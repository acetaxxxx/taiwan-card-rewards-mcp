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
A dated statement of a bank or issuer's published benefit, condition,
exclusion, fee, or valuation with a traceable official source URL, page,
announcement identifier, or source description.
_Avoid_: rule, recommendation, search result, unsupported claim

**User-Supplied Offer Input**:
A transcription or structured description supplied by a user to represent an
offer that may be shown in an image or otherwise unavailable as machine-readable
text; it is a candidate input, not official evidence.
_Avoid_: official evidence, verified rule, user claim

**Offer Input Provenance**:
The record linking an offer input to its official URL or source description,
submitter, submission time, and content fingerprint so the input can be reviewed
without treating the submitter's interpretation as issuer-authoritative.
_Avoid_: source URL only, audit log

**Offer Confirmation**:
The user's explicit confirmation that a candidate transcription accurately
represents the cited official offer and may be used to activate its rule.
_Avoid_: agent approval, implicit consent, page visit

**Offer Rule**:
A versioned, declarative interpretation of Offer Evidence that defines when a
reward applies and how it is calculated.
_Avoid_: source page, prompt instruction, arbitrary script

**Predicate AST**:
A declarative tree of reward conditions and operators, including conjunction,
alternatives, thresholds, and exclusions, that can be evaluated without running
agent-supplied code.
_Avoid_: free-form rule text, executable rule, model guess

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

**Timezone Authority**:
The explicit IANA timezone supplied by the user or declared by authoritative
card, offer, or cap context that governs local dates and period boundaries.
_Avoid_: server timezone, guessed locale, silent default timezone

**Currency Context**:
The complete monetary context of a transaction, preserving original, settlement,
reward, fee, and comparison currencies when they differ.
_Avoid_: implicit TWD, display currency only

**FX Snapshot**:
A dated, source-attributed exchange-rate observation for a currency pair and
effective time. The Agent supplies the observation; the MCP creates the
authoritative ID when it persists the snapshot used by a durable transaction.
_Avoid_: live rate, timeless conversion

**Current FX Rate**:
The single fresh rate selected for a currency pair and rate type; issuer or card
scope is added only when the source explicitly requires it.
_Avoid_: global FX table, simultaneous equivalent snapshots

**Merchant Identity**:
A canonical merchant entity shared across issuers and cards. Its fixed
Traditional-Chinese canonical name is separate from offer applicability facts
such as market, country, channel, and MCC.
_Avoid_: issuer-specific merchant, localized merchant identity, raw statement name

**Canonical Merchant Name**:
The single `zh-Hant-TW` name maintained for a Merchant Identity and used by all
offers in this project; source-language labels remain evidence, not aliases.
_Avoid_: localized display name, bank-specific merchant name, alias table

**Agent Merchant Interpretation**:
The LLM Agent's provisional conversion of a raw merchant label, nickname, or
translation into a canonical merchant candidate. It is not MCP durable state
until MCP validates the canonical ID/name and market facts.
_Avoid_: treating an Agent alias guess as a verified merchant identity

**Canonical Merchant Fact**:
The market-scoped merchant identity selected by the Agent from MCP-provided
candidates and validated by MCP before rule evaluation.
_Avoid_: Agent-selected rule ID, raw statement string, unconfirmed translation

**Active Offer Index**:
The derived index of Offer Rules that are active, source-trusted, time-valid,
and evaluable for recommendation or reward calculation.
_Avoid_: all merchant catalog, candidate offer list, search result cache

## Payment paths

**Acceptance Network**:
The merchant-facing network or acceptance brand through which a payment is presented, such as a QR or interoperability network. A brand name does not by itself prove which role it plays in a specific route.
_Avoid_: payment method, funding source, provider

**Payment Service**:
An app, wallet, merchant application, or intermediate payment service that participates between merchant acceptance and funding. It is distinct from the instrument or account that ultimately supplies value.
_Avoid_: payment method, generic provider

**Funding Instrument**:
The card, bank account, wallet balance, or cash source that supplies value at a particular step of a route. A funding instrument is not necessarily the terminal settlement source; a card may top up a wallet whose balance settles the purchase.
_Avoid_: card ID for every funding type, payment route

**Route Node**:
A role-labeled participant in a Payment Route, such as an acceptance network, payment service, or funding instrument. The role is part of the fact so the same brand can be interpreted differently only when evidence supports that role.
_Avoid_: provider node, undifferentiated payment method

**Route Transition**:
The typed relationship between adjacent Route Nodes, such as direct authorization, account debit, wallet top-up, or wallet settlement. It records how value moves and prevents a card top-up from being inferred as a direct card purchase.
_Avoid_: implicit link, assumed funding

**Payment Route Record**:
An evidence-backed concrete Payment Route containing ordered Route Nodes, Route Transitions, and relevant settlement facts for an observed or declared path. Its identifier is stable identity only; it does not contain the matching semantics.
_Avoid_: opaque route rule, route ID as policy

