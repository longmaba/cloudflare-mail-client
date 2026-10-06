// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { importKey, getDecryptedBlob, decryptContent } from "@doota/mail-core/crypto";
import { startImport, putImportPart, finishUpload, handleImportJob, recoverImports, cancelImport, restartImport, importPartKey, PART_PLAINTEXT_BYTES, MAX_IMPORT_MESSAGE_BYTES } from "@doota/mail-core/import";
import { getThread, listThreads } from "@doota/mail-core/read";

const KEY = btoa("0123456789abcdef0123456789abcdef");
const enc = new TextEncoder();
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: ReturnType<typeof bucket>;
let queue: { sent: { kind: "mailbox_import"; importId: string }[]; send: ReturnType<typeof vi.fn> };
function bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: vi.fn(async (key: string, bytes: ArrayBuffer | Uint8Array) => { store.set(key, new Uint8Array(bytes)); }),
    get: vi.fn(async (key: string) => {
      const bytes = store.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) } : null;
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}
const env = () => ({ MAIL_RAW: r2 as never, MAIL_QUEUE: queue as never, MAIL_DEK: KEY });
const record = (id: string) => db.query.mailImport.findFirst({ where: eq(schema.mailImport.id, id) });
const run = (id: string) => handleImportJob(db, env(), ck, KEY, { kind: "mailbox_import", importId: id });
async function stage(bytes: Uint8Array | string, mailboxId = "a", format: "mbox" | "eml" = "mbox") {
  const raw = typeof bytes === "string" ? enc.encode(bytes) : bytes;
  const id = await startImport(db, { orgId: "org", mailboxId, requestedByUserId: "owner", filename: `mail.${format}`, sourceFormat: format, sizeBytes: raw.length });
  for (let i = 0; i * PART_PLAINTEXT_BYTES < raw.length; i++) {
    await putImportPart(db, env(), ck, id, i, raw.slice(i * PART_PLAINTEXT_BYTES, (i + 1) * PART_PLAINTEXT_BYTES).buffer);
  }
  await finishUpload(db, queue as never, id, { env: env(), ck });
  return id;
}
async function importArchive(raw: string | Uint8Array, mailboxId = "a", format: "mbox" | "eml" = "mbox") {
  const id = await stage(raw, mailboxId, format);
  for (let i = 0; i < 10 && (await record(id)).status !== "done"; i++) await run(id);
  return id;
}
function message(id: string, extra = "", body = "body", subject = id) {
  return `Message-ID: <${id}@example.net>\r\nFrom: Sender <sender@example.net>\r\nTo: owner@example.com\r\nDate: Thu, 1 Jan 1970 00:00:00 +0000\r\nSubject: ${subject}\r\n${extra}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`;
}
const mbox = (...messages: string[]) => messages.map((raw) => `From sender@example.net Thu Jan 1 00:00:00 1970\r\n${raw}`).join("");
const multipart = () => [
  "Message-ID: <multipart@example.net>",
  'From: "Nguyen Example" <sender@example.net>',
  "To: owner@example.com, Other <other@example.net>",
  "Cc: colleague@example.net", "Reply-To: reply@example.net",
  "Date: Sat, 1 Aug 2020 10:30:00 +0000", "Subject: Rich fixture",
  'X-Gmail-Labels: Inbox,Unread,Starred,Important,=?UTF-8?B?SMOzYSDEkcahbg==?=,"Work, old",=?UTF-8?B?RW5jb2RlZCwgbmFtZQ==?=',
  "MIME-Version: 1.0", 'Content-Type: multipart/mixed; boundary="mixed"', "",
  "--mixed", 'Content-Type: text/html; charset="utf-8"', "", '<p>hello</p><img src="cid:logo">',
  "--mixed", 'Content-Type: application/octet-stream; name="file.bin"',
  'Content-Disposition: attachment; filename="file.bin"', "Content-Transfer-Encoding: base64", "", "AAEC/w==",
  "--mixed", 'Content-Type: image/png; name="logo.png"',
  'Content-Disposition: inline; filename="logo.png"', "Content-ID: <logo>", "Content-Transfer-Encoding: base64", "", "AQID",
  "--mixed--", "",
].join("\r\n");

