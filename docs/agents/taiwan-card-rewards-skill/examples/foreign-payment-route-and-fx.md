# 範例：通用跨國支付通道與匯率量化 (Foreign Payment Route & FX)

**情境**：使用者在國外實體商店使用跨境行動支付（例如支援日本 PayPay 條碼的台灣電支 App，或以 Apple Pay 綁定台灣信用卡），消費金額 ¥20,000 JPY。

---

## Step 1: Pre-flight 提示缺少匯率與扣款途徑

Agent 呼叫 `recommendation_preflight`：
```json
{
  "transaction": {
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T17:00:00+08:00",
    "amount": { "amountMinor": 2000000, "currency": "JPY" },
    "merchant": "Bic Camera"
  }
}
```

**MCP 回傳**：
```json
{
  "ready": false,
  "requiredActions": ["refresh_external_data"],
  "diagnostics": [
    { "code": "MISSING_FX_SNAPSHOT", "message": "非 TWD 交易必須提供 FxSnapshot，嚴禁 1:1 匯率回退。" }
  ]
}
```

---

## Step 2: Agent 執行最小澄清提問

Agent 詢問：「請問您是：
1. 使用 Apple Pay / 實體卡感應刷台灣信用卡？
2. 或是使用台灣電子支付錢包（如街口/全支付）掃碼扣款（扣銀行帳戶或信用卡）？」

使用者：「我用 Apple Pay 刷富邦 J 卡（JCB）」。

---

## Step 3: Agent 查核最新官方牌告匯率並轉換為 PPM

Agent 查詢台灣銀行牌告現鈔賣出/即期匯率：
- 1 JPY = 0.2152 TWD
- 量化為 PPM：$0.2152 \times 1,000,000 = `215200` PPM。
- 國外交易手續費：1.5% = `15000` PPM。

---

## Step 4: 注入 `PaymentRouteContext` 與 `FxSnapshot` 重跑 Preflight

```json
{
  "transaction": {
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T17:00:00+08:00",
    "amount": { "amountMinor": 2000000, "currency": "JPY" },
    "merchant": "Bic Camera",
    "country": "JP",
    "channel": "apple_pay",
    "fx": {
      "id": "fx_jpy_twd_bot_20260906",
      "baseCurrency": "JPY",
      "quoteCurrency": "TWD",
      "ratePpm": 215200,
      "capturedAt": "2026-09-06T12:00:00Z",
      "maxAgeSeconds": 86400,
      "provider": "BankOfTaiwan",
      "rateType": "spot_selling"
    },
    "routeContext": {
      "transactionCurrency": "JPY",
      "settlementCurrency": "TWD",
      "billingCurrency": "TWD",
      "cardNetwork": "JCB",
      "issuer": "台北富邦銀行",
      "fundingSource": "credit_card",
      "conversionOwner": "card_network",
      "foreignTransactionFee": { "amountMinor": 6450, "currency": "TWD" },
      "dcc": false
    }
  }
}
```

**MCP 回傳**：`{ "ready": true, "requiredActions": [] }`

---

## Step 5: 執行 `recommend`

MCP 計算：
- 折合新台幣：NT$ 4,304 (20,000 JPY * 0.2152)
- 1.5% 國外交易手續費：NT$ 65
- 富邦 J 卡日韓實體加碼 3%：獲得 129 點 LINE POINTS
- 扣除手續費後淨回饋：約 1.5%（淨收益 64 元等值點數）
