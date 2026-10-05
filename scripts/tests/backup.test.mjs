// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { captureD1RestorePoint } from '../lib/backup.mjs';
import { atomicJson, keyFingerprint, newSecrets, resourceNames, saveInstance } from '../lib/instance.mjs';

const bookmark = '00000085-0000024c-00004c6d-8e61117bf38d7adb71b934ebbf891683';
const databaseId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const release = { databaseId, tag: 'v1.0.1', from: 'a'.repeat(40), to: 'b'.repeat(40) };
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mail-upgrade recovery with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = { ...newSecrets(), deployToken: 'synthetic-deploy-credential', runtimeToken: 'synthetic-runtime-credential' };
  const config = {
    version: 1, instanceId: 'saved-instance', instanceSlug: 'example', stage: 'prod',
    accountId: 'a'.repeat(32), zoneId: 'c'.repeat(32), zoneName: 'example.com',
    mailDomain: 'pilot.example.com', routingMode: 'manual', appName: 'Example Mail', appOrigin: 'https://mail.example.com',
    sourceOrigin: 'https://github.com/example/mail.git', sourceRemote: 'origin', keyFingerprint: keyFingerprint(secrets), phase: 'deployed',
  };
  config.resourceNames = resourceNames(config);
  await saveInstance(root, config, secrets);
  return { root, config, secrets };
}
const points = async root => (await readdir(join(root, '.local'))).filter(name => name.startsWith('before-upgrade-'));

test('captures a protected full-D1 restore point using only read-only Time Travel, preserving FTS and private identity', async (t) => {
  const { root, config, secrets } = await fixture(t);
  const priorState = await readFile(join(root, '.local', 'instance.json'));
  const priorKeys = await readFile(join(root, '.local', 'secrets.json'));
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec("CREATE VIRTUAL TABLE message_search USING fts5(subject); INSERT INTO message_search(subject) VALUES ('stored mail');");
  let called = 0;
  const result = await captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, {
    now: () => new Date('2026-10-06T01:02:03.000Z'),
    execute: async (args, options) => {
      called++;
      assert.deepEqual(args, ['d1', 'time-travel', 'info', 'DB', '--json', '--config', join(root, '.local', 'backup-wrangler.json')]);
      assert.equal(options.capture, true);
      assert.equal(options.env.WRANGLER_LOG, 'log');
      assert.equal(options.env.WRANGLER_WRITE_LOGS, 'false');
      assert.equal(options.env.CLOUDFLARE_API_TOKEN, secrets.deployToken);
      assert.equal(options.env.CLOUDFLARE_ACCOUNT_ID, config.accountId);
      assert(options.secrets.includes(secrets.deployToken));
      assert(options.secrets.includes(secrets.runtimeToken));
      const cliConfig = JSON.parse(await readFile(args.at(-1), 'utf8'));
      assert.deepEqual(cliConfig, { name: config.resourceNames.web, account_id: config.accountId, d1_databases: [{ binding: 'DB', database_name: config.resourceNames.database, database_id: databaseId }] });
      // Additional provider properties must never enter the saved record.
      return `\uFEFF${JSON.stringify({ bookmark, ignored: secrets.deployToken })}\n`;
    },
  });
  assert.equal(called, 1);
  assert.equal(result.capturedAt, '2026-10-06T01:02:03.000Z');
  const raw = await readFile(result.path, 'utf8');
  const record = JSON.parse(raw);
  assert.deepEqual(record, {
    version: 1, kind: 'd1-time-travel', capturedAt: result.capturedAt, bookmark,
    accountId: config.accountId,
    database: { binding: 'DB', id: databaseId, name: config.resourceNames.database },
    instance: { id: config.instanceId, slug: config.instanceSlug, stage: config.stage },
    source: { origin: config.sourceOrigin, remote: config.sourceRemote, ...Object.fromEntries(['tag', 'from', 'to'].map(name => [name, release[name]])) },
    keyFingerprint: config.keyFingerprint,
    retention: { workersPaidDays: 30, workersFreeDays: 7 },
    independentBackupsRequired: ['R2 mail objects', '.local private instance state and original keys'],
  });
  for (const value of Object.values(secrets)) assert(!raw.includes(value), 'Restore-point record must never contain credentials or encryption keys.');
  assert.deepEqual(await readFile(join(root, '.local', 'instance.json')), priorState);
  assert.deepEqual(await readFile(join(root, '.local', 'secrets.json')), priorKeys);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM message_search WHERE message_search MATCH 'stored'").get().count, 1);
  if (process.platform !== 'win32') {
    assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(root, '.local', 'backup-wrangler.json'))).mode & 0o777, 0o600);
  }
});

