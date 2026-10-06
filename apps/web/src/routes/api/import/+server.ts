// SPDX-License-Identifier: Apache-2.0
// Import chunk upload. The browser slices the mbox into PART_PLAINTEXT_BYTES
// pieces and POSTs them here one at a time; each lands as its own encrypted R2
// object. A whole archive can be gigabytes, far past the Worker request
// ceiling, so it can only arrive in pieces — and because the pieces are a fixed
// *plaintext* size, the job's byte cursor stays a simple integer.
//
// Retried chunks must match the bytes already staged at that index. A resumed
// upload cannot replace the archive underneath its durable processing cursor.
import { error, json } from "@sveltejs/kit";
import { eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { importKey } from "@doota/mail-core/crypto";
import { putImportPart, PART_PLAINTEXT_BYTES } from "@doota/mail-core/import";
import type { RequestHandler } from "./$types";

/** Bound unknown-length requests as they arrive, before buffering a chunk. */
async function readChunk(request: Request, expected: number): Promise<ArrayBuffer> {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) !== expected)) {
    error(400, "This chunk does not match the declared archive size.");
  }
  if (!request.body) error(400, "Empty chunk.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > expected) error(413, "This chunk is larger than its declared part size.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  if (total !== expected) error(400, "This chunk does not match the declared archive size.");
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export const POST: RequestHandler = async ({ request, locals, platform, url }) => {
  const user = locals.user;
  if (!user) error(401, "Sign in first.");

  const importId = url.searchParams.get("importId");
  const indexParam = url.searchParams.get("index");
  const index = Number(indexParam);
  if (!importId || !indexParam || !/^\d+$/.test(indexParam) || !Number.isSafeInteger(index)) {
    error(400, "Bad chunk request.");
  }

  const row = await locals.db.query.mailImport.findFirst({
    where: eq(schema.mailImport.id, importId),
  });
  if (!row) error(404, "Import not found.");

  // The uploader must still be allowed to write to this mailbox — an import is
  // a bulk write, so it gets the same gate a single write would.
  const grants = await locals.db.query.mailboxAccess.findMany({
    where: eq(schema.mailboxAccess.mailboxId, row.mailboxId),
  });
  const allowed = grants.some((grant) => grant.userId === user.id && grant.canManage);
  if (!allowed) error(403, "You can't import into this mailbox.");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, row.mailboxId),
    columns: { orgId: true, isActive: true },
  });
  if (!box || box.orgId !== row.orgId) error(404, "Import mailbox not found.");
  if (!box.isActive) error(409, "Activate this mailbox before importing mail.");
  if (row.status !== "uploading") error(409, "This import is no longer accepting uploads.");
  if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes <= 0) error(409, "The stored archive size is invalid. Cancel this import and start again.");
  const partCount = Math.ceil(row.sizeBytes / PART_PLAINTEXT_BYTES);
  if (index >= partCount) error(400, "This chunk is outside the declared archive.");
  const expected = Math.min(PART_PLAINTEXT_BYTES, row.sizeBytes - index * PART_PLAINTEXT_BYTES);
  const bytes = await readChunk(request, expected);

  const env = platform?.env;
  if (!env?.MAIL_RAW || !env?.MAIL_DEK) error(500, "Storage is not configured.");

  try {
    await putImportPart(locals.db, { MAIL_RAW: env.MAIL_RAW }, await importKey(env.MAIL_DEK), importId, index, bytes);
  } catch (cause) {
    // Only controlled validation failures belong in a user-visible response.
    // Provider errors can include storage credentials or private metadata.
    const message = cause instanceof Error ? cause.message : "";
    if (message === "This chunk differs from the original archive. Resume using the same file.") error(409, message);
    if (message === "This import is no longer accepting chunks.") error(409, "This import is no longer accepting uploads.");
    error(503, "The archive chunk could not be stored. Retry the upload using the same file.");
  }
  return json({ ok: true, index });
};
