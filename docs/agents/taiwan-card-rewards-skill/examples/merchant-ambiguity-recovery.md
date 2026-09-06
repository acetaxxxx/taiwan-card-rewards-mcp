# 範例：商家歧義診斷與修復流程 (Merchant Ambiguity Recovery)

**情境**：使用者詢問：「我在 Uber 刷 500 元哪張好？」因 "Uber" 可能代表「Uber Eats 外送」或「Uber 網約車」，兩者適用通路與加碼規則不同。

---

## Step 1: Pre-flight 偵測到歧義

Agent 呼叫 `recommendation_preflight`：
```json
{
  "amount": 500,
  "currency": "TWD",
  "merchantName": "Uber"
}
```

**MCP 回傳結果**：
```json
{
  "ready": false,
  "requiredActions": ["clarify_merchant"],
  "diagnostics": [
    {
      "code": "AMBIGUOUS_MERCHANT",
      "field": "merchantName",
      "message": "商家名稱 Uber 存在多個可能實體，請進行消歧義選擇。"
    }
  ]
}
```

---

## Step 2: 查詢候選商家實體 (`resolve_merchant`)

Agent 呼叫 `resolve_merchant`：
```json
{
  "query": "Uber",
  "limit": 2
}
```

**MCP 回傳候選**：
```json
{
  "candidates": [
    { "merchantId": "mch_01J_UBER_EATS", "canonicalName": "Uber Eats (優食外送)", "category": "food_delivery" },
    { "merchantId": "mch_01J_UBER_RIDES", "canonicalName": "Uber 網約車 (乘車交通)", "category": "transportation" }
  ]
}
```

---

## Step 3: 向使用者確認並修復

Agent 詢問使用者：「請問您是在 **Uber Eats 外送** 消費，還是搭乘 **Uber 網約車**？」
使用者回應：「搭車的」。

---

## Step 4: 帶入權威 ID 重新 Pre-flight

Agent 重新呼叫 `recommendation_preflight`：
```json
{
  "amount": 500,
  "currency": "TWD",
  "merchantId": "mch_01J_UBER_RIDES"
}
```

**MCP 回傳結果**：`{ "ready": true, "requiredActions": [] }`

---

## Step 5: 執行 `recommend` 順利產出精確交通優惠推薦。
