// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { newSecrets, keyFingerprint, deploymentEnv, resourceNames } from '../lib/instance.mjs';
import { refreshedCredentials } from '../instance.mjs';

function fixture() {
  const secrets = { ...newSecrets(), runtimeToken: 'old-runtime', deployToken: 'old-deploy' };
  const config = { version: 1, instanceId: 'saved-instance', instanceSlug: 'example', stage: 'prod', sourceOrigin: 'https://github.com/example/mail.git', sourceRemote: 'origin', credentialSource: 'token', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32), zoneName: 'example.com', mailDomain: 'pilot.example.com', routingMode: 'manual', appName: 'Domain Mail', appOrigin: 'https://mail.example.com', keyFingerprint: keyFingerprint(secrets) };
  config.resourceNames = resourceNames(config);
  return { config, secrets };
}

test('replacement credentials reach deployment while preserving all instance keys and names', async () => {
  const { config, secrets } = fixture();
  const before = structuredClone({ config, secrets });
  const paths = [];
  const refreshed = await refreshedCredentials(config, secrets, 'new-deploy', { APP_CLOUDFLARE_API_TOKEN: 'new-runtime' }, async path => {
    paths.push(path);
    return { result: path === `/zones/${config.zoneId}` ? { id: config.zoneId, account: { id: config.accountId } } : {} };
  });
  assert.equal(paths.length, 3);
  assert.equal(refreshed.deployToken, 'new-deploy');
  assert.equal(refreshed.runtimeToken, 'new-runtime');
  assert.equal(keyFingerprint(refreshed), keyFingerprint(secrets));
  assert.deepEqual({ config, secrets }, before);
  const env = deploymentEnv(config, refreshed, 'new-deploy', {});
  assert.equal(env.CLOUDFLARE_API_TOKEN, 'new-deploy');
  assert.equal(env.APP_CLOUDFLARE_API_TOKEN, 'new-runtime');
  assert.equal(env.MAIL_DEK, secrets.MAIL_DEK);
  assert.equal(env.INSTANCE_ID, config.instanceId);
});

test('invalid replacement runtime permissions do not alter saved credentials', async () => {
  const { config, secrets } = fixture();
  const before = structuredClone(secrets);
  await assert.rejects(refreshedCredentials(config, secrets, 'new-deploy', { APP_CLOUDFLARE_API_TOKEN: 'new-runtime' }, async () => { throw new Error('Permission missing'); }), /Permission missing/);
  assert.deepEqual(secrets, before);
  await assert.rejects(refreshedCredentials(config, secrets, 'new-deploy', { APP_CLOUDFLARE_API_TOKEN: 'new-runtime' }, async () => ({ result: { id: config.zoneId, account: { id: 'c'.repeat(32) } } })), /saved account and zone/);
  assert.deepEqual(secrets, before);
});

test('resume reuses the stored runtime token and rejects binding the deployment credential', async () => {
  const { config, secrets } = fixture();
  const refreshed = await refreshedCredentials(config, secrets, 'new-deploy', {}, async () => { throw new Error('No API read expected'); });
  assert.equal(refreshed.runtimeToken, secrets.runtimeToken);
  await assert.rejects(refreshedCredentials(config, secrets, 'new-deploy', { APP_CLOUDFLARE_API_TOKEN: 'new-deploy' }), /separate runtime token/);
  assert.throws(() => deploymentEnv(config, secrets, 'new-deploy', { APP_CLOUDFLARE_API_TOKEN: 'new-runtime' }), /Run pnpm run setup/);
});
