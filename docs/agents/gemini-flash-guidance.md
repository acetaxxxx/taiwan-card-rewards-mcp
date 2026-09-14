# Gemini 3.8 Flash Medium 操作指引：台灣信用卡與支付回饋

本指引專為 Gemini 3.8 Flash Medium 等低推理模型設計，採三層結構，提供高密度、零猜測的 MCP 操作規則與合約。總 token 數嚴格控制在 1,500 以內。

---

## 第一層：核心不變量與意圖路由 (Tier 1: Core Invariants & Intent Routing)

### 5 大核心紅線（不得違反）
1. **禁止先查後做**：推薦直接呼叫 `recommend`；**嚴禁**在推薦前先調用 `list_cards` 或 `list_payment_routes`。
2. **二階段更正確認**：使用者糾錯或更新優惠時，**必須**先輸出「差異預覽」並獲使用者明確確認，方可呼叫 `upsert_offer`（`user_confirmed`）；**嚴禁**口頭承認後遺失狀態，亦**嚴禁**未確認直接寫入。
3. **非阻擋記帳**：實際消費一律以 `record_transaction` 寫入（支援信用卡、銀行帳戶、電支餘額、現金）；若回饋未知（`unknown`），仍**必須**完成記帳，不得中斷。
4. **相容鍵匯率重用**：同清算條件（幣別、清算方、時點、牌價類型、卡組織）在新鮮期內共享 FX 快照；電支現鈔結匯**嚴禁**混用卡組織即期中價。
5. **外部失敗即時停止**：外部條款或匯率查詢失敗時，**立即停止**無效重試，標記估算狀態（`estimate`）與結構化缺口（`requiredActions`），直接交付結果。

### 意圖路由表 (Intent Router)
| 使用者意圖 | 優先調用工具 | 關鍵輸入參數 | 完成條件 |
|---|---|---|---|
| 推薦消費方式 | `recommend` | `merchant`, `amount`, `occurredAt`, [可選 `fx`] | 取得 candidates（含直刷與生成式支付路徑） |
| 商家名稱不清 | `resolve_merchant` | `rawQuery`（僅在自然語言歧義時調用） | 取得 canonicalId；多選時向使用者提問澄清 |
| 使用者更正優惠 | `upsert_offer` | `trustBasis: "user_confirmed"`, `confirmation` | 先展示差異預覽，獲確認後寫入私有版本 |
| 記錄實際消費 | `record_transaction` | `idempotencyKey`, `occurredAt`, `amount`, `funding` | 取得寫入確認（回饋 unknown 亦成功記帳） |
| 查詢歷史交易 | `list_transactions` | `startDate`, `endDate`, `timeBasis`, `limit` (<=50) | 取得分頁清單（預設 occurred_at） |

---

## 第二層：高風險決策表 (Tier 2: High-Risk Decision Tables)

### 1. 商家解析與歧義處理 (Merchant Resolution)
- **情境 A（明確商家）**：輸入「唐吉訶德」或「全家」$\rightarrow$ **直接呼叫** `recommend({ merchant: "唐吉訶德", ... })`，不呼叫 `resolve_merchant`。
- **情境 B（歧義商家）**：輸入模糊或有多分店不同通路時 $\rightarrow$ 呼叫 `resolve_merchant({ rawQuery: "..." })`。
  - 單一確診 $\rightarrow$ 帶入 canonicalId 呼叫 `recommend`。
  - 多筆候選 $\rightarrow$ 向使用者提問選擇（僅列選項，不猜測）。
  - 無匹配 $\rightarrow$ 以通用商戶類別或一般消費呼叫 `recommend`。

### 2. 使用者更正生命週期：差異預覽 → 確認 → 寫入 (Correction Flow)
- **步驟 1（偵測糾正）**：使用者表示「台新玩旅刷海外是 3.3% 不是 3.8%」。
- **步驟 2（差異預覽）**：輸出對比並停等：
  > 【優惠更正預覽】  
  > - 卡別：台新 Richart 玫瑰卡（玩旅刷）  
  > - 原規則：3.8% (官方)  
  > - 新提案：3.3% (使用者私有確認)  
  > - 生效日：即日起  
  > 是否確認將此設定套用為您的個人專屬回饋規則？
- **步驟 3（使用者確認後寫入）**：使用者回覆「確認」$\rightarrow$ 呼叫 `upsert_offer`，帶入 `rule.trustBasis: "user_confirmed"` 與 `confirmation` 物件。
- **步驟 4（使用者否決/未確認）**：維持原狀，絕不寫入。

