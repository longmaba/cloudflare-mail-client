# Operations, backup and recovery

Run `pnpm run doctor` before and after every deployment. It checks the configured
account, zone, resources, mail DNS and routing. Account activation, paid sending
eligibility, delivery and sender reputation still require Cloudflare dashboard
and real mail checks. An API permission failure must not be treated as an empty
resource list.

## Backup

Back up `.local/instance.json`, `.local/secrets.json`, the private Alchemy state,
the D1 database and the entire R2 mail bucket as one instance. Include queue/job
metadata in the D1 snapshot. Never rotate `MAIL_DEK` or `MAIL_SEARCH_KEY` during
an upgrade. Use D1 Time Travel and authenticated R2 object copies; record the
snapshot time, resource IDs, release and key fingerprint. Cloudflare's SQL
export currently rejects databases containing FTS virtual tables, including
this client's search tables. Do not drop live search tables to make an export
work. See [D1 export limitations](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations).

Initial setup also keeps its resumable private wizard link in
`.local/bootstrap.json`. Treat it as a credential; setup suppresses the link in
CI and unattended logs. Setup runs diagnostics automatically and exits with a
failure status while required pilot DNS or routing is incomplete, even if the
application Worker itself has deployed successfully.
Keep an encrypted off-account copy and test restores to an isolated instance.
Encryption keys alone are not a mail backup; R2 objects alone are unreadable.

## Restore

Restore the matching database, R2 objects, private resource state and secrets.
Use the original instance slug, account, stage and bindings. Deploy the same
release first, run doctor, verify old attachments and search, then upgrade.
Pause ingress and queue consumption while restoring to avoid writing into a
partially restored snapshot. Never destroy and recreate storage to repair a
deployment error.

## Upgrade

