// SPDX-License-Identifier: Apache-2.0
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, like } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";

vi.mock("$lib/server/mailer", () => ({ sendMailBackground: vi.fn() }));
import { sendMailBackground } from "$lib/server/mailer";
import { createAuth, type Auth } from "$lib/server/auth.js";

let db: Awaited<ReturnType<typeof makeDb>>;
let auth: Auth;
const domainEmail = "member@example.test";
const recoveryEmail = "recovery@outside.test";
const headers = new Headers({ origin: "http://localhost:5173" });

beforeAll(async () => {
  db = await makeDb();
  auth = createAuth(db);
  setRequestEvent({ locals: { db, auth }, request: new Request("http://localhost:5173"), platform: { env: {} } });
});

beforeEach(async () => {
  vi.clearAllMocks();
  for (const table of [schema.session, schema.account, schema.verification, schema.member, schema.organization, schema.user]) {
    await db.delete(table);
  }
  const ctx = await auth.$context;
  await db.insert(schema.user).values({
    id: "u1", name: "Member", email: domainEmail, role: "member", recoveryEmail,
    recoveryEmailVerified: false, mustChangePassword: true, createdAt: new Date(), updatedAt: new Date(),
  });
  await db.insert(schema.account).values({
    id: "credential", userId: "u1", accountId: "u1", providerId: "credential",
    password: await ctx.password.hash("original-password"), updatedAt: new Date(),
  });
  await db.insert(schema.organization).values({
    id: "o1", domain: "example.test", name: "Example", slug: "example-test", status: "active", createdAt: new Date(),
  });
});

async function requestLink() {
  await auth.api.requestPasswordReset({ body: { email: domainEmail, redirectTo: "http://localhost:5173/reset-password" }, headers });
  const mail = vi.mocked(sendMailBackground).mock.calls[0]?.[0];
  expect(mail?.to).toBe(recoveryEmail);
  const verification = await db.query.verification.findFirst({
    where: like(schema.verification.identifier, "reset-password:%"),
  });
  expect(verification).toBeDefined();
  expect(verification.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60 * 1000);
  return verification.identifier.slice("reset-password:".length) as string;
}

describe("Better Auth recovery link integration", () => {
  it("password login does not verify external recovery ownership", async () => {
    await auth.api.signInEmail({ body: { email: domainEmail, password: "original-password" }, headers });
    expect((await db.query.user.findFirst()).recoveryEmailVerified).toBe(false);
  });

  it("setup email has a token link and no password; redemption proves recovery once", async () => {
    const token = await requestLink();
    const mail = vi.mocked(sendMailBackground).mock.calls[0][0];
    expect(mail.html).toContain("Set up your account");
    expect(mail.html).not.toContain("original-password");
    expect(mail.html).not.toContain("password=");
    await auth.api.resetPassword({ body: { token, newPassword: "chosen-password" }, headers });
    expect(await db.query.user.findFirst()).toMatchObject({ recoveryEmailVerified: true, mustChangePassword: false });
    await expect(auth.api.resetPassword({ body: { token, newPassword: "another-password" }, headers })).rejects.toThrow(/invalid|expired/i);
  });

  it("a reset revokes old sessions without removing enrolled administrator TOTP", async () => {
    await auth.api.signInEmail({ body: { email: domainEmail, password: "original-password" }, headers });
    expect(await db.$count(schema.session)).toBe(1);
    await db.update(schema.user).set({ role: "superadmin", twoFactorEnabled: true });
    const token = await requestLink();
    await auth.api.resetPassword({ body: { token, newPassword: "chosen-password" }, headers });
    expect(await db.$count(schema.session)).toBe(0);
    expect((await db.query.user.findFirst()).twoFactorEnabled).toBe(true);
  });

  it("concurrent redemption changes the credential only once", async () => {
    const token = await requestLink();
    const results = await Promise.allSettled([
      auth.api.resetPassword({ body: { token, newPassword: "chosen-password" }, headers }),
      auth.api.resetPassword({ body: { token, newPassword: "another-password" }, headers }),
    ]);
    expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected")).toHaveLength(1);
  });

  it("normal verified administrator recovery uses the external inbox", async () => {
    await db.update(schema.user).set({ role: "superadmin", mustChangePassword: false, recoveryEmailVerified: true });
    await requestLink();
    expect(vi.mocked(sendMailBackground).mock.calls[0][0].subject).toBe("Reset your password");
  });

  it("expired tokens cannot set a password or verify recovery", async () => {
    const token = await requestLink();
    await db.update(schema.verification).set({ expiresAt: new Date(Date.now() - 1000) });
    await expect(auth.api.resetPassword({ body: { token, newPassword: "chosen-password" }, headers })).rejects.toThrow(/invalid|expired/i);
    expect((await db.query.user.findFirst()).recoveryEmailVerified).toBe(false);
  });

  it("a link to an old recovery inbox is rejected after the address changes", async () => {
    const token = await requestLink();
    await db.update(schema.user).set({ recoveryEmail: "new@outside.test" }).where(eq(schema.user.id, "u1"));
    await expect(auth.api.resetPassword({ body: { token, newPassword: "chosen-password" }, headers })).rejects.toThrow(/invalid|expired/i);
    expect((await db.query.user.findFirst()).recoveryEmailVerified).toBe(false);
  });

  it("public signup is disabled", async () => {
    await expect(auth.api.signUpEmail({ body: { email: "new@example.test", name: "New", password: "chosen-password" }, headers })).rejects.toThrow();
    expect(await db.$count(schema.user)).toBe(1);
  });

  it("ordinary resets without verified recovery do not deliver a link", async () => {
    await db.update(schema.user).set({ mustChangePassword: false });
    await auth.api.requestPasswordReset({ body: { email: domainEmail, redirectTo: "http://localhost:5173/reset-password" }, headers });
    expect(sendMailBackground).not.toHaveBeenCalled();
    expect((await db.query.user.findFirst()).recoveryEmailVerified).toBe(false);
  });
});
