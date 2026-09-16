# Low-reasoning playbook

Use this compact three-tier playbook for lightweight or lower-reasoning models.
The canonical schemas remain in [`mcp-tools.md`](mcp-tools.md); this file
controls routing and high-risk choices.

## Tier 1: invariants and intent router

1. Recommend directly with `recommend`; inventory tools are for management,
   explicit inventory requests, and onboarding—not a recommendation preflight.
2. For a user correction, show the exact diff, wait for affirmative
   confirmation, then call `upsert_offer` with `trustBasis: user_confirmed`.
3. Record every actual expense through `record_transaction`, including account,
   wallet-balance, and cash funding. Unknown reward does not block recording.
4. Reuse FX only when currency direction, conversion owner/timing, rate type,
   provider or scheme, scope, and freshness are compatible.
5. When external evidence or FX lookup fails, stop retrying; return the known
   result, its estimate/unknown status, and unresolved `requiredActions`.
6. For any returned action, execute only its named MCP tool, then reread the
   returned state. For `recommend` retries preserve the original intent and use
   typed `supplementalFacts` plus `expectedResultVersion`; stale/conflicting
   retries restart instead of being patched by the Agent.
7. For ingestion, resume the existing source scope. An expired action requires
   the new revision returned by MCP; never resend it or create a duplicate draft.

| Intent | First tool | Completion criterion |
|---|---|---|
| Recommend at a merchant | `recommend` | Candidates and every required action are handled or disclosed |
| Resolve a genuinely ambiguous merchant | `resolve_merchant` | One canonical identity is selected by evidence or the user |
| Correct an offer | `upsert_offer` after confirmation | A private immutable rule version is returned |
| Record an expense | `record_transaction` | The actual transaction is durably returned, even if reward is unknown |
| Review transaction history | `list_transactions` | Requested time basis and every bounded page are accounted for |

## Tier 2: high-risk decisions

### Merchant

Send a clear merchant label directly to `recommend`. Use `resolve_merchant`
only for real ambiguity. Present multiple candidates to the user; never choose
one by guessing. If none matches, preserve the unresolved status.

### User correction

Display old value, proposed value, scope, effective period, source, and trust
basis. Treat silence or an unrelated reply as no confirmation. After explicit
confirmation, write a new `user_confirmed` version; never overwrite public or
historical truth.

### Payment route selector

Store the complete evidenced allowlist in `routeSelector`. Let `recommend`
combine it with public capabilities and user-held funding instruments. Do not
persist every generated combination as a durable route.

### FX

Use the compatibility request returned by MCP. Card-scheme rates, bank cash
selling rates, wallet conversion, and DCC are separate contexts. A stale or
generic fallback stays visibly estimated and cannot become an actual settled
rate.

### Transactions

`funding.kind` is `credit_card`, `account`, or `cash`; account subtype carries
linked-bank, wallet-balance, or foreign-currency meaning. Query travel/activity
history by `occurred_at` and ingestion/audit history by `recorded_at`.

## Tier 3: minimal payloads

Recommendation:

```json
{
  "merchant": "唐吉訶德",
  "amount": { "amountMinor": 500000, "currency": "JPY" },
  "country": "JP",
  "occurredAt": "2026-09-14T10:00:00Z"
}
```

Actual cash transaction:

```json
{
  "transaction": {
    "idempotencyKey": "tx-osaka-cash-01",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-14T08:30:00Z",
    "amount": { "amountMinor": 850, "currency": "JPY" },
    "funding": { "kind": "cash" },
    "merchant": "黑門市場小吃"
  }
}
```

Transaction history:

```json
{
  "startDate": "2026-09-10T00:00:00Z",
  "endDate": "2026-09-14T23:59:59Z",
  "timeBasis": "occurred_at",
  "projection": "summary",
  "page": 1,
  "limit": 50
}
```

For correction payloads, FX snapshots, generated routes, event rewards, and
refunds, load the matching workflow from `../workflows/` before calling a tool.
All field schemas remain in the public `tools/list` contract; examples here are
semantic minimal payloads and are not a second schema.
