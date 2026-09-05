# ADR 0006: Multi-component reward ledger, per-component refunds, and cap-pool attribution

**Status**: Accepted (Amended)
**Version**: 0.6.0 Target
**Conforms to**: [`CONTEXT.md`](../../CONTEXT.md), ADR 0001, ADR 0003, ADR 0004, ADR 0005

---

## Context

Under ADR 0005 (Payment Route Opportunity Stacking) and Schema v2, a single purchase may trigger multiple independent Reward Components (e.g., merchant loyalty points, payment wallet promotions, and card issuer cashback).

The legacy v0.4.0/v0.5.0 ledger stored a single `ruleId` and a scalar reward per transaction. This structure cannot:
1. Accurately attribute and reconcile cap consumption across multiple independent `CapPoolDefinition`s referenced by different applied rules.
2. Store heterogeneous native reward units (e.g., TWD minor cash, LINE POINTS, 小樹點, airline miles) earned in a single transaction without lossy or unverified conversions.
3. Support accurate, auditable partial and full refunds that proportionally reverse each component's reward and restore its corresponding cap pool consumption.

## Decision

1. **Independent `rewardComponents` Collection & Composite Identity**:
   - Store actual applied reward components as a dedicated top-level collection in durable storage (`StoredState.rewardComponents`).
   - The logical identity of each component is the composite tuple `(transactionId, ruleId, ruleVersion)`.
   - The primary key `componentId` is generated using a collision-safe canonical encoding: `${encodeURIComponent(transactionId)}:${encodeURIComponent(ruleId)}:${encodeURIComponent(ruleVersion)}`.
   - `transactionId` is the durable persisted transaction identity (immutable across retries, matching `idempotencyKey` for actual transactions).
2. **Cardinality Invariant (`(transactionId, ruleId) <= 1`)**:
   - For any given transaction, at most ONE actual applied `RewardComponent` is permitted per `ruleId`.
   - If multiple rule versions or conflicting rule evaluations attempt to produce more than one component for the same `(transactionId, ruleId)`, the evaluator and ledger MUST fail closed (`needs_review`).
3. **Accounting Boundary**:
   - Only *actually applied rules* are recorded into `rewardComponents` and consume ledger caps.
   - Matched candidate rules that were excluded by combination policies (e.g., lower-priority `replace` or non-winning `best_of` alternatives) remain strictly in ephemeral calculation traces.
4. **Component State**:
   - Each `RewardComponent` immutably captures `componentId`, `transactionId`, `ruleId`, `ruleVersion`, `route`/`provider` (per ADR 0005), native `reward` (`value`, `unitType`, `unitName`, `currency`), and atomic `capUsages` (`poolId`, `periodKey`, `metric`, `consumedAmount`).
5. **No Forced Summation**:
   - Reward amounts in differing native units or currencies are never forcefully collapsed into a single scalar value without explicit valuation snapshots.
6. **Snapshot-Based Proportional Refunds**:
   - Partial refunds reverse each component strictly proportional to the original transaction snapshot, using deterministic integer floor rounding, with exact remainder adjustment applied on the final refund step.
   - Past transactions are never re-evaluated against present-day rules, preserving idempotency.
7. **Shared Cap Pool Deduplication**:
   - Cap pools are aggregated by `(poolId, periodKey)`.
   - For `spend` and `transaction_count` metrics, a single transaction consumes the shared pool exactly once across co-applied rules.
8. **Atomic Persistence & Referential Integrity**:
   - Transactions and their associated `rewardComponents` are written atomically with full referential integrity.
9. **Legacy Compatibility & Fail-Closed Behavior**:
   - Legacy records with single `ruleId` remain readable; operations requiring granular component breakdowns on legacy records fail closed (`needs_review`).

## Consequences

- Enables complete, auditable multi-layer stacking across merchant apps, digital wallets, and credit cards (aligning with `CONTEXT.md` Reward Component definitions and ADR 0005).
- Guarantees exact, non-drifting cap restoration upon repeated and partial refunds.
- Eliminates delimiter collision risk in composite component IDs while enforcing strict rule cardinality per transaction.
- Preserves pure calculation determinism and zero-guessing currency boundaries.
