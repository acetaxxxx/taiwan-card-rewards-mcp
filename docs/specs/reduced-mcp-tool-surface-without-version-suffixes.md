# Reduced MCP Tool Surface Without Public Version Suffixes

Status: implemented in release 0.10.1. This document records the public
contract consolidation and migration boundary; the canonical tool schemas are
maintained in `docs/agents/taiwan-card-rewards-skill/references/mcp-tools.md`.

## Current public surface

The current `src/mcp-contract.ts` publishes exactly 19 tools. The
`tests/mcp-contract.test.ts` contract and the canonical Agent Skill reference
are the executable and documentation sources of truth. Older documents that
say 21, 20, or 15 tools describe superseded stages and are not the current
contract.

The current public names are:

```text
calculate_reward             rank_cards
register_card                list_cards
upsert_offer                 recommend
recommendation_preflight     upsert_payment_route
list_payment_routes          register_payment_account
list_payment_accounts        record_transaction
record_event_reward           reverse_event_reward
remaining_caps                get_user_benefit_status
upsert_user_benefit_status    resolve_merchant
search_active_offers
```

The CLI dispatch also retains migration-only aliases, but those aliases are
absent from `tools/list` and share the canonical validation and ownership
gates.

## Target public surface

The 0.10.1 public surface has 19 tools. Public names do not contain `v1`,
`v2`, or another transport/schema version suffix. Internal stored-state
versions and wire compatibility aliases remain allowed.

| Current public name(s) | Target public name | Change |
| --- | --- | --- |
| `calculate_reward` | `calculate_reward` | Keep read-only single-rule calculation. |
| `rank_cards` | `rank_cards` | Keep read-only bounded card ranking. |
| `register_card` | `register_card` | Keep write boundary. |
| `list_cards` | `list_cards` | Keep read-only boundary. |
| `upsert_offer` | `upsert_offer` | Keep write boundary and atomic merchant candidate support. |
| `recommend`, `recommend_payment_paths_v1` | `recommend` | One read-only entry with a closed request union: card recommendation or the future multi-layer complete payment-path request. |
| `recommendation_preflight` | `recommendation_preflight` | Keep read-only diagnostics boundary. |
| `upsert_payment_route` | `upsert_payment_route` | Keep write boundary. |
| `list_payment_routes` | `list_payment_routes` | Keep read-only boundary. |
| `register_payment_account` | `register_payment_account` | Keep write boundary. |
| `list_payment_accounts` | `list_payment_accounts` | Keep read-only boundary. |
| `record_transaction` | `record_transaction` | Keep legacy purchase/refund boundary. |
| `record_event_reward_v1`, `record_event_reward_v2` | `record_event_reward` | One write tool with a closed union requiring exactly one event-local `rule` or `chainRule` plus `sourceEvents` for a chain. Server-side eligibility recomputation remains mandatory. |
| `reverse_event_reward_v1` | `reverse_event_reward` | Rename only; preserve explicit refund relation and idempotency semantics. |
| `remaining_caps` | `remaining_caps` | Keep read-only bounded projection. |
| `get_user_benefit_status` | `get_user_benefit_status` | Keep read-only boundary. |
| `upsert_user_benefit_status` | `upsert_user_benefit_status` | Keep write boundary. |
| `resolve_merchant` | `resolve_merchant` | Keep read-only exact resolution. |
| `search_active_offers` | `search_active_offers` | Keep read-only search. |

The release merges the event recording pair, renames the reverse operation,
and merges payment-path recommendation into the closed `recommend` union. It
does not introduce a generic `action` tool.

## Closed request unions

### `recommend`

`recommend` remains read-only and accepts one of two closed request shapes:

1. Card recommendation: the existing `transaction` plus optional card IDs,
   merchant, context, pagination, and projection fields.
2. Multi-layer payment-path recommendation: the bounded request shape defined
   by the multi-layer path specification, including route topology, transitions,
   funding source, and evidence constraints. The historical
   `recommend_payment_paths_v1` name is migration-only.

The discriminator should be an explicit `kind` (`card` or `payment_path`) or a
JSON Schema `oneOf` with disjoint required fields. Ambiguous payloads must be
rejected. The implementation must preserve read-only behavior and existing
fail-closed route/evidence checks. No credentials, owner fields, or arbitrary
action selector is permitted.

### `record_event_reward`

The target schema is the already hardened v2 union, renamed without the suffix:

- exactly one of `rule` and `chainRule`;
- `chainRule` requires bounded `sourceEvents`;
- nested event/rule/candidate objects are closed;
- the authenticated metadata user determines ownership;
- server recomputes event-local or explicit `funded_by` eligibility;
- unknown, missing, ambiguous, stale, or non-calculable rewards fail closed;
- idempotency replay returns the original decision and conflicting replay fails.

The old v1 shape must not be silently accepted under the new name if it can
bypass server matching. If retained for compatibility, it must be normalized
into the same validated internal union and use the same server-side gate.

## Compatibility and removal boundary

Compatibility aliases may remain in `src/cli.ts` for one documented migration
period:

```text
recommend_payment_paths_v1  -> recommend(kind=payment_path)
record_event_reward_v1      -> record_event_reward
record_event_reward_v2      -> record_event_reward
reverse_event_reward_v1     -> reverse_event_reward
```

Aliases are dispatch-only and must not appear in `tools/list`. They must share
the target validator, ownership checks, idempotency behavior, and error mapping;
there must be no legacy bypass. A deprecation diagnostic may be emitted in
logs/telemetry, but response payloads remain contract-compatible.

Removal requires a release note and a migration window with no consumers still
using the aliases. Existing StoredState and internal schema versions remain
readable; this proposal does not reinterpret legacy transactions or migrate
state merely because public names changed.

## Read/write and ownership boundaries

Read-only: `calculate_reward`, `rank_cards`, `list_cards`, `recommend`,
`recommendation_preflight`, `list_payment_routes`, `list_payment_accounts`,
`remaining_caps`, `get_user_benefit_status`, `resolve_merchant`, and
`search_active_offers`.

Mutating: `register_card`, `upsert_offer`, `upsert_payment_route`,
`register_payment_account`, `record_transaction`, `record_event_reward`,
`reverse_event_reward`, and `upsert_user_benefit_status`.

No public input may select `ownerUser`, `user_id`, credentials, tokens, or a
data directory. Current authenticated metadata determines tenant ownership;
list and write operations must remain user-scoped where the existing service
requires it.

## Eight acceptance criteria for implementation

1. Release 0.10.1 `tools/list` returns exactly 19 names and contains
   unversioned event and payment-path names. It exposes no public version
   suffixes for the merged tools.
2. Every target name has one CLI dispatch branch and one closed schema; each
   compatibility alias is absent from tools/list but tested through dispatch.
3. `recommend` tests cover both union branches, ambiguity rejection, and
   parity with the old recommendation/path behavior.
4. `record_event_reward` tests cover event-local and explicit `funded_by`
   chain branches, replay/conflict, unknown/needs_review, cross-user
   isolation, and schema/runtime parity.
5. `reverse_event_reward` preserves validated relation, proportional reversal,
   cap release, and idempotency behavior.
6. Existing StoredState, legacy transaction records, and internal schema
   versions remain readable without reinterpretation.
7. Agent docs, README, tool reference, examples, and installation SOPs use the
   same 19-name list. No current document may claim 15, 20, or 21 tools.
8. Full tests, typecheck/build, and `git diff --check` pass; external staging
   and production remain explicitly unverified.
