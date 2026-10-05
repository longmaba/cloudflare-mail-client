// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { atomicJson, deploymentEnv } from './instance.mjs';
import { wrangler } from './process.mjs';

/** D1 SQL export cannot handle this application's FTS virtual tables. Time
 * Travel recovers the complete production database without changing its schema. */
export async function captureD1RestorePoint(root, config, secrets, token, release, {
  execute = wrangler, writeJson = atomicJson, now = () => new Date(),
} = {}) {
  const { databaseId, tag, from, to } = release;
  if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId ?? '')) throw new Error('Live D1 database ID is invalid; upgrade blocked before checkout.');
  if (![tag, from, to].every(value => typeof value === 'string' && value.trim())) throw new Error('Upgrade release identity is incomplete; no restore point was captured.');
  const env = {
    ...deploymentEnv(config, secrets, token),
    // JSON is printed through Wrangler's log level; error suppresses it entirely.
    WRANGLER_LOG: 'log', WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false',
  };
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  const configPath = join(root, '.local', 'backup-wrangler.json');
  await writeJson(configPath, {
    name: config.resourceNames.web, account_id: config.accountId,
    d1_databases: [{ binding: 'DB', database_name: config.resourceNames.database, database_id: databaseId }],
  });
  let raw;
  try {
    // info always targets remote D1 and takes no --remote option. Captured pipes
    // and disabled log files keep bookmarks, credentials and provider errors private.
    raw = await execute(['d1', 'time-travel', 'info', 'DB', '--json', '--config', configPath], {
      env, capture: true, secrets: [token, ...Object.values(secrets)].filter(value => typeof value === 'string' && value),
    });
  } catch {
    throw new Error('Could not capture the D1 Time Travel restore point. Check the deploy credential D1 permissions and Cloudflare availability, then retry. Upgrade blocked before checkout.');
  }
  let result;
  try { result = JSON.parse(raw.replace(/^\uFEFF/, '').trim()); }
  catch { throw new Error('D1 Time Travel returned invalid JSON; raw output is suppressed. Upgrade blocked before checkout.'); }
  // Current D1 bookmarks consist of three 8-digit groups and one 32-digit
  // group. Reject blanks, nested responses, shell syntax and failed envelopes.
  if (!result || Array.isArray(result) || result.success === false
      || (result.errors != null && (!Array.isArray(result.errors) || result.errors.length))
      || typeof result.bookmark !== 'string'
      || !/^[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{8}-[a-f0-9]{32}$/i.test(result.bookmark)) {
    throw new Error('D1 Time Travel returned no valid bookmark. Upgrade blocked before checkout; update the installer if Cloudflare changed its bookmark format.');
  }
  const capturedAt = now().toISOString();
  const path = join(root, '.local', `before-upgrade-${capturedAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`);
  const record = {
    version: 1, kind: 'd1-time-travel', capturedAt, bookmark: result.bookmark,
    accountId: config.accountId,
    database: { binding: 'DB', id: databaseId, name: config.resourceNames.database },
    instance: { id: config.instanceId, slug: config.instanceSlug, stage: config.stage },
    source: { origin: config.sourceOrigin, remote: config.sourceRemote, tag, from, to },
    keyFingerprint: config.keyFingerprint,
    retention: { workersPaidDays: 30, workersFreeDays: 7 },
    independentBackupsRequired: ['R2 mail objects', '.local private instance state and original keys'],
  };
  // The atomic writer fsyncs before rename and applies mode 0600. Returning
  // only after it succeeds prevents checkout with an unsaved recovery point.
  await writeJson(path, record);
  return { path, capturedAt };
}
