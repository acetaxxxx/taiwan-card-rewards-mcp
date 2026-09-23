# Changelog

## 0.17.0

- Make `remaining_caps` return cap pools referenced by currently usable rewards by default: active, in-window, source-valid, and visible to the current user. Pass `includeHistorical: true` to audit cap pools from inactive, expired, superseded, or otherwise unavailable rules.

## 0.16.1

- Auto-scale zero-decimal currencies (JPY, KRW) per ISO 4217 exponents so agents input natural amounts without manual multiplication.
- Support `fx` as an array or single object in `recommend` and `supplementalFacts`, strictly scoped to prevent rateType cross-poisoning across cards and routes.
- Automatically fan out candidate payment postures (e.g. Apple Pay) when `paymentMethod` is omitted in `recommend`, surfacing optimal reward paths.
- Remove invalid `contentHash` from `buildFxResolutionRequest` requiredFields.
- Fix stateless typed recommendation retry fact forwarding for `supplementalFacts`, `transaction`, and `routeFacts`.

## 0.16.0

- Expose 28-tool MCP contract with server-owned workflow authority and source-scoped ingestion sequence (`create_ingestion`, `get_ingestion`, `submit_ingestion_source`, `submit_ingestion_manifest`, `correct_ingestion_manifest`, `submit_benefit_leaf`, `submit_exclusion_leaf`, `finalize_ingestion`).
- Candidate offer rules remain invisible until atomic manifest finalization; official rules supersede matching predecessors safely across card, componentKind, and tenant boundaries.
- Add transparent `schemaVersion: 4` persistence migration for persisted v2 and v3 ledgers.
- Connect recommendation stale-benefit handoff to ingestion drafts, returning typed continuation tokens (`childFlowId`, `resumedFlowId`, `expectedResultVersion`).
- Reconcile user-facing skill documentation, gold-evidence examples, and tool matrix verification script.

## 0.15.0

- Expose nested transaction predicate contract and structured predicate diagnostics.
- Add nested fact diagnostics and derive server version from package metadata.

## 0.14.1

- Ignore unknown and sensitive input fields at validation boundaries instead of
  persisting or dispatching them; declared fields remain strictly typed and
  invalid values still fail closed.
- Validate and normalize state before every file-store write, use schema-safe
  reward component identifiers, and make transaction idempotency comparison
  independent of server-generated field ordering.

## 0.14.0

- Add user-confirmed offer versions, generated payment paths, bounded transaction history, reusable FX compatibility, and low-reasoning agent workflow coverage.

## 0.13.1

- Preserve the `enrolledAt` timestamp written for campaign registrations when
  schema v2 state is validated and reloaded, preventing valid ledgers from
  being rejected as corrupt after an MCP restart.

## 0.13.0

- Added a schema-directed MCP input adapter that accepts snake_case and
  camelCase recursively at every tool boundary, then validates the canonical
  camelCase model. Unknown, sensitive, and tenant-scoped fields still fail
  closed; duplicate snake/camel spellings are rejected deterministically.
- Kept `tools/list` as the unambiguous camelCase contract and made payment
  route `authority` enumerate its validator-approved values.

## 0.12.0

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
