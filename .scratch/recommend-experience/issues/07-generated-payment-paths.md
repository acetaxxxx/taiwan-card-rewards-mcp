# 07: 從已驗證支付關係建立暫存付款路徑

Status: ready-for-agent

**Blocked by:** 03, 06.

**What to build:** 使用者不必事先登記每一種組合，MCP 從可信支付能力及使用者持有事實探索 planned 路徑。

- [x] 明確分開公共支付能力、私人持有／綁定與暫存候選的資料所有權；以 ADR 記錄生成與版本策略。
- [x] 由有證據的 transitions 生成並評估候選；可直接刷卡、帳戶／錢包路徑均可端到端展示。
- [x] 新的 planned 組合不需 upsert durable route；待綁定／登記的路徑列為 action-required。
- [x] 遵守 top-up／purchase 區別、funding provenance 與既有 stacking 政策；品牌名不推導受理關係。
- [x] 有界探索能續查並揭露 coverage；Agent workflow 示範沒有已登記組合仍能探索付款方式。
- [ ] 新生成的多層路徑回傳各層優惠與完整回饋拆解；以多條競爭路徑驗證共享規則不重複加總、互斥優惠不自動相加、top-up 不被當成直接 purchase。

## 共通交付要求

- [ ] 完成本票 public schema、dispatcher、service、必要保存、Agent 操作文件與對應端到端驗證，維持舊輸入相容。
- [ ] 推薦不写交易或消耗 cap；unknown 不等於零；來源、scope 與 tenant 隔離有效。

## Comments

使用者已核可八票拆分；補充要求為具體 FX 查詢來源／回填契約，以及多路徑與各層優惠比較。僅在前置票完成後開始實作。

目前已完成第一個切片：新增 `upsert_payment_capability`／`list_payment_capabilities`，能力資料與 user route/account 分離；recommend 可將 active、官方 evidence 支持的 capability 與持有信用卡組合成 ephemeral planned route，候選不寫入 durable `paymentRoutes`。帳戶組合、transition 語意與完整 coverage 仍待補齊。
