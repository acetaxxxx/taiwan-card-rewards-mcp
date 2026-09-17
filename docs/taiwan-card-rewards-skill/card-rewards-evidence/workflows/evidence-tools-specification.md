# 條款研究、卡片與權益維護專屬工具規格 (Evidence Tools Specification)

本文件收錄卡片登記、官方來源 Ingestion、支付路徑與快速優惠規則所需之所有工具規格、Property 結構與標準 JSON 骨架。

---

## 1. 工具清單速查

| 工具名稱 | 模式 | 核心用途 |
|---|:---:|---|
| `register_card` | write | 登記持有的卡片描述符（禁止敏感卡號） |
| `list_cards` | read | 查詢目前持有的卡片清單 |
| `get_user_benefit_status` | read | 查詢使用者卡片目前啟用的權益方案狀態 |
| `upsert_user_benefit_status` | write | 記錄使用者確認切換的權益方案 |
| `upsert_offer` | write | 快速路徑：直接建立或更新卡片優惠規則 |
| `create_ingestion` | write | 建立或恢復一個 source-scoped Ingestion 草稿 |
| `get_ingestion` | read | 讀取 MCP 決定的下一個 Ingestion 動作與覆蓋進度 |
| `submit_ingestion_source` | write | 提交官方來源快照 |
| `submit_ingestion_manifest` | write | 提交完整條款清單（Manifest） |
| `correct_ingestion_manifest` | write | 全量替換勘誤條款清單 |
| `submit_benefit_leaf` | write | 逐一提交權益加碼葉節點 |
| `submit_exclusion_leaf` | write | 逐一提交排除條件葉節點 |
| `finalize_ingestion` | write | 原子驗證並正式發布所有 verified candidate rules |
| `upsert_payment_capability` | write | 登錄公開可用的支付能力與外幣匯率來源 |
| `list_payment_capabilities` | read | 列出公開支付能力 |
| `upsert_payment_route` | write | 登錄使用者專屬支付路徑與匯率來源設定 |
| `list_payment_routes` | read | 列出使用者專屬支付路徑 |
| `register_payment_account` | write | 登記電子錢包或連結銀行帳戶身份 |
| `list_payment_accounts` | read | 列出登記之支付帳戶 |

---

## 2. 工具詳細規格與 Payload 骨架

### 2.1 卡片登記與權益維護工具

#### `register_card`
```json
{
  "card": {
    "id": "cathay_cube",
    "issuer": "CathayUnitedBank",
    "productName": "國泰世華 CUBE 卡",
    "network": "VISA"
  }
}
```

#### `list_cards`
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

#### `get_user_benefit_status`
```json
{
  "cardId": "cathay_cube",
  "asOf": "2026-09-17T08:00:00Z"
}
```

#### `upsert_user_benefit_status`
```json
{
  "input": {
    "kind": "card_switch",
    "cardId": "cathay_cube",
    "benefit": "play_digital",
    "effectiveFrom": "2026-09-17T00:00:00+08:00",
    "completedAt": "2026-09-17T08:00:00Z",
    "idempotencyKey": "cube_switch_20260917",
    "confirmation": {
      "confirmedBy": "user_explicit_statement"
    }
  }
}
```

---

### 2.2 快速優惠規則建立：`upsert_offer`

```json
{
  "snapshot": {
    "id": "snap_cathay_online_2026",
    "url": "https://www.cathaybk.com.tw/cube/digital",
    "fetchedAt": "2026-09-17T08:00:00Z",
    "contentHash": "sha256:abcd1234ef",
    "parserVersion": "1.0.0",
    "sourceType": "official",
    "verified": true
  },
  "rule": {
    "id": "rule_cube_digital_3pct",
    "cardId": "cathay_cube",
    "version": "1",
    "sourceSnapshotId": "snap_cathay_online_2026",
    "status": "active",
    "validFrom": "2026-01-01T00:00:00Z",
    "settlementCurrency": "TWD",
    "match": { "channels": ["online"] },
    "reward": { "kind": "percentage", "rateBps": 300 }
  }
}
```

---

### 2.3 官方來源 Ingestion 工具組

#### `create_ingestion`
```json
{
  "sourceScope": {
    "kind": "official_url",
    "value": "https://www.fubon.com/credit/j-card"
  },
  "idempotencyKey": "ingest_fubon_j_20260917"
}
```

#### `get_ingestion`
```json
{
  "flowId": "flow_fubon_j_draft_1"
}
```

#### `submit_ingestion_source`
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_submit_source_1",
  "expectedRevision": 1,
  "sourceCapture": {
    "sourceType": "official",
    "url": "https://www.fubon.com/credit/j-card",
    "retrievedAt": "2026-09-17T08:00:00Z",
    "contentHash": "sha256:9f83b1657f",
    "artifactRef": "artifact:fubon-j-2026",
    "submitter": "agent",
    "submittedAt": "2026-09-17T08:00:01Z"
  }
}
```

#### `submit_ingestion_manifest`
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_submit_manifest_1",
  "expectedRevision": 2,
  "manifest": [
    { "id": "ex_pxmart", "kind": "exclusion", "summary": "排除全聯消費", "evidenceLocator": "p.2", "dependsOn": [] },
    { "id": "b_jp_kr", "kind": "benefit", "summary": "日韓消費加碼3%", "evidenceLocator": "p.1", "dependsOn": ["ex_pxmart"] }
  ]
}
```

