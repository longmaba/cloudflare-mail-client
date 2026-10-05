// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { makeDb } from "./mail-db";
import { importKey } from "@doota/mail-core/crypto";
import { listThreads, threadSummariesByIds } from "@doota/mail-core/read";
import { seedMailboxWithThreads } from "./helpers/seed-threads";

let db: any, ck: any;
beforeEach(async () => {
  db = await makeDb();
  ck = await importKey(btoa("0123456789abcdef0123456789abcdef"));
});

describe("threadSummariesByIds", () => {
  it.each(["seed", "delta"])("hydrates a 200-thread %s within D1's 100-binding budget", async (mode) => {
    const limitedDb = await makeDb({ maxBindings: 100 });
    const { mailboxId, threadIds } = await seedMailboxWithThreads(limitedDb, ck, 200);
    const context = { mailboxId, ck, userId: "u1", includeCollab: true, assignedTo: null };
    const out = mode === "seed"
      ? await listThreads(limitedDb, { ...context, limit: 200, allPlacements: true })
      : await threadSummariesByIds(limitedDb, { ...context, threadIds: [...threadIds, threadIds[0]] });
    expect(out).toHaveLength(200);
    expect(out.map((summary) => summary.threadId).sort()).toEqual(threadIds.sort());
    expect(new Set(out.map((summary) => summary.subject)).size).toBe(200);
    expect(out.every((summary) => summary.snippet?.startsWith("Body of seed thread "))).toBe(true);
  });

  it("returns summaries only for the requested, still-present threads", async () => {
    const { mailboxId, threadIds } = await seedMailboxWithThreads(db, ck, 3);
    const some = [threadIds[0], threadIds[2], "gone_id"];
    const out = await threadSummariesByIds(db, {
      mailboxId,
      threadIds: some,
      ck,
      userId: "u1",
      includeCollab: true,
      assignedTo: null,
    });
    expect(out.map((summary) => summary.threadId).sort()).toEqual(
      [threadIds[0], threadIds[2]].sort(),
    );
  });

  it("returns empty array when threadIds is empty", async () => {
    const { mailboxId } = await seedMailboxWithThreads(db, ck, 1);
    const out = await threadSummariesByIds(db, {
      mailboxId,
      threadIds: [],
      ck,
      userId: "u1",
      includeCollab: false,
      assignedTo: null,
    });
    expect(out).toEqual([]);
  });
});
