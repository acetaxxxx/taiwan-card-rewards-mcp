# Preflight and recommendation workflow (legacy transaction branch)

本文件描述舊 transaction-shaped 相容／診斷流程。正常商家消費意圖直接呼叫
`recommend`，請先讀 [`recommendation-intent.md`](recommendation-intent.md)；不要求
先 `list_cards` 或先跑 preflight。

`recommendation_preflight` 是 read-only 診斷；它不連網、不修改 state。需要資料時 Agent 依 `requiredActions` 到 MCP 外查官方來源、詢問使用者或補齊已驗證 facts，再重跑 preflight。

## 1. 合法 card recommendation payload

```json
{
  "transaction": {
    "cardId": "card_illustrative",
    "kind": "purchase",
    "mode": "planned",
    "occurredAt": "2026-09-06T15:00:00+08:00",
    "amount": { "amountMinor": 300000, "currency": "TWD" },
    "merchant": "momo購物網",
    "mcc": "5311",
    "country": "TW",
    "channel": "online",
    "paymentMethod": "direct_card"
  },
  "context": {
    "now": "2026-09-06T07:00:00Z"
  }
}
```

所有 object 都是 closed；金額用 minor units。`cardId` 在 recommendation schema 可由 service ranking seam 代入 placeholder；本相容流程若需要展示卡片清單，才查 user 已登記 card。

## 2. 診斷循環

1. 送 `recommendation_preflight`，讀取 `ready`、`requiredActions`、`diagnostics`、`requirements`。
2. `clarify_merchant`：呼叫 `resolve_merchant`；候選超過一個時讓使用者選，不做 fuzzy auto-accept。
3. `refresh_offer`/`research_evidence`：Agent 查官方頁面/PDF，附 snapshot、rule、期間與 confirmation，呼叫 `upsert_offer`。
4. `register_card`：只送 issuer/product/network/last4 等 descriptor，不送 PAN/CVV。
5. `refresh_external_data`/FX：提交包含 provider、rateType、capturedAt、ratePpm 的 validated `fx`。缺 snapshot 或超過 max age 就維持 stale/unknown。
6. `review_conflict`/benefit：檢查 user benefit status、combination/stacking policy，必要時詢問使用者，不自行選 priority。
7. `recommendation_preflight` 只在 legacy transaction 或明確診斷需求使用；正常 merchant-first 流程直接重跑 `recommend`，不要求先取得 preflight 的 ready 結果。

## 3. 呼叫 recommendation

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
  "page": 1,
  "projection": "detail"
}
```

回傳是 bounded ranking entries；不要自行包裝成未定義的 `recommendations` schema，也不要把缺失/unknown reward 當作 0。planned recommendation 不消耗 cap、不寫 ledger。

## 4. Payment path 分支

多層路徑不是把 `paymentRoute` 塞入 card transaction。使用 `recommend` 的 closed envelope：

```json
{
  "kind": "payment_path",
  "payment_path": {
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "merchant": "merchant_illustrative",
    "routeIds": ["route_illustrative"],
    "maxHops": 6,
    "maxEvents": 4,
    "maxBranchesPerNode": 8,
    "limit": 20
  }
}
```

先 `list_payment_accounts`、`list_payment_routes`，只選 current user's active + confirmed + accepted official HTTPS evidence route。response candidates 會列有界 nodes/events；top-up 金額、wallet source allocation、Gold/member facts 未證實時應顯示 unknown/blocked。不得自動 FIFO/LIFO。

Source schema 可描述 `eligibilityFacts`，但目前 CLI payment_path dispatcher 未把它轉給 service；依賴 Gold/member fact 的 public invocation 應標示 parity gap 並停止宣稱 ready，直到 runtime 對齊。

## 5. 輸出與停止標準

| 回應狀態 | Agent 行動 |
|---|---|
| `ready`/`ok` | 顯示 ranking、gross/capped/net、fees、required actions 與 evidence |
| `no_match` | 解釋明確不符合的條件 |
| `unknown`/`needs_facts` | 取得缺失 fact；不改成零 |
| `stale`/`needs_review`/`blocked` | 刷新官方 evidence 或詢問使用者；不寫 ledger |

完成條件：payload 通過 closed contract、所有必要 facts 有 provenance、status 被正確轉述、planned 與 actual 邊界維持不變。
