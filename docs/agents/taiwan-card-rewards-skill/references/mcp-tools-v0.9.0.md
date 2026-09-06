# MCP Tools v0.9.0 合約規範 (13 Public Tools)

本文件定義 `taiwan-card-rewards-mcp` (v0.9.0) 所提供的 13 項公開 MCP 工具簽名、參數結構與錯誤碼。

---

## 工具總表 (Tool Matrix)

| # | 工具名稱 (Tool Name) | 類型 | 說明 |
|---|---|---|---|
| 1 | `recommendation_preflight` | 唯讀 / 診斷 | 推薦前置診斷：檢查商家、匯率、權益與事實完整度 |
| 2 | `recommend` | 唯讀 / 試算 | 依消費情境回傳最佳卡片排序推薦（支援有界分頁） |
| 3 | `calculate_reward` | 唯讀 / 試算 | 單一卡片精確回饋金額與多組件細目試算 |
| 4 | `rank_cards` | 唯讀 / 試算 | 多張卡片回饋金額純排序（不含複雜推薦建議） |
| 5 | `resolve_merchant` | 唯讀 / 查詢 | 商家識別碼消歧義與候選比對 |
| 6 | `search_active_offers` | 唯讀 / 查詢 | 檢索指定卡片、通路或期間之有效促銷規則 |
| 7 | `list_cards` | 唯讀 / 查詢 | 列出使用者已登記之所有信用卡清冊 |
| 8 | `remaining_caps` | 唯讀 / 查詢 | 查詢指定卡片、月份或全期上限池之剩餘額度 |
| 9 | `get_user_benefit_status` | 唯讀 / 查詢 | 查詢使用者已選擇之權益方案或登錄狀態 |
| 10 | `register_card` | 寫入 / 管理 | 登記使用者持有的信用卡至個人資料庫 |
| 11 | `upsert_offer` | 寫入 / 管理 | 新增或更新卡片優惠活動快照與規則定義 |
| 12 | `upsert_user_benefit_status` | 寫入 / 管理 | 更新使用者權益方案選擇（如 CUBE 切換）或活動登錄紀錄 |
| 13 | `record_transaction` | 寫入 / 記帳 | 記錄實際消費扣減上限池，或記錄退款以對沖額度 |

---

## 1. 核心推薦與診斷工具

### `recommendation_preflight`
- **用途**：在執行正式推薦前，診斷消費情境是否存在缺少事實、過期匯率或商家歧義。
- **輸入參數**：
  - `amount`: `number` (必填，消費金額)
  - `currency`: `string` (必填，三位 ISO 幣別，如 `"TWD"`, `"JPY"`)
  - `merchantName`: `string` (選填，商家名稱)
  - `merchantId`: `string` (選填，權威商家識別碼 `mch_...`)
  - `paymentRoute`: `PaymentRouteContext` (選填，支付通道結構)
  - `targetDate`: `string` (選填，ISO 8601 日期)
  - `fxSnapshot`: `FxSnapshot` (選填，外幣匯率快照)
- **回傳結構**：
  - `ready`: `boolean` (是否已準備就緒可直接執行 `recommend`)
  - `requiredActions`: `string[]` (待修復動作：`"clarify_merchant"`, `"refresh_external_data"`, `"research_evidence"`, `"register_card"`, `"review_conflict"`)
  - `diagnostics`: `DiagnosticDetail[]` (診斷細節與問題說明)
  - `dataVersion`: `string` (目前資料與規則版本號)

### `recommend`
- **用途**：執行最佳用卡推薦與排序，提供清晰的組件回饋拆解。
- **輸入參數**：
  - `amount`: `number` (必填)
  - `currency`: `string` (必填)
  - `merchantId`: `string` (選填)
  - `paymentRoute`: `PaymentRouteContext` (選填)
  - `targetDate`: `string` (選填)
  - `fxSnapshot`: `FxSnapshot` (選填)
  - `limit`: `number` (選填，預設 5，最大 20)
  - `cursor`: `string` (選填，分頁游標)
- **回傳結構**：
  - `recommendations`: `CardRecommendation[]`
    - `cardId`: `string`
    - `cardName`: `string`
    - `totalRewardEstimated`: `number`
    - `effectiveRate`: `number` (百分比，如 0.035 代表 3.5%)
    - `components`: `RewardComponentBreakdown[]` (基礎、加碼、活動拆解)
    - `capImpact`: `CapImpactDetail[]` (各上限池消耗預估)
    - `prerequisitesMet`: `boolean`
    - `warnings`: `string[]`
  - `nextCursor`: `string | null`
  - `hasMore`: `boolean`

---

## 2. 試算與商家工具

### `calculate_reward`
- **用途**：針對單一特定卡片計算回饋細節。
- **輸入參數**：`cardId`, `amount`, `currency`, `merchantId`, `paymentRoute`, `targetDate`, `fxSnapshot`.
- **回傳結構**：`RewardCalculationResult` (含總回饋金額、幣別、點數類型與各組件計算過程)。

### `resolve_merchant`
- **用途**：傳入模糊商家字串，比對資料庫並回傳候選商家識別碼。
- **輸入參數**：`query: string`, `limit?: number`.
- **回傳結構**：`MerchantCandidate[]` (含 `merchantId`, `canonicalName`, `category`, `confidence`, `aliases`)。

---

## 3. 寫入與記帳工具

### `record_transaction`
- **用途**：記錄實際消費以扣減上限池，或記錄退款。
- **輸入參數**：
  - `idempotencyKey`: `string` (必填，唯一防重鍵，如 `"tx_req_20260906_001"`)
  - `cardId`: `string` (必填)
  - `amount`: `number` (必填，正數為消費，負數為退款)
  - `currency`: `string` (必填)
  - `transactionDate`: `string` (必填，ISO 8601)
  - `merchantId`: `string` (選填)
  - `paymentRoute`: `PaymentRouteContext` (選填)
  - `refundReferenceTxId`: `string` (選填，退款時關聯之原始交易 ID)
- **回傳結構**：`TransactionRecordResult` (含 `transactionId`, `recordedReward`, `updatedCapBalances`)。

---

## 4. 系統標準錯誤代碼 (Error Codes)

| 錯誤碼 | 說明 | 代理人處理方式 |
|---|---|---|
| `LOCK_EXISTS` | 資料目錄已有其他行程鎖定 | 提示使用者稍後重試，確認無殘留背景行程 |
| `SENSITIVE_FIELD_FORBIDDEN` | 請求含卡號(PAN)/CVV/OTP等敏感欄位 | 立即移除敏感欄位後重新發送請求 |
| `INSUFFICIENT_FACTS` | 缺少必要事實（如時區、幣別或匯率） | 執行 Preflight 診斷，向使用者確認或補齊事實 |
| `STALE` | 規則或匯率快照已逾期失效 | 啟動 Research SOP 檢索官方最新資料並更新快照 |
| `IDEMPOTENCY_CONFLICT` | 同一冪等鍵重複提交且參數不一致 | 檢查是否生成新的交易請求或重新確認交易參數 |
| `STORE_UNAVAILABLE` | 檔案系統無權限或無法寫入 | 檢查磁碟空間與 `--data-dir` 讀寫權限 |
