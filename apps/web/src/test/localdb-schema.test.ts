// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { DDL, upsertThreadSql, deleteThreadSql, listThreadsSql, threadSummaryToRow, rowToThreadSummary, getSeedStateSql, setSeedStateSql, setCursorSql } from "$lib/client/localdb/schema";

// A ThreadSummary fixture (shape from @doota/mail-core/read).
const summary = (over: Partial<any> = {}) => ({
  threadId: "t1", subject: "Invoice", snippet: "hi", from: "a@x.com", fromName: "A",
  participants: ["a@x.com"], participantCount: 1, lastMessageAt: 1000, isStarred: false,
  unread: true, hasNotes: false, assigneeUserId: null, placement: "inbox", pinnedAt: null, ...over,
});

let db: any;
beforeEach(async () => {
  const sqlite3 = await sqlite3InitModule();
  db = new sqlite3.oo1.DB(":memory:", "c"); // memory VFS — universal, node-safe
  db.exec(DDL);
});

describe("localdb schema", () => {
  const readSeedState = (mailboxId: string) => {
    const out: any[] = [];
    db.exec({ sql: getSeedStateSql().sql, bind: { $mailbox_id: mailboxId }, rowMode: "object", resultRows: out });
    return out[0] ?? null;
  };

  it("a legacy cursor does not create seed completeness when the cache schema opens again", () => {
    db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: "mb_a", $cursor: 12 } });
    db.exec(DDL);

    expect(readSeedState("mb_a")).toBeNull();
  });

  it("preserves full-seed completeness separately from subsequent cursor updates", () => {
    db.exec({ sql: setSeedStateSql().sql, bind: { $mailbox_id: "mb_a", $complete: 1 } });
    db.exec({ sql: setCursorSql().sql, bind: { $mailbox_id: "mb_a", $cursor: 42 } });
    db.exec(DDL);

    expect(readSeedState("mb_a")).toEqual({ complete: 1 });
    expect(readSeedState("mb_b")).toBeNull();

    db.exec({ sql: setSeedStateSql().sql, bind: { $mailbox_id: "mb_a", $complete: 0 } });
    expect(readSeedState("mb_a")).toEqual({ complete: 0 });
  });

  it("upserts a ThreadSummary and reads it back by mailbox+placement", () => {
    const row = threadSummaryToRow("mb_a", summary());
    db.exec({ sql: upsertThreadSql().sql, bind: row });
    const out: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(rowToThreadSummary(out[0]).subject).toBe("Invoice");
  });

  it("upsert replaces the same (mailbox, thread) row", () => {
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ unread: true })) });
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ unread: false })) });
    const out: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: out });
    expect(out.length).toBe(1);
    expect(rowToThreadSummary(out[0]).unread).toBe(false);
  });

  it("delete removes the row; folder filter scopes by placement", () => {
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ threadId: "t1", placement: "inbox" })) });
    db.exec({ sql: upsertThreadSql().sql, bind: threadSummaryToRow("mb_a", summary({ threadId: "t2", placement: "archived" })) });
    db.exec({ sql: deleteThreadSql().sql, bind: { $mailbox_id: "mb_a", $thread_id: "t1" } });
    const inbox: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "inbox" }, rowMode: "object", resultRows: inbox });
    expect(inbox.length).toBe(0);
    const archived: any[] = [];
    db.exec({ sql: listThreadsSql().sql, bind: { $mailbox_id: "mb_a", $placement: "archived" }, rowMode: "object", resultRows: archived });
    expect(archived.length).toBe(1);
  });
});
