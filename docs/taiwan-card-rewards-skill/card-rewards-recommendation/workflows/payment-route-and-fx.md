# 外幣匯率查詢與組裝標準作業程序 (Payment Route & FX SOP)

本標準作業程序規範 Agent 在推薦流程中收到 `fx_missing`、`fx_stale`、`fx_pair_mismatch` 或附帶 `FxResolutionRequest` 時，如何解析來源網址、計算匯率並組裝 `fx` 快照以供重試。

> [!IMPORTANT]
> **架構原則（核心零直接網路 I/O 與失敗即關閉 Fail-Closed）**：
> MCP 核心內部絕不自行發起外聯網路請求抓取匯率。若缺少匯率快照，核心引擎遵循「失敗即關閉 (Fail-Closed)」原則，回傳 `requiredActions` 包含 `action: "query_approved_fx_source"` 以及結構化之 `FxResolutionRequest`，由外部 Host Agent 負責透過網路或工具查詢核准之來源網址後注入。實際交易入帳後，採納之匯率將固化為 `AppliedFxRate`。

---

## 1. 核心查價與換匯 4 步流程 (The 4-Step FX Resolution Flow)

```text
1. 解析 MCP 指示 ──► 2. 獲取合格報價 ──► 3. 計算 ratePpm ──► 4. 組裝 fx 重試
   (sourceUrls)         (即期 vs 現鈔)      (匯率 x 1,000,000)   (帶入 recommend)
```

### 步驟 1：解析 MCP 指示與來源網址 (`FxResolutionRequest`)
當 `recommend` 回傳 `requiredActions` 之 `action: "query_approved_fx_source"` 時，檢視附加的 `fxResolutionRequest` 物件：
- `baseCurrency`: 交易外幣（如 `JPY`, `USD`, `EUR`）。
- `quoteCurrency`: 結算貨幣（固定為 `TWD`）。
- `sourceUrls`: **MCP 指定之核准查詢網址**。若此欄位有提供，Agent **必須優先以此 URL 查詢**。
- `suggestedRateTypes`: 建議匯率類型（如 `cash_selling`, `spot_selling`, `card_scheme`, `mid_market`）。
- `conversionOwner`: 換匯主導者（`card_scheme`, `wallet`, `issuer`）。

---

### 步驟 2：換匯主體判斷與查價原則 (Pricing Rules)
若 `sourceUrls` 未指定或需要進一步確認定價軌道，遵循以下規則：

| 支付通路與清算軌道 | 換匯主導者 (`conversionOwner`) | 匯率類型 (`rateType`) | 合格查價來源與原則 |
|---|---|---|---|
| **實體信用卡 / Apple Pay / Google Pay** | `card_scheme` | `card_scheme` 或 `spot_selling` | 走國際卡組織即期中價。<br>查價網址：臺灣銀行牌告即期賣出中價 (`https://rate.bot.com.tw/xrt?Lang=zh-TW`) 或卡組織公布之參考匯率。 |
| **跨境電子錢包 (街口 / 台新Pay+ 掃日本 PayPay)** | `wallet` | `cash_selling` | **走合作銀行「現鈔賣出牌告價」（約比即期貴 1.8%~2.3%）**。<br>查價網址：台新即時外幣牌告 (`https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/`) 現鈔賣出牌價，或錢包 App 即時鎖定牌價。 |
| **發卡行直接結匯 / 雙幣卡** | `issuer` | `cash_selling` | 發卡行官網當日牌告現鈔賣出價。 |

> [!WARNING]
> **🚨 跨境雙軌匯差防呆注意清單**：
> 當使用者打算在日本使用街口或台新Pay+ 掃 PayPay 時，清算網路 (HIVEX) 採用的是較貴的**「銀行現鈔賣出價」**。
> 若名目回饋僅多 0.5%~1.0%，扣除約 2% 匯差滑價後實質淨回饋往往不如直接刷實體卡或 Apple Pay。Agent 推薦時應計算並主動提醒使用者實質回饋差距。

---

### 步驟 3：量化計算 PPM 數值 (`ratePpm`)
系統要求匯率以 Parts-Per-Million (PPM) 整數表示：
$$\text{ratePpm} = \text{Round}(\text{1 單位外幣兌換之新台幣金額} \times 1,000,000)$$

**算例對照**：
- 日圓現鈔賣出價 `1 JPY = 0.2093 TWD` ➔ `ratePpm = 209300`
- 美元即期賣出價 `1 USD = 32.15 TWD` ➔ `ratePpm = 32150000`
- 歐元即期賣出價 `1 EUR = 34.50 TWD` ➔ `ratePpm = 34500000`

---

### 步驟 4：組裝標準 `fx` 快照並重試
組裝符合 MCP Schema 的 `fx` Snapshot 物件：

```json
{
  "id": "fx_quote_jpy_twd",
  "baseCurrency": "JPY",
  "quoteCurrency": "TWD",
  "ratePpm": 209300,
  "capturedAt": "2026-09-17T12:00:00Z",
  "maxAgeSeconds": 86400,
  "provider": "TaishinBank",
  "rateType": "cash_selling",
  "sourceUrl": "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
}
```

攜帶上述 `fx` 物件與 `expectedResultVersion: response.resultVersion` 重新調用 `recommend` 工具：
```javascript
recommend({
  merchant: "Bic Camera",
  amount: { amountMinor: 10000, currency: "JPY" },
  fx: {
    id: "fx_quote_jpy_twd",
    baseCurrency: "JPY",
    quoteCurrency: "TWD",
    ratePpm: 209300,
    capturedAt: "2026-09-17T12:00:00Z",
    maxAgeSeconds: 86400,
    provider: "TaishinBank",
    rateType: "cash_selling",
    sourceUrl: "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
  },
  expectedResultVersion: response.resultVersion
})
```
