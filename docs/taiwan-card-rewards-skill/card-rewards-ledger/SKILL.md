---
name: card-rewards-ledger
description: Record Taiwan card-rewards transactions, refunds, and event-scoped rewards while preserving idempotency, caps, and evidence requirements.
---

# Taiwan card-rewards ledger

Before constructing an MCP payload, read the shared [`mcp-tools.md`](../references/mcp-tools.md) and [`lifecycle-and-privacy.md`](../references/lifecycle-and-privacy.md). Use this skill for actual transactions, refunds, top-up/purchase event relations, event rewards, reversals, and reward-cap questions.

- For actual transaction and refund behavior, read [`examples/actual-transaction-and-refund.md`](examples/actual-transaction-and-refund.md).
- For event-scoped rewards, wallet top-ups, and reversals, read [`workflows/event-reward-and-wallet-eligibility.md`](workflows/event-reward-and-wallet-eligibility.md).

Use a stable idempotency key for a retry of the same actual write. Keep planned evaluation separate from ledger mutations, and stop when the public contract returns an unresolved status.
