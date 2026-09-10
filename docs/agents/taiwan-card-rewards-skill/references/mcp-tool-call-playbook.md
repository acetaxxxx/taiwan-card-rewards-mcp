# MCP tool-call playbook

這是給 Agent 的呼叫順序與 JSON 骨架；canonical 19-tool 清單與欄位定義在
[`mcp-tools.md`](mcp-tools.md)。每個 object 都是 closed schema。以下 ID、URL、rule、amount 是 illustrative，不能當成銀行產品或 production evidence。

## A. 商家消費意圖推薦（唯一入口）

推薦只需商家；已知金額與情境可一併提供。MCP 會讀取目前 user-scoped
cards 及已驗證 routes，回傳同一個 `status/candidates/requiredActions/coverage`
結果——`candidates` 同時包含直接刷卡（`kind: "direct_card"`）與跨錢包/多層路徑
（`kind: "payment_path"`）候選，不需要再呼叫任何路徑專用的 tool。不要先列
cards/routes，也不要先選 card ID 或 route ID。

```json
{
  "merchant": "示例商家",
  "amount": { "amountMinor": 10000, "currency": "TWD" },
  "country": "TW",
  "channel": "in_store",
  "limit": 10
}
```

只提供商家時，回應可包含尚未計算的候選與 `ask_user` action；未知金額不當作
零。商家歧義依 `requiredActions` 處理，再用相同意圖重新呼叫。候選範圍是目前
tenant 已知資料的有界集合，不宣稱涵蓋所有市場優惠。

`list_cards`／`list_payment_routes`／`list_payment_accounts` 是管理／明確清單
用途，不是商家意圖推薦的必要前置。

## B. 外幣交易：inline fx snapshot

外幣交易由 Agent 自行取得目前匯率，直接以單一 `fx` snapshot 附在 intent 上，
不需要先呼叫任何 FX 專用 tool：

