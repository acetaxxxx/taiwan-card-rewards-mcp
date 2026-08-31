# 07: Reconcile billing cycles, currencies, and FX context

**What to build:** Cap usage and reward calculations respect calendar or issuer billing cycles, closing-day/timezone boundaries, native currencies, and versioned FX observations.

**Blocked by:** 01: Establish the LedgerStore persistence seam; 02: Add Predicate AST evaluation and the Calculation Trust Gate; 06: Record purchases with idempotency and refund reconciliation

**Status:** ready-for-agent

- [ ] Calendar-month and billing-cycle caps resolve to the correct period using closing day and timezone.
- [ ] Original, settlement, reward, fee, comparison, and cap currencies remain distinguishable.
- [ ] Cross-currency calculations require a valid FX snapshot containing pair, provider, capture time, and validity policy.
- [ ] Missing or stale FX data fails closed rather than applying a default rate.
- [ ] Purchase usage and refund reversal reconcile correctly across cycle and currency boundaries.
- [ ] Tests cover boundary dates, timezones, cap exhaustion/reset, FX absence/staleness, and conversion consistency.
