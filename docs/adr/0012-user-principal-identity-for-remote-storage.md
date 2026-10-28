---
status: accepted
---

# Use issuer and subject as the remote User Principal

Remote MCP storage is scoped by the verified `(issuer, subject)` identity pair, because an email address can change or collide and an OAuth client ID identifies an application rather than the person. The pair is hashed for the tenant directory; providers that issue pairwise subjects may therefore give the same person separate ledgers across client applications unless they provide a stable shared subject.
