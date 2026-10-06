// SPDX-License-Identifier: Apache-2.0
import { command, query, getRequestEvent } from "$app/server";
import { error } from "@sveltejs/kit";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import * as schema from "@doota/db/schema";
import { tryCatch } from "$lib/utils/try-catch.js";
import { setOrgLifecycle } from "$lib/server/auth/escape-hatches.js";
import { getAuthz } from "$lib/server/authz.js";
import { invalidateRemoteContentPolicy } from "$lib/server/mail-cache.js";
import {
  mirrorSubaddressing,
  mirrorRoutingSubdomains,
  mirrorReturnPathDomain,
} from "@doota/mail-core/mirror";
import { MAIL_IN_WORKER_NAME, MAIL_DOMAIN, MAIL_STAGING_DOMAIN, MAIL_ROUTING_MODE } from "$app/env/private";
import { syncDomainRecipients } from '$lib/server/mail-routing.js';
import { sendRecoveryEmailVerification } from '$lib/server/recovery-email.js';
import { senderAddress } from '@doota/db/org-domains';
import { syncRoutingIssue } from "@doota/mail-core/notify";
import {
  findMailZone,
  getRoutingConfig,
  listZoneDnsRecords,
  inspectZoneMail,
  listZones,
  pollZoneStatus,
  setSubaddressing,
  upsertTxtRecord,
  wireMail,
  MailSetupError,
  type ZoneOnboardStatus,
} from "$lib/server/cloudflare.js";

/**
 * Domain onboarding is superadmin-only and the only writer of Cloudflare state.
 * D1 stores just domain, zone_id, org mapping and the lifecycle `status`; the
 * live DNS/DKIM/routing truth is fetched from CF for settings screens only.
 */

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)+$/;

function requireActor() {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (!user) error(401, "Not authenticated");
  return user;
}

function requireSuperadmin() {
  const user = requireActor();
  if (user.role !== "superadmin") error(403, "Super-admin only");
  return user;
}

/**
 * Create the org for a domain (super-admin becomes owner) if missing, then set
 * its status/zone. Only called after a Cloudflare success, so the DB never
 * holds a domain that CF doesn't have. Idempotent (reuses an existing org).
 */
async function upsertOrg(
  domain: string,
  status: ZoneOnboardStatus,
  zoneId: string,
): Promise<string> {
  const { locals, request } = getRequestEvent();
  const existing = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.domain, domain),
    columns: { id: true },
  });
  const orgId =
    existing?.id ??
    (
      await locals.auth.api.createOrganization({
        body: { name: domain, slug: domain.replace(/\./g, "-"), domain },
        headers: request.headers,
      })
    )?.id;
  if (!orgId) throw error(500, "Could not create the organization.");
  await setOrgLifecycle(orgId, status, zoneId);
  return orgId;
}

/**
 * Wire mail on an active zone, then create/activate the org. CF first: if wiring
 * fails, no org is written (or an existing one drops to `error`), so the DB never
 * claims a domain CF hasn't accepted.
 */
async function wireAndActivate(
  domain: string,
  zoneId: string,
): Promise<string> {
  if (!MAIL_IN_WORKER_NAME) {
    error(500, "MAIL_IN_WORKER_NAME is not configured; cannot wire the catch-all route.");
  }
  let sending: { returnPathDomain?: string } = {};
  try {
    sending = await wireMail(zoneId, MAIL_IN_WORKER_NAME, domain);
  } catch (e) {
    if (e instanceof MailSetupError) error(400, e.message);
    console.error("[domains:wire] failed", e);
    error(502, "Cloudflare wiring failed. Check the API token scopes and try again.");
  }
  const orgId = await upsertOrg(domain, "wiring", zoneId);
  await syncDomainRecipients(getRequestEvent().locals.db, orgId, zoneId, domain);
  await setOrgLifecycle(orgId, 'active', zoneId);
  // Mirror the bounce/return-path subdomain to D1 (outbound envelope + inbound
  // DSN recognition read it off the hot path). Best-effort — CF stays truth.
  if (sending.returnPathDomain) {
    await tryCatch(mirrorReturnPathDomain(getRequestEvent().locals.db, orgId, sending.returnPathDomain));
  }
  // A domain just went live, so the first working sending path now exists. If the
  // super-admin who onboarded it hasn't verified their (external) primary email,
  // auto-send that verification now so they don't have to trigger it by hand.
  // Best-effort: a failure here must not fail the activation. Covers both entry
  // points, since onboardDomain and refreshDomain both route through here.
  await autoSendSuperadminVerify();
  return orgId;
}

