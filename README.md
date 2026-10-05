# cloudflare-mail-client

A self-hosted domain email client on Cloudflare. Deploy your own Workers,
mailboxes and storage with a guided installer. Forked from
[Doota](https://github.com/etherCorps/doota) at
`100c1629fa5bce002653d019b2c95dfae54f942f`; Apache-2.0 licensed.

**The software is free. Native Cloudflare sending is not a free hosting plan.**
It requires Workers Paid, starting at **$5/month**, with **3,000 outgoing emails
included each month**, then **$0.35 per 1,000**. Worker, storage and other usage
can add charges. Cloudflare account eligibility and Email Service activation
are required. See [Email pricing](https://developers.cloudflare.com/email-service/platform/pricing/)
and [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).
You also need a domain you own, with an active Cloudflare DNS zone.

This repository is an initial release candidate. Local verification and live
mail acceptance are separate; see [verification](docs/VERIFICATION.md).

## Install

Install **Node 24**, **pnpm 10** and Git, then run in Terminal or PowerShell:

```sh
git clone https://github.com/longmaba/cloudflare-mail-client.git
cd cloudflare-mail-client
pnpm run setup
```

The installer uses Node APIs on Windows, macOS and Linux. It installs the
existing locked dependencies, selects your account and active zone, inspects
existing mail DNS, generates stable secrets, provisions three Workers and
shared storage/queues, applies migrations, then opens protected administrator
setup. No source edits or manual infrastructure creation are required.

If another provider receives apex mail, setup selects a pilot subdomain first.
The web administrator activates the selected domain and its literal recipient
rules. Existing apex MX stays in place during pilot testing. Keep the private
`.local/` directory and Alchemy state: reruns reuse the same resources and keys.
Do not copy an instance's state into another account.

```sh
pnpm run doctor
pnpm run upgrade
```

Doctor reports missing permissions, bindings, ownership, mail DNS and routing.
Upgrade selects a published tag, preserves instance resources/secrets and runs
the same build/deploy path. Take a matched backup before schema migrations.
Cloudflare's deploy button does not support this three-Worker deployment:
[deployment limitations](https://developers.cloudflare.com/workers/platform/deploy-buttons/).

## Credentials and activation

Enable Workers Paid and Email Service sending for your account before testing
outbound mail. Also activate an R2 subscription under **Storage & databases >
R2 > Overview**; the installer creates the bucket afterward. R2 includes free
monthly usage and bills usage above its allowances. See
[R2 activation](https://developers.cloudflare.com/r2/get-started/) and
[R2 pricing](https://developers.cloudflare.com/r2/pricing/).
Sign in with Wrangler or provide a scoped deployment API token.
The installer also requires a **separate runtime token** for the selected zone.
Never use a Global API Key or bind the broad deployment token into the app.

| Credential | Required permissions and resource scope |
| --- | --- |
| Deployment | Account Settings Read; Workers Scripts, D1, Workers KV Storage, Workers R2 Storage, Queues and Secrets Store Edit for the selected account; Zone Read, DNS Edit and Workers Routes Edit for the selected zone |
| Runtime | Account Settings Read and Email Sending Edit for the selected account; Zone Read, DNS Edit, Zone Settings Edit and Email Routing Rules Edit for the selected zone |

Create tokens at Cloudflare **My Profile > API Tokens > Create Custom Token**.
Use the permissions shown by the installer and doctor; Cloudflare's permission
labels can vary as products change. Restrict each token to the selected account
and zone. Secrets are entered with a masked prompt and kept out of Git. On
Windows keep the checkout under a filesystem ACL limited to your user. Rerun
setup after fixing a scope or activation error.
Follow the [dashboard walkthrough](docs/TOKENS.md) for token creation and account activation.

## Mail client

* Responsive Inbox, Sent, Drafts, Archive, search, Trash/restore, replies,
  attachments and mailbox aliases inherited from Doota.
* Administrator-created domain/password accounts; public registration disabled.
* Single-use, ten-minute setup/reset links sent to external recovery addresses.
  Passwords never appear in invitation emails or URLs.
* Mandatory administrator TOTP; optional member MFA and passkeys.
* Member mailbox isolation for messages, search, attachments and sender identities.
  Instance administrators remain trusted operators.
* Native sending preflight checks the full MIME message against the **5 MiB**
  limit, including attachment encoding. Inbound limit: **25 MiB**.
* Encrypted raw-mail persistence, content-derived identity, per-recipient
  deduplication, durable retry receipts, cron recovery and an operator replay page.
* Explicit literal routing rules for pilot mailboxes and aliases. Subdomain
  delivery needs these rules; an apex catch-all alone is insufficient.
  [Subdomain rules](https://developers.cloudflare.com/email-service/configuration/subdomains/).

This v1 deployment supports the web client. Historical mailbox import and
IMAP/native desktop clients are outside v1. Bulk marketing is excluded; follow
Cloudflare's [transactional sending scope](https://developers.cloudflare.com/email-service/reference/faq/).

## Screenshots and operations

[Setup and client screenshots](docs/screenshots.md),
[backup, restore, upgrade and troubleshooting](docs/OPERATIONS.md),
[first pilot deployment and DNS rollback](docs/KIENG-PILOT.md),
[upstream attribution](docs/UPSTREAM.md) and [security reporting](SECURITY.md).

## Development

```sh
pnpm install --frozen-lockfile
# Copy apps/web/.env.example to apps/web/.env for local development.
pnpm --filter doota gen
pnpm run check
pnpm run test:installer
pnpm test
pnpm run build
pnpm -C infra install --frozen-lockfile
pnpm -C infra run check
```

No new runtime dependencies are needed for the launcher. Workspace package
names remain `@doota/*`. See [CONTRIBUTING.md](CONTRIBUTING.md) for changes and
release checks. The CI matrix runs installer tests, checks, tests and builds on
Windows, macOS and Linux. A green local build is not proof of Cloudflare sending
activation, independent account installation or real delivery.
