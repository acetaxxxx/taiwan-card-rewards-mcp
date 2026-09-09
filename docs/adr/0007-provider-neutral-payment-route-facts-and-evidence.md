# ADR 0007: Provider-neutral payment-route facts, funding rails, and evidence

**Status**: Accepted for the v0.9.x route-binding slice

**Date**: 2026-09-06

**Scope**: `upsert_payment_route`, `list_payment_routes`, transaction route context, route-bound offer rules, and Agent research/preflight.

## Decision

Model a payment route as an ordered, role-labeled route graph plus distinct settlement facts:

1. Route nodes identify the merchant acceptance network, consumer app or wallet, optional interoperability/intermediate service, and funding instrument or account.
2. Route transitions identify how value moves between adjacent nodes, such as direct authorization, account debit, wallet top-up, or wallet settlement.
3. Settlement facts preserve transaction, settlement, and billing currencies; conversion owner and timing; FX snapshot; markup and fees; and DCC choice.

The route graph is necessary because a card used to top up a wallet is not automatically a card-funded merchant purchase. For example, a PayPay acceptance path may involve Taishin Pay+ and then either a Taishin Richart card or a Taishin Jieli Cun account; those are different funding and reward facts even when the acceptance brand and intermediate service are the same. These paths remain candidate routes until current evidence establishes the actual transitions.

The terminal funding instrument remains the stable coarse category `credit_card | account | cash`. Account subtypes are open to the known facts needed by the route, including `linked_bank_account`, `wallet_balance`, and `foreign_currency_account`.

Provider names, app names, payment methods, acceptance networks, and interoperability schemes remain open strings. Adding a provider therefore adds an evidence-backed route and offer rule; it does not require a new MCP tool or a core enum. Stable topology kinds are reserved for calculation semantics, not brand names.

The current 15-tool surface remains the public seam. Route registration uses `upsert_payment_route`; route discovery uses `list_payment_routes`. Reward applicability should be expressed by a reusable `Payment Route Selector` over route roles and transitions: a selector may bind to a funding node, a payment-service node, an acceptance node, one transition, or a complete route pattern. `OfferRuleVersion.routeId` remains a backward-compatible exact constraint for a concrete observed route, but it is not the reusable policy language and must not hide matching semantics inside an opaque ID. Generic rules omit `routeId`.

The simpler `money_source + pay_channel` projection is allowed as an input or display view when a route has only two relevant facts. It is not the canonical domain model because it loses intermediate services and transition semantics.

## Route semantics

### Route-specific offer matching

An offer can bind to one or more route facts without inventing a new combination type:

- a funding selector matches a Richart card or Jieli Cun account;
- a payment-service selector matches Taishin Pay+;
- an acceptance selector matches PayPay acceptance;
- a transition selector distinguishes card authorization, card top-up, account debit, and wallet settlement;
- a complete route selector requires the relevant nodes and transitions together.

All required selector clauses are conjunctive. Unknown or contradictory route facts do not match a constrained selector and are never widened to `any`. This preserves reusable node-level policies while still allowing a genuine PayPay + Taishin Pay+ + Richart-card or PayPay + Taishin Pay+ + Jieli-Cun combination to have its own rule.

These examples are distinct routes, even when they share a merchant QR brand:

| Observed path | Terminal funding | Required interpretation |
|---|---|---|
| PayPay QR → JKO Pay → linked bank/JKO balance | `account` | Wallet/account debit; no issuer-card reward. |
| PayPay QR → JKO Pay → bound credit card | `account(wallet_balance)` after `credit_card_topup` | Not a direct PayPay-to-card rail. JKO’s official FAQ says the card first tops up the JKO account, then the account balance settles the order; JKO account-payment rewards do not apply to this path. Issuer reward remains unknown until the issuer terms match the top-up descriptor. |
| PayPay QR → Taishin Pay+ → Taishin account | `account(linked_bank_account)` | Account route; no credit-card issuer component. |
| PayPay QR → Taishin Pay+ → Taishin credit card | `credit_card` or card-top-up semantics only as the current bank terms define | Record the exact funding fact and current terms. Do not infer ordinary overseas-card treatment merely from the Pay+ or PayPay brand. |
| TWQR acceptance → Taishin Pay+ | account or credit card | TWQR is an acceptance/interoperability standard, not a nested Taiwan Pay application. |

The last two rows are intentionally fact-driven. A route is `candidate` until the funding and settlement semantics are supported by current official evidence and, when user-specific, user confirmation.

## Evidence and fail-closed rules

The Agent owns web retrieval and stores immutable source snapshots/evidence. MCP remains deterministic and zero-network. Each route or layer may refer to evidence that proves:

- merchant acceptance and supported app/wallet;
- funding method and whether the card is direct authorization or wallet top-up;
- transaction/settlement/billing currency and conversion owner/timing;
- fee, markup, DCC choice, and FX rate source;
- reward issuer, eligibility, exclusions, stacking, and cap.

The following are not global defaults:

- a 1.5% foreign transaction fee;
- card issuer reward eligibility for a wallet-bound card;
- a wallet’s supported cards or foreign-currency accounts;
- a merchant QR brand implying every partner wallet/funding source;
- a route layer implying that rewards stack.

When any required fact is absent, stale, contradictory, or outside its validity window, `recommendation_preflight` returns actionable diagnostics and the evaluator does not invent a reward. For route-bound rules, an unregistered/stale/conflicting route or a route registered to a different card is `unknown`/`stale`/`needs_review`; it is never silently treated as a match.

## Consequences

- New payment brands can be onboarded by the Agent through the existing route, evidence, offer, and preflight workflow.
- Rules can be precise without forcing every generic card rule to mention a route.
- The canonical matching model is a typed route graph with reusable selectors, not a two-column channel model and not a collection of manually named combination routes.
- The model distinguishes the user-visible path from the clearing/settlement path and avoids false “nested wallet” chains.
- Deep provider-specific facts remain refreshable external evidence rather than hard-coded MCP assumptions.
- Production availability, current campaigns, and individual issuer treatment still require current official verification.

## Considered and rejected simplification

The two-column `money_source + pay_channel` model is useful for simple direct payments, but it is insufficient as the canonical model. It cannot represent an intermediate service such as Taishin Pay+, cannot distinguish direct card authorization from card-to-wallet top-up, and cannot express why the same PayPay acceptance path has different reward semantics when funded by a Richart card versus a Jieli Cun account. Those facts require role-labeled route nodes and typed transitions.

## Primary research anchors

- [JKO Pay FAQ](https://www.jkopay.com/application/faq) — PayPay funding options, credit-card top-up wording, and JKO-account reward exclusion.
- [JKO Pay FX explanation](https://www.jkopay.com/instructions/exchange.html) — JPY/other-currency reference rates and App-displayed transaction rate.
- [Taishin Pay+ FAQ](https://web.taishinbank.com.tw/TSB/personal/digital/E-Payment/Electronic-Payment/faq/) — PayPay acceptance, account/card binding, current fee and FX description, and credit-card top-up limits.
- [PayPay partner-wallet announcement](https://about.paypay.ne.jp/en/pr/20230823/01/) — PayPay interoperability with JKO Pay, PXPay Plus, and E.SUN Wallet.
- [Visa DCC explanation](https://www.visa.com/en-us/personal/travel/dynamic-currency-conversion) — DCC display, markup/fee disclosure, and user choice.
