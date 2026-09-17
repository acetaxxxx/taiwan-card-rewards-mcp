# Example: Gold evidence and fail-closed recovery

這個範例刻意把「Gold 是資格 fact」與「支付 path 節點」分開。所有 ID、
URL、rate 與 reward 數字都是 illustrative；需由 Agent 從銀行/合作方官方
頁面取得並核對期間。未驗證的銀行、wallet、sidecar 或 Chromium 路徑不會因
這份文件變成 supported。

## 1. Gold authoritative evidence

Agent 在 MCP 外取得官方 Gold 條款後，至少保留：

```text
evidenceId: ev_gold_official_illustrative
sourceType: official
authority: issuer (or the explicitly named provider)
reviewState: accepted
sourceUrl: https://official.example.invalid/gold-terms
contentHash: sha256:illustrative
observedAt: 2026-09-06T07:00:00Z
validTo: 2026-12-31T23:59:59Z
claim: { factKey: "user.membership", value: "gold", version: "terms-1" }
```

Agent 應先走 evidence/research 流程，將官方 snapshot/rule 交給 `upsert_offer`。
Eligibility fact（例如 Gold 會員資格）本身是 self-asserted：只要 Agent 提供
`factKey`/`value`（見下），系統直接信任並用來評估 predicate，不需要另外呼叫
任何 evidence 提交 tool 先行核准——現行 28-tool public surface 也沒有這種
tool，不能在文件中假裝它存在。同一個 `factKey`（同一張卡）出現兩個不同的
`value` 會被視為衝突並導致 `needs_review`，這是唯一剩下的內建保護。

## 2. Card predicate 用 eligibility fact

`recommend` 的 merchant-first intent 直接支援頂層 `eligibilityFacts`（亦可在 `supplementalFacts.eligibilityFacts` 提供）；若需要對單一 rule 進行純試算，亦可改用 `calculate_reward`（接受完整 `context.eligibilityFacts`）：

### A. 使用 `recommend` 提供 eligibility fact

```json
{
  "merchant": "示例商家",
  "amount": { "amountMinor": 100000, "currency": "TWD" },
  "country": "TW",
  "channel": "online",
  "paymentMethod": "direct_card",
  "eligibilityFacts": [
    {
      "id": "fact_gold_illustrative",
      "version": "terms-1",
      "cardId": "card_illustrative",
      "factKey": "user.membership",
      "value": "gold",
      "validFrom": "2026-01-01T00:00:00Z",
      "validTo": "2026-12-31T23:59:59Z"
    }
  ],
  "limit": 10
}
```

### B. 使用 `calculate_reward` 精確控制單一 rule 試算

```json
{
  "rule": { "...": "the offer rule with a predicate keyed on user.membership" },
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 100000, "currency": "TWD" },
    "merchant": "merchant_illustrative",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  },
  "context": {
    "now": "2026-09-06T07:00:00Z",
    "eligibilityFacts": [
      {
        "id": "fact_gold_illustrative",
        "version": "terms-1",
        "cardId": "card_illustrative",
        "factKey": "user.membership",
        "value": "gold",
        "validFrom": "2026-01-01T00:00:00Z",
        "validTo": "2026-12-31T23:59:59Z"
      }
    ],
    "capPools": [
      {
        "id": "cap_gold_illustrative",
        "name": "Gold campaign cap",
        "metric": "reward",
        "period": "calendar_month",
        "limit": 500000,
        "currency": "TWD",
        "timezone": "Asia/Taipei"
      }
    ]
  }
}
```

若 rule 沒有明確 predicate/combination/cap，或 fact 已過期，MCP 應回
unknown/needs_review，而不是把 Gold bonus 當成 guaranteed。

## 3. Payment-path stacking 與 eligibility fact

`recommend` 內部在進行 payment-path stacking prerequisite 判斷時，支援相同的
`eligibilityFacts` 機制，一樣是直接信任自報 facts、不需要先行提交 evidence。
在呼叫公開 `recommend` 工具時，可在頂層 `eligibilityFacts` 傳入包含 `factKey`、`value`、
`validFrom`、`validTo` 的條款事實陣列（例如 Gold 會員身份）。同一個 `factKey`（同一張卡）
不可提供互相衝突的數值，否則整體回報 `needs_review`。若未提供必要 fact，路徑評估
會 fail-closed 回傳 `needs_review` 或 `blocked`，要求補件；不要移除 fact 後聲稱 Gold 已判定。

## 4. Valuation、FX 與 fee 的 fail-closed recovery

### Missing reward valuation

若 route reward 是 native `points`，要排序成 TWD `netValue` 必須有 user-owned
accepted official valuation claim，例如：

```text
nativeUnit: issuer_points
rateNumerator: 1
rateDenominator: 1
targetCurrency: TWD
asOf: 2026-09-06T00:00:00Z
version: valuation-terms-1
evidenceId: ev_valuation_official_illustrative
```

目前 public 28-tool surface 沒有提交此 valuation snapshot 的工具；若 durable
store 也沒有已驗證 snapshot，payment-path candidate 必須帶
`requiredActions: ["provide a validated valuation snapshot for each reward unit"]`
並為 `blocked`/`needs_review`。Agent 不可用「1 point = NT$1」臆測。

### Missing FX or fee conversion

若 event fee 是 JPY、reward/net 要比較 TWD，缺 FX 時 candidate blocked。補齊
官方/指定 provider quote 後，`fx` 必須包含完整欄位：

```json
{
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
}
```

同時要在 transaction/route edge 提供 fee、markup、foreignTransactionFee 或
selected DCC 的明確 currency。若費用 currency 仍不能用該 event 的 FX
換算，`feeTotal` 與 `netValue` 應維持 undefined，回應 recovery action；不以
零費用或 1:1 fallback 排序。

## 5. Recovery checklist

| Blocker | 補救 | 可完成標準 |
|---|---|---|
| Gold fact missing/stale/conflicting | 重新確認官方條款後，直接以正確的 `factKey`/`value` 重新提供 | server 能重算 predicate，status 不再 unknown |
| payment-path eligibility fact 缺失或衝突 | 在 `recommend` 頂層 `eligibilityFacts` 直接提供一致的自報 facts | server 能驗證 stacking prerequisite，不再 fail-closed |
| native valuation missing | 提供已接受的 official valuation snapshot（目前缺 public tool） | reward units 可轉到比較 currency |
| FX/fee missing | 提供完整 `fx` 快照與費用來源、期間、currency | `feeTotal`/`netValue` 可重算 |
| stacking/cap ambiguous | 提交條款明示的 combination mode、group、cap pool | additive/replace/best_of 等決策可重現 |

直到所有 blockers 解決，Agent 只能報告 blocked/needs_review；這是預期的
fail-closed 行為，不是「零回饋」結論。
