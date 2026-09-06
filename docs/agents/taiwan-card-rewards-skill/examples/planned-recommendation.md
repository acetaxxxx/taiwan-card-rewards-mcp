# 範例：國內購物選卡推薦 (Planned Recommendation)

**情境**：使用者計劃在 momo 購物網購買一件 NT$ 3,000 的小家電，詢問應使用手上的哪張信用卡刷卡回饋最高。

---

## Step 1: Agent 發起 Pre-flight 診斷

Agent 呼叫 `recommendation_preflight`：
```json
{
  "amount": 3000,
  "currency": "TWD",
  "merchantName": "momo購物網",
  "paymentRoute": {
    "channel": "direct_card"
  }
}
```

**MCP 回傳結果**：
```json
{
  "ready": true,
  "requiredActions": [],
  "diagnostics": [],
  "dataVersion": "2026.09.06-01"
}
```

---

## Step 2: 執行推薦計算 (`recommend`)

因 `ready === true`，Agent 直接呼叫 `recommend`：
```json
{
  "amount": 3000,
  "currency": "TWD",
  "merchantName": "momo購物網",
  "paymentRoute": {
    "channel": "direct_card"
  },
  "limit": 3
}
```

**MCP 回傳結果**：
```json
{
  "recommendations": [
    {
      "cardId": "cathay_cube",
      "cardName": "國泰世華 CUBE 卡 (玩數位方案)",
      "totalRewardEstimated": 90,
      "effectiveRate": 0.03,
      "components": [
        { "name": "一般國內消費", "rate": "0.3%", "amount": 9 },
        { "name": "玩數位指定電商加碼", "rate": "2.7%", "amount": 81 }
      ],
      "capImpact": [
        { "pool": "cube_digital_unlimited", "consumed": 81, "remainingAfter": "unlimited" }
      ],
      "prerequisitesMet": true,
      "warnings": ["請確認當日於國泰 App 切換為「玩數位」權益方案"]
    },
    {
      "cardId": "taishin_gogo",
      "cardName": "台新 @GoGo 卡",
      "totalRewardEstimated": 90,
      "effectiveRate": 0.03,
      "components": [
        { "name": "基本回饋", "rate": "0.5%", "amount": 15 },
        { "name": "精選網購加碼", "rate": "2.5%", "amount": 75 }
      ],
      "capImpact": [
        { "pool": "gogo_monthly_cap", "consumed": 75, "remainingAfter": 225 }
      ],
      "prerequisitesMet": true,
      "warnings": ["需使用數位帳單並以 Richart 帳戶自動扣繳"]
    },
    {
      "cardId": "fubon_j",
      "cardName": "台北富邦 J 卡",
      "totalRewardEstimated": 30,
      "effectiveRate": 0.01,
      "components": [
        { "name": "一般消費", "rate": "1.0%", "amount": 30 }
      ],
      "capImpact": [],
      "prerequisitesMet": true,
      "warnings": []
    }
  ]
}
```

---

## Step 3: Agent 回覆使用者

> 💡 **推薦用卡結果**（消費金額：NT$ 3,000 @ momo購物網）：
>
> 1. 🥇 **國泰世華 CUBE 卡**：預估獲得 **90 點小樹點 (3.0%)**
>    - 基本 0.3% (9點) + 玩數位指定電商 2.7% (81點，無上限)
>    - ⚠️ **提醒**：刷卡當日請確保 CUBE App 設定為「玩數位」方案。
>
> 2. 🥈 **台新 @GoGo 卡**：預估獲得 **90 元台新Point (3.0%)**
>    - 基本 0.5% (15元) + 精選加碼 2.5% (75元)
>    - 📊 本月加碼上限尚餘 225 元。
>    - ⚠️ **提醒**：需綁定 Richart 自動扣繳。
