// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { makeDb } from "./mail-db";
import { setRequestEvent } from "./stubs/app-server";
import { PART_PLAINTEXT_BYTES, startImport } from "@doota/mail-core/import";
import { importKey, getDecryptedBlob } from "@doota/mail-core/crypto";
import { uploadMbox, UploadAborted } from "$lib/client/import-upload";

vi.mock("$app/server", async (original) => ({
  ...await original<object>(),
  command: (_schema: unknown, fn: unknown) => fn,
  query: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn,
}));
import { beginImport, completeImport, abortImport, retryImport, importStatus, importableMailboxes } from "$lib/rpc/import.remote";
import { POST } from "../routes/api/import/+server";

const KEY = btoa("0123456789abcdef0123456789abcdef");
let db: Awaited<ReturnType<typeof makeDb>>;
let r2: ReturnType<typeof bucket>;
let queue: { send: ReturnType<typeof vi.fn> };
let activeUser: string;
function bucket() {
  const store = new Map<string, Uint8Array>();
  return {
    store,
    put: vi.fn(async (key: string, value: ArrayBuffer | Uint8Array) => { store.set(key, new Uint8Array(value)); }),
    get: vi.fn(async (key: string) => {
      const value = store.get(key);
      return value ? { arrayBuffer: async () => value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) } : null;
    }),
    delete: vi.fn(async (key: string) => { store.delete(key); }),
  };
}
const env = () => ({ MAIL_RAW: r2 as never, MAIL_DEK: KEY, MAIL_QUEUE: queue as never });
function signIn(userId: string) {
  activeUser = userId;
  // Deliberately cached read access: mutations must still fetch canManage.
  setRequestEvent({ locals: { db, user: { id: userId }, authz: Promise.resolve({ mailboxIds: ["box", "other-box"], orgAdminOf: [] }) }, platform: { env: env() } });
}
async function start(sizeBytes: number, filename = "archive.mbox") {
  return startImport(db, { orgId: "org", mailboxId: "box", requestedByUserId: "owner", filename, sizeBytes });
}
async function upload(importId: string, index: string | null, bytes: Uint8Array, headers?: HeadersInit) {
  const url = new URL(`https://mail.example.com/api/import?importId=${importId}`);
  if (index !== null) url.searchParams.set("index", index);
  const request = new Request(url, { method: "POST", body: new Blob([bytes as BlobPart]), headers });
  return POST({ request, url, locals: { db, user: { id: activeUser } }, platform: { env: env() } } as never);
}

beforeEach(async () => {
  vi.unstubAllGlobals();
  db = await makeDb(); r2 = bucket(); queue = { send: vi.fn() };
  await db.insert(schema.organization).values({ id: "org", name: "Example", slug: "example", domain: "example.com", status: "active", createdAt: new Date() });
  await db.insert(schema.user).values([
    { id: "owner", name: "Owner", email: "owner@example.com", updatedAt: new Date() },
    { id: "reader", name: "Reader", email: "reader@example.com", updatedAt: new Date() },
  ]);
  await db.insert(schema.mailbox).values([
    { id: "box", orgId: "org", address: "owner@example.com", localPart: "owner", isActive: true },
    { id: "other-box", orgId: "org", address: "other@example.com", localPart: "other", isActive: true },
  ]);
  await db.insert(schema.mailboxAccess).values([
    { id: "manager", userId: "owner", mailboxId: "box", canManage: true },
    { id: "readonly", userId: "reader", mailboxId: "box", canManage: false },
  ]);
  signIn("owner");
});

