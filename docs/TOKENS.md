# Cloudflare credentials

Select the Cloudflare account containing your domain. Check **Manage Account >
Billing > Subscriptions** for Workers Paid; the account plan starts at $5/month.
The domain's Cloudflare DNS plan can remain Free. See
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

Activate R2 under **Storage & databases > R2 > Overview** and complete the
account checkout. This enables the storage API; the installer creates the mail
bucket. R2 includes free monthly usage and bills usage beyond its allowances.
See [R2 activation](https://developers.cloudflare.com/r2/get-started/) and
[pricing](https://developers.cloudflare.com/r2/pricing/).

Open **Compute > Email Service > Email Sending** and complete any account
activation requested. Leave domain onboarding to the installer and web wizard,
especially when another provider receives apex mail. See
[Email Sending setup](https://developers.cloudflare.com/email-service/get-started/send-emails/).

## Create two user API tokens

Open [My Profile > API Tokens](https://dash.cloudflare.com/profile/api-tokens),
then **Create Token > Create Custom Token**. Use the following permissions;
Cloudflare may label write access `Write` instead of `Edit`.

| Token | Account permissions | Zone permissions |
| --- | --- | --- |
| Deployment | Account Settings Read; Workers Scripts, D1, Workers KV Storage, Workers R2 Storage, Queues and Secrets Store Edit | Zone Read, DNS Edit, Workers Routes Edit |
| Runtime | Account Settings Read; Email Sending Edit | Zone Read, DNS Edit, Zone Settings Edit, Email Routing Rules Edit |

Routing settings use **Zone > Zone Settings > Edit** (or `Write`), not a
permission named "Email Routing Settings". See the
[routing settings API](https://developers.cloudflare.com/api/resources/email_routing/methods/edit/).

Restrict **Account Resources** to your selected account and **Zone Resources**
to **Specific zone > your domain**. Do not select all accounts or all zones.
For sending, choose **Account > Email Sending > Edit/Write**, scoped to the
selected account. If it is absent despite Workers Paid and an accessible
Email Sending page, check account membership permissions; do not substitute a
Global API Key. Native email sending is in public beta.

Select **Continue to summary**, review the resource limits, and select
**Create Token**. The secret is shown once. Keep it private and provide each
secret to the installer's masked prompt. The deployment credential is used by
the launcher; only the separate runtime credential is bound into the app.
See [Cloudflare's token guide](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/).

## Save tokens for this assisted deployment

If an assistant has requested a local credential handoff, open
`.local/credentials.json` inside your checkout in your editor. Fill in the two
secrets, keeping the quotation marks:

```json
{"deployToken":"YOUR_DEPLOYMENT_TOKEN","runtimeToken":"YOUR_RUNTIME_TOKEN"}
```

Save the file, then reply `ready` and say whether Workers Paid and Email Sending
activation are complete. Do not paste either token into chat. This handoff file
is for the assisted deployment; the public installer accepts masked prompts or
the `CLOUDFLARE_API_TOKEN` and `APP_CLOUDFLARE_API_TOKEN` environment variables.

The installer stores private state in ignored `.local/` files. On Windows,
use a directory whose filesystem ACL permits your user, SYSTEM and trusted
administrators only. Git ignore rules do not restrict local filesystem access.
Rerun setup after fixing permission or account-activation errors. Never use a
Global API Key or place credentials in a commit, issue, screenshot or chat.
