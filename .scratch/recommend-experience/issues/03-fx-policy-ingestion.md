# 03: 登記外幣產品時取得並保存換匯政策

Status: ready-for-agent

**Blocked by:** 02.

**What to build:** 卡片／優惠／路徑登記會提醒並承接缺少的官方換匯政策，供推薦重用。

- [ ] 政策與價格分開保存，含適用範圍、換匯方、rateType／方向、時點、fee／markup 基礎、來源及版本。
- [ ] ingestion 缺政策回 research_fx_policy；推薦也能重現未解缺項，已登記不等於政策完整。
- [ ] 公開可用的 typed 保存／引用契約完成端到端驗證；Agent 查官方條款、提交並檢查結果。
- [ ] 未知政策保持未知；不把 owner 的粗略預設當成銀行實際條款。
- [ ] 多產品可重用適用政策；政策變更不改寫歷史交易。
- [ ] research_fx_policy 回傳已知官方政策來源 URL、待查欄位及提交契約；未知來源明示需查官方條款。政策研究與報價取得分開，臺銀公共報價不能填補未查證的銀行政策。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。

目前已完成第一個切片：外幣規則找不到適用 policy 時，recommend 會回傳去重的 `research_fx_policy` action，包含 scope、已知官方來源或 `discovery_required`、待補欄位與 `upsert_fx_policy` 提交入口；臺銀 reference estimate 仍與 policy 分開。Build 與完整測試通過。
