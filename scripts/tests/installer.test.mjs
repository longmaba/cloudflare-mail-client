// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertStable, deploymentEnv, keyFingerprint, newSecrets, readInstance, resourceNames, saveInstance, validateConfig, withInstallLock } from '../lib/instance.mjs';
import { assertRemoteIdentity, assertUnclaimedResources, cloudflare, dnsPreview, externalMx, selectAccountAndZone } from '../lib/cloudflare.mjs';
import { inspectInstance } from '../lib/doctor.mjs';
import { assertUpgradeTag, finishSetup, paidRequirement } from '../instance.mjs';
import { bootstrapUrl, browserCommand, presentBootstrap } from '../lib/bootstrap.mjs';
import { run } from '../lib/process.mjs';
import { assertUpgradeTarget } from '../lib/upgrade.mjs';
import { requireExistingSuperadmin } from '../../apps/web/scripts/reset-admin.mjs';

const accountA = 'a'.repeat(32);
const accountB = 'b'.repeat(32);
const zoneId = 'c'.repeat(32);
function fixture() {
  const secrets = { ...newSecrets(), runtimeToken: 'runtime-test-token', deployToken: 'deploy-test-token' };
  const config = { version: 1, instanceId: 'test-instance', instanceSlug: 'example', stage: 'prod', sourceOrigin: 'https://github.com/example/mail.git', sourceRemote: 'origin', accountId: accountB, zoneId, zoneName: 'example.com', mailDomain: 'pilot.example.com', routingMode: 'manual', appName: 'Example Mail', appOrigin: 'https://mail.example.com', keyFingerprint: keyFingerprint(secrets), phase: 'configured', apexMx: [{ content: 'aspmx.l.google.com', priority: 1, ttl: 3600 }] };
  config.resourceNames = resourceNames(config);
  return { config, secrets };
}
const identityBindings = (config) => ['INSTANCE_ID', 'INSTANCE_SLUG', 'INSTANCE_STAGE', 'MAIL_KEY_FINGERPRINT'].map((name) => ({ type: 'plain_text', name, text: ({ INSTANCE_ID: config.instanceId, INSTANCE_SLUG: config.instanceSlug, INSTANCE_STAGE: config.stage, MAIL_KEY_FINGERPRINT: config.keyFingerprint })[name] }));

test('account selection filters zones to selected account, including multiple-account credentials', async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path.startsWith('/accounts')) return { result: [{ id: accountA, name: 'A' }, { id: accountB, name: 'B' }], result_info: { total_pages: 1 } };
    assert.match(path, new RegExp(`account.id=${accountB}`));
    return { result: [{ id: zoneId, name: 'example.com' }] };
  };
  const selected = await selectAccountAndZone(api, async (name, items) => items[name.includes('account') ? 1 : 0].value);
  assert.equal(selected.account.id, accountB);
  assert.equal(calls.length, 2);
});

test('configuration rejects cross-zone domains and stages', () => {
  const { config } = fixture();
  assert.throws(() => validateConfig({ ...config, mailDomain: 'someone-else.com' }), /selected zone/);
  assert.throws(() => validateConfig({ ...config, routingMode: 'apex' }), /Apex routing/);
  assert.throws(() => validateConfig({ ...config, stage: '../../prod' }), /Stage/);
  assert.throws(() => validateConfig({ ...config, resourceNames: { ...config.resourceNames, database: 'another-database' } }), /resources will not be renamed/);
});

