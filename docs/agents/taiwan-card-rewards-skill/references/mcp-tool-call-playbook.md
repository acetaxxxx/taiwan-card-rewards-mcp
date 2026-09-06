# MCP 工具呼叫實戰手冊 (Tool-Call Playbook v0.9.0)

本手冊提供 `taiwan-card-rewards-mcp` 15 項公開工具的標準 JSON-RPC 與 Tool-Call 規範範例。

---

## 1. 唯讀查詢與診斷類工具 (Read-Only & Diagnostic)

### 1.1 `recommendation_preflight`
- **用途**：推薦前置檢查，診斷是否缺少匯率快照、商家歧義或過期條款。
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
    "channel": "direct_card"
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
    "merchant": "momo購物網"
  },
  "limit": 5,
  "page": 1,
  "projection": "detail"
}
```

### 1.3 `resolve_merchant`
- **用途**：精確比對商家名稱，回傳權威商家 ID (`mch_<ULID>`) 與分類。
- **呼叫範例**：
```json
{
  "rawQuery": "Uber Eats",
  "country": "TW",
  "market": "food_delivery"
}
```
- **預期回應**：
```json
{
  "canonicalId": "mch_01J8Y7A9B0C1D2E3F4G5H6J7K8",
  "canonicalNameZhHant": "Uber Eats (優食外送)",
  "market": "food_delivery",
  "country": "TW",
  "mcc": "5812",
  "status": "exact_match"
}
```

### 1.4 `search_active_offers`
- **用途**：分頁搜尋有效優惠條款。
- **呼叫範例**：
```json
{
  "cardId": "fubon_j",
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```
- **預期回應**：
```json
{
  "offers": [
    { "ruleId": "rule_fubon_j_domestic_base", "rewardRateBps": 10000, "status": "active" },
    { "ruleId": "rule_fubon_j_japan_korea", "rewardRateBps": 30000, "status": "active" }
  ],
  "page": 1,
  "limit": 10,
  "total": 2,
  "hasMore": false
}
```

### 1.5 `list_cards`
- **呼叫範例**：
```json
{
  "limit": 20,
  "page": 1,
  "projection": "summary"
}
```

### 1.6 `remaining_caps`
- **呼叫範例**：
```json
{
  "cardId": "cathay_cube",
  "asOf": "2026-09-06T12:00:00Z",
  "limit": 10,
  "page": 1
}
```

### 1.7 `get_user_benefit_status`
- **呼叫範例**：
```json
{
  "kind": "card_switch",
  "cardId": "cathay_cube",
  "projection": "detail"
}
```

### 1.8 `calculate_reward` & `rank_cards`
- **用途**：純數學試算（不讀寫持久化帳本）。
- **呼叫範例 (`calculate_reward`)**：
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
    "match": { "countries": ["TW"] },
    "reward": {
      "kind": "cashback",
      "rateBps": 20000,
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

---

## 2. 狀態寫入與記帳類工具 (State Mutations)

### 2.1 `register_card`
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

### 2.2 `upsert_offer` (優惠快照與規則寫入)
- **呼叫範例**：
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
    "excerpt": "精選網購與行動支付享加碼 3.8% 回饋",
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
      "merchants": ["momo購物網", "PChome 24h購物", "蝦皮購物"],
      "channels": ["line_pay", "jkopay"]
    },
    "reward": {
      "kind": "point",
      "code": "taishin_point",
      "rateBps": 38000,
      "roundingMode": "floor"
    },
    "capPoolRefs": ["cap_taishin_gogo_monthly_online"]
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


### 1.9 `list_payment_routes`
- **用途**：分頁查詢使用者已登記的支付路徑。
- **呼叫範例**：
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

### 2.4 `upsert_payment_route` (支付路徑拓撲與扣款設定)
- **用途**：登記或更新一筆支付路徑拓撲與扣款工具（無敏感金融資料）。
- **操作守則**：Agent 必須先 `list_payment_routes` 去重，再用官方證據建立 `candidate`；只有使用者明確確認後才可寫入 `active`。PayPay、街口、台新 Pay+ 等都只是開放識別碼，不應新增品牌專用工具。
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

`candidate` 路徑不能直接產生回饋；Agent 應先補齊證據並向使用者確認 funding／費用／匯率，再以相同 idempotency key 更新為 `active`。若官方資料顯示是「信用卡儲值 → wallet balance debit」，就照實記錄兩段式語意，不能標成 direct card rail。

### 2.3 `record_transaction` (實際刷卡與退款)
- **實際消費記帳**：
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

- **退款對沖**：
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
