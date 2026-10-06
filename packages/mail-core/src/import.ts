// SPDX-License-Identifier: Apache-2.0
// Historical MIME bypasses inbound rules, vacation replies and notifications.
import { and, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import PostalMime, { decodeWords } from "postal-mime";
import * as mail from "@doota/db/mail.schema";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import { getDecryptedBlob, putEncryptedBlob, type ContentKey } from "./crypto.js";
import { contentHash } from "./inbound-receipts.js";
import { materializeMessage, materializeDelivery, type ParsedMessage } from "./materialize.js";
import { createLabel, applyLabel } from "./labels.js";
import { log } from "./log.js";

type Db = DrizzleD1Database<typeof schema>;
type ImportRow = typeof mail.mailImport.$inferSelect;
type Outcome = "imported" | "skipped";
export type MailboxImportJob = { kind: "mailbox_import"; importId: string };
export const PART_PLAINTEXT_BYTES = 8 * 1024 * 1024;
export const MAX_IMPORT_MESSAGE_BYTES = 25 * 1024 * 1024;
const MAX_MESSAGES_PER_RUN = 12;
const WINDOW_BYTES = 16 * 1024 * 1024;
const TIME_BUDGET_MS = 12_000;
const LEASE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const MAX_ATTEMPTS = 10;
const INCOMPLETE = "The archive upload is incomplete. Resume using the same file.";
const DIFFERENT = "This chunk differs from the original archive. Resume using the same file.";
const OVERSIZED = "A message exceeds the 25 MiB MIME limit. The archive and checkpoint were retained. Extract or split the oversized message before importing the remaining mail.";
class ImportArchiveError extends Error {}

export function importPartKey(orgId: string, importId: string, index: number): string {
  return `import/${orgId}/${importId}/part-${String(index).padStart(5, "0")}`;
}
const FROM_ = [0x46, 0x72, 0x6f, 0x6d, 0x20];
function isFromLine(bytes: Uint8Array, at: number): boolean {
  return at + FROM_.length <= bytes.length && FROM_.every((b, i) => bytes[at + i] === b);
}
export function nextSeparator(bytes: Uint8Array, from: number): number {
  for (let i = Math.max(from, 0); i < bytes.length; i++) {
    if (bytes[i] === 0x0a && isFromLine(bytes, i + 1)) return i + 1;
  }
  return -1;
}
/** Undo one level of mboxrd escaping without decoding attachment bytes. */
export function unescapeMboxBody(bytes: Uint8Array): Uint8Array {
  let escaped = false;
  for (let i = 0; i < bytes.length; i++) {
    if ((i === 0 || bytes[i - 1] === 0x0a) && bytes[i] === 0x3e) {
      let j = i;
      while (bytes[j] === 0x3e) j++;
      if (isFromLine(bytes, j)) { escaped = true; break; }
    }
  }
  if (!escaped) return bytes;
  const out = new Uint8Array(bytes.length);
  let w = 0;
  let lineStart = true;
  for (let i = 0; i < bytes.length; i++) {
    if (lineStart && bytes[i] === 0x3e) {
      let j = i;
      while (j < bytes.length && bytes[j] === 0x3e) j++;
      if (isFromLine(bytes, j)) {
        i++;
        lineStart = false;
        if (i < bytes.length) out[w++] = bytes[i];
        continue;
      }
    }
    out[w++] = bytes[i];
    lineStart = bytes[i] === 0x0a;
  }
  return out.subarray(0, w);
}
function expectedParts(size: number): number {
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Choose a non-empty MBOX or EML file.");
  return Math.ceil(size / PART_PLAINTEXT_BYTES);
}
function expectedPartSize(row: ImportRow, index: number): number {
  const count = expectedParts(row.sizeBytes);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) throw new Error("Invalid archive chunk index.");
  return Math.min(PART_PLAINTEXT_BYTES, row.sizeBytes - index * PART_PLAINTEXT_BYTES);
}
async function ownedMailbox(db: Db, row: Pick<ImportRow, "orgId" | "mailboxId" | "requestedByUserId">) {
  const box = await db.query.mailbox.findFirst({ where: and(eq(mail.mailbox.id, row.mailboxId), eq(mail.mailbox.orgId, row.orgId), eq(mail.mailbox.isActive, true)) });
  const access = await db.query.mailboxAccess.findFirst({ where: and(eq(mail.mailboxAccess.mailboxId, row.mailboxId), eq(mail.mailboxAccess.userId, row.requestedByUserId), eq(mail.mailboxAccess.canManage, true)) });
  if (!box || !access) throw new ImportArchiveError("The mailbox is unavailable or import permission was removed.");
  return box;
}
const LIVE = ["uploading", "queued", "running"];

