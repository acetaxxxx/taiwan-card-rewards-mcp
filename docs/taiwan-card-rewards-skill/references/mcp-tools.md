# 權威 MCP 工具目錄與全域架構手冊 (Canonical MCP Tools & Architecture Reference)

本文件為 `taiwan-card-rewards-mcp` 系統的**全域工具權威目錄與底層約束規範**。
目前公開契約嚴格收錄 **28 個工具**，所有工具名稱、封閉輸入欄位（Closed Schemas）、列舉值域（Closed Enums）與 Fail-Closed 錯誤代碼均以 `src/mcp-contract.ts`、`src/validation.ts` 與 `src/cli.ts` 為唯一真理來源。

---

## 1. 漸進式揭露架構導引 (Progressive Disclosure)

為維持高訊噪比並避免 Context 混亂，本 Skill 體系採取三層漸進式揭露：
- **Level 1（意圖路由）**：各目錄之 `SKILL.md`，負責意圖識別與分流。
- **Level 2（專門工作流程與專屬工具規格）**：針對特定情境，直接查閱專屬工具規格與 Payload 骨架：
  - 🛍️ **消費推薦與試算** ➔ [`recommendation-tools-specification.md`](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-recommendation/workflows/recommendation-tools-specification.md) (4 工具)
  - 📜 **卡片/權益/條款研究** ➔ [`evidence-tools-specification.md`](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md) (19 工具)
  - 💳 **記帳/對帳/跨事件連鎖** ➔ [`ledger-tools-specification.md`](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md) (8 工具)
- **Level 3（全域權威與例外手冊）**：
  - 工具總覽與全域枚舉 ➔ 本文件 [`mcp-tools.md`](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/references/mcp-tools.md)
  - 缺失事實與診斷手冊 ➔ [`required-actions-and-diagnostics.md`](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/references/required-actions-and-diagnostics.md)

---

## 2. 28-tool matrix

以下為系統中完整 28 個 MCP 工具的權威清單，依業務領域分類索引：

