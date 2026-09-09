# ADR 0008: Event-scoped reward evaluation and cross-event eligibility

**Status**: Proposed

**Date**: 2026-09-07

**Scope**: top-up and purchase facts, wallet-funded purchases, multi-event campaigns, reward issuance/redemption, and future reward-ledger evolution.

## Context

An ordered payment route describes how one payment event reaches a merchant or moves value between accounts. It does not, by itself, describe the earlier event that funded a stored-value balance, the later event that spends that balance, or the campaign state created by a sequence of events.

The distinction matters for routes such as a bank account → wallet top-up → two later wallet purchases. It also matters when a payment brand performs an internal top-up before settling an order, or when a campaign issues a coupon after a threshold and only turns that coupon into wallet value after a later qualifying purchase.

The current runtime evaluates one card-oriented purchase or refund at a time. `TransactionKind` has no top-up kind, `OfferRuleVersion.cardId` is required, and recording requires a held card. Route records also do not yet carry typed transitions or cross-event relations. Therefore this ADR describes the target domain boundary; it does not claim current runtime support.

## Decision

Adopt event-scoped evaluation as the target model, with the following rules.

1. **Every monetary event has its own identity and lifecycle.**

   A top-up event moves value into a stored-value balance. A purchase event exchanges value for goods or services and has its own merchant, amount, currency, timestamp, and payment route. A refund or reversal references the event it changes. Reward issuance and reward redemption are separate benefit events when an offer uses a coupon, delayed credit, or other intermediate instrument.

2. **Evaluate event-local offers against that event's facts.**

   A top-up offer may match the funding account, destination wallet, amount, period, and top-up method. A purchase offer may match the acceptance network, payment service, terminal funding fact, merchant, currency, and route transitions. A purchase evaluation must not re-emit a reward that was already issued for an earlier top-up.

3. **Represent cross-event campaigns explicitly.**

   A campaign such as “top up from the specified account, then purchase within 30 days” is a `Cross-Event Eligibility` condition. Its qualification must be derived from evidenced events, their ordering or causal relation, validity windows, consumption count, and reversal state. It is not a permanent boolean and is not satisfied by merely seeing the same wallet brand on two transactions.

4. **Do not infer fungible-balance provenance.**

   Wallet balances can combine funds from multiple sources, refunds, transfers, and rewards. The system must not silently apply FIFO, LIFO, or an invented source allocation. If an official offer requires proving that a later spend used a particular funding lot, the required allocation or provider evidence must be present; otherwise that component is `unknown`/`needs_review`.

5. **Keep route compatibility separate from reward combination.**

   A route selector answers whether an event's observed topology and transitions fit a route condition. A combination policy answers whether matched reward components are additive, replacing, best-of, exclusive, or prerequisite. No blanket “more specific wins,” “same owner is always exclusive,” or “different owners always stack” rule is allowed to replace the published policy.

6. **Make idempotency and caps event-aware.**

   A durable reward application is keyed by the event identity, rule version, and component identity. Replaying an event returns the prior result. Cap pools may be independent or shared only when the offer terms say so. A refund or reversal applies the original component and cap context; it does not automatically reverse an unrelated earlier top-up reward unless the campaign explicitly links them.

7. **Fail closed on evidence state.**

   `unknown` means a fact that affects the decision is missing, stale, contradictory, or unverified. `no_match` means the required facts are sufficiently known and contradict the rule. An unverified outbound route must not produce a calculated reward merely because a similarly named inbound or partner route exists.

## Canonical evaluation sequence

```text
normalize event facts
  → validate route and evidence for this event
  → evaluate event-local offers
  → derive any cross-event eligibility from prior evidenced events
  → apply explicit combination policy and cap pools
  → record each reward component idempotently
  → process later issue, redemption, refund, or reversal events separately
```

For the paper example:

```text
E1: bank account → wallet top-up 1,000
E2: wallet balance → merchant purchase 400
E3: wallet balance → merchant purchase 600
```

If the hypothetical top-up reward is 1% and each purchase reward is 2%, the lifecycle result is 10 + 8 + 12 = 30. The new reward for E3 is 12, not 22 or 30. If a campaign also requires E1 before E2/E3, that prerequisite is evaluated as a separate cross-event condition and consumed according to its campaign terms.

## Consequences

- A single reusable evaluator can handle direct card payment, account debit, wallet top-up, wallet settlement, cash payment, and multi-hop routes by varying event facts and selectors.
- Recommendation can explain whether a reward belongs to the current payment, a prior funding event, or a later redemption event.
- The ledger can prevent duplicate top-up rewards while retaining independent purchase rewards.
- Exact source-provenance campaigns require richer provider evidence or explicit allocation; generic wallet spending remains usable without pretending to know which deposit was spent.
- The current runtime needs a later migration: non-card event kinds, typed route transitions, event relations, event-aware caps, non-card offer ownership, and service/ledger support beyond mandatory `cardId`.

## Alternatives considered

### One flattened payment route per complete lifecycle

Rejected. It mixes separate top-up and purchase events, cannot represent time-separated spending or delayed reward redemption cleanly, and encourages double counting.

### Only `money_source + pay_channel`

Useful as a simple display projection, but rejected as the canonical model. It loses intermediate services and typed transitions such as card top-up versus direct card authorization.

### Attribute every wallet spend to a specific deposit automatically

Rejected. Stored-value funds are fungible unless authoritative provider records or an explicitly supported allocation policy prove otherwise.

## Open implementation questions

- Which event kinds and relation types are admitted in the first migration slice?
- Which provider evidence is sufficient to prove a source-specific wallet spend?
- Should delayed coupon issuance and redemption share the payment ledger or a separate benefit ledger linked by event IDs?
- Which existing 15-tool contracts need versioned additions before non-card recording is exposed?
