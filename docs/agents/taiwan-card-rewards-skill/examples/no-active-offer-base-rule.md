# 範例：無促銷活動自動套用基礎回饋 (No Active Offer Fallback)

**情境**：使用者在傳統巷口五金雜貨店消費 NT$ 1,200，該商家無任何指定行銷加碼活動。

---

## 核心設計精神：一般消費基礎規則不阻擋 (Non-Blocking Base Rules)

未命中特定促銷或未登錄特定專案時，系統**絕不拋出錯誤中斷**，而是優雅套用卡片之一般國內消費基礎回饋率。

---

## Step 1: Pre-flight 執行

```json
{
  "amount": 1200,
  "currency": "TWD",
  "merchantName": "阿福五金行"
}
```

**MCP 回傳**：`{ "ready": true, "requiredActions": [] }`

---

## Step 2: 推薦計算結果

```json
{
  "recommendations": [
    {
      "cardId": "fubon_j",
      "cardName": "台北富邦 J 卡",
      "totalRewardEstimated": 12,
      "effectiveRate": 0.01,
      "components": [
        { "name": "一般國內消費基礎回饋", "rate": "1.0%", "amount": 12 }
      ],
      "capImpact": [],
      "prerequisitesMet": true,
      "warnings": ["該商家無特定促銷活動，套用一般國內消費基礎回饋。"]
    }
  ]
}
```
