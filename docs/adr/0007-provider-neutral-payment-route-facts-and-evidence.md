# ADR 0007: Provider-neutral payment-route facts, funding rails, and evidence

**Status**: Accepted for the v0.9.x route-binding slice

**Date**: 2026-09-06

**Scope**: `upsert_payment_route`, `list_payment_routes`, transaction route context, route-bound offer rules, and Agent research/preflight.

## Decision

Model a payment route as two related but distinct facts:

1. An observed customer/payment path: merchant acceptance network, consumer app or wallet, optional interoperability/intermediate scheme, and the terminal funding instrument.
2. Settlement facts: transaction, settlement, and billing currencies; conversion owner and timing; FX snapshot; markup and fees; DCC choice.

The terminal funding instrument remains the stable coarse category `credit_card | account | cash`. Account subtypes are open to the known facts needed by the route, including `linked_bank_account`, `wallet_balance`, and `foreign_currency_account`.

Provider names, app names, payment methods, acceptance networks, and interoperability schemes remain open strings. Adding a provider therefore adds an evidence-backed route and offer rule; it does not require a new MCP tool or a core enum. Stable topology kinds are reserved for calculation semantics, not brand names.

The current 15-tool surface remains the public seam. Route registration uses `upsert_payment_route`; route discovery uses `list_payment_routes`; reward applicability uses `OfferRuleVersion.routeId` when an offer is specific to one observed route. Generic rules omit `routeId` and remain backward compatible.

## Route semantics

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
- The model distinguishes the user-visible path from the clearing/settlement path and avoids false “nested wallet” chains.
- Deep provider-specific facts remain refreshable external evidence rather than hard-coded MCP assumptions.
- Production availability, current campaigns, and individual issuer treatment still require current official verification.

## Primary research anchors

- [JKO Pay FAQ](https://www.jkopay.com/application/faq) — PayPay funding options, credit-card top-up wording, and JKO-account reward exclusion.
- [JKO Pay FX explanation](https://www.jkopay.com/instructions/exchange.html) — JPY/other-currency reference rates and App-displayed transaction rate.
- [Taishin Pay+ FAQ](https://web.taishinbank.com.tw/TSB/personal/digital/E-Payment/Electronic-Payment/faq/) — PayPay acceptance, account/card binding, current fee and FX description, and credit-card top-up limits.
- [PayPay partner-wallet announcement](https://about.paypay.ne.jp/en/pr/20230823/01/) — PayPay interoperability with JKO Pay, PXPay Plus, and E.SUN Wallet.
- [Visa DCC explanation](https://www.visa.com/en-us/personal/travel/dynamic-currency-conversion) — DCC display, markup/fee disclosure, and user choice.
