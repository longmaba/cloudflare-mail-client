// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { migrationProvider, migrationRequest, sameRecords, checkSpfBudget, normalizedRule, recipientRules } from '../lib/migration-provider.mjs';
import { newSecrets, keyFingerprint, resourceNames } from '../lib/instance.mjs';
import { migrationArguments } from '../instance.mjs';

function fixture(t) {
  const secrets = { ...newSecrets(), runtimeToken: 'runtime-private-fixture', deployToken: 'deploy-private-fixture' };
  const config = { version: 1, instanceId: 'fixture-instance', instanceSlug: 'example', stage: 'prod', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com', mailDomain: 'pilot.example.com', routingMode: 'manual', stagedMailDomain: 'example.com', keyFingerprint: keyFingerprint(secrets) };
  config.resourceNames = resourceNames(config);
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  db.exec(`CREATE TABLE organization(id TEXT,domain TEXT,zone_id TEXT,status TEXT);
    CREATE TABLE user(id TEXT,email TEXT,role TEXT,banned INTEGER,two_factor_enabled INTEGER,must_change_password INTEGER,recovery_email_verified INTEGER,recovery_email TEXT,onboarded_at INTEGER);
    CREATE TABLE account(user_id TEXT,provider_id TEXT,password TEXT);
    CREATE TABLE member(user_id TEXT,organization_id TEXT,role TEXT);
    CREATE TABLE mailbox(id TEXT,org_id TEXT,address TEXT,is_active INTEGER,is_service INTEGER);
    CREATE TABLE alias(mailbox_id TEXT,org_id TEXT,address TEXT,is_enabled INTEGER);
    CREATE TABLE mailbox_access(user_id TEXT,mailbox_id TEXT,can_send INTEGER);
    CREATE TABLE org_mail_settings(org_id TEXT PRIMARY KEY,return_path_domain TEXT,updated_at INTEGER,require_2fa INTEGER,require_2fa_from INTEGER);
    INSERT INTO organization VALUES('org','example.com','${config.zoneId}','staged');
    INSERT INTO user VALUES('alice','alice@example.com','admin',0,1,0,1,'recovery@external.test',123);
    INSERT INTO account VALUES('alice','credential','synthetic-hash-never-returned');
    INSERT INTO member VALUES('alice','org','admin');
    INSERT INTO mailbox VALUES('box','org','alice@example.com',1,0);
    INSERT INTO alias VALUES('box','org','support@example.com',1);
    INSERT INTO mailbox_access VALUES('alice','box',1);`);
  let sequence = 10;
  const nextId = () => (++sequence).toString(16).padStart(32, '0');
  const records = [
    { id: nextId(), type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1, ttl: 3600, proxied: false, settings: {} },
    { id: nextId(), type: 'TXT', name: 'example.com', content: '"v=spf1 include:_spf.google.com ~all"', ttl: 3600, proxied: false, settings: {} },
    { id: nextId(), type: 'MX', name: 'pilot.example.com', content: 'route1.mx.cloudflare.net', priority: 1, ttl: 1 },
  ];
  const calls = [], rules = [];
  let native = null, status = 'misconfigured', lostUnlock = false;
  const sendDns = [
    { type: 'MX', name: 'cf-bounce.example.com', content: 'route1.mx.cloudflare.net', priority: 1, ttl: 1 },
    { type: 'TXT', name: 'cf-bounce.example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 },
    { type: 'TXT', name: 'cf-bounce._domainkey.example.com', content: `v=DKIM1; k=rsa; p=${'A'.repeat(392)}`, ttl: 1 },
    { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=none', ttl: 1 },
  ];
  const fetcher = async (url, options) => {
    const path = new URL(url).pathname.replace('/client/v4', ''), method = options.method ?? 'GET';
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method, body });
    const infrastructure = path.startsWith('/accounts/');
    assert.equal(options.headers.Authorization, `Bearer ${infrastructure ? secrets.deployToken : secrets.runtimeToken}`);
    const result = value => Response.json({ success: true, result: value, result_info: { total_pages: 1 } });
    if (path === `/zones/${config.zoneId}`) {
      // guard lookup uses deployment credentials rather than the runtime token.
      return result({ id: config.zoneId, name: config.zoneName, status: 'active', account: { id: config.accountId } });
    }
    if (path.endsWith('/settings')) {
      const role = Object.keys(config.resourceNames).find(role => config.resourceNames[role] === path.split('/').at(-2));
      assert.ok(['web', 'inbound', 'jobs'].includes(role));
      const values = { INSTANCE_ID: config.instanceId, INSTANCE_SLUG: config.instanceSlug, INSTANCE_STAGE: config.stage, MAIL_KEY_FINGERPRINT: config.keyFingerprint, MAIL_DOMAIN: config.mailDomain, MAIL_ROUTING_MODE: config.routingMode, MAIL_STAGING_DOMAIN: config.stagedMailDomain };
      return result({ bindings: [...Object.entries(values).map(([name, text]) => ({ type: 'plain_text', name, text })), { type: 'd1', name: 'DB', id: '11111111-1111-4111-8111-111111111111' }, { type: 'kv_namespace', name: 'AUTH_KV', namespace_id: 'c'.repeat(32) }, { type: 'r2_bucket', name: 'MAIL_RAW', bucket_name: config.resourceNames.rawBucket }] });
    }
    if (path.endsWith('/query')) {
      assert.equal(method, 'POST');
      return result([{ success: true, results: db.prepare(body.sql).all(...body.params) }]);
    }
    if (path.includes('/d1/database/')) return result({ name: config.resourceNames.database });
    if (path.includes('/storage/kv/')) { assert.equal(method, 'DELETE'); assert.ok(path.endsWith('/ids%3Av2%3Aalice')); return result(null); }
    if (path.endsWith('/dns_records/batch')) {
      assert.equal(method, 'POST');
      for (const { id } of body.deletes ?? []) { const position = records.findIndex(record => record.id === id); assert.ok(position >= 0); records.splice(position, 1); }
      for (const record of body.posts ?? []) records.push({ ...record, id: nextId(), settings: {}, content: record.type === 'TXT' ? `"${record.content}"` : `${record.content}.` });
      return result({});
    }
    if (path.endsWith('/dns_records')) { assert.equal(method, 'GET'); return result(records); }
    if (path.endsWith('/email/routing/rules/catch_all')) return result({ enabled: false, matchers: [{ type: 'all' }], actions: [] });
    if (/\/email\/routing\/rules(?:\/[a-f0-9]{32})?$/.test(path)) {
      if (method === 'GET') return result(rules);
      assert.ok(['POST', 'PUT'].includes(method)); assert.equal(body.source, undefined);
      const tag = method === 'PUT' ? path.split('/').at(-1) : nextId();
      const position = rules.findIndex(rule => rule.tag === tag);
      if (position >= 0) rules[position] = { ...body, tag, source: 'user' }; else rules.push({ ...body, tag, source: 'user' });
      return result(rules.at(-1));
    }
    if (path.endsWith('/email/routing/dns')) {
      if (method === 'PATCH') { status = 'unlocked'; if (lostUnlock) { lostUnlock = false; throw new Error(`network error with ${secrets.runtimeToken}`); } return result(null); }
      assert.equal(method, 'GET');
      return result([{ type: 'MX', name: 'example.com', content: 'route1.mx.cloudflare.net.', priority: 1, ttl: 1 }, { type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 }]);
    }
    if (path.endsWith('/email/routing')) return result({ enabled: true, status });
    if (path.endsWith('/email/sending/subdomains')) {
      if (method === 'GET') return result(native ? [native] : []);
      assert.equal(method, 'POST'); assert.deepEqual(body, { name: 'example.com' });
      native = { name: 'example.com', enabled: true, tag: 'd'.repeat(32), return_path_domain: 'cf-bounce.example.com', dkim_selector: 'cf-bounce' };
      return result(native);
    }
    if (path.endsWith(`/email/sending/subdomains/${'d'.repeat(32)}/dns`)) return result(sendDns);
    throw new Error('Unexpected fixture API operation.');
  };
  // Zone identity is a deployment read; distinguish that one GET by path.
  const routedFetch = (url, options) => {
    if (new URL(url).pathname === `/client/v4/zones/${config.zoneId}`) {
      assert.equal(options.headers.Authorization, `Bearer ${secrets.deployToken}`);
      return Promise.resolve(Response.json({ success: true, result: { id: config.zoneId, name: config.zoneName, status: 'active', account: { id: config.accountId } } }));
    }
    return fetcher(url, options);
  };
  return { config, secrets, db, records, rules, calls, sendDns, provider: migrationProvider(config, secrets, secrets.deployToken, { fetcher: routedFetch }), loseUnlock: () => { lostUnlock = true; } };
}

test('provider snapshot executes actual readonly SQL, separates credentials and returns no hashes or recovery addresses', async t => {
  const f = fixture(t), snapshot = await f.provider.snapshot();
  assert.equal(snapshot.organization.status, 'staged'); assert.equal(snapshot.owners[0].externalRecovery, true);
  assert.equal(snapshot.owners[0].passwordChosen, 1); assert.equal(snapshot.owners[0].elevatedMembership, 1);
  assert.equal(snapshot.recipients.length, 2); assert.ok(snapshot.grants[0].canSend);
  assert.ok(f.calls.filter(call => call.method !== 'GET').every(call => call.path.endsWith('/query') && /^SELECT/i.test(call.body.sql)));
  assert.ok(!JSON.stringify(snapshot).includes('synthetic-hash')); assert.ok(!JSON.stringify(snapshot).includes('recovery@external.test'));
  f.db.exec("UPDATE user SET recovery_email='owner@pilot.example.com'");
  assert.equal((await f.provider.snapshot()).owners[0].externalRecovery, false);
});

test('provider mutations use exact native registration, rules without readonly metadata, guarded SQL and scoped identity cache keys', async t => {
  const f = fixture(t), before = await f.provider.snapshot();
  await f.provider.registerSender(); await f.provider.registerSender();
  assert.equal(f.calls.filter(call => call.path.endsWith('/email/sending/subdomains') && call.method === 'POST').length, 1);
  await f.provider.addSendingDns(f.sendDns);
  const wanted = recipientRules(before.recipients, [], f.config.zoneName, f.config.resourceNames.inbound);
  await f.provider.reconcileRules(wanted);
  const resumed = recipientRules(before.recipients, f.rules, f.config.zoneName, f.config.resourceNames.inbound);
  assert.deepEqual(f.rules.map(normalizedRule), resumed.map(normalizedRule));
  await f.provider.reconcileRules(resumed);
  const live = await f.provider.snapshot();
  await f.provider.activateOrganization(live.organization, live.nativeDomain); await f.provider.invalidateIdentities(live.owners);
  assert.equal(f.db.prepare('SELECT status FROM organization').get().status, 'active');
  assert.equal(f.db.prepare('SELECT return_path_domain FROM org_mail_settings').get().return_path_domain, 'cf-bounce.example.com');
  assert.ok(f.calls.every(call => !call.body?.sql || !/UPDATE user|UPDATE account|DELETE/i.test(call.body.sql)));
});

test('provider unlocks without deleting zone routing and atomically replaces only selected apex IDs; unlock response loss safely retries', async t => {
  const f = fixture(t), before = await f.provider.snapshot();
  const previous = before.records.filter(record => record.name === f.config.zoneName);
  const next = [{ type: 'MX', name: f.config.zoneName, content: 'route1.mx.cloudflare.net', priority: 1, ttl: 1 }, { type: 'TXT', name: f.config.zoneName, content: 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net ~all', ttl: 3600 }];
  f.loseUnlock();
  await assert.rejects(f.provider.replaceApexDns(previous, next), error => !error.message.includes(f.secrets.runtimeToken));
  assert.ok(sameRecords(f.records.filter(record => record.name === f.config.zoneName), previous));
  await f.provider.replaceApexDns(previous, next);
  assert.ok(sameRecords(f.records.filter(record => record.name === f.config.zoneName), next));
  assert.equal(f.records.find(record => record.name === f.config.mailDomain).content, 'route1.mx.cloudflare.net');
  const batch = f.calls.at(-1); assert.ok(batch.path.endsWith('/dns_records/batch'));
  assert.deepEqual(batch.body.deletes.map(record => record.id), previous.map(record => record.id));
  assert.ok(f.calls.every(call => !(call.method === 'DELETE' && call.path.includes('/email/routing'))));
});

test('canonical DNS comparison includes proxy and structured-data drift but tolerates empty provider settings and TXT quoting', () => {
  const a = [{ type: 'SRV', name: '_smtp._tcp.example.com', content: '0 5 25 mail.example.com', ttl: 300, data: { port: 25, target: 'mail.example.com' } }];
  assert.ok(sameRecords(a, [{ ...a[0], proxied: false, settings: {}, data: { target: 'mail.example.com', port: 25 } }]));
  assert.ok(!sameRecords(a, [{ ...a[0], data: { port: 587, target: 'mail.example.com' } }]));
  assert.ok(!sameRecords(a, [{ ...a[0], proxied: true }]));
  assert.ok(sameRecords([{ type: 'TXT', name: 'example.com', content: 'v=spf1 ~all', ttl: 1 }], [{ type: 'TXT', name: 'example.com', content: '"v=spf1 ~all"', ttl: 1, settings: {}, proxied: false }]));
});

test('migration HTTP suppresses provider and network secrets while preserving actionable scope and method', async () => {
  const token = 'private-fixture-token';
  const network = migrationRequest(token, async () => { throw new Error(token); });
  await assert.rejects(network('/zones/a/dns_records'), error => !error.message.includes(token));
  const malformed = migrationRequest(token, async () => new Response(token, { status: 500 }));
  await assert.rejects(malformed('/zones/a/dns_records'), error => !error.message.includes(token) && error.message.includes('DNS Read/Edit'));
  const denied = migrationRequest(token, async () => Response.json({ success: false, errors: [{ code: 1000, message: token }] }, { status: 403 }));
  await assert.rejects(denied('/zones/a/email/sending/subdomains', 'POST', { name: 'example.com' }), error => !error.message.includes(token) && error.message.includes('Email Sending Read/Edit'));
});

test('SPF nested repeated includes consume their full lookup budget and DNS failure blocks preflight', async () => {
  const lookup = async name => [[name === '_spf.example.com' ? 'v=spf1 include:_nested.example.com ~all' : 'v=spf1 ip4:192.0.2.0/24 ~all']];
  assert.equal(await checkSpfBudget('v=spf1 include:_spf.example.com include:_spf.example.com ~all', lookup), 4);
  await assert.rejects(checkSpfBudget('v=spf1 include:_spf.example.com ~all', async () => { throw new Error('offline'); }), /Cannot resolve/);
});

test('migration command rejects missing, duplicate and ambiguous flags before contacting provider', () => {
  assert.deepEqual(migrationArguments(['plan']), { action: 'plan' });
  assert.deepEqual(migrationArguments(['status', '--plan', 'saved.json']), { action: 'status', basename: 'saved.json' });
  assert.deepEqual(migrationArguments(['apply', '--plan', 'saved.json', '--confirm', 'digest']), { action: 'apply', basename: 'saved.json', confirm: 'digest' });
  assert.deepEqual(migrationArguments(['rollback', '--plan', 'saved.json', '--confirm', 'digest']), { action: 'rollback', basename: 'saved.json', confirm: 'digest' });
  for (const args of [[], ['plan', '--apply'], ['apply', '--plan', 'saved.json'], ['status', '--plan', 'saved.json', '--plan', 'other.json'], ['rollback', '--confirm', 'digest', '--plan', 'saved.json'], ['delete']]) assert.throws(() => migrationArguments(args), /Usage/);
});
