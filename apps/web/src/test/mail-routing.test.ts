// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => {
  const env = { APP_CLOUDFLARE_ACCOUNT_ID: 'account', APP_CLOUDFLARE_API_TOKEN: 'token',
    MAIL_DOMAIN: 'pilot.example.com', MAIL_ROUTING_MODE: 'manual', MAIL_IN_WORKER_NAME: 'mail-in-pilot' };
  const api = {
    zones: { get: vi.fn() },
    dns: { records: { list: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() } },
    emailRouting: { get: vi.fn(), enable: vi.fn(), dns: { get: vi.fn(), create: vi.fn() },
      rules: { create: vi.fn(), update: vi.fn(), catchAlls: { get: vi.fn(), update: vi.fn() } } },
    emailSending: { subdomains: { create: vi.fn() } },
    get: vi.fn()
  };
  return { env, api };
});
vi.mock('$app/env/private', () => fixture.env);
vi.mock('cloudflare', () => ({ default: class { constructor() { return fixture.api; } } }));

import { createRoutingRule, getRoutingConfig, wireMail } from '../lib/server/cloudflare.js';
import { setRecipientRouting } from '../lib/server/mail-routing.js';

type Dns = { id: string; type: string; name: string; content: string; priority?: number; ttl?: number };
const apex: Dns[] = [
  { id: 'google', type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1 },
  { id: 'spf-apex', type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.google.com include:zoho.com ~all' },
  { id: 'dmarc-apex', type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject' },
  { id: 'dkim-apex', type: 'TXT', name: 'google._domainkey.example.com', content: 'v=DKIM1; p=old-key' }
];
let records: Dns[];
const expected = [
  { type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net', priority: 15, ttl: 1 },
  { type: 'MX', name: 'example.com', content: 'route2.mx.cloudflare.net', priority: 25, ttl: 1 },
  { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 }
];
function rule(overrides = {}) {
  return { id: 'owned', name: 'cloudflare-mail-client:owner@pilot.example.com', enabled: true,
    matchers: [{ type: 'literal', field: 'to', value: 'owner@pilot.example.com' }],
    actions: [{ type: 'worker', value: ['mail-in-pilot'] }], ...overrides };
}

beforeEach(() => {
  vi.resetAllMocks();
  fixture.env.MAIL_DOMAIN = 'pilot.example.com';
  fixture.env.MAIL_ROUTING_MODE = 'manual';
  records = structuredClone(apex);
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
  fixture.api.emailRouting.get.mockResolvedValue({ enabled: true, status: 'ready' });
  fixture.api.emailRouting.rules.catchAlls.get.mockResolvedValue({ enabled: false, actions: [] });
  fixture.api.emailSending.subdomains.create.mockResolvedValue({ return_path_domain: 'cf-bounce.pilot.example.com' });
  fixture.api.get.mockResolvedValue({ result: [], result_info: { total_pages: 1 } });
});

describe('scoped DNS wiring', () => {
  it('creates only pilot MX/SPF and monitor DMARC, preserves every apex record, and resumes without duplicate DNS writes', async () => {
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.emailRouting.dns.get).toHaveBeenCalledWith({ zone_id: 'zone' });
    expect(fixture.api.emailRouting.dns.create).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.enable).not.toHaveBeenCalled();
    expect(fixture.api.emailRouting.rules.catchAlls.update).not.toHaveBeenCalled();
    expect(fixture.api.dns.records.create.mock.calls.map(([r]) => r.name)).toEqual([
      'pilot.example.com', 'pilot.example.com', 'pilot.example.com', '_dmarc.pilot.example.com'
    ]);
    expect(fixture.api.emailSending.subdomains.create).toHaveBeenCalledWith({ zone_id: 'zone', name: 'pilot.example.com' });
    expect(records.slice(0, apex.length)).toEqual(apex);
    await wireMail('zone', 'mail-in-pilot', 'pilot.example.com');
    expect(fixture.api.dns.records.create).toHaveBeenCalledTimes(4);
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
