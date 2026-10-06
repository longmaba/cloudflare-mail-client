# First deployment: kieng.io.vn

Application: `https://mail.kieng.io.vn`.
Pilot mail domain: `pilot.kieng.io.vn`. Routing mode: `manual`.

The existing apex MX snapshot (2026-10-05) is:

| Priority | Server |
| --- | --- |
| 1 | aspmx.l.google.com |
| 5 | alt1.aspmx.l.google.com |
| 5 | alt2.aspmx.l.google.com |
| 10 | alt3.aspmx.l.google.com |
| 10 | alt4.aspmx.l.google.com |

Existing SPF: `v=spf1 include:zohomail.com include:_spf.google.com ~all`.
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

Status: live deployment and mail acceptance must be recorded separately; this
document does not assert that the cutover has happened.
