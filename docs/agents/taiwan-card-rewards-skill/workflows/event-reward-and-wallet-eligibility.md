# Event reward and wallet eligibility workflow

這個 workflow 處理 top-up、purchase、refund、reversal 與跨事件 eligibility。MCP 不瀏覽銀行頁面、不呼叫 wallet API，也不從 wallet balance 猜 funding provenance；Agent/UI 先取得官方 evidence，再交給 MCP 驗證、matching、stacking、cap、idempotency 與 ledger。

## 1. 先分清經濟事件

一筆「帳戶儲值 wallet，再用 wallet 消費」至少是兩個 planned/actual event：

```text
E1 top_up:  account / linked_bank_account → wallet_balance
E2 purchase: wallet_balance → payment service/acceptance → merchant
E2.relations.funded_by = [E1.id] 只有在條款與事實明確支持時才提供
```

卡片儲值也是 `top_up`；後續 wallet purchase 不會自動繼承信用卡 issuer reward。PayPay inbound acceptance、PayPay outbound top-up、bank account top-up 是不同方向/事件，不能因名稱相近而合併。

Fungible wallet 混合多筆來源時，不自動 FIFO/LIFO 或比例配對。只有官方條款要求資金追溯，且 Agent 能提供 bounded source events、唯一 relation、時間窗與金額證據時，才建立 chain eligibility；否則回傳 unknown/needs_review。

## 2. Planned path 與 actual event 的分界

`recommend` payment_path branch 只產生 bounded path candidates 與 planned events：它不寫 event ledger、不扣 cap、不預約回饋。top-up 金額或 membership fact 不明時，保留 `unknown`/undefined 及 required action；不能用 purchase amount 或使用者猜測補值。

只有實際發生且 evidence 齊全時，才呼叫 `record_event_reward`。它要求：

- `event`（`id`、`kind`、正數 `amount`、`occurredAt`、`funding`）；
- `candidate`（event/rule/evidence identity、sponsor、benefitGroup、eligibility）；
- exactly one `rule` 或 `chainRule`；
- chain 必須提供最多 16 個 `sourceEvents`，且 target event 明確有 `relations.funded_by`；
- stable `idempotencyKey`。

Server 會依 user scope 與 stored evidence 重新 match。即使 caller 傳 `eligibility.status: matched`，也不能繞過該 gate。

## 3. 呼叫順序

1. `list_payment_accounts` 確認 wallet/bank opaque IDs，再 `list_payment_routes` 確認同 user route。
2. Agent 在 MCP 外查官方頁面/PDF，保存 evidence identity、URL、期間、hash、excerpt 與 source type。
3. 需要新增 identity 時，使用 `register_payment_account`；需要 route graph 時，使用 `upsert_payment_route`。禁止帳號號碼、credential、token。
4. planned 行動呼叫 `recommend` payment_path；只呈現 ready/blocked/unknown 與 bounded events。
5. actual event 呼叫 `record_event_reward`。同一 sponsor/benefit group 若沒有明確 combination mode（`additive`、`replace`、`best_of`、`exclusive`、`prerequisite` 等），停止並 needs_review；不可假定同 owner 互斥或不同 owner 必疊加。
6. refund/reversal 呼叫 `reverse_event_reward`，用一個 explicit relation 指向已記錄 event。不要以 merchant 名稱、金額或猜測 id 尋找原 reward。

## 4. 合法 chain payload 骨架

下列 ID 與 evidence 都是 illustrative，不能聲稱任何真實銀行/PayPay 路徑：

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

`eventRule` and `chainRule` are mutually exclusive. A chain rule must use relation `funded_by`, a 1..31-day bounded `windowSeconds`, and source/target event rules. `reverse_event_reward` input is `{ "event": <refund-or-reversal-event>, "idempotencyKey": "..." }`.

## 5. Status handling

| Status | Meaning | Agent action |
|---|---|---|
| `matched` | Server found eligible event rule/chain | Record only after actual event and confirmation |
| `no_match` | Explicit event fact fails rule | Explain failed condition; do not retry with guessed facts |
| `unknown`/`needs_facts` | Missing amount, relation, membership, evidence, or source | Ask for fact/evidence; do not make it zero |
| `needs_review` | Ambiguous stacking, duplicate source, conflict, stale evidence | Resolve policy/evidence before writing |

同一 idempotency key + same payload replays the prior durable decision；different payload fails with conflict。所有 mutation 都在 current user 的 configured data directory 內持久化。
