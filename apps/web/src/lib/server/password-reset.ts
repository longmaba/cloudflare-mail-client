// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type * as schema from "@doota/db/schema";
import { sendMail } from "./mailer";
import { renderEmail } from "./email";
import { senderAddress, domainOf, isServedDomain } from "@doota/db/org-domains";
import { MAIL_DOMAIN } from "$app/env/private";
import { isExternalRecovery } from "./auth/recovery-policy.js";
import { tokenStore, throttleAllows } from "./auth/escape-hatches.js";

type Db = DrizzleD1Database<typeof schema>;

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const THROTTLE_MS = 60_000; // one request per minute

type ResetUser = {
  id: string;
  email: string;
  role?: string | null;
  recoveryEmail?: string | null;
  recoveryEmailVerified?: boolean | null;
};

/**
 * External address the reset code is sent to (same invariant as the logged-out
 * flow): every role uses a verified recovery email, never their domain inbox.
 */
export function resetTarget(user: ResetUser): string | null {
  return user.recoveryEmail && user.recoveryEmailVerified
    ? user.recoveryEmail
    : null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split("@");
  if (!domain) return email;
  const head = local.slice(0, 1);
  return `${head}${"•".repeat(Math.max(local.length - 1, 1))}@${domain}`;
}

/** Issues a 6-digit code, stores it, and mails it to the reset target. */
export async function sendPasswordResetCode(
  db: Db,
  user: ResetUser,
): Promise<{ ok: boolean; message: string }> {
  const to = resetTarget(user);
  if (!to || (MAIL_DOMAIN && !isExternalRecovery(to, MAIL_DOMAIN)) || await isServedDomain(db, to)) {
    return {
      ok: false,
      message: "No verified recovery email on file to send a code to.",
    };
  }

  if (!(await throttleAllows(`pwreset-throttle:${user.id}`, THROTTLE_MS))) {
    return {
      ok: false,
      message: "Please wait a minute before requesting another code.",
    };
  }

  // Rejection sampling avoids modulo bias and Math.random() for auth material.
  const random = new Uint32Array(1);
  do { crypto.getRandomValues(random); } while (random[0] >= 4_294_800_000);
  const code = String(100000 + (random[0] % 900000));
  const codeId = `pwreset:${user.id}`;
  // One active code per user: drop any previous one before issuing.
  await tokenStore.dropByIdentifier(codeId);
  await tokenStore.issue(codeId, code, CODE_TTL_MS);

  const fromDomain = domainOf(user.email);
  const from = await senderAddress(db, fromDomain);
  const mail = renderEmail("reset-code", { from, code });
  await sendMail({ to, from, subject: mail.subject, text: mail.text, html: mail.html });

  return { ok: true, message: `Code sent to ${maskEmail(to)}.` };
}

/** Checks the submitted code and consumes it on success. */
export async function confirmPasswordResetCode(
  userId: string,
  code: string,
): Promise<boolean> {
  const rec = await tokenStore.peek(`pwreset:${userId}`);
  // Wrong code leaves the record so the user can retry within the TTL; the
  // per-minute request throttle bounds brute-force attempts.
  if (!rec || rec.value !== code) return false;
  await tokenStore.dropById(rec.id);
  return true;
}
