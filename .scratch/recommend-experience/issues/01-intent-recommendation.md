# 01: 用消費意圖取得持卡與已登記付款路徑候選

Status: ready-for-agent

**Blocked by:** None (can start immediately).

**What to build:** 商家及已知消費資料即可開始推薦，MCP 自行讀取使用者工具；只有商家時能探索，不要求先查卡或選路徑。

- [ ] public recommend 接受商家及選填金額／幣別、國家、通路、時間；部分輸入回候選或具體追問。
- [ ] 直接刷卡與既有可驗證路徑使用同一候選模型，含 matched／potential rules、來源、狀態及 coverage。
- [ ] cardIds／routeIds 僅為可選篩選；舊分支保持相容；傳入事實在 public 與 service 行為一致。
- [ ] Agent 正常入口直接 recommend；以 public 呼叫驗證不帶 cardId 的推薦及商家歧義。
- [ ] 這票可暫保留明示的有界集合；票 06 提供完整續查，這票不得宣稱已涵蓋所有結果。
- [ ] 同一商家一次回傳並比較至少三個有證據的完整路徑（直接卡付、錢包付款、帳戶資金路徑）；每條路徑列商家／支付服務／發卡行各層適用規則、Reward Components、stacking／互斥與排除原因，不能退化為卡片排名。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
