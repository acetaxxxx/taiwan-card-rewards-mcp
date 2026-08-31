# 06: Record purchases with idempotency and refund reconciliation

**What to build:** Actual purchases update only the user-scoped Reward Ledger exactly once, and linked full, partial, or repeated refunds reverse reward and cap effects without exceeding the original purchase.

**Blocked by:** 01: Establish the LedgerStore persistence seam; 02: Add Predicate AST evaluation and the Calculation Trust Gate

**Status:** ready-for-agent

- [ ] Planned transactions remain side-effect free and actual purchases persist their calculation trace.
- [ ] Reusing an idempotency key with the same payload returns the original result; a different payload is rejected.
- [ ] Refunds require a valid original purchase and matching card/context.
- [ ] Partial and repeated refunds are bounded by the original amount and prior refunds; over-refunds are rejected.
- [ ] Refunds reverse reward and cap usage using the original rule version, cycle, currency, and accounting context.
- [ ] Tests cover retries, conflicts, missing originals, wrong cards, partial/repeated refunds, and over-refunds.
