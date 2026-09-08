# 支付方式檢索、非信用卡資金來源優惠模型與評估引擎演進研究

> **文件狀態**：Lead-assigned Research Report for Task `01a07b45-37f3-7900-bedd-a3a8f7060333`
> **調查日期**：2026-09-07
> **研究依據**：嚴格對照 repo 現行源碼（`src/mcp-contract.ts`、`src/types.ts`、`src/validation.ts`、`src/service.ts`、`src/cli.ts`、`src/evaluator.ts`）、ADR 0005、ADR 0006、ADR 0007，以及本報告列出的第一方官方 FAQ/條款。未列出直接官方 URL 的支付活動，不作為本報告的事實主張。
> **研究範疇**：
> 1. `search_active_offers` 新增 `paymentMethod` 過濾維度之可行性、向後相容性與 TDD 規範。
> 2. `upsert_offer` 強制要求 `cardId` 對非卡扣款（帳戶直扣、電支餘額、外幣帳戶、現金）與平台自有優惠之結構性限制與真實商業事實檢驗。
> 3. 評估三種非卡優惠模型架構（`fundingKind` 欄位 vs `appliesTo` 區分物件 vs `route-bound` 路線綁定規則），提出兼顧 Fail-Closed、Ownership 與漸進遷移（Migration）之完整技術方案。
> **免責聲明**：外部網路/生產環境實體清算細節以最新官方公告為準；本報告聚焦於規格合約、清算事實與架構推演，不變更 runtime 程式碼。

---

## 1. `search_active_offers` 新增 `paymentMethod` 過濾維度之分析與建議

### 1.1 現行合約與實作盤點
- **合約層級 (`src/mcp-contract.ts:L59`)**：
  ```typescript
  search_active_offers: closed({
    rawQuery: { type: 'string', maxLength: 128 },
    cardId: string,
    canonicalMerchantId: string,
    country: string,
    market: string,
    mcc: string,
    channel: string,
    asOf: date,
    ...page,
    projection: { type: 'string', enum: ['summary', 'detail'] }
  })
  ```
- **服務層級 (`src/service.ts:L257-L281`)**：
  過濾邏輯依序檢查了 `rule.status === 'active'`、`cardId`、`validFrom/validTo`、`channel`、`country`、`mcc`、`canonicalMerchantId`、`market` 與 `rawQuery`。
- **邊界層 (`src/validation.ts:L621`、`src/cli.ts` 的 `search_active_offers` dispatch)**：
  工具參數 allowlist 與 CLI forwarding 也沒有 `paymentMethod`；只改 service 而不改這兩層，MCP 呼叫仍會被拒絕或欄位被丟失。
- **底層型別與比對核心 (`src/types.ts:L193` & `src/evaluator.ts:L49`)**：
  `RuleMatch` 結構中**已經原生存在** `paymentMethods?: readonly string[] | undefined`，且 `evaluator` 亦原生執行 `['payment_method', has(tx.paymentMethod, rule.match.paymentMethods)]`。

### 1.2 存在問題與 Agent 痛點
- 目前使用者或 Agent 若欲查詢「特定支付方式（如 LINE Pay、街口支付、Apple Pay 或 TWQR）有何加碼優惠？」，`search_active_offers` 無法在 MCP 伺服端直接透過 `paymentMethod` 進行過濾。
- Agent 被迫拉取全部有效優惠，在 context window 中逐筆檢視 client-side filter，造成 token 浪費並增加推理幻覺風險。

### 1.3 向後相容（Backward-Compatible）設計建議
1. **Schema 擴展**：
   在 `src/mcp-contract.ts` 的 `search_active_offers.inputSchema` 增加選填欄位：
   ```typescript
   paymentMethod: { type: 'string', maxLength: 64 }
   ```
2. **過濾語意規範 (Symmetric Filter Invariant)**：
   比照 `channel`、`country`、`mcc` 的現有設計：
   - 若規則的 `rule.match.paymentMethods` 為空陣列或 `undefined`，代表該優惠為「全支付方式通用（Universal）」，在傳入特定 `paymentMethod` 時**依然匹配（Match）**。
   - 若規則明確指定了 `paymentMethods`（例如 `['line_pay', 'apple_pay']`），則只有當傳入的 `input.paymentMethod` 包含於該清單時才匹配。
   ```typescript
   if (input.paymentMethod && rule.match.paymentMethods?.length && !rule.match.paymentMethods.includes(input.paymentMethod)) {
     return false;
   }
   ```
   這是「規則沒有支付方式限制」的計算語意，不是「官方已確認該支付方式有加碼」的證據。若產品日後要區分「可適用」與「明示支持」，應另加明確的查詢模式或證據欄位，不應偷偷改變既有 wildcard 行為。
