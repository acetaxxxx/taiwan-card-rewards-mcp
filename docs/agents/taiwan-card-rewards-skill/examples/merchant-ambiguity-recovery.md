# Example: merchant ambiguity recovery

情境：「Uber」可能是 rides 或 Eats。先用合法 nested transaction 呼叫
`recommendation_preflight`：

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 50000, "currency": "TWD" },
    "merchant": "Uber",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  }
}
```

若 diagnostics 要求 merchant facts，呼叫 `resolve_merchant` 的 contract shape：

```json
{ "rawQuery": "Uber", "country": "TW", "market": "transport_or_delivery" }
```

這是 deterministic bounded matching，不是 fuzzy search。若回傳多個候選，
Agent 讓使用者選，再用所選的 canonical merchant identity/confirmed facts
重跑 preflight；不自行建立 `merchantId` 或宣稱 ranking ready。
