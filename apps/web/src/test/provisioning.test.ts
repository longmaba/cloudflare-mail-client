// SPDX-License-Identifier: Apache-2.0
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { fakeCtx } from "./fakes";
import { setRequestEvent } from "./stubs/app-server";
import { invalidateDomainCache, senderAddress } from '@doota/db/org-domains';
import { getOnboardingStatus } from '$lib/server/onboarding.js';

vi.mock('$app/env/private', async (original) => ({ ...await original<object>(), MAIL_STAGING_DOMAIN: 'example.com' }));

vi.mock("$lib/server/mail-routing.js", () => ({ ensureMailboxRouting: vi.fn() }));
import { ensureMailboxRouting } from "$lib/server/mail-routing.js";
import { provisionUser, type ProvisionInput } from "$lib/server/provisioning.js";

let db: Awaited<ReturnType<typeof makeDb>>;
let createUser: ReturnType<typeof vi.fn>;
let requestPasswordReset: ReturnType<typeof vi.fn>;
const input: ProvisionInput = { name: "New member", email: "new", recoveryEmail: "rescue@outside.test", role: "member", organizationId: "o1" };
let actualRouting: typeof import('$lib/server/mail-routing.js');

beforeAll(async () => {
  // Load the real routing fixture before timed assertions. Cold full-suite
  // transforms must not consume this provisioning test's execution deadline.
  actualRouting = await vi.importActual<typeof import('$lib/server/mail-routing.js')>('$lib/server/mail-routing.js');
});

