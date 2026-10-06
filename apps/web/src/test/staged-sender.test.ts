// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
import { resolveSender, resolveServiceSender, assertDomainNotStaged } from "@doota/mail-core/resolver";
import { enqueueSend } from "@doota/mail-core/outbound";
import { createDraft, saveDraft, sendDraft } from "@doota/mail-core/drafts";
import { importKey } from "@doota/mail-core/crypto";

vi.mock("$app/server", async original => ({
  ...await original<object>(), command: (_schema: unknown, fn: unknown) => fn,
}));
vi.mock("$lib/server/mail/deliver-bridge.js", () => ({ deliverInBackground: vi.fn() }));
vi.mock("$lib/server/auth/api-key.js", () => ({
  bearerFromHeaders: () => "synthetic-key",
  verifyApiKey: async () => ({ userId: null, mailboxId: "service-box", isService: true, keyId: "service-key" }),
}));
import { sendMessage } from "$lib/rpc/send.remote";
import { POST as apiSend } from "../routes/api/send/+server";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let ck: Awaited<ReturnType<typeof importKey>>;
const raw = { put: vi.fn(), get: vi.fn() };
const queue = { send: vi.fn() };
const env = { MAIL_DEK: KEY, MAIL_SEARCH_KEY: KEY, MAIL_RAW: raw as never, MAIL_OUT_QUEUE: queue as never };

beforeEach(async () => {
  vi.clearAllMocks();
  db = await makeDb();
  ck = await importKey(KEY);
  await db.insert(schema.organization).values({ id: "staged-org", name: "Prepared", slug: "prepared", domain: "example.com", status: "staged", createdAt: new Date() });
  await db.insert(schema.user).values({ id: "owner", name: "Owner", email: "owner@example.com", role: "member", updatedAt: new Date() });
  await db.insert(schema.mailbox).values([
    { id: "owner-box", orgId: "staged-org", localPart: "owner", address: "owner@example.com", isPersonal: true, isActive: true },
    { id: "service-box", orgId: "staged-org", localPart: "notify", address: "notify@example.com", isService: true, isActive: true },
  ]);
  await db.insert(schema.mailboxAccess).values({ id: "owner-grant", userId: "owner", mailboxId: "owner-box", canSend: true });
  setRequestEvent({ locals: { db, user: { id: "owner", role: "member" } }, platform: { env } });
});

describe("prepared mailbox sending", () => {
  it("rejects interactive and service senders before exposing queue/storage work", async () => {
    const sender = await resolveSender(db, "owner", "owner-box");
    await expect(assertDomainNotStaged(db, sender.orgId)).rejects.toMatchObject({ status: 409 });
    await expect(sendMessage({ mailboxId: "owner-box", to: ["outside@example.net"], cc: [], bcc: [], subject: "Prepared draft", text: "Keep me", attachments: [] })).rejects.toMatchObject({ status: 409 });
    const url = new URL("https://mail.example.com/api/send");
    await expect(apiSend({ url, request: new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mailboxId: "service-box", to: ["outside@example.net"] }) }), locals: { db }, platform: { env } } as never)).rejects.toMatchObject({ status: 409 });
    expect(raw.put).not.toHaveBeenCalled();
    expect(raw.get).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
    expect(await db.query.submission.findMany()).toHaveLength(0);
  });

  it("keeps draft creation and edits available, and leaves a rejected send exactly editable", async () => {
    const draft = await createDraft(db, ck, "owner", { mailboxId: "owner-box", kind: "new", to: ["outside@example.net"], subject: "Keep me", body: "Initial" });
    expect(await saveDraft(db, ck, "owner", { draftId: draft.id, clientRevision: draft.clientRevision, body: "Edited", fromAliasId: null })).toMatchObject({ ok: true });
    const before = await db.query.draft.findFirst({ where: eq(schema.draft.id, draft.id) });
    await expect(sendDraft(db, env, ck, "owner", { draftId: draft.id })).rejects.toMatchObject({ status: 409 });
    expect(await db.query.draft.findFirst({ where: eq(schema.draft.id, draft.id) })).toEqual(before);
    expect(before?.status).toBe("editing");
    expect(raw.put).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });

  it("checks sender grants before reading a foreign domain's staging status", async () => {
    const orgRead = vi.spyOn(db.query.organization, "findFirst");
    await expect(resolveSender(db, "unrelated", "owner-box")).rejects.toMatchObject({ status: 403 });
    setRequestEvent({ locals: { db, user: { id: "unrelated", role: "member" } }, platform: { env } });
    await expect(sendMessage({ mailboxId: "owner-box", to: ["outside@example.net"], cc: [], bcc: [], subject: "Foreign", text: "Keep me", attachments: [] })).rejects.toMatchObject({ status: 403 });
    expect(orgRead).not.toHaveBeenCalled();
  });

  it("continues sending from an active domain without changing its sender identity", async () => {
    await db.update(schema.organization).set({ status: "active" }).where(eq(schema.organization.id, "staged-org"));
    expect(await resolveSender(db, "owner", "owner-box")).toMatchObject({ orgId: "staged-org", fromAddress: "owner@example.com" });
    expect(await resolveServiceSender(db, "service-box")).toMatchObject({ fromAddress: "notify@example.com" });
    await expect(assertDomainNotStaged(db, "staged-org")).resolves.toBeUndefined();
  });

  it("rejects internal enqueue paths before creating mail, submissions or queue jobs", async () => {
    await expect(enqueueSend(db, env, { orgId: "staged-org", mailboxId: "owner-box", createdByUserId: "owner", fromAddress: "owner@example.com", to: ["outside@example.net"], subject: "Internal send", text: "Keep me", idempotencyKey: "staged-send" })).rejects.toMatchObject({ status: 409 });
    expect(await db.query.message.findMany()).toHaveLength(0);
    expect(await db.query.submission.findMany()).toHaveLength(0);
    expect(raw.put).not.toHaveBeenCalled();
    expect(raw.get).not.toHaveBeenCalled();
    expect(queue.send).not.toHaveBeenCalled();
  });
});
