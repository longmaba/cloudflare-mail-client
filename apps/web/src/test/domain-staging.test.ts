// SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import * as schema from '@doota/db/schema';
import { invalidateDomainCache } from '@doota/db/org-domains';
import { makeDb } from './mail-db';
import { setRequestEvent } from './stubs/app-server';
import { fakeCtx } from './fakes';

const env = vi.hoisted(() => ({ MAIL_DOMAIN: 'pilot.example.com', MAIL_STAGING_DOMAIN: 'example.com', MAIL_ROUTING_MODE: 'manual',
  MAIL_MIGRATED_DOMAIN: '', MAIL_ZONE_NAME: 'example.com', MAIL_ZONE_ID: 'zone' }));
vi.mock('$app/env/private', async (original) => ({ ...await original<object>(),
  get MAIL_DOMAIN() { return env.MAIL_DOMAIN; },
  get MAIL_STAGING_DOMAIN() { return env.MAIL_STAGING_DOMAIN; },
  get MAIL_ROUTING_MODE() { return env.MAIL_ROUTING_MODE; },
  get MAIL_MIGRATED_DOMAIN() { return env.MAIL_MIGRATED_DOMAIN; },
  get MAIL_ZONE_NAME() { return env.MAIL_ZONE_NAME; },
  get MAIL_ZONE_ID() { return env.MAIL_ZONE_ID; },
}));
vi.mock('$app/server', async (original) => ({
  ...await original<object>(),
  command: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn,
  query: (schemaOrFn: unknown, fn?: unknown) => fn ?? schemaOrFn,
}));
vi.mock('$lib/server/cloudflare.js', async (original) => ({
  ...await original<object>(),
  findMailZone: vi.fn(), pollZoneStatus: vi.fn(), wireMail: vi.fn(),
  inspectMigratedMail: vi.fn(), getRoutingConfig: vi.fn(), setSubaddressing: vi.fn(),
  cf: vi.fn(() => { throw new Error('Provider mutation forbidden during account preparation'); }),
}));
vi.mock('$lib/server/mail-routing.js', () => ({ syncDomainRecipients: vi.fn() }));
vi.mock('$lib/server/auth/escape-hatches.js', async (original) => {
  const actual = await original<typeof import('$lib/server/auth/escape-hatches.js')>();
  return { ...actual, setOrgLifecycle: vi.fn(actual.setOrgLifecycle) };
});
import { setOrgLifecycle } from '$lib/server/auth/escape-hatches.js';
import { findMailZone, pollZoneStatus, wireMail, cf, inspectMigratedMail, getRoutingConfig, setSubaddressing, MailSetupError } from '$lib/server/cloudflare.js';
import { syncDomainRecipients } from '$lib/server/mail-routing.js';
import { stageDomain, refreshDomain, listCloudflareZones, linkDomain, onboardDomain, mailRoutingConfig, toggleSubaddressing } from '$lib/rpc/domains.remote';

let db: Awaited<ReturnType<typeof makeDb>>;
let createOrganization: ReturnType<typeof vi.fn>;
let addMember: ReturnType<typeof vi.fn>;
function actor(role = 'superadmin') {
  const { ctx } = fakeCtx();
  setRequestEvent({ locals: { db, user: { id: 'owner', role }, auth: { $context: Promise.resolve(ctx), api: { createOrganization, addMember } } },
    request: new Request('https://mail.example.com') });
}
async function target(status: string, zoneId = 'zone') {
  await db.insert(schema.organization).values({ id: 'target', name: 'Apex', slug: 'apex', domain: 'example.com', status, zoneId, createdAt: new Date() });
}

