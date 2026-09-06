# 支付通道上下文與外幣匯率量化 SOP

---

## 1. 支付通道上下文 (`PaymentRouteContext`)

台灣信用卡市場中，同一張信用卡經由不同支付通道可能享有不同回饋（例如直接刷實體卡 vs 綁定 LINE Pay / 街口支付）。

### 標準通道常數 (Standard Channels)
- `direct_card`: 實體卡過卡、晶片插卡、感應刷卡或一般線上輸入卡號
- `apple_pay`: Apple Pay 感應或 In-App 支付
- `google_pay`: Google Pay 感應或 In-App 支付
- `samsung_pay`: Samsung Pay 感應支付
- `line_pay`: LINE Pay 條碼或線上結帳
- `jkopay`: 街口支付
- `pxpay`: 全聯 PX Pay / 全支付
- `taiwan_pay`: 台灣 Pay (金融卡/信用卡)
- `open_wallet`: OPEN 錢包 / icash Pay

### 上下文資料結構
```json
{
  "channel": "line_pay",
  "isContactless": false,
  "walletBinding": "fubon_j_card",
  "merchantCategoryOverride": "convenience_store"
}
```

---

## 2. 外幣交易與匯率量化標準 (`ratePpm`)

為避免浮點數精度誤差，系統一律採用 **PPM (Parts-Per-Million，百萬分之一)** 表示匯率與回饋率。

### 數值轉換對照
- **1% 回饋** = $0.01 \times 1,000,000$ = **`10,000 PPM`**
- **3.5% 回饋** = $0.035 \times 1,000,000$ = **`35,000 PPM`**
- **1.5% 國外交易手續費** = **`15,000 PPM`**
- **日幣匯率 1 JPY = 0.2150 TWD** = $0.2150 \times 1,000,000$ = **`215,000 PPM`**
- **美金匯率 1 USD = 31.850 TWD** = $31.850 \times 1,000,000$ = **`31,850,000 PPM`**

### `FxSnapshot` 注入範例
```json
{
  "sourceCurrency": "JPY",
  "targetCurrency": "TWD",
  "ratePpm": 215000,
  "quotedAt": "2026-09-06T12:00:00Z",
  "source": "BankOfTaiwan_Cash_Sell"
}
```

> [!WARNING]
> **絕不回退 1:1 匯率**：若未提供 `FxSnapshot` 且幣別非 `TWD`，Pre-flight 必須回傳 `ready: false` 並要求補齊匯率快照。
