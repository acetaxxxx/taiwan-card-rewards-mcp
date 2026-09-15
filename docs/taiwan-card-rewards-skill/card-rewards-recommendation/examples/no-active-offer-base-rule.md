# Example: no matching offer

情境：使用者在無已驗證 merchant-specific offer 的五金行消費 NT$1,200。
`card_illustrative`、rule 與 reward 僅為 shape illustration。

```json
{
  "merchant": "阿福五金行",
  "amount": { "amountMinor": 120000, "currency": "TWD" },
  "country": "TW",
  "channel": "in_store",
  "occurredAt": "2026-09-06T15:00:00+08:00",
  "limit": 3
}
```

`recommend` 回傳的是 `{status, candidates, requiredActions, coverage}`，不是自訂
`recommendations` wrapper。若已驗證的 issuer base rule 命中，該 candidate 可呈現
`reward`；若沒有可用 rule，`status`/`exclusionReasons` 由 MCP 回傳，
Agent 不得憑卡片品牌自行補一個基礎比例。planned call 永不扣 cap。
