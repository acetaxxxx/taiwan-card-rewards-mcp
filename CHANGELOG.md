# Changelog

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