export async function startImport(
  db: Db,
  input: { orgId: string; mailboxId: string; requestedByUserId: string; filename: string; sizeBytes: number; sourceFormat?: "mbox" | "eml" },
): Promise<string> {
  expectedParts(input.sizeBytes);
  await ownedMailbox(db, input);
  const format = input.sourceFormat ?? (/\.eml$/i.test(input.filename) ? "eml" : "mbox");
  if (format !== "mbox" && format !== "eml") throw new Error("Choose an MBOX or EML file.");
  const id = crypto.randomUUID();
  // Atomic guard avoids a unique migration rejecting duplicate legacy jobs.
  await db.run(sql`INSERT INTO mail_import (id, org_id, mailbox_id, requested_by_user_id, filename, size_bytes, source_format, status, created_at)
    SELECT ${id}, ${input.orgId}, ${input.mailboxId}, ${input.requestedByUserId}, ${input.filename.slice(0, 200)}, ${input.sizeBytes}, ${format}, 'uploading', ${Date.now()}
    WHERE NOT EXISTS (SELECT 1 FROM mail_import WHERE mailbox_id = ${input.mailboxId} AND status IN ('uploading','queued','running'))`);
  if (!await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, id) })) throw new Error("An import is already running for this mailbox.");
  log.warn("import.started", { importId: id, mailboxId: input.mailboxId, bytes: input.sizeBytes });
  return id;
}

