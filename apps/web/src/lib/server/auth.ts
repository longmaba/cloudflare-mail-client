// SPDX-License-Identifier: Apache-2.0
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { sveltekitCookies } from "better-auth/svelte-kit";
import {
  admin,
  lastLoginMethod,
  twoFactor,
  organization,
  multiSession,
} from "better-auth/plugins";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements } from "better-auth/plugins/admin/access";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { passkey } from "@better-auth/passkey";
import { getRequestEvent } from "$app/server";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { sendMailBackground } from "./mailer";
import {
  isServedDomain,
  invalidateDomainCache,
  senderAddress,
  domainOf,
} from "@doota/db/org-domains";
import { BETTER_AUTH_SECRET, APP_NAME, MAIL_DOMAIN } from "$app/env/private";
import { ORIGINS } from "$app/env/public";
import { dev } from "$app/env";
import { renderEmail } from "./email";
import { kvSecondaryStorage } from "./auth/kv-secondary-storage.js";
import { MAX_DEVICE_SESSIONS } from "$lib/auth-limits.js";
import { recoveryResetTarget, isExternalRecovery } from "./auth/recovery-policy.js";
import { rememberRecoveryReset, validRecoveryReset, completeRecoveryReset } from "./auth/escape-hatches.js";

// Instance roles (admin plugin). Separate from org membership roles
// (owner/admin/member), which the organization plugin manages per-membership.
const ac = createAccessControl(defaultStatements);
export const roles = {
  member: ac.newRole({}),
  admin: ac.newRole(adminAc.statements),
  superadmin: ac.newRole(adminAc.statements),
};

type UserRecovery = {
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean;
};

/**
 * Reject an address that lands on any domain this deployment serves. Recovery
 * addresses must be external. A
 * served-domain address recreates the circular "can't read your own mailbox
 * until you're logged in" problem. No-op when db is absent (schema generation).
 */
async function assertNotServedDomain(
  db: DrizzleD1Database<typeof schema> | undefined,
  email: unknown,
  label: string,
) {
  if (!db || typeof email !== "string" || !email) return;
  if ((MAIL_DOMAIN && !isExternalRecovery(email, MAIL_DOMAIN)) || await isServedDomain(db, email)) {
    throw new APIError("BAD_REQUEST", {
      message: `${label} must be an external address, not on a domain this server hosts.`,
    });
  }
}

