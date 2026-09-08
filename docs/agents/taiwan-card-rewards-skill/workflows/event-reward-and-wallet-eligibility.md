# Event Reward and Wallet Eligibility Workflow

This workflow tells an Agent how to turn an evidenced payment route into
event-scoped MCP calls. It complements the payment-route workflow; it does not
replace official-source research.

## Boundary

The Agent/UI retrieves and interprets bank pages, PDFs, screenshots, and OCR.
The stdio MCP does not browse, call bank APIs, or discover hidden wallet
funding. The MCP validates the structured facts supplied by the Agent and owns
matching, idempotency, caps, stacking, and ledger writes.

## Required facts before writing

Collect, or explicitly mark unknown:

- event kind: `top_up`, `purchase`, `refund`, or `reversal`;
- direction and provider/app, including inbound versus outbound route;
- merchant and channel/payment method;
- funding kind/subtype, such as `credit_card`, `linked_bank_account`, or
  `wallet_balance`;
- amount, currency, event time, and official source/evidence identity;
- explicit event relation when one event funds another.

Never infer issuer rewards from a wallet purchase merely because a card was
used earlier. A missing or ambiguous fact is not a zero reward.

## MCP sequence

1. `list_payment_routes` to inspect known routes.
2. `upsert_payment_route` only for a confirmed or clearly labelled candidate
   route; store no credentials.
3. `upsert_offer` only after the Agent has supplied the official snapshot and,
   when activation is required, user confirmation.
4. For a planned action, call `recommendation_preflight` and/or `recommend`.
5. For an actual event, call `record_event_reward_v2`. Provide exactly one of
   `eventRule` or `chainRule`. A chain requires bounded `sourceEvents` and one
   explicit `funded_by` relation.
6. For a refund/reversal, call `reverse_event_reward_v1` with exactly one
   validated refund relation to the original event.

`record_event_reward_v1` is retained for already validated internal callers.
An interactive Agent should prefer v2 because the server recomputes event
eligibility instead of trusting a caller-provided eligibility status.

## Scenario: bank account → wallet top-up → wallet purchase

Represent the route as two events:

```text
E1 top_up:
  funding = account / linked_bank_account
  channel = wallet

E2 purchase:
  funding = account / wallet_balance
  relations.funded_by = [E1]
```

The chain rule must identify the source and target event-local facts and a
bounded time window. If E1 is absent, the relation is missing or ambiguous, or
the wallet balance has multiple possible sources, return `unknown` or
`needs_review` and do not write a reward.

## Scenario: PayPay or card-funded wallet

Separate card top-up, wallet settlement, and merchant purchase events. Confirm
whether the route is PayPay inbound TWQR, PayPay outbound top-up, or another
wallet route. These are not interchangeable. A credit-card top-up does not
automatically make the later wallet purchase a credit-card purchase for reward
purposes.

## Result handling

| Result | Agent action |
|---|---|
| `matched`/eligible | Record only through v2 with idempotency and explicit evidence. |
| `no_match` | Explain the proven failed condition. |
| `unknown` | Ask for the missing fact or evidence; do not guess. |
| `needs_review` | Ask the user to resolve ambiguity or stacking policy. |
| stale source | Refresh official evidence before recording. |

The event ledger is user-scoped and durable through the configured data
directory. Reusing an idempotency key with the same payload replays the prior
decision; a conflicting payload fails closed.
