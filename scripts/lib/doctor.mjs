// SPDX-License-Identifier: Apache-2.0
import { cloudflare, dnsSnapshot, externalMx, listAll, workerSettings, assertRemoteIdentity } from './cloudflare.mjs';

const targetsInboundWorker = (rule, worker) => rule.actions?.length === 1 && rule.actions[0].type === 'worker' && rule.actions[0].value?.length === 1 && rule.actions[0].value[0] === worker;

async function inspectRecipientRouting(config, api) {
  const rules = await listAll(api, `/zones/${config.zoneId}/email/routing/rules`);
  const recipients = new Set();
  let active = 0;
  for (const rule of rules) {
    const selected = rule.matchers?.filter((matcher) => matcher.type === 'literal' && matcher.field === 'to' && typeof matcher.value === 'string' && matcher.value.toLowerCase().endsWith(`@${config.mailDomain}`)) ?? [];
    if (!selected.length || !rule.enabled) continue;
    if (selected.length !== 1 || rule.matchers.length !== 1 || !targetsInboundWorker(rule, config.resourceNames.inbound)) {
      throw new Error(`An enabled literal rule for @${config.mailDomain} has conflicting matchers or a different destination. Review the selected-domain rule in Cloudflare; each recipient must route only to ${config.resourceNames.inbound}. Doctor did not change it.`);
    }
    const address = selected[0].value.toLowerCase();
    if (recipients.has(address)) throw new Error(`Multiple enabled rules match ${address}. Review and remove the duplicate/conflicting rule in Cloudflare before testing delivery; doctor did not change it.`);
    recipients.add(address);
    active++;
  }
  if (config.routingMode === 'manual') {
    if (!active) throw new Error(`No enabled literal recipient rules exist for @${config.mailDomain}. Complete pilot onboarding and provision a mailbox/alias targeting ${config.resourceNames.inbound}. Subdomains cannot use an apex catch-all; keep apex routing at its current provider.`);
    return { status: 'pass', detail: `${active} enabled literal recipient rule(s) route only to ${config.resourceNames.inbound}. Apex routing settings are not used as pilot readiness proof; compare these recipients with provisioned mailboxes/aliases.` };
  }
  const settings = (await api(`/zones/${config.zoneId}/email/routing`)).result;
  if (!settings?.enabled || settings.status !== 'ready') throw new Error(`Apex Email Routing is not enabled and ready for ${config.mailDomain}. Complete the deliberate apex onboarding after migration checks; doctor did not enable routing or change MX.`);
  let catchAll;
  try { catchAll = (await api(`/zones/${config.zoneId}/email/routing/rules/catch_all`)).result; } catch (error) { if (error.status !== 404) throw error; }
  if (!catchAll?.enabled || catchAll.matchers?.length !== 1 || catchAll.matchers[0].type !== 'all' || !targetsInboundWorker(catchAll, config.resourceNames.inbound)) {
    throw new Error(`Apex catch-all is missing, disabled or targets another destination. Review it in Cloudflare and deliberately attach it only to ${config.resourceNames.inbound}; doctor did not replace the existing rule.`);
  }
  return { status: 'pass', detail: `Apex routing ready; enabled catch-all and ${active} enabled literal recipient rule(s) target only ${config.resourceNames.inbound}.` };
}

async function inspectSendingDomain(config, api) {
  let domains;
  try { domains = await listAll(api, `/zones/${config.zoneId}/email/sending/subdomains`); } catch (error) {
    throw new Error(`Could not inspect native Email Sending for ${config.mailDomain}${error.status ? ` (HTTP ${error.status})` : ''}. Check Email Sending Read/Edit permissions for the selected zone and Workers Paid entitlement, then rerun doctor. No send or configuration change was attempted.`);
  }
  const exact = domains.find((domain) => domain.name?.toLowerCase() === config.mailDomain);
  if (!exact) throw new Error(`Native Email Sending is not configured for exact domain ${config.mailDomain}. Onboard this domain in Email Service > Email Sending; an enabled apex, sibling or wildcard entry is not this instance's scoped sending identity.`);
  if (exact.enabled !== true) throw new Error(`Native Email Sending is disabled for ${config.mailDomain}. Re-enable this exact domain through deliberate Email Sending onboarding, then rerun doctor.`);
  return { status: 'pass', detail: `Cloudflare reports exact domain ${config.mailDomain} sending-enabled. This API does not report separate DNS-verification/delivery state; DNS records and a real reply/header check are still required.` };
}