test('restart preserves saved keys and identity; truncated private config never regenerates secrets', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-installer-'));
  try {
    const original = fixture();
    await saveInstance(dir, original.config, original.secrets);
    const resumed = await readInstance(dir);
    assert.deepEqual(resumed, original);
    await saveInstance(dir, { ...resumed.config, phase: 'deploying' }, resumed.secrets);
    const second = await readInstance(dir);
    assert.equal(second.secrets.MAIL_DEK, original.secrets.MAIL_DEK);
    assert.equal(second.config.instanceId, original.config.instanceId);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, '.local/secrets.json'))).mode & 0o777, 0o600);
    await rm(join(dir, '.local/secrets.json'));
    await assert.rejects(readInstance(dir), /will not be regenerated/);
    assert.doesNotMatch(await readFile(join(dir, '.local/instance.json'), 'utf8'), new RegExp(original.secrets.MAIL_DEK.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('key, account, slug and stage changes block redeploy', () => {
  const { config, secrets } = fixture();
  assert.throws(() => assertStable(config, { ...secrets, MAIL_DEK: 'new-key' }), /keys changed/);
  assert.throws(() => assertStable(config, secrets, { CLOUDFLARE_ACCOUNT_ID: accountA }), /conflicts/);
  assert.throws(() => assertStable(config, secrets, { INSTANCE_STAGE: 'other' }), /conflicts/);
  const env = deploymentEnv(config, secrets, 'deploy-test-token', {});
  assert.equal(env.APP_CLOUDFLARE_API_TOKEN, secrets.runtimeToken);
  assert.notEqual(env.APP_CLOUDFLARE_API_TOKEN, env.CLOUDFLARE_API_TOKEN);
  assert.equal(env.MAIL_ROUTING_MODE, 'manual');
});

test('unknown remote ownership and remote key drift block deployment', () => {
  const { config } = fixture();
  assert.doesNotThrow(() => assertRemoteIdentity(config, { bindings: identityBindings(config) }));
  assert.throws(() => assertRemoteIdentity(config, { bindings: [] }), /another instance/);
  assert.throws(() => assertRemoteIdentity(config, { bindings: identityBindings({ ...config, keyFingerprint: 'changed' }) }), /fingerprint differs/);
  const stub = { bindings: [], tags: [`mail-instance:${config.instanceId}`, `mail-keys:${config.keyFingerprint}`] };
  assert.doesNotThrow(() => assertRemoteIdentity({ ...config, phase: 'deploying' }, stub));
  assert.throws(() => assertRemoteIdentity({ ...config, phase: 'deployed' }, stub), /another instance/);
});

test('fresh setup refuses orphaned storage instead of adopting mail data', async () => {
  const { config } = fixture();
  await assert.rejects(assertUnclaimedResources(config, async () => ({ result: [{ name: config.resourceNames.database }] })), /database already/);
});

test('pilot DNS preview keeps provider apex and explicitly covers mailbox/alias rules', () => {
  const { config } = fixture();
  const records = [{ type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1 }];
  assert.equal(externalMx(records, 'example.com').length, 1);
  const preview = dnsPreview(config, records);
  assert.equal(preview.apexUntouched, true);
  assert.ok(preview.planned.some((item) => item.includes('Literal mailbox and alias')));
  assert.ok(preview.planned.every((item) => !item.includes('MX on example.com')));
});

test('installer lock releases on interrupted operation and blocks concurrent setup', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-lock-'));
  try {
    await assert.rejects(withInstallLock(dir, async () => { await assert.rejects(withInstallLock(dir, async () => {}), /Another installer/); throw new Error('interrupted'); }), /interrupted/);
    assert.equal(await withInstallLock(dir, async () => 'resumed'), 'resumed');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('release input rejects shell/option/ref-expression injection', () => {
  for (const tag of ['--force', 'v1; echo secret', '$(whoami)', 'main~2', 'v1..v2', 'HEAD^{tree}']) assert.throws(() => assertUpgradeTag(tag));
  assert.equal(assertUpgradeTag('v1.2.3'), 'v1.2.3');
});

test('upgrade blocks source changes, divergent tags, dirty edits and incompatible configuration', () => {
  const { config } = fixture();
  const release = { sourceOrigin: config.sourceOrigin, dirty: false, current: 'old-commit', target: 'new-commit', publishedCommits: ['new-commit'], isAncestor: true, manifest: { scripts: { setup: 'node setup', upgrade: 'node upgrade' }, engines: { node: '>=24 <25' }, mailInstaller: { configVersion: 1 } } };
  assert.deepEqual(assertUpgradeTarget(config, release), { from: 'old-commit', to: 'new-commit' });
  assert.throws(() => assertUpgradeTarget(config, { ...release, sourceOrigin: 'https://other-source.example/mail.git' }), /source differs/);
  assert.throws(() => assertUpgradeTarget(config, { ...release, dirty: true }), /Tracked edits/);
  assert.throws(() => assertUpgradeTarget(config, { ...release, publishedCommits: ['another-commit'] }), /published source/);
  assert.throws(() => assertUpgradeTarget(config, { ...release, isAncestor: false }), /diverges/);
  assert.throws(() => assertUpgradeTarget(config, { ...release, manifest: { ...release.manifest, mailInstaller: { configVersion: 2 } } }), /configuration/);
});

test('admin recovery cannot bootstrap an unprovisioned external identity', () => {
  assert.throws(() => requireExistingSuperadmin(undefined), /cannot create users/);
  assert.throws(() => requireExistingSuperadmin({ role: 'member', hasCredential: 1 }), /non-superadmin/);
  assert.throws(() => requireExistingSuperadmin({ role: 'superadmin', hasCredential: 0 }), /no password/);
  assert.equal(requireExistingSuperadmin({ id: 'admin-id', role: 'superadmin', hasCredential: 1 }).id, 'admin-id');
});

test('subprocess passes metacharacters literally without shell expansion', async () => {
  const argument = 'a space; $HOME $(whoami) `quoted`';
  const output = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument], { capture: true });
  assert.equal(output, argument);
});

test('Cloudflare credential never appears in errors', async () => {
  const request = cloudflare('very-private-token', async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer very-private-token');
    return { ok: false, status: 403, json: async () => ({ success: false, errors: [{ code: 10000, message: 'very-private-token rejected' }] }) };
  });
  await assert.rejects(request('/accounts'), (error) => !error.message.includes('very-private-token') && error.message.includes('permissions'));
});

test('doctor is read-only and does not claim real mail delivery or write-permission proof', async () => {
  const { config, secrets } = fixture();
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path === `/zones/${zoneId}`) return { result: { account: { id: accountB }, name: 'example.com', status: 'active' } };
    if (path.endsWith('/subscriptions')) return { result: [{ rate_plan: { id: 'workers_paid' } }] };
    if (path.includes('/email/routing/rules?')) return { result: [{ enabled: true, matchers: [{ type: 'literal', field: 'to', value: 'admin@pilot.example.com' }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] }] };
    if (path.includes('/email/sending/subdomains?')) return { result: [{ enabled: true, name: config.mailDomain }] };
    if (path.includes('/workers/scripts/')) return { result: { bindings: [...identityBindings(config), ...['DB', 'AUTH_KV', 'MAIL_RAW', 'MAIL_QUEUE', 'MAIL_OUT_QUEUE', 'MAIL_EVENTS', 'EMAIL_SENDER', 'APP_CLOUDFLARE_API_TOKEN'].map((name) => ({ name, id: name === 'DB' ? 'db-id' : undefined }))] } };
    if (path.includes('/d1/database/db-id')) return { result: { name: config.resourceNames.database } };
    if (path.includes('/queues/inbound-id/consumers')) return { result: [{ script_name: config.resourceNames.inbound, dead_letter_queue: config.resourceNames.inboundDlq }] };
    if (path.includes('/queues?')) return { result: [{ queue_name: config.resourceNames.inboundQueue, queue_id: 'inbound-id' }, { queue_name: config.resourceNames.inboundDlq, queue_id: 'dlq-id' }] };
    if (path.includes('/dns_records')) return { result: [{ type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1 }, { type: 'MX', name: 'pilot.example.com', content: 'route1.mx.cloudflare.net' }, { type: 'TXT', name: 'pilot.example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all' }, ...['cf-bounce.pilot.example.com', 'cf-bounce._domainkey.pilot.example.com', '_dmarc.pilot.example.com'].map((name) => ({ name }))] };
    return { result: {} };
  };
  const fetcher = async (url, options) => {
    assert.equal(options.method, undefined);
    if (url.startsWith('https://mail.')) return { status: 200 };
    return { ok: true, status: 200, json: async () => ({ success: true, result: {} }) };
  };
  const checks = await inspectInstance(config, secrets, 'deploy-test-token', { api, fetcher });
  assert.ok(checks.every((check) => check.status !== 'fail'));
  assert.ok(checks.some((check) => check.status === 'manual' && check.detail.includes('cannot prove delivery')));
  assert.ok(checks.find((check) => check.name === 'Runtime token scope').detail.includes('Write permissions'));
  assert.ok(paths.length > 3);
});

