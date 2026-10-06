// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareApexAccounts } from '../lib/apex-preparation.mjs';
import { deploymentEnv, keyFingerprint, newSecrets, readInstance, resourceNames, saveInstance, validateConfig } from '../lib/instance.mjs';

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'apex account preparation with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = { ...newSecrets(), deployToken: 'synthetic-deploy', runtimeToken: 'synthetic-runtime' };
  const config = { version: 1, instanceId: 'synthetic-instance', instanceSlug: 'example', stage: 'prod', sourceOrigin: 'https://github.com/example/mail.git', sourceRemote: 'origin', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com', mailDomain: 'pilot.example.com', routingMode: 'manual', appName: 'Example Mail', appOrigin: 'https://mail.example.com', phase: 'deployed', keyFingerprint: keyFingerprint(secrets) };
  config.resourceNames = resourceNames(config);
  await saveInstance(root, config, secrets);
  const records = [
    { id: 'c'.repeat(32), type: 'MX', name: config.zoneName, content: 'aspmx.l.google.com', priority: 1, ttl: 3600 },
    { id: 'd'.repeat(32), type: 'TXT', name: config.zoneName, content: 'v=spf1 include:_spf.google.com ~all', ttl: 3600 },
    { id: 'e'.repeat(32), type: 'TXT', name: `google._domainkey.${config.zoneName}`, content: 'provider-dkim', ttl: 3600 },
  ];
  const calls = [];
  const api = async path => {
    calls.push(path);
    if (path === `/zones/${config.zoneId}`) return { result: { id: config.zoneId, name: config.zoneName, status: 'active', account: { id: config.accountId } } };
    assert.match(path, new RegExp(`^/zones/${config.zoneId}/dns_records\\?`));
    return { result: records, result_info: { total_pages: 1 } };
  };
  return { root, config, secrets, records, calls, api };
}

test('preparation snapshots complete provider DNS and preserves primary routing, identities and keys', async t => {
  const f = await fixture(t);
  const beforeState = await readFile(join(f.root, '.local', 'instance.json'));
  const beforeKeys = await readFile(join(f.root, '.local', 'secrets.json'));
  const next = await prepareApexAccounts(f.root, f.config, f.secrets, f.api);
  assert.equal(f.calls.length, 2, 'Only zone and DNS GET endpoints are used.');
  assert.equal(next.mailDomain, f.config.mailDomain);
  assert.equal(next.routingMode, 'manual');
  assert.equal(next.stagedMailDomain, f.config.zoneName);
  assert.deepEqual(next.resourceNames, f.config.resourceNames);
  assert.equal(next.keyFingerprint, f.config.keyFingerprint);
  assert.equal(f.config.stagedMailDomain, undefined, 'Input state is not mutated before its caller can persist.');
  const path = join(f.root, '.local', next.apexPreparation.snapshot);
  const raw = await readFile(path, 'utf8');
  assert.deepEqual(JSON.parse(raw).records, f.records);
  assert.equal(JSON.parse(raw).receivingChanged, false);
  for (const secret of Object.values(f.secrets)) assert(!raw.includes(secret));
  assert.deepEqual(await readFile(join(f.root, '.local', 'instance.json')), beforeState);
  assert.deepEqual(await readFile(join(f.root, '.local', 'secrets.json')), beforeKeys);
  if (process.platform !== 'win32') assert.equal((await stat(path)).mode & 0o777, 0o600);
  const env = deploymentEnv(next, f.secrets, f.secrets.deployToken, { MAIL_STAGING_DOMAIN: 'foreign.test' });
  assert.equal(env.MAIL_STAGING_DOMAIN, f.config.zoneName);
  assert.equal(env.MAIL_DOMAIN, f.config.mailDomain);
  assert.equal(env.MAIL_ROUTING_MODE, 'manual');
  await saveInstance(f.root, next, f.secrets);
  assert.deepEqual((await readInstance(f.root)).config, next);
});

