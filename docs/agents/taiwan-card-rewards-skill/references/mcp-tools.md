# Canonical MCP tools

這份 reference 對應目前 source contract 的公開 surface：19 個工具。工具名稱、closed input、enum 與 fail-closed errors 以 `src/mcp-contract.ts`、`src/validation.ts` 和 `src/cli.ts` 為準；版本 tag 是發佈管理資訊，不是 public tool name。

## 19-tool matrix

| Tool | Read/write | 用途 |
|---|---|---|
| `calculate_reward` | read | 以提供的 rule、transaction、context 做單筆試算，不寫帳本；適合在 `upsert_offer` 前驗證一條 rule 的數學，或對未確認的候選優惠展示假設性回饋 |
| `register_card` | write | 登記 card descriptor（不可有 PAN/CVV） |
| `list_cards` | read | 列出 user-scoped card 清冊 |
| `upsert_offer` | write | 寫入 source snapshot/rule，可原子性地帶入一個候選商家；有一致證據時預設可用，衝突或歧義才需要使用者處理 |
| `recommend` | read | merchant-first intent 的 bounded recommendation；一次呼叫回傳直接刷卡與多層付款路徑的統一候選清單 |
| `upsert_payment_route` | write | 登記有界 route graph 與 funding identity；自帶 evidenceIds 即視為可用，使用者否認才標記 failed |
| `upsert_payment_capability` | write | 保存與 user route 分離的公共支付能力；自帶 evidenceIds 即視為可用 |
| `list_payment_capabilities` | read | 列出可供 planned route generation 使用的公共支付能力 |
| `list_payment_routes` | read | 列出 user-scoped route |
| `register_payment_account` | write | 登記 wallet/linked bank account 的 opaque identity 與 evidence |
| `list_payment_accounts` | read | 列出可供 route 引用的 account identity |
| `record_transaction` | write | 寫入 actual purchase 或 linked refund、更新 cap usage |
| `record_event_reward` | write | server 重新判斷 event-local rule 或 explicit `funded_by` chain 後記帳 |
| `reverse_event_reward` | write | 依 explicit refund/reversal relation 反轉 event reward |
| `remaining_caps` | read | 查詢 actual usage 後的 cap 餘額 |
| `get_user_benefit_status` | read | 查詢使用者權益狀態與可執行候選 |
| `upsert_user_benefit_status` | write | 寫入 user-confirmed benefit action |
| `resolve_merchant` | read | 驗證 Agent 提供的 merchant identity/candidate |
| `search_active_offers` | read | 有界搜尋 active offer，不直接套用回饋 |

每個工具的 input object 都是 `additionalProperties: false`。所有 arrays、page/limit、route graph、event source list 都有上限。

`upsert_fx_policy`、`list_fx_policies`、`upsert_fx_observation`、`list_fx_observations`、`recommendation_preflight` 已完全移除——FX 收斂成單一 inline snapshot（見下），`recommend` 本身就是唯一、完整的推薦入口，不再需要獨立的 preflight 呼叫。`rank_cards` 也已移除：它只是把呼叫端自帶的 cards/rules 排序，沒有存取 store，Agent 重複呼叫 `calculate_reward` 就能自己排序，因此收斂成單一用途的 `calculate_reward`。`recommend_payment_paths_v1`、`record_event_reward_v1`、`record_event_reward_v2`、`reverse_event_reward_v1` 這些版本化別名也一併移除；只使用上表的正式名稱。

## `recommend`：merchant-first intent

唯一入口是 merchant-first intent：`merchant` 必填，其餘消費條件與 `cardIds`／
`routeIds` 篩選皆可省略。省略篩選時由 MCP 讀取目前 user state；回應使用 typed
candidate envelope，並帶狀態、required actions 與 bounded coverage。這個入口不
要求先呼叫任何 list tool。

`candidates` 是單一、統一的陣列：每個 candidate 的 `kind` 是 `direct_card`（直接刷卡）或 `payment_path`（跨錢包/多層中介的付款路徑，如信用卡→儲值錢包→商家）。同一次 `recommend` 呼叫就會同時比較兩種候選並排序，不需要再呼叫任何額外的路徑專用 tool。

