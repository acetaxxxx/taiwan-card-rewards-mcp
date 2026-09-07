# 範例：初次持卡登錄與動態權益設定 (Card Onboarding & Benefit Setup)

**情境**：使用者初次使用系統，告訴 Agent：「我目前手上有國泰世華 CUBE 卡和台新 @GoGo 卡，平常 CUBE 卡習慣切換在『玩數位』方案，請幫我設定」。

---

## Step 1: Agent 引導並確認安全元資料

Agent 回應：「收到！為您登記這兩張卡片。請確認以下安全資訊（我們絕不會索取您的完整卡號、CVV 或密碼）：
1. 國泰世華 CUBE 卡（Mastercard，結帳日 15 日）
2. 台新 @GoGo 卡（VISA，結帳日 7 日）
請問確認無誤嗎？」  
使用者：「確認」。

---

## Step 2: 依序呼叫 `register_card` 寫入卡片描述

### 登錄國泰 CUBE 卡
```json
{
  "card": {
    "id": "cathay_cube",
    "issuer": "國泰世華銀行",
    "productName": "CUBE 卡",
    "network": "Mastercard",
    "last4": "6688",
    "country": "TW",
    "billingCycleDay": 15,
    "timezone": "Asia/Taipei"
  }
}
```

### 登錄台新 @GoGo 卡
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

---

## Step 3: 呼叫 `list_cards` 驗證登記結果

```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

**MCP 回傳**：
```json
{
  "cards": [
    { "id": "cathay_cube", "issuer": "國泰世華銀行", "productName": "CUBE 卡" },
    { "id": "taishin_gogo", "issuer": "台新銀行", "productName": "@GoGo 卡" }
  ],
  "total": 2
}
```

---

## Step 4: 建立／確認優惠規則所需的商家實體

只要優惠條款對特定商家、商家集團或支付通路有額外條件，Agent 必須先完成商家 identity gate，再建立 rule。不要把人類可讀店名直接放進 `rule.match.merchants`。

### 4.1 先解析每一個條款中的商家

例如官方條款提到「全聯福利中心」：

```json
{
  "rawQuery": "全聯福利中心",
  "country": "TW",
  "mcc": "5411",
  "channel": "in_store"
}
```

呼叫 `resolve_merchant` 後，只有 `resolutionStatus: "confirmed"` 才能繼續：

```json
{
  "resolutionStatus": "confirmed",
  "merchant": {
    "canonicalId": "mch_01J8Y7A9B0C1D2E3F4G5H6J7K8",
    "canonicalNameZhHant": "全聯福利中心",
    "operatingMarkets": ["TW"],
    "mccs": ["5411"]
  }
}
```

建立 `upsert_offer` payload 時，使用 `canonicalId`：

```json
{
  "match": {
    "merchants": ["mch_01J8Y7A9B0C1D2E3F4G5H6J7K8"],
    "countries": ["TW"],
    "channels": ["in_store"]
  }
}
```

### 4.2 歧義與未收錄商家的處理

- `ambiguous`：列出候選商家，請使用者確認市場／分店／業態，再重新呼叫 `resolve_merchant`。
- `unresolved`：保留官方原文與候選 rule 為 `candidate`，或改用已被條款明確支持的 MCC／國家／通路條件；不要自行產生 `mch_<ULID>`。
- 目前公開 MCP 合約中沒有 `register_merchant` 工具；`resolve_merchant` 是唯讀查詢。Agent 不得宣稱已建立一個不存在的商家，也不得把 raw name 當成 canonical ID。若需要由 Agent 直接新增商家目錄，必須另行設計 atomic merchant-onboarding seam，再加入合約與測試。

**完成條件**：每一個 `rule.match.merchants` 值都必須來自已確認的 `canonicalId`，或該 rule 不使用 merchant selector；未達成前不可將 merchant-specific rule 寫成 `active`。

## Step 5: 登記國泰 CUBE 權益方案 (`upsert_user_benefit_status`)

```json
{
  "input": {
    "kind": "card_switch",
    "action": "record",
    "cardId": "cathay_cube",
    "timezone": "Asia/Taipei",
    "completedAt": "2026-09-06T09:00:00+08:00",
    "effectiveFrom": "2026-09-06T00:00:00+08:00",
    "benefit": "digital_play",
    "sourceUrl": "https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/",
    "sourceSnapshotAt": "2026-09-06T00:00:00Z",
    "ruleVersion": "2026.09.01",
    "confirmation": {
      "confirmedBy": "user_statement",
      "confirmedAtUtc": "2026-09-06T09:00:00Z",
      "completed": true
    },
    "idempotencyKey": "cube_switch_20260906_setup"
  }
}
```

**MCP 回傳**：`{ "success": true, "status": "recorded" }`

---

## Step 6: 完成回報

Agent 回覆：「已成功為您登記 **國泰世華 CUBE 卡**（玩數位方案）與 **台新 @GoGo 卡**。商家優惠將先通過 canonical merchant identity，再寫入規則；未確認的商家不會被當成有效優惠。未來試算與推薦將優先以您的持卡清冊與已確認商家為基準！」
