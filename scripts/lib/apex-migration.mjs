// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { assertStable, atomicJson, fingerprint, saveInstance } from './instance.mjs';
import { apexRecords, dnsName, isSpf, mergedSpf, checkSpfBudget, missingSendingRecords, recipientRules, routingRequirements, sendingRequirements, sameMailRecord, sameRecords, sortedRules, normalizedRule } from './migration-provider.mjs';

const planFile = /^apex-cutover-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const identity = config => ({ instanceId: config.instanceId, accountId: config.accountId, zoneId: config.zoneId, zoneName: config.zoneName, mailDomain: config.mailDomain, keyFingerprint: config.keyFingerprint, resourceNames: config.resourceNames });
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const senderNames = domain => [`cf-bounce.${domain}`, `cf-bounce._domainkey.${domain}`, `_dmarc.${domain}`];
const ownsInitialDmarc = (config, journal) => journal.plan.sending.generatedByCloudflare === true &&
  !journal.plan.snapshot.nativeDomain && !!journal.progress.startedAt &&
  !journal.plan.snapshot.records.some(record => dnsName(record.name) === `_dmarc.${config.zoneName}`);

export function assertMigrationScope(config, secrets) {
  assertStable(config, secrets);
  if (config.stagedMailDomain !== config.zoneName || config.routingMode !== 'manual' || config.mailDomain === config.zoneName || !config.apexPreparation) throw new Error('Verify a pilot and run setup --prepare-apex before migration. No DNS changes were made.');
}
export function assertOwnersReady(snapshot, domain) {
  if (!snapshot.recipients.length || !snapshot.owners.length) throw new Error('Provision production mailboxes and their owners before migration.');
  const addresses = new Set();
  for (const recipient of snapshot.recipients) {
    if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+$/i.test(recipient.address) || !recipient.address.endsWith(`@${domain}`) || recipient.address !== recipient.address.toLowerCase() || recipient.isService || addresses.has(recipient.address)) throw new Error('Recipient is duplicated, outside this apex, or a service mailbox. Resolve it before migration.');
    addresses.add(recipient.address);
    if (!snapshot.grants.some(grant => grant.mailboxId === recipient.mailboxId && snapshot.owners.some(owner => owner.id === grant.userId) && grant.canSend)) throw new Error(`Mailbox ${recipient.address} needs an owner with a send grant.`);
  }
  const pending = snapshot.owners.filter(owner => owner.banned || !owner.passwordChosen || owner.passwordSetupPending || !owner.recoveryVerified || !owner.externalRecovery || !owner.onboarded || ((['admin', 'superadmin'].includes(owner.role) || owner.elevatedMembership || owner.orgTotpRequired) && !owner.totpEnabled));
  if (pending.length) throw new Error(`Owners must finish password setup, external recovery verification and reach Inbox; administrators must enable authenticator TOTP: ${pending.map(owner => owner.email).join(', ')}. No apex DNS changes were made.`);
}
function assertSnapshot(config, snapshot) {
  assertOwnersReady(snapshot, config.zoneName);
  if (snapshot.scopes.MAIL_DOMAIN !== config.mailDomain || snapshot.scopes.MAIL_ROUTING_MODE !== 'manual' || snapshot.scopes.MAIL_STAGING_DOMAIN !== config.zoneName || (snapshot.scopes.MAIL_MIGRATED_DOMAIN && snapshot.scopes.MAIL_MIGRATED_DOMAIN !== config.zoneName)) throw new Error('Live mail scopes differ from the saved pilot/preparation.');
  if (!snapshot.routingEnabled) throw new Error('The pilot has not enabled Email Routing for this zone. Repair and verify pilot onboarding first.');
  if (snapshot.catchAll?.enabled) throw new Error('Disable or deliberately resolve the existing apex catch-all before planning. Migration uses exact provisioned recipient rules only.');
  // Cloudflare flattens zone-apex CNAMEs automatically; an apex website alias
  // and authoritative NS do not conflict with mail. Sender hosts still must
  // have their own MX/TXT records and cannot be aliased or delegated.
  if (snapshot.records.some(record => ['CNAME', 'NS'].includes(record.type) && senderNames(config.zoneName).includes(dnsName(record.name)))) throw new Error('Mail hosts are aliased or delegated. Resolve their DNS conflicts before migration.');
  recipientRules(snapshot.recipients, snapshot.rules, config.zoneName, config.resourceNames.inbound);
}

