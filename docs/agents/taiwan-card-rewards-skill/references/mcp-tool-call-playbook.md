# MCP 工具呼叫實戰手冊 (Tool-Call Playbook v0.9.0)

本手冊提供 `taiwan-card-rewards-mcp` 20 項公開工具的標準 JSON-RPC 與 Tool-Call 規範範例。

---

## 1. 唯讀查詢與診斷類工具 (Read-Only & Evaluation, 10 項)

### 1.1 `recommendation_preflight`
- **用途**：推薦前置檢查，診斷是否缺少匯率快照、商家歧義或過期條款（唯讀，不變更狀態）。
- **呼叫範例**：
```json
{
  "transaction": {
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": {
      "amountMinor": 300000,
      "currency": "TWD"
    },
    "merchant": "momo購物網",
    "channel": "online"
  }
}
```
- **預期回應**：
```json
{
  "ready": true,
  "requiredActions": [],
  "diagnostics": [],
  "dataVersion": "2026.09.06"
}
```

### 1.2 `recommend`
- **用途**：取得最佳卡片推薦排序，提供多組件回饋拆解與上限池影響。
- **呼叫範例**：
```json
{
  "transaction": {
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": {
      "amountMinor": 300000,
      "currency": "TWD"
    },
    "merchant": "momo購物網",
    "channel": "online"
  },
  "limit": 5,
  "page": 1,
  "projection": "detail"
}
```

### 1.3 `calculate_reward`
- **用途**：純數學試算單一促銷規則於特定交易之回饋，不讀寫持久化帳本。
- **呼叫範例**：
```json
{
  "rule": {
    "id": "rule_sample_001",
    "cardId": "sample_card",
    "version": "1.0.0",
    "sourceSnapshotId": "snap_001",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "settlementCurrency": "TWD",
    "match": {
      "countries": ["TW"],
      "channels": ["online"]
    },
    "reward": {
      "kind": "percentage",
      "code": "twd_cashback",
      "rateBps": 200,
      "roundingMode": "floor"
    }
  },
  "transaction": {
    "cardId": "sample_card",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T12:00:00Z",
    "amount": { "amountMinor": 100000, "currency": "TWD" }
  },
  "context": {
    "now": "2026-09-06T12:00:00Z"
  }
}
```

### 1.4 `rank_cards`
- **用途**：傳入多張卡片與規則清單，進行純計算之 Deterministic 排序，回傳最高前五名。
- **呼叫範例**：
```json
{
  "cards": [
    {
      "id": "cathay_cube",
      "issuer": "國泰世華銀行",
      "productName": "CUBE 卡",
      "network": "Mastercard",
      "last4": "6688",
      "country": "TW",
      "billingCycleDay": 15,
      "timezone": "Asia/Taipei"
    },
    {
      "id": "fubon_j",
      "issuer": "台北富邦銀行",
      "productName": "富邦 J 卡",
      "network": "JCB",
      "last4": "1234",
      "country": "TW",
      "billingCycleDay": 7,
      "timezone": "Asia/Taipei"
    }
  ],
  "rules": [
    {
      "id": "rule_cathay_cube_digital",
      "cardId": "cathay_cube",
      "version": "2026.09.01",
      "sourceSnapshotId": "snap_cube_001",
      "status": "active",
      "validFrom": "2026-01-01T00:00:00Z",
      "settlementCurrency": "TWD",
      "match": { "countries": ["TW"], "channels": ["online"] },
      "reward": {
        "kind": "percentage",
        "code": "cube_point",
        "rateBps": 300,
        "roundingMode": "floor"
      }
    },
    {
      "id": "rule_fubon_j_domestic_base",
      "cardId": "fubon_j",
      "version": "2026.09.01",
      "sourceSnapshotId": "snap_fubon_001",
      "status": "active",
      "validFrom": "2026-01-01T00:00:00Z",
      "settlementCurrency": "TWD",
      "match": { "countries": ["TW"] },
      "reward": {
        "kind": "percentage",
        "code": "line_points",
        "rateBps": 100,
        "roundingMode": "floor"
      }
    }
  ],
  "transaction": {
    "cardId": "cathay_cube",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "channel": "online"
  },
  "context": {
    "now": "2026-09-06T15:00:00+08:00"
  }
}
```

### 1.5 `resolve_merchant`
- **用途**：精確比對商家名稱，回傳權威商家 ID (`mch_<ULID>`) 與消歧義狀態（`confirmed` | `ambiguous` | `unresolved`）。
- **呼叫範例**：
```json
{
  "rawQuery": "Uber Eats",
  "country": "TW",
  "market": "food_delivery",
  "mcc": "5812",
  "channel": "online"
}
```
- **預期回應**：
```json
{
  "resolutionStatus": "confirmed",
  "merchant": {
    "canonicalId": "mch_01J8Y7A9B0C1D2E3F4G5H6J7K8",
    "canonicalNameZhHant": "Uber Eats (優食外送)",
    "canonicalNameLocale": "zh-Hant-TW",
    "operatingMarkets": ["TW"],
    "mccs": ["5812"],
    "channels": ["online"],
    "status": "active"
  }
}
```

