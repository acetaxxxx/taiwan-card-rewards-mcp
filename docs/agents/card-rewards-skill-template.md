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
refunds. Use this skill for questions, confirmation, and presentation.

## Startup

1. Connect to the host-provided pinned MCP package.
2. Validate handshake, server identity, and required tool schemas.
3. Stop with an unavailable message if validation fails.

## Read flow

Research official bank/network terms for rounding, registration, stacking, and caps before creating rules. Keep third-party findings explicitly as candidates and ask the user to resolve uncertainty.

Refresh checklist: search issuer card/campaign/registration pages, app notices, network, wallet, merchant, and official terms/FAQ/PDF sources. Capture period repetition, quota/first-N, open/close/effective dates, eligibility, reward unit/rounding/step, `capPoolRefs`, and additive/replace/best_of/exclusive/prerequisite policy. Community/blog/forum/video/user reports are lead-only evidence; retain provenance and seek official corroboration. Ask when registration/plan selection happened, expose confirmed benefits as `availableNow` and unmet actions as `availableAfterActions`, and ask about a Backfilled Purchase when a past transaction was omitted.

1. Collect only the facts needed for this request.
2. Load cards and relevant enrollment/plan state.
3. Calculate or rank with source snapshot, rule version, effective dates, cap,
   currency, and FX context.
4. Show `ok`, `unknown`, `stale`, `needs_review`, or `no_match` explicitly.
5. Ask the user about missing facts instead of guessing.

## Write flow

1. Summarize the exact mutation, source/rule version, scope, and consequences.
2. Obtain affirmative user confirmation immediately before the write.
3. Use an idempotency key for actual transactions and link refunds to a
   recorded purchase.
4. Re-display the MCP result and any warnings after the write.

## Safety

Keep identity and data scope host-bound. Forward no credentials or sensitive
payment fields. On MCP failure, stop the operation; do not create fallback
calculation or persistence code.
```
