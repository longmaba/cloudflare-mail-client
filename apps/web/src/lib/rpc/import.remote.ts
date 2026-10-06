// SPDX-License-Identifier: Apache-2.0
import { query, command, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { startImport, finishUpload, cancelImport, restartImport, type MailboxImportJob } from "@doota/mail-core/import";
import { importKey } from "@doota/mail-core/crypto";

/**
 * Mailbox import rpc — export's mirror.
 *
 * The chunk bytes do NOT come through here; they go to /api/import, because a
 * remote function is the wrong shape for a multi-gigabyte body. This surface
 * only opens the import, closes it, reports on it, and cancels it.
 *
 * Mutation gates use a fresh mailbox manager grant: importing an archive is
 * a bulk mailbox write, including historical sender identities and labels.
 */

async function grantOn(mailboxId: string, requireActive = false) {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  const box = await locals.db.query.mailbox.findFirst({
    where: eq(schema.mailbox.id, mailboxId),
    columns: { id: true, orgId: true, isActive: true },
  });
  if (!box) error(404, "Mailbox not found");
  const grant = await locals.db.query.mailboxAccess.findFirst({
    where: and(
      eq(schema.mailboxAccess.mailboxId, mailboxId),
      eq(schema.mailboxAccess.userId, locals.user.id),
      eq(schema.mailboxAccess.canManage, true),
    ),
    columns: { id: true },
  });
  if (!grant) error(403, "You need permission to manage this mailbox to import mail.");
  if (requireActive && !box.isActive) error(409, "Activate this mailbox before importing mail.");
  return { box, user: locals.user, db: locals.db };
}

/** Live imports block a second one: two interleaving jobs into one mailbox is
 * a support ticket nobody can untangle afterwards. */
const LIVE = ["uploading", "queued", "running"] as const;

/** Import controls belong only to active mailboxes the caller manages. */
export const importableMailboxes = query(async () => {
  const { locals } = getRequestEvent();
  if (!locals.user) error(401, "Not authenticated");
  return locals.db
    .select({ id: schema.mailbox.id, address: schema.mailbox.address })
    .from(schema.mailbox)
    .innerJoin(schema.mailboxAccess, eq(schema.mailboxAccess.mailboxId, schema.mailbox.id))
    .where(and(
      eq(schema.mailboxAccess.userId, locals.user.id),
      eq(schema.mailboxAccess.canManage, true),
      eq(schema.mailbox.isActive, true),
    ))
    .orderBy(asc(schema.mailbox.createdAt));
});

export const beginImport = command(
  z.object({
    mailboxId: z.string().min(1),
    filename: z.string().trim().min(1).max(200).refine((name) => /\.(?:mbox|eml)$/i.test(name), "Choose an extracted .mbox archive or .eml message."),
    sizeBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  async ({ mailboxId, filename, sizeBytes }) => {
    const { box, user, db } = await grantOn(mailboxId, true);
    // Remote function validation normally handles these; keep the boundary
    // explicit for non-browser callers and tests invoking the handler directly.
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes <= 0) error(400, "The archive must be a non-empty file.");
    if (!/\.(?:mbox|eml)$/i.test(filename)) error(400, "Choose an extracted .mbox archive or .eml message.");
    const live = await db.query.mailImport.findFirst({
      where: and(
        eq(schema.mailImport.mailboxId, mailboxId),
        inArray(schema.mailImport.status, LIVE as unknown as string[]),
      ),
      columns: { id: true },
    });
    if (live) error(409, "An import is already running for this mailbox.");
    try {
      const importId = await startImport(db, {
        orgId: box.orgId,
        mailboxId,
        requestedByUserId: user.id,
        filename,
        sizeBytes,
        sourceFormat: /\.eml$/i.test(filename) ? "eml" : "mbox",
      });
      return { importId };
    } catch (cause) {
      if (cause instanceof Error && cause.message === "An import is already running for this mailbox.") error(409, cause.message);
      error(503, "The import could not be started. Try again shortly.");
    }
  },
);

export const completeImport = command(
  z.object({ mailboxId: z.string().min(1), importId: z.string().min(1) }),
  async ({ mailboxId, importId }) => {
    const { db } = await grantOn(mailboxId, true);
    const row = await db.query.mailImport.findFirst({
      where: and(eq(schema.mailImport.id, importId), eq(schema.mailImport.mailboxId, mailboxId)),
      columns: { id: true, partCount: true },
    });
    if (!row) error(404, "Import not found.");
    if (row.partCount === 0) error(400, "No chunks were uploaded.");
    const env = getRequestEvent().platform?.env;
    const queue = env?.MAIL_QUEUE as Queue<MailboxImportJob> | undefined;
    if (!queue) error(500, "Mail queue is not configured.");
    if (!env?.MAIL_RAW || !env?.MAIL_DEK) error(500, "Mail storage is not configured.");
    try {
      await finishUpload(db, queue, importId, { env: { MAIL_RAW: env.MAIL_RAW }, ck: await importKey(env.MAIL_DEK) });
    } catch (cause) {
      // Keep private provider errors out of browser responses.
      const detail = cause instanceof Error ? cause.message : "";
      if (detail === "The archive upload is incomplete. Resume using the same file.") error(409, detail);
      error(503, "The import could not be queued. Retry using the same archive.");
    }
    return { started: true as const };
  },
);

/** Retry a failed retained archive from its last durable message checkpoint. */
export const retryImport = command(
  z.object({ mailboxId: z.string().min(1), importId: z.string().min(1) }),
  async ({ mailboxId, importId }) => {
    const { db } = await grantOn(mailboxId, true);
    const row = await db.query.mailImport.findFirst({
      where: and(eq(schema.mailImport.id, importId), eq(schema.mailImport.mailboxId, mailboxId)),
      columns: { id: true, status: true },
    });
    if (!row) error(404, "Import not found.");
    if (row.status !== "failed") error(409, "Only failed imports can be retried.");
    const queue = getRequestEvent().platform?.env?.MAIL_QUEUE as Queue<MailboxImportJob> | undefined;
    if (!queue) error(500, "Mail queue is not configured.");
    try {
      await restartImport(db, queue, importId);
    } catch (cause) {
      if (cause instanceof Error && cause.message === "An import is already running for this mailbox.") error(409, cause.message);
      error(503, "The import could not be retried. Try again shortly.");
    }
    return { started: true as const };
  },
);

export const abortImport = command(
  z.object({ mailboxId: z.string().min(1), importId: z.string().min(1) }),
  async ({ mailboxId, importId }) => {
    const { db } = await grantOn(mailboxId);
    const row = await db.query.mailImport.findFirst({
      where: and(eq(schema.mailImport.id, importId), eq(schema.mailImport.mailboxId, mailboxId)),
      columns: { id: true },
    });
    if (!row) error(404, "Import not found.");
    await cancelImport(db, importId);
    return { canceled: true as const };
  },
);

/** Recent imports for a mailbox, newest first — the progress readout. */
export const importStatus = query(z.object({ mailboxId: z.string().min(1) }), async ({ mailboxId }) => {
  const { db } = await grantOn(mailboxId);
  const rows = await db.query.mailImport.findMany({
    where: eq(schema.mailImport.mailboxId, mailboxId),
    orderBy: [desc(schema.mailImport.createdAt)],
    limit: 5,
    columns: {
      id: true,
      status: true,
      filename: true,
      sizeBytes: true,
      partCount: true,
      cursor: true,
      messageCount: true,
      skippedCount: true,
      failedCount: true,
      labelId: true,
      error: true,
      createdAt: true,
      completedAt: true,
    },
  });
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt?.getTime() ?? 0,
    completedAt: row.completedAt?.getTime() ?? null,
    // Byte-based, because the message total isn't knowable until the file has
    // been read. Honest fraction beats a fake ETA.
    percent: row.sizeBytes > 0 ? Math.min(100, Math.round((row.cursor / row.sizeBytes) * 100)) : 0,
  }));
});
