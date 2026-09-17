# 卡片登錄與權益設定標準作業程序 (Card Onboarding & Benefit Enrollment SOP)

本 SOP 規範當使用者宣告持有信用卡、新增卡片，或需要設定/切換卡片權益方案時，Agent 應遵循的結構化登錄步驟。

---

## 本 SOP 使用工具速查 (Scoped Tools)

| 工具 | 類型 | 本 SOP 中的用途 | 關鍵必填欄位 |
|---|:---:|---|---|
| `register_card` | write | 登錄每一張持有卡片的描述符 | `card.{id, issuer, productName}` |
| `list_cards` | read | 驗證登錄結果，確認持卡清冊正確 | `limit`, `page`, `projection` |
| `upsert_user_benefit_status` | write | 記錄多方案卡片的目前啟用方案 | `input.{kind, cardId, benefit, completedAt, effectiveFrom, idempotencyKey, confirmation}` |

---


## 1. 觸發條件 (Trigger Conditions)

進入本 SOP 的時機：
- 使用者說「我有 XX 卡」、「我新辦了一張 YY 卡」
- `recommend` 回傳 `requiredActions` 中包含 `action: "bind_payment_method"` 或 `action: "ask_user"` 且 `path` 涉及卡片持有事實

---

## 2. 安全元資料白名單 (Safe Metadata Allowlist)

> [!CAUTION]
> **嚴格禁止索取或傳輸敏感金融欄位**：
> - ❌ 完整卡號 (PAN)、安全碼 (CVV/CVC)、簡訊認證碼 (OTP)、網銀帳密

**允許收集的欄位**：
| 欄位 | 說明 | 必填 |
|---|---|:---:|
| `id` | 英文數字識別碼，如 `fubon_j_cash`、`cathay_cube` | ✅ |
| `issuer` | 發卡機構，如「台北富邦銀行」 | ✅ |
| `productName` | 卡片商品名稱，如「富邦 J 卡」 | ✅ |
| `network` | 發卡組織：`VISA`、`Mastercard`、`JCB`、`American Express` | 選填 |
| `country` | ISO 3166-1 alpha-2，如 `TW` | 選填 |
| `last4` | 卡號末四碼字串，如 `"5678"` | 選填 |
| `billingCycleDay` | 結帳日，整數 1~31 | 選填 |
| `timezone` | IANA 時區，如 `Asia/Taipei` | 選填 |

---

## 3. 登錄執行演算法 (Onboarding Algorithm)

```text
// 步驟 1：確認安全元資料
向使用者確認卡片清冊（卡片名稱、結帳日）
告知：「我們只需要以上基本資料，不會索取卡號或密碼」

// 步驟 2：逐張呼叫 register_card
FOR EACH card IN 使用者持有卡片:
    register_card({ card: { id, issuer, productName, network, last4, country, billingCycleDay, timezone } })

    SWITCH response:
        CASE { success: true, status: "registered" }:
            繼續下一張
        CASE { success: false } 或 error:
            回報錯誤訊息，詢問使用者是否修正 id 衝突或欄位問題
            不要繼續登錄後續卡片直到問題解決

// 步驟 3：呼叫 list_cards 驗證持卡清冊
list_cards({ limit: 10, page: 1, projection: "summary" })
向使用者確認登錄結果是否符合預期

// 步驟 4：詢問是否要同步查詢最新優惠（明確分流）
詢問使用者：「要同步查這些卡的最新官方優惠規則嗎？」

    IF 使用者回答「要」:
        → 跳出本 SOP，進入 [研究與 Ingestion SOP](research-source-and-ingestion.md)

    IF 使用者回答「不用」:
        繼續步驟 5

// 步驟 5：詢問是否有多方案權益切換（選填，但主動詢問）
IF 卡片具備多方案切換機制（如 CUBE 卡、Richart 等）:
    詢問使用者：「請問目前 App 設定的是哪一個方案？」

    取得使用者確認後呼叫:
    upsert_user_benefit_status({
        input: {
            kind: "card_switch",
            action: "record",
            cardId: 卡片ID,
            timezone: "Asia/Taipei",
            completedAt: 使用者確認時間（ISO 8601）,
            effectiveFrom: 方案生效時間,
            benefit: 方案識別碼（如 "digital_play"）,
            sourceUrl: 銀行官方說明網頁 URL,
            sourceSnapshotAt: 查核時間,
            ruleVersion: 版本標識（如 "2026.09.01"）,
            confirmation: {
                confirmedBy: "user_explicit_statement",
                confirmedAtUtc: 確認時間 UTC,
                completed: true
            },
            idempotencyKey: "benefit_<cardId>_switch_<日期>_001"
        }
    })

// 步驟 6：完成回報
回報使用者所有登錄的卡片與方案設定摘要
```

---

## 4. 標準 Payload 範例

### `register_card` 呼叫
```json
{
  "card": {
    "id": "cathay_cube",
    "issuer": "國泰世華銀行",
    "productName": "CUBE 卡",
    "network": "Mastercard",
    "last4": "8888",
    "country": "TW",
    "billingCycleDay": 15,
    "timezone": "Asia/Taipei"
  }
}
```

### `upsert_user_benefit_status` 呼叫（方案切換）
```json
{
  "input": {
    "kind": "card_switch",
    "action": "record",
    "cardId": "cathay_cube",
    "timezone": "Asia/Taipei",
    "completedAt": "2026-09-17T09:00:00+08:00",
    "effectiveFrom": "2026-09-17T00:00:00+08:00",
    "benefit": "digital_play",
    "sourceUrl": "https://www.cathaybk.com.tw/cathaybk/personal/product/credit-card/cards/cube/",
    "sourceSnapshotAt": "2026-09-17T00:00:00Z",
    "ruleVersion": "2026.09.01",
    "confirmation": {
      "confirmedBy": "user_explicit_statement",
      "confirmedAtUtc": "2026-09-17T01:00:00Z",
      "completed": true
    },
    "idempotencyKey": "benefit_cathay_cube_switch_20260917_001"
  }
}
```
