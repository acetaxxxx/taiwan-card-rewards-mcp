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

## Step 2: Agent Workspace 查詢該 route 的官方匯率

Agent 先依 route 的 `conversionOwner` 與 `rateType` 查詢對應的官方匯率頁、App 顯示或條款快照。例如若該路徑明確指定銀行即期賣出價，才可記錄：
- 1 JPY = 0.2150 TWD
- 量化為 PPM：$0.2150 \times 1,000,000 = `215000` PPM。

若路徑是錢包換匯、信用卡儲值或 DCC，不能拿銀行牌告或卡組織匯率代替；Agent 必須先詢問／查證換匯主體與時間。匯率、費用與 DCC markup 都不能以 1.5% 或其他固定值預設。

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

**MCP 回傳結果**：只有當 route、FX snapshot 與費用／回饋證據均符合有效期時才可 `ready: true`；否則維持 `ready: false` 並回傳可操作的 `requiredActions`。

---

## Step 4: 執行 `recommend`

MCP 只能依已查證的 route fee 與卡片條款計算折合台幣、費用與回饋；若沒有該卡／通道當期費率證據，不得自行扣除 1.5%，也不得宣稱一般海外消費回饋適用於錢包信用卡儲值。
