# 官方來源研究與 Ingestion 標準作業程序 (Research, Source & Ingestion SOP)

本 SOP 規範 Agent 在建立或更新卡片優惠規則時，如何進行官方條款研究、將原始來源送入 MCP Ingestion 流程，以及快速路徑（`upsert_offer`）的適用情境。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `create_ingestion` | write | 建立或繼續一個 source-scoped ingestion draft | `sourceScope.{kind, value}`, `idempotencyKey` |
| `get_ingestion` | read | 取得 MCP 決定的下一個 action（每次 write 後必須重讀） | `flowId` |
| `submit_ingestion_source` | write | 提交官方來源快照（MCP 不自行抓 URL） | `flowId`, `actionId`, `expectedRevision`, `sourceCapture.{sourceType, retrievedAt, contentHash, artifactRef, submitter, submittedAt}` |
| `submit_ingestion_manifest` | write | 提交完整 benefit/exclusion leaf 清單 | `flowId`, `actionId`, `expectedRevision`, `manifest[].{id, kind, summary, evidenceLocator, dependsOn}` |
| `correct_ingestion_manifest` | write | 建立新的 manifest revision（需全量替換，不可差異補丁） | `flowId`, `actionId`, `expectedRevision`, `idempotencyKey`（必須全新）, `manifest` |
| `submit_benefit_leaf` | write | 逐一提交 MCP 指定的 benefit leaf | `flowId`, `actionId`, `expectedRevision`, `leafId` + benefit rule payload |
| `submit_exclusion_leaf` | write | 逐一提交 MCP 指定的 exclusion leaf | `flowId`, `actionId`, `expectedRevision`, `leafId` + exclusion payload |
| `finalize_ingestion` | write | 原子重驗並啟用所有 candidate rules | `flowId`, `actionId`, `expectedRevision` |
| `upsert_offer` | write | 快速路徑：直接提交 snapshot + rule（不走 leaf 追蹤） | `snapshot.{id, url, fetchedAt, contentHash, sourceType}`, `rule.{id, cardId, version}` |
| `resolve_merchant` | read | 查詢特店的 canonical ID（用於 upsert_offer 快速路徑） | `query` |

---


## 1. 觸發條件 (Trigger Conditions)

進入本 SOP 的時機：
- 使用者詢問「XX 卡的最新優惠是什麼？」並需要主動查找
- `recommend` 回傳 `requiredActions` 包含 `action: "refresh_external_data"` 或 `action: "review_candidate"`
- 卡片 candidate 狀態為 `stale`、`needs_review` 或 `blocked`，且原因是條款過期或來源未驗證

---

## 2. 雙軌資料研究演算法 (Dual-Track Research Algorithm)

```text
// 步驟 1：非官方探索（發現線索）
keywords = "[發卡行名稱] [卡片名稱] [time.Now('YYYY MM')] 優惠 權益"
檢索來源: PTT 信用卡板、Dcard 信用卡板、CardU 卡優新聞網、Money101、iCard.AI
記錄探索線索（URL, 摘要, 查詢時間）
注意: 社群資料僅作線索，嚴禁直接以此建立 active 規則

// 步驟 2：官方來源查核（建立事實）
依據線索前往發卡行官網、官方 PDF 條款、國際卡組織活動頁面
檢查: 來源發布日期、生效期間、截止日是否仍在有效期內
錄取: 官方 URL、頁面快照時間 (retrievedAt)、條款摘要 (excerpt)

// 步驟 3：交叉比對與衝突仲裁
IF 社群線索與官方來源一致:
    進入步驟 4（提交 Ingestion）
IF 社群線索與官方來源衝突:
    Fail-Closed: 標記 NEEDS_REVIEW，向使用者說明矛盾點，回歸官方標準
IF 官方條款已過期 (validTo < now):
    告知使用者，重新檢索最新官方公告，不沿用失效規則
```

### 推薦查核管道清冊
- **官方發卡機構**：各大銀行信用卡權益公告、活動頁面（國泰世華、台北富邦、台新、玉山、聯邦、永豐、中信、星展等）
- **官方支付通道**：LINE Pay、街口支付、全支付 PXPay Plus、台灣Pay、Apple Pay、Google Pay 官方費率公告
- **非官方整理平台（線索用）**：卡優新聞網 (CardU)、Money101、iCard.AI
- **社群討論（線索用）**：PTT `bbs/creditcard`、Dcard 信用卡板、Mobile01 信用卡理財區