function buildAuth(db?: DrizzleD1Database<typeof schema>, kv?: KVNamespace) {
  return betterAuth({
    // Cloudflare KV as a fast, edge-local read cache in front of D1. D1 stays the
    // source of truth (storeSessionInDatabase / verification.storeInDatabase
    // below): sessions + verification values are dual-written, reads hit KV first
    // and fall back to D1, and consume/revoke are enforced on D1. Absent (CLI
    // schema-gen has no binding) → plain database-only mode.
    secondaryStorage: kv ? kvSecondaryStorage(kv) : undefined,
    advanced: {
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      // Cloudflare Workers never set NODE_ENV, so better-auth can't auto-detect
      // production and would ship session cookies without Secure. Force it on
      // outside local dev (paired with HSTS in hooks.server.ts).
      useSecureCookies: !dev,
    },
    user: {
      modelName: "user",
      additionalFields: {
        // Every account signs in with its domain email and recovers externally.
        recoveryEmail: { type: "string", required: false },
        recoveryEmailVerified: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        recoveryEmailVerifiedAt: {
          type: "number",
          required: false,
          input: false,
        },
        // Set by the provisioning admin; forces the set-password onboarding step.
        mustChangePassword: {
          type: "boolean",
          required: false,
          defaultValue: false,
          input: false,
        },
        // Fast-path marker so the request hook can skip re-deriving status.
        onboardedAt: { type: "number", required: false, input: false },
      },
    },
    emailVerification: {
      // Optional primary mailbox verification; account recovery always uses the
      // separately verified external recovery address.
      sendVerificationEmail: async ({ user, url }) => {
        const from = db ? await senderAddress(db) : undefined;
        const mail = renderEmail("verify-email", { from, verifyLink: url });
        sendMailBackground({
          to: user.email,
          from,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      },
      autoSignInAfterVerification: false,
    },
    appName: APP_NAME || "Cloudflare Mail Client",
    // ORIGINS entries are full origins (protocol included) — better-auth uses
    // them verbatim as trusted origins; the canonical first entry is the
    // fallback base URL when a request can't resolve one.
    baseURL: {
      allowedHosts: ORIGINS,
      fallback: ORIGINS[0],
    },
    secret: BETTER_AUTH_SECRET,
    database: drizzleAdapter(db!, { provider: "sqlite", schema }),
    emailAndPassword: {
      enabled: true,
      // Accounts are provisioned by an admin, never self-signup.
      disableSignUp: true,
      revokeSessionsOnPasswordReset: true,
      resetPasswordTokenExpiresIn: 60 * 10, // seconds
      // Invitations use the same expiring, single-use Better Auth reset token.
      // An unverified recovery address is allowed only for initial account setup.
      sendResetPassword: async ({ user, url, token }) => {
        const role = (user as typeof user & { role?: string | null }).role;
        const recoveryUser = user as typeof user & UserRecovery & { mustChangePassword?: boolean };
        const to = recoveryResetTarget(recoveryUser);
        if (!to) return;
        // Defence in depth: never send a reset link to a served-domain inbox.
        if ((MAIL_DOMAIN && !isExternalRecovery(to, MAIL_DOMAIN)) || (db && await isServedDomain(db, to))) return;

        // Brand from the user's own org domain (members) when it's active;
        // superadmin/system mail falls back to any active org domain.
        const fromDomain =
          role === "superadmin" ? undefined : domainOf(user.email);
        const from = db ? await senderAddress(db, fromDomain) : undefined;

        await rememberRecoveryReset(token, user.id, to);
        const mail = recoveryUser.mustChangePassword
          ? renderEmail("invite", { from, mailbox: user.email, setupLink: url })
          : renderEmail("reset-link", { from, resetLink: url });
        sendMailBackground({
          to,
          from,
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
        });
      },
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/reset-password") return;
        const token = ctx.body?.token || ctx.query?.token;
        if (typeof token !== "string" || !(await validRecoveryReset(token))) {
          throw new APIError("BAD_REQUEST", { message: "Invalid or expired reset link." });
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/reset-password") return;
        const result = ctx.context.returned as { status?: boolean } | undefined;
        const token = ctx.body?.token || ctx.query?.token;
        if (result?.status === true && typeof token === "string") {
          await completeRecoveryReset(token);
        }
      }),
    },
    databaseHooks: {
      user: {
        create: {
          before: async (user) => {
            await assertNotServedDomain(
              db,
              (user as UserRecovery).recoveryEmail,
              "Recovery email",
            );
            // The bootstrap lock guarantees only one first administrator.
            const isFirst = db ? (await db.$count(schema.user)) === 0 : false;
            return {
              data: {
                ...user,
                role: isFirst ? "superadmin" : (user.role ?? "member"),
              },
            };
          },
        },
        update: {
          before: async (data) => {
            const recoveryEmail = (data as UserRecovery).recoveryEmail;
            if (recoveryEmail === undefined) return { data };
            await assertNotServedDomain(db, recoveryEmail, "Recovery email");
            // Changing the recovery address always re-requires verification.
            return {
              data: {
                ...data,
                recoveryEmailVerified: false,
                recoveryEmailVerifiedAt: null,
              },
            };
          },
        },
      },
    },
    rateLimit: {
      enabled: true,
      storage: "database",
      customRules: {
        // Tighter than the default bucket for credential/2FA guessing.
        // (2FA also has better-auth's own failed-attempt lockout on top.)
        "/request-password-reset": { window: 60, max: 3 },
        "/sign-in/email": { window: 60, max: 5 },
        "/two-factor/*": { window: 60, max: 5 },
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 60 * 5 },
      // Keep D1 authoritative for sessions; KV is only a read cache in front of
      // it. Revocation (logout / password reset) deletes from D1 and KV, so a
      // revoked session can't outlive KV's propagation window in the DB of record.
      storeSessionInDatabase: true,
    },
    verification: {
      // Same: verification values (email-verify links, our namespaced recovery /
      // reset / throttle tokens) stay in D1 so single-use consume is enforced
      // there and tokenStore.peek's direct D1 read still sees them; KV just caches.
      storeInDatabase: true,
    },
    plugins: [
      admin({
        defaultRole: "member",
        adminRoles: ["admin", "superadmin"],
        ac,
        roles,
      }),
      // org == domain. Only the super-admin may create orgs; they become the
      // org owner (org membership role) automatically via creatorRole.
      organization({
        allowUserToCreateOrganization: async (user) =>
          (user as { role?: string | null }).role === "superadmin",
        creatorRole: "owner",
        schema: {
          organization: {
            additionalFields: {
              domain: {
                type: "string",
                required: true,
                input: true,
                unique: true,
              },
              zoneId: { type: "string", required: false, input: false },
              // Onboarding lifecycle. CF is the source of truth for the actual
              // DNS/DKIM/routing state; we only cache which stage we're at.
              status: {
                type: "string",
                required: false,
                input: false,
                defaultValue: "pending_zone",
              },
            },
          },
        },
        organizationHooks: {
          beforeCreateOrganization: async ({ organization: org }) => {
            const domain = String((org as { domain?: string }).domain ?? "")
              .trim()
              .toLowerCase();
            if (
              !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/.test(domain)
            ) {
              throw new APIError("BAD_REQUEST", {
                message: "A valid organization domain is required.",
              });
            }
            return {
              data: {
                ...org,
                domain,
                name: org.name || domain,
                slug: org.slug || domain.replace(/\./g, "-"),
              },
            };
          },
          afterCreateOrganization: async () => invalidateDomainCache(),
          afterUpdateOrganization: async () => invalidateDomainCache(),
          afterDeleteOrganization: async () => invalidateDomainCache(),
        },
      }),
      // Switching between accounts on different domains, not the /app↔/admin
      // switch (that is plain navigation within a single account). The cap is
      // shared with the UI, which blocks before a sign-in would exceed it (over
      // the cap the plugin silently stops tracking sessions).
      multiSession({ maximumSessions: MAX_DEVICE_SESSIONS }),
      lastLoginMethod(),
      twoFactor(),
      // No TOTP after passkey login: a passkey is already two factors.
      passkey(),
      sveltekitCookies(getRequestEvent),
    ], // sveltekitCookies must be last
  });
}

export type Auth = ReturnType<typeof buildAuth>;

let auth: Auth | undefined;

export function createAuth(
  db: DrizzleD1Database<typeof schema>,
  kv?: KVNamespace,
) {
  return (auth ??= buildAuth(db, kv));
}

/**
 * Don't use this export; it's only for the better-auth CLI to generate schema.
 */
const authClientGen = buildAuth();
export default authClientGen;
