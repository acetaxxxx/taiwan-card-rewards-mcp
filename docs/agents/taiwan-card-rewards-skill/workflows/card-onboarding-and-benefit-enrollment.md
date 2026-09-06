# 初次使用與卡片登錄工作流程 (Card Onboarding & Benefit Enrollment SOP)

本工作流程定義當使用者首次使用或新增持有卡片時，Agent 應遵循的漸進式揭露（Progressive Disclosure）引導、安全元資料收集與登錄驗證流程。

---

## 1. 核心原則與安全防線

> [!CAUTION]
> **嚴格禁止索取或傳輸敏感金融欄位**：
> 1. ❌ **禁止真實完整卡號 (PAN)**：僅允許記錄卡片識別別名（如 `fubon_j_cash`, `cathay_cube`）或卡號末四碼 (`last4: "1234"`)。
> 2. ❌ **禁止卡片安全碼 (CVV/CVC)**：嚴禁索取或儲存。
> 3. ❌ **禁止簡訊認證碼 (OTP)**：嚴禁索取或轉發。
> 4. ❌ **禁止網銀帳密與 Token**：嚴禁索取銀行登入憑證。
> 5. ❌ **禁止使用者自訂 user_id 覆寫**：租戶身分完全由 MCP 啟動參數與宿主環境鎖定。

### 允許收集的安全元資料 (Safe Metadata Allowlist)
- **卡片唯一標識符** (`id`): 英文數字或底線識別碼，例如 `fubon_j_points`、`taishin_gogo`。
- **發卡機構** (`issuer`): 例如「台北富邦銀行」、「國泰世華銀行」、「台新銀行」。
- **卡片產品名稱** (`productName`): 例如「富邦 J 卡」、「CUBE 卡」、「@GoGo 卡」。
- **發卡組織** (`network`): 選填，`"VISA"`, `"Mastercard"`, `"JCB"`, `"American Express"`。
- **卡號末四碼** (`last4`): 選填，四位數字字串（如 `"5678"`）。
- **結帳日** (`billingCycleDay`): 選填，整數 1~31。
- **所屬時區** (`timezone`): 選填，合法 IANA 時區（如 `"Asia/Taipei"`）。

---

## 2. 登錄對話與作業步驟 (Step-by-Step SOP)

```
[使用者宣告持卡] ──► [Agent 收集安全元資料] ──► [呼叫 register_card]
                                                    │
                                                    ▼
[確認權益方案/活動] ◄── [列出卡片驗證 list_cards] ◄┘
       │
       ▼
[呼叫 upsert_user_benefit_status] ──► [Onboarding 完成]
```

### 步驟 1：詢問並整理持卡安全清冊
當使用者表示「我有富邦 J 卡和國泰 CUBE 卡」時，Agent 僅詢問必要別名與結帳日，絕不詢問卡號。

### 步驟 2：呼叫 `register_card` 寫入卡片描述
針對每一張卡片發起工具呼叫：

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

**MCP 回傳預期**：
```json
{
  "success": true,
  "cardId": "cathay_cube",
  "status": "registered"
}
```

### 步驟 3：呼叫 `list_cards` 驗證持卡清冊
完成登記後，呼叫 `list_cards` 進行確認：
```json
{
  "limit": 10,
  "page": 1,
  "projection": "summary"
}
```

### 步驟 4：主動引導並登錄動態權益方案（選填）
若卡片具備多權益切換機制（如國泰 CUBE 卡方案切換、台新 Richart 扣繳加碼），向使用者確認目前已啟用的方案：
- Agent：「請問您的國泰 CUBE 卡目前 App 設定的是哪一個權益方案？（如：玩數位、樂響購、趣旅行、集精選）」
- 使用者：「玩數位」。

取得使用者明確確認後，呼叫 `upsert_user_benefit_status`：
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
      "confirmedBy": "user_explicit_statement",
      "confirmedAtUtc": "2026-09-06T09:00:00Z",
      "completed": true
    },
    "idempotencyKey": "benefit_cube_switch_20260906_001"
  }
}
```
