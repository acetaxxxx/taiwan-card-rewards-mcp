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

若條款是使用者自己的 status，而非公開 issuer/provider claim，不能升級成
authoritative。Agent 應先走 evidence/research 流程，將官方 snapshot/rule
交給 `upsert_offer`，並在需要時由 runtime 的 evidence ingestion API 建立
user-owned accepted evidence。現行 public 25-tool surface 沒有獨立的
`submit_evidence` 或 `submit_valuation_snapshot` tool，不能在文件中假裝它們
存在。

## 2. 使用 Gold fact 做 card recommendation

卡片 branch 的 `recommend` 可將合法 `eligibilityFacts` 放在 `context`；fact
必須指向該 user/卡片 scope 的 accepted official evidence，不能只傳字串
`"gold"`：

```json
{
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
        "evidenceId": "ev_gold_official_illustrative",
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
  },
  "limit": 3,
  "projection": "detail"
}
```

這個 card branch payload 只表示 contract shape。若 Gold evidence 未被現行
store 接受、已過期、跨 user 或 rule 沒有明確 predicate/combination/cap，
MCP 應回 unknown/needs_review，而不是把 Gold bonus 當成 guaranteed。

## 3. Payment-path Gold parity gap

`recommend` 的 payment_path source schema 也定義 `eligibilityFacts`，但目前
`cli.ts` 的 payment_path allowlist 未轉送它；因此下列需求在 public CLI 是
明確 blocked，不能宣稱已完成：

```json
{
  "kind": "payment_path",
  "payment_path": {
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "routeIds": ["route_illustrative"],
    "eligibilityFacts": [
      {
        "evidenceId": "ev_gold_official_illustrative",
        "version": "terms-1",
        "cardId": "card_illustrative",
        "factKey": "user.membership",
        "value": "gold"
      }
    ]
  }
}
```

在 runtime parity 修復前，Agent 應回報 `eligibilityFacts` forwarding gap，
改走可支援的 card branch 或等待 runtime 更新；不要移除 fact 後聲稱 Gold
已判定。

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

目前 public 25-tool surface 沒有提交此 valuation snapshot 的工具；若 durable
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
| Gold fact missing/stale | 重新取得官方 evidence，確認 user/card scope 與有效期 | server 能重算 predicate，status 不再 unknown |
| payment_path CLI parity | 修 runtime forwarding，再跑 contract/route tests | `eligibilityFacts` 不再被 unknown-field 丟棄 |
| native valuation missing | 提供已接受的 official valuation snapshot（目前缺 public tool） | reward units 可轉到比較 currency |
| FX/fee missing | 提供完整 FX 與費用來源、期間、currency | `feeTotal`/`netValue` 可重算 |
| stacking/cap ambiguous | 提交條款明示的 combination mode、group、cap pool | additive/replace/best_of 等決策可重現 |

直到所有 blockers 解決，Agent 只能報告 blocked/needs_review；這是預期的
fail-closed 行為，不是「零回饋」結論。
