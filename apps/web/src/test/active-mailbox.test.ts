// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";

// Runed intentionally returns its initial value during SSR. These tests drive
// browser-state ownership; persistence and component ordering get browser proof.
vi.mock("runed", () => ({
  PersistedState: class {
    constructor(_key: string, public current: string | null) {}
  },
}));

beforeEach(() => vi.resetModules());

describe("remembered mailbox account ownership", () => {
  it("clears a legacy unowned mailbox before the signed-in account uses it", async () => {
    const { activeMailbox, bindActiveMailbox } = await import("$lib/client/active-mailbox.svelte");
    activeMailbox.current = "previous-account-mailbox";
    bindActiveMailbox("member-b");
    expect(activeMailbox.current).toBeNull();
  });

  it("retains the same user's offline selection and clears it for another account", async () => {
    const { activeMailbox, bindActiveMailbox } = await import("$lib/client/active-mailbox.svelte");
    bindActiveMailbox("member-a");
    activeMailbox.current = "mailbox-a";
    bindActiveMailbox("member-a");
    expect(activeMailbox.current).toBe("mailbox-a");

    bindActiveMailbox("member-b");
    expect(activeMailbox.current).toBeNull();
    activeMailbox.current = "mailbox-b";
    bindActiveMailbox("member-b");
    expect(activeMailbox.current).toBe("mailbox-b");
  });
});
