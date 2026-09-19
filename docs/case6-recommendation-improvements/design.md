# Case6 推薦系統架構改善設計書 (Design v3)

## 1. 架構原則重塑

消費前比價 (`recommend`) 回歸探索本質：
1. **輸入直覺**：日圓就是以日圓自然數額輸入（100 JPY 傳入 100），由底層根據 ISO 4217 進行次方換算，絕不讓外部 Agent 做乘法運算。
2. **多軌展開**：未指定支付方式時，自動評估卡片所屬之最佳支付姿勢（如 Apple Pay 4.0% vs 實體直刷 2.5%），不再降級為 `unknown`。
3. **路徑自適應匯率與頂層解耦**：頂層 `fx` 僅代表通用參考匯率，不強制帶有單一路徑排他性 `rateType`；卡片走即期匯率、跨境錢包走現鈔賣出價，由路徑自身屬性或 `routeFacts` 決定。
4. **全路徑探索**：跨境錢包等支付路徑在推薦中預設列出，標記條件並精確折算現鈔匯差，不需額外開關參數。

---

## 2. 模組設計

### 2.1 ISO 4217 貨幣次方字典與換算縮放
在 `src/types.ts` 定義標準貨幣次方：
```typescript
export const CURRENCY_EXPONENTS: Record<string, number> = {
  TWD: 2,
  USD: 2,
  EUR: 2,
  JPY: 0,
  KRW: 0,
};
```
在 `src/evaluator.ts` 重構 `convertMinor`：
```typescript
export function convertMinor(amount: Money, currency: string, tx: TransactionTuple): number | undefined {
  if (amount.currency === currency) return amount.amountMinor;
  if (tx.fx?.baseCurrency === amount.currency && tx.fx.quoteCurrency === currency) {
    const baseExp = CURRENCY_EXPONENTS[amount.currency.toUpperCase()] ?? 2;
    const quoteExp = CURRENCY_EXPONENTS[currency.toUpperCase()] ?? 2;
    const factor = 10 ** (quoteExp - baseExp);
    return Math.floor((amount.amountMinor * tx.fx.ratePpm * factor) / 1_000_000);
  }
  return undefined;
}
```
- 輸入 `30000 JPY` (baseExp = 0), ratePpm = 215,000, 結算幣別 `TWD` (quoteExp = 2)。
- 換算值：$30000 \times 215,000 \times 100 / 1,000,000 = 645,000\text{ minor units}$（即 6,450.00 TWD）。
- 徹底終結手動換算錯誤！

### 2.2 頂層單一 `fx` 的歷史成因與徹底解耦（回歸推薦預設無 `fx`）
1. **歷史成因**：
   - 最早系統僅支援信用卡海外直接刷卡，只有單一結算匯率，因此直接將記帳交易（`transaction.fx`）的單一匯率物件複製給推薦工具（`recommendIntent.fx`）。
   - 後期引入多層跨境錢包路徑時，底層擴充了 `routeFacts: [{ routeId, edgeId, fx }]`，但頂層 `fx` 未被拔除。更因 Skill 範例將錢包的 `rateType: "cash_selling"` 填入頂層全域物件，導致信用卡全數因卡組織規則衝突而被「毒死」。
2. **解耦與拔除**：
   - **Tools Specification 與 Skill 文件**：從 `recommend` 的標準輸入參數與範例中徹底拔除頂層 `fx (object)`！初次推薦呼叫預設為乾淨的 `{ merchant, amount, country, channel }`。
   - **推薦引擎自動估算**：系統預設自動針對直刷信用卡套用即期牌告、對跨境錢包套用合作銀行現鈔賣出牌告，無需呼叫端預先注入匯率。
   - **路徑專屬匯率走 `routeFacts`**：若重試或特定路徑需要補充專屬匯率，一律使用 `routeFacts: [{ routeId, edgeId, fx }]` 提供，路徑間互不干擾。
   - **服務層相容性保護**：若外部呼叫端歷史性地傳入了頂層 `fx`，僅作為通用匯率參考，絕不得以其 `rateType` 拒絕或排擠其他不同結算路徑之卡片。

### 2.3 支付方式自適應展開 (`recommendIntent`)
當 `input.paymentMethod` 未指定時：
1. 針對每張卡片，評估其所有有效規則（含無條件的基礎規則與指定行動支付的加碼規則）。
2. 在輸出候選人中，若該卡具備行動支付加碼（如 Apple Pay 4.0%）：
   - 自動將該卡片的最優姿勢並列呈現（例如呈現為最佳方案），並附註觸發條件（例如「需使用 Apple Pay 感應」）。
3. 絕不因為使用者沒提 Apple Pay 就將規則標記為 `unknown` 並降級回饋。

### 2.4 全路徑預設探索與實質匯差試算
在 `recommendIntent` 中：
1. 針對跨境電子錢包（如 PayPay 掃碼），若尚未收錄該特店的立牌證據，不阻斷拋出 `needs_review`，而是直接生成推薦候選，並附帶 `unverifiedConditions: ["店家支援 PayPay 掃碼"]`。
2. 系統自動以合作銀行現鈔賣出價折算淨支出 (`netSpend`)，扣除隱藏匯差（約 1.8%~2.0%），讓使用者與 Agent 呼叫一次 `recommend`，即可完整看清所有刷卡與錢包路徑之排序與實質淨效益。
