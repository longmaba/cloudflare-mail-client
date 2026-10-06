// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMigrationPlan, readMigrationPlan, applyMigration, rollbackMigration, assertOwnersReady, migrationPreview } from '../lib/apex-migration.mjs';
import { apexRecords, checkSpfBudget, mergedSpf, missingSendingRecords, normalizedRule, recipientRules, routingRequirements, sameRecords, sendingRequirements, validateSender } from '../lib/migration-provider.mjs';
import { prepareApexAccounts } from '../lib/apex-preparation.mjs';
import { atomicJson, fingerprint, keyFingerprint, newSecrets, readInstance, resourceNames, saveInstance } from '../lib/instance.mjs';

const instant = new Date('2026-10-06T05:00:00.000Z');
const now = () => new Date(instant);
const lookup = async () => [['v=spf1 ip4:192.0.2.0/24 ~all']];
const clone = value => structuredClone(value);
const dnsId = number => number.toString(16).padStart(32, '0');

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'apex migration fixture with spaces-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const secrets = { ...newSecrets(), deployToken: 'synthetic-migration-deploy', runtimeToken: 'synthetic-migration-runtime' };
  let config = { version: 1, instanceId: 'synthetic-instance', instanceSlug: 'example', stage: 'prod',
    sourceOrigin: 'https://github.com/example/mail.git', sourceRemote: 'origin', accountId: 'a'.repeat(32), zoneId: 'b'.repeat(32),
    zoneName: 'example.com', mailDomain: 'pilot.example.com', routingMode: 'manual', appName: 'Example Mail',
    appOrigin: 'https://mail.example.com', phase: 'deployed', keyFingerprint: keyFingerprint(secrets),
    apexMx: [{ content: 'aspmx.l.google.com', priority: 1, ttl: 3600 }] };
  config.resourceNames = resourceNames(config);
  const records = [
    { id: dnsId(1), type: 'MX', name: 'example.com', content: 'aspmx.l.google.com', priority: 1, ttl: 3600 },
    { id: dnsId(2), type: 'TXT', name: 'example.com', content: 'v=spf1 include:_spf.google.com ~all', ttl: 3600, comment: 'retain provider authorization', tags: ['owner:instance'] },
    { id: dnsId(3), type: 'TXT', name: 'google._domainkey.example.com', content: 'old-provider-key', ttl: 3600 },
    { id: dnsId(4), type: 'TXT', name: 'cf2024-1._domainkey.example.com', content: 'v=DKIM1; p=shared-routing-key', ttl: 1 },
    { id: dnsId(5), type: 'MX', name: 'pilot.example.com', content: 'route1.mx.cloudflare.net', priority: 10, ttl: 1 },
    { id: dnsId(6), type: 'TXT', name: 'pilot.example.com', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 },
    { id: dnsId(7), type: 'TXT', name: '_dmarc.pilot.example.com', content: 'v=DMARC1; p=reject', ttl: 1 },
    { id: dnsId(8), type: 'A', name: 'www.example.com', content: '192.0.2.40', ttl: 300 },
  ];
  config = await prepareApexAccounts(root, config, secrets, async path => path.includes('/dns_records')
    ? { result: records, result_info: { total_pages: 1 } }
    : { result: { id: config.zoneId, name: config.zoneName, account: { id: config.accountId }, status: 'active' } }, { now });
  await saveInstance(root, config, secrets);
  const nativeDomain = { name: config.zoneName, tag: 'c'.repeat(32), enabled: true,
    return_path_domain: 'cf-bounce.example.com', dkim_selector: 'cf-bounce' };
  const nativeDns = [
    { type: 'MX', name: 'cf-bounce.example.com', content: 'route1.mx.cloudflare.net', priority: 20, ttl: 1 },
    { type: 'MX', name: 'cf-bounce.example.com', content: 'route2.mx.cloudflare.net', priority: 40, ttl: 1 },
    { type: 'TXT', name: 'cf-bounce.example.com', content: '"v=spf1 include:_spf.mx.cloudflare.net ~all"', ttl: 1 },
    { type: 'TXT', name: 'cf-bounce._domainkey.example.com', content: `"v=DKIM1; k=rsa; p=${'A'.repeat(392)}"`, ttl: 1 },
    { type: 'TXT', name: '_dmarc.example.com', content: '"v=DMARC1; p=reject;"', ttl: 1 },
  ];
  const rule = address => ({ tag: dnsId(100), name: `cloudflare-mail-client:${address}`, enabled: true, priority: 10,
    matchers: [{ type: 'literal', field: 'to', value: address }], actions: [{ type: 'worker', value: [config.resourceNames.inbound] }] });
  const state = { records: clone(records), rules: [rule('admin@pilot.example.com')],
    catchAll: { name: 'disabled drop', enabled: false, priority: 0, matchers: [{ type: 'all' }], actions: [{ type: 'drop' }] },
    routingEnabled: true, routingStatus: 'ready',
    routingDns: [
      { type: 'MX', name: '@', content: 'route1.mx.cloudflare.net', priority: 10, ttl: 1 },
      { type: 'MX', name: 'example.com', content: 'route2.mx.cloudflare.net', priority: 20, ttl: 1 },
      { type: 'TXT', name: '@', content: 'v=spf1 include:_spf.mx.cloudflare.net ~all', ttl: 1 },
      { type: 'TXT', name: 'cf2024-1._domainkey.example.com', content: 'v=DKIM1; p=shared-routing-key', ttl: 1 },
    ], nativeDomain: null, nativeDns: [], organization: { id: 'apex-org', domain: 'example.com', zoneId: config.zoneId, status: 'staged' },
    recipients: [{ address: 'first@example.com', mailboxId: 'first-box', isService: false },
      { address: 'second@example.com', mailboxId: 'second-box', isService: false },
      { address: 'alias@example.com', mailboxId: 'first-box', isService: false }],
    owners: ['first', 'second'].map(id => ({ id, email: `${id}@example.com`, role: 'user', banned: false, passwordChosen: true,
      passwordSetupPending: false, recoveryVerified: true, externalRecovery: true, onboarded: true,
      elevatedMembership: false, orgTotpRequired: false, totpEnabled: false })),
    grants: [{ userId: 'first', mailboxId: 'first-box', canSend: true }, { userId: 'second', mailboxId: 'second-box', canSend: true }],
    resources: { web: [{ name: 'DB', type: 'd1', id: 'database-id' }, { name: 'MAIL_RAW', type: 'r2_bucket', id: config.resourceNames.rawBucket }],
      inbound: [{ name: 'DB', type: 'd1', id: 'database-id' }], jobs: [{ name: 'MAIL_OUT_QUEUE', type: 'queue', id: config.resourceNames.outboundQueue }] },
    scopes: { MAIL_DOMAIN: config.mailDomain, MAIL_ROUTING_MODE: 'manual', MAIL_STAGING_DOMAIN: config.zoneName }, databaseId: 'database-id' };
  const initial = clone(state), events = [], commits = [];
  let sequence = 200, fault, hook;
  const commit = label => {
    events.push(label); commits.push(label);
    hook?.(label, state);
    if (fault === label) { fault = undefined; throw new Error(`Synthetic committed response lost: ${label}`); }
  };
  const provider = {
    async snapshot() { events.push('snapshot'); return clone(state); },
    async registerSender() { state.nativeDomain = clone(nativeDomain); state.nativeDns = clone(nativeDns); commit('registerSender'); },
    async addSendingDns(wanted) {
      if (!wanted.length) return;
      state.records.push(...wanted.map(record => ({ ...clone(record), id: dnsId(sequence++) })));
      commit('addSendingDns');
    },
    async ensureInitialDmarc(current, wanted) {
      const index = state.records.findIndex(record => record.id === current.id);
      assert.ok(index >= 0);
      state.records[index] = { ...state.records[index], content: wanted.content, ttl: wanted.ttl };
      commit('ensureInitialDmarc');
    },
    async reconcileRules(wanted) {
      for (const [index, record] of wanted.entries()) {
        const existing = state.rules.findIndex(row => row.tag && row.tag === record.tag);
        if (existing >= 0) state.rules[existing] = clone(record);
        else state.rules.push({ ...clone(record), tag: dnsId(sequence++) });
        commit(`recipient:${index + 1}`);
      }
      if (wanted.length) commit('reconcileRules');
    },
    async activateOrganization() {
      commit('activationSettings');
      state.organization.status = 'active'; commit('activateOrganization');
    },
    async invalidateIdentities(owners) {
      for (const [index] of owners.entries()) commit(`identity:${index + 1}`);
      commit('invalidateIdentities');
    },
    async replaceApexDns(previous, next) {
      const ids = new Set(previous.map(record => record.id));
      state.records = state.records.filter(record => !ids.has(record.id));
      state.records.push(...next.map(record => ({ ...clone(record), id: dnsId(sequence++) })));
      commit('replaceApexDns');
    },
  };
  const adapters = { now, lookup, wait: async milliseconds => { assert.equal(milliseconds, 31_000); events.push('wait'); },
    backup: async databaseId => { assert.equal(databaseId, state.databaseId); events.push('backup'); return { databaseId, bookmark: 'synthetic-bookmark', capturedAt: now().toISOString() }; },
    deploy: async instance => { assert.equal(instance.config.migratedMailDomain, config.zoneName); state.scopes.MAIL_MIGRATED_DOMAIN = config.zoneName; commit('deploy'); } };
  const plan = options => createMigrationPlan(root, config, secrets, provider, { now, lookup, ...options });
  const apply = (saved, overrides = {}, confirm = saved.journal.digest) => applyMigration(root, saved.basename, { config, secrets }, provider, confirm, { ...adapters, ...overrides });
  const rollback = (saved, overrides = {}, confirm = saved.journal.digest) => rollbackMigration(root, saved.basename, config, secrets, provider, confirm, { now, ...overrides });
  return { root, config, secrets, state, initial, nativeDomain, nativeDns, provider, events, commits, adapters, rule, plan, apply, rollback,
    setFault: label => { fault = label; }, setHook: fn => { hook = fn; } };
}

