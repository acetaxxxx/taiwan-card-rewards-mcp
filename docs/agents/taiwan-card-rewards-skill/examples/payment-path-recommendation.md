# Example: multi-layer payment-path recommendation

這是一個「帳戶/卡 → wallet → acceptance network → merchant」的完整模型範例。
所有 `*_illustrative` IDs 與 `official.example.invalid` 都是文件測試值，不是
真實銀行、PayPay、sidecar 或 Chromium 路徑的證明。真正 route 只有在 Agent
取得官方 HTTPS evidence、使用者確認、並由 MCP 接受後才可進 production candidate。

## 1. 先建立可引用的 account identity

不把帳戶號碼、PAN、credential 存入 MCP：

```json
{
  "account": {
    "providerId": "wallet_illustrative",
    "kind": "wallet_balance",
    "displayName": "Wallet balance (illustrative)",
    "status": "active",
    "observedAt": "2026-09-06T07:00:00Z",
    "evidenceIds": ["ev_official_illustrative"],
    "confirmation": { "confirmedAt": "2026-09-06T07:05:00Z", "confirmedBy": "user" },
    "idempotencyKey": "account-wallet-illustrative"
  }
}
```

這個 object 作為 `register_payment_account` 的 arguments。Agent 同樣以
`list_payment_accounts`、`list_payment_routes` 先讀 current-user scope。

## 2. 登記一條官方證據 route graph

此 route 以 linked bank account funding 為例；另一個獨立 candidate 可使用
信用卡儲值：

```json
{
  "funding": { "kind": "credit_card", "cardId": "card_illustrative" },
  "nodes": [
    { "id": "source", "kind": "funding_source", "displayName": "Registered card" },
    { "id": "wallet", "kind": "wallet_balance", "displayName": "Wallet balance" },
    { "id": "acceptance", "kind": "acceptance_network", "displayName": "Acceptance network" },
    { "id": "merchant", "kind": "merchant", "displayName": "Merchant" }
  ],
  "edges": [
    { "edgeId": "card-topup", "fromNodeId": "source", "toNodeId": "wallet", "transition": "wallet_top_up", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound" },
    { "edgeId": "wallet-to-acceptance", "fromNodeId": "wallet", "toNodeId": "acceptance", "transition": "wallet_debit", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound" },
    { "edgeId": "settlement", "fromNodeId": "acceptance", "toNodeId": "merchant", "transition": "merchant_settlement", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound" }
  ]
}
```

這是第二個 route descriptor 的欄位片段，仍需自己的 idempotency key、
confirmation、source URL 與 accepted official evidence。不能把兩種 funding
混在一個 route，也不能替 fungible wallet balance 自動挑來源。

```json
{
  "route": {
    "status": "active",
    "layers": [
      { "kind": "wallet", "providerId": "wallet_illustrative", "displayName": "Wallet", "evidenceIds": ["ev_official_illustrative"] },
      { "kind": "merchant_acceptance", "providerId": "acceptance_illustrative", "displayName": "Acceptance network", "evidenceIds": ["ev_official_illustrative"] }
    ],
    "funding": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" },
    "observedAt": "2026-09-06T07:00:00Z",
    "sourceUrl": "https://official.example.invalid/route-terms",
    "authority": "official-provider",
    "confidence": "high",
    "evidenceIds": ["ev_official_illustrative"],
    "confirmation": { "confirmedAt": "2026-09-06T07:05:00Z", "confirmedBy": "user" },
    "nodes": [
      { "id": "source", "kind": "funding_source", "displayName": "Linked bank account" },
      { "id": "wallet", "kind": "wallet_balance", "displayName": "Wallet balance" },
      { "id": "acceptance", "kind": "acceptance_network", "displayName": "Acceptance network" },
      { "id": "merchant", "kind": "merchant", "displayName": "Merchant" }
    ],
    "edges": [
      { "edgeId": "debit", "fromNodeId": "source", "toNodeId": "wallet", "transition": "account_debit", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound", "currency": "TWD" },
      { "edgeId": "wallet-to-acceptance", "fromNodeId": "wallet", "toNodeId": "acceptance", "transition": "wallet_debit", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound", "currency": "TWD" },
      { "edgeId": "settlement", "fromNodeId": "acceptance", "toNodeId": "merchant", "transition": "merchant_settlement", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound", "currency": "TWD" }
    ],
    "idempotencyKey": "route-bank-wallet-merchant-illustrative"
  }
}
```