### 1.6 `search_active_offers`
- **用途**：分頁搜尋有效、已驗證之促銷條款（唯讀，不啟動規則）。回傳結構包含 `offers` 清單與 `pageInfo` 分頁元資料。
- **呼叫範例**：
```json
{
  "cardId": "fubon_j",
  "country": "TW",
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```
- **預期回應**：
```json
{
  "offers": [
    {
      "id": "rule_fubon_j_domestic_base",
      "cardId": "fubon_j",
      "version": "2026.09.01",
      "sourceSnapshotId": "snap_fubon_j_001",
      "status": "active",
      "validFrom": "2026-01-01T00:00:00Z",
      "settlementCurrency": "TWD",
      "match": {
        "countries": ["TW"],
        "channels": ["in_store", "online"]
      },
      "reward": {
        "kind": "percentage",
        "code": "line_points",
        "rateBps": 100,
        "roundingMode": "floor"
      }
    }
  ],
  "pageInfo": {
    "page": 1,
    "limit": 10,
    "total": 1,
    "totalPages": 1,
    "hasMore": false
  }
}
```

### 1.7 `list_cards`
- **用途**：分頁列出使用者已登記之卡片清冊。
- **呼叫範例**：
```json
{
  "limit": 20,
  "page": 1,
  "projection": "summary"
}
```

### 1.8 `remaining_caps`
- **用途**：查詢指定卡片在特定時間點之剩餘回饋上限池額度。
- **呼叫範例**：
```json
{
  "cardId": "cathay_cube",
  "asOf": "2026-09-06T12:00:00Z",
  "limit": 10,
  "page": 1
}
```

### 1.9 `get_user_benefit_status`
- **用途**：查詢使用者卡片目前生效之權益方案（如 CUBE 卡玩數位）或活動登錄狀態。
- **呼叫範例**：
```json
{
  "kind": "card_switch",
  "cardId": "cathay_cube",
  "projection": "detail"
}
```

### 1.10 `list_payment_routes`
- **用途**：分頁查詢使用者已登記的通用支付路徑拓撲。
- **呼叫範例**：
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

---

### 1.11 `list_payment_accounts` / `register_payment_account`
- **用途**：先查看使用者已有的帳戶身分；使用者明確要加入街口支付或綁定銀行帳戶時，再以官方證據登記匿名 provider/account identity。
- **安全限制**：不得傳送帳號、卡號、密碼、OTP、token 或任何憑據；回傳的 `acct_<ULID>` 只能作為路徑引用。
- **流程**：`list_payment_accounts` → `register_payment_account` → `upsert_payment_route`（`funding.accountId`）→ `recommend`。

---

## 2. 狀態寫入與記帳類工具 (State Mutations & Ledger, 5 項)

### 2.1 `register_card`
- **用途**：登記卡片安全描述元（嚴禁完整卡號 PAN、CVV、OTP 與網銀憑證）。
- **呼叫範例**：
```json
{
  "card": {
    "id": "taishin_gogo",
    "issuer": "台新銀行",
    "productName": "@GoGo 卡",
    "network": "VISA",
    "last4": "1234",
    "country": "TW",
    "billingCycleDay": 7,
    "timezone": "Asia/Taipei"
  }
}
```

### 2.2 `upsert_offer` (優惠快照、規則與候選商家寫入)
- **商家處理原則**：
  1. 若 `resolve_merchant` 已確認商家，將回傳之 `merchant.canonicalId` (`mch_<ULID>`) 放入 `rule.match.merchants`。嚴禁自行編造 `mch_<ULID>`。
  2. 若商家尚未收錄但官方條款已具備充分資料，在同一次呼叫中傳入 `merchant` 物件（`status: "candidate"`）；MCP 會自動生成權威 ID 並原子綁定，此時 rule 必須維持 `status: "candidate"`。
  3. 若規則標記為 `status: "active"`，必須於同一呼叫傳入完整的 `confirmation` 物件（含 `confirmedAt`、`confirmedBy`、`sourceReference`、`offerPeriod`、`rewardUnit`）。
