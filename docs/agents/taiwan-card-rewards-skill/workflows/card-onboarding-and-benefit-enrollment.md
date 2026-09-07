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
[列出卡片驗證 list_cards] ◄┘
       │
       ├── 使用者要查最新優惠？ ──► [官方研究 + merchant identity gate + upsert_offer]
       │                                      │
       └── 使用者只要登記卡片 ────────────────┘
                                              ▼
                                  [確認權益方案/活動]
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

### 步驟 4：詢問是否要同步研究這些卡的優惠（選填，但必須明確分流）

登記信用卡本身**不會自動建立商家或優惠 rule**。完成 `list_cards` 後，Agent 應詢問：

> 「要不要現在查這些卡的最新官方優惠？如果要查，我會逐張卡整理官方來源；遇到指定商家，會先建立或解析 canonical merchant identity，再寫入 rule。」

- 使用者回答「不用」：進入步驟 5 的權益方案詢問，或直接完成卡片 onboarding。
- 使用者回答「要」：讀取 [`research-and-evidence-submission.md`](research-and-evidence-submission.md) 與 [`offer-discovery-and-pagination.md`](offer-discovery-and-pagination.md)，由 Agent 在 MCP 外部取得官方條款與快照，再逐條提交。
- 每一條 merchant-specific offer 都必須先走 `resolve_merchant`：
  - `confirmed`：把回傳的 `mch_<ULID>` 放進 `rule.match.merchants`。
  - `ambiguous`：向使用者確認市場、分店或業態後再查詢。
  - `unresolved` 但官方資料足夠：在同一次 `upsert_offer` 帶入 `merchant` 與 `candidate` rule，由 MCP 生成 ID 並原子保存。
  - 官方資料不足：保留 candidate，不猜測商家身份。
- 不同銀行若指向同一商家，重用同一個 canonical merchant ID；銀行卡、來源快照、有效期限與回饋規則仍分開保存。
- `merchant` 是 candidate 時，不得把 merchant-specific rule 寫成 `active`；一般 MCC／國家／通路 rule 可以在其自身證據與確認條件成立時獨立處理。

**完成條件**：若使用者要求研究優惠，所有已提交的 merchant-specific rule 都必須有已解析的 canonical ID，或明確標記為與 candidate merchant 原子保存的 candidate rule；不得留下 raw merchant name 作為 active selector。

### 步驟 5：主動引導並登錄動態權益方案（選填）
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
