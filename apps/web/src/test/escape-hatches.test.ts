// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as schema from "@doota/db/schema";
import { fakeCtx, fakeDb, installEvent, clearEvent } from "./fakes";
import { makeDb } from "./mail-db";

// invalidateDomainCache is a module-cache clear with real deps we don't want to
// load; mock it so setOrgLifecycle's call is observable (guards finding F1).
vi.mock("@doota/db/org-domains", () => ({ invalidateDomainCache: vi.fn() }));

import { invalidateDomainCache } from "@doota/db/org-domains";
import {
  tokenStore,
  throttleAllows,
  setUserAuthFlags,
  stampOnboarded,
  setOrgLifecycle,
  purgeUserMemberships,
  createGenesisSuperadmin,
  genesisSetupLocked,
} from "$lib/server/auth/escape-hatches.js";

beforeEach(() => {
  vi.clearAllMocks();
  clearEvent();
});

describe("tokenStore", () => {
  it("issue() writes a namespaced verification value with a future expiry", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);
    const before = Date.now();
    await tokenStore.issue("recovery-email:tok", "payload", 60_000);

    expect(internalAdapter.createVerificationValue).toHaveBeenCalledTimes(1);
    const arg = internalAdapter.createVerificationValue.mock.calls[0][0];
    expect(arg.identifier).toBe("recovery-email:tok");
    expect(arg.value).toBe("payload");
    expect(arg.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 60_000);
  });

  it("consume() returns {value} when present, null when absent", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);

    internalAdapter.consumeVerificationValue.mockResolvedValueOnce({ value: "v1" });
    expect(await tokenStore.consume("id")).toEqual({ value: "v1" });

    internalAdapter.consumeVerificationValue.mockResolvedValueOnce(null);
    expect(await tokenStore.consume("id")).toBeNull();
  });

  it("peek() returns unexpired row shape or null", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    f.findFirst.mockResolvedValueOnce({ id: "r1", value: "c", extra: 1 });
    expect(await tokenStore.peek("id")).toEqual({ id: "r1", value: "c" });

    f.findFirst.mockResolvedValueOnce(undefined);
    expect(await tokenStore.peek("id")).toBeNull();
  });

  it("dropById / dropByIdentifier delete from the verification table", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await tokenStore.dropById("r1");
    await tokenStore.dropByIdentifier("id");
    expect(f.del).toHaveBeenCalledTimes(2);
    expect(f.del).toHaveBeenCalledWith(schema.verification);
  });
});

describe("throttleAllows", () => {
  it("returns false and issues nothing when a live marker exists", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.findFirst.mockResolvedValueOnce({ id: "r", value: "1" });

    expect(await throttleAllows("k", 60_000)).toBe(false);
    expect(internalAdapter.createVerificationValue).not.toHaveBeenCalled();
  });

  it("returns true and sets a marker when none exists", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);
    f.findFirst.mockResolvedValueOnce(undefined);

    expect(await throttleAllows("k", 60_000)).toBe(true);
    expect(internalAdapter.createVerificationValue).toHaveBeenCalledOnce();
  });
});

describe("setUserAuthFlags", () => {
  it("updates the user via the internal adapter with exactly the given flags", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    installEvent(fakeDb().db, ctx);

    await setUserAuthFlags("u1", { mustChangePassword: false });
    expect(internalAdapter.updateUser).toHaveBeenCalledWith("u1", {
      mustChangePassword: false,
    });
  });
});

describe("stampOnboarded", () => {
  it("sets onboardedAt via the internal adapter (keeps cached sessions coherent)", async () => {
    const { ctx, internalAdapter } = fakeCtx();
    await stampOnboarded({ $context: Promise.resolve(ctx) } as never, "u1");
    expect(internalAdapter.updateUser).toHaveBeenCalledWith("u1", {
      onboardedAt: expect.any(Number),
    });
  });
});

describe("setOrgLifecycle", () => {
  it("writes status only, then invalidates the domain cache (F1)", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await setOrgLifecycle("org1", "pending_nameservers");
    expect(f.update).toHaveBeenCalledWith(schema.organization);
    expect(f.set).toHaveBeenCalledWith({ status: "pending_nameservers" });
    expect(invalidateDomainCache).toHaveBeenCalledOnce();
  });

  it("writes status + zoneId when a zone is provided", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await setOrgLifecycle("org1", "active", "zone9");
    expect(f.set).toHaveBeenCalledWith({ status: "active", zoneId: "zone9" });
    expect(invalidateDomainCache).toHaveBeenCalledOnce();
  });
});