describe("mail import upload authorization", () => {
  it("rejects anonymous uploads before consuming or storing the request body", async () => {
    const importId = await start(4);
    const url = new URL(`https://mail.example.com/api/import?importId=${importId}&index=0`);
    const request = new Request(url, { method: "POST", body: "MAIL" });
    await expect(POST({ request, url, locals: { db }, platform: { env: env() } } as never)).rejects.toMatchObject({ status: 401 });
    expect(request.bodyUsed).toBe(false); expect(r2.put).not.toHaveBeenCalled();
  });

  it("creates an .eml import with its explicit parser format and lists only managed boxes", async () => {
    const { importId } = await beginImport({ mailboxId: "box", filename: "message.eml", sizeBytes: 100 });
    const row = await db.query.mailImport.findFirst({ where: eq(schema.mailImport.id, importId) });
    expect(row.sourceFormat).toBe("eml");
    expect(await importableMailboxes()).toEqual([{ id: "box", address: "owner@example.com" }]);
  });

  it("serializes simultaneous starts without creating overlapping live imports", async () => {
    const input = { mailboxId: "box", filename: "archive.mbox", sizeBytes: 4 };
    const results = await Promise.allSettled([beginImport(input), beginImport(input)]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409 } });
    expect(await db.query.mailImport.findMany()).toHaveLength(1);
  });

  it("rejects all mutations from a read-only member despite a cached access snapshot", async () => {
    const importId = await start(4);
    signIn("reader");
    await expect(beginImport({ mailboxId: "box", filename: "archive.mbox", sizeBytes: 4 })).rejects.toMatchObject({ status: 403 });
    for (const action of [completeImport, abortImport, retryImport]) {
      await expect(action({ mailboxId: "box", importId })).rejects.toMatchObject({ status: 403 });
    }
    await expect(upload(importId, "0", new Uint8Array(4))).rejects.toMatchObject({ status: 403 });
    await expect(importStatus({ mailboxId: "box" })).rejects.toMatchObject({ status: 403 });
    expect(r2.put).not.toHaveBeenCalled(); expect(queue.send).not.toHaveBeenCalled();
    const row = await db.query.mailImport.findFirst({ where: eq(schema.mailImport.id, importId) });
    expect(row.status).toBe("uploading");
    expect(await importableMailboxes()).toEqual([]);
  });

  it("rejects a revoked manage grant before a bulk write", async () => {
    await db.update(schema.mailboxAccess).set({ canManage: false }).where(eq(schema.mailboxAccess.id, "manager"));
    await expect(beginImport({ mailboxId: "box", filename: "archive.mbox", sizeBytes: 4 })).rejects.toMatchObject({ status: 403 });
    expect(await db.query.mailImport.findMany()).toHaveLength(0);
  });

  it("does not operate on an import through another mailbox's identifier", async () => {
    await db.insert(schema.mailboxAccess).values({ id: "other-manager", userId: "owner", mailboxId: "other-box", canManage: true });
    const importId = await start(4);
    for (const action of [completeImport, abortImport, retryImport]) {
      await expect(action({ mailboxId: "other-box", importId })).rejects.toMatchObject({ status: 404 });
    }
    expect(queue.send).not.toHaveBeenCalled();
  });
});

