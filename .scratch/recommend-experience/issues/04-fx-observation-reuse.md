# 04: 保存並重用各路徑適用的 FX observation

Status: ready-for-agent

**Blocked by:** 03.

**What to build:** Agent 查一次、提交一次，後续推薦可直接使用適用的新鮮報價。

- [ ] 完成 observation 寫入入口、推薦讀取與本次 typed evidence 補交；recommend 維持 read-only。
- [ ] 硬性驗證 pair、provider／policy、rateType、scope、方向、正值、來源時間與 freshness，再選報價。
- [ ] 同 pair 不同路徑政策不互相覆蓋；不讀其他 tenant 私人資料。
- [ ] refresh action 精確指出所需報價，共用需求去重；寫入後重算門檻、cap、成本與排序。
- [ ] Agent 範例涵蓋查來源 → 保存確認 → recommend，並驗證重啟後可重用資料。
- [ ] 回傳 fxResolutionRequest 供查詢，Agent 取得資料後提交 fxObservation；既有 observation 可回傳作估算依據，缺報價不生成假 observation。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
