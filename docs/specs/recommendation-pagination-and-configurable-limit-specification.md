# Recommendation 可配置筆數與 Page 分頁規格

**狀態**：Target normative specification，待獨立 Review
**版本**：0.1.0
**語言**：繁體中文

## 1. 目的

`recommend` 不再把 Top-5 視為計算引擎的硬上限。MCP 預設回傳 10 筆，讓
Agent 從中選出適合向使用者呈現的 5 筆；每次回應仍受 deployment policy
限制，必要時使用簡單的 page 分頁。

## 2. 輸入契約

```typescript
interface RecommendationInput {
  transaction: {
    kind: "purchase";
    mode: "planned";
    amount: { amountMinor: number; currency: string };
    cardId?: string;
    merchant?: string | { canonicalId?: string; raw?: string; market?: string; country?: string };
    country?: string;
    channel?: "in_store" | "online";
    mcc?: string;
    paymentMethod?: string;
    route?: PaymentRoute;
    fx?: FxSnapshot;
  };
  limit?: number;
  page?: number;
  includeCandidates?: boolean;
}
```

- `limit` 預設為 `10`。
- `limit` 必須是正整數，最大值由 deployment policy 宣告，例如 `20` 或 `50`。
- 超過最大值回 `invalid_input`，不得靜默截斷。
- `cardId` 在詢問「該用哪張卡」的 planned recommendation 可省略；實際
  `record_transaction` 仍必須指定 card。
- `page` 從 `1` 開始；省略時使用第 1 頁。

## 3. 回應契約

```typescript
interface RecommendationPage {
  status: "ok" | "partial" | "needs_facts" | "no_match" | "needs_review";
  items: readonly RankingEntry[];
  pageInfo: {
    page: number;
    limit: number;
    hasMore: boolean;
    totalPages?: number;
    total?: number;
  };
  diagnostics?: readonly ActionableDiagnostic[];
}
```

`total` 可以因成本或 privacy policy 省略；Agent 不得假設省略就是零筆。

## 4. 穩定排序

相同 query、資料版本與 evaluation time 必須得到相同排序。排序至少包含：

1. 可安全比較的 `ok` 結果優先於不確定結果。
2. capped reward 或明確可比較的 estimated reward 降冪。
3. effective rate 降冪。
4. `cardId` 升冪作為最終 tie-breaker。

異質點數、里程或幣別在沒有可信 valuation snapshot 時不得強制合併；這些
結果必須以獨立 native breakdown 呈現，並可帶 `needs_review`。

## 5. Page 與資料版本

目前資料規模與更新頻率不需要 cursor。MCP 依穩定排序與 `page`/`limit` 執行
offset 查詢，回應附帶 `evaluatedAt` 與 `dataVersion`。Agent 若需要下一頁，
只需以相同 query、evaluation context 與排序要求下一個 page。

跨頁期間若 dataVersion 改變，MCP 必須在回應中標示新版本；Agent 可重新從
page 1 取得一致視圖。這個設計刻意接受低頻資料變動下 offset pagination 的
簡單性，不引入 cursor 的維護成本。

## 6. 有效優惠與商家解析

recommend 只評估 `ActiveOfferIndex` 中 active、source-trusted、時間有效且
條件可評估的規則。candidate、過期或未驗證規則只能在
`includeCandidates=true` 時以候選標記出現，不得影響排序或金額。

- 商家解析為 ambiguous 或 unresolved 時，專屬商家規則回
  `merchant_ambiguous` / `missing_required_fact`。
- 不依賴商家 identity 的有效 Base Rule 仍可計算。
- 已解析商家但沒有適用專屬優惠回 `no_active_offer`，不代表商家不存在。
- fuzzy、embedding、翻譯與未驗證社群資料不得自動套用。

## 7. 驗收條件

1. `recommend()` 預設回十筆，Agent 可從中選出五筆呈現，也可要求其他合法
   `limit`。
2. 每頁不超過 deployment cap，且不會無界回傳。
3. 同一 query、page 與 dataVersion 的頁面順序穩定。
4. Agent 可要求 page 2、page 3，不需要保存或管理 cursor。
5. candidate 或 fuzzy 候選不會污染正式 reward 或 ledger。
6. planned recommendation 不消耗 cap、不寫入 transaction ledger。
