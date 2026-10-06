// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

export const configVersion = 1;
export const secretNames = ['MAIL_DEK', 'MAIL_SEARCH_KEY', 'BETTER_AUTH_SECRET', 'SETUP_TOKEN'];
export const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
export const keyFingerprint = (secrets) => fingerprint(secretNames.map((name) => `${name}:${secrets[name]}`).join('\n'));

export function validateSlug(value, label = 'Instance slug') {
  if (!/^[a-z][a-z0-9-]{1,23}$/.test(value)) throw new Error(`${label} must use 2-24 lowercase letters, digits or hyphens, beginning with a letter.`);
  return value;
}

export function validateDomain(value) {
  const domain = value.trim().toLowerCase();
  if (domain.length > 253 || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) throw new Error('Enter a DNS domain such as example.com.');
  return domain;
}

export function validateConfig(config) {
  if (config.version !== configVersion) throw new Error('Unsupported instance configuration version. Use its matching release; do not overwrite the config.');
  validateSlug(config.instanceSlug);
  validateSlug(config.stage, 'Stage');
  if (!/^[a-f0-9]{32}$/.test(config.accountId) || !/^[a-f0-9]{32}$/.test(config.zoneId)) throw new Error('Invalid Cloudflare account or zone identifier.');
  validateDomain(config.zoneName);
  validateDomain(config.mailDomain);
  if (config.mailDomain !== config.zoneName && !config.mailDomain.endsWith(`.${config.zoneName}`)) throw new Error('The mail domain must belong to the selected zone.');
  if (!['manual', 'apex'].includes(config.routingMode)) throw new Error('Unknown mail routing mode.');
  if (config.routingMode === 'apex' && config.mailDomain !== config.zoneName) throw new Error('Apex routing requires the zone apex as mail domain.');
  if (config.stagedMailDomain !== undefined && (validateDomain(config.stagedMailDomain) !== config.zoneName || config.stagedMailDomain !== config.zoneName || config.mailDomain === config.zoneName || config.routingMode !== 'manual')) {
    throw new Error('Account preparation requires the selected zone apex and an unchanged pilot mail domain in manual mode.');
  }
  const preparation = config.apexPreparation;
  if (config.migratedMailDomain !== undefined && (config.migratedMailDomain !== config.zoneName || config.stagedMailDomain !== config.zoneName || config.routingMode !== 'manual' || config.mailDomain === config.zoneName)) {
    throw new Error('Migrated mail scope must match this instance\'s prepared apex and preserve its pilot.');
  }
  if ((config.stagedMailDomain !== undefined && !preparation) ||
      (preparation !== undefined && (!preparation || typeof preparation !== 'object' ||
        Array.isArray(preparation) || !config.stagedMailDomain ||
        !/^before-apex-preparation-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/.test(preparation.snapshot ?? '') ||
        !/^[a-f0-9]{64}$/.test(preparation.digest ?? '')))) {
    throw new Error('Apex preparation metadata is invalid. Restore the original private instance state.');
  }
  const origin = new URL(config.appOrigin);
  if (origin.protocol !== 'https:' || origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password) throw new Error('App origin must be a full HTTPS origin, without a path or credentials.');
  if (origin.hostname !== config.zoneName && !origin.hostname.endsWith(`.${config.zoneName}`)) throw new Error('The app origin must be within the selected zone.');
  if (!config.instanceId || !config.sourceOrigin || !config.sourceRemote || !config.keyFingerprint) throw new Error('Instance identity is incomplete. Restore the original .local configuration.');
  if (JSON.stringify(config.resourceNames) !== JSON.stringify(resourceNames(config))) throw new Error('Saved resource names differ from the instance slug/stage. Restore the original configuration; resources will not be renamed.');
  return config;
}

export function resourceNames(config) {
  const named = (name) => `${name}-${config.instanceSlug}-${config.stage}`;
  return { web: named('doota'), inbound: named('doota-mail-inbound'), jobs: named('doota-mail-jobs'), database: named('doota'), rawBucket: named('doota-mail-raw'), inboundQueue: named('doota-mail-inbound'), inboundDlq: named('doota-mail-inbound-dlq'), outboundQueue: named('doota-mail-outbound'), eventsQueue: named('doota-mail-events') };
}

