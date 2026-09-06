# Pre-flight 診斷與推薦標準作業程序 (Pre-flight SOP)

本作業程序定義 Agent 在提供任何信用卡推薦或試算時，必須嚴格執行的 **Pre-flight 循環流程**。

---

## 1. 核心流程概覽

```
       [使用者請求推薦]
              │
              ▼
  1. 呼叫 recommendation_preflight
              │
              ▼
    2. 檢查 ready 旗標
       ├─────────────────────────────────┐
       │ ready === false                 │ ready === true
       ▼                                 ▼
3. 解析 requiredActions           5. 呼叫 recommend 工具
   - clarify_merchant                 - 指定 limit (預設 5)
   - refresh_external_data (fx)       - 支援 cursor 分頁
   - research_evidence / offer           │
   - register_card                       ▼
   - review_conflict              6. 格式化結構化輸出
       │                             - 總估算金額
       ▼                             - 多組件拆解 (Base/Bonus)
4. 執行修復 (引導使用者/查核)         - 上限池扣減預估
       │                             - 注意事項與生效條件
       └───────────► [重新執行 Pre-flight]
```

---

## 2. 詳細執行步驟

### 步驟 1：執行 Pre-flight 診斷
Agent 收集使用者輸入的金額、幣別、商家與支付方式，呼叫 `recommendation_preflight`：

```json
{
  "amount": 3000,
  "currency": "TWD",
  "merchantName": "momo購物網",
  "paymentRoute": {
    "channel": "direct_card"
  }
}
```

### 步驟 2：解析 `requiredActions` 與自動修復

| `requiredAction` | 觸發原因 | Agent 修復動作 |
|---|---|---|
| `clarify_merchant` / `choose_market` | 商家名稱模糊（如 "Uber" 存在 Rides/Eats 歧義） | 呼叫 `resolve_merchant` 取得候選，列出清單供使用者確認 |
| `refresh_external_data` | 外幣交易缺少即時匯率或快照已逾期 | 查詢官方牌告匯率，換算為 `ratePpm` 並注入 `fxSnapshot` |
| `research_evidence` / `refresh_offer` | 相關卡片促銷活動過期或缺少官方事實 | 啟動 Research SOP 查詢官方條款並執行 `upsert_offer` |
| `register_card` | 使用者未登記任何信用卡 | 提示使用者登記現有卡片（呼叫 `register_card`） |
| `review_conflict` | 規則間存在排他或互斥衝突 | 提示使用者仲裁或選擇適用之權益方案 |

### 步驟 3：重跑 Pre-flight 直至 `ready === true`
完成修復後，再次呼叫 `recommendation_preflight`。確認 `ready === true` 且無致命診斷錯誤。

### 步驟 4：執行 `recommend` 產生推薦
呼叫 `recommend` 工具，設定 `limit: 5`，取得排序清單與組件拆解。

### 步驟 5：呈現使用者結果
輸出必須清晰呈現：
1. **推薦卡片排名**與預估總回饋。
2. **回饋組件拆解**：基本國內/國外回饋 + 加碼活動回饋。
3. **上限池狀態**：此筆消費將消耗多少上限、是否即將達頂。
4. **權益門檻提醒**：例如「需綁定電子帳單」、「需於月底前至 App 登錄」。
