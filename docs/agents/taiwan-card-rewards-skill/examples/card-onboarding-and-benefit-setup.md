# 範例：初次持卡登錄、雙軌資料研究與權益設定 (Card Onboarding & Benefit Setup)

**情境**：使用者初次使用系統，告訴 Agent：「我目前手上有國泰世華 CUBE 卡和台新 @GoGo 卡，平常 CUBE 卡習慣切換在『玩數位』方案，請幫我設定並查一下最新回饋」。

---

## Step 1: Agent 引導並確認安全元資料 (Zero Sensitive Credentials)

Agent 回應：「收到！為您登記這兩張卡片。請確認以下安全資訊（我們絕不會索取您的完整卡號 PAN、CVV 驗證碼、OTP 簡訊密碼或網銀密碼）：
1. **國泰世華 CUBE 卡**（Mastercard，結帳日 15 日）
2. **台新 @GoGo 卡**（VISA，結帳日 7 日）
請問確認無誤嗎？」
使用者：「確認」。

---

## Step 2: 依序呼叫 `register_card` 寫入卡片描述

### 2.1 登錄國泰 CUBE 卡
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

### 2.2 登錄台新 @GoGo 卡
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

## Step 4: 雙軌資料研究：官方條款查核與非官方線索交叉比對

Agent 在建立優惠規則前，執行雙軌資料查找：

### 4.1 非官方公開資料檢索（探索線索）
- 檢索 PTT 信用卡板、CardU 卡優新聞網、Money101：
  - 關鍵字：`台新 @GoGo 2026 網購 權益 PTT`
  - 發現線索：社群討論提到「@GoGo 卡精選網購 3.8% 需綁定 Richart 自動扣繳，且上限調整為 1,000 點」。
  - 來源保存：記錄 URL (`https://www.ptt.cc/bbs/creditcard/M.1700000000.A.123.html [示範佔位 URL]`)、查詢時間 (`2026-09-07T05:00:00Z`)、摘要與 `EvidenceRecord.sourceType: "community"`。
  - **重要原則**：非官方討論僅作為線索發現，不得直接作為入庫依據，必須找官方一手來源佐證。官方入庫時 MCP 之 `OfferSourceSnapshot.sourceType` 僅使用 `"official"`。

### 4.2 官方發卡行條款查核（權威事實）
- 依據社群線索，前往台新銀行官網優惠公告專頁進行確認：
  - 查核目標：`https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/`
  - 查核結果：確認 2026 年方案生效期間為 2026-01-01 至 2026-12-31，精選網購加碼 3.3% + 基本 0.5% = 3.8%，加碼上限每月 1,000 點，符合條件為「使用數位帳單並以 Richart 帳戶自動扣繳」。
  - 官方與非官方比對一致，提取為 `verified` 證據快照。

### 4.3 衝突與過期情境示範 (Fail-Closed)
若搜尋到 2024 年舊部落格文章宣稱「GoGo 卡有 5% 回饋且無上限」：
- Agent 判定該文章適用年份已過期，且與 2026 年官網條款（3.8% 含上限）矛盾。
- **Fail-Closed 處理**：丟棄過期非官方數據，以 2026 官方公告為準，並主動向使用者澄清。

---

## Step 5: 商家實體解析與提交優惠規則 (`upsert_offer`)

在提交優惠前，Agent 必須執行 **Merchant Identity Gate**，針對商家狀態採不同入庫路徑：

### 5.1 已解析既有商家入庫路徑 (Resolved Merchant + Confirmation)
對特定網購商家呼叫 `resolve_merchant`，取得工具回傳之權威 ID `mch_01J8Y7A9B0C1D2E3F4G5H6J7K8`（**注意**：此 ID 必須嚴格來自 `resolve_merchant` 之輸出，Agent 絕不可自行編造或猜測 `mch_<ULID>`）。
取得使用者確認後，攜帶 `confirmation` 提交 `active` 規則：

```json
{
  "snapshot": {
    "id": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "url": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "fetchedAt": "2026-09-07T05:10:00Z",
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
    "confirmedAt": "2026-09-07T05:12:00Z",
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
      "name": "GoGo卡精選通路每期帳單加碼上限",
      "metric": "reward",
      "period": "billing_cycle",
      "limit": 100000,
      "currency": "TWD",
      "timezone": "Asia/Taipei"
    }
  ]
}
```

### 5.2 未收錄商家之候選原子入庫路徑 (Unresolved Merchant Atomic Onboarding)
若 `resolve_merchant` 回傳 `unresolved`，但官方條款已載明新商家名稱，Agent 在同一次 `upsert_offer` 傳入 `merchant` candidate 物件與 `candidate` rule，由 MCP 生成權威 ID 並原子綁定：

```json
{
  "snapshot": {
    "id": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "url": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
    "fetchedAt": "2026-09-07T05:10:00Z",
    "contentHash": "sha256:7f83b1657ff1fc53b92dc18148a1d65dfc2d4b1fa3d677284addd200126d9069",
    "parserVersion": "1.0.0",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "excerpt": "新增合作網購特店享加碼回饋",
    "verified": true,
    "sourceType": "official"
  },
  "merchant": {
    "canonicalNameZhHant": "新進合作電商",
    "canonicalNameLocale": "zh-Hant-TW",
    "operatingMarkets": ["TW"],
    "channels": ["online"],
    "status": "candidate",
    "provenance": {
      "sourceSnapshotId": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
      "sourceUrl": "https://www.taishinbank.com.tw/TSB/personal/credit/gogo-offer/",
      "version": "1.0.0",
      "updatedAt": "2026-09-07T05:10:00Z"
    }
  },
  "rule": {
    "id": "rule_taishin_gogo_new_partner_2026",
    "cardId": "taishin_gogo",
    "version": "2026.09.01",
    "sourceSnapshotId": "snap_01J8Y7A9B0C1D2E3F4G5H6J7K9",
    "status": "candidate",
    "validFrom": "2026-01-01T00:00:00Z",
    "validTo": "2026-12-31T23:59:59Z",
    "settlementCurrency": "TWD",
    "match": {
      "countries": ["TW"],
      "channels": ["online"]
    },
    "reward": {
      "kind": "percentage",
      "code": "taishin_point",
      "rateBps": 380,
      "roundingMode": "floor"
    }
  }
}
```

---

## Step 6: 登記國泰 CUBE 權益方案 (`upsert_user_benefit_status`)

取得使用者確認「目前設定玩數位方案」後，發起工具呼叫：

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
      "confirmedBy": "user_statement",
      "confirmedAtUtc": "2026-09-07T05:15:00Z",
      "completed": true
    },
    "idempotencyKey": "cube_switch_20260907_setup"
  }
}
```

**MCP 回傳**：`{ "success": true, "status": "recorded" }`

---

## Step 7: 完成回報

Agent 回覆使用者：
> 「已成功為您登記 **國泰世華 CUBE 卡**（玩數位方案）與 **台新 @GoGo 卡**！
> 經官方條款與社群最新資訊交叉比對，已同步為您建立 2026 年最新 @GoGo 卡精選網購 3.8% 加碼規則（每期上限 1,000 點）。未來消費推薦將精確以此為基準進行試算！」
