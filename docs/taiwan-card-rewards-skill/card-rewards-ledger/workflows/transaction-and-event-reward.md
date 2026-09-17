# 交易記帳、退款與事件連鎖回饋標準作業程序 (Transaction, Refund & Event Reward SOP)

本 SOP 規範 Agent 在使用者確認已付款後，如何記錄實際交易、退款，以及電子錢包跨事件連鎖回饋。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `list_cards` | read | 查詢使用者已持有的卡片清冊，取得正確的 `cardId` | `limit`, `page`, `projection` |
| `record_transaction` | write | 記錄一般信用卡刷卡購買或退款 | `transaction.{idempotencyKey, cardId, kind, mode, occurredAt, amount}` |
| `list_transactions` | read | 查詢歷史交易記錄、驗證寫入結果 | `limit`, `page`, 時間區間篩選 |
| `remaining_caps` | read | 查詢當前 cap 餘額（確認回饋上限剩餘空間） | cap pool ID |
| `record_event_reward` | write | 記錄電子錢包儲值/消費事件連鎖回饋 | `event.{id,kind,amount,occurredAt,funding}`, `candidate`, `rule` 或 `chainRule`, `idempotencyKey` |
| `reverse_event_reward` | write | 反轉已記錄的事件回饋（退款/reversal） | `event`（含 explicit refund relation）, `idempotencyKey` |
| `list_payment_accounts` | read | 確認 wallet/bank 的 opaque identity ID | `limit`, `page` |
| `list_payment_routes` | read | 確認使用者已登錄的支付路徑 | `limit`, `page` |

> [!NOTE]
> 詳細工具 Property 結構與 JSON 骨架，請參考 [記帳專屬工具規格](ledger-tools-specification.md)。

---


## 1. 觸發條件 (Trigger Conditions)

| 使用者情境 | 進入節點 |
|---|:---:|
| 「剛刷了 XX 卡在 YY 店」、「已付款」 | 第 2 節 |
| 「退款了」、「取消訂單」 | 第 2 節（退款） |
| 「街口/LINE Pay 儲值後消費的回饋」、「跨事件連鎖活動」 | 第 3 節 |
| 「要取消剛才的事件回饋」（reversal） | 第 3 節（reversal） |

> [!IMPORTANT]
> 進入本 SOP 前，必須確認使用者說的是**已發生的消費**，而非詢問「哪張卡比較好」。後者請回到 `card-rewards-recommendation` 技能。

---

## 2. 一般信用卡交易記帳演算法 (Card Transaction Algorithm)

```text
// 步驟 1：確認消費已實際發生與卡片身份
IF 尚未確定 cardId 或需要比對使用者持有卡片:
    list_cards({ limit: 10, page: 1, projection: "summary" })
    比對使用者描述取得對應的 cardId
取得: cardId、消費金額、幣別、消費時間、商家名稱、channel、paymentMethod

// 步驟 2：記錄購買
record_transaction({
    transaction: {
        idempotencyKey: "purchase_<cardId>_<日期時間>",
        cardId: 卡片ID,
        kind: "purchase",
        mode: "actual",
        occurredAt: 消費時間（ISO 8601，含時區）,
        amount: { amountMinor: 分為單位金額, currency: "TWD" },
        merchant: 商家名稱,
        country: "TW",
        channel: "online" | "in_store",
        paymentMethod: 支付方式
    }
})

// 步驟 3：讀取回應與重試處置
SWITCH response 狀態 / 拋出錯誤 (Error Code):
    CASE 成功 (RewardBreakdown):
        展示 RewardBreakdown（回饋金額、cap 扣抵、套用之 rule）

    CASE IDEMPOTENCY_CONFLICT:
        說明「此筆消費已記錄過」，若是同一操作安全重試，保持完全相同 payload 重送；若為新消費，生成全新 idempotencyKey

    CASE INSUFFICIENT_FACTS:
        // 原因：缺少結算時區或必要交易條件
        向使用者確認時區或補充必要條件（如 timezone: "Asia/Taipei"、occurredAt 帶時區 offset），補齊後以相同 idempotencyKey 重試

    CASE NEEDS_REVIEW:
        IF 錯誤包含 "mid_market rate cannot be used":
            // 原因：實際交易不可使用中價匯率
            更換匯率類型為 "card_scheme" 或 "cash_selling"，重新取得快照後重試
        IF 錯誤包含 "fx_conflict" 或 "supplied FX snapshot is incompatible":
            // 原因：匯率快照與交易幣別或清算上下文衝突
            檢查 fxResolutionRequest.requiredFacts，修正 fx.baseCurrency 或 provider 後重試
        IF 錯誤包含 "event reward combination policy requires review":
            // 原因：多重回饋疊加未定義或衝突
            向使用者說明衝突規則，確認欲套用之特定優惠後重試

    CASE fx_missing:
        // 原因：外幣消費缺少匯率快照
        讀取回傳的 fxResolutionRequest.sourceUrls，於外部查詢即時匯率並組裝 transaction.fx 後重新提交

    CASE fx_stale:
        // 原因：匯率快照已過期
        執行 retryAction: "refresh_fx_snapshot"，更新 fx.capturedAt 為最新查詢時間後重試

    CASE INVALID_REFUND:
        // 原因：原購買不存在、卡片或幣別不符、或退款超額
        呼叫 list_transactions 查核原交易的 idempotencyKey、cardId、幣別與剩餘可退額度，修正後重試

    CASE no_match:
        說明未找到符合規則，展示已知排除原因，不推算或虛構回饋

// 步驟 4（退款）：記錄退款
record_transaction({
    transaction: {
        idempotencyKey: "refund_<cardId>_<日期時間>",
        cardId: 卡片ID,
        kind: "refund",
        mode: "actual",
        occurredAt: 退款時間（ISO 8601）,
        amount: { amountMinor: 退款金額（正數）, currency: "TWD" },
        merchant: 商家名稱,
        refundOfId: 原始購買的 idempotencyKey
    }
})
// MCP 驗證原購買存在、卡片相同、累計退款不超額，並按比例反轉 reward/cap
```

