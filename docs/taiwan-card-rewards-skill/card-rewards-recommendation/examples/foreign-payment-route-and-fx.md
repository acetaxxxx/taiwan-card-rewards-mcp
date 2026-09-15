# Example: foreign card payment and FX

情境：使用者在日本實體商店用已登記的 JCB card（可能透過 Apple Pay）支付
¥20,000。`card_illustrative`、rate、merchant 與 fee 都是 illustrative；
Apple Pay/PayPay/其他 route 是否適用，仍需各自的官方 evidence。

## 1. Preflight with the real transaction shape

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T17:00:00+08:00",
    "amount": { "amountMinor": 2000000, "currency": "JPY" },
    "merchant": "Bic Camera",
    "country": "JP",
    "channel": "in_store",
    "paymentMethod": "apple_pay"
  },
  "context": { "now": "2026-09-06T09:00:00Z" }
}
```

若缺 FX/route/offer facts，回應會含 `ready: false`、diagnostics 與
`requiredActions`。diagnostic 的實際文字以 MCP 回應為準，文件不捏造 error code。

## 2. Agent supplies a validated FX snapshot

Agent 先依實際 conversion owner 查核官方或指定 provider source；不可把
銀行牌告套給 wallet/DCC，也不可預設海外手續費。示意 1 JPY = 0.2152 TWD：

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T17:00:00+08:00",
    "amount": { "amountMinor": 2000000, "currency": "JPY" },
    "merchant": "Bic Camera",
    "country": "JP",
    "channel": "in_store",
    "paymentMethod": "apple_pay",
    "fx": {
      "id": "fx_jpy_twd_illustrative",
      "baseCurrency": "JPY",
      "quoteCurrency": "TWD",
      "ratePpm": 215200,
      "capturedAt": "2026-09-06T12:00:00Z",
      "maxAgeSeconds": 86400,
      "provider": "official-provider-illustrative",
      "rateType": "card_scheme",
      "sourceUrl": "https://official.example.invalid/fx",
      "contentHash": "sha256:illustrative"
    },
    "routeContext": {
      "transactionCurrency": "JPY",
      "settlementCurrency": "TWD",
      "billingCurrency": "TWD",
      "acceptanceProviderId": "acceptance_illustrative",
      "consumerAppId": "apple_pay",
      "cardNetwork": "JCB",
      "issuer": "issuer_illustrative",
      "fundingSource": "credit_card",
      "conversionOwner": "card_network",
      "conversionTiming": "clearing",
      "foreignTransactionFee": { "amountMinor": 6450, "currency": "TWD" },
      "dcc": false
    }
  },
  "context": { "now": "2026-09-06T09:00:00Z" }
}
```

若 fee currency 或 rate 不可驗證，preflight/recommend 維持 unknown/stale；
Agent 不應自動扣 1.5%。

## 3. Recommend after recovery

以同一 nested transaction 呼叫 `recommend`，並標示為 planned。MCP 會回
bounded ranking entries；折合金額、fee、capped reward 與 status 只可引用
實際回應。外幣 payment path 若需要多個 event，改用
`kind="payment_path"` branch，不把 wallet top-up 當成 direct card purchase。
