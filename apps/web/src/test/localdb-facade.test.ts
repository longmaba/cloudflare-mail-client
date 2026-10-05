// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, it, expect, vi } from "vitest";
import { flushSync } from "svelte";
import { makeLocalDb } from "$lib/client/localdb";

it("liveThreadList re-queries after applyDeltas bumps the mailbox version", async () => {
  let rows: any[] = [{ threadId: "t1", placement: "inbox" }];
  const bridge = { call: vi.fn(async (method: string) => {
    if (method === "list") return rows;
    if (method === "getSeedState") return { complete: true };
    return true;
  }) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");
  // let the initial effect run + resolve
  flushSync(); await Promise.resolve(); flushSync();
  rows = [{ threadId: "t1", placement: "inbox" }, { threadId: "t2", placement: "inbox" }];
  await local.applyDeltas("mb_a", [], [], 5);
  flushSync(); await Promise.resolve(); flushSync();
  expect(live.current.length).toBe(2);
});

it("does not certify an optimistic or delta-only row as a complete mailbox", async () => {
  const bridge = { call: vi.fn(async (method: string) => {
    if (method === "list") return [{ threadId: "t1", placement: "inbox" }];
    if (method === "getSeedState") return null;
    return true;
  }) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");

  await local.open("user_a");

  expect(live.current).toHaveLength(1);
  expect(live.complete).toBe(false);
  await local.applyDeltas("mb_a", [], [], 5);
  expect(live.complete).toBe(false);
});

it("uses persisted seed completeness on an offline open, including empty folders", async () => {
  const bridge = { call: vi.fn(async (method: string) => {
    if (method === "list") return [];
    if (method === "getSeedState") return { complete: true };
    return true;
  }) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");

  await local.open("user_a");

  expect(live.current).toHaveLength(0);
  expect(live.complete).toBe(true);
  expect(bridge.call).not.toHaveBeenCalledWith("seed", expect.anything());
});

it("keeps a capped all-folder seed incomplete even when the current folder has one row", async () => {
  const bridge = { call: vi.fn(async (method: string) => {
    if (method === "list") return [{ threadId: "t1", placement: "inbox" }];
    if (method === "getSeedState") return { complete: false };
    return true;
  }) };
  const local = makeLocalDb(bridge as any);
  const live = local.liveThreadList(() => "mb_a", () => "inbox");

  await local.open("user_a");

  expect(live.current).toHaveLength(1);
  expect(live.complete).toBe(false);
});
