// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectRoot, pnpm, run, validateTools, wrangler } from './lib/process.mjs';
import { assertStable, deploymentEnv, keyFingerprint, newSecrets, readInstance, resourceNames, saveInstance, validateDomain, validateSlug, withInstallLock } from './lib/instance.mjs';
import { cloudflare, dnsPreview, dnsSnapshot, externalMx, selectAccountAndZone, workerSettings, assertRemoteIdentity, assertUnclaimedResources } from './lib/cloudflare.mjs';
import { choose, maskedSecret, question } from './lib/prompt.mjs';
import { inspectInstance } from './lib/doctor.mjs';
import { assertUpgradeTarget } from './lib/upgrade.mjs';
import { captureD1RestorePoint } from './lib/backup.mjs';
import { presentBootstrap, saveBootstrapLink } from './lib/bootstrap.mjs';
import { prepareApexAccounts } from './lib/apex-preparation.mjs';
import { createMigrationPlan, readMigrationPlan, applyMigration, rollbackMigration, migrationPreview, assertOwnersReady } from './lib/apex-migration.mjs';
import { migrationProvider, apexRecords, sameRecords, recipientRules, normalizedRule } from './lib/migration-provider.mjs';

export const paidRequirement = 'Cloudflare Workers Paid is required: $5/month base, including 3,000 outbound emails each month. Additional email usage and usage above included compute/storage quotas are billed separately. Email Routing receiving alone is free; this mailbox uses paid native outbound sending.\n';

const git = (args) => run('git', args, { capture: true });

export async function sourceIdentity() {
  const remotes = (await git(['remote'])).split('\n');
  const remote = remotes.includes('origin') ? 'origin' : remotes.includes('upstream') ? 'upstream' : null;
  if (!remote) throw new Error('This checkout needs an origin or upstream Git remote for reproducible upgrades.');
  const sourceOrigin = await git(['remote', 'get-url', remote]);
  if (/^https?:\/\//i.test(sourceOrigin)) {
    const sourceUrl = new URL(sourceOrigin);
    if (sourceUrl.username || sourceUrl.password) throw new Error('Remove embedded Git credentials from the remote URL; use a Git credential manager or SSH before setup.');
  }
  return { sourceRemote: remote, sourceOrigin };
}

export async function currentToken(secrets = {}, source) {
  if (source === 'wrangler') {
    let credentials;
    try { credentials = JSON.parse(await wrangler(['auth', 'token', '--json'], { capture: true, secrets: ['credential-output'] })); } catch { throw new Error('Could not retrieve the existing Wrangler credential securely. Run Wrangler login again or choose a scoped API token in setup.'); }
    if (!credentials.token || credentials.type === 'api_key') throw new Error('A Cloudflare scoped API token or browser login is required; Global API Keys are not supported.');
    return credentials.token;
  }
  const token = process.env.CLOUDFLARE_API_TOKEN || secrets.deployToken;
  if (!token) throw new Error('Set CLOUDFLARE_API_TOKEN or rerun setup to supply a deploy credential.');
  return token;
}

async function credentials(existing) {
  if (existing) {
    const token = await currentToken(existing.secrets, existing.config.credentialSource);
    existing.secrets = await refreshedCredentials(existing.config, existing.secrets, token);
    return { token, secrets: existing.secrets, credentialSource: existing.config.credentialSource };
  }
  if (process.env.CLOUDFLARE_API_TOKEN) return { token: process.env.CLOUDFLARE_API_TOKEN, secrets: { deployToken: process.env.CLOUDFLARE_API_TOKEN }, credentialSource: 'token' };
  const source = await choose('Deploy credential', [{ label: 'Use existing Wrangler authenticated login', value: 'wrangler' }, { label: 'Sign in to Cloudflare in browser', value: 'login' }, { label: 'Enter a scoped Cloudflare API token (masked)', value: 'token' }]);
  if (source === 'login') await wrangler(['login']);
  if (source !== 'token') return { token: await currentToken({}, 'wrangler'), secrets: {}, credentialSource: 'wrangler' };
  const token = await maskedSecret('CLOUDFLARE_API_TOKEN');
  if (!token) throw new Error('A deployment API token is required.');
  return { token, secrets: { deployToken: token }, credentialSource: 'token' };
}