/**
 * Fire the super-admin's primary-email verification once a sending path exists.
 * No-op unless the acting user is an unverified super-admin. better-auth's
 * verify-email endpoint no-ops if the address is already verified, so a redundant
 * call (e.g. activating a second domain) is harmless.
 */
async function autoSendSuperadminVerify() {
  const { locals } = getRequestEvent();
  const user = locals.user;
  if (user?.role !== 'superadmin' || !user.recoveryEmail || user.recoveryEmailVerified) return;
  const from = await senderAddress(locals.db, MAIL_DOMAIN);
  await tryCatch(sendRecoveryEmailVerification(user.id, user.recoveryEmail, from));
}

/**
 * Onboard a domain not yet configured on Cloudflare: create/find the zone, then,
 * only on CF success, wire mail + create the org. If the zone is still pending
 * we surface the assigned nameservers and persist a pending org (the zone exists
 * on CF, so we must track it to poll later).
 */
function configuredDomain(raw: string) {
  const domain = raw.trim().toLowerCase();
  if (!MAIL_DOMAIN || domain !== MAIL_DOMAIN) error(400, 'Use the domain selected by the installer.');
  return domain;
}

export const onboardDomain = command(
  z.object({ domain: z.string().min(3), sendingSubdomain: z.string().optional() }),
  async ({ domain: raw }) => {
    requireSuperadmin();
    const domain = configuredDomain(raw);
    const zone = await findMailZone(domain);
    if (!zone) error(400, 'Add the parent domain to the selected Cloudflare account first, then run doctor.');
    if (zone.status !== 'active') {
      const orgId = await upsertOrg(domain, zone.status, zone.id);
      return { success: true as const, orgId, status: zone.status, nameServers: zone.nameServers };
    }
    const orgId = await wireAndActivate(domain, zone.id);
    return { success: true as const, orgId, status: 'active' as ZoneOnboardStatus, nameServers: [] };
  },
);

// Both entry points enforce the same scoped routing and sending checks.
export const linkDomain = command(z.string(), async (raw) => {
  requireSuperadmin();
  const domain = configuredDomain(raw);
  const zone = await findMailZone(domain);
  if (!zone || zone.status !== 'active') error(400, 'The selected Cloudflare zone must be active.');
  const orgId = await wireAndActivate(domain, zone.id);
  return { success: true as const, orgId, status: 'active' as ZoneOnboardStatus };
});

/** Account preparation has its own installer scope and never wires mail. */
async function stagingZone(raw: string) {
  const domain = raw.trim().toLowerCase();
  if (!MAIL_STAGING_DOMAIN || domain !== MAIL_STAGING_DOMAIN || !MAIL_DOMAIN ||
      MAIL_ROUTING_MODE !== 'manual' || !MAIL_DOMAIN.endsWith(`.${domain}`)) {
    error(400, 'Use the account preparation domain selected by the installer.');
  }
  const zone = await findMailZone(MAIL_DOMAIN);
  if (!zone || zone.name !== domain || zone.status !== 'active') {
    error(400, 'The active parent zone must match the account preparation domain. Run doctor.');
  }
  const primary = await getRequestEvent().locals.db.query.organization.findFirst({
    where: eq(schema.organization.domain, MAIL_DOMAIN),
    columns: { status: true, zoneId: true },
  });
  if (primary?.status !== 'active' || primary.zoneId !== zone.id) {
    error(400, 'Activate the selected pilot domain before preparing production accounts.');
  }
  return zone;
}

const STAGING_RESERVATION = 'cloudflare-mail-client:account-staging';

