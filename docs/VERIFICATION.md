# Release verification

Release candidate: `v0.1.0-rc.4`. Verification date: 2026-10-06.

## Automated evidence

On Windows with Node 24.12.0 and pnpm 10.26.2:

| Check | Result |
| --- | --- |
| Frozen workspace and infrastructure installs | Passed |
| Workspace type and Svelte checks | Passed, zero errors and warnings |
| Application tests | 82 files, 848 tests passed |
| Portable installer tests | 72 tests passed; migration, credential replacement, live API responses and pre-upgrade restore points |
| Infrastructure TypeScript check | Passed |
| Production Cloudflare build | Passed |
| Local D1 migrations | All migrations through `0058` applied |

Tests cover setup locking, domain/recovery identities, expiring single-use reset
links, administrator security gates, current mailbox grants and assignments,
attachment access and reply/forward ancestry, complete-message size checks,
durable inbound receipts, duplicate deliveries, failed enqueue and replay,
scoped pilot DNS/rules, interrupted state and upgrade ownership/key guards.
Sent regression tests cover archived sender copies, replied conversations in
Inbox, recipient isolation, spam/trash exclusion and complete browser mirrors.
Account-switch regressions cover releasing offline database ownership while
preserving other users' files and multiple-tab refusal, clearing another user's
remembered mailbox, and retaining the same user's offline selection.

