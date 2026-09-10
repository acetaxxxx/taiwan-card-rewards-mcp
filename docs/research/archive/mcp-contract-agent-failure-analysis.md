# MCP Tool Schema vs Runtime Validator & Agent Failure Analysis

> **文件狀態**：Lead-reviewed research report；以 repo source code、TypeScript 型別、JSON 驗證器、測試案例及架構規範為 primary sources 之核實分析報告。
> **查詢日期**：2026-09-05
> **研究目的**：針對 AI Agent 呼叫 `taiwan-card-rewards-mcp` 時發生的失敗回報，逐項對照 `tools/list` inputSchema、runtime validator (`src/validation.ts`)、MCP handler (`src/service.ts`, `src/cli.ts`)、型別定義 (`src/types.ts`) 及相關文件，釐清事實、確立責任邊界並提出具體改進建議。

---

## 1. 核心結論摘要 (Executive Summary)

| 分析面向 | 核實結論 | 責任歸屬 | 關鍵證據 (File & Line) |
|---|---|:---:|---|
| **1. `tools/list` Schema 暴露不完整** | **成立 (Defect)** | **MCP Server** | `src/mcp-contract.ts:16-27` 8/10 工具之 `inputSchema` 僅宣告 `required`，缺少 `properties` 子結構定義。 |
| **2. 金額結構 `amount: { amountMinor, currency }` 摩擦** | **成立 (Contract Gap)** | **MCP Server** | `src/validation.ts:53-57, 298-326` 嚴格要求巢狀 `Money` 物件，但 schema 未對外暴露欄位型別，導致 Agent 猜測 `amount` 或 `amountMinor`。 |
| **3. `recommend` 強制要求 `transaction.cardId`** | **成立 (Defect)** | **MCP Server** | `src/service.ts:287` 呼叫 `validateTransaction`，強制要求 `cardId`，但 `src/evaluator.ts:413` 在推薦計算時實質覆蓋 `cardId`。 |
| **4. 外幣與 FX Snapshot 契約未暴露** | **成立 (Documentation Gap)** | **MCP Server** | `src/validation.ts:305-316` 要求 `ratePpm`, `capturedAt` 等結構，但 `tools/list` schema 未聲明 `fx` 屬性。 |
| **5. 多支付路徑與回饋疊加不支援** | **不成立 (Outdated Claim)** | **v0.5.0/v0.6.0 已支援** | `src/types.ts:60-80, 240-272`、ADR 0005、ADR 0006 已完整支援 `route` 與 multi-component ledger。 |
| **6. 靜默遺失資料或隨意覆寫** | **不成立 (False Claim)** | **已受防護** | `src/validation.ts:485`（`INCOMPATIBLE_SCHEMA`）與 `src/store.ts:40-47` 保證零靜默刪除與原子性寫入。 |
| **7. 遇到未知條件與時區需由 Agent 處理** | **成立 (Expected Design)** | **Agent 責任** | `mcpInstructions` 載明 `fail-closed` 原則，Agent 遇到 `unknown`/`needs_review` 須向使用者求證，不可預設為 0。 |

---

## 2. 詳細核實與證據剖析

### 2.1 `tools/list` JSON Schema 缺乏 `properties` 屬性定義 (成立)