const recipientRule = (config, address = `admin@${config.mailDomain}`) => ({ enabled: true, matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] });

async function mailDoctor(config, overrides = {}) {
  const paths = [];
  const api = async (path) => {
    paths.push(path);
    if (path.includes('/email/routing/rules?')) return overrides.rulesResponse?.(path) ?? { result: overrides.rules ?? [recipientRule(config)] };
    if (path.endsWith('/email/routing/rules/catch_all')) {
      if (overrides.catchAllError) throw overrides.catchAllError;
      return { result: overrides.catchAll ?? { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] } };
    }
    if (path.endsWith('/email/routing')) return { result: overrides.routing ?? { enabled: true, status: 'ready' } };
    if (path.includes('/email/sending/subdomains?')) {
      if (overrides.sendingError) throw overrides.sendingError;
      return overrides.sendingResponse?.(path) ?? { result: overrides.sending ?? [{ name: config.mailDomain, enabled: true }] };
    }
    if (path.includes('/dns_records')) return { result: overrides.records ?? [{ type: 'MX', name: config.zoneName, content: 'aspmx.l.google.com', priority: 1 }] };
    if (path === `/zones/${config.zoneId}`) return { result: { account: { id: config.accountId }, name: config.zoneName, status: 'active' } };
    if (path.endsWith('/subscriptions')) return { result: [{ rate_plan: { id: 'workers_paid' } }] };
    return { result: {} };
  };
  const checks = await inspectInstance(config, fixture().secrets, 'deploy-test-token', { api, fetcher: async () => ({ ok: true, status: 200, json: async () => ({ success: true, result: {} }) }) });
  return { checks, paths, check: (name) => checks.find((entry) => entry.name === name) };
}