beforeEach(async () => {
  vi.clearAllMocks();
  env.MAIL_DOMAIN = 'pilot.example.com'; env.MAIL_STAGING_DOMAIN = 'example.com'; env.MAIL_ROUTING_MODE = 'manual';
  env.MAIL_MIGRATED_DOMAIN = ''; env.MAIL_ZONE_NAME = 'example.com'; env.MAIL_ZONE_ID = 'zone';
  db = await makeDb(); invalidateDomainCache();
  await db.insert(schema.organization).values({ id: 'pilot', name: 'Pilot', slug: 'pilot', domain: 'pilot.example.com', status: 'active', zoneId: 'zone', createdAt: new Date() });
  await db.insert(schema.user).values({ id: 'owner', name: 'Owner', email: 'owner@pilot.example.com', role: 'superadmin' });
  createOrganization = vi.fn(async ({ body }) => {
    const { keepCurrentActiveOrganization: _, metadata, ...org } = body;
    await db.insert(schema.organization).values({ ...org, metadata: JSON.stringify(metadata), id: 'target', createdAt: new Date() });
    await db.insert(schema.member).values({ id: 'target-owner', userId: 'owner', organizationId: 'target', role: 'owner', createdAt: new Date() });
    return { id: 'target' };
  });
  addMember = vi.fn(async ({ body }) => {
    await db.insert(schema.member).values({ ...body, id: 'resumed-owner', createdAt: new Date() });
  });
  vi.mocked(findMailZone).mockResolvedValue({ id: 'zone', name: 'example.com', status: 'active', nameServers: [] });
  vi.mocked(pollZoneStatus).mockResolvedValue({ id: 'zone', name: 'example.com', status: 'active', nameServers: [] });
  vi.mocked(inspectMigratedMail).mockResolvedValue(undefined);
  vi.mocked(getRoutingConfig).mockResolvedValue({ enabled: true, status: 'ready', supportSubaddress: false, subdomains: [] });
  actor();
});

