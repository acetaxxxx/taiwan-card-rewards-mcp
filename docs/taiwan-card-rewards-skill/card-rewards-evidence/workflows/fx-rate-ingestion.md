# 外幣特殊匯率登錄標準作業程序 (FX Rate Ingestion SOP)

本 SOP 規範 Agent 在遇到某支付方式採用特定機構的特殊外幣匯率（非標準卡組織匯率）時，如何查詢並將此匯率來源資訊持久化至 MCP，使未來推薦時 MCP 能自動使用正確的匯率來源。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `upsert_payment_capability` | write | 登錄公開可用的支付能力與其 FX 來源設定（任何使用者可用） | `capability.{id, provider, fxPolicy.{sourceUrls, provider, suggestedRateTypes}, evidence}` |
| `upsert_payment_route` | write | 登錄使用者個人支付路徑並指定其匯率查詢來源 | `route.{id, cardId, routeFacts.{fxProvider, fxRateType, fxSourceUrl}, evidence}` |
| `register_payment_account` | write | 首次登錄電子錢包或連結銀行帳戶（登錄路徑前置步驟） | `account.{provider, accountKind, linkedCardId, evidence.confirmedBy}` |
| `recommend` | read | 登錄完成後重試，確認 `fx_missing` 已解決 | `merchant`, `amount`, `expectedResultVersion` |

> [!NOTE]
> 本 SOP 的 `upsert_payment_route` / `upsert_payment_capability` 是**長期設定**（MCP 記憶匯率查詢來源）。
> 只需要當次推薦試算的 FX 快照，請改走 [`payment-route-and-fx.md`](../../card-rewards-recommendation/workflows/payment-route-and-fx.md)。

---


## 1. 觸發條件 (Trigger Conditions)

進入本 SOP 的時機：
- `recommend` 推薦比價時，某支付路徑反覆回傳 `fx_missing` 或 `query_approved_fx_source`，且 `FxResolutionRequest.sourceUrls` 為空（MCP 不知道要去哪裡查）
- 使用者告知：「XX 支付方式的匯率要去 YY 網站查」
- 新增支付路徑或電子錢包，且已知其採用特定銀行的特殊牌告匯率（非卡組織即期匯率）

---

## 2. 情境分類與處置方向

```text
SWITCH 匯率來源的持久化需求:

    CASE "一次性推薦試算" (planned 查詢):
        → 不需要此 SOP，直接遵循 [FX 推薦 SOP](../../card-rewards-recommendation/workflows/payment-route-and-fx.md)
        → 在 recommend 呼叫時直接帶入 fx snapshot 即可

    CASE "支付路徑長期採用特定匯率來源" (需要 MCP 記憶):
        → 進入步驟 3：查詢 + 組裝 + 持久化至 MCP

    CASE "新增電子錢包或支付帳戶，且需要登錄匯率來源設定":
        → 先執行步驟 3，再執行步驟 4（register_payment_account）
```

---

## 3. FX 來源查詢與組裝演算法

```text
// 步驟 1：確認匯率資訊
baseCurrency = 交易外幣（如 JPY、USD、EUR）
quoteCurrency = TWD
rateProvider = 匯率機構名稱（如 "TaishinBank"、"BankOfTaiwan"）
rateType = 匯率類型
    - card_scheme (卡組織即期匯率)
    - spot_selling (即期賣出)
    - cash_selling (現鈔賣出，電子錢包通常使用)
sourceUrl = 匯率查詢網址（如 https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/）

// 步驟 2：前往指定網站查詢目前匯率（由 Agent 使用外部工具執行）
rateQuote = 讀取 sourceUrl 頁面上的即時匯率數值
ratePpm = Math.round(rateQuote * 1_000_000)

// 步驟 3：組裝驗證用 fx snapshot（供 recommend 重試用）
fxSnapshot = {
    id: "fx_<baseCurrency.toLowerCase()>_<quoteCurrency.toLowerCase()>_<provider>",
    baseCurrency: baseCurrency,
    quoteCurrency: quoteCurrency,
    ratePpm: ratePpm,
    capturedAt: 當前 ISO 8601 UTC 時間,
    maxAgeSeconds: 86400,
    provider: rateProvider,
    rateType: rateType,
    sourceUrl: sourceUrl
}
```

---

## 4. 支付路徑匯率來源登錄演算法 (Payment Route FX Source Persistence)

當此匯率來源需要長期記憶在 MCP 中，讓 MCP 的 `fxResolutionRequest` 未來能自動回傳正確的 `sourceUrls`，執行以下步驟：