### 標準 Payload 範例

```json
{
  "transaction": {
    "idempotencyKey": "purchase_cathay_cube_20260917_1430",
    "cardId": "cathay_cube",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-17T14:30:00+08:00",
    "amount": { "amountMinor": 200000, "currency": "TWD" },
    "merchant": "PChome",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  }
}
```

退款時加 `kind: "refund"` 及 `refundOfId`：

```json
{
  "transaction": {
    "idempotencyKey": "refund_cathay_cube_20260919_1000",
    "cardId": "cathay_cube",
    "kind": "refund",
    "mode": "actual",
    "occurredAt": "2026-09-19T10:00:00+08:00",
    "amount": { "amountMinor": 200000, "currency": "TWD" },
    "merchant": "PChome",
    "refundOfId": "purchase_cathay_cube_20260917_1430"
  }
}
```

---

## 3. 電子錢包事件連鎖回饋演算法 (Wallet Event Chain Algorithm)

### 3.1 事件結構原則

```text
// 一筆「錢包儲值後消費」是兩個獨立事件
E1 = top_up:  linked_bank_account → wallet_balance
E2 = purchase: wallet_balance → merchant
// 只有官方條款明確要求資金追溯時，才建立 E2.relations.funded_by = [E1.id]

// 不可混用：
- PayPay inbound acceptance ≠ PayPay outbound top-up（方向不同）
- 卡片儲值錢包 ≠ 直接刷卡消費（不繼承 issuer reward）
- Fungible wallet 混合來源時，不自動 FIFO/LIFO 配對
```

### 3.2 記帳演算法

```text
// 步驟 1：確認 opaque ID（禁止帳號明碼）
list_payment_accounts → 取得 wallet accountId、bank accountId
list_payment_routes   → 取得 routeId（若需要路徑識別）

// 步驟 2：判斷是否符合建立連鎖的條件
IF 官方條款要求 funded_by 追溯
   AND Agent 能提供 bounded source events（最多 16 個）
   AND target event 有明確 relations.funded_by:
    → 使用 chainRule（步驟 3）
ELSE:
    → 回傳 unknown/needs_review，不強行配對

// 步驟 3：記錄事件連鎖回饋
record_event_reward({
    event: {
        id: "evt_purchase_<唯一識別>",
        kind: "purchase",
        amount: { amountMinor: 消費金額, currency: "TWD" },
        occurredAt: 消費時間（ISO 8601 UTC）,
        funding: { kind: "account", subtype: "wallet_balance", accountId: walletId },
        relations: { funded_by: ["evt_topup_<唯一識別>"] }
    },
    sourceEvents: [
        {
            id: "evt_topup_<唯一識別>",
            kind: "top_up",
            amount: { amountMinor: 儲值金額, currency: "TWD" },
            occurredAt: 儲值時間（ISO 8601 UTC）,
            funding: { kind: "account", subtype: "linked_bank_account", accountId: bankId }
        }
    ],
    chainRule: {
        id: "chain_<規則ID>",
        version: "evidence-version-1",
        relation: "funded_by",
        windowSeconds: 2592000,
        sourceRule: { id: "sr", version: "1", eventKind: "top_up",
                      fundingKind: "account", fundingSubtype: "linked_bank_account" },
        targetRule: { id: "tr", version: "1", eventKind: "purchase",
                      fundingKind: "account", fundingSubtype: "wallet_balance" }
    },
    candidate: {
        eventId: "evt_purchase_<唯一識別>",
        ruleId: "rule_<規則ID>",
        ruleVersion: "evidence-version-1",
        evidenceId: "ev_official_<來源ID>",
        sponsor: "sponsor_<活動名稱>",
        benefitGroup: "benefit_<活動名稱>",
        eligibility: { status: "matched", reasons: [] }
    },
    idempotencyKey: "event_reward_<唯一識別>"
})
// 注意：caller 傳 eligibility.status: "matched" 不能繞過 MCP server 端重新驗證

// 步驟 4：Reversal（反轉已記錄回饋）
// 必須有明確 refund relation，禁止用商家名稱或金額猜測原 event
reverse_event_reward({
    event: {
        id: "evt_refund_<唯一識別>",
        kind: "refund",
        amount: { amountMinor: 退款金額, currency: "TWD" },
        occurredAt: 退款時間（ISO 8601 UTC）,
        relations: { refund_of: ["evt_purchase_<原始事件ID>"] }
    },
    idempotencyKey: "event_reversal_<唯一識別>"
})
```

## 4. 記帳狀態與異常處置指南

當 `record_transaction` 或 `record_event_reward` 執行後：
- **`matched` (成功)**：交易已成功持久化，向使用者呈現完整的 `RewardBreakdown`（回饋總額、扣抵之 Cap Pool 與依據之規則 ID）。
- **`no_match`**：消費條件明確不符合任何已知優惠規則，記錄為基礎消費，向使用者說明原因，嚴禁自創或估算回饋。
- **拋出錯誤或需要補件 (`INSUFFICIENT_FACTS` / `NEEDS_REVIEW` / `fx_missing` / `INVALID_REFUND` / `IDEMPOTENCY_CONFLICT`)**：
  ➔ 嚴禁猜測數值補寫帳本，請直接查閱通用手冊 [缺失事實與診斷代碼處置手冊](../../references/required-actions-and-diagnostics.md) 依序排查與重試。


