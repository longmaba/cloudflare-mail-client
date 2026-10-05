// SPDX-License-Identifier: Apache-2.0
import { redirect, type Handle } from "@sveltejs/kit";
import { building, dev } from "$app/env";
import { createAuth } from "$lib/server/auth.js";
import { svelteKitHandler } from "better-auth/svelte-kit";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@doota/db/schema";
import {
  getOnboardingStatus,
  markOnboarded,
  notifyOnboardingComplete,
  onboardingHome,
  orgTwoFactorGate,
} from "$lib/server/onboarding.js";
import { initLogLevel } from "@doota/mail-core/log";

// Enabling Secure cookies renamed the auth cookies to `__Secure-better-auth.*`.
// Users who signed in BEFORE that change still carry the old, non-prefixed
// `better-auth.session_token` (+ `session_data` and the `_multi-<id>` account-
// switch cookies). better-auth now looks up only the prefixed names, so those
// stale cookies read as no-session — but the browser keeps sending them, which
// leaves an insecure token on the wire and confuses the multi-session account
// switcher. Expire any legacy (non-`__Secure-`) auth session cookie so the
// browser drops it and the user gets a clean re-login. Prod only: in dev
// `useSecureCookies` is off, so the non-prefixed name IS the current cookie.
function expireLegacySessionCookies(request: Request, response: Response): void {
  if (dev) return;
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return;
  const legacyNames = new Set(
    [...cookieHeader.matchAll(/(?:^|;\s*)(better-auth\.session_(?:token|data)(?:_multi-[^=\s;]+)?)=/g)].map(
      (match) => match[1],
    ),
  );
  for (const name of legacyNames) {
    // Match the original Path so the browser deletes the right cookie. No Secure
    // needed to delete a non-`__Secure-` cookie.
    response.headers.append("Set-Cookie", `${name}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`);
  }
}

const handleBetterAuth: Handle = async ({ event, resolve }) => {
  if (building) return resolve(event);

  // Better Auth's admin and organization HTTP routes are not used by the app — every
  // privileged action goes through org-scoped, server-side auth.api.* in the RPC
  // layer. Left reachable over HTTP, a logged-in instance admin could self-promote
  // to superadmin or impersonate members across orgs (the plugin gates only on the
  // instance role, bypassing our org scoping). Block the raw routes at the edge;
  // server-side auth.api.* calls don't pass through this handler, so provisioning
  // and the app's own admin actions keep working.
  if (event.url.pathname.startsWith("/api/auth/admin/") || event.url.pathname.startsWith("/api/auth/organization/")) {
    return new Response("Not found", { status: 404 });
  }

  const env = event.platform?.env;
  if (!env?.DB) {
    throw new Error(
      'D1 binding "DB" is missing. Run dev via `npm run dev` (platformProxy) after applying local migrations.',
    );
  }

  initLogLevel(env);
  const db = drizzle(env.DB, { schema });

  const auth = createAuth(db, env.AUTH_KV);

  event.locals.db = db;
  event.locals.auth = auth;

  let session = await auth.api.getSession({ headers: event.request.headers });

  if (session) {
    event.locals.session = session.session;
    event.locals.user = session.user;

    // A just-completed mail verification wrote fresh flags to D1, but the 5-min
    // session cookie cache still holds the stale user. `?verified=1` (set on every
    // verification landing) forces one uncached read + cookie rewrite so the new
    // emailVerified / recoveryEmailVerified is live immediately, for all users.
    // ponytail: harmless if spoofed — costs the caller one extra own-session read.
    if (event.url.searchParams.has("verified")) {
      const fresh = await auth.api.getSession({
        headers: event.request.headers,
        query: { disableCookieCache: true },
      });
      if (fresh) {
        session = fresh;
        event.locals.session = fresh.session;
        event.locals.user = fresh.user;
      }
    }

    const { user } = session;
    const p = event.url.pathname;
    // Better-auth's own routes and the recovery-link page must stay reachable
    // regardless of onboarding state (they're how a user COMPLETES onboarding).
    const bypass = p.startsWith("/api/auth") || p.startsWith("/verify-recovery-email");
    const inOnboarding = p.startsWith("/onboarding");

    if (!bypass) {
      // Read current administrator memberships and TOTP flags on every request:
      // promotion and disabling TOTP must take effect despite cached cookies.
      // Ordinary members retain the organization's optional grace period.
      const orgGate = await orgTwoFactorGate(db, user, session.session.activeOrganizationId);
      if (orgGate.kind === "grace") event.locals.enroll2faBy = orgGate.deadline;
      const mustEnroll2fa = orgGate.kind === "block";

      if (user.onboardedAt && !mustEnroll2fa) {
        // Fast path: finished. Don't let them wander back into the flow.
        if (inOnboarding) redirect(302, onboardingHome(user.role));
      } else {
        const status = await getOnboardingStatus(db, user, mustEnroll2fa);
        if (status.complete) {
          await markOnboarded(auth, user.id);
          // First completion only (the 2FA-reopen path re-enters here with
          // onboardedAt already stamped — no duplicate mails).
          if (!user.onboardedAt) {
            await notifyOnboardingComplete(db, user.id).catch((e) =>
              console.error("[onboarding] completion mails failed", e),
            );
          }
          // Rewrite the session cookie cache so onboardedAt is reflected NOW.
          // Without this the cache (~5 min) still reports onboardedAt = null and
          // every request re-derives status; refetching fresh makes the server
          // authoritative and lets subsequent requests take the fast path.
          const refreshed = await auth.api.getSession({
            headers: event.request.headers,
            query: { disableCookieCache: true },
          });
          if (refreshed) {
            event.locals.session = refreshed.session;
            event.locals.user = refreshed.user;
          }
          if (inOnboarding) redirect(302, onboardingHome(user.role));
        } else {
          event.locals.onboarding = status;
          // Nothing else is reachable until onboarding is done.
          if (!inOnboarding) redirect(302, "/onboarding");
        }
      }
    }
  }

  return svelteKitHandler({
    event,
    // Attach transport-security headers to every resolved response. HSTS closes
    // the SSL-strip downgrade path (paired with Secure cookies in auth.ts);
    // nosniff blocks content-type confusion. No global X-Frame-Options — the app
    // frames its own mail/attachment views same-origin (those routes set their
    // own frame-ancestors CSP).
    resolve: async (innerEvent) => {
      const response = await resolve(innerEvent);
      response.headers.set(
        "Strict-Transport-Security",
        "max-age=63072000; includeSubDomains; preload",
      );
      response.headers.set("X-Content-Type-Options", "nosniff");
      expireLegacySessionCookies(innerEvent.request, response);
      return response;
    },
    auth,
    building,
  });
};

export const handle: Handle = handleBetterAuth;
