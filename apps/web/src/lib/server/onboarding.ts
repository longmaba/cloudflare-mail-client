// SPDX-License-Identifier: Apache-2.0
import { and, eq, inArray } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { domainOf, senderAddress } from "@doota/db/org-domains";
import type { Auth } from "./auth.js";
import { stampOnboarded } from "./auth/escape-hatches.js";
import { renderEmail } from "./email/index.js";
import { sendMailBackground } from "./mailer.js";

export type OnboardingStepId =
  | "verify-email"
  | "verify-recovery"
  | "secure-account"
  | "set-password"
  | "onboard-domain";

export type OnboardingStep = {
  id: OnboardingStepId;
  title: string;
  description: string;
  done: boolean;
};

export type OnboardingStatus = {
  steps: OnboardingStep[];
  complete: boolean;
  /** First not-yet-done step, or null when finished. */
  nextStep: OnboardingStepId | null;
};

type SessionUser = {
  id: string;
  role?: string | null;
  onboardedAt?: number | null;
  twoFactorEnabled?: boolean | null;
};

/** Elevated accounts require authenticator two-factor authentication. */
export function isElevatedRole(role?: string | null): boolean {
  return role === "admin" || role === "superadmin";
}

/**
 * A coarse session hint only. Enforcement below reads current D1 roles,
 * administrator memberships and enrollment; cached session flags cannot grant
 * access after a promotion or TOTP disable.
 */
export function hasSecurityDebt(user: SessionUser): boolean {
  return isElevatedRole(user.role) && !user.twoFactorEnabled;
}

/** Organization roles grant trusted access independently of the global role. */
async function securitySnapshot(db: DrizzleD1Database<typeof schema>, userId: string) {
  const [fresh, administratorMembership] = await Promise.all([
    db.query.user.findFirst({
      where: eq(schema.user.id, userId),
      columns: {
        role: true,
        twoFactorEnabled: true,
        recoveryEmail: true,
        recoveryEmailVerified: true,
        mustChangePassword: true,
      },
    }),
    db.query.member.findFirst({
      where: and(eq(schema.member.userId, userId), inArray(schema.member.role, ["owner", "admin"])),
      columns: { id: true },
    }),
  ]);
  return { fresh, isElevated: isElevatedRole(fresh?.role) || !!administratorMembership };
}

export type OrgTwoFactorGate =
  | { kind: "none" }
  | { kind: "grace"; deadline: number } // required, but the grace window is open
  | { kind: "block" }; // deadline passed, TOTP still off → block interactive access

/**
 * Interactive TOTP gate, evaluated on every authenticated application request.
 * Current global admins and owners/admins of any organization have no grace
 * period. Ordinary members use their active organization's optional mandate.
 * D1 enrollment is authoritative even when a browser cookie reports otherwise.
 * API keys do not use this interactive session guard.
 */
export async function orgTwoFactorGate(
  db: DrizzleD1Database<typeof schema>,
  user: SessionUser,
  activeOrganizationId?: string | null,
): Promise<OrgTwoFactorGate> {
  const { fresh, isElevated } = await securitySnapshot(db, user.id);
  if (!fresh) return { kind: "block" };
  if (fresh.twoFactorEnabled) return { kind: "none" };
  if (isElevated) return { kind: "block" };

  let orgId = activeOrganizationId ?? null;
  if (!orgId) {
    const access = await db.query.mailboxAccess.findFirst({
      where: eq(schema.mailboxAccess.userId, user.id),
      columns: { mailboxId: true },
    });
    if (access) {
      const box = await db.query.mailbox.findFirst({
        where: eq(schema.mailbox.id, access.mailboxId),
        columns: { orgId: true },
      });
      orgId = box?.orgId ?? null;
    }
  }
  if (!orgId) {
    const membership = await db.query.member.findFirst({
      where: eq(schema.member.userId, user.id),
      columns: { organizationId: true },
    });
    orgId = membership?.organizationId ?? null;
  }
  if (!orgId) return { kind: "none" };

  const settings = await db.query.orgMailSettings.findFirst({
    where: eq(schema.orgMailSettings.orgId, orgId),
    columns: { require2fa: true, require2faFrom: true },
  });
  if (!settings?.require2fa) return { kind: "none" };
  // The toggle always writes a future deadline; a missing one enforces now.
  const deadline = settings.require2faFrom?.getTime() ?? Date.now();
  return Date.now() >= deadline ? { kind: "block" } : { kind: "grace", deadline };
}

const HOME_BY_ROLE: Record<string, string> = { superadmin: "/admin" };
export function onboardingHome(role?: string | null): string {
  return HOME_BY_ROLE[role ?? ""] ?? "/app";
}

