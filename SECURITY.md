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
