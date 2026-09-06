# FX Snapshot 儲存與 Current Rate 簡化政策

**狀態**：Normative amendment，待獨立 Review
**版本**：0.2.0
**語言**：繁體中文

## 1. 目的

原本的 FX contract 過度強調同時保存多份可能有效的 snapshot。本修訂將
「計算需要的匯率」與「歷史交易稽核」分開，讓 MCP 只維護簡單、可替換的
current rate，同時保留實際交易用過的 rate，避免重算與資源浪費。

## 2. Current Rate Store

MCP 以以下 key 維護一份 current rate：

```text
(baseCurrency, quoteCurrency, rateType)
```

預設不依發卡行拆分。只有來源明確表示不同 issuer/card 使用不同匯率時，才
加上可選的 `issuerScope` 或 `cardIdScope`。若不同發卡行的匯率可視為同一
市場匯率，使用同一份 current rate，不建立多份近似 snapshot。

更新 current rate 時，以新鮮度與 provider policy 替換舊的 current value，
而不是讓所有歷史 observation 同時成為可選候選。

## 3. Agent 與 MCP 責任

- Agent 或 approved provider adapter 負責取得匯率並提交 observation。
- MCP 不連網、不猜測、不自動平均多個 provider。
- MCP 驗證 pair、ratePpm、capturedAt、freshness 與 scope。
- calculation 可以使用 Agent 明確提交的 FX observation；若呼叫契約允許省略
  `transaction.fx`，MCP 才能使用該 pair 的 fresh current rate，並在結果中
  回傳實際採用的 rate reference。
- `record_transaction` 必須凍結實際採用的 `ratePpm`、pair、capturedAt 與
  provider，不能在退款時重新讀 current rate。

## 4. 最小資料契約

計算必要欄位：

```typescript
interface FxRateObservation {
  baseCurrency: string;
  quoteCurrency: string;
  ratePpm: number;
  capturedAt: string;
  provider: string;
  rateType: string;
  issuerScope?: string;
  cardIdScope?: string;
  sourceUrl?: string;
  contentHash?: string;
}
```

- `fxSnapshotId` 不要求由 Agent 提供。
- MCP 寫入 current store 或 durable transaction record 時，生成 authoritative
  UUID/ULID。
- `sourceUrl`、`contentHash` 是稽核 metadata；沒有公開文件的 provider 不必
  偽造這些欄位，但必須保留 provider 與 capture time。
- `issuerScope`、`cardIdScope` 預設省略；只有 rate 真正專屬時才使用。

## 5. 歷史保留與資源控制

MCP 至少保留：

1. 每個 pair/type 的一份 fresh current rate；
2. 所有仍被 `Recorded Purchase`、Refund 或 audit record 引用的 applied rate。

未被任何 durable record 引用的舊 current observations 可以依 retention policy
清理。清理不得影響已記錄交易的 applied rate，也不得讓退款重新使用新的
current rate。

若 Agent 一次提交多份同 pair snapshot，MCP 不自動合併或平均；應選定一份
作為 current observation，或回 `fx_conflict` 要求 Agent/政策指定來源。

## 6. Fail-Closed 狀態

| 情況 | 回應 | 下一步 |
|---|---|---|
| 找不到 current rate 且未提供 observation | `fx_missing` | Agent 查詢 approved source |
| current/observation 過期 | `fx_stale` | 取得新鮮匯率 |
| pair 不符 | `fx_pair_mismatch` | 重新建立正確 pair |
| issuer/card scope 不符 | `fx_scope_mismatch` | 改用適用 scope 或確認卡片 |
| 同次請求多份來源互相衝突 | `fx_conflict` | 選一個 authoritative provider |

這些狀態都必須帶 `path`、`requiredFacts` 與 `retryAction`。不再把所有狀況
壓成沒有下一步資訊的 `unknown`。

## 7. 驗收條件

1. 一般 pair 不會因不同發卡行而建立多份重複 current snapshot。
2. issuer/card scope 只有在來源明確要求時才出現。
3. 歷史交易能重現當時實際使用的匯率。
4. 舊未引用 observations 可以清理，且不影響退款。
5. MCP 從不進行隱藏網路查詢或自行猜測匯率。