test('migration preview is read-only, snapshots fresh DNS and seals private consent without changing instance keys', async t => {
  const f = await fixture(t);
  const instanceBefore = await readFile(join(f.root, '.local', 'instance.json'));
  const keysBefore = await readFile(join(f.root, '.local', 'secrets.json'));
  const saved = await f.plan();
  assert.deepEqual(f.commits, []); assert.deepEqual(f.state, f.initial);
  assert.equal(saved.journal.digest, fingerprint(JSON.stringify(saved.journal.plan)));
  assert.equal(saved.journal.plan.spfLookups, 2);
  assert.deepEqual(saved.journal.plan.previousApexDns, apexRecords(f.initial.records, f.config.zoneName));
  assert.equal(saved.journal.plan.rules.length, 3);
  assert.equal(saved.journal.plan.sending.generatedByCloudflare, true);
  assert.equal(saved.journal.plan.rollbackRetainsReceiver, true);
  assert.deepEqual(await readFile(join(f.root, '.local', 'instance.json')), instanceBefore);
  assert.deepEqual(await readFile(join(f.root, '.local', 'secrets.json')), keysBefore);
  const raw = await readFile(join(f.root, '.local', saved.basename), 'utf8');
  for (const secret of Object.values(f.secrets)) assert.ok(!raw.includes(secret));
  assert.equal(migrationPreview(saved.basename, saved.journal).confirm, saved.journal.digest);
});

