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
an upgrade. Use Cloudflare D1 exports/Time Travel and authenticated R2 object
copies; record the snapshot time, resource IDs, release and key fingerprint.

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
Database migrations may not be backward compatible: take a backup first. A
source rollback does not undo a database migration. Restore a matched snapshot
when a previous release requires the previous schema.

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
