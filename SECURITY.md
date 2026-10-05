# Security reporting

Report vulnerabilities privately using GitHub's **Report a vulnerability** tab
in this repository. Do not publish mailbox contents, credentials, recovery links,
or encryption keys in an issue. Include the affected release, a minimal
reproduction, and the impact. Keep security fixes coordinated until a patched
release is available.

Only the latest tagged release receives fixes. Administrators are trusted
operators: they control the Workers, database, storage and encryption keys.
Member isolation does not protect mail from the instance owner. Treat `.local/`
and Alchemy state as sensitive. Back up stable encryption keys separately from
the stored mail; losing them makes encrypted messages unreadable.

Raw R2 mail and D1 content columns are encrypted. Doota's current FTS5 search
index stores readable subjects and message text in D1 so it can rank full-text
results. Mailbox authorization scopes searches, but the index is visible to
trusted database operators and is included in database backups.