describe("purgeUserMemberships", () => {
  it("deletes from the member table", async () => {
    const { ctx } = fakeCtx();
    const f = fakeDb();
    installEvent(f.db, ctx);

    await purgeUserMemberships("u1");
    expect(f.del).toHaveBeenCalledWith(schema.member);
  });
});

describe("createGenesisSuperadmin", () => {
  const input = { name: "Admin", email: "admin@example.test", recoveryEmail: "rescue@outside.test", domain: "example.test", password: "password123" };

  async function genesisDb() {
    const db = await makeDb();
    const { ctx, internalAdapter } = fakeCtx();
    internalAdapter.createUser.mockImplementation(async (u) => {
      await db.insert(schema.user).values({ ...u, id: "u1" });
      return { ...u, id: "u1" };
    });
    internalAdapter.deleteUser.mockImplementation(async (id) => {
      await db.delete(schema.user).where((await import("drizzle-orm")).eq(schema.user.id, id));
    });
    installEvent(db, ctx);
    return { db, ctx, internalAdapter };
  }

  it("creates a domain-email admin, owner membership and first personal mailbox", async () => {
    const { db, internalAdapter } = await genesisDb();
    const res = await createGenesisSuperadmin(input);
    expect(res).toEqual({ id: "u1" });
    expect(internalAdapter.linkAccount).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", password: "hashed:password123", providerId: "credential" }),
    );
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
    expect(await db.query.user.findFirst()).toMatchObject({ email: input.email, recoveryEmail: input.recoveryEmail, recoveryEmailVerified: false, role: "superadmin" });
    expect(await db.query.organization.findFirst()).toMatchObject({ domain: input.domain, status: "pending_zone" });
    expect(await db.query.member.findFirst()).toMatchObject({ userId: "u1", role: "owner" });
    expect(await db.query.mailbox.findFirst()).toMatchObject({ address: input.email, isPersonal: true });
    expect(await genesisSetupLocked(db)).toBe(true);
  });

  it("releases the setup lock when creating the user fails", async () => {
    const { db, internalAdapter } = await genesisDb();
    internalAdapter.createUser.mockResolvedValueOnce(undefined);
    await expect(createGenesisSuperadmin(input)).rejects.toThrow(/no user/i);
    expect(internalAdapter.linkAccount).not.toHaveBeenCalled();
    expect(internalAdapter.deleteUser).not.toHaveBeenCalled();
    expect(await genesisSetupLocked(db)).toBe(false);
  });

  it("rolls back the user and rethrows when the password link fails", async () => {
    const { db, internalAdapter } = await genesisDb();
    internalAdapter.linkAccount.mockRejectedValueOnce(new Error("link failed"));
    await expect(createGenesisSuperadmin(input)).rejects.toThrow("link failed");
    expect(internalAdapter.deleteUser).toHaveBeenCalledWith("u1");
    expect(await db.$count(schema.user)).toBe(0);
    expect(await genesisSetupLocked(db)).toBe(false);
  });

  it("rejects racing bootstrap attempts before a second user can be created", async () => {
    const { internalAdapter } = await genesisDb();
    const outcomes = await Promise.allSettled([createGenesisSuperadmin(input), createGenesisSuperadmin(input)]);
    expect(outcomes.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(internalAdapter.createUser).toHaveBeenCalledOnce();
  });

  it("remains locked if an operator later deletes all users", async () => {
    const { db } = await genesisDb();
    await createGenesisSuperadmin(input);
    await db.delete(schema.user);
    expect(await genesisSetupLocked(db)).toBe(true);
    await expect(createGenesisSuperadmin(input)).rejects.toThrow(/already completed/i);
  });

  it("recovers an expired setup claim when interruption created no user", async () => {
    const { db } = await genesisDb();
    await db.insert(schema.verification).values({
      id: "cloudflare-mail-client:genesis-lock", identifier: "cloudflare-mail-client:genesis-lock",
      value: "claimed", expiresAt: new Date(Date.now() - 1000),
    });
    expect(await genesisSetupLocked(db)).toBe(false);
    expect(await createGenesisSuperadmin(input)).toEqual({ id: "u1" });
    expect(await genesisSetupLocked(db)).toBe(true);
  });
});