function matchesStagingReservation(metadata: string | null, domain: string, zoneId: string) {
  try {
    const marker = JSON.parse(metadata ?? 'null')?.[STAGING_RESERVATION];
    return marker?.version === 1 && marker.domain === domain &&
      marker.primaryDomain === MAIL_DOMAIN && marker.zoneId === zoneId;
  } catch {
    return false;
  }
}

export const stageDomain = command(z.string(), async (raw) => {
  const actor = requireSuperadmin();
  const zone = await stagingZone(raw);
  const { locals, request } = getRequestEvent();
  const existing = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.domain, zone.name),
  });
  if (existing) {
    if (existing.status === 'pending_zone' && (!existing.zoneId || existing.zoneId === zone.id) &&
        matchesStagingReservation(existing.metadata, zone.name, zone.id)) {
      // Better Auth persists the marked org before its owner membership. A
      // stopped request may therefore need both writes completed on retry.
      const owner = await locals.db.query.member.findFirst({
        where: and(eq(schema.member.organizationId, existing.id), eq(schema.member.role, 'owner')),
        columns: { id: true },
      });
      if (!owner) {
        await locals.auth.api.addMember({
          body: { organizationId: existing.id, userId: actor.id, role: 'owner' },
          headers: request.headers,
        });
      }
      await setOrgLifecycle(existing.id, 'staged', zone.id);
      return { success: true as const, orgId: existing.id, status: 'staged' as const };
    }
    if (existing.zoneId !== zone.id || !['staged', 'active'].includes(existing.status)) {
      error(409, 'This domain already has incompatible setup state. Repair it before preparing accounts.');
    }
    return { success: true as const, orgId: existing.id, status: existing.status as 'staged' | 'active' };
  }
  const created = await locals.auth.api.createOrganization({
    // Metadata is stored in Better Auth's organization INSERT, allowing a safe
    // retry after interruption without adopting an unrelated pending domain.
    body: { name: zone.name, slug: zone.name.replace(/\./g, '-'), domain: zone.name,
      metadata: { [STAGING_RESERVATION]: { version: 1, domain: zone.name, primaryDomain: MAIL_DOMAIN, zoneId: zone.id } },
      keepCurrentActiveOrganization: true },
    headers: request.headers,
  });
  if (!created?.id) error(500, 'Could not create the organization.');
  await setOrgLifecycle(created.id, 'staged', zone.id);
  return { success: true as const, orgId: created.id, status: 'staged' as const };
});

export const refreshDomain = command(z.string(), async (orgId) => {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({ where: eq(schema.organization.id, orgId) });
  if (!org) error(404, 'Organization not found');
  if (org.status === 'staged') {
    const zone = await stagingZone(org.domain);
    if (org.zoneId !== zone.id) error(409, 'The prepared domain belongs to a different zone. Run doctor.');
    return { status: 'staged' as const, nameServers: [] };
  }
  configuredDomain(org.domain);
  const zone = org.zoneId ? await pollZoneStatus(org.zoneId) : await findMailZone(org.domain);
  if (!zone) error(400, 'The selected zone was not found. Run doctor.');
  if (zone.status === 'active') await wireAndActivate(org.domain, zone.id);
  else await setOrgLifecycle(org.id, zone.status, zone.id);
  return { status: zone.status, nameServers: zone.nameServers };
});

export const listCloudflareZones = command(async () => {
  requireSuperadmin();
  if (!MAIL_DOMAIN) error(400, 'MAIL_DOMAIN is missing. Run setup.');
  const zone = await findMailZone(MAIL_DOMAIN);
  if (!zone) return [];
  const domains = [{ id: zone.id, name: MAIL_DOMAIN, active: zone.status === 'active', preparation: false }];
  if (MAIL_STAGING_DOMAIN === zone.name && MAIL_ROUTING_MODE === 'manual' &&
      MAIL_DOMAIN.endsWith(`.${zone.name}`)) {
    const primary = await getRequestEvent().locals.db.query.organization.findFirst({
      where: eq(schema.organization.domain, MAIL_DOMAIN),
      columns: { status: true, zoneId: true },
    });
    domains.push({ id: zone.id, name: zone.name,
      active: zone.status === 'active' && primary?.status === 'active' && primary.zoneId === zone.id,
      preparation: true });
  }
  return domains;
});