The GitHub Actions matrix runs frozen installs, installer tests, checks,
application tests and production builds on Windows, macOS and Linux. Its
[current results](https://github.com/longmaba/cloudflare-mail-client/actions)
are the authority for cross-platform CI status.

Recovery tests also passed with Windows CRLF checkouts. An actual read-only
local Wrangler D1 query confirmed that the recovery command preserves JSON
output while disabling response logs; the focused recovery suite has five tests.

## Browser evidence

The protected first-admin wizard was exercised locally: domain login, required
external recovery address, password creation and first mailbox provisioning.
Reopening setup after creation redirects to login. The correct configured
origin logs in; recovery and TOTP requirements appear during onboarding.

The full local Chrome run passed 14 functional checks: five folder views,
free-text search, decrypted conversation/read state, preserved inbox rows,
archive/restore, trash/restore, responsive captures and saved draft attachments.
It also exposed an uncaught autosave cancellation. After fixing the debouncer,
the focused production-build compose run passed all four checks with zero
unexpected HTTP failures, page errors or runtime exceptions. Upload returned
HTTP 201; the reopened attachment returned HTTP 200 with identical bytes.
No send action was attempted. Desktop captures use 1280 by 800 pixels and the
mobile inbox uses 390 by 844 pixels; physical devices were not tested.

Administrator TOTP was exercised against the production bundle in local
Wrangler preview. The owner was required to enroll; a valid TOTP completed
enrollment, and a fresh browser context required a challenge after password
login. A wrong code returned HTTP 401 without a session; the correct code
returned HTTP 200 and unlocked the Inbox. There were no page errors or mail
send attempts. Domain activation and external recovery readiness were temporary
synthetic database fixtures, restored after the run along with session cleanup.
Development-server hydration/reload was unstable during earlier attempts;
the production preview run was clean.

The Sent regression passed in local Chrome against the production bundle. A
completed personal mailbox cache contained an archived sender conversation and
a sender conversation moved to Inbox by a reply. The actual mirror's Sent query
returned no rows, while the client showed both through the authorized server
view and retained them after a full reload. There were no browser errors or
send/recovery requests; synthetic fixtures were removed and the preview stopped.

Two ordinary members passed 11 production-browser isolation checks using local
synthetic personal mailboxes. Each member could read their own attachment bytes;
foreign mailbox/thread/attachment requests and forged sender or alias choices
were rejected, and search returned only permitted content. A real UI logout and
login in the same tab immediately selected the second member's Inbox and opened
its complete offline cache without forced navigation or reload. There were zero
prior-user renders, browser errors or mail/recovery/external requests. Fixtures
were removed, private local environment bytes restored and the preview stopped.
This run exposed and then verified fixes for retained offline pool handles and
the previous account's remembered mailbox; five new regression tests cover them.

Run the reusable harness with the fixture instructions in
[CONTRIBUTING.md](../CONTRIBUTING.md). External recovery delivery and incoming
raw attachment rendering remain outside this
browser evidence; their automated coverage does not replace live acceptance.

[Screenshots](screenshots.md) use only local synthetic accounts and mail.
Synthetic fixture accounts have pre-completed onboarding; they do not prove
recovery delivery or Cloudflare domain activation.

## Live acceptance remains open

Scoped deployment and runtime tokens passed read-only checks for the selected
active zone, Workers, D1, KV, queues, DNS, routing settings, sending subdomains
and sending limits. R2 activation was completed and its API check passed.
Initial infrastructure provisioning reached database migrations, where D1's
HTTP API rejected a trigger migration with Windows CRLF line endings.
Read-only `EXPLAIN CREATE TRIGGER` reproduced the error with CRLF and passed
with LF. The launcher now prepares complete LF-only migration files while
preserving source bytes, migration filenames, resources and mailbox keys.
The live infrastructure deployment completed: all 59 migrations and 13 triggers
are installed, the three Workers have matching ownership/key fingerprints,
and the login page loads in a browser with no console errors. Replaced runtime
and deployment credentials are saved; the mailbox keys remain stable.

Explicit named receiving activation for the pilot returned its exact domain,
`enabled: true` and `status: ready`. A repeated call returned the same ready
state. Cloudflare added the pilot MX/SPF records and its shared parent-zone
Routing DKIM selector; existing provider records were preserved. Domain
onboarding is complete, including verified external recovery and administrator
TOTP. The owner completed the live outgoing, reply and attachment test.

The provider's five-record DNS preview includes quoted SPF and shared-parent
Routing DKIM values. A live onboarding attempt exposed the old MX/SPF-only
validator rejecting that DKIM row before writes. Regression tests now cover the
observed preview, validate shared DKIM without copying or overwriting it, and
preserve strict rejection of unexpected names and malformed values. Doctor
recognizes simple quoted SPF without changing its bytes and reports provider
outages separately from credential failures.
Pilot scope checks read the routing DNS preview rather than unrelated apex
settings; mailbox rules and sending DNS still have independent readiness gates.

Native Sending registration supplies its DNS requirements through a separate
API. Setup now reads those provider values, validates exact return-path/signing
names, and creates missing records while preserving existing SPF/DMARC policies.
The pilot gained three return-path MX records, one SPF and one signing DKIM.
A repeated run made no changes. Cloudflare stores long DKIM TXT as quoted
chunks; comparison joins those chunks without changing stored bytes or accepting
a changed public key. An already-enabled registration's observed HTTP 409/code
2040 resumes only after verifying one exact enabled domain.

All required live doctor checks pass; optional billing inspection remains a
warning with scoped credentials. Public DNS resolves Google apex MX and pilot
receiving/sending records. The owner reports outgoing SPF, DKIM and DMARC pass.
Read-only database checks confirm the delivered sender copy and received reply
are stored. The complete browser mirror incorrectly hid Sent because it lacks
sender delivery roles; Sent now retains the authorized server query and refreshes
after compose and delivery updates. After a hard refresh, the owner confirmed
the original message appears in Sent without resending, the reply attachment
opens, and mail to the existing apex address still arrives in Google. Outgoing
SPF, DKIM and DMARC all passed in the external inbox's message details.
After deploying this fix, a preserved real message's encrypted fields still
decrypted to the original digest. All four current messages remain stored;
the original database/resource identities and key fingerprint match the baseline.
This is deployment preservation evidence, not a matched backup/restore test.

The actual pilot database's SQL export failed because it contains FTS virtual
tables. The upgrade prerequisite now saves a validated D1 Time Travel bookmark
and exact private recovery metadata before checkout or migrations. A live
read-only capture passed; malformed responses, provider failures and failed
record writes block the upgrade. R2 and private-state/key backups remain separate.

An isolated local data restore passed using a read-only snapshot of the pilot's
56 logical tables, captured FTS rows, original SQLite sequence counters and 13
triggers. Five referenced R2 objects were copied into an isolated filesystem.
All four stored messages decrypted with restored keys, and the one attachment's
decrypted bytes matched its original MIME part. Integrity, foreign keys, table
row counts and ciphertext-copy hashes passed; source mail and schema remained
unchanged. No live database restore, queue processing or email sending occurred.
This tests captured mail data, not a complete bucket backup or operational
restore of routing, authentication and external configuration.

A read-only comparison against the original DNS snapshot confirmed all five
Google apex MX records, the apex SPF record and three existing DKIM records
unchanged. Apex DMARC was absent in both snapshots. No apex migration has been
performed.

Pending evidence includes a fresh real-account installation, independent
account/domain installation, interrupted live deployment and upgrade preserving
old mail, real member/alias onboarding and delivery, queue/storage faults, and
complete bucket backup/operational restore. These are release gates for
production, not conclusions drawn from mocked tests.

Inherited service-key sending has a separate consumer identity limitation;
service API authorization/enqueue tests do not prove service-key delivery.
The supported v1 acceptance target is the interactive domain email client.
IMAP/native desktop clients, historical import and bulk marketing are outside v1.

Use [OPERATIONS.md](OPERATIONS.md) for acceptance and recovery checks, and
[KIENG-PILOT.md](KIENG-PILOT.md) for the first deployment and DNS rollback.
