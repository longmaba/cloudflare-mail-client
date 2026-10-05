// SPDX-License-Identifier: Apache-2.0
/** Password recovery for an EXISTING super-admin only. First-run provisioning belongs to /setup. */
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { hashPassword } from 'better-auth/crypto';
import { projectRoot, wrangler } from '../../../scripts/lib/process.mjs';
import { atomicJson, deploymentEnv, readInstance } from '../../../scripts/lib/instance.mjs';
import { currentToken, guardDeployment } from '../../../scripts/instance.mjs';
import { cloudflare, workerSettings } from '../../../scripts/lib/cloudflare.mjs';
import { maskedSecret } from '../../../scripts/lib/prompt.mjs';

export function requireExistingSuperadmin(user) {
  if (!user) throw new Error('No existing super-admin with this address. Use the private /setup bootstrap to provision the first admin and mailbox; this recovery tool cannot create users.');
  if (user.role !== 'superadmin') throw new Error('This address belongs to a non-superadmin user. Recovery is refused.');
  if (!user.hasCredential) throw new Error('This admin has no password credential. Recover through its configured sign-in method.');
  return user;
}

const esc = (value) => String(value).replace(/'/g, "''");
export const sessionCacheNotice = 'Database and KV session records removed. Existing cached browser cookies may still authorize requests for up to 5 minutes after KV deletion propagates; recovery is not immediate containment.';

/** Wrangler emits JSON results at log level. Capture them privately while
 * disabling debug output and Wrangler's on-disk response logs. */
export function recoveryWranglerOptions(env = process.env) {
  return { env: { ...env, WRANGLER_WRITE_LOGS: 'false', WRANGLER_LOG: 'log' }, capture: true, secrets: ['credential-output'] };
}

/** Persist exact keys before changing D1 so an interrupted KV purge can resume.
 * The journal is private and doubles as Wrangler's bulk-delete input: secrets
 * never appear in process arguments, terminal output or captured error details. */
export async function recoverExistingAdmin({ user, password, clearTwoFactor = false, execute, cachedTokens, purgeKeys, journal }) {
  requireExistingSuperadmin(user);
  const id = esc(user.id);
  const snapshot = await execute(`SELECT token FROM session WHERE user_id='${id}';`);
  if (!snapshot[0]?.success || !Array.isArray(snapshot[0].results)) throw new Error('Session enumeration failed. No recovery changes were made.');
  const keys = new Set([...(await journal.read()), ...snapshot[0].results.map((row) => row.token), ...(await cachedTokens()), `active-sessions-${user.id}`]);
  if ([...keys].some((key) => typeof key !== 'string' || !key)) throw new Error('Invalid session recovery state. No recovery changes were made.');
  await journal.save([...keys]);
  const hash = await hashPassword(password);
  const statements = [`UPDATE account SET password='${esc(hash)}', updated_at=(cast(unixepoch('subsecond')*1000 as integer)) WHERE provider_id='credential' AND user_id='${id}' AND EXISTS(SELECT 1 FROM user WHERE id='${id}' AND role='superadmin') RETURNING user_id;`, `DELETE FROM session WHERE user_id='${id}' RETURNING token;`];
  if (clearTwoFactor) statements.push(`DELETE FROM two_factor WHERE user_id='${id}';`, `UPDATE user SET two_factor_enabled=0 WHERE id='${id}' AND role='superadmin';`);
  const result = await execute(statements.join('\n'));
  if (!result.length || !result.every((entry) => entry.success)) throw new Error('D1 did not confirm every recovery statement. The private revocation journal is preserved; retry recovery.');
  if (!result[0].results?.some((row) => row.user_id === user.id)) throw new Error('D1 did not confirm the existing administrator password update. The private revocation journal is preserved; inspect the account before retrying.');
  // Include sessions created between enumeration and the atomic D1 deletion.
  for (const row of result[1]?.results ?? []) keys.add(row.token);
  for (const token of await cachedTokens()) keys.add(token);
  if ([...keys].some((key) => typeof key !== 'string' || !key)) throw new Error('Invalid session recovery state. The revocation journal is preserved; retry recovery.');
  await journal.save([...keys]);
  try { await purgeKeys([...keys]); } catch {
    throw new Error('Password updated, but KV session revocation did not complete. The private revocation journal is preserved; rerun the same recovery command. Do not assume old sessions are revoked.');
  }
  await journal.clear();
}

export async function main(args = process.argv.slice(2)) {
  if (args.some((arg) => arg.startsWith('--') && !['--remote', '--clear-2fa'].includes(arg))) throw new Error('Usage: pnpm reset-admin <existing-superadmin-email> [new-password] [--remote] [--clear-2fa]');
  const positionals = args.filter((arg) => !arg.startsWith('--'));
  const [email, suppliedPassword] = positionals;
  if (!email || positionals.length > 2 || !/^[^\s'@]+@[^\s'@]+\.[^\s'@]+$/.test(email)) throw new Error('Specify the existing super-admin email.');
  const password = suppliedPassword || await maskedSecret('New password (masked)');
  if (password.length < 12) throw new Error('Use a password of at least 12 characters.');
  const target = args.includes('--remote') ? '--remote' : '--local';
  const instance = await readInstance(projectRoot);
  let env = process.env;
  let configArgs = [];
  let database = 'doota';
  let remoteKv;
  if (instance && target === '--remote') {
    const token = await currentToken(instance.secrets, instance.config.credentialSource);
    await guardDeployment(instance.config, instance.secrets, token);
    const settings = await workerSettings(cloudflare(token), instance.config.accountId, instance.config.resourceNames.web);
    const databaseId = settings?.bindings.find((binding) => binding.name === 'DB')?.id;
    const namespaceId = settings?.bindings.find((binding) => binding.name === 'AUTH_KV')?.namespace_id;
    if (!databaseId) throw new Error('Saved instance has no live database binding. Restore it before recovery.');
    if (!namespaceId) throw new Error('Saved instance has no live AUTH_KV binding. Restore it before recovery; cached sessions must also be revoked.');
    const configPath = join(projectRoot, '.local/recovery-wrangler.json');
    await atomicJson(configPath, { name: instance.config.resourceNames.web, account_id: instance.config.accountId, d1_databases: [{ binding: 'DB', database_name: instance.config.resourceNames.database, database_id: databaseId }], kv_namespaces: [{ binding: 'AUTH_KV', id: namespaceId }] });
    remoteKv = { token, accountId: instance.config.accountId, namespaceId };
    configArgs = ['--config', configPath];
    database = 'DB';
    env = deploymentEnv(instance.config, instance.secrets, token);
  }
  if (target === '--remote' && !remoteKv) throw new Error('Remote recovery requires the original saved instance and its live DB/AUTH_KV bindings. Restore .local/ first.');
  // Wrangler's debug log normally records D1 responses, including session tokens.
  // Keep credential reads confined to captured pipes and the private journal.
  const commandOptions = recoveryWranglerOptions(env);
  const execute = async (sql) => {
    const output = await wrangler(['d1', 'execute', database, target, ...configArgs, '--json', '--command', sql], commandOptions);
    const start = output.indexOf('[');
    if (start < 0) throw new Error('D1 did not return a query result. No recovery result can be confirmed.');
    try { const result = JSON.parse(output.slice(start)); if (!Array.isArray(result)) throw new Error(); return result; }
    catch { throw new Error('D1 returned an unsupported query result. Recovery could not be confirmed.'); }
  };
  const rows = await execute(`SELECT id, role, EXISTS(SELECT 1 FROM account WHERE account.user_id=user.id AND provider_id='credential') AS hasCredential FROM user WHERE email='${esc(email)}';`);
  const user = requireExistingSuperadmin(rows?.[0]?.results?.[0]);
  await mkdir(join(projectRoot, '.local'), { recursive: true, mode: 0o700 });
  const scope = `${remoteKv?.accountId ?? 'local'}:${remoteKv?.namespaceId ?? 'AUTH_KV'}:${user.id}`;
  const journalPath = join(projectRoot, '.local', `recovery-sessions-${createHash('sha256').update(scope).digest('hex')}.json`);
  const journal = {
    read: async () => {
      try { const keys = JSON.parse(await readFile(journalPath, 'utf8')); if (!Array.isArray(keys)) throw new Error(); return keys; }
      catch (error) { if (error.code === 'ENOENT') return []; throw new Error('Cannot read the private session revocation journal. Restore it before retrying.'); }
    },
    save: (keys) => atomicJson(journalPath, keys),
    clear: () => rm(journalPath, { force: true }),
  };
  const cachedTokens = async () => {
    const key = `active-sessions-${user.id}`;
    let value;
    if (remoteKv) {
      const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${remoteKv.accountId}/storage/kv/namespaces/${remoteKv.namespaceId}/values/${encodeURIComponent(key)}`, { headers: { Authorization: `Bearer ${remoteKv.token}` }, signal: AbortSignal.timeout(20_000) });
      if (response.status === 404) return [];
      if (!response.ok) throw new Error('Cannot enumerate cached sessions. Check Workers KV Storage Read/Edit on the deploy token; recovery is incomplete.');
      value = await response.text();
    } else {
      value = await wrangler(['kv', 'key', 'get', key, '--binding', 'AUTH_KV', target, ...configArgs], commandOptions);
      if (value.trim() === 'Value not found') return [];
    }
    try { const list = JSON.parse(value); if (!Array.isArray(list) || list.some((entry) => typeof entry.token !== 'string' || !entry.token)) throw new Error(); return list.map((entry) => entry.token); }
    catch { throw new Error('Cached session list is malformed. Recovery is incomplete; inspect the private instance.'); }
  };
  await recoverExistingAdmin({ user, password, clearTwoFactor: args.includes('--clear-2fa'), execute, cachedTokens, journal,
    purgeKeys: () => wrangler(['kv', 'bulk', 'delete', journalPath, '--binding', 'AUTH_KV', target, ...configArgs, '--force'], commandOptions) });
  process.stdout.write(`Password reset for existing super-admin ${email}${args.includes('--clear-2fa') ? '; 2FA cleared' : ''}. ${sessionCacheNotice}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
