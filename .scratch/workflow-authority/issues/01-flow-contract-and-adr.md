# 01: 定義 Workflow Authority 契約與 ADR

Status: ready-for-agent

**Blocked by:** None.

**What to build:** 將核可架構轉成正式領域決策與穩定契約，讓後續 tickets 不需要自行推測 flow、action、診斷或原子性語意。

## Definition of done

- [ ] ADR 記錄 MCP workflow authority、Agent semantic worker、零網路與 deterministic evaluation 邊界。
- [ ] 定義 durable ingestion lifecycle、合法狀態轉移、terminal/intervention states 與 correction revision 規則。
- [ ] 定義 action envelope、submission correlation、optimistic revision 與 idempotency/conflict 語意。
- [ ] 定義 `code`、`path`、`message`、`requiredFacts`、`retryAction` 及 affected IDs 的共用診斷契約。
- [ ] 定義 candidate artifacts 與 active offer index 的可見性邊界，以及 finalize 的原子啟用保證。
- [ ] 定義 stateless Recommendation retry、`resultVersion`、child ingestion continuation 與 restart 條件。
- [ ] 更新 `CONTEXT.md` 所需詞彙，避免 Flow、Action、Manifest Leaf、Completion Proof 與現有 Rule/Evidence 名詞混用。
- [ ] 契約測試可驗證 closed schema、狀態 enum、required fields 與非法組合；此票不宣稱尚未實作的 tools 可用。

## Comments

不得建立通用 workflow DSL。共用 Module 僅處理生命週期機制，benefit、exclusion、recommendation semantics 留在各自 Module。
