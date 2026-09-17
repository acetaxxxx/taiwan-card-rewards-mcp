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
            // 每次只提交 MCP 指定的一個 leaf（順序由 MCP 決定）
            submit_benefit_leaf({
                flowId,
                actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                leafId: nextAction.leafId,
                // benefit rule payload（含 rule, snapshot, capPools 等）
                ...
            })

        CASE "SUBMIT_EXCLUSION_LEAF":
            // 每次只提交 MCP 指定的一個排除條款 leaf
            submit_exclusion_leaf({
                flowId,
                actionId: nextAction.actionId,
                expectedRevision: nextAction.expectedRevision,
                leafId: nextAction.leafId,
                // exclusion payload
                ...
            })

        CASE "FINALIZE":
            // 向使用者確認後 finalize（不可在使用者確認前 finalize）
            取得使用者明確確認
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

### 4.2 Manifest 修正（版本衝突時）

```text
// 當 MCP 回傳 manifestCorrectionAction（或使用者要求修改 manifest）
correct_ingestion_manifest({
    flowId,
    actionId: manifestCorrectionAction.actionId,
    expectedRevision: manifestCorrectionAction.expectedRevision,
    idempotencyKey: 新的冪等鍵（禁止重用舊 key）,
    manifest: 完整替換的新 manifest（必須是完整版本，不可差異補丁）
})
// 立即 get_ingestion 確認 manifestRevision 已更新
```

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

## 6. 防呆原則 (Guardrails)

1. **搜尋摘要非事實**：搜尋引擎 snippet、AI 生成摘要、社群貼文均非確定事實，必須核查原始官方頁面。
2. **年份核查**：嚴禁套用前年度舊條款；必須確認生效年份（如 2026 年）與截止日。
3. **敏感欄位禁區**：`sourceCapture.submitter` 等欄位不得填入任何帳密或憑證資訊。
4. **leaf 順序依 MCP**：禁止 Agent 自行決定 leaf 提交順序；必須等 MCP 的 `nextAction` 指定。
5. **冪等鍵唯一性**：每次新 ingestion draft 或 manifest correction 必須使用全新的 `idempotencyKey`，禁止重用。
