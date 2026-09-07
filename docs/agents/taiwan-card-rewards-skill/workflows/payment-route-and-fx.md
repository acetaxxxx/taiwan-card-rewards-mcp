# 通用支付路徑層級與外幣匯率研究 SOP (Payment Route & FX SOP)

本標準作業程序規範多層支付路徑架構、最終扣款工具分類、支付拓撲與開放識別碼、外幣匯率研究及 PPM 量化標準。

> **先讀研究與 ADR**：遇到跨境錢包、PayPay、TWQR、台灣 Pay、Pay+ 或任何新 provider，先讀 [`payment-route-chain-reality-and-mcp-design.md`](../../../research/payment-route-chain-reality-and-mcp-design.md) 與 [ADR 0007](../../../adr/0007-provider-neutral-payment-route-facts-and-evidence.md)。品牌、QR 受理網路、消費者 App、互通方案、funding 與 settlement 是不同事實；只有官方證據支持時才可把它們串成一條 route。

---

## 1. 循序支付路徑層級與最終扣款工具 (Payment-Route Layers & Funding Instruments)

依據 [ADR 0005](../../adr/0005-payment-route-opportunity-stacking.md) 與 [ADR 0006](../../adr/0006-multi-component-reward-ledger-and-cap-attribution.md)，一筆消費可能同時產出多個獨立的 `RewardComponent`。系統將交易拆解為 **(A) 循序支付路徑層級** 與 **(B) 最終實體扣款工具**：

### (A) 可疊加之循序支付路徑層級 (Ordered Payment-Route Layers)

```
┌────────────────────────────────────────────────────────────────────────┐
│ 1. 特約商家會員層 (Merchant Loyalty)  ──► 產生 merchant_loyalty 回饋組件   │
│    (例：超商 OPEN POINT、全聯福利點、百貨會員點數)                     │
├────────────────────────────────────────────────────────────────────────┤
│ 2. 消費者支付 App / Wallet 層       ──► 產生 payment_provider 回饋組件   │
│    (例：LINE Pay 點數、街口幣、全支付點數、電子支付跨國優惠)           │
├────────────────────────────────────────────────────────────────────────┤
│ 3. 商家受理 / 互通方案 / 中介層       （不一定同時存在）                 │
│    (例：PayPay QR、TWQR、跨境互通或清算中介)                             │
├────────────────────────────────────────────────────────────────────────┤
│ 4. 發卡機構與卡組織 (Card Issuer / Network) ──► 產生 card_issuer 回饋組件 │
│    (例：銀行信用卡現金回饋、紅利點數、發卡組織專案)                    │
└────────────────────────────────────────────────────────────────────────┘
```

- **回饋歸屬主體**：每個 `RewardComponent` 依其發放主體（`merchant_loyalty`, `payment_provider`, `card_issuer`）獨立計量、獨立套用進位規則與上限池。電子錢包可能是 App、帳戶扣款者或信用卡儲值中介；不能只看品牌判斷最終 funding。

### (B) 最終實體扣款工具 (Terminal Funding Instrument)

最終實際支付資金來源僅劃分為以下三大類：
1. **信用卡 (`credit_card`)**：實體信用卡或綁定於錢包之信用卡。
2. **現金 (`cash`)**：實體紙鈔硬幣或貨到付款現金。
3. **帳戶 (`account`)**：涵蓋銀行存款帳戶（`linked_bank_account`）、電子支付錢包儲值帳戶/餘額（`wallet_balance`）及外幣存款帳戶（`foreign_currency_account`）。

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

建議 route layer 依觀察事實使用 `merchant_acceptance`、`consumer_app`、`interoperability_scheme`、`payment_provider`、`intermediate_provider`、`card_network`、`card_issuer`；`funding` 另以 `credit_card | account | cash` 表示。`PayPay QR → Taishin Pay+ → 台新信用卡` 與 `TWQR → 台灣 Pay → 帳戶` 是兩筆 route，不得用一個固定 `wallet` 常數代替。

### 2.3 核心欄位語意區分
- **`channel`**：交易互動媒介情境（如 `in_store` 實體門市臨櫃、`online` 網路電商/App）。
- **`paymentMethod` / `providerId`**：具體支付工具或電子支付機構名稱（如 `line_pay`, `apple_pay`）。
- **`route.kind`**：粗粒度路徑種類（`direct_card` | `wallet` | `merchant_app`）。

### 2.4 Agent 自動提醒與加入支付路徑 (Route Onboarding Loop)

