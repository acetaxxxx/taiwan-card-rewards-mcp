---
name: card-rewards-recommendation
description: "台灣信用卡消費推薦與最佳支付路徑比價 (Recommend Taiwan credit-card rewards)."
---

# 信用卡消費推薦黃金路徑 (Recommendation Golden Path)

本技能專注於消費前的**卡片比較、通路回饋與最佳支付路徑推薦**。

## 1. 任務工具視野 (Scoped Tools)
為避免認知干擾，本推薦任務**僅允許**使用以下唯讀查詢工具：
- `recommend`：核心推薦比價工具（計算命中規則、扣除海外手續費、剩餘回饋上限與排名）。
- `resolve_merchant`：僅在商家名稱有歧義（如「全家」有多個實體）時用於特店消歧義。
- 嚴禁在本推薦流程調用任何寫入型工具（如 `record_transaction`, `create_ingestion`）。

---

## 2. 推薦執行演算法 (Recommendation Loop Algorithm)

Agent 執行推薦時，**必須遵循以下結構化虛擬碼狀態機**：

### 階段一：要素萃取 (Input Extraction)
從使用者對話中解析以下三要素：
- `merchant`：特店名稱（如「唐吉訶德」、「全家便利商店」、「中華航空」）。
- `amount`：預計消費金額（整數或小數），幣別預設 `TWD`；若為國外消費則填對應外幣（如 `JPY`）。
- `paymentMethod`：支付方式（如「Apple Pay」、「街口支付」），若未指定則留空。

### 階段二：調用工具 (Initial Call)
呼叫 `recommend({ merchant, amount, currency, paymentMethod })`。

### 階段三：狀態機循環 (Recommendation Loop)

```text
WHILE (response.status !== 'ready'):
    🚨 觸發 Hard Gate 阻斷：
    嚴禁向使用者輸出任何推薦卡片名稱、趴數或排名！即使 candidates 有初步計算，一律視為未定案。

    FOR EACH action IN response.requiredActions:
        MATCH action.diagnostic.code WITH:

            CASE "merchant_ambiguous" (特店名稱模糊):
                -> 檢視 action.candidateIds 或 action.diagnostic.message
                -> 參考 [`workflows/merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md) 流程
                -> 向使用者列出 2~3 個候選實體請其選擇（例如：「請問是 1. 全家便利商店 還是 2. 全家餐飲？」）
                -> 等待使用者回覆選定項目

            CASE "missing_required_fact" (缺少必要消費事實，如金額或通路):
                -> 依據 action.path 向使用者提問（例如：「請問這筆消費預計金額是多少？」）
                -> 等待使用者回覆

            CASE "fx_missing" | "fx_stale" | "fx_pair_mismatch" | "fx_scope_mismatch" (缺少或過期外幣匯率):
                -> 責任為 agent (owner === 'agent')，禁止向使用者索取技術代碼
                -> 讀取 [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md) 獲取已知即時匯率快照與組裝格式
                -> 組裝 fx 物件 (ratePpm, capturedAt, provider, rateType)

            CASE "conflicting_fact" | "stale_fact" | "invalid_fact" (卡片資格事實衝突):
                -> 向使用者確認真實資格（例如目前持有的卡片會員等級或已切換方案）

            CASE "stale_rule" | "needs_review" (卡片權益條款需覆核):
                -> 該卡片候選標記為需要覆核，若其他卡片已 ready 則繼續進行；若為核心目標卡則提示使用者可能需要更新條款

        END MATCH

    [組裝重試 Payload]：
        - 保留原始交易意圖（merchant, amount 等）
        - 將補齊的事實填入 action.submission.field（例如填入 fx、或填入 supplementalFacts）
        - 帶入 expectedResultVersion: response.resultVersion（鎖定版本，防止並行漂移）
        - 再次調用 recommend 工具
        - 更新 response 為最新回傳結果

