// SPDX-License-Identifier: Apache-2.0
import { eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getRequestEvent } from "$app/server";
import { requestOrigin } from "./origins.js";
import * as schema from "@doota/db/schema";
import { getDiceBearURL } from "$lib/utils/dice-bear.js";
import { tryCatch } from "$lib/utils/try-catch.js";
import { can, type Actor } from "@doota/db/can";
import { isServedDomain, senderAddress } from "@doota/db/org-domains";
import { setUserAuthFlags } from "./auth/escape-hatches.js";
import { ensurePersonalMailbox, addressHosts } from "@doota/mail-core/mailbox";
import { seedWelcomeMessage } from "@doota/mail-core/welcome";
import { importKey } from "@doota/mail-core/crypto";
import { ensureMailboxRouting } from "./mail-routing.js";
import { MAIL_STAGING_DOMAIN } from "$app/env/private";

type Db = DrizzleD1Database<typeof schema>;

export type ProvisionInput = {
  name: string;
  /** Local part only; the org's domain is appended server-side. */
  email: string;
  recoveryEmail: string;
  role: "member" | "admin";
  organizationId: string;
  /** Host for the address; the apex when omitted. Must be the apex or a
   * configured routing subdomain of the org. */
  host?: string;
};

/**
 * Bindings lookup for the welcome seed, kept out of the provisioning flow so the
 * happy path reads as one line. A stack without the mail bindings (a bare dev
 * run) simply gets no welcome message — never an error.
 */
async function seedWelcome(input: {
  orgId: string;
  mailboxId: string;
  address: string;
  displayName?: string | null;
  from: { name: string; email: string };
}): Promise<void> {
  const env = getRequestEvent().platform?.env;
  if (!env?.MAIL_RAW || !env?.MAIL_QUEUE || !env?.MAIL_DEK) return;
  await seedWelcomeMessage(
    { MAIL_RAW: env.MAIL_RAW, MAIL_QUEUE: env.MAIL_QUEUE as never },
    await importKey(env.MAIL_DEK),
    { ...input, from: input.from.email, fromName: input.from.name, appOrigin: requestOrigin() },
  );
}

/** Org ids where the actor is owner/admin — the orgs they may provision into. */
export async function actorOrgAdminOf(
  db: Db,
  userId: string,
): Promise<string[]> {
  const rows = await db
    .select({ orgId: schema.member.organizationId, role: schema.member.role })
    .from(schema.member)
    .where(eq(schema.member.userId, userId));
  return rows
    .filter((row) => row.role === "owner" || row.role === "admin")
    .map((row) => row.orgId);
}