export async function refreshedCredentials(config, secrets, deployToken, env = process.env, api = cloudflare(env.APP_CLOUDFLARE_API_TOKEN || secrets.runtimeToken)) {
  const runtimeToken = env.APP_CLOUDFLARE_API_TOKEN || secrets.runtimeToken;
  if (!runtimeToken || runtimeToken === deployToken) throw new Error('Use a separate runtime token scoped to this zone; never bind the deployment token into the app.');
  if (runtimeToken !== secrets.runtimeToken) {
    const zone = (await api(`/zones/${config.zoneId}`)).result;
    if (zone.id !== config.zoneId || zone.account?.id !== config.accountId) throw new Error('Replacement runtime token does not match the saved account and zone.');
    await api(`/zones/${config.zoneId}/dns_records?per_page=1`);
    await api(`/zones/${config.zoneId}/email/routing`);
  }
  return { ...secrets, runtimeToken, ...(config.credentialSource === 'token' ? { deployToken } : {}) };
}

export function assertUpgradeTag(tag) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(tag) || tag.includes('..') || tag.endsWith('/')) throw new Error('Select a valid published release tag. Commit expressions and shell commands are not accepted.');
  return tag;
}

async function verifySource(config) {
  const origin = await git(['remote', 'get-url', config.sourceRemote]);
  if (origin !== config.sourceOrigin) throw new Error('Git source changed from the installed release. Restore the original remote; upgrades are blocked.');
}

export async function guardDeployment(config, secrets, token, api = cloudflare(token)) {
  assertStable(config, secrets, process.env);
  await verifySource(config);
  const zone = (await api(`/zones/${config.zoneId}`)).result;
  if (zone.account.id !== config.accountId || zone.name !== config.zoneName || zone.status !== 'active') throw new Error('Selected zone/account changed or DNS is not active. Deployment blocked.');
  for (const role of ['web', 'inbound', 'jobs']) assertRemoteIdentity(config, await workerSettings(api, config.accountId, config.resourceNames[role]));
}

async function installDependencies() {
  await pnpm(['install', '--frozen-lockfile']);
  await pnpm(['install', '--frozen-lockfile'], { cwd: join(projectRoot, 'infra') });
}

async function deploy(instance, token) {
  const { config, secrets } = instance;
  await guardDeployment(config, secrets, token);
  config.phase = 'deploying';
  await saveInstance(projectRoot, config, secrets);
  const env = deploymentEnv(config, secrets, token);
  await pnpm(['run', 'build'], { env });
  await pnpm(['run', 'deploy', '--stage', config.stage], { cwd: join(projectRoot, 'infra'), env });
  config.phase = 'deployed';
  config.lastSourceCommit = await git(['rev-parse', 'HEAD']);
  delete config.upgrade;
  await saveInstance(projectRoot, config, secrets);
}

