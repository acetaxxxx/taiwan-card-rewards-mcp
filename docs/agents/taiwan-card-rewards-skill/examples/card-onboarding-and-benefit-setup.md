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

## Step 4: 登記國泰 CUBE 權益方案 (`upsert_user_benefit_status`)

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

## Step 5: 完成回報

Agent 回覆：「已成功為您登記 **國泰世華 CUBE 卡**（玩數位方案）與 **台新 @GoGo 卡**。未來試算與推薦將優先以您的持卡清冊為基準！」