| Tool | 領域 | 模式 | 核心用途 | 專屬規格手冊 |
|---|:---:|:---:|---|---|
| `recommend` | 推薦 | read | 特店優先的統合推薦入口，同時評估直接刷卡與多層支付路徑 | [推薦規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-recommendation/workflows/recommendation-tools-specification.md#21-recommend) |
| `calculate_reward` | 推薦 | read | 單筆回饋純數學試算（不寫入帳本、不累積 Cap） | [推薦規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-recommendation/workflows/recommendation-tools-specification.md#22-calculate_reward) |
| `resolve_merchant` | 推薦 | read | 驗證特店識別資訊或查詢特店候選清冊 | [推薦規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-recommendation/workflows/recommendation-tools-specification.md#23-resolve_merchant) |
| `search_active_offers` | 推薦 | read | 有界搜尋生效中之優惠條款規則 | [推薦規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-recommendation/workflows/recommendation-tools-specification.md#24-search_active_offers) |
| `register_card` | 卡片/權益 | write | 登記持卡清冊描述符（嚴禁卡號與 CVV） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#register_card) |
| `list_cards` | 查詢共用 | read | 查詢使用者已登記之卡片清單 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#list_cards) |
| `get_user_benefit_status` | 卡片/權益 | read | 查詢指定卡片目前啟用的權益方案或活動登錄狀態 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#get_user_benefit_status) |
| `upsert_user_benefit_status` | 卡片/權益 | write | 記錄使用者確認切換的方案或活動登錄紀錄 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#upsert_user_benefit_status) |
| `upsert_offer` | 條款快速路徑 | write | 快速路徑：原子寫入官方來源快照與優惠規則 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#22-快速優惠規則建立upsert_offer) |
| `create_ingestion` | 條款 Ingestion | write | 建立或恢復一個 source-scoped Ingestion 草稿流程 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#create_ingestion) |
| `get_ingestion` | 條款 Ingestion | read | 讀取 MCP 決定的下一個 Ingestion 動作與葉節點覆蓋進度 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#get_ingestion) |
| `submit_ingestion_source` | 條款 Ingestion | write | 提交官方來源不可變快照（MCP 不會主動抓取外部網址） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#submit_ingestion_source) |
| `submit_ingestion_manifest` | 條款 Ingestion | write | 提交完整條款清單（Manifest）並驗證依賴拓撲無環 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#submit_ingestion_manifest) |
| `correct_ingestion_manifest` | 條款 Ingestion | write | 全量勘誤條款清單，保留舊修訂版之血統關聯 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#correct_ingestion_manifest) |
| `submit_benefit_leaf` | 條款 Ingestion | write | 逐一實體化優惠加碼葉節點為 Candidate Rule（未發布前外部隱形） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#submit_benefit_leaf) |
| `submit_exclusion_leaf` | 條款 Ingestion | write | 逐一提交排除條件葉節點（可設定忽略或生效層級） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#submit_exclusion_leaf) |
| `finalize_ingestion` | 條款 Ingestion | write | 原子校驗完整 Manifest 覆蓋率，正式發布所有候選規則 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#finalize_ingestion) |
| `upsert_payment_capability` | 支付能力 | write | 登錄公開可用之支付能力與流轉狀態（供路徑規劃使用） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#upsert_payment_capability) |
| `list_payment_capabilities` | 支付能力 | read | 列出公開登錄之所有支付能力 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#list_payment_capabilities) |
| `upsert_payment_route` | 支付路徑 | write | 登錄使用者自訂之支付路徑圖拓撲（支援節點與邊緣轉移） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#upsert_payment_route) |
| `list_payment_routes` | 查詢共用 | read | 列出已登錄之支付路徑清單 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#list_payment_routes) |
| `register_payment_account` | 支付帳戶 | write | 登記電子錢包或連結銀行帳戶身分識別（不存機敏憑證） | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#register_payment_account) |
| `list_payment_accounts` | 查詢共用 | read | 列出已登記之電子錢包或帳戶清單 | [條款/卡片規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-evidence/workflows/evidence-tools-specification.md#list_payment_accounts) |
| `record_transaction` | 記帳帳本 | write | 記錄實際購買或退款交易，原子更新 Cap Pool 上限累計 | [記帳規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md#21-record_transaction) |
| `list_transactions` | 記帳帳本 | read | 查詢歷史實際交易清冊，支援雙時間基準與分頁投影 | [記帳規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md#22-list_transactions) |
| `remaining_caps` | 記帳帳本 | read | 查詢特定卡片目前週期累積後之剩餘可回饋額度 (Cap) | [記帳規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md#23-remaining_caps) |
| `record_event_reward` | 記帳連鎖 | write | 伺服器端重算資格並記錄跨事件（如儲值後扣款）連鎖回饋 | [記帳規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md#24-record_event_reward) |
| `reverse_event_reward` | 記帳連鎖 | write | 依明確退款/反轉關聯原子撤銷先前已入帳的事件回饋 | [記帳規格](file:///Users/hankyin/Practice/taiwan-card-rewards-mcp/docs/taiwan-card-rewards-skill/card-rewards-ledger/workflows/ledger-tools-specification.md#25-reverse_event_reward) |

---

## 3. 全域架構規則與呼叫鐵律 (Global Invariants)

全域調用工具時，Agent 必須恪遵以下核心約束：

### 3.1 欄位命名與自動適配
- **標準命名**：以公開 Schema 定義之 **camelCase** 為準（如 `idempotencyKey`, `observedAt`, `asOfUtc`）。
- **寬容相容**：MCP Adapter 在入口層會自動將 `snake_case` 映射轉換為 camelCase；但**嚴禁在同一物件中混用兩種拼法**。
- **封閉物件檢查**：所有工具一律拒絕未公開欄位，傳入多餘屬性將立即觸發 `INVALID_INPUT` 或 fail-closed。

### 3.2 零敏感憑證鐵律 (Zero Sensitive Data)
- **嚴禁卡號與機敏個資**：全系統禁止接收或存儲信用卡號 (PAN, 13~19 位連續數字)、CVV/CVC、OTP、銀行帳密、Cookie 或 Token。卡片僅以 `cardId`、`last4` 與卡名識別；帳戶僅以 opaque `id` 與 `providerId` 識別。
- **禁絕多租戶洩漏鍵**：嚴禁在 Payload 中傳入 `ownerUser`、`owner_user`、`userId` 或 `user_id`，使用者身分由伺服器認證上下文嚴格控管。

### 3.3 信任模型與伺服器端重算防線
- **自報事實 (Agent-Asserted Facts)**：匯率快照 (`fx`)、資格事實 (`eligibilityFacts`) 與證據關聯 (`evidenceIds`) 採信任自報機制，通過型別與時效驗證後即套用，不需要前置呼叫額外的存儲工具。
- **伺服器端權威核算**：在 `record_event_reward` 與 `record_transaction` 中，回饋金額與累積上限一律由伺服器端嚴格重算，Agent 無法自行偽造 `matched` 或規避上限。
- **嚴格退款關聯**：退款或反轉（`reverse_event_reward` / `record_transaction` with refund）必須明確關聯至**唯一一筆已存在的原交易**，嚴禁孤立退款。

---

## 4. 全域封閉枚舉對照表 (Closed Enums Index)

以下為全系統在 Runtime 驗證中嚴格限制的封閉枚舉值域。Agent 在組裝 Payload 時必須精確使用下列特定字串，嚴禁自創別名：

| 欄位名稱 (`path`) | 合法枚舉值域 (`enum`) | 說明 |
|---|---|---|
| `channel` | `'online'` \| `'in_store'` | 交易通路：線上網購/APP 或實體門市 |
| `transaction.kind` | `'purchase'` \| `'refund'` | 交易類型：一般購買扣款或退款反轉 |
| `transaction.mode` | `'planned'` \| `'actual'` | 交易模式：試算推薦 (planned) 或實際記帳 (actual) |
| `rateType` (FX) | `'card_scheme'` \| `'cash_selling'` \| `'spot_selling'` \| `'mid_market'` | 匯率類型：卡組織匯率、現鈔賣出、即期賣出、牌告中價（實際記帳禁用） |
| `conversionOwner` | `'merchant'` \| `'wallet'` \| `'payment_provider'` \| `'card_network'` \| `'issuer'` \| `'bank'` \| `'acquirer'` \| `'card_scheme'` \| `'merchant_dcc'` \| `'unknown'` | 換匯清算責任主體 |
| `funding.kind` | `'credit_card'` \| `'account'` \| `'cash'` | 出資工具種類 |
| `funding.subtype`<br>`account.kind` | `'linked_bank_account'` \| `'wallet_balance'` \| `'foreign_currency_account'` | 帳戶子類型：銀行帳戶、錢包餘額、外幣帳戶 |
| `timeBasis` | `'occurred_at'` \| `'recorded_at'` | 交易歷史時間基準：消費發生時點或記帳入帳時點 |
| `projection` | `'summary'` \| `'detail'` \| `'calculation'` \| `'audit'` | 查詢投影深度 |
| `card.network` | `'VISA'` \| `'MasterCard'` \| `'JCB'` \| `'AmericanExpress'` | 國際卡組織網路名稱（區分大小寫） |
| `leaf.kind` | `'benefit'` \| `'exclusion'` | Ingestion 條款種類：加碼優惠或排除條件 |
| `leaf.disposition` | `'materialized'` \| `'ignored'` \| `'superseded'` | 葉節點歸宿：實體化、忽略不適用、被覆蓋 |
| `exclusion.target` | `'merchant'` \| `'transaction_fact'` \| `'payment_route'` \| `'payment_method'` | 排除目標層級 |
| `transitions` | `'card_authorization'` \| `'account_debit'` \| `'wallet_top_up'` \| `'wallet_debit'` \| `'service_to_acceptance'` \| `'merchant_settlement'` \| `'direct_settlement'` \| `'split_tender'` | 支付路徑流轉狀態轉移 |
| `paymentRouteLayer.kind` | `'merchant_loyalty'` \| `'merchant_acceptance'` \| `'consumer_app'` \| `'payment_provider'` \| `'wallet'` \| `'interoperability_scheme'` \| `'intermediate_provider'` \| `'card_network'` \| `'card_issuer'` | 支付路由層級角色 |
| `capPool.metric` | `'spend'` \| `'reward'` \| `'transaction_count'` | Cap 額度度量：累積消費、累積回饋、交易筆數 |
| `capPool.period` | `'calendar_month'` \| `'billing_cycle'` \| `'quarter'` \| `'year'` \| `'campaign'` | Cap 週期：日曆月、帳單週期、季、年、活動期間 |
| `rule.status` | `'candidate'` \| `'active'` \| `'stale'` \| `'superseded'` \| `'needs_review'` \| `'unknown'` | 優惠規則狀態 |
| `user_benefit_status.kind` | `'card_switch'` \| `'campaign_registration'` | 使用者權益狀態類別：方案切換或活動登錄 |
| `user_benefit_status.action` | `'record'` \| `'adjust'` | 權益操作：記錄或校正 |
| `trustBasis` | `'official_verified'` \| `'user_confirmed'` | 信任基礎：官方核實或使用者確認 |

---

## 5. 廢棄工具警告 (Deprecated Tools)

以下名稱已徹底從合約與 Dispatch 層完全移除，呼叫將直接回傳 `TOOL_NOT_FOUND`，嚴禁在任何代碼或對話中引用：
- ❌ **外幣舊工具**：`upsert_fx_policy`、`list_fx_policies`、`upsert_fx_observation`、`list_fx_observations`（已整合為 `recommend` inline `fx` 快照）。
- ❌ **推薦前置/排序舊工具**：`recommendation_preflight`（已由 `recommend` 整合）、`rank_cards`（請改用 `calculate_reward`）。
- ❌ **歷史版本後綴別名**：`recommend_payment_paths_v1`、`record_event_reward_v1`、`record_event_reward_v2`、`reverse_event_reward_v1`（請一律使用無版本後綴之正式名稱）。