3. **TDD 驗證矩陣**：
   - `test 1`: 當未提供 `paymentMethod` 時，回傳結果與現行行為 100% 一致（相容性）。
   - `test 2`: 當傳入 `paymentMethod: "line_pay"` 時，命中指定 `line_pay` 的規則以及未限制支付方式的通用規則。
   - `test 3`: 當傳入 `paymentMethod: "line_pay"` 時，排除明確限定 `['apple_pay']` 的專屬規則。
   - `test 4`: 與 `cardId`、`channel: "online"`、分頁參數組合時，交集正確且 `pageInfo` 筆數一致。
   - `test 5`: tools/list schema、`validateToolArgs`、CLI dispatch 與 service input 均保留/轉送 `paymentMethod`；未列在 allowlist 的未知欄位仍 fail closed。

---

## 2. `upsert_offer` 現行 `cardId`-required 限制與非卡資金商業事實

### 2.1 現有程式碼之強烈卡片綁定瓶頸
在當前 codebase 中，優惠模型呈現高度「以卡為中心（Card-Centric）」的設計：
1. **`src/mcp-contract.ts:L28`**：`rule` 的 `required` 陣列包含 `cardId`。
2. **`src/validation.ts:L297`**：`cardId: requiredString(item.cardId, 'rule.cardId', true)`。
3. **`src/evaluator.ts:L280`**：
   ```typescript
   if (rule.cardId !== tx.cardId) return base; // 直接短路回傳 no_match
   ```
4. **`src/service.ts:L491`**：`recommend` 僅以使用者持有的 `heldCards` 逐卡查詢 `rule.cardId === card.id`。

### 2.2 矛盾點：ADR 0006/0007 已定義非卡層次，但 schema 無法體現
- **ADR 0006** 與 **ADR 0007** 明確定義了三層回饋架構 (`RewardComponentKind`)：
  - `merchant_loyalty`（商家會員點數）
  - `payment_provider`（電支錢包與支付業者行銷回饋）
  - `card_issuer`（發卡銀行信用卡回饋）
- **ADR 0007** 更定義了多種終端資金工具 (`FundingInstrument`)：
  - `credit_card`
  - `account` (`linked_bank_account`, `wallet_balance`, `foreign_currency_account`)
  - `cash`
- **現行限制導致之後果**：
  若某個優惠是屬於「街口支付帳戶筆筆 2% 街口幣」或「全支付綁定銀行存款帳戶 1.5% 全點」，由於 `cardId` 為必填欄位，Agent 被迫：
  - 虛構一個假的 `cardId`（如 `cardId: "JKO_WALLET_ACCOUNT"`）；
  - 或將錢包自有優惠錯誤地複製到每一張使用者的信用卡上；
  - 且在評估引擎中，若交易為非卡消費（如 `funding.kind === 'account'`），因 `tx.cardId` 不存在或不匹配，導致規則永遠被 `evaluator.ts:L280` 拒絕。

### 2.3 台灣第一方非卡資金優惠之真實商業事實 (Primary Evidence)

本研究只把已查到且可直接定位的官方頁面列為證據；其他支付業者或活動的比率、排除條件與有效期不可由品牌印象推導，應另建立官方 source snapshot。