#### `correct_ingestion_manifest`
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_correct_manifest_1",
  "expectedRevision": 2,
  "idempotencyKey": "correct_manifest_v2",
  "manifest": [
    { "id": "ex_pxmart", "kind": "exclusion", "summary": "排除全聯消費", "evidenceLocator": "p.2", "dependsOn": [] },
    { "id": "b_jp_kr", "kind": "benefit", "summary": "日韓消費加碼3%", "evidenceLocator": "p.1", "dependsOn": ["ex_pxmart"] },
    { "id": "b_domestic_1pct", "kind": "benefit", "summary": "國內一般消費1%", "evidenceLocator": "p.1", "dependsOn": [] }
  ]
}
```

#### `submit_benefit_leaf`
- **實體化 (Materialized)**：
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_leaf_b_jp_kr",
  "expectedRevision": 3,
  "leafId": "b_jp_kr",
  "idempotencyKey": "submit_leaf_b_jp_kr",
  "evidenceRefs": ["p.1#section-offer"],
  "offer": {
    "snapshot": {
      "id": "snap_leaf_b_jp_kr",
      "url": "https://www.fubon.com/credit/j-card",
      "fetchedAt": "2026-09-17T08:00:00Z",
      "contentHash": "sha256:9f83b1657f",
      "parserVersion": "1.0.0",
      "verified": true,
      "sourceType": "official"
    },
    "rule": {
      "id": "rule_fubon_j_kr_2026",
      "cardId": "fubon_j",
      "version": "1",
      "sourceSnapshotId": "snap_leaf_b_jp_kr",
      "status": "candidate",
      "validFrom": "2026-01-01T00:00:00Z",
      "settlementCurrency": "TWD",
      "match": { "countries": ["JP", "KR"], "channels": ["in_store"] },
      "reward": { "kind": "percentage", "rateBps": 300 }
    }
  }
}
```
- **忽略條款 (Ignored)**：
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_leaf_corporate",
  "expectedRevision": 4,
  "leafId": "b_corporate_bonus",
  "idempotencyKey": "submit_leaf_ignore_corporate",
  "disposition": "ignored",
  "reason": "商務差旅加碼不適用個人持卡人",
  "evidenceRefs": ["p.3#fine-print"]
}
```

#### `submit_exclusion_leaf`
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_leaf_ex_pxmart",
  "expectedRevision": 5,
  "leafId": "ex_pxmart",
  "idempotencyKey": "submit_leaf_ex_pxmart",
  "evidenceRefs": ["p.2#exclusions"],
  "target": "merchant",
  "scope": { "kind": "all_benefits" },
  "predicate": { "field": "transaction.merchant", "op": "EQUALS", "value": "全聯福利中心" }
}
```

#### `finalize_ingestion`
```json
{
  "flowId": "flow_fubon_j_draft_1",
  "actionId": "act_finalize_1",
  "expectedRevision": 6
}
```

---

### 2.4 支付能力與支付路徑工具

#### `upsert_payment_capability`
```json
{
  "capability": {
    "id": "cap_jkopay_fx",
    "provider": "JkoPay",
    "displayName": "街口支付",
    "supportedCurrencies": ["JPY", "TWD"],
    "fxPolicy": {
      "conversionOwner": "wallet",
      "suggestedRateTypes": ["cash_selling"],
      "sourceUrls": ["https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"],
      "provider": "TaishinBank"
    },
    "evidence": {
      "sourceType": "official",
      "sourceUrl": "https://www.jkopay.com/policy",
      "observedAt": "2026-09-17T00:00:00Z"
    }
  }
}
```

#### `list_payment_capabilities`
```json
{
  "limit": 10,
  "page": 1
}
```

#### `upsert_payment_route`
```json
{
  "route": {
    "id": "route_gogo_jkopay_jp",
    "cardId": "taishin_gogo",
    "walletProvider": "JkoPay",
    "market": "JP",
    "routeFacts": {
      "fxProvider": "TaishinBank",
      "fxRateType": "cash_selling",
      "fxSourceUrl": "https://www.taishinbank.com.tw/TSB/personal/deposit/lookup/realtime/"
    },
    "evidence": {
      "sourceType": "official",
      "sourceUrl": "https://www.jkopay.com/policy",
      "observedAt": "2026-09-17T00:00:00Z"
    }
  }
}
```

#### `list_payment_routes`
```json
{
  "limit": 10,
  "page": 1
}
```

#### `register_payment_account`
```json
{
  "account": {
    "id": "acct_jkopay_wallet",
    "provider": "JkoPay",
    "accountKind": "wallet",
    "linkedCardId": "taishin_gogo",
    "evidence": {
      "sourceType": "user_input",
      "confirmedBy": "user_explicit_statement",
      "confirmedAtUtc": "2026-09-17T08:00:00Z"
    }
  }
}
```

#### `list_payment_accounts`
```json
{
  "limit": 10,
  "page": 1
}
```