describe("declared archive and immutable chunks", () => {
  it.each([null, "-1", "0.5", "1e0", " ", "9007199254740992", "1"])("rejects invalid or outside chunk index %s", async (index) => {
    const importId = await start(4);
    await expect(upload(importId, index, new Uint8Array(4))).rejects.toMatchObject({ status: 400 });
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("checks the actual streamed length even without a Content-Length header", async () => {
    const importId = await start(4);
    await expect(upload(importId, "0", new Uint8Array(3))).rejects.toMatchObject({ status: 400 });
    await expect(upload(importId, "0", new Uint8Array(5))).rejects.toMatchObject({ status: 413 });
    await expect(upload(importId, "0", new Uint8Array(4), { "Content-Length": "1000000000" })).rejects.toMatchObject({ status: 400 });
    expect(r2.put).not.toHaveBeenCalled();
  });

  it("reports a cancellation racing the final chunk as a conflict without staging bytes", async () => {
    const importId = await start(4);
    const original = db.query.mailImport.findFirst.bind(db.query.mailImport);
    vi.spyOn(db.query.mailImport, "findFirst")
      .mockImplementationOnce(original)
      .mockImplementationOnce(async (query: unknown) => {
        await db.update(schema.mailImport).set({ status: "canceled" }).where(eq(schema.mailImport.id, importId));
        return original(query);
      });
    await expect(upload(importId, "0", new Uint8Array(4))).rejects.toMatchObject({ status: 409 });
    expect(r2.put).not.toHaveBeenCalled();
    expect(await db.query.mailImportPart.findMany()).toHaveLength(0);
  });

  it("accepts an identical retry and rejects another file without replacing encrypted storage", async () => {
    const original = new TextEncoder().encode("MAIL");
    const importId = await start(original.length);
    await upload(importId, "0", original);
    const [key, encrypted] = [...r2.store.entries()][0];
    await upload(importId, "0", original);
    await expect(upload(importId, "0", new TextEncoder().encode("EVIL"))).rejects.toMatchObject({ status: 409 });
    expect(r2.store.get(key)).toEqual(encrypted);
    expect(new Uint8Array((await getDecryptedBlob(r2 as never, key, await importKey(KEY)))!)).toEqual(original);
  });

  it("refuses to complete a gapped upload even if the highest index was stored", async () => {
    const importId = await start(PART_PLAINTEXT_BYTES + 4);
    await upload(importId, "1", new Uint8Array(4));
    await expect(completeImport({ mailboxId: "box", importId })).rejects.toMatchObject({ status: 409 });
    expect(queue.send).not.toHaveBeenCalled();
    const row = await db.query.mailImport.findFirst({ where: eq(schema.mailImport.id, importId) });
    expect(row.status).toBe("uploading");
  });

  it("rejects ZIP downloads and empty archives with actionable errors", async () => {
    await expect(beginImport({ mailboxId: "box", filename: "takeout.zip", sizeBytes: 100 })).rejects.toMatchObject({ status: 400 });
    await expect(beginImport({ mailboxId: "box", filename: "archive.mbox", sizeBytes: 0 })).rejects.toMatchObject({ status: 400 });
    expect(await db.query.mailImport.findMany()).toHaveLength(0);
  });

  it("keeps failed storage retries private and resumes the pending immutable part", async () => {
    const importId = await start(4);
    r2.put.mockRejectedValueOnce(new Error("PRIVATE_PROVIDER_TOKEN_AND_METADATA"));
    await expect(upload(importId, "0", new TextEncoder().encode("MAIL"))).rejects.toMatchObject({ status: 503, body: { message: "The archive chunk could not be stored. Retry the upload using the same file." } });
    const part = await db.query.mailImportPart.findFirst({ where: eq(schema.mailImportPart.importId, importId) });
    expect(part.status).toBe("pending");
    await upload(importId, "0", new TextEncoder().encode("MAIL"));
    const stored = await db.query.mailImportPart.findFirst({ where: eq(schema.mailImportPart.importId, importId) });
    expect(stored.status).toBe("stored");
  });

  it("retries a failed archive at its durable cursor without changing counts", async () => {
    const importId = await start(4);
    await upload(importId, "0", new TextEncoder().encode("MAIL"));
    await db.update(schema.mailImport).set({ status: "failed", cursor: 2, messageCount: 1, error: "Temporary storage failure." }).where(eq(schema.mailImport.id, importId));
    await retryImport({ mailboxId: "box", importId });
    const row = await db.query.mailImport.findFirst({ where: eq(schema.mailImport.id, importId) });
    expect(row).toMatchObject({ status: "queued", cursor: 2, messageCount: 1, error: null });
    expect(queue.send).toHaveBeenCalledExactlyOnceWith({ kind: "mailbox_import", importId });
  });
});

describe("browser chunk resume", () => {
  it("revalidates previously uploaded chunks rather than trusting fromPart", async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('{}', { headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal("fetch", fetcher);
    const file = new File([new Uint8Array(PART_PLAINTEXT_BYTES), new Uint8Array([1, 2, 3])], "archive.mbox");
    const progress = vi.fn();
    await uploadMbox(file, "resume-id", { fromPart: 1, onProgress: progress });
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/import?importId=resume-id&index=0", "/api/import?importId=resume-id&index=1",
    ]);
    expect(progress).toHaveBeenLastCalledWith({ uploadedBytes: file.size, totalBytes: file.size, partIndex: 2, partCount: 2 });
  });

  it("reports aborts during a fetch as a resumable stop", async () => {
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); }));
    await expect(uploadMbox(new File(["MAIL"], "archive.mbox"), "id", { signal: controller.signal })).rejects.toBeInstanceOf(UploadAborted);
  });

  it("displays controlled JSON errors and suppresses proxy diagnostic bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "Resume using the same file." }), { status: 409 })));
    await expect(uploadMbox(new File(["MAIL"], "archive.mbox"), "id")).rejects.toThrow("Resume using the same file.");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>PROVIDER_PRIVATE_DIAGNOSTIC</html>", { status: 503 })));
    await expect(uploadMbox(new File(["MAIL"], "archive.mbox"), "id")).rejects.toThrow("Chunk 1 failed (503)");
  });
});