/**
 * Update an org's BIMI profile: display name + logo URL. BIMI advertises a
 * verified logo for deliverability/branding. Editable by a superadmin or the
 * org's owner/admin; never touches Cloudflare.
 *
 * ponytail: logo is a URL string, not an upload. BIMI needs an HTTPS SVG Tiny-PS;
 * add upload + VMC validation when a customer actually needs the blue check.
 */
export const updateOrgProfile = command(
  z.object({
    orgId: z.string().min(1),
    name: z.string().trim().min(1, "Name is required.").max(120),
    logo: z.string().trim().url("Logo must be a URL.").or(z.literal("")).optional(),
  }),
  async ({ orgId, name, logo }) => {
    const user = requireActor();
    if (user.role !== "superadmin") {
      const adminOf = (await getAuthz()).orgAdminOf;
      if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
    }
    const { locals, request } = getRequestEvent();
    await locals.auth.api.updateOrganization({
      body: { organizationId: orgId, data: { name, logo: logo || null } },
      headers: request.headers,
    });
    return { success: true as const };
  },
);

/** Org remote-content (images + fonts) policy for the settings UI. */
export const orgRemoteContent = query(z.string().min(1), async (orgId) => {
  const user = requireActor();
  if (user.role !== "superadmin") {
    const adminOf = (await getAuthz()).orgAdminOf;
    if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
  }
  const row = await getRequestEvent().locals.db.query.orgMailSettings.findFirst({
    where: eq(schema.orgMailSettings.orgId, orgId),
    columns: { remoteContentMode: true, remoteContentLocked: true },
  });
  return {
    mode: row?.remoteContentMode === "allow" ? ("allow" as const) : ("block" as const),
    locked: row?.remoteContentLocked ?? false,
  };
});

/** Set the org remote-content default + whether users may override it. */
export const setOrgRemoteContent = command(
  z.object({ orgId: z.string().min(1), mode: z.enum(["block", "allow"]), locked: z.boolean() }),
  async ({ orgId, mode, locked }) => {
    const user = requireActor();
    if (user.role !== "superadmin") {
      const adminOf = (await getAuthz()).orgAdminOf;
      if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
    }
    await getRequestEvent()
      .locals.db.insert(schema.orgMailSettings)
      .values({ orgId, remoteContentMode: mode, remoteContentLocked: locked })
      .onConflictDoUpdate({
        target: schema.orgMailSettings.orgId,
        set: { remoteContentMode: mode, remoteContentLocked: locked },
      });
    await invalidateRemoteContentPolicy(orgId); // render caches must see it now
    return { success: true as const };
  },
);

/** Read the org's 2FA mandate: whether it's on and the grace deadline (ms). */
export const orgRequire2fa = query(z.string().min(1), async (orgId) => {
  const user = requireActor();
  if (user.role !== "superadmin") {
    const adminOf = (await getAuthz()).orgAdminOf;
    if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
  }
  const row = await getRequestEvent().locals.db.query.orgMailSettings.findFirst({
    where: eq(schema.orgMailSettings.orgId, orgId),
    columns: { require2fa: true, require2faFrom: true },
  });
  return {
    required: row?.require2fa ?? false,
    /** Grace deadline (ms) — before it members are prompted; after it, blocked. */
    from: row?.require2faFrom ? row.require2faFrom.getTime() : null,
  };
});

// Existing members need time to enroll — enabling never locks out instantly.
const REQUIRE_2FA_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Toggle the org-wide 2FA mandate (owner/admin only). Enabling sets a 7-day
 * grace deadline so existing members are prompted first, then blocked at the
 * guard. Flipping to instant lockout would be a support incident. Disabling
 * clears the deadline. API keys are exempt by construction (docs/2fa.md).
 */
