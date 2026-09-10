# 08: 以 Agent 呼叫軌跡驗收完整推薦工作流

Status: ready-for-agent

**Blocked by:** 05, 06, 07.

**What to build:** 新版 Agent 從登記、推薦到補件與全部優惠探索可直接使用，舊版文件不再引導錯誤前置步驟。

- [ ] 各票已更新的契約與操作說明收斂為單一 canonical workflow；router、playbook、template、SOP 引用一致且標記版本。
- [ ] Agent trace 覆蓋直接推薦、外幣政策缺項、初估後 refresh／保存／重算、更多／全部、來源失敗停止。
- [ ] 一般推薦無不必要的 list/preflight；沒有要求所有 FX 更新完才交付；要求全部時沒有漏頁。
- [ ] 以實際 public MCP 呼叫驗證 schema、service、文件範例一致；沒有假造工具或敏感資料。
- [ ] 移除矛盾指引但保留 legacy adapter；刪除舊 public tool 不在本票範圍。
- [ ] 呼叫軌跡驗證 Agent 能依回傳 URL 找到來源、提交 fxObservation，並比較多條路徑及各層優惠；臺銀參考與銀行政策研究在輸出及回填中明確區分。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
