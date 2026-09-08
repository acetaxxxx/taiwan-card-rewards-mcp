# MCP Tools v0.9.0 合約規範 (20 Public Tools)

本文件定義 `taiwan-card-rewards-mcp` (v0.9.0) 所提供的 20 項公開 MCP 工具簽名、參數結構與錯誤碼。

---

## 工具總表 (Tool Matrix - 20 Public Tools)

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
| 10 | `list_payment_routes` | 唯讀 / 查詢 | 查詢目前使用者已註冊之支付路徑清冊（支援有界分頁） |
| 11 | `register_payment_account` | 寫入 / 管理 | 登記街口等錢包或綁定銀行帳戶的匿名身分與證據（絕不儲存憑據） |
| 12 | `list_payment_accounts` | 唯讀 / 查詢 | 列出目前使用者可供支付路徑引用的帳戶身分 |
| 13 | `register_card` | 寫入 / 管理 | 登記使用者持有的信用卡至個人資料庫 |
| 14 | `upsert_offer` | 寫入 / 管理 | 新增或更新卡片優惠活動快照與規則定義；可在同一次呼叫原子建立一個 candidate merchant |
| 15 | `upsert_payment_route` | 寫入 / 管理 | 登記或更新確認/候選支付路徑拓撲與扣款來源（絕不儲存敏感憑據） |
| 16 | `upsert_user_benefit_status` | 寫入 / 管理 | 更新使用者權益方案選擇（如 CUBE 切換）或活動登錄紀錄 |
| 17 | `record_transaction` | 寫入 / 記帳 | 記錄實際消費扣減上限池，或記錄退款以對沖額度 |
| 18 | `record_event_reward_v1` | 寫入 / 記帳 | 記錄已驗證的事件回饋候選 |
| 19 | `record_event_reward_v2` | 寫入 / 記帳 | 伺服器重算明示跨事件資格後記帳 |
| 20 | `reverse_event_reward_v1` | 寫入 / 記帳 | 依明示退款關係反轉事件回饋 |

---

## 1. 核心推薦與診斷工具

### `recommendation_preflight`
- **用途**：在執行正式推薦前，診斷消費情境是否存在缺少事實、過期匯率或商家歧義。
- **輸入參數**：`transaction: recommendationTransaction`, `context?: EvaluationContext`
- **回傳結構**：`ready: boolean`, `requiredActions: string[]`, `diagnostics: DiagnosticDetail[]`, `dataVersion: string`

### `recommend`
- **用途**：執行最佳用卡推薦與排序，提供清晰的組件回饋拆解。
- **輸入參數**：`transaction: recommendationTransaction`, `cardIds?: string[]`, `merchant?: MerchantIdentity`, `context?: EvaluationContext`, `limit?: number`, `page?: number`, `projection?: "summary" | "detail" | "calculation"`

---

## 2. 支付路徑管理工具 (Payment Route Tools)

> [!IMPORTANT]
> **支付路徑 (Payment Route) 與優惠活動 (Offer) 之區別**：
> - **Payment Route** 定義支付實體拓撲與扣款工具（商家會員層 ➔ 錢包載體 ➔ 中介處理商 ➔ 發卡機構；扣款為信用卡、帳戶或現金）。
> - **Offer** 定義具體的回饋比率、步進、疊加模式與上限池規則。

### `upsert_payment_route`
- **用途**：登記或更新一筆支付路徑拓撲與扣款工具配置。
- **輸入參數**：`route: PaymentRouteDescriptor`
  - `id`: `string` (選填，路徑唯一 ID)
  - `status`: `"candidate" | "active" | "stale" | "conflict" | "needs_review"` (選填)
  - `layers`: `PaymentRouteLayer[]` (必填；可依官方證據使用 `merchant_acceptance`, `consumer_app`, `interoperability_scheme`, `payment_provider`, `intermediate_provider`, `card_network`, `card_issuer`，每層可附 `evidenceIds[]`)
  - `funding`: `PaymentFunding` (必填，`kind: "credit_card" | "account" | "cash"`, `cardId?`, `subtype?: "linked_bank_account" | "wallet_balance" | "foreign_currency_account"`)
  - `sourceUrl`: `string` (選填，官方來源網址)
  - `sourceSnapshotId`: `string` (選填)
  - `contentHash`: `string` (選填)
  - `observedAt`: `string` (必填，ISO 8601 時間)
  - `validFrom`: `string` (選填)
  - `validTo`: `string` (選填)
  - `authority`: `string` (選填)
  - `confidence`: `"high" | "medium" | "low"` (選填)
  - `confirmation`: `{ confirmedAt: string, confirmedBy: string }` (選填，使用者確認紀錄)
  - `evidenceIds`: `string[]` (選填，證明 route/funding/FX/fee 的已提交 evidence)
  - `idempotencyKey`: `string` (必填，唯一防重鍵)
- **安全防線**：嚴禁傳入任何卡號 (PAN)、CVV、OTP 或密碼，違者觸發 `SENSITIVE_FIELD_FORBIDDEN`。

### `list_payment_routes`
- **用途**：查詢目前使用者已登記的支付路徑清冊。
- **輸入參數**：`limit?: number` (1..20), `page?: number` (1-based), `projection?: "summary" | "detail" | "calculation" | "audit"`
- **回傳結構**：`routes: PaymentRouteDescriptor[]`, `page: number`, `limit: number`, `total: number`, `hasMore: boolean`

---

## 3. 系統標準錯誤代碼 (Error Codes)

| 錯誤碼 | 說明 | 代理人處理方式 |
|---|---|---|
| `LOCK_EXISTS` | 資料目錄已有其他行程鎖定 | 提示使用者稍後重試，確認無殘留背景行程 |
| `SENSITIVE_FIELD_FORBIDDEN` | 請求含卡號(PAN)/CVV/OTP等敏感欄位 | 立即移除敏感欄位後重新發送請求 |
| `INSUFFICIENT_FACTS` | 缺少必要事實（如時區、幣別或匯率） | 執行 Preflight 診斷，向使用者確認或補齊事實 |
| `STALE` | 規則或匯率快照已逾期失效 | 啟動 Research SOP 檢索官方最新資料並更新快照 |
| `IDEMPOTENCY_CONFLICT` | 同一冪等鍵重複提交且參數不一致 | 檢查是否生成新的交易請求或重新確認交易參數 |
| `STORE_UNAVAILABLE` | 檔案系統無權限或無法寫入 | 檢查磁碟空間與 `--data-dir` 讀寫權限 |
