// SPDX-License-Identifier: Apache-2.0
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
import { recoverExistingAdmin, recoveryWranglerOptions, sessionCacheNotice } from "../../scripts/reset-admin.mjs";
import { createAuth } from "$lib/server/auth.js";

vi.mock("$lib/server/mailer", () => ({ sendMailBackground: vi.fn() }));

let db: Awaited<ReturnType<typeof makeDb>>;
let store: Map<string, string>;
let ctx: Awaited<ReturnType<typeof createAuth>["$context"]>;
let pending: string[];
const user = { id: "admin", role: "superadmin", hasCredential: 1 };
const journal = { read: async () => pending, save: async (keys: string[]) => { pending = [...keys]; }, clear: async () => { pending = []; } };

async function execute(sql: string) {
  const results = [];
  for (const statement of sql.split(";").map((s) => s.trim()).filter(Boolean)) {
    const result = await db.$client.execute(statement);
    results.push({ success: true, results: result.rows });
  }
  return results;
}
async function cachedTokens() {
  return JSON.parse(store.get("active-sessions-admin") ?? "[]").map((entry: { token: string }) => entry.token);
}
async function purgeKeys(keys: string[]) { for (const key of keys) store.delete(key); }

beforeAll(async () => {
  db = await makeDb(); store = new Map();
  const kv = { get: async (key: string) => store.get(key) ?? null, put: async (key: string, value: string) => { store.set(key, value); }, delete: async (key: string) => { store.delete(key); } };
  const auth = createAuth(db, kv as unknown as KVNamespace);
  setRequestEvent({ locals: { db, auth }, request: new Request("http://localhost:5173"), platform: { env: {} } });
  ctx = await auth.$context;
});

beforeEach(async () => {
  store.clear(); pending = [];
  for (const table of [schema.session, schema.account, schema.twoFactor, schema.user]) await db.delete(table);
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.test", role: "superadmin", recoveryEmail: "admin@outside.test", recoveryEmailVerified: true, updatedAt: new Date() });
  await db.insert(schema.account).values({ id: "credential", userId: "admin", accountId: "admin", providerId: "credential", password: await ctx.password.hash("original-password"), updatedAt: new Date() });
});

describe("administrator CLI recovery revocation", () => {
  it("captures Wrangler query output without suppressing JSON or enabling response logs", () => {
    for (const level of ["error", "debug"]) {
      const env = { WRANGLER_LOG: level, WRANGLER_WRITE_LOGS: "true", CLOUDFLARE_API_TOKEN: "private-fixture" };
      const options = recoveryWranglerOptions(env);
      expect(options).toEqual({
        env: { ...env, WRANGLER_LOG: "log", WRANGLER_WRITE_LOGS: "false" },
        capture: true,
        secrets: ["credential-output"],
      });
      expect(env.WRANGLER_LOG).toBe(level);
      expect(env.WRANGLER_WRITE_LOGS).toBe("true");
    }
  });

  it("removes real Better Auth cached sessions that survive D1-only deletion", async () => {
    const session = await ctx.internalAdapter.createSession("admin");
    await db.$client.execute("DELETE FROM session WHERE user_id='admin'");
    expect(await ctx.internalAdapter.findSession(session.token)).not.toBeNull(); // the original blocker
    await recoverExistingAdmin({ user, password: "new-password-1234", execute, cachedTokens, purgeKeys, journal });
    expect(await ctx.internalAdapter.findSession(session.token)).toBeNull();
    expect(store.has("active-sessions-admin")).toBe(false);
    expect(pending).toEqual([]);
    const [account] = await db.select().from(schema.account);
    expect(await ctx.password.verify({ hash: account.password!, password: "new-password-1234" })).toBe(true);
    expect(sessionCacheNotice).toContain("5 minutes");
    expect(sessionCacheNotice).toContain("not immediate containment");
  });

  it("keeps exact secret keys for a failed purge and resumes after D1 rows are gone", async () => {
    const own = await ctx.internalAdapter.createSession("admin");
    await db.insert(schema.user).values({ id: "other", name: "Other", email: "other@example.test", updatedAt: new Date() });
    const other = await ctx.internalAdapter.createSession("other");
    await expect(recoverExistingAdmin({ user, password: "new-password-1234", execute, cachedTokens, purgeKeys: async () => { throw new Error(`sensitive provider detail ${own.token}`); }, journal })).rejects.toThrow("Do not assume old sessions are revoked");
    expect(await db.query.session.findMany({ where: eq(schema.session.userId, "admin") })).toHaveLength(0);
    expect(pending).toContain(own.token);
    expect(pending).not.toContain(other.token);
    await recoverExistingAdmin({ user, password: "new-password-1234", execute, cachedTokens, purgeKeys, journal });
    expect(await ctx.internalAdapter.findSession(own.token)).toBeNull();
    expect(await ctx.internalAdapter.findSession(other.token)).not.toBeNull();
    expect(pending).toEqual([]);
  });

  it("fails before credential writes when KV permission or journal reads fail", async () => {
    const before = (await db.select().from(schema.account))[0].password;
    await expect(recoverExistingAdmin({ user, password: "new-password-1234", execute, cachedTokens: async () => { throw new Error("missing KV permission"); }, purgeKeys, journal })).rejects.toThrow("missing KV permission");
    expect((await db.select().from(schema.account))[0].password).toBe(before);
    await expect(recoverExistingAdmin({ user, password: "new-password-1234", execute, cachedTokens, purgeKeys, journal: { ...journal, read: async () => { throw new Error("corrupt journal"); } } })).rejects.toThrow("corrupt journal");
    expect((await db.select().from(schema.account))[0].password).toBe(before);
  });

  it("includes a concurrent session returned by the D1 deletion, and clears TOTP only on request", async () => {
    const lateSession = vi.fn();
    const executeWithRace = async (sql: string) => {
      if (sql.startsWith("UPDATE account")) {
        const session = await ctx.internalAdapter.createSession("admin"); lateSession(session.token);
        // Simulate a stale KV index: the authoritative DELETE RETURNING captures it.
        store.delete("active-sessions-admin");
      }
      return execute(sql);
    };
    await db.insert(schema.twoFactor).values({ id: "totp", userId: "admin", secret: "encrypted-test-secret", backupCodes: "[]" });
    await recoverExistingAdmin({ user, password: "new-password-1234", execute: executeWithRace, cachedTokens, purgeKeys, journal });
    expect(await ctx.internalAdapter.findSession(lateSession.mock.calls[0][0])).toBeNull();
    expect(await db.query.twoFactor.findMany()).toHaveLength(1);
    await recoverExistingAdmin({ user, password: "new-password-1234", clearTwoFactor: true, execute, cachedTokens, purgeKeys, journal });
    expect(await db.query.twoFactor.findMany()).toHaveLength(0);
  });
});