export async function createMigrationPlan(root, config, secrets, provider, { now = () => new Date(), writeJson = atomicJson, lookup } = {}) {
  assertMigrationScope(config, secrets);
  let preparation;
  try { preparation = JSON.parse(await readFile(join(root, '.local', config.apexPreparation.snapshot), 'utf8')); } catch { throw new Error('Restore the original private apex preparation snapshot before migration.'); }
  if (fingerprint(JSON.stringify(preparation)) !== config.apexPreparation.digest || preparation.instanceId !== config.instanceId || preparation.zoneId !== config.zoneId || preparation.keyFingerprint !== config.keyFingerprint) throw new Error('Apex preparation snapshot differs from the saved instance.');
  const snapshot = await provider.snapshot();
  assertSnapshot(config, snapshot);
  if (snapshot.organization.status === 'active' && config.migratedMailDomain !== config.zoneName) throw new Error('The apex is already active outside this installer. Review its ownership before migration.');
  const original = apexRecords(snapshot.records, config.zoneName);
  if (!original.some(record => record.type === 'MX' && !/\.mx\.cloudflare\.net\.?$/i.test(record.content)) || original.some(record => record.type === 'MX' && /\.mx\.cloudflare\.net\.?$/i.test(record.content))) throw new Error('Migration needs the existing provider as the sole apex receiver. Restore or review MX before planning.');
  if (!snapshot.nativeDomain && snapshot.records.some(record => senderNames(config.zoneName).slice(0, 2).includes(dnsName(record.name)))) throw new Error('Native sending hosts already exist without a sending registration. Resolve ownership before migration.');
  const routingMx = routingRequirements(snapshot.routingDns, config.zoneName, snapshot.records);
  const spf = mergedSpf(snapshot.records, config.zoneName);
  const spfLookups = await checkSpfBudget(spf.content, lookup);
  const senderDns = snapshot.nativeDomain ? sendingRequirements(snapshot.nativeDomain, snapshot.nativeDns, config.zoneName) : null;
  if (senderDns) missingSendingRecords(senderDns, snapshot.records, config.zoneName);
  const plan = { version: 1, kind: 'apex-mail-cutover', createdAt: now().toISOString(), identity: identity(config), snapshot,
    previousApexDns: original, nextApexDns: [...routingMx, spf], spfLookups,
    // Cloudflare creates a signing key at registration; its value is sealed in
    // the journal and strictly scoped before any receiving MX changes.
    sending: { domain: config.zoneName, generatedByCloudflare: !senderDns, names: senderNames(config.zoneName), records: senderDns },
    rules: recipientRules(snapshot.recipients, snapshot.rules, config.zoneName, config.resourceNames.inbound),
    rollbackRetainsReceiver: true, oldProviderRetentionDays: 7 };
  const journal = { plan, digest: fingerprint(JSON.stringify(plan)), progress: {} };
  const basename = `apex-cutover-${randomUUID()}.json`;
  await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 });
  await writeJson(join(root, '.local', basename), journal);
  return { basename, journal };
}

export async function readMigrationPlan(root, basename, config, secrets) {
  assertMigrationScope(config, secrets);
  if (!planFile.test(basename ?? '')) throw new Error('Use the apex-cutover UUID filename saved in .local; paths outside private state are rejected.');
  let journal;
  try { journal = JSON.parse(await readFile(join(root, '.local', basename), 'utf8')); } catch { throw new Error('Migration journal is missing or unreadable. Restore its original private backup. Raw contents were suppressed.'); }
  if (journal?.plan?.version !== 1 || journal.plan.kind !== 'apex-mail-cutover' || !equal(journal.plan.identity, identity(config)) || !equal(fingerprint(JSON.stringify(journal.plan)), journal.digest) || !journal.progress || typeof journal.progress !== 'object' || Array.isArray(journal.progress)) throw new Error('Migration journal integrity or instance identity differs. Restore the original private journal.');
  for (const field of ['startedAt', 'completedAt', 'rolledBackAt']) if (journal.progress[field] !== undefined && (typeof journal.progress[field] !== 'string' || !Number.isFinite(Date.parse(journal.progress[field])))) throw new Error('Migration journal integrity failed: invalid progress timestamp.');
  for (const field of ['mxPending', 'rollbackPending', 'dmarcPolicyReady']) if (journal.progress[field] !== undefined && typeof journal.progress[field] !== 'boolean') throw new Error('Migration journal integrity failed: invalid progress state.');
  if (journal.progress.backup !== undefined && (!journal.progress.backup || typeof journal.progress.backup !== 'object' || Array.isArray(journal.progress.backup))) throw new Error('Migration journal integrity failed: invalid backup state.');
  if (journal.progress.sending !== undefined && !Array.isArray(journal.progress.sending)) throw new Error('Migration journal integrity failed: invalid sealed sending state.');
  return journal;
}

