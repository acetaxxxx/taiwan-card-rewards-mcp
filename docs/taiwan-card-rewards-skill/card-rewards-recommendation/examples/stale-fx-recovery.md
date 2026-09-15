# Example: stale FX recovery

情境：日本 Bic Camera ¥15,000 的 planned card payment 使用過期匯率。以下
ID/URL 是 illustrative，不代表任何實際 provider。

## 1. Detect stale or missing FX

```json
{
  "merchant": "Bic Camera",
  "amount": { "amountMinor": 1500000, "currency": "JPY" },
  "country": "JP",
  "channel": "in_store",
  "occurredAt": "2026-09-06T17:00:00+08:00"
}
```

若 `recommend` 回應的某個 candidate 缺 FX 或匯率已超過新鮮度視窗，該 candidate
的 `status` 會是 `unknown`/`blocked`，並在 `requiredActions` 附上
`action: "query_approved_fx_source"` 與對應的 `fxResolutionRequest`。Agent 不能
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

## 3. Re-run with the refreshed fx snapshot

把該 object 放入同一個 intent 的 `fx` 欄位（不是 `fxSnapshot`，也不是
`quotedAt`），保留原本的 merchant/amount/country/channel/occurredAt，再重跑
`recommend`：

```json
{
  "merchant": "Bic Camera",
  "amount": { "amountMinor": 1500000, "currency": "JPY" },
  "country": "JP",
  "channel": "in_store",
  "occurredAt": "2026-09-06T17:00:00+08:00",
  "fx": {
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
}
```

`fx` 一旦通過幣別配對與新鮮度檢查即被直接信任套用，沒有中間的儲存或核准
步驟。若相關 candidate 仍是 `unknown`/`blocked`，保留該狀態並回報來源查證
失敗；只轉述 MCP 回傳的 reward/cap/fee，不自行假設 ready。
