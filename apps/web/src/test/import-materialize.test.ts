// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey } from "@doota/mail-core/crypto";
import { materializeDelivery, materializeMessage, type ParsedMessage } from "@doota/mail-core/materialize";
import { makeDb } from "./mail-db";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let deps: { ck: Awaited<ReturnType<typeof importKey>>; searchKeyB64: string };
const parsed = (id: string, extra: Partial<ParsedMessage> = {}): ParsedMessage => ({
  messageIdHeader: `<${id}@example.net>`, inReplyTo: null, references: null,
  from: "same@example.net", to: ["alice@example.com"], subject: "Historical conversation", sentAt: 100000,
  text: id, html: null, r2RawKey: `import-raw/org/alice/${id}`, dedupeByRaw: true,
  threadMailboxId: "alice", attachments: [], ...extra,
});
async function deliver(pm: ParsedMessage, mailboxId: string) {
  const ids = await materializeMessage(db, "org", pm, deps);
  await materializeDelivery(db, { orgId: "org", ...ids, mailboxId, role: "to", viaAliasId: null,
    subaddressTag: null, sentAt: pm.sentAt, placement: { newThread: "archived", unarchiveOnReply: false }, isRead: true });
  return ids;
}
beforeEach(async () => {
  db = await makeDb({ maxBindings: 100 });
  deps = { ck: await importKey(KEY), searchKeyB64: KEY };
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.mailbox).values([
    { id: "alice", orgId: "org", localPart: "alice", address: "alice@example.com", isActive: true },
    { id: "bob", orgId: "org", localPart: "bob", address: "bob@example.com", isActive: true },
  ]);
});
describe("historical materialization boundaries", () => {
  it("ignores another mailbox's Message-ID ancestry and subject fallback", async () => {
    const bob = await deliver(parsed("private", { threadMailboxId: undefined, r2RawKey: "raw/org/private" }), "bob");
    const alice = await deliver(parsed("forged", { inReplyTo: "<private@example.net>" }), "alice");
    expect(alice.threadId).not.toBe(bob.threadId);
    const reply = await deliver(parsed("own-reply", { references: "<forged@example.net>" }), "alice");
    expect(reply.threadId).toBe(alice.threadId);
  });
  it("cannot resolve a provider-minted parent belonging only to another mailbox", async () => {
    const bob = await deliver(parsed("private-provider", { threadMailboxId: undefined, r2RawKey: "raw/org/private-provider" }), "bob");
    await db.insert(schema.user).values({ id: "bob-user", email: "bob@example.com", name: "Bob" });
    await db.insert(schema.submission).values({ orgId: "org", mailboxId: "bob", messageId: bob.messageId, createdByUserId: "bob-user", providerMessageId: "<provider@example.net>", idempotencyKey: "provider-parent", envelopeFrom: "bob@example.com" });
    const alice = await deliver(parsed("forged-provider", { inReplyTo: "<provider@example.net>" }), "alice");
    expect(alice.threadId).not.toBe(bob.threadId);
  });
  it("preserves newer recency, snooze and user placement while importing an older reply", async () => {
    const newer = await deliver(parsed("newer", { sentAt: 900000 }), "alice");
    await db.update(schema.threadState).set({ placement: "trash", snoozedUntil: new Date(1000000), placementOrigin: "user" }).where(eq(schema.threadState.threadId, newer.threadId));
    const older = await deliver(parsed("older", { sentAt: 200000, inReplyTo: "<newer@example.net>" }), "alice");
    expect(older.threadId).toBe(newer.threadId);
    const thread = await db.query.thread.findFirst({ where: eq(schema.thread.id, newer.threadId) });
    const state = await db.query.threadState.findFirst({ where: eq(schema.threadState.threadId, newer.threadId) });
    expect(thread!.lastMessageAt!.getTime()).toBe(900000);
    expect(state).toMatchObject({ placement: "trash", placementOrigin: "user" });
    expect(state!.lastActivityAt!.getTime()).toBe(900000);
    expect(state!.snoozedUntil!.getTime()).toBe(1000000);
  });
  it("preserves successful attachment links and completes an interrupted write without duplicates", async () => {
    const attachments = Array.from({ length: 23 }, (_, i) => ({ partId: `part-${i}`, filename: `${i}.txt`, contentType: "text/plain", size: 1, r2Key: `att/org/safe/${i}` }));
    const pm = parsed("attachment", { attachments });
    const ids = await deliver(pm, "alice");
    const first = await db.query.attachment.findMany({ where: eq(schema.attachment.messageId, ids.messageId) });
    await db.delete(schema.attachment).where(eq(schema.attachment.id, first[12].id));
    await materializeMessage(db, "org", pm, deps);
    const retried = await db.query.attachment.findMany({ where: eq(schema.attachment.messageId, ids.messageId) });
    expect(retried.map((row: { id: string }) => row.id).sort()).toEqual(first.map((row: { id: string }) => row.id).sort());
    await materializeMessage(db, "org", pm, deps);
    expect(await db.query.attachment.findMany()).toHaveLength(23);
  });
  it("keeps distinct attachment IDs when a new derived part precedes an existing part", async () => {
    const original = { partId: "old", filename: "old.txt", contentType: "text/plain", size: 1, r2Key: "att/org/old" };
    const pm = parsed("ordering", { attachments: [original] });
    const ids = await deliver(pm, "alice");
    const [old] = await db.query.attachment.findMany();
    await materializeMessage(db, "org", { ...pm, attachments: [{ ...original, partId: "new", filename: "new.txt", r2Key: "att/org/new" }, original] }, deps);
    const rows = await db.query.attachment.findMany({ where: eq(schema.attachment.messageId, ids.messageId) });
    expect(rows).toHaveLength(2);
    expect(rows.find((row: { filename: string }) => row.filename === "old.txt")!.id).toBe(old.id);
    expect(new Set(rows.map((row: { id: string }) => row.id)).size).toBe(2);
  });
});