外幣交易由 Agent 自行取得目前匯率，直接以單一 `fx` snapshot 附在 intent 上：

```json
{
  "merchant": { "rawStatement": "示例商家", "country": "JP" },
  "amount": { "amountMinor": 10000, "currency": "JPY" },
  "channel": "in_store",
  "fx": {
    "id": "fx_illustrative",
    "baseCurrency": "JPY",
    "quoteCurrency": "TWD",
    "ratePpm": 220000,
    "capturedAt": "2026-09-06T07:00:00Z",
    "provider": "Example Bank",
    "rateType": "card_scheme",
    "sourceUrl": "https://bank.example/fx"
  },
  "limit": 10
}
```

`fx` 一旦通過幣別配對與新鮮度檢查（且 actual 情境下不是 `mid_market`）就會被直接信任套用，沒有額外的「政策」或「觀測值儲存」層——不需要先呼叫任何 FX 專用 tool 才能使用。跨路徑報價可用 `routeFacts: [{"routeId":"route_illustrative","edgeId":"edge_illustrative","fx":{...}}]` 針對特定 route/edge 提供更精確的匯率；同一 route/edge scope 不可重複。若同時提供籠統的 `fx` 與精確的 `routeFacts`，`routeFacts` 優先，`fx` 只作為找不到精確匹配時的 fallback（此時對應 candidate 的 `fxEstimate.status` 會標成 `estimated_fallback`）。

Intent recommendation 預設每頁 10 筆；一般流程使用 `limit` + 1-based `page`、送回的
`resultVersion` 與相同
`resultVersion` 續查，`cursor/nextCursor` 僅保留給 legacy。只有 `coverage.explorationComplete` 為 true 時，
`coverage.total` 才是完整總數。

若要單獨篩選卡片，使用 `cardIds`；若要限制路徑搜尋範圍，使用 `routeIds`。這兩個欄位是選填的縮小條件，不是必要的前置查詢。

若付款路徑上的規則要求 prerequisite/stacking 資格（例如「使用者是金卡會員」），用 `eligibilityFacts: [{"factKey":"user.membership","value":"gold"}]` 直接在同一次 `recommend` 呼叫裡提供；這些事實由 Agent 自報並直接信任，同一個 `factKey`（依 `cardId` 區分）不可提供互相衝突的值，否則整體回應會 fail-closed 成 `needs_review`。

Response 中每個 candidate 的 `fxEstimate.status` 可能是 `estimated`（有精確的 routeFacts 匹配）、`estimated_fallback`（用籠統的 `fx` 做貨幣對匹配，不是精確的 per-edge fact）、`stale_estimate`（套用的 fx 已超過新鮮度視窗）或 `unavailable`（外幣規則需要 fx 但完全沒有可用資料）。直接刷卡且 Agent 已在本次呼叫提供 `fx` 時不會有 `fxEstimate` 標註——Agent 本來就知道自己提供了什麼。

## Route、capability 與 account payloads

`register_payment_account` 接受 opaque provider identity，不接受帳號或憑證：

```json
{
  "account": {
    "providerId": "wallet_illustrative",
    "kind": "wallet_balance",
    "displayName": "Wallet (illustrative)",
    "status": "active",
    "observedAt": "2026-09-06T07:00:00Z",
    "evidenceIds": ["ev_official_illustrative"],
    "confirmation": { "confirmedAt": "2026-09-06T07:05:00Z", "confirmedBy": "user" },
    "idempotencyKey": "account-onboard-illustrative"
  }
}
```