```json
{
  "merchant": "示例商家",
  "amount": { "amountMinor": 10000, "currency": "JPY" },
  "country": "JP",
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

`fx` 通過幣別配對與新鮮度檢查（且 actual 情境下不是 `mid_market`）後即被直接
信任套用。若 `recommend` 回應的 `requiredActions` 帶有 `action: "query_approved_fx_source"`，
表示某張卡的規則需要外幣轉換但本次沒有提供可用的 `fx`；重新取得目前匯率、
用同一個 intent 加上 `fx` 再呼叫一次即可，不需要任何額外的儲存步驟。

跨路徑報價可用 `routeFacts: [{"routeId":"route_illustrative","edgeId":"edge_illustrative","fx":{...}}]`
針對特定 route/edge 提供更精確的匯率；同一 route/edge scope 不可重複。若同時
提供籠統的 `fx` 與精確的 `routeFacts`，`routeFacts` 優先，`fx` 只作為 fallback。

對於 actual 交易（`record_transaction`／`record_event_reward`），同樣的 `fx`
物件放在 `transaction.fx`／`event.fx` 底下：

```json
{
  "transaction": {
    "idempotencyKey": "purchase-illustrative",
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-06T14:30:00+08:00",
    "amount": { "amountMinor": 100000, "currency": "JPY" },
    "fx": {
      "id": "fx_illustrative",
      "baseCurrency": "JPY",
      "quoteCurrency": "TWD",
      "ratePpm": 220000,
      "capturedAt": "2026-09-06T07:00:00Z",
      "provider": "Example Bank",
      "rateType": "card_scheme"
    }
  }
}
```

Actual 交易禁止 `rateType: "mid_market"`；只能用 `cash_selling`、`spot_selling`
或 `card_scheme`。

## C. 建立 account、route 與 capability

先呼叫 `register_payment_account`（不傳帳號號碼或 credential）：

```json
{
  "account": {
    "providerId": "wallet_illustrative",
    "kind": "wallet_balance",
    "displayName": "Wallet (illustrative)",
    "observedAt": "2026-09-06T07:00:00Z",
    "evidenceIds": ["ev_official_illustrative"],
    "confirmation": { "confirmedAt": "2026-09-06T07:05:00Z", "confirmedBy": "user" },
    "idempotencyKey": "account-onboard-illustrative"
  }
}
```

再呼叫 `upsert_payment_route`。`evidenceIds` 是 Agent 自帶的 self-asserted
citation（例如官方頁面 URL 對應的識別字串），不需要先呼叫任何 evidence 提交
tool；只要 route/edge 的其餘欄位（`sourceUrl`、`authority`、`confidence: "high"`
等）合理，路徑就會被 `recommend` 視為可用：

```json
{
  "route": {
    "status": "active",
    "layers": [],
    "funding": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" },
    "observedAt": "2026-09-06T07:00:00Z",
    "sourceUrl": "https://official.example.invalid/terms",
    "authority": "issuer",
    "confidence": "high",
    "evidenceIds": ["ev_official_illustrative"],
    "confirmation": { "confirmedAt": "2026-09-06T07:05:00Z", "confirmedBy": "user" },
    "nodes": [
      { "id": "n_source", "kind": "funding_source", "displayName": "Linked account" },
      { "id": "n_wallet", "kind": "wallet_balance", "displayName": "Wallet" },
      { "id": "n_acceptance", "kind": "acceptance_network", "displayName": "Acceptance" },
      { "id": "n_merchant", "kind": "merchant", "displayName": "Merchant" }
    ],
    "edges": [
      { "edgeId": "e_topup", "fromNodeId": "n_source", "toNodeId": "n_wallet", "transition": "account_debit", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound" },
      { "edgeId": "e_purchase", "fromNodeId": "n_wallet", "toNodeId": "n_merchant", "transition": "merchant_settlement", "evidenceIds": ["ev_official_illustrative"], "provenance": "official", "direction": "outbound" }
    ],
    "idempotencyKey": "route-onboard-illustrative"
  }
}
```

The URL above is a shape placeholder only; a real production route should cite
a real official source. Set `direction` to the evidenced flow (`outbound` or
`inbound`); do not infer or reverse it. `provenance: "model_fixture"` is for
tests only.

若使用者事後表示某條路徑不可用，重新呼叫 `upsert_payment_route`（同一
`idempotencyKey`）並把 `status` 改成 `failed`、附上 `failure` 詳情即可。

`upsert_payment_capability` 用法類似，用來描述與特定 user route 無關的公共
支付能力（例如「這個錢包支援信用卡儲值」），`recommend` 會用它針對持有相符
卡片/帳戶的使用者自動產生 planned route；不需要另外呼叫任何 evidence tool。

## D. Event reward recording and reversal

For actual event reward, send `record_event_reward` with one target `event`, a
candidate, and exactly one `rule` or `chainRule`. A `funded_by` chain also sends
bounded `sourceEvents`. The server recomputes event eligibility; the candidate's
`matched` status is not trusted.

```json
{
  "event": {
    "id": "evt_purchase_illustrative",
    "kind": "purchase",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-06T07:10:00Z",
    "funding": { "kind": "account", "subtype": "wallet_balance", "accountId": "wallet_illustrative" },
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

For reversal, call `reverse_event_reward` with `{ "event": { ... }, "idempotencyKey": "..." }`; its event must contain one explicit refund relation. For ordinary card purchase/refund use `record_transaction`:

```json
{
  "transaction": {
    "idempotencyKey": "purchase-illustrative",
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "actual",
    "occurredAt": "2026-09-06T14:30:00+08:00",
    "amount": { "amountMinor": 200000, "currency": "TWD" },
    "merchant": "PChome"
  }
}
```

The linked refund keeps `kind: "refund"`, `mode: "actual"`, a positive amount,
its own idempotency key, and `refundOfId` pointing to the recorded purchase key.
Same-key same-payload retries replay; same-key different-payload retries fail.

## E. Research and offer ingestion

1. Agent obtains an official page/PDF and records snapshot URL, fetchedAt,
contentHash, valid period, provenance, and excerpt.
2. Call `resolve_merchant` before merchant-specific matching. Call `upsert_offer`
only with the extracted rule and required user confirmation. A community page is
lead-only, not authoritative activation evidence.
3. For foreign currency, follow section B above — supply `fx` inline, never
guess a rate or fall back to 1:1.
4. If fee currency cannot be converted, or a reward unit lacks an authoritative
valuation snapshot, present blocked/unknown and ask for recovery.

## F. Retired names

New agents call only the 19 names in `mcp-tools.md`. `upsert_fx_policy`,
`list_fx_policies`, `upsert_fx_observation`, `list_fx_observations`,
`recommendation_preflight`, `recommend_payment_paths_v1`,
`record_event_reward_v1`, `record_event_reward_v2`, and `reverse_event_reward_v1`
are fully retired — not hidden aliases, calling them returns `TOOL_NOT_FOUND`.
Do not reference them in new examples or integration code.
