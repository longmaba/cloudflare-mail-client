// SPDX-License-Identifier: Apache-2.0
import Cloudflare from "cloudflare";
import { APP_CLOUDFLARE_ACCOUNT_ID, APP_CLOUDFLARE_API_TOKEN, MAIL_DOMAIN, MAIL_ROUTING_MODE } from "$app/env/private";
import { assertMailScope } from './routing-policy.js';
import type { DNSRecord } from 'cloudflare/resources/email-routing/dns';
import type { RecordCreateParams, RecordResponse } from 'cloudflare/resources/dns/records';
type MailDnsCreate = Extract<RecordCreateParams, { type: 'MX' | 'TXT' }>;

/** Safe operator-facing setup failures; SDK errors keep their separate handling. */
export class MailSetupError extends Error {
  constructor(message: string) { super(message); this.name = 'MailSetupError'; }
}

/**
 * Cloudflare is the source of truth for all mail wiring. This module is the only
 * place we talk to the CF API. Don't call it on the inbound-email hot path or on
 * login validation; those read the cached D1 domain→org→zone map.
 *
 * Credential is a scoped API token (Bearer), never the global API key. No
 * account email. Every call here is idempotent: check-then-create where a list
 * exists, tolerate "already exists / already enabled" otherwise.
 */

export type ZoneOnboardStatus =
  | "pending_zone"
  | "pending_nameservers"
  | "wiring"
  | "active"
  | "error";

let client: Cloudflare | undefined;

export function cf(): Cloudflare {
  if (!APP_CLOUDFLARE_API_TOKEN || !APP_CLOUDFLARE_ACCOUNT_ID) {
    throw new Error(
      "Cloudflare is not configured. Set APP_CLOUDFLARE_API_TOKEN and APP_CLOUDFLARE_ACCOUNT_ID (scoped API token).",
    );
  }
  // Bearer token only — apiEmail/global key is intentionally not passed.
  return (client ??= new Cloudflare({ apiToken: APP_CLOUDFLARE_API_TOKEN }));
}

/**
 * Map a live CF zone to our onboarding status. `active` means DNS is delegated
 * to Cloudflare and the zone is live — the prerequisite for wiring mail.
 */
export function statusForZone(status: string | undefined): ZoneOnboardStatus {
  switch (status) {
    case "active":
      return "active";
    case "pending":
    case "initializing":
      return "pending_nameservers";
    default:
      return "error";
  }
}

/**
 * True for CF errors that mean "the thing you asked to create already exists /
 * is already enabled" — benign for an idempotent wire step, so we swallow them.
 */
function isBenignConflict(err: unknown): boolean {
  const e = err as { status?: number; errors?: Array<{ code?: number; message?: string }>; message?: string };
  if (e?.status === 409) return true;
  const blob =
    (e?.errors?.map((cfError) => `${cfError.code} ${cfError.message}`).join(" ") ?? "") +
    " " +
    (e?.message ?? "");
  return /already\s+(exists|enabled|active|been)|duplicate|is enabled/i.test(blob);
}

export type ZoneRef = {
  id: string;
  name: string;
  status: ZoneOnboardStatus;
  nameServers: string[];
};

function toZoneRef(z: {
  id: string;
  name: string;
  status?: string;
  name_servers?: string[];
}): ZoneRef {
  return {
    id: z.id,
    name: z.name,
    status: statusForZone(z.status),
    nameServers: z.name_servers ?? [],
  };
}

/**
 * Idempotent zone create. If the domain is already a zone on this account we
 * return it (the "already on the operator's CF account" path); otherwise POST a
 * new full zone and return its pending status + assigned nameservers.
 */
export async function zoneCreate(domain: string): Promise<ZoneRef> {
  const c = cf();
  const existing = await c.zones.list({
    account: { id: APP_CLOUDFLARE_ACCOUNT_ID },
    name: domain,
  });
  const found = existing.result?.[0];
  if (found) return toZoneRef(found);

  const created = await c.zones.create({
    account: { id: APP_CLOUDFLARE_ACCOUNT_ID },
    name: domain,
    type: "full",
  });
  return toZoneRef(created);
}

/** Live zone status — used only by the (superadmin) poll, never the hot path. */
export async function pollZoneStatus(zoneId: string): Promise<ZoneRef> {
  const z = await cf().zones.get({ zone_id: zoneId });
  if (z.account.id !== APP_CLOUDFLARE_ACCOUNT_ID) {
    throw new MailSetupError('This Cloudflare zone belongs to a different account than the configured mail instance.');
  }
  return toZoneRef(z);
}