---

## 3. 路徑選擇：Ingestion Loop vs upsert_offer 快速路徑

```text
// 判斷使用哪條路徑
IF 需要完整 source manifest 追蹤、多個 benefit leaf、exclusion leaf:
    → 進入 [路徑 A：Ingestion Action Loop]

IF 已有官方來源快照、規則結構簡單、不需要 leaf 層級追蹤:
    → 進入 [路徑 B：upsert_offer 快速路徑]
```

---

## 4. 路徑 A：Ingestion Action Loop (官方溯源完整流程)

> [!IMPORTANT]
> **伺服器主導 (Server-Owned) 原則**：MCP 決定 phase 順序、leaf 依賴順序與 finalization 時機。Agent 必須執行 MCP 回傳的 `nextAction`，不可自行推斷或跳過。

### 4.0 核心概念解析：什麼是 Source、Manifest 與 Leaf？

為了避免 Agent 混淆名詞，以下定義本流程的階層關係：

```text
┌───────────────────────────────────────────────────────────────────┐
│ 1. Source（條款來源全篇）                                         │
│    銀行官網公告、PDF 權益手冊整份文件全文                          │
│    例如：「2026年富邦J卡全年度權益公告.pdf」                      │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │ Agent 研讀後萃取出條款目錄
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ 2. Manifest（條款清單 / 藍圖）                                    │
│    從 Source 萃取出的「條款清單邊界」（Coverage Boundary）       │
│    宣告這篇公告包含哪幾項獨立條款，以及條款之間的依賴關係 (dependsOn)│
└─────────────────────────────────┬─────────────────────────────────┘
                                  │ 由多個不可再分割的單元組成
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ 3. Leaf（條款葉節點 / 最小條款單元）                              │
│    - kind: "benefit"    ── 加碼或基礎回饋（如日韓實體加碼 3%）     │
│    - kind: "exclusion"  ── 排除條件（如排除全聯、超商、菸酒消費）  │
└───────────────────────────────────────────────────────────────────┘
```

#### 葉節點的兩種種類 (`leaf.kind`)
1. **`kind: "benefit"`**：具體的權益加碼或基本回饋規則（需提供匹配通路、卡別、幣別、回饋比率與 Cap Pool）。
2. **`kind: "exclusion"`**：排除通路、特店或特定交易類別（如「不回饋之特定特店清單」或「不適用行動支付」）。若加碼規則依賴排除規則，加碼 leaf 之 `dependsOn` 必須填入該 exclusion leaf ID。

#### 葉節點的三種最終歸宿 (`disposition`)
MCP 要求 Manifest 中的每一片 Leaf 在結束前都必須有明確的歸宿，否則無法 Finalize：
- **`materialized`（實體化）**：成功轉換為候選回饋規則 (`candidate rule`)。
- **`ignored`（忽略）**：該條款在此次流程中不適用（例如：公告中提到「公務人員專屬卡加碼」，但目前處理的是一般卡；必須附帶 `reason` 與 `evidenceRefs`）。
- **`superseded`（被覆蓋）**：該條款已被後面的修訂版本或更精確的條款覆蓋（必須附帶 `reason` 與 `evidenceRefs`）。

---

### 4.1 啟動與 Action Loop 演算法


