# 06: 所有可能路徑與優惠可續查，預設每頁 10 筆

Status: ready-for-agent

**Blocked by:** 02.

**What to build:** 使用者可取得全部已知可能優惠，page size 不截斷探索或規則集合。

- [ ] 穩定分頁可取完超過 30 個候選與單一路徑超過 10 個優惠，保留低回饋、缺資料與 action-required 候選。
- [ ] 回 hasMore、continuation、resultVersion、coverage；未探索完只回 discoveredCount，不偽裝最終 total。
- [ ] 分頁綁定輸入與資料版本；任何相關資料更新時明確 restart，避免重複／漏列。
- [ ] actions 亦可完整取得且去重；正常查詢先展示 10 筆，要求全部時 Agent 才持續取得完整結果。
- [ ] 資源限制可續跑；不能續跑的模型限制明示範圍，沒有默默 top-N 截斷。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
