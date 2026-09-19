# Case6 推薦系統改善工作清單 (Task v4)

## Phase 1: 規格書與 Skill 文檔修復（徹底拔除頂層單一 `fx` 與誤導範例）
- [x] **Task 1.1**: 修改 `src/fx.ts` 的 `buildFxResolutionRequest`，自 `requiredFields` 移除 `contentHash`。
- [x] **Task 1.2**: 全面清理 `recommendation-tools-specification.md`：
  - 從 `recommend` 的標準輸入屬性與範例中徹底拔除頂層 `fx (object)`。
  - 補齊 `routeFacts` 作為特定路徑補充屬性。
  - 將 JPY 範例改為自然金額（50000 JPY 寫為 `50000`）。
- [x] **Task 1.3**: 全面清理 `payment-route-and-fx.md`：
  - 更新 Scoped Tools 表格，移除推薦頂層強制 `fx.{...}` 描述。
  - 更新標準 Payload 範例：初次探索推薦預設無 `fx`；重試特定跨境路徑使用 `routeFacts` 陣列。

## Phase 2: 外幣輸入自然化與 ISO 4217 次方換算
- [x] **Task 2.1**: 在 `src/types.ts` 定義標準貨幣次方字典 `CURRENCY_EXPONENTS`（JPY: 0, TWD: 2, USD: 2）與輔助函式。
- [x] **Task 2.2**: 重構 `src/evaluator.ts` 的 `convertMinor` 與 `src/service.ts` 的 `convertCost`，依據幣別次方進行差額縮放（factor = $10^{(\text{quote} - \text{base})}$），確保傳入 30000 JPY 自動精確折算為 645,000 TWD minor units（6,450.00 TWD）。
- [x] **Task 2.3**: 更新 `tests/fx-resolution-automation.test.ts` 單元測試，驗證 JPY 0 小數之自動縮放與轉換。

## Phase 3: 頂層 FX 解耦與相容性防護（`src/service.ts`）
- [x] **Task 3.1**: 重構 `src/service.ts` 中推薦階段的匯率綁定邏輯：
  - 若 `recommendIntent` 未傳入頂層 `fx`，推薦引擎自動為直刷卡與錢包套用對應的參考匯率。
  - 若呼叫端傳入頂層 `fx`，支援單一物件或陣列（`oneOf: [fx, array]`），且透過嚴格 scope（cardScheme, issuer, cardId, routeId, edgeId）精確配對，絕不讓單一 `rateType` 毒死其他結算路徑（如 `cash_selling` 毒死信用卡）。
- [x] **Task 3.2**: 確保針對特定路徑注入專屬匯率時，完全依循 `routeFacts: [{ routeId, edgeId, fx }]` 獨立處理，路徑間互不污染。

## Phase 4: `recommend` 自動展開多支付姿勢（免加參數）
- [x] **Task 4.1**: 重構 `src/service.ts` 的 `recommendIntent`，未指定 `paymentMethod` 時，自動從所有適用的優惠規則中收集 `match.paymentMethods` 候選姿態進行模擬試算。
- [x] **Task 4.2**: 針對具備 Apple Pay / 行動支付加碼之卡片，自動展開最優支付姿勢並列呈現（如吉鶴卡 Apple Pay 4.0% 升至前段排名，並在 candidate node 中標示 payment_method）。

## Phase 5: `recommend` 預設呈現完整支付路徑與實質匯差（免加參數）
- [x] **Task 5.1**: 在 `recommendIntent` 中，支援各卡片與跨境路徑之 `netSpend` 折抵試算，預設呈現完整路徑與條件。
- [x] **Task 5.2**: 支援 `supplementalFacts` typed retry 狀態補全（修復 validation 遺漏之 `transaction`、`routeFacts` 與頂層 `supplementalFacts` 轉發）。

## Phase 6: 驗證與文件同步
- [x] **Task 6.1**: 執行系統全量核心單元測試（61 test files, 291 tests 全部通過，TypeScript 編譯 0 錯誤）。
- [x] **Task 6.2**: 同步更新 `llm/` 英文規範與 `docs/` 繁體中文文檔。
