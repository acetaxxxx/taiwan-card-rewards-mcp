# 官方來源 Ingestion 完整作業程序 (Ingestion Action Loop SOP)

本 SOP 規範當官方條款包含多重加碼、排除項目或依賴關係時，Agent 如何透過 MCP Ingestion Flow 建立可追溯的完整來源覆蓋邊界（Coverage Boundary）與候選規則。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `create_ingestion` | write | 建立或恢復一個 source-scoped ingestion draft | `sourceScope.{kind, value}`, `idempotencyKey` |
| `get_ingestion` | read | 讀取 MCP 決定的單一 `nextAction`（每次寫入後必調用） | `flowId` |
| `submit_ingestion_source` | write | 提交官方來源快照（MCP 不會自行聯網） | `flowId`, `actionId`, `expectedRevision`, `sourceCapture` |
| `submit_ingestion_manifest` | write | 提交完整條款邊界清單（包含 Leaf 依賴關係） | `flowId`, `actionId`, `expectedRevision`, `manifest` |
| `submit_benefit_leaf` | write | 逐一提交 MCP 指定之權益葉節點 | `flowId`, `actionId`, `expectedRevision`, `leafId`, `offer` (或 `disposition`) |
| `submit_exclusion_leaf` | write | 逐一提交 MCP 指定之排除葉節點 | `flowId`, `actionId`, `expectedRevision`, `leafId`, `target` (或 `disposition`) |
| `correct_ingestion_manifest` | write | 全量替換修訂條款清單（勘誤時使用） | `flowId`, `actionId`, `expectedRevision`, `idempotencyKey`, `manifest` |
| `finalize_ingestion` | write | 原子驗證並正式發布所有 verified candidate rules | `flowId`, `actionId`, `expectedRevision` |

---

## 1. 核心概念階層 (Source ➔ Manifest ➔ Leaf)

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
│    從 Source 萃取出的完整條款邊界（Coverage Boundary）            │
│    宣告包含哪幾項獨立條款與依賴鏈結 (dependsOn)                   │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │ 由多個最小不可分割單元組成
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│ 3. Leaf（條款葉節點 / 最小條款單元）                              │
│    - kind: "benefit"    ── 加碼或基礎回饋規則                      │
│    - kind: "exclusion"  ── 排除條件（被加碼規則依賴）              │
│    最終歸宿: materialized (實體化) / ignored (忽略) / superseded (被覆蓋)│
└───────────────────────────────────────────────────────────────────┘
```

---

## 2. Ingestion Action Loop 演算法

> [!IMPORTANT]
> **伺服器主導原則 (Server-Owned)**：MCP 決定 phase 順序與 leaf 依賴。Agent 必須執行 MCP 回傳之 `nextAction`，嚴禁自選葉節點順序。

```text
// 步驟 1：建立或恢復草稿
create_ingestion({
    sourceScope: { kind: "official_url", value: 官方來源網址 },
    idempotencyKey: "ingest_<cardId>_<日期>"
})
// 取得 flowId

// 步驟 2：執行 Action 迴圈
LOOP:
    get_ingestion({ flowId })

    SWITCH nextAction.kind:

        CASE "SUBMIT_SOURCE":
            submit_ingestion_source({
                flowId, actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                sourceCapture: {
                    sourceType: "official",
                    url: 官方來源網址,
                    description: 條款摘要,
                    retrievedAt: 當前 UTC,
                    contentHash: "sha256:<雜湊>",
                    artifactRef: "artifact:<識別碼>",
                    submitter: "agent",
                    submittedAt: 當前 UTC
                }
            })

        CASE "SUBMIT_MANIFEST":
            submit_ingestion_manifest({
                flowId, actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                manifest: [
                    { id: "ex_pxmart", kind: "exclusion", summary: "排除全聯消費", evidenceLocator: "p.2", dependsOn: [] },
                    { id: "b_jp_kr", kind: "benefit", summary: "日韓消費加碼3%", evidenceLocator: "p.1", dependsOn: ["ex_pxmart"] }
                ]
            })

        CASE "SUBMIT_BENEFIT_LEAF":
            // 嚴格只處理 nextAction.leafId 指定的葉節點
            IF 條款適用 (實體化):
                submit_benefit_leaf({
                    flowId, actionId: nextAction.actionId, expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId, idempotencyKey: "leaf_b_<leafId>",
                    evidenceRefs: ["p.1#offer"],
                    offer: { snapshot: { ... }, rule: { ... candidate rule ... } }
                })
            ELSE (忽略/覆蓋):
                submit_benefit_leaf({
                    flowId, actionId: nextAction.actionId, expectedRevision: nextAction.expectedRevision,
                    leafId: nextAction.leafId, idempotencyKey: "leaf_b_ignore_<leafId>",
                    disposition: "ignored", reason: "本卡不適用此企業聯名條款", evidenceRefs: ["p.1#fine-print"]
                })

        CASE "SUBMIT_EXCLUSION_LEAF":
            submit_exclusion_leaf({
                flowId, actionId: nextAction.actionId, expectedRevision: nextAction.expectedRevision,
                leafId: nextAction.leafId, idempotencyKey: "leaf_ex_<leafId>", evidenceRefs: ["p.2#ex"],
                target: "merchant", scope: { kind: "all_benefits" },
                predicate: { field: "transaction.merchant", op: "EQUALS", value: "全聯福利中心" }
            })

        CASE "FINALIZE":
            向使用者報告即將啟用之規則清單，取得明確確認後呼叫:
            finalize_ingestion({ flowId, actionId: nextAction.actionId, expectedRevision: nextAction.expectedRevision })

        CASE "COMPLETE":
            讀取 completionProof 向使用者報告完成摘要，結束迴圈
```

---

## 3. 異常代碼與重試查表

在執行 Ingestion 過程中若遇錯誤或阻斷狀態，依通用手冊排查：
- 循環依賴 (`INVALID_INPUT: cycle`)、跳步亂序 (`INVALID_FLOW_ACTION`)、版本過期 (`STALE_REVISION`)、範圍衝突 (`SOURCE_SCOPE_CONFLICT`) 等：
  ➔ 查閱 [缺失事實與診斷代碼處置手冊 第 4 節](../../references/required-actions-and-diagnostics.md#4-ingestion-flow-專屬異常代碼處置表)。