Commit or stash local source changes. Run `pnpm run upgrade` and select a tagged
release. The launcher keeps private instance state and stable keys, installs
locked dependencies, builds and deploys through the same infrastructure stack.
Before checkout or migrations, the launcher saves a validated D1 Time Travel
bookmark in a private `.local/before-upgrade-*.json` file. The record includes
the exact database, instance, release transition and key fingerprint. Failure
to capture or save the bookmark blocks the upgrade. Time Travel covers D1;
keep matching R2 objects and private state/keys backed up independently. Its
restore points expire after 30 days on Workers Paid, or 7 days on Free.
[Time Travel documentation](https://developers.cloudflare.com/d1/reference/time-travel/)
explains retention and recovery. A restore overwrites the live database, so
pause ingress/consumption and review the matching snapshot before using it.

Candidates before `v0.1.0-rc.3` use the unsupported SQL export prerequisite.
If their upgrade command stops there, preserve `.local/` and private resource
state, fetch the published compatible release, switch to it in a clean checkout
and run `pnpm run setup`. This resumes the saved instance with its original
resources and keys. Future upgrades use the restore-point path above.

Starting with `v0.1.0-rc.4`, the remembered mailbox is bound to the signed-in
user. An older selection without an owner marker is cleared once; reconnect
if the first offline launch has no mailbox selected. Stored mail is unaffected,
and subsequent offline launches retain the same user's selection.

Database migrations may not be backward compatible: take a matched backup first. A
source rollback does not undo a database migration. Restore a matched snapshot
when a previous release requires the previous schema.

## Prepare production accounts

After successful pilot delivery and a matched backup, run
`pnpm run setup -- --prepare-apex` from the saved instance checkout. Required
pilot doctor checks must pass first. The installer records the complete zone
DNS, including existing record IDs, content, priorities and TTLs, in a protected
`.local/before-apex-preparation-*.json` file. It retains the primary pilot domain,
manual routing, resource names and encryption keys. A rerun reuses this snapshot;
missing or changed evidence blocks preparation instead of overwriting it.
Take another fresh snapshot immediately before a future cutover: this account
preparation snapshot may become stale.

Open **Admin → Organizations → Add organization → Prepare accounts** for the
selected apex. This creates a **staged** organization without changing mail DNS,
Routing rules or native sending registrations. A staged Refresh remains
read-only. Existing pilot accounts and delivery stay active.

Add each separate-login owner under the staged organization's **Members** tab,
providing the assigned local part and an external recovery address. Invitations
come from the active pilot domain; each owner chooses a password, verifies their
external recovery address and optionally enrolls MFA/passkeys. Administrators
still require TOTP. Invitation/reset links are single-use and expire after ten
minutes. Public registration is disabled.

Staged accounts can sign in and save drafts. Sending is rejected before enqueue
and a rejected draft stays editable; mail still reaches the old receiving
provider. Recipient rules are deferred until reviewed mail activation. Confirm
that every required production recipient has a working login and verified
external recovery before cutover. Keep the old receiver available for at least
seven days afterward and retain it for historical messages.

Preparation does not replace existing MX or merge SPF, and the web activation
guard continues to refuse conflicting old-provider records. Do not edit the
saved primary domain, delete Google records, or mark an organization active to
bypass this guard. Use the migration command below for the reviewed cutover;
see [the first deployment](KIENG-PILOT.md) for deployment-specific evidence.

If provisioning reports that an account exists but invitation delivery failed,
use **Forgot password** for that domain login after repairing its mailbox or
sending path. Repeating installer setup does not recreate users or resend links.

## Migrate the prepared apex

Every required mailbox owner must choose a password, verify their external
recovery address and reach Inbox before migration. Global administrators and
organization owners/admins must enroll authenticator TOTP and retain their backup
codes. Confirm all receiving addresses and aliases
exist in the prepared organization. Run pilot send/receive tests first, then make
a fresh matched backup of D1, the complete R2 bucket, private instance state and
keys. The migration's DNS snapshot and D1 restore point supplement that backup;
they do not replace an independent R2 copy or private-state/key backup.

From the saved instance checkout, create a read-only plan:

```sh
pnpm run migrate -- plan
```

Review the displayed recipients, old-provider DNS and proposed changes. Keep the
printed plan basename and digest. Private migration artifacts stay under
`.local/`; they can contain personal addresses and must not be committed or
published. Planning does not replace MX, create sending registrations or activate
the organization. If account setup, permissions or provider configuration changes
after planning, generate a fresh plan instead of modifying the saved plan.

Apply that exact reviewed plan, replacing `PLAN_BASENAME` and `PLAN_DIGEST` with
the values printed by the plan command:

```sh
pnpm run migrate -- apply --plan "PLAN_BASENAME" --confirm "PLAN_DIGEST"
```

The controlled cutover saves private-state/key and D1 Time Travel recovery
records, provisions native apex sending and its DNS, installs exact mailbox/alias
rules pointing to the existing inbound Worker, deploys the exact migrated scope
and activates the prepared organization. It waits for the inbound domain cache
to expire, then replaces old-provider apex MX with Cloudflare's supplied MX and
merges authorizations into one SPF record. Existing sender SPF includes remain,
with a conservative check of the ten DNS lookup budget. The native DKIM public
key is generated by Cloudflare at registration and sealed in the journal;
unexpected DNS names, values or occupied selectors stop the cutover before MX.
An existing DMARC policy is preserved; a new manually provisioned policy starts
at monitoring (`p=none`). The primary pilot domain, manual routing, resource
IDs, encryption keys and stored mail are retained. It does not attach a catch-all or enable
zone-wide plus addressing. Public web activation still cannot take over a staged
domain. Do not change mail DNS, routing rules, owner permissions or infrastructure
from another session during the cutover. Cloudflare DNS batches use one database
transaction but propagation is not atomic. The API has no conditional DNS batch
update, so the installer detects drift before writes and checks actual outcomes;
operator changes between those checks must be resolved through the journal.
See [Cloudflare batch behavior](https://developers.cloudflare.com/dns/manage-dns-records/how-to/batch-record-changes/).

If execution stops, preserve `.local/` and rerun the same apply command. Inspect
its saved progress before retrying; do not hand-edit MX, lifecycle status, private
state or keys to skip a failed step:

```sh
pnpm run migrate -- status --plan "PLAN_BASENAME"
pnpm run doctor
```

Doctor checks the pilot and migrated apex separately. A migrated apex requires
ready Email Routing, enabled literal recipient routes, the exact native sending
identity and mail DNS; it does not require a catch-all. Doctor checks route
consistency and reports the need to compare every provisioned recipient. Migration
status performs its fresh recipient readiness checks. Neither command proves
real mail delivery or sends a test message.

Test every production mailbox and alias from an external inbox, reply with a
small attachment, check Sent and inspect SPF, DKIM and DMARC results. Keep Google
or the previous provider's receiver service available for at least seven days,
and check both inboxes during propagation. Keeping the services active does not
provide duplicate delivery: a sender's cached MX determines which provider
receives its message. Keep an independent historical archive when importing
mail with [the Gmail import workflow](GMAIL-IMPORT.md). This client does not
expose IMAP in v1.

### Retained Google Workspace routing

Before accepting a Google migration, test replies from Gmail and retained
Workspace accounts as well as another provider. Public MX and doctor checks do
not inspect Google's internal delivery configuration. A retained Gmail service
can still deliver internally or apply an old route despite the new public MX;
a missing reply or delivery-loop bounce needs transport evidence before a fix.

In **Google Admin console → Apps → Google Workspace → Gmail**, inspect enabled
**Routing**, **Default routing**, recipient address maps, and the affected users'
aliases and groups. Include inherited organizational-unit settings. Record the
old settings and rollback steps privately before editing. Resolve conflicting
rules rather than adding an overlapping rule: higher-priority settings can
override the intended route. See [Google routing settings](https://knowledge.workspace.google.com/admin/gmail/advanced/add-gmail-routing-settings)
and [Default routing](https://knowledge.workspace.google.com/admin/gmail/advanced/set-up-default-routing-for-your-organization).

If this inspection establishes that Google must hand off migrated recipients,
use an exact envelope-recipient filter for those addresses only, with the
appropriate message/account scope. Under **Gmail → Hosts → Add Route**, use a
Cloudflare receiving MX hostname from the domain's current required routing DNS,
port **25**, and leave **Perform MX lookup on host** unchecked for that direct
server hostname. Keep TLS, CA-signed certificate and hostname validation enabled,
and pass **Test TLS connection** before saving. Use **Modify message → Change
the route** to select the reviewed host route; preserve the envelope recipient.
Do not redirect an address to itself or add it as an additional recipient.
Do not point the route at the application hostname or back to Google.
See [Google mail hosts](https://knowledge.workspace.google.com/admin/gmail/advanced/add-mail-servers-for-gmail-email-routing)
and [Cloudflare receiving DNS](https://developers.cloudflare.com/email-service/configuration/domains/#routing-records).

Check received-header hops, timestamps, rejecting server and DSN status codes
privately, together with Cloudflare routing events and inbound receipt counts.
Do not publish mail bodies, full headers, credentials or recovery links. Retest
each migrated recipient after propagation; this procedure is not proof that an
uninspected loop has been fixed. Keep the old service and historical mail as
described above. Google administration remains an owner task; the installer does
not request Google credentials or change Workspace settings.

## Roll back a migration

Use the original reviewed plan and digest to restore its recorded old-provider
mail DNS:

```sh
pnpm run migrate -- rollback --plan "PLAN_BASENAME" --confirm "PLAN_DIGEST"
pnpm run migrate -- status --plan "PLAN_BASENAME"
```

Rollback preserves stored messages, storage resources and keys. It keeps the
Cloudflare receiver and exact recipient routes available so messages sent using
cached Cloudflare MX can still arrive. Check both providers during this drain;
do not disable or delete the Cloudflare receiver immediately. The organization
and migrated binding remain available for those delayed messages.
Outgoing mail can also remain available while replies follow restored
old-provider MX. Inspect both inboxes and coordinate senders during rollback.
The installer unlocks managed routing records using PATCH without disabling
zone routing. It never invokes routing DNS DELETE, which could damage the pilot.

Doctor will correctly report that migrated apex MX is no longer exclusively
Cloudflare after rollback; the migration status explains the draining state.
That expected DNS failure does not imply stored mail was lost. Continue checking
the pilot and both receiving services. Before trying the cutover again, fix the
cause and create a new plan against the current provider state. Do not reuse the
rolled-back plan as a new migration or recreate resources to clear its journal.

## Failed inbound mail

Raw mail is encrypted and stored before enqueueing. Durable receipts identify
content and normalized recipient, track attempts, and allow cron recovery after
enqueue or processing failure. Exhausted jobs stay preserved. The superadmin
**Inbound recovery** page (`/admin/inbound`) lists failed jobs and replays them
after the underlying problem is fixed. The inbound dead-letter queue remains
available for inspection. Do not delete raw objects or receipts to clear errors.

## Troubleshooting

* **403 from Cloudflare:** add the exact scope reported by doctor to the scoped
  deployment/runtime token, restrict it to the chosen account and zone, then rerun.
* **Sending unavailable:** activate Email Service sending and Workers Paid in
  the selected account; verify the exact sending domain and its DNS records.
* **Pilot receives nothing:** publish subdomain MX/SPF and an enabled literal
  recipient rule pointing to the instance's inbound Worker. A zone catch-all
  alone does not receive subdomain mailboxes.
* **Authentication loops:** the deployed origin must match `ORIGINS`; use the
  domain login address and complete TOTP and external recovery verification.
* **Emergency administrator recovery:** `pnpm --filter doota run reset-admin`
  accepts an existing superadmin only. Use the masked password prompt. It
  revokes database and KV sessions; an already issued cached session cookie
  can still authorize for up to five minutes after KV propagation. If recovery
  reports partial revocation, preserve its private `.local/` journal and rerun
  the same recovery operation to finish deleting cached sessions.
* **Interrupted setup:** rerun setup from the same checkout. Preserve `.local/`
  and the infrastructure state. Review stale locks before removing them.
* **Oversized send:** the outgoing limit is 5 MiB for the complete MIME message,
  including base64 attachments and headers. Reduce attachments and resend the
  retained draft. The inbound limit is 25 MiB.

## Real mail acceptance

Use a mailbox on the selected pilot domain. Send to an external inbox, reply
back, and inspect SPF/DKIM/DMARC results. Verify attachments, aliases, sent mail,
trash/restore and independent member access. Confirm apex mail still arrives
at the previous provider. Record timestamps and message IDs without publishing
mail bodies or recovery links. Local tests do not prove real delivery.
