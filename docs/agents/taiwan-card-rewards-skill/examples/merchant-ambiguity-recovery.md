# Example: merchant ambiguity recovery

情境：「Uber」可能是 rides 或 Eats。直接用 merchant-first intent 呼叫
`recommend`：

```json
{
  "merchant": "Uber",
  "amount": { "amountMinor": 50000, "currency": "TWD" },
  "country": "TW",
  "channel": "online",
  "occurredAt": "2026-09-06T15:00:00+08:00"
}
```

若商家名稱對應多個候選，回應的 `requiredActions` 會包含
`{ "id": "merchant", "action": "resolve_merchant", "owner": "user", ... }`。
需要候選清單時呼叫 `resolve_merchant` 的 contract shape：

```json
{ "rawQuery": "Uber", "country": "TW", "market": "transport_or_delivery" }
```

這是 deterministic bounded matching，不是 fuzzy search。若回傳多個候選，
Agent 讓使用者選，再用所選的 canonical merchant identity（例如
`{ "canonicalId": "mch_uber_eats" }`）重跑同一個 `recommend` intent；不自行
建立 `canonicalId` 或宣稱 ranking ready。