當使用者說「我有一張新卡」或「我常用某個支付 App／帳戶」時，Agent 應把支付路徑當成可重用的使用者設定提醒，但不可在沒有確認時自行啟用：

1. 先詢問並記錄非敏感事實：受理網路或商家 App、消費者 App、是否有互通／中介、最終 funding 是信用卡／帳戶／現金，以及交易幣別與結算幣別。
2. 先呼叫 `list_payment_routes`，避免重複建立；若存在但已過期或衝突，先標示 `needs_review`，不要覆蓋原紀錄。
3. 缺資料時由 Agent Workspace 查官方 FAQ、費率、匯率、回饋與排除條款，建立逐層 `EvidenceRecord`；MCP 不自行上網，也不把品牌名稱當成清算事實。
4. 用 `upsert_payment_route` 寫入 `candidate` 路徑。只有使用者明確確認、且必要證據已具備時，才可寫入 `active`；禁止寫入卡號、驗證碼、密碼或任何支付憑據。
5. 若有只適用此路徑的回饋規則，將規則以 `OfferRuleVersion.routeId` 綁定該 route；通用規則不綁 route，維持既有相容性。
6. 推薦前把 `transaction.routeId` 與 route context 一起送入 `recommendation_preflight`。路徑不存在、過期、funding 不一致、匯率／費用／回饋條款衝突時，回傳 `requiredActions` 讓 Agent 補資料或詢問使用者，不能猜測。

新增支付服務只需要新的開放識別碼與官方證據；除非出現新的計算語意，否則不需要新增 PayPay、街口或其他品牌專用工具。

---

## 3. 外幣匯率研究與三種幣別拆解 (FX & Currency Tri-Split)

跨國或外幣交易中，Agent 必須精確釐清以下三種幣別：
1. **交易幣別 (`transactionCurrency`)**：特約商店結帳標價幣別（如 JPY, USD, EUR, TWD）。
2. **清算幣別 (`settlementCurrency`)**：卡組織或跨境支付通道結算幣別（通常為 TWD 或 USD）。
3. **帳單請款幣別 (`billingCurrency`)**：使用者信用卡帳單計價幣別（通常為 TWD）。

### 換匯主導者與換匯時機
- `conversionOwner`: `merchant` (DCC 機制), `wallet` (電子錢包即時換匯), `payment_provider`, `bank`, `acquirer`, `card_network` (VISA/Mastercard/JCB 國際組織), `issuer` (發卡銀行), `unknown`。
- `conversionTiming`: `transaction` (即時結匯), `clearing`, `settlement`, `posting` (入帳日匯率)。

### 手續費結構
- `foreignTransactionFee`: 以該 provider／卡片／活動的官方費率快照為準；`1.5% = 15000` PPM 只是某些卡片條款的輸入，不是全域預設。
- `markup`: 通道服務費或匯差加價。
- `dcc`: 是否觸發動態貨幣轉換 (Dynamic Currency Conversion)。

---

## 4. 官方一手來源查核階層 (Official Source Hierarchy)

| 優先級 | 來源類別 | 查核目標內容 |
|---|---|---|
| 🥇 **第 1 級** | **支付錢包 / 通道官方定價與條款** | 跨國交易支援度、扣款手續費、換匯合作銀行與即時匯率公告 (例：街口/全支付跨境條款、LINE Pay 服務協議) |
| 🥈 **第 2 級** | **發卡銀行 / 國際組織條款** | 國外交易 1.5% 手續費計收標準、海外刷卡加碼門檻、排除加碼之特店清單 |
| 🥉 **第 3 級** | **特店商家結帳條款** | 是否收取外幣交易附加費、是否強制或預設 DCC 本幣結帳 |

### 4.1 路徑研究的最小官方證據包

每條候選 route 至少要回答以下問題，並讓每個答案對應自己的來源快照：

- 這個 App 是否真的支援該商家受理網路／互通方案？
- 使用信用卡是直接授權，還是先儲值到錢包餘額再扣款？
- 最終扣款工具與回饋發放主體是誰？是否有排除條款或不同 MCC／帳單描述？
- 換匯由誰決定、在何時決定、使用哪種 rate type？是否另收 service fee、foreign transaction fee 或 DCC markup？
- 條款有效期、地區、卡別、活動登錄與上限為何？

任何一題無法由當期官方資料回答，就保留 `candidate` 或 `needs_review`，不把路徑當成可推薦事實。

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