export async function inspectInstance(config, secrets, token, { api = cloudflare(token), fetcher = fetch } = {}) {
  const checks = [];
  const check = async (name, action) => {
    try { const result = await action(); checks.push({ name, ...result }); } catch (error) { checks.push({ name, status: 'fail', detail: error.message }); }
  };
  await check('Selected account and zone', async () => {
    const zone = (await api(`/zones/${config.zoneId}`)).result;
    if (zone.account.id !== config.accountId || zone.name !== config.zoneName) throw new Error('Zone/account differs from the saved instance. Restore its original account/zone.');
    return { status: zone.status === 'active' ? 'pass' : 'fail', detail: zone.status === 'active' ? `${zone.name} is active` : 'Activate the zone in Cloudflare before deployment.' };
  });
  await check('Runtime token scope', async () => {
    if (!secrets.runtimeToken) throw new Error('Missing runtime token. Supply a separate token scoped to this zone for DNS Edit, Zone Settings Edit, Email Routing Rules Edit and Email Sending Edit. See docs/TOKENS.md.');
    const runtimeApi = cloudflare(secrets.runtimeToken, fetcher);
    await runtimeApi(`/zones/${config.zoneId}`);
    await runtimeApi(`/zones/${config.zoneId}/dns_records?per_page=1`);
    await runtimeApi(`/zones/${config.zoneId}/email/routing`);
    return { status: 'pass', detail: 'Zone, DNS and routing reads allowed. Write permissions are exercised only by deliberate onboarding.' };
  });
  await check('Email Sending entitlement', async () => {
    const subscriptions = (await api(`/accounts/${config.accountId}/subscriptions`)).result;
    const paid = Array.isArray(subscriptions) && subscriptions.some((item) => /workers.*(?:paid|standard|bundled|unbound)|(?:paid|standard|bundled|unbound).*workers/i.test(JSON.stringify(item.rate_plan ?? item.plan ?? item.product ?? {})));
    return paid ? { status: 'pass', detail: 'Workers paid subscription reported; sending-domain readiness is checked separately.' } : { status: 'warn', detail: 'Workers Paid entitlement was not confirmed by the account API. Enable/check Workers Paid ($5 base) and Email Sending in the dashboard; receiving alone does not enable unrestricted outbound email.' };
  });
  for (const [role, expectedBindings] of Object.entries({ web: ['DB', 'AUTH_KV', 'MAIL_RAW', 'MAIL_QUEUE', 'MAIL_OUT_QUEUE', 'MAIL_EVENTS', 'EMAIL_SENDER', 'APP_CLOUDFLARE_API_TOKEN'], inbound: ['DB', 'MAIL_RAW', 'MAIL_QUEUE'], jobs: ['DB', 'MAIL_RAW', 'MAIL_QUEUE', 'MAIL_OUT_QUEUE', 'MAIL_EVENTS', 'EMAIL_SENDER'] })) {
    await check(`${role} Worker bindings`, async () => {
      const settings = await workerSettings(api, config.accountId, config.resourceNames[role]);
      if (!settings) throw new Error('Worker not deployed. Run pnpm run setup to resume deployment.');
      assertRemoteIdentity(config, settings);
      const missing = expectedBindings.filter((name) => !settings.bindings.some((binding) => binding.name === name));
      if (missing.length) throw new Error(`Missing bindings: ${missing.join(', ')}. Rerun setup for this saved instance.`);
      return { status: 'pass', detail: 'Identity, key fingerprint and required bindings match.' };
    });
  }
  await check('Persistent mail storage', async () => {
    const settings = await workerSettings(api, config.accountId, config.resourceNames.web);
    const databaseId = settings?.bindings.find((binding) => binding.name === 'DB')?.id;
    if (!databaseId) throw new Error('No live D1 binding. Resume setup before checking storage.');
    const database = (await api(`/accounts/${config.accountId}/d1/database/${databaseId}`)).result;
    if (database.name !== config.resourceNames.database) throw new Error('Database binding points at another instance. Deployment blocked.');
    await api(`/accounts/${config.accountId}/r2/buckets/${config.resourceNames.rawBucket}`);
    return { status: 'pass', detail: 'Bound D1 and raw R2 bucket exist. This read-only check does not prove backups or decryption.' };
  });
  await check('Inbound queue and durable recovery', async () => {
    const queues = await listAll(api, `/accounts/${config.accountId}/queues`);
    const queue = queues.find((item) => item.queue_name === config.resourceNames.inboundQueue);
    const dlq = queues.find((item) => item.queue_name === config.resourceNames.inboundDlq);
    if (!queue || !dlq) throw new Error('Inbound queue or DLQ missing. Resume setup for this saved instance.');
    const consumers = (await api(`/accounts/${config.accountId}/queues/${queue.queue_id}/consumers`)).result;
    if (!consumers.some((item) => item.script_name === config.resourceNames.inbound && item.dead_letter_queue === config.resourceNames.inboundDlq)) throw new Error('Inbound consumer/DLQ wiring differs. Redeploy the saved stack.');
    return { status: 'pass', detail: 'Inbound consumer and DLQ configured; jobs Worker has replay binding. Fault/replay acceptance still requires the live pilot.' };
  });
  await check('Recipient Email Routing', () => inspectRecipientRouting(config, api));
  await check('Native sending domain', () => inspectSendingDomain(config, api));
  if (config.routingMode === 'manual') {
    await check('Pilot apex MX preservation', async () => {
      const records = await dnsSnapshot(api, config.zoneId);
      const before = JSON.stringify(config.apexMx.map(({ content, priority }) => ({ content, priority })).sort((a, b) => a.content.localeCompare(b.content)));
      const after = JSON.stringify(records.filter((record) => record.type === 'MX' && record.name === config.zoneName).map(({ content, priority }) => ({ content, priority })).sort((a, b) => a.content.localeCompare(b.content)));
      if (before !== after) throw new Error('Apex MX changed during pilot. Restore the saved provider records before continuing.');
      return { status: 'pass', detail: 'Apex MX still matches the saved provider, independently of pilot readiness.' };
    });
  }
  await check('Inbound and sending DNS', async () => {
    const records = await dnsSnapshot(api, config.zoneId);
    const mailMx = records.filter((record) => record.type === 'MX' && record.name === config.mailDomain);
    const spf = records.filter((record) => record.type === 'TXT' && record.name === config.mailDomain && record.content.startsWith('v=spf1'));
    if (externalMx(records, config.mailDomain).length || !mailMx.length) throw new Error(`Inbound ${config.mailDomain} is not routed exclusively to Cloudflare. Complete the scoped Email Routing onboarding; keep ${config.zoneName} at its old provider during pilot.`);
    if (spf.length !== 1) throw new Error('Mail domain must have exactly one SPF record. Merge authorizations rather than adding a second SPF record.');
    const sendingNames = [`cf-bounce.${config.mailDomain}`, `cf-bounce._domainkey.${config.mailDomain}`, `_dmarc.${config.mailDomain}`];
    const absent = sendingNames.filter((name) => !records.some((record) => record.name === name));
    if (absent.length) throw new Error(`Email Sending records missing: ${absent.join(', ')}. Onboard the sending domain in Email Service.`);
    return { status: 'pass', detail: 'Inbound MX, one SPF, sending records present; real message/header checks still required.' };
  });
  await check('App HTTPS', async () => {
    const response = await fetcher(`${config.appOrigin}/login`, { signal: AbortSignal.timeout(20_000), redirect: 'manual' });
    if (response.status < 200 || response.status >= 400) throw new Error(`HTTP ${response.status}. Check custom domain, certificates and Worker logs.`);
    return { status: 'pass', detail: 'Login endpoint reachable. Authentication and real send/receive are separate tests.' };
  });
  checks.push({ name: 'Live mail verification', status: 'manual', detail: `Send from controlled Gmail/Outlook to a provisioned @${config.mailDomain} inbox, reply with an attachment, inspect SPF/DKIM/DMARC headers, then check queues and delivery logs. Doctor sends no messages and cannot prove delivery.` });
  return checks;
}
