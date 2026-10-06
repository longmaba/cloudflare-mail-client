// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const env = { APP_CLOUDFLARE_ACCOUNT_ID: 'account', APP_CLOUDFLARE_API_TOKEN: 'token',
    MAIL_DOMAIN: 'pilot.example.com', MAIL_ROUTING_MODE: 'manual', MAIL_IN_WORKER_NAME: 'mail-in-pilot',
    MAIL_STAGING_DOMAIN: 'example.com', MAIL_MIGRATED_DOMAIN: '', MAIL_ZONE_NAME: 'example.com' };
  const api = {
    zones: { get: vi.fn() },
    dns: { records: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() } },
    emailRouting: { get: vi.fn(), enable: vi.fn(), dns: { get: vi.fn(), create: vi.fn() },
      rules: { create: vi.fn(), update: vi.fn(), catchAlls: { get: vi.fn(), update: vi.fn() } } },
    emailSending: { subdomains: { create: vi.fn(), list: vi.fn(), dns: { get: vi.fn() } } },
    get: vi.fn()
  };
  return { env, api };
});
vi.mock('$app/env/private', () => fixture.env);
vi.mock('cloudflare', () => ({ default: class { constructor() { return fixture.api; } } }));

import { createRoutingRule, enableEmailRouting, enablePilotEmailRouting, getRoutingConfig, inspectMigratedMail, onboardSendingDomain, wireMail } from '../lib/server/cloudflare.js';
import { setRecipientRouting } from '../lib/server/mail-routing.js';

type Dns = { id: string; type: string; name: string; content: string; priority?: number; ttl?: number };
const apex: Dns[] = [
  { id: 'google', type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1 },
  { id: 'spf-apex', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.google.com include:zoho.com ~all' },
  { id: 'dmarc-apex', type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject' },
  { id: 'dkim-apex', type: 'TXT', name: 'google._domainkey.example.com', content: 'v=DKIM1; p=old-key' },
  { id: 'dkim-cname-apex', type: 'CNAME', name: 'zoho._domainkey.example.com', content: 'zoho-key.provider.test' }
];
let records: Dns[];
const expected = [
  { type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 15, ttl: 1 },
  { type: 'MX', name: 'example.com', content: 'route2.mx.cloudflare.net', priority: 25, ttl: 1 },
  { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 }
];
const sendingExpected = [
  { type: 'MX', name: 'cf-bounce.pilot.example.com', content: 'route1.mx.cloudflare.net', priority: 24, ttl: 1 },
  { type: 'MX', name: 'cf-bounce.pilot.example.com', content: 'route2.mx.cloudflare.net', priority: 44, ttl: 1 },
  { type: 'MX', name: 'cf-bounce.pilot.example.com', content: 'route3.mx.cloudflare.net', priority: 27, ttl: 1 },
  { type: 'TXT', name: 'cf-bounce.pilot.example.com', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', ttl: 1 },
  { type: 'TXT', name: 'cf-bounce._domainkey.pilot.example.com', content: `"v=DKIM1; h=sha256; k=rsa; p=${'A'.repeat(392)}"`, ttl: 1 },
  { type: 'TXT', name: '_dmarc.pilot.example.com', content: '"v=DMARC1; p=reject;"', ttl: 1 }
];
const sendingIdentity = { name: 'pilot.example.com', enabled: true, tag: 'a'.repeat(32),
  dkim_selector: 'cf-bounce', return_path_domain: 'cf-bounce.pilot.example.com' };
const alreadySending = { status: 409, error: { errors: [{ code: 2040 }] } };
function rule(overrides = {}) {
  return { id: 'owned', name: 'cloudflare-mail-client:owner@pilot.example.com', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: 'owner@pilot.example.com' }],
    actions: [{ type: 'worker', value: ['mail-in-pilot'] }], ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.env.MAIL_DOMAIN = 'pilot.example.com';
  fixture.env.MAIL_ROUTING_MODE = 'manual';
  fixture.env.MAIL_STAGING_DOMAIN = 'example.com'; fixture.env.MAIL_MIGRATED_DOMAIN = ''; fixture.env.MAIL_ZONE_NAME = 'example.com';
  records = [...structuredClone(apex), ...sendingExpected.slice(0, 5).map((record, index) => ({ id: `sending-${index}`, ...record }))];
  fixture.api.zones.get.mockResolvedValue({ id: 'zone', name: 'example.com', status: 'active', account: { id: 'account' } });
  fixture.api.dns.records.list.mockImplementation((params) => ({
    async *[Symbol.asyncIterator]() {
      for (const record of records.filter(r => !params.name?.exact || r.name === params.name.exact)) yield record;
    }
  }));
  fixture.api.dns.records.create.mockImplementation(async (params) => {
    records.push({ id: `new-${records.length}`, ...params });
    return records.at(-1);
  });
  fixture.api.emailRouting.dns.get.mockResolvedValue({ success: true, result: expected });
  fixture.api.emailRouting.dns.create.mockResolvedValue({ name: 'pilot.example.com', enabled: true, status: 'ready' });
  fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'ready' });
  fixture.api.emailRouting.rules.catchAlls.get.mockResolvedValue({ enabled: false, actions: [] });
  fixture.api.emailSending.subdomains.create.mockImplementation(async ({ name }) => ({ name, enabled: true,
    tag: 'a'.repeat(32), dkim_selector: 'cf-bounce', return_path_domain: `cf-bounce.${name}` }));
  fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield sendingIdentity; } }));
  fixture.api.emailSending.subdomains.dns.get.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
    yield* sendingExpected;
  } }));
  fixture.api.get.mockResolvedValue({ result: [], result_info: { total_pages: 1 } });
});

