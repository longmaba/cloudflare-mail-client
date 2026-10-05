// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { isDomainAddress, isExternalRecovery, recoveryResetTarget } from "$lib/server/auth/recovery-policy.js";
import { setupSchema } from "$lib/shared/model/auth.zod.schema.js";

describe("domain administrator setup", () => {
  it("requires an external recovery field in the wizard", () => {
    const input = { email: "admin@example.test", password: "password123", name: "Admin", setupToken: "one-time" };
    expect(setupSchema.safeParse(input).success).toBe(false);
    expect(setupSchema.safeParse({ ...input, recoveryEmail: "r@outside.test" }).success).toBe(true);
  });
  it("matches the configured mail domain exactly and without case sensitivity", () => {
    expect(isDomainAddress("Admin@EXAMPLE.test", "example.test")).toBe(true);
    expect(isDomainAddress("a@sub.example.test", "example.test")).toBe(false);
    expect(isDomainAddress("a@example.test.attacker.test", "example.test")).toBe(false);
  });
  it("rejects recovery on the hosted domain and its children", () => {
    expect(isExternalRecovery("a@example.test", "example.test")).toBe(false);
    expect(isExternalRecovery("a@sub.example.test", "example.test")).toBe(false);
    expect(isExternalRecovery("a@outside.test", "example.test")).toBe(true);
  });
});

describe("setup/reset delivery policy", () => {
  const user = { id: "u1", email: "u@example.test", recoveryEmail: "r@outside.test" };
  it("only permits an unverified recovery address during initial password setup", () => {
    expect(recoveryResetTarget(user)).toBeNull();
    expect(recoveryResetTarget({ ...user, mustChangePassword: true })).toBe(user.recoveryEmail);
    expect(recoveryResetTarget({ ...user, recoveryEmailVerified: true })).toBe(user.recoveryEmail);
  });
  it("does not fall back to the primary domain mailbox for any role", () => {
    expect(recoveryResetTarget({ id: "admin", email: "admin@example.test" })).toBeNull();
  });
});