beforeEach(async () => {
  vi.resetAllMocks();
  db = await makeDb();
  invalidateDomainCache();
  await db.insert(schema.organization).values({ id: "o1", name: "Example", domain: "example.test", slug: "example-test", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values({ id: "admin", name: "Admin", email: "admin@example.test", role: "admin", updatedAt: new Date() });
  await db.insert(schema.member).values({ id: "owner", organizationId: "o1", userId: "admin", role: "admin", createdAt: new Date() });
  const { ctx, internalAdapter } = fakeCtx();
  internalAdapter.updateUser.mockImplementation(async (id, flags) => {
    await db.update(schema.user).set(flags).where(eq(schema.user.id, id));
  });
  createUser = vi.fn(async ({ body }) => {
    const user = { id: "new-user", email: body.email, name: body.name, role: body.role, ...body.data, updatedAt: new Date() };
    await db.insert(schema.user).values(user);
    return { user };
  });
  const addMember = vi.fn(async ({ body }) => {
    await db.insert(schema.member).values({ ...body, id: "new-member", createdAt: new Date() });
  });
  requestPasswordReset = vi.fn(async () => ({ status: true }));
  setRequestEvent({
    locals: { db, auth: { $context: Promise.resolve(ctx), api: { createUser, addMember, requestPasswordReset } } },
    request: new Request("http://localhost:5173"), platform: { env: {} },
  });
});

describe("administrator account invitations", () => {
  it("a member cannot provision another account", async () => {
    expect((await provisionUser({ id: "member", role: "member" }, input)).success).toBe(false);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("an administrator outside the target organization cannot provision into it", async () => {
    expect((await provisionUser({ id: "unrelated-admin", role: "admin" }, input)).success).toBe(false);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("creates domain mailbox and routes it before requesting a password setup link", async () => {
    expect((await provisionUser({ id: "admin", role: "admin" }, input)).success).toBe(true);
    const user = await db.query.user.findFirst({ where: eq(schema.user.id, "new-user") });
    expect(user).toMatchObject({ email: "new@example.test", recoveryEmail: input.recoveryEmail, mustChangePassword: true, recoveryEmailVerified: false });
    expect(await db.query.mailbox.findFirst()).toMatchObject({ address: "new@example.test", isPersonal: true });
    expect(ensureMailboxRouting).toHaveBeenCalledWith(db, "o1", "new@example.test");
    expect(requestPasswordReset).toHaveBeenCalledWith({ body: { email: "new@example.test", redirectTo: "http://localhost:5173/reset-password" }, headers: expect.any(Headers) });
    expect(vi.mocked(ensureMailboxRouting).mock.invocationCallOrder[0]).toBeLessThan(requestPasswordReset.mock.invocationCallOrder[0]);
    expect(createUser.mock.calls[0][0].body.password).toMatch(/^[a-f0-9]{64}$/);
    expect(requestPasswordReset.mock.calls[0][0].body).not.toHaveProperty("password");
  });

  it("does not send an invitation when email routing failed", async () => {
    vi.mocked(ensureMailboxRouting).mockRejectedValueOnce(new Error("Permission denied"));
    const result = await provisionUser({ id: "admin", role: "admin" }, input);
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/routing failed/i);
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it("rejects a recovery inbox hosted by this deployment", async () => {
    const result = await provisionUser({ id: "admin", role: "admin" }, { ...input, recoveryEmail: "another@example.test" });
    expect(result.success).toBe(false);
    expect(createUser).not.toHaveBeenCalled();
    expect(requestPasswordReset).not.toHaveBeenCalled();
  });

  it('prepares a scoped staged account using the active pilot sender and unchanged private setup flow', async () => {
    const providerRequest = vi.spyOn(globalThis, 'fetch');
    await db.update(schema.organization).set({ domain: 'pilot.example.com' }).where(eq(schema.organization.id, 'o1'));
    await db.insert(schema.organization).values({ id: 'apex', name: 'Apex', slug: 'apex', domain: 'example.com', status: 'staged', createdAt: new Date() });
    vi.mocked(ensureMailboxRouting).mockImplementationOnce(actualRouting.ensureMailboxRouting);
    expect(await senderAddress(db, 'example.com')).toMatchObject({ email: 'no-reply@pilot.example.com' });
    const result = await provisionUser({ id: 'admin', role: 'superadmin' }, { ...input, organizationId: 'apex' });
    expect(result.success).toBe(true);
    expect(await db.query.mailbox.findFirst()).toMatchObject({ orgId: 'apex', address: 'new@example.com' });
    expect(createUser.mock.calls[0][0].body.password).toMatch(/^[a-f0-9]{64}$/);
    expect(requestPasswordReset).toHaveBeenCalledWith({ body: { email: 'new@example.com', redirectTo: 'http://localhost:5173/reset-password' }, headers: expect.any(Headers) });
    // Once the existing recovery/reset hooks finish, ordinary members have no
    // domain activation step and can enter their prepared account.
    await db.update(schema.user).set({ recoveryEmailVerified: true, mustChangePassword: false }).where(eq(schema.user.id, 'new-user'));
    expect(await getOnboardingStatus(db, { id: 'new-user', role: 'member' })).toMatchObject({ complete: true });
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'apex') })).toMatchObject({ status: 'staged' });
    expect(providerRequest).not.toHaveBeenCalled();
    providerRequest.mockRestore();
  });

  it('rejects a staged invitation without an active sending path before creating an account', async () => {
    await db.update(schema.organization).set({ domain: 'example.com', status: 'staged' }).where(eq(schema.organization.id, 'o1'));
    expect(await provisionUser({ id: 'admin', role: 'admin' }, input)).toMatchObject({ success: false, message: expect.stringMatching(/pilot sending/i) });
    expect(createUser).not.toHaveBeenCalled(); expect(requestPasswordReset).not.toHaveBeenCalled(); expect(ensureMailboxRouting).not.toHaveBeenCalled();
    expect(await db.query.mailbox.findMany()).toEqual([]);
  });

  it('does not allow arbitrary staged domains outside the installer scope', async () => {
    await db.update(schema.organization).set({ status: 'staged' }).where(eq(schema.organization.id, 'o1'));
    expect((await provisionUser({ id: 'admin', role: 'admin' }, input)).success).toBe(false);
    expect(createUser).not.toHaveBeenCalled(); expect(requestPasswordReset).not.toHaveBeenCalled();
  });
});
