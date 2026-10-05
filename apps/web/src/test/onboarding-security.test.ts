// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { getOnboardingStatus, hasSecurityDebt, orgTwoFactorGate } from "$lib/server/onboarding";

/**
 * The TOTP mandate for elevated roles. The incident this guards:
 * an admin enrolled a passkey but no TOTP — password sign-in never consults
 * passkeys, so bare credentials logged them in with no second factor.
 */

let db: Awaited<ReturnType<typeof makeDb>>;

async function seedAdmin(over: Partial<typeof schema.user.$inferInsert> = {}) {
  await db.insert(schema.user).values({
    id: "a1",
    name: "Admin",
    email: "admin@acme.com",
    emailVerified: true,
    role: "admin",
    recoveryEmail: "rescue@ext.com",
    recoveryEmailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  });
}

function addPasskey(userId: string) {
  return db.insert(schema.passkey).values({
    id: crypto.randomUUID(),
    publicKey: "pk",
    userId,
    credentialID: crypto.randomUUID(),
    counter: 0,
    deviceType: "multiDevice",
    backedUp: true,
  });
}

beforeEach(async () => {
  db = await makeDb();
});

describe("secure-account step — administrator TOTP required, passkeys optional", () => {
  it("passkey WITHOUT TOTP does not satisfy the step (the incident)", async () => {
    await seedAdmin({ twoFactorEnabled: false });
    await addPasskey("a1");
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((step) => step.id === "secure-account")?.done).toBe(false);
    expect(status.complete).toBe(false);
  });

  it("TOTP WITHOUT a passkey satisfies the step", async () => {
    await seedAdmin({ twoFactorEnabled: true });
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((step) => step.id === "secure-account")?.done).toBe(true);
    expect(status.complete).toBe(true);
  });

  it("TOTP + passkey completes the step", async () => {
    await seedAdmin({ twoFactorEnabled: true });
    await addPasskey("a1");
    const status = await getOnboardingStatus(db, { id: "a1", role: "admin" });
    expect(status.steps.find((step) => step.id === "secure-account")?.done).toBe(true);
    expect(status.complete).toBe(true);
  });

  it("an already-onboarded admin with 2FA off is pulled back in (no fast path)", async () => {
    await seedAdmin({ twoFactorEnabled: false, onboardedAt: Date.now() });
    const user = { id: "a1", role: "admin", onboardedAt: Date.now(), twoFactorEnabled: false };
    expect(hasSecurityDebt(user)).toBe(true);
    const status = await getOnboardingStatus(db, user);
    expect(status.complete).toBe(false);
    expect(status.nextStep).toBe("secure-account");
  });

  it("members carry no security debt and no secure-account step", async () => {
    expect(hasSecurityDebt({ id: "m1", role: "member", twoFactorEnabled: false })).toBe(false);
    await seedAdmin({ id: "m1", email: "m@acme.com", role: "member" } as never);
    const status = await getOnboardingStatus(db, { id: "m1", role: "member" });
    expect(status.steps.some((step) => step.id === "secure-account")).toBe(false);
  });

  it.each(["admin", "owner"])("a current organization %s must enroll despite a completed member session", async (role) => {
    await seedAdmin({ role: "member", twoFactorEnabled: false, onboardedAt: Date.now() });
    await db.insert(schema.organization).values({ id: "org", name: "Acme", domain: "acme.com", slug: "acme", createdAt: new Date() });
    await db.insert(schema.member).values({ id: "membership", userId: "a1", organizationId: "org", role: "member", createdAt: new Date() });
    const cached = { id: "a1", role: "member", onboardedAt: Date.now(), twoFactorEnabled: false };
    expect((await orgTwoFactorGate(db, cached)).kind).toBe("none");
    // Both the app and Better Auth organization endpoints update membership
    // independently of user.role; the next request must observe that promotion.
    await db.update(schema.member).set({ role }).where(eq(schema.member.id, "membership"));
    expect((await db.query.user.findFirst()).role).toBe("member");
    expect((await orgTwoFactorGate(db, cached, "another-active-org")).kind).toBe("block");
    expect((await getOnboardingStatus(db, cached)).nextStep).toBe("secure-account");
    await db.update(schema.user).set({ twoFactorEnabled: true }).where(eq(schema.user.id, "a1"));
    expect((await orgTwoFactorGate(db, cached)).kind).toBe("none");
    expect((await getOnboardingStatus(db, cached)).complete).toBe(true);
  });

  it("observes a global admin promotion even while the session still says member", async () => {
    await seedAdmin({ role: "member", twoFactorEnabled: false, onboardedAt: Date.now() });
    const cached = { id: "a1", role: "member", onboardedAt: Date.now(), twoFactorEnabled: false };
    await db.update(schema.user).set({ role: "admin" }).where(eq(schema.user.id, "a1"));
    expect((await orgTwoFactorGate(db, cached)).kind).toBe("block");
    expect((await getOnboardingStatus(db, cached)).nextStep).toBe("secure-account");
  });

  it("ignores cached TOTP enrollment after an administrator disables it", async () => {
    await seedAdmin({ role: "admin", twoFactorEnabled: false, onboardedAt: Date.now() });
    const cached = { id: "a1", role: "admin", onboardedAt: Date.now(), twoFactorEnabled: true };
    expect((await orgTwoFactorGate(db, cached)).kind).toBe("block");
    expect((await getOnboardingStatus(db, cached)).nextStep).toBe("secure-account");
  });
});
