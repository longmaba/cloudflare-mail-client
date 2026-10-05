// SPDX-License-Identifier: Apache-2.0
import { getRequestEvent } from "$app/server";
import { assertOutboundSize } from '@doota/mail-core/outbound-size';

type MailFrom = { name: string; email: string; logo?: string | null };
type Mail = {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Sender from an onboarded active domain (see `senderAddress`). Required to
   *  actually send — there is no system fallback domain. */
  from?: MailFrom;
};

/**
 * Mailer via the EMAIL_SENDER binding. Every mail must originate from an
 * onboarded domain whose sending path is live (`senderAddress`) — there is no
 * fallback domain. If none is active yet (fresh deploy) `from` is undefined and
 * the send is skipped. Falls back to console.log in local dev (no binding).
 */
export async function sendMail({ to, subject, text, html, from }: Mail) {
  const sender = getRequestEvent().platform?.env.EMAIL_SENDER;
  if (!sender) {
    console.log("[mailer:dev] skipped: EMAIL_SENDER is unavailable");
    return;
  }
  if (!from) {
    console.warn("[mailer] no active sending domain — mail skipped", { to, subject });
    return;
  }
  const body = html ?? `<p>${text}</p>`;
  assertOutboundSize({ to: [to], from, subject, text, html: body });
  await sender.send({
    to,
    from,
    subject,
    text,
    html: body,
  });
}

/**
 * Send without blocking the response. Two reasons this matters for
 * password reset: (1) a mail failure must not turn the generic 200 into a
 * 500, and (2) not awaiting the send keeps the endpoint's latency uniform
 * whether or not a mail actually goes out — so response timing can't be
 * used to probe which accounts exist. Uses the Worker's waitUntil to finish
 * delivery after the response; falls back to a caught fire-and-forget in dev.
 */
export function sendMailBackground(mail: Mail) {
  const promise = sendMail(mail).catch((err) =>
    console.error("[mailer] background send failed", err),
  );
  const ctx = getRequestEvent().platform?.ctx;
  if (ctx) ctx.waitUntil(promise);
  return Promise.resolve()
}
