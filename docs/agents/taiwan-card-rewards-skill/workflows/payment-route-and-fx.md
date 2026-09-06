# 通用支付路徑層級與外幣匯率研究 SOP (Payment Route & FX SOP)

本標準作業程序規範多層支付路徑架構、最終扣款工具分類、支付拓撲與開放識別碼、外幣匯率研究及 PPM 量化標準。

---

## 1. 循序支付路徑層級與最終扣款工具 (Payment-Route Layers & Funding Instruments)

依據 [ADR 0005](../../adr/0005-payment-route-opportunity-stacking.md) 與 [ADR 0006](../../adr/0006-multi-component-reward-ledger-and-cap-attribution.md)，一筆消費可能同時產出多個獨立的 `RewardComponent`。系統將交易拆解為 **(A) 循序支付路徑層級** 與 **(B) 最終實體扣款工具**：

### (A) 可疊加之循序支付路徑層級 (Ordered Payment-Route Layers)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 特約商家會員層 (Merchant Loyalty)  ──► 產生 merchant_loyalty 回饋組件   │
│    (例：超商 OPEN POINT、全聯福利點、百貨會員點數)                     │
├────────────────────────────────────────────────────────────────────────┤
│ 2. 支付錢包/App 層 (Wallet / App)     ──► 產生 payment_provider 回饋組件   │
│    (例：LINE Pay 點數、街口幣、全支付點數、電子支付跨國優惠)           │
├────────────────────────────────────────────────────────────────────────┤
│ 3. 金流中介處理商 (Intermediate Provider)                             │
│    (例：跨境代收代付平台、清算中介機構)                                │
├────────────────────────────────────────────────────────────────────────┤
│ 4. 發卡機構與卡組織 (Card Issuer / Network) ──► 產生 card_issuer 回饋組件 │
│    (例：銀行信用卡現金回饋、紅利點數、發卡組織專案)                    │
└────────────────────────────────────────────────────────────────────────┘
```

- **回饋歸屬主體**：每個 `RewardComponent` 依其發放主體（`merchant_loyalty`, `payment_provider`, `card_issuer`）獨立計量、獨立套用進位規則與上限池，**電子錢包屬於路徑載體，絕非最終付款工具**。

### (B) 最終實體扣款工具 (Terminal Funding Instrument)

最終實際支付資金來源僅劃分為以下三大類：
1. **信用卡 (`credit_card`)**：實體信用卡或綁定於錢包之信用卡。
2. **現金 (`cash`)**：實體紙鈔硬幣或貨到付款現金。
3. **帳戶 (`account`)**：涵蓋銀行存款帳戶（`linked_bank_account`）、電子支付錢包儲值帳戶/餘額（`wallet_balance`）及電子票證儲值金。

> [!IMPORTANT]
> **扣款工具與回饋連動守則**：
> 1. **帳戶扣款不觸發發卡行回饋**：當使用者選擇以銀行帳戶或錢包餘額（`account`）扣款時，**絕不觸發**發卡機構信用卡回饋（`card_issuer`），僅能享有商家或錢包業者之回饋。
> 2. **現金無信用卡回饋**：使用現金（`cash`）結帳絕無卡片回饋，嚴禁代理人猜測或虛構。

---

## 2. 穩定拓撲 vs 開放可擴充識別碼 (Topology vs Extensible Identifiers)

系統明確區分**封閉穩定的架構拓撲**與**開放可擴充的字串資料**：

### 2.1 粗粒度穩定拓撲 (`PaymentRouteKind`)
MCP 合約中維持穩定封閉列舉：
- `direct_card`: 實體卡插卡、感應或線上輸入卡號。
- `wallet`: 行動支付、電子錢包或條碼支付載體。
- `merchant_app`: 特店專屬 App 內嵌結帳（如 Uber App、foodpanda、高鐵 T-EX App）。

### 2.2 開放可擴充識別碼 (Extensible Open Identifiers)
`providerId`, `appId`, `paymentMethod`, `walletProviderId` 等皆為開放字串資料：
- **常見實例（僅為說明，非封閉常數）**：`line_pay`, `jkopay`, `pxpay_plus`, `apple_pay`, `google_pay`, `taiwan_pay`, `samsung_pay`, `icash_pay`, `open_wallet`, `paypay` 等。
- **新增支付服務**：新增市場上的新電子錢包或支付品牌時，**只需填入新的 provider / paymentMethod 字串並提供對應的官方證據與規則 (Evidence & Rules)**，完全無需修改 MCP 核心引擎。
- **無猜測原則**：遇到系統未建立規則之未知 provider 時，絕不進行模糊自動匹配；只有出現全新計算語意（如全新形態的匯率折算公式、特殊階梯費率或新型態疊加邏輯）時才需擴充 MCP 合約。

### 2.3 核心欄位語意區分
- **`channel`**：交易互動媒介情境（如 `in_store` 實體門市臨櫃、`online` 網路電商/App）。
- **`paymentMethod` / `providerId`**：具體支付工具或電子支付機構名稱（如 `line_pay`, `apple_pay`）。
- **`route.kind`**：粗粒度路徑種類（`direct_card` | `wallet` | `merchant_app`）。

---

## 3. 外幣匯率研究與三種幣別拆解 (FX & Currency Tri-Split)

跨國或外幣交易中，Agent 必須精確釐清以下三種幣別：
1. **交易幣別 (`transactionCurrency`)**：特約商店結帳標價幣別（如 JPY, USD, EUR, TWD）。
2. **清算幣別 (`settlementCurrency`)**：卡組織或跨境支付通道結算幣別（通常為 TWD 或 USD）。
3. **帳單請款幣別 (`billingCurrency`)**：使用者信用卡帳單計價幣別（通常為 TWD）。

### 換匯主導者與換匯時機
- `conversionOwner`: `merchant` (DCC 機制), `wallet` (電子錢包即時換匯), `payment_provider`, `card_network` (VISA/Mastercard/JCB 國際組織), `issuer` (發卡銀行), `unknown`。
- `conversionTiming`: `transaction` (即時結匯), `clearing`, `settlement`, `posting` (入帳日匯率)。

### 手續費結構
- `foreignTransactionFee`: 國外交易手續費（通常為 1.5% = `15000` PPM）。
- `markup`: 通道服務費或匯差加價。
- `dcc`: 是否觸發動態貨幣轉換 (Dynamic Currency Conversion)。

---

## 4. 官方一手來源查核階層 (Official Source Hierarchy)

| 優先級 | 來源類別 | 查核目標內容 |
|---|---|---|
| 🥇 **第 1 級** | **支付錢包 / 通道官方定價與條款** | 跨國交易支援度、扣款手續費、換匯合作銀行與即時匯率公告 (例：街口/全支付跨境條款、LINE Pay 服務協議) |
| 🥈 **第 2 級** | **發卡銀行 / 國際組織條款** | 國外交易 1.5% 手續費計收標準、海外刷卡加碼門檻、排除加碼之特店清單 |
| 🥉 **第 3 級** | **特店商家結帳條款** | 是否收取外幣交易附加費、是否強制或預設 DCC 本幣結帳 |

---

## 5. 外幣匯率研究與 PPM 量化標準

### 5.1 量化公式
$$\text{ratePpm} = \text{匯率 (1 單位外幣折合新台幣金額)} \times 1,000,000$$

- **日圓 (JPY) 範例**：1 JPY = 0.2152 TWD $\Rightarrow 0.2152 \times 1,000,000 =$ **`215200` PPM**。
- **美金 (USD) 範例**：1 USD = 31.850 TWD $\Rightarrow 31.850 \times 1,000,000 =$ **`31850000` PPM**。
- **歐元 (EUR) 範例**：1 EUR = 34.500 TWD $\Rightarrow 34.500 \times 1,000,000 =$ **`34500000` PPM**。

### 5.2 注入 `FxSnapshot` 結構
```json
{
  "id": "fx_jpy_twd_bot_spot_20260906",
  "baseCurrency": "JPY",
  "quoteCurrency": "TWD",
  "ratePpm": 215200,
  "capturedAt": "2026-09-06T12:00:00Z",
  "maxAgeSeconds": 86400,
  "provider": "BankOfTaiwan",
  "rateType": "spot_selling",
  "sourceUrl": "https://rate.bot.com.tw/xrt?Lang=zh-TW"
}
```

> [!CAUTION]
> **嚴禁 1:1 匯率回退**：若交易幣別非 `TWD` 且未注入有效 `FxSnapshot`，Pre-flight 必須回傳 `ready: false` 並標註 `requiredActions: ["refresh_external_data"]`。
