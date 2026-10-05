// SPDX-License-Identifier: Apache-2.0
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("$lib/server/auth/escape-hatches.js", () => ({
  tokenStore: {
    peek: vi.fn(),
    issue: vi.fn(),
    dropById: vi.fn(),
    dropByIdentifier: vi.fn(),
  },
  throttleAllows: vi.fn(),
}));
vi.mock("@doota/db/org-domains", () => ({
  senderAddress: vi.fn(async () => ({ name: "Doota", email: "no-reply@acme.com" })),
  domainOf: vi.fn((e: string) => e.split("@")[1]),
  isServedDomain: vi.fn(async () => false),
}));
vi.mock("$lib/server/mailer.js", () => ({ sendMail: vi.fn() }));
vi.mock("$lib/server/email.js", () => ({
  renderEmail: vi.fn(() => ({ subject: "s", text: "t", html: "h" })),
}));

import { resetTarget, confirmPasswordResetCode, sendPasswordResetCode } from "$lib/server/password-reset.js";
import { tokenStore, throttleAllows } from "$lib/server/auth/escape-hatches.js";
import { sendMail } from "$lib/server/mailer.js";

beforeEach(() => vi.clearAllMocks());

describe("resetTarget (security invariant)", () => {
  it("superadmin uses verified external recovery, never the domain login", () => {
    expect(resetTarget({ id: "1", email: "s@example.test", role: "superadmin", recoveryEmail: "r@ext.com", recoveryEmailVerified: true })).toBe("r@ext.com");
    expect(resetTarget({ id: "1", email: "s@example.test", role: "superadmin" })).toBeNull();
  });
  it("member with VERIFIED recovery → the recovery email", () => {
    expect(
      resetTarget({
        id: "1",
        email: "m@acme.com",
        role: "member",
        recoveryEmail: "r@ext.com",
        recoveryEmailVerified: true,
      }),
    ).toBe("r@ext.com");
  });
  it("member with UNVERIFIED recovery → null (never the unverified address)", () => {
    expect(
      resetTarget({
        id: "1",
        email: "m@acme.com",
        role: "member",
        recoveryEmail: "r@ext.com",
        recoveryEmailVerified: false,
      }),
    ).toBeNull();
  });
  it("member with no recovery → null (never the served-domain inbox)", () => {
    expect(resetTarget({ id: "1", email: "m@acme.com", role: "member" })).toBeNull();
  });
});

describe("confirmPasswordResetCode", () => {
  it("false when no active code", async () => {
    vi.mocked(tokenStore.peek).mockResolvedValueOnce(null);
    expect(await confirmPasswordResetCode("u1", "123456")).toBe(false);
    expect(tokenStore.dropById).not.toHaveBeenCalled();
  });
  it("true + consumes the code on match", async () => {
    vi.mocked(tokenStore.peek).mockResolvedValueOnce({ id: "r1", value: "123456" });
    expect(await confirmPasswordResetCode("u1", "123456")).toBe(true);
    expect(tokenStore.dropById).toHaveBeenCalledWith("r1");
  });
  it("false on wrong code, leaves the record for retry", async () => {
    vi.mocked(tokenStore.peek).mockResolvedValueOnce({ id: "r1", value: "123456" });
    expect(await confirmPasswordResetCode("u1", "000000")).toBe(false);
    expect(tokenStore.dropById).not.toHaveBeenCalled();
  });
});

describe("sendPasswordResetCode", () => {
  const db = {} as never;

  it("no valid target → not sent", async () => {
    const res = await sendPasswordResetCode(db, { id: "1", email: "m@acme.com", role: "member" });
    expect(res.ok).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("throttled → not sent", async () => {
    vi.mocked(throttleAllows).mockResolvedValueOnce(false);
    const res = await sendPasswordResetCode(db, { id: "1", email: "s@example.test", role: "superadmin", recoveryEmail: "s@ext.com", recoveryEmailVerified: true });
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/wait a minute/i);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("happy path issues one code and mails it (masked)", async () => {
    vi.mocked(throttleAllows).mockResolvedValueOnce(true);
    const res = await sendPasswordResetCode(db, { id: "1", email: "super@example.test", role: "superadmin", recoveryEmail: "super@ext.com", recoveryEmailVerified: true });
    expect(res.ok).toBe(true);
    // one active code per user: prior dropped, new issued
    expect(tokenStore.dropByIdentifier).toHaveBeenCalledWith("pwreset:1");
    expect(tokenStore.issue).toHaveBeenCalledOnce();
    expect(sendMail).toHaveBeenCalledOnce();
    expect(res.message).toContain("•"); // masked target
  });
});
