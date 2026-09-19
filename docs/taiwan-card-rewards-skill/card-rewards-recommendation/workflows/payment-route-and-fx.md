# 外幣匯率查詢與組裝標準作業程序 (Payment Route & FX SOP)

本標準作業程序規範 Agent 在推薦比價流程中處理外幣換匯時的查詢原則、PPM 計算與快照組裝。

> [!IMPORTANT]
> **架構原則（核心零直接網路 I/O 與失敗即關閉 Fail-Closed）**：
> MCP 核心遵循「零直接網路 I/O」與「失敗即關閉 (Fail-Closed)」原則，內部絕不自行發起外聯網路請求抓取匯率。
> 當交易缺少外幣匯率快照時，MCP 將阻斷推薦並在 `requiredActions` 回傳 `action: "query_approved_fx_source"` 及結構化 `FxResolutionRequest`。
> Agent 必須於外部查詢核准來源，組裝 typed `fx` snapshot 後重新調用 `recommend`。實際入帳交易後，採納之匯率將固化為 `AppliedFxRate`。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `recommend` | read | 消費前比價（預設無須帶 `fx`，系統自動估算各路徑；重試特定路徑時可帶入 `routeFacts`） | `merchant`, `amount` (必填)；重試時：`routeFacts`, `expectedResultVersion` |

> [!NOTE]
> 外幣推薦**預設無須在頂層傳入單一 `fx` 物件**！系統內部會為直接刷卡與跨境電子錢包分別採用適當的牌告匯率試算實質淨回饋。
> 唯有當系統回傳 `requiredActions` 要求補充特定路徑的事實時，才於重試時透過 `routeFacts: [{ routeId, fx }]` 陣列提供該路徑專屬匯率。
> 詳細工具 Property 結構與 JSON 骨架，請參考 [推薦專屬工具規格](recommendation-tools-specification.md)。

---


## 1. 觸發條件 (Trigger Conditions)

當調用 `recommend` 回傳滿足下列條件之一時，進入本 SOP：
- `response.status === 'needs_input'` 或 `'partial'`
- `requiredActions` 包含 `action === 'query_approved_fx_source'`
- 診斷代碼 (`diagnostic.code`) 為 `fx_missing`、`fx_stale`、`fx_pair_mismatch` 或 `fx_scope_mismatch`

---

## 2. 處置流程演算法 (Agent Resolution Algorithm)

```text
// 步驟 1：解析指示
request = action.fxResolutionRequest
baseCurrency = request.baseCurrency    // 外幣代碼 (如 JPY, USD, EUR)
quoteCurrency = request.quoteCurrency  // 結算幣別 (固定 TWD)
sourceUrls = request.sourceUrls        // MCP 指定之核准查詢網址清單

// 步驟 2：獲取合格報價 (Pricing Rules)
IF (sourceUrls 存在且非空):
    // 優先使用 MCP 指定網址 (Mandatory Priority)
    targetUrl = sourceUrls[0]
    rateQuote = 透過外部工具 (如 web_search 或 read_url) 讀取 targetUrl 的即時匯率
ELSE:
    // 依 conversionOwner 判定定價軌道與來源
    SWITCH request.conversionOwner:
        CASE 'card_scheme': // 實體卡、Apple Pay / Google Pay 直刷
            rateType = 'spot_selling' // 或 card_scheme
            targetUrl = "https://rate.bot.com.tw/xrt?Lang=zh-TW" // 臺灣銀行牌告即期賣出中價
        CASE 'wallet': // 街口、台新Pay+ 掃日本 PayPay (HIVEX)
            rateType = 'cash_selling' // 🚨 警告：必須走合作銀行「現鈔賣出牌告價」
            targetUrl = "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
        CASE 'issuer': // 銀行結匯、雙幣卡
            rateType = 'cash_selling'
            targetUrl = 發卡銀行牌告現鈔賣出價
    rateQuote = 查詢 targetUrl 對應之 rateType 牌告匯率

// 步驟 3：組裝快照並重新調用（直接填入牌告自然匯率，MCP 會自動換算 PPM）
fxSnapshot = {
    id: "fx_quote_" + baseCurrency.toLowerCase() + "_" + quoteCurrency.toLowerCase(),
    baseCurrency: baseCurrency,
    quoteCurrency: quoteCurrency,
    rate: rateQuote, // 直接填入畫面上看到的牌告匯率（例如 0.215 或 32.5），無需手動乘 1,000,000
    capturedAt: 當前 ISO 8601 UTC 時間,
    maxAgeSeconds: 86400,
    provider: 報價機構名稱 (例如 "JCB", "BankOfTaiwan", "TaishinBank"),
    rateType: rateType,
    sourceUrl: targetUrl
}

recommend({
    ...原始 intent 參數,
    fx: fxSnapshot,
    expectedResultVersion: response.resultVersion
})
```

---

## 3. 定價軌道與主體矩陣 (Pricing Matrix)

