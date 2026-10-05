# Contributing

Start with the root README and docs/UPSTREAM.md. Preserve Apache-2.0 notices.
Use Node 24 and pnpm 10; install frozen lockfiles. Do not add dependencies
without discussing the need. Keep changes scoped and avoid unrelated cleanup.

Run the development checks listed in the README. Authentication, routing,
mailbox authorization, MIME limits and storage changes require regression tests.
Run real mail tests only against your own test domain and accounts. Never commit
`.local/`, API tokens, encryption keys, mailbox data or recovery links.

For the local browser regression, use a development checkout and apply local
migrations before creating synthetic fixtures:

```sh
pnpm run db:migrate:local
pnpm --filter doota run seed:dummy
pnpm run dev
```

With the dev server running, execute this in a second terminal:

```sh
node apps/web/e2e/local-client.mjs
```

The harness requires installed Chrome/Chromium (set `LOCAL_CLIENT_CHROME` if
needed), uses only a synthetic `.invalid` account and blocks send requests.
It exercises folders, search, conversation actions and draft attachments,
saves screenshots in `docs/screenshots/` and writes its report under `.local/`.
The seed command replaces its synthetic organization in local D1; never use a
development fixture checkout for production mail.

Submit a PR describing the concrete problem, resulting behavior, tests and known
limits. Commit messages explain why the change was needed; git trailers such as
`Constraint`, `Rejected`, `Tested` and `Not-tested` capture relevant decisions.

Before a release, check fresh install, interruption/resume, resource/key
preservation, upgrade, browser client behavior and real mail acceptance. Record
which operating systems and independent accounts were actually exercised.
Create a version tag and GitHub release; use a prerelease until deployment and
mail acceptance are complete. Security reports belong in SECURITY.md's private
reporting flow.
