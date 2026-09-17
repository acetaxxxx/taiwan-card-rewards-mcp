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
- `card.id` (string, 必填): 自訂卡片代碼 (e.g. "cathay_cube")
- `card.issuer` (string, 必填): 銀行名稱或代碼 (e.g. "CathayUnitedBank")
- `card.productName` (string, 必填): 完整卡片產品名稱 (e.g. "國泰世華 CUBE 卡")
- `card.network` (string, 選填): 國際卡組織，**封閉枚舉**：`"VISA"` \| `"MasterCard"` \| `"JCB"` \| `"AmericanExpress"`

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
- `limit` (number, 選填): 每頁回傳筆數
- `page` (number, 選填): 頁碼
- `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"`

```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

#### `get_user_benefit_status`
- `kind` (string, 必填): 權益類型，**封閉枚舉**：`"card_switch"` \| `"campaign_registration"`
- `cardId` (string, 必填): 卡片 ID
- `asOfUtc` (string, 選填): 查詢基準時間 (ISO 8601 UTC)
- `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

```json
{
  "kind": "card_switch",
  "cardId": "cathay_cube",
  "asOfUtc": "2026-09-17T08:00:00Z"
}
```

#### `upsert_user_benefit_status`
- `input.kind` (string, 必填): **封閉枚舉**：`"card_switch"` (方案切換) \| `"campaign_registration"` (登錄活動)
- `input.action` (string, 選填): **封閉枚舉**：`"record"` \| `"adjust"`
- `input.cardId` (string, 必填): 卡片 ID
- `input.benefit` (string, 必填): 方案或活動代碼 (如 "play_digital")
- `input.effectiveFrom` (string, 必填): ISO 8601 生效時間

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
- `sourceScope.kind` (string, 必填): 來源範圍類型，**封閉枚舉**：`"official_url"` \| `"offer_family"`
- `sourceScope.value` (string, 必填): 官方網址或系列代碼

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
- `sourceCapture.sourceType` (string, 必填): 來源真實性，**封閉枚舉**：`"official"` (官方) \| `"user_input"` (使用者自報)

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
- `manifest[].kind` (string, 必填): 葉節點種類，**封閉枚舉**：`"benefit"` (回饋) \| `"exclusion"` (排除)

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
- `disposition` (string, 忽略或覆蓋時必填): **封閉枚舉**：`"materialized"` \| `"ignored"` \| `"superseded"`
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
- `target` (string, 必填): 排除目標層級，**封閉枚舉**：`"merchant"` \| `"transaction_fact"` \| `"payment_route"` \| `"payment_method"`
- `disposition` (string, 選填): **封閉枚舉**：`"materialized"` \| `"ignored"` \| `"superseded"`

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
- `capability.id` (string, 選填): 能力識別碼 (若未指定，系統指派預設值)
- `capability.status` (string, 選填): 狀態，**封閉枚舉**：`"candidate"` \| `"active"` \| `"stale"` \| `"conflict"` \| `"needs_review"`
- `capability.providerId` (string, 必填): 支付服務機構代碼 (e.g. `"JkoPay"`, `"LinePay"`)
- `capability.acceptanceProviderId` (string, 選填): 端末收單代碼
- `capability.consumerAppId` (string, 選填): 消費者應用程式代碼
- `capability.merchant` (string, 選填): 特店名稱
- `capability.market` (string, 選填): 適用市場/國別 (e.g. `"TW"`, `"JP"`)
- `capability.channel` (string, 選填): 交易通路，**封閉枚舉**：`"online"` \| `"in_store"`
- `capability.fundingKinds` (array of string, 必填): 支援之出資種類 (長度 1~3)，元素**封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
- `capability.transitions` (array of string, 必填): 支援之狀態轉移 (至少 1 項)，元素**封閉枚舉**：
  - `"card_authorization"` \| `"account_debit"` \| `"wallet_top_up"` \| `"wallet_debit"` \| `"service_to_acceptance"` \| `"merchant_settlement"` \| `"direct_settlement"` \| `"split_tender"`
- `capability.sourceUrl` (string, 選填): 官方政策網址
- `capability.evidenceIds` (array of string, 必填): 關聯之證據 ID 陣列 (長度 1~64)
- `capability.observedAt` (string, 必填): ISO 8601 UTC 時間
- `capability.idempotencyKey` (string, 必填): 冪等鍵

```json
{
  "capability": {
    "id": "cap_jkopay_crossborder_jp",
    "providerId": "JkoPay",
    "market": "JP",
    "channel": "in_store",
    "fundingKinds": ["account"],
    "transitions": ["account_debit", "service_to_acceptance", "merchant_settlement"],
    "sourceUrl": "https://www.jkopay.com/crossborder/jp",
    "evidenceIds": ["ev_jkopay_jp_terms"],
    "observedAt": "2026-09-17T08:00:00Z",
    "idempotencyKey": "cap_jkopay_jp_20260917"
  }
}
```