END WHILE
```

### 階段四：結案輸出 (Final Presentation)

- **情境 A (`response.status === 'ready'`)**：
  1. 依據 `candidates` 排名，依序輸出推薦卡片名稱。
  2. 標註名目回饋趴數、命中之權益規則名稱。
  3. 若為外幣交易，明確列出海外手續費（1.5%）與**預估實質淨回饋金額**。
  4. 提示該卡回饋上限剩餘額度。
- **情境 B (`response.status === 'no_match'`)**：
  - 誠實告知使用者目前登記的卡片無特定加碼通路，依據 `candidates` 排名，依序輸出推薦卡片名稱。

---

## 3. 診斷代碼處置映射表 (Diagnostic Code Matrix)

本表格直接對應 MCP 原始碼之真實枚舉：

| 診斷代碼 (`diagnostic.code`) | 責任人 (`owner`) | 說明 | Agent 處置指南與流程連結 |
|---|:---:|---|---|
| `merchant_ambiguous` | `user` | 特店在不同地區或體系有多個實體 | 參考 [`merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md) 列出選項確認，更新 `merchant` 後重試。 |
| `merchant_not_found` | `agent` | 特店尚未收錄於在地型錄 | 參考 [`merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md) 將已知品牌作為特店重新調用。 |
| `missing_required_fact` | `user` | 缺少金額 (`amount`) 或關鍵欄位 | 依據 `requiredActions` 之 `submission` 補齊欄位後重試（見下方速查表）。 |
| `fx_missing` / `fx_stale` | `agent` | 缺少或過期之外幣匯率快照 | 依 [`payment-route-and-fx.md`](workflows/payment-route-and-fx.md) 查詢牌告或卡組織匯率，組裝 `fx` 快照後重試。 |
| `conflicting_fact` | `user` | 資格條件衝突（如方案切換日期不符） | 向使用者詢問最新狀態，填入 `eligibilityFacts` 或 `supplementalFacts`。 |
| `stale_rule` / `needs_review` | `agent` | 權益可能已到期或需覆核 | 候選卡片標記為待覆核，或提示使用者載入 Ingestion 流程更新。 |

---

## 4. `INSUFFICIENT_FACTS` 與 `requiredActions` 結構化處置速查 (三大情境統一通用)

當 MCP 回傳狀態非 `ready` 且帶有 `requiredActions` 陣列時，**嚴禁 Agent 自行猜測下一步**。Agent 必須依據每個 action 的 `owner`、`path` 與 `submission` 執行標準處置：

| 缺少事實分類 | 觸發路徑 (`action.path`) | 責任歸屬 (`owner`) | MCP 指引之 `action` | 補齊目標與欄位 (`submission`) | Agent 具體 SOP 行動與重試條件 |
|---|---|:---:|---|---|---|
| **1. 交易核心要素** | `amount`<br>`merchant` | `user` | `ask_user`<br>`resolve_merchant` | `{ tool: "recommend", field: "amount" }`<br>`{ tool: "recommend", field: "merchant" }` | 向使用者詢問消費金額與幣別；或遇到特店歧義時呈現選項供使用者選定，回填後帶入原 intent 重試。 |
| **2. 使用者資格事實** | `eligibilityFacts`<br>（如 `user.membership`、`card_switch`） | `user` | `ask_user`<br>`resolve_conflict` | `{ tool: "recommend", field: "eligibilityFacts" }` | 向使用者確認持卡身份或權益方案（如「您目前是金卡會員嗎？」或「CUBE卡目前設定哪個方案？」），將自報 fact 填入 `eligibilityFacts`。 |
| **3. 支付工具缺失** | `paymentCapabilities.<id>` | `user` | `bind_payment_method` | `{ tool: "register_card", field: "card" }` 或 `{ tool: "register_payment_account", field: "account" }` | 告知使用者：「此支付路徑需要特定信用卡或電子錢包」，引導使用者調用 `register_card` 登記，或切換其他支付方式。 |
| **4. 結算與清算要素** | `timezone`<br>`transaction.fx` | `agent` | `query_approved_fx_source`<br>`refresh_fx_snapshot` | `{ tool: "recommend", field: "fx" }`<br>或補齊 `timezone` | 若缺少時區，於時間欄位帶入 ISO 8601 時區偏移（如 `+08:00`）；若缺少匯率，依 `fxResolutionRequest.sourceUrls` 查核並組裝 `fx` 快照。 |

