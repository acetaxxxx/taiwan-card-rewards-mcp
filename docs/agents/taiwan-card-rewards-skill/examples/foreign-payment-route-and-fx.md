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
2. 或是使用台灣電子支付錢包（如街口/全支付/台新 Pay+）掃碼扣款？
3. 若是錢包，底層是銀行帳戶、錢包餘額、直接信用卡授權，還是信用卡先儲值錢包再付款？
4. 店家顯示的是 PayPay／TWQR／其他受理網路？是否選了 DCC？」

使用者：「我用 Apple Pay 刷富邦 J 卡（JCB）」。

---

## Step 3: Agent 查核「該 route」的官方匯率並轉換為 PPM

Agent 必須依 route 的 conversion owner 查核對應官方來源，例如卡組織／發卡行、街口匯率頁或台新 Pay+ FAQ；不可因為交易在日本就直接套用台灣銀行牌告：
- 1 JPY = 0.2152 TWD
- 量化為 PPM：$0.2152 \times 1,000,000 = `215200` PPM。
- 國外交易手續費不預設為 1.5%；只有取得該卡／通道當期官方費率後才填 `foreignTransactionFee`。

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
    "channel": "in_store",
    "paymentMethod": "apple_pay",
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
      "acceptanceProviderId": "paypay_qr",
      "consumerAppId": "apple_pay",
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
- 國外交易手續費：只有在 Fx/fee evidence 已確認時才列出，否則回傳 `needs_review`
- 富邦 J 卡日韓實體加碼 3%：獲得 129 點 LINE POINTS
- 扣除已確認費用後的淨回饋；不可使用未查證的 1.5% 假設。

## 另一條合法 route：PayPay QR → 台新 Pay+ → 台新信用卡

這不是「Taiwan Pay 裡再套台新 Pay+」。Agent 應依台新 Pay+ 官方 FAQ 登錄：

- `merchant_acceptance`: `paypay_qr`
- `consumer_app`: `taishin_pay_plus`
- `funding`: `credit_card`, `cardId: <registered-taishin-card>`（或 `account/linked_bank_account`）
- `routeContext.conversionOwner`: `bank` / `payment_provider`，以當期 FAQ 與 App 顯示為準
- `routeContext.rateType`: `cash_selling`（只有來源實際如此時才填）

如果使用街口 PayPay 並選信用卡，官方 FAQ 的語意是 `credit_card_topup → wallet_balance_debit`；Agent 必須另查發卡行對 `JKO-Credit Card Top-up` 的回饋條款，不能把它當成 PayPay direct card transaction。