#### `list_payment_capabilities`
- 本工具不接受任何參數 (空物件 `{}`)，回傳目前公開登錄之所有支付能力。

```json
{}
```

#### `upsert_payment_route`
- `route.id` (string, 必填): 路由識別碼 (e.g. `"route_gogo_linepay"`)
- `route.status` (string, 必填): 狀態，**封閉枚舉**：`"candidate"` \| `"active"` \| `"stale"` \| `"conflict"` \| `"needs_review"` \| `"failed"`
- `route.layers` (array of object, 必填): 路由層級陣列
  - `kind` (string, 必填): 層級角色，**封閉枚舉**：`"merchant_loyalty"` \| `"merchant_acceptance"` \| `"consumer_app"` \| `"payment_provider"` \| `"wallet"` \| `"interoperability_scheme"` \| `"intermediate_provider"` \| `"card_network"` \| `"card_issuer"`
  - `providerId` (string, 選填): 機構識別代碼
  - `appId` (string, 選填): 應用程式代碼
  - `paymentMethod` (string, 選填): 支付方式代碼
  - `displayName` (string, 選填): 顯示名稱
- `route.funding` (object, 必填): 出資方式
  - `kind` (string, 必填): 出資種類，**封閉枚舉**：`"credit_card"` \| `"account"` \| `"cash"`
  - `cardId` (string, kind 為 credit_card 時選填): 信用卡 ID
  - `accountId` (string, kind 為 account 時選填): 帳戶 ID
  - `subtype` (string, kind 為 account 時選填): 帳戶子類型，**封閉枚舉**：`"linked_bank_account"` \| `"wallet_balance"` \| `"foreign_currency_account"`
- `route.observedAt` (string, 必填): ISO 8601 UTC 時間
- `route.idempotencyKey` (string, 必填): 冪等鍵
- `route.authority` (string, 選填): 權威來源，**封閉枚舉**：`"issuer"` \| `"network"` \| `"wallet"` \| `"merchant"` \| `"secondary"` \| `"community"` \| `"user"`
- `route.confidence` (string, 選填): 信心水準，**封閉枚舉**：`"high"` \| `"medium"` \| `"low"`
- `route.evidenceIds` (array of string, 選填): 關聯之證據 ID 陣列

```json
{
  "route": {
    "id": "route_gogo_linepay_online",
    "status": "active",
    "layers": [
      {
        "kind": "wallet",
        "providerId": "LinePay",
        "displayName": "LINE Pay"
      }
    ],
    "funding": {
      "kind": "credit_card",
      "cardId": "taishin_gogo"
    },
    "authority": "wallet",
    "confidence": "high",
    "evidenceIds": ["ev_gogo_linepay_spec"],
    "observedAt": "2026-09-17T08:00:00Z",
    "idempotencyKey": "route_gogo_linepay_20260917"
  }
}
```

#### `list_payment_routes`
- `limit` (number, 選填): 每頁回傳筆數 (預設 10，上限 50)
- `page` (number, 選填): 頁碼 (1-based)
- `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

#### `register_payment_account`
- `account.id` (string, 必填): 帳戶識別碼 (e.g. `"acct_jkopay_wallet"`)
- `account.providerId` (string, 必填): 支付服務機構代碼 (e.g. `"JkoPay"`)
- `account.kind` (string, 必填): 帳戶種類，**封閉枚舉**：
  - `"linked_bank_account"`: 連結銀行扣款帳戶
  - `"wallet_balance"`: 電子錢包儲值餘額
  - `"foreign_currency_account"`: 外幣活存帳戶
- `account.displayName` (string, 必填): 帳戶顯示名稱
- `account.status` (string, 必填): 狀態，**封閉枚舉**：`"candidate"` \| `"active"` \| `"stale"` \| `"needs_review"`
- `account.observedAt` (string, 必填): ISO 8601 UTC 時間
- `account.idempotencyKey` (string, 必填): 冪等鍵
- `account.confirmation` (object, 當 status 為 `"active"` 時必填):
  - `confirmedAt` (string, 必填): ISO 8601 UTC 時間
  - `confirmedBy` (string, 必填): 確認來源（如 `"user_explicit_statement"`）

```json
{
  "account": {
    "id": "acct_jkopay_wallet",
    "providerId": "JkoPay",
    "kind": "wallet_balance",
    "displayName": "街口儲值帳戶",
    "status": "active",
    "observedAt": "2026-09-17T08:00:00Z",
    "idempotencyKey": "acct_jkopay_wallet_20260917",
    "confirmation": {
      "confirmedAt": "2026-09-17T08:00:00Z",
      "confirmedBy": "user_explicit_statement"
    }
  }
}
```

#### `list_payment_accounts`
- `limit` (number, 選填): 每頁回傳筆數 (預設 10，上限 50)
- `page` (number, 選填): 頁碼 (1-based)
- `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"` \| `"calculation"` \| `"audit"`

```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```
