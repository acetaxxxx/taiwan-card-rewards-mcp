# Complete user-scoped credit-card rewards MCP

Status: ready-for-agent

## Problem Statement

Users need a trustworthy way to compare Taiwan credit-card rewards for a planned spend and maintain the resulting reward accounting when a purchase or refund actually settles. Bank offers are often expressed in images or other formats that require user-assisted transcription, while reward rules include eligibility conditions, exclusions, thresholds, caps, currencies, and changing validity periods. The system must preserve the distinction between official Offer Evidence, User-Supplied Offer Input, versioned Offer Rules, Reward Calculations, and contextual Recommendations, without allowing an uncertain or unconfirmed interpretation to become a confident financial result.

## Solution

Deliver the complete eight-tool, user-scoped stdio MCP surface around a pure deterministic reward calculator and a tenant-bound durable store. The first implementation supports Predicate AST rules, Card Products plus Held Card and Eligibility Facts in calculation inputs, official source provenance, user-confirmed candidate activation, planned and actual transactions, partial and repeated refunds, idempotency, cap reconciliation, currency and FX context, and deterministic uncertainty-aware Top-5 ranking. Bank pages, images, and PDFs are obtained and parsed outside the MCP by the Agent or UI.

Images are handled before the MCP boundary by an agent or UI. The MCP accepts structured candidate JSON, not raw image processing. User-assisted input is never treated as official evidence by implication: it remains candidate until traceable official provenance and the complete rule semantics have been reviewed and the user has explicitly confirmed them. Raw images are not retained by default.

## User Stories

1. As a cardholder, I want to submit a planned transaction, so that I can compare the rewards available from my cards before spending.
2. As a cardholder, I want to compare multiple Held Cards in one request, so that I can choose among the cards I actually hold.
3. As a cardholder, I want Card Products to remain distinct from my Held Cards, so that product terms are not confused with my enrollment, plan, or cycle facts.
4. As a cardholder, I want the result to show a Reward Breakdown, so that I can understand the matched conditions, exclusions, reward unit, cap, fees, and unresolved reasons.
5. As a cardholder, I want up to five cards ordered deterministically, so that repeated requests with the same inputs produce the same ordering.
6. As a cardholder, I want `ok` results separated from `unknown`, `stale`, and `needs_review` results, so that uncertainty is visible instead of being presented as a recommendation.
7. As a cardholder, I want to provide an offer image or image URL to the agent or UI, so that image-based bank promotions can be captured.
8. As a cardholder, I want to provide structured offer fields directly, so that I can correct or replace an inaccurate transcription.
9. As a cardholder, I want an image transcription to retain its source description, submitter, submission time, and content fingerprint, so that I can audit what was entered without retaining the raw image by default.
10. As a cardholder, I want to review the official source, validity period, reward conditions, exclusions, reward unit, and cap before confirmation, so that I explicitly approve the meaning that will affect calculations.
11. As a cardholder, I want a candidate rule without provenance to remain inactive, so that unsupported claims cannot produce confident rewards.
12. As a cardholder, I want a candidate rule to become active only after my explicit Offer Confirmation, so that an agent cannot silently authorize a financial rule on my behalf.
13. As a cardholder, I want the system to preserve immutable Rule Versions, so that later source changes do not rewrite historical calculations.
14. As a cardholder, I want Predicate AST rules to express AND, OR, NOT, field matching, thresholds, and exclusions, so that common Taiwan bank offers can be represented without executable agent code.
15. As a cardholder, I want malformed ASTs and unknown operators rejected, so that partial parsing cannot create an apparently valid but incorrect reward.
16. As a cardholder, I want missing merchant, MCC, country, channel, payment method, eligibility, or plan facts to produce an explicit unknown result, so that the system asks for facts instead of guessing.
17. As a cardholder, I want stale source snapshots, stale FX snapshots, conflicting rules, and unreviewed rules to fail closed, so that expired or disputed data does not become a confident recommendation.
18. As a cardholder, I want original, settlement, reward, fee, and comparison currencies preserved, so that cross-currency calculations remain explainable.
19. As a cardholder, I want FX observations to include their provider, captured time, currency pair, and validity policy, so that conversions can be reconciled later.
20. As a cardholder, I want to record an actual purchase with an idempotency key, so that retrying a request cannot duplicate ledger effects.
21. As a cardholder, I want a conflicting payload with an existing idempotency key rejected, so that one key cannot represent two transactions.
22. As a cardholder, I want to record a refund linked to its original purchase, so that the original reward and cap effects can be reversed rather than deleting history.
23. As a cardholder, I want partial and repeated refunds bounded by the original purchase and prior refunds, so that an over-refund cannot corrupt reward accounting.
24. As a cardholder, I want refunds to use the original accounting context, including rule version, cycle, currency, and reward amount, so that reversals remain consistent with the purchase.
25. As a cardholder, I want planned transactions to have no ledger or cap side effects, so that comparison is safe to repeat.
26. As a cardholder, I want actual transactions to update only my user-scoped Reward Ledger, so that another user cannot see or consume my data.
27. As a cardholder, I want remaining caps calculated from actual ledger records and the correct Card Cycle, so that usage resets and limits reflect the issuer's period.
28. As a cardholder, I want a billing-cycle cap to respect my card's statement closing day and timezone, so that calendar-month assumptions do not misstate eligibility.
29. As a cardholder, I want the MCP process to require a trusted, canonical data directory, so that tools cannot select or override another user's storage.
30. As a cardholder, I want tool inputs to exclude user identifiers, data paths, credentials, PAN, CVV, OTP, cookies, and tokens, so that the model cannot spoof identity or submit sensitive financial secrets.
31. As a cardholder, I want public-offer fetching restricted to official hosts explicitly supplied by the trusted parent, so that arbitrary URLs, private IPs, redirects, and SSRF targets are rejected.
33. As a cardholder, I want the system to preserve source hashes, parser versions, fetch times, validity periods, and excerpts, so that an Offer Rule can be traced to the evidence used to create it.
34. As a cardholder, I want a second process using the same data directory rejected, so that concurrent writers cannot corrupt my ledger.
35. As a cardholder, I want atomic durable writes and explicit corruption errors, so that an interrupted write does not silently replace valid history with partial state.
36. As a cardholder, I want the domain service to use a replaceable persistence boundary, so that the system can move from FileStore to SQLite/WAL without rewriting reward semantics.
37. As an agent, I want stable MCP tool names and structured error statuses, so that I can explain successful, uncertain, stale, and rejected outcomes consistently.
38. As an operator, I want audit-relevant provenance and rule versions retained without raw images by default, so that review and privacy requirements can coexist.

