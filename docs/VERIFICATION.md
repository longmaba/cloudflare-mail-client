# Release verification

Release candidate: `v0.1.0-rc.1`. Verification date: 2026-10-05.

## Automated evidence

On Windows with Node 24.12.0 and pnpm 10.26.2:

| Check | Result |
| --- | --- |
| Frozen workspace and infrastructure installs | Passed |
| Workspace type and Svelte checks | Passed, zero errors and warnings |
| Application tests | 79 files, 738 tests passed |
| Portable installer tests | 26 tests passed |
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

Run the reusable harness with the fixture instructions in
[CONTRIBUTING.md](../CONTRIBUTING.md). Administrator TOTP enrollment, external
recovery delivery and incoming raw attachment rendering remain outside this
browser evidence; their automated coverage does not replace live acceptance.

[Screenshots](screenshots.md) use only local synthetic accounts and mail.
Synthetic fixture accounts have pre-completed onboarding; they do not prove
recovery delivery or Cloudflare domain activation.

## Live acceptance remains open

The available Cloudflare login lacks the deployment and mail/DNS permissions
required for the first instance. No Cloudflare resources were deployed and no
mail or DNS records were changed by this implementation session.

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