describe('installer-scoped production account preparation', () => {
  it.each(['member', 'admin'])('rejects the %s role before provider or database changes', async (role) => {
    actor(role);
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 403 });
    expect(findMailZone).not.toHaveBeenCalled(); expect(createOrganization).not.toHaveBeenCalled();
  });

  it.each(['foreign.test', 'other.example.com', 'pilot.example.com'])('rejects a different target %s', async (domain) => {
    await expect(stageDomain(domain)).rejects.toMatchObject({ status: 400 });
    expect(createOrganization).not.toHaveBeenCalled(); expect(wireMail).not.toHaveBeenCalled();
  });

  it('requires a matching active parent zone and pilot organization', async () => {
    vi.mocked(findMailZone).mockResolvedValueOnce({ id: 'zone', name: 'foreign.test', status: 'active', nameServers: [] });
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 400 });
    vi.mocked(findMailZone).mockResolvedValueOnce({ id: 'zone', name: 'example.com', status: 'pending_nameservers', nameServers: [] });
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 400 });
    await db.update(schema.organization).set({ status: 'error' }).where(eq(schema.organization.id, 'pilot'));
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 400 });
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('creates through Better Auth once and reruns without DNS, routing, or sending writes', async () => {
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'staged' });
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'staged' });
    expect(createOrganization).toHaveBeenCalledOnce();
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status: 'staged', zoneId: 'zone' });
    expect(await db.query.member.findFirst()).toMatchObject({ userId: 'owner', role: 'owner' });
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'pilot') })).toMatchObject({ status: 'active' });
    expect(wireMail).not.toHaveBeenCalled(); expect(cf).not.toHaveBeenCalled(); expect(syncDomainRecipients).not.toHaveBeenCalled();
    expect(await db.query.mailbox.findMany()).toEqual([]);
  });

  it('preserves an already active target without downgrading it', async () => {
    await target('active');
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'active' });
    expect(createOrganization).not.toHaveBeenCalled();
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status: 'active' });
    expect(wireMail).not.toHaveBeenCalled();
  });

  it('resumes after a hard interruption immediately after the atomic marked organization insert', async () => {
    createOrganization.mockImplementationOnce(async ({ body }) => {
      const { keepCurrentActiveOrganization: _, metadata, ...org } = body;
      await db.insert(schema.organization).values({ ...org, metadata: JSON.stringify(metadata), id: 'target', createdAt: new Date() });
      throw new Error('Simulated interruption before owner creation');
    });
    await expect(stageDomain('example.com')).rejects.toThrow(/interruption/);
    const pending = await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') });
    expect(pending).toMatchObject({ status: 'pending_zone', zoneId: null });
    expect(await db.query.member.findMany()).toEqual([]);
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'staged' });
    expect(createOrganization).toHaveBeenCalledOnce(); expect(addMember).toHaveBeenCalledOnce();
    expect(await db.query.member.findFirst()).toMatchObject({ userId: 'owner', organizationId: 'target', role: 'owner' });
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'staged' });
    expect(addMember).toHaveBeenCalledOnce();
    expect(wireMail).not.toHaveBeenCalled(); expect(cf).not.toHaveBeenCalled(); expect(syncDomainRecipients).not.toHaveBeenCalled();
  });

  it('resumes a lifecycle write failure while preserving the existing owner and organization', async () => {
    vi.mocked(setOrgLifecycle).mockRejectedValueOnce(new Error('Lifecycle storage unavailable'));
    await expect(stageDomain('example.com')).rejects.toThrow(/storage unavailable/);
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status: 'pending_zone' });
    await db.update(schema.organization).set({ zoneId: 'zone' }).where(eq(schema.organization.id, 'target'));
    expect(await stageDomain('example.com')).toMatchObject({ orgId: 'target', status: 'staged' });
    expect(createOrganization).toHaveBeenCalledOnce(); expect(addMember).not.toHaveBeenCalled();
    expect(await db.query.member.findMany()).toHaveLength(1);
    expect(wireMail).not.toHaveBeenCalled(); expect(cf).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2, domain: 'example.com', primaryDomain: 'pilot.example.com', zoneId: 'zone' },
    { version: 1, domain: 'foreign.test', primaryDomain: 'pilot.example.com', zoneId: 'zone' },
    { version: 1, domain: 'example.com', primaryDomain: 'other.example.com', zoneId: 'zone' },
    { version: 1, domain: 'example.com', primaryDomain: 'pilot.example.com', zoneId: 'foreign-zone' },
  ])('rejects a pending reservation with a mismatched marker %j', async (marker) => {
    await target('pending_zone');
    await db.update(schema.organization).set({ metadata: JSON.stringify({ 'cloudflare-mail-client:account-staging': marker }) }).where(eq(schema.organization.id, 'target'));
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
    expect(addMember).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
  });

  it('rejects a matching marker on an incompatible routing state or foreign zone', async () => {
    await target('wiring');
    const metadata = JSON.stringify({ 'cloudflare-mail-client:account-staging': { version: 1, domain: 'example.com', primaryDomain: 'pilot.example.com', zoneId: 'zone' } });
    await db.update(schema.organization).set({ metadata }).where(eq(schema.organization.id, 'target'));
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
    await db.update(schema.organization).set({ status: 'pending_zone', zoneId: 'foreign-zone' }).where(eq(schema.organization.id, 'target'));
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
    expect(addMember).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
  });

  it('rejects malformed unrelated metadata without adopting the pending domain', async () => {
    await target('pending_zone');
    await db.update(schema.organization).set({ metadata: '{invalid' }).where(eq(schema.organization.id, 'target'));
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
    expect(addMember).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
  });

  it.each(['pending_zone', 'pending_nameservers', 'wiring', 'error'])('rejects existing %s state', async (status) => {
    await target(status);
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status });
    expect(createOrganization).not.toHaveBeenCalled();
  });

  it('rejects an existing organization from a different zone', async () => {
    await target('staged', 'foreign-zone');
    await expect(stageDomain('example.com')).rejects.toMatchObject({ status: 409 });
  });

  it('refreshes a staged target without presenting an active zone as live mail', async () => {
    await target('staged');
    expect(await refreshDomain('target')).toEqual({ status: 'staged', nameServers: [] });
    expect(pollZoneStatus).not.toHaveBeenCalled(); expect(wireMail).not.toHaveBeenCalled(); expect(syncDomainRecipients).not.toHaveBeenCalled();
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status: 'staged' });
  });

  it('revalidates the staging configuration on refresh', async () => {
    await target('staged'); env.MAIL_STAGING_DOMAIN = 'different.test';
    await expect(refreshDomain('target')).rejects.toMatchObject({ status: 400 });
    expect(wireMail).not.toHaveBeenCalled();
  });

  it('keeps apex activation out of the primary pilot routing scope', async () => {
    await expect(linkDomain('example.com')).rejects.toMatchObject({ status: 400 });
    await expect(onboardDomain({ domain: 'example.com' })).rejects.toMatchObject({ status: 400 });
    expect(wireMail).not.toHaveBeenCalled();
  });

  it('keeps staged refresh and activation read-only even with an installed migration grant', async () => {
    await target('staged'); env.MAIL_MIGRATED_DOMAIN = 'example.com';
    expect(await refreshDomain('target')).toEqual({ status: 'staged', nameServers: [] });
    await expect(linkDomain('example.com')).rejects.toMatchObject({ status: 400 });
    await expect(onboardDomain({ domain: 'example.com' })).rejects.toMatchObject({ status: 400 });
    await expect(mailRoutingConfig('target')).rejects.toMatchObject({ status: 400 });
    expect(inspectMigratedMail).not.toHaveBeenCalled(); expect(wireMail).not.toHaveBeenCalled();
    expect(syncDomainRecipients).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
  });

  it('refreshes only an active installed migrated apex through read-only readiness inspection', async () => {
    await target('active'); env.MAIL_MIGRATED_DOMAIN = 'example.com';
    expect(await refreshDomain('target')).toEqual({ status: 'active', nameServers: [] });
    expect(inspectMigratedMail).toHaveBeenCalledWith('zone', 'example.com');
    expect(wireMail).not.toHaveBeenCalled(); expect(syncDomainRecipients).not.toHaveBeenCalled();
    expect(setOrgLifecycle).not.toHaveBeenCalled(); expect(cf).not.toHaveBeenCalled();
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'pilot') })).toMatchObject({ status: 'active' });
  });

  it.each(['MAIL_MIGRATED_DOMAIN', 'MAIL_STAGING_DOMAIN', 'MAIL_ZONE_NAME', 'MAIL_ZONE_ID'] as const)
    ('rejects active migrated refresh and settings when %s does not match', async (binding) => {
      await target('active'); env.MAIL_MIGRATED_DOMAIN = 'example.com'; env[binding] = 'foreign.test';
      await expect(refreshDomain('target')).rejects.toMatchObject({ status: 400 });
      await expect(mailRoutingConfig('target')).rejects.toMatchObject({ status: 400 });
      expect(inspectMigratedMail).not.toHaveBeenCalled(); expect(wireMail).not.toHaveBeenCalled();
      expect(getRoutingConfig).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
    });

  it('reports migrated readiness failures without rewiring or silently changing lifecycle', async () => {
    await target('active'); env.MAIL_MIGRATED_DOMAIN = 'example.com';
    vi.mocked(inspectMigratedMail).mockRejectedValueOnce(new MailSetupError('Resume the migration.'));
    await expect(refreshDomain('target')).rejects.toMatchObject({ status: 400 });
    expect(await db.query.organization.findFirst({ where: eq(schema.organization.id, 'target') })).toMatchObject({ status: 'active' });
    expect(wireMail).not.toHaveBeenCalled(); expect(setOrgLifecycle).not.toHaveBeenCalled();
  });

  it('permits migrated routing settings but keeps zone-wide plus-addressing disabled', async () => {
    await target('active'); env.MAIL_MIGRATED_DOMAIN = 'example.com';
    expect(await mailRoutingConfig('target')).toMatchObject({ enabled: true, status: 'ready', routingMode: 'manual', catchAllAttached: null });
    expect(getRoutingConfig).toHaveBeenCalledWith('zone', 'example.com');
    await expect(toggleSubaddressing({ orgId: 'target', on: true })).rejects.toMatchObject({ status: 400 });
    expect(setSubaddressing).not.toHaveBeenCalled(); expect(wireMail).not.toHaveBeenCalled();
  });

  it('rejects migrated settings on a different live zone before provider writes', async () => {
    await target('active'); env.MAIL_MIGRATED_DOMAIN = 'example.com';
    vi.mocked(pollZoneStatus).mockResolvedValueOnce({ id: 'zone', name: 'foreign.test', status: 'active', nameServers: [] });
    await expect(mailRoutingConfig('target')).rejects.toMatchObject({ status: 400 });
    expect(getRoutingConfig).not.toHaveBeenCalled(); expect(setSubaddressing).not.toHaveBeenCalled();
  });

  it('offers distinct pilot activation and account preparation actions', async () => {
    expect(await listCloudflareZones()).toEqual([
      { id: 'zone', name: 'pilot.example.com', active: true, preparation: false },
      { id: 'zone', name: 'example.com', active: true, preparation: true },
    ]);
    await db.update(schema.organization).set({ status: 'error' }).where(eq(schema.organization.id, 'pilot'));
    expect(await listCloudflareZones()).toMatchObject([
      { name: 'pilot.example.com', active: true, preparation: false },
      { name: 'example.com', active: false, preparation: true },
    ]);
  });
});
