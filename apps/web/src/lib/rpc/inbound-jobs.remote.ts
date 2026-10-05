// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from '$app/server';
import { error } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import * as schema from '@doota/db/schema';
import { replayInboundReceipt } from '@doota/mail-core/inbound-receipts';

function operator() {
  const event = getRequestEvent();
  if (event.locals.user?.role !== 'superadmin') error(403, 'Instance administrator only');
  return event;
}

export const failedInboundJobs = query(async () => {
  const { locals } = operator();
  return locals.db.select({ id: schema.inboundReceipt.id, recipient: schema.inboundReceipt.recipient,
    attempts: schema.inboundReceipt.attempts, error: schema.inboundReceipt.lastError, updatedAt: schema.inboundReceipt.updatedAt })
    .from(schema.inboundReceipt).where(eq(schema.inboundReceipt.status, 'failed'))
    .orderBy(desc(schema.inboundReceipt.updatedAt)).limit(100);
});

export const retryInboundJob = command(z.string().min(1), async (id) => {
  const { locals, platform } = operator();
  if (!platform?.env.MAIL_QUEUE) error(503, 'Inbound queue is missing. Run doctor.');
  await replayInboundReceipt(locals.db, platform.env.MAIL_QUEUE, id);
  return { success: true };
});
