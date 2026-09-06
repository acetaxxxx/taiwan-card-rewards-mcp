# Agent FX 與商家 Canonical Fact Recovery Workflow 規格

**狀態**：Target normative specification，待獨立 Review
**版本**：0.1.0
**語言**：繁體中文

## 1. 目的

本規格定義 Agent 在呼叫 MCP 前如何收集可計算 facts，以及收到
Actionable Diagnostic 後如何補資料、詢問使用者與重試。Agent 不得以模型猜測、
過期筆記或靜默降級取代 MCP 的 fail-closed 結果。

## 2. 共通流程

```text
自然語言/帳單/圖片
  → 保留 raw statement
  → 擷取 transaction facts
  → 補齊 currency、occurredAt、market、channel
  → 查詢 FX 或解析 merchant identity
  → 呼叫 recommend/calculate_reward
  → 讀取 diagnostics
  → 補資料、詢問使用者或重新查詢
  → 確認後才進入 record_transaction
```

Agent 必須把 `planned` recommendation 與 `actual` ledger recording 分開。規劃
階段不消耗 cap、不寫入帳本。

`recommend` 可以自動執行一次 merchant pre-flight，因此 Agent 的一般路徑不必
先讀取完整商家名單。只有在 MCP 回傳多個候選、缺少市場 facts 或需要讓使用者
確認時，才單獨呼叫 `resolve_merchant` 取得 bounded candidates。

## 3. FX Recovery

Agent 執行跨幣別計算前，必須取得：

- 消費幣別與 rule settlement currency；
- rate type（例如 cash selling、card scheme 或 approved provider 定義）；
- rate、capturedAt、provider；
- 可取得時附上 sourceUrl 與 contentHash。

Agent 將 rate 轉為整數 `ratePpm`，再提交不可變 FX observation。MCP 不在
`calculate_reward` 或 `recommend` 內自行查網路、不猜 1:1、不使用未標示來源的
舊匯率。

| Diagnostic code | Agent 動作 |
|---|---|
| `fx_missing` | 依指定 currency pair 查 approved source，再重試 |
| `fx_stale` | 取得更新快照，不可只改 capturedAt |
| `fx_pair_mismatch` | 依 MCP 指出的 base/quote 重建 snapshot |
| `fx_scope_mismatch` | 確認 card/issuer scope，或改用適用的 unscoped snapshot |
| `fx_conflict` | 讓使用者或政策選定 authoritative provider，不自行平均 |
| `source_untrusted` | 補官方來源、confirmation 或交給 review |

## 4. Merchant Recovery

Agent 應先保存帳單上的原始 merchant label，例如 `唐吉`、`唐吉軻德` 或
`ドン・キホーテ`，不可先把它改寫成模型猜測的 canonical ID。

至少收集：

- 消費國家/市場；
- 實體店或線上 channel；
- 可取得時的 MCC、payment route/provider；
- 使用者是否確認該 merchant identity。

Agent 先用 LLM、既有知識或 approved web research 將暱稱、縮寫與跨語言名稱
轉成統一繁中 canonical ID/name candidate，再提交 MCP。MCP 只依 canonical ID 或
`canonicalNameZhHant` 做 deterministic validation，並回傳有界的 merchant
facts/active-offer records，不回傳整份商家目錄。

Agent 收到 `not_found`、`merchant_ambiguous` 或缺少 market facts 時，必須補充
查詢、詢問使用者或進行 approved research；MCP 不執行 alias、fuzzy、embedding、
翻譯或語意自動套用，任何 Agent 推論都必須先經 MCP 驗證才能進入 reward。

## 5. Diagnostics 與重試契約

每個非 `ok` 結果至少應包含：

```json
{
  "code": "merchant_ambiguous",
  "path": "transaction.merchant",
  "requiredFacts": ["transaction.country", "transaction.channel"],
  "retryAction": "ask_user_to_choose_merchant_candidate"
}
```

Agent 依 `retryAction` 執行，不得只看 legacy `status: unknown` 自行推測。若
同一 facts 在修正後仍衝突，停止自動重試並轉 `needs_review`。

## 6. 禁止行為

- 不以舊文字筆記覆蓋 `fx_stale` 或 `source_untrusted`。
- 不把缺少 merchant country 當成台灣或日本。
- 不把無專屬優惠誤報為商家不存在；應區分 `no_active_offer`。
- 不在 planned recommendation 階段寫 ledger。
- 不因 MCP 拒絕未知欄位就靜默放棄工具並自行猜答案。

## 7. 驗收條件

1. 缺 FX、過期 FX、錯 pair 都能導向不同且可執行的下一步。
2. 台灣/日本同名商家缺 market 時必須詢問使用者。
3. 使用者確認 canonical fact 後，Agent 可用同一 query 重試並得到可重現結果。
4. Agent 永遠保留 raw statement，canonical mapping 由 MCP 的版本化資料與
   provenance 支撐。
5. 最終 `record_transaction` 的 FX、merchant identity、rule version 與來源
   都可追溯。
