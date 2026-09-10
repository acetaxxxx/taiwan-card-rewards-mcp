# Changelog

## Unreleased

- Reduced the public MCP surface from 25 to 19 tools. Removed `upsert_fx_policy`,
  `list_fx_policies`, `upsert_fx_observation`, `list_fx_observations`,
  `recommendation_preflight`, and `rank_cards`, and fully retired the hidden
  version-suffixed aliases (`recommend_payment_paths_v1`, `record_event_reward_v1`,
  `record_event_reward_v2`, `reverse_event_reward_v1`) rather than leaving them
  dispatchable outside `tools/list`.
- Collapsed FX from five overlapping concepts (snapshot, policy, policy
  requirement, observation, and a duplicate intent-level observation field) to a
  single inline `fx` snapshot on `recommend`, `record_transaction`, and
  `record_event_reward`; it is trusted directly once it passes currency-pair and
  freshness checks, with no separate policy/observation storage layer.
- `recommend`'s input is now the single merchant-first intent shape (no more
  `oneOf` of intent / legacy transaction / payment-path envelope); its
  `candidates[]` already unifies direct-card and multi-layer payment-path
  results in one ranked list, matching how `recommendIntent` has called the
  path engine internally since the multi-layer payment path work landed.
- Fixed payment routes, payment route edges, payment capabilities, and
  payment-path eligibility facts so they are usable through the public MCP
  protocol: they previously required resolving against a `state.evidence`
  store that no MCP tool could ever populate, making them dead in practice.
  They are now trusted directly from the caller's self-asserted `evidenceIds`,
  consistent with how `upsert_payment_route` already worked. `recommend`'s
  intent schema also gained an `eligibilityFacts` field so prerequisite/stacking
  rules can be exercised through the single public `recommend` entry point,
  matching what the removed lower-level `payment_path` branch used to accept.
- Reorganized documentation to match: deleted eight superseded/dead
  `docs/specs/*` documents and a byte-identical duplicate research file,
  archived the remaining `docs/research/*` snapshots under
  `docs/research/archive/`, removed two fully-superseded `.scratch/` project
  trees, and corrected tool-count claims across `README.md`, `AGENTS.md`, and
  the Agent Skill bundle.

## 0.11.3

- Align package and server release metadata with the `v0.11.3` tag.

## 0.11.1

- Fix bounded list projections used by Aion agents: `list_cards`, `list_payment_accounts`, and `list_payment_routes` now accept the documented `limit` range up to 50.
- Report invalid projection bounds as `INVALID_INPUT` instead of masking them as `INTERNAL_ERROR`.

## 0.11.0

- Added shared MCP owner/stdio bridge auto-attach for agents using the same
  `data-dir`, with bounded queues, stale-owner recovery, session isolation, and
  different-directory tenant isolation.
- Added automatic FX resolution requests, typed `FxRateObservation` provenance,
  atomic cross-currency ingestion, fail-closed `fx_missing`, and frozen applied
  rates for refunds.
- Added the shared MCP and FX automation integration plan and completed the
  Track A/B/C acceptance matrix.

## 0.10.1

- Renamed the MCP protocol identity to `taiwan_card_rewards_mcp` for Codex and
  host compatibility while preserving the npm package and CLI binary names.

## 0.10.0

- Consolidated the public MCP surface to 19 unversioned tools, including the
  closed card/payment_path `recommend` union and canonical event tools.
- Added bounded multi-layer payment-path planning with planned top-up/purchase
  events, explicit stacking/caps, authoritative eligibility evidence, fee/FX/
  valuation fail-closed handling, and deterministic ranking.
- Published the canonical Agent Skill router, references, workflows, and
  end-to-end usage examples aligned with the runtime contract.

External bank APIs, sidecar/Chromium integration, and staging remain outside
this release's verification scope.

## 0.9.0

- Added read-only `recommendation_preflight` and PaymentRoute onboarding/listing (15-tool MCP contract).
- Added MCP-owned `ev_<ULID>`/`fact_<ULID>` evidence identities.
- Added typed `PaymentRouteContext` and actionable route/FX diagnostics.
- Preflight remains read-only and performs no network retrieval.

Existing Schema v2 state remains readable; incompatible older schemas still require explicit migration.