// Unknown until the owner redeems the setup link; never included in email/URLs.
function inaccessiblePassword(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a member/admin under the organization that owns their email's domain,
 * then mail a ten-minute single-use password setup link to their
 * external recovery address. Authorization runs through can() — superadmin or an
 * admin of the target org only.
 */
export async function provisionUser(
  actor: Actor,
  input: ProvisionInput,
): Promise<{ success: boolean; message: string }> {
  const { locals, request } = getRequestEvent();
  const db = locals.db;
  const username = input.email.trim().toLowerCase();
  const recoveryEmail = input.recoveryEmail.trim().toLowerCase();

  // Membership is chosen up front: the org pins the domain, so the admin only
  // supplies the local part.
  const org = await db.query.organization.findFirst({
    where: eq(schema.organization.id, input.organizationId),
    columns: { id: true, domain: true, status: true },
  });
  if (!org?.domain) {
    return { success: false, message: "Organization not found." };
  }
  const staged = org.status === 'staged' && !!MAIL_STAGING_DOMAIN && org.domain === MAIL_STAGING_DOMAIN;
  if (org.status !== "active" && !staged) {
    return {
      success: false,
      message: "This domain isn't active yet. Finish onboarding it before adding users.",
    };
  }
  const hosts = await addressHosts(db, org.id, org.domain);
  const host = input.host?.trim().toLowerCase() || hosts[0];
  if (!hosts.includes(host)) {
    return { success: false, message: `${host} isn't a configured domain for this org.` };
  }
  const email = `${username}@${host}`;

  // Recovery address must be external — a served-domain recovery recreates the
  // "can't read your mailbox until you're logged in" deadlock.
  if (await isServedDomain(db, recoveryEmail)) {
    return {
      success: false,
      message: "Recovery email must be an external address, not a hosted one.",
    };
  }

  const orgAdminOf = await actorOrgAdminOf(db, actor.id);
  const allowed = can(
    { id: actor.id, role: actor.role, orgAdminOf },
    "manage",
    { type: "user", ownerId: "", organizationId: org.id },
  );
  if (!allowed) {
    return {
      success: false,
      message: "You don't have permission to add users to this domain.",
    };
  }

  // Staged accounts use the active pilot sender for their external invitation.
  // Reject a missing path before creating an inaccessible account.
  const stagedSender = staged ? await senderAddress(db, org.domain) : undefined;
  if (staged && !stagedSender) {
    return { success: false, message: 'Activate the pilot sending domain before inviting prepared accounts.' };
  }

  const password = inaccessiblePassword();
  // admin.createUser is atomic (user + credential account in one call), so the
  // old create/link/rollback dance is gone. recoveryEmail (input:true) rides in
  // `data` so the user.create hook re-validates it; mustChangePassword is
  // input:false, so it's stamped separately below.
  const { error: createError, data: created } = await tryCatch(
    locals.auth.api.createUser({
      body: {
        email,
        password,
        name: input.name,
        role: input.role, // instance role: member | admin
        data: {
          recoveryEmail,
          image: getDiceBearURL({ seed: email }),
        },
      },
      headers: request.headers,
    }),
  );
  if (createError || !created?.user) {
    return {
      success: false,
      message: "Could not create the account — that email may already be in use.",
    };
  }
  const userId = created.user.id;

  // Both writes touch the Better Auth `user` row — route through the boundary so
  // the session cache stays coherent (and the auth-boundary guard passes). The
  // invite chain drives onboarding's "member joined" + welcome mails.
  await setUserAuthFlags(userId, { mustChangePassword: true, invitedByUserId: actor.id });

  const { error: memberError } = await tryCatch(
    locals.auth.api.addMember({
      body: {
        userId,
        organizationId: org.id,
        role: input.role === "admin" ? "admin" : "member",
      },
      headers: request.headers,
    }),
  );
  if (memberError) {
    return {
      success: false,
      message: "Account created but could not be added to the organization.",
    };
  }

  // The address moves off the implied user.email into a mailbox row — the single
  // source of truth for "what address is this person". Idempotent, so a retried
  // provision converges. Failure here is non-fatal to the invite (the mailbox is
  // reconcilable), but log it.
  const { data: mailboxId, error: mailboxError } = await tryCatch(
    ensurePersonalMailbox(db, {
      orgId: org.id,
      userId,
      address: email,
      displayName: input.name,
    }),
  );
  if (mailboxError) {
    console.error("[provision] personal mailbox failed", mailboxError);
    return { success: false, message: "Account created but mailbox setup failed. Repair the mailbox before sending an invitation." };
  }
  const { error: routingError } = await tryCatch(ensureMailboxRouting(db, org.id, email));
  if (routingError) {
    console.error("[provision] mailbox routing failed", routingError);
    return { success: false, message: "Account created but email routing failed. Finish routing setup before sending an invitation." };
  }

  const from = stagedSender ?? await senderAddress(db, org.domain);

  // Seed the welcome message so the first login opens on something rather than
  // an empty list. It rides the normal inbound path (encrypted R2 put + queue),
  // so it threads, indexes, mirrors and exports like any other mail. Best
  // effort: a mailbox without it is cosmetically poorer, never broken — and the
  // stable Message-ID makes a retried provision converge instead of duplicating.
  if (mailboxId && from)
    await tryCatch(
      seedWelcome({ orgId: org.id, mailboxId, address: email, displayName: input.name, from }),
    );

  // Better Auth owns token expiry/atomic consumption. Its reset callback binds
  // the token to the external recovery address and renders the invitation.
  const { error: inviteError } = await tryCatch(
    locals.auth.api.requestPasswordReset({
      body: { email, redirectTo: `${requestOrigin()}/reset-password` },
      headers: request.headers,
    }),
  );
  if (inviteError) return { success: false, message: "Account created, but the setup link could not be sent. Request a new link from Forgot password." };

  return {
    success: true,
    message: `Invite sent to ${recoveryEmail}.`,
  };
}