```text
// 啟動或繼續 Ingestion Draft
create_ingestion({
    sourceScope: {
        kind: "official_url",  // 或 "offer_family"
        value: 官方來源 URL 或系列識別碼
    },
    idempotencyKey: "ingest_<cardId>_<來源摘要>_<日期>"
})
// 取得 flowId

// Ingestion Action Loop
LOOP:
    get_ingestion({ flowId })
    // 讀取: flow.nextAction, flow.coverage, flow.manifestRevision

    SWITCH nextAction.kind:

        CASE "SUBMIT_SOURCE":
            // Agent 自行從官方網站取得來源快照後提交
            submit_ingestion_source({
                flowId,
                actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                sourceCapture: {
                    sourceType: "official",  // 非官方資料不可用此欄位
                    url: 官方來源 URL,
                    description: 條款描述摘要,
                    retrievedAt: Agent 查詢時間（ISO 8601 UTC）,
                    contentHash: "sha256:<雜湊值>",
                    artifactRef: 快照參考識別碼,
                    submitter: "agent",
                    submittedAt: 提交時間（ISO 8601 UTC）
                }
            })
            // 提交後立即 get_ingestion 確認狀態

        CASE "SUBMIT_MANIFEST":
            // 依照官方條款結構提交 manifest（必須等 MCP 給這個 action 才能執行）
            submit_ingestion_manifest({
                flowId,
                actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                manifest: [
                    {
                        id: "leaf_<identifier>",
                        kind: "benefit",  // 或 "exclusion"
                        summary: "條款摘要描述",
                        evidenceLocator: 對應官方條款的位置參考,
                        dependsOn: []  // 若此 leaf 依賴其他 leaf，列出其 ID
                    }
                ]
            })

        CASE "SUBMIT_BENEFIT_LEAF":
            // 每次只提交 MCP 指定的一個 leaf（由 nextAction.leafId 指定）
            IF 該條款適用於當前卡片 (實體化):
                submit_benefit_leaf({
                    flowId,
                    actionId: nextAction.actionId,
                    expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId,
                    idempotencyKey: "leaf_b_<leafId>_<flowId>",
                    evidenceRefs: ["page:1#section-offer"],
                    offer: {
                        snapshot: {
                            id: "snap_<ULID>",
                            url: 官方來源 URL,
                            fetchedAt: 當前 UTC,
                            contentHash: "sha256:<雜湊>",
                            parserVersion: "1.0.0",
                            verified: true,
                            sourceType: "official"
                        },
                        rule: {
                            id: "rule_<cardId>_<leafId>_2026",
                            cardId: 卡片ID,
                            version: "1",
                            sourceSnapshotId: "snap_<ULID>",
                            status: "candidate",  // 未 finalize 前為 candidate
                            validFrom: "2026-01-01T00:00:00Z",
                            validTo: "2026-12-31T23:59:59Z",
                            settlementCurrency: "TWD",
                            match: { channels: ["online", "in_store"] },
                            reward: { kind: "percentage", rateBps: 300 }
                        }
                    },
                    localExclusions: []
                })
            ELSE IF 該條款不適用 (忽略/覆蓋):
                submit_benefit_leaf({
                    flowId,
                    actionId: nextAction.actionId,
                    expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId,
                    idempotencyKey: "leaf_b_ignore_<leafId>_<flowId>",
                    disposition: "ignored",  // 或 "superseded"
                    reason: "此加碼僅適用特定企業聯名卡，本卡不適用",
                    evidenceRefs: ["page:1#fine-print"]
                })

        CASE "SUBMIT_EXCLUSION_LEAF":
            // 每次只提交 MCP 指定的一個排除條款 leaf
            IF 排除條款生效 (實體化):
                submit_exclusion_leaf({
                    flowId,
                    actionId: nextAction.actionId,
                    expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId,
                    idempotencyKey: "leaf_ex_<leafId>_<flowId>",
                    evidenceRefs: ["page:2#exclusions"],
                    target: "merchant",
                    scope: { kind: "all_benefits" },
                    predicate: { field: "transaction.merchant", op: "EQUALS", value: "全聯福利中心" }
                })
            ELSE IF 排除條款不適用 (忽略):
                submit_exclusion_leaf({
                    flowId,
                    actionId: nextAction.actionId,
                    expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId,
                    idempotencyKey: "leaf_ex_ignore_<leafId>_<flowId>",
                    disposition: "ignored",
                    reason: "排除活動已於 2025 年終止，2026 年新制已刪除此排除項",
                    evidenceRefs: ["page:2#note"]
                })

        CASE "FINALIZE":
            // 向使用者確認後 finalize（不可在使用者確認前 finalize）
            取得使用者明確確認（向使用者報告本次預計啟用的規則清單）
            finalize_ingestion({
                flowId,
                actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision
            })

        CASE "COMPLETE":
            // Ingestion 完成，讀取 completionProof 回報使用者
            BREAK LOOP

        CASE "EXPIRED" 或 nextAction 與上次相同但持續失敗:
            // 取得最新 action，禁止重送舊 actionId
            繼續 LOOP（get_ingestion 取得最新狀態）

        CASE "NEEDS_REVIEW" 或 "BLOCKED":
            // 條款或 leaf 需要人工確認
            向使用者說明阻塞原因，等待確認或補充資料後繼續
```