test('flattened apex website CNAME and authoritative NS survive cutover and rollback unchanged', async t => {
  const f = await fixture(t);
  const website = [
    { id: dnsId(9), type: 'CNAME', name: f.config.zoneName, content: 'site.onrender.com', proxied: true, ttl: 1, settings: { flatten_cname: false } },
    { id: dnsId(10), type: 'NS', name: f.config.zoneName, content: 'ns.provider.test', ttl: 3600 },
  ];
  f.state.records.push(...clone(website));
  const saved = await f.plan();
  await f.apply(saved);
  assert.deepEqual(f.state.records.filter(record => website.some(row => row.id === record.id)), website);
  await f.rollback(saved);
  assert.deepEqual(f.state.records.filter(record => website.some(row => row.id === record.id)), website);
});

test('apex website CNAME drift still blocks cutover before any provider writes', async t => {
  const f = await fixture(t);
  const website = { id: dnsId(9), type: 'CNAME', name: f.config.zoneName, content: 'site.onrender.com', proxied: true, ttl: 1 };
  f.state.records.push(website);
  const saved = await f.plan();
  website.content = 'other-site.onrender.com';
  await assert.rejects(f.apply(saved), /Unrelated DNS changed/);
  assert.deepEqual(f.commits, []);
});

test('CNAME and NS conflicts at native sending or DMARC hosts block the read-only preview', async t => {
  for (const type of ['CNAME', 'NS']) {
    for (const name of ['cf-bounce.example.com', 'cf-bounce._domainkey.example.com', '_dmarc.example.com']) {
      const f = await fixture(t);
      f.state.records.push({ id: dnsId(9), type, name, content: 'foreign.provider.test', ttl: 1 });
      await assert.rejects(f.plan(), /aliased or delegated/);
      assert.deepEqual(f.commits, []);
    }
  }
});

test('apply requires exact consent and a nonexpired, nonfuture plan before provider writes', async t => {
  const f = await fixture(t), saved = await f.plan();
  for (const confirm of [undefined, '', 'a'.repeat(64), saved.journal.digest.toUpperCase()]) {
    await assert.rejects(applyMigration(f.root, saved.basename, { config: f.config, secrets: f.secrets }, f.provider, confirm, f.adapters), /exact digest/);
  }
  for (const createdAt of ['2026-10-04T05:00:00.000Z', '2026-10-06T05:02:00.000Z', 'invalid']) {
    const outdated = await f.plan({ now: () => ({ toISOString: () => createdAt }) });
    await assert.rejects(f.apply(outdated), /expired/);
  }
  assert.deepEqual(f.commits, []); assert.ok(!f.events.includes('backup'));
});

