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
    if (authorization === `Bearer ${runtimeToken}` && options.runtimeFailure) {
      if (options.runtimeFailure === 'network') throw new Error(`${deploymentToken} ${runtimeToken} network error`);
      if (options.nonJsonFailure) return new Response('<html>Temporary provider error</html>', { status: options.runtimeFailure });
      return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `${deploymentToken} ${runtimeToken} provider error` }] }), { status: options.runtimeFailure });
    }
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
    const routingStatus = path.endsWith('/email/routing') ? options.apexSettingsStatus : path.endsWith('/email/routing/dns') ? options.routingPreviewStatus : undefined;
    if (routingStatus) return new Response(JSON.stringify({ success: false, errors: [{ code: 10000, message: `${deploymentToken} ${runtimeToken} provider error` }] }), { status: routingStatus });
    let result = {};
    if (path === `/zones/${config.zoneId}`) result = { account: { id: config.accountId }, name: config.zoneName, status: 'active' };
    else if (path.endsWith('/subscriptions')) result = options.subscriptions ?? [{ rate_plan: { id: 'workers_paid' } }];
    else if (path.includes('/workers/scripts/')) result = { bindings };
    else if (path.includes('/d1/database/')) result = { name: config.resourceNames.database };
    else if (path.endsWith('/consumers')) result = options.consumers ?? [{ type: 'worker', script: config.resourceNames.inbound, dead_letter_queue: config.resourceNames.inboundDlq, settings: { batch_size: 10, max_retries: 5 } }];
    else if (path.endsWith('/queues')) result = [{ queue_name: config.resourceNames.inboundQueue, queue_id: 'inbound-id' }, { queue_name: config.resourceNames.inboundDlq, queue_id: 'dlq-id' }];
    else if (path.endsWith('/email/routing')) result = { enabled: true, status: 'ready' };
    else if (path.endsWith('/email/routing/dns')) result = [];
    else if (path.endsWith('/email/routing/rules/catch_all')) result = { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] };
    else if (path.endsWith('/email/routing/rules')) result = options.recipientRules ?? [{ enabled: true, matchers: [{ type: 'literal', field: 'to', value: `admin@${config.mailDomain}` }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] }];
    else if (path.endsWith('/email/sending/subdomains')) result = [{ name: config.mailDomain, enabled: true }];
    else if (path.endsWith('/dns_records')) result = [
      { type: 'MX', name: config.zoneName, content: 'aspmx.l.google.com', priority: 1 },
      { type: 'MX', name: config.mailDomain, content: 'route1.mx.cloudflare.net', priority: 10 },
      ...(options.spfContents ?? ['v=spf1 include:_spf.mx.cloudflare.net ~all']).map((content) => ({ type: 'TXT', name: config.mailDomain, content })),
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

test('pilot runtime scope uses DNS preview and never requires apex settings or implies mailbox readiness', async () => {
  const { calls, inspect } = fixture({ apexSettingsStatus: 502, recipientRules: [], spfContents: [] });
  const checks = await inspect();
  const scope = checks.find((check) => check.name === 'Runtime token scope');
  assert.equal(scope.status, 'pass');
  assert.match(scope.detail, /routing DNS preview.*token scope only/);
  const preview = calls.filter((call) => call.path.endsWith('/email/routing/dns'));
  assert.equal(preview.length, 1);
  assert.equal(preview[0].authorization, `Bearer ${runtimeToken}`);
  assert.ok(!calls.some((call) => call.path.endsWith('/email/routing')));
  assert.equal(checks.find((check) => check.name === 'Recipient Email Routing').status, 'fail');
  assert.equal(checks.find((check) => check.name === 'Inbound and sending DNS').status, 'fail');
});

test('apex runtime scope still requires apex settings and preserves provider failures without DNS-preview fallback', async () => {
  const { config, calls, inspect } = fixture({ apexSettingsStatus: 502 });
  config.routingMode = 'apex';
  config.mailDomain = config.zoneName;
  const checks = await inspect();
  assert.equal(checks.find((check) => check.name === 'Runtime token scope').status, 'fail');
  assert.match(checks.find((check) => check.name === 'Runtime token scope').detail, /HTTP 502.*temporarily unavailable/);
  assert.equal(checks.find((check) => check.name === 'Recipient Email Routing').status, 'fail');
  assert.ok(calls.some((call) => call.path.endsWith('/email/routing')));
  assert.ok(!calls.some((call) => call.path.endsWith('/email/routing/dns')));
});

test('pilot DNS-preview failure remains a scope failure without retry or apex-settings fallback', async () => {
  const { calls, inspect } = fixture({ routingPreviewStatus: 502 });
  const checks = await inspect();
  assert.equal(checks.find((check) => check.name === 'Runtime token scope').status, 'fail');
  assert.match(checks.find((check) => check.name === 'Runtime token scope').detail, /HTTP 502.*temporarily unavailable/);
  assert.equal(calls.filter((call) => call.path.endsWith('/email/routing/dns')).length, 1);
  assert.ok(!calls.some((call) => call.path.endsWith('/email/routing')));
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

test('provider outages, rate limits and network failures give retry guidance without token-permission advice', async () => {
  const cases = [
    [{ runtimeFailure: 502 }, /HTTP 502.*temporarily unavailable.*Rerun doctor/],
    [{ runtimeFailure: 502, nonJsonFailure: true }, /HTTP 502.*temporarily unavailable.*Rerun doctor/],
    [{ runtimeFailure: 503 }, /HTTP 503.*temporarily unavailable.*Rerun doctor/],
    [{ runtimeFailure: 429 }, /HTTP 429.*rate limited.*Wait before rerunning doctor/],
    [{ runtimeFailure: 'network' }, /could not be reached.*network connection.*rerun doctor/],
  ];
  for (const [options, guidance] of cases) {
    const { inspect, calls } = fixture(options);
    const checks = await inspect();
    for (const name of ['Runtime token scope', 'Recipient Email Routing', 'Native sending domain']) {
      const check = checks.find((entry) => entry.name === name);
      assert.equal(check.status, 'fail');
      assert.match(check.detail, guidance);
      assert.doesNotMatch(check.detail, /permissions|Workers Paid entitlement|docs\/TOKENS/);
    }
    const runtimePaths = calls.filter((call) => call.authorization === `Bearer ${runtimeToken}`).map((call) => call.path);
    assert.equal(new Set(runtimePaths).size, runtimePaths.length, 'Doctor must not retry failed requests automatically');
    assert.ok(!JSON.stringify(checks).includes(runtimeToken));
    assert.ok(!JSON.stringify(checks).includes(deploymentToken));
  }
});

test('HTTP 401 remains an actionable runtime credential failure', async () => {
  const { inspect } = fixture({ runtimeFailure: 401 });
  const checks = await inspect();
  for (const name of ['Runtime token scope', 'Recipient Email Routing', 'Native sending domain']) {
    assert.match(checks.find((entry) => entry.name === name).detail, /HTTP 401.*runtime token.*permissions/);
  }
});

test('single quoted and unquoted SPF values pass read-only classification without changing provider bytes', async () => {
  for (const content of ['v=spf1 include:_spf.mx.cloudflare.net ~all', '"v=spf1 include:_spf.mx.cloudflare.net ~all"', '"V=SPF1 include:_spf.mx.cloudflare.net ~all"']) {
    const spfContents = [content];
    const { inspect } = fixture({ spfContents });
    const checks = await inspect();
    assert.equal(checks.find((check) => check.name === 'Inbound and sending DNS').status, 'pass');
    assert.deepEqual(spfContents, [content]);
  }
});

test('multipart, malformed quoted SPF and duplicate policies remain DNS failures', async () => {
  const cases = [
    ['"v=spf1 " "include:_spf.mx.cloudflare.net ~all"'],
    ['"v=spf1 include:_spf.mx.cloudflare.net ~all'],
    ['"v=spf1\\032include:_spf.mx.cloudflare.net ~all"'],
    ['v=spf11 include:_spf.mx.cloudflare.net ~all'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all', '"v=spf1 include:_spf.mx.cloudflare.net ~all"'],
    ['v=spf1 include:_spf.mx.cloudflare.net ~all', '"v=spf1 " "include:_spf.mx.cloudflare.net ~all"'],
  ];
  for (const spfContents of cases) {
    const original = [...spfContents];
    const { inspect } = fixture({ spfContents });
    const checks = await inspect();
    const dns = checks.find((check) => check.name === 'Inbound and sending DNS');
    assert.equal(dns.status, 'fail');
    assert.match(dns.detail, /SPF/);
    assert.deepEqual(spfContents, original);
  }
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
