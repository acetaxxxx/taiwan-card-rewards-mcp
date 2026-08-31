# Card Rewards Context

This context models user-owned card products, public offer evidence, eligibility
facts, reward calculations, and reward accounting. It separates evidence and
rules from the AI agent's conversational recommendation.

## Products and ownership

**Card Product**:
The bank-issued card product whose published terms can be evaluated for a reward.
_Avoid_: held card, card account, user card

**Held Card**:
The user's relationship to a Card Product, including whether the user holds it,
its selected plan, and its product-specific cycle facts.
_Avoid_: card product, account, credential

**Card Alias**:
A user-provided name or label used to identify a Held Card without identifying
the payment instrument itself.
_Avoid_: card number, PAN, account number

**Unresolved Card**:
A user-provided card name that has not yet been matched to a Card Product and
therefore cannot receive a confident reward calculation.
_Avoid_: unknown user, anonymous card

## Offers and eligibility

**Offer Evidence**:
A dated, source-linked statement of a bank or issuer's published benefit,
condition, exclusion, fee, or valuation.
_Avoid_: rule, recommendation, search result

**Offer Rule**:
A versioned, declarative interpretation of Offer Evidence that defines when a
reward applies and how it is calculated.
_Avoid_: source page, prompt instruction, arbitrary script

**Rule Version**:
An immutable set of Offer Rule terms valid for a stated time interval and source
revision; a later revision replaces it for future evaluation without rewriting
past results.
_Avoid_: latest rule, current text

**Rule Status**:
The lifecycle state of a Rule Version: `candidate`, `active`, `stale`,
`superseded`, or `needs_review`.
_Avoid_: confidence score, model state

**Eligibility Fact**:
A time-scoped fact needed to decide whether a Held Card or transaction qualifies,
such as enrollment, plan selection, automatic payment, or a spending threshold.
_Avoid_: inferred fact, permanent user attribute

**Enrollment**:
The user's completion of an issuer-required registration for a specific offer and
period.
_Avoid_: eligibility assumption, app visit

**Plan Selection**:
The user's selected benefits plan at a stated time, including its effective
period and any issuer limit on changing it.
_Avoid_: recommendation, default forever

**Exclusion**:
An explicit transaction or fee category that is outside a reward rule, even when
other conditions match.
_Avoid_: failed calculation, missing condition

## Rewards and money

**Reward Unit**:
The native unit in which an issuer grants value, such as cash, points, or miles.
_Avoid_: always-cash reward, generic points

**Reward Valuation**:
A versioned exchange from a Reward Unit to a stated currency for comparison or
reporting; it is separate from the issuer's redemption promise.
_Avoid_: universal cash value, guessed price

**Reward Calculation**:
The deterministic application of a Rule Version, Eligibility Facts, transaction
attributes, cycle, cap, fees, and currency context to produce a Reward Breakdown.
_Avoid_: recommendation, language-model estimate

**Reward Breakdown**:
The explainable result showing matched and excluded conditions, native reward,
valuation, fees, cap consumption, and unresolved reasons.
_Avoid_: opaque score, final advice

**Reward Cap**:
The maximum reward or qualifying amount allowed for a defined scope and period.
_Avoid_: credit limit, available credit

**Cap Period**:
The interval over which a Reward Cap is shared and consumed, such as a calendar
month, billing cycle, quarter, year, or named campaign.
_Avoid_: reset counter, arbitrary month

**Card Cycle**:
The card-specific time boundary used to group transactions and reset eligible
Reward Caps; it may be different from a calendar month.
_Avoid_: cron reset, universal billing month

**Currency Context**:
The complete monetary context of a transaction, preserving original, settlement,
reward, fee, and comparison currencies when they differ.
_Avoid_: implicit TWD, display currency only

**FX Snapshot**:
A dated, source-attributed exchange-rate observation scoped to the currencies,
provider, card or issuer, and effective time for which it may be used.
_Avoid_: live rate, timeless conversion

## Transactions and accounting

**Transaction Intent**:
A proposed or hypothetical spend used to evaluate a possible reward without
altering the user's reward accounting.
_Avoid_: pending ledger entry, reserved cap

**Recorded Purchase**:
An actual settled or otherwise accepted spend that is written to the user's
reward accounting with its applied Rule Version and calculation trace.
_Avoid_: simulation, chat claim

**Refund**:
A reversal that explicitly references a Recorded Purchase and offsets its reward
and cap effects according to the original accounting context.
_Avoid_: delete purchase, new unrelated purchase

**Reward Ledger**:
The auditable record of Recorded Purchases, Refunds, native rewards, and cap
consumption for a user's Held Cards.
_Avoid_: cached balance, prompt memory

**Idempotent Recording**:
The rule that repeating an actual-record request with the same identity returns
the original result, while a different payload is rejected for review.
_Avoid_: duplicate tolerance, best-effort append

## Outcomes and collaboration

**Unknown Condition**:
A required fact, source, rate, or operator result that is unavailable or
ambiguous, so the calculation cannot claim a confident outcome.
_Avoid_: zero reward, false, model guess

**Stale Evidence**:
Offer Evidence or an FX Snapshot whose validity or freshness window no longer
supports a current confident calculation.
_Avoid_: deleted evidence, automatically false

**Explicit Sort**:
A deterministic ordering over declared fields such as net reward, rate, or
remaining cap; it does not express the user's final preference.
_Avoid_: best card, semantic recommendation

**Recommendation**:
An AI agent's contextual choice or explanation based on Reward Breakdowns, user
priorities, and operational conditions; it is not the ledger's authority.
_Avoid_: calculation verdict, guaranteed outcome

## Domain invariants

- Offer Evidence is not an Offer Rule. A source-linked fact must be interpreted
  into a versioned declarative rule before it can affect a calculation.
- A Card Product is not a Held Card. The same product can have different user
  eligibility facts, selected plans, cycles, or enrollment state.
- A Transaction Intent never consumes a Reward Cap. Only a Recorded Purchase can
  change the Reward Ledger, and a Refund must remain linked to its source.
- A Rule Version, Card Cycle, Currency Context, FX Snapshot, and Reward Valuation
  used by a Recorded Purchase remain traceable for later reconciliation.
- Unknown Condition and Stale Evidence cannot silently become a match, a zero,
  or a confident Recommendation; the AI agent must refresh evidence or ask the
  user when the missing fact is user-owned.
- A Reward Calculation is not a Recommendation. The calculation supplies
  explainable facts and explicit sort options; the agent supplies contextual
  judgment.
- A user may enter a new card name before it is resolved. That name can be kept
  as an Unresolved Card, but it has no active reward rule until the agent supplies
  verified evidence and the user confirms required facts.