test('journal read rejects unsafe paths, corrupt state, tampering and other instance identities', async t => {
  const f = await fixture(t), saved = await f.plan();
  for (const basename of ['../../outside.json', `../${saved.basename}`, `C:\\temp\\${saved.basename}`, saved.basename.toUpperCase(), '', 'apex-cutover-not-a-uuid.json']) {
    await assert.rejects(readMigrationPlan(f.root, basename, f.config, f.secrets), /paths outside private state/);
  }
  await assert.rejects(readMigrationPlan(f.root, saved.basename, { ...f.config, instanceId: 'another-instance' }, f.secrets), /identity differs/);
  const changed = clone(saved.journal); changed.plan.nextApexDns[0].content = 'attacker.invalid';
  await atomicJson(join(f.root, '.local', saved.basename), changed);
  await assert.rejects(readMigrationPlan(f.root, saved.basename, f.config, f.secrets), /integrity/);
  await writeFile(join(f.root, '.local', saved.basename), '{ synthetic-private-state');
  await assert.rejects(readMigrationPlan(f.root, saved.basename, f.config, f.secrets), error => /Raw contents were suppressed/.test(error.message) && !error.message.includes('synthetic-private-state'));
  assert.deepEqual(f.commits, []);
});

test('missing, changed or nondurable preparation evidence blocks plan without provider writes', async t => {
  const f = await fixture(t);
  const path = join(f.root, '.local', f.config.apexPreparation.snapshot);
  await writeFile(path, '{}');
  await assert.rejects(f.plan(), /differs/);
  await rm(path);
  await assert.rejects(f.plan(), /original private apex preparation snapshot/);
  assert.deepEqual(f.commits, []);
});

test('unsafe migration scope, key drift and failed durable preview save never mutate provider or saved keys', async t => {
  const f = await fixture(t);
  for (const config of [{ ...f.config, stagedMailDomain: undefined, apexPreparation: undefined },
    { ...f.config, stagedMailDomain: 'foreign.test' }, { ...f.config, routingMode: 'apex' },
    { ...f.config, migratedMailDomain: 'foreign.test' }, { ...f.config, resourceNames: { ...f.config.resourceNames, inbound: 'other-worker' } }]) {
    await assert.rejects(createMigrationPlan(f.root, config, f.secrets, f.provider, { now, lookup }));
  }
  await assert.rejects(createMigrationPlan(f.root, f.config, { ...f.secrets, ...newSecrets() }, f.provider, { now, lookup }), /keys changed/);
  assert.deepEqual(f.events, [], 'Invalid scope and key checks run before remote inspection.');
  const before = await readFile(join(f.root, '.local', 'secrets.json'));
  await assert.rejects(f.plan({ writeJson: async () => { throw new Error('Synthetic preview durability failure'); } }), /durability failure/);
  assert.deepEqual(f.commits, []);
  assert.deepEqual(await readFile(join(f.root, '.local', 'secrets.json')), before);
  assert.equal((await readdir(join(f.root, '.local'))).filter(name => name.startsWith('apex-cutover-')).length, 0);
});

test('fresh owner credentials, external recovery, onboarding, elevated TOTP and mailbox grants are mandatory', async t => {
  const f = await fixture(t);
  for (const change of [
    state => { state.owners[0].passwordChosen = false; }, state => { state.owners[0].passwordSetupPending = true; },
    state => { state.owners[0].recoveryVerified = false; }, state => { state.owners[0].externalRecovery = false; },
    state => { state.owners[0].onboarded = false; }, state => { state.owners[0].banned = true; },
    state => { state.owners[0].role = 'superadmin'; }, state => { state.owners[0].elevatedMembership = true; },
    state => { state.owners[0].orgTotpRequired = true; }, state => { state.grants[0].canSend = false; },
    state => { state.recipients[0].isService = true; }, state => { state.recipients.push(clone(state.recipients[0])); },
  ]) {
    const state = clone(f.initial); change(state);
    assert.throws(() => assertOwnersReady(state, f.config.zoneName));
  }
  const readyAdmin = clone(f.initial); readyAdmin.owners[0].role = 'superadmin'; readyAdmin.owners[0].totpEnabled = true;
  assert.doesNotThrow(() => assertOwnersReady(readyAdmin, f.config.zoneName));
  assert.deepEqual(f.commits, []);
});

test('failed Time Travel backup or private backup persistence leaves routing, lifecycle and DNS untouched', async t => {
  for (const failure of ['database', 'private']) {
    const f = await fixture(t), saved = await f.plan();
    const overrides = failure === 'database' ? { backup: async () => { throw new Error('Synthetic bookmark failure'); } }
      : { writeJson: async (path, value) => { if (path.includes('before-apex-private-')) throw new Error('Synthetic private snapshot failure'); return atomicJson(path, value); } };
    await assert.rejects(f.apply(saved, overrides), /Synthetic.*failure/);
    assert.deepEqual(f.commits, []); assert.deepEqual(f.state, f.initial);
    assert.equal(f.config.migratedMailDomain, undefined);
  }
});