describe('scoped DNS wiring', () => {
  it('creates only pilot MX/SPF and monitor DMARC, preserves every apex record, and resumes without duplicate DNS writes', async () => {
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.emailRouting.dns.get).toHaveBeenCalledWith({ zone_id: 'zone' });
    expect(fixture.api.emailRouting.dns.create).toHaveBeenCalledWith({ zone_id: 'zone', name: 'pilot.example.com' });
    expect(fixture.api.emailRouting.enable).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create.mock.calls.map(([r]) => r.name)).toEqual([
      'pilot.example.com', 'pilot.example.com', 'pilot.example.com', '_dmarc.pilot.example.com'
    ]);
    expect(fixture.api.emailSending.subdomains.create).toHaveBeenCalledWith({ zone_id: 'zone', name: 'pilot.example.com' });
    expect(records.slice(0, apex.length)).toEqual(apex);
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(4);
    expect(fixture.api.emailRouting.dns.create).toHaveBeenCalledTimes(2);
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it('refuses conflicting pilot MX before any mutation', async () => {
    records.push({ id: 'old-pilot', type: 'MX', name: 'pilot.example.com', content: 'mail.other.test' });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/existing MX/i);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('refuses another Cloudflare account even when the domain name matches', async () => {
    fixture.api.zones.get.mockResolvedValue({ id: 'other-zone', name: 'example.com', status: 'active', account: { id: 'other-account' } });
    await expect(wireMail('other-zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/different account/);
    expect(fixture.api.emailRouting.dns.get).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it('preserves an existing pilot SPF and DMARC that already authorize Cloudflare', async () => {
    records.push({ id: 'spf-pilot', type: 'TXT', name: 'pilot.example.com', content: 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all' },
      { id: 'dmarc-pilot', type: 'TXT', name: '_dmarc.pilot.example.com', content: 'v=DMARC1; p=reject; rua=mailto:admin@example.com' });
    const original = structuredClone(records);
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(records.slice(0, original.length)).toEqual(original);
    expect(fixture.api.dns.records.create.mock.calls.map(([r]) => r.type)).toEqual(['MX', 'MX']);
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
  });

  it('preserves a quoted operator SPF that already authorizes Cloudflare', async () => {
    const content = '"v=spf1 include:_spf.mx.cloudflare.net -all"';
    records.push({ id: 'quoted-spf', type: 'TXT', name: 'pilot.example.com', content });
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(records.find(record => record.id === 'quoted-spf')?.content).toBe(content);
    expect(records.filter(record => record.name === 'pilot.example.com' && record.type === 'TXT')).toHaveLength(1);
  });

  it.each([
    ['v=spf1 include:_spf.google.com ~all'],
    ['v=spf1 -all include:_spf.mx.cloudflare.net'],
    ['"v=spf1 include:_spf.google.com ~all"'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all', 'v=spf1 include:zoho.com ~all']
  ])('requires an operator SPF merge rather than replacing existing policies (%j)', async (...policies) => {
    for (const [index, content] of policies.entries()) records.push({ id: `spf-${index}`, type: 'TXT', name: 'pilot.example.com', content });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/SPF/);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
  });

  it.each([
    { result: undefined }, { result: { record: expected } },
    { result: [{ ...expected[0], name: 'foreign.test' }] },
    { result: [...expected, { type: 'TXT', name: 'selector._domainkey.example.com', content: 'v=DKIM1; p=key' }] }
  ])('rejects unsupported DNS previews before writes (%j)', async ({ result }) => {
    fixture.api.emailRouting.dns.get.mockResolvedValue({ success: true, result });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/DNS/);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each(['cf2024-1', 'cf2026-2'])('accepts the observed five-row quoted preview and leaves managed selector %s to service activation', async selector => {
    const managed = { type: 'TXT', name: `${selector}._domainkey.example.com`,
      content: `"v=DKIM1; h=sha256; k=rsa; p=${'A'.repeat(392)}"`, ttl: 1 };
    const preview = [
      { type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 24, ttl: 1 },
      { type: 'MX', name: 'example.com', content: 'route2.mx.cloudflare.net', priority: 44, ttl: 1 },
      { type: 'MX', name: 'example.com', content: 'route3.mx.cloudflare.net', priority: 27, ttl: 1 },
      managed,
      { type: 'TXT', name: 'example.com', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', ttl: 1 }
    ];
    fixture.api.emailRouting.dns.get.mockResolvedValue({ success: true, result: preview });
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.dns.records.create.mock.calls.map(([record]) => record.name)).toEqual([
      'pilot.example.com', 'pilot.example.com', 'pilot.example.com', 'pilot.example.com', '_dmarc.pilot.example.com'
    ]);
    expect(records.slice(0, apex.length)).toEqual(apex);
    expect(records.some(record => record.name === managed.name)).toBe(false);
    expect(fixture.api.emailRouting.dns.create).toHaveBeenCalledWith({ zone_id: 'zone', name: 'pilot.example.com' });
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(5);
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'cf2024-1._domainkey.foreign.test', content: 'v=DKIM1; h=sha256; k=rsa; p=AAAA' },
    { name: 'cf2024-1._domainkey.pilot.example.com', content: 'v=DKIM1; h=sha256; k=rsa; p=AAAA' },
    { name: 'selector._domainkey.example.com', content: 'v=DKIM1; h=sha256; k=rsa; p=AAAA' },
    { name: 'cf2024-1._domainkey.example.com', content: '' },
    { name: 'cf2024-1._domainkey.example.com', content: '"v=DKIM1; h=sha256; k=rsa; p="' },
    { name: 'cf2024-1._domainkey.example.com', content: 'v=DKIM1; h=sha256; k=rsa; p=not-a-key' },
    { name: 'cf2024-1._domainkey.example.com', content: 'v=DKIM1; k=rsa; p=AAAA; p=BBBB' },
    { name: 'cf2024-1._domainkey.example.com', content: '"v=DKIM1; k=rsa; p=AAAA' },
    { name: 'cf2024-1._domainkey.example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }
  ])('rejects unexpected or malformed shared DKIM preview rows before any write (%j)', async row => {
    fixture.api.emailRouting.dns.get.mockResolvedValue({ success: true, result: [...expected, { type: 'TXT', ttl: 1, ...row }] });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/DNS/);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('propagates DNS failures and never falls back to whole-zone enable', async () => {
    fixture.api.dns.records.create.mockRejectedValue(new Error('DNS permission denied'));
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow('DNS permission denied');
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.enable).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('resumes a partially written DNS plan without replacing the successful records', async () => {
    const create = fixture.api.dns.records.create.getMockImplementation()!;
    fixture.api.dns.records.create.mockImplementationOnce(create).mockRejectedValueOnce(new Error('temporary API failure'));
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow('temporary API failure');
    const first = structuredClone(records.at(-1));
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(records.filter(record => record.name === 'pilot.example.com' && record.type === 'MX')).toHaveLength(2);
    expect(records).toContainEqual(first);
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it('does not swallow a DNS conflict unless the exact required record now exists', async () => {
    fixture.api.dns.records.create.mockRejectedValue({ status: 409 });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toMatchObject({ status: 409 });
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('refuses a delegated or aliased selected domain before writes', async () => {
    records.push({ id: 'delegated', type: 'NS', name: 'pilot.example.com', content: 'other.nameserver.test' });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/aliased or delegated/);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it('does not expose native bounce MX as a selectable mail subdomain', async () => {
    records.push({ id: 'bounce', type: 'MX', name: 'cf-bounce.pilot.example.com', content: 'route1.mx.cloudflare.net' });
    expect((await getRoutingConfig('zone', 'pilot.example.com')).subdomains).toEqual([]);
  });
});

describe('explicit pilot routing activation', () => {
  it('serializes the full pilot name in the SDK request body', async () => {
    const { default: ActualCloudflare } = await vi.importActual<typeof import('cloudflare')>('cloudflare');
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ success: true, result: {
      id: 'routing', name: 'pilot.example.com', enabled: true, status: 'ready'
    } }), { headers: { 'content-type': 'application/json' } }));
    const client = new ActualCloudflare({ apiToken: 'fixture-only-token', fetch: fetcher });
    await client.emailRouting.dns.create({ zone_id: 'zone', name: 'pilot.example.com' });
    const request = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(new URL(request[0]).pathname).toBe('/client/v4/zones/zone/email/routing/dns');
    expect(request[1].method).toBe('POST');
    expect(JSON.parse(request[1].body as string)).toEqual({ name: 'pilot.example.com' });
  });

  it.each(['', ' ', 'example.com', 'other.example.com', 'pilot.foreign.test', 'pilot.badexample.com'])
    ('rejects an absent, apex or unselected activation name before writes (%j)', async (name) => {
      await expect(enablePilotEmailRouting('zone', name)).rejects.toThrow();
      expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
      expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
      expect(fixture.api.emailRouting.enable).not.toHaveBeenCalled();
      expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
    });

  it('rejects the apex even when explicitly configured for migration', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    fixture.env.MAIL_ROUTING_MODE = 'apex';
    await expect(enablePilotEmailRouting('zone', 'example.com')).rejects.toThrow(/subdomain/i);
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
  });

  it('rejects a configured domain outside the selected zone', async () => {
    fixture.env.MAIL_DOMAIN = 'pilot.foreign.test';
    await expect(enablePilotEmailRouting('zone', 'pilot.foreign.test')).rejects.toThrow(/outside/i);
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
  });

  it.each([409, 422])('does not swallow routing activation HTTP %s', async status => {
    fixture.api.emailRouting.dns.create.mockRejectedValue({ status });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toMatchObject({ status });
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
    expect(records.slice(0, apex.length)).toEqual(apex);
  });

  it.each([
    { name: 'example.com', enabled: true, status: 'ready' },
    { name: 'pilot.example.com', enabled: false, status: 'ready' },
    { name: 'pilot.example.com', enabled: true, status: 'misconfigured' },
    undefined
  ])('does not claim activation without scoped server confirmation (%j)', async result => {
    fixture.api.emailRouting.dns.create.mockResolvedValue(result);
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/confirm.*pilot/i);
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it.each(['google', 'spf-apex', 'dmarc-apex', 'dkim-apex', 'dkim-cname-apex'])
    ('blocks sending onboarding when activation changes protected apex record %s', async id => {
      fixture.api.emailRouting.dns.create.mockImplementation(async () => {
        records.find(record => record.id === id)!.content = 'unexpected-provider-change';
        return { name: 'pilot.example.com', enabled: true, status: 'ready' };
      });
      await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/apex.*changed/i);
      expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
      expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
      expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
    });

  it('permits a new Cloudflare parent DKIM selector while preserving all preexisting provider records', async () => {
    fixture.api.emailRouting.dns.create.mockImplementation(async () => {
      if (!records.some(record => record.id === 'new-routing-dkim')) records.push({
        id: 'new-routing-dkim', type: 'TXT', name: 'cf2024-1._domainkey.example.com', content: 'v=DKIM1; p=fixture'
      });
      return { name: 'pilot.example.com', enabled: true, status: 'ready' };
    });
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(records.slice(0, apex.length)).toEqual(apex);
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(records.slice(0, apex.length)).toEqual(apex);
    expect(fixture.api.emailRouting.dns.create.mock.calls.every(([params]) => params.name === 'pilot.example.com')).toBe(true);
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
  });

  it('rejects an additional apex MX instead of accepting enrollment success', async () => {
    fixture.api.emailRouting.dns.create.mockImplementation(async () => {
      records.push({ id: 'unexpected-apex-mx', type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net' });
      return { name: 'pilot.example.com', enabled: true, status: 'ready' };
    });
    await expect(wireMail('zone', 'mail-in-pilot', 'pilot.example.com')).rejects.toThrow(/apex.*changed/i);
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });
});

describe('provider-supplied sending DNS', () => {
  beforeEach(() => { records = structuredClone(apex); });

  it('resumes provider 409/code 2040 only after refetching the exact enabled identity, then reruns without writes', async () => {
    fixture.api.emailSending.subdomains.create.mockRejectedValue(alreadySending);
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'foreign.example.com' };
      yield sendingIdentity;
    } }));
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(fixture.api.emailSending.subdomains.list).toHaveBeenCalledWith({ zone_id: 'zone' });
    expect(fixture.api.emailSending.subdomains.dns.get).toHaveBeenCalledWith(sendingIdentity.tag, { zone_id: 'zone' });
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(6);
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(6);
  });

  it.each([
    { status: 409 }, { status: 409, error: { errors: [{ code: 2007 }] } },
    { status: 422, error: { errors: [{ code: 2040 }] } },
    { status: 409, error: { errors: [{ code: 2040 }, { code: 2007 }] } },
    { status: 409, errors: [{ code: 2040 }] }
  ])('propagates an unrecognized registration conflict without fallback (%j)', async error => {
    fixture.api.emailSending.subdomains.create.mockRejectedValue(error);
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toMatchObject(error);
    expect(fixture.api.emailSending.subdomains.list).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.dns.get).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each([
    [], [{ ...sendingIdentity, name: 'foreign.example.com' }],
    [sendingIdentity, sendingIdentity], [{ ...sendingIdentity, enabled: false }],
    [{ ...sendingIdentity, tag: 'missing' }], [{ ...sendingIdentity, dkim_selector: 'foreign.example.com' }],
    [{ ...sendingIdentity, return_path_domain: 'cf-bounce.example.com' }]
  ].map(identities => ({ identities })))('rejects an unverifiable existing sending identity without DNS writes (%j)', async ({ identities }) => {
    fixture.api.emailSending.subdomains.create.mockRejectedValue(alreadySending);
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield* identities; } }));
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/sending/i);
    expect(fixture.api.emailSending.subdomains.dns.get).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it('propagates a failed existing-domain lookup without DNS writes', async () => {
    fixture.api.emailSending.subdomains.create.mockRejectedValue(alreadySending);
    const error = { status: 503 };
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { throw error; } }));
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toMatchObject(error);
    expect(fixture.api.emailSending.subdomains.dns.get).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it('creates the observed six-row sending preview with fresh monitor DMARC, and reruns without writes', async () => {
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(fixture.api.emailSending.subdomains.dns.get).toHaveBeenCalledWith('a'.repeat(32), { zone_id: 'zone' });
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(6);
    expect(records.slice(0, apex.length)).toEqual(apex);
    expect(records.find(record => record.name === '_dmarc.pilot.example.com')?.content).toBe('v=DMARC1; p=none');
    expect(records.find(record => record.name === 'cf-bounce._domainkey.pilot.example.com')?.content).toBe(sendingExpected[4].content);
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(6);
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it('preserves preexisting monitor DMARC bytes and a merged quoted bounce SPF', async () => {
    const dmarc = { id: 'monitor', type: 'TXT', name: '_dmarc.pilot.example.com', content: '"v=DMARC1; p=none; rua=mailto:owner@pilot.example.com"' };
    const spf = { id: 'merged', type: 'TXT', name: 'cf-bounce.pilot.example.com', content: '"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all"' };
    records.push(dmarc, spf);
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(records).toContainEqual(dmarc);
    expect(records).toContainEqual(spf);
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(4);
  });

  it('preserves the observed 255/165-character DKIM chunks as equivalent to the single-string provider preview', async () => {
    const value = sendingExpected[4].content.slice(1, -1);
    const stored = `"${value.slice(0, 255)}" "${value.slice(255)}"`;
    records.push(...sendingExpected.map((record, index) => ({ id: `existing-${index}`, ...record,
      content: index === 4 ? stored : index === 5 ? 'v=DMARC1; p=none' : record.content })));
    const before = structuredClone(records);
    expect(sendingExpected[4].content).toHaveLength(422);
    expect(stored).toHaveLength(425);
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it('accepts equivalent DKIM chunks in the provider preview and verifies a concurrent normalized create', async () => {
    const value = sendingExpected[4].content.slice(1, -1);
    const stored = `"${value.slice(0, 255)}" "${value.slice(255)}"`;
    fixture.api.emailSending.subdomains.dns.get.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield* sendingExpected.map((record, index) => index === 4 ? { ...record, content: stored } : record);
    } }));
    const create = fixture.api.dns.records.create.getMockImplementation()!;
    fixture.api.dns.records.create.mockImplementation(async params => {
      if (params.name === sendingExpected[4].name) {
        await create({ ...params, content: sendingExpected[4].content });
        throw { status: 409 };
      }
      return create(params);
    });
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(records).toHaveLength(apex.length + 6);
  });

  it.each(['different-key', 'case-changed-key', 'escaped', 'unterminated', 'unquoted-suffix', 'unquoted-prefix', 'no-separator'])('rejects %s DKIM without changing occupied records', async presentation => {
    const value = sendingExpected[4].content.slice(1, -1);
    const first = value.slice(0, 255);
    const last = value.slice(255);
    const content = presentation === 'different-key' ? `"${first}" "B${last.slice(1)}"` :
      presentation === 'case-changed-key' ? `"${first}" "a${last.slice(1)}"` :
      presentation === 'escaped' ? `"${first}" "\\065${last}"` :
      presentation === 'unterminated' ? `"${first}" "${last}` :
      presentation === 'unquoted-suffix' ? `"${first}" ${last}` :
      presentation === 'unquoted-prefix' ? `${first} "${last}"` : `"${first}""${last}"`;
    records.push({ id: 'occupied-dkim', type: 'TXT', name: sendingExpected[4].name, content });
    const before = structuredClone(records);
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/DKIM conflicts/i);
    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'MX', name: 'cf-bounce.pilot.example.com', content: 'old-provider.test' },
    { type: 'TXT', name: 'cf-bounce.pilot.example.com', content: 'v=spf1 include:_spf.google.com -all' },
    { type: 'TXT', name: 'cf-bounce._domainkey.pilot.example.com', content: 'v=DKIM1; k=rsa; p=BBBB' },
    { type: 'CNAME', name: 'cf-bounce._domainkey.pilot.example.com', content: 'old-provider.test' },
    { type: 'NS', name: 'cf-bounce.pilot.example.com', content: 'old-provider.test' },
    { type: 'TXT', name: '_dmarc.pilot.example.com', content: 'unrelated-policy' },
    { type: 'TXT', name: '_dmarc.pilot.example.com', content: 'v=DMARC1; p=none; p=reject' }
  ])('preserves conflicting occupied sending names and blocks all DNS writes (%j)', async record => {
    records.push({ id: 'occupied', ...record });
    const before = structuredClone(records);
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/conflict|aliased|delegated/i);
    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each([
    ['"v=spf1 include:_spf.mx.cloudflare.net ~all'],
    ['"v=spf1 include:_spf.mx.cloudflare.net" "~all"'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all', '"v=spf1 include:_spf.mx.cloudflare.net ~all"']
  ].map(policies => ({ policies })))('rejects malformed or duplicate bounce SPF before all writes (%j)', async ({ policies }) => {
    records.push(...policies.map((content, index) => ({ id: `spf-${index}`, type: 'TXT', name: 'cf-bounce.pilot.example.com', content })));
    const before = structuredClone(records);
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/SPF conflict/i);
    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each([
    { tag: undefined }, { name: 'foreign.test' }, { enabled: false },
    { return_path_domain: 'cf-bounce.example.com' }, { dkim_selector: 'foreign.example.com' }
  ])('rejects incomplete or foreign sending registration metadata before DNS writes (%j)', async override => {
    fixture.api.emailSending.subdomains.create.mockResolvedValue({ name: 'pilot.example.com', enabled: true,
      tag: 'a'.repeat(32), dkim_selector: 'cf-bounce', return_path_domain: 'cf-bounce.pilot.example.com', ...override });
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/sending/i);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each([
    [], sendingExpected.slice(0, 4),
    [...sendingExpected, { type: 'TXT', name: 'google._domainkey.example.com', content: 'v=DKIM1; k=rsa; p=AAAA' }],
    [{ ...sendingExpected[0], name: 'cf-bounce.foreign.test' }, ...sendingExpected.slice(1)],
    [{ ...sendingExpected[0], type: 'A' }, ...sendingExpected.slice(1)],
    [...sendingExpected.slice(0, 4), { ...sendingExpected[4], content: 'malformed-DKIM' }, sendingExpected[5]]
  ].map(preview => ({ preview })))('rejects unsupported provider sending DNS before writes (%j)', async ({ preview }) => {
    fixture.api.emailSending.subdomains.dns.get.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { yield* preview; } }));
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toThrow(/sending/i);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it.each(['registration', 'preview', 'write'])('propagates %s API errors without false readiness', async stage => {
    const error = { status: 403 };
    if (stage === 'registration') fixture.api.emailSending.subdomains.create.mockRejectedValue(error);
    if (stage === 'preview') fixture.api.emailSending.subdomains.dns.get.mockImplementation(() => ({ async *[Symbol.asyncIterator]() { throw error; } }));
    if (stage === 'write') fixture.api.dns.records.create.mockRejectedValue(error);
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toMatchObject(error);
    expect(records).toEqual(apex);
  });

  it.each([409, 422])('does not swallow DNS write status %s when no matching record exists', async status => {
    fixture.api.dns.records.create.mockRejectedValue({ status });
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toMatchObject({ status });
    expect(records).toEqual(apex);
  });

  it('accepts a concurrent DNS conflict only after verifying the exact provider requirement', async () => {
    const create = fixture.api.dns.records.create.getMockImplementation()!;
    fixture.api.dns.records.create.mockImplementationOnce(async params => {
      await create(params);
      throw { status: 409 };
    });
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(records).toHaveLength(apex.length + 6);
  });

  it('resumes a partially applied sending plan without duplicating or replacing successful records', async () => {
    const create = fixture.api.dns.records.create.getMockImplementation()!;
    fixture.api.dns.records.create.mockImplementationOnce(create).mockRejectedValueOnce({ status: 503 });
    await expect(onboardSendingDomain('zone', 'pilot.example.com')).rejects.toMatchObject({ status: 503 });
    const successful = structuredClone(records.at(-1));
    await onboardSendingDomain('zone', 'pilot.example.com');
    expect(records).toContainEqual(successful);
    expect(records.filter(record => record.name === 'cf-bounce.pilot.example.com' && record.type === 'MX')).toHaveLength(3);
    expect(records).toHaveLength(apex.length + 6);
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });
});

for (const flow of ['routing', 'sending'] as const) describe(`${flow} SPF version-boundary conflicts`, () => {
  beforeEach(() => { records = structuredClone(apex); });

  it.each([
    ['"v=spf1" " include:_spf.mx.cloudflare.net ~all"'],
    ['"v=spf1\\032include:_spf.mx.cloudflare.net ~all"'],
    ['v=spf1\\ include:_spf.mx.cloudflare.net ~all'],
    ['v=spf1 include:_spf.mx.cloudflare.net "\\032~all"'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all"'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all', '"v=spf1" " include:_spf.mx.cloudflare.net ~all"']
  ].map(policies => ({ policies })))('preserves ambiguous or duplicate policy bytes and blocks every DNS write (%j)', async ({ policies }) => {
    const name = flow === 'routing' ? 'pilot.example.com' : 'cf-bounce.pilot.example.com';
    records.push(...policies.map((content, index) => ({ id: `ambiguous-spf-${index}`, type: 'TXT', name, content })));
    const before = structuredClone(records);
    const operation = flow === 'routing' ? wireMail('zone', 'mail-in-pilot', 'pilot.example.com') : onboardSendingDomain('zone', 'pilot.example.com');
    await expect(operation).rejects.toThrow(/SPF/i);
    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });
});

describe('recipient routing ownership', () => {
  it('creates an exact worker rule once and does not rewrite a matching enabled rule', async () => {
    await setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', true);
    expect(fixture.api.emailRouting.rules.create).toHaveBeenCalledWith(expect.objectContaining({
      matchers: rule().matchers, actions: rule().actions, enabled: true
    }));
    fixture.api.get.mockResolvedValue({ result: [rule()], result_info: { total_pages: 1 } });
    await setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', true);
    expect(fixture.api.emailRouting.rules.create).toHaveBeenCalledTimes(1);
    expect(fixture.api.emailRouting.rules.update).not.toHaveBeenCalled();
  });

  it.each([
    rule({ name: 'operator rule' }),
    rule({ actions: [{ type: 'worker', value: ['other-instance'] }] }),
    rule({ actions: [{ type: 'forward', value: ['private@example.net'] }] }),
    rule({ source: 'wrangler' }),
    rule({ matchers: [...rule().matchers, { type: 'literal', field: 'to', value: 'other@pilot.example.com' }] })
  ])('refuses an existing operator or different-instance rule (%j)', async (existing) => {
    fixture.api.get.mockResolvedValue({ result: [existing] });
    await expect(setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', false)).rejects.toThrow(/existing routing rule/i);
    expect(fixture.api.emailRouting.rules.update).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.create).not.toHaveBeenCalled();
  });

  it('checks later REST pages for conflicting rules', async () => {
    fixture.api.get.mockResolvedValueOnce({ result: [], result_info: { total_pages: 2 } })
      .mockResolvedValueOnce({ result: [rule({ name: 'operator' })], result_info: { total_pages: 2 } });
    await expect(setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', true)).rejects.toThrow(/existing routing rule/i);
    expect(fixture.api.get.mock.calls[1][1]).toEqual({ query: { page: 2, per_page: 50 } });
  });

  it('continues a full page when optional pagination metadata is absent', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => rule({ matchers: [{ type: 'literal', field: 'to', value: `other-${i}@pilot.example.com` }] }));
    fixture.api.get.mockResolvedValueOnce({ result: fullPage })
      .mockResolvedValueOnce({ result: [rule({ name: 'operator' })] });
    await expect(setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', true)).rejects.toThrow(/existing routing rule/i);
    expect(fixture.api.emailRouting.rules.create).not.toHaveBeenCalled();
  });

  it('updates only the enabled state of an owned rule and propagates missing-worker errors', async () => {
    fixture.api.get.mockResolvedValue({ result: [rule()] });
    fixture.api.emailRouting.rules.update.mockRejectedValue({ status: 404, errors: [{ code: 2016 }] });
    await expect(setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', false)).rejects.toMatchObject({ status: 404 });
    expect(fixture.api.emailRouting.rules.update).toHaveBeenCalledWith('owned', expect.objectContaining({ enabled: false }));
  });

  it('preserves the owned rule priority when toggling its state', async () => {
    fixture.api.get.mockResolvedValue({ result: [rule({ priority: 23 })] });
    await setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', false);
    expect(fixture.api.emailRouting.rules.update).toHaveBeenCalledWith('owned', expect.objectContaining({ priority: 23, enabled: false }));
  });

  it('rejects off-domain addresses before accessing Cloudflare', async () => {
    await expect(setRecipientRouting('zone', 'pilot.example.com', 'owner@example.com', true)).rejects.toThrow(/Recipient/);
    expect(fixture.api.get).not.toHaveBeenCalled();
  });
});

describe('completed migration scope', () => {
  it('maintains exact apex recipients and the pilot without enabling zone-wide routing', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    await setRecipientRouting('zone', 'example.com', 'owner@example.com', true);
    await setRecipientRouting('zone', 'pilot.example.com', 'owner@pilot.example.com', true);
    expect(fixture.api.emailRouting.rules.create.mock.calls.map(([record]) => record.matchers[0].value)).toEqual([
      'owner@example.com', 'owner@pilot.example.com',
    ]);
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
  });

  it.each(['MAIL_MIGRATED_DOMAIN', 'MAIL_STAGING_DOMAIN', 'MAIL_ZONE_NAME'] as const)
    ('rejects apex recipient maintenance when %s differs', async (binding) => {
      fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com'; fixture.env[binding] = 'foreign.test';
      await expect(setRecipientRouting('zone', 'example.com', 'owner@example.com', true)).rejects.toThrow(/outside/);
      expect(fixture.api.emailRouting.rules.create).not.toHaveBeenCalled();
      expect(fixture.api.emailRouting.rules.update).not.toHaveBeenCalled();
    });

  it('keeps normal apex wiring, routing enablement and catch-all attachment unavailable after a cutover', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    await expect(wireMail('zone', 'mail-in-pilot', 'example.com')).rejects.toThrow(/outside/);
    await expect(enableEmailRouting('zone')).rejects.toThrow(/outside/);
    await expect(createRoutingRule('zone', 'mail-in-pilot')).rejects.toThrow(/outside/);
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
  });

  it('reads migrated settings and validates the exact apex sending identity without provider mutations', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield sendingIdentity;
      yield { ...sendingIdentity, name: 'example.com', return_path_domain: 'cf-bounce.example.com' };
    } }));
    expect(await getRoutingConfig('zone', 'example.com')).toMatchObject({ enabled: true, status: 'ready', subdomains: [] });
    await inspectMigratedMail('zone', 'example.com');
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.update).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('does not accept the enabled pilot as evidence of migrated apex sending readiness', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/not ready/);
  });

  it('accepts unlocked migrated routing only with exact receiving MX and a merged authorized SPF', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'unlocked' });
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'example.com' };
    } }));
    records = expected.map((record, index) => ({ id: `migrated-${index}`, ...record }));
    records.find(record => record.type === 'TXT')!.content = '"v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all"';
    const before = structuredClone(records);
    await inspectMigratedMail('zone', 'example.com');
    expect(records).toEqual(before);
    expect(fixture.api.emailRouting.dns.get).toHaveBeenCalledWith({ zone_id: 'zone' });
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it.each(['proxied apex CNAME', 'DNS-only apex CNAME', 'authoritative apex NS'])('preserves %s while inspecting unlocked migrated mail', async (recordType) => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'unlocked' });
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'example.com' };
    } }));
    const unrelated = recordType === 'authoritative apex NS'
      ? { id: 'apex-ns', type: 'NS', name: 'example.com', content: 'ns.cloudflare.com' }
      : { id: 'apex-website', type: 'CNAME', name: 'example.com', content: 'website.onrender.com',
        proxied: recordType === 'proxied apex CNAME', settings: { flatten_cname: false } };
    records = [...expected.map((record, index) => ({ id: `migrated-${index}`, ...record })), unrelated];
    const before = structuredClone(records);

    await inspectMigratedMail('zone', 'example.com');

    expect(records).toEqual(before);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it.each(['provider MX', 'wrong priority', 'missing MX', 'duplicate MX', 'unauthorized SPF', 'duplicate SPF', 'terminal before include', 'denied include'])('rejects unlocked migrated DNS drift: %s', async (drift) => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'unlocked' });
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'example.com' };
    } }));
    records = expected.map((record, index) => ({ id: `migrated-${index}`, ...record }));
    if (drift === 'provider MX') records[0].content = 'aspmx.l.google.com';
    if (drift === 'wrong priority') records[0].priority = 99;
    if (drift === 'missing MX') records.shift();
    if (drift === 'duplicate MX') records.push({ ...records[0], id: 'duplicate-mx' });
    if (drift === 'unauthorized SPF') records.find(record => record.type === 'TXT')!.content = 'v=spf1 include:_spf.google.com ~all';
    if (drift === 'duplicate SPF') records.push({ ...records.find(record => record.type === 'TXT')!, id: 'duplicate-spf' });
    if (drift === 'terminal before include') records.find(record => record.type === 'TXT')!.content = 'v=spf1 -all include:_spf.mx.cloudflare.net';
    if (drift === 'denied include') records.find(record => record.type === 'TXT')!.content = 'v=spf1 -include:_spf.mx.cloudflare.net include:_spf.mx.cloudflare.net ~all';
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/MX\/SPF/);
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.delete).not.toHaveBeenCalled();
  });

  it('keeps unlocked routing outside the configured migrated apex', async () => {
    fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'unlocked' });
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/installed active/);
    expect(fixture.api.emailRouting.dns.get).not.toHaveBeenCalled();
  });

  it.each(['disabled', 'duplicate'])('rejects %s migrated sending registrations', async (state) => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'example.com', enabled: state !== 'disabled' };
      if (state === 'duplicate') yield { ...sendingIdentity, name: 'example.com' };
    } }));
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/not ready/);
  });

  it('rejects unready routing even when the exact apex sending registration is enabled', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.emailSending.subdomains.list.mockImplementation(() => ({ async *[Symbol.asyncIterator]() {
      yield { ...sendingIdentity, name: 'example.com' };
    } }));
    fixture.api.emailRouting.get.mockResolvedValueOnce({ enabled: false, status: 'ready' });
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/not ready/);
  });

  it('rejects migrated reads outside the actual installed zone', async () => {
    fixture.env.MAIL_MIGRATED_DOMAIN = 'example.com';
    fixture.api.zones.get.mockResolvedValue({ id: 'zone', name: 'foreign.test', status: 'active', account: { id: 'account' } });
    await expect(getRoutingConfig('zone', 'example.com')).rejects.toThrow(/outside/);
    await expect(inspectMigratedMail('zone', 'example.com')).rejects.toThrow(/installed active/);
    expect(fixture.api.emailRouting.get).not.toHaveBeenCalled();
    expect(fixture.api.emailSending.subdomains.list).not.toHaveBeenCalled();
  });
});

