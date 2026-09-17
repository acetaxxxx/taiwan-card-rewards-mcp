# 消費記帳與對帳專屬工具規格 (Ledger Tools Specification)

本文件收錄實際消費記帳、退款反轉、電子錢包跨事件連鎖回饋所需之所有工具規格、Property 結構與標準 JSON 骨架。

---

## 1. 工具清單速查

| 工具名稱 | 模式 | 核心用途 |
|---|:---:|---|
| `record_transaction` | write | 記錄實際購買或退款，原子更新累積上限與 Cap Pool |
| `list_transactions` | read | 查詢歷史記帳交易紀錄 |
| `remaining_caps` | read | 查詢特定卡片之剩餘可回饋額度 (Cap) |
| `record_event_reward` | write | 伺服器端重新計算並記錄電子錢包事件連鎖回饋 |
| `reverse_event_reward` | write | 反轉先前已記錄的事件回饋 (Reversal) |
| `list_cards` | read | 記帳前查核使用者已持有的卡片清冊與 cardId |
| `list_payment_accounts` | read | 查核已登記之電子錢包或銀行帳戶 ID |
| `list_payment_routes` | read | 查核已登記之支付路徑 ID |

---

## 2. 工具詳細規格與 Payload 骨架

### 2.1 `record_transaction`
- **Properties 結構**：
  - `transaction.kind` (string, 必填): 交易類型，**封閉枚舉**：
    - `"purchase"`: 一般消費購買
    - `"refund"`: 消費退款反轉
  - `transaction.mode` (string, 必填): 交易模式，**封閉枚舉**：
    - `"actual"`: 實際記帳入帳
    - `"planned"`: 推薦試算模擬
  - `transaction.occurredAt` (string, 必填): 交易發生 ISO 8601 時間
  - `transaction.amount` (object, 必填): 金額物件 `{ "amountMinor": number, "currency": string }`
  - `transaction.idempotencyKey` (string, 必填): 唯一冪等鍵 (退款時需使用全新 key)
  - `transaction.cardId` (string, 選填): 卡片 ID
  - `transaction.merchant` (string, 選填): 商家名稱
  - `transaction.mcc` (string, 選填): 4 位數字 MCC 代碼
  - `transaction.country` (string, 選填): 國別代碼 (e.g. "TW", "JP")
  - `transaction.channel` (string, 選填): 交易通路，**封閉枚舉**：`"online"` \| `"in_store"`
  - `transaction.paymentMethod` (string, 選填): 支付方式代碼 (e.g. "direct_card", "line_pay")
  - `transaction.funding` (object, 選填): 出資工具
    - `kind` (string, 必填): **封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
    - `subtype` (string, kind 為 account 時選填): **封閉枚舉**：`"linked_bank_account"` \| `"wallet_balance"` \| `"foreign_currency_account"`
    - `cardId` / `accountId` (string, 選填)
  - `transaction.refundOfId` (string, 當 kind 為 `"refund"` 且 mode 為 `"actual"` 時必填): 指向原購買交易之 `idempotencyKey`
  - `transaction.originalRewardMinor` (integer, 選填): 原始發放之回饋金額 (Minor)

- **購買 (Purchase)**：
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

- **退款 (Refund)**：
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

### 2.2 `list_transactions`
- **Properties 結構**：
  - `cardId` (string, 選填): 依卡片 ID 篩選
  - `timeBasis` (string, 選填): 時間基準，**封閉枚舉**：
    - `"occurred_at"`: 消費實際發生時間
    - `"recorded_at"`: 系統入帳記帳時間
  - `fundingKind` (string, 選填): 出資種類篩選，**封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
  - `startDate` (string, 選填): 查詢起始 ISO 8601 時間
  - `endDate` (string, 選填): 查詢截止 ISO 8601 時間
  - `limit` (number, 選填): 每頁回傳筆數 (預設 10，上限 50)
  - `page` (number, 選填): 頁碼 (1-based)
  - `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

```json
{
  "cardId": "cathay_cube",
  "limit": 10,
  "page": 1,
  "timeBasis": "occurred_at",
  "projection": "summary"
}
```

---

### 2.3 `remaining_caps`
- **Properties 結構**：
  - `cardId` (string, 必填): 卡片 ID
  - `asOf` (string, 選填): 查詢基準 ISO 8601 時間 (預設目前時間)
  - `limit` (number, 選填): 每頁回傳筆數 (預設 10，上限 50)
  - `page` (number, 選填): 頁碼 (1-based)
  - `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