/** Find an existing zone by name without creating one (for the Link path). */
export async function findZone(domain: string): Promise<ZoneRef | undefined> {
  const res = await cf().zones.list({ account: { id: APP_CLOUDFLARE_ACCOUNT_ID }, name: domain });
  const found = res.result?.[0];
  return found ? toZoneRef(found) : undefined;
}

/**
 * Every zone on the operator's Cloudflare account — the source for the "pick a
 * domain" onboarding picker (no manual typing). Super-admin/settings only.
 */
export async function listZones(): Promise<ZoneRef[]> {
  const zones: ZoneRef[] = [];
  for await (const zone of cf().zones.list({ account: { id: APP_CLOUDFLARE_ACCOUNT_ID } })) zones.push(toZoneRef(zone));
  return zones;
}

export async function findMailZone(domain: string): Promise<ZoneRef | undefined> {
  return (await listZones()).filter(zone => domain === zone.name || domain.endsWith(`.${zone.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

export type ZoneDnsRecord = {
  type: string;
  name: string;
  content: string;
  priority?: number;
  ttl?: number;
  proxied?: boolean;
};

/**
 * Every DNS record in the zone, live from Cloudflare (never persisted). Cloudflare
 * holds the full zone (the apex and every subdomain), so this is the operator's
 * complete view of what's published. Best-effort: [] on error.
 */
export async function listZoneDnsRecords(zoneId: string): Promise<ZoneDnsRecord[]> {
  try {
    const page = await cf().dns.records.list({ zone_id: zoneId, per_page: 100 });
    // `priority`/`proxied` exist only on some record subtypes in the CF union.
    const rows = (page.result ?? []).map((record) => {
      const rec = record as { priority?: number; proxied?: boolean };
      return {
        type: record.type ?? "",
        name: record.name ?? "",
        content: record.content ?? "",
        priority: rec.priority,
        ttl: record.ttl,
        proxied: rec.proxied,
      };
    });
    rows.sort((first, second) => first.name.localeCompare(second.name) || first.type.localeCompare(second.type));
    return rows;
  } catch (e) {
    console.error("[cf:dns] zone records", e);
    return [];
  }
}

/**
 * Create-or-update a TXT record by exact name. Used for records we own outright
 * (e.g. the BIMI `default._bimi.<apex>` record) — one record per name, so an
 * existing one is updated in place rather than duplicated.
 */
export async function upsertTxtRecord(
  zoneId: string,
  name: string,
  content: string,
): Promise<void> {
  const page = await cf().dns.records.list({ zone_id: zoneId, per_page: 100, type: "TXT" });
  const existing = (page.result ?? []).find((record) => record.name === name);
  // ttl: 1 = "automatic" on Cloudflare.
  if (existing?.id) {
    await cf().dns.records.update(existing.id, { zone_id: zoneId, type: "TXT", name, content, ttl: 1 });
  } else {
    await cf().dns.records.create({ zone_id: zoneId, type: "TXT", name, content, ttl: 1 });
  }
}

/** Enable zone-wide routing only for an explicitly selected apex migration. */
export async function enableEmailRouting(zoneId: string): Promise<void> {
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(zone.name, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  const current = await cf().emailRouting.get({ zone_id: zoneId }).catch(() => null);
  if (current?.enabled && current?.status === "ready") return;
  // Only an explicitly selected apex may use this zone-wide endpoint.
  await cf().emailRouting.dns.create({ zone_id: zoneId });
}

/** Register only the configured pilot. Omitting name would activate apex routing. */
export async function enablePilotEmailRouting(zoneId: string, domain: string): Promise<void> {
  if (typeof domain !== 'string' || !domain || domain !== MAIL_DOMAIN) {
    throw new MailSetupError('Pilot routing requires the exact configured mail subdomain.');
  }
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(domain, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  const prefix = domain.endsWith(`.${zone.name}`) ? domain.slice(0, -zone.name.length - 1) : '';
  if (!prefix || prefix.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new MailSetupError('Pilot routing activation requires a strict subdomain of the selected zone.');
  }
  if (zone.status !== 'active') throw new MailSetupError('The selected Cloudflare zone is not active.');
  const before = await protectedApexDns(zoneId, zone.name);
  let result;
  try {
    // DNS records alone do not enroll a domain in Email Routing. Always name the
    // selected subdomain; conflicts must propagate rather than imply enrollment.
    result = await cf().emailRouting.dns.create({ zone_id: zoneId, name: domain });
  } finally {
    if (before.state !== (await protectedApexDns(zoneId, zone.name, before.dkimNames)).state) {
      throw new MailSetupError('Protected apex mail DNS changed during pilot activation. Review the saved provider records before continuing.');
    }
  }
  if (result?.name !== domain || !result.enabled || result.status !== 'ready') {
    throw new MailSetupError('Cloudflare did not confirm ready routing for the configured pilot subdomain. Review its Email Routing settings and retry.');
  }
}

async function protectedApexDns(zoneId: string, zone: string, existingDkim?: ReadonlySet<string>) {
  const records = [];
  const dkimNames = new Set<string>();
  for await (const record of cf().dns.records.list({ zone_id: zoneId, per_page: 100 })) {
    const name = dnsContent(record.name);
    const dkim = ['TXT', 'CNAME'].includes(record.type) &&
      (name === `_domainkey.${zone}` || name.endsWith(`._domainkey.${zone}`));
    if ((record.type === 'MX' && name === zone) ||
        (record.type === 'TXT' && name === zone && /^\s*"?v=spf1(?:\s|$)/i.test(record.content ?? '')) ||
        (record.type === 'TXT' && name === `_dmarc.${zone}`) ||
        (dkim && (!existingDkim || existingDkim.has(name)))) {
      if (dkim) dkimNames.add(name);
      const typed = record as { priority?: number; proxied?: boolean };
      records.push({ id: record.id, type: record.type, name, content: record.content, ttl: record.ttl,
        priority: typed.priority ?? null, proxied: typed.proxied ?? false });
    }
  }
  return { state: JSON.stringify(records.sort((first, second) => first.id.localeCompare(second.id))), dkimNames };
}

/**
 * Read the supported zone DNS preview, then provision only the selected host.
 * The preview's deprecated `subdomain` query has an undocumented response shape,
 * so only apex MX/SPF requirements are mapped to the selected mail domain. The
 * validated shared routing DKIM is managed by explicit service activation.
 * Existing policies are never replaced and conflicts fail before any write.
 */
export async function writeDnsRecords(
  zoneId: string,
  subdomain?: string,
): Promise<void> {
  const c = cf();
  const zone = await pollZoneStatus(zoneId);
  const domain = subdomain ?? zone.name;
  assertMailScope(domain, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  const preview = await c.emailRouting.dns.get({ zone_id: zoneId });
  if (!preview.success || !Array.isArray(preview.result) || !preview.result.length) {
    throw new MailSetupError('Cloudflare returned an unsupported routing DNS preview. Review the selected domain in Cloudflare.');
  }
  const required = preview.result.flatMap(record => {
    const planned = routingDnsRecord(record, zone.name, domain, zoneId);
    return planned ? [planned] : [];
  });
  if (!required.some(record => record.type === 'MX') ||
      required.filter(record => record.type === 'TXT').length !== 1) {
    throw new MailSetupError('Cloudflare routing DNS preview must contain MX records and one SPF policy.');
  }

  const dmarcName = `_dmarc.${domain}`;
  const [existing, dmarc] = await Promise.all([
    exactDnsRecords(zoneId, domain), exactDnsRecords(zoneId, dmarcName)
  ]);
  if ([...existing, ...dmarc].some(record => record.type === 'CNAME' || record.type === 'NS')) {
    throw new MailSetupError('The selected mail DNS name is aliased or delegated. Resolve that conflict before retrying.');
  }
  const requiredMx = required.filter(record => record.type === 'MX');
  if (existing.some(record => record.type === 'MX' &&
      !requiredMx.some(wanted => dnsContent(record.content) === dnsContent(wanted.content)))) {
    throw new MailSetupError(`Existing MX records already receive mail for ${domain}. Migrate them explicitly before retrying; no records were changed.`);
  }
  const spf = existing.filter(record => record.type === 'TXT' && /^\s*"?v=spf1(?:\s|$)/i.test(record.content ?? ''));
  if (spf.length > 1 || (spf.length === 1 && !authorizesRouting(spf[0].content ?? ''))) {
    // Nested includes can exceed SPF's lookup limit. Keep the exact operator
    // policy and require a reviewed merge instead of guessing at its semantics.
    throw new MailSetupError(`SPF conflict for ${domain}. Keep one SPF record and merge include:_spf.mx.cloudflare.net before retrying; the existing policy was preserved.`);
  }
  const planned = required.filter(wanted => wanted.type === 'MX'
    ? !existing.some(record => record.type === 'MX' && dnsContent(record.content) === dnsContent(wanted.content))
    : spf.length === 0);
  if (!dmarc.some(record => record.type === 'TXT' && /^\s*"?v=DMARC1(?:\s*;|$)/i.test(record.content ?? ''))) {
    planned.push({ zone_id: zoneId, type: 'TXT', name: dmarcName, content: 'v=DMARC1; p=none', ttl: 1 });
  }
  for (const record of planned) {
    try {
      await c.dns.records.create(record);
    } catch (cause) {
      // A concurrent rerun is benign only if it created this exact requirement.
      if (!isBenignConflict(cause) || !(await exactDnsRecords(zoneId, record.name)).some(existing =>
        existing.type === record.type && dnsContent(existing.content) === dnsContent(record.content))) throw cause;
    }
  }
}

const dnsContent = (content: string | undefined) => (content ?? '').toLowerCase().replace(/\.$/, '');
function txtValue(content: string): string {
  const value = content.trim();
  return /^"[^"\\]*"$/.test(value) ? value.slice(1, -1) : value;
}
function authorizesRouting(content: string): boolean {
  // Accept a single RFC 1035 quoted string without changing its stored bytes.
  const terms = txtValue(content).split(/\s+/);
  const include = terms.findIndex(term => /^\+?include:_spf\.mx\.cloudflare\.net$/i.test(term));
  const terminal = terms.findIndex(term => /^[+?~-]?all$/i.test(term));
  return /^v=spf1$/i.test(terms[0]) && include > 0 && (terminal < 0 || include < terminal);
}

async function exactDnsRecords(zoneId: string, name: string): Promise<RecordResponse[]> {
  const records: RecordResponse[] = [];
  for await (const record of cf().dns.records.list({ zone_id: zoneId, name: { exact: name }, per_page: 100 })) {
    if (dnsContent(record.name) === name) records.push(record);
  }
  return records;
}

function managedRoutingDkim(record: DNSRecord, zone: string): boolean {
  const suffix = `._domainkey.${zone}`;
  const name = dnsContent(record.name);
  const selector = name.endsWith(suffix) ? name.slice(0, -suffix.length) : '';
  // The documented/live selector is cf2024-1. Recognizing cf<year>-<key> is a
  // bounded rotation-compatibility assumption, not a published API contract.
  // This only excludes shared DKIM from writes; other names still fail closed.
  if (record.type !== 'TXT' || !/^cf\d{4}-[1-9]\d*$/.test(selector) || !record.content) return false;
  const terms = txtValue(record.content).split(';').map(term => term.trim()).filter(Boolean);
  if (!/^v\s*=\s*DKIM1$/i.test(terms[0] ?? '')) return false;
  const tags = new Map<string, string>();
  for (const term of terms) {
    const match = /^([a-z]+)\s*=\s*(.+)$/i.exec(term);
    if (!match || tags.has(match[1].toLowerCase()) || !['v', 'h', 'k', 'p'].includes(match[1].toLowerCase())) return false;
    tags.set(match[1].toLowerCase(), match[2].trim());
  }
  const key = tags.get('p') ?? '';
  return tags.get('k')?.toLowerCase() === 'rsa' &&
    (!tags.has('h') || tags.get('h')?.toLowerCase() === 'sha256') &&
    /^[A-Za-z0-9+/]+={0,2}$/.test(key) && key.length % 4 === 0;
}

function routingDnsRecord(record: DNSRecord, zone: string, domain: string, zoneId: string): MailDnsCreate | undefined {
  // Never copy the shared parent selector onto the pilot or write it generically.
  if (managedRoutingDkim(record, zone)) return undefined;
  const name = record.name === '@' ? zone : dnsContent(record.name);
  if (name !== zone || !record.content) {
    throw new MailSetupError('Cloudflare routing DNS preview contains an unexpected record name or value. No DNS records were changed.');
  }
  if (record.type === 'MX' && /^[a-z0-9.-]+\.mx\.cloudflare\.net\.?$/i.test(record.content) &&
      Number.isInteger(record.priority) && record.priority! >= 0 && record.priority! <= 65535) {
    return { zone_id: zoneId, type: 'MX', name: domain, content: record.content, priority: record.priority!, ttl: record.ttl ?? 1 };
  }
  if (record.type === 'TXT' && /^\s*"?v=spf1\s/i.test(record.content) && authorizesRouting(record.content)) {
    return { zone_id: zoneId, type: 'TXT', name: domain, content: record.content, ttl: record.ttl ?? 1 };
  }
  throw new MailSetupError('Cloudflare routing DNS preview contains unsupported requirements. Review them in Cloudflare before retrying.');
}

/**
 * Onboard the exact sending domain (apex or subdomain), with its own signing
 * identity and return path. Idempotent: create re-enables an existing domain.
 */
export async function onboardSendingDomain(
  zoneId: string,
  sendingSubdomain?: string,
): Promise<{ dkimSelector?: string; returnPathDomain?: string }> {
  const name = sendingSubdomain?.trim().toLowerCase();
  if (!name) return {};
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(name, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  const res = await cf().emailSending.subdomains.create({ zone_id: zoneId, name });
  return {
    dkimSelector: res?.dkim_selector,
    returnPathDomain: res?.return_path_domain,
  };
}

/**
 * Inspect a zone's mail config on Cloudflare — used to decide "already onboarded
 * on the CF dashboard → offer Link" vs "not onboarded → Onboard". Read-only.
 */
export async function inspectZoneMail(zoneId: string): Promise<{
  routingReady: boolean;
  catchAllToWorker: (worker: string) => boolean;
  sendingConfigured: boolean;
}> {
  const c = cf();
  const [routing, catchAll, subs] = await Promise.all([
    c.emailRouting.get({ zone_id: zoneId }).catch(() => null),
    c.emailRouting.rules.catchAlls.get({ zone_id: zoneId }).catch(() => null),
    c.emailSending.subdomains.list({ zone_id: zoneId }).catch(() => null),
  ]);
  const actions = (catchAll?.actions ?? []) as Array<{ type?: string; value?: string[] }>;
  return {
    routingReady: !!routing?.enabled && routing?.status === "ready",
    catchAllToWorker: (worker: string) =>
      actions.some((action) => action.type === "worker" && (action.value ?? []).includes(worker)),
    sendingConfigured: (subs?.result ?? []).some((sub) => sub.enabled),
  };
}

/**
 * Attach an apex catch-all to this worker. Existing operator destinations are
 * preserved, identical rules are skipped, and failed attachment blocks activation.
 */
export async function createRoutingRule(
  zoneId: string,
  workerName: string,
): Promise<void> {
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(zone.name, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  const current = await cf().emailRouting.rules.catchAlls.get({ zone_id: zoneId }).catch((cause) => {
    if ((cause as { status?: number })?.status === 404) return null;
    throw cause;
  });
  const ours = current?.matchers?.length === 1 && current.matchers[0].type === 'all' &&
    current.actions?.length === 1 && current.actions[0].type === 'worker' &&
    current.actions[0].value?.length === 1 && current.actions[0].value[0] === workerName;
  if (ours && current?.enabled) return;
  if (current && !ours && (current.enabled || current.actions?.some(action => action.type !== 'drop'))) {
    throw new MailSetupError('An existing catch-all belongs to another destination. Review it in Cloudflare before retrying.');
  }
  // Missing workers and permission failures must prevent an active domain claim.
  await cf().emailRouting.rules.catchAlls.update({
    zone_id: zoneId,
    name: `cloudflare-mail-client:${zone.name}`,
    actions: [{ type: "worker", value: [workerName] }],
    matchers: [{ type: "all" }],
    enabled: true,
  });
}

/**
 * Live zone routing state. v1 permits only the configured domain; unrelated
 * subdomains and native sending bounce hosts must not become mailbox choices.
 */
export type RoutingConfig = {
  enabled: boolean;
  supportSubaddress: boolean;
  status?: string;
  subdomains: string[];
};

export async function getRoutingConfig(
  zoneId: string,
  apex: string,
): Promise<RoutingConfig> {
  if (apex !== MAIL_DOMAIN) throw new Error('This domain is outside the configured mail instance.');
  const settings = await cf().emailRouting.get({ zone_id: zoneId }).catch(() => null);
  return {
    enabled: !!settings?.enabled,
    supportSubaddress: !!settings?.support_subaddress,
    status: settings?.status,
    subdomains: [],
  };
}

/**
 * Toggle subaddressing (plus-addressing, `user+tag@domain`) on the zone's Email
 * Routing. No typed setter in the SDK (v7 only exposes enable/disable/get), so
 * this uses the raw PATCH escape hatch. Endpoint confirmed against the CF API
 * reference: PATCH /zones/{id}/email/routing { support_subaddress }.
 * ponytail: raw path — if CF ever moves it, the toast surfaces the error and
 * this is the one line to fix.
 */
export async function setSubaddressing(zoneId: string, on: boolean): Promise<void> {
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(zone.name, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  await cf().patch(`/zones/${zoneId}/email/routing`, {
    body: { support_subaddress: on },
  });
}

// ---- Zone observability: analytics · email logs · audit logs ----------------
//
// All read-only, live from Cloudflare (never persisted). To respect Cloudflare's
// API rate limit (~1200 req / 5 min per token; the GraphQL Analytics API has its
// own per-minute ceiling) these go through a tiny per-isolate TTL cache so an
// admin refreshing a dashboard collapses to at most one upstream call per TTL
// window per zone+view. Best-effort: any upstream/GraphQL error degrades to an
// empty result (the UI shows "no data") rather than 500ing the page.
//
// ponytail: in-memory per-isolate cache — resets on isolate recycle and isn't
// shared across colos. Fine for an internal admin panel (few viewers). If you
// ever expose these widely and start hitting CF limits, back this with KV/D1.

const _obsCache = new Map<string, { exp: number; val: unknown }>();

async function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = _obsCache.get(key);
  if (hit && hit.exp > now) return hit.val as T;
  const val = await fn();
  _obsCache.set(key, { exp: now + ttlMs, val });
  return val;
}

/**
 * GraphQL Analytics API. Not exposed by the SDK's typed surface (and its raw
 * request unwraps the REST `result` envelope, which /graphql doesn't use), so
 * this posts directly with the same scoped Bearer token. Returns `data` or null.
 * The token must carry the "Analytics Read" permission for these datasets.
 */
async function cfGraphql<T>(query: string, variables: Record<string, unknown>): Promise<T | null> {
  try {
    const r = await fetch("https://api.cloudflare.com/client/v4/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await r.json()) as { data?: T; errors?: Array<{ message?: string }> };
    // GraphQL can return partial data alongside per-field errors: surface the
    // errors but keep whatever data came back, so a bad field doesn't blank the view.
    if (j.errors?.length) console.warn("[cf:graphql]", r.status, j.errors.map((gqlError) => gqlError.message).join("; "));
    if (!r.ok && !j.data) return null;
    return j.data ?? null;
  } catch (e) {
    console.error("[cf:graphql] request failed", e);
    return null;
  }
}

/** Coerce an unknown CF value to a display string (fields are sometimes objects,
 * lists, or numbers rather than the plain strings the schema implies). */
function str(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return v.map(str).filter(Boolean).join(", ") || null;
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    return str(o.email ?? o.address ?? o.value ?? o.name ?? o.text);
  }
  return null;
}

export type EmailAnalyticsRow = { date: string; status: string; count: number };

const ANALYTICS_Q = `query($zoneTag:string!,$start:Date!,$end:Date!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptiveGroups(filter:{date_geq:$start,date_leq:$end},limit:1000,orderBy:[date_ASC]){
      count dimensions{ date status }
    }
  }}
}`;

/** Cloudflare's email analytics window maxes at 4w3d (31d), measured to the
 * request instant — so a 31-day span overflows by the current time-of-day and is
 * rejected (quota error). Cap at 30 for headroom. */
const MAX_DAYS = 30;
const clampDays = (days: number) => Math.min(Math.max(Math.round(days), 1), MAX_DAYS);

/**
 * Aggregated outbound sending counts over the last `days`, grouped by day +
 * status (delivered / deliveryFailed / …). Clamped to Cloudflare's 31-day window.
 */
export async function zoneEmailAnalytics(zoneId: string, days = 7): Promise<EmailAnalyticsRow[]> {
  const d = clampDays(days);
  return memo(`analytics:${zoneId}:${d}`, 300_000, async () => {
    const iso = (x: Date) => x.toISOString().slice(0, 10);
    const data = await cfGraphql<{
      viewer: { zones: { emailSendingAdaptiveGroups: { count: number; dimensions: { date: string; status: string } }[] }[] };
    }>(ANALYTICS_Q, { zoneTag: zoneId, start: iso(new Date(Date.now() - d * 864e5)), end: iso(new Date()) });
    const rows = data?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups ?? [];
    return rows.map((row) => ({ date: row.dimensions.date, status: row.dimensions.status, count: row.count }));
  });
}

export type SendingReputation = {
  delivered: number;
  failed: number;
  spam: number;
  total: number;
  /** delivered / total as a 0–100 percentage (1 decimal); null with no sends. */
  rate: number | null;
};

// Same filters the Cloudflare dashboard's reputation widget uses: last event
// per message only, no NDRs, and only the three reputation-relevant outcomes.
const REP_FILTER = `isNDR:0,isLastEvent:1,sendingDomain:$domain,status_in:["delivered","deliveryFailed","spamRejection"]`;
const REP_7D_Q = `query($zoneTag:string!,$domain:string!,$start:Date!,$end:Date!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptiveGroups(limit:10000,filter:{${REP_FILTER},date_geq:$start,date_leq:$end}){
      count dimensions{ status }
    }
  }}
}`;
const REP_24H_Q = `query($zoneTag:string!,$domain:string!,$start:Time!,$end:Time!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptiveGroups(limit:10000,filter:{${REP_FILTER},datetimeHour_geq:$start,datetimeHour_leq:$end}){
      count dimensions{ status }
    }
  }}
}`;

function tallyReputation(rows: { count: number; dimensions: { status: string } }[]): SendingReputation {
  let delivered = 0,
    failed = 0,
    spam = 0;
  for (const row of rows) {
    if (row.dimensions.status === "delivered") delivered += row.count;
    else if (row.dimensions.status === "spamRejection") spam += row.count;
    else failed += row.count;
  }
  const total = delivered + failed + spam;
  return { delivered, failed, spam, total, rate: total ? Math.round((delivered / total) * 1000) / 10 : null };
}

/**
 * Domain sending reputation over the trailing 24h + 7d windows (the same
 * numbers the Cloudflare dashboard's reputation widget shows). Best-effort:
 * a failed window tallies as empty rather than erroring the page.
 */
export async function zoneSendingReputation(
  zoneId: string,
  domain: string,
): Promise<{ h24: SendingReputation; d7: SendingReputation }> {
  return memo(`reputation:${zoneId}:${domain}`, 300_000, async () => {
    type Res = {
      viewer: { zones: { emailSendingAdaptiveGroups: { count: number; dimensions: { status: string } }[] }[] };
    };
    const now = new Date();
    const day = (x: Date) => x.toISOString().slice(0, 10);
    const hour = (x: Date) => {
      const d = new Date(x);
      d.setUTCMinutes(0, 0, 0);
      return d.toISOString();
    };
    const [d7, h24] = await Promise.all([
      cfGraphql<Res>(REP_7D_Q, {
        zoneTag: zoneId,
        domain,
        start: day(new Date(now.getTime() - 7 * 864e5)),
        end: day(now),
      }),
      cfGraphql<Res>(REP_24H_Q, {
        zoneTag: zoneId,
        domain,
        start: hour(new Date(now.getTime() - 24 * 3600e3)),
        end: hour(now),
      }),
    ]);
    return {
      h24: tallyReputation(h24?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups ?? []),
      d7: tallyReputation(d7?.viewer?.zones?.[0]?.emailSendingAdaptiveGroups ?? []),
    };
  });
}

/** Per-zone sends today, summed from the analytics dataset (per-domain context
 * for the org overview). The account-wide daily limit lives in accountSendLimits. */
export async function zoneSendUsage(zoneId: string): Promise<{ today: number }> {
  return memo(`usage:${zoneId}`, 300_000, async () => {
    const rows = await zoneEmailAnalytics(zoneId, MAX_DAYS);
    const today = new Date().toISOString().slice(0, 10);
    let day = 0;
    for (const row of rows) if (row.date === today) day += row.count;
    return { today: day };
  });
}

export type SendLimits = {
  /** Emails allowed per `unit` window; null if Cloudflare didn't return it. */
  dailyLimit: number | null;
  unit: string | null;
  /** Sent in the current window. */
  sent: number | null;
  overQuota: boolean;
  /** When the window resets (ISO). */
  resetsAt: string | null;
};

/**
 * The account's live sending limit + usage, straight from Cloudflare
 * (`GET /accounts/{id}/email/sending/limits`). The daily quota is dynamic
 * (scales with reputation), so it's read live — never hardcoded. Account-scoped
 * (superadmin/dashboard). Unknown fields degrade to null, not a fabricated value.
 */
export async function accountSendLimits(): Promise<SendLimits> {
  return memo("acct-limits", 60_000, async () => {
    const unknown: SendLimits = { dailyLimit: null, unit: null, sent: null, overQuota: false, resetsAt: null };
    try {
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${APP_CLOUDFLARE_ACCOUNT_ID}/email/sending/limits`,
        { headers: { Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}` } },
      );
      const j = (await r.json()) as {
        result?: { quota?: { value?: number; unit?: string }; usage?: { sent?: number; over_quota?: boolean; resets_at?: string } };
      };
      if (!r.ok || !j.result) return unknown;
      const { quota, usage } = j.result;
      return {
        dailyLimit: typeof quota?.value === "number" ? quota.value : null,
        unit: quota?.unit ?? null,
        sent: typeof usage?.sent === "number" ? usage.sent : null,
        overQuota: !!usage?.over_quota,
        resetsAt: usage?.resets_at ?? null,
      };
    } catch (e) {
      console.error("[cf:limits] request failed", e);
      return unknown;
    }
  });
}

export type EmailEvent = {
  datetime: string | null;
  to: string | null;
  from: string | null;
  subject: string | null;
  status: string | null;
  errorCause: string | null;
  dkim: string | null;
  dmarc: string | null;
  spf: string | null;
};

// Individual-event dataset: recipient is `to` (a scalar); `envelopeTo` is a
// group dimension and comes back as an object on this dataset. Confirmed fields.
const EVENTS_Q = `query($zoneTag:string!,$start:Time!,$end:Time!){
  viewer{ zones(filter:{zoneTag:$zoneTag}){
    emailSendingAdaptive(filter:{datetime_geq:$start,datetime_leq:$end},limit:100,orderBy:[datetime_DESC]){
      datetime to from subject status errorCause dkim dmarc spf
    }
  }}
}`;

/** Individual outbound email events over the last `days` (up to 100, adaptively
 * sampled by Cloudflare) — the per-message delivery log. Every field is coerced
 * to a display string; CF returns some as objects/lists. */
export async function zoneEmailEvents(zoneId: string, days = 1): Promise<EmailEvent[]> {
  const d = clampDays(days);
  return memo(`events:${zoneId}:${d}`, 60_000, async () => {
    const data = await cfGraphql<{ viewer: { zones: { emailSendingAdaptive: Record<string, unknown>[] }[] } }>(
      EVENTS_Q,
      { zoneTag: zoneId, start: new Date(Date.now() - d * 864e5).toISOString(), end: new Date().toISOString() },
    );
    const rows = data?.viewer?.zones?.[0]?.emailSendingAdaptive ?? [];
    return rows.map((event) => ({
      datetime: str(event.datetime),
      to: str(event.to),
      from: str(event.from),
      subject: str(event.subject),
      status: str(event.status),
      errorCause: str(event.errorCause),
      dkim: str(event.dkim),
      dmarc: str(event.dmarc),
      spf: str(event.spf),
    }));
  });
}

export type AuditEntry = {
  id: string;
  when: string | null;
  action: string | null;
  ok: boolean;
  actor: string | null;
  resource: string | null;
};

/**
 * Recent account audit-log entries scoped to this zone (who changed what, when).
 * Account-scoped endpoint filtered by `zone.name` — Cloudflare's audit log is
 * per-account but every entry carries the zone it touched. Fields are read
 * tolerantly (v1/v2 differ on timestamp + shape) and coerced to display strings.
 */
export async function zoneAuditLogs(zoneName: string, days = 30): Promise<AuditEntry[]> {
  const d = clampDays(days);
  return memo(`audit:${zoneName}:${d}`, 60_000, async () => {
    try {
      const params = new URLSearchParams({
        since: new Date(Date.now() - d * 864e5).toISOString(),
        before: new Date().toISOString(),
        per_page: "50",
        "zone.name": zoneName,
      });
      const r = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${APP_CLOUDFLARE_ACCOUNT_ID}/audit_logs?${params}`,
        { headers: { Authorization: `Bearer ${APP_CLOUDFLARE_API_TOKEN}` } },
      );
      const j = (await r.json()) as { result?: Record<string, unknown>[]; errors?: Array<{ message?: string }> };
      if (!r.ok) {
        console.warn("[cf:audit]", r.status, j.errors?.map((auditError) => auditError.message).join("; "));
        return [];
      }
      return (j.result ?? []).map((entry, i) => {
        const action = entry.action as Record<string, unknown> | undefined;
        const actor = entry.actor as Record<string, unknown> | undefined;
        const resource = entry.resource as Record<string, unknown> | undefined;
        return {
          id: str(entry.id) ?? String(i),
          when: str(entry.when ?? entry.created_at ?? entry.timestamp),
          action: str(action?.type ?? entry.action),
          ok: action?.result !== false,
          actor: str(actor?.email ?? actor?.type ?? entry.actor),
          resource: str(resource?.type ?? resource?.id ?? entry.resource),
        };
      });
    } catch (e) {
      console.error("[cf:audit] request failed", e);
      return [];
    }
  });
}

/**
 * Run the full idempotent wire once a zone is active. Safe to re-run: every
 * step tolerates "already done". Returns the sending metadata (DKIM selector).
 */
export async function wireMail(
  zoneId: string,
  mailInWorkerName: string,
  domain: string,
): Promise<{ dkimSelector?: string; returnPathDomain?: string }> {
  const zone = await pollZoneStatus(zoneId);
  assertMailScope(domain, zone.name, MAIL_DOMAIN ?? '', MAIL_ROUTING_MODE ?? 'manual');
  if (zone.status !== 'active') throw new MailSetupError('The selected Cloudflare zone is not active.');
  if (domain === zone.name) {
    await writeDnsRecords(zoneId);
    await enableEmailRouting(zoneId);
    await createRoutingRule(zoneId, mailInWorkerName);
  } else {
    // Preflight existing policies before scoped routing enrollment. Never omit
    // the pilot name or attach an apex catch-all on this branch.
    await writeDnsRecords(zoneId, domain);
    await enablePilotEmailRouting(zoneId, domain);
  }
  return onboardSendingDomain(zoneId, domain);
}
