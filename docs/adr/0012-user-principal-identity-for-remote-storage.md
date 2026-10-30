---
status: accepted
---

# Use issuer and subject as the remote User Principal

Remote MCP storage is scoped by the verified `(issuer, subject)` identity pair, because an email address can change or collide and an OAuth client ID identifies an application rather than the person. The pair is hashed for the tenant directory; providers that issue pairwise subjects may therefore give the same person separate ledgers across client applications unless they provide a stable shared subject.

If a verified subject changes, recovery is an explicit administrator operation: bind the new hashed principal to the existing tenant key and revoke the old principal. Preserve historical `ownerUser` values and idempotency records under that original tenant key; do not rewrite or merge ledger records and do not match users by email. Backups include the principal binding map. A full restore that changes live bindings requires a separate acknowledgement because it may restore access to a previously revoked principal.
