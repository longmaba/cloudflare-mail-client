# Flows

> **Upstream reference: use the guided installer.**
>
> This page retains upstream Doota implementation details and historical commands.
> For this fork, follow the [current guided setup](https://github.com/longmaba/cloudflare-mail-client#install) using Node 24, pnpm 10
> and `pnpm run setup`; use `pnpm run doctor` for read-only diagnostics and
> `pnpm run upgrade` for published releases. Native sending requires Workers Paid.
> The installer preserves the selected account, domain, resource names and keys.
> Older direct-deploy and automatic-deploy instructions below are historical reference,
> not the installation path for a saved instance. See [current operations](https://github.com/longmaba/cloudflare-mail-client/blob/main/docs/OPERATIONS.md)
> and the [staged pilot guide](https://github.com/longmaba/cloudflare-mail-client/blob/main/docs/KIENG-PILOT.md).

## Bootstrap: protected domain administrator setup

Run `pnpm run setup` from the repository root. It configures the selected mail
domain and saves a private one-use bootstrap URL in `.local/bootstrap.json`,
then opens the protected `/setup` wizard in a local interactive terminal.
The server checks the setup token and permits bootstrap only while no user
exists and the genesis lock is unused. Once completed, bootstrap stays locked.

The administrator signs in as an address on the configured `MAIL_DOMAIN`
(for example, `admin@pilot.kieng.io.vn`), with a separate external recovery
address and a password. Bootstrap initializes the pending organization, owner
and administrator mailbox. It sends no mail until the selected domain has
a working sending path. Public registration remains disabled.

`reset-admin` is an existing-superadmin password-recovery tool. It cannot
create the first user, create a mailbox, or bootstrap an external login identity.
Use the private wizard for first-run provisioning; never the old CLI genesis flow.

## Administrator recovery and verification

After signing in, the administrator activates the selected mail domain, verifies
the external recovery inbox, and enrolls authenticator TOTP before onboarding
completes. Recovery verification is required for every role. A passkey does not
replace the administrator TOTP requirement. Password-reset links go to the
verified external recovery address, not the hosted login address.

Before mail activation, an existing superadmin can recover through the operator
CLI with deployment access to the saved instance. Remote recovery needs
Cloudflare access; it does not need delivery to the administrator's inbox.

## Onboarding gate (`hooks.server.ts` + `onboarding.ts`)

Once signed in, a user cannot reach anything until onboarding is complete. The
gate lives in `hooks.server.ts`:

- If `user.onboardedAt` is set → **fast path**, no per-request work; only block
  wandering back into `/onboarding`.
- Otherwise `getOnboardingStatus(db, user)` derives the remaining steps **reading
  the gating flags fresh from D1** (never the 5-minute session cookie cache):
  - `superadmin` -> activate the configured mail domain, verify external
    **recovery email**, and enroll **authenticator TOTP**.
  - `admin` -> verify **recovery email** and enroll **authenticator TOTP**.
  - `member` → verify **recovery email**
  - invited users -> **set password** through the recovery setup link
    (`mustChangePassword`); no usable temporary password is sent.
- If complete → `markOnboarded` stamps `onboardedAt` **on that same request**,
  then the session is refetched with `disableCookieCache: true` so the signed
  cookie reflects it immediately and later requests take the fast path.
- If not complete → `locals.onboarding` is populated and any non-`/onboarding`
  path redirects to `/onboarding`.

`/api/auth/*` and `/verify-recovery-email` are bypass paths — they are how a user
*completes* onboarding, so they stay reachable regardless of state. The
`/onboarding` route has **no sidebar**; it renders the checklist and the relevant
step cards.

## Domain onboarding via Cloudflare (super-admin only)

The onboarding checklist and `/admin/domains` use the saved, zone-scoped
runtime token (`APP_CLOUDFLARE_ACCOUNT_ID` + `APP_CLOUDFLARE_API_TOKEN`).
The app accepts only the installer's configured `MAIL_DOMAIN` inside
`MAIL_ZONE_ID`/`MAIL_ZONE_NAME`; it does not onboard arbitrary zones.

In pilot/manual mode, activation configures only the selected subdomain's
receiving and sending records, then synchronizes literal recipient rules for
active mailboxes and enabled aliases to `MAIL_IN_WORKER_NAME`. Existing provider
MX at the apex stays in place. A subdomain cannot use an apex catch-all.
Existing conflicting MX, recipient rules or DNS policies require operator review;
refresh does not silently replace them. Apex routing/catch-all activation is
reserved for an explicitly selected apex cutover after pilot acceptance.

D1 stores the organization/domain/zone mapping and onboarding status. DNS and
routing details are inspected live through Cloudflare. Run `pnpm run doctor`
and the staged send/receive tests before considering the pilot ready. Cloudflare
API calls do not run on the inbound-mail hot path or password validation.

## Admin provisions a member / admin (org-centric)

Admins work **through an organization**: `/admin/organizations` → pick an org →
manage its members. An org is one mail domain; picking the org pins the domain,
so the admin supplies only the **local part** of the new mailbox. Provisioning is
**only allowed once the domain is `active`** (a working sending path exists, so
the invite mail can be delivered).

`createUser` (`manage-users.remote.ts`) → `provisionUser`
(`server/provisioning.ts`):

1. Authorize through `can()` — super-admin, or an admin/owner of the target org
   (`actorOrgAdminOf`). Otherwise refused.
2. Resolve the org by id; build `email = <username>@<org.domain>`.
3. Recovery email must be **external** (`isServedDomain` guard).
4. Create the user with an inaccessible initial credential and
   `mustChangePassword: true`; create its organization membership and mailbox.
5. Install the scoped literal receiving rule before sending an invitation.
6. Send a ten-minute, single-use password-setup link to the external recovery
   inbox. No usable password appears in the email or URL.

The invited user chooses a password through the link, signs in using the hosted
address, verifies recovery, and completes authenticator TOTP if an administrator.

Member management also exposes **pause** (`pauseUser` — sets `banned` and deletes
the user's `session` rows so access is cut immediately, not after the cache
window) and **remove** (`removeUser` — `deleteUser`, FK-cascades member/session/
account). Both re-check `can()` and refuse to act on yourself or a super-admin.

## Login Flow A — password + TOTP

1. Submit Doota email + password.
2. If the account has `twoFactorEnabled`, Better Auth returns
   `{ twoFactorRedirect: true }` instead of a session.
3. Submit the 6-digit TOTP code **or** a backup code → session issued.
4. TOTP is mandatory for `admin`/`superadmin` (via the secure-account onboarding
   step); optional for `member`.

## Login Flow B — passkey

1. Trigger passkey login → WebAuthn assertion → session.
2. A passkey is an alternative sign-in method. Administrator onboarding still
   requires authenticator TOTP; passkey enrollment alone does not complete it.
3. Passkey enrollment requires an existing session, so a new user logs in via
   Flow A first, then adds a passkey (onboarding secure-account card or
   `/account/security`).

## Forgot password → external recovery email (logged-OUT)

1. User enters their **Doota email** (never asked which recovery address).
2. `requestPasswordReset` always returns the same generic 200 — no enumeration.
3. Rate limited to 3 / 60 s.
4. `sendResetPassword` sends only to a verified external `recoveryEmail`
   for every role. Hosted login addresses are not reset destinations. Delivery
   is backgrounded so errors cannot expose whether an account exists.
5. The `/forgot-password` and `/reset-password` routes redirect authenticated
   users away — those are the logged-out flow only.

## Reset password — logged-OUT (token link)

- Link points at `/api/auth/reset-password/<token>` → redirects to the
  `/reset-password` page with `?token=` (or `?error=INVALID_TOKEN`).
- Token expires in 10 minutes; single-use.
- **Resets the password only.** `revokeSessionsOnPasswordReset` clears sessions
  but 2FA is untouched — a compromised recovery inbox must not equal a full 2FA
  bypass. Lost authenticator is recovered with **backup codes**, not this link.

## Change password — logged-IN (in-app dialog)

Authenticated users change their password through a popup, not the token flow
(`account/security` → `change-password-dialog.svelte`). It requires **both** an
emailed code **and** the current password:

1. `requestPasswordResetCode` (`reset-password.remote.ts` → `password-reset.ts`)
   mails a 6-digit code to the verified external recovery address for every role.
   Throttled 1 / 60 s; one active code per user
   (10-min TTL); reuses the `verification` table (`pwreset:<id>`).
2. `confirmPasswordReset` requires the code **and** `currentPassword`, then goes
   through `auth.api.changePassword({ revokeOtherSessions: true })` so the
   current password is actually proven before the change lands.

## Recovery email: set & verify

- `setRecoveryEmail` (`recovery-email.remote.ts`, requires a session):
  rejects served-domain addresses, sets `recoveryEmailVerified = false`, sends a
  confirm link. Throttled to **one email per user per minute**.
- `verify-recovery-email?token=` consumes the token (single-use, ten-minute
  expiry). A token is rejected if the user's
  `recoveryEmail` changed after it was issued (stale link), then flips
  `recoveryEmailVerified = true`.

## Escape hatches

1. **Backup codes** — the lost-authenticator path, generated at TOTP enrollment.
2. **In-app change-password dialog** — self-service, code + current password.
3. **Admin-initiated reset** for a member with no working recovery path — not
   yet built.
4. **CLI, existing superadmins only** - from the repository root:

   `pnpm --filter doota reset-admin admin@pilot.kieng.io.vn --remote`

   Enter the new password at the masked prompt. This resets an existing
   superadmin's password and revokes sessions; it cannot create users. Add
   `--clear-2fa` only for deliberate operator recovery when backup codes are
   unavailable, then re-enroll authenticator TOTP. See
   `apps/web/scripts/reset-admin.mjs`.
