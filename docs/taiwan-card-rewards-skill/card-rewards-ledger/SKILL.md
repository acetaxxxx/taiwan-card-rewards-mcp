---
name: card-rewards-ledger
description: Record Taiwan card-rewards transactions, refunds, and event-scoped rewards while preserving idempotency, caps, and evidence requirements.
---

# 信用卡消費記帳與對帳 (Card Rewards Ledger)

本技能處理所有**已發生消費的記帳、退款、電子錢包事件連鎖回饋與帳本對帳**任務。

> [!IMPORTANT]
> **Planned ≠ Actual（計劃 ≠ 實際）**：`recommend` 的推薦結果是試算，不會寫入帳本、不扣 cap、不記錄回饋。只有使用者明確確認「已付款」後，才能進入本技能進行 actual 寫入。

---

## 意圖分流 (Intent Router)

```text
SWITCH 使用者意圖:

    CASE "刷了一筆" | "已付款" | "要記帳" | "退款了":
        → 進入 [記帳與退款 SOP](workflows/transaction-and-event-reward.md)（第 2 節：一般交易）
        使用工具: list_cards, record_transaction, list_transactions, remaining_caps

    CASE "錢包儲值後消費" | "街口/LINE Pay 回饋" | "跨事件連鎖回饋" | "reversal":
        → 進入 [記帳與退款 SOP](workflows/transaction-and-event-reward.md)（第 3 節：事件連鎖）
        使用工具: record_event_reward, reverse_event_reward,
                  list_payment_accounts, list_payment_routes
```

---

## 共用守則 (Shared Invariants)

- **冪等性（Idempotency）**：每次寫入必須帶穩定的 `idempotencyKey`；相同 key + 相同 payload = replay（安全重試）；相同 key + 不同 payload = `IDEMPOTENCY_CONFLICT`（不可繞過）。
- **Fail-Closed**：MCP 回傳 `INSUFFICIENT_FACTS`、`NEEDS_REVIEW`、`stale`、`no_match` 時，停止並向使用者說明原因，禁止以估算值補寫帳本。
- **嚴禁猜測 funding**：Fungible wallet 混合多筆來源時，不自動 FIFO/LIFO 配對；只有官方條款要求且 Agent 能提供 bounded source events 時才建立 chain eligibility。

