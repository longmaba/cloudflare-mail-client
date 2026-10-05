// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import sqlite3InitModule, { type SqlValue } from "@sqlite.org/sqlite-wasm";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey } from "@doota/mail-core/crypto";
import { enqueueSend } from "@doota/mail-core/outbound";
import { materializeMessage, materializeDelivery } from "@doota/mail-core/materialize";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
import { buildSeed } from "$lib/rpc/thread-localdb";
import { DDL, listThreadsSql, rowToThreadSummary, threadSummaryToRow, upsertThreadSql } from "$lib/client/localdb/schema";
import { threadListUsesMirror } from "$lib/shared/thread-mirror-limits";

vi.mock("$app/server", async (original) => ({
  ...await original<object>(),
  command: (_schema: unknown, fn: unknown) => fn,
  query: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn,
}));
import { mailboxThreads } from "$lib/rpc/thread.remote";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
const env = () => ({
  MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY,
  MAIL_RAW: { put: vi.fn(async () => {}) } as never,
  MAIL_OUT_QUEUE: { send: vi.fn(async () => {}) } as never,
});
function asUser(userId = "alice") {
  setRequestEvent({ locals: { db, user: { id: userId, role: "member" } }, platform: { env: env() } });
}
async function send(to = "outside@example.net") {
  return enqueueSend(db, env(), {
    orgId: "org", mailboxId: "alice-box", createdByUserId: "alice", fromAddress: "alice@example.com",
    to: [to], subject: "Sent regression", text: "Hello", idempotencyKey: crypto.randomUUID(), undoSeconds: 0,
  });
}
async function remoteSent(mailboxId = "alice-box") {
  return mailboxThreads({ mailboxId, placement: "sent", offset: 0 });
}
async function mirrorRows(placement: string) {
  const seed = await buildSeed(db, { mailboxId: "alice-box", ck, userId: "alice", includeCollab: true, assignedTo: null });
  const sqlite = await sqlite3InitModule();
  const mirror = new sqlite.oo1.DB(":memory:", "c");
  try {
    mirror.exec(DDL);
    for (const row of seed.rows) mirror.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("alice-box", row) });
    const resultRows: Record<string, SqlValue>[] = [];
    mirror.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "alice-box", $placement: placement }, rowMode: "object", resultRows });
    return resultRows.map(rowToThreadSummary);
  } finally {
    mirror.close();
  }
}

beforeEach(async () => {
  db = await makeDb(); ck = await importKey(KEY);
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values([
    { id: "alice", name: "Alice", email: "alice@example.com", role: "member" },
    { id: "bob", name: "Bob", email: "bob@example.com", role: "member" },
  ]);
  await db.insert(schema.mailbox).values([
    { id: "alice-box", orgId: "org", localPart: "alice", address: "alice@example.com", isActive: true, isPersonal: true },
    { id: "bob-box", orgId: "org", localPart: "bob", address: "bob@example.com", isActive: true, isPersonal: true },
  ]);
  await db.insert(schema.mailboxAccess).values([
    { id: "alice-access", userId: "alice", mailboxId: "alice-box", canManage: true, canSend: true },
    { id: "bob-access", userId: "bob", mailboxId: "bob-box", canManage: true, canSend: true },
  ]);
  asUser();
});

describe("Sent with a completed placement-only mirror", () => {
  it("renders the archived sender copy from the authorized server view instead of an empty local folder", async () => {
    const { threadId } = await send();
    const remote = await remoteSent();
    const local = await mirrorRows("sent");
    expect(remote).toMatchObject([{ threadId, placement: "archived" }]);
    expect(local).toEqual([]); // The cache does not carry this mailbox's role=from.
    const useMirror = threadListUsesMirror({ ready: true, complete: true, placement: "sent" });
    expect((useMirror ? local : remote).map((row) => row.threadId)).toEqual([threadId]);
  });

  it("refreshes Sent from the server after a reply moves the sender copy into Inbox", async () => {
    const { threadId, messageId } = await send();
    const before = await remoteSent();
    const message = await db.query.message.findFirst({ where: eq(schema.message.id, messageId) });
    const sentAt = Date.now() + 1000;
    const reply = await materializeMessage(db, "org", {
      messageIdHeader: "<reply@example.net>", inReplyTo: message!.messageIdHeader, references: null,
      from: "outside@example.net", subject: "Re: Sent regression", sentAt, text: "Reply", html: null, r2RawKey: null, attachments: [],
    }, { ck, searchKeyB64: KEY });
    await materializeDelivery(db, { orgId: "org", ...reply, mailboxId: "alice-box", role: "to", viaAliasId: null, subaddressTag: null, sentAt });
    expect(before[0].placement).toBe("archived");
    const refreshed = await remoteSent();
    expect(refreshed).toMatchObject([{ threadId, placement: "inbox", from: "outside@example.net" }]);
    const useMirror = threadListUsesMirror({ ready: true, complete: true, placement: "sent" });
    expect((useMirror ? await mirrorRows("sent") : refreshed).map((row) => row.threadId)).toEqual([threadId]);
  });

  it("keeps a recipient's same-org copy out of their Sent and denies another member's mailbox", async () => {
    const { threadId, messageId } = await send("bob@example.com");
    await materializeDelivery(db, { orgId: "org", threadId, messageId, mailboxId: "bob-box", role: "to", viaAliasId: null, subaddressTag: null, sentAt: Date.now() });
    await expect(remoteSent("bob-box")).rejects.toMatchObject({ status: 403 });
    asUser("bob");
    expect(await remoteSent("bob-box")).toEqual([]);
    await expect(remoteSent("alice-box")).rejects.toMatchObject({ status: 403 });
  });

  it.each(["spam", "trash"])("removes a sender copy from Sent after moving it to %s", async (placement) => {
    const { threadId } = await send();
    expect(await remoteSent()).toHaveLength(1);
    await db.update(schema.threadState).set({ placement }).where(eq(schema.threadState.threadId, threadId));
    expect(await remoteSent()).toEqual([]);
  });

  it("keeps label, Snoozed, unknown, incomplete and unopened views remote while preserving ordinary folder caching", () => {
    const state = { ready: true, complete: true };
    for (const placement of ["sent", "snoozed", "archive", "drafts", "scheduled"]) {
      expect(threadListUsesMirror({ ...state, placement })).toBe(false);
    }
    for (const placement of ["inbox", "archived", "spam", "trash"]) {
      expect(threadListUsesMirror({ ...state, placement })).toBe(true);
      expect(threadListUsesMirror({ ...state, placement, labelId: "label" })).toBe(false);
      expect(threadListUsesMirror({ ...state, placement, complete: false })).toBe(false);
      expect(threadListUsesMirror({ ...state, placement, ready: false })).toBe(false);
    }
  });
});
