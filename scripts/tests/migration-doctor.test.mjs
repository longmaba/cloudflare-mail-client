// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectInstance, inspectRecipientRouting } from '../lib/doctor.mjs';
import { resourceNames } from '../lib/instance.mjs';

const deploymentToken = 'synthetic-migration-deploy-token';
const runtimeToken = 'synthetic-migration-runtime-token';

function fixture(options = {}) {
  const config = {
    accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com',
    instanceId: 'saved-instance', instanceSlug: 'example', stage: 'prod', keyFingerprint: 'saved-fingerprint',
    mailDomain: 'pilot.example.com', stagedMailDomain: 'example.com', migratedMailDomain: 'example.com',
    routingMode: 'manual', appOrigin: 'https://mail.example.com', apexMx: [{ content: 'aspmx.l.google.com', priority: 1 }],
  };
  config.resourceNames = resourceNames(config);
  const plain = {
    INSTANCE_ID: config.instanceId, INSTANCE_SLUG: config.instanceSlug, INSTANCE_STAGE: config.stage,
    MAIL_KEY_FINGERPRINT: config.keyFingerprint, MAIL_DOMAIN: config.mailDomain, MAIL_ROUTING_MODE: config.routingMode,
    MAIL_STAGING_DOMAIN: config.stagedMailDomain, MAIL_MIGRATED_DOMAIN: config.migratedMailDomain,
    MAIL_ZONE_NAME: config.zoneName, MAIL_ZONE_ID: config.zoneId, ...options.bindings,
  };
  const bindings = [
    ...Object.entries(plain).filter(([, text]) => text !== undefined).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    ...['DB', 'AUTH_KV', 'MAIL_RAW', 'MAIL_QUEUE', 'MAIL_OUT_QUEUE', 'MAIL_EVENTS', 'EMAIL_SENDER', 'APP_CLOUDFLARE_API_TOKEN'].map(name => ({ name, id: name === 'DB' ? 'database-id' : undefined })),
  ];
  const rule = address => ({ enabled: true, matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] });
  const records = [config.mailDomain, config.zoneName].flatMap(domain => [
    { type: 'MX', name: domain, content: 'route1.mx.cloudflare.net', priority: 10 },
    { type: 'TXT', name: domain, content: 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all' },
    ...[`cf-bounce.${domain}`, `cf-bounce._domainkey.${domain}`, `_dmarc.${domain}`].map(name => ({ type: 'TXT', name, content: 'sending-fixture' })),
  ]);
  const calls = [];
  const fetcher = async (url, request = {}) => {
    assert.ok(!request.method || request.method === 'GET', 'Migration doctor must not mutate provider state');
    if (url.startsWith(config.appOrigin)) return new Response(null, { status: 200 });
    const path = new URL(url).pathname.replace('/client/v4', '');
    const authorization = request.headers.Authorization;
    calls.push({ path, authorization });
    if (path.includes('/email/')) assert.equal(authorization, `Bearer ${runtimeToken}`);
    if (path.startsWith('/accounts/')) assert.equal(authorization, `Bearer ${deploymentToken}`);
    if (options.runtimeDenied && path.endsWith('/email/routing')) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `${deploymentToken} ${runtimeToken} denied` }] }), { status: 403 });
    }
    let result = {};
    if (path === `/zones/${config.zoneId}`) result = { account: { id: config.accountId }, name: config.zoneName, status: 'active' };
    else if (path.endsWith('/subscriptions')) result = [{ rate_plan: { id: 'workers_paid' } }];
    else if (path.includes('/workers/scripts/')) result = { bindings };
    else if (path.includes('/d1/database/')) result = { name: config.resourceNames.database };
    else if (path.endsWith('/consumers')) result = [{ type: 'worker', script: config.resourceNames.inbound, dead_letter_queue: config.resourceNames.inboundDlq }];
    else if (path.endsWith('/queues')) result = [{ queue_name: config.resourceNames.inboundQueue, queue_id: 'queue' }, { queue_name: config.resourceNames.inboundDlq, queue_id: 'dlq' }];
    else if (path.endsWith('/email/routing')) result = options.routing ?? { enabled: true, status: 'ready' };
    else if (path.endsWith('/email/routing/dns')) result = [];
    else if (path.endsWith('/email/routing/rules/catch_all')) throw new Error('Migrated literal routing must not require a catch-all');
    else if (path.endsWith('/email/routing/rules')) result = [rule(`admin@${config.mailDomain}`), ...(options.apexRules ?? [rule('first@example.com'), rule('alias@example.com')])];
    else if (path.endsWith('/email/sending/subdomains')) result = options.sending ?? [{ name: config.mailDomain, enabled: true }, { name: config.zoneName, enabled: true }];
    else if (path.endsWith('/dns_records')) result = options.records ?? records;
    return new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }));
  };
  const inspect = async () => {
    const checks = await inspectInstance(config, { runtimeToken }, deploymentToken, { fetcher });
    return { checks, check: name => checks.find(entry => entry.name === name) };
  };
  return { config, records, rule, calls, inspect };
}

