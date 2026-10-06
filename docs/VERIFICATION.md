# Release verification

Release candidate: `v0.1.0-rc.9`. Verification date: 2026-10-06.

## Current live status: 2026-10-06

RC9 apex cutover completed at **07:19:40 UTC**, with three literal recipient
routes to the existing inbound Worker, native apex sending DKIM and monitoring
DMARC (`p=none`). Mail DNS checks passed through Cloudflare and Google public
resolvers. Before the latest reply test, preservation checks verified ten
pre-cutover messages, eleven baseline R2 ciphertext objects and unchanged keys.

After identifying a Google Workspace catch-all for unrecognized recipients and
following routing guidance, the owner reported that reply delivery works.
The resulting Google Admin settings were not independently observed. A read-only
check at **09:45:58 UTC** confirmed a new production reply receipt created at
**09:45:08 UTC** completed processing: ten inbound receipts complete, two outbound
submissions sent and one unchanged historical failure in total.
Further restricted metadata checks at **09:47:46 UTC** confirmed the new Gmail
reply has a stored message, a reply header and one non-inline attachment. The
owner reported working client delivery; the metadata check does not independently
prove opening the attachment in the client.

The owners now report all three production accounts passed send, Sent, reply,
small-attachment opening and SPF/DKIM/DMARC checks. The **09:50 UTC** live database
check still showed two sent submissions and ten completed inbound receipts,
without matching new test send/reply records for the other two accounts. Their
server correlation remains pending, so all-account acceptance is not yet
confirmed. Their browser checks and the new Google Admin settings were not
independently observed. Keep Google available through
at least **2026-10-13 07:19:40 UTC** and until correlation is resolved; retain
historical mail there.
Full operational restore remains open. Older Google-MX and
four-message preservation/restore results below record pilot milestones and do
not describe the current apex DNS or full current mailbox contents.

## Automated evidence

On Windows with Node 24.12.0 and pnpm 10.26.2:

| Check | Result |
| --- | --- |
| Frozen workspace and infrastructure installs | Passed |
| Workspace type and Svelte checks | Passed, zero errors and warnings |
| Application tests | 87 files, 941 tests passed |
| Portable installer tests | 142 tests passed; migration planning/apply/rollback, snapshots/bindings, credential replacement, API adapters and pre-upgrade restore points |
| Infrastructure TypeScript check | Passed |
| Production Cloudflare build | Passed |
| Local D1 migrations | All migrations through `0058` applied |

The RC7 migration tests cover exact owner readiness and mandatory administrator
TOTP, read-only fresh plans, digest confirmation, scope/identity/key checks,
private recovery records before writes, conservative nested SPF lookup budgets,
native DNS validation, exact recipient rules, deployment and active organization
before MX replacement, and response-loss recovery at ten mutation boundaries.
Rollback tests restore original MX/SPF while retaining the Cloudflare receiver,
mail storage and keys, including recovery after an uncertain DNS batch response.
HTTP adapter tests execute the real parameterized SQL against synthetic SQLite,
verify separate deploy/runtime credentials, metadata-free rule writes and routing
DNS PATCH unlock; zone-wide routing DELETE is never used.

Migration maintenance is limited to the exact prepared apex in the installed
zone. Public activation remains pilot-only; a staged refresh is read-only.
Unlocked migrated routing is accepted only with separate DNS validation; the
application checks the exact supplied MX and an authorized SPF policy without
changing records. Fixtures contain no live credentials or private mail.

Live readiness checks confirmed that all three production owners completed
onboarding, including authenticator TOTP for both administrators. The read-only
RC7 preview then rejected the existing apex website CNAME too broadly. RC8
permits Cloudflare's automatically flattened zone-apex CNAME and authoritative
NS while preserving them as unrelated DNS; sender and DMARC host alias conflicts
still block migration. Regression tests preserve the website through apply and
rollback and reject website drift before writes. Existing Google apex MX remained
unchanged during this correction. RC8 upgraded successfully with one web Worker
update and preserved all DNS, resources, keys and account security flags.
Its cutover stopped after native sending registration auto-created Cloudflare's
default reject DMARC policy; receiving MX remained at Google. RC9 recognizes only
that journal-owned, exact validated provider policy, normalizes it to monitor,
and persists verified readiness before recipient rules or receiving MX changes.
Preexisting policies are never normalized. Tests cover lost PATCH responses,
failed readiness persistence, duplicate/invalid/annotated policy injection and
policy reversion after readiness. Existing protected journals retain their
original preview and digest.
The merged SPF policy resolved to four nested DNS lookups during preflight.
Subsequent live cutover, reply evidence, owner reports and pending server
correlation are recorded in the current status above.

