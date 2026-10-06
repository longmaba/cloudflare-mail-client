// SPDX-License-Identifier: Apache-2.0
import { resolveTxt } from 'node:dns/promises';
import { CloudflareError, dnsSnapshot, listAll, workerSettings, assertRemoteIdentity } from './cloudflare.mjs';

export const dnsName = value => String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
export function txt(value) {
  const text = String(value ?? '').trim();
  if (/^"[^"\\\r\n]*"$/.test(text)) return text.slice(1, -1);
  if (/["\\\r\n]/.test(text)) throw new Error('Ambiguous multipart TXT policy. Review it before migration; existing bytes were preserved.');
  return text;
}
export function recordValue(record) {
  return { type: record.type, name: dnsName(record.name), content: record.type === 'MX' ? dnsName(record.content) : String(record.content), ttl: record.ttl ?? 1,
    proxied: record.proxied === true,
    ...(record.priority !== undefined ? { priority: record.priority } : {}),
    ...(record.data && Object.keys(record.data).length ? { data: canonical(record.data) } : {}), ...(record.settings && Object.keys(record.settings).length ? { settings: canonical(record.settings) } : {}),
    ...(record.comment ? { comment: record.comment } : {}), ...(record.tags?.length ? { tags: [...record.tags].sort() } : {}) };
}
export const sortedRecords = records => records.map(recordValue).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function sameRecords(a, b) {
  const comparable = records => sortedRecords(records.map(record => {
    if (record.type !== 'TXT') return record;
    try { return { ...record, content: dkimTxt(record.content) }; } catch { return record; }
  }));
  return JSON.stringify(comparable(a)) === JSON.stringify(comparable(b));
}
export function sameMailRecord(a, b) {
  if (a.type !== b.type || dnsName(a.name) !== dnsName(b.name)) return false;
  return a.type === 'MX' ? dnsName(a.content) === dnsName(b.content) && a.priority === b.priority : a.name.includes('._domainkey.') ? dkimTxt(a.content) === dkimTxt(b.content) : txt(a.content) === txt(b.content);
}
function dkimTxt(value) {
  const content = String(value).trim();
  if (!content.includes('"')) return txt(content);
  if (!/^(?:"[^"\\\r\n]*"\s*)+$/.test(content)) throw new Error('Ambiguous DKIM TXT data.');
  return [...content.matchAll(/"([^"\\]*)"/g)].map(match => match[1]).join('');
}
export const isSpf = record => record.type === 'TXT' && /^"?v=spf1(?:\s|$)/i.test(String(record.content).trim());
export const apexRecords = (records, domain) => records.filter(record => dnsName(record.name) === domain && (record.type === 'MX' || isSpf(record)));
const cfMx = content => /^[a-z0-9-]+\.mx\.cloudflare\.net\.?$/i.test(content);
const id = value => typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
const dmarc = content => /^v=DMARC1\s*;/i.test(txt(content)) && [...txt(content).matchAll(/(?:^|;)\s*p\s*=/gi)].length === 1 && /(?:^|;)\s*p\s*=\s*(?:none|quarantine|reject)\s*(?:;|$)/i.test(txt(content));

export function mergedSpf(records, domain) {
  const policies = records.filter(record => dnsName(record.name) === domain && isSpf(record));
  if (policies.length > 1) throw new Error('Multiple apex SPF policies. Merge them before migration.');
  const original = policies[0];
  const value = original ? txt(original.content) : 'v=spf1 ~all';
  const terms = value.split(/\s+/);
  if (terms.shift()?.toLowerCase() !== 'v=spf1' || !/^[~-]all$/i.test(terms.at(-1) ?? '') || terms.slice(0, -1).some(term => /^(?:[+?~-]?all|redirect=)/i.test(term))) throw new Error('Apex SPF must have one final ~all or -all and no redirect. Review the existing policy before migration.');
  if (terms.some(term => /^[+?~-]?include:_spf\.mx\.cloudflare\.net$/i.test(term) && !/^\+?include:/i.test(term))) throw new Error('Cloudflare SPF include has a negative qualifier. Review the policy before migration.');
  if (!terms.some(term => /^\+?include:_spf\.mx\.cloudflare\.net$/i.test(term))) terms.splice(-1, 0, 'include:_spf.mx.cloudflare.net');
  return { type: 'TXT', name: domain, content: ['v=spf1', ...terms].join(' '), ttl: original?.ttl ?? 1, ...(original?.comment ? { comment: original.comment } : {}), ...(original?.tags?.length ? { tags: original.tags } : {}) };
}

/** Conservative worst-case SPF budget. Repeated includes count repeatedly.
 * Macros, ptr and unknown mechanisms require operator review, not a guess. */
export async function checkSpfBudget(policy, lookup = resolveTxt, ancestry = []) {
  const terms = txt(policy).split(/\s+/);
  if (terms.shift()?.toLowerCase() !== 'v=spf1') throw new Error('Invalid SPF policy.');
  let count = 0;
  for (const raw of terms) {
    const term = raw.replace(/^[+?~-]/, '');
    if (/^(?:all|ip4:[0-9./]+|ip6:[a-f0-9:/]+)$/i.test(term) || /^exp=[a-z0-9_.-]+$/i.test(term)) continue;
    if (/^(?:a|mx)(?::[a-z0-9_.-]+)?(?:\/\d{1,3})?$/i.test(term)) { count++; continue; }
    const nested = /^(?:include:|redirect=)([a-z0-9_.-]+)$/i.exec(term);
    if (!nested || ancestry.includes(nested[1].toLowerCase()) || ancestry.length > 10) throw new Error('SPF has an unsupported mechanism or include cycle. Review its DNS lookup budget before migration.');
    let answers;
    try { answers = await lookup(nested[1]); } catch { throw new Error('Cannot resolve an SPF include. Retry with working DNS before migration.'); }
    const policies = answers.map(parts => parts.join('')).filter(value => /^v=spf1(?:\s|$)/i.test(value));
    if (policies.length !== 1) throw new Error('An SPF include does not resolve to exactly one policy. Review it before migration.');
    count += 1 + await checkSpfBudget(policies[0], lookup, [...ancestry, nested[1].toLowerCase()]);
    if (count > 10) throw new Error('Merged SPF exceeds the ten DNS lookup limit. Remove unused sender authorizations before migration.');
  }
  if (count > 10) throw new Error('Merged SPF exceeds the ten DNS lookup limit.');
  return count;
}

export function routingRequirements(records, domain, current) {
  const wanted = [];
  let spf = 0;
  for (const record of records) {
    const name = record.name === '@' ? domain : dnsName(record.name);
    if (name === `cf2024-1._domainkey.${domain}` && record.type === 'TXT') {
      // The working pilot must already own this shared selector; don't copy it.
      if (!current.some(row => row.type === 'TXT' && dnsName(row.name) === name && String(row.content).replace(/["\s]/g, '') === String(record.content).replace(/["\s]/g, ''))) throw new Error('Shared Email Routing DKIM is missing or differs. Repair the pilot first; migration will not overwrite it.');
    } else if (name === domain && record.type === 'MX' && cfMx(record.content) && Number.isInteger(record.priority) && record.priority >= 0 && record.priority <= 65535) wanted.push(recordValue({ ...record, name }));
    else if (name === domain && record.type === 'TXT' && /^v=spf1\s+include:_spf\.mx\.cloudflare\.net\s+[~-]all$/i.test(txt(record.content))) spf++;
    else throw new Error('Unexpected Cloudflare routing DNS preview. No apex records were changed.');
  }
  if (!wanted.length || spf !== 1 || new Set(wanted.map(record => `${record.content}:${record.priority}`)).size !== wanted.length) throw new Error('Incomplete or duplicate Cloudflare routing DNS requirements.');
  return sortedRecords(wanted);
}

export function validateSender(native, domain) {
  if (!native || native.name !== domain || native.enabled !== true || !id(native.tag) || dnsName(native.return_path_domain) !== `cf-bounce.${domain}` || native.dkim_selector !== 'cf-bounce') throw new Error('Native sending identity is disabled or has unexpected scope. Review Email Sending for this exact apex.');
}
export function sendingRequirements(native, records, domain) {
  validateSender(native, domain);
  const bounce = `cf-bounce.${domain}`, signing = `cf-bounce._domainkey.${domain}`, policy = `_dmarc.${domain}`;
  const wanted = records.map(record => {
    const next = recordValue(record);
    if (!Number.isInteger(next.ttl) || (next.ttl !== 1 && (next.ttl < 60 || next.ttl > 86400))) throw new Error('Invalid sending DNS TTL.');
    if (next.type === 'MX' && next.name === bounce && cfMx(next.content) && Number.isInteger(next.priority) && next.priority >= 0 && next.priority <= 65535) return next;
    if (next.type === 'TXT' && ((next.name === bounce && /^v=spf1\s+include:_spf\.mx\.cloudflare\.net\s+[~-]all$/i.test(txt(next.content))) || (next.name === signing && /^v=DKIM1\s*;.*(?:^|;)\s*p=[A-Za-z0-9+/=\s]+;?$/i.test(dkimTxt(next.content))))) return next;
    if (next.type === 'TXT' && next.name === policy && dmarc(next.content)) return { ...next, content: 'v=DMARC1; p=none', ttl: 1 };
    throw new Error('Unexpected native sending DNS name, type or value. Apex MX was preserved.');
  });
  if (!wanted.some(record => record.type === 'MX') || [bounce, signing, policy].some(name => wanted.filter(record => record.type === 'TXT' && record.name === name).length !== 1)) throw new Error('Incomplete native sending DNS requirements.');
  return sortedRecords(wanted);
}
export function missingSendingRecords(wanted, current, domain) {
  const names = new Set(wanted.map(record => record.name));
  const existing = current.filter(record => names.has(dnsName(record.name)));
  if (existing.some(record => ['CNAME', 'NS'].includes(record.type))) throw new Error('Sending hosts are aliased or delegated. Existing records were preserved.');
  const missing = [];
  for (const record of wanted) {
    const rows = existing.filter(row => dnsName(row.name) === record.name && row.type === record.type);
    if (record.name === `_dmarc.${domain}` && rows.length === 1 && dmarc(rows[0].content)) continue;
    if (record.type === 'MX') {
      if (rows.some(row => !wanted.some(other => sameMailRecord(row, other)))) throw new Error('Native bounce MX conflicts with another provider.');
    } else if (rows.length > 1 || rows.some(row => !sameMailRecord(row, record))) throw new Error('Native sending TXT conflicts with an occupied selector or SPF.');
    if (!rows.some(row => sameMailRecord(row, record))) missing.push(record);
  }
  return missing;
}

export function normalizedRule(rule) {
  return { ...(rule.tag ? { tag: rule.tag } : {}), name: rule.name ?? '', enabled: rule.enabled === true, priority: rule.priority ?? 0, matchers: rule.matchers ?? [], actions: rule.actions ?? [], ...(rule.source ? { source: rule.source } : {}) };
}
export const sortedRules = rules => rules.map(normalizedRule).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
export function recipientRules(recipients, rules, domain, worker) {
  const addresses = new Set(recipients.map(row => row.address));
  const wanted = [];
  for (const address of addresses) {
    const matches = rules.filter(rule => rule.matchers?.some(matcher => matcher.field === 'to' && dnsName(String(matcher.value).split('@')[1]) === domain && String(matcher.value).toLowerCase() === address));
    if (matches.length > 1) throw new Error(`Duplicate routing rules for ${address}. Review them before migration.`);
    const old = matches[0];
    if (old && (old.name !== `cloudflare-mail-client:${address}` || old.source === 'wrangler' || old.matchers?.length !== 1 || old.matchers[0].type !== 'literal' || old.actions?.length !== 1 || old.actions[0].type !== 'worker' || old.actions[0].value?.length !== 1 || old.actions[0].value[0] !== worker)) throw new Error(`Conflicting routing rule for ${address}. Existing destination was preserved.`);
    wanted.push({ ...(old?.tag ? { tag: old.tag } : {}), ...(old?.source ? { source: old.source } : {}), name: `cloudflare-mail-client:${address}`, enabled: true, priority: old?.priority ?? 0, matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [worker] }] });
  }
  // Regex/unknown apex rules can shadow a literal rule. Never infer ownership.
  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (rule.matchers?.some(matcher => matcher.type !== 'literal' || matcher.field !== 'to')) throw new Error('An enabled nonliteral routing rule needs operator review before migration.');
    for (const matcher of rule.matchers ?? []) if (String(matcher.value).toLowerCase().endsWith(`@${domain}`) && !addresses.has(String(matcher.value).toLowerCase())) throw new Error('An enabled apex rule has no provisioned recipient. Review it before migration.');
  }
  return wanted;
}

