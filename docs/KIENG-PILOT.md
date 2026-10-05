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
3. Complete protected administrator setup using a pilot-domain login and an
   external recovery address; enroll TOTP.
4. Run doctor and the real mail acceptance steps in OPERATIONS.md.
5. Record successful inbound/outbound authentication and continued Google
   delivery at the apex before scheduling migration.

## Apex migration and rollback

Perform only after pilot acceptance. Export the zone and store current record
IDs, content, priority and TTL in private deployment state. Provision production
addresses and exact routing rules before replacing apex mail DNS. Change the
configured mail domain deliberately, select apex mode, then review the complete
change list. Do not make that change as a pilot repair.

Keep the old receiving service available for at least seven days, check both
inboxes during DNS propagation, and retain the old provider for historical mail.
Publishing old and new MX simultaneously does not deliver every message to both
providers; senders select by priority and availability.

To roll back, restore the recorded previous MX priorities/content and SPF at the
apex, disable the new apex routing rules, verify public DNS and send an external
test to the old inbox. Keep new storage and messages intact. This DNS rollback
does not import or move messages that already reached the new receiver.

Status: live deployment and mail acceptance must be recorded separately; this
document does not assert that the cutover has happened.