Agent calls this as `upsert_payment_route`. The production service requires
accepted official evidence and does not accept `model_fixture` edges. A route
graph alone cannot prove reward eligibility, balance allocation, member status,
fee, FX, or that a named product actually supports this path.

## 3. Ask for bounded candidate paths

There is no separate payment-path tool. Call `recommend` with the normal
merchant-first intent, optionally narrowing to a specific route:

```json
{
  "merchant": "merchant_illustrative",
  "amount": { "amountMinor": 10000, "currency": "TWD" },
  "country": "TW",
  "channel": "online",
  "paymentMethod": "wallet_balance",
  "routeIds": ["route_bank_wallet_merchant_illustrative"],
  "limit": 20
}
```

The response's `candidates[]` mixes `direct_card` and `payment_path` entries in
one ranked list; filter for `kind === "payment_path"` to isolate route-based
candidates. `maxHops`/`maxEvents`/`maxBranchesPerNode` graph-search bounds and
`eligibilityFacts` (for stacking prerequisites, e.g. a Gold-membership fact)
are internal parameters of the underlying path engine but are not yet exposed
on `recommend`'s public intent schema — a caller needing to supply a stacking
eligibility fact through the public MCP surface currently cannot; report
`needs_review`/blocked instead of claiming membership was evaluated.

## 4. Expected planned candidate (shape and uncertainty)

A verified route can produce a `payment_path` candidate with two planned events,
returned inside `recommend`'s unified `candidates[]`:

```json
{
  "status": "partial",
  "candidates": [
    {
      "id": "path:illustrative",
      "kind": "payment_path",
      "routeId": "route_bank_wallet_merchant_illustrative",
      "fundingSource": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" },
      "nodes": [],
      "events": [
        {
          "planEventId": "plan:debit",
          "kind": "top_up",
          "fromNodeId": "source",
          "toNodeId": "wallet",
          "transition": "account_debit",
          "routeEdgeIds": ["debit"],
          "evidenceIds": ["ev_official_illustrative"],
          "provenance": "official",
          "eligibility": { "status": "unknown", "reasons": ["top-up amount policy is not evidenced"] },
          "relations": [
            { "type": "planned_precedes", "eventId": "plan:settlement" },
            { "type": "planned_enables", "eventId": "plan:settlement" }
          ]
        },
        {
          "planEventId": "plan:settlement",
          "kind": "purchase",
          "fromNodeId": "acceptance",
          "toNodeId": "merchant",
          "amount": { "amountMinor": 10000, "currency": "TWD" },
          "transition": "merchant_settlement",
          "routeEdgeIds": ["settlement"],
          "evidenceIds": ["ev_official_illustrative"],
          "provenance": "official"
        }
      ],
      "matchedRules": [],
      "exclusionReasons": ["top-up amount and event eligibility remain unknown"],
      "status": "blocked"
    }
  ],
  "requiredActions": [],
  "coverage": { "scope": "registered cards and payment routes; route acceptance requires evidence", "discoveredCount": 1, "bounded": false, "explorationComplete": true, "total": 1, "notes": [] }
}
```

This shape illustrates the fail-closed outcome. In a fully evidenced case the
response may be `ok`/`ready`, include rule components and explicit cap previews,
and rank multiple candidates by net value, capped/gross reward, fee, evidence
tier/freshness, user effort, then stable ID. Do not infer FIFO/LIFO allocation
from a mixed wallet. Explicit stacking must say `additive`, `replace`,
`best_of`, `exclusive`, or `prerequisite`; otherwise candidate stays blocked. A
ready `matchedRules[]` entry can carry `capUses[]` with `poolId`, `grossAmount`,
and `cappedAmount`; the candidate's `cappedReward` is the post-policy total, not
an extra reward to add again. Shared cap pools and same-sponsor combinations are
applied according to the stored policy only.

## 5. Planned versus actual

The path response is a plan only: it does not write event ledger records or
consume caps. After a real top-up and purchase, record separate actual events
with `record_event_reward` only when the terms prove the event-local rule or
explicit `funded_by` chain. If the wallet has multiple possible sources, ask for
evidence rather than recording both rewards.
