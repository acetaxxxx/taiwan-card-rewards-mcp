# Example: planned card recommendation

For the normal merchant-first entry, use [`workflows/recommendation-intent.md`](../workflows/recommendation-intent.md).

這是 merchant-first intent 的合法骨架。`card_illustrative` 與回應數字都是 illustrative；Agent 以 MCP 回應為準，不自行計算回饋。`cardIds` 是選填的縮小條件，只有使用者明確要求限制卡片時才加上。

## 1. Call `recommend`

```json
{
  "merchant": "momo購物網",
  "amount": { "amountMinor": 300000, "currency": "TWD" },
  "country": "TW",
  "channel": "online",
  "occurredAt": "2026-09-06T15:00:00+08:00",
  "limit": 3
}
```

若回應含 stale、unknown、needs_review 或 required action，Agent 先完成 research/clarification，不直接展示確定回饋。

## 2. Response shape

實際回應是 `{status, candidates, requiredActions, coverage, ...}`；`candidates[]` 每筆有 `kind`（`direct_card` 或 `payment_path`）、`status`、`matchedRules`。例如：

```json
{
  "status": "ready",
  "candidates": [
    {
      "id": "card:card_illustrative",
      "kind": "direct_card",
      "cardId": "card_illustrative",
      "status": "ready",
      "reward": { "amountMinor": 9000, "currency": "TWD" },
      "matchedRules": []
    }
  ],
  "requiredActions": [],
  "coverage": { "scope": "registered cards and payment routes; route acceptance requires evidence", "discoveredCount": 1, "bounded": false, "explorationComplete": true, "total": 1, "notes": [] }
}
```

上面數值與欄位為 shape-only，不能假裝已從銀行條款驗證。planned call 不消耗 cap、不寫 transaction ledger；實際消費應另以 `record_transaction` actual payload 記錄。
