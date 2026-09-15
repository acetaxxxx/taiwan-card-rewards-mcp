# Example: actual transaction and linked refund

以下只示範 payload shape；`card_illustrative`、reward amount 與 merchant label 不是 production evidence。

## 1. Record actual purchase

使用者確認消費已發生後，以 nested `transaction` 呼叫 `record_transaction`：

```json
{
  "transaction": {
    "idempotencyKey": "purchase-illustrative-20260906",
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-06T14:30:00+08:00",
    "amount": { "amountMinor": 200000, "currency": "TWD" },
    "merchant": "PChome",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  }
}
```

`record_transaction` 只接受 actual transaction，會以 user-scoped rules/evidence
重算並持久化結果。相同 idempotency key + 相同 payload 是 replay；同 key 不同
payload 會 `IDEMPOTENCY_CONFLICT`。回應是 `RewardBreakdown`，不是自訂
`success/transactionId/recordedReward` wrapper。

## 2. Record a partial/full refund

退款金額是正數，並以 `refundOfId` 指向原 purchase 的 idempotency key：

```json
{
  "transaction": {
    "idempotencyKey": "refund-illustrative-20260909",
    "cardId": "card_illustrative",
    "kind": "refund",
    "mode": "actual",
    "occurredAt": "2026-09-09T10:00:00+08:00",
    "amount": { "amountMinor": 200000, "currency": "TWD" },
    "merchant": "PChome",
    "refundOfId": "purchase-illustrative-20260906"
  }
}
```

Server 會驗證原 purchase 存在、card 相同、累計退款不超額，並按比例反轉 reward/cap usage。若要處理 top-up/purchase 的 event relation 或 event-specific campaign，改用 [`workflows/event-reward-and-wallet-eligibility.md`](../workflows/event-reward-and-wallet-eligibility.md) 的 `reverse_event_reward`，不要把兩種 ledger API 混用。

## 3. Agent 回覆界線

只展示實際 MCP 回應中的 reward、cap、status 與 warning。若回應是
`INSUFFICIENT_FACTS`、`NEEDS_REVIEW`、stale 或 invalid refund，說明缺失/衝突
並停止重試；不可用估算值補寫帳本。
