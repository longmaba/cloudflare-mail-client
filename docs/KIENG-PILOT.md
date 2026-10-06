# First deployment: kieng.io.vn

Application: `https://mail.kieng.io.vn`.
Pilot mail domain: `pilot.kieng.io.vn`. Routing mode: `manual`.

## Current status: 2026-10-06

RC9 apex cutover completed at **07:19:40 UTC**. Three literal production
recipient rules target the existing inbound Worker; native apex sending DKIM
and monitoring DMARC (`p=none`) are configured. Cloudflare and Google public
resolver checks passed for the new mail DNS. Before the latest reply test,
verification preserved ten pre-cutover messages, eleven baseline R2 ciphertext
objects and the original encryption keys.

The owner identified a Google Workspace catch-all for unrecognized recipients
and subsequently reported working reply delivery after following routing
guidance. New Google Admin settings were not independently observed. A read-only
check at **09:45:58 UTC** confirmed a new production reply receipt from
**09:45:08 UTC** completed processing. Totals were ten completed inbound
receipts, two sent outbound submissions and one unchanged historical failure.
Further metadata checks at **09:47:46 UTC** confirmed that this Gmail reply has
a stored message, a reply header and one non-inline attachment. The owner
reported working client delivery; metadata checks do not prove attachment opening.

Long's production send, Sent, reply, attachment and SPF/DKIM/DMARC checks passed
according to the owner; the reply and attachment storage are independently
confirmed above. The other two accounts are configured but their owners have
not completed the individual mail tests. The owner has deferred those tests;
all-account verification is not claimed. Keep Google available through at least
**2026-10-13 07:19:40 UTC** and retain historical mail there.
See [retained Google routing](OPERATIONS.md#retained-google-workspace-routing).
The instructions and DNS snapshot below describe the earlier pilot and migration
procedure; the Google MX snapshot is rollback history, not current public DNS.

## Historical pre-cutover DNS

The apex MX snapshot on 2026-10-05 was:

| Priority | Server |
| --- | --- |
| 1 | aspmx.l.google.com |
| 5 | alt1.aspmx.l.google.com |
| 5 | alt2.aspmx.l.google.com |
| 10 | alt3.aspmx.l.google.com |
| 10 | alt4.aspmx.l.google.com |

Pre-cutover SPF: `v=spf1 include:zohomail.com include:_spf.google.com ~all`.
Re-read and export all current DNS records immediately before any cutover;
this historical public snapshot is not a complete zone backup.

## Pilot acceptance

1. Run setup against the existing account and zone, using the pilot domain.
2. Review the subdomain DNS preview. Leave apex MX/SPF and Google verification
   records intact. The web hostname adds its own application DNS binding.
   Named receiving activation adds pilot MX/SPF records and may add Cloudflare's
   shared Routing DKIM selector at the parent zone. Existing provider DKIM and
   DMARC records are checked and preserved; this is not an apex MX migration.
3. Complete protected administrator setup using a pilot-domain login and an
   external recovery address; enroll TOTP.
4. Run doctor and the real mail acceptance steps in OPERATIONS.md.
5. Record successful inbound/outbound authentication and continued Google
   delivery at the apex before scheduling migration.

## Apex migration and rollback

Perform only after pilot acceptance. Export the zone and store current record
IDs, content, priority and TTL in private deployment state. Provision production
accounts using `pnpm run setup -- --prepare-apex`, then **Prepare accounts** in
Admin → Organizations. Each owner receives a private setup link at their
external recovery address. This stages the apex organization while preserving
the pilot's primary domain, manual mode and Google MX/SPF. Confirm every owner's
login and recovery verification before cutover; staged mailboxes cannot send.

The preparation command does not perform cutover. Once every owner reaches
Inbox and administrators have enrolled authenticator TOTP, use
`pnpm run migrate -- plan` and review its fresh protected preview. Apply its
printed filename and digest following [the operations walkthrough](OPERATIONS.md#migrate-the-prepared-apex).
The recorded migration provisions exact recipient rules and native sending,
deploys the migrated scope, activates the organization, then replaces apex
MX/SPF. Do not change the saved primary domain or delete Google MX as a pilot
repair, or mark a staged organization active to bypass readiness checks.

Keep the old receiving service available for at least seven days, check both
inboxes during DNS propagation, and retain the old provider for historical mail.
Publishing old and new MX simultaneously does not deliver every message to both
providers; senders select by priority and availability.

To roll back, use `pnpm run migrate -- rollback --plan "PLAN_BASENAME" --confirm
"PLAN_DIGEST"` to restore recorded Google MX priorities/content/TTL and SPF.
Keep Cloudflare's receiver, exact apex rules and stored messages available for
senders with cached Cloudflare MX, then verify public DNS and send an external
test to Google. This DNS rollback does not import or move messages that already
reached the new receiver.

Deployment verification, owner reports and deferred account tests are
recorded separately in the dated current status above.
