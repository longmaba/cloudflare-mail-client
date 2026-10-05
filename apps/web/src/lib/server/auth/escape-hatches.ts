// SPDX-License-Identifier: Apache-2.0
/**
 * Auth boundary — escape hatches.
 *
 * The only place in app code allowed to reach Better Auth internals
 * (`$context` / `internalAdapter`) or write Better Auth-owned tables directly.
 * Each function here exists because the sanctioned paths (auth.api mutations /
 * databaseHooks) can't express it; the reason is documented inline. Everything
 * else must import from the boundary, never from Better Auth guts.
 *
 * A grep guard (scripts/check-auth-boundary.mjs, run in `pnpm check`) blocks
 * `$context` / `internalAdapter` / auth-schema imports anywhere outside
 * `src/lib/server/auth/`, so this can't regress.
 */
import { and, eq, gt, lte, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { getRequestEvent } from "$app/server";
import * as schema from "@doota/db/schema";
import { invalidateDomainCache } from "@doota/db/org-domains";
import type { Auth } from "$lib/server/auth.js";
import type { ZoneOnboardStatus } from "$lib/server/cloudflare.js";
import { ensurePersonalMailbox } from "@doota/mail-core/mailbox";

type Ctx = Awaited<Auth["$context"]>;
type Db = DrizzleD1Database<typeof schema>;
const GENESIS_LOCK_ID = "cloudflare-mail-client:genesis-lock";
const RESET_TTL_MS = 10 * 60 * 1000;

/**
 * Better Auth context + db for the current request. `$context` lives only here.
 * Every escape hatch runs inside a request (remote functions / load), so
 * getRequestEvent is always available.
 */
async function reqCtx(): Promise<{ db: Db; ctx: Ctx }> {
  const { locals } = getRequestEvent();
  return { db: locals.db, ctx: await locals.auth.$context };
}

// ---------------------------------------------------------------------------
// D1 — genesis super-admin
// ---------------------------------------------------------------------------

/**
 * Escape hatch — create the first super-admin (web setup wizard).
 *
 * Why no sanctioned path: at genesis there is no admin session to authorize
 * `auth.api.createUser` (admin plugin), and `emailAndPassword.disableSignUp`
 * blocks `auth.api.signUpEmail`. So the first credentialed account must be
 * minted through the internal adapter. A durable unique lock serializes genesis
 * before the first user count check. The lock remains after success, so deleting
 * all users never reopens public bootstrap.
 *
 * Roll back a failed setup before releasing the claim. A failed rollback leaves
 * the claim in place so an operator can repair the partially created account.
 *
 * (The break-glass CLI `scripts/reset-admin.mjs` is a separate floor: it runs
 * outside the Worker runtime with no bindings, so it uses raw wrangler SQL and
 * cannot route through here.)
 */
export async function createGenesisSuperadmin(input: {
  name: string;
  email: string;
  recoveryEmail: string;
  domain: string;
  password: string;
  image?: string;
}): Promise<{ id: string }> {
  const { db, ctx } = await reqCtx();
  if (await db.$count(schema.user)) throw new Error("Setup is already completed.");
  // A worker interrupted before writing its first user leaves a short lease,
  // which can be retried safely. Completed bootstrap is a permanent lock.
  await db.delete(schema.verification).where(and(
    eq(schema.verification.id, GENESIS_LOCK_ID),
    eq(schema.verification.value, "claimed"),
    lte(schema.verification.expiresAt, new Date()),
  ));
  const claim = await db.insert(schema.verification).values({
    id: GENESIS_LOCK_ID,
    identifier: GENESIS_LOCK_ID,
    value: "claimed",
    expiresAt: new Date(Date.now() + RESET_TTL_MS),
  }).onConflictDoNothing().returning({ id: schema.verification.id });
  if (!claim.length) throw new Error("Setup is already completed or in progress.");
  if (await db.$count(schema.user)) throw new Error("Setup is already completed.");

  let userId: string | undefined;
  let orgId: string | undefined;
  try {
    const createdUser = await ctx.internalAdapter.createUser({
      email: input.email.trim().toLowerCase(),
      name: input.name,
      image: input.image,
      recoveryEmail: input.recoveryEmail.trim().toLowerCase(),
      role: "superadmin",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    if (!createdUser) throw new Error("Genesis createUser returned no user.");
    userId = createdUser.id;

    await ctx.internalAdapter.linkAccount({
      providerId: "credential",
      accountId: createdUser.id,
      userId: createdUser.id,
      password: await ctx.password.hash(input.password),
    });
    // At genesis no authenticated organization owner exists. Initialize the
    // configured domain and its owner once, then use the normal org APIs.
    orgId = crypto.randomUUID();
    await db.insert(schema.organization).values({
      id: orgId,
      domain: input.domain,
      name: input.domain,
      slug: input.domain.replace(/\./g, "-"),
      status: "pending_zone",
      createdAt: new Date(),
    });
    await db.insert(schema.member).values({
      id: crypto.randomUUID(),
      organizationId: orgId,
      userId,
      role: "owner",
      createdAt: new Date(),
    });
    await ensurePersonalMailbox(db, {
      orgId,
      userId,
      address: input.email,
      displayName: input.name,
    });
    await db.update(schema.verification).set({
      value: "completed", expiresAt: new Date("9999-12-31T00:00:00Z"),
    }).where(eq(schema.verification.id, GENESIS_LOCK_ID));
    invalidateDomainCache();
    return { id: userId };
  } catch (err) {
    // Remove dependencies explicitly because D1 FK cascades are not dependable.
    if (userId) {
      await db.delete(schema.mailboxAccess).where(eq(schema.mailboxAccess.userId, userId));
      await db.delete(schema.member).where(eq(schema.member.userId, userId));
    }
    if (orgId) {
      await db.delete(schema.mailbox).where(eq(schema.mailbox.orgId, orgId));
      await db.delete(schema.organization).where(eq(schema.organization.id, orgId));
    }
    if (userId) await ctx.internalAdapter.deleteUser(userId);
    // Unlock only once rollback succeeded. A partially recovered install must
    // be repaired by an operator rather than creating a second administrator.
    await db.delete(schema.verification).where(eq(schema.verification.id, GENESIS_LOCK_ID));
    throw err;
  }
}

/** True even if an operator later deletes every user after initial setup. */
export async function genesisSetupLocked(db: Db): Promise<boolean> {
  return !!(await db.query.verification.findFirst({
    where: and(eq(schema.verification.id, GENESIS_LOCK_ID), or(
      eq(schema.verification.value, "completed"), gt(schema.verification.expiresAt, new Date()),
    )), columns: { id: true },
  }));
}

// ---------------------------------------------------------------------------
// D2 — namespaced token store (recovery-email links, pwreset codes, throttles)
// ---------------------------------------------------------------------------

/**
 * Escape hatch — mint/read/consume short-lived tokens in Better Auth's
 * `verification` table under namespaced identifiers.
 *
 * Why no sanctioned path: Better Auth exposes no `auth.api` to write arbitrary
 * verification values. Our recovery-email verification links, password-reset
 * codes, and per-user send throttles reuse this BA-owned table rather than add a
 * parallel one. All reads/writes are confined here.
 */
export const tokenStore = {
  /** Store a token; expires after ttlMs. */
  async issue(identifier: string, value: string, ttlMs: number): Promise<void> {
    const { ctx } = await reqCtx();
    await ctx.internalAdapter.createVerificationValue({
      identifier,
      value,
      expiresAt: new Date(Date.now() + ttlMs),
    });
  },
  /** One-shot: return + delete the record for an identifier (null if absent). */
  async consume(identifier: string): Promise<{ value: string } | null> {
    const { ctx } = await reqCtx();
    const rec = await ctx.internalAdapter.consumeVerificationValue(identifier);
    return rec ? { value: rec.value } : null;
  },
  /** Read the active (unexpired) record for an identifier without consuming. */
  async peek(
    identifier: string,
  ): Promise<{ id: string; value: string } | null> {
    const { db } = await reqCtx();
    const rec = await db.query.verification.findFirst({
      where: and(
        eq(schema.verification.identifier, identifier),
        gt(schema.verification.expiresAt, new Date()),
      ),
    });
    return rec ? { id: rec.id, value: rec.value } : null;
  },
  /** Delete every record with this identifier (e.g. drop a prior reset code). */
  async dropByIdentifier(identifier: string): Promise<void> {
    const { db } = await reqCtx();
    await db
      .delete(schema.verification)
      .where(eq(schema.verification.identifier, identifier));
  },
  /** Delete a single record by row id (consume-on-success for peeked codes). */
  async dropById(id: string): Promise<void> {
    const { db } = await reqCtx();
    await db.delete(schema.verification).where(eq(schema.verification.id, id));
  },
};

/** Bind a Better Auth reset token to the recovery address that received it. */
export async function rememberRecoveryReset(token: string, userId: string, email: string): Promise<void> {
  await tokenStore.issue(`recovery-reset:${token}`, JSON.stringify({ userId, email }), RESET_TTL_MS);
}

async function recoveryResetRecord(token: string): Promise<{ userId: string; email: string } | null> {
  const record = await tokenStore.peek(`recovery-reset:${token}`);
  if (!record) return null;
  let snapshot: { userId: string; email: string };
  try {
    snapshot = JSON.parse(record.value);
    if (!snapshot || typeof snapshot.userId !== "string" || typeof snapshot.email !== "string") return null;
  } catch { return null; }
  const { db } = await reqCtx();
  const user = await db.query.user.findFirst({
    where: eq(schema.user.id, snapshot.userId), columns: { recoveryEmail: true },
  });
  return user?.recoveryEmail === snapshot.email ? snapshot : null;
}

export async function validRecoveryReset(token: string): Promise<boolean> {
  return !!(await recoveryResetRecord(token));
}

/** Only a successful BA password reset proves control of the delivered link. */
export async function completeRecoveryReset(token: string): Promise<void> {
  const snapshot = await recoveryResetRecord(token);
  if (!snapshot) return;
  const consumed = await tokenStore.consume(`recovery-reset:${token}`);
  if (!consumed) return;
  const { db, ctx } = await reqCtx();
  // A recovery-address change racing redemption must not verify the new address.
  const [updated] = await db.update(schema.user).set({
    recoveryEmailVerified: true,
    recoveryEmailVerifiedAt: Date.now(),
    mustChangePassword: false,
  }).where(and(eq(schema.user.id, snapshot.userId), eq(schema.user.recoveryEmail, snapshot.email))).returning();
  if (updated) await ctx.internalAdapter.refreshUserSessions(updated);
}

/**
 * Per-key send throttle over the token store: true = allowed (marker set),
 * false = a live marker already exists (caller should back off). Dedupes the
 * "one request per window" pattern shared by recovery-email + password-reset.
 */
export async function throttleAllows(
  identifier: string,
  windowMs: number,
): Promise<boolean> {
  if (await tokenStore.peek(identifier)) return false;
  await tokenStore.issue(identifier, "1", windowMs);
  return true;
}

// ---------------------------------------------------------------------------
// D3 — app-owned user flags stored on the Better Auth `user` row
// ---------------------------------------------------------------------------

type UserAuthFlags = Partial<{
  recoveryEmailVerified: boolean;
  recoveryEmailVerifiedAt: number | null;
  mustChangePassword: boolean;
  onboardedAt: number;
  /** Inviter's user id, stamped once at provision time (invite chain). */
  invitedByUserId: string;
}>;

/**
 * Escape hatch — set app-owned boolean/timestamp flags that live on the BA
 * `user` row (recoveryEmailVerified, mustChangePassword, onboardedAt, ...).
 *
 * Why no sanctioned path: `auth.api` has no way to set custom additionalFields
 * on a user by id (self-update only covers input:true fields; these are
 * input:false, server-managed). Uses the internal adapter so
 * `databaseHooks.user.update.*` still runs.
 */
export async function setUserAuthFlags(
  userId: string,
  flags: UserAuthFlags,
): Promise<void> {
  const { ctx } = await reqCtx();
  await ctx.internalAdapter.updateUser(userId, flags);
}

/**
 * Escape hatch — stamp onboardedAt via the internal adapter so the session's
 * cached user (KV secondary storage + cookie cache) is refreshed alongside it
 * (updateUser → refreshUserSessions). A raw D1 write would leave the KV session
 * snapshot reporting onboardedAt=null, defeating the request-hook fast path.
 *
 * Takes the auth instance explicitly rather than via getRequestEvent: the caller
 * is the request hook, and `$context` resolves independent of the request event.
 * An onboardedAt-only update triggers no user.update side effect (the hook reacts
 * only to a recoveryEmail change).
 */
export async function stampOnboarded(auth: Auth, userId: string): Promise<void> {
  const ctx = await auth.$context;
  await ctx.internalAdapter.updateUser(userId, { onboardedAt: Date.now() });
}

/**
 * Escape hatch — purge a user's org memberships.
 *
 * Why no sanctioned path: admin.removeUser deletes the user + sessions + accounts
 * but doesn't cascade the organization plugin's `member` table, and D1's FK
 * cascade is unreliable at runtime. `auth.api.removeMember` keys on a
 * member-id/email (version-fragile), so a direct delete-by-userId is the robust
 * purge. Call before auth.api.removeUser so no orphan membership rows survive.
 */
export async function purgeUserMemberships(userId: string): Promise<void> {
  const { db } = await reqCtx();
  await db.delete(schema.member).where(eq(schema.member.userId, userId));
}

// ---------------------------------------------------------------------------
// D4 — organization onboarding lifecycle fields
// ---------------------------------------------------------------------------

/**
 * Escape hatch — write an org's onboarding lifecycle fields (status, zoneId).
 *
 * Why no sanctioned path: these are `input:false` org additionalFields, so
 * `auth.api.updateOrganization` refuses to set them. Written via Drizzle, then
 * `invalidateDomainCache()` to mirror the org plugin's afterUpdateOrganization
 * hook. A raw write would skip it and leave the served-domain cache stale after
 * a domain goes active (finding F1).
 */
export async function setOrgLifecycle(
  orgId: string,
  status: ZoneOnboardStatus,
  zoneId?: string,
): Promise<void> {
  const { db } = await reqCtx();
  await db
    .update(schema.organization)
    .set(zoneId ? { status, zoneId } : { status })
    .where(eq(schema.organization.id, orgId));
  invalidateDomainCache();
}