```json
{
  "cardId": "cathay_cube",
  "asOf": "2026-09-17T08:00:00Z",
  "projection": "summary"
}
```

---

### 2.4 `record_event_reward`
- **Properties 結構**：
  - `event` (object, 必填):
    - `kind` (string, 必填): 事件種類，**封閉枚舉**：`"top_up"` \| `"purchase"` \| `"refund"` \| `"reversal"` \| `"reward_issuance"` \| `"reward_redemption"`
    - `funding.kind` (string, 必填): 出資種類，**封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
    - `funding.subtype` (string, 選填): 帳戶子類型，**封閉枚舉**：`"linked_bank_account"` \| `"wallet_balance"` \| `"foreign_currency_account"`
    - `channel` (string, 選填): 交易通路，**封閉枚舉**：`"online"` \| `"in_store"`
  - `chainRule` (object, 跨事件連鎖規則):
    - `relation` (string, 必填): 固定為 `"funded_by"`
  - `candidate` (object, 必填):
    - `eligibility.status` (string, 必填): 資格匹配狀態，**封閉枚舉**：`"matched"` \| `"no_match"` \| `"unknown"`
  - `idempotencyKey` (string, 必填): 唯一冪等鍵

```json
{
  "event": {
    "id": "evt_purchase_jkopay_1",
    "kind": "purchase",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-17T08:10:00Z",
    "funding": {
      "kind": "account",
      "subtype": "wallet_balance",
      "accountId": "acct_jkopay_wallet"
    },
    "relations": {
      "funded_by": ["evt_topup_bank_1"]
    }
  },
  "sourceEvents": [
    {
      "id": "evt_topup_bank_1",
      "kind": "top_up",
      "amount": { "amountMinor": 10000, "currency": "TWD" },
      "occurredAt": "2026-09-17T08:00:00Z",
      "funding": {
        "kind": "account",
        "subtype": "linked_bank_account",
        "accountId": "acct_taishin_bank"
      }
    }
  ],
  "chainRule": {
    "id": "chain_jkopay_topup_purchase",
    "version": "1",
    "relation": "funded_by",
    "windowSeconds": 2592000,
    "sourceRule": { "id": "sr1", "version": "1", "eventKind": "top_up", "fundingKind": "account", "fundingSubtype": "linked_bank_account" },
    "targetRule": { "id": "tr1", "version": "1", "eventKind": "purchase", "fundingKind": "account", "fundingSubtype": "wallet_balance" }
  },
  "candidate": {
    "eventId": "evt_purchase_jkopay_1",
    "ruleId": "rule_jkopay_chain_reward",
    "ruleVersion": "1",
    "evidenceId": "ev_jkopay_official",
    "sponsor": "JkoPay",
    "benefitGroup": "topup_and_spend",
    "eligibility": { "status": "matched", "reasons": [] }
  },
  "idempotencyKey": "event_reward_jkopay_20260917"
}
```

---

### 2.5 `reverse_event_reward`
- **Properties 結構**：
  - `event.kind` (string, 必填): 反轉事件種類，**封閉枚舉**：`"refund"` \| `"reversal"`
  - `event.funding.kind` (string, 必填): 出資種類，**封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
  - `event.funding.subtype` (string, 選填): 帳戶子類型，**封閉枚舉**：`"linked_bank_account"` \| `"wallet_balance"` \| `"foreign_currency_account"`
  - `event.relations.refunds` (array of string, 必填且長度為 1): 指定原消費之原始事件 ID (`eventId`)
  - `idempotencyKey` (string, 必填): 唯一冪等鍵

```json
{
  "event": {
    "id": "evt_refund_jkopay_1",
    "kind": "refund",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-17T09:00:00Z",
    "funding": {
      "kind": "account",
      "subtype": "wallet_balance",
      "accountId": "acct_jkopay_wallet"
    },
    "relations": {
      "refunds": ["evt_purchase_jkopay_1"]
    }
  },
  "idempotencyKey": "event_reversal_jkopay_20260917"
}
```

---

### 2.6 查核輔助工具
- **共通分頁與投影結構**：
  - `limit` (number, 選填): 每頁回傳筆數 (預設 10，上限 50)
  - `page` (number, 選填): 頁碼 (1-based)
  - `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

#### `list_cards`
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

#### `list_payment_accounts`
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

#### `list_payment_routes`
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```