Tests cover setup locking, domain/recovery identities, expiring single-use reset
links, administrator security gates, current mailbox grants and assignments,
attachment access and reply/forward ancestry, complete-message size checks,
durable inbound receipts, duplicate deliveries, failed enqueue and replay,
scoped pilot DNS/rules, interrupted state and upgrade ownership/key guards.
Dashboard recovery regressions cover unverified hosted login addresses with
verified external recovery, conflicting cached flags, missing recovery addresses
and unavailable sending paths. The dashboard and deferred verification command
read current recovery state from D1. An already verified address succeeds without
dispatching mail; a changed address receives verification at its current external
address, and a revoked administrator role is rejected.
Sent regression tests cover archived sender copies, replied conversations in
Inbox, recipient isolation, spam/trash exclusion and complete browser mirrors.
Account-switch regressions cover releasing offline database ownership while
preserving other users' files and multiple-tab refusal, clearing another user's
remembered mailbox, and retaining the same user's offline selection.

Production account preparation tests cover the exact installer scope, active
pilot/parent-zone prerequisites, read-only staging/refresh, safe retries after
interrupted organization/owner writes, and refusal to demote active domains or
adopt unrelated pending state. Staged invitations require an active fallback
sender before creating a user. A real Better Auth integration redeems a staged
member's private setup link, verifies external recovery and signs in. Sender
checks reject staged interactive/API/draft and internal enqueue attempts before
mail/submission/queue creation; draft content and revision remain editable.
Protected DNS snapshot reruns preserve the original evidence, keys and resource
names, and doctor verifies the deployed preparation binding. Preparation leaves
apex DNS, mail routing rules and sending registrations unchanged.

Staged sender identities remain unavailable for sending while permitting owned
draft creation and editing in Compose. Compose and inline Reply show the readiness
reason and keep Send disabled. Sender identity cache versioning retains its user
namespace. Cold imports on a 28-CPU Windows host exposed full-suite timing
contention; limiting worker concurrency to at most eight (and below the host CPU
allocation) passed all tests with the original assertion and hook deadlines.

