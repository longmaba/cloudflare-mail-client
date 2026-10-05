// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectInstance } from '../lib/doctor.mjs';
import { resourceNames } from '../lib/instance.mjs';

const deploymentToken = 'private-fixture-deployment-token';
const runtimeToken = 'private-fixture-runtime-token';

function fixture(options = {}) {
  const config = {
    accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com',
    instanceId: 'saved-instance', instanceSlug: 'example', stage: 'prod', keyFingerprint: 'saved-fingerprint',
    mailDomain: 'pilot.example.com', routingMode: 'manual', appOrigin: 'https://mail.example.com',
    apexMx: [{ content: 'aspmx.l.google.com', priority: 1 }],
  };
  config.resourceNames = resourceNames(config);
  const values = { INSTANCE_ID: config.instanceId, INSTANCE_SLUG: config.instanceSlug, INSTANCE_STAGE: config.stage, MAIL_KEY_FINGERPRINT: config.keyFingerprint };
  const bindings = [
    ...Object.entries(values).map(([name, text]) => ({ name, text, type: 'plain_text' })),
    ...['DB', 'AUTH_KV', 'MAIL_RAW', 'MAIL_QUEUE', 'MAIL_OUT_QUEUE', 'MAIL_EVENTS', 'EMAIL_SENDER', 'APP_CLOUDFLARE_API_TOKEN'].map((name) => ({ name, id: name === 'DB' ? 'database-id' : undefined })),
  ];
  const calls = [];
  const fetcher = async (url, request = {}) => {
    assert.ok(!request.method || request.method === 'GET', 'Doctor must stay read-only');
    if (url.startsWith(config.appOrigin)) return new Response(null, { status: 200 });
    const endpoint = new URL(url);
    const path = endpoint.pathname.replace('/client/v4', '');
    const authorization = request.headers.Authorization;
    calls.push({ path, authorization });
    const isMailConfiguration = path.includes('/email/');
    if ((isMailConfiguration && authorization !== `Bearer ${runtimeToken}`) || (authorization === `Bearer ${runtimeToken}` && options.runtimeDenied)) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `${deploymentToken} ${runtimeToken} rejected` }] }), { status: 403 });
    }
    if (path.startsWith('/accounts/')) assert.equal(authorization, `Bearer ${deploymentToken}`, 'Infrastructure reads require the deployment credential');
    if (path.endsWith('/subscriptions') && options.billingStatus) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `${deploymentToken} ${runtimeToken} rejected` }] }), { status: options.billingStatus });
    }
    if (path.endsWith('/email/sending/subdomains') && options.sendingCode) {
      return new Response(JSON.stringify({ success: false, errors: [{ code: options.sendingCode, message: `${deploymentToken} ${runtimeToken} account not entitled` }] }), { status: 403 });
    }
    let result = {};
    if (path === `/zones/${config.zoneId}`) result = { account: { id: config.accountId }, name: config.zoneName, status: 'active' };
    else if (path.endsWith('/subscriptions')) result = options.subscriptions ?? [{ rate_plan: { id: 'workers_paid' } }];
    else if (path.includes('/workers/scripts/')) result = { bindings };
    else if (path.includes('/d1/database/')) result = { name: config.resourceNames.database };
    else if (path.endsWith('/consumers')) result = options.consumers ?? [{ type: 'worker', script: config.resourceNames.inbound, dead_letter_queue: config.resourceNames.inboundDlq, settings: { batch_size: 10, max_retries: 5 } }];
    else if (path.endsWith('/queues')) result = [{ queue_name: config.resourceNames.inboundQueue, queue_id: 'inbound-id' }, { queue_name: config.resourceNames.inboundDlq, queue_id: 'dlq-id' }];
    else if (path.endsWith('/email/routing')) result = { enabled: true, status: 'ready' };
    else if (path.endsWith('/email/routing/rules/catch_all')) result = { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] };
    else if (path.endsWith('/email/routing/rules')) result = [{ enabled: true, matchers: [{ type: 'literal', field: 'to', value: `admin@${config.mailDomain}` }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] }];
    else if (path.endsWith('/email/sending/subdomains')) result = [{ name: config.mailDomain, enabled: true }];
    else if (path.endsWith('/dns_records')) result = [
      { type: 'MX', name: config.zoneName, content: 'aspmx.l.google.com', priority: 1 },
      { type: 'MX', name: config.mailDomain, content: 'route1.mx.cloudflare.net', priority: 10 },
      { type: 'TXT', name: config.mailDomain, content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' },
      ...[`cf-bounce.${config.mailDomain}`, `cf-bounce._domainkey.${config.mailDomain}`, `_dmarc.${config.mailDomain}`].map((name) => ({ type: 'TXT', name, content: 'sending-fixture' })),
    ];
    return new Response(JSON.stringify({ success: true, result, result_info: { total_pages: 1 } }));
  };
  const inspect = (secrets = { runtimeToken }) => inspectInstance(config, secrets, deploymentToken, { fetcher });
  return { config, calls, inspect };
}

test('doctor uses runtime token for scoped routing/sending and deployment token for infrastructure', async () => {
  const { calls, inspect } = fixture();
  const checks = await inspect();
  assert.deepEqual(checks.filter((check) => check.status === 'fail'), []);
  assert.ok(calls.some((call) => call.path.endsWith('/email/routing/rules')));
  assert.ok(calls.some((call) => call.path.endsWith('/email/sending/subdomains')));
  for (const call of calls.filter((call) => call.path.includes('/email/'))) assert.equal(call.authorization, `Bearer ${runtimeToken}`);
  for (const call of calls.filter((call) => call.path.startsWith('/accounts/'))) assert.equal(call.authorization, `Bearer ${deploymentToken}`);
});