`upsert_payment_route` 接受 `route`，含 `layers`、`funding`、`observedAt`、`idempotencyKey`；要參與路徑搜尋還需要 `nodes` 和 `edges`。node 的 kind 是 `funding_source`、`wallet_balance`、`payment_service`、`acceptance_network`、`merchant` 之一。edge 的 transition 是 `card_authorization`、`account_debit`、`wallet_top_up`、`wallet_debit`、`service_to_acceptance`、`merchant_settlement`、`direct_settlement`、`split_tender` 之一，且必須指向已存在的 node。edge 的 `direction` 可為 `inbound` 或 `outbound`，須依有證據的資金流向填寫；不可自行反轉或推測。`evidenceIds` 必須非空但直接信任 Agent 自帶的內容，不需要另外呼叫任何 evidence tool 先行提交。`provenance: 'model_fixture'` 只給測試使用，production 會拒絕。

`upsert_payment_capability` 同樣直接信任 Agent 提供的 `evidenceIds`（至少一筆），一旦 `status: 'active'` 就可能被 `recommend` 用來自動產生 planned route（例如「持有信用卡 + 錢包支援」→ 自動組出信用卡儲值進錢包再付款的路徑）。

路徑與能力一旦被 `recommend` 使用，若使用者明確表示該路徑/能力不可用，用相同的 `upsert_payment_route`／未來的等效呼叫把 `status` 改成 `failed`（route）即可，不需要撤銷任何 evidence 紀錄。

## Event reward and durable ledger calls

Event calls use one `event` and one `candidate`; the public event tool additionally requires exactly one `rule` or `chainRule` (a chain also requires bounded `sourceEvents`):

```json
{
  "event": {
    "id": "evt_purchase_illustrative",
    "kind": "purchase",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-06T07:10:00Z",
    "funding": { "kind": "account", "subtype": "wallet_balance", "accountId": "account_illustrative" },
    "relations": { "funded_by": ["evt_topup_illustrative"] }
  },
  "sourceEvents": [
    {
      "id": "evt_topup_illustrative",
      "kind": "top_up",
      "amount": { "amountMinor": 10000, "currency": "TWD" },
      "occurredAt": "2026-09-06T07:00:00Z",
      "funding": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" }
    }
  ],
  "chainRule": {
    "id": "chain_illustrative",
    "version": "evidence-version-1",
    "relation": "funded_by",
    "windowSeconds": 2592000,
    "sourceRule": { "id": "source-rule", "version": "1", "eventKind": "top_up", "fundingKind": "account", "fundingSubtype": "linked_bank_account" },
    "targetRule": { "id": "target-rule", "version": "1", "eventKind": "purchase", "fundingKind": "account", "fundingSubtype": "wallet_balance" }
  },
  "candidate": {
    "eventId": "evt_purchase_illustrative",
    "ruleId": "rule_illustrative",
    "ruleVersion": "evidence-version-1",
    "evidenceId": "ev_official_illustrative",
    "sponsor": "sponsor_illustrative",
    "benefitGroup": "benefit_illustrative",
    "eligibility": { "status": "matched", "reasons": [] }
  },
  "idempotencyKey": "event-reward-illustrative"
}
```

`record_event_reward` recomputes eligibility and stacking server-side; a caller cannot forge `matched`. `reverse_event_reward` is `{event,idempotencyKey}` and requires exactly one explicit refund relation to a recorded event. For card purchase/refund, `record_transaction` takes `{transaction:{cardId,kind,mode,occurredAt,amount,idempotencyKey,...}}`, and actual refunds reference `transaction.refundOfId`.

## Status and migration rules

- `ok`/`ready`: present the calculated fields and evidence.
- `no_match`: the rule did not qualify; explain the proven failed condition.
- `unknown`/`needs_facts`: ask for the missing fact; never render zero as a proven reward.
- `stale`/`blocked`/`needs_review`: refresh evidence, clarify policy, or stop before writing.

`upsert_fx_policy`、`list_fx_policies`、`upsert_fx_observation`、`list_fx_observations`、`recommendation_preflight`、`rank_cards`、`recommend_payment_paths_v1`、`record_event_reward_v1`、`record_event_reward_v2`、`reverse_event_reward_v1` 這些名稱已經完全從 `tools/list` 與 dispatch 層移除，不是隱藏別名，呼叫會直接得到 `TOOL_NOT_FOUND`。不要在任何新的 Skill 範例或整合程式碼裡引用它們。