beforeEach(async () => {
  db = await makeDb({ maxBindings: 100 }); ck = await importKey(KEY); r2 = bucket();
  queue = { sent: [], send: vi.fn(async (job) => { queue.sent.push(job); }) };
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com", updatedAt: new Date() });
  await db.insert(schema.mailbox).values([
    { id: "a", orgId: "org", address: "owner@example.com", localPart: "owner", isPersonal: true },
    { id: "b", orgId: "org", address: "second@example.com", localPart: "second", isPersonal: true },
  ]);
  await db.insert(schema.mailboxAccess).values(["a", "b"].map((mailboxId) => ({ userId: "owner", mailboxId, canManage: true })));
});

describe("encrypted historical MIME materialization", () => {
  it("preserves Gmail flags, recipients, date, Unicode labels and regular/inline attachment bytes", async () => {
    const raw = multipart();
    const id = await importArchive(mbox(raw));
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1, skippedCount: 0, failedCount: 0 });
    const [stored] = await db.query.message.findMany();
    expect(stored).toMatchObject({ fromAddr: "sender@example.net", fromName: "Nguyen Example", replyTo: "reply@example.net" });
    expect(JSON.parse(stored.toAddrs)).toEqual(["owner@example.com", "other@example.net"]);
    expect(JSON.parse(stored.ccAddrs)).toEqual(["colleague@example.net"]);
    expect(stored.sentAt.toISOString()).toBe("2020-08-01T10:30:00.000Z");
    const [delivery] = await db.query.delivery.findMany();
    expect(delivery.isRead).toBe(false);
    expect(JSON.parse(delivery.keywords)).toEqual(["$imported", "$flagged"]);
    const [state] = await db.query.threadState.findMany();
    expect(state).toMatchObject({ placement: "inbox", isStarred: true });
    const labels = (await db.query.label.findMany()).map((v: { name: string }) => v.name);
    expect(labels).toContain("Hóa đơn"); expect(labels).toContain("Work, old");
    expect(labels).toContain("Important"); expect(labels).toContain("Encoded, name");
    const attachments = await db.query.attachment.findMany();
    expect(attachments).toHaveLength(2);
    for (const [filename, bytes] of [["file.bin", [0, 1, 2, 255]], ["logo.png", [1, 2, 3]]] as const) {
      const attachment = attachments.find((v: { filename: string }) => v.filename === filename);
      expect([...(await getDecryptedBlob(r2 as never, attachment.r2Key, ck))!]).toEqual(bytes);
      expect(attachment.inline).toBe(filename === "logo.png");
    }
    expect(new TextDecoder().decode((await getDecryptedBlob(r2 as never, stored.r2RawKey, ck))!)).toBe(raw);
    expect(new TextDecoder().decode(r2.store.get(stored.r2RawKey))).not.toContain("Rich fixture");
    const dto = await getThread(db, { threadId: stored.threadId, mailboxId: "a", ck, userId: "owner" });
    const item = dto!.items.find((v) => v.type === "external_message")!;
    expect(item.attachments).toHaveLength(2);
    expect(item.isRead).toBe(false);
    expect(await db.query.threadRead.findMany()).toHaveLength(0);
  });

  it("imports Sent as an outbound delivery and shows it in the server Sent view", async () => {
    const raw = message("sent", "X-Gmail-Labels: Sent,Read\r\n").replace("Sender <sender@example.net>", "Owner <owner@example.com>");
    await importArchive(mbox(raw));
    const [stored] = await db.query.message.findMany();
    const [delivery] = await db.query.delivery.findMany();
    expect(delivery).toMatchObject({ role: "from", isRead: true });
    const sent = await listThreads(db, { mailboxId: "a", placement: "sent", ck, userId: "owner" });
    expect(sent.map((v) => v.threadId)).toEqual([stored.threadId]);
    const item = (await getThread(db, { threadId: stored.threadId, mailboxId: "a", ck }))!.items.find((v) => v.type === "external_message")!;
    expect(item.outbound).toBe(true);
    expect(await db.query.submission.findMany()).toHaveLength(0);
  });

  it.each([["Inbox", "inbox"], ["Trash", "trash"], ["Spam", "spam"], ["All Mail", "archived"]])("places %s mail in %s", async (label, placement) => {
    await importArchive(mbox(message("placement", `X-Gmail-Labels: ${label}\r\n`)));
    expect((await db.query.threadState.findMany())[0].placement).toBe(placement);
  });

  it.each([false, true])("aggregates Sent and Inbox thread placement in either source order (%s)", async (reverse) => {
    const sent = message("mixed-sent", "X-Gmail-Labels: Sent,Read\r\n", "sent", "Mixed thread").replace("Sender <sender@example.net>", "Owner <owner@example.com>");
    const reply = message("mixed-reply", "In-Reply-To: <mixed-sent@example.net>\r\nX-Gmail-Labels: Inbox,Read\r\n", "reply", "Mixed thread");
    // In reverse source order, References must point to the earlier imported
    // reply too, so the second record still belongs to the same conversation.
    const reverseSent = sent.replace("Content-Type:", "References: <mixed-reply@example.net>\r\nContent-Type:");
    await importArchive(reverse ? mbox(reply, reverseSent) : mbox(sent, reply));
    const [state] = await db.query.threadState.findMany();
    expect(await db.query.threadState.findMany()).toHaveLength(1);
    expect(state.placement).toBe("inbox");
    expect(await listThreads(db, { mailboxId: "a", placement: "inbox", ck })).toHaveLength(1);
    expect(await listThreads(db, { mailboxId: "a", placement: "sent", ck })).toHaveLength(1);
  });

  it("preserves preexisting default archive placement when later importing an Inbox reply", async () => {
    await importArchive(mbox(message("archived-existing", "X-Gmail-Labels: All Mail\r\n", "existing", "Existing thread")));
    const [stored] = await db.query.message.findMany();
    await db.update(schema.thread).set({ createdAt: new Date(0) }).where(eq(schema.thread.id, stored.threadId));
    await importArchive(mbox(message("inbox-history", "In-Reply-To: <archived-existing@example.net>\r\nX-Gmail-Labels: Inbox\r\n", "older reply", "Existing thread")));
    expect((await db.query.threadState.findMany())[0]).toMatchObject({ placement: "archived", placementOrigin: "default" });
  });

  it("distinguishes sender-controlled identical Message-IDs and never overwrites canonical MIME", async () => {
    const first = message("same", "", "first");
    const second = message("same", "", "second");
    await importArchive(mbox(first, second));
    const messages = await db.query.message.findMany();
    expect(messages).toHaveLength(2);
    expect(new Set(messages.map((v: { r2RawKey: string }) => v.r2RawKey)).size).toBe(2);
    expect(await Promise.all(messages.map((v: { bodyFullEnc: string }) => decryptContent(ck, v.bodyFullEnc)))).toEqual(expect.arrayContaining(["first\n", "second\n"]));
  });

  it("deduplicates within a mailbox, isolates another mailbox, and keeps deterministic missing IDs", async () => {
    const raw = message("missing").replace("Message-ID: <missing@example.net>\r\n", "");
    const first = await importArchive(mbox(raw));
    const [original] = await db.query.message.findMany();
    const again = await importArchive(mbox(raw));
    expect(await record(first)).toMatchObject({ messageCount: 1 });
    expect(await record(again)).toMatchObject({ messageCount: 0, skippedCount: 1 });
    await importArchive(mbox(raw), "b");
    const messages = await db.query.message.findMany();
    expect(messages).toHaveLength(2);
    expect(messages[0].messageIdHeader).toBe(messages[1].messageIdHeader);
    expect(original.messageIdHeader).toMatch(/^<[a-f0-9]{64}@import\.invalid>$/);
    expect(new Set(messages.map((v: { threadId: string }) => v.threadId)).size).toBe(2);
    expect(await getThread(db, { threadId: original.threadId, mailboxId: "b", ck })).toBeNull();
  });

  it("does not attach forged references or subject matches to another mailbox", async () => {
    await importArchive(mbox(message("private", "", "private", "Shared words")), "b");
    const [privateMessage] = await db.query.message.findMany();
    await importArchive(mbox(message("forged", "In-Reply-To: <private@example.net>\r\n", "new", "Shared words")), "a");
    const messages = await db.query.message.findMany();
    const imported = messages.find((v: { messageIdHeader: string }) => v.messageIdHeader === "<forged@example.net>");
    expect(imported.threadId).not.toBe(privateMessage.threadId);
    expect((await getThread(db, { threadId: imported.threadId, mailboxId: "a", ck }))!.items).toHaveLength(1);
  });

  it("leaves EML From lines untouched and preserves the epoch date", async () => {
    const raw = message("eml", "", "From body line\r\n>From literal line");
    await importArchive(raw, "a", "eml");
    const [stored] = await db.query.message.findMany();
    expect(stored.sentAt.getTime()).toBe(0);
    expect(new TextDecoder().decode((await getDecryptedBlob(r2 as never, stored.r2RawKey, ck))!)).toBe(raw);
    expect(await db.query.message.findMany()).toHaveLength(1);
  });

  it("preserves an owner placement/read cursor/star while adding older thread messages", async () => {
    await importArchive(mbox(message("first", "X-Gmail-Labels: Inbox,Starred\r\n", "first", "Conversation")));
    const [stored] = await db.query.message.findMany();
    await db.update(schema.threadState).set({ placement: "trash" }).where(eq(schema.threadState.threadId, stored.threadId));
    await db.insert(schema.threadRead).values({ orgId: "org", userId: "owner", threadId: stored.threadId, mailboxId: "a", lastReadAt: new Date(1000) });
    await importArchive(mbox(message("reply", "In-Reply-To: <first@example.net>\r\nX-Gmail-Labels: Inbox,Unread\r\n", "reply", "Conversation")));
    const state = (await db.query.threadState.findMany())[0];
    expect(state).toMatchObject({ placement: "trash", isStarred: true });
    expect((await db.query.threadRead.findMany())[0].lastReadAt.getTime()).toBe(1000);
  });
});

