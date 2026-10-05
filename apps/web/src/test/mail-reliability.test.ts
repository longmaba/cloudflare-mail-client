// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { getDecryptedBlob, importKey, putEncryptedBlob } from "@doota/mail-core/crypto";
import { handleEmail } from "@doota/mail-core/inbound-worker";
import { handleQueue } from "@doota/mail-core/queue-consumer";
import { sweepDueInboundReceipts, replayInboundReceipt, MAX_INBOUND_ATTEMPTS } from "@doota/mail-core/inbound-receipts";
import { enqueueSend } from "@doota/mail-core/outbound";
import { createDraft, getDraft, sendDraft, stageDraftAttachment } from "@doota/mail-core/drafts";
import { selectProvider } from "@doota/mail-core/provider";
import { assertOutboundSize, base64WireBytes, MAX_OUTBOUND_BYTES, outboundWireBytes } from "@doota/mail-core/outbound-size";
import type { InboundJob, MailEnv } from "@doota/mail-core/inbound-worker";

// Use the real SQLite/migration harness while adapting only the D1 entry point.
vi.mock("drizzle-orm/d1", () => ({ drizzle: (db: unknown) => db }));
const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
let blobs: Map<string, ArrayBuffer>;
let put: ReturnType<typeof vi.fn>;
let get: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let env: MailEnv;

