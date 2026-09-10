# Canonical MCP tools

這份 reference 對應目前 source contract 的公開 surface：23 個工具。工具名稱、closed input、enum 與 fail-closed errors 以 `src/mcp-contract.ts`、`src/validation.ts` 和 `src/cli.ts` 為準；版本 tag 是發佈管理資訊，不是 public tool name。

## 23-tool matrix

| Tool | Read/write | 用途 |
|---|---|---|
| `calculate_reward` | read | 以提供的 rule、transaction、context 做單筆試算，不寫帳本 |
| `rank_cards` | read | 以提供的 cards/rules 做 deterministic 卡片排序 |
| `register_card` | write | 登記 card descriptor（不可有 PAN/CVV） |
| `list_cards` | read | 列出 user-scoped card 清冊 |
| `upsert_offer` | write | 寫入 source snapshot/rule；需符合 official evidence 與 confirmation gate |
| `upsert_fx_policy` | write | 保存有 official evidence 支持的 FX policy |
| `list_fx_policies` | read | 列出 user-scoped FX policies |
| `upsert_fx_observation` | write | 保存 source-attributed FX observation，可標記 public reference |
| `list_fx_observations` | read | 列出 user-scoped FX observations |
| `recommend` | read | closed card/payment_path union 的 bounded recommendation |
| `recommendation_preflight` | read | intent-shaped 呼叫沿用 `recommend` 的候選診斷；legacy transaction 仍提供相容 preflight，不修改狀態 |
| `upsert_payment_route` | write | 登記有界 route graph 與 funding identity |
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

## `recommend` 的 closed union

正常入口是 merchant-first intent：`merchant` 必填，其餘消費條件與 `cardIds`／
`routeIds` 篩選皆可省略。省略篩選時由 MCP 讀取目前 user state；回應使用 typed
candidate envelope，並帶狀態、required actions 與 bounded coverage。這個入口不
要求先呼叫任何 list tool 或 `recommendation_preflight`。

跨路徑報價可暫時以 `routeFacts: [{"routeId":"route_illustrative","edgeId":"edge_illustrative","fx":{...}}]` 提供；同一 route/edge scope 不可重複。需要重用時使用 `upsert_fx_observation`，並保留 `sourceKind` 與 route/edge scope。

Intent recommendation 預設每頁 10 筆；使用 `nextCursor` 與相同
`resultVersion` 續查。只有 `coverage.explorationComplete` 為 true 時，
`coverage.total` 才是完整總數。

```json
{
  "merchant": { "rawStatement": "示例商家", "country": "JP" },
  "amount": { "amountMinor": 10000, "currency": "JPY" },
  "channel": "in_store",
  "limit": 10
}
```

`recommend` 仍保留以下舊 transaction branch 與 payment-path branch 供相容／明確
查詢；它們不是正常意圖流程的前置步驟。

一般卡片 branch：

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

舊 transaction branch 的 `cardId` 可由 service 的 ranking seam 代入 placeholder；
正常商家 intent 不要求 Agent 先 `list_cards`。使用者要求明確卡片篩選或管理清單
時，才使用真實的已登記 opaque card ID。

多層 path branch 必須只有以下 envelope 形狀：

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

`payment_path` required field is only `amount`; `merchant`/`mcc`/`country`/`channel`/`paymentMethod`/`asOf`/`routeIds` and bounds are optional. `limit`, `maxHops`, `maxEvents`, `maxBranchesPerNode` each range from 1 to 20. The source contract also defines `eligibilityFacts`; the current CLI dispatcher does not forward that field in this branch, so callers requiring facts must treat public CLI use as a parity gap until runtime is aligned.

Response shape is `PaymentPathRecommendation`:

```json
{
  "status": "ok",
  "candidates": [
    {
      "id": "path:illustrative",
      "routeId": "route_illustrative",
      "nodes": [],
      "events": [],
      "fundingSource": { "kind": "account", "subtype": "wallet_balance", "accountId": "account_illustrative" },
      "grossReward": { "amountMinor": 0, "currency": "TWD" },
      "cappedReward": { "amountMinor": 0, "currency": "TWD" },
      "netReward": { "amountMinor": 0, "currency": "TWD" },
      "matchedRules": [],
      "exclusionReasons": [],
      "status": "ready"
    }
  ],
  "evaluatedAt": "2026-09-06T07:00:00.000Z",
  "blocked": [],
  "limits": { "maxCandidates": 20, "maxHops": 6, "maxEvents": 4, "maxBranchesPerNode": 8 }
}
```

Illustrative response values above are shape-only. Production candidates require the current user’s active/confirmed route, accepted official HTTPS evidence, valid period, and admissible edges. Planned path events never write event ledger records.

## Route and account payloads

`register_payment_account` accepts an opaque provider identity, not account number or credential:

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

`upsert_payment_route` accepts `route` with `layers`, `funding`, `observedAt`, `idempotencyKey`; for path evaluation it should also carry `nodes` and `edges`. A node is one of `funding_source`, `wallet_balance`, `payment_service`, `acceptance_network`, `merchant`. An edge uses one of `card_authorization`, `account_debit`, `wallet_top_up`, `wallet_debit`, `service_to_acceptance`, `merchant_settlement`, `direct_settlement`, `split_tender`, and must point to existing nodes. Edge `direction` must be outbound; production evaluation requires official provenance/evidence. `model_fixture` is for tests and is rejected at the production service boundary.

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

Historical versioned tool aliases are compatibility-only and must not appear in new calls. They may be documented solely in a migration note when explaining how an older host is upgraded to the canonical names.

### Explicit legacy alias map (migration only)

| Legacy caller name | Canonical replacement | Migration action |
|---|---|---|
| `recommend_payment_paths_v1` | `recommend` with `kind: "payment_path"` envelope | Move fields under `payment_path`; revalidate closed schema |
| `record_event_reward_v1` / `record_event_reward_v2` | `record_event_reward` | Supply exactly one `rule` or `chainRule` and bounded event inputs |
| `reverse_event_reward_v1` | `reverse_event_reward` | Keep `{event,idempotencyKey}` and verify explicit refund relation |

These names are not part of the 23-tool public matrix and are shown only so a
host can migrate old configuration. New Skill examples and tools/list checks
must use canonical names.