### 4.2 Manifest 修正（版本衝突或條款勘誤時）

```text
// 當 MCP 回傳 manifestCorrectionAction（或 Agent 發現提取條款遺漏需修正時）
// 注意：Manifest correction 必須是「全量替換」，不可只送差異補丁
correct_ingestion_manifest({
    flowId,
    actionId: manifestCorrectionAction.actionId,
    expectedRevision: manifestCorrectionAction.expectedRevision,
    idempotencyKey: 新的冪等鍵（禁止重用舊 key）,
    manifest: 包含所有正確葉節點的完整清單陣列
})
// 呼叫後立即 get_ingestion 驗證 manifestRevision 與 coverage
```

---

### 4.3 Ingestion 異常、衝突與中途問題處置矩陣 (Ingestion Error & Recovery Matrix)

在 Ingestion flow 執行中，若遇到錯誤或阻斷狀態，Agent 應依下表精確處置：

| 異常 / 錯誤代碼 | 觸發原因 | Agent 處置與重試步驟 |
|---|---|---|
| **`INVALID_INPUT: cycle`** | Manifest 中存在循環依賴（例如 A 依賴 B，B 又依賴 A） | 檢查 Manifest 中的 `dependsOn` 鏈結。確保排除條款優先宣告（`dependsOn: []`），優惠規則再指向排除條款，破除循環後重新提交 Manifest。 |
| **`INVALID_FLOW_ACTION`** | 1. 順序跳步：MCP 期待 A 動作（如提交來源），Agent 卻送了 B 動作（如送 Manifest）。<br>2. Leaf 亂序：Agent 自選 leaf 提交，而非 MCP 指定的 `nextAction.leafId`。 | 立即調用 `get_ingestion({ flowId })`，讀取目前唯一的 `nextAction.kind` 與 `nextAction.leafId`，**嚴格只執行 MCP 規定的下一步**。 |
| **`STALE_REVISION`** | Flow 的版本號已遞增（例如已經修正過 Manifest），但 Agent 仍送帶舊 `expectedRevision` 或舊 `actionId` 的請求。 | 嚴禁重送舊 actionId。立即調用 `get_ingestion({ flowId })` 取得最新 `revision` 與新 `actionId` 後重試。 |
| **`SOURCE_SCOPE_CONFLICT`** | 提交的 `sourceCapture.url` 與當初 `create_ingestion` 宣告的 `sourceScope` 網域或範圍不相符。 | 確保 `sourceCapture.url` 與 `create_ingestion({ sourceScope })` 嚴格一致；若為全新網站來源，應建立新的 Ingestion Draft。 |
| **`IDEMPOTENCY_CONFLICT`** | 相同的 `idempotencyKey` 被帶入了不同的 Manifest 或 Leaf 內容。 | 若為同一請求的安全重試，確保 payload 全量一致（MCP 將返回原結果）；若修改了內容，**必須產生全新的 `idempotencyKey`**。 |
| **`NEEDS_REVIEW`<br>(特店歧義)** | 提交 Leaf 時，`rule.match.merchants` 包含的特店名稱在系統中有複數匹配實體。 | 讀取回傳的候選清單向使用者確認具體店家名稱，選定後以相同 `leafId` 重新調用 `submit_benefit_leaf`。 |
| **`NEEDS_REVIEW`<br>(Finalize 阻塞)** | Coverage 中尚有 `pending` 或 `blocked` 的葉節點未處理完畢，就嘗試調用 `finalize_ingestion`。 | 檢查 `flow.coverage`，繼續依序處理剩餘的 `pendingLeafIds`，直至所有 leaf 均成為 `materialized`、`ignored` 或 `superseded` 且 `nextAction.kind === 'FINALIZE'`。 |
| **`FLOW_NOT_FOUND` 或 `status: "expired"`** | 草稿因長時間未活動超過 TTL 已被伺服器標記過期並清除 incomplete artifacts。 | 舊草稿無法恢復。使用 `create_ingestion` 重新開啟一個新的 Draft，並產生全新 `idempotencyKey`。 |
| **`MANIFEST_DIFF_PATCH_FORBIDDEN`** | 在 `correct_ingestion_manifest` 中只傳入想修改的單一 leaf，而非全量 manifest。 | 修正 Manifest 必須傳入**包含所有舊有需保留項＋新修訂項的完整陣列**。 |