test('reruns after interrupted deployment retain the original protected preparation snapshot', async t => {
  const f = await fixture(t);
  const prepared = await prepareApexAccounts(f.root, f.config, f.secrets, f.api);
  await saveInstance(f.root, { ...prepared, phase: 'deploying' }, f.secrets);
  const resumed = await readInstance(f.root);
  const before = await readFile(join(f.root, '.local', prepared.apexPreparation.snapshot));
  f.calls.length = 0;
  const next = await prepareApexAccounts(f.root, resumed.config, resumed.secrets, f.api);
  assert.equal(next.apexPreparation.snapshot, prepared.apexPreparation.snapshot);
  assert.deepEqual(await readFile(join(f.root, '.local', prepared.apexPreparation.snapshot)), before);
  assert.equal((await readdir(join(f.root, '.local'))).filter(name => name.startsWith('before-apex-preparation-')).length, 1);
  assert.deepEqual(f.calls, [`/zones/${f.config.zoneId}`]);
});

test('missing or tampered saved snapshots block reruns instead of overwriting rollback evidence', async t => {
  const f = await fixture(t);
  const next = await prepareApexAccounts(f.root, f.config, f.secrets, f.api);
  const path = join(f.root, '.local', next.apexPreparation.snapshot);
  await writeFile(path, '{}');
  await assert.rejects(prepareApexAccounts(f.root, next, f.secrets, f.api), /does not match/);
  await rm(path);
  await assert.rejects(prepareApexAccounts(f.root, next, f.secrets, f.api), /missing or unreadable/);
});

test('invalid scope, incomplete pilot and key drift fail before contacting the provider', async t => {
  const f = await fixture(t);
  for (const config of [
    { ...f.config, phase: 'configured' },
    { ...f.config, phase: 'deploying' },
    { ...f.config, mailDomain: f.config.zoneName, routingMode: 'apex' },
    { ...f.config, stagedMailDomain: 'foreign.test' },
  ]) await assert.rejects(prepareApexAccounts(f.root, config, f.secrets, f.api));
  await assert.rejects(prepareApexAccounts(f.root, f.config, { ...f.secrets, MAIL_DEK: 'different' }, f.api), /keys changed/);
  assert.equal(f.calls.length, 0);
  for (const apexPreparation of [undefined, null, false, [], 'invalid']) {
    assert.throws(() => validateConfig({ ...f.config, stagedMailDomain: f.config.zoneName, apexPreparation }), /metadata is invalid/);
  }
  assert.throws(() => validateConfig({ ...f.config, stagedMailDomain: f.config.zoneName, apexPreparation: { snapshot: '../../outside.json', digest: 'a'.repeat(64) } }), /metadata is invalid/);
  assert.equal(deploymentEnv(f.config, f.secrets, f.secrets.deployToken, { MAIL_STAGING_DOMAIN: 'foreign.test' }).MAIL_STAGING_DOMAIN, '', 'An inherited staging variable cannot authorize another domain.');
});

test('wrong or inactive provider zone, missing receiver, API failure and failed durable save leave the instance untouched', async t => {
  const f = await fixture(t);
  const before = await readFile(join(f.root, '.local', 'instance.json'));
  for (const zone of [
    { id: f.config.zoneId, name: f.config.zoneName, status: 'pending', account: { id: f.config.accountId } },
    { id: f.config.zoneId, name: f.config.zoneName, status: 'active', account: { id: 'f'.repeat(32) } },
    { id: f.config.zoneId, name: 'foreign.test', status: 'active', account: { id: f.config.accountId } },
  ]) await assert.rejects(prepareApexAccounts(f.root, f.config, f.secrets, async () => ({ result: zone })), /does not|not active/);
  await assert.rejects(prepareApexAccounts(f.root, f.config, f.secrets, async path => path.includes('/dns_records') ? { result: [], result_info: { total_pages: 1 } } : f.api(path)), /No existing apex receiver/);
  await assert.rejects(prepareApexAccounts(f.root, f.config, f.secrets, async () => { throw new Error('403 scoped credential'); }), /403/);
  await assert.rejects(prepareApexAccounts(f.root, f.config, f.secrets, f.api, { writeJson: async () => { throw new Error('Disk full'); } }), /Disk full/);
  assert.equal(f.config.stagedMailDomain, undefined);
  assert.deepEqual(await readFile(join(f.root, '.local', 'instance.json')), before);
  assert.equal((await readdir(join(f.root, '.local'))).filter(name => name.startsWith('before-apex-preparation-')).length, 0);
});