**Payment Route Selector**:
A reusable declarative condition over Route Nodes and Route Transitions that an Offer Rule can use to match one node, one transition, or a complete route pattern. A selector may require a conjunction of roles without requiring every matching route to share one generated route ID.
_Avoid_: hard-coded route name, combination-specific enum

## Transactions and accounting

**Payment Route**:
The ordered, role-labeled path by which a transaction reaches the merchant and
its settlement or funding parties, including acceptance networks, payment
services, funding instruments, and typed transitions; it identifies route
context without storing payment credentials.
_Avoid_: payment token, credential, generic payment method, opaque route ID

**Settlement Amount**:
The amount actually charged to the underlying Held Card after an applicable
wallet balance, merchant-app credit, coupon, or points redemption; it is the
issuer reward basis only when the applicable rule says so.
_Avoid_: displayed price, pre-discount amount, guessed eligible spend

**Reward Component**:
One independently calculated native reward issued by a distinct merchant,
payment-provider, or card-issuer layer, with its own rule, unit, source, and cap
context.
_Avoid_: blended percentage, universal reward, opaque total

**Stacking Assessment**:
The explicit assessment of whether Reward Components can be combined: confirmed,
possible, or unknown.
_Avoid_: automatic sum, absence-of-exclusion guarantee

**Community Observation**:
A third-party report or observed result used to discover a possible offer or
stacking path; it is a candidate lead and not issuer-authoritative Offer Evidence.
_Avoid_: official evidence, verified rule, guaranteed loophole

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

**Top-up Event**:
An event transferring monetary value from a Funding Instrument into a stored-value balance, distinct from and potentially preceding a subsequent purchase across different days.
_Avoid_: purchase transaction, direct payment, wallet debit

**Purchase Event**:
An event exchanging payment for goods or services with a merchant, possessing its own independent payment route, amount, currency, and timestamp.
_Avoid_: funding transfer, top-up, generic transaction

**Cross-Event Eligibility**:
A qualified status for reward rules established by multiple evidenced events spanning specific time windows, execution sequences, or cumulative thresholds, rather than an instantaneous single-transaction match or permanent static boolean fact.
_Avoid_: single-transaction predicate, instant match, static user attribute

## Outcomes and collaboration

**Campaign Registration**: A user's confirmed completion of an issuer registration for a campaign and effective interval.

**Current Benefit State**: The replaceable, user-scoped state describing the currently selected plan or registration, not an event history.

**Reward Rounding Policy**: The versioned official rule for rounding reward units and the scope at which rounding occurs.

**Step Reward**: A reward earned per complete spend step or unit, with explicit step amount and reward amount.

**Reward Combination Policy**: The versioned rule for combining offers: additive, replace, best_of, exclusive, or prerequisite.

**Combination Group**: Offers governed by one combination policy.

**Cap Pool**: The explicit period-scoped aggregate of cap usage shared by rules.

**Cap Pool Reference**: A rule's explicit reference to every Cap Pool it consumes.

**Immediately Available Offer**: An offer whose required registration, plan selection, and facts are confirmed now.

**Action-Required Offer**: A candidate requiring a user action or unresolved fact before confident reward calculation.

**Backfilled Purchase**: An actual past purchase entered after occurrence because the user forgot to record it; it is evaluated in its original period.

**Unknown Condition**:
A required fact, source, rate, or operator result that is unavailable or
ambiguous, so the calculation cannot claim a confident outcome.
_Avoid_: zero reward, false, model guess

**Actionable Diagnostic**:
A machine-readable explanation of a non-confident result containing a code,
data path, required facts, and the next retry or confirmation action.
_Avoid_: bare unknown, free-form error, silent fallback

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

**Uncertainty-Aware Ranking**:
A result ordering that places confident `ok` calculations first and retains
`unknown`, `stale`, or `needs_review` results with their explicit status rather
than treating them as equivalent recommendations.
_Avoid_: estimated ranking, fallback ranking

**Calculation Trust Gate**:
The provenance and confirmation conditions that a Reward Rule must satisfy
before its calculation can produce a confident result; the gate is part of the
calculation authority, not merely a caller convention.
_Avoid_: caller promise, warning flag, best effort

## Domain invariants

- One Held Card has one issuer, but a transaction may match issuer, network, wallet, or merchant sources.
- Cap usage aggregates only by explicit Cap Pool; a rule may consume multiple pools and usage is never inferred from issuer or rule ID.
- Unknown rounding, combination, registration, or required facts are non-confident and prompt the user.
- A confirmed completedAt can affect an asOf projection but never silently rewrites a Recorded Purchase; corrections require confirmation and idempotency.
- Unregistered or unknown campaigns are excluded from confirmed reward while remaining Action-Required candidates.
- A Backfilled Purchase uses its original occurredAt, rule version, current benefit facts, timezone/cycle, and original-period cap pools. It never silently rewrites an existing Recorded Purchase.
- A Recorded Purchase captures its Payment Route and Settlement Amount as
  transaction-time facts; later changes to a wallet binding or merchant-app
  selection cannot rewrite the historical route.
