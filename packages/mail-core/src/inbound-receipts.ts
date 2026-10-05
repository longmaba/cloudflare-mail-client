// SPDX-License-Identifier: Apache-2.0
import { and, eq, inArray, lt, lte, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import * as mail from "@doota/db/mail.schema";
import type { InboundJob, MailEnv } from "./inbound-worker";

type Db = DrizzleD1Database<typeof schema>;
const LEASE_MS = 15 * 60 * 1000;
export const MAX_INBOUND_ATTEMPTS = 10;

export async function contentHash(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function ensureInboundReceipt(db: Db, job: InboundJob): Promise<string> {
  const recipient = job.recipient.trim().toLowerCase();
  const id = await contentHash(new TextEncoder().encode(JSON.stringify([job.orgId, job.r2RawKey, recipient])));
  job.receiptId = id;
  const now = new Date();
  await db.insert(mail.inboundReceipt).values({
    id, orgId: job.orgId, mailboxId: job.resolvedMailboxId, recipient,
    r2RawKey: job.r2RawKey, jobJson: JSON.stringify(job), nextAttemptAt: now,
    createdAt: now, updatedAt: now,
  }).onConflictDoNothing();
  return id;
}

export async function markInboundQueued(db: Db, id: string): Promise<void> {
  const now = Date.now();
  // A fast consumer may already have completed before Queue.send resolves.
  await db.update(mail.inboundReceipt).set({
    status: "queued", updatedAt: new Date(now), nextAttemptAt: new Date(now + LEASE_MS),
  }).where(and(eq(mail.inboundReceipt.id, id), inArray(mail.inboundReceipt.status, ["stored", "failed", "queued"])));
}

export async function beginInboundReceipt(db: Db, id: string): Promise<"process" | "complete" | "busy" | "exhausted"> {
  const row = await db.query.inboundReceipt.findFirst({ where: eq(schema.inboundReceipt.id, id) });
  if (!row) throw new Error("Inbound receipt is missing; raw mail has been preserved.");
  if (row.status === "complete") return "complete";
  if (row.attempts >= MAX_INBOUND_ATTEMPTS) return "exhausted";
  const now = Date.now();
  if (row.status === "processing" && row.updatedAt.getTime() > now - LEASE_MS) return "busy";
  const claimed = await db.update(mail.inboundReceipt).set({
    status: "processing", attempts: sql`${mail.inboundReceipt.attempts} + 1`,
    updatedAt: new Date(now), nextAttemptAt: new Date(now + LEASE_MS),
  }).where(and(eq(mail.inboundReceipt.id, id), eq(mail.inboundReceipt.status, row.status), eq(mail.inboundReceipt.updatedAt, row.updatedAt)))
    .returning({ id: mail.inboundReceipt.id });
  return claimed.length ? "process" : "busy";
}

export async function completeInboundReceipt(db: Db, id: string): Promise<void> {
  await db.update(mail.inboundReceipt).set({ status: "complete", lastError: null, updatedAt: new Date() })
    .where(eq(mail.inboundReceipt.id, id));
}

export async function failInboundReceipt(db: Db, id: string, error: unknown): Promise<void> {
  const now = Date.now();
  await db.update(mail.inboundReceipt).set({
    status: "failed", lastError: (error instanceof Error ? error.message : String(error)).slice(0, 1000),
    updatedAt: new Date(now), nextAttemptAt: new Date(now + 5 * 60 * 1000),
  }).where(and(eq(mail.inboundReceipt.id, id), sql`${mail.inboundReceipt.status} != 'complete'`));
}

/** Explicit operator replay. Exhausted jobs remain failed until requested. */
export async function replayInboundReceipt(db: Db, queue: MailEnv["MAIL_QUEUE"], id: string): Promise<void> {
  const row = await db.query.inboundReceipt.findFirst({ where: eq(schema.inboundReceipt.id, id) });
  if (!row || row.status === "complete") return;
  if (row.status === "processing" && row.updatedAt.getTime() > Date.now() - LEASE_MS) throw new Error("Mail is still processing.");
  await db.update(mail.inboundReceipt).set({ status: "stored", attempts: 0, lastError: null, updatedAt: new Date(), nextAttemptAt: new Date() })
    .where(eq(mail.inboundReceipt.id, id));
  try {
    await queue.send(JSON.parse(row.jobJson) as InboundJob);
    await markInboundQueued(db, id);
  } catch (error) {
    await failInboundReceipt(db, id, error);
    throw error;
  }
}

/** Recover lost enqueue/crashed processing without removing raw objects or the DLQ. */
export async function sweepDueInboundReceipts(db: Db, queue: MailEnv["MAIL_QUEUE"]): Promise<number> {
  const now = new Date();
  const rows = await db.query.inboundReceipt.findMany({
    where: and(inArray(schema.inboundReceipt.status, ["stored", "queued", "processing", "failed"]),
      lte(schema.inboundReceipt.nextAttemptAt, now), lt(schema.inboundReceipt.attempts, MAX_INBOUND_ATTEMPTS)), limit: 50,
  });
  let enqueued = 0;
  for (const row of rows) {
    const claimed = await db.update(mail.inboundReceipt).set({
      status: "queued", updatedAt: now, nextAttemptAt: new Date(now.getTime() + LEASE_MS),
    }).where(and(eq(mail.inboundReceipt.id, row.id), eq(mail.inboundReceipt.updatedAt, row.updatedAt), eq(mail.inboundReceipt.status, row.status)))
      .returning({ id: mail.inboundReceipt.id });
    if (!claimed.length) continue;
    try {
      await queue.send(JSON.parse(row.jobJson) as InboundJob);
      enqueued++;
    } catch (error) {
      await failInboundReceipt(db, row.id, error);
    }
  }
  return enqueued;
}