/** Reserve the hash before R2: different concurrent resumes cannot overwrite. */
export async function putImportPart(
  db: Db, env: { MAIL_RAW: R2Bucket }, ck: ContentKey, importId: string, index: number, bytes: ArrayBuffer,
): Promise<void> {
  const row = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, importId) });
  if (!row) throw new Error("Import not found.");
  if (row.status !== "uploading") throw new Error("This import is no longer accepting chunks.");
  if (bytes.byteLength !== expectedPartSize(row, index)) throw new Error("The archive chunk has an unexpected size.");
  const sha256 = await contentHash(bytes);
  await db.insert(mail.mailImportPart).values({ importId, index, sizeBytes: bytes.byteLength, sha256, status: "pending" }).onConflictDoNothing();
  const manifest = await db.query.mailImportPart.findFirst({ where: and(eq(mail.mailImportPart.importId, importId), eq(mail.mailImportPart.index, index)) });
  if (!manifest || manifest.sha256 !== sha256 || manifest.sizeBytes !== bytes.byteLength) throw new Error(DIFFERENT);
  const key = importPartKey(row.orgId, importId, index);
  const stored = await getDecryptedBlob(env.MAIL_RAW, key, ck);
  if (stored) {
    if (stored.byteLength !== bytes.byteLength || await contentHash(stored) !== sha256) throw new Error(DIFFERENT);
  } else {
    await putEncryptedBlob(env.MAIL_RAW, key, ck, bytes, { httpMetadata: { contentType: "application/octet-stream" } });
  }
  await db.update(mail.mailImportPart).set({ status: "stored" }).where(and(eq(mail.mailImportPart.importId, importId), eq(mail.mailImportPart.index, index)));
  await db.update(mail.mailImport).set({ partCount: sql`(SELECT count(*) FROM mail_import_part WHERE import_id = ${importId} AND status = 'stored')` })
    .where(and(eq(mail.mailImport.id, importId), eq(mail.mailImport.status, "uploading")));
}
async function validateManifest(db: Db, row: ImportRow): Promise<void> {
  const count = expectedParts(row.sizeBytes);
  const [parts] = await db.select({
    count: sql<number>`count(*)`, bytes: sql<number>`coalesce(sum(size_bytes), 0)`,
    first: sql<number>`min("index")`, last: sql<number>`max("index")`,
    invalid: sql<number>`coalesce(sum(CASE WHEN status <> 'stored' OR length(sha256) <> 64 OR sha256 GLOB '*[^0-9a-f]*'
      OR size_bytes <> CASE WHEN "index" = ${count - 1} THEN ${row.sizeBytes - (count - 1) * PART_PLAINTEXT_BYTES} ELSE ${PART_PLAINTEXT_BYTES} END THEN 1 ELSE 0 END), 0)`,
  }).from(mail.mailImportPart).where(eq(mail.mailImportPart.importId, row.id));
  if (parts.count !== count || parts.bytes !== row.sizeBytes || parts.first !== 0 || parts.last !== count - 1 || parts.invalid !== 0) throw new ImportArchiveError(INCOMPLETE);
}
async function enqueue(db: Db, queue: Queue<MailboxImportJob>, id: string): Promise<void> {
  await queue.send({ kind: "mailbox_import", importId: id });
  await db.update(mail.mailImport).set({ nextAttemptAt: new Date(Date.now() + LEASE_MS) }).where(and(eq(mail.mailImport.id, id), eq(mail.mailImport.status, "queued")));
}
export async function finishUpload(
  db: Db, queue: Queue<MailboxImportJob>, importId: string,
  deps?: { env: { MAIL_RAW: R2Bucket }; ck: ContentKey },
): Promise<void> {
  const row = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, importId) });
  if (!row) throw new Error("Import not found.");
  if (row.status === "running" || row.status === "done") return;
  if (row.status !== "uploading" && row.status !== "queued") throw new Error("This import cannot be completed.");
  if (!deps?.env.MAIL_RAW || !deps.ck) throw new Error("Encrypted archive storage is unavailable.");
  await ownedMailbox(db, row);
  // Jobs verify R2 hashes too. The manifest keeps multi-GB scans out of HTTP.
  await validateManifest(db, row);
  await db.update(mail.mailImport).set({ status: "queued", partCount: expectedParts(row.sizeBytes), error: null, nextAttemptAt: new Date() })
    .where(and(eq(mail.mailImport.id, row.id), inArray(mail.mailImport.status, ["uploading", "queued"])));
  await enqueue(db, queue, row.id);
}
export async function cancelImport(db: Db, importId: string): Promise<void> {
  await db.update(mail.mailImport).set({ status: "canceled", completedAt: new Date(), leaseToken: null, leaseUntil: null, nextAttemptAt: null })
    .where(and(eq(mail.mailImport.id, importId), inArray(mail.mailImport.status, [...LIVE, "failed"])));
  // Retain staged bytes; in-flight work must never destroy data on cancellation.
}
export async function restartImport(db: Db, queue: Queue<MailboxImportJob>, importId: string): Promise<void> {
  const row = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, importId) });
  if (!row || row.status !== "failed") throw new Error("Only a failed import can be retried.");
  await ownedMailbox(db, row);
  await validateManifest(db, row);
  const updated = await db.update(mail.mailImport).set({
    status: "queued", error: null, completedAt: null, leaseToken: null, leaseUntil: null, attempts: 0, nextAttemptAt: new Date(),
  }).where(and(eq(mail.mailImport.id, importId), eq(mail.mailImport.status, "failed"),
    sql`NOT EXISTS (SELECT 1 FROM mail_import AS other WHERE other.mailbox_id = ${row.mailboxId} AND other.id <> ${importId} AND other.status IN ('uploading','queued','running'))`,
  )).returning({ id: mail.mailImport.id });
  if (!updated.length) throw new Error("An import is already running for this mailbox.");
  await enqueue(db, queue, importId);
}

