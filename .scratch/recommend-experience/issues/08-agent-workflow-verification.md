# 08: 以 Agent 呼叫軌跡驗收完整推薦工作流

Status: ready-for-human

**Blocked by:** 05, 06, 07.

**What to build:** 新版 Agent 從登記、推薦到補件與全部優惠探索可直接使用，舊版文件不再引導錯誤前置步驟。

- [ ] 各票已更新的契約與操作說明收斂為單一 canonical workflow；router、playbook、template、SOP 引用一致且標記版本。
- [ ] Agent trace 覆蓋直接推薦、外幣政策缺項、初估後 refresh／保存／重算、更多／全部、來源失敗停止。
- [x] 一般推薦無不必要的 list/preflight；沒有要求所有 FX 更新完才交付；要求全部時沒有漏頁。
- [x] 以實際 public MCP 呼叫驗證 schema、service、文件範例一致；沒有假造工具或敏感資料。
- [x] 移除矛盾指引但保留 legacy adapter；刪除舊 public tool 不在本票範圍。
- [ ] 呼叫軌跡驗證 Agent 能依回傳 URL 找到來源、提交 fxObservation，並比較多條路徑及各層優惠；臺銀參考與銀行政策研究在輸出及回填中明確區分。

## 低推理成本 Agent 驗收基準

設計對象包含使用者指定的 gemini-3.8-flash-low、gpt-5.6-luna-low 等級；這是目標能力假設，不是已完成模型相容性驗證。

- [x] canonical workflow 以短步驟寫明觸發條件、工具、輸入來源與完成條件；一般推薦從 merchant intent 開始。
- [x] 每個補件 action 明示受影響候選、待查欄位、已知來源或來源探索要求、提交工具／欄位與完成條件；agent 不必推導內部資料模型。
- [ ] 範例使用通過 public schema 的具體 payload，區分讀取來源、保存政策／觀測、重新推薦；重試保留原始交易意圖。
- [ ] 來源不可用或沒有新證據且缺項未變時停止自動重試，先交付可用部分與未解項；只向使用者詢問其可提供的必要事實。
- [ ] 未知政策、參考匯率、過期估算與已驗證結果各有明確輸出分支；沒有把成功登記誤認成政策完整。
- [ ] 分開記錄 deterministic public-contract 測試與實際模型 trace；沒有實際跑過的模型標記未驗證，不以較強模型通過代替。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。

目前 repo 內的 deterministic public-contract、public MCP 呼叫、文件一致性與完整測試均已驗證；尚缺指定低推理成本模型的實際 Agent trace。此項不能以 Vitest 或較強模型代替，需在配置模型執行器/API 後補跑直接推薦、FX 補件、refresh／保存／重算、分頁探索與來源失敗停止軌跡。