test('doctor validates all selected-domain literal rules across pages without depending on apex routing', async () => {
  const { config } = fixture();
  const result = await mailDoctor(config, { rulesResponse: (path) => ({ result: path.includes('page=1&') ? [recipientRule(config), { ...recipientRule(config, 'old@example.com'), actions: [{ type: 'forward', value: ['other@example.net'] }] }] : [recipientRule(config, 'alias@pilot.example.com')], result_info: { total_pages: 2 } }) });
  assert.equal(result.check('Recipient Email Routing').status, 'pass');
  assert.match(result.check('Recipient Email Routing').detail, /2 enabled literal/);
  assert.equal(result.paths.filter((path) => path.includes('/email/routing/rules?')).length, 2);
  assert.ok(!result.paths.some((path) => path.endsWith('/email/routing') || path.endsWith('/catch_all')));
});

test('doctor rejects conflicting enabled recipient actions, matchers and duplicate addresses', async () => {
  const { config } = fixture();
  const valid = recipientRule(config);
  const conflicting = [
    [{ ...valid, actions: [{ type: 'worker', value: ['another-worker'] }] }],
    [{ ...valid, actions: [{ type: 'worker', value: [config.resourceNames.inbound, 'another-worker'] }] }],
    [{ ...valid, actions: [...valid.actions, { type: 'forward', value: ['other@example.net'] }] }],
    [{ ...valid, matchers: [...valid.matchers, { type: 'all' }] }],
    [valid, recipientRule(config, `ADMIN@${config.mailDomain.toUpperCase()}`)]
  ];
  for (const rules of conflicting) {
    const result = await mailDoctor(config, { rules });
    assert.equal(result.check('Recipient Email Routing').status, 'fail');
    assert.match(result.check('Recipient Email Routing').detail, /Review/);
  }
});

test('doctor reports a pilot with absent or disabled literal rules as unconfigured', async () => {
  const { config } = fixture();
  for (const rules of [[], [{ ...recipientRule(config), enabled: false }]]) {
    const result = await mailDoctor(config, { rules });
    assert.equal(result.check('Recipient Email Routing').status, 'fail');
    assert.match(result.check('Recipient Email Routing').detail, /provision a mailbox\/alias/);
    assert.match(result.check('Recipient Email Routing').detail, /Subdomains cannot use an apex catch-all/);
    assert.equal(result.check('Pilot apex MX preservation').status, 'pass');
  }
});

