# Contributing

Start with the root README and docs/UPSTREAM.md. Preserve Apache-2.0 notices.
Use Node 24 and pnpm 10; install frozen lockfiles. Do not add dependencies
without discussing the need. Keep changes scoped and avoid unrelated cleanup.

Run the development checks listed in the README. Authentication, routing,
mailbox authorization, MIME limits and storage changes require regression tests.
Run real mail tests only against your own test domain and accounts. Never commit
`.local/`, API tokens, encryption keys, mailbox data or recovery links.

Submit a PR describing the concrete problem, resulting behavior, tests and known
limits. Commit messages explain why the change was needed; git trailers such as
`Constraint`, `Rejected`, `Tested` and `Not-tested` capture relevant decisions.

Before a release, check fresh install, interruption/resume, resource/key
preservation, upgrade, browser client behavior and real mail acceptance. Record
which operating systems and independent accounts were actually exercised.
Create a version tag and GitHub release; use a prerelease until deployment and
mail acceptance are complete. Security reports belong in SECURITY.md's private
reporting flow.
