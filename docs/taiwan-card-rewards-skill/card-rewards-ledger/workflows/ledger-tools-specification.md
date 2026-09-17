# 消費記帳與對帳專屬工具規格 (Ledger Tools Specification)

本文件收錄實際消費記帳、退款反轉、電子錢包跨事件連鎖回饋所需之所有工具規格、Property 結構與標準 JSON 骨架。

---

## 1. 工具清單速查

| 工具名稱 | 模式 | 核心用途 |
|---|:---:|---|
| `record_transaction` | write | 記錄實際購買或退款，原子更新累積上限與 Cap Pool |
| `list_transactions` | read | 查詢歷史記帳交易紀錄 |
| `remaining_caps` | read | 查詢特定卡片或通路的剩餘可回饋額度 (Cap) |
| `record_event_reward` | write | 伺服器端重新計算並記錄電子錢包事件連鎖回饋 |
| `reverse_event_reward` | write | 反轉先前已記錄的事件回饋 (Reversal) |
| `list_cards` | read | 記帳前查核使用者已持有的卡片清冊與 cardId |
| `list_payment_accounts` | read | 查核已登記之電子錢包或銀行帳戶 ID |
| `list_payment_routes` | read | 查核已登記之支付路徑 ID |

---

## 2. 工具詳細規格與 Payload 骨架

### 2.1 `record_transaction`
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
```json
{
  "cardId": "cathay_cube",
  "limit": 10,
  "page": 1,
  "timeBasis": "occurred_at"
}
```

---

### 2.3 `remaining_caps`
```json
{
  "capPoolId": "cap_taishin_gogo_monthly_online",
  "asOf": "2026-09-17T08:00:00Z"
}
```

---

### 2.4 `record_event_reward`
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
```json
{
  "event": {
    "id": "evt_refund_jkopay_1",
    "kind": "refund",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-17T09:00:00Z",
    "relations": {
      "refund_of": ["evt_purchase_jkopay_1"]
    }
  },
  "idempotencyKey": "event_reversal_jkopay_20260917"
}
```

---

### 2.6 查核輔助工具

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
  "page": 1
}
```

#### `list_payment_routes`
```json
{
  "limit": 10,
  "page": 1
}
```