test('repeated or interrupted upgrades retain distinct recovery records without altering resources or keys', async (t) => {
  const { root, config, secrets } = await fixture(t);
  const before = await readFile(join(root, '.local', 'secrets.json'));
  const options = { execute: async () => JSON.stringify({ bookmark }), now: () => new Date('2026-10-06T01:02:03.000Z') };
  const first = await captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, options);
  const resumed = await captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, options);
  assert.notEqual(first.path, resumed.path);
  assert.equal((await points(root)).length, 2);
  assert.equal(JSON.parse(await readFile(first.path)).database.id, databaseId);
  assert.equal(JSON.parse(await readFile(resumed.path)).keyFingerprint, config.keyFingerprint);
  assert.deepEqual(await readFile(join(root, '.local', 'secrets.json')), before);
});

for (const [index, response] of ['not JSON synthetic-private-output', '', 'null', '[]', '{}', '{"bookmark":""}', '{"bookmark":"   "}', JSON.stringify({ bookmark: [bookmark] }), JSON.stringify({ result: { bookmark } }), JSON.stringify({ bookmark, success: false }), JSON.stringify({ bookmark, errors: [{ message: 'synthetic-private-output' }] }), JSON.stringify({ bookmark: `${bookmark}\n` }), JSON.stringify({ bookmark: '$(synthetic-private-output)' })].entries()) {
  test(`malformed Time Travel response #${index + 1} blocks recovery capture without exposing provider output`, async (t) => {
    const { root, config, secrets } = await fixture(t);
    await assert.rejects(captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, {
      execute: async () => response,
    }), error => {
      assert.match(error.message, /Upgrade blocked before checkout/);
      assert(!error.message.includes('synthetic-private-output'));
      assert(!error.message.includes(bookmark));
      return true;
    });
    assert.deepEqual(await points(root), []);
  });
}

test('permission and provider failures are sanitized and cannot produce a recovery record', async (t) => {
  const { root, config, secrets } = await fixture(t);
  for (const status of [403, 429, 502]) {
    await assert.rejects(captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, {
      execute: async () => { throw new Error(`${status}: ${secrets.deployToken} synthetic-private-mail`); },
    }), error => {
      assert.match(error.message, /D1 permissions and Cloudflare availability/);
      assert(!error.message.includes(secrets.deployToken));
      assert(!error.message.includes('synthetic-private-mail'));
      return true;
    });
    assert.deepEqual(await points(root), []);
  }
});

test('failure to durably save a validated bookmark rejects before a caller can continue its upgrade', async (t) => {
  const { root, config, secrets } = await fixture(t);
  let returned = false;
  await assert.rejects((async () => {
    await captureD1RestorePoint(root, config, secrets, secrets.deployToken, release, {
      execute: async () => JSON.stringify({ bookmark }),
      writeJson: async (path, value) => {
        if (value.kind === 'd1-time-travel') throw new Error('Synthetic disk full');
        return atomicJson(path, value);
      },
    });
    returned = true;
  })(), /Synthetic disk full/);
  assert.equal(returned, false);
  assert.deepEqual(await points(root), []);
});

test('invalid database identity and key drift block capture before contacting D1', async (t) => {
  const { root, config, secrets } = await fixture(t);
  let calls = 0;
  const options = { execute: async () => { calls++; return JSON.stringify({ bookmark }); } };
  await assert.rejects(captureD1RestorePoint(root, config, secrets, secrets.deployToken, { ...release, databaseId: '--other-db' }, options), /database ID is invalid/);
  await assert.rejects(captureD1RestorePoint(root, config, { ...secrets, MAIL_DEK: 'changed' }, secrets.deployToken, release, options), /keys changed/);
  assert.equal(calls, 0);
});