---

## 5. 路徑 B：upsert_offer 快速路徑

適用情境：已有官方來源 snapshot，規則結構清楚，不需要 leaf 層級的 Ingestion flow。

### 5.1 商家實體解析前置步驟 (Merchant Identity Gate)

```text
// 對每一個特定商家執行
resolve_merchant({ query: 商家名稱, ... })

SWITCH response.status:
    CASE "resolved":
        使用 response.canonicalId (格式: mch_<ULID>) 填入 rule.match.merchants
    CASE "ambiguous":
        向使用者列出 2~3 個候選實體確認
        嚴禁把 raw merchant name 直接寫入 active rule
    CASE "unresolved":
        // 若官方條款明確記載新商家，可在同一次 upsert_offer 傳入 merchant candidate
        將 merchant candidate 物件帶入 upsert_offer 讓 MCP 原子建立
```

### 5.2 upsert_offer Payload 範例

```json
{
  "snapshot": {
    "id": "snap_<ULID>",
    "url": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "fetchedAt": "2026-09-17T05:10:00Z",
    "contentHash": "sha256:<雜湊值>",
    "parserVersion": "1.0.0",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "excerpt": "精選網購加碼 3.3%，需綁定 Richart 自動扣繳，每期帳單上限 1,000 點。",
    "verified": true,
    "sourceType": "official"
  },
  "rule": {
    "id": "rule_taishin_gogo_online_2026",
    "cardId": "taishin_gogo",
    "version": "2026.09.01",
    "sourceSnapshotId": "snap_<ULID>",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "settlementCurrency": "TWD",
    "match": {
      "merchants": ["mch_<ULID>"],
      "countries": ["TW"],
      "channels": ["online"],
      "paymentMethods": ["direct_card"]
    },
    "reward": {
      "kind": "percentage",
      "code": "taishin_point",
      "rateBps": 330,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_taishin_gogo_monthly_online"]
  },
  "capPools": [
    {
      "id": "cap_taishin_gogo_monthly_online",
      "name": "GoGo卡精選通路每期帳單加碼上限",
      "metric": "reward",
      "period": "billing_cycle",
      "limit": 100000,
      "currency": "TWD",
      "timezone": "Asia/Taipei"
    }
  ]
}
```

---

### 5.3 `INSUFFICIENT_FACTS` 與 `requiredActions` 統一處置原則

無論在推薦、研究或記帳情境中，當 MCP 回傳 `missing_required_fact` 或 `INSUFFICIENT_FACTS` 時，Agent 應依據回傳之 `requiredActions` 結構化欄位進行四大類處置：
1. **交易核心要素缺失 (`path: "amount" | "merchant"`)**：`owner: "user"`，向使用者確認金額、幣別或消歧義店家，回填至 `submission` 指定欄位。
2. **使用者資格事實缺失 (`path: "eligibilityFacts"`)**：`owner: "user"`，向使用者確認等級或啟用方案，自報事實填入 `eligibilityFacts`。
3. **支付工具缺失 (`path: "paymentCapabilities.<id>"`)**：`owner: "user"`，引導調用 `register_card` 或切換支援之支付工具。
4. **結算與清算要素缺失 (`path: "timezone" | "transaction.fx"`)**：`owner: "agent"`，由 Agent 自行補齊時區偏移或查詢 `sourceUrls` 組裝 `fx` 快照。

---

## 6. 防呆原則 (Guardrails)


1. **搜尋摘要非事實**：搜尋引擎 snippet、AI 生成摘要、社群貼文均非確定事實，必須核查原始官方頁面。
2. **年份核查**：嚴禁套用前年度舊條款；必須確認生效年份（如 2026 年）與截止日。
3. **敏感欄位禁區**：`sourceCapture.submitter` 等欄位不得填入任何帳密或憑證資訊。
4. **leaf 順序依 MCP**：禁止 Agent 自行決定 leaf 提交順序；必須等 MCP 的 `nextAction` 指定。
5. **冪等鍵唯一性**：每次新 ingestion draft 或 manifest correction 必須使用全新的 `idempotencyKey`，禁止重用。
