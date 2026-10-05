// SPDX-License-Identifier: Apache-2.0
import { and, eq, inArray, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { error } from "@sveltejs/kit";
import * as schema from "@doota/db/schema";
import { can } from "@doota/db/can";

type Db = DrizzleD1Database<typeof schema>;
export type MessageActor = { userId: string | null; /** API keys are confined to their bound mailbox. */ mailboxId?: string };

/** Content authorization uses current D1 grants, including thread assignment,
 * rather than cached lists or storage-key prefixes. Operators remain trusted. */
export async function canReadMessage(db: Db, actor: MessageActor, messageId: string, orgId: string): Promise<boolean> {
  const message = await db.query.message.findFirst({
    where: and(eq(schema.message.id, messageId), eq(schema.message.orgId, orgId)),
    columns: { threadId: true },
  });
  if (!message) return false;
  const deliveries = await db.query.delivery.findMany({
    where: and(eq(schema.delivery.messageId, messageId), eq(schema.delivery.orgId, orgId), actor.mailboxId ? eq(schema.delivery.mailboxId, actor.mailboxId) : undefined),
    columns: { mailboxId: true },
  });
  if (actor.mailboxId && !deliveries.length) return false;
  if (!actor.userId) return !!actor.mailboxId && deliveries.length > 0;

  const user = await db.query.user.findFirst({ where: eq(schema.user.id, actor.userId), columns: { role: true } });
  if (!user) return false;
  const memberships = await db.query.member.findMany({
    where: and(eq(schema.member.userId, actor.userId), eq(schema.member.organizationId, orgId), inArray(schema.member.role, ["owner", "admin"])),
    columns: { organizationId: true },
  });
  const operator = { id: actor.userId, role: user.role, orgAdminOf: memberships.map((m) => m.organizationId) };
  if (user.role === "superadmin" || memberships.length) {
    return can(operator, "read", { type: "message", ownerId: "", organizationId: orgId });
  }
  for (const delivery of deliveries) {
    const grant = await db.query.mailboxAccess.findFirst({
      where: and(eq(schema.mailboxAccess.userId, actor.userId), eq(schema.mailboxAccess.mailboxId, delivery.mailboxId)),
      columns: { assignedOnly: true, canManage: true },
    });
    if (!grant) continue;
    if (grant.assignedOnly && !grant.canManage) {
      const state = await db.query.threadState.findFirst({
        where: and(eq(schema.threadState.threadId, message.threadId), eq(schema.threadState.orgId, orgId), eq(schema.threadState.mailboxId, delivery.mailboxId)),
        columns: { assigneeUserId: true },
      });
      if (state?.assigneeUserId !== actor.userId) continue;
    }
    return can(operator, "read", { type: "message", ownerId: actor.userId, organizationId: orgId });
  }
  return false;
}

export async function assertMessageReadable(db: Db, actor: MessageActor, messageId: string, orgId: string): Promise<void> {
  if (!(await canReadMessage(db, actor, messageId, orgId))) error(403, "Message source is not available to this sender.");
}

/** Thread placement can survive message removal (for example, internal notes).
 * Authorize that placement without treating a bare thread id as a capability. */
export async function canReadThread(db: Db, actor: MessageActor, threadId: string, orgId: string): Promise<boolean> {
  const thread = await db.query.thread.findFirst({ where: and(eq(schema.thread.id, threadId), eq(schema.thread.orgId, orgId)), columns: { id: true } });
  if (!thread) return false;
  const states = await db.query.threadState.findMany({
    where: and(eq(schema.threadState.threadId, threadId), eq(schema.threadState.orgId, orgId), actor.mailboxId ? eq(schema.threadState.mailboxId, actor.mailboxId) : undefined),
    columns: { mailboxId: true, assigneeUserId: true },
  });
  if (actor.mailboxId && !states.length) return false;
  if (!actor.userId) return !!actor.mailboxId && states.length > 0;
  const user = await db.query.user.findFirst({ where: eq(schema.user.id, actor.userId), columns: { role: true } });
  if (!user) return false;
  const memberships = await db.query.member.findMany({
    where: and(eq(schema.member.userId, actor.userId), eq(schema.member.organizationId, orgId), inArray(schema.member.role, ["owner", "admin"])), columns: { organizationId: true },
  });
  const operator = { id: actor.userId, role: user.role, orgAdminOf: memberships.map((m) => m.organizationId) };
  if (user.role === "superadmin" || memberships.length) return can(operator, "read", { type: "thread", ownerId: "", organizationId: orgId });
  for (const state of states) {
    const grant = await db.query.mailboxAccess.findFirst({
      where: and(eq(schema.mailboxAccess.userId, actor.userId), eq(schema.mailboxAccess.mailboxId, state.mailboxId)), columns: { assignedOnly: true, canManage: true },
    });
    if (grant && (!grant.assignedOnly || grant.canManage || state.assigneeUserId === actor.userId)) {
      return can(operator, "read", { type: "thread", ownerId: actor.userId, organizationId: orgId });
    }
  }
  return false;
}

/** Message-ID headers are untrusted and not unique. Select an authorized row,
 * also resolving our provider's wire id, and never decrypt an arbitrary first
 * row sharing the header. Missing/denied ancestry is omitted from auto-quotes. */
export async function readableMessageReference(db: Db, actor: MessageActor, orgId: string, reference: string, required = true) {
  const rows = await db.select({ message: schema.message }).from(schema.message)
    .leftJoin(schema.submission, eq(schema.submission.messageId, schema.message.id))
    .where(and(eq(schema.message.orgId, orgId), or(eq(schema.message.messageIdHeader, reference), eq(schema.submission.providerMessageId, reference))));
  for (const { message } of rows) {
    if (await canReadMessage(db, actor, message.id, orgId)) return message;
  }
  if (required) error(403, "Message source is not available to this sender.");
  return null;
}
