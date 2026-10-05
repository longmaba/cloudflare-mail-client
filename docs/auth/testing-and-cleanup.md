# Testing auth locally & cleanup

> Upstream testing notes follow. Use [CONTRIBUTING.md](../../CONTRIBUTING.md)
> for current synthetic fixtures and browser checks, and
> [OPERATIONS.md](../OPERATIONS.md) for administrator recovery.

## Prerequisites

```bash
pnpm db:migrate:local          # apply migrations to the local D1
pnpm dev                        # dev server on :5173
```

**`ORIGIN` must match the dev port.** Better Auth's `svelteKitHandler` only
mounts `/api/auth/*` when the request origin equals the `ORIGIN` env var. `.env`
sets `ORIGIN=http://localhost:5173`. To run on another port, drop a temporary
`.env.local` (Vite gives it priority) and delete it afterward:

```bash
printf 'ORIGIN="http://localhost:5199"\n' > .env.local
pnpm dev --port 5199 --strictPort
# ... test ...
rm .env.local
```

Sanity check that auth is mounted:

```bash
curl -s localhost:5173/api/auth/ok      # -> {"ok":true}
```

## What can be tested with curl

Better Auth JSON endpoints work directly:

```bash
# generic response + rate limit (3/min)
curl -s -X POST localhost:5173/api/auth/request-password-reset \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5173' \
  -d '{"email":"someone@domain.tld","redirectTo":"/reset-password"}'

# sign-in rate limit (5/min) — expect 429 on the 6th wrong attempt
```

**Remote functions (setup, setRecoveryEmail, onboardDomain) cannot be driven by
curl** — SvelteKit's remote-form POST uses a binary wire protocol. Test those
through the browser, or exercise the same `internalAdapter` sequence from a
throwaway dev-only `+server.ts` (guard with `if (!dev) error(404)`, delete after).

Create the first administrator through the protected `/setup` wizard. Use
the private bootstrap URL saved by `pnpm run setup`; do not put setup tokens
or passwords in shared logs. The recovery CLI cannot provision accounts.

**Cloudflare onboarding** needs `APP_CLOUDFLARE_ACCOUNT_ID` + `APP_CLOUDFLARE_API_TOKEN` (scoped Bearer)
and `MAIL_IN_WORKER_NAME`. `zoneCreate` first lists zones (read-only); a
brand-new domain issues a real `POST /zones`, so test against a domain you own.

## Inspecting local D1

```bash
pnpm wrangler d1 execute doota --local --command "SELECT email, role FROM user;"
```

## Cleanup — MANDATORY after any test that creates admins/users

Any test that creates users, verification tokens, or rate-limit rows **must
clean up after itself.** Do not leave test accounts in the local D1 — a leftover
user makes the `/setup` bootstrap guard (`userCount > 0`) refuse to run, and
stale rows pollute later tests.

Scope deletes to your known test emails (safer than truncating). Deleting from
`user` cascades to `session`/`account`/`two_factor`/`passkey`/`member`;
`organization` is **not** cascaded (the owner is just a member row), and
`verification` / `rate_limit` have no FK — clear those separately. A leftover
test org also keeps its domain "served", which will reject reused recovery
addresses in later tests.

```bash
pnpm wrangler d1 execute doota --local --command "
  DELETE FROM user WHERE email LIKE '%@your-test-domain';
  DELETE FROM organization WHERE domain = 'your-test-domain';
  DELETE FROM verification;
  DELETE FROM rate_limit;"
```

Also remove any throwaway route and the temporary `.env.local`:

```bash
rm -rf src/routes/<throwaway-test-route> .env.local
lsof -ti :5199 | xargs kill 2>/dev/null   # stop the test dev server
```

Verify a clean slate:

```bash
pnpm wrangler d1 execute doota --local --command \
  "SELECT (SELECT COUNT(*) FROM user) AS users,
          (SELECT COUNT(*) FROM verification) AS verifs,
          (SELECT COUNT(*) FROM rate_limit) AS ratelimits;"
```

## Existing-superadmin recovery (test on local first)

Use the masked password prompt. The command refuses missing accounts and
non-superadmins. Remote recovery requires the original private instance state.

```bash
pnpm --filter doota run reset-admin admin@example.test
pnpm --filter doota run reset-admin admin@your-domain.tld --remote
```

Use `--clear-2fa` only for an operator-authorized lost-authenticator recovery;
the administrator must enroll again. Read the session propagation limits in
[OPERATIONS.md](../OPERATIONS.md) before treating recovery as containment.