async function setup({ prepareApex = false } = {}) {
  process.stdout.write(paidRequirement);
  process.stdout.write('Credentials: create separate custom deployment and runtime tokens at https://dash.cloudflare.com/profile/api-tokens, restricted to your account and zone. Follow docs/TOKENS.md for the exact permission matrix and Email Service activation. Never use a Global API Key.\n');
  const existing = await readInstance(projectRoot);
  if (prepareApex && !existing) throw new Error('Run setup and verify a pilot before using --prepare-apex.');
  await installDependencies();
  const auth = await credentials(existing);
  let instance = existing;
  if (!instance) {
    const api = cloudflare(auth.token);
    const { account, zone } = await selectAccountAndZone(api, choose);
    const records = await dnsSnapshot(api, zone.id);
    const provider = externalMx(records, zone.name);
    let mailDomain;
    let routingMode;
    if (provider.length) {
      process.stdout.write(`Existing provider MX detected for ${zone.name}: ${provider.map((record) => record.content).join(', ')}\n`);
      mailDomain = validateDomain(await question('Pilot mail domain (existing apex stays live)', `pilot.${zone.name}`));
      if (mailDomain === zone.name) throw new Error('An existing provider is live. Initial setup requires a pilot subdomain; migrate apex separately after pilot verification.');
      routingMode = 'manual';
    } else {
      const mode = await choose('Initial receiving domain', [{ label: `Pilot ${'pilot.' + zone.name} (recommended)`, value: 'manual' }, { label: `New unused apex ${zone.name}`, value: 'apex' }]);
      routingMode = mode;
      mailDomain = mode === 'apex' ? zone.name : validateDomain(await question('Pilot mail domain', `pilot.${zone.name}`));
      if (mode === 'apex') {
        if (await question(`Type ${zone.name} to reserve its unused apex for routing`) !== zone.name) throw new Error('Apex routing choice was not confirmed. Setup stopped without changing DNS.');
      }
    }
    const instanceSlug = validateSlug(await question('Stable instance slug', zone.name.split('.')[0]));
    const appName = await question('Application name', 'Domain Mail');
    const appOrigin = await question('Application HTTPS origin', `https://mail.${zone.name}`);
    const runtimeToken = process.env.APP_CLOUDFLARE_API_TOKEN || await maskedSecret('APP_CLOUDFLARE_API_TOKEN');
    if (!runtimeToken || runtimeToken === auth.token) throw new Error('Use a separate runtime token scoped to this zone; never bind the deployment token into the app.');
    const runtimeApi = cloudflare(runtimeToken);
    await runtimeApi(`/zones/${zone.id}`);
    await runtimeApi(`/zones/${zone.id}/dns_records?per_page=1`);
    await runtimeApi(`/zones/${zone.id}/email/routing`);
    const secrets = { ...newSecrets(process.env), ...auth.secrets, runtimeToken };
    const config = { version: 1, instanceId: randomUUID(), instanceSlug, stage: 'prod', ...(await sourceIdentity()), credentialSource: auth.credentialSource, accountId: account.id, zoneId: zone.id, zoneName: zone.name, mailDomain, routingMode, appName, appOrigin, keyFingerprint: keyFingerprint(secrets), phase: 'configured', apexMx: records.filter((record) => record.type === 'MX' && record.name === zone.name).map(({ content, priority, ttl }) => ({ content, priority, ttl })) };
    config.resourceNames = resourceNames(config);
    // Check collisions before saving ownership. Existing unknown workers are never adopted.
    for (const role of ['web', 'inbound', 'jobs']) assertRemoteIdentity(config, await workerSettings(api, account.id, config.resourceNames[role]));
    await assertUnclaimedResources(config, api);
    instance = { config, secrets };
    const preview = dnsPreview(config, records);
    process.stdout.write(`\nApp: ${appOrigin}\nMail: @${mailDomain}\nDeployment creates Workers, storage, queues and the app HTTPS hostname. Mail DNS is a separate deliberate onboarding step.\n${preview.planned.map((line) => `  ${line}`).join('\n')}\n${preview.apexUntouched ? `Existing apex ${zone.name} MX/SPF/DKIM/DMARC records stay at the current provider. Cloudflare may add a separate shared Routing DKIM selector.\n` : ''}`);
    await saveInstance(projectRoot, config, secrets);
    process.stdout.write('Saved .local/instance.json and private .local/secrets.json. Back up both and the encryption keys before receiving real mail. On Windows, keep the checkout under your user-only filesystem ACL.\n');
  } else {
    process.stdout.write(`Resuming ${instance.config.instanceSlug}/${instance.config.stage}; saved account, resource names and keys are reused.\n`);
  }
  if (prepareApex) {
    await guardDeployment(instance.config, instance.secrets, auth.token);
    const pilotChecks = await inspectInstance(instance.config, instance.secrets, auth.token, { preparingAccounts: true });
    printChecks(pilotChecks);
    if (pilotChecks.some(check => check.status === 'fail')) throw new Error('Resolve pilot doctor failures before preparing production accounts. Apex receiving configuration was not changed.');
    const settings = await workerSettings(cloudflare(auth.token), instance.config.accountId, instance.config.resourceNames.web);
    const values = Object.fromEntries((settings?.bindings ?? []).filter(binding => binding.type === 'plain_text').map(binding => [binding.name, binding.text]));
    if (values.MAIL_DOMAIN !== instance.config.mailDomain || values.MAIL_ROUTING_MODE !== 'manual') throw new Error('The deployed pilot mail domain differs from saved state. Restore its original configuration before preparing accounts.');
    instance.config = await prepareApexAccounts(projectRoot, instance.config, instance.secrets, cloudflare(auth.token));
    await saveInstance(projectRoot, instance.config, instance.secrets);
    process.stdout.write(`Preparing accounts for @${instance.config.stagedMailDomain}. Primary mail stays @${instance.config.mailDomain}; existing apex MX/SPF and routing are unchanged. A protected DNS snapshot is saved in .local/. This enables administrator invitations only, not receiving activation.\n`);
  }
  // Save the same one-use URL before deploy so an interrupted run can resume.
  await saveBootstrapLink(instance.config, instance.secrets);
  await deploy(instance, auth.token);
  const checks = await finishSetup(instance, auth.token);
  if (prepareApex) process.stdout.write(`\nOpen ${instance.config.appOrigin}/admin/organizations, choose Prepare accounts for ${instance.config.stagedMailDomain}, then invite each owner using an external recovery address. Mail remains with the existing provider until a separate reviewed cutover.\n`);
  if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

export async function finishSetup(instance, token, { inspect = inspectInstance, bootstrap = presentBootstrap, output = process.stdout } = {}) {
  await bootstrap(instance.config, instance.secrets);
  output.write('\nRunning read-only doctor diagnostics...\n');
  const checks = await inspect(instance.config, instance.secrets, token);
  printChecks(checks, output);
  output.write(`\nApp deployed. Mail ${instance.config.mailDomain} remains pending until scoped onboarding and real send/receive verification pass. Resolve diagnostic failures and complete the web wizard; rerun pnpm run doctor after mail DNS is configured.\n`);
  return checks;
}

function printChecks(checks, output = process.stdout) {
  for (const check of checks) output.write(`${check.status.toUpperCase()} ${check.name}: ${check.detail}\n`);
}

async function doctor() {
  const instance = await readInstance(projectRoot);
  if (!instance) throw new Error('No saved instance. Run pnpm run setup.');
  assertStable(instance.config, instance.secrets, process.env);
  await verifySource(instance.config);
  const token = await currentToken(instance.secrets, instance.config.credentialSource);
  const checks = await inspectInstance(instance.config, instance.secrets, token);
  printChecks(checks);
  if (checks.some((check) => check.status === 'fail')) process.exitCode = 1;
}

async function upgrade(args) {
  const instance = await readInstance(projectRoot);
  if (!instance) throw new Error('No saved instance. Run setup before upgrading.');
  await verifySource(instance.config);
  assertStable(instance.config, instance.secrets, process.env);
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Tracked files are modified. Commit or preserve those edits before upgrading; the installer never stashes or discards them.');
  const token = await currentToken(instance.secrets, instance.config.credentialSource);
  await guardDeployment(instance.config, instance.secrets, token);
  await git(['fetch', '--tags', instance.config.sourceRemote]);
  let tag = args[0] === '--tag' ? args[1] : undefined;
  if (args.length && (args[0] !== '--tag' || args.length !== 2)) throw new Error('Usage: pnpm run upgrade -- --tag <published-tag>');
  if (!tag) {
    const tags = (await git(['tag', '--list', '--sort=-version:refname'])).split('\n').filter(Boolean);
    tag = await choose('Release tag', tags.map((value) => ({ label: value, value })));
  }
  assertUpgradeTag(tag);
  const remoteTags = await git(['ls-remote', '--tags', instance.config.sourceRemote, `refs/tags/${tag}`, `refs/tags/${tag}^{}`]);
  if (!remoteTags.trim()) throw new Error('That release tag is not published by the installed source.');
  const target = await git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  const remoteCommits = remoteTags.split('\n').map((line) => line.split(/\s+/)[0]);
  let isAncestor = true;
  try { await git(['merge-base', '--is-ancestor', 'HEAD', target]); } catch { isAncestor = false; }
  const manifest = JSON.parse(await git(['show', `${target}:package.json`]));
  const transition = assertUpgradeTarget(instance.config, { sourceOrigin: await git(['remote', 'get-url', instance.config.sourceRemote]), dirty: false, current: await git(['rev-parse', 'HEAD']), target, publishedCommits: remoteCommits, manifest, isAncestor });
  // Verify the release still accepts the saved configuration before changing the checkout.
  await git(['cat-file', '-e', `${target}:scripts/lib/instance.mjs`]);
  process.stdout.write('Saving a D1 Time Travel restore point before checkout or migrations. Keep independent R2 and .local private-state/key backups current; Time Travel covers D1 only and expires after 30 days on Workers Paid (7 days on Free).\n');
  const settings = await workerSettings(cloudflare(token), instance.config.accountId, instance.config.resourceNames.web);
  const databaseId = settings?.bindings?.find((binding) => binding.name === 'DB')?.id;
  if (!databaseId) throw new Error('Live database binding is missing. Restore it before upgrading; no migration was attempted.');
  const restorePoint = await captureD1RestorePoint(projectRoot, instance.config, instance.secrets, token, { databaseId, tag, ...transition });
  instance.config.phase = 'upgrading';
  instance.config.upgrade = { tag, ...transition, restorePoint };
  await saveInstance(projectRoot, instance.config, instance.secrets);
  await git(['switch', '--detach', target]);
  // A release never receives a new config, stage, key or resource ID.
  await installDependencies();
  await deploy(instance, token);
  process.stdout.write(`Upgraded to ${tag}. Instance identity, storage and keys were preserved. Run pnpm run doctor and a real mailbox check.\n`);
}

export async function main(args = process.argv.slice(2)) {
  const [command = 'setup', ...rest] = args.filter((argument) => argument !== '--');
  if (rest.includes('--help') || command === '--help') {
    process.stdout.write('pnpm run setup [-- --prepare-apex] | pnpm run doctor | pnpm run upgrade -- --tag <published-tag>\npnpm run migrate -- plan | status --plan <filename> | apply --plan <filename> --confirm <digest> | rollback --plan <filename> --confirm <digest>\nSetup deploys the app after saving private config; --prepare-apex enables production account invitations while preserving pilot/apex receiving; doctor and migration plan/status are read-only; upgrade preserves the saved instance.\n');
    return;
  }
  await validateTools();
  if (command === 'doctor') return doctor();
  if (command === 'setup' && !rest.length) return withInstallLock(projectRoot, setup);
  if (command === 'setup' && rest.length === 1 && rest[0] === '--prepare-apex') return withInstallLock(projectRoot, () => setup({ prepareApex: true }));
  if (command === 'upgrade') return withInstallLock(projectRoot, () => upgrade(rest));
  if (command === 'migrate') return withInstallLock(projectRoot, () => migrate(rest));
  throw new Error('Unknown command. Use setup, doctor, migrate or upgrade --tag <published-tag>.');
}

export function migrationArguments(args) {
  const [action, ...rest] = args;
  if (action === 'plan' && !rest.length) return { action };
  if (action === 'status' && rest.length === 2 && rest[0] === '--plan') return { action, basename: rest[1] };
  if (['apply', 'rollback'].includes(action) && rest.length === 4 && rest[0] === '--plan' && rest[2] === '--confirm') return { action, basename: rest[1], confirm: rest[3] };
  throw new Error('Usage: migrate plan | status --plan <filename> | apply|rollback --plan <filename> --confirm <digest>');
}

async function migrate(args) {
  const { action, basename, confirm } = migrationArguments(args);
  const instance = await readInstance(projectRoot);
  if (!instance) throw new Error('Run setup and verify a pilot before migration.');
  const { config, secrets } = instance;
  await verifySource(config);
  const token = await currentToken(secrets, config.credentialSource);
  await guardDeployment(config, secrets, token);
  const provider = migrationProvider(config, secrets, token);
  if (action === 'plan') {
    const planned = await createMigrationPlan(projectRoot, config, secrets, provider);
    process.stdout.write(`${JSON.stringify(migrationPreview(planned.basename, planned.journal), null, 2)}\nRead-only preview saved. No provider configuration or DNS records were changed.\n`);
    return;
  }
  const journal = await readMigrationPlan(projectRoot, basename, config, secrets);
  if (action === 'status') {
    const live = await provider.snapshot();
    let readiness = 'ready';
    try { assertOwnersReady(live, config.zoneName); } catch (error) { readiness = error.message; }
    let recipientsReady = false;
    try { recipientsReady = recipientRules(live.recipients, live.rules, config.zoneName, config.resourceNames.inbound).every(wanted => live.rules.some(rule => JSON.stringify(normalizedRule(rule)) === JSON.stringify(normalizedRule(wanted)))); } catch { /* False is actionable without provider payload disclosure. */ }
    process.stdout.write(`${JSON.stringify({ ...migrationPreview(basename, journal), current: { ownerReadiness: readiness, exactRecipientRulesReady: recipientsReady, organization: live.organization.status, oldProviderMxSpf: sameRecords(apexRecords(live.records, config.zoneName), journal.plan.previousApexDns), cloudflareMxSpf: sameRecords(apexRecords(live.records, config.zoneName), journal.plan.nextApexDns), routing: live.routingStatus, sendingEnabled: live.nativeDomain?.enabled === true, migratedScope: live.scopes.MAIL_MIGRATED_DOMAIN === config.zoneName } }, null, 2)}\n`);
    return;
  }
  if (action === 'rollback') {
    await rollbackMigration(projectRoot, basename, config, secrets, provider, confirm);
    process.stdout.write('Previous apex MX/SPF restored. Cloudflare receiver, pilot, signing records and stored messages remain available for delayed deliveries. Keep both services active; inspect both inboxes.\n');
    return;
  }
  // Migration source must be reviewable. Never deploy an uncommitted cutover.
  if ((await git(['status', '--porcelain', '--untracked-files=no'])).trim()) throw new Error('Commit or preserve tracked source edits before applying migration. No DNS changes were made.');
  const source = await git(['rev-parse', 'HEAD']);
  process.stdout.write('Provisioning the reviewed plan. Receiving MX changes last. The original provider must remain active for at least seven days.\n');
  await applyMigration(projectRoot, basename, instance, provider, confirm, {
    deploy: value => deploy(value, token),
    backup: databaseId => captureD1RestorePoint(projectRoot, config, secrets, token, { databaseId, tag: `apex-cutover-${basename.slice(13, -5)}`, from: source, to: source }),
  });
  process.stdout.write(`Apex cutover submitted for ${config.zoneName}. DNS propagation and real message tests are still required; run migrate status and doctor, then send and reply with an attachment for every recipient. Keep Google/the previous provider for historical messages. Rollback uses this same filename and digest.\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`Installer: ${error.message}\n`); process.exitCode = 1; });
}