test('provider-created reject DMARC becomes monitor before rules and MX, including a lost PATCH response', async t => {
  for (const loseResponse of [false, true]) {
    const f = await fixture(t), saved = await f.plan();
    f.setHook((label, state) => {
      if (label === 'registerSender') state.records.push(...f.nativeDns.map((record, index) => ({ ...clone(record), id: dnsId(400 + index) })));
    });
    if (loseResponse) {
      f.setFault('ensureInitialDmarc');
      await assert.rejects(f.apply(saved), /committed response lost/);
      assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
      assert.ok(!f.commits.some(event => event.startsWith('recipient:')));
    }
    const result = await f.apply(saved);
    assert.equal(result.progress.dmarcPolicyReady, true);
    assert.equal(f.state.records.find(record => record.name === '_dmarc.example.com').content, 'v=DMARC1; p=none');
    assert.equal(f.commits.filter(event => event === 'ensureInitialDmarc').length, 1);
    assert.ok(f.events.indexOf('ensureInitialDmarc') < f.events.indexOf('recipient:1'));
    assert.ok(f.events.indexOf('ensureInitialDmarc') < f.events.indexOf('replaceApexDns'));
  }
});

test('failed monitor-readiness persistence resumes without rewriting policy or changing MX early', async t => {
  const f = await fixture(t), saved = await f.plan();
  f.setHook((label, state) => {
    if (label === 'registerSender') state.records.push(...f.nativeDns.map((record, index) => ({ ...clone(record), id: dnsId(400 + index) })));
  });
  await assert.rejects(f.apply(saved, { writeJson: async (path, value) => {
    if (value.progress?.dmarcPolicyReady) throw new Error('Synthetic policy readiness persistence failure');
    return atomicJson(path, value);
  } }), /persistence failure/);
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
  assert.ok(!f.commits.some(event => event.startsWith('recipient:')));
  assert.equal((await readMigrationPlan(f.root, saved.basename, f.config, f.secrets)).progress.dmarcPolicyReady, undefined);
  await f.apply(saved);
  assert.equal(f.commits.filter(event => event === 'ensureInitialDmarc').length, 1);
});

test('initial policy refuses injected, invalid, duplicate or annotated DMARC before receiving cutover', async t => {
  for (const drift of ['unrelated', 'invalid', 'duplicate', 'annotated']) {
    const f = await fixture(t), saved = await f.plan();
    f.setHook((label, state) => {
      if (label !== 'registerSender') return;
      const policy = { ...clone(f.nativeDns.find(record => record.name === '_dmarc.example.com')), id: dnsId(400) };
      if (drift === 'unrelated') policy.content = 'v=DMARC1; p=quarantine';
      if (drift === 'invalid') policy.content = 'v=DMARC1; p=invalid';
      if (drift === 'annotated') policy.comment = 'operator-owned policy';
      state.records.push(policy);
      if (drift === 'duplicate') state.records.push({ ...policy, id: dnsId(401) });
    });
    await assert.rejects(f.apply(saved), /Generated sending DNS drifted/);
    assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
    assert.ok(!f.commits.includes('ensureInitialDmarc'));
  }
});

test('preexisting reject DMARC stays unchanged and is never normalized', async t => {
  const f = await fixture(t);
  const original = { id: dnsId(400), type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=reject; rua=mailto:dmarc@example.com', ttl: 3600, comment: 'existing policy' };
  f.state.records.push(clone(original));
  const saved = await f.plan();
  await f.apply(saved);
  assert.deepEqual(f.state.records.find(record => record.id === original.id), original);
  assert.ok(!f.commits.includes('ensureInitialDmarc'));
});

test('monitor policy reversion after readiness blocks MX even if it matches Cloudflare defaults', async t => {
  const f = await fixture(t), saved = await f.plan();
  f.setHook((label, state) => {
    if (label === 'deploy') state.records.find(record => record.name === '_dmarc.example.com').content = 'v=DMARC1; p=reject;';
  });
  await assert.rejects(f.apply(saved), /Generated sending DNS drifted/);
  assert.equal((await readMigrationPlan(f.root, saved.basename, f.config, f.secrets)).progress.dmarcPolicyReady, true);
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
});

test('successful apply orders backup, sender DNS, exact routes, deployed scope and activation before receiving MX', async t => {
  const f = await fixture(t), saved = await f.plan();
  const keysBefore = await readFile(join(f.root, '.local', 'secrets.json'));
  const result = await f.apply(saved);
  const steps = ['backup', 'registerSender', 'addSendingDns', 'reconcileRules', 'deploy', 'activateOrganization', 'invalidateIdentities', 'wait', 'replaceApexDns'];
  for (let index = 1; index < steps.length; index++) assert.ok(f.events.indexOf(steps[index - 1]) < f.events.indexOf(steps[index]), `${steps[index - 1]} precedes ${steps[index]}`);
  assert.ok(result.progress.backup.bookmark); assert.ok(result.progress.completedAt);
  assert.equal(f.config.mailDomain, 'pilot.example.com'); assert.equal(f.config.routingMode, 'manual');
  assert.equal(f.config.migratedMailDomain, 'example.com'); assert.equal(f.state.organization.status, 'active');
  assert.deepEqual(f.state.resources, f.initial.resources); assert.deepEqual(f.state.catchAll, f.initial.catchAll);
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.nextApexDns));
  assert.ok(sameRecords(f.state.records.filter(row => row.name.includes('pilot.')), f.initial.records.filter(row => row.name.includes('pilot.'))));
  assert.deepEqual(f.state.rules.filter(row => row.matchers.some(matcher => matcher.value.endsWith('@pilot.example.com'))), f.initial.rules);
  assert.deepEqual(await readFile(join(f.root, '.local', 'secrets.json')), keysBefore);
  const persisted = await readInstance(f.root);
  assert.deepEqual(persisted.secrets, f.secrets); assert.equal(persisted.config.keyFingerprint, f.config.keyFingerprint);
  assert.equal((await readdir(join(f.root, '.local'))).filter(name => name.startsWith('before-apex-private-')).length, 1);
});