| 通路清算軌道 | 換匯主體 (`conversionOwner`) | 匯率類型 (`rateType`) | 合格來源與定價原則 |
|---|---|---|---|
| **實體卡 / Apple Pay / Google Pay** | `card_scheme` | `card_scheme` / `spot_selling` | 走國際卡組織即期賣出中價（臺灣銀行牌告即期賣出 `https://rate.bot.com.tw/xrt?Lang=zh-TW`）。試算推薦 (`planned`) 允許參考 `mid_market`，但實際入帳交易嚴禁 `mid_market`。 |
| **跨境電子錢包 (街口 / 台新Pay+ 掃 PayPay)** | `wallet` | `cash_selling` | **走合作銀行現鈔賣出牌告價**（台新即時外幣牌告 `https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/`）。 |
| **發卡行直接結匯 / 雙幣卡** | `issuer` | `cash_selling` | 發卡行官方當日現鈔賣出牌告價。 |

> [!WARNING]
> **🚨 跨境雙軌匯差防呆注意清單**：
> 跨境電子錢包採用「銀行現鈔賣出價」，通常較國際信用卡即期中價貴 **1.8%~2.3%**。
> 若名目回饋僅多 0.5%~1%，扣除匯差成本後實質淨回饋反而落後信用卡。Agent 在輸出推薦時，應主動提醒使用者實質淨回饋差異。

---

## 4. 標準 Payload 範例

### 4.1 初次探索推薦（自然金額輸入，預設無須帶任何 `fx`）
直接傳入商家與自然金額，`amount` 與 `currency` 放頂層；省略 `currency` 預設 `"TWD"`。系統自動依 ISO 4217 次方換算並展開所有可用卡片與多層路徑：
```json
{
  "merchant": "Bic Camera",
  "amount": 10000,
  "currency": "JPY",
  "country": "JP",
  "channel": "in_store"
}
```

```json
{
  "merchant": "全聯",
  "amount": 150,
  "channel": "in_store"
}
```

```json
{
  "merchant": "Uber",
  "amount": 4.8,
  "currency": "USD",
  "country": "US",
  "channel": "online"
}
```


### 4.2 特定跨境路徑重試（使用 `routeFacts` 補充專屬匯率）
透過 `routeFacts` 陣列提供各結算路徑（信用卡直刷或跨境錢包）的專屬匯率，彼此嚴格隔離、互不干擾。

#### 範例 A：信用卡專用匯率（走國際卡組織 JCB / Visa / Mastercard 匯率）
```json
{
  "merchant": "Bic Camera",
  "amount": 50000,
  "currency": "JPY",
  "country": "JP",
  "channel": "in_store",
  "routeFacts": [
    {
      "routeId": "card:fubon-jcb",
      "fx": {
        "id": "fx_quote_jpy_twd_jcb",
        "baseCurrency": "JPY",
        "quoteCurrency": "TWD",
        "rate": 0.215,
        "capturedAt": "2026-09-17T12:00:00Z",
        "maxAgeSeconds": 86400,
        "provider": "JCB",
        "rateType": "card_scheme",
        "cardScheme": "jcb",
        "sourceUrl": "https://www.jcb.tw/rate/jpy.html"
      }
    }
  ],
  "expectedResultVersion": "v1"
}
```

#### 範例 B：跨境電子錢包專用匯率（走合作銀行現鈔賣出牌告價）
```json
{
  "merchant": "東京燒肉店",
  "amount": 30000,
  "currency": "JPY",
  "country": "JP",
  "channel": "in_store",
  "routeFacts": [
    {
      "routeId": "route_taishin_paypay",
      "fx": {
        "id": "fx_quote_jpy_twd_taishin",
        "baseCurrency": "JPY",
        "quoteCurrency": "TWD",
        "rate": 0.2185,
        "capturedAt": "2026-09-17T12:00:00Z",
        "maxAgeSeconds": 86400,
        "provider": "TaishinBank",
        "rateType": "cash_selling",
        "sourceUrl": "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
      }
    }
  ],
  "expectedResultVersion": "v1"
}
```

#### 範例 C：多軌道同時比較（信用卡組織匯率 vs 錢包現鈔賣出並陳）
```json
{
  "merchant": "東京電器行",
  "amount": 50000,
  "currency": "JPY",
  "country": "JP",
  "channel": "in_store",
  "routeFacts": [
    {
      "routeId": "card:fubon-jcb",
      "fx": {
        "id": "fx_quote_jpy_twd_jcb",
        "baseCurrency": "JPY",
        "quoteCurrency": "TWD",
        "rate": 0.215,
        "capturedAt": "2026-09-17T12:00:00Z",
        "maxAgeSeconds": 86400,
        "provider": "JCB",
        "rateType": "card_scheme",
        "cardScheme": "jcb",
        "sourceUrl": "https://www.jcb.tw/rate/jpy.html"
      }
    },
    {
      "routeId": "route_taishin_paypay",
      "fx": {
        "id": "fx_quote_jpy_twd_taishin",
        "baseCurrency": "JPY",
        "quoteCurrency": "TWD",
        "rate": 0.2185,
        "capturedAt": "2026-09-17T12:00:00Z",
        "maxAgeSeconds": 86400,
        "provider": "TaishinBank",
        "rateType": "cash_selling",
        "sourceUrl": "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
      }
    }
  ],
  "expectedResultVersion": "v1"
}
```

