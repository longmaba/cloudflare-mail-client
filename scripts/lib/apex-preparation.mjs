// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertStable, atomicJson, fingerprint } from './instance.mjs';
import { dnsSnapshot, externalMx } from './cloudflare.mjs';

/** Reserve only account preparation. The API surface used here is read-only;
 * receiving DNS, rules, native sending and the primary mail domain stay intact. */
export async function prepareApexAccounts(root, config, secrets, api, {
  writeJson = atomicJson, now = () => new Date(),
} = {}) {
  assertStable(config, secrets);
  if (!['deployed', 'deploying'].includes(config.phase) || config.routingMode !== 'manual' || config.mailDomain === config.zoneName || (config.phase !== 'deployed' && !config.apexPreparation)) {
    throw new Error('Finish deploying and verifying the pilot before preparing apex accounts. Primary receiving configuration was not changed.');
  }
  const zone = (await api(`/zones/${config.zoneId}`)).result;
  if (zone?.id !== config.zoneId || zone?.name !== config.zoneName || zone?.account?.id !== config.accountId || zone?.status !== 'active') {
    throw new Error('The saved account/zone is not active or no longer matches this instance. Apex preparation blocked.');
  }
  if (config.apexPreparation) {
    let record;
    try { record = JSON.parse(await readFile(join(root, '.local', config.apexPreparation.snapshot), 'utf8')); }
    catch { throw new Error('The original preparation DNS snapshot is missing or unreadable. Restore it before resuming; it will not be overwritten.'); }
    if (fingerprint(JSON.stringify(record)) !== config.apexPreparation.digest || record.kind !== 'apex-account-preparation' || record.accountId !== config.accountId || record.zoneId !== config.zoneId || record.instanceId !== config.instanceId || record.keyFingerprint !== config.keyFingerprint || record.primaryMailDomain !== config.mailDomain) {
      throw new Error('The saved preparation snapshot does not match this instance. Restore the original snapshot before resuming.');
    }
    return config;
  }
  const records = await dnsSnapshot(api, config.zoneId);
  const providerMx = externalMx(records, config.zoneName);
  if (!providerMx.length) throw new Error('No existing apex receiver was found. Account staging is for a verified pilot with an existing provider; no receiving records were changed.');
  const capturedAt = now().toISOString();
  const snapshot = `before-apex-preparation-${randomUUID()}.json`;
  const record = {
    version: 1, kind: 'apex-account-preparation', capturedAt,
    accountId: config.accountId, zoneId: config.zoneId, zoneName: config.zoneName,
    instanceId: config.instanceId, keyFingerprint: config.keyFingerprint,
    primaryMailDomain: config.mailDomain, routingMode: config.routingMode,
    targetMailDomain: config.zoneName, resourceNames: config.resourceNames,
    records,
    // This snapshot is not a cutover authorization or a permanently current DNS
    // diff. Cutover needs a fresh snapshot and readiness of every production user.
    receivingChanged: false, cutoverRequiresFreshSnapshot: true,
  };
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  await writeJson(join(root, '.local', snapshot), record);
  return { ...config, stagedMailDomain: config.zoneName, apexPreparation: { snapshot, digest: fingerprint(JSON.stringify(record)), capturedAt } };
}
