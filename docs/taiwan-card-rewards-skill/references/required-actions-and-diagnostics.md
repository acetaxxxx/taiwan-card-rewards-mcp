# 缺失事實與診斷代碼通用處置手冊 (Required Actions & Diagnostics Reference)

本手冊為全技能套件（推薦、研究/登錄、記帳）在遇到 MCP 回傳非成功狀態、缺少事實 (`missing_required_fact` / `INSUFFICIENT_FACTS`) 或診斷代碼時的**唯一權威查表依據**。

---

## 1. 核心原則 (Core Principles)

1. **依據 `owner` 決定處置主體**：
   - 若 `owner: "user"`：**必須**向使用者詢問或確認，嚴禁 Agent 自行猜測或虛構。
   - 若 `owner: "agent"`：**必須**由 Agent 自行在外部查核或組裝，嚴禁向使用者索取技術參數（如 PPM 匯率、內部 ID）。
2. **依據 `submission` 鎖定回填目標**：
   - MCP 回傳的 `submission.tool` 與 `submission.field` 明確指定了補齊事實後應送回的工具與欄位名稱。
3. **版本鎖定重試**：
   - 重試時帶入上次回傳的 `expectedResultVersion: response.resultVersion`，防止並行資料漂移。

---

## 2. `requiredActions` 四大類缺失事實處置矩陣 (四大情境統一通用)

當回應帶有 `requiredActions` 陣列時，Agent 依據 `action.path` 查閱下表進行標準處置：

| 分類 | 觸發路徑 (`action.path`) | 責任人 (`owner`) | MCP 指引之 `action` | 補齊目標與欄位 (`submission`) | Agent 具體 SOP 行動與重試條件 |
|---|---|:---:|---|---|---|
| **1. 交易核心要素** | `amount`<br>`merchant` | `user` | `ask_user`<br>`resolve_merchant` | `{ tool: "recommend", field: "amount" }`<br>`{ tool: "recommend", field: "merchant" }` | 向使用者詢問消費金額與幣別；或遇到特店歧義時呈現 2~3 個具體選項供使用者選定，回填後以相同意圖重試。 |
| **2. 使用者資格事實** | `eligibilityFacts`<br>（如 `user.membership`、`card_switch`） | `user` | `ask_user`<br>`resolve_conflict` | `{ tool: "recommend", field: "eligibilityFacts" }` | 向使用者確認持卡身份或權益方案（如「您目前是金卡會員嗎？」或「CUBE卡目前設定哪個方案？」），將自報 fact 填入 `eligibilityFacts` 重試。 |
| **3. 支付工具缺失** | `paymentCapabilities.<id>` | `user` | `bind_payment_method` | `{ tool: "register_card", field: "card" }` 或 `{ tool: "register_payment_account", field: "account" }` | 告知使用者：「此支付路徑需要特定信用卡或電子錢包」，引導使用者調用 `register_card` 登記，或切換其他支付方式。 |
| **4. 結算與清算要素** | `timezone`<br>`transaction.fx`<br>`event.fx` | `agent` | `query_approved_fx_source`<br>`refresh_fx_snapshot` | `{ tool: "recommend", field: "fx" }`<br>或補齊 `timezone` | 若缺少時區，於時間欄位帶入 ISO 8601 時區偏移（如 `+08:00`）；若缺少匯率，前往 `fxResolutionRequest.sourceUrls` 查核並組裝 `fx` 快照後重試。 |

---

## 3. 系統通用診斷代碼處置對照表 (Diagnostic Codes)

| 診斷代碼 (`code`) | 責任人 | 說明 | Agent 標準處置指南 |
|---|:---:|---|---|
| `merchant_ambiguous` | `user` | 特店名稱匹配到型錄多個實體 | 向使用者列出選項確認，更新 `merchant` 後重試。 |
| `merchant_not_found` | `agent` | 特店尚未收錄於在地型錄 | 將使用者輸入之品牌名稱作為自訂特店重新調用。 |
| `missing_required_fact` | `user`/`agent` | 缺少必要之交易或資格條件 | 依上方第 2 節查表補齊事實後重試。 |
| `fx_missing` | `agent` | 外幣交易缺少對應匯率快照 | 依 `fxResolutionRequest.sourceUrls` 查核牌告匯率，組裝 `fx` 物件後重試。 |
| `fx_stale` | `agent` | 匯率快照超出新鮮度上限 | 重新查詢當下最新即時匯率並更新 `capturedAt` 後重試。 |
| `conflicting_fact` | `user` | 資格條件或權益狀態衝突 | 向使用者詢問最新真實狀態，填入 `eligibilityFacts`。 |
| `stale_rule` / `needs_review` | `agent` | 權益可能已到期或需人工覆核 | 候選卡片標記為待覆核，或提示使用者載入 Ingestion 流程更新。 |
| `INVALID_REFUND` | `agent`/`user` | 原交易不存在、卡片不符或退款超額 | 調用 `list_transactions` 核對原交易，修正 `refundOfId` 或退款金額。 |
| `IDEMPOTENCY_CONFLICT` | `agent` | 同一冪等鍵帶入了不同的參數 | 若為同一操作重試，確保 payload 全量一致；若為新操作，產生全新 `idempotencyKey`。 |

---

## 4. Ingestion Flow 專屬異常代碼處置表

| 異常代碼 (`error`) | 觸發原因 | Agent 標準處置指南 |
|---|---|---|
| `INVALID_INPUT: cycle` | Manifest 中葉節點存在循環依賴 | 破除循環依賴，確保排除條款優先宣告（`dependsOn: []`），優惠規則再指向排除條款。 |
| `INVALID_FLOW_ACTION` | 1. 順序跳步<br>2. 未依 `nextAction.leafId` 指定順序送 Leaf | 調用 `get_ingestion({ flowId })`，嚴格只執行 MCP 目前指定的 `nextAction`。 |
| `STALE_REVISION` | 帶入了舊的 `expectedRevision` 或舊的 `actionId` | 調用 `get_ingestion({ flowId })` 取得最新版本號與 actionId，禁止重送舊 actionId。 |
| `SOURCE_SCOPE_CONFLICT` | 提交的來源 URL 與當初宣告的 sourceScope 範圍不合 | 確保 `sourceCapture.url` 屬於宣告之 sourceScope；若為全新網站應開啟新 Draft。 |
| `FLOW_NOT_FOUND` / `expired` | 草稿因超時未活動已被清除 | 舊草稿無法恢復，調用 `create_ingestion` 建立全新 Draft。 |
| `MANIFEST_DIFF_PATCH_FORBIDDEN` | 在修正 Manifest 時嘗試傳入單項差異補丁 | 調用 `correct_ingestion_manifest` 必須傳入包含所有保留項＋修訂項的**完整陣列**。 |
