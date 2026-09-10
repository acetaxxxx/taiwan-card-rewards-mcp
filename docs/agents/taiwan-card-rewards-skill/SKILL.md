---
name: taiwan-card-rewards-assistant
description: 協助試算、比較與記錄台灣信用卡回饋；路由至 canonical 19-tool MCP contract。觸發分支：卡片與多層路徑推薦、公共支付能力、官方研究與證據、事件回饋/退款、錢包與外幣、權益狀態或帳本管理。
---

# Taiwan Card Rewards Assistant

這是 Agent 直接載入的入口。詳細 JSON schema、錯誤與合法 payload 在
[`references/mcp-tools.md`](references/mcp-tools.md)；不要從舊文章推導欄位。

## 先守住的邊界

1. MCP 是計算與 user-scoped durable ledger 的唯一權威。planned evaluation 不寫帳本、不扣 cap；actual/event 寫入必須由 canonical tool 完成。
2. Agent/UI 負責瀏覽銀行官網、PDF、圖片與 OCR，並提交可追溯的官方 evidence。MCP 不連網、不代替研究，也不接受猜測的優惠條款。
3. 絕不傳送或儲存 PAN、CVV/CVC、OTP、密碼、cookie、token、帳號號碼，或把 `user_id` 當作 tool-level tenant selector。
4. 啟動 MCP 時，`--data-dir` 才是持久化邊界；`--user` 只供 display/metadata，不能當授權或 storage selector。
5. `unknown`、`stale`、`needs_review`、衝突或缺 evidence 一律 fail closed；不可把未知轉成零回饋或擅自選活動。
6. 外幣交易由 Agent 自行取得目前匯率，以單一 `fx` snapshot 附在呼叫上；planned recommendation 若缺 `fx`，可先用依 `fxResolutionRequest` 取得的臺銀即期公共參考估算，但必須標示 estimate（見 candidate 的 `fxEstimate.status`），不能當成 actual settlement 的確定政策。費用或 reward valuation 無法換算時，net value 仍是 blocked/unknown。
7. payment path 是有界圖，不是把卡片、wallet、支付服務壓平為一個交易。每個 top-up/purchase 是 planned event；不可對 fungible wallet 自動推 FIFO/LIFO 或把早先卡 top-up 推成後續 wallet purchase 的卡刷。

## 意圖 router

| 使用者要做的事 | 先做什麼 | 完成條件 |
|---|---|---|
| 商家消費意圖推薦（含多層路徑） | 直接以商家呼叫 `recommend`；可附金額、幣別、國家、通路、時間、`fx` 或可選的 card/route 篩選 | 讀回 `status`、`candidates`（`direct_card` 與 `payment_path` 混合排序）、`requiredActions`、`coverage`；按 action 補件後重送同一意圖 |
| 新卡/錢包/路徑 | `register_card`、`register_payment_account`、`upsert_payment_route` | 只存 opaque identity 與 evidence；不存 credential；官方 product path 未證實就留 candidate/blocked |
| 官方優惠/商家研究 | Agent 取得官方來源，`resolve_merchant` / `upsert_offer` | snapshot、rule、期間、條件與 confirmation 可追溯；社群資料只能作線索 |
| 實際交易/退款 | `record_transaction`（actual、stable `idempotencyKey`） | 重試同 payload 不重複；refund 必須 `refundOfId` 且 amount 不超過原交易 |
| event-scoped reward | `record_event_reward`；退款用 `reverse_event_reward` | exactly one event rule 或 `funded_by` chain；server 重算 eligibility；明確 stacking/cap 才可記帳 |
| Gold/會員/自動扣繳 | `get_user_benefit_status`，用 authoritative evidence 建立 fact | Gold 是 eligibility fact，不是 payment-path node；evidence/valuation/FX/fee 不完整就 recovery 或 blocked |

商家消費意圖以 [`workflows/recommendation-intent.md`](workflows/recommendation-intent.md) 為準，required actions 的逐項處理見 [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md)；支付 capability 生成與 ownership 以 [ADR 0009](../../adr/0009-public-payment-capability-route-generation.md) 為準。schema 與 19-tool 清單以
[`references/mcp-tools.md`](references/mcp-tools.md) 為準。

## 三個必讀入口

- [`references/mcp-tools.md`](references/mcp-tools.md)：canonical 19-tool contract、closed input union、event/route/capability schema。
- [`references/mcp-tool-call-playbook.md`](references/mcp-tool-call-playbook.md)：實際 MCP 呼叫順序與合法 JSON 骨架。
- [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md) 與 [`workflows/event-reward-and-wallet-eligibility.md`](workflows/event-reward-and-wallet-eligibility.md)：多層路徑、planned events、跨事件資格與 fail-closed。

完整 Agent→MCP 範例：
[`examples/payment-path-recommendation.md`](examples/payment-path-recommendation.md)、
[`examples/gold-evidence-and-fail-closed.md`](examples/gold-evidence-and-fail-closed.md)、
[`examples/planned-recommendation.md`](examples/planned-recommendation.md)。

## 何時停止並詢問使用者

若 merchant、funding source、event relation、membership、cap policy、valuation、FX、fee 或官方適用期間缺失/矛盾，回傳 MCP 的 diagnostic/status，說明要補的 fact/evidence，停止寫入。對一致且有官方 evidence 的 payment route 預設可直接作 planned recommendation；只有 evidence 衝突、歧義或使用者表示路徑不可用時才詢問，並可將 route mark failed。

完成任一流程的標準是：payload 通過 closed schema、回應狀態未被誤解、planned/actual 邊界清楚、所有未知與外部未驗證範圍已明示。