for (const fault of ['registerSender', 'addSendingDns', 'recipient:1', 'reconcileRules', 'deploy', 'activationSettings', 'activateOrganization', 'identity:1', 'invalidateIdentities', 'replaceApexDns']) {
  test(`apply converges after provider commits but loses the ${fault} response`, async t => {
    const f = await fixture(t), saved = await f.plan(); f.setFault(fault);
    await assert.rejects(f.apply(saved), /committed response lost/);
    const result = await f.apply(saved);
    assert.ok(result.progress.completedAt);
    assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.nextApexDns));
    assert.equal(f.state.rules.filter(row => row.matchers.some(matcher => matcher.value.endsWith('@example.com'))).length, 3);
    assert.equal(f.state.nativeDomain.name, f.config.zoneName);
    assert.deepEqual(f.state.resources, f.initial.resources); assert.equal(keyFingerprint(f.secrets), f.config.keyFingerprint);
    assert.equal(f.events.filter(event => event === 'backup').length, 1);
  });
}

test('a started migration resumes after preview expiration because durable intent and fresh state govern retry', async t => {
  const f = await fixture(t), saved = await f.plan(); f.setFault('registerSender');
  await assert.rejects(f.apply(saved), /committed response lost/);
  const result = await f.apply(saved, { now: () => new Date('2026-10-10T05:00:00.000Z') });
  assert.ok(result.progress.completedAt);
});

test('repeat apply and rollback preserve converged mail state and never duplicate DNS or recipient rules', async t => {
  const f = await fixture(t), saved = await f.plan();
  const first = await f.apply(saved), state = clone(f.state);
  const second = await f.apply(saved);
  assert.deepEqual(f.state, state); assert.equal(second.progress.completedAt, first.progress.completedAt);
  assert.equal(f.commits.filter(step => step === 'replaceApexDns').length, 1);
  assert.equal(f.commits.filter(step => step === 'registerSender').length, 1);
  assert.equal(f.commits.filter(step => step === 'addSendingDns').length, 1);
  assert.equal(f.commits.filter(step => step === 'reconcileRules').length, 1);
  await f.rollback(saved); const rolledBack = clone(f.state), replacements = f.commits.filter(step => step === 'replaceApexDns').length;
  await f.rollback(saved); assert.deepEqual(f.state, rolledBack);
  assert.equal(f.commits.filter(step => step === 'replaceApexDns').length, replacements);
  await assert.rejects(f.apply(saved), /rolled back/);
});

test('rule, DNS, owner role, grant, organization and resource drift fail before mutation', async t => {
  for (const [label, change] of [
    ['unrelated rule', state => { state.rules[0].priority++; }],
    ['DNS', state => { state.records.find(row => row.name === 'www.example.com').content = '192.0.2.99'; }],
    ['owner', state => { state.owners[0].role = 'admin'; state.owners[0].totpEnabled = true; }],
    ['grant', state => { state.grants.push({ userId: 'second', mailboxId: 'first-box', canSend: true }); }],
    ['organization', state => { state.organization.id = 'other-org'; }],
    ['resource', state => { state.resources.web[0].id = 'other-database'; }],
    ['catch-all', state => { state.catchAll.enabled = true; }],
    ['primary scope', state => { state.scopes.MAIL_DOMAIN = 'other.example.com'; }],
    ['recipient', state => { state.recipients.push({ address: 'new@example.com', mailboxId: 'first-box', isService: false }); }],
    ['apex MX', state => { state.records[0].content = 'different.provider.test'; }],
  ]) {
    const f = await fixture(t), saved = await f.plan(); change(f.state);
    await assert.rejects(f.apply(saved), undefined, label);
    assert.deepEqual(f.commits, [], label); assert.ok(!f.events.includes('backup'), label);
  }
});

