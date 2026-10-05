// SPDX-License-Identifier: Apache-2.0
import { and, eq } from 'drizzle-orm';
import type { DrizzleD1Database } from 'drizzle-orm/d1';
import * as schema from '@doota/db/schema';
import { MAIL_DOMAIN, MAIL_IN_WORKER_NAME, MAIL_ROUTING_MODE } from '$app/env/private';
import { cf, pollZoneStatus, MailSetupError } from './cloudflare.js';
import { assertMailScope, assertRecipientScope } from './routing-policy.js';
import type { EmailRoutingRule } from 'cloudflare/resources/email-routing/rules/rules';

type Db = DrizzleD1Database<typeof schema>;
const prefix = 'cloudflare-mail-client:';

/** Exact recipient rules are required for subdomain delivery. Never replace an operator's rule. */
export async function setRecipientRouting(zoneId: string, domain: string, address: string, enabled: boolean) {
  assertRecipientScope(address, domain);
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(domain, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  if (!MAIL_IN_WORKER_NAME) throw new Error('Mail worker is missing. Run setup or doctor.');
  const api = cf().emailRouting.rules;
  const name = `${prefix}${address}`;
  const matches: Array<EmailRoutingRule & { source?: string }> = [];
  // The pinned SDK omits the list method. The REST endpoint is paginated.
  for (let page = 1; ; page++) {
    const response = await cf().get<{ result: EmailRoutingRule[]; result_info?: { total_pages?: number } }>(
      `/zones/${zoneId}/email/routing/rules`, { query: { page, per_page: 50 } });
    if (!Array.isArray(response.result)) throw new Error('Cloudflare returned an unsupported routing rule list.');
    for (const rule of response.result) {
      if (rule.matchers?.some(m => m.type === 'literal' && m.field === 'to' && m.value?.toLowerCase() === address)) matches.push(rule);
    }
    const totalPages = response.result_info?.total_pages;
    if (totalPages === undefined ? response.result.length < 50 : page >= totalPages) break;
  }
  if (matches.some(rule => rule.name !== name || rule.source === 'wrangler' ||
    rule.matchers?.length !== 1 || rule.actions?.length !== 1 ||
    rule.actions[0].type !== 'worker' || rule.actions[0].value?.length !== 1 ||
    rule.actions[0].value[0] !== MAIL_IN_WORKER_NAME)) {
    throw new MailSetupError(`An existing routing rule already owns ${address}. Review it in Cloudflare before retrying.`);
  }
  const body = { zone_id: zoneId, name, enabled,
    matchers: [{ type: 'literal' as const, field: 'to' as const, value: address }],
    actions: [{ type: 'worker' as const, value: [MAIL_IN_WORKER_NAME] }] };
  if (matches.length) {
    for (const rule of matches) {
      if (rule.enabled === enabled) continue;
      const id = rule.id ?? rule.tag;
      if (!id) throw new Error('Cloudflare returned a routing rule without an identifier.');
      await api.update(id, { ...body, ...(rule.priority === undefined ? {} : { priority: rule.priority }) });
    }
  } else if (enabled) await api.create(body);
}

export async function ensureMailboxRouting(db: Db, orgId: string, address: string) {
  const org = await db.query.organization.findFirst({ where: eq(schema.organization.id, orgId) });
  if (!org || org.status !== 'active') return; // Bootstrap is wired when the domain activates.
  if (!org.zoneId) throw new Error('Domain has no Cloudflare zone. Run doctor.');
  await setRecipientRouting(org.zoneId, org.domain, address, true);
}

export async function disableMailboxRouting(db: Db, orgId: string, address: string) {
  const org = await db.query.organization.findFirst({ where: eq(schema.organization.id, orgId) });
  if (org?.zoneId) await setRecipientRouting(org.zoneId, org.domain, address, false);
}

export async function syncDomainRecipients(db: Db, orgId: string, zoneId: string, domain: string) {
  const [boxes, aliases] = await Promise.all([
    db.query.mailbox.findMany({ where: and(eq(schema.mailbox.orgId, orgId), eq(schema.mailbox.isActive, true)) }),
    db.query.alias.findMany({ where: and(eq(schema.alias.orgId, orgId), eq(schema.alias.isEnabled, true)) })
  ]);
  for (const address of new Set([...boxes, ...aliases].map(row => row.address))) {
    await setRecipientRouting(zoneId, domain, address, true);
  }
}