#### 程式碼證據：
在 [`src/mcp-contract.ts`](../../src/mcp-contract.ts#L16-L27) 中：
```typescript
export const mcpTools: readonly McpToolContract[] = [
  { name: 'calculate_reward', description: '...', readOnly: true, inputSchema: { type: 'object', required: ['rule', 'transaction', 'context'] } },
  { name: 'rank_cards', description: '...', readOnly: true, inputSchema: { type: 'object', required: ['cards', 'rules', 'transaction', 'context'] } },
  { name: 'register_card', description: '...', readOnly: false, inputSchema: { type: 'object', required: ['card'] } },
  { name: 'list_cards', description: '...', readOnly: true, inputSchema: { type: 'object' } },
  { name: 'upsert_offer', description: '...', readOnly: false, inputSchema: { type: 'object', required: ['snapshot', 'rule'] } },
  { name: 'recommend', description: '...', readOnly: true, inputSchema: { type: 'object', required: ['transaction'] } },
  { name: 'record_transaction', description: '...', readOnly: false, inputSchema: { type: 'object', required: ['transaction'] } },
  { name: 'remaining_caps', description: '...', readOnly: true, inputSchema: { type: 'object', required: ['cardId'], properties: { cardId: { type: 'string' }, asOf: { type: 'string', format: 'date-time' } } } },
  { name: 'get_user_benefit_status', description: '...', readOnly: true, inputSchema: { type: 'object', required: ['kind', 'cardId'], properties: { kind: { type: 'string', enum: ['card_switch', 'campaign_registration'] }, cardId: { type: 'string' }, asOfUtc: { type: 'string', format: 'date-time' } } } },
  { name: 'upsert_user_benefit_status', description: '...', readOnly: false, inputSchema: { type: 'object', required: ['input'] } },
];
```

#### 行為與影響分析：
- **問題**：除了 `remaining_caps` 與 `get_user_benefit_status` 之外，其餘 8 個工具均未提供 `properties` 定義（例如 `transaction` 底下包含哪些欄位、型別為何）。
- **後果**：相容 MCP 協議的 AI Agent（例如 Claude Desktop、OpenAI Assistants、AionCore Agent）在呼叫 `tools/list` 後無法得知參數結構，容易構造出不符合 runtime validator 預期的參數（如傳入未包裝的扁平參數或型別錯誤），進而觸發 `INVALID_INPUT` 或 `UNKNOWN_FIELD`。

---

### 2.2 金額結構 `amount: { amountMinor, currency }` 與欄位命名摩擦 (成立)

#### 程式碼證據：
1. **驗證器要求**：[`src/validation.ts:53-57`](../../src/validation.ts#L53-L57)：
   ```typescript
   export function validateMoney(value: unknown, name: string): Money {
     const item = object(value, name);
     keys(item, ['amountMinor', 'currency'], name);
     return {
       amountMinor: safeInt(item.amountMinor, `${name}.amountMinor`),
       currency: requiredString(item.currency, `${name}.currency`, true).toUpperCase()
     };
   }
   ```
2. **交易結構驗證**：[`src/validation.ts:298-326`](../../src/validation.ts#L298-L326)：
   ```typescript
   export function validateTransaction(value: unknown): TransactionTuple {
     const item = object(value, 'transaction');
     keys(item, ['idempotencyKey', 'cardId', 'kind', 'mode', 'merchant', 'mcc', 'country', 'channel', 'paymentMethod', 'occurredAt', 'amount', 'fx', 'refundOfId', 'originalRewardMinor', 'route', 'settlementAmount'], 'transaction');
     ...
     return {
       cardId: requiredString(item.cardId, 'transaction.cardId', true),
       kind: kind as TransactionTuple['kind'],
       mode: mode as TransactionTuple['mode'],
       occurredAt,
       amount: validateMoney(item.amount, 'transaction.amount'),
       ...
     };
   }
   ```

#### 行為與影響分析：
- **Agent 常見錯誤呼叫**：
  - 傳入 `amount: 1000` ➔ 報錯 `INVALID_INPUT: transaction.amount must be an object`。
  - 傳入 `amountMinor: 100000, currency: "TWD"` 於 transaction 根節點 ➔ 報錯 `UNKNOWN_FIELD: transaction contains unsupported field: amountMinor`。
- **結論**：因為 `tools/list` 沒定義 `transaction.properties.amount` 是物件，Agent 依直覺傳入數值導致驗證失敗。

---

### 2.3 `recommend` 邏輯上不需要 `cardId`，但驗證器強制要求 (成立)

#### 程式碼證據：
1. **`recommend` 服務入口**：[`src/service.ts:286-291`](../../src/service.ts#L286-L291)：
   ```typescript
   recommend(transaction: TransactionTuple, limit = 5): RankingEntry[] {
     transaction = validateTransaction(transaction); // 強制要求 cardId
     if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RewardServiceError('INVALID_INPUT', 'limit must be a safe integer from 1 to 5');
     const state = this.store.read();
     return rankCards(state.cards, state.rules, transaction, this.context(state, nowIso(), transaction), Math.min(5, Math.max(1, limit)));
   }
   ```
2. **`rankCards` 實作**：[`src/evaluator.ts:410-413`](../../src/evaluator.ts#L410-L413)：
   ```typescript
   export function rankCards(cards, rules, tx, context, limit = 5) {
     const entries = cards.map((card) => {
       const cardRules = rules.filter((rule) => rule.cardId === card.id);
       const results = cardRules.map((rule) => evaluateOffer(rule, { ...tx, cardId: card.id }, context));
       ...
   ```

#### 行為與影響分析：
- **問題**：`recommend` 的業務邏輯是對使用者**所有持有卡片**進行最優推薦，`rankCards` 會主動將 `tx.cardId` 替換為當前候選卡片 ID。
- **後果**：當 Agent 進行消費前諮詢「我在全聯消費 1000 元該刷哪張卡？」時，構造的 planned transaction 尚未選定卡片（無 `cardId`），卻被 `validateTransaction` 擋下報錯 `INVALID_INPUT: transaction.cardId must be a valid string`。Agent 必須傳入虛擬假 ID 才能繞過，造成嚴重認知摩擦。

---

### 2.4 外幣與 FX Snapshot 契約 (成立)

#### 程式碼證據：
- 在 [`src/evaluator.ts:314-324`](../../src/evaluator.ts#L314-L324)：
  若交易幣別與規則結算幣別不同（例如日幣消費 vs 台幣結算），必須提供 `tx.fx: { id, baseCurrency, quoteCurrency, ratePpm, capturedAt, maxAgeSeconds }`。
- 若缺少 FX Snapshot，評估器回傳 `status: 'unknown'` 與 `unknownReasons: ['missing FX snapshot for settlement currency']`。
- **結論**：此機制為確定性計算的必要保護，但因 `tools/list` 未宣告 `fx` 欄位與結構，Agent 無法預先感知需要提供 `ratePpm`（百萬分之一匯率）等精確格式。

---

## 3. 因版本迭代 (v0.5.0 / v0.6.0) 已不成立之指控 (False / Outdated Claims)

1. **指控「無法處理電子支付（全支付、LINE Pay 等）與商家 App 回饋疊加」**：
   - **核實**：**不成立**。
   - **證據**：在 ADR 0005、ADR 0006 及 [`src/types.ts:60-80`](../../src/types.ts#L60-L80) 中，已支援 `route: { kind: 'wallet' | 'merchant_app' | 'direct_card', ... }` 與 `settlementAmount`，且規範了 Multi-Component Ledger (`docs/specs/multi-component-ledger-and-cap-attribution-specification.md`)。
2. **指控「MCP 伺服器會靜默刪除舊資料或破壞狀態檔案」**：
   - **核實**：**不成立**。
   - **證據**：在 [`src/validation.ts:485`](../../src/validation.ts#L485) 中，非 v2 格式強制拋出 `INCOMPATIBLE_SCHEMA`，並明確宣告 `data was not deleted`；[`src/store.ts`](../../src/store.ts#L40-L47) 採用原子寫入。
3. **指控「時區處理會隨機猜測或自動預設 UTC」**：
   - **核實**：**不成立**。
   - **證據**：所有時區處理均受 [`validateTimezone`](../../src/validation.ts#L43-L51) 嚴格檢驗，缺少時區時一律 fail-closed。

---

## 4. Agent 呼叫端之責任邊界 (Agent Responsibilities)

下列行為屬於 Agent 呼叫與容錯職責，不應歸咎於 MCP 錯誤：

1. **Fail-Closed 應答處理**：
   - 當 MCP 回傳 `status: "unknown"`、`"needs_review"`、`"stale"` 時，Agent **必須主動向使用者詢問缺少的事實**（如確認是否符合登錄資格、確認匯率），不得自行猜測或將回饋算為 0。
2. **Idempotency Key 供給**：
   - 呼叫 `record_transaction` 時，Agent 必須提供穩定且唯一的 `idempotencyKey`，以支援安全重試。
3. **時間格式遵循 ISO 8601**：
   - `occurredAt` 必須是包含時間與時區標記的 ISO 字串（例如 `2026-09-05T12:00:00Z`），傳入 `2026/09/05` 屬 Agent 格式化錯誤。
4. **推薦前應先查詢卡片清單**：
   - 呼叫 `recommend` 前，Agent 應適時呼叫 `list_cards` 確保資料目錄具備卡片描述檔。

---

## 5. 建議改進方向 (Actionable Recommendations for MCP)

1. **補全 `src/mcp-contract.ts` 中的 `inputSchema.properties`**：
   - 為全部 10 個工具提供完整的 JSON Schema 屬性描述，特別是 `transaction`、`amount`、`fx`、`context`、`rule` 與 `snapshot` 的巢狀屬性。
2. **放寬 `recommend` 工具對 `transaction.cardId` 的強制要求**：
   - 在驗證層允許 `mode: 'planned'` 的 transaction `cardId` 為 optional（或提供專屬的 `PlannedTransactionInput` 驗證器）。
3. **在 `upsert_offer` 的 schema 中補上 `confirmation` 與 `capPools`**：
   - 目前 runtime `validateToolArgs` 支援此兩參數，但 `tools/list` 未宣告。
