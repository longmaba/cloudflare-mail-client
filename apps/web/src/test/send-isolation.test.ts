// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
import { importKey, encryptContent, putEncryptedBlob, getDecryptedBlob } from "@doota/mail-core/crypto";
import { invalidateDomainCache } from "@doota/db/org-domains";
import { createDraft, stageDraftAttachment, sendDraft } from "@doota/mail-core/drafts";
import { enqueueSend } from "@doota/mail-core/outbound";
import { processSubmission } from "@doota/mail-core/outbound-consumer";
import { canReadMessage } from "@doota/mail-core/message-access";
import { resolveSendAttachments } from "$lib/server/send-attachments.js";

vi.mock("$app/server", async (original) => ({
  ...await original<object>(),
  command: (_schema: unknown, fn: unknown) => fn,
  query: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn,
}));
vi.mock("$lib/server/mail/deliver-bridge.js", () => ({ deliverInBackground: vi.fn() }));
const keyActor = vi.hoisted(() => ({ userId: "alice" as string | null, mailboxId: "alice-box" as string | null, isService: false, keyId: "api-key" }));
vi.mock("$lib/server/auth/api-key.js", () => ({ bearerFromHeaders: () => "test-key", verifyApiKey: async () => keyActor }));
import { sendMessage } from "$lib/rpc/send.remote";
import { POST as apiSend } from "../routes/api/send/+server";
import { GET as download } from "../routes/api/attachments/[id]/+server";
import { GET as body } from "../routes/api/messages/[id]/body/+server";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
let r2: ReturnType<typeof bucket>;
let queue: { send: ReturnType<typeof vi.fn> };
function bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: vi.fn(async (key: string, value: ArrayBuffer | Uint8Array | string) => { store.set(key, typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value)); }),
    get: vi.fn(async (key: string) => {
      const bytes = store.get(key);
      return bytes ? { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), body: new Blob([bytes as BlobPart]).stream() } : null;
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}
const env = () => ({ MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY, MAIL_RAW: r2 as never, MAIL_OUT_QUEUE: queue as never });
const sendInput = (extra = {}) => ({ mailboxId: "alice-box", to: ["outside@example.net"], cc: [], bcc: [], subject: "Reply", text: "note", attachments: [], ...extra });
const requestInput = (extra = {}) => ({ orgId: "org", mailboxId: "alice-box", createdByUserId: "alice", fromAddress: "alice@example.com", to: ["outside@example.net"], subject: "Reply", text: "note", idempotencyKey: crypto.randomUUID(), undoSeconds: 0, ...extra });
async function api(body: object) {
  const url = new URL("https://mail.example.com/api/send");
  return apiSend({ request: new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "alice-box", to: ["outside@example.net"], ...body }) }), url, locals: { db }, platform: { env: env() } } as never);
}

async function source(id: string, mailboxId: string, text: string, extra: Record<string, unknown> = {}) {
  const orgId = mailboxId === "other-box" ? "other-org" : "org";
  await db.insert(schema.thread).values({ id: `thread-${id}`, orgId, lastMessageAt: new Date() });
  await db.insert(schema.message).values({ id, orgId, threadId: `thread-${id}`, messageIdHeader: `<${id}@source.net>`, fromAddr: "source@outside.net", sentAt: new Date(), toAddrs: "[]", bodyFullEnc: await encryptContent(ck, text), ...extra });
  await db.insert(schema.delivery).values({ id: `delivery-${id}`, orgId, messageId: id, mailboxId, role: "to" });
  await db.insert(schema.threadState).values({ id: `state-${id}`, orgId, threadId: `thread-${id}`, mailboxId, assigneeUserId: mailboxId === "shared-box" ? "bob" : null });
  const r2Key = `att/${orgId}/${id}`;
  await putEncryptedBlob(r2 as never, r2Key, ck, text);
  await db.insert(schema.attachment).values({ id: `attachment-${id}`, messageId: id, filename: `${id}.txt`, contentType: "text/plain", size: text.length, r2Key });
  return r2Key;
}