- A Reward Component keeps its own native unit, source, rule version, and cap
  consumption. Components may be merged for presentation only when their
  Stacking Assessment supports it and their units are compatible.
- A Possible Stacking Assessment is an opportunity estimate, not a confirmed
  reward guarantee; under the accepted opportunity-stacking policy it may still
  be formally recorded when its dated evidence is not expired or contradictory.
  A Community Observation can support discovery but cannot replace provenance or
  hide its uncertainty.

- Offer Evidence is not an Offer Rule. A source-linked fact must be interpreted
  into a versioned declarative rule before it can affect a calculation.
- A Card Product is not a Held Card. The same product can have different user
  eligibility facts, selected plans, cycles, or enrollment state.
- A Transaction Intent never consumes a Reward Cap. Only a Recorded Purchase can
  change the Reward Ledger, and a Refund must remain linked to its source.
- A Rule Version, Card Cycle, Currency Context, FX Snapshot, and Reward Valuation
  used by a Recorded Purchase remain traceable for later reconciliation.
- An Agent workspace may retain raw research evidence, but the MCP durable state
  retains only validated typed facts, provenance references, rule versions,
  ledger records, and the FX snapshot actually used by a durable transaction.
- The MCP generates authoritative IDs for persisted snapshots and records;
  Agent references and idempotency keys are correlation inputs, not server IDs.
- A query that needs a local period boundary must use an explicit Timezone
  Authority; the AI agent asks the user when the relevant timezone is missing,
  and the calculator does not infer it from the server or environment locale.
- Unknown Condition and Stale Evidence cannot silently become a match, a zero,
  or a confident Recommendation; the AI agent must refresh evidence or ask the
  user when the missing fact is user-owned.
- A non-confident result must carry an Actionable Diagnostic. Legacy `unknown`
  may remain for compatibility, but it cannot be the only recovery signal.
- Merchant matching uses MCP-managed canonical IDs (`mch_<ULID>`) and fixed Traditional-Chinese
  names; Agent alias/translation guesses must be validated before reward
  evaluation, and market/country belong to offer applicability rather than issuer
  identity.
- The MerchantIdentity catalog is a deployment-shared reference catalog, while
  user transactions, held cards, and reward ledgers remain strictly tenant-isolated.
- Canonical merchant IDs are generated authoritatively by MCP as immutable `mch_<ULID>`
  during controlled registration; LLM agents propose candidates but never assign IDs.
- Merged or duplicate merchant identities never rewrite historical records; deprecated
  identities reference the active canonical ID via `supersededBy`.
- Merchant and offer ingestion follows a strict lifecycle (trusted source extraction ->
  candidate -> user confirmation -> active); recommendation and calculation workflows
  are strictly read-only and never automatically write or activate merchant entities or rules.
- A merchant with no active offer rules (`no_active_offer`) or an unresolved merchant condition
  never blocks non-merchant-dependent general base card rules from producing confident results.
- User-Supplied Offer Input remains `candidate` until its official source,
  required fields, and interpretation have been reviewed; it cannot silently
  activate a rule.
- A candidate rule becomes eligible for `active` status only after an Offer
  Confirmation; an agent may prepare or validate it but cannot substitute for
  that confirmation.
- An Offer Confirmation may use a source URL or another traceable official
  source reference; a user confirmation without any source provenance cannot
  activate a rule.
- The first planned calculation slice uses Predicate AST rules and structured
  inputs; image interpretation happens before the MCP boundary and is not part
  of the calculator's authority.
- Offer Confirmation covers the official source, offer period, reward
  conditions, exclusions, reward unit, and cap; a general approval without those
  semantics is insufficient.
- An Explicit Sort may retain uncertain results for transparency, but
  Uncertainty-Aware Ranking must keep them visibly separate from `ok` results.
- A Reward Calculation must enforce its Calculation Trust Gate itself; a caller
  cannot make an unprovenanced or unconfirmed rule trustworthy by assertion.
- A Reward Calculation is not a Recommendation. The calculation supplies
  explainable facts and explicit sort options; the agent supplies contextual
  judgment.
- The Agent may interpret language and select a merchant candidate with user
  confirmation, but `recommend` and `record_transaction` let MCP select all
  applicable active rules; an Agent-supplied `ruleId` is not authoritative for
  reward choice.
- A user may enter a new card name before it is resolved. That name can be kept
  as an Unresolved Card, but it has no active reward rule until the agent supplies
  verified evidence and the user confirms required facts.
