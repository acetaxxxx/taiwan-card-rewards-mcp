# Changelog

## 0.9.0

- Added read-only `recommendation_preflight` (13-tool MCP contract).
- Added MCP-owned `ev_<ULID>`/`fact_<ULID>` evidence identities.
- Added typed `PaymentRouteContext` and actionable route/FX diagnostics.
- Preflight remains read-only and performs no network retrieval.

Existing Schema v2 state remains readable; incompatible older schemas still require explicit migration.