describe('apex catch-all activation', () => {
  it('propagates a missing worker instead of reporting activation success', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    fixture.env.MAIL_ROUTING_MODE = 'apex';
    fixture.api.emailRouting.rules.catchAlls.update.mockRejectedValue({ status: 404, errors: [{ code: 2016 }] });
    await expect(createRoutingRule('zone', 'mail-in-pilot')).rejects.toMatchObject({ status: 404 });
  });

  it('blocks full apex activation and sending onboarding when catch-all attachment fails', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    fixture.env.MAIL_ROUTING_MODE = 'apex';
    records = [];
    fixture.api.emailRouting.rules.catchAlls.update.mockRejectedValue({ status: 404, errors: [{ code: 2016 }] });
    await expect(wireMail('zone', 'mail-in-pilot', 'example.com')).rejects.toMatchObject({ status: 404 });
    expect(fixture.api.emailSending.subdomains.create).not.toHaveBeenCalled();
  });

  it('blocks apex wiring before any DNS write when migration mode is absent', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    await expect(wireMail('zone', 'mail-in-pilot', 'example.com')).rejects.toThrow(/Pilot mode/);
    expect(fixture.api.emailRouting.dns.get).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
  });

  it('preserves the catch-all when its current state cannot be read', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    fixture.env.MAIL_ROUTING_MODE = 'apex';
    fixture.api.emailRouting.rules.catchAlls.get.mockRejectedValue({ status: 403 });
    await expect(createRoutingRule('zone', 'mail-in-pilot')).rejects.toMatchObject({ status: 403 });
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
  });

  it('refuses to replace an enabled operator catch-all', async () => {
    fixture.env.MAIL_DOMAIN = 'example.com';
    fixture.env.MAIL_ROUTING_MODE = 'apex';
    fixture.api.emailRouting.rules.catchAlls.get.mockResolvedValue({ enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'forward', value: ['old@example.net'] }] });
    await expect(createRoutingRule('zone', 'mail-in-pilot')).rejects.toThrow(/catch-all/i);
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
  });
});