describe("durable import jobs", () => {
  it("checkpoints each batch and duplicate concurrent queue deliveries run only once", async () => {
    const id = await stage(mbox(...Array.from({ length: 15 }, (_, i) => message(`batch-${i}`))));
    r2.get.mockClear();
    await Promise.all([run(id), run(id)]);
    expect(await record(id)).toMatchObject({ status: "queued", messageCount: 12 });
    // One encrypted part/window serves all twelve small messages.
    expect(r2.get).toHaveBeenCalledTimes(1);
    await run(id); await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 15, skippedCount: 0 });
    expect(await db.query.message.findMany()).toHaveLength(15);
  });

  it("retains planned counts and attachment IDs when a crash follows materialization before cursor commit", async () => {
    const id = await stage(mbox(multipart()));
    await db.run(sql`CREATE TRIGGER fail_import_cursor BEFORE UPDATE OF cursor ON mail_import WHEN NEW.cursor > 0 BEGIN SELECT RAISE(ABORT, 'PRIVATE_DATABASE_DIAGNOSTIC'); END`);
    await expect(run(id)).rejects.toThrow("Temporary import storage or database failure.");
    expect(await record(id)).toMatchObject({ status: "queued", cursor: 0, messageCount: 0, skippedCount: 0 });
    const attachments = await db.query.attachment.findMany();
    expect(await db.query.mailImportMessage.findMany()).toMatchObject([{ status: "done", outcome: "imported" }]);
    await db.run(sql`DROP TRIGGER fail_import_cursor`);
    await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1, skippedCount: 0 });
    expect((await db.query.attachment.findMany()).map((v: { id: string }) => v.id)).toEqual(attachments.map((v: { id: string }) => v.id));
    expect(await db.query.message.findMany()).toHaveLength(1);
  });

  it("does not turn temporary R2 failures into skipped mail and retries the saved source", async () => {
    const id = await stage(mbox(multipart()));
    r2.put.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_BODY"));
    await expect(run(id)).rejects.toThrow("Temporary import storage or database failure.");
    expect(await record(id)).toMatchObject({ status: "queued", cursor: 0, messageCount: 0, skippedCount: 0, failedCount: 0 });
    expect(r2.store.has(importPartKey("org", id, 0))).toBe(true);
    await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1, skippedCount: 0 });
  });

  it("rescues enqueue failure and expired leases while preserving the byte checkpoint", async () => {
    const id = await stage(mbox(message("recovery")));
    await db.update(schema.mailImport).set({ status: "running", leaseToken: "crashed", leaseUntil: new Date(0), nextAttemptAt: new Date(0) }).where(eq(schema.mailImport.id, id));
    queue.send.mockRejectedValueOnce(new Error("PRIVATE_QUEUE_DETAIL"));
    expect(await recoverImports(db, queue as never)).toBe(0);
    expect(await record(id)).toMatchObject({ status: "queued", cursor: 0 });
    await db.update(schema.mailImport).set({ nextAttemptAt: new Date(0) }).where(eq(schema.mailImport.id, id));
    expect(await recoverImports(db, queue as never)).toBe(1);
    await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1 });
  });

  it("does not overwrite a cancellation or delete staged data during an in-flight message", async () => {
    const id = await stage(mbox(message("cancel-first"), message("cancel-next")));
    const put = r2.put.getMockImplementation()!;
    r2.put.mockImplementationOnce(async (...args) => { await cancelImport(db, id); return put(...args); });
    await run(id); await run(id);
    expect(await record(id)).toMatchObject({ status: "canceled", cursor: 0, messageCount: 0 });
    expect(await db.query.message.findMany()).toHaveLength(1);
    expect(r2.store.has(importPartKey("org", id, 0))).toBe(true);
    expect(r2.delete).not.toHaveBeenCalled();
  });

  it("retains missing chunks and reports an actionable failure instead of a false EOF", async () => {
    const id = await stage(mbox(message("missing-part")));
    r2.store.delete(importPartKey("org", id, 0));
    await run(id);
    const row = await record(id);
    expect(row).toMatchObject({ status: "failed", cursor: 0, messageCount: 0 });
    expect(row.error).toContain("upload the original file again");
  });

  it("enforces one live import and retries failed jobs without resetting checkpoints", async () => {
    const id = await stage(mbox(message("retry")));
    await expect(startImport(db, { orgId: "org", mailboxId: "a", requestedByUserId: "owner", filename: "next.mbox", sizeBytes: 4 })).rejects.toThrow("already running");
    await db.update(schema.mailImport).set({ status: "failed", attempts: 10 }).where(eq(schema.mailImport.id, id));
    await restartImport(db, queue as never, id);
    expect(await record(id)).toMatchObject({ status: "queued", attempts: 0, cursor: 0 });
    await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1 });
  });
});

