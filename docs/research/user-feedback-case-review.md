# 使用者真實回饋案例研究與架構審查報告 (User Feedback Case Review)

> **研究依據**：依據 `research` 技能規範，本研究以 `userFeedback/` 全部 4 份案例為出發點，嚴格對照儲存庫第一手權威資料：[`CONTEXT.md`](../../CONTEXT.md)、[`docs/adr/`](../adr/) 系列架構決策、[`docs/usage/ai-agent-usage-guide.md`](../usage/ai-agent-usage-guide.md)、[`docs/taiwan-card-rewards-skill/`](../taiwan-card-rewards-skill/) 規範，以及核心原始碼與測試（[`src/mcp-contract.ts`](../../src/mcp-contract.ts)、[`src/service.ts`](../../src/service.ts)、[`src/cli.ts`](../../src/cli.ts)、[`tests/agent-workflow-public-trace.test.ts`](../../tests/agent-workflow-public-trace.test.ts)）。
> **最新產品方針與修訂重點**：
> 1. **使用者確認規則啟用 (User-Confirmed Offers)**：使用者確認（User Confirmation）可直接啟用私有之 `user_confirmed` 規則版本；官方條款查證（Official Evidence）轉為可選之非阻塞旁路。推薦與試算輸出明確標示 `trust_basis`（`official_evidence` vs `user_confirmed`），並嚴守不可變版本、撤銷更正機制與租戶隔離（Tenant Isolation）。
> 2. **外幣匯率相容鍵跨卡重用 (Reusable FX via Compatible Keys)**：FX 匯率以 `(baseCurrency, quoteCurrency, conversionOwner, conversionTiming, rateType, provider/scheme, freshnessWindow)` 之相容鍵（Compatible Key Tuple）跨卡與跨候選路徑安全重用（例如同屬 JCB 之多張卡片共享同一新鮮快照，免除每卡重查負擔）；精確作用域（route/card）優先於寬鬆 scheme，且嚴格禁止跨 conversionOwner 混用。
> 3. **直接交易紀錄與查詢 (Transaction History)**：沿用單一 `Transaction` 模型；`record_transaction` 接受卡片、帳戶、錢包與現金，`list_transactions` 依時間區間分頁查詢。回饋、上限與路徑資訊是交易的關聯結果，不另建一套 Payment Journal 服務。
> 4. **低推理模型引導 (3-Tier Playbook)**：採 `< 1500` token 的三層架構（意圖映射、決策表/動作合約、精簡 Payload 範例）與二階段更正確認，確保輕量模型低延遲且精確遵循。

---

## 壹、逐 Case 深度摘要與故障根因還原

### 案例一：行銷上限語義污染、口頭承認未回寫與上下文壓縮盲信 (Case 1)