/** Write-capable request surface is separate from the installer's GET adapter.
 * Never print provider bodies or network errors, which can contain credentials. */
export function migrationRequest(token, fetcher = fetch) {
  return async (path, method = 'GET', body) => {
    let response;
    try { response = await fetcher(`https://api.cloudflare.com/client/v4${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(20_000) }); }
    catch { throw new Error('Cloudflare migration request could not complete. Rerun the same journal to inspect its outcome; private request details were suppressed.'); }
    let payload;
    try { payload = await response.json(); } catch { throw new CloudflareError(path, response.status, []); }
    if (!response.ok || payload.success !== true) throw new CloudflareError(path, response.status, (payload.errors ?? []).map(error => error.code).filter(Number.isInteger));
    return payload;
  };
}

export function migrationProvider(config, secrets, token, { fetcher = fetch } = {}) {
  const deployRead = migrationRequest(token, fetcher), runtime = migrationRequest(secrets.runtimeToken, fetcher), deploy = migrationRequest(token, fetcher);
  const zone = `/zones/${config.zoneId}`, account = `/accounts/${config.accountId}`;
  let databaseId, authKv;
  const query = async (sql, params = []) => {
    const payload = await deploy(`${account}/d1/database/${databaseId}/query`, 'POST', { sql, params });
    if (payload.result?.length !== 1 || payload.result[0].success !== true || !Array.isArray(payload.result[0].results)) throw new Error('D1 migration query failed. Raw database output was suppressed.');
    return payload.result[0].results;
  };
  return {
    async snapshot() {
      const selected = (await deployRead(zone)).result;
      if (selected.id !== config.zoneId || selected.name !== config.zoneName || selected.account?.id !== config.accountId || selected.status !== 'active') throw new Error('Migration account/zone identity differs or is inactive.');
      const settings = {};
      for (const role of ['web', 'inbound', 'jobs']) {
        settings[role] = await workerSettings(deployRead, config.accountId, config.resourceNames[role]);
        if (!settings[role]) throw new Error('Deploy and verify all pilot Workers first.');
        assertRemoteIdentity(config, settings[role]);
      }
      const bindings = settings.web.bindings;
      databaseId = bindings.find(binding => binding.name === 'DB' && binding.type === 'd1')?.id;
      authKv = bindings.find(binding => binding.name === 'AUTH_KV' && binding.type === 'kv_namespace')?.namespace_id;
      if (!databaseId || !id(authKv)) throw new Error('Live D1 or authentication cache binding is missing.');
      const db = (await deployRead(`${account}/d1/database/${databaseId}`)).result;
      if (db.name !== config.resourceNames.database) throw new Error('Bound D1 belongs to a different instance.');
      const organizations = await query('SELECT id,domain,zone_id AS zoneId,status FROM organization WHERE domain=?', [config.zoneName]);
      if (organizations.length !== 1 || organizations[0].zoneId !== config.zoneId || !['staged', 'active'].includes(organizations[0].status)) throw new Error('The prepared apex organization is missing, duplicated or outside this zone.');
      const organization = organizations[0];
      const recipients = await query(`SELECT b.id AS mailboxId,b.address,b.is_service AS isService FROM mailbox b WHERE b.org_id=? AND b.is_active=1
        UNION ALL SELECT b.id AS mailboxId,a.address,b.is_service AS isService FROM alias a JOIN mailbox b ON b.id=a.mailbox_id AND b.org_id=a.org_id WHERE a.org_id=? AND a.is_enabled=1 AND b.is_active=1 ORDER BY address`, [organization.id, organization.id]);
      const owners = await query(`SELECT DISTINCT u.id,u.email,u.role,u.banned,u.two_factor_enabled AS totpEnabled,u.must_change_password AS passwordSetupPending,
        u.recovery_email_verified AS recoveryVerified, substr(lower(u.recovery_email),instr(u.recovery_email,'@')+1) AS recoveryDomain,
        u.onboarded_at IS NOT NULL AS onboarded, EXISTS(SELECT 1 FROM account a WHERE a.user_id=u.id AND a.provider_id='credential' AND a.password IS NOT NULL) AS passwordChosen,
        EXISTS(SELECT 1 FROM member m WHERE m.user_id=u.id AND m.role IN ('owner','admin')) AS elevatedMembership,
        EXISTS(SELECT 1 FROM member m JOIN org_mail_settings s ON s.org_id=m.organization_id WHERE m.user_id=u.id AND s.require_2fa=1 AND (s.require_2fa_from IS NULL OR s.require_2fa_from<=?)) AS orgTotpRequired
        FROM user u JOIN mailbox_access g ON g.user_id=u.id JOIN mailbox b ON b.id=g.mailbox_id WHERE b.org_id=? AND b.is_active=1 ORDER BY u.id`, [Date.now(), organization.id]);
      for (const owner of owners) {
        owner.externalRecovery = !!owner.recoveryDomain && owner.recoveryDomain !== config.zoneName && !owner.recoveryDomain.endsWith(`.${config.zoneName}`);
        delete owner.recoveryDomain;
      }
      const grants = await query('SELECT g.user_id AS userId,g.mailbox_id AS mailboxId,g.can_send AS canSend FROM mailbox_access g JOIN mailbox b ON b.id=g.mailbox_id WHERE b.org_id=? AND b.is_active=1 ORDER BY g.user_id,g.mailbox_id', [organization.id]);
      const records = await dnsSnapshot(runtime, config.zoneId);
      const rules = await listAll(runtime, `${zone}/email/routing/rules`);
      let catchAll;
      try { catchAll = (await runtime(`${zone}/email/routing/rules/catch_all`)).result; } catch (error) { if (error.status !== 404) throw error; }
      const routing = (await runtime(`${zone}/email/routing`)).result;
      const routingDns = await listAll(runtime, `${zone}/email/routing/dns`);
      const natives = (await listAll(runtime, `${zone}/email/sending/subdomains`)).filter(item => item.name === config.zoneName);
      if (natives.length > 1) throw new Error('Duplicate exact apex sending identities.');
      const nativeDomain = natives[0] ?? null;
      const nativeDns = nativeDomain ? await listAll(runtime, `${zone}/email/sending/subdomains/${nativeDomain.tag}/dns`) : [];
      const scopes = Object.fromEntries(bindings.filter(binding => binding.type === 'plain_text' && ['MAIL_DOMAIN', 'MAIL_ROUTING_MODE', 'MAIL_STAGING_DOMAIN', 'MAIL_MIGRATED_DOMAIN'].includes(binding.name)).map(binding => [binding.name, binding.text]));
      const resources = Object.fromEntries(Object.entries(settings).map(([role, value]) => [role, value.bindings.filter(binding => ['d1', 'kv_namespace', 'r2_bucket', 'queue'].includes(binding.type)).map(binding => ({ name: binding.name, type: binding.type, id: binding.id ?? binding.namespace_id ?? binding.bucket_name ?? binding.queue_id ?? binding.queue_name })).sort((a, b) => a.name.localeCompare(b.name))]));
      return { records, rules, catchAll: catchAll ? normalizedRule(catchAll) : null, routingEnabled: routing.enabled === true, routingStatus: routing.status, routingDns, nativeDomain, nativeDns, organization, recipients, owners, grants, resources, scopes, databaseId };
    },
    async registerSender() {
      const existing = (await listAll(runtime, `${zone}/email/sending/subdomains`)).filter(item => item.name === config.zoneName);
      if (existing.length === 1 && existing[0].enabled === true) return;
      if (existing.length > 1) throw new Error('Duplicate native sending identities.');
      await runtime(`${zone}/email/sending/subdomains`, 'POST', { name: config.zoneName });
    },
    async addSendingDns(records) {
      if (records.length) await runtime(`${zone}/dns_records/batch`, 'POST', { posts: records.map(recordValue) });
    },
    async reconcileRules(rules) {
      for (const rule of rules) {
        const { tag, source: _source, ...body } = rule;
        if (tag) await runtime(`${zone}/email/routing/rules/${tag}`, 'PUT', body);
        else await runtime(`${zone}/email/routing/rules`, 'POST', body);
      }
    },
    async activateOrganization(organization, native) {
      validateSender(native, config.zoneName);
      await query(`INSERT INTO org_mail_settings (org_id,return_path_domain,updated_at) VALUES (?,?,?)
        ON CONFLICT(org_id) DO UPDATE SET return_path_domain=excluded.return_path_domain,updated_at=excluded.updated_at`, [organization.id, native.return_path_domain, Date.now()]);
      await query("UPDATE organization SET status='active' WHERE id=? AND domain=? AND zone_id=? AND status IN ('staged','active')", [organization.id, config.zoneName, config.zoneId]);
    },
    async invalidateIdentities(owners) {
      for (const owner of owners) await deploy(`${account}/storage/kv/namespaces/${authKv}/values/${encodeURIComponent(`ids:v2:${owner.id}`)}`, 'DELETE');
    },
    async replaceApexDns(previous, next) {
      const deletes = previous.map(record => {
        if (!id(record.id)) throw new Error('Invalid DNS record ID; replacement blocked.');
        return { id: record.id };
      });
      // Unlock, never disable/delete zone routing. Cloudflare may lock its
      // managed MX after activation; PATCH retains pilot and signing records.
      await runtime(`${zone}/email/routing/dns`, 'PATCH');
      await runtime(`${zone}/dns_records/batch`, 'POST', { deletes, posts: next.map(recordValue) });
    },
  };
}
