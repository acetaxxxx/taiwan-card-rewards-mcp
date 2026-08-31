# taiwan-card-rewards-mcp Skill/Agent binding plan

This is a planning contract only; it is not an installed Aion Skill.

The eventual Skill may route card registration, public-offer refresh,
recommendation, actual transaction/refund recording, and remaining-cap queries
to the independently released `taiwan-card-rewards-mcp`. It must not store
cards or ledger truth, calculate rewards, accept `user_id`/`data-dir`, or handle
PAN, CVV/CVC, OTP, cookies, credentials, or session tokens.

Aion's trusted parent starts one fixed-version stdio MCP process per user with
an absolute existing canonical `--data-dir`; the model and Skill cannot change
that scope. The Skill asks for merchant/MCC, country, channel, payment method,
amount/currency, date, and planned/actual intent, then displays source URL,
fetched time, rule version, cap period/usage, FX snapshot, and any
`unknown`/`stale`/`needs_review` result. Uncertain results are never promoted
to recommendations; missing facts are questions. Actual writes require
idempotency and refunds require recorded-transaction linkage.

Production descriptors pin an immutable package version; they never use
`latest` or model-provided paths. See the repository-boundary contract in
`aion-self-host/docs/specs/taiwan-card-rewards-mcp-repository.md`.
