# 範例：歧義商家消歧義與完整分頁優惠探索 (Ambiguous Merchant & Exhaustive Discovery)

**情境**：使用者詢問：「我在 PChome 買 10,000 元，有什麼卡有加碼活動？」  
資料庫中存在多頁促銷規則，且「PChome」存在不同子通路。

---

## Step 1: 呼叫 `recommend` 偵測到商家名稱歧義

Agent 呼叫 `recommend`：
```json
{
  "merchant": "PChome",
  "amount": { "amountMinor": 1000000, "currency": "TWD" },
  "occurredAt": "2026-09-06T16:00:00+08:00"
}
```

**MCP 回傳**（節錄）：
```json
{
  "status": "needs_input",
  "candidates": [],
  "requiredActions": [
    { "id": "merchant", "action": "resolve_merchant", "owner": "user", "path": "merchant", "requiredFacts": ["confirmed merchant identity and market"], "submission": { "tool": "recommend", "field": "merchant" } }
  ]
}
```

`resolve_merchant` action 代表「PChome」比對到多個候選（例如 PChome 24h購物
與 PChome 商店街）；`owner: "user"` 表示需要使用者選擇，不能由 Agent 自行猜測。

---

## Step 2: 呼叫 `resolve_merchant` 與使用者確認

Agent 呼叫 `resolve_merchant`：
```json
{
  "rawQuery": "PChome",
  "country": "TW",
  "market": "ecommerce"
}
```

Agent 向使用者確認：「請問您是在 **PChome 24h購物** 還是 **PChome 商店街** 消費？」  
使用者：「PChome 24h」。選定 `canonicalId: "mch_pchome_24h"`。

---

## Step 3: 完整遍歷分頁搜尋有效優惠 (`search_active_offers`)

### Page 1 請求：
```json
{
  "canonicalMerchantId": "mch_pchome_24h",
  "limit": 20,
  "page": 1,
  "projection": "summary"
}
```
*回傳*：`{ "offers": [...20筆優惠...], "hasMore": true, "total": 25 }`

### Page 2 請求（因 hasMore=true，Agent 自動遍歷第二頁）：
```json
{
  "canonicalMerchantId": "mch_pchome_24h",
  "limit": 20,
  "page": 2,
  "projection": "summary"
}
```
*回傳*：`{ "offers": [...5筆優惠...], "hasMore": false, "total": 25 }`

Agent 將 25 筆候選優惠全數聚合完畢，無遺漏。

---

## Step 4: 帶入權威商家 ID 重跑 `recommend`

```json
{
  "merchant": {
    "canonicalId": "mch_pchome_24h",
    "canonicalNameZhHant": "PChome 24h購物",
    "rawStatement": "PChome",
    "market": "ecommerce",
    "country": "TW"
  },
  "amount": { "amountMinor": 1000000, "currency": "TWD" },
  "occurredAt": "2026-09-06T16:00:00+08:00",
  "limit": 5
}
```

**MCP 輸出精確排行**，完整列出一般消費、電商特店加碼與滿額分期活動。