/** Reject unrelated changes while allowing only this journal's owned actions.
 * Provider state, not a progress boolean, determines whether a retry can skip. */
export function assertMigrationDrift(config, journal, live) {
  const { plan, progress } = journal, original = plan.snapshot;
  assertSnapshot(config, live);
  for (const name of ['resources', 'recipients', 'owners', 'grants', 'catchAll']) if (!equal(live[name], original[name])) throw new Error(`Migration ${name} changed since the preview. Stop and review a fresh plan; no blind replacement was attempted.`);
  if (!progress.startedAt && (!equal(live.nativeDomain, original.nativeDomain) || !sameRecords(live.nativeDns, original.nativeDns))) throw new Error('Native sending registration changed since the preview.');
  if (live.organization.id !== original.organization.id || live.organization.domain !== config.zoneName || live.organization.zoneId !== config.zoneId || (!progress.startedAt && live.organization.status !== original.organization.status)) throw new Error('Migration organization changed since the preview.');
  const targetAddresses = new Set(plan.snapshot.recipients.map(recipient => recipient.address));
  const ours = rule => rule.matchers?.some(matcher => targetAddresses.has(String(matcher.value).toLowerCase()));
  if (!equal(sortedRules(live.rules.filter(rule => !ours(rule))), sortedRules(original.rules.filter(rule => !ours(rule))))) throw new Error('Unrelated routing rules changed since the preview.');
  if (!progress.startedAt && !equal(sortedRules(live.rules), sortedRules(original.rules))) throw new Error('Routing rules changed since the preview.');
  const scoped = record => dnsName(record.name) === config.zoneName && (record.type === 'MX' || isSpf(record));
  const generated = record => plan.sending.names.includes(dnsName(record.name));
  if (!sameRecords(live.records.filter(record => !scoped(record) && !generated(record)), original.records.filter(record => !scoped(record) && !generated(record)))) throw new Error('Unrelated DNS changed since the preview; pilot and other records were preserved.');
  for (const name of plan.sending.names) {
    const before = original.records.filter(record => dnsName(record.name) === name);
    if (before.length && !sameRecords(before, live.records.filter(record => dnsName(record.name) === name))) throw new Error('An existing sending/DMARC policy changed since the preview.');
    if (!progress.startedAt && !sameRecords(before, live.records.filter(record => dnsName(record.name) === name))) throw new Error('Sending DNS changed since the preview.');
  }
  if (progress.startedAt && live.nativeDomain?.enabled) {
    const wanted = sendingRequirements(live.nativeDomain, live.nativeDns, config.zoneName);
    const policyName = `_dmarc.${config.zoneName}`;
    const policies = live.records.filter(record => dnsName(record.name) === policyName);
    const rawPolicy = ownsInitialDmarc(config, journal) && !progress.dmarcPolicyReady
      ? sendingRequirements(live.nativeDomain, live.nativeDns, config.zoneName, { monitorDmarc: false }).find(record => record.name === policyName)
      : null;
    if (progress.sending && !sameRecords(progress.sending, wanted)) throw new Error('Native sending DNS changed during migration.');
    for (const record of live.records.filter(generated)) {
      // Registration can itself create Cloudflare's default reject policy.
      // Only this journal's new policy may briefly match that verified preview;
      // the monitor policy must be read back before any receiving cutover.
      const initialPolicy = rawPolicy && policies.length === 1 && sameRecords([rawPolicy], [record]);
      if (!original.records.some(row => sameMailRecord(row, record)) && !wanted.some(row => sameMailRecord(row, record)) && !initialPolicy) throw new Error('Generated sending DNS drifted outside the sealed requirements.');
    }
    missingSendingRecords(wanted, live.records, config.zoneName);
  }
  const current = apexRecords(live.records, config.zoneName);
  if (!sameRecords(current, plan.previousApexDns) && !(progress.mxPending && sameRecords(current, plan.nextApexDns))) throw new Error('Apex MX/SPF changed outside this journal. Review drift before resuming.');
  if (!sameRecords(routingRequirements(live.routingDns, config.zoneName, live.records), plan.nextApexDns.filter(record => record.type === 'MX'))) throw new Error('Cloudflare routing requirements changed since the preview.');
}