## Implementation Decisions

- The system remains an external AionCore stdio MCP. AionCore supplies a separate process and canonical data directory per user. The MCP does not expose an HTTP or SSE listener.
- The complete initial MCP surface includes `calculate_reward`, `rank_cards`, `register_card`, `list_cards`, `upsert_offer`, `recommend`, `record_transaction`, and `remaining_caps`.
- `calculate_reward` and `rank_cards` remain pure calculation entry points. Their inputs include structured Card Products, Held Card and Eligibility Facts where needed, versioned rules, transactions, and evaluation context. They do not perform persistence.
- `RewardService` remains the highest public domain seam for the stateful operations. The MCP adapter validates JSON-RPC and tool arguments, then delegates to the service. Private helpers are not public test seams.
- Reward rules use a validated Predicate AST. The allowlisted operators are conjunction, alternatives, negation, field matching, thresholds, and exclusions. Unknown operators, malformed nodes, unknown fields, and invalid values are rejected as validation failures.
- The calculation authority enforces a Calculation Trust Gate. A rule must have a valid status, traceable Offer Evidence or equivalent official provenance, a matching source snapshot, required validity metadata, and an Offer Confirmation before it can produce a confident `ok` result. A caller cannot override this gate.
- User-Supplied Offer Input is accepted only as structured candidate JSON at the MCP boundary. Image selection, OCR, and manual transcription occur in the agent or UI layer. Raw images are not retained by default.
- Offer Confirmation records explicit confirmation of official source, offer period, reward conditions, exclusions, reward unit, and cap. A source may be represented by a URL, page, announcement identifier, or other traceable official source description. No provenance means the rule remains `candidate` or `needs_review`.
- Offer Evidence, Offer Rules, Rule Versions, and source snapshots remain separate concepts. Source changes create new immutable versions and never rewrite historical calculations.
- Card Products, Held Cards, Eligibility Facts, Card Cycles, Currency Context, FX Snapshots, Reward Units, and Reward Valuations remain separately representable. The first complete surface may pass these as structured inputs even when persistence for every future context is not yet available.
- Monetary calculations use integer minor units, basis points for percentages, and parts-per-million FX rates. The output preserves native reward units and any versioned valuation used for comparison.
- Planned transactions never mutate the Reward Ledger or consume a Reward Cap. Actual purchases require idempotency and persist the calculation trace. Refunds reference an existing purchase, support partial and repeated reversals within the original amount, and apply the original accounting context.
- Cap usage is scoped by rule, Card Cycle, currency, and ledger semantics. A refund reverses the corresponding usage rather than being ignored by aggregation.
- Ranking is deterministic and limited to five entries. `ok` results come first; uncertain statuses remain visible with explicit reasons. Ties use a declared stable secondary ordering, including card identity, and never depend on iteration order.
- Public source fetching accepts only HTTP(S) URLs that match the trusted official-host allowlist supplied at startup. It rejects credentials, custom ports, redirects, private or loopback addresses, disallowed content types, oversized responses, and timeout failures.
- All tool arguments are strict allowlists. Unknown fields and sensitive fields are rejected. `user_id`, data paths, credentials, PAN, CVV, OTP, cookies, session tokens, and provider keys are never accepted as tool data.
- Persistence is accessed through a `LedgerStore`／repository seam. The first adapter remains the tenant-bound FileStore with exclusive locking and atomic replacement; a future SQLite/WAL adapter can replace it without changing evaluator or service semantics.
- The process requires an absolute, existing, canonical, non-root data directory. Every persistence operation uses that directory; tools cannot override it. Process-level identity and storage scope come from the trusted parent rather than model-supplied fields.
- The stateful service rejects stale locks, conflicting idempotency payloads, invalid refunds, invalid candidate activation, missing source snapshots, and corrupt or unavailable storage with explicit fail-closed errors.