The GitHub Actions matrix runs frozen installs, installer tests, checks,
application tests and production builds on Windows, macOS and Linux. Its
[current results](https://github.com/longmaba/cloudflare-mail-client/actions)
are the authority for cross-platform CI status.

For RC4 commit `5d7043a1a61de1d272114e93190b33aeece9f5e3`, Windows and macOS
CI passed. The hosted Ubuntu job could not acquire a runner and was retried
([run](https://github.com/longmaba/cloudflare-mail-client/actions/runs/37369219703)).
An independent isolated Ubuntu 22.04 / WSL2 checkout of that exact commit passed
all eight workflow commands using checksum-verified Node 24.12.0 and pnpm
10.26.2: frozen installs, generation, 72 installer tests, zero-error checks,
848 application tests, production build and infrastructure check. This proves
native Linux execution; it does not claim the hosted Ubuntu job passed.

The follow-up [RC4 run](https://github.com/longmaba/cloudflare-mail-client/actions/runs/37371631134)
passed all three hosted platforms at `54b0f033d61145747088e022f054dddd5b2fd713`;
that commit changed only this document from the immutable RC4 tag. RC5
cross-platform status must be read from its own run, not inferred from RC4.

The [RC5 matrix](https://github.com/longmaba/cloudflare-mail-client/actions/runs/37400041887)
passed all workflow steps on hosted Linux, Windows and macOS at immutable release
commit `80225e32cbbec4635af8f30cdee293fc2a0ce2a2`, including all 893 application
tests, 79 installer tests, checks and builds. Later verification-note updates do
not change that release tag or its deployed source.

Recovery tests also passed with Windows CRLF checkouts. An actual read-only
local Wrangler D1 query confirmed that the recovery command preserves JSON
output while disabling response logs; the focused recovery suite has five tests.

The [RC6 matrix](https://github.com/longmaba/cloudflare-mail-client/actions/runs/37402454066)
passed all steps on hosted Linux, Windows and macOS at immutable release commit
`421a3b01f11ce7c522631e7036946c24a1df8d98`, including 901 application tests,
79 installer tests, checks, frozen installs and production builds.

## Browser evidence

RC6's recovery dashboard passed in local Chrome against the production build
with a synthetic administrator. An unverified hosted login with verified
external recovery displayed no verification card or button. A current D1
unverified recovery flag overrode a stale verified session and displayed only
the external address in the recovery warning. Verification removed that warning
without changing hosted-login verification. An already-verified RPC succeeded
without creating a verification token, submission or message. Original synthetic
user, organization, security and session rows were restored; the browser closed.
Browser errors and unexpected writes were zero. Default avatar requests were
blocked locally; no external email was sent. This does not test a new live
verification email or real administrator TOTP enrollment.

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

RC5 staged account behavior passed in local Chrome against the production
bundle. An ordinary synthetic member created and edited a draft through Compose;
Send remained disabled with the migration reason. An authenticated attempt to
send that owned draft returned HTTP 409 without mail, recipient, submission,
event or job additions. The retained draft reopened and remained editable through
Drafts. A foreign mailbox returned HTTP 403, and the prepared-account banner
accurately described old-provider delivery. There were zero browser errors,
external HTTP requests or unexpected send/recovery requests. The original
organization status, draft IDs and session IDs were restored, the browser and
preview stopped, and private local environment bytes restored exactly.

[Screenshots](screenshots.md) use only local synthetic accounts and mail.
Synthetic fixture accounts have pre-completed onboarding; they do not prove
recovery delivery or Cloudflare domain activation.

## Live acceptance and deployment history

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

At this pilot milestone, all required live doctor checks passed; optional billing
inspection remained a warning with scoped credentials. Public DNS resolved
Google apex MX and pilot
receiving/sending records. The owner reports outgoing SPF, DKIM and DMARC pass.
Read-only database checks confirm the delivered sender copy and received reply
are stored. The complete browser mirror incorrectly hid Sent because it lacks
sender delivery roles; Sent now retains the authorized server query and refreshes
after compose and delivery updates. After a hard refresh, the owner confirmed
the original message appears in Sent without resending, the reply attachment
opens, and mail to the existing apex address still arrives in Google. Outgoing
SPF, DKIM and DMARC all passed in the external inbox's message details.
After deploying this fix, a preserved real message's encrypted fields still
decrypted to the original digest. All four messages at that milestone remained
stored; the original database/resource identities and key fingerprint matched
the baseline.
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

The supported tagged upgrade from the published RC3 checkout to RC4 completed
against the pilot. Its protected D1 Time Travel record matches the exact release
transition, database and key fingerprint, and its in-progress state was cleared.
All four pre-upgrade messages retain identical encrypted-field and decrypted
content digests. All five referenced R2 ciphertext objects match the earlier
recovery copy, including the attachment. The three Worker resource identities
and mailbox-key fingerprints are unchanged, required doctor checks pass, and
all six public pilot/apex DNS checks pass. No mail was resent. This proves one
completed live release upgrade; interrupted live-upgrade recovery remains open.

A read-only comparison against the original DNS snapshot confirmed all five
Google apex MX records, the apex SPF record and three existing DKIM records
unchanged. Apex DMARC was absent in both snapshots. At this pilot comparison,
no apex migration had been performed.

The supported tagged RC4-to-RC5 pilot upgrade completed with its matching protected
D1 Time Travel record, original database/resources/key fingerprint and cleared
in-progress state. `setup --prepare-apex` then saved protected full-zone DNS
evidence and added only the exact staging binding on the existing web Worker.
All required doctor checks pass, including that binding. A read-only comparison
confirmed the complete zone DNS unchanged since preparation, and all six public
pilot/apex DNS checks pass. All four baseline messages still have identical
encrypted-field and decrypted-content digests, and all five baseline R2 objects
match the earlier recovery copies. The owner elected to create the separate
accounts and send invitations personally; live staged-owner setup and apex
cutover were still pending at this RC5 milestone.

The supported tagged RC5-to-RC6 upgrade updated only the web Worker. Its protected
D1 restore point matches that exact transition, and in-progress state is cleared.
The original resources, encryption keys, primary pilot and staging configuration
are preserved. All four baseline messages decrypt with identical content and
encrypted-field digests; all five referenced R2 objects match earlier recovery
copies. Complete zone DNS is unchanged since preparation, required doctor checks
pass, and administrator verification/security flags are unchanged. The live
administrator's external recovery is verified while its hosted login remains
unverified. No new live verification email was dispatched.

Pending evidence includes a fresh real-account installation, independent
account/domain installation, interrupted live deployment and upgrade preserving
old mail after interruption, real member/alias onboarding and delivery, queue/storage faults, and
complete bucket backup/operational restore. These are release gates for
production, not conclusions drawn from mocked tests.

Inherited service-key sending has a separate consumer identity limitation;
service API authorization/enqueue tests do not prove service-key delivery.
The supported v1 acceptance target is the interactive domain email client.
IMAP/native desktop clients, historical import and bulk marketing are outside v1.

Use [OPERATIONS.md](OPERATIONS.md) for acceptance and recovery checks, and
[KIENG-PILOT.md](KIENG-PILOT.md) for the first deployment and DNS rollback.
