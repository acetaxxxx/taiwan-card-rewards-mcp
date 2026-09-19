# 推薦比價流程專屬工具規格 (Recommendation Tools Specification)

本文件收錄推薦與試算工作流程所需之所有工具規格、Property 結構與標準 JSON 骨架。

---

## 1. 工具清單速查

| 工具名稱 | 模式 | 核心用途 |
|---|:---:|---|
| `recommend` | read | 商家優先的推薦比價唯一入口，回傳卡片與支付路徑之統一候選排序 |
| `calculate_reward` | read | 無副作用試算單筆交易在特定規則下的回饋金額 |
| `resolve_merchant` | read | 查詢與驗證特店之唯一權威 ID (`canonicalId`) |
| `search_active_offers` | read | 分頁搜尋目前生效之公開與自訂優惠規則 |

---

## 2. 工具詳細規格與 Payload 骨架

### 2.1 `recommend`
- **用途**：消費前比價，支援直接刷卡與多層付款路徑。
- **Properties 結構**：
  - `merchant` (string, 必填): 商家名稱或模糊字串
  - `amount` (object 或 number, 選填): 交易金額。支援自然金額（如 USD 填 `4.8`、TWD 填 `20`、JPY 填 `30000`），MCP 伺服器會依據幣別自動換算最小單位，Agent 無須自行乘 100：
    - 物件形式：`{ "amount": number, "currency": string }`（亦支援 `{ "value": number, "currency": string }` 或相容舊版 `{ "amountMinor": number, "currency": string }`）
    - 扁平形式：可直接於推薦頂層給予 `"amount": number` 與 `"currency": string`
  - `country` (string, 選填): 國別代碼 (e.g. "TW", "JP", "US")
  - `channel` (string, 選填): 交易通路，**封閉枚舉**：
    - `"online"`: 線上網購、APP 內扣款
    - `"in_store"`: 實體門市刷卡
  - `paymentMethod` (string, 選填): 支付方式代碼（如 `"direct_card"`, `"line_pay"`, `"jkopay"`, `"apple_pay"`；未填時自動展開各卡最佳姿勢）
  - `cardIds` (array of string, 選填): 限制篩選之特定卡片 ID 陣列
  - `routeIds` (array of string, 選填): 限制篩選之支付路徑 ID 陣列
  - `routeFacts` (array of object, 重試或特定路徑補充時選填): 針對個別支付路徑補充專屬事實或匯率（`[{ routeId, edgeId, fx }]`）
  - `eligibilityFacts` (array of object, 選填): 補充資格自報事實陣列
  - `expectedResultVersion` (string, 重試時選填): 鎖定版本防止並行漂移
  - `limit` (number, 選填): 每頁回傳筆數 (預設 10)

> [!NOTE]
> - 針對外幣金額，直接傳入自然金額（例如 USD `4.8` 或 JPY `50000`），伺服器會自動依幣別次方計算，避免 Agent 端計算錯誤。
> - 透過 `routeFacts` 陣列提供特定支付路徑的專屬匯率（如信用卡國際組織匯率或電子錢包現鈔賣出牌告）。

#### 範例 1：初次自然金額推薦（免傳 fx）
```json
{
  "merchant": "Uber",
  "amount": { "amount": 4.8, "currency": "USD" },
  "country": "US",
  "channel": "online"
}
```

#### 範例 2：信用卡特定路徑補充國際卡組織匯率 (`routeFacts`)
```json
{
  "merchant": "Bic Camera",
  "amount": { "amount": 50000, "currency": "JPY" },
  "country": "JP",
  "channel": "in_store",
  "routeFacts": [
    {
      "routeId": "card:fubon-jcb",
      "fx": {
        "id": "fx_quote_jpy_twd_jcb",
        "baseCurrency": "JPY",
        "quoteCurrency": "TWD",
        "rate": 0.215,
        "capturedAt": "2026-09-17T12:00:00Z",
        "maxAgeSeconds": 86400,
        "provider": "JCB",
        "rateType": "card_scheme",
        "cardScheme": "jcb",
        "sourceUrl": "https://www.jcb.tw/rate/jpy.html"
      }
    }
  ]
}
```

---

### 2.2 `calculate_reward`
- **用途**：對單一卡片規則進行數學計算驗證，不涉及帳本寫入。
- **Properties 結構**：
  - `rule` (object, 必填): 優惠規則物件
  - `transaction` (object, 必填): 模擬交易資料
  - `context` (object, 必填): 包含當前時間與已用額度

```json
{
  "rule": {
    "id": "rule_test_3pct",
    "cardId": "test_card",
    "version": "1",
    "status": "candidate",
    "reward": { "kind": "percentage", "rateBps": 300 }
  },
  "transaction": {
    "amount": { "amountMinor": 100000, "currency": "TWD" },
    "occurredAt": "2026-09-17T08:00:00Z"
  },
  "context": {
    "evaluatedAt": "2026-09-17T08:00:00Z"
  }
}
```

---

### 2.3 `resolve_merchant`
- **用途**：驗證特店名稱並取得 canonicalId。
- **Properties 結構**：
  - `rawQuery` (string, 必填): 特店原始名稱
  - `country` (string, 選填): 國別代碼
  - `channel` (string, 選填): "online" | "in_store"

```json
{
  "rawQuery": "全聯",
  "country": "TW",
  "channel": "in_store"
}
```

---

### 2.4 `search_active_offers`
- **用途**：查詢目前生效中的優惠規則清單。
- **Properties 結構**：
  - `cardId` (string, 選填): 依卡片 ID 篩選
  - `canonicalMerchantId` (string, 選填): 依特店 ID 篩選
  - `page` (number, 選填): 頁碼 (1-based)
  - `limit` (number, 選填): 筆數 (上限 50)
  - `projection` (string, 選填): 投影深度，**封閉枚舉**：`"summary"` \| `"detail"`


```json
{
  "cardId": "cathay_cube",
  "projection": "summary",
  "limit": 10,
  "page": 1
}
```
