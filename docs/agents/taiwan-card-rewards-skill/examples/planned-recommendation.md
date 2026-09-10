# Example: planned card recommendation (legacy transaction branch)

For the normal merchant-first entry, use [`workflows/recommendation-intent.md`](../workflows/recommendation-intent.md); this example remains a compatibility shape.

這是 card branch 的合法骨架。`card_illustrative` 與回應數字都是 illustrative；Agent 必須先以 `list_cards` 確認使用者實際持有的 opaque card ID，並以 MCP 回應為準，不自行計算回饋。

## 1. Preflight

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "merchant": "momo購物網",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  },
  "context": { "now": "2026-09-06T07:00:00Z" }
}
```

若回應含 stale、unknown、needs_review 或 required action，Agent 先完成 research/clarification，不直接展示確定回饋。

## 2. Recommend

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "merchant": "momo購物網",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  },
  "limit": 3,
  "page": 1,
  "projection": "detail"
}
```

實際回應是 bounded ranking entries（陣列），欄位依 source contract 的
`RankingEntry` 為準。例如 Agent 可呈現：

```json
[
  {
    "cardId": "card_illustrative",
    "status": "ok",
    "grossReward": { "amountMinor": 9000, "currency": "TWD" },
    "cappedReward": { "amountMinor": 9000, "currency": "TWD" },
    "components": [],
    "unknownReasons": []
  }
]
```

上面數值與 component 為 shape-only，不能假裝已從銀行條款驗證。planned call 不消耗 cap、不寫 transaction ledger；實際消費應另以 `record_transaction` actual payload 記錄。