export async function applyMigration(root, basename, instance, provider, confirm, {
  deploy, backup, now = () => new Date(), writeJson = atomicJson, save = saveInstance, wait = delay, lookup,
} = {}) {
  const { config, secrets } = instance;
  const journal = await readMigrationPlan(root, basename, config, secrets);
  if (confirm !== journal.digest) throw new Error('Review the saved DNS preview and pass its exact digest with --confirm. No provider writes were made.');
  if (journal.progress.rollbackPending || journal.progress.rolledBackAt) throw new Error('This journal is rolling back or rolled back. Finish rollback, then create a fresh plan for another cutover.');
  if (!journal.progress.startedAt && (now().getTime() - Date.parse(journal.plan.createdAt) > 86_400_000 || Date.parse(journal.plan.createdAt) > now().getTime() + 60_000 || !Number.isFinite(Date.parse(journal.plan.createdAt)))) throw new Error('DNS preview expired. Create and review a fresh plan.');
  if (typeof deploy !== 'function' || typeof backup !== 'function') throw new Error('Migration requires the installer deployment and backup adapters.');
  const path = join(root, '.local', basename);
  const persist = () => writeJson(path, journal);
  let live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  await checkSpfBudget(journal.plan.nextApexDns.find(isSpf).content, lookup);
  if (!journal.progress.backup) {
    // Both backups must be durable before any DNS/routing/lifecycle write.
    await writeJson(join(root, '.local', `before-apex-private-${basename.slice(13)}`), { config, secrets });
    journal.progress.backup = await backup(live.databaseId);
    await persist();
  }
  journal.progress.startedAt ??= now().toISOString();
  journal.progress.intent = 'register native sender';
  await persist();
  if (!live.nativeDomain?.enabled) await provider.registerSender();
  live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  const sending = sendingRequirements(live.nativeDomain, live.nativeDns, config.zoneName);
  if (journal.progress.sending && !sameRecords(journal.progress.sending, sending)) throw new Error('Native sending DNS changed during migration.');
  journal.progress.sending = sending;
  journal.progress.intent = 'provision sending DNS';
  await persist();
  await provider.addSendingDns(missingSendingRecords(sending, live.records, config.zoneName));
  live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  if (ownsInitialDmarc(config, journal)) {
    const wantedPolicy = sending.find(record => record.name === `_dmarc.${config.zoneName}`);
    let policies = live.records.filter(record => dnsName(record.name) === wantedPolicy.name);
    if (policies.length !== 1) throw new Error('Initial DMARC policy is missing or duplicated; apex MX was preserved.');
    if (!sameRecords(policies, [wantedPolicy])) {
      if (typeof provider.ensureInitialDmarc !== 'function') throw new Error('The provider cannot normalize the initial DMARC policy; apex MX was preserved.');
      await provider.ensureInitialDmarc(policies[0], wantedPolicy);
      live = await provider.snapshot();
      assertMigrationDrift(config, journal, live);
      policies = live.records.filter(record => dnsName(record.name) === wantedPolicy.name);
    }
    if (!sameRecords(policies, [wantedPolicy])) throw new Error('Initial monitor DMARC readback failed; apex MX was preserved.');
  }
  if (missingSendingRecords(sending, live.records, config.zoneName).length) throw new Error('Native sending DNS provisioning is incomplete. Rerun this journal.');
  journal.progress.dmarcPolicyReady = true;
  await persist();
  journal.progress.intent = 'provision exact recipient rules';
  await persist();
  const wantedRules = recipientRules(live.recipients, live.rules, config.zoneName, config.resourceNames.inbound);
  await provider.reconcileRules(wantedRules.filter(wanted => !live.rules.some(rule => equal(normalizedRule(rule), normalizedRule(wanted)))));
  journal.progress.intent = 'deploy migrated domain scope';
  await persist();
  // Save first so interrupted deployment resumes with the same scope and keys.
  config.migratedMailDomain = config.zoneName;
  await save(root, config, secrets);
  if (live.scopes.MAIL_MIGRATED_DOMAIN !== config.zoneName) await deploy(instance);
  live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  if (live.scopes.MAIL_MIGRATED_DOMAIN !== config.zoneName) throw new Error('Migrated scope is not deployed; apex MX remains at its previous receiver.');
  if (recipientRules(live.recipients, live.rules, config.zoneName, config.resourceNames.inbound).some(wanted => !live.rules.some(rule => equal(normalizedRule(rule), normalizedRule(wanted))))) throw new Error('A provisioned recipient rule is missing or disabled; apex MX was preserved.');
  journal.progress.intent = 'activate prepared organization';
  await persist();
  await provider.activateOrganization(live.organization, live.nativeDomain);
  await provider.invalidateIdentities(live.owners);
  // Organization map in inbound workers expires after 30s. KV deletion also
  // permits eventual caches, so the UI may take up to its five-minute TTL.
  await wait(31_000);
  live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  if (live.organization.status !== 'active') throw new Error('Prepared organization did not become active; apex MX was preserved.');
  journal.progress.intent = 'replace apex MX and merged SPF';
  journal.progress.mxPending = true;
  await persist();
  const current = apexRecords(live.records, config.zoneName);
  if (!sameRecords(current, journal.plan.nextApexDns)) await provider.replaceApexDns(current, journal.plan.nextApexDns);
  live = await provider.snapshot();
  assertMigrationDrift(config, journal, live);
  if (!sameRecords(apexRecords(live.records, config.zoneName), journal.plan.nextApexDns)) throw new Error('Apex DNS write outcome could not be confirmed. Rerun the same journal; do not manually replace records.');
  journal.progress.completedAt ??= now().toISOString();
  journal.progress.intent = 'complete; propagation and real mail tests required';
  await persist();
  return journal;
}