test('doctor checks preserved apex MX even when pilot routing/DNS are incomplete', async () => {
  const { config } = fixture();
  const result = await mailDoctor(config, { rules: [], records: [{ type: 'MX', name: config.zoneName, content: 'route1.mx.cloudflare.net', priority: 1 }] });
  assert.equal(result.check('Recipient Email Routing').status, 'fail');
  assert.equal(result.check('Inbound and sending DNS').status, 'fail');
  assert.equal(result.check('Pilot apex MX preservation').status, 'fail');
  assert.match(result.check('Pilot apex MX preservation').detail, /Restore the saved provider/);
});

test('doctor requires a ready apex and an enabled catch-all exclusively targeting the inbound Worker', async () => {
  const { config } = fixture();
  config.routingMode = 'apex';
  config.mailDomain = config.zoneName;
  const ready = await mailDoctor(config, { rules: [] });
  assert.equal(ready.check('Recipient Email Routing').status, 'pass');
  assert.ok(ready.paths.includes(`/zones/${zoneId}/email/routing/rules/catch_all`));
  const incomplete = await mailDoctor(config, { routing: { enabled: false, status: 'unconfigured' } });
  assert.equal(incomplete.check('Recipient Email Routing').status, 'fail');
  assert.match(incomplete.check('Recipient Email Routing').detail, /deliberate apex onboarding/);
  for (const override of [
    { catchAll: { enabled: false } },
    { catchAll: { enabled: true, matchers: [{ type: 'all' }], actions: [{ type: 'worker', value: ['another-worker'] }] } },
    { catchAllError: Object.assign(new Error('not found'), { status: 404 }) }
  ]) {
    const result = await mailDoctor(config, override);
    assert.equal(result.check('Recipient Email Routing').status, 'fail');
    assert.match(result.check('Recipient Email Routing').detail, /did not replace/);
  }
});

test('doctor inspects exact native sending identity and distinguishes missing/disabled domains', async () => {
  const { config } = fixture();
  const missing = await mailDoctor(config, { sending: [{ name: config.zoneName, enabled: true }, { name: `*.${config.zoneName}`, enabled: true }] });
  assert.equal(missing.check('Native sending domain').status, 'fail');
  assert.match(missing.check('Native sending domain').detail, /Onboard this domain/);
  const disabled = await mailDoctor(config, { sending: [{ name: config.mailDomain, enabled: false }] });
  assert.equal(disabled.check('Native sending domain').status, 'fail');
  assert.match(disabled.check('Native sending domain').detail, /Re-enable this exact domain/);
  const enabled = await mailDoctor(config, { sendingResponse: (path) => ({ result: path.includes('page=1&') ? [{ name: config.zoneName, enabled: true }] : [{ name: config.mailDomain.toUpperCase(), enabled: true }], result_info: { total_pages: 2 } }) });
  assert.equal(enabled.check('Native sending domain').status, 'pass');
  assert.equal(enabled.paths.filter((path) => path.includes('/email/sending/subdomains?')).length, 2);
  assert.match(enabled.check('Native sending domain').detail, /does not report separate DNS-verification\/delivery/);
});

test('doctor sending-permission errors provide action without exposing credential/server text', async () => {
  const { config } = fixture();
  const result = await mailDoctor(config, { sendingError: Object.assign(new Error('private-runtime-token was rejected'), { status: 403 }) });
  const check = result.check('Native sending domain');
  assert.equal(check.status, 'fail');
  assert.match(check.detail, /HTTP 403/);
  assert.match(check.detail, /Email Sending Read\/Edit permissions/);
  assert.ok(!check.detail.includes('private-runtime-token'));
});

test('bootstrap opener uses platform executables and a literal URL argument without a shell', () => {
  const url = 'https://mail.example.com/setup?token=private-token';
  assert.deepEqual(browserCommand(url, 'win32'), { command: 'rundll32.exe', args: ['url.dll,FileProtocolHandler', url] });
  assert.deepEqual(browserCommand(url, 'darwin'), { command: 'open', args: [url] });
  assert.deepEqual(browserCommand(url, 'linux'), { command: 'xdg-open', args: [url] });
});