* **情境與故障現象**：  
  在海外消費推薦試算中，AI 助手多次將台新 Richart 卡「玩旅刷」權益錯誤回報為 **3.8%**（實際官方合約應為 **3.3%**）。使用者於 Day 1 提出糾正，助手於聊天室窗口頭承認錯誤並回覆為 3.3%；然而到了 Day 2 使用者詢問唐吉訶德刷卡推薦時，該 3.8% 錯誤全面復發，造成跨日決策失誤風險（引自 [`userFeedback/Case1.md#L10-L12`](../../userFeedback/Case1.md#L10-L12) 與流程圖 [`userFeedback/Case1.md#L18-L45`](../../userFeedback/Case1.md#L18-L45)）。
* **深層故障機制**：
  1. **行銷宣傳上限語義污染 (Semantic Pollution in Seed Data)**：  
     初始建構 MCP 種子資料時，爬蟲或建檔人員將官方主宣傳標題「最高 3.8%」的宣傳上限（Upper Bound），未經細則條款過濾，直接繼承為子方案「玩旅刷」的固定費率（`rateBps: 380`）（引自 [`userFeedback/Case1.md#L51-L55`](../../userFeedback/Case1.md#L51-L55)）。
  2. **口頭承認與持久狀態分裂 (No Write-Back Mutation)**：  
     LLM 在自然語言對話中承諾「是 3.3%」，但未觸發任何資料層寫入，且系統缺乏受治理的更正回寫機制，口頭承諾未進入持久化帳本（引自 [`userFeedback/Case1.md#L58-L65`](../../userFeedback/Case1.md#L58-L65)）。
  3. **上下文壓縮導致記憶洗除與工具盲信 (Compaction Blindness)**：  
     對話歷史達到 token 閾值觸發壓縮（Compaction），Day 1 的細微爭論被濃縮遺忘；Day 2 Agent 重新調用 MCP 工具時，看到 MCP 回傳包含 `rateBps: 380` 的結構化 JSON，Agent 視工具回傳為權威真相（Ground Truth），堅信 3.8% 並藉由 LLM 推論能力展開自圓其說（Confirmation Bias）（引自 [`userFeedback/Case1.md#L67-L81`](../../userFeedback/Case1.md#L67-L81)）。
* **第一手規範與治理生命週期對照**：
  - [`CONTEXT.md#L30-L35`](../../CONTEXT.md#L30-L35) 與 [`CONTEXT.md#L48-L56`](../../CONTEXT.md#L48-L56) 明訂：**Offer Evidence** 必須源自可追溯官方條款，不能將行銷宣傳視為有效合約；未經確認之輸入僅為 candidate，必須由使用者透過 **Offer Confirmation** 激活。
  - [`docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L8-L14`](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L8-L14) 與 [`docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L18-L20`](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L18-L20) 確立：計算權威與帳本狀態屬於 MCP，規則具備版本不可變性（Immutable Rule Version）。
  - **架構決策（使用者確認直接啟用私有版本，官方佐證非阻塞）**：  
    對話中的口頭答應（Verbal Concession）不能視為資料持久化；然而，若強制要求 Agent 必須連網爬取官方條款（Official Evidence）成功後才允許寫入，在使用者明確糾錯的場景下會導致嚴重的死鎖與體驗阻滯。  
    因此，系統確立受治理的生命週期：
    $$\text{對話糾正} \longrightarrow \text{二階段確認提案 (Proposal)} \overset{\text{使用者確認}}{\longrightarrow} \text{啟用私有 } \texttt{user\_confirmed} \text{ 新版本 (不可變、租戶隔離)}$$
    官方佐證檢索轉為**可選的非阻塞背景提升管道**（可事後將版本提升為 `official_evidence`），絕不阻塞當前使用者確認版本的生效與試算。

---

## 案例二：資料模型過度窄化與思維捷徑導致錯誤推薦 (Case 2)

* **情境與故障現象**：  
  使用者抵達大阪初期，刷卡場景均為實體門市，Agent 建檔時將台新「玩旅刷」過度窄化為 `channels: ["in_store"]`。後續使用者詢問「中華航空機票劃位費用 NT$2,580 怎麼刷」（台灣線上交易）時，Agent 未連網覆核官方條款，依據本地窄化標籤斷定玩旅刷為一般消費（0.3%），錯誤推薦國泰世華 CUBE 卡（3.0%）；直到使用者質疑後連網爬取最新細則，才確認玩旅刷明確包含中華航空（含線上購票），實質享有 3.3%（引自 [`userFeedback/Case2.md#L9-L33`](../../userFeedback/Case2.md#L9-L33)）。
* **深層故障機制**：
  1. **資料建模偏誤（Data Modeling Bias）**：  
     初始建檔時僅依據旅程當下情境（海外實體），未完整轉譯台新官網條款中包含「航空、海外交通、訂房平台、旅行社」等多通路屬性（引自 [`userFeedback/Case2.md#L9-L19`](../../userFeedback/Case2.md#L9-L19)）。
  2. **思維定勢與缺乏即時官網覆核（Mental Shortcut）**：  
     Agent 面對跨界通路（華航為線上交易但屬於航空公司），未呼叫外部檢索工具或向 MCP 請求診斷，直接依賴本地過度窄化的靜態規則武斷推論，造成推薦失真（引自 [`userFeedback/Case2.md#L21-L26`](../../userFeedback/Case2.md#L21-L26)）。
* **第一手規範與架構對照**：
  - [`CONTEXT.md#L58-L63`](../../CONTEXT.md#L58-L63) 與 [`CONTEXT.md#L90-L94`](../../CONTEXT.md#L90-L94) 定義了 **Predicate AST** 與 **Exclusion**：條件比對是宣告式的精確樹狀結構，若未包含相應的商戶/通路分支，引擎將判定為不符合。
  - [`src/mcp-contract.ts#L10`](../../src/mcp-contract.ts#L10) 與 [`src/mcp-contract.ts#L81`](../../src/mcp-contract.ts#L81) 提供了商戶識別工具 [`resolve_merchant`](../../src/mcp-contract.ts#L81)，並在 [`upsert_offer`](../../src/mcp-contract.ts#L67) 支援原子建立候選商戶（如 `mch_china_airlines`），以避免商戶名稱歧義與通路脫鉤。
  - 當規則覆蓋不足時，單純依賴本地快取會破壞推薦品質，Agent 應依據 [`research-and-evidence-submission.md`](../taiwan-card-rewards-skill/card-rewards-evidence/workflows/research-and-evidence-submission.md) 流程保持對外部官方條款的主動檢索。

---

## 案例三：歷史明細查詢 API 缺失與單一卡片限制 (Case 3)

* **情境與故障現象**：  
  全旅程共 29 筆消費（NT$24,021），對帳時發現遺漏了「深夜居酒屋新世界串カツ小鉄（台新Pay+ 帳戶直扣）」與「早餐日圓現金消費」。原因為 MCP 僅有寫入與上限查詢工具，缺少交易明細查詢工具；且 `record_transaction` 強制要求 `cardId`，導致電支帳戶直扣與現金消費直接被拋錯拒收（引自 [`userFeedback/case3.md#L6-L24`](../../userFeedback/case3.md#L6-L24)）。
* **深層故障機制**：
  1. **缺乏交易明細查詢工具（No `list_transactions` API）**：  
     MCP 提供 [`record_transaction`](../../src/mcp-contract.ts#L75) 與 [`remaining_caps`](../../src/mcp-contract.ts#L78)，但未提供讀取歷史交易清單的 API，導致 Agent 對帳時必須手動穿透至底層 raw JSON，破壞抽象邊界（引自 [`userFeedback/case3.md#L6-L14`](../../userFeedback/case3.md#L6-L14)）。
  2. **單一卡片帳本假設（Card-Centric Schema Lock-in）**：  
     傳統交易合約將 `cardId` 設為強制欄位，忽略現代支付情境已廣泛涵蓋「銀行存款帳戶（`linked_bank_account`）」、「電支餘額（`wallet_balance`）」及「現金（`cash`）」（引自 [`userFeedback/case3.md#L17-L24`](../../userFeedback/case3.md#L17-L24)）。
* **產品決策：沿用 Transaction，不新增帳本服務**：  
  Case 3 所需能力很直接：實際支出都寫成 `Transaction`，再用 `list_transactions({ from, to, page, limit })` 查詢。`Transaction.funding` 應支援 `credit_card | account | wallet_balance | cash`；回饋結果、上限扣減、FX 與路徑可作為交易的關聯資料或查詢投影。無回饋的現金或帳戶支出也可以記錄，因為「是否值得回溯」不應由回饋資格決定。系統仍不必加入預算、分類帳、帳戶餘額或資產管理功能。

  這項設計只需要兩個公開動作：

  1. `record_transaction`：寫入一筆實際交易或退款，使用 `funding` 區分資金來源；有回饋時再附加計算結果。
  2. `list_transactions`：依 `from`、`to`、`page`、`limit` 查詢目前使用者的交易；預設摘要、需要時才展開回饋與稽核欄位。

* **第一手規範與架構對照**：
  - [`src/mcp-contract.ts#L44`](../../src/mcp-contract.ts#L44) 舊版 `transaction` 確有強制 `cardId`。
  - [`docs/adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L18-L20`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L18-L20) 與 [`docs/adr/0008-event-scoped-reward-evaluation-and-cross-event-eligibility.md#L15-L16`](../adr/0008-event-scoped-reward-evaluation-and-cross-event-eligibility.md#L15-L16) 已指出 `cardId` 限制；現行 `record_event_reward` 能寫部分非卡事件，但它不是一般交易 API，不應成為記帳入口。
  - 查詢仍須租戶隔離並分頁，但這是 `list_transactions` 的輸入與輸出約束，不需要新的 Payment Journal domain 或服務。

---

## 案例四：清算軌道本質差異、匯差滑價與相容鍵重用 (Case 4)

* **情境與故障現象**：  
  在大阪行程中，使用電支掃碼支付時，Agent 誤將國際卡組織的「批發即期中價（0.205323）」當作全域通用匯率套用；然而跨境電支清算實際採用合作銀行的「現鈔賣出牌告價（0.2093）」，實質匯差成本高出約 +2%（匯差滑價 FX Spread Drag）。導致電支聯名卡 3.5% 扣除 1.5% 手續費與 2% 匯差後實質回饋為負（-0.3%），反不如直接逼卡；且導致估算支出（$1,728 / $1,625）與銀行實際請款（$1,762 / $1,663）產生脫節（引自 [`userFeedback/Case4.md#L9-L35`](../../userFeedback/Case4.md#L9-L35)）。
* **深層故障機制（通用能力維度剖析）**：
  1. **支付節點與轉折語義混淆 (Route Nodes & Transitions)**：  
     未將「掃碼受理網路（Acceptance Network）」、「電支服務中介（Payment Service）」與「終端扣款工具（Funding Source）」明確分離。誤將電支掃碼當成一般信用卡直刷，忽略了 `wallet_top_up` 或 `account_debit` 的清算轉折本質（引自 [`userFeedback/Case4.md#L19-L29`](../../userFeedback/Case4.md#L19-L29)）。
  2. **清算上下文與換匯主體錯誤 (Clearing Context & Conversion Owner)**：  
     不同清算軌道具備不同 `conversionOwner`（卡組織 vs 商業銀行結匯）與 `conversionTiming`（交易即時結匯 vs 入帳清算結匯）。誤用卡組織匯率套用至銀行現鈔結匯通道（引自 [`userFeedback/Case4.md#L45-L55`](../../userFeedback/Case4.md#L45-L55)）。
  3. **報價生命週期與相容鍵重用機制缺失 (Quote Lifecycle & Missing FX Reuse Key)**：  
     電支 App 提供 24 小時固定鎖定報價（Quote Locked Window），卡組織則為入帳日浮動匯率。系統早期既未表達報價有效窗口（`maxAgeSeconds`、`quoteLockedUntil`），亦未建立**相容鍵（Compatible FX Keys）重用機制**，導致 Agent 若非盲目全域混用，就是極端地要求每張卡全部重複查價（引自 [`userFeedback/Case4.md#L47-L52`](../../userFeedback/Case4.md#L47-L52)）。
  4. **證據作用域邊界模糊 (Evidence Scope Asymmetry)**：  
     Skill 參考手冊存在「單邊傾斜」：詳述卡組織牌價爬取 SOP，但完全缺乏電支/現鈔結匯查價指引，導致 Agent 跨作用域（Evidence Scope）挪用不適用的匯率數據（引自 [`userFeedback/Case4.md#L88-L130`](../../userFeedback/Case4.md#L88-L130)）。
* **第一手規範與架構對照**：
  - [`CONTEXT.md#L160-L180`](../../CONTEXT.md#L160-L180) 定義了三種幣別拆解（Transaction, Settlement, Billing Currency）與換匯主導者（`conversionOwner`）。
  - [`docs/adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L11-L16`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L11-L16) 與 [`docs/adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L58-L62`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L58-L62) 規範：清算軌道、換匯方、時點、手續費、加價與匯率來源必須綁定於具體 Route Edge 上。
  - **架構澄清（相容鍵重用 vs 跨軌道隔離）**：  
    系統**嚴格禁止跨 conversionOwner / rateType 混用**（如卡組織即期中價不得套用於電支銀行現鈔結匯）；然而，**對於相同相容鍵的卡片與候選路徑，系統支援並鼓勵安全重用**（例如使用者持有 3 張 JCB 信用卡，只要幣別為 JPY->TWD、換匯方為 card_scheme、牌價類型為 spot_selling 且在有效新鮮窗口內，應共享同一筆 JCB 牌價快照，絕不要求每張卡重複檢索）。精確作用域（route/card）優先於寬鬆 scheme，確保試算兼具效能與絕對精確度。

---

## 貳、跨案例共通問題與深層架構缺陷

綜合分析上述 4 個案例，可歸納出 5 項跨案例反覆發生的深層系統性缺陷：

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    跨案例 5 大深層系統缺陷映射矩陣                      │
├─────────────────────────┬─────────┬─────────┬─────────┬─────────────────┤
│ 系統性缺陷              │ Case 1  │ Case 2  │ Case 3  │ Case 4          │
├─────────────────────────┼─────────┼─────────┼─────────┼─────────────────┤
│ 1. 行銷語義污染 (標題當細則) │   ●     │   ●     │         │                 │
│ 2. 口頭承認脫鉤與壓縮盲信   │   ●     │         │         │                 │
│ 3. 屬性建模過度窄化與偷步   │         │   ●     │         │   ●             │
│ 4. 單一卡片假設與記帳工具缺失 │         │         │   ●     │   ●             │
│ 5. 文檔/指引非對稱與匯率粗糙 │         │         │         │   ●             │
└─────────────────────────┴─────────┴─────────┴─────────┴─────────────────┘
```

1. **行銷宣傳與精確合約的語義污染 (Semantic Pollution)**：  
   將「全卡最高 3.8%」套給特定方案（Case 1），或將「海外實體」大標題設為唯一通道（Case 2），違反 [`CONTEXT.md#L30-L35`](../../CONTEXT.md#L30-L35) 之「Offer Evidence 必須為官方細則」原則。
2. **「自然語言承諾 vs 狀態持久化」脫鉤與 Compaction 盲信**：  
   對話中口頭答應修正，但底層未走受治理的變更流程，Context 壓縮後重新盲信錯誤工具數據（Case 1），違反 [`docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L8-L14`](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md#L8-L14)。
3. **資料建模過度窄化與思維捷徑 (Narrow Modeling & Mental Shortcuts)**：  
   實體通路偏誤造成線上航司漏失（Case 2）；全域單一匯率忽略清算軌道本質差異（Case 4）。
4. **單一卡片帳本與異質現實的結構性衝突 (Card-Centric vs Heterogeneous Reality)**：  
   強制 `cardId` 阻擋帳戶直扣與現金記帳，且缺乏只讀對帳查詢 API（Case 3）；將信用卡清算模型生搬硬套至跨境電支（Case 4），偏離 [`docs/adr/0007`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md) / [`docs/adr/0008`](../adr/0008-event-scoped-reward-evaluation-and-cross-event-eligibility.md) 定義之中立拓撲。
5. **Skill 與參考手冊的非對稱傾斜 (Asymmetrical Guidance & FX Granularity Gap)**：  
   詳細定義卡組織爬蟲卻完全空白電支/現鈔查價指引，且缺乏相容鍵跨卡重用機制，導致 Agent 若非跨作用域借用就是重複查價（Case 4）。

---

## 參、通用化設計原則 (Generalized Design Principles)

為杜絕上述架構缺陷，系統確立以下 5 大通用設計原則：

### 原則一：使用者確認直接啟用私有版本，官方佐證可選，明確標示 Trust Basis (User-Confirmed Direct Activation with Optional Official Evidence)
* **規範**：口頭答應不等於持久化；對話中的糾正經使用者確認後，**直接啟用私有之 `user_confirmed` 規則版本**。官方條款查證（Official Evidence）轉為可選之非阻塞旁路，計算與推薦輸出清楚標示 `trust_basis`，嚴守不可變版本、撤銷更正與租戶隔離（Tenant Isolation）。
* **機制**：
  1. **二階段確認提案 (Two-Phase Confirmation Proposal)**：使用者於對話中糾正費率時，Agent 結構化提取欲變更之條件（卡片、方案、通路、費率），向使用者發出確認摘要；經使用者明確回覆同意後，呼叫 [`upsert_offer`](../../src/mcp-contract.ts#L67)。
  2. **直接啟用私有不可變新版本 (Direct Activation of Private RuleVersion)**：寫入新版本（如 `version: "2"`），設定 `status: "active"`、`trust_basis: "user_confirmed"`。新版本僅對該使用者的私有 Tenant 生效，絕不污染全域共用規則庫。舊版本標記為 `superseded`，保留歷史審計追溯（落實 [`CONTEXT.md#L64-L74`](../../CONTEXT.md#L64-L74)）。
  3. **計算與推薦透明標記 (Calculation Trust Gate & Trust Basis)**：引擎在回傳候選與推薦明細時，輸出明確的 `trust_basis: "user_confirmed" | "official_evidence"`，讓使用者與前端清楚知悉數值來源。
  4. **官方佐證非阻塞 (Optional Official Evidence)**：官方條款檢索不再作為寫入或計算的阻絕條件（Blocking Gate），可由 Agent 在背景非同步驗證，或於事後將 `trust_basis` 升級為 `official_evidence`。使用者若發現手動更正有誤，亦可隨時透過相同合約撤銷或發布新版本更正。

### 原則二：行銷標題嚴格降級為 Candidate (Fail-Closed Marketing Degradation)
* **規範**：未獲完整條款（T&C）細則佐證的行銷宣傳，一律降級為 candidate。
* **機制**：依據 [`CONTEXT.md#L70-L74`](../../CONTEXT.md#L70-L74)，未經條款確認的規則維持 `status: "candidate"`，在通過使用者明確確認前觸發 [`Calculation Trust Gate`](../../CONTEXT.md#L110)，標註為 `needs_review`，絕不參與 confident 排序。

### 原則三：能力導向路徑拓撲與清算上下文 (Capability-Driven Topology & Clearing Context)
* **規範**：以通用抽象取代特定品牌/App 列舉，全面以節點、轉折、清算上下文與報價作用域定義路徑。
* **機制**：
  - **Route Nodes & Transitions**：依據 [`docs/adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L11-L20`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md#L11-L20)，定義 `funding_source`、`payment_service`、`acceptance_network` 節點，以及 `wallet_top_up`、`account_debit`、`card_authorization` 等轉折。
  - **Clearing Context**：明確宣告 `conversionOwner`（`merchant | wallet | payment_provider | bank | card_network`）與 `conversionTiming`（`transaction | clearing | settlement`）。
  - **Evidence Scope**：匯率快照依邊界（Edge）、路徑（Route）或發卡行（Issuer）隔離，禁止跨清算軌道混用。
  - **細則中的指定支付清單必須入模**：若條款寫「限指定行動支付」，Agent 必須讀取細則列出的完整清單，將每一個支付服務或受理網路寫入 selector 的 allowlist；例如 `paymentService in ["line_pay", "jko_pay", "taishin_pay_plus"]`。這些是可更新的資料值，不是把品牌寫成核心 enum，也不是讓 Agent 靠名稱猜測。
  - **Offer-Driven Route Generation**：帶有上述 allowlist、資金種類與必要轉折的 `Payment Route Selector`，就是推薦引擎產生候選路徑的約束。引擎把它與使用者已持有的卡片或帳戶組合，建立只存在於當次試算的 Generated Route；不要求先為每張卡 × 每個錢包 × 每個商家寫入一筆完整路徑。
  - **何時持久化完整路徑**：只有使用者專屬綁定、實際交易觀察、專屬匯率/費用或已知失敗狀態需要跨次保留時，才寫入具穩定 ID 的 `Payment Route Record`。一般優惠推薦使用 selector 生成即可。

目前實作只會從獨立的 `PaymentCapabilityRecord` 生成路徑，再把優惠規則套上去；`OfferRuleVersion` 仍只有精確 `routeId`，沒有可重用 selector 欄位。因此它尚不能從「限指定行動支付」的條款清單生成候選，這正是目前能力不足之處。建議讓 Offer ingestion 同時寫入或引用可重用的 Route Selector／Capability，避免同一份付款事實要求 Agent 重複登記。

### 原則四：相容鍵匯率重用、作用域優先與實質淨收益試算 (Compatible Key FX Reuse, Scope Precedence & Net Spend Projection)
* **規範**：以相容鍵安全重用匯率快照，精確作用域優先，嚴禁跨清算主體混用，並於推薦引擎計入實質淨收益。
* **機制**：
  - **相容鍵重用 (Compatible Key Tuple)**：匯率快照由以下 Tuple 決定唯一相容性：
    $$\text{FX Key} = (\text{baseCurrency}, \text{quoteCurrency}, \text{conversionOwner}, \text{conversionTiming}, \text{rateType}, \text{provider/scheme}, \text{freshnessWindow})$$
    - 當多張候選卡片或多條推薦路徑匹配相同相容鍵（例如 3 張 JCB 信用卡同屬 JPY->TWD、`card_scheme`、`spot_selling`、JCB 牌價），**直接共享同一份新鮮快照，嚴禁每張卡重複對外查價**。
  - **作用域優先權 (Scope Precedence)**：查詢與重用依 `route/card scope`（精確自訂牌價）優先於 `scheme/global scope`（通用組織牌價），保證特殊協議卡片的匯率不被覆蓋。
  - **嚴格跨清算主體隔離 (Cross-Owner Isolation)**：商業銀行現鈔賣出（`bank / cash_selling`）與卡組織即期中價（`card_network / spot_selling`）為不相容鍵，絕對禁止跨軌道借用。
  - **實質淨收益試算 (Net Spend Projection with FX Spread Drag)**：在 [`src/service.ts`](../../src/service.ts) 之 `recommendIntent` 排序中，計入匯差滑價：
    $$\text{淨收益} = \text{名目回饋} - \text{海外手續費} - (\text{電支現鈔牌價} - \text{基準即期匯率}) \times \text{外幣金額}$$

### 原則五：漸進式揭露與明確安全邊界 (Progressive Disclosure with Surgical Fail-Closed Boundaries)
* **規範**：Agent 探索與使用者溝通採「漸進式揭露（Progressive Disclosure）」，安全防線則於核心邊界「精準 Fail-Closed」。
* **機制**：
  - **安全探索與漸進展示（Progressive Disclosure）**：
    - 推薦初期允許回傳並展示可用候選、部分匹配（partial candidates）、近鄰匹配（near-match）與結構化待辦（`requiredActions`）。
    - 缺匯率或舊匯率時，允許展示帶有 `reference_estimate` / `stale_estimate` 標註的初估結果，並明確告知使用者「此為參考試算，正在為您更新最新匯率」，不因單一路徑未決而中斷整體推薦。
  - **精準 Fail-Closed 防線（Surgical Fail-Closed）**：
    1. **直接影響金額試算的未知事實**：缺匯率、缺手續費、缺關鍵門檻時，金額運算嚴格判定為 `unknown` 或非 confident，絕不預設為 0 或 1:1。
    2. **正式規則啟用 (Rule Activation)**：未經官方條款佐證或使用者明確確認的候選規則，絕不自動通過 Calculation Trust Gate。
    3. **實際交易入帳 (Actual Transaction Mutation)**：調用 [`record_transaction`](../../src/mcp-contract.ts#L75) 時，必須具備穩定 idempotencyKey、金額、時間與資金來源。回饋是否可計算不影響交易本身能否被記錄；不確定的回饋保持未評估即可。

---

## 肆、Agent 易用性與安全邊界權衡 (Usability vs Safety Boundaries)

在提升使用者體驗的同時，必須確保核心安全與隱私防線不被放寬：

| 維度 | Agent 易用性：漸進式揭露 (Progressive Disclosure) | 堅守之精準安全邊界 (Surgical Fail-Closed) | 依據來源 |
|---|---|---|---|
| **推薦入口** | 單一入口 [`recommend`](../../src/mcp-contract.ts#L68) 直達，無需前置 `list_cards`；支援展示初估與候選排序 | planned 推薦純只讀，**絕對不扣減上限池**、不寫入持久帳本 | [`docs/usage/ai-agent-usage-guide.md`](../usage/ai-agent-usage-guide.md) |
| **支付路徑** | 優惠的 Route Selector／Capability 與使用者持有的卡或帳戶在推薦時直接生成候選；無需預先登記每個具體組合 | 只有使用者專屬或實際觀察狀態才持久化；嚴禁傳輸或儲存 PAN、CVV、OTP、密碼或 Token | [`docs/adr/0009`](../adr/0009-public-payment-capability-route-generation.md) |
| **缺項處置** | 回傳 `requiredActions` 明示補件入口與責任方，允許展示帶標記之參考初估 | 金額計算嚴守 **Fail-Closed**：未知匯率/費率不腦補為 0 或 1:1，金額標記非確知 | [`src/service.ts#L875-L887`](../../src/service.ts#L875-L887) |
| **外部查網** | Agent 主動檢索公開匯率與官網條款，減輕使用者填寫負擔 | **Zero-Network MCP**：MCP 本體保持零外網、零開放埠，外網完全由 Agent 工作區負責 | [`docs/usage/ai-agent-usage-guide.md`](../usage/ai-agent-usage-guide.md) |
| **規則更正** | 對話中經二階段確認後，直接啟用私有 `user_confirmed` 新版本；官方佐證可選 | 租戶完全隔離、版本不可變；計算與推薦輸出必須明確標明 `trust_basis` | [`CONTEXT.md#L48-L56`](../../CONTEXT.md#L48-L56) |
| **匯率查詢** | 相容鍵跨卡/候選安全重用（如多張 JCB 卡共用同一快照），免除重複查價 | 作用域精確優先（route > scheme）；嚴禁跨 conversionOwner 混用；過期強制更新 | [`docs/adr/0007`](../adr/0007-provider-neutral-payment-route-facts-and-evidence.md) |
| **歷史對帳** | `list_transactions(from, to, page, limit)` 直接列出信用卡、帳戶、錢包與現金交易 | 租戶隔離並限制單頁筆數；不延伸到帳戶餘額、預算或資產管理 | [`src/service.ts`](../../src/service.ts) |

---

### 附錄：低推理模型落地指引 (< 1500 Tokens 3-Tier Architecture)

針對輕量推理模型，為避免提示詞過長導致注意力分散或延遲升高，採用 `< 1500` token 的精簡三層架構：

```
┌────────────────────────────────────────────────────────────────────────┐
│                    低推理模型三層指引架構 (<1500 Tokens)                 │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 1: 核心原則與意圖映射 (< 300 tokens)                               │
│  - 推薦只讀、記帳授權、二階段規則更正確認、相容鍵匯率重用              │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 2: 動作合約與精確決策表 (< 700 tokens)                             │
│  - 二階段更正決策表 (Proposal -> Confirmation -> Activation)            │
│  - FX 相容鍵比對表 (base, quote, owner, timing, type, scheme, fresh)    │
│  - 交易寫入與時間區間查詢表 (from, to, page, limit)                    │
├────────────────────────────────────────────────────────────────────────┤
│ Tier 3: 精準 Minimal Payload 範例 (< 500 tokens)                       │
│  - upsert_offer (user_confirmed)                                       │
│  - recommend (含 trust_basis 與 FX 重用)                                │
│  - list_transactions (時間區間分頁查詢)                                │
└────────────────────────────────────────────────────────────────────────┘
```

#### Tier 1: 核心原則與意圖映射 (Core Principles & Intent Mapping, < 300 Tokens)
1. **只讀與試算安全**：`recommend`、`list_transactions` 為安全只讀工具，可隨時呼叫；`record_transaction` 寫入實際交易，需有金額、時間、資金來源與穩定 idempotencyKey。
2. **二階段更正確認**：使用者於對話中提出回饋或糾正時，嚴禁口頭承認卻不寫入，亦嚴禁未經確認直接靜默覆寫；必須採「提取提案並向使用者確認 $\rightarrow$ 使用者明確同意 $\rightarrow$ 呼叫 `upsert_offer` 啟用私有版本」。
3. **相容鍵匯率重用**：查詢外幣推薦時，比對候選路徑之 FX 相容鍵 Tuple；相同相容鍵者共用同一份牌價快照，不發起重複外部查詢；不同清算主體（卡組織 vs 銀行現鈔）嚴格分開。

#### Tier 2: 動作合約與精確決策表 (Action Contract & Decision Tables, < 700 Tokens)

* **決策表 1：二階段規則更正與生命週期**
  
  | 觸發事件 | 階段 1：提案 (Proposal) | 階段 2：確認與寫入 (Activation) | 標記與作用域 |
  |---|---|---|---|
  | 使用者告知「某卡某通路應該是 X%」 | 回覆使用者結構化摘要：「為您確認：將【卡片 A】在【通路 B】的費率更正為 X%，請問是否確認套用？」 | 收到使用者「是 / 確認 / 套用」後，呼叫 `upsert_offer` | `status: "active"`<br>`trust_basis: "user_confirmed"`<br>僅限使用者私有 Tenant，不外溢 |
  | 使用者提供官方條款連結 | 讀取條款快照，驗證細則後向使用者摘要更正內容 | 收到確認後呼叫 `upsert_offer` | `status: "active"`<br>`trust_basis: "official_evidence"` |
  | 使用者要求撤銷先前更正 | 摘要欲恢復之上一版本資訊並請求確認 | 收到確認後呼叫 `upsert_offer` 標記舊版本 `superseded` | 回歸系統預設基準版本 |

* **決策表 2：外幣匯率相容鍵比對與重用**
  
  | 候選卡片 / 路徑 | 相容鍵比對屬性 | 重用行為 | 說明 |
  |---|---|---|---|
  | 卡 A (JCB) 與 卡 B (JCB) | 幣別相同 (JPY/TWD)、owner 相同 (card_scheme)、rateType 相同 (spot_selling)、有效窗口內 | **允許重用同一快照** | 免除對 JCB 官網發起二次查詢 |
  | 卡 A (JCB) 與 街口掃碼 (街利存) | owner 不同 (card_scheme vs bank)、rateType 不同 (spot_selling vs cash_selling) | **嚴格禁止重用** | 街口掃碼必須查詢商業銀行現鈔賣出價 |
  | 卡 C (特定聯名卡有專屬議定匯率) | 具備卡片/路徑精確作用域 (route scope) | **精確作用域優先** | 覆蓋一般卡組織牌價，不可回退至通用快照 |

* **決策表 3：交易寫入與查詢**
  
  | 查詢需求 | 處理動作 | 邊界約束 |
  |---|---|---|
  | 記錄卡片、帳戶、錢包或現金支出 | 呼叫 `record_transaction`，以 `funding.kind` 表示來源 | 無回饋也可記錄；回饋結果可為未評估 |
  | 查詢旅程消費明細 | 呼叫 `list_transactions(from, to, page, limit)` | 依時間區間及目前使用者查詢，單頁筆數有上限 |
  | 查看特定交易的回饋、FX 或路徑 | 使用 detail 投影或交易 ID 查詢 | 需要時才展開關聯資料，避免每次回傳冗長內容 |
  | 查詢銀行餘額、預算或資產淨值 | 不在本 MCP 的交易歷史範圍 | 不需因此禁止一般現金支出記錄 |

#### Tier 3: 精準 Minimal Payload 範例 (< 500 Tokens)

1. **二階段更正後啟用私有版本 (`upsert_offer`)**：
```json
{
  "cardId": "card_taishin_richart",
  "version": "2",
  "status": "active",
  "trustBasis": "user_confirmed",
  "effectiveFrom": "2026-09-01T00:00:00Z",
  "rules": [{
    "planId": "play_travel",
    "rateBps": 330,
    "channels": ["in_store", "airline_online"],
    "notes": "User confirmed 3.3% on 2026-09-14"
  }]
}
```

2. **推薦試算輸出（帶 `trust_basis` 與 FX 相容鍵快照）**：
```json
{
  "recommendations": [{
    "cardId": "card_taishin_richart",
    "planName": "玩旅刷",
    "rewardRate": "3.3%",
    "trustBasis": "user_confirmed",
    "netSpendTwd": 1650,
    "fxApplied": {
      "rate": 0.2053,
      "rateType": "spot_selling",
      "provider": "JCB",
      "reusedFromCache": true,
      "freshUntil": "2026-09-15T00:00:00Z"
    }
  }]
}
```

3. **交易時間區間查詢 (`list_transactions`)**：
```json
{
  "from": "2026-09-10T00:00:00Z",
  "to": "2026-09-14T23:59:59Z",
  "page": 1,
  "limit": 50
}
```

---

## 伍、具體建議與分期實施計畫 (Actionable Roadmap)

### 第一期：文件、Skill 規範與輕量引導落地 (Phase 1: Immediate / Short-Term)

* **目標**：以極低代價修補 Agent 認知漏洞，建立二階段更正確認、相容鍵匯率重用與輕量 Playbook。
* **具體工作項**：
  1. **部署 `< 1500` Token 低推理模型引導手冊**：
     - 在 `docs/taiwan-card-rewards-skill/references/` 建立 `low-reasoning-playbook.md`，以三層架構（核心原則、決策表、精簡 Payload）落實二階段更正確認與私有版本啟用流程。
  2. **補齊電支/商業銀行現鈔結匯查價指引手冊**：
     - 在 `docs/taiwan-card-rewards-skill/references/` 新增 `wallet-and-clearing-fx-sources.md`，明定以商業銀行現鈔賣出結匯之電支掃碼路徑，應查詢之官方牌價來源與提取規範。
  3. **在 Skill 中建立「FX 相容鍵重用與清算上下文防呆」**：
     - 更新 [`payment-route-and-fx.md`](../taiwan-card-rewards-skill/card-rewards-recommendation/workflows/payment-route-and-fx.md)，明定同相容鍵（幣別、清算方、時點、牌價類型、組織）之卡片共享快照，免除每卡重複查價；同時加入負向防呆：當清算上下文為商業銀行現鈔結匯時，**嚴禁**跨作用域借用卡組織即期中價。
  4. **規範使用者確認啟用私有版本流程**：
     - 明定對話糾正應採「提取提案 $\rightarrow$ 使用者確認 $\rightarrow$ 啟用 `user_confirmed` 新版本」，禁止口頭答應不寫入，亦不再強制將外部爬蟲作為寫入前置阻塞。

### 第二期：MCP 合約擴充、相容鍵選擇器與交易查詢 (Phase 2: Mid-Term)

* **目標**：在 MCP 引擎層面落實 `trust_basis` 治理、相容鍵匯率重用與直接交易歷史查詢。
* **具體工作項**：
  1. **MCP 合約擴充 `trust_basis` 與私有版本生命週期**：
     - 在 [`src/mcp-contract.ts`](../../src/mcp-contract.ts) 之 `upsert_offer` 與回饋結構中擴充 `trustBasis: "official_evidence" | "user_confirmed"`；Calculation Trust Gate 支援使用者私有 Tenant 規則計算，並於推薦結果中透明呈現信任等級。
  2. **推薦引擎實作「相容鍵匯率重用選擇器」與實質淨收益演算法**：
     - 修改 [`src/service.ts`](../../src/service.ts) 之 `recommendIntent`，建立 FX 快照快取層，依相容鍵 Tuple 自動重用有效快照（精確 scope 優先）；並在比較候選排序時，將電支現鈔匯率與基準即期匯率之價差（FX Spread Drag）納入成本扣減。
  3. **擴充 `record_transaction` 並新增 `list_transactions`**：
     - 將 `cardId` 單一路徑改為 `funding.kind` 聯集，使信用卡、帳戶、錢包與現金都能用相同交易合約記錄；新增依 `from`、`to`、`page`、`limit` 的租戶隔離查詢。回饋與事件帳本只作為交易關聯資料，不新增 Payment Journal 服務。

### 第三期：全面事件驅動與多層路徑成熟化 (Phase 3: Long-Term)

* **目標**：完整落地 ADR 0008 與 ADR 0009，達成跨異質支付與跨境消費的通用計算架構。
* **具體工作項**：
  1. **讓事件回饋附掛於交易，而非取代交易**：
     - `Transaction` 保持使用者可理解的記帳主體；[`record_event_reward`](../../src/mcp-contract.ts#L76) 與跨事件資格只處理回饋計算、因果關係與沖正。兩者以 transaction/event ID 關聯，不要求 Agent 為一般記帳選擇不同服務。
  2. **讓優惠的 Route Selector 直接驅動候選路徑生成**：
     - 落實 [`docs/adr/0009-public-payment-capability-route-generation.md`](../adr/0009-public-payment-capability-route-generation.md)：優惠 ingestion 讀取細則的指定行動支付清單，寫入 provider/app allowlist、受理網路、資金種類與必要轉折，並建立或引用可重用的 selector/capability；推薦時與使用者持有的卡片或帳戶組合。避免要求 Agent 先另外登記同一份能力，也避免持久化每一種排列組合。