### 4.1 判斷登錄工具

```text
SWITCH 匯率來源的歸屬層級:

    CASE "公開可用的支付能力設定" (如卡組織匯率、標準銀行牌告):
        → 使用 upsert_payment_capability
        適用: 任何持卡人都可以使用的公開匯率來源設定

    CASE "使用者個人持有的支付路徑設定" (如某錢包綁定特定銀行帳戶的匯率):
        → 使用 upsert_payment_route
        適用: 特定使用者的支付路徑已確認採用特定匯率機構

    CASE "首次登錄電子錢包帳戶（尚未建立 payment account）":
        → 先執行 register_payment_account，再執行 upsert_payment_route
```

### 4.2 `upsert_payment_capability` Payload 範例

（公開支付能力，不含個人帳戶資訊）

```json
{
  "capability": {
    "id": "cap_jkopay_taishin_fx",
    "provider": "JkoPay",
    "displayName": "街口支付（台新銀行現鈔賣出匯率）",
    "supportedCurrencies": ["JPY", "USD", "EUR", "TWD"],
    "fxPolicy": {
      "conversionOwner": "wallet",
      "suggestedRateTypes": ["cash_selling"],
      "sourceUrls": [
        "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
      ],
      "provider": "TaishinBank"
    },
    "evidence": {
      "sourceType": "official",
      "sourceUrl": "https://www.jkopay.com/policy/exchange-rate",
      "observedAt": "2026-09-17T00:00:00Z",
      "summary": "街口跨境掃碼採用台新銀行即時現鈔賣出牌告匯率"
    }
  }
}
```

### 4.3 `upsert_payment_route` Payload 範例

（使用者個人支付路徑，含 FX 來源設定）

```json
{
  "route": {
    "id": "route_<使用者卡ID>_jkopay_jp",
    "cardId": "taishin_gogo",
    "walletProvider": "JkoPay",
    "market": "JP",
    "routeFacts": {
      "conversionOwner": "wallet",
      "fxProvider": "TaishinBank",
      "fxRateType": "cash_selling",
      "fxSourceUrl": "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
    },
    "evidence": {
      "sourceType": "official",
      "sourceUrl": "https://www.jkopay.com/policy/exchange-rate",
      "observedAt": "2026-09-17T00:00:00Z",
      "confirmedBy": "user_explicit_statement"
    }
  }
}
```

### 4.4 `register_payment_account` Payload 範例

（首次登錄電子錢包帳戶）

```json
{
  "account": {
    "id": "acct_jkopay_main",
    "provider": "JkoPay",
    "accountKind": "wallet",
    "linkedCardId": "taishin_gogo",
    "evidence": {
      "sourceType": "user_input",
      "confirmedBy": "user_explicit_statement",
      "confirmedAtUtc": "2026-09-17T01:00:00Z"
    }
  }
}
```

---

## 5. 登錄後的驗證步驟

```text
// 步驟 1：用剛組裝的 fxSnapshot 重試 recommend 確認是否解決
recommend({
    ...原始 intent,
    fx: fxSnapshot,
    expectedResultVersion: response.resultVersion
})

// 步驟 2：確認 recommend 的 fxResolutionRequest 中是否已出現正確的 sourceUrls
// 若 MCP 已記憶此 payment route 的 fxPolicy，後續呼叫將自動帶入 sourceUrls

// 步驟 3：回報使用者匯率登錄摘要
回報：「已為您將 [支付方式] 的外幣匯率來源設定為 [機構名稱]（[rateType] 匯率）。
       未來在此支付路徑的外幣比價將自動使用此匯率來源。」
```

---

## 6. 防呆原則 (Guardrails)

1. **拒絕硬編碼匯率**：永遠不要把特定數值匯率（如 0.2093）直接硬寫入 `routeFacts`；只記錄查詢來源，不記錄當下數值。
2. **凍結 vs 長期記憶的差異**：`fx` snapshot 只用於當次 `recommend` 重試（一次性信任）；`upsert_payment_route` 的 `fxPolicy` 是告訴 MCP「這個路徑用哪裡的匯率查」的長期設定。
3. **嚴禁 mid_market 用於 actual 入帳**：`rateType: "mid_market"` 只允許用於 `planned` 試算推薦，不可用於 `record_transaction` 等實際入帳工具。
4. **敏感帳戶資訊禁區**：`register_payment_account` 不可填入帳號、卡號、密碼等敏感欄位。