const DONE: OnboardingStatus = { steps: [], complete: true, nextStep: null };

/**
 * Derives what onboarding is left for a user. Requirements differ by role:
 *   superadmin → activate mail domain + verify recovery + secure account (TOTP)
 *   admin      → verify recovery email + secure account
 *   member     → verify recovery email
 * Invited users finish password setup through their recovery link before login.
 *
 * Reads the gating flags fresh from D1 (never the 5-minute session cookie cache),
 * so a just-completed step isn't reported stale and bounce the user in a loop.
 * The completed-onboarding fast path follows the current security checks.
 */
export async function getOnboardingStatus(
  db: DrizzleD1Database<typeof schema>,
  user: SessionUser,
  /** Org-2FA mandate past its grace deadline (Phase C): a plain member must
   * enroll TOTP too, so reopen secure-account for them like an elevated debt. */
  mustEnroll2fa = false,
): Promise<OnboardingStatus> {
  const { fresh, isElevated } = await securitySnapshot(db, user.id);
  const role = fresh?.role ?? user.role ?? "member";
  // Passkeys are optional; they do not replace the administrator TOTP mandate.
  const secured = !!fresh?.twoFactorEnabled;
  const mustSecure = (isElevated && !secured) || mustEnroll2fa;
  if (fresh && user.onboardedAt && !mustSecure) return DONE;
  const steps: OnboardingStep[] = [];

  // Genesis initializes a pending domain. Activate it during onboarding so
  // external recovery verification has a working sending path.
  if (role === "superadmin") {
    const domains = await db.$count(schema.organization, eq(schema.organization.status, "active"));
    steps.push({
      id: "onboard-domain",
      title: "Onboard a mail domain",
      description:
        "Connect a Cloudflare domain so Doota can send and receive mail.",
      done: domains > 0,
    });
  }

  // Every role verifies its external recovery inbox.
  steps.push({
    id: "verify-recovery",
    title: "Verify a recovery email",
    description: "An external inbox for password reset links.",
    done: !!fresh?.recoveryEmail && !!fresh?.recoveryEmailVerified,
  });

  if (fresh?.mustChangePassword) {
    steps.push({
      id: "set-password",
      title: "Set your password",
      description: "Choose your own password using the setup link sent to your recovery inbox.",
      done: false,
    });
  }

  if (isElevated || mustEnroll2fa) {
    steps.push({
      id: "secure-account",
      title: "Secure your account",
      description: isElevated
        ? "Admin accounts require authenticator two-factor authentication. Passkeys are optional."
        : "Your organization requires two-factor authentication.",
      done: secured,
    });
  }

  const complete = steps.every((step) => step.done);
  const nextStep = steps.find((step) => !step.done)?.id ?? null;
  return { steps, complete, nextStep };
}

/** Stamps onboardedAt so future requests take the fast path. Idempotent. */
export async function markOnboarded(auth: Auth, userId: string): Promise<void> {
  await stampOnboarded(auth, userId);
}

/**
 * Completion notifications, fired once when an account turns active (first
 * markOnboarded): the new user always gets a welcome as the first mail in
 * their inbox, sent from the org's no-reply sender (senderAddress default).
 * When an invite chain exists, the inviter additionally gets "member joined".
 * Best-effort: a mail failure never blocks the request.
 */
export async function notifyOnboardingComplete(
  db: DrizzleD1Database<typeof schema>,
  userId: string,
): Promise<void> {
  const u = await db.query.user.findFirst({
    where: eq(schema.user.id, userId),
    columns: { name: true, email: true, invitedByUserId: true },
  });
  if (!u) return;

  const from = await senderAddress(db, domainOf(u.email));
  const memberName = u.name || u.email;

  const w = renderEmail("welcome", { from, name: memberName, mailbox: u.email });
  sendMailBackground({ to: u.email, from, subject: w.subject, text: w.text, html: w.html });

  // "Member joined" goes to the inviter — or, when no invite chain exists
  // (account created outside provisioning), to the superadmin running the
  // instance. Never to the new member themselves (superadmin self-onboarding).
  const inviter = u.invitedByUserId
    ? await db.query.user.findFirst({
        where: eq(schema.user.id, u.invitedByUserId),
        columns: { email: true },
      })
    : await db.query.user.findFirst({
        where: eq(schema.user.role, "superadmin"),
        columns: { email: true },
      });
  if (inviter?.email && inviter.email !== u.email) {
    const j = renderEmail("member-joined", { from, memberName, memberEmail: u.email });
    sendMailBackground({ to: inviter.email, from, subject: j.subject, text: j.text, html: j.html });
  }
}