### 3. 指定支付清單與路徑生成 (Route Selector & Generated Paths)
- 優惠條款若載明「限指定行動支付（如 LINE Pay、街口）」$\rightarrow$ 條款 rule 內置 `routeSelector: { paymentMethods: ["line_pay", "jkopay"] }`。
- `recommend` 會自動將 Selector 與系統公共 `PaymentCapability` 及使用者持有卡片/帳戶動態組裝成 `generated` 路徑。
- **Agent 職責**：直接呼叫 `recommend` 讀取路徑結果，**不得**手動為每張卡與支付工具排列組合登記 durable route。

### 4. 外幣匯率相容鍵重用 (FX Reuse Key)
- **相容鍵 Tuple**：`(baseCurrency, quoteCurrency, conversionOwner, rateType, provider/scheme)`。
- **重用決策**：
  - 同相容鍵且在 `maxAgeSeconds` 內 $\rightarrow$ **直接重用**快照，多卡共享，不重複聯網。
  - 電支掃碼結匯（`conversionOwner: "bank"`, `rateType: "cash_selling"`）$\rightarrow$ **嚴禁**混用卡組織即期中價。
  - 外部匯率無法取得 $\rightarrow$ 立即停止重試，在回覆中標示 `fxEstimate: "estimate"`，並列出 `requiredActions` 缺口。

### 5. 交易記錄與雙時間依據查詢 (Transaction & Time Querying)
- **資金來源 (`funding`)**：
  - 信用卡：`{ kind: "credit_card", cardId: "..." }`（未指定 cardId 亦合法）。
  - 銀行/電支帳戶：`{ kind: "account", subtype: "linked_bank_account" | "wallet_balance" | "foreign_currency_account", accountId: "..." }`。
  - 現金：`{ kind: "cash" }`（無卡片 ID）。
- **時間基準 (`timeBasis`)**：
  - `occurred_at`（預設）：消費實際發生時間，用於活動期間計算、上限扣減與歷史回溯。
  - `recorded_at`：MCP 寫入/審計時間，用於查閱晚間補登紀錄。

---

## 第三層：精準 Minimal Payload 範例 (Tier 3: Minimal Valid Payloads)

### 1. 直接消費推薦 (`recommend`)
```json
{
  "merchant": "唐吉訶德",
  "amount": { "amountMinor": 500000, "currency": "JPY" },
  "country": "JP",
  "occurredAt": "2026-09-14T10:00:00Z",
  "fx": {
    "id": "fx-jpy-twd",
    "baseCurrency": "JPY",
    "quoteCurrency": "TWD",
    "ratePpm": 215000,
    "capturedAt": "2026-09-14T09:00:00Z",
    "provider": "JCB",
    "rateType": "card_scheme"
  }
}
```

### 2. 使用者確認私有版本寫入 (`upsert_offer`)
```json
{
  "snapshot": {
    "id": "snap-user-taishin",
    "url": "https://bank.example.com/richart",
    "fetchedAt": "2026-09-14T10:00:00Z",
    "contentHash": "hash-taishin-user",
    "parserVersion": "1.0.0",
    "sourceType": "user_input"
  },
  "rule": {
    "id": "rule-taishin-travel-v2",
    "cardId": "card-taishin-rose",
    "version": "2.0.0",
    "sourceSnapshotId": "snap-user-taishin",
    "status": "active",
    "trustBasis": "user_confirmed",
    "validFrom": "2026-09-01T00:00:00Z",
    "settlementCurrency": "TWD",
    "match": { "countries": ["JP"] },
    "reward": { "kind": "percentage", "rateBps": 330 }
  },
  "confirmation": {
    "confirmedAt": "2026-09-14T10:05:00Z",
    "confirmedBy": "user",
    "sourceReference": "user_correction_session",
    "offerPeriod": { "validFrom": "2026-09-01T00:00:00Z" },
    "rewardUnit": "TWD",
    "rewardConditionsSummary": "海外實體 3.3%",
    "capSummary": "無上限"
  }
}
```

### 3. 記錄現金/帳戶交易 (`record_transaction`)
```json
{
  "transaction": {
    "idempotencyKey": "tx-osaka-cash-01",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-14T08:30:00Z",
    "amount": { "amountMinor": 850, "currency": "JPY" },
    "funding": { "kind": "cash" },
    "merchant": "黑門市場小吃"
  }
}
```

### 4. 交易歷史分頁查詢 (`list_transactions`)
```json
{
  "startDate": "2026-09-10T00:00:00Z",
  "endDate": "2026-09-14T23:59:59Z",
  "timeBasis": "occurred_at",
  "projection": "summary",
  "page": 1,
  "limit": 50
}
```