test('apex routing settings and catch-all diagnostic reads also use the scoped runtime token', async () => {
  const { config, calls, inspect } = fixture();
  config.routingMode = 'apex';
  config.mailDomain = config.zoneName;
  const checks = await inspect();
  assert.equal(checks.find((check) => check.name === 'Recipient Email Routing').status, 'pass');
  assert.ok(calls.some((call) => call.path.endsWith('/email/routing/rules/catch_all')));
  for (const call of calls.filter((call) => call.path.includes('/email/'))) assert.equal(call.authorization, `Bearer ${runtimeToken}`);
});

test('missing runtime credentials fail mail diagnostics without using deployment credentials as fallback', async () => {
  const { calls, inspect } = fixture();
  const checks = await inspect({});
  for (const name of ['Runtime token scope', 'Recipient Email Routing', 'Native sending domain']) {
    const check = checks.find((entry) => entry.name === name);
    assert.equal(check.status, 'fail');
    assert.match(check.detail, /Missing runtime token/);
  }
  assert.ok(!calls.some((call) => call.path.includes('/email/')));
  assert.equal(checks.find((check) => check.name === 'Persistent mail storage').status, 'pass');
});

test('runtime permission failures name the right credential and never expose either token', async () => {
  const { inspect } = fixture({ runtimeDenied: true });
  const checks = await inspect();
  const routing = checks.find((check) => check.name === 'Recipient Email Routing');
  const sending = checks.find((check) => check.name === 'Native sending domain');
  assert.equal(routing.status, 'fail');
  assert.match(routing.detail, /Runtime token.*HTTP 403.*Email Routing Rules Read\/Edit/);
  assert.equal(sending.status, 'fail');
  assert.match(sending.detail, /HTTP 403.*runtime token Email Sending Read\/Edit permissions.*selected account/);
  assert.ok(!JSON.stringify(checks).includes(runtimeToken));
  assert.ok(!JSON.stringify(checks).includes(deploymentToken));
});

test('unavailable billing verification warns without requiring broader token permissions or claiming Paid is verified', async () => {
  for (const billingStatus of [403, 503]) {
    const { inspect } = fixture({ billingStatus });
    const checks = await inspect();
    const entitlement = checks.find((check) => check.name === 'Email Sending entitlement');
    assert.equal(entitlement.status, 'warn');
    assert.match(entitlement.detail, new RegExp(`could not be confirmed automatically.*HTTP ${billingStatus}`));
    assert.match(entitlement.detail, /Manage Account > Billing > Subscriptions/);
    assert.match(entitlement.detail, /no additional Billing permission is needed/);
    assert.match(entitlement.detail, /Native sending-domain and DNS checks remain required/);
    assert.equal(checks.find((check) => check.name === 'Native sending domain').status, 'pass');
    assert.deepEqual(checks.filter((check) => check.status === 'fail'), []);
    assert.ok(!JSON.stringify(checks).includes(runtimeToken));
    assert.ok(!JSON.stringify(checks).includes(deploymentToken));
  }
});

test('native sending entitlement failures remain failures when optional billing verification is unavailable', async () => {
  const { inspect } = fixture({ billingStatus: 403, sendingCode: 10105 });
  const checks = await inspect();
  assert.equal(checks.find((check) => check.name === 'Email Sending entitlement').status, 'warn');
  const sending = checks.find((check) => check.name === 'Native sending domain');
  assert.equal(sending.status, 'fail');
  assert.match(sending.detail, /HTTP 403.*Workers Paid entitlement/);
  assert.equal(checks.find((check) => check.name === 'Persistent mail storage').status, 'pass');
  assert.ok(!JSON.stringify(checks).includes(runtimeToken));
  assert.ok(!JSON.stringify(checks).includes(deploymentToken));
});

test('a sending-enabled domain does not turn an unconfirmed subscription into Paid verification', async () => {
  const { inspect } = fixture({ subscriptions: [] });
  const checks = await inspect();
  assert.equal(checks.find((check) => check.name === 'Email Sending entitlement').status, 'warn');
  assert.equal(checks.find((check) => check.name === 'Native sending domain').status, 'pass');
});

test('queue readiness accepts actual script field and legacy script_name only for the expected worker and DLQ', async () => {
  const expected = resourceNames({ instanceSlug: 'example', stage: 'prod' });
  const base = { type: 'worker', script: expected.inbound, dead_letter_queue: expected.inboundDlq };
  const cases = [
    [base, 'pass'],
    [{ type: 'worker', script_name: expected.inbound, dead_letter_queue: expected.inboundDlq }, 'pass'],
    [{ ...base, type: 'http' }, 'fail'],
    [{ ...base, script: 'other-worker' }, 'fail'],
    [{ ...base, dead_letter_queue: 'other-dlq' }, 'fail'],
    [{ ...base, script: 'other-worker', script_name: expected.inbound }, 'fail'],
  ];
  for (const [consumer, status] of cases) {
    const { inspect } = fixture({ consumers: [consumer] });
    const checks = await inspect();
    assert.equal(checks.find((check) => check.name === 'Inbound queue and durable recovery').status, status);
  }
});
