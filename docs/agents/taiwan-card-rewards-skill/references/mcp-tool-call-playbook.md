# MCP tool-call playbook

這是給 Agent 的呼叫順序與 JSON 骨架；canonical 25-tool 清單與欄位定義在
[`mcp-tools.md`](mcp-tools.md)。每個 object 都是 closed schema。以下 ID、URL、rule、amount 是 illustrative，不能當成銀行產品或 production evidence。

## A. 商家消費意圖推薦（正常入口）

正常推薦只需商家；已知金額與情境可一併提供。MCP 會讀取目前 user-scoped
cards 及已驗證 routes，回傳同一個 `status/candidates/requiredActions/coverage`
結果。不要先列 cards/routes，也不要先選 card ID 或 route ID。

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

## B. 舊交易形狀卡片推薦（相容入口）

舊 host 或需要明確 transaction facts 時，才使用以下相容流程。`list_cards` 是
管理／明確清單用途；`recommendation_preflight` 是診斷用途，兩者都不是商家意圖
推薦的必要前置。

1. （相容流程可選）呼叫 `list_cards`：

```json
{ "limit": 20, "page": 1, "projection": "summary" }
```

2. 需要診斷時才呼叫 `recommendation_preflight`：

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "merchant": "momo購物網",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  }
}
```

3. 依舊契約（或診斷允許後）用同樣的 nested transaction 呼叫 `recommend`：

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "merchant": "momo購物網",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  },
  "limit": 3,
  "projection": "detail"
}
```

回應是 bounded ranking array（card recommendation）而非自訂的
`recommendations` wrapper。只呈現 MCP response 的 reward/status；planned 不扣 cap。

## C. 舊 payment-path envelope（相容／明確查詢）

只有 host 或使用者明確要求舊 payment-path envelope 時，對 account/card → wallet → acceptance → merchant 先列 account/route，確認
route 是該 user 的 active、官方 HTTPS evidence；證據一致即可使用，衝突或歧義時才詢問，再呼叫 `recommend`
的 closed payment-path branch：

```json
{
  "kind": "payment_path",
  "payment_path": {
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "merchant": "merchant_illustrative",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "wallet_balance",
    "routeIds": ["route_illustrative"],
    "limit": 20,
    "maxHops": 6,
    "maxEvents": 4,
    "maxBranchesPerNode": 8
  }
}
```

回應 `candidates[]` 可能含兩個 planned events：`top_up` 與 `purchase`，各自
有 transition、routeEdgeIds、evidenceIds、eligibility 與 relation。top-up amount
未被官方條款證明時，保留 unknown/undefined，不能從 purchase 金額倒推；wallet
fungible balance 也不自動 FIFO/LIFO 配對。詳見
[`examples/payment-path-recommendation.md`](../examples/payment-path-recommendation.md)。

目前 CLI public dispatcher 只轉送 payment_path 的 amount、merchant、mcc、country、channel、paymentMethod、asOf、routeIds 與 bounds；source schema 雖定義 `eligibilityFacts`，CLI 尚未轉送。需要 Gold/member fact 的呼叫須回報這個 parity gap，不可假裝已成功。

## C. 建立 account 與 route

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

再呼叫 `upsert_payment_route`：

```json
{
  "route": {
    "status": "active",
    "layers": [],
    "funding": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" },
    "observedAt": "2026-09-06T07:00:00Z",
    "sourceUrl": "https://official.example.invalid/terms",
    "authority": "official-provider",
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

The URL above is a shape placeholder only. A real production route needs a
real accepted official HTTPS evidence record; an unverified PayPay/sidecar/
Chromium path remains unknown.

## D. Event reward recording and reversal

For actual event reward, send `record_event_reward` with one target `event`, a
candidate, and exactly one `rule` or `chainRule`. A `funded_by` chain also sends
bounded `sourceEvents`. The server recomputes event eligibility; the candidate’s
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

## E. Research, offer, and foreign currency recovery

1. Agent obtains an official page/PDF and records snapshot URL, fetchedAt,
contentHash, valid period, provenance, and excerpt.
2. Call `resolve_merchant` before merchant-specific matching. Call `upsert_offer`
only with the extracted rule and required user confirmation. A community page is
lead-only, not authoritative activation evidence.
3. For foreign currency, include transaction `fx` with `baseCurrency`,
`quoteCurrency`, integer `ratePpm`, `capturedAt`, `maxAgeSeconds`, `provider`,
and `rateType` (`cash_selling`, `spot_selling`, `mid_market`, or `card_scheme`).
4. If fee currency cannot be converted, or a reward unit lacks an authoritative
valuation snapshot, present blocked/unknown and ask for recovery. Never use 1:1.

## F. Compatibility and migration

New agents call only the 19 names in `mcp-tools.md`. If an older host emits a
versioned event/path name, migrate it at the host boundary to the canonical
envelope and verify the new closed schema; do not advertise the old alias as a
public tool or write it into new examples.