/** Rescue lost enqueues and crashed/expired workers, independent of queue DLQ. */
export async function recoverImports(db: Db, queue: Queue<MailboxImportJob>): Promise<number> {
  const now = new Date();
  const due = await db.query.mailImport.findMany({ where: and(
    inArray(mail.mailImport.status, ["queued", "running"]),
    or(isNull(mail.mailImport.nextAttemptAt), lte(mail.mailImport.nextAttemptAt, now)),
    or(isNull(mail.mailImport.leaseUntil), lte(mail.mailImport.leaseUntil, now)),
  ), limit: 20 });
  let count = 0;
  for (const row of due) {
    const tokenMatches = row.leaseToken === null ? isNull(mail.mailImport.leaseToken) : eq(mail.mailImport.leaseToken, row.leaseToken);
    const nextMatches = row.nextAttemptAt === null ? isNull(mail.mailImport.nextAttemptAt) : eq(mail.mailImport.nextAttemptAt, row.nextAttemptAt);
    const updated = await db.update(mail.mailImport).set(row.attempts >= MAX_ATTEMPTS ? {
      status: "failed", error: "Import paused after repeated temporary failures. Retry to continue from the saved checkpoint.", leaseToken: null, leaseUntil: null, nextAttemptAt: null,
    } : { status: "queued", leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now() + LEASE_MS) })
      .where(and(eq(mail.mailImport.id, row.id), eq(mail.mailImport.status, row.status), tokenMatches, nextMatches)).returning({ id: mail.mailImport.id });
    if (!updated.length || row.attempts >= MAX_ATTEMPTS) continue;
    try { await queue.send({ kind: "mailbox_import", importId: row.id }); count++; }
    catch {
      await db.update(mail.mailImport).set({ nextAttemptAt: new Date(Date.now() + RETRY_MS) }).where(and(eq(mail.mailImport.id, row.id), eq(mail.mailImport.status, "queued")));
    }
  }
  return count;
}
async function readFrom(db: Db, env: { MAIL_RAW: R2Bucket }, ck: ContentKey, row: ImportRow, start: number, want: number): Promise<Uint8Array> {
  const length = Math.min(want, row.sizeBytes - start);
  if (length <= 0) return new Uint8Array();
  const out = new Uint8Array(length);
  const first = Math.floor(start / PART_PLAINTEXT_BYTES);
  const last = Math.floor((start + length - 1) / PART_PLAINTEXT_BYTES);
  let written = 0;
  for (let index = first; index <= last; index++) {
    const manifest = await db.query.mailImportPart.findFirst({ where: and(eq(mail.mailImportPart.importId, row.id), eq(mail.mailImportPart.index, index)) });
    const bytes = await getDecryptedBlob(env.MAIL_RAW, importPartKey(row.orgId, row.id, index), ck);
    if (!manifest || manifest.status !== "stored" || !bytes || bytes.byteLength !== manifest.sizeBytes || await contentHash(bytes) !== manifest.sha256) {
      throw new ImportArchiveError("An uploaded archive chunk is missing or damaged. The checkpoint and remaining archive were retained. Cancel this import and upload the original file again.");
    }
    const from = Math.max(0, start - index * PART_PLAINTEXT_BYTES);
    const take = Math.min(bytes.byteLength - from, out.length - written);
    out.set(bytes.subarray(from, from + take), written);
    written += take;
  }
  if (written !== out.length) throw new ImportArchiveError(INCOMPLETE);
  return out;
}
async function ensureLabel(db: Db, orgId: string, mailboxId: string, name: string): Promise<string> {
  const existing = await db.query.label.findFirst({ where: and(eq(mail.label.mailboxId, mailboxId), eq(mail.label.name, name)), columns: { id: true } });
  return existing?.id ?? (await createLabel(db, { mailboxId, orgId, name })).id;
}
type MimeMessage = Awaited<ReturnType<typeof PostalMime.parse>>;
function addresses(values: MimeMessage["to"]): string[] {
  return (values ?? []).flatMap((v) => "group" in v ? addresses(v.group) : v.address ? [v.address] : []);
}
function header(parsed: MimeMessage, name: string): string | null {
  return parsed.headers.find((h) => h.key.toLowerCase() === name)?.value ?? null;
}
/** Quoted comma-separated labels and RFC2047 names from Takeout headers. */
function labelNames(value: string): string[] {
  const names: string[] = [];
  let name = "";
  let quoted = false;
  let escaped = false;
  for (const char of value) {
    if (escaped) { name += char; escaped = false; }
    else if (char === "\\" && quoted) escaped = true;
    else if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { names.push(decodeWords(name.trim())); name = ""; }
    else name += char;
  }
  names.push(decodeWords(name.trim()));
  return names.filter(Boolean);
}
const SYSTEM_LABELS = new Set(["inbox", "sent", "sent mail", "trash", "bin", "spam", "junk", "unread", "read", "starred", "all mail"]);
function sourceState(parsed: MimeMessage, address: string) {
  const labels = labelNames(header(parsed, "x-gmail-labels") ?? "");
  const lower = new Set(labels.map((s) => s.toLowerCase()));
  const exportedPlacement = (header(parsed, "x-doota-placement") ?? "").toLowerCase();
  return {
    placement: lower.has("trash") || lower.has("bin") ? "trash" : lower.has("spam") || lower.has("junk") ? "spam" : lower.has("inbox") ? "inbox" :
      ["inbox", "archived", "trash", "spam", "sent"].includes(exportedPlacement) ? exportedPlacement : "archived",
    sent: lower.has("sent") || lower.has("sent mail") || parsed.from?.address?.toLowerCase() === address.toLowerCase(),
    read: !lower.has("unread"),
    starred: lower.has("starred"),
    labels: [...new Set([...labels.filter((s) => !SYSTEM_LABELS.has(s.toLowerCase())),
      ...labelNames(header(parsed, "x-doota-labels") ?? "")])],
  };
}
async function importOne(
  db: Db, env: { MAIL_RAW: R2Bucket }, row: ImportRow, mailbox: typeof mail.mailbox.$inferSelect,
  labelId: string, raw: Uint8Array, offset: number, endOffset: number, deps: { ck: ContentKey; searchKeyB64: string },
): Promise<Outcome> {
  const before = await db.query.mailImportMessage.findFirst({ where: and(eq(mail.mailImportMessage.importId, row.id), eq(mail.mailImportMessage.offset, offset)) });
  if (before?.endOffset !== undefined && before.endOffset !== endOffset) throw new ImportArchiveError("The archive no longer matches its saved checkpoint.");
  if (before?.status === "done") return before.outcome as Outcome;
  const hash = await contentHash(raw);
  const r2RawKey = `raw/${row.orgId}/${row.mailboxId}/${hash}`;
  let parsed: MimeMessage;
  try { parsed = await PostalMime.parse(raw); } catch { throw new ImportArchiveError("A message could not be parsed. The archive and checkpoint were retained."); }
  if (!parsed.headers.length) throw new ImportArchiveError("A message has no MIME headers. The archive and checkpoint were retained.");
  const already = await db.query.message.findFirst({ where: and(eq(mail.message.orgId, row.orgId), eq(mail.message.r2RawKey, r2RawKey)), columns: { id: true } });
  await db.insert(mail.mailImportMessage).values({ importId: row.id, offset, endOffset, outcome: already ? "skipped" : "imported", status: "pending" }).onConflictDoNothing();
  const ledger = await db.query.mailImportMessage.findFirst({ where: and(eq(mail.mailImportMessage.importId, row.id), eq(mail.mailImportMessage.offset, offset)) });
  if (!ledger) throw new Error("Import checkpoint unavailable.");
  const parsedDate = parsed.date ? Date.parse(parsed.date) : NaN;
  const pm: ParsedMessage = {
    messageIdHeader: parsed.messageId || `<${hash}@import.invalid>`,
    inReplyTo: parsed.inReplyTo ?? null, references: parsed.references ?? null,
    from: parsed.from?.address ?? null, fromName: parsed.from?.name ?? null,
    to: addresses(parsed.to), cc: addresses(parsed.cc), replyTo: addresses(parsed.replyTo)[0] ?? null,
    subject: parsed.subject ?? "", sentAt: Number.isFinite(parsedDate) ? parsedDate : row.createdAt.getTime(),
    text: parsed.text ?? null, html: parsed.html ?? null, r2RawKey, dedupeByRaw: true, threadMailboxId: row.mailboxId, attachments: [],
  };
  for (const [index, a] of parsed.attachments.entries()) {
    if (!a.filename && !a.contentId && a.disposition !== "attachment") continue;
    const key = `attachments/${row.orgId}/${row.mailboxId}/${hash}/${index}`;
    const bytes = typeof a.content === "string" ? new TextEncoder().encode(a.content) : a.content;
    await putEncryptedBlob(env.MAIL_RAW, key, deps.ck, bytes, { httpMetadata: { contentType: a.mimeType } });
    pm.attachments.push({ partId: a.contentId ?? String(index), filename: a.filename ?? null, contentType: a.mimeType, size: bytes.byteLength, r2Key: key });
  }
  if (!already) await putEncryptedBlob(env.MAIL_RAW, r2RawKey, deps.ck, raw, { httpMetadata: { contentType: "application/octet-stream" } });
  const ids = await materializeMessage(db, row.orgId, pm, deps, mailbox.searchIndexed);
  const state = sourceState(parsed, mailbox.address);
  const role = state.sent ? "from" : pm.to?.some((a) => a.toLowerCase() === mailbox.address.toLowerCase()) ? "to" : pm.cc?.some((a) => a.toLowerCase() === mailbox.address.toLowerCase()) ? "cc" : "bcc";
  await materializeDelivery(db, {
    orgId: row.orgId, ...ids, mailboxId: row.mailboxId, role, viaAliasId: null, subaddressTag: null, sentAt: pm.sentAt,
    placement: { newThread: state.placement, unarchiveOnReply: false }, isRead: state.read,
    keywords: ["$imported", ...(state.read ? ["$seen"] : []), ...(state.starred ? ["$flagged"] : [])],
  });
  // Gmail labels are per-message; a newly imported conversation must aggregate
  // its placement regardless of archive order. Existing/live/user-filed threads
  // retain their placement, and duplicate imports never resurface old history.
  if (ledger.outcome === "imported") {
    const priority = state.placement === "trash" ? 3 : state.placement === "spam" ? 2 : state.placement === "inbox" ? 1 : 0;
    if (priority) await db.update(mail.threadState).set({ placement: state.placement }).where(and(
      eq(mail.threadState.threadId, ids.threadId), eq(mail.threadState.mailboxId, row.mailboxId),
      eq(mail.threadState.placementOrigin, "default"), isNull(mail.threadState.snoozedUntil), isNull(mail.threadState.hiddenAt),
      sql`EXISTS (SELECT 1 FROM thread WHERE id = ${ids.threadId} AND created_at >= ${row.createdAt.getTime()})`,
      sql`NOT EXISTS (SELECT 1 FROM delivery d JOIN message m ON m.id = d.message_id WHERE d.mailbox_id = ${row.mailboxId}
        AND m.thread_id = ${ids.threadId} AND instr(d.keywords, '"$imported"') = 0)`,
      sql`CASE ${mail.threadState.placement} WHEN 'trash' THEN 3 WHEN 'spam' THEN 2 WHEN 'inbox' THEN 1 ELSE 0 END < ${priority}`,
    ));
  }
  if (state.starred) await db.update(mail.threadState).set({ isStarred: true }).where(and(eq(mail.threadState.threadId, ids.threadId), eq(mail.threadState.mailboxId, row.mailboxId)));
  await applyLabel(db, { threadId: ids.threadId, mailboxId: row.mailboxId, labelId });
  for (const name of state.labels) {
    const id = await ensureLabel(db, row.orgId, row.mailboxId, name);
    await applyLabel(db, { threadId: ids.threadId, mailboxId: row.mailboxId, labelId: id });
  }
  await db.update(mail.mailImportMessage).set({ status: "done" }).where(and(eq(mail.mailImportMessage.importId, row.id), eq(mail.mailImportMessage.offset, offset)));
  return ledger.outcome as Outcome;
}

