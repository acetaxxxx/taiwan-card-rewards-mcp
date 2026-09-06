# MCP 有界回應、分頁、Projection 與 Store Isolation 規格

**狀態**：Target normative specification，待獨立 Review
**版本**：0.1.0
**語言**：繁體中文

## 1. 目的與範圍

本規格定義 MCP 如何在資料量增加時，仍以可預測的 payload 大小、穩定分頁
與 user-scoped store 回應 Agent。MCP 不得把整份 JSON state、內部檔案或
data directory 暴露給 Agent。

本規格適用於 `list_cards`、benefit/cap 查詢、商家解析、recommend 及未來
catalog 查詢。單筆 `calculate_reward` 的 breakdown 仍須遵守單筆大小上限。

## 2. 核心決策

1. 所有 read tool 都回傳任務所需的 projection，不回傳原始 durable state。
2. 所有可列舉結果都使用 `limit`、穩定排序與 query-bound `cursor`；在低頻
   靜態查詢可相容地使用 1-based `page`。
3. 超過大小或計算政策上限時，回傳明確錯誤或下一頁，不得靜默截斷。
4. 每頁回應帶有 `evaluatedAt` 與資料/index version；跨頁查詢以相同的
   evaluation context 與排序保留可重現性。
5. Tool arguments 不得接受 `user_id`、`data_dir`、任意檔案 `path` 或其他
   用來繞過 process-scoped isolation 的欄位。

## 3. Projection 契約

Read tool 應支援下列概念性 projection：

| Projection | 內容 | 用途 |
|---|---|---|
| `summary` | ID、顯示名稱、狀態、少量摘要 | Agent 初次探索 |
| `detail` | 單筆完整公開欄位與 provenance | 使用者確認或說明 |
| `calculation` | 計算所需的已驗證 facts、rule version、breakdown | 純計算與稽核 |
| `audit` | provenance、fingerprint、版本與時間戳 | review、replay、debug |

未被 projection 要求的敏感、內部或大型欄位不得附帶回傳。

標準回應形狀如下：

```json
{
  "items": [],
  "projection": "summary",
  "pageInfo": {
    "page": 1,
    "limit": 10,
    "totalPages": 1,
    "hasMore": false,
    "nextCursor": null
  },
  "evaluatedAt": "2026-09-05T12:00:00Z",
  "dataVersion": "offers-42",
  "diagnostics": []
}
```

## 4. Payload 與計算界線

- 每個 tool 宣告 deployment policy 的 `maxItems` 與 `maxBytes`。
- `limit` 必須是正整數，超過政策上限回 `invalid_input`，不得自動改成上限
  後假裝成功。
- 單筆 record 過大回 `PAYLOAD_TOO_LARGE`，並附 `path` 與可用的 detail/summary
  替代方案。
- 多筆查詢過大時回傳 `hasMore: true` 與下一個 `page`，或明確回
  `PAYLOAD_TOO_LARGE`；不得只回前半段而不告知遺漏。
- 不同 native reward unit、currency 或 point system 不得為了縮短 payload
  被強制相加；應回傳分開的 breakdown。

## 5. Page 規格

`limit` 是本次頁面筆數，必須受 deployment policy 的 `maxItems` 限制。動態
查詢使用 opaque `cursor`；cursor 綁定 tenant、query、projection、evaluation
context、dataVersion 與排序版本，任何不一致都回 `invalid_input`，不可跨租戶
或跨查詢重用。低頻、靜態查詢可接受 1-based `page` 作為相容模式，但不得把
offset 分頁當成動態資料的一致性保證。

每頁回應應附帶 `limit`、`hasMore`、`evaluatedAt`、`dataVersion` 與
`nextCursor`（若有）；page 相容模式另外附帶 `page`/`totalPages`。超出範圍
回空 `items` 與合法 pageInfo，不視為錯誤。若呼叫端更改 query、evaluation
time 或 projection，必須丟棄 cursor 並重新查詢。

資料在跨頁期間變動時，以回應中的 `dataVersion` 與 `evaluatedAt` 告知 Agent；
MCP 不承諾跨不同 dataVersion 的 offset 結果完全不位移。

## 6. Store Isolation

MCP process 啟動時綁定單一 user-scoped `--data-dir` 與 lock。工具只能讀取
該 process 已綁定的 store；任何呼叫端都不能透過參數切換使用者或路徑。

MCP 不回傳：

- 內部 data directory 的絕對路徑
- 原始 state JSON 檔案
- 其他 tenant 的 card、offer 或 ledger
- 可用來繞過 validation 的檔案修改入口

Agent 若需要新增或修正資料，必須使用 typed MCP mutation，由 MCP 驗證、套用
user scope 並原子寫入。

## 7. 驗收條件

1. 大量 cards/rules/snapshots 查詢不會產生無界 payload。
2. 相同 query、page、limit 與相同資料版本的結果順序穩定。
3. page/limit 不能跨 tenant 讀取資料，且不洩漏另一 tenant 是否存在。
4. 超限不會靜默截斷。
5. projection 不會附帶未要求的 raw evidence 或敏感欄位。
6. 所有錯誤都有 `code`、`path`、`retryAction` 或明確的不可恢復原因。

## 8. 非目標

本規格不決定商家 identity 的匹配演算法，也不決定 recommendation 的排序
商業偏好；兩者分別由 MerchantIdentity 與 recommendation spec 定義。
