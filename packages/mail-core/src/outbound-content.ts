// SPDX-License-Identifier: Apache-2.0
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { decryptContent, type ContentKey } from "./crypto";
import { buildQuotedHtml, buildQuotedText, type QuotedParent } from "./mail-thread-contract";
import { readableMessageReference, type MessageActor } from "./message-access";

/** The same quoted wire body is checked before enqueue and rebuilt on delivery. */
export async function appendQuotedHistory(
  db: DrizzleD1Database<typeof schema>, ck: ContentKey, orgId: string, actor: MessageActor,
  parentReference: string | null | undefined, text: string | null | undefined, html: string | null | undefined,
): Promise<{ text?: string; html?: string }> {
  const parents: QuotedParent[] = [];
  const seen = new Set<string>();
  let ref = parentReference;
  for (let depth = 0; ref && depth < 10 && !seen.has(ref); depth++) {
    seen.add(ref);
    const parent = await readableMessageReference(db, actor, orgId, ref, depth === 0);
    if (!parent) break;
    parents.push({ from: parent.fromAddr, sentAt: parent.sentAt?.getTime() ?? null, bodyFull: await decryptContent(ck, parent.bodyFullEnc) });
    ref = parent.inReplyTo;
  }
  return parents.length
    ? { text: buildQuotedText(text ?? "", parents), html: html ? buildQuotedHtml(html, parents) : undefined }
    : { text: text ?? undefined, html: html ?? undefined };
}
