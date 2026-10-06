# Import Gmail history

Each mailbox owner imports into their own signed-in mailbox at **Account →
Mail → Your data → Import mail**. A shared mailbox requires its manager's grant.
Import processing does not send messages, auto-replies or historical-mail
notifications, and does not alter DNS or Google's retained receiver.

1. Sign into the old Google account and open [Google Takeout](https://takeout.google.com/).
   Deselect the other products, select **Mail**, and include all required labels.
   Request a one-time ZIP export. Download every archive part when it is ready.
   Workspace administrators can restrict exports.
2. Extract the ZIP files locally. Keep an independent copy of the original
   download. Choose the extracted `.mbox` file in this client's import control;
   uploading a ZIP directly is unsupported. An individual `.eml` is also supported.
3. Start with a small export or individual message. Wait for **Done**, then check
   Inbox, Sent, a custom label, read/starred state and an attachment download.
   Import the remaining files into the same mailbox after that check.
4. Compare the imported and duplicate counts against your export. A failed import
   is incomplete: fix a storage or permission problem and use **Retry**. For an
   invalid or oversized source message, cancel and start a corrected archive.
   Keep Google and the original export until the imported history has been checked.

Google's export includes messages and attachments. Its `X-Gmail-Labels` header
carries Gmail label metadata. See [Google's export instructions](https://support.google.com/accounts/answer/3024190)
and [the Gmail export reference](https://support.google.com/mail/answer/10016932).

## What is preserved

* Raw MIME, text/HTML bodies, file attachments and embedded images, encrypted in R2.
* Message dates, sender display names, From, To, Cc, Reply-To and reply ancestry.
* Gmail Inbox, Sent, Spam and Trash placement; archive placement when no Inbox
  label applies; custom labels and an additional dated Imported label.
* Gmail unread and starred flags. Imported read flags seed the mailbox until its
  owner explicitly reads or marks the thread unread.
* Sent messages as historical sender copies. They are never sent again.

Folder placement and starring are thread-wide in this client. A mixed Gmail
conversation therefore cannot have separate placements for its individual
messages. Imports preserve existing user placement and snoozing on conversations
already in the client. Gmail drafts are historical mail, not editable compose
drafts. Filters, contacts, signatures, scheduled sending, Gmail account settings
and Google chat data are not recreated.

## Limits and interrupted imports

An individual raw MIME message must be **25 MiB or less**, including base64
attachment encoding and headers. This is separate from the client's 5 MiB
outgoing-message limit. Large attachments can exceed the import limit after
encoding. An oversized message stops the import with an actionable error rather
than being silently discarded. Retain the original, cancel the failed import,
and start a new archive that excludes the oversized message. Archive that
message outside the client; Retry cannot change the immutable source file.

The archive uploads in encrypted 8 MiB parts; the browser and Worker do not load
the entire archive into memory. There is no need to send Gmail credentials to
the installer. R2 storage, D1 writes and queue operations still count toward the
instance's Cloudflare usage.

For an interrupted upload, choose **Resume** and select the same extracted file
with the same name and byte size. Already uploaded parts are checked against
the file; different bytes are rejected. Resume rechecks earlier chunks before
uploading the remainder. Do not modify an archive while it is uploading.

Queue retries checkpoint each message and use content-derived storage identity
scoped to the destination mailbox. Repeated processing of identical message
bytes does not duplicate messages or invalidate successful attachment links.
Messages without a Message-ID receive a deterministic import ID. An imported
header cannot select another mailbox's private message or conversation.

Failed processing retains staged data and its checkpoint for retry. **Cancel**
stops further processing and does not delete already imported mail. Keep backups
of encryption keys and raw objects as described in [operations](OPERATIONS.md).