/** Lease, durable per-message outcome, and CAS cursor tolerate queue redelivery. */
export async function handleImportJob(
  db: Db, env: { MAIL_RAW: R2Bucket; MAIL_QUEUE: Queue<MailboxImportJob>; MAIL_DEK: string },
  ck: ContentKey, searchKeyB64: string, job: MailboxImportJob,
): Promise<void> {
  const initial = await db.query.mailImport.findFirst({ where: eq(mail.mailImport.id, job.importId) });
  if (!initial || !["queued", "running"].includes(initial.status)) return;
  const now = new Date();
  if (initial.leaseUntil && initial.leaseUntil > now) return;
  if (initial.attempts >= MAX_ATTEMPTS) {
    await db.update(mail.mailImport).set({ status: "failed", error: "Import paused after repeated temporary failures. Retry to continue from the saved checkpoint.", leaseToken: null, leaseUntil: null, nextAttemptAt: null })
      .where(and(eq(mail.mailImport.id, initial.id), eq(mail.mailImport.status, initial.status)));
    return;
  }
  const token = crypto.randomUUID();
  const [row] = await db.update(mail.mailImport).set({
    status: "running", leaseToken: token, leaseUntil: new Date(Date.now() + LEASE_MS), nextAttemptAt: new Date(Date.now() + LEASE_MS), attempts: sql`attempts + 1`,
  }).where(and(eq(mail.mailImport.id, initial.id), eq(mail.mailImport.status, initial.status),
    initial.leaseToken === null ? isNull(mail.mailImport.leaseToken) : eq(mail.mailImport.leaseToken, initial.leaseToken),
    or(isNull(mail.mailImport.leaseUntil), lte(mail.mailImport.leaseUntil, now)),
  )).returning();
  if (!row) return;
  const owned = and(eq(mail.mailImport.id, row.id), eq(mail.mailImport.status, "running"), eq(mail.mailImport.leaseToken, token));
  try {
    const box = await ownedMailbox(db, row);
    if (row.sourceFormat !== "mbox" && row.sourceFormat !== "eml") throw new ImportArchiveError("Unsupported archive format. Choose an MBOX or EML file.");
    if (!Number.isSafeInteger(row.cursor) || row.cursor < 0 || row.cursor > row.sizeBytes || row.partCount !== expectedParts(row.sizeBytes)) throw new ImportArchiveError(INCOMPLETE);
    if (row.sourceFormat === "eml" && row.sizeBytes > MAX_IMPORT_MESSAGE_BYTES) throw new ImportArchiveError(OVERSIZED);
    const labelId = row.labelId ?? await ensureLabel(db, row.orgId, row.mailboxId,
      `Imported ${row.createdAt.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`);
    await db.update(mail.mailImport).set({ labelId }).where(owned);
    let cursor = row.cursor;
    let windowStart = cursor;
    let cachedWindow: Uint8Array = new Uint8Array();
    const deadline = Date.now() + TIME_BUDGET_MS;
    for (let n = 0; n < MAX_MESSAGES_PER_RUN && cursor < row.sizeBytes && Date.now() < deadline; n++) {
      if (!await db.query.mailImport.findFirst({ where: owned, columns: { id: true } })) return;
      if (cursor < windowStart || cursor >= windowStart + cachedWindow.length) {
        windowStart = cursor;
        cachedWindow = await readFrom(db, env, ck, row, cursor, row.sourceFormat === "eml" ? MAX_IMPORT_MESSAGE_BYTES : WINDOW_BYTES);
      }
      let window = cachedWindow.subarray(cursor - windowStart);
      let start = 0;
      if (row.sourceFormat === "mbox") {
        if (!isFromLine(window, 0)) throw new ImportArchiveError("This file is not an MBOX archive. Choose the extracted .mbox file, not its ZIP.");
        let newline = window.indexOf(0x0a);
        // A valid separator can lie at the end of the cached window while its
        // envelope newline lies in the next part. Refill before rejecting it.
        if (newline === -1 && window.length <= 4097 && cursor + window.length < row.sizeBytes) {
          window = new Uint8Array();
          cachedWindow = new Uint8Array();
          windowStart = cursor;
          cachedWindow = await readFrom(db, env, ck, row, cursor, WINDOW_BYTES);
          window = cachedWindow;
          newline = window.indexOf(0x0a);
        }
        if (newline === -1 || newline > 4096) throw new ImportArchiveError("An MBOX envelope line is invalid.");
        start = newline + 1;
      }
      let next = row.sourceFormat === "eml" ? -1 : nextSeparator(window, start);
      if (next === -1 && cursor + window.length < row.sizeBytes) {
        window = new Uint8Array();
        cachedWindow = new Uint8Array();
        windowStart = cursor;
        cachedWindow = await readFrom(db, env, ck, row, cursor, MAX_IMPORT_MESSAGE_BYTES + 4097);
        window = cachedWindow;
        next = nextSeparator(window, start);
      }
      const end = next === -1 ? window.length : next;
      if ((next === -1 && cursor + end < row.sizeBytes) || end - start > MAX_IMPORT_MESSAGE_BYTES) throw new ImportArchiveError(OVERSIZED);
      const raw = row.sourceFormat === "eml" ? window : unescapeMboxBody(window.subarray(start, end));
      if (!raw.byteLength || raw.byteLength > MAX_IMPORT_MESSAGE_BYTES) throw new ImportArchiveError(OVERSIZED);
      const endOffset = cursor + end;
      const outcome = await importOne(db, env, row, box, labelId, raw, cursor, endOffset, { ck, searchKeyB64 });
      const updated = await db.update(mail.mailImport).set({
        cursor: endOffset, messageCount: outcome === "imported" ? sql`message_count + 1` : sql`message_count`,
        skippedCount: outcome === "skipped" ? sql`skipped_count + 1` : sql`skipped_count`, error: null,
      }).where(and(owned, eq(mail.mailImport.cursor, cursor))).returning({ id: mail.mailImport.id });
      if (!updated.length) return;
      cursor = endOffset;
    }
    const done = cursor >= row.sizeBytes;
    const updated = await db.update(mail.mailImport).set({
      status: done ? "done" : "queued", attempts: 0, leaseToken: null, leaseUntil: null,
      nextAttemptAt: done ? null : new Date(), completedAt: done ? new Date() : null, error: null,
    }).where(owned).returning({ id: mail.mailImport.id });
    if (!updated.length) return;
    if (!done) { await enqueue(db, env.MAIL_QUEUE, row.id); return; }
    for (let i = 0; i < row.partCount; i++) await env.MAIL_RAW.delete(importPartKey(row.orgId, row.id, i)).catch(() => {});
    log.warn("import.completed", { importId: row.id });
  } catch (err) {
    const permanent = err instanceof ImportArchiveError;
    await db.update(mail.mailImport).set({
      status: permanent ? "failed" : "queued", leaseToken: null, leaseUntil: null,
      error: permanent ? err.message : "A temporary storage or database failure paused the import. It will retry from the saved checkpoint.",
      nextAttemptAt: permanent ? null : new Date(Date.now() + RETRY_MS),
    }).where(owned);
    log.warn("import.paused", { importId: row.id, temporary: !permanent });
    if (!permanent) throw new Error("Temporary import storage or database failure.");
  }
}