beforeEach(async () => {
  db = await makeDb(); ck = await importKey(KEY); r2 = bucket(); queue = { send: vi.fn() };
  await db.insert(schema.organization).values([
    { id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() },
    { id: "other-org", name: "Other", slug: "other", domain: "other.com", status: "active", createdAt: new Date() },
  ]);
  await db.insert(schema.user).values([
    { id: "alice", name: "Alice", email: "alice@example.com", role: "member", updatedAt: new Date() },
    { id: "bob", name: "Bob", email: "bob@example.com", role: "member", updatedAt: new Date() },
    { id: "operator", name: "Operator", email: "admin@example.com", role: "superadmin", updatedAt: new Date() },
  ]);
  await db.insert(schema.mailbox).values([
    { id: "alice-box", orgId: "org", localPart: "alice", address: "alice@example.com", isPersonal: true, isActive: true },
    { id: "bob-box", orgId: "org", localPart: "bob", address: "bob@example.com", isPersonal: true, isActive: true },
    { id: "shared-box", orgId: "org", localPart: "shared", address: "shared@example.com", isActive: true },
    { id: "other-box", orgId: "other-org", localPart: "other", address: "other@other.com", isActive: true },
  ]);
  await db.insert(schema.mailboxAccess).values([
    { id: "alice-grant", userId: "alice", mailboxId: "alice-box", canManage: true, canSend: true },
    { id: "bob-grant", userId: "bob", mailboxId: "bob-box", canManage: true, canSend: true },
    { id: "restricted-grant", userId: "alice", mailboxId: "shared-box", assignedOnly: true, canSend: true },
  ]);
  await db.insert(schema.apiKey).values({ id: "api-key", orgId: "org", userId: "alice", mailboxId: "alice-box", keyHash: "test-hash", prefix: "dk_test" });
  await source("own", "alice-box", "OWN_CONTENT");
  await source("private", "bob-box", "BOB_SECRET");
  await source("restricted", "shared-box", "UNASSIGNED_SECRET");
  await source("other", "other-box", "OTHER_ORG_SECRET");
  r2.get.mockClear(); r2.put.mockClear(); invalidateDomainCache();
  Object.assign(keyActor, { userId: "alice", mailboxId: "alice-box", isService: false });
  setRequestEvent({ locals: { db, user: { id: "alice", role: "member" } }, platform: { env: env() } });
});

