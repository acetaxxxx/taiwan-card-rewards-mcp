# 05: 缺新匯率時先回估算，再按需更新

Status: ready-for-agent

**Blocked by:** 04.

**What to build:** 缺新鮮報價仍能用受時效限制的舊報價或公共參考匯率先試算，並完成更新循環。

- [ ] 依政策設定 freshFor／maxEstimateAge；有效政策報價、可用舊報價、公共參考、unknown 的選擇可測試。
- [ ] 預設公共參考政策為臺銀即期，明確定義方向／種類／單位；實際來源 observation 由 Agent 提供，不硬編價格。
- [ ] 回 policy_current／stale_estimate／reference_estimate／unavailable、來源時間、假設及 refresh actions。
- [ ] 比較可計算的總支出與回饋後淨支出；未知 fee 不當 0，參考 FX 不使未知資格變 matched。
- [ ] Agent 先展示估算，優先刷新影響當前決策的報價；掌握全部缺項但不以全部更新完成作一般查詢終止條件。
- [ ] 新報價改變門檻或排序時顯示更新結果；來源失敗可交付帶缺口的估算；actual 不沿用未確認估算。
- [ ] refresh action 附公共參考網址 https://rate.bot.com.tw/xrt?Lang=zh-TW ，Agent 重新取得頁面並驗證掛牌時間、即期買賣欄位、方向與單位；該幣別無即期報價時保留 unavailable，不挪用現金欄位。來源仅供 reference estimate。
- [ ] 多路徑使用各自 policy／FX／fee，驗證相同名目回饋率但不同換匯成本的候選能正確比較，更新後可改變排序。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。