test('migrated doctor checks pilot and exact apex without requiring catch-all or obsolete provider MX', async () => {
  const { calls, inspect } = fixture();
  const result = await inspect();
  assert.deepEqual(result.checks.filter(check => check.status === 'fail'), []);
  for (const name of ['Recipient Email Routing', 'Native sending domain', 'Inbound and sending DNS',
    'Production migration binding', 'Migrated apex Recipient Email Routing', 'Migrated apex Native sending domain', 'Migrated apex Inbound and sending DNS']) {
    assert.equal(result.check(name).status, 'pass', name);
  }
  assert.match(result.check('Migrated apex Recipient Email Routing').detail, /2 enabled literal.*catch-all is not required.*Compare these recipients/);
  assert.ok(!result.check('Pilot apex MX preservation'));
  assert.ok(!result.check('Production account preparation'));
  assert.match(result.check('Migrated apex live mail verification').detail, /seven days.*After rollback.*drains delayed mail/);
  assert.ok(calls.some(call => call.path.endsWith('/email/routing')));
  assert.ok(!calls.some(call => call.path.endsWith('/catch_all')));
});

test('migrated doctor rejects missing and mismatched grants and preserved-scope bindings', async () => {
  for (const bindings of [
    { MAIL_MIGRATED_DOMAIN: undefined }, { MAIL_MIGRATED_DOMAIN: 'foreign.test' },
    { MAIL_STAGING_DOMAIN: 'foreign.test' }, { MAIL_DOMAIN: 'example.com' },
    { MAIL_ROUTING_MODE: 'apex' }, { MAIL_ZONE_NAME: 'foreign.test' }, { MAIL_ZONE_ID: 'foreign-zone' },
  ]) {
    const { inspect } = fixture({ bindings });
    const result = await inspect();
    assert.equal(result.check('Production migration binding').status, 'fail');
    assert.match(result.check('Production migration binding').detail, /Resume the reviewed migration deployment/);
  }
});

test('an unexpected deployed migration grant fails even while the saved pilot configuration preserves Google MX', async () => {
  const { config, records, inspect } = fixture();
  delete config.migratedMailDomain;
  records.find(record => record.type === 'MX' && record.name === config.zoneName).content = 'aspmx.l.google.com';
  records.find(record => record.type === 'MX' && record.name === config.zoneName).priority = 1;
  const result = await inspect();
  assert.equal(result.check('Production migration binding').status, 'fail');
  assert.match(result.check('Production migration binding').detail, /absent from saved state/);
  assert.equal(result.check('Pilot apex MX preservation').status, 'pass');
  assert.ok(!result.check('Migrated apex Native sending domain'));
});

test('invalid saved migration scope never inspects another domain or skips apex protection', async () => {
  const { config, inspect } = fixture();
  config.migratedMailDomain = 'foreign.test';
  const result = await inspect();
  assert.equal(result.check('Production migration binding').status, 'fail');
  assert.match(result.check('Production migration binding').detail, /exact prepared parent zone/);
  assert.equal(result.check('Pilot apex MX preservation').status, 'fail');
  assert.ok(!result.checks.some(check => check.name.startsWith('Migrated apex')));
});

test('migrated doctor requires zone readiness and at least one exact apex recipient', async () => {
  for (const options of [
    { apexRules: [] }, { routing: { enabled: false, status: 'ready' } }, { routing: { enabled: true, status: 'unconfigured' } },
  ]) {
    const result = await fixture(options).inspect();
    assert.equal(result.check('Recipient Email Routing').status, 'pass', 'Pilot literal rules remain independent of zone routing');
    assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'fail');
  }
});

test('migrated unlocked routing passes with independent DNS validation and leaves pilot inspection unchanged', async () => {
  const result = await fixture({ routing: { enabled: true, status: 'unlocked' } }).inspect();
  assert.deepEqual(result.checks.filter(check => check.status === 'fail'), []);
  assert.equal(result.check('Recipient Email Routing').status, 'pass');
  assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'pass');
  assert.match(result.check('Migrated apex Recipient Email Routing').detail, /unlocked.*DNS.*separately/);
  assert.equal(result.check('Migrated apex Inbound and sending DNS').status, 'pass');
});

