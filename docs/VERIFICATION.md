# Release verification

Release candidate: `v0.1.0-rc.2`. Verification date: 2026-10-06.

## Automated evidence

On Windows with Node 24.12.0 and pnpm 10.26.2:

| Check | Result |
| --- | --- |
| Frozen workspace and infrastructure installs | Passed |
| Workspace type and Svelte checks | Passed, zero errors and warnings |
| Application tests | 79 files, 739 tests passed |
| Portable installer tests | 29 tests passed |
| Infrastructure TypeScript check | Passed |
| Production Cloudflare build | Passed |
| Local D1 migrations | All migrations through `0058` applied |

Tests cover setup locking, domain/recovery identities, expiring single-use reset
links, administrator security gates, current mailbox grants and assignments,
attachment access and reply/forward ancestry, complete-message size checks,
durable inbound receipts, duplicate deliveries, failed enqueue and replay,
scoped pilot DNS/rules, interrupted state and upgrade ownership/key guards.

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
and sending limits. All five Google apex MX records were present. R2 returned
HTTP 403 / code 10042 requesting account activation. No Cloudflare resources
were deployed and no mail or DNS records were changed by this implementation
session; live setup awaits R2 activation.

Pending evidence includes a fresh real-account installation, independent
account/domain installation, interrupted live deployment and upgrade preserving
old mail, real pilot send/receive and SPF/DKIM/DMARC checks, queue/storage faults,
backup/restore and continued Google apex delivery. These are release gates for
production, not conclusions drawn from mocked tests.

Inherited service-key sending has a separate consumer identity limitation;
service API authorization/enqueue tests do not prove service-key delivery.
The supported v1 acceptance target is the interactive domain email client.
IMAP/native desktop clients, historical import and bulk marketing are outside v1.

Use [OPERATIONS.md](OPERATIONS.md) for acceptance and recovery checks, and
[KIENG-PILOT.md](KIENG-PILOT.md) for the first deployment and DNS rollback.
