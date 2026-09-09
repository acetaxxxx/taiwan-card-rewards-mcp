# Example: stale FX recovery

情境：日本 Bic Camera ¥15,000 的 planned card payment 使用過期匯率。以下
ID/URL 是 illustrative，不代表任何實際 provider。

## 1. Detect stale or missing FX

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T17:00:00+08:00",
    "amount": { "amountMinor": 1500000, "currency": "JPY" },
    "merchant": "Bic Camera",
    "country": "JP",
    "channel": "in_store",
    "paymentMethod": "direct_card"
  }
}
```

`recommendation_preflight` 的實際回應若顯示 missing/stale FX，Agent 不能
自行用 1:1 或固定費用繼續。

## 2. Refresh outside MCP

Agent 查證實際 route 的 conversion owner、rateType、capturedAt、有效期間與
fee。示意 rate 1 JPY = 0.2150 TWD（`ratePpm: 215000`）：

```json
{
  "id": "fx_jpy_twd_refresh_illustrative",
  "baseCurrency": "JPY",
  "quoteCurrency": "TWD",
  "ratePpm": 215000,
  "capturedAt": "2026-09-06T12:00:00Z",
  "maxAgeSeconds": 86400,
  "provider": "official-provider-illustrative",
  "rateType": "card_scheme",
  "sourceUrl": "https://official.example.invalid/fx",
  "contentHash": "sha256:illustrative"
}
```

把該 object 放入合法 transaction 的 `fx` 欄位（不是 `fxSnapshot`，也不是
`quotedAt`），並補齊 country/channel/paymentMethod/routeContext。

## 3. Re-run and stop if unresolved

用更新後的 nested `transaction` 重跑 `recommendation_preflight`，ready 只在
MCP 判斷所有必要 facts valid 時成立；否則保留 stale/unknown 與 required
actions。只有 ready 後才呼叫 `recommend`，且只轉述 MCP 的 reward/cap/fee。