export const setOrgRequire2fa = command(
  z.object({ orgId: z.string().min(1), required: z.boolean() }),
  async ({ orgId, required }) => {
    const user = requireActor();
    if (user.role !== "superadmin") {
      const adminOf = (await getAuthz()).orgAdminOf;
      if (!adminOf.includes(orgId)) error(403, "You don't manage this organization");
    }
    const from = required ? new Date(Date.now() + REQUIRE_2FA_GRACE_MS) : null;
    await getRequestEvent()
      .locals.db.insert(schema.orgMailSettings)
      .values({ orgId, require2fa: required, require2faFrom: from })
      .onConflictDoUpdate({
        target: schema.orgMailSettings.orgId,
        set: { require2fa: required, require2faFrom: from },
      });
    return { required, from: from ? from.getTime() : null };
  },
);

/**
 * Every DNS record in the org's Cloudflare zone (the apex and all subdomains),
 * for the operator's full view of what's published. Superadmin only; fetched
 * live, never persisted.
 */
export const domainDnsRecords = command(z.string(), async (orgId) => {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { zoneId: true },
  });
  if (!org?.zoneId) error(400, "No Cloudflare zone for this domain yet.");
  return listZoneDnsRecords(org.zoneId);
});

/**
 * BIMI, the verified-logo badge. One TXT record at `default._bimi.<apex>`
 * pointing at a public HTTPS square SVG Tiny-PS (plus an optional VMC cert for
 * the blue check). Inbox providers only show the logo when DMARC is enforcing
 * (p=quarantine|reject), so the status surfaces DMARC alongside the record.
 */
const HTTPS_URL = z
  .string()
  .trim()
  .url()
  .refine((url) => url.startsWith("https://"), "Must be an HTTPS URL.");

/** Published BIMI + DMARC state for the org's domain. Superadmin only. */
export const bimiStatus = command(z.string(), async (orgId) => {
  const { zoneId, apex } = await orgZone(orgId);
  const records = await listZoneDnsRecords(zoneId);
  const host = `default._bimi.${apex}`;
  const bimi = records.find((record) => record.type === "TXT" && record.name === host);
  const dmarc = records.find((record) => record.type === "TXT" && record.name === `_dmarc.${apex}`);
  const dmarcPolicy = dmarc ? (/\bp\s*=\s*(\w+)/i.exec(dmarc.content)?.[1]?.toLowerCase() ?? null) : null;
  return {
    host,
    published: !!bimi,
    record: bimi?.content ?? null,
    logoUrl: bimi ? (/\bl\s*=\s*([^;\s]+)/i.exec(bimi.content)?.[1] ?? "") : "",
    vmcUrl: bimi ? (/\ba\s*=\s*([^;\s]+)/i.exec(bimi.content)?.[1] ?? "") : "",
    // Providers require enforcement before they render the logo.
    dmarcPolicy,
    dmarcOk: dmarcPolicy === "quarantine" || dmarcPolicy === "reject",
  };
});

/** Publish/update the BIMI TXT record on the org's zone. Superadmin only. */
export const publishBimi = command(
  z.object({
    orgId: z.string().min(1),
    logoUrl: HTTPS_URL,
    vmcUrl: HTTPS_URL.optional().or(z.literal("")),
  }),
  async ({ orgId, logoUrl, vmcUrl }) => {
    const { zoneId, apex } = await orgZone(orgId);
    const content = `v=BIMI1; l=${logoUrl};${vmcUrl ? ` a=${vmcUrl};` : ""}`;
    try {
      await upsertTxtRecord(zoneId, `default._bimi.${apex}`, content);
    } catch (e) {
      console.error("[domains:bimi] publish failed", e);
      return { success: false as const, message: "Cloudflare rejected the BIMI record. Check the zone and try again." };
    }
    return { success: true as const, record: content };
  },
);

/** Fetch the org's zone (superadmin-gated). Shared by the routing commands. */
async function orgZone(orgId: string) {
  requireSuperadmin();
  const { locals } = getRequestEvent();
  const org = await locals.db.query.organization.findFirst({
    where: eq(schema.organization.id, orgId),
    columns: { domain: true, zoneId: true },
  });
  if (!org?.zoneId) error(400, "No Cloudflare zone for this domain yet.");
  configuredDomain(org.domain);
  return { zoneId: org.zoneId, apex: org.domain };
}

