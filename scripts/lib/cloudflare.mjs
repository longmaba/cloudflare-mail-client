// SPDX-License-Identifier: Apache-2.0
export class CloudflareError extends Error {
  constructor(path, status, codes) {
    const scope = path.includes('/d1/') ? 'D1 Read/Edit' : path.includes('/r2/') ? 'Workers R2 Storage Read/Edit' : path.includes('/queues') ? 'Queues Read/Edit' : path.includes('/workers/') ? 'Workers Scripts Read/Edit' : path.includes('/email/routing') ? 'Email Routing Read/Edit' : path.includes('/dns_records') ? 'DNS Read/Edit' : path.startsWith('/zones') ? 'Zone Read' : 'Account Settings Read';
    const action = path.includes('/r2/') && codes.includes(10042)
      ? 'R2 is not enabled for the selected account. Open the Cloudflare Dashboard > Storage & databases > R2 Object Storage, activate R2, then rerun setup.'
      : `Check ${scope} token permissions for the selected account/zone. If an existing OAuth login lacks these scopes, reauthenticate with Wrangler or use a scoped deploy token; never substitute the runtime token.`;
    super(`Cloudflare ${path}: HTTP ${status}${codes.length ? ` (codes ${codes.join(', ')})` : ''}. ${action}`);
    this.status = status;
  }
}

export function cloudflare(token, fetcher = fetch) {
  return async (path) => {
    const response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    let payload;
    try { payload = await response.json(); } catch { throw new CloudflareError(path, response.status, []); }
    if (!response.ok || !payload.success) throw new CloudflareError(path, response.status, (payload.errors ?? []).map((error) => error.code));
    return payload;
  };
}

export async function listAll(api, path) {
  const items = [];
  for (let page = 1; page <= 100; page++) {
    const payload = await api(`${path}${path.includes('?') ? '&' : '?'}page=${page}&per_page=50`);
    if (!Array.isArray(payload.result)) throw new Error('Unexpected Cloudflare list response.');
    items.push(...payload.result);
    if (page >= (payload.result_info?.total_pages ?? 1)) return items;
  }
  throw new Error('Cloudflare returned too many pages. Narrow the token/account scope.');
}

export async function selectAccountAndZone(api, choose) {
  const accounts = await listAll(api, '/accounts');
  const account = await choose('Cloudflare account', accounts.map((item) => ({ label: `${item.name} (${item.id})`, value: item })));
  const zones = await listAll(api, `/zones?account.id=${encodeURIComponent(account.id)}&status=active`);
  const zone = await choose('Active Cloudflare DNS zone', zones.map((item) => ({ label: `${item.name} (${item.id})`, value: item })));
  return { account, zone };
}

export async function dnsSnapshot(api, zoneId) { return listAll(api, `/zones/${zoneId}/dns_records`); }

export function externalMx(records, domain) {
  return records.filter((record) => record.type === 'MX' && record.name.toLowerCase() === domain.toLowerCase() && !/\.mx\.cloudflare\.net\.?$/i.test(record.content));
}

export function dnsPreview(config, records) {
  const domain = config.mailDomain;
  const relevant = records.filter((record) => [config.zoneName, domain, `cf-bounce.${domain}`, `_dmarc.${domain}`, `cf-bounce._domainkey.${domain}`, `cf2024-1._domainkey.${domain}`].includes(record.name));
  return { current: relevant.map(({ type, name, content, priority, ttl }) => ({ type, name, content, priority, ttl })), planned: [`Routing MX on ${domain} -> Cloudflare routing MX (priorities supplied by Cloudflare)`, `One merged SPF TXT on ${domain}; preserve existing senders`, `Sending MX/SPF on cf-bounce.${domain}`, `Sending DKIM on cf-bounce._domainkey.${domain}`, `DMARC on _dmarc.${domain}; preserve existing policy, otherwise monitor first`, `Literal mailbox and alias rules on ${domain} -> ${config.resourceNames.inbound}`], apexUntouched: config.routingMode === 'manual' };
}

export async function workerSettings(api, accountId, name) {
  try { return (await api(`/accounts/${accountId}/workers/scripts/${name}/settings`)).result; } catch (error) { if (error.status === 404) return null; throw error; }
}

export function assertRemoteIdentity(config, settings) {
  if (!settings) return;
  const values = Object.fromEntries((settings.bindings ?? []).filter((binding) => binding.type === 'plain_text').map((binding) => [binding.name, binding.text]));
  if (!values.INSTANCE_ID && config.phase === 'deploying' && settings.tags?.includes(`mail-instance:${config.instanceId}`) && settings.tags?.includes(`mail-keys:${config.keyFingerprint}`)) return;
  if (values.INSTANCE_ID !== config.instanceId || values.INSTANCE_SLUG !== config.instanceSlug || values.INSTANCE_STAGE !== config.stage) throw new Error('A deployed Worker with this name belongs to another instance. Choose a separate slug/checkout; automatic adoption is blocked.');
  if (values.MAIL_KEY_FINGERPRINT !== config.keyFingerprint) throw new Error('Deployed key fingerprint differs. Restore the original keys; deployment is blocked.');
}

export async function assertUnclaimedResources(config, api) {
  // Even an orphaned database/bucket must not be silently adopted by a new checkout.
  const databases = await listAll(api, `/accounts/${config.accountId}/d1/database`);
  if (databases.some((item) => item.name === config.resourceNames.database)) throw new Error('A database already uses this instance name. Restore its original .local state or choose a different slug.');
  const buckets = (await api(`/accounts/${config.accountId}/r2/buckets`)).result;
  if (!Array.isArray(buckets?.buckets)) throw new Error('Cannot inspect R2 ownership. Check Workers R2 Storage Read/Edit permissions.');
  if (buckets.buckets.some((item) => item.name === config.resourceNames.rawBucket)) throw new Error('A mail bucket already uses this instance name. Restore its original .local state or choose a different slug.');
  const queues = await listAll(api, `/accounts/${config.accountId}/queues`);
  const names = [config.resourceNames.inboundQueue, config.resourceNames.inboundDlq, config.resourceNames.outboundQueue, config.resourceNames.eventsQueue];
  if (queues.some((item) => names.includes(item.queue_name))) throw new Error('A queue already uses this instance name. Restore its original .local state or choose a different slug.');
}
