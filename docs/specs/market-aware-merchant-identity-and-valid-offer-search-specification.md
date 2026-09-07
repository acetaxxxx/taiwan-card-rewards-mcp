# Market-aware MerchantIdentity 與 Valid-Offer Search 規格

**狀態**：Target normative specification，待獨立 Review
**版本**：0.3.0
**語言**：繁體中文
**遵循**：[`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md), [ADR 0003](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md), [ADR 0004](../adr/0004-generic-benefit-status-and-schema-v2.md), [ADR 0005](../adr/0005-payment-route-opportunity-stacking.md), [ADR 0006](../adr/0006-multi-component-reward-ledger-and-cap-attribution.md), [Schema v2 Specification](card-rewards-schema-v2-specification.md), [Agent-Supplied FX Specification](agent-supplied-fx-and-fail-closed-specification.md).

---

## 1. 問題定義與核心範疇

帳單上的 merchant 字串常有縮寫、外文名稱、全半形差異、口語暱稱或跨市場同名品牌。

### 1.1 命名與語言標準
- 本專案 canonical merchant name 統一使用繁體中文（`zh-Hant-TW`），不隨消費地區或持卡人切換顯示語言。
- `market`、`country`、`channel` 與 `MCC` 是優惠規則的適用條件，不是發卡行或語言造成的另一個商家名稱。
- Agent 負責將自然語言、縮寫與外文轉成 canonical candidate；MCP 負責驗證 identity 並執行規則匹配。

### 1.2 目錄範疇與隔離層級（Catalog Scope & Tenant Isolation）
- **Deployment-Shared Reference Catalog**：`MerchantIdentityCatalog` 採部署層級共用之參考主檔（Reference Catalog），所有租戶共用同一套標準化商家識別與官方別名，避免不同使用者重複建立碎片化商家。
- **Tenant-Isolated Ledger**：使用者的信用卡資訊、持卡事實、實際消費交易（`RecordedTransaction`）與回饋帳本（`RewardLedger`）**嚴格保持租戶/使用者獨立隔離**，共用商家主檔絕不洩漏或交叉污染個人帳本資料。

---

## 2. Agent 與 MCP 的責任分工與資料進場流程

### 2.1 責任邊界
- **LLM Agent**：負責理解自然語言、暱稱、縮寫與跨語言名稱，將其轉成 MCP 已知的 canonical ID 或繁中 canonical name；在市場或 identity 不明時主動向使用者發起消歧義詢問。
- **MCP Server**：負責管理受控的 canonical merchant 資料、驗證 Agent 提交的 canonical merchant fact，並依交易事實自主尋找並評估所有符合的 active rules。
- **計算權威控制**：`recommend` 與 `record_transaction` 不接受 Agent 指定某個 `ruleId` 來決定回饋；`ruleId` 是 MCP 評估後的 trace 結果。Agent 提供的 rule identity 僅在 `upsert_offer` 時使用。

### 2.2 商家與優惠資料進場防線（Ingestion Lifecycle）
商家與優惠資料進入 MCP 必須嚴格遵循以下四階段單向推進流程：

```
┌────────────────────────────────────────────────────────────────────────┐
│                        資料進場生命週期 (Ingestion Lifecycle)            │
├────────────────────────────────────────────────────────────────────────┤
│  1. 可信來源擷取 (Trusted Source Ingestion)                             │
│     • 擷取官方網頁、公告或條款，建立 OfferSourceSnapshot (verified/hash) │
│                                                                        │
│  2. 提案狀態 (Candidate Phase)                                         │
│     • 由 Agent/Maintainer 提案產生 candidate 規則與商家實體             │
│     • 尚未獲得確認前，status = 'candidate'，嚴禁參與正式回饋計算       │
│                                                                        │
│  3. 審核確認 (OfferConfirmation & Audit)                               │
│     • 必須包含來源參照、效期、回饋條件摘要與上限摘要之明確確認           │
│                                                                        │
│  4. 生效啟用 (Active Phase)                                            │
│     • 確認完成後轉換為 status = 'active'，正式進入 ActiveOfferIndex      │
└────────────────────────────────────────────────────────────────────────┘
```

> [!IMPORTANT]
> **推薦流程唯讀防線**：`recommend`、`calculate_reward` 與 `search_active_offers` 為純唯讀評估查詢，**嚴禁在推薦或查詢過程中自動寫入、自動新增或自動啟用任何商家實體或優惠規則**。

---

## 3. Domain Model 與 Identity 生命週期

### 3.1 `MerchantIdentity` 資料模型

```typescript
export interface MerchantProvenance {
  sourceSnapshotId?: string;
  sourceUrl?: string;
  version: string;
  updatedAt: string;
  notes?: string;
}

export interface MerchantIdentity {
  /** 不可變 opaque ULID，格式為 mch_<ULID> */
  canonicalId: string;
  /** 專案統一繁體中文名稱 */
  canonicalNameZhHant: string;
  /** 固定為繁中台灣 */
  canonicalNameLocale: "zh-Hant-TW";
  /** 營運所屬市場 (ISO 3166-1 alpha-2) */
  operatingMarkets?: readonly string[];
  /** 標準關聯 MCC 清冊 */
  mccs?: readonly string[];
  /** 支援通路類型 */
  channels?: readonly ("in_store" | "online")[];
  /** 實體生命週期狀態 */
  status: "candidate" | "active" | "deprecated";
  /** 當 status 為 deprecated 時，指向合併後的新 Canonical ID */
  supersededBy?: string;
  /** 來源溯源資料 */
  provenance: MerchantProvenance;
}
```

### 3.2 Canonical ID 產生機制
1. **MCP 系統權威生成**：`canonicalId` 由 MCP 在受控的 catalog ingestion 流程中生成不可變的 `mch_<ULID>`（例如 `mch_01JABC123XYZ45678901234567`）。現行公開合約可透過 `upsert_offer.merchant` 與候選 rule 原子建立；不得由 caller 傳入或覆寫 ID。
2. **禁止 LLM 自行生成**：LLM Agent 僅能作為候選提案方（Proposer），**嚴禁自行發明、拼接或宣告 Canonical ID**（例如禁止使用英文名稱拼接如 `mch_pxmart_tw` 作為 ID）。
3. **跨發卡行一致性**：同一實體在不同發卡行、信用卡或優惠規則中均引用同一 `canonicalId`。

### 3.3 重複 Identity 與合併生命週期（Deprecation & Supersession）
1. **歷史資料不可竄改（No Historical Rewrite）**：當發現重複建立的商家實體或發生合併時，**絕不竄改或覆寫歷史交易紀錄（`RecordedTransaction`）與帳本記錄**。
2. **軟性廢棄與指向（Deprecation & SupersededBy）**：
   - 被合併或重複的舊實體將其 `status` 設為 `deprecated`。
   - 在舊實體中設定 `supersededBy: "mch_<NewULID>"` 指向有效之新 Canonical ID。
   - 解析引擎在查詢時自動將 `deprecated` 導向新 ID，但歷史帳本與審計軌跡仍保留原始當下的 `canonicalId`。

---

## 4. 雙索引架構（Hybrid Dual-Index）

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              Merchant Resolution Subsystem                             │
├───────────────────────────────────────────┬────────────────────────────────────────────┤
│         1. MerchantIdentityCatalog        │             2. ActiveOfferIndex            │
├───────────────────────────────────────────┼────────────────────────────────────────────┤
│ • 範圍：全已知實體、繁中名稱、營運市場與 MCC│ • 範圍：active + 來源受信任 + 效期內規則   │
│ • 目的：解析 raw query 成為 Canonical ID  │ • 目的：高速優惠規則反向索引與金額試算     │
│ • 特性：支援 Deployment-Shared 參考主檔   │ • 特性：僅載入目前可評估之 active rules    │
└───────────────────────────────────────────┴────────────────────────────────────────────┘
```

### 4.1 MerchantIdentityCatalog (實體主檔索引)
保存已知商家 identity、固定繁中 canonical name、營運市場 metadata、MCC、channel 與 provenance。支援唯讀 canonical identity lookup，但不代表商家目前有優惠。MCP 不保存或推導 Agent 的模糊別名對照表。

### 4.2 ActiveOfferIndex (有效規則反向索引)
由下列條件同時成立的 Offer Rule 動態建立反向索引：
- `status = 'active'`；
- source snapshot 已通過 Calculation Trust Gate（`verified === true`）；
- `asOf` 時間落在有效期間內（`validFrom <= asOf <= validTo`）；
- merchant binding、market、channel、MCC 等條件可明確評估；
- rule version、source snapshot 與 index version 可完整追溯。

### 4.3 Phase 1 vs. Phase 2 演進策略
- **Phase 1 (Rule-Derived Index)**：不預載全球商家清冊。直接由現有 valid `OfferRuleVersion` 提取之 canonical merchant ID、繁中名稱、market 與 provenance 建立記憶體索引。
- **Phase 2 (Pluggable Adapters)**：保留 Ports/Adapters 介面，後續可平滑外接 `BundledCatalogAdapter`（內建靜態清冊）、`RemoteSnapshotCatalogAdapter`（外部受控來源）或 `UserScopedAliasAdapter`（租戶自訂別名），外部 MCP 工具介面維持不變。

---

## 5. 確定性比對流水線（Deterministic Matching Pipeline）

### 5.1 比對優先順序
MCP 比對順序嚴格固定如下：

```
Precedence 1: Exact Canonical ID Match
  └── 檢查 rawInput 是否精準符合 mch_<ULID>（市場隔離）。
Precedence 2: Deterministic Normalized Key Match
  └── 檢查經過 Unicode NFKC、case-fold、全半形轉換、空白壓縮與標點規範化後的 canonicalNameZhHant。
Precedence 3: Market/Country/MCC/Channel 相容性檢核
  └── 驗證解析出之 identity 是否符合交易上下文條件。
Precedence 4: Bounded Candidates (歧義候選生成)
  └── 若多重實體匹配或為語意/模糊候選，嚴禁 auto-accept，一律回傳 status: 'ambiguous' 附帶最多 10 筆候選。
Precedence 5: Unresolved
  └── 查無實體回傳 status: 'unresolved' (INSUFFICIENT_FACTS)。
```

### 5.2 嚴格禁止 Fuzzy Auto-Accept
> [!CAUTION]
> **Anti-Fuzzy Auto-Accept Invariant**：MCP 絕不執行 fuzzy、vector embedding、機器翻譯或語意相似度之直接自動認定；任何非 100% 確定之匹配結果僅能作為候選，**絕不得自動套用至回饋金額或寫入帳本**。

---

## 6. 市場消歧義與 Fail-Closed 邊界

### 6.1 跨市場與多重歧義防護
查詢應盡量提供 `country`、`market`、`channel` 與 `mcc`。若同一商家名稱對應多個市場實體或跨市場條件，且缺少足以消歧之 facts 時，fail-closed 回傳 `needs_facts`：

```json
{
  "status": "needs_facts",
  "diagnostics": [{
    "code": "merchant_ambiguous",
    "path": "transaction.merchant",
    "requiredFacts": ["transaction.country"],
    "retryAction": "ask_user_to_choose_market"
  }]
}
```

*範例*：Agent 將「唐吉軻德」轉換為 canonical candidate 後，若缺少 `country`/`market`，不得自行認定適用日本或台灣優惠；`JP` 與 `TW` 屬於不同市場範疇，資訊不足時必須 fail-closed。

### 6.2 Base Rule 核心不變量（Non-Blocking Base Rules）
1. **`no_active_offer` 狀態**：
   - 商家 identity 成功解析（`status: 'confirmed'`），但用戶持卡並無該商家的專屬加碼規則時，回傳 `no_active_offer`。
   - **`no_active_offer` 明確不代表商家不存在**。
2. **基礎回饋絕不受阻（Base Rule Fallback）**：
   - 當商家為 `no_active_offer`、`unresolved` 或 `ambiguous` 時，僅該商家的專屬加碼規則回傳 `needs_facts` 或 `needs_review`。
   - **卡片的一般消費基礎規則（如「國內一般消費 1%」、「國外一般消費 2%」）必須繼續正常計算並輸出 `status: "ok"`**，絕不得因特定商家未命中而阻擋整張卡片的基本回饋。

---

## 7. MCP Surface 與 Bounded Output

### 7.1 工具職責分離
- **`resolve_merchant` (唯讀實體解析工具)**：
  - 供 Agent 在呼叫 `recommend` 前驗證 canonical identity、進行前置消歧義、取得繁中標準名稱、營運市場與 provenance。
  - 回傳結果包含 `resolutionStatus`、`boundedCandidates` (最多 10 筆)、`requiredFacts` 與版本號。
- **`recommend` (純確定性財務計算排序)**：
  - 專注於依據確定的交易 facts，查詢 `ActiveOfferIndex` 並計算實質回饋金後排序。
  - 自動內嵌 merchant pre-flight；若遇歧義則該加碼規則標記未確認，但不阻擋 Base Rule 計算。
- **`search_active_offers` (唯讀有效優惠探索)**：
  - 讓 Agent 探索 `ActiveOfferIndex` 中 active、未過期且可信的優惠，支援 card、merchant、market、channel 篩選，回傳分頁結果。

### 7.2 負載硬性約束（Bounded Payload Constraints）
- `rawQuery` 長度上限：最多 128 個 Unicode 字元。
- `candidates` 陣列上限：每次最多回傳 10 筆候選。
- `limit` 參數限制：硬性約束於 1..20 之間（`recommend` 支援呼叫端配置上限至 50），預設為 5。
- 分頁機制：採用穩定之 Opaque Cursor 分頁。
- 超出邊界一律回傳 `INVALID_INPUT` 或 `PAYLOAD_TOO_LARGE`，嚴禁靜默截斷或無限制放大搜尋。

---

## 8. 驗收條件

1. **Deployment-Shared Catalog**：`MerchantIdentityCatalog` 作為部署共用參考主檔，使用者交易與帳本資料嚴格隔離。
2. **ULID ID 權威生成**：Canonical ID 格式為 `mch_<ULID>`，由 MCP 系統生成；LLM 僅為提案方，不生成 ID。
3. **不可竄改與軟性廢棄**：重複 identity 合併時不改寫歷史帳本，舊 ID 標記為 `deprecated` 並透過 `supersededBy` 指向新 ID。
4. **進場防線與推薦唯讀**：資料遵循可信來源 $\rightarrow$ candidate $\rightarrow$ 確認 $\rightarrow$ active；推薦流程嚴禁自動寫入任何商家或優惠。
5. **Base Rule 正常運作**：商家為 `no_active_offer` 或 `ambiguous` 時，卡片一般消費基礎回饋仍必須產出 `status: "ok"`。
6. **Anti-Fuzzy & Traceability**：絕無 Fuzzy Auto-Accept；所有解析與計算結果均附帶 catalogVersion、indexVersion、ruleVersion 與完整 provenance。
