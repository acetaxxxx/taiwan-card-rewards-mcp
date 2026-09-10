# MCP Nested Schemas, Actionable Errors, and Recommendation Contract

**Status**: Target normative specification
**Version**: 0.6.0

## Purpose

The MCP wire contract MUST describe the nested values that runtime validation
already requires. A tool's `inputSchema` is part of its interface: agents must
be able to construct valid values without guessing whether a money, rule,
transaction, or context value is flat or nested.

## Nested input contract

The following shapes are normative. Unknown fields are rejected at every
nested level.

```json
{
  "transaction": {
    "cardId": "card-01",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-05T12:00:00Z",
    "amount": { "amountMinor": 100000, "currency": "TWD" },
    "merchant": "Example Store",
    "mcc": "5411",
    "country": "TW",
    "channel": "in_store",
    "paymentMethod": "direct_card",
    "route": { "kind": "direct_card" },
    "settlementAmount": { "amountMinor": 95000, "currency": "TWD" },
    "fx": {
      "baseCurrency": "JPY",
      "quoteCurrency": "TWD",
      "ratePpm": 215000,
      "capturedAt": "2026-09-05T10:00:00Z",
      "provider": "approved-provider",
      "rateType": "card_scheme"
    }
  },
  "context": {
    "now": "2026-09-05T12:00:00Z",
    "sourceSnapshots": {},
    "capPools": [],
    "usageByKey": {}
  }
}
```

`recommend` is the exception to the transaction `cardId` requirement: the
caller is asking which registered card to use, so its planned transaction may
omit `cardId`. Actual
recording always requires `cardId` and `idempotencyKey`.

`calculate_reward` accepts optional `context.now`; omitted
means the current evaluation time is selected internally. A caller-supplied
future ISO-8601 timestamp is honored for planning. `occurredAt` remains the
transaction event time and governs historical rule/cap evaluation.

## FX input versus durable audit record

An agent-supplied FX value is an input observation, not an authoritative
identifier. `fxSnapshotId` MAY be supplied as an optional client correlation
value in recommendation/calculation input. When the MCP accepts and persists
an FX snapshot, it MUST generate its own UUID/ULID audit ID. A provider's
reference, URL, or agent-generated ID MUST NOT become that authoritative ID.
Transaction `idempotencyKey` and a canonical payload fingerprint provide retry
identity.

For calculation, `provider`, `rateType`, and `capturedAt` are required facts.
`sourceUrl` and `contentHash` are optional during ingestion, but are required
or strongly recommended for official-source audit and durable transaction
records. `cardIdScope` and `issuerScope` are absent by default; they are
present only when the rate is specifically scoped to that card or issuer, and
otherwise are null/absent rather than guessed.

The MCP never fetches FX or source pages. Agents/UI obtain approved data,
attach provenance, and retry after an actionable failure.

## Actionable result and error contract

The legacy top-level `status` (`ok`, `unknown`, `stale`, `needs_review`, or
`no_match`) remains for compatibility. Every non-`ok` result MUST additionally
include one or more machine-readable diagnostics:

```json
{
  "status": "unknown",
  "diagnostics": [{
    "code": "fx_missing",
    "path": "transaction.fx",
    "requiredFacts": ["provider", "rateType", "capturedAt", "baseCurrency", "quoteCurrency", "ratePpm"],
    "retryAction": "query_approved_fx_source"
  }]
}
```

The approved code/action taxonomy is:

| Code | Meaning | Agent retry action |
|---|---|---|
| `missing_required_fact` | Required transaction/rule/context field absent | Ask user and collect the named path |
| `fx_missing` | Cross-currency calculation has no usable snapshot | Query an approved FX source |
| `fx_stale` | Snapshot outside its freshness window | Refresh FX |
| `fx_pair_mismatch` | Base/quote currencies do not match | Rebuild the snapshot for the required pair |
| `fx_scope_mismatch` | Card/issuer-scoped snapshot does not apply | Ask for card/issuer confirmation or an unscoped rate |
| `fx_conflict` | Multiple authoritative candidates disagree | Select an approved source or request review |
| `merchant_ambiguous` | Merchant candidates collide across market/identity | Ask market/country and show bounded candidates |
| `source_untrusted` | Source is unverified or candidate-only | Verify official provenance or obtain confirmation |
| `stale_rule` | Rule or source validity ended | Refresh official offer evidence |
| `invalid_input` | Payload violates schema or invariant | Correct the indicated path |
| `needs_review` | Human confirmation or contradiction is required | Present evidence and request confirmation |

`unknown` alone means unresolved or legacy fallback only; it is not an
adequate new error contract. Existing `unknownReasons` MAY remain during the
compatibility period, but must not replace `diagnostics`.

## Recommendation input and bounded responses

```typescript
interface RecommendationInput {
  transaction: PlannedTransactionInput; // cardId omitted until a card is selected
  cardIds?: readonly string[];           // default: all cards in tenant scope
  merchant?: {
    canonicalId?: string;
    canonicalNameZhHant?: string;
    rawStatement?: string;              // evidence only; never an authority
    market?: string;
    country?: string;
  };
  context?: EvaluationContext;
  limit?: number;                        // default 10; Agent may select five to present
  page?: number;                         // 1-based; default 1
}

interface ActiveOfferSearchInput {
  cardId?: string;
  canonicalMerchantId?: string;
  market?: string;
  country?: string;
  mcc?: string;
  channel?: "in_store" | "online";
  limit?: number;                        // default 10
  page?: number;                         // 1-based; default 1
}

interface RecommendationPage {
  items: readonly RankingEntry[];
  limit: number;
  page: number;
  hasMore: boolean;
  totalPages?: number;
  diagnostics?: readonly ActionableDiagnostic[];
}
```

The result page MUST include its `dataVersion` and `evaluatedAt`. The current
data scale uses simple 1-based `page` plus `limit`; no cursor is required.
Results use deterministic ordering (status, reward value where comparable, then card ID). Native reward
units that cannot be safely valued are returned as separate breakdowns rather
than silently summed.

Recommendation must first validate a canonical merchant ID or
`canonicalNameZhHant`, or fail closed with `merchant_ambiguous`/
`missing_required_fact`; `rawStatement` is evidence only. It must then scope
candidates to active, source-trusted, time-valid Offer Rules. A known merchant
with no active dedicated offer returns `no_active_offer` while still allowing a
valid base rule to be evaluated. The Agent may use fuzzy, embedding, translation,
or web research outside the MCP to produce a canonical candidate, but MCP never
executes or persists those interpretations automatically.

`search_active_offers` returns only active, source-trusted, time-valid Offer Rules
and their fixed Traditional-Chinese canonical merchant names. It is the discovery
surface for Agent queries such as "目前哪些商家有優惠"; it does not create
MerchantIdentity records or expose candidate/stale rules.

## Integration and compatibility

- `src/types.ts` owns nested DTOs and `ActionableDiagnostic` types.
- `src/validation.ts` validates every nested object and emits path-specific
  diagnostics without accepting unknown fields.
- `src/evaluator.ts` stays pure; it consumes an already validated context and
  never fetches FX or merchant data.
- `src/service.ts` owns tenant-scoped ledger/context construction and
  recommendation pagination.
- `src/mcp-contract.ts` publishes complete `properties` and nested schemas in
  `tools/list`; it must not expose `user_id`, `data-dir`, or credentials.

This contract is additive for existing callers: legacy `status` and
`unknownReasons` remain readable while new clients use `diagnostics` for
deterministic recovery.