test('bootstrap rerun reuses the private link, opens locally and provides actionable browser fallback', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-bootstrap-'));
  try {
    const { config, secrets } = fixture();
    await saveInstance(dir, config, secrets);
    let printed = '';
    const launched = [];
    const options = { root: dir, env: {}, output: { isTTY: true, write: (value) => { printed += value; } }, fetcher: async (url) => { assert.ok(!url.includes(secrets.SETUP_TOKEN)); return { status: 200 }; }, launch: async (...args) => { launched.push(args); throw new Error('not installed'); }, platform: 'linux' };
    assert.equal(await presentBootstrap(config, secrets, options), 'pending');
    const first = JSON.parse(await readFile(join(dir, '.local/bootstrap.json'), 'utf8'));
    assert.equal(first.url, bootstrapUrl(config, secrets));
    assert.match(printed, /Copy the private link/);
    assert.equal(launched[0][0], 'xdg-open');
    assert.equal(launched[0][2].capture, true);
    assert.deepEqual(launched[0][2].secrets, [first.url]);
    await presentBootstrap(config, secrets, options);
    assert.deepEqual(JSON.parse(await readFile(join(dir, '.local/bootstrap.json'), 'utf8')), first);
    assert.equal(launched.length, 2);
    if (process.platform !== 'win32') assert.equal((await stat(join(dir, '.local/bootstrap.json'))).mode & 0o777, 0o600);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('bootstrap never logs a token or launches a browser in CI/non-interactive output', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-bootstrap-ci-'));
  try {
    const { config, secrets } = fixture();
    await saveInstance(dir, config, secrets);
    for (const [env, isTTY] of [[{ CI: 'true' }, true], [{}, false]]) {
      let printed = '';
      await presentBootstrap(config, secrets, { root: dir, env, output: { isTTY, write: (value) => { printed += value; } }, fetcher: async () => ({ status: 200 }), launch: async () => assert.fail('browser must not launch') });
      assert.ok(!printed.includes(secrets.SETUP_TOKEN));
      assert.match(printed, /\.local\/bootstrap\.json/);
      assert.match(printed, /pending/);
    }
    assert.ok((await readFile(join(dir, '.local/bootstrap.json'), 'utf8')).includes(secrets.SETUP_TOKEN));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('completed bootstrap skips credential disclosure and browser launch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'mail-bootstrap-complete-'));
  try {
    const { config, secrets } = fixture();
    await saveInstance(dir, config, secrets);
    let printed = '';
    const result = await presentBootstrap(config, secrets, { root: dir, env: {}, output: { isTTY: true, write: (value) => { printed += value; } }, fetcher: async () => ({ status: 303, headers: new Headers({ location: '/login?notice=Setup%20already%20completed' }) }), launch: async () => assert.fail('completed bootstrap must not launch') });
    assert.equal(result, 'complete');
    assert.match(printed, /already completed/);
    assert.ok(!printed.includes(secrets.SETUP_TOKEN));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('setup runs doctor automatically and leaves an unconfigured pilot pending', async () => {
  const instance = fixture();
  const calls = [];
  let printed = '';
  const expected = [{ status: 'pass', name: 'Worker bindings', detail: 'Configured' }, { status: 'fail', name: 'Inbound DNS', detail: 'Complete pilot routing' }, { status: 'manual', name: 'Live mail', detail: 'Send/receive test required' }];
  const checks = await finishSetup(instance, 'deploy-test-token', { bootstrap: async () => { calls.push('bootstrap'); }, inspect: async (config, secrets, token) => { calls.push('doctor'); assert.equal(config, instance.config); assert.equal(secrets, instance.secrets); assert.equal(token, 'deploy-test-token'); return expected; }, output: { write: (value) => { printed += value; } } });
  assert.deepEqual(calls, ['bootstrap', 'doctor']);
  assert.equal(checks, expected);
  assert.match(printed, /FAIL Inbound DNS/);
  assert.match(printed, /remains pending/);
  assert.match(paidRequirement, /\$5\/month/);
  assert.match(paidRequirement, /3,000 outbound emails/);
});
