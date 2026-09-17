# 商家實體消歧義標準作業程序 (Merchant Resolution SOP)

本標準作業程序規範 Agent 在推薦比價流程中收到 `merchant_ambiguous` 或 `merchant_not_found` 診斷代碼時的具體處置步驟。

---

## 1. 處置流程

```text
recommend 回傳 requiredActions
       │
       ├─► 診斷為 merchant_ambiguous ──► 條列候選實體向使用者提問 ──► 取得選定名稱後重試
       │
       └─► 診斷為 merchant_not_found ──► 提示未收錄並以自訂特店帶入 ──► 回退基礎回饋重試
```

### 情境 A：特店名稱歧義 (`diagnostic.code === 'merchant_ambiguous'`)
- **現象**：使用者輸入的名稱匹配到型錄中多個實體（例如「全家」可能為「全家便利商店」或「全家國際餐飲」；「Uber」可能為「網約車」或「Uber Eats 外送」）。
- **Agent 具體處置步驟**：
  1. 檢視 `action.candidateIds` 或 `action.diagnostic.message`。
  2. 向使用者發問，條列出 2~3 個候選選項：
     > 「請問您的消費是在：
     > 1. 全家便利商店（超商通路）
     > 2. 全家國際餐飲（餐飲通路）？」
  3. 等待使用者回覆。
  4. 將使用者確認的店家名稱填入 `recommend` 的 `merchant` 欄位重新調用：
     ```javascript
     recommend({
       merchant: "全家便利商店",
       amount: { amountMinor: 15000, currency: "TWD" },
       expectedResultVersion: response.resultVersion
     })
     ```

### 情境 B：未收錄特店 (`diagnostic.code === 'merchant_not_found'`)
- **現象**：特店名稱未收錄於在地型錄白名單中（例如巷口早餐店、獨立咖啡店）。
- **Agent 具體處置步驟**：
  1. 若使用者已知為具體品牌，直接將使用者輸入之名稱保留在 `merchant` 欄位。
  2. 若具備行業特徵（如「餐廳」、「機票」），可補充 `channel`（如 `in_store`、`online`）欄位重新調用。
  3. 系統將自動回退至該卡片的一般國內/國外消費基礎回饋。