## Testing Decisions

- Tests assert externally observable behavior at the highest useful seam. Stateful behavior is tested through `RewardService` operations and the MCP tool contract; pure arithmetic and ranking behavior is tested through the pure calculator functions. Private helpers and storage implementation details are not direct test targets.
- Existing evaluator, security, startup, and service-oriented test patterns are extended rather than replaced.
- Predicate AST tests cover valid conjunction, alternatives, negation, field matching, thresholds, exclusions, malformed nodes, unknown operators, and unknown fields.
- Calculation tests cover exact integer percentage and flat rewards, caps, cap exhaustion, source validity, rule status, missing facts, missing FX, currency mismatch, Reward Unit and valuation handling, and Calculation Trust Gate failures.
- Ranking tests cover deterministic Top-5 truncation, `ok` before uncertain statuses, explicit uncertain reasons, stable tie-breaking, no-match cards, and repeated identical requests.
- Candidate and source tests cover structured user input, provenance forms, required Offer Confirmation fields, candidate-to-active transitions, missing provenance, unconfirmed rules, source hash/version changes, stale snapshots, and raw-image non-retention policy at the contract level.
- Transaction tests cover planned non-mutation, actual purchase recording, repeated idempotent requests, conflicting idempotency payloads, missing idempotency, linked refunds, partial refunds, repeated refunds, over-refunds, wrong-card refunds, missing originals, and currency/context preservation.
- Cap and cycle tests cover calendar month, billing cycle, timezone and closing-day boundaries, campaign periods, purchase usage, refund reversal, and cap currency conversion.
- Persistence tests exercise the `LedgerStore` seam for read/write behavior, tenant directory binding, exclusive lock behavior, stale-lock handling policy, atomic replacement, corrupt-state errors, and process restart recovery. They do not assert the internal JSON layout.
- Security tests cover rejection of user/path overrides and sensitive fields, canonical directory requirements, symlink/path escape protection, official-host allowlisting, DNS rebinding/private-address rejection, redirect rejection, response-size limits, timeouts, and disallowed content types.
- MCP protocol tests cover initialize, tools/list, tools/call, malformed JSON-RPC, unknown tools, unknown arguments, structured fail-closed errors, and stdout/stderr separation.
- Every test that expects a confident result supplies explicit source provenance, active status, confirmation, required transaction facts, currency context, and valid time context. Tests expecting uncertainty assert the exact status and reasons rather than treating uncertainty as zero reward.

## Out of Scope

- Storing or processing PAN, CVV, OTP, bank credentials, login cookies, session tokens, or provider keys.
- Implementing image OCR, image understanding, or image upload storage inside the MCP process.
- Opening an HTTP, SSE, browser automation, or public network server.
- Accepting arbitrary third-party reward sources as official evidence.
- Letting an agent silently activate a rule without user confirmation.
- Treating unsupported or missing provenance as a confident result.
- Replacing FileStore with SQLite/WAL in this specification; only the replaceable persistence seam is required now.
- Building AionCore authentication, JWT validation, account management, purge orchestration, or multi-user process supervision inside this repository. The parent contract must still provide trusted per-user process and storage scope.
- Making contextual Recommendation logic the authority for reward calculation. Recommendation consumes Reward Breakdowns; it cannot alter their status or arithmetic.
- Implementing every bank's complete current offer catalog as hard-coded core logic. Bank-specific rules enter through versioned evidence and validated rule data.

## Further Notes

- The most important delivery risk is scope: complete exposure of all eight tools requires purchase, refund, cap, idempotency, source governance, and persistence behavior to be real rather than placeholder endpoints.
- The initial implementation should preserve one high-level service seam while keeping the evaluator pure. Any new seam should be introduced only when it removes a cross-cutting concern such as cycle resolution, FX provenance, or durable ledger replacement.
- Existing repository behavior contains known follow-up risks around refund aggregation, billing-cycle calculation, deterministic tie-breaking, and the current source URL validation shape. The implementation must resolve those contract gaps rather than merely document them.
- The local issue tracker stores this spec under `.scratch/complete-mcp-rewards/`. Follow-up implementation tickets should be separate files under `.scratch/complete-mcp-rewards/issues/`, numbered from `01`, and marked `ready-for-agent` when individually actionable.
