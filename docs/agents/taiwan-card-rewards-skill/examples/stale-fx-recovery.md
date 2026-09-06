# 範例：過期外幣匯率查核與快照補齊 (Stale FX Recovery)

**情境**：使用者在日本 Bic Camera 實體店購買 ¥15,000 JPY 商品，詢問用卡推薦。

---

## Step 1: Pre-flight 提示缺少匯率快照

Agent 呼叫 `recommendation_preflight`：
```json
{
  "amount": 15000,
  "currency": "JPY",
  "merchantName": "Bic Camera"
}
```

**MCP 回傳結果**：
```json
{
  "ready": false,
  "requiredActions": ["refresh_external_data"],
  "diagnostics": [
    {
      "code": "MISSING_FX_SNAPSHOT",
      "message": "外幣 JPY 交易需要有效的 FxSnapshot，系統嚴禁 1:1 匯率回退。"
    }
  ]
}
```

---

## Step 2: Agent Workspace 查詢官方即時匯率

Agent 於 Workspace 查詢台灣銀行即時牌告日圓現鈔/即期匯率：
- 1 JPY = 0.2150 TWD
- 量化為 PPM：$0.2150 \times 1,000,000 = `215000` PPM。

---

## Step 3: 注入 `fxSnapshot` 重跑 Pre-flight

```json
{
  "amount": 15000,
  "currency": "JPY",
  "merchantName": "Bic Camera",
  "fxSnapshot": {
    "sourceCurrency": "JPY",
    "targetCurrency": "TWD",
    "ratePpm": 215000,
    "quotedAt": "2026-09-06T12:00:00Z",
    "source": "BankOfTaiwan_Spot"
  }
}
```

**MCP 回傳結果**：`{ "ready": true, "requiredActions": [] }`

---

## Step 4: 執行 `recommend`

MCP 計算折合台幣約 NT$ 3,225，扣除 1.5% 海外交易手續費（NT$ 48）後，精確計算富邦 J 卡日韓實體加碼（3%）與聯邦吉鶴卡日幣專屬回饋。