export async function rollbackMigration(root, basename, config, secrets, provider, confirm, { now = () => new Date(), writeJson = atomicJson } = {}) {
  const journal = await readMigrationPlan(root, basename, config, secrets);
  if (confirm !== journal.digest) throw new Error('Pass the exact saved plan digest with --confirm to restore its old MX/SPF.');
  if (!journal.progress.startedAt) throw new Error('This journal never started; no DNS rollback is needed.');
  const live = await provider.snapshot();
  // Rollback must work even if an owner loses TOTP/access. Validate identity,
  // DNS ownership and current MX/SPF, not interactive account readiness.
  if (!equal(live.resources, journal.plan.snapshot.resources)) throw new Error('Resource identity changed. Rollback blocked before DNS writes.');
  const current = apexRecords(live.records, config.zoneName);
  if (!sameRecords(current, journal.plan.previousApexDns) && !sameRecords(current, journal.plan.nextApexDns)) throw new Error('Current apex MX/SPF differs from both journal states. Resolve DNS drift before rollback; no records were overwritten.');
  journal.progress.rollbackPending = true;
  await writeJson(join(root, '.local', basename), journal);
  if (!sameRecords(current, journal.plan.previousApexDns)) await provider.replaceApexDns(current, journal.plan.previousApexDns);
  const after = await provider.snapshot();
  if (!sameRecords(apexRecords(after.records, config.zoneName), journal.plan.previousApexDns)) throw new Error('Rollback DNS outcome is pending. Rerun the same rollback journal.');
  journal.progress.rolledBackAt ??= now().toISOString();
  journal.progress.intent = 'old provider restored; Cloudflare receiver retained for delayed deliveries';
  await writeJson(join(root, '.local', basename), journal);
  // Deliberately retain scope, sending, exact routes and active organization.
  // Cached MX clients may still reach Cloudflare. Never delete mail or invoke
  // the zone-wide routing DNS DELETE, which would also damage the pilot.
  return journal;
}

export function migrationPreview(basename, journal) {
  const { plan } = journal;
  return { plan: basename, confirm: journal.digest, domain: plan.identity.zoneName,
    remove: plan.previousApexDns.map(({ type, name, content, priority, ttl }) => ({ type, name, content, ...(priority === undefined ? {} : { priority }), ttl })),
    add: plan.nextApexDns, recipients: plan.snapshot.recipients.map(row => row.address),
    sending: plan.sending, spfLookups: plan.spfLookups, progress: journal.progress,
    notice: 'Apply provisions sending and exact recipient routes, deploys the scope, activates the prepared organization, then replaces apex MX/SPF. Preserve the old provider for at least seven days and historical mail. Rollback restores previous MX/SPF while keeping Cloudflare available for delayed deliveries. DNS propagation is not atomic.' };
}