test('generated sending DNS drift after activation blocks receiving cutover before replacing old MX', async t => {
  for (const [label, change] of [
    ['DKIM', state => { state.records.find(row => row.name === 'cf-bounce._domainkey.example.com').content = 'v=DKIM1; p=unreviewed-key'; }],
    ['bounce MX', state => { state.records.find(row => row.type === 'MX' && row.name === 'cf-bounce.example.com').content = 'different.provider.test'; }],
    ['sender requirements', state => { state.nativeDns.find(row => row.name === 'cf-bounce._domainkey.example.com').content = `v=DKIM1; p=${'B'.repeat(392)}`; }],
  ]) {
    const f = await fixture(t), saved = await f.plan();
    f.setHook((step, state) => { if (step === 'activateOrganization') change(state); });
    await assert.rejects(f.apply(saved), undefined, label);
    assert.ok(!f.commits.includes('replaceApexDns'), label);
    assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns), label);
  }
});

test('malformed progress metadata is rejected as corrupt private journal state', async t => {
  const f = await fixture(t), saved = await f.plan();
  for (const progress of ['invalid', 1, true]) {
    await atomicJson(join(f.root, '.local', saved.basename), { ...saved.journal, progress });
    await assert.rejects(readMigrationPlan(f.root, saved.basename, f.config, f.secrets), /integrity/);
  }
  for (const dmarcPolicyReady of ['true', 1, null]) {
    await atomicJson(join(f.root, '.local', saved.basename), { ...saved.journal, progress: { dmarcPolicyReady } });
    await assert.rejects(readMigrationPlan(f.root, saved.basename, f.config, f.secrets), /integrity/);
  }
  assert.deepEqual(f.commits, []);
});

test('rollback succeeds after owner loses readiness, retaining active receiver, native sender, scope and stored resources', async t => {
  const f = await fixture(t), saved = await f.plan(); await f.apply(saved);
  f.state.owners[0].banned = true; f.state.owners[0].recoveryVerified = false; f.state.owners[0].onboarded = false;
  const rules = clone(f.state.rules), generated = clone(f.state.records.filter(row => row.name.startsWith('cf-bounce.')));
  const result = await f.rollback(saved);
  assert.ok(result.progress.rolledBackAt);
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
  assert.equal(f.state.organization.status, 'active'); assert.equal(f.state.nativeDomain.enabled, true);
  assert.equal(f.state.scopes.MAIL_MIGRATED_DOMAIN, f.config.zoneName); assert.equal(f.config.migratedMailDomain, f.config.zoneName);
  assert.deepEqual(f.state.rules, rules); assert.deepEqual(f.state.resources, f.initial.resources);
  assert.deepEqual(f.state.records.filter(row => row.name.startsWith('cf-bounce.')), generated);
});

test('rollback converges when the DNS batch committed but its response was lost', async t => {
  const f = await fixture(t), saved = await f.plan(); await f.apply(saved); f.setFault('replaceApexDns');
  await assert.rejects(f.rollback(saved), /committed response lost/);
  const result = await f.rollback(saved);
  assert.ok(result.progress.rolledBackAt); assert.equal(f.state.organization.status, 'active');
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), saved.journal.plan.previousApexDns));
  assert.equal(f.commits.filter(step => step === 'replaceApexDns').length, 2);
});

test('rollback rejects wrong consent, an unstarted journal and changed resources or arbitrary apex DNS', async t => {
  const f = await fixture(t), saved = await f.plan();
  await assert.rejects(f.rollback(saved, {}, 'wrong'), /exact saved plan digest/);
  await assert.rejects(f.rollback(saved), /never started/);
  await f.apply(saved); const commits = f.commits.length;
  f.state.resources.web[0].id = 'another-database';
  await assert.rejects(f.rollback(saved), /Resource identity changed/);
  f.state.resources = clone(f.initial.resources); f.state.records.find(row => row.name === f.config.zoneName && row.type === 'MX').content = 'third.provider.test';
  await assert.rejects(f.rollback(saved), /Resolve DNS drift/);
  assert.equal(f.commits.length, commits);
});

