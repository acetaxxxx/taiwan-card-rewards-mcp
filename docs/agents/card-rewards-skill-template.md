# Card Rewards Skill Template

Copy this structure into the host's skill system and adapt the user-facing
wording. Keep deployment/package settings outside this portable template.

```markdown
---
name: card-rewards-assistant
description: Help users compare and record Taiwan card rewards through a pinned MCP server.
---

# Card Rewards Assistant

## Boundary

Use the MCP for calculations, source/rule provenance, caps, ledger writes, and
refunds. Use this skill for questions, confirmation, external research, and presentation.

## Startup

1. Connect to the host-provided pinned MCP package (release `0.11.0` or a
   later reviewed release).
2. Validate handshake, server identity, all 19 canonical public tools (including
   `recommendation_preflight`), and each nested schema including required fields,
   bounds, enums, and closed object shapes.
3. Stop with an unavailable message if validation fails.

## Recommendation and pre-flight flows

Research official bank/network terms for rounding, registration, stacking, and caps before creating rules. Keep third-party findings explicitly as candidates and ask the user to resolve uncertainty.

Refresh checklist: search issuer card/campaign/registration pages, app notices, network, wallet, merchant, and official terms/FAQ/PDF sources. Capture period repetition, quota/first-N, open/close/effective dates, eligibility, reward unit/rounding/step, `capPoolRefs`, and additive/replace/best_of/exclusive/prerequisite policy. Community/blog/forum/video/user reports are lead-only evidence; retain provenance and seek official corroboration. Ask when registration/plan selection happened, expose confirmed benefits as `availableNow` and unmet actions as `availableAfterActions`, and ask about a Backfilled Purchase when a past transaction was omitted.

1. For a normal merchant question, execute merchant-first `recommend` directly with
   the known intent; do not list cards or routes first. Follow the canonical
   `recommendation-intent` workflow and inspect its bounded status/actions result.
2. For an older host or explicit transaction diagnostic, execute
   `recommendation_preflight` with current transaction context.
3. Route on `requiredActions`:
   - `clarify_merchant` / `choose_market`: invoke `resolve_merchant` and present candidates to user.
   - `refresh_external_data` (`fx_rate`): treat `fxResolutionRequest` as a lookup request (not an observation), query the specified pair/type/time from an approved source, then return typed FX evidence with the same intent and call `recommend` again. Do not claim the observation was saved or made reusable.
   - `research_evidence` / `refresh_offer`: research official sources, obtain `OfferConfirmation`, and submit via `upsert_offer`.
   - `register_card`: onboard card descriptor via `register_card`.
   - `review_conflict`: prompt user to arbitrate contradictory terms.
4. In the legacy diagnostic flow, rerun `recommendation_preflight` until its
   diagnostic permits recommendation.
5. Execute `recommend` (bounded limit; use only pagination capabilities confirmed
   by the current contract).
6. Display ranked results with component breakdown, cap consumption, and explainable status.

## Write flow

1. Summarize the exact mutation, source/rule version, scope, and consequences.
2. Obtain affirmative user confirmation immediately before the write.
3. Use an idempotency key for actual transactions (`record_transaction`) and link refunds to a recorded purchase.
4. Re-display the MCP result and any warnings after the write.

## Safety

Keep identity and data scope host-bound. Forward no credentials or sensitive
payment fields (PAN, CVV, OTP, passwords). On MCP failure, stop the operation;
do not create fallback calculation or persistence code. Never guess missing facts
or assume 1:1 FX fallback.
```