| 官方來源 | 可支持的事實 | 對模型的含義 |
|---|---|---|
| [街口支付官方 FAQ](https://www.jkopay.com/application/faq) | FAQ 同時描述 TWQR/JKO Coin、JKO Save Account、JKOPAY Account 與聯名卡的不同支付/回饋情境；也說明帳戶/街口帳戶退款回到 JKOPAY 帳戶，而卡交易依卡帳單處理；PayPay 跨境可選帳戶或聯名卡，聯名卡路徑涉及信用卡儲值。 | 同一個商家/支付品牌不能直接代表同一條 funding rail。至少要區分 `account(wallet_balance)`、`account(linked_bank_account)` 與 `credit_card_topup`，並把 reward owner、refund path 與 paymentMethod 分開保存。 |
| [台新 Pay+ 官方 FAQ](https://web.taishinbank.com.tw/TSB/personal/digital/E-Payment/Electronic-Payment/faq/) | FAQ 說明 Pay+ 可綁定台新台幣存款帳戶或台新信用卡，且兩種工具的額度/交易限制不同；信用卡路徑可涉及台新點數，餘額再由信用卡扣款。 | 同一 provider 下仍有 account 與 card rail；`fundingKind` 單一欄位不足以表達 provider、subtype、card identity 與 route-specific facts。 |
| [台新 Taiwan Pay/TWQR 官方條款 PDF](https://web.taishinbank.com.tw/TSB/export/sites/TSB/personal/digital/TWPay-v2.pdf) | 條款區分綁定信用卡、金融卡與存款帳戶，並分別描述帳戶扣款與卡片交易；使用者可切換綁定的支付工具。 | TWQR/acceptance brand、payment method、terminal funding 與 issuer reward 不能合併成一個 `cardId` 或品牌欄位。 |

因此，這些官方資料足以驗證「非卡 funding 不是假需求」及「同一支付品牌存在多條 funding rail」；但它們不自動證明任何特定當期回饋比率。每個 active rule 仍必須引用對應官方 snapshot、有效期與確認資料。

---

## 3. 非卡優惠模型三種架構設計評估 (Design Options Comparison)

為了讓 MCP 能精確表達並計算非信用卡（錢包、銀行帳戶、商家會員）自有優惠，評估以下三種設計候選方案：

### 方案 A：`fundingKind` 簡單純量欄位
- **定義**：在 `rule` 中新增 `fundingKind?: 'credit_card' | 'account' | 'cash'`。若為 `'account'` 或 `'cash'`，放寬 `cardId` 為選填。
- **優點**：改動最輕量，只需在 schema 放寬 `cardId` 的必填檢查。
- **缺點**：
  - 無法細分 `account` 之子類型（如無法區分「銀行存款帳戶代扣」與「電支儲值金餘額」）。
  - 無法表達回饋由誰發放（未包含 Ownership 語意）。
  - 缺乏路線拓撲，容易引發「假多跳」模糊推論。

### 方案 B：`appliesTo` / `funding` 鑑別聯集物件 (Discriminated Union)
- **定義**：
  ```typescript
  type OfferTarget =
    | { kind: 'card'; cardId: string }
    | { kind: 'account'; providerId: string; subtype?: 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account' }
    | { kind: 'route'; routeId: string }
    | { kind: 'merchant_universal'; merchantId?: string };
  ```
- **優點**：強型別封裝，語意極度嚴謹，不合法的欄位組合（如 account 帶 cardId）在 schema 驗證期直接阻斷。
- **缺點**：
  - 破壞既有 `OfferRuleVersion.cardId` 的公開介面，造成重大 breaking change。
  - 需要大規模的 Desugaring 與 Storage 遷移，現有 15 個測試檔與 Skill 範例均須重寫。

### 方案 C：基於 ADR 0007 之 `routeId` 路線綁定 + `cardId` 彈性化方案
- **設計核心**：
  1. 保留 ADR 0007 已實作的 `routeId?: string` 與 `componentKind?: 'merchant_loyalty' | 'payment_provider' | 'card_issuer'`。
  2. 將 `rule.cardId` 從「全局必填」調整為「**條件式必填 (Conditionally Required)**」：
     - 若 `rule.componentKind === 'card_issuer'`（或省略時預設之發卡行規則），`rule.cardId` **嚴格必填**。
     - 若 `rule.componentKind === 'payment_provider'` 或 `'merchant_loyalty'`，`rule.cardId` **得為選填（可為 undefined）**，但必須提供明確的 `appliesTo`/provider/merchant/payment-method facts；`routeId` 僅是額外的特定路線約束。
  3. 終端資金工具與子類型完全繼承自關聯之 `PaymentRouteRecord.funding`：
     - 若 `route.funding.kind === 'account'`，其 `subtype`（如 `linked_bank_account`、`wallet_balance`）由已註冊並驗證之路線事實主導。
- **方案比較總表**：

| 評估維度 | 方案 A：`fundingKind` 簡單欄位 | 方案 B：`appliesTo` 鑑別聯集物件 | 方案 C：`routeId` 綁定 + `cardId` 條件化 |
|---|---|---|---|
| **向後相容性** | 良好 | 差 (Breaking Change) | **最佳 (舊卡片規則可保留)** |
| **Fail-Closed 完整性** | 中等 | 高 | 高，但必須解引用 user-owned route |
| **權責歸屬 (Ownership)** | 模糊 | 清晰 | 清晰；仍需 componentKind |
| **實作與遷移成本** | 低 | 高 | 適中 |
| **本案定位** | 輸入簡化欄位/投影 | canonical target model | optional route constraint |

### 3.1 關鍵概念：公開優惠政策不等於使用者的支付路線

三個方案真正的差異，不只是欄位多少，而是是否把兩種不同的 entity 混在一起：

- **Offer policy**：銀行、支付業者或商家發布的公開規則，可被多個使用者及多條路線套用。
- **Payment route**：某一使用者實際登記、觀察到的支付拓撲，包含該次交易使用的 app、provider、funding 與清算事實。

因此，Option C 若把每個非卡優惠都綁在單一 `routeId`，會產生 route/policy conflation：同一個「街口帳戶回饋」要複製成每個使用者各自的 route-bound rule；使用者尚未登記 route 時，推薦也無法先發現這個公開優惠。`routeId` 應是特定路徑專案的額外約束，不應是非卡優惠的唯一主體識別。

### 3.2 五種情境的可表達性

| 情境 | A：`fundingKind` | B：`appliesTo` union | C：`routeId` | 判斷 |
|---|---|---|---|---|
| 支付業者通用優惠 | 缺 provider/owner | 可表達 provider 與 owner | 綁死 user route | B 勝 |
| 電支 wallet balance | 只能寫 account，無 subtype | 可表達 `account + wallet_balance` | 未登記 route 就無法評估 | B 勝 |
| linked bank account | 無法指定合作銀行 | 可表達 provider/bank + subtype | 拓撲過度具體 | B 勝 |
| credit-card top-up | 容易誤認為 direct card | 可表達 top-up route/funding facts | 可表達，但僅適合已觀察路線 | B + C |
| merchant loyalty | 沒有自然主體欄位 | 可表達 merchant/program | routeId 不必要 | B 勝 |

### 3.3 修正版建議：Hybrid Canonical Model

建議採 B 的適用主體模型，加上 C 的可選 route constraint，而不是三者擇一：

```ts
rule: {
  componentKind: 'card_issuer' | 'payment_provider' | 'merchant_loyalty',
  cardId?: string, // legacy alias; card_issuer 必填
  appliesTo?:
    | { kind: 'card'; cardId: string }
    | { kind: 'provider'; providerId: string; paymentMethods?: string[]; funding?: FundingSelector }
    | { kind: 'merchant'; merchantId: string; programId?: string }
    | { kind: 'funding'; providerId?: string; funding: FundingSelector },
  routeSelector?: {
    nodes?: RouteNodeSelector[]
    transitions?: RouteTransitionSelector[]
    exact?: boolean
  }, // reusable route-pattern policy
  routeId?: string // exact constraint for one observed route only
}

type FundingSelector = {
  kind: 'credit_card' | 'account' | 'cash',
  subtype?: 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account'
}
```

#### 四層概念清晰切割 (Four-Layer Separation)
1. **通道標籤 (Rail / Method Label)**：
   既有 `rule.match.paymentMethods?: string[]` 是 open string（例如 `"jkopay"`, `"line_pay"`, `"pxpay"`, `"taiwan_pay"`），本質上是支付 App/受理軌道標籤，不是終端清算資金。
2. **終端資金選擇器 (Terminal Funding Selector)**：
   型別化的 `FundingSelector`（`kind: 'credit_card' | 'account' | 'cash'` 與其子類型），對齊 `PaymentRouteRecord.funding`，描述實際扣款的資產類型。
3. **路線拓撲 (Payment Route Topology)**：
   包含具角色的 acceptance network、payment service、funding instrument 與 typed transitions（如 card authorization、wallet top-up、account debit、wallet settlement）。完整組合優惠應綁定可重用的 `PaymentRouteSelector`；`routeId` 只用於綁定一條已觀察、已註冊的具體路徑。
4. **結算與權責 (Settlement & Ownership)**：
   保存 terminal funding、settlement owner、reward sponsor、幣別、轉換與費用等事實；不能從品牌名稱或某個 route node 自動推導回饋歸屬。

#### 語意約束與同 Owner 去重規範 (Deduplication & Invariants)：

1. `componentKind` 決定回饋發放者、ownership 與 cap pool；不能由 `funding.kind` 推導。
2. `appliesTo` 與 `routeSelector` 決定優惠適用主體；`routeId` 只收窄到某一條已驗證的 concrete route record。
3. `card_issuer` 必須有 `cardId`，且交易 funding 必須是該卡的 `credit_card`；非卡交易不得套用發卡行規則。
4. `payment_provider` 的 wallet/account 規則可沒有 `cardId`，但必須有 provider、funding subtype 或明確 payment method；缺少這些 facts 時只能是 candidate/needs_review。
5. `merchant_loyalty` 不應被迫攜帶 routeId；它可只以 merchant/program 與會員資格條件匹配。
6. credit-card top-up 要拆成兩個可能的 component：錢包/支付業者 component 依實際 wallet settlement 判定；發卡行 component 只有在 issuer 官方條款明確涵蓋該 top-up descriptor 時才成立，否則 fail-closed。
7. **同 Owner 重複命中防護 (Same-Owner Deduplication)**：
   - 當同一筆交易中，某個節點通則 policy（透過 payment method / funding selector 命中）與 route-selector rule（或 legacy `routeId` exact constraint）同時符合時：
     - 若兩者屬於同一個 `componentKind` 與發放主體（例如同為街口官方）：
       - 除非官方條款明示可雙重累積，否則 Evaluator 預設採**特化優先（Specificity Precedence：route-bound rule 覆蓋通則）**或**擇優計算（Best-Offer Wins）**，嚴禁同一個 owner 之行銷活動重複灌水。
     - 若兩者屬於不同 `componentKind`（如發卡行 1% + 錢包業者 2% + 商家 1%），則依 ADR 0006 正常進行多層疊加，並分別計入各 owner 獨立的 Cap Pool。

這樣可保留既有 `cardId` 規則的相容性，又避免把公開 campaign 複製成每個使用者的 route。Option A 可以作為輸入的簡化 projection，但不應是 canonical persisted model；完整組合應使用可重用的 route selector，`routeId` 僅保留為 concrete-route constraint。

### 3.4 白話化心智模型與技術對照表 (User-Facing Mental Model)

為降低理解門檻，避免過度抽象的技術術語，對外與使用者溝通時，固定使用「**錢從哪裡來？怎麼付？是不是特定路徑？**」三層核心問答：

| 白話核心提問 | 對外稱呼 | 商業真實範例 | 優惠綁定預設原則 | 內部技術欄位與型別對照 |
|---|---|---|---|---|
| **1. 錢從哪裡來？** | **付款來源** | 信用卡、銀行存款帳戶直扣、電支儲值金餘額、外幣帳戶、現金 | **主要綁定點**（如「帳戶直扣 2%」、「信用卡一般消費」） | `FundingInstrument` / `FundingSelector`（`kind: 'credit_card' \| 'account' \| 'cash'`, `subtype`） |
| **2. 怎麼付？** | **付款方式** | 實體刷卡、Apple Pay、街口支付、LINE Pay、Taiwan Pay (TWQR)、現金 | **主要綁定點**（如「Apple Pay 加碼 1%」、「街口筆筆 3%」） | `paymentMethod` / `rule.match.paymentMethods` / `appliesTo.provider` |
| **3. 是不是特定路徑？** | **付款路徑** | 「PayPay → 台新 Pay+ → Richart 卡」或「PayPay → 台新 Pay+ → 街利存帳戶」 | **若條款要求完整組合，綁 reusable route selector；只有具體觀察路徑才綁 routeId** | `PaymentRouteRecord` / `PaymentRouteSelector` / `rule.routeId` / `tx.routeId` |

#### 溝通與封裝原則：
1. **內部模型封裝**：`FundingInstrument`、`appliesTo`、`PaymentRouteSelector`、`componentKind` 完整保留在底層核心型別中負責型別安全、上限池隔離與精準計算；對外文件、CLI 說明與 Agent 對話仍先使用「付款來源、付款方式、付款路徑」三層白話語言。
2. **政策與具體路徑分離**：公開優惠政策可綁定付款來源、支付服務、受理網路，或可跨使用者重用的完整 route selector；只有已觀察、已註冊的具體路徑才使用 `routeId` 約束。

---

## 4. Fail-Closed、Ownership 與 Evaluator/Recommendation 遷移架構

### 4.1 嚴格 Fail-Closed 與權限隔離保證 (Ownership Invariants)
1. **發卡行權益隔離**：
   - 任何標記為 `componentKind: 'card_issuer'` 的規則，若交易透過非信用卡（如 `account` 或 `cash`）扣款，Evaluator 必須判定為 `no_match`。
   - 嚴格禁止銀行一般刷卡回饋無證據滲漏至電支儲值金或銀行帳戶直扣交易中。
2. **路線與資金不匹配阻斷**：
   - 若規則綁定 `routeId: "route_jko_balance"`，但交易指定之 `tx.routeId` 為 `"route_jko_card"`，Evaluator 判定 `no_match`。
   - 若 `routeId` 未在 `context.paymentRoutes` 註冊，Evaluator 回傳 `unknown` 並發出 `missing_required_fact` 診斷；若已過期，回傳 `stale`。
3. **無憑據不假設通用**：
   - 電支錢包之行銷回饋若未在官方條款中載明適用於所有卡片，不得將無 `cardId` 的規則視為對所有持有卡通用；未經證實之關聯一律 Fail-Closed。

### 4.2 Evaluator 評估引擎遷移邏輯 (Evaluator Matching Logic)
現行 `src/evaluator.ts:L280` 的強硬阻斷：
```typescript
// 現行程式碼 (Line 280)
if (rule.cardId !== tx.cardId) return base;
```
應遷移為符合多層權益與非卡資金之條件比對：
```typescript
// 建議遷移實作
const route = tx.routeId === undefined ? undefined : context.paymentRoutes?.find((candidate) => candidate.id === tx.routeId);
if (rule.cardId !== undefined) {
  if (rule.cardId !== tx.cardId) return base;
}
// Future appliesTo/funding selector: absent route or mismatched subtype is unknown/no_match,
// never an implicit account-or-wallet match.
if (rule.componentKind === 'card_issuer') {
  // 發卡行回饋必須有明確卡片識別，且資金來源必須為信用卡
  if (!tx.cardId || (route && route.funding.kind !== 'credit_card')) return base;
}
```
此改動確保：
- 現有所有傳統信用卡規則（`rule.cardId` 存在）行為完全不變。
- 平台自有規則（`rule.cardId` 為空，但有 `routeId` 或 `paymentMethods`）能順利為符合條件之非卡交易提供精確計算。

### 4.3 Recommendation 推薦引擎演進 (Multi-Component Stacking)
- **現行限制**：`src/service.ts:L491` 僅依持有卡清冊逐卡搜尋規則。
- **演進路徑**：
  1. `recommend` 接收 `transaction`（包含可選之 `routeId` 或 `paymentMethod`）。
  2. 推薦引擎同時檢索：
     - 各持有卡之專屬 `card_issuer` 規則；
     - 與目前交易情境匹配之通用 `payment_provider` 規則（如 JKO 帳戶加碼、全支付全聯加碼）；
     - 特店會員之 `merchant_loyalty` 規則。
  3. 依 ADR 0006 合併為多層 `RewardComponentRecord`，回傳綜合最優回饋策略，並分別扣減獨立上限池。

---

## 5. 結論與後續執行規劃

1. **短期（建議 v0.9.x additive change）**：新增 `search_active_offers.paymentMethod`，同步修改 contract、service、CLI、validation 與 focused tests；保留 rawQuery 的 merchant-only 語意。這是低風險、可獨立發布的檢索能力。
2. **中期（建議版本化的非卡 funding slice）**：不要只新增 `fundingKind: card|account|wallet`，也不要把 PayPay＋Pay+＋Richart／街利存硬編成新的組合 enum。採 route-graph canonical model：以 `appliesTo` 表達節點主體，以 `PaymentRouteSelector` 表達可重用的節點/transition/完整路徑條件，以 ADR 0007 的 `FundingInstrument`（`credit_card|account|cash` + subtype）表達資金事實，以 `componentKind` 表達 ownership，並保留 `routeId` 作為具體路徑約束。
3. **遷移順序**：先讓非 `card_issuer` rule 以 candidate 狀態保存新的 `appliesTo`；等 evaluator/recommendation 能識別並驗證 funding/provider/active user-owned route 後，才允許其成為可計算的 active reward。舊有 card rules 保留原 schema/行為，避免一次破壞既有 15-tool 合約。
4. **Fail-Closed 邊界**：若缺少 terminal funding、provider/subtype、route ownership、官方 snapshot、有效期或 reward owner，返回 `unknown`/`needs_review`，不得以品牌或 paymentMethod 猜測 funding，也不得創造假的 `cardId`。
5. **本研究產出**：已記錄於 `docs/research/payment-method-search-and-non-card-funding-model.md`，作為後續 MCP 合約擴充與 ADR 更新的研究輸入；本文件沒有修改 runtime，也沒有驗證 staging/production 清算結果。