- **呼叫範例 (附帶 Confirmation 之 Active 規則寫入)**：
```json
{
  "snapshot": {
    "id": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "url": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "fetchedAt": "2026-09-06T08:00:00Z",
    "contentHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "parserVersion": "1.0.0",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "excerpt": "精選網購與行動支付享加碼 3.8% 回饋，需綁定 Richart 自動扣繳，每期帳單加碼上限 1,000 點。",
    "verified": true,
    "sourceType": "official"
  },
  "rule": {
    "id": "rule_taishin_gogo_online_2026",
    "cardId": "taishin_gogo",
    "version": "2026.09.01",
    "sourceSnapshotId": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "settlementCurrency": "TWD",
    "match": {
      "merchants": ["mch_01J8Y7A9B0C1D2E3F4G5H6J7K8"],
      "countries": ["TW"],
      "channels": ["online"],
      "paymentMethods": ["line_pay", "jkopay"]
    },
    "reward": {
      "kind": "percentage",
      "code": "taishin_point",
      "rateBps": 380,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_taishin_gogo_monthly_online"]
  },
  "confirmation": {
    "confirmedAt": "2026-09-06T08:05:00Z",
    "confirmedBy": "user_explicit_statement",
    "sourceReference": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "offerPeriod": {
      "validFrom": "2026-01-01T00:00:00Z",
      "validTo": "2026-12-31T23:59:59Z"
    },
    "rewardUnit": "TWD",
    "rewardConditionsSummary": "使用數位帳單並以 Richart 帳戶自動扣繳",
    "capSummary": "每期帳單加碼上限 1,000 點"
  },
  "capPools": [
    {
      "id": "cap_taishin_gogo_monthly_online",
      "name": "GoGo卡精選通路每月加碼上限",
      "metric": "reward",
      "period": "billing_cycle",
      "limit": 100000,
      "currency": "TWD",
      "timezone": "Asia/Taipei"
    }
  ]
}
```

### 2.3 `upsert_payment_route` (支付路徑拓撲與扣款設定)
- **用途**：登記或更新一筆支付路徑拓撲與扣款工具（無敏感金融資料）。
- **呼叫範例**：
```json
{
  "route": {
    "id": "route_paypay_taishin_payplus_card",
    "status": "candidate",
    "layers": [
      {
        "kind": "merchant_acceptance",
        "providerId": "paypay_qr",
        "evidenceIds": ["ev_paypay_acceptance"]
      },
      {
        "kind": "consumer_app",
        "appId": "taishin_pay_plus",
        "evidenceIds": ["ev_taishin_payplus"]
      },
      {
        "kind": "card_issuer",
        "providerId": "taishin",
        "evidenceIds": ["ev_taishin_funding"]
      }
    ],
    "funding": {
      "kind": "credit_card",
      "cardId": "taishin_card_alias"
    },
    "evidenceIds": ["ev_paypay_acceptance", "ev_taishin_payplus", "ev_taishin_funding"],
    "observedAt": "2026-09-06T12:00:00Z",
    "idempotencyKey": "route_setup_paypay_taishin_payplus_20260906"
  }
}
```

### 2.4 `upsert_user_benefit_status` (動態權益與登錄狀態寫入)
- **用途**：記錄或調整經使用者確認已完成之卡片方案切換（如 CUBE 卡玩數位）或活動登錄。
- **呼叫範例**：
```json
{
  "input": {
    "kind": "card_switch",
    "action": "record",
    "cardId": "cathay_cube",
    "timezone": "Asia/Taipei",
    "completedAt": "2026-09-07T05:15:00+08:00",
    "effectiveFrom": "2026-09-07T00:00:00+08:00",
    "benefit": "digital_play",
    "sourceUrl": "https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/",
    "sourceSnapshotAt": "2026-09-07T00:00:00Z",
    "ruleVersion": "2026.09.01",
    "confirmation": {
      "confirmedBy": "user_explicit_statement",
      "confirmedAtUtc": "2026-09-07T05:15:00Z",
      "completed": true
    },
    "idempotencyKey": "benefit_cube_switch_20260907_001"
  }
}
```

### 2.5 `record_transaction` (實際刷卡與退款記帳)
- **用途**：記錄實際消費以扣減上限池，或記錄退款以逆向回補上限池額度。
- **實際消費記帳範例**：
```json
{
  "transaction": {
    "idempotencyKey": "tx_req_20260906_150001",
    "cardId": "cathay_cube",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": {
      "amountMinor": 250000,
      "currency": "TWD"
    },
    "merchant": "PChome 24h購物"
  }
}
```
- **退款對沖範例**：
```json
{
  "transaction": {
    "idempotencyKey": "tx_req_20260909_refund_001",
    "cardId": "cathay_cube",
    "kind": "refund",
    "mode": "actual",
    "occurredAt": "2026-09-09T10:00:00+08:00",
    "amount": {
      "amountMinor": -250000,
      "currency": "TWD"
    },
    "merchant": "PChome 24h購物",
    "refundOfId": "tx_req_20260906_150001"
  }
}
```
