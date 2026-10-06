// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey } from "@doota/mail-core/crypto";
import { materializeMessage, materializeDelivery } from "@doota/mail-core/materialize";
import { countUnread, countUnreadByLabel, getThread, listThreads, recentUnread } from "@doota/mail-core/read";
import { applyLabel, createLabel } from "@doota/mail-core/labels";
import { sweepDueSnoozes } from "@doota/mail-core/snooze";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
vi.mock("$app/server", async (original) => ({ ...await original<object>(), command: (_schema: unknown, fn: unknown) => fn, query: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn }));
import { bulkMarkRead } from "$lib/rpc/thread.remote";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
beforeEach(async () => {
  db = await makeDb(); ck = await importKey(KEY);
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com" });
  await db.insert(schema.mailbox).values({ id: "box", orgId: "org", localPart: "owner", address: "owner@example.com", isPersonal: true, isActive: true });
  await db.insert(schema.mailboxAccess).values({ userId: "owner", mailboxId: "box", canManage: true });
  setRequestEvent({ locals: { db, user: { id: "owner", role: "member" } }, platform: { env: { MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY } } });
});
async function imported(id: string, read: boolean, parent: string | null = null, sentAt = 100000, role: "to" | "from" = "to") {
  const ids = await materializeMessage(db, "org", { messageIdHeader: `<${id}@example.net>`, inReplyTo: parent, references: null, from: "sender@example.net", subject: "History", sentAt, text: id, html: null, r2RawKey: `raw/import/${id}`, dedupeByRaw: true, threadMailboxId: "box", attachments: [] }, { ck, searchKeyB64: KEY });
  await materializeDelivery(db, { orgId: "org", ...ids, mailboxId: "box", role, viaAliasId: null, subaddressTag: null, sentAt, isRead: read, keywords: read ? ["$imported", "$seen"] : ["$imported"], placement: { newThread: "inbox", unarchiveOnReply: false } });
  return ids;
}
const listing = () => listThreads(db, { mailboxId: "box", placement: "inbox", ck, userId: "owner" });
const count = () => countUnread(db, { mailboxId: "box", userId: "owner" });
const thread = (threadId: string) => getThread(db, { mailboxId: "box", threadId, ck, userId: "owner" });
describe("Gmail initial read flags and user overrides", () => {
  it("keeps a personal unread notice's preview scoped to delivered messages in a shared conversation", async () => {
    await db.insert(schema.mailbox).values({ id: "other", orgId: "org", localPart: "other", address: "other@example.com", isPersonal: true, isActive: true });
    const first = await imported("common", false);
    await materializeDelivery(db, { orgId: "org", ...first, mailboxId: "other", role: "to", viaAliasId: null, subaddressTag: null, sentAt: 100000 });
    const privateReply = await materializeMessage(db, "org", { messageIdHeader: "<private-reply@example.net>", inReplyTo: "<common@example.net>", references: null, from: "private@example.net", subject: "OTHER_MAILBOX_PRIVATE_SUBJECT", sentAt: 200000, text: "private", html: null, r2RawKey: "raw/other/private-reply", dedupeByRaw: true, attachments: [] }, { ck, searchKeyB64: KEY });
    await materializeDelivery(db, { orgId: "org", ...privateReply, mailboxId: "other", role: "to", viaAliasId: null, subaddressTag: null, sentAt: 200000 });
    expect(privateReply.threadId).toBe(first.threadId);
    const importedReply = await materializeMessage(db, "org", { messageIdHeader: "<forged-import@example.net>", inReplyTo: "<private-reply@example.net>", references: "<common@example.net>", from: "sender@example.net", subject: "History", sentAt: 150000, text: "own uploaded text", html: null, r2RawKey: "raw/import/forged", dedupeByRaw: true, threadMailboxId: "box", attachments: [] }, { ck, searchKeyB64: KEY });
    await materializeDelivery(db, { orgId: "org", ...importedReply, mailboxId: "box", role: "to", viaAliasId: null, subaddressTag: null, sentAt: 150000 });
    const ownThread = await thread(first.threadId);
    expect(ownThread!.items).toHaveLength(2);
    expect(JSON.stringify(ownThread)).not.toContain("OTHER_MAILBOX_PRIVATE_SUBJECT");
    expect(ownThread!.items[1]).not.toHaveProperty("replyContext");
    const notices = await recentUnread(db, { mailboxIds: ["box"], userId: "owner", ck });
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({ subject: "History", from: "sender@example.net" });
  });
  it("can explicitly unread messages dated at or before the Unix epoch", async () => {
    for (const [index, sentAt] of [-1000, 0].entries()) {
      const first = await imported(`epoch-${index}`, true, null, sentAt);
      await bulkMarkRead({ mailboxId: "box", threadIds: [first.threadId], read: false });
      expect((await thread(first.threadId))!.items[0]).toMatchObject({ isRead: false });
      expect((await listing()).find((item) => item.threadId === first.threadId)!.unread).toBe(true);
    }
    expect(await count()).toBe(2);
  });
  it("preserves manually unread Gmail Sent history without treating new own sends as unread", async () => {
    const first = await imported("sent-unread", false, null, 100000, "from");
    expect((await listing())[0].unread).toBe(true);
    expect(await count()).toBe(1);
    await bulkMarkRead({ mailboxId: "box", threadIds: [first.threadId], read: true });
    expect((await listing())[0].unread).toBe(false);
    expect(await count()).toBe(0);
  });
  it("keeps older unread and newer read messages distinct and counts the thread as unread", async () => {
    const first = await imported("old-unread", false);
    await imported("new-read", true, "<old-unread@example.net>", 200000);
    const dto = await thread(first.threadId);
    expect(dto!.items.filter((item) => item.type === "external_message").map((message) => message.isRead)).toEqual([false, true]);
    expect((await listing())[0].unread).toBe(true);
    expect(await count()).toBe(1);
  });
  it("agrees across Inbox, label badges and notices, then honors explicit read/unread", async () => {
    const first = await imported("already-read", true);
    const label = await createLabel(db, { orgId: "org", mailboxId: "box", name: "Imported" });
    await applyLabel(db, { mailboxId: "box", threadId: first.threadId, labelId: label.id });
    expect((await listing())[0].unread).toBe(false);
    expect(await count()).toBe(0);
    expect((await countUnreadByLabel(db, { mailboxId: "box", userId: "owner" })).get(label.id) ?? 0).toBe(0);
    expect(await recentUnread(db, { mailboxIds: ["box"], userId: "owner", ck })).toEqual([]);
    await bulkMarkRead({ mailboxId: "box", threadIds: [first.threadId], read: false });
    expect((await thread(first.threadId))!.items[0]).toMatchObject({ isRead: false });
    expect((await listing())[0].unread).toBe(true);
    expect(await count()).toBe(1);
    expect((await countUnreadByLabel(db, { mailboxId: "box", userId: "owner" })).get(label.id)).toBe(1);
    expect(await recentUnread(db, { mailboxIds: ["box"], userId: "owner", ck })).toHaveLength(1);
    await bulkMarkRead({ mailboxId: "box", threadIds: [first.threadId], read: true });
    expect(await count()).toBe(0);
    expect((await thread(first.threadId))!.items[0]).toMatchObject({ isRead: true });
  });
  it("wakes a previously read imported thread as unread when its snooze expires", async () => {
    const first = await imported("snoozed-read", true);
    await bulkMarkRead({ mailboxId: "box", threadIds: [first.threadId], read: true });
    await db.update(schema.threadState).set({ snoozedUntil: new Date(Date.now() - 1000) }).where(eq(schema.threadState.threadId, first.threadId));
    await sweepDueSnoozes(db);
    expect((await listing())[0].unread).toBe(true);
    expect(await count()).toBe(1);
  });
});