/**
 * Normalise a subdomain input to a full host within the apex. Accepts a bare
 * label ("mail") or a full host ("mail.acme.com"); rejects anything outside the
 * apex. Returns the lowercased host or null if invalid.
 */
function normalizeSubdomain(input: string, apex: string): string | null {
  const raw = input.trim().toLowerCase().replace(/\.$/, "");
  if (!raw) return null;
  const host = raw.endsWith(`.${apex}`) || raw === apex ? raw : `${raw}.${apex}`;
  if (host === apex) return null; // the apex is not a subdomain
  if (!host.endsWith(`.${apex}`)) return null;
  return DOMAIN_RE.test(host) ? host : null;
}

/**
 * Live inbound-routing config for the org's DNS tab: Email Routing state,
 * subaddressing flag, and configured routing subdomains. Superadmin only.
 */
export const mailRoutingConfig = command(z.string(), async (orgId) => {
  const { zoneId, apex } = await orgZone(orgId);
  const config = await getRoutingConfig(zoneId, apex);
  // Catch-all truth: routing can be enabled while the catch-all was never
  // pointed at the mail-in Worker (onboarding before the Worker deployed;
  // createRoutingRule tolerates that and leaves it unset). Surface it so the
  // UI can say "refresh to retry" instead of failing silently. null = can't
  // judge (no MAIL_IN_WORKER_NAME configured, e.g. local dev).
  const catchAllAttached = MAIL_ROUTING_MODE === 'apex' && MAIL_IN_WORKER_NAME
    ? (await inspectZoneMail(zoneId)).catchAllToWorker(MAIL_IN_WORKER_NAME)
    : null;
  // Reconcile-on-view: refresh the D1 mirror from CF truth so a direct dashboard
  // edit self-heals and the inbound hot path stays accurate.
  const { locals } = getRequestEvent();
  await mirrorSubaddressing(locals.db, orgId, MAIL_ROUTING_MODE === 'apex' && config.supportSubaddress);
  await mirrorRoutingSubdomains(locals.db, orgId, []);
  // Bell truth rides the same inspection: detached raises a routing_issue
  // notification for every superadmin, attached resolves them. Best-effort:
  // a notification hiccup must not fail the config read.
  if (catchAllAttached !== null) {
    await syncRoutingIssue(locals.db, orgId, catchAllAttached).catch(() => {});
  }
  return { ...config, catchAllAttached, routingMode: MAIL_ROUTING_MODE ?? 'manual' };
});

/** Single-domain v1: mail hosts come exclusively from installer configuration. */
export const addMailSubdomain = command(
  z.object({ orgId: z.string().min(1), subdomain: z.string().min(1) }),
  async ({ orgId }) => {
    await orgZone(orgId);
    return { success: false as const, message: 'Additional mail subdomains require a separate instance.' };
  },
);
export const removeMailSubdomain = command(
  z.object({ orgId: z.string().min(1), subdomain: z.string().min(1) }),
  async ({ orgId }) => {
    await orgZone(orgId);
    return { success: false as const, message: 'The configured mail domain is managed by setup.' };
  },
);

/** Toggle subaddressing (`user+tag@domain`) on the org's zone. Superadmin only. */
export const toggleSubaddressing = command(
  z.object({ orgId: z.string().min(1), on: z.boolean() }),
  async ({ orgId, on }) => {
    const { zoneId } = await orgZone(orgId);
    if (MAIL_ROUTING_MODE !== 'apex') error(400, 'Plus addressing changes are zone-wide and disabled during pilot installation.');
    try {
      await setSubaddressing(zoneId, on);
    } catch (e) {
      console.error("[domains:subaddress] toggle failed", e);
      return { success: false as const, message: "Cloudflare rejected the subaddressing change." };
    }
    // Write-through: mirror the flag into D1 for the resolver.
    const { locals } = getRequestEvent();
    await mirrorSubaddressing(locals.db, orgId, on);
    return { success: true as const, on };
  },
);