describe("interactive attachment authorization", () => {
  it.each(["att/org/private", "att/org/restricted", "att/other-org/other", "raw/org/known-key", "outbound-att/org/unrecorded"])("rejects %s before storage or queue access", async (r2Key) => {
    await expect(sendMessage(sendInput({ attachments: [{ r2Key, filename: "stolen", contentType: "text/plain", size: 1 }] }))).rejects.toMatchObject({ status: 403 });
    expect(r2.get).not.toHaveBeenCalled(); expect(r2.put).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled();
    expect(await db.query.submission.findMany()).toHaveLength(0);
  });

  it("uses authorized message metadata instead of forged filename/type/size", async () => {
    const result = await sendMessage(sendInput({ attachments: [{ r2Key: "att/org/own", filename: "forged.exe", contentType: "text/html", size: 0 }] }));
    const sub = await db.query.submission.findFirst({ where: eq(schema.submission.id, result.submissionId) });
    const attachments = await db.query.attachment.findMany({ where: eq(schema.attachment.messageId, sub!.messageId) });
    expect(attachments[0]).toMatchObject({ filename: "own.txt", contentType: "text/plain", size: "OWN_CONTENT".length });
    expect(queue.send).toHaveBeenCalledOnce();
  });

  it("copies only the owner's recorded draft upload and encrypts it", async () => {
    const d = await createDraft(db, ck, "alice", { mailboxId: "alice-box", kind: "new" });
    const [ref] = await stageDraftAttachment(db, env(), d.id, "alice", { name: "mine.txt", type: "text/plain", size: 6, bytes: new TextEncoder().encode("UPLOAD").buffer });
    const [stored] = await resolveSendAttachments(db, env(), "alice", "org", [ref.r2Key]);
    expect(stored.r2Key).toMatch(/^outbound-att\/org\//);
    expect(new TextDecoder().decode((await getDecryptedBlob(r2 as never, stored.r2Key, ck))!)).toBe("UPLOAD");
    const victim = await createDraft(db, ck, "bob", { mailboxId: "bob-box", kind: "new" });
    const [victimRef] = await stageDraftAttachment(db, env(), victim.id, "bob", { name: "private.txt", type: "text/plain", size: 6, bytes: new TextEncoder().encode("SECRET").buffer });
    r2.get.mockClear(); r2.put.mockClear();
    await expect(resolveSendAttachments(db, env(), "alice", "org", [victimRef.r2Key])).rejects.toMatchObject({ status: 403 });
    await expect(resolveSendAttachments(db, env(), "alice", "org", [`draft/org/${d.id}/unrecorded`])).rejects.toMatchObject({ status: 403 });
    expect(r2.get).not.toHaveBeenCalled(); expect(r2.put).not.toHaveBeenCalled();
  });

  it("honors changed assignments and current grants rather than cached access", async () => {
    await db.update(schema.threadState).set({ assigneeUserId: "alice" }).where(eq(schema.threadState.id, "state-restricted"));
    expect(await resolveSendAttachments(db, env(), "alice", "org", ["att/org/restricted"])).toHaveLength(1);
    await db.delete(schema.mailboxAccess).where(eq(schema.mailboxAccess.id, "restricted-grant"));
    await expect(resolveSendAttachments(db, env(), "alice", "org", ["att/org/restricted"])).rejects.toMatchObject({ status: 403 });
  });

  it("blocks direct downloads of unassigned attachments before object access", async () => {
    await expect(download({ params: { id: "attachment-restricted" }, url: new URL("https://mail.example.com/api/attachments/attachment-restricted"), request: new Request("https://mail.example.com/"), locals: { db, user: { id: "alice" } }, platform: { env: env() } } as never)).rejects.toMatchObject({ status: 403 });
    expect(r2.get).not.toHaveBeenCalled();
  });

  it("blocks an unassigned message body before rendering or minting attachment tokens", async () => {
    await expect(body({ params: { id: "restricted" }, url: new URL("https://mail.example.com/api/messages/restricted/body"), request: new Request("https://mail.example.com/"), locals: { db, user: { id: "alice" } }, platform: { env: env() } } as never)).rejects.toMatchObject({ status: 403 });
    expect(r2.get).not.toHaveBeenCalled();
  });
});

describe("reply and forward source authorization", () => {
  it.each(["private", "restricted", "other"])("rejects forged interactive/API/draft reply and forward references to %s", async (id) => {
    await expect(sendMessage(sendInput({ parentMessageId: `<${id}@source.net>` }))).rejects.toMatchObject({ status: 403 });
    await expect(api({ parentMessageId: `<${id}@source.net>` })).rejects.toMatchObject({ status: 403 });
    await expect(createDraft(db, ck, "alice", { mailboxId: "alice-box", kind: "reply", inReplyToMessageId: `<${id}@source.net>` })).rejects.toMatchObject({ status: 403 });
    await expect(createDraft(db, ck, "alice", { mailboxId: "alice-box", kind: "forward", forwardMessageIds: [id] })).rejects.toMatchObject({ status: 403 });
    await expect(createDraft(db, ck, "alice", { mailboxId: "alice-box", kind: "new", threadId: `thread-${id}` })).rejects.toMatchObject({ status: 403 });
    expect(r2.get).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled();
    expect(await db.query.draft.findMany()).toHaveLength(0);
  });

  it("does not quote unauthorized ancestors even when the readable parent names them", async () => {
    await db.update(schema.message).set({ inReplyTo: "<private@source.net>" }).where(eq(schema.message.id, "own"));
    const result = await enqueueSend(db, env(), requestInput({ parentMessageId: "<own@source.net>" }));
    const sender = { send: vi.fn(async () => ({ messageId: "wire-id" })) };
    await processSubmission(db, { ...env(), EMAIL_SENDER: sender as never, DB: {} as never }, ck, { body: { submissionId: result.submissionId }, ack: vi.fn(), retry: vi.fn() } as never);
    expect(sender.send).toHaveBeenCalledOnce();
    expect(JSON.stringify(sender.send.mock.calls)).toContain("OWN_CONTENT");
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain("BOB_SECRET");
  });

  it("selects only a readable row when another mailbox spoofs the same Message-ID", async () => {
    await db.update(schema.message).set({ messageIdHeader: "<own@source.net>" }).where(eq(schema.message.id, "private"));
    const result = await enqueueSend(db, env(), requestInput({ parentMessageId: "<own@source.net>" }));
    const sender = { send: vi.fn(async () => ({ messageId: "wire-id" })) };
    await processSubmission(db, { ...env(), EMAIL_SENDER: sender as never, DB: {} as never }, ck, { body: { submissionId: result.submissionId }, ack: vi.fn(), retry: vi.fn() } as never);
    expect(JSON.stringify(sender.send.mock.calls)).toContain("OWN_CONTENT");
    expect(JSON.stringify(sender.send.mock.calls)).not.toContain("BOB_SECRET");
  });

  it("rechecks forwarded sources on send and preserves an editable draft after revocation", async () => {
    await db.update(schema.threadState).set({ assigneeUserId: "alice" }).where(eq(schema.threadState.id, "state-restricted"));
    const d = await createDraft(db, ck, "alice", { mailboxId: "alice-box", kind: "forward", to: ["outside@example.net"], forwardMessageIds: ["restricted"] });
    await db.update(schema.threadState).set({ assigneeUserId: "bob" }).where(eq(schema.threadState.id, "state-restricted"));
    await expect(sendDraft(db, env(), ck, "alice", { draftId: d.id })).rejects.toMatchObject({ status: 403 });
    expect((await db.query.draft.findFirst({ where: eq(schema.draft.id, d.id) }))!.status).toBe("editing");
    expect(r2.get).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled();
  });

  it("fails a scheduled reply if source access is revoked before delivery", async () => {
    const result = await enqueueSend(db, env(), requestInput({ parentMessageId: "<own@source.net>" }));
    await db.delete(schema.delivery).where(eq(schema.delivery.id, "delivery-own"));
    const sender = { send: vi.fn(async () => ({ messageId: "wire-id" })) };
    const ack = vi.fn();
    await processSubmission(db, { ...env(), EMAIL_SENDER: sender as never, DB: {} as never }, ck, { body: { submissionId: result.submissionId }, ack, retry: vi.fn() } as never);
    expect(sender.send).not.toHaveBeenCalled(); expect(ack).toHaveBeenCalled();
    expect((await db.query.submission.findFirst({ where: eq(schema.submission.id, result.submissionId) }))!.lastError).toBe("reply source access revoked");
  });

  it("rejects API stored attachment references instead of treating them as uploads", async () => {
    await expect(api({ attachments: [{ r2Key: "att/org/private", filename: "secret.txt", content: btoa("decoy") }] })).rejects.toMatchObject({ status: 400 });
    expect(r2.get).not.toHaveBeenCalled(); expect(r2.put).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled();
  });

  it("confines service and mailbox-bound user keys to sources delivered to that mailbox", async () => {
    await db.update(schema.threadState).set({ assigneeUserId: "alice" }).where(eq(schema.threadState.id, "state-restricted"));
    // Interactive forwarding is allowed for an assigned shared-mailbox member.
    expect(await canReadMessage(db, { userId: "alice" }, "restricted", "org")).toBe(true);
    await expect(api({ parentMessageId: "<restricted@source.net>" })).rejects.toMatchObject({ status: 403 });
    await db.update(schema.mailbox).set({ isService: true }).where(eq(schema.mailbox.id, "alice-box"));
    Object.assign(keyActor, { userId: null, isService: true });
    await expect(api({ parentMessageId: "<private@source.net>" })).rejects.toMatchObject({ status: 403 });
    expect((await api({ parentMessageId: "<own@source.net>" })).status).toBe(202);
  });

  it("retains trusted operator access without granting ordinary members org-wide reads", async () => {
    expect(await canReadMessage(db, { userId: "operator" }, "private", "org")).toBe(true);
    await db.insert(schema.member).values({ id: "org-admin", organizationId: "org", userId: "alice", role: "admin", createdAt: new Date() });
    expect(await canReadMessage(db, { userId: "alice" }, "private", "org")).toBe(true);
    expect(await canReadMessage(db, { userId: "alice" }, "other", "other-org")).toBe(false);
  });
});
