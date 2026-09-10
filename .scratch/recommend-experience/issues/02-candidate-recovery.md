# 02: 推薦內建候選級診斷與補件重試

Status: ready-for-agent

**Blocked by:** 01.

**What to build:** 同一次推薦回傳可用結果及所缺資料；補完再呼叫同一入口，無需 preflight 前置。

- [ ] 每個 action 有 owner、required facts、受影響候選、補交方式與完成條件，並去重。
- [ ] 一條路徑缺 FX／來源不阻擋其他候選；商家未解不阻擋不依賴商家的規則。
- [ ] preflight 與 recommend 共用內部判定，舊 preflight 保留相容；新版正常流程不要求呼叫。
- [ ] Agent 執行研究型 action，只詢問使用者擁有的事實；沒有新證據時停止相同重試。
- [ ] 以 public 呼叫驗證 partial → 補件 → 重算，且不產生 ledger mutation。
- [ ] FX 查詢要求使用 fxResolutionRequest 語意，與已取得的 fxObservation 分開；要求含來源 URL／來源待發現狀態、用途、pair、rateType、方向、scope、目標時間、freshness、requiredFields 與可用提交入口。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
