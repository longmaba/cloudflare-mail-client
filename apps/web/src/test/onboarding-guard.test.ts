// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RequestEvent } from "@sveltejs/kit";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";

let db: Awaited<ReturnType<typeof makeDb>>;
const state = vi.hoisted(() => ({ session: {} as Record<string, unknown> }));
vi.mock("drizzle-orm/d1", () => ({ drizzle: () => db }));
vi.mock("$lib/server/auth.js", () => ({ createAuth: () => ({ api: { getSession: async () => state.session } }) }));
vi.mock("better-auth/svelte-kit", () => ({ svelteKitHandler: ({ event, resolve }: { event: RequestEvent; resolve: (event: RequestEvent) => Promise<Response> }) => resolve(event) }));
import { handle } from "../hooks.server";

beforeEach(async () => {
  db = await makeDb();
  const user = { id: "user", name: "Member", email: "member@example.test", role: "member", recoveryEmail: "rescue@outside.test", recoveryEmailVerified: true, onboardedAt: Date.now(), twoFactorEnabled: false, updatedAt: new Date() };
  await db.insert(schema.user).values(user);
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.test", createdAt: new Date() });
  state.session = { user, session: { id: "cached-session", userId: user.id, activeOrganizationId: "org" } };
});

async function appRequest(path = "/app") {
  const event = { url: new URL(path, "http://localhost:5173"), request: new Request(new URL(path, "http://localhost:5173")), locals: {}, platform: { env: { DB: {} } } } as unknown as RequestEvent;
  const resolve = vi.fn(async () => new Response("application", { status: 200 }));
  return { result: handle({ event, resolve }), resolve };
}

describe("application guard requires current administrator TOTP", () => {
  it("blocks an organization-admin promotion before resolving application content", async () => {
    await db.insert(schema.member).values({ id: "membership", userId: "user", organizationId: "org", role: "admin", createdAt: new Date() });
    const { result, resolve } = await appRequest();
    await expect(result).rejects.toMatchObject({ status: 302, location: "/onboarding" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("blocks disabled TOTP even if the browser cookie still reports enrollment", async () => {
    await db.insert(schema.member).values({ id: "membership", userId: "user", organizationId: "org", role: "owner", createdAt: new Date() });
    state.session = { ...state.session, user: { ...(state.session.user as object), twoFactorEnabled: true } };
    const { result, resolve } = await appRequest();
    await expect(result).rejects.toMatchObject({ status: 302, location: "/onboarding" });
    expect(resolve).not.toHaveBeenCalled();
  });

  it("keeps MFA optional for an ordinary member without an organization mandate", async () => {
    const { result, resolve } = await appRequest();
    expect((await result).status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it.each(["update-member-role", "create", "add-member", "remove-member"])("keeps raw organization/%s outside the onboarding bypass", async (operation) => {
    const { result, resolve } = await appRequest(`/api/auth/organization/${operation}`);
    expect((await result).status).toBe(404);
    expect(resolve).not.toHaveBeenCalled();
  });

  it.each(["two-factor/enable", "two-factor/verify-totp", "request-password-reset", "get-session"])("keeps %s reachable to finish onboarding", async (operation) => {
    await db.insert(schema.member).values({ id: "membership", userId: "user", organizationId: "org", role: "admin", createdAt: new Date() });
    const { result, resolve } = await appRequest(`/api/auth/${operation}`);
    expect((await result).status).toBe(200);
    expect(resolve).toHaveBeenCalledOnce();
  });
});