describe("bounded MIME windows", () => {
  it("refills an MBOX envelope split by the cached window boundary", async () => {
    const first = new Uint8Array(16 * 1024 * 1024 - 7);
    first.fill(0x41);
    first.set(enc.encode("From sender@example.net Thu Jan 1 00:00:00 1970\r\nMessage-ID: <boundary@example.net>\r\nFrom: sender@example.net\r\nTo: owner@example.com\r\nSubject: Boundary fixture\r\nContent-Type: application/octet-stream; name=boundary.bin\r\nContent-Disposition: attachment; filename=boundary.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n"));
    first[first.length - 1] = 0x0a;
    const second = enc.encode(mbox(message("after-boundary")));
    const archive = new Uint8Array(first.length + second.length);
    archive.set(first); archive.set(second, first.length);
    const id = await stage(archive);
    await run(id);
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 2, cursor: archive.length });
    expect(await db.query.message.findMany()).toHaveLength(2);
  }, 30_000);

  it("imports an actual 25 MiB attachment MIME message beyond the 16 MiB window", async () => {
    const prefix = enc.encode("Message-ID: <large@example.net>\r\nFrom: sender@example.net\r\nTo: owner@example.com\r\nSubject: Large fixture\r\nContent-Type: application/octet-stream; name=large.bin\r\nContent-Disposition: attachment; filename=large.bin\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    const raw = new Uint8Array(MAX_IMPORT_MESSAGE_BYTES);
    raw.fill(0x41); raw.set(prefix);
    const envelope = enc.encode("From sender@example.net Thu Jan 1 00:00:00 1970\r\n");
    const archive = new Uint8Array(raw.length + envelope.length); archive.set(envelope); archive.set(raw, envelope.length);
    const id = await stage(archive);
    r2.get.mockClear();
    const started = performance.now();
    await run(id);
    const elapsed = performance.now() - started;
    expect(await record(id)).toMatchObject({ status: "done", messageCount: 1, cursor: archive.length });
    expect(elapsed).toBeLessThan(12_000);
    expect(r2.get).toHaveBeenCalledTimes(6); // initial two parts, then four bounded extended-window parts.
    const [attachment] = await db.query.attachment.findMany();
    expect(attachment.size).toBeGreaterThan(18 * 1024 * 1024);
    expect((await getDecryptedBlob(r2 as never, attachment.r2Key, ck))!.byteLength).toBe(attachment.size);
  }, 30_000);

  it("pauses oversized EML without losing the archive, cursor or mail", async () => {
    const raw = new Uint8Array(MAX_IMPORT_MESSAGE_BYTES + 1);
    raw.set(enc.encode(message("oversize")));
    const id = await stage(raw, "a", "eml");
    await run(id);
    expect(await record(id)).toMatchObject({ status: "failed", cursor: 0, messageCount: 0 });
    expect((await record(id)).error).toContain("25 MiB MIME limit");
    expect(r2.store.has(importPartKey("org", id, 0))).toBe(true);
    expect(await db.query.message.findMany()).toHaveLength(0);
  }, 30_000);
});