export function newSecrets(overrides = {}) {
  const secrets = { MAIL_DEK: randomBytes(32).toString('base64'), MAIL_SEARCH_KEY: randomBytes(32).toString('base64'), BETTER_AUTH_SECRET: randomBytes(32).toString('base64url'), SETUP_TOKEN: randomBytes(32).toString('base64url') };
  for (const name of secretNames) if (overrides[name]) secrets[name] = overrides[name];
  for (const name of ['MAIL_DEK', 'MAIL_SEARCH_KEY']) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(secrets[name]) || Buffer.from(secrets[name], 'base64').length !== 32) throw new Error(`${name} must encode exactly 32 bytes as base64.`);
  }
  if (secrets.BETTER_AUTH_SECRET.length < 32 || secrets.SETUP_TOKEN.length < 32) throw new Error('Authentication/bootstrap secrets must be at least 32 characters.');
  return secrets;
}

export function assertStable(config, secrets, expected = {}) {
  validateConfig(config);
  for (const name of secretNames) {
    if (!secrets[name]) throw new Error(`Missing ${name}. Restore .local/secrets.json from backup; never generate a replacement for a live instance.`);
    if (expected[name] && expected[name] !== secrets[name]) throw new Error(`${name} changed. Restore the original value before continuing.`);
  }
  if (keyFingerprint(secrets) !== config.keyFingerprint) throw new Error('Instance keys changed. Restore the original secrets file; deployment is blocked.');
  for (const [envName, configName] of [['CLOUDFLARE_ACCOUNT_ID', 'accountId'], ['INSTANCE_SLUG', 'instanceSlug'], ['INSTANCE_STAGE', 'stage']]) {
    if (expected[envName] && expected[envName] !== config[configName]) throw new Error(`${envName} conflicts with the saved instance. Use a separate checkout for another instance.`);
  }
}

export function deploymentEnv(config, secrets, deployToken, inherited = process.env) {
  assertStable(config, secrets, inherited);
  if (inherited.APP_CLOUDFLARE_API_TOKEN && inherited.APP_CLOUDFLARE_API_TOKEN !== secrets.runtimeToken) throw new Error('Runtime token differs from saved credentials. Run pnpm run setup with the replacement tokens before deploying or upgrading.');
  return { ...inherited, ...Object.fromEntries(secretNames.map((name) => [name, secrets[name]])), CLOUDFLARE_API_TOKEN: deployToken, CLOUDFLARE_ACCOUNT_ID: config.accountId, APP_CLOUDFLARE_API_TOKEN: secrets.runtimeToken, APP_CLOUDFLARE_ACCOUNT_ID: config.accountId, INSTANCE_ID: config.instanceId, INSTANCE_SLUG: config.instanceSlug, INSTANCE_STAGE: config.stage, MAIL_KEY_FINGERPRINT: config.keyFingerprint, APP_NAME: config.appName, ORIGINS: config.appOrigin, MAIL_DOMAIN: config.mailDomain, MAIL_ROUTING_MODE: config.routingMode, MAIL_STAGING_DOMAIN: config.stagedMailDomain ?? '', MAIL_MIGRATED_DOMAIN: config.migratedMailDomain ?? '', MAIL_ZONE_ID: config.zoneId, MAIL_ZONE_NAME: config.zoneName };
}

export async function atomicJson(path, value) {
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temporaryPath, path); await chmod(path, 0o600); } finally { await rm(temporaryPath, { force: true }); }
}

export async function readInstance(root) {
  const dir = join(root, '.local');
  let config;
  try { config = JSON.parse(await readFile(join(dir, 'instance.json'), 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw new Error('Cannot read .local/instance.json. Restore a valid backup; it will not be overwritten.'); }
  let secrets;
  try { secrets = JSON.parse(await readFile(join(dir, 'secrets.json'), 'utf8')); } catch { throw new Error('Cannot read .local/secrets.json. Restore the original file; it will not be regenerated.'); }
  assertStable(config, secrets);
  return { config, secrets };
}

export async function saveInstance(root, config, secrets) {
  const dir = join(root, '.local');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Secrets go first: an interruption never leaves a config referencing missing keys.
  await atomicJson(join(dir, 'secrets.json'), secrets);
  await atomicJson(join(dir, 'instance.json'), validateConfig(config));
}

export async function withInstallLock(root, action) {
  const dir = join(root, '.local');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lockPath = join(dir, 'install.lock');
  let handle;
  try { handle = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const lock = JSON.parse(await readFile(lockPath, 'utf8'));
    try { process.kill(lock.pid, 0); } catch (pidError) { if (pidError.code === 'ESRCH') { await rm(lockPath); return withInstallLock(root, action); } throw pidError; }
    throw new Error(`Another installer is running (PID ${lock.pid}). Wait for it to finish.`);
  }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid })); await handle.close(); return await action(); } finally { await rm(lockPath, { force: true }); }
}
