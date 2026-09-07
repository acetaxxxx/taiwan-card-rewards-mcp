# 商家實體消歧義與解析標準作業程序 (Merchant Resolution SOP)

本程序規範 Agent 如何透過 `resolve_merchant` 進行確定性商家辨識，以及遇到歧義（Ambiguity）時的 Fail-Closed 處理流程。

---

## 1. `resolve_merchant` 呼叫規範

`resolve_merchant` 採用嚴格確定性匹配，絕不在內部進行不可控的模糊自動採納（No Fuzzy Auto-Accept）。

### 輸入參數
- `rawQuery`: `string` (必填，原始查詢字串，長度 1~128 字元)
- `country`: `string` (選填，ISO 雙字元國碼，如 `"TW"`, `"JP"`)
- `market`: `string` (選填，市場或行業別，如 `"food_delivery"`, `"transportation"`, `"ecommerce"`)
- `mcc`: `string` (選填，4 位 MCC 碼，如 `"5812"`, `"4121"`)
- `channel`: `string` (選填，支付通道，如 `"direct_card"`, `"line_pay"`)

---

## 2. 匹配結果分類與 Agent 行為

```
                       [呼叫 resolve_merchant]
                                 │
         ┌───────────────────────┼───────────────────────┐
         ▼                       ▼                       ▼
    [精確匹配]              [歧義候選]              [未匹配/未知]
  (Exact Match)         (Ambiguous Matches)      (Unresolved / None)
         │                       │                       │
         ▼                       ▼                       ▼
保留權威 ID 與分類      向使用者列出候選確認      回退至一般國內/國外
帶入後續 Preflight      使用者選擇後再行帶入      基礎規則 (Non-blocking)
```

### 1. 精確匹配 (Exact / Normalized Match)
- 狀態：回傳唯一的 `canonicalId` (`mch_<ULID>`)。
- Agent 行為：保留以下欄位並帶入推薦流程：
  - `canonicalId`: 例如 `"mch_01J8Y7A9B0C1D2E3F4G5H6J7K8"`
  - `canonicalNameZhHant`: 例如 `"Uber Eats (優食外送)"`
  - `market`: `"food_delivery"`
  - `country`: `"TW"`
  - `mcc`: `"5812"`

### 2. 歧義候選 (Ambiguous Candidates)
- 情境：查詢字串可能對應不同業務實體（例如 "Uber" 可能為「Uber 網約車」或「Uber Eats 外送」；"台灣高鐵" 可能為「一般購票」或「TGo 會員商城」）。
- Preflight 狀態：回傳 `ready: false`, `requiredActions: ["clarify_merchant"]`。
- Agent 行為：
  - **嚴禁自作主張猜測**。
  - 向使用者輸出清晰的多選詢問：「請問您的消費是：1) Uber 網約車 (乘車) 還是 2) Uber Eats (外送美食)？」
  - 依據使用者回覆選定對應的 `canonicalId`，重新執行 Preflight。

### 3. 未匹配 / 無指定促銷 (Unresolved / No Active Offer)
- 情境：商家未在特定活動白名單中（如巷口早餐店、一般診所）。
- 處理原則：**Non-blocking Base Rules**。系統不中斷執行，而是自動套用一般國內/國外消費基礎回饋。
