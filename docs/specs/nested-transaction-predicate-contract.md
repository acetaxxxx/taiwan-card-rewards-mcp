# 交易條件 Predicate 的受控巢狀欄位規格

## 目的

優惠條款常同時限制國別、交易幣別與付款路徑。例如「非台灣國別且非新台幣交易，排除 DCC」是通用的交易資格，而不是某張卡的特例。本規格定義 MCP 如何安全讀取這些條件，讓 validator、evaluator 與 agent 指引使用同一份公開契約。

## 公開欄位白名單

Predicate 只允許讀取下列交易欄位。欄位名稱必須以 `transaction.` 開頭；未知路徑一律 `INVALID_INPUT`，不得退回任意物件 traversal。

| 欄位 | 型別 | 用途 |
| --- | --- | --- |
| `transaction.country` | string | 交易發生國家或市場 |
| `transaction.amount.currency` | string | 交易金幣別 |
| `transaction.routeContext.dcc` | boolean | 是否由特店 DCC 轉換 |
| `transaction.funding.kind` | string | `credit_card`、`account` 或 `cash` |
| `transaction.route.kind` | string | `direct_card`、`wallet` 或 `merchant_app` |
| `transaction.paymentMethod` | string | 付款方式識別 |

欄位解析器應以明確的 switch 或路徑表實作，不能接受 `__proto__`、任意陣列索引、憑證欄位或未列入契約的內部欄位。validator 與 evaluator 應共用欄位表，避免「schema 接受但評估器讀不到」的漂移。

## 判斷語意

- 欄位存在且條件成立時，回傳 matched。
- 欄位存在且條件不成立時，回傳 no match；這不是錯誤。
- 欄位缺失、格式無法判斷或資料互相衝突時，回傳 unknown／needs review；不得把缺失當成 `false` 或自動套用優惠。
- `NOT` 對缺失值仍應保留 unknown，不能把「不知道是否為台灣」當成「確定不是台灣」。
- MCP 邊界的必要欄位（例如 `transaction.amount.currency`）仍由 transaction validator 驗證；評估器層保留缺失測試，以防內部呼叫或未來 schema 放寬時誤算。

## 通用規則範例

以下條件表達「非台灣且非新台幣，並排除 DCC」：

```json
{
  "op": "AND",
  "rules": [
    { "op": "NOT", "rule": {
      "field": "transaction.country",
      "op": "EQUALS",
      "value": "TW"
    }},
    { "op": "NOT", "rule": {
      "field": "transaction.amount.currency",
      "op": "EQUALS",
      "value": "TWD"
    }},
    { "op": "NOT", "rule": {
      "field": "transaction.routeContext.dcc",
      "op": "EQUALS",
      "value": true
    }}
  ]
}
```

此模型也能表達其他跨卡、跨支付服務的條件；新增條款只需組合既有欄位與運算子，不需要新增品牌 enum 或特例程式碼。

## 驗收矩陣

至少應涵蓋：

1. 海外外幣、非 DCC：所有條件成立，規則可計算。
2. 海外但 DCC 後為 TWD：幣別或 DCC 條件不成立，規則不匹配。
3. 台灣境內外幣：國別條件不成立，規則不匹配。
4. 缺少國別：結果為 unknown／required action，不得啟用或寫入正式優惠。
5. 缺少幣別：public validator 拒絕不完整 transaction；純 evaluator 測試確認回傳 unknown。
6. `AND`、`OR`、`NOT` 的組合，以及既有第一層 `match.countries` 規則的回歸測試。

測試應同時覆蓋 `calculate_reward`、`recommend` 與 actual `record_transaction`。planned 階段可以展示 partial／required action；actual 寫入遇到 unknown 必須 fail-closed。

## 相容與遷移

既有正向 `match.countries`、`match.channels` 與 `match.paymentMethods` 保持不變。predicate 是補充能力，規則可逐步從第一層清單遷移；在所有執行器完成巢狀欄位支援前，不應宣稱海外外幣條款已完整覆蓋。文件與 agent playbook 應明確要求使用完整 `transaction.` 前綴，並在資料不足時詢問使用者或交付待補事實。