test('unlocked migrated routing does not conceal unauthorized SPF or rolled-back receiving DNS', async () => {
  for (const change of [
    records => { records.find(record => record.name === 'example.com' && record.type === 'TXT').content = 'v=spf1 include:_spf.google.com ~all'; },
    records => { records.find(record => record.name === 'example.com' && record.type === 'TXT').content = 'v=spf1 -all include:_spf.mx.cloudflare.net'; },
    records => { records.find(record => record.name === 'example.com' && record.type === 'TXT').content = 'v=spf1 -include:_spf.mx.cloudflare.net include:_spf.mx.cloudflare.net ~all'; },
    records => { records.find(record => record.name === 'example.com' && record.type === 'MX').content = 'aspmx.l.google.com'; },
  ]) {
    const { records, inspect } = fixture({ routing: { enabled: true, status: 'unlocked' } });
    change(records);
    const result = await inspect();
    assert.equal(result.check('Recipient Email Routing').status, 'pass');
    assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'pass');
    assert.equal(result.check('Migrated apex Inbound and sending DNS').status, 'fail');
  }
});

test('unlocked state does not loosen original apex catch-all readiness', async () => {
  const { config, rule } = fixture();
  await assert.rejects(inspectRecipientRouting({ ...config, routingMode: 'apex', mailDomain: config.zoneName }, async path => {
    if (path.endsWith('/email/routing')) return { result: { enabled: true, status: 'unlocked' } };
    return { result: [rule('first@example.com')], result_info: { total_pages: 1 } };
  }), /not enabled and ready/);
});

test('migrated doctor rejects conflicting or duplicate literal apex rules', async () => {
  const base = fixture();
  const valid = base.rule('first@example.com');
  for (const apexRules of [
    [{ ...valid, actions: [{ type: 'worker', value: ['other-instance'] }] }],
    [{ ...valid, matchers: [...valid.matchers, { type: 'all' }] }],
    [valid, base.rule('FIRST@EXAMPLE.COM')],
  ]) {
    const result = await fixture({ apexRules }).inspect();
    assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'fail');
    assert.match(result.check('Migrated apex Recipient Email Routing').detail, /Review/);
  }
});

test('apex native sending cannot be inferred from pilot, wildcard, disabled or duplicate identities', async () => {
  for (const apex of [[], [{ name: '*.example.com', enabled: true }], [{ name: 'example.com', enabled: false }],
    [{ name: 'example.com', enabled: true }, { name: 'EXAMPLE.COM', enabled: true }]]) {
    const result = await fixture({ sending: [{ name: 'pilot.example.com', enabled: true }, ...apex] }).inspect();
    assert.equal(result.check('Native sending domain').status, 'pass');
    assert.equal(result.check('Migrated apex Native sending domain').status, 'fail');
  }
});

test('rollback DNS produces an honest migrated apex DNS failure while retained receiver and pilot still pass', async () => {
  const { config, records, inspect } = fixture();
  records.find(record => record.type === 'MX' && record.name === config.zoneName).content = 'aspmx.l.google.com';
  const result = await inspect();
  assert.equal(result.check('Inbound and sending DNS').status, 'pass');
  assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'pass');
  assert.equal(result.check('Migrated apex Inbound and sending DNS').status, 'fail');
  assert.match(result.check('Migrated apex Inbound and sending DNS').detail, /rollback\/draining status.*did not change DNS/);
});

test('migrated runtime routing permission failures remain actionable and redact both credentials', async () => {
  const result = await fixture({ runtimeDenied: true }).inspect();
  assert.equal(result.check('Migrated apex Recipient Email Routing').status, 'fail');
  assert.match(result.check('Migrated apex Recipient Email Routing').detail, /HTTP 403.*runtime token.*Zone Settings/);
  assert.ok(!JSON.stringify(result.checks).includes(deploymentToken));
  assert.ok(!JSON.stringify(result.checks).includes(runtimeToken));
});

test('exported migrated recipient inspection follows pagination and never reads a catch-all', async () => {
  const { config, rule } = fixture();
  const paths = [];
  const result = await inspectRecipientRouting({ ...config, mailDomain: config.zoneName }, async path => {
    paths.push(path);
    if (path.endsWith('/email/routing')) return { result: { enabled: true, status: 'ready' } };
    return { result: [rule(path.includes('page=1&') ? 'first@example.com' : 'alias@example.com')], result_info: { total_pages: 2 } };
  }, { literalApex: true });
  assert.equal(result.status, 'pass');
  assert.match(result.detail, /2 enabled literal/);
  assert.equal(paths.filter(path => path.includes('/email/routing/rules?')).length, 2);
  assert.ok(!paths.some(path => path.endsWith('/catch_all')));
});
