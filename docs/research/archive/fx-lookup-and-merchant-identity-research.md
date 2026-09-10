# FX Lookup Boundary & Market-Aware Merchant Identity Mapping Research

> **文件狀態**：Lead-reviewed research report；以 repo source code、TypeScript 型別、驗證器、架構設計文件 (`docs/design/codebase-design.md`) 及測試案例為 primary sources 之專題研究報告。
> **查詢日期**：2026-09-05
> **研究目標**：針對即將拆分的兩個正式規格 Ticket 提供事實基礎與驗收標準 (Acceptance Criteria)：
> 1. **Ticket A**：Agent-supplied FX lookup, provenance, freshness, and fail-closed boundary
> 2. **Ticket B**：Market-aware MerchantIdentity, alias mapping, and ambiguous match fail-closed

---

## 1. 現行程式碼事實與實作狀態 (Current Codebase State)

### 1.1 FX 匯率與估值實作盤點 (Topic A)
- **已實作部分**：
  - **型別定義**：[`src/types.ts:196-203`](../../src/types.ts#L196-L203) 定義了 `FxSnapshot`：
    ```typescript
    export interface FxSnapshot {
      id: string;
      baseCurrency: string;
      quoteCurrency: string;
      ratePpm: number;
      capturedAt: string; // ISO 8601
      maxAgeSeconds?: number | undefined;
    }
    ```
  - **驗證器**：[`src/validation.ts:305-320`](../../src/validation.ts#L305-L320) 驗證 `tx.fx` 欄位（`id`, `baseCurrency`, `quoteCurrency`, `ratePpm`, `capturedAt`, `maxAgeSeconds`）。
  - **純計算核心**：[`src/evaluator.ts:187-188, 314-324`](../../src/evaluator.ts#L187-L324)：
    - 整數折算：`Math.floor((amount.amountMinor * tx.fx.ratePpm) / 1_000_000)`。
    - 幣別匹配：要求 `fx.baseCurrency === tx.amount.currency` 且 `fx.quoteCurrency === rule.settlementCurrency`。
    - 新鮮度檢驗：`Math.abs(txTime - fxTime) > maxAgeMs`（預設 7 日 TTL），逾期回傳 `status: 'stale'`。
    - 缺少匯率：外幣交易缺少 `fx` 時回傳 `status: 'unknown'`, `unknownReasons: ['missing FX snapshot for settlement currency']`。
- **尚未實作部分 (Design Gap)**：
  - `docs/design/codebase-design.md:244` 提及的 `FxAndValuationBook` 與「遠端 FX provider adapter」**在 runtime code 完全未實作**。
  - 目前 MCP Server 本身是無狀態且不連網的（Zero Network I/O），完全依賴呼叫端於 `transaction.fx` 提供快照。

### 1.2 特店識別與 Alias Mapping 盤點 (Topic B)
- **已實作部分**：
  - **型別定義**：[`src/types.ts:131, 218`](../../src/types.ts#L131) 僅有字串欄位 `tx.merchant?: string` 與 `rule.match.merchants?: string[]`。
  - **比對邏輯**：[`src/evaluator.ts:38-49`](../../src/evaluator.ts#L38-L49)：
    ```typescript
    const has = (value, allowed) => !allowed?.length ? true : (value === undefined ? undefined : allowed.includes(value));
    ```
  - **現狀**：僅支援**純字串精確比對 (String Exact-Match)**。
- **尚未實作部分 (Design Gap)**：
  - **無特店別名對照表 (No Alias Table)**：如「全聯」、「全聯福利中心」、「全聯-大安店」、「連加*全聯」無法自動對齊同一實體。
  - **無市場/國家維度特店實體 (No Market-Aware Identity)**：如跨國品牌「Don Don Donki / 唐吉訶德」在台灣與日本的實體無 canonical ID。
  - **無模糊比對衝突判定機制 (No Ambiguity Fail-Closed)**：目前未完全匹配即直接回傳 `no_match`，無法提示 Agent 進行特店確認。

---

## 2. 責任邊界與架構決策 (Responsibility & Trust Boundaries)

### 2.1 Topic A: FX Lookup 與 Provenance 責任邊界

```
┌────────────────────────────────────────────────────────────────────────┐
│ AI Agent / Aion Skill 責任                                              │
│  - 連網查詢官方銀行牌告匯率 (台銀、玉山、兆豐) 或合規匯率 API             │
│  - 取得匯率數值，計算整數 PPM (ratePpm = round(rate * 1,000,000))        │
│  - 封裝為不可變 FxSnapshot 並附帶 provenance (來源 URL、時間戳、Provider) │
└──────────────────────────────────┬─────────────────────────────────────┘
                                   │ 傳入 transaction.fx (JSON-RPC)
                                   ▼
┌────────────────────────────────────────────────────────────────────────┐
│ MCP Server / Evaluator 責任 (純確定性計算與驗證)                        │
│  - 絕不主動發起網路請求、絕不隨意猜測匯率                                │
│  - 嚴格校驗幣別配對 (baseCurrency, quoteCurrency)                      │
│  - 嚴格校驗時間戳有效性與 TTL (超過 maxAgeSeconds ➔ status: 'stale')     │
│  - 執行純整數定點數乘除 (Floor integer arithmetic)                     │
│  - 缺匯率 ➔ fail-closed (status: 'unknown', missing FX snapshot)       │
└────────────────────────────────────────────────────────────────────────┘
```

#### 建議新增 Provenance 欄位：
在 `FxSnapshot` 中擴充：
- `provider`: string (例如 `"bank_bot"`, `"bank_esun"`, `"open_exchange_rates"`)
- `sourceUrl`?: string (牌告匯率頁面 URL)
- `retrievedAt`: string (ISO 8601 UTC)
- `rateType`: `'cash_selling' | 'spot_selling' | 'mid_market' | 'card_scheme'`

---

### 2.2 Topic B: Market-Aware MerchantIdentity 規範

#### 實體資料模型 (Data Contract)：
```typescript
export interface MerchantIdentity {
  /** 唯一標準化 ID，例如 "tw_pxmart", "tw_wowprime", "jp_dondondonki" */
  canonicalId: string;
  /** 顯示名稱，例如 "全聯福利中心", "王品牛排" */
  displayName: string;
  /** 市場/國家代碼 (ISO 3166-1 alpha-2)，例如 "TW", "JP", "US", "GLOBAL" */
  market: string;
  /** 標準 MCC 代碼清單，例如 ["5411"] */
  mccs?: readonly string[] | undefined;
  /** 常見別名清單 (精確比對) */
  aliases: readonly string[];
  /** 帳單明細正則匹配樣式 (Regex Patterns)，例如 ["^全聯.*", "^連加\\*全聯.*", "^全支付-全聯.*"] */
  statementPatterns?: readonly string[] | undefined;
}
```

#### 比對演算法與 Fail-Closed 規則：
1. **正規化比對流程**：
   - Step 1: 檢查 `tx.merchant` 是否等於 `canonicalId` 或任一 `aliases`。
   - Step 2: 檢查 `tx.merchant` 是否符合 `statementPatterns`。
   - Step 3: 若規則限定 `country`，必須與 `MerchantIdentity.market` 保持一致（或 market 為 `"GLOBAL"`）。
2. **多重匹配與歧義處理 (Ambiguity Fail-Closed)**：
   - 若單一 `tx.merchant` 命中多個不同的 `canonicalId`（例如「大三元」同時匹配粵菜餐廳與茶飲店），或匹配信心度不足：
   - 評估器**嚴禁猜測**，必須回傳 `status: 'needs_review'`，`unknownReasons: ['ambiguous_merchant_identity']`，要求 Agent 向使用者確認具體店家。

---

## 3. 建議 Spec Ticket 之驗收標準 (Acceptance Criteria)

### 3.1 Ticket A: Agent-Supplied FX Lookup, Provenance, Freshness, and Fail-Closed Boundary

- **AC 1 (契約完整性)**：`FxSnapshot` 包含 `id`, `provider`, `baseCurrency`, `quoteCurrency`, `ratePpm`, `capturedAt`, `maxAgeSeconds`, 可選 `sourceUrl`，並於 `tools/list` schema 完整暴露。
- **AC 2 (純確定性整數運算)**：計算外幣折算金額嚴格使用 `Math.floor((amountMinor * ratePpm) / 1_000_000)`，零浮點誤差。
- **AC 3 (嚴格時效檢驗)**：若 `|tx.occurredAt - fx.capturedAt| > maxAgeSeconds`（預設 604,800 秒），回傳 `status: 'stale'`。
- **AC 4 (Fail-Closed 邊界)**：外幣交易缺少符合幣別對之 `fx` 時，一律回傳 `status: 'unknown'` 與 `unknownReasons: ['missing FX snapshot for settlement currency']`；MCP 本體零網路呼叫。
- **AC 5 (向後相容)**：本幣交易（`amount.currency === settlementCurrency`）無需 `fx` 欄位。

---

### 3.2 Ticket B: Market-Aware MerchantIdentity, Alias Mapping, and Ambiguous Match Fail-Closed

- **AC 1 (MerchantIdentity 定義)**：定義具備 `canonicalId`, `displayName`, `market`, `aliases`, `statementPatterns`, `mccs` 之標準介面。
- **AC 2 (標準化解析層)**：規則比對支援 `canonicalId`、精確 `aliases` 與 `statementPatterns` 正則解析，正確將「連加*全聯」或「全聯-大安」解析為 `tw_pxmart`。
- **AC 3 (市場/國家邊界檢驗)**：`tx.country` 與 `merchant.market` 衝突時（例如在日本使用台灣全聯特店規則），判定為不符合或 `needs_review`。
- **AC 4 (歧義防護 Fail-Closed)**：當特店字串匹配多個衝突之 `canonicalId` 時，回傳 `status: 'needs_review'` 與 `unknownReasons: ['ambiguous_merchant_identity']`。
- **AC 5 (零硬編碼網路請求)**：特店目錄作為純資料結構注入 `EvaluationContext` 或作為標準 Catalog 版本，計算核心維持純函數。

---

## 4. 結論與後續步驟

1. **現狀確認**：目前 codebase **無** runtime FX provider adapter，**無** `FxAndValuationBook` 類別，**無** merchant alias 對照表；現行為純粹的 Agent-supplied snapshot 與 string exact-match。
2. **規格推進**：上述責任邊界與 AC 已具備充分之 primary source 證據，可立即作為 Ticket `01a0719f-0749-7c81-807d-53dbb483be98` (MerchantIdentity) 與 Ticket `01a0719f-141a-7b32-a590-db07a4a9ea2f` (FX Lookup) 之正式規格撰寫依據。