beforeEach(async () => {
  db = await makeDb();
  await db.insert(schema.organization).values({ id: "org", name: "Team", slug: "team", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.orgMailSettings).values({ orgId: "org", routingSubdomains: "[]" });
  await db.insert(schema.user).values({ id: "u", name: "User", email: "a@example.com", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  await db.insert(schema.mailbox).values([
    { id: "a", orgId: "org", localPart: "a", address: "a@example.com", isActive: true, isPersonal: true },
    { id: "b", orgId: "org", localPart: "b", address: "b@example.com", isActive: true, isPersonal: true },
  ]);
  await db.insert(schema.mailboxAccess).values({ id: "grant", userId: "u", mailboxId: "a", canSend: true, canManage: true });
  invalidateDomainCache();
  ck = await importKey(KEY);
  blobs = new Map();
  put = vi.fn(async (key: string, value: ArrayBuffer | ArrayBufferView) => {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    blobs.set(key, bytes.slice().buffer);
  });
  get = vi.fn(async (key: string) => blobs.has(key) ? { arrayBuffer: async () => blobs.get(key)!.slice(0) } : null);
  send = vi.fn(async (_job: unknown) => {});
  env = { DB: db, MAIL_RAW: { put, get } as unknown as R2Bucket, MAIL_QUEUE: { send } as unknown as MailEnv["MAIL_QUEUE"], MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY };
});

function incoming(body = "hello", to = "a@example.com", id = "<reused@sender.test>") {
  const raw = `From: Sender <sender@outside.test>\r\nTo: a@example.com, b@example.com\r\nMessage-ID: ${id}\r\nSubject: Test\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
  return { raw, message: { from: "sender@outside.test", to, headers: new Headers({ "message-id": id }), raw: new Response(raw).body!, setReject: vi.fn() } };
}
function queued(job: InboundJob) { return { body: job, ack: vi.fn(), retry: vi.fn() }; }
const outboundEnv = () => ({ MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY, MAIL_RAW: env.MAIL_RAW, MAIL_OUT_QUEUE: { send } as never });

describe("durable inbound receipt", () => {
  it("different raw bytes sharing a Message-ID never overwrite or collapse", async () => {
    const first = incoming("first"); const second = incoming("second");
    await handleEmail(first.message, env); await handleEmail(second.message, env);
    const jobs = send.mock.calls.map(([job]) => job as InboundJob);
    expect(jobs[0].r2RawKey).not.toBe(jobs[1].r2RawKey);
    expect(new TextDecoder().decode((await getDecryptedBlob(env.MAIL_RAW, jobs[0].r2RawKey, ck))!)).toBe(first.raw);
    expect(new TextDecoder().decode((await getDecryptedBlob(env.MAIL_RAW, jobs[1].r2RawKey, ck))!)).toBe(second.raw);
    await handleQueue({ messages: jobs.map(queued) }, env);
    expect(await db.query.message.findMany()).toHaveLength(2);
  });

  it("same content dedupes per recipient; complete duplicates do not reprocess", async () => {
    await handleEmail(incoming().message, env); await handleEmail(incoming("hello", "b@example.com").message, env);
    const jobs = send.mock.calls.map(([job]) => job as InboundJob);
    expect(jobs[0].r2RawKey).toBe(jobs[1].r2RawKey);
    await handleQueue({ messages: jobs.map(queued) }, env);
    const duplicate = queued(jobs[0]); const reads = get.mock.calls.length;
    await handleQueue({ messages: [duplicate] }, env);
    expect(duplicate.ack).toHaveBeenCalledOnce(); expect(get.mock.calls.length).toBe(reads);
    expect(await db.query.message.findMany()).toHaveLength(1);
    expect(await db.query.delivery.findMany()).toHaveLength(2);
    expect((await db.query.inboundReceipt.findMany()).map((r: { status: string }) => r.status)).toEqual(["complete", "complete"]);
  });

  it("does not enqueue or accept before R2 persistence completes; storage errors propagate", async () => {
    let finish!: () => void;
    put.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    const receiving = handleEmail(incoming().message, env);
    await vi.waitFor(() => expect(put).toHaveBeenCalled());
    expect(send).not.toHaveBeenCalled();
    finish(); await receiving; expect(send).toHaveBeenCalledOnce();
    put.mockRejectedValueOnce(new Error("R2 unavailable"));
    await expect(handleEmail(incoming("other").message, env)).rejects.toThrow("R2 unavailable");
    expect(send).toHaveBeenCalledOnce();
  });

  it("queue failure retains encrypted raw and a failed receipt that cron replays", async () => {
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    const mail = incoming();
    await expect(handleEmail(mail.message, env)).rejects.toThrow("Queue unavailable");
    const receipt = (await db.query.inboundReceipt.findMany())[0];
    expect(receipt).toMatchObject({ status: "failed", lastError: "Queue unavailable" });
    expect(new TextDecoder().decode((await getDecryptedBlob(env.MAIL_RAW, receipt.r2RawKey, ck))!)).toBe(mail.raw);
    expect(new TextDecoder().decode(new Uint8Array(blobs.get(receipt.r2RawKey)!))).not.toContain("hello");
    await db.update(schema.inboundReceipt).set({ nextAttemptAt: new Date(0) }).where(eq(schema.inboundReceipt.id, receipt.id));
    expect(await sweepDueInboundReceipts(db, env.MAIL_QUEUE)).toBe(1);
    expect(send.mock.calls[1][0]).toMatchObject({ receiptId: receipt.id, r2RawKey: receipt.r2RawKey });
  });

  it("waits for enqueue before accepting received mail", async () => {
    let finish!: () => void; let accepted = false;
    send.mockImplementationOnce(async () => new Promise<void>((resolve) => { finish = resolve; }));
    const receiving = handleEmail(incoming().message, env).then(() => { accepted = true; });
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(accepted).toBe(false);
    finish(); await receiving; expect(accepted).toBe(true);
  });

  it("consumer read failure is durable, retries, caps automatic replay, and supports explicit replay", async () => {
    await handleEmail(incoming().message, env);
    const job = send.mock.calls[0][0] as InboundJob;
    get.mockRejectedValueOnce(new Error("R2 read unavailable"));
    const message = queued(job); await handleQueue({ messages: [message] }, env);
    expect(message.retry).toHaveBeenCalledOnce(); expect(message.ack).not.toHaveBeenCalled();
    const receipt = await db.query.inboundReceipt.findFirst();
    expect(receipt).toMatchObject({ status: "failed", attempts: 1, lastError: "R2 read unavailable" });
    await db.update(schema.inboundReceipt).set({ attempts: MAX_INBOUND_ATTEMPTS, nextAttemptAt: new Date(0) }).where(eq(schema.inboundReceipt.id, receipt.id));
    expect(await sweepDueInboundReceipts(db, env.MAIL_QUEUE)).toBe(0);
    await replayInboundReceipt(db, env.MAIL_QUEUE, receipt.id);
    await handleQueue({ messages: [queued(job)] }, env);
    expect(await db.query.inboundReceipt.findFirst()).toMatchObject({ status: "complete", attempts: 1 });
    expect(blobs.has(receipt.r2RawKey)).toBe(true);
  });

  it("binary MIME attachments survive receipt, encrypted staging and duplicate delivery", async () => {
    const bytes = new Uint8Array([0, 255, 128, 10, 13, 42]);
    const raw = `From: sender@outside.test\r\nTo: a@example.com\r\nMessage-ID: <binary@sender.test>\r\nSubject: Binary\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=part\r\n\r\n--part\r\nContent-Type: text/plain\r\n\r\nhello\r\n--part\r\nContent-Type: application/octet-stream\r\nContent-Disposition: attachment; filename="binary.bin"\r\nContent-Transfer-Encoding: base64\r\n\r\n${btoa(String.fromCharCode(...bytes))}\r\n--part--\r\n`;
    await handleEmail({ from: "sender@outside.test", to: "a@example.com", headers: new Headers({ "message-id": "<binary@sender.test>" }), raw: new Response(raw).body!, setReject: vi.fn() }, env);
    const job = send.mock.calls[0][0] as InboundJob;
    await handleQueue({ messages: [queued(job), queued(job)] }, env);
    const attachment = await db.query.attachment.findFirst();
    expect(await getDecryptedBlob(env.MAIL_RAW, attachment.r2Key, ck)).toEqual(bytes);
    expect([...blobs.keys()].filter((key) => key.startsWith("attachments/"))).toHaveLength(1);
  });
});

describe("complete outbound wire preflight", () => {
  const email = (size: number) => ({ from: { email: "a@example.com" }, to: ["outside@recipient.test"], subject: "File", text: "hello", attachments: [{ filename: "binary.bin", contentType: "application/octet-stream", content: new ArrayBuffer(size) }] });
  it("counts base64 folding, body representations, non-ASCII headers and MIME overhead", () => {
    expect(base64WireBytes(3)).toBe(6);
    const size = 4 * 1024 * 1024;
    expect(outboundWireBytes(email(size))).toBeGreaterThan(MAX_OUTBOUND_BYTES);
    expect(() => assertOutboundSize(email(size))).toThrow(/5 MiB/);
    expect(() => assertOutboundSize(email(3 * 1024 * 1024))).not.toThrow();
    expect(outboundWireBytes({ ...email(0), subject: "Tiếng Việt", html: "<p>こんにちは</p>" })).toBeGreaterThan(outboundWireBytes(email(0)));
  });

  it("refuses oversized actual attachment bytes before any submission or queue mutation", async () => {
    await putEncryptedBlob(env.MAIL_RAW, "large", ck, new Uint8Array(4 * 1024 * 1024));
    await expect(enqueueSend(db, outboundEnv(), { orgId: "org", mailboxId: "a", createdByUserId: "u", fromAddress: "a@example.com", to: ["outside@recipient.test"], subject: "File", idempotencyKey: "large", attachments: [{ r2Key: "large", filename: "file.bin", contentType: "application/octet-stream", size: 1 }] })).rejects.toThrow(/5 MiB/);
    expect(await db.query.submission.findMany()).toHaveLength(0); expect(await db.query.message.findMany()).toHaveLength(0); expect(send).not.toHaveBeenCalled();
  });

  it("keeps an oversized draft editable with its saved body and a 413 error", async () => {
    const draft = await createDraft(db, ck, "u", { mailboxId: "a", kind: "new", to: ["outside@recipient.test"], body: "x".repeat(3 * 1024 * 1024) });
    await expect(sendDraft(db, outboundEnv(), ck, "u", { draftId: draft.id })).rejects.toMatchObject({ status: 413, body: { message: expect.stringContaining("Your draft has been kept") } });
    const kept = await getDraft(db, ck, draft.id, "u");
    expect(kept?.status).toBe("editing"); expect(kept?.body?.length).toBe(3 * 1024 * 1024);
    expect(send).not.toHaveBeenCalled(); expect(await db.query.submission.findMany()).toHaveLength(0);
  });

  it("a failed outbound enqueue retains one durable queued send instead of reopening its draft", async () => {
    const draft = await createDraft(db, ck, "u", { mailboxId: "a", kind: "new", to: ["outside@recipient.test"], body: "hello" });
    send.mockRejectedValueOnce(new Error("Queue unavailable"));
    const result = await sendDraft(db, outboundEnv(), ck, "u", { draftId: draft.id });
    expect(await db.query.submission.findFirst()).toMatchObject({ id: result.submissionId, status: "queued" });
    expect((await getDraft(db, ck, draft.id, "u")).status).toBe("sent");
    expect(await db.query.submission.findMany()).toHaveLength(1);
  });

  it("rejects oversized upload bytes even when supplied size metadata is small", async () => {
    const draft = await createDraft(db, ck, "u", { mailboxId: "a", kind: "new" });
    await expect(stageDraftAttachment(db, outboundEnv(), draft.id, "u", { name: "bad.bin", type: "application/octet-stream", size: 1, bytes: new ArrayBuffer(4 * 1024 * 1024) })).rejects.toMatchObject({ status: 413 });
    expect(put).not.toHaveBeenCalled();
  });

  it("checks again at the provider boundary and reports acceptance without delivery", async () => {
    const sender = { send: vi.fn(async (_builder: unknown) => ({ messageId: "accepted-id" })) };
    const provider = selectProvider({ EMAIL_SENDER: sender as never })!;
    await expect(provider.send(email(4 * 1024 * 1024))).rejects.toMatchObject({ permanent: true });
    expect(sender.send).not.toHaveBeenCalled();
    expect(await provider.send(email(16))).toEqual({ providerMessageId: "accepted-id", accepted: true });
    const submitted = sender.send.mock.calls[0][0] as { attachments: { content: Uint8Array }[] };
    expect(submitted.attachments[0].content).toBeInstanceOf(Uint8Array);
  });
});
