// SPDX-License-Identifier: Apache-2.0
import { error } from "@sveltejs/kit";
import { and, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { canReadMessage } from "@doota/mail-core/message-access";
import { importKey, putEncryptedBlob } from "@doota/mail-core/crypto";
import { MAX_ATTACHMENTS, type AttachmentRef } from "@doota/mail-core/drafts";

type Db = DrizzleD1Database<typeof schema>;
type Env = { MAIL_RAW: R2Bucket; MAIL_DEK: string };
type StoredAttachment = { r2Key: string; filename: string; contentType: string; size: number | null };

/** A key supplied by a session is only a reference, never an R2 capability.
 * Resolve it to a readable message attachment or this user's recorded upload.
 * Client filename/type/size never override the stored metadata. */
export async function resolveSendAttachments(db: Db, env: Env, userId: string, orgId: string, keys: string[]): Promise<StoredAttachment[]> {
  if (keys.length > MAX_ATTACHMENTS) error(413, "Too many attachments.");
  const resolved: (StoredAttachment | { draftId: string; ref: AttachmentRef })[] = [];
  // Authorize the entire list before reading or writing any object.
  for (const key of keys) {
    const attachments = await db.select({ attachment: schema.attachment, orgId: schema.message.orgId })
      .from(schema.attachment).innerJoin(schema.message, eq(schema.message.id, schema.attachment.messageId))
      .where(and(eq(schema.attachment.r2Key, key), eq(schema.message.orgId, orgId)));
    let stored: StoredAttachment | undefined;
    for (const { attachment } of attachments) {
      if (await canReadMessage(db, { userId }, attachment.messageId, orgId)) {
        stored = { r2Key: key, filename: attachment.filename ?? "attachment", contentType: attachment.contentType ?? "application/octet-stream", size: attachment.size };
        break;
      }
    }
    if (stored) { resolved.push(stored); continue; }
    const upload = /^draft\/([^/]+)\/([^/]+)\/[^/]+$/.exec(key);
    const draft = upload && upload[1] === orgId
      ? await db.query.draft.findFirst({ where: and(eq(schema.draft.id, upload[2]), eq(schema.draft.orgId, orgId), eq(schema.draft.createdByUserId, userId), eq(schema.draft.status, "editing")) })
      : null;
    let refs: AttachmentRef[] = [];
    try { refs = draft ? JSON.parse(draft.attachments ?? "[]") : []; } catch { /* denied below */ }
    const ref = Array.isArray(refs) ? refs.find((a) => a.r2Key === key) : undefined;
    if (!draft || !ref) error(403, "Attachment source is not available to this sender.");
    resolved.push({ draftId: draft.id, ref });
  }
  const out: StoredAttachment[] = [];
  for (const attachment of resolved) {
    if (!("draftId" in attachment)) { out.push(attachment); continue; }
    const upload = await env.MAIL_RAW.get(attachment.ref.r2Key);
    if (!upload) error(404, "Attachment bytes are missing.");
    const bytes = new Uint8Array(await upload.arrayBuffer());
    const r2Key = `outbound-att/${orgId}/${crypto.randomUUID()}`;
    await putEncryptedBlob(env.MAIL_RAW, r2Key, await importKey(env.MAIL_DEK), bytes, { httpMetadata: { contentType: attachment.ref.contentType } });
    out.push({ ...attachment.ref, r2Key, size: bytes.byteLength });
  }
  return out;
}