test('a finished rollback permits a fresh plan while retaining active Cloudflare receiving for delayed mail', async t => {
  const f = await fixture(t), first = await f.plan();
  await f.apply(first); await f.rollback(first);
  const second = await f.plan();
  assert.notEqual(second.basename, first.basename);
  assert.equal(second.journal.plan.snapshot.organization.status, 'active');
  assert.equal(second.journal.plan.sending.generatedByCloudflare, false);
  const cutover = await f.apply(second);
  assert.ok(cutover.progress.completedAt);
  assert.ok(sameRecords(apexRecords(f.state.records, f.config.zoneName), second.journal.plan.nextApexDns));
  assert.equal(f.commits.filter(step => step === 'registerSender').length, 1, 'Recutover reuses the existing exact native sending registration.');
  assert.equal(f.commits.filter(step => step === 'reconcileRules').length, 1, 'Recutover reuses the existing recipient routes.');
});

test('sender registration and DNS policies strictly refuse wrong domains, selectors, aliases and provider records', async t => {
  const f = await fixture(t);
  const sending = sendingRequirements(f.nativeDomain, f.nativeDns, f.config.zoneName);
  for (const native of [{ ...f.nativeDomain, name: 'pilot.example.com' }, { ...f.nativeDomain, tag: 'invalid' },
    { ...f.nativeDomain, return_path_domain: 'outside.example.net' }, { ...f.nativeDomain, dkim_selector: 'occupied' }, { ...f.nativeDomain, enabled: false }]) {
    assert.throws(() => validateSender(native, f.config.zoneName));
  }
  assert.throws(() => sendingRequirements(f.nativeDomain, [...f.nativeDns, { type: 'TXT', name: 'foreign.test', content: 'arbitrary', ttl: 1 }], f.config.zoneName), /Unexpected native/);
  assert.throws(() => missingSendingRecords(sending, [{ type: 'CNAME', name: 'cf-bounce.example.com', content: 'operator.example.net' }], f.config.zoneName), /aliased/);
  assert.throws(() => missingSendingRecords(sending, [{ type: 'MX', name: 'cf-bounce.example.com', content: 'operator.example.net', priority: 1 }], f.config.zoneName), /conflicts/);
  const preservePolicy = { type: 'TXT', name: '_dmarc.example.com', content: 'v=DMARC1; p=quarantine', ttl: 3600 };
  assert.ok(!missingSendingRecords(sending, [preservePolicy], f.config.zoneName).some(row => row.name === preservePolicy.name));
  assert.throws(() => routingRequirements([...f.state.routingDns, f.state.routingDns[0]], f.config.zoneName, f.state.records), /duplicate/);
});

test('SPF merging retains old senders and blocks ambiguous, redirected, negative and excessive lookup policies', async () => {
  const record = content => [{ type: 'TXT', name: 'example.com', content, ttl: 3600 }];
  assert.equal(mergedSpf(record('v=spf1 include:_spf.google.com -all'), 'example.com').content, 'v=spf1 include:_spf.google.com include:_spf.mx.cloudflare.net -all');
  for (const content of ['"v=spf1 " "include:_spf.google.com ~all"', 'v=spf1 redirect=provider.test ~all', 'v=spf1 -include:_spf.mx.cloudflare.net ~all', 'v=spf1 +all']) {
    assert.throws(() => mergedSpf(record(content), 'example.com'));
  }
  assert.equal(await checkSpfBudget(`v=spf1 ${Array(10).fill('include:provider.test').join(' ')} ~all`, lookup), 10);
  await assert.rejects(checkSpfBudget(`v=spf1 ${Array(11).fill('include:provider.test').join(' ')} ~all`, lookup), /ten DNS lookup/);
  await assert.rejects(checkSpfBudget('v=spf1 include:cycle.test ~all', async () => [['v=spf1 include:cycle.test ~all']]), /cycle/);
  await assert.rejects(checkSpfBudget('v=spf1 ptr ~all', lookup), /unsupported/);
  await assert.rejects(checkSpfBudget('v=spf1 include:provider.test ~all', async () => [['v=spf1 ~all'], ['v=spf1 -all']]), /exactly one/);
});

test('recipient requirements reject shadowing, duplicates, foreign destinations and unprovisioned apex rules', async t => {
  const f = await fixture(t), valid = f.rule('first@example.com');
  for (const rules of [[valid, clone(valid)], [{ ...valid, source: 'wrangler' }], [{ ...valid, actions: [{ type: 'worker', value: ['other-worker'] }] }],
    [{ ...valid, matchers: [{ type: 'regex', field: 'to', value: '.*@example.com' }] }], [f.rule('unknown@example.com')]]) {
    assert.throws(() => recipientRules(f.state.recipients, rules, f.config.zoneName, f.config.resourceNames.inbound));
  }
  const ownedDisabled = { ...valid, enabled: false, priority: 13 };
  assert.deepEqual(recipientRules(f.state.recipients, [ownedDisabled], f.config.zoneName, f.config.resourceNames.inbound)[0], { ...normalizedRule(ownedDisabled), enabled: true });
});
