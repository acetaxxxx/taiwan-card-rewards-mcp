# 多層付款路徑推薦規格

**狀態**：Normative specification；除 §1.2 標註的 `split_tender` 缺口外，本文件描述的模型已 shipped 並由測試回歸保護  
**版本**：0.2.0  
**範圍**：`recommend` 統一入口內的候選路徑生成、事件計畫、回饋比較與驗收基準  
**限制**：本文件只定義可實作的模型與驗收條件；不宣稱任何未有當期官方證據的產品路徑可用。

## 1. 目的與邊界

付款路徑推薦要回答的是：

1. 使用者目前擁有或已確認的哪些付款來源，可以透過哪些有證據的中介服務
   到達指定商家？
2. 這條路徑實際包含哪些事件，例如信用卡儲值與之後的錢包消費？
3. 每個事件分別命中哪些優惠、受哪些 cap 與 stacking policy 控制？
4. 在回饋、費用、匯率、證據新鮮度與操作成本都可解釋的前提下，候選路徑如何
   穩定排序？

本模型刻意把以下三件事分開：

- PaymentRouteRecord 是使用者範圍內的已觀察或已確認路徑事實。
- PaymentPathCandidate 是針對一個 planned purchase 產生的候選路徑。
- PaymentPathPlan 是候選路徑內的預計事件序列。它可以包含 top_up 與
  purchase，但不是已發生交易。

候選推薦是只讀計算。任何 planned candidate 都不得寫入 transaction、reward
component、event reward ledger、cap usage 或 wallet balance ledger，也不得預約
cap。只有之後收到真實事件並通過實際事件 API，才可進行 durable recording。

### 1.1 非目標

- 從支付品牌名稱推導未公開的清算、回饋或資金來源。
- 把一個多跳路徑壓平為 money_source + payment_method 兩欄。
- 對混合錢包餘額自動套 FIFO、LIFO 或任何未被官方證據支持的 lot allocation。
- 把 Gold、會員等級或 enrollment 狀態建成付款路徑節點。
- 把 model fixture 的通過結果當作 PayPay、街口、Pay+、悠遊付或其他產品的
  當期商業保證。

### 1.2 Current runtime audit

**狀態更新**：本節原先（v0.1.0）把下列能力列為待實作目標；實際上，這份規格
描述的 Phase 2～5 與 M-06～M-27 範圍已經實作並持續由 `tests/payment-path-*.test.ts`
回歸保護。以下是重新盤點過的現況：

- **已 shipped**：typed node/edge graph traversal（僅限本規格定義的 8 種
  transition）、cycle/hop/event/branch-count 上限與對應 `truncated_by_bound`
  診斷、edge evidence 的精確性/新鮮度/方向檢查、path-signature 去重、
  top_up+purchase 的 planned event 拆分、全部 5 種 stacking mode
  （additive/replace/best_of/exclusive/prerequisite，含 cycle-safe
  prerequisite 解析）、cap-pool preview、以 valuation snapshot 為準的
  native-unit 回饋換算、FX-aware 的 fee/net-value 計算（缺對應轉換一律
  `unknown`，不 fallback）、以及 8 層 deterministic tie-break 排序。
- **唯一已知缺口**：`split_tender`（一筆消費同時由多個資金來源分攤）雖然是
  已定義的 transition enum 值，但目前的圖搜尋尚未實作把一筆購買拆成多個並行
  資金來源分攤的邏輯。
- **不是程式碼缺口，是資料填充工作**：真實台灣錢包（PayPay、街口、Pay+、
  悠遊付等）的官方 evidence 需要逐一研究並透過 `upsert_payment_route`／
  `upsert_payment_capability` 建立；在對應 route/edge 真的帶有官方來源之前，
  沒有任何 route 會判定為 `ready`——這是本規格一直以來的 fail-closed 設計，
  不是尚待完成的程式功能。
- **入口整合**：`recommend`（merchant-first intent）內部已經呼叫本規格描述的
  路徑引擎，並把結果與卡片候選合併進同一個 `candidates[]`（`kind:
  'direct_card' | 'payment_path'`），一次呼叫即可同時比較兩者。原本規劃的
  `recommend_payment_paths_v1` 這類獨立、較低階的入口已經移除——它是整合前的
  舊入口，回傳的欄位（沒有 `fxEstimate`、沒有與卡片候選合併排序）比整合後的
  `recommend` 少。

因此，除了 `split_tender` 之外，本文件後面章節描述的模型與行為應視為目前
runtime 的現況說明，而不是未來目標；沿用本文件的驗收矩陣（第 10 節）作為
回歸測試的對照基準。

## 2. 詞彙與模型邊界

### 2.1 候選路徑與路徑事實

PaymentRouteRecord 的 route ID 是一筆具體路徑事實的穩定識別，不是可重用的
優惠政策。可重用政策要使用 typed route selector，選擇節點、transition 或
完整拓撲。

PaymentPathCandidate 是以同一個 asOf、使用者資料版本及輸入金額生成的
不可變計算結果。候選 ID 必須由規格版本、route signature、event plan 與
comparison context 決定，不能以隨機 ID 造成同一查詢排序漂移。

### 2.2 路徑方向

內部 canonical graph 使用**價值流方向**：funding source 在前、merchant 在
末端。UI 可以反向顯示成「商家 → 支付服務 → 錢包 → 資金來源」，但不能改變
transition 語意。

完整候選必須以 merchant terminal 結束，且每個相鄰節點都有 typed transition
及所需 evidence。只有 layers 名稱能串起來、但沒有 transition evidence 的
圖是 blocked/unknown，不是完整路徑。

### 2.3 會員資格不是節點

Gold、聯名卡資格、campaign enrollment、plan selection 都是 EligibilityFact：

- Gold 是 user-scoped fact，例如 membership.program=gold、有效期間與資料來源。
- 聯名卡是 HeldCard 與 CardProduct 的產品／發卡行事實。
- 某一 payment provider 的會員資格是該 provider 的 user fact。

它們可以供 rule predicate 或 stacking policy 使用，但不能在 graph 中插入
GoldNode、MembershipNode，不能因會員 fact 存在就虛構付款 transition。

## 3. Canonical typed graph

### 3.1 節點角色

第一版只允許下列穩定角色；品牌、provider、app 名稱全部是資料欄位，不新增
核心 enum：

| role | 代表 | 必要識別 | 是否可為起點／終點 |
| --- | --- | --- | --- |
| funding_source | Held Card、連結銀行帳戶、外幣帳戶、現金 | cardId、accountId 或明示 cash | 起點 |
| wallet_balance | 電支或商戶 app 的儲值餘額 | provider/account 或 wallet ID | 中間／交易 funding／既有餘額 seed |
| payment_service | 街口、Pay+、LINE Pay 等支付服務 | provider/app ID | 中間 |
| acceptance_network | PayPay、TWQR 或其他商家受理／互通網路 | network ID | 中間 |
| merchant | 具市場範圍的 canonical merchant | merchant ID | 唯一末端 |

card_issuer、card_network 等既有 PaymentRouteLayer.kind 可在 adapter 中保留
為 evidence layer，但若要參與多跳計算，必須映射成角色明確的 issuer facts 或
transition evidence；layer 名稱本身不能充當 edge。

### 3.2 Transition 種類

| transition | from → to | 事件意義 | 需要證明的事 |
| --- | --- | --- | --- |
| card_authorization | funding_source(card) → acceptance_network 或 merchant | 一次直接卡交易 | 卡在該受理軌道直接授權，而非先儲值 |
| account_debit | funding_source(account) → wallet_balance 或 merchant | 帳戶扣款 | 帳戶可用於該目的與期間 |
| wallet_top_up | funding_source(card/account/cash) → wallet_balance | top_up | 來源、目的 wallet、金額規則與時點 |
| wallet_debit | wallet_balance → payment_service/acceptance_network/merchant | wallet value 被扣用 | wallet 能在該商家／network 使用 |
| service_to_acceptance | payment_service → acceptance_network | 支付服務轉送至受理／互通網路 | provider 與 network 的 exact interoperability 及市場範圍 |
| merchant_settlement | acceptance_network/payment_service/wallet → merchant | 商家結算 | 受理範圍、market、currency 與 settlement semantics |
| direct_settlement | funding_source → merchant | 直接付款結算 | 沒有中介儲值或餘額轉移 |
| split_tender | 多個 funding_source/wallet → merchant | 拆分付款 | 交易是否真的允許拆單及每份 amount；沒有證據不得產生 |

Transition 是 domain fact，不是 evaluator 的猜測。相鄰節點雖然 provider 字串
相同，也不能自動視為同一節點；node identity、role、edge direction、currency
及 evidence 必須一致。

### 3.3 Edge evidence

每一條候選 edge 必須保存：

~~~typescript
interface PathEdgeEvidence {
  edgeId: string;
  evidenceIds: readonly string[];
  sourceSnapshotIds: readonly string[];
  provenance: "official" | "model_fixture";
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  claim: {
    fromRole: PathNodeRole;
    toRole: PathNodeRole;
    transition: TransitionKind;
    providerScope?: string;
    market?: string;
    currency?: string;
  };
}
~~~

production official evidence 必須是可追溯的第一方來源、已接受、未過期且 claim
涵蓋該 exact edge。社群觀察或 Agent 推測只能作 discovery，不能使 edge 成為
ready。model_fixture 僅用來測試圖演算法，永遠不能被 production state 當作
official evidence。

## 4. 資料輸入與候選生成

### 4.1 可用資料

每次查詢隱含一個 ownerUser，只可讀取：

- 該 user 的 active HeldCard 與 card-specific eligibility facts。
- 該 user 的 active、confirmed PaymentAccountRecord。
- 該 user 的 active、confirmed PaymentRouteRecord。
- 對應 user 的 Gold／會員／enrollment／plan facts。
- deployment-shared 的 active OfferRuleVersion、cap pools、reward valuation
  與 official evidence。

路徑與帳戶資料不得跨 user join。route、account 或 card 若只有 candidate、stale、
conflict、needs_review、未確認或 evidence 過期狀態，不得進入 ready candidate；
可依查詢設定保留為 blocked diagnostic。

資料讀取要固定 asOf 與 dataVersion。同一 user、相同 query、相同資料版本與
相同 policy version 必須生成相同 path signature 與排序。

### 4.2 建議 request/response seam

以下是 target API 的語意契約，不是本次直接修改的 TypeScript public type：

~~~typescript
interface RecommendPaymentPathRequest {
  intent: {
    kind: "purchase";
    amount: Money;
    merchant?: CanonicalMerchantInput;
    mcc?: string;
    country?: string;
    channel?: string;
    paymentMethod?: string;
    occurredAt?: string;
  };
  sourceFilter?: {
    cardIds?: readonly string[];
    accountIds?: readonly string[];
    routeIds?: readonly string[];
  };
  comparison?: {
    currency?: Currency;
    objective?: "net_value" | "capped_reward" | "gross_reward" | "lowest_fee";
  };
  include?: {
    conditional?: boolean;
    blocked?: boolean;
    noMatch?: boolean;
  };
  limits?: {
    maxCandidates?: number;
    maxHops?: number;
    maxEvents?: number;
    maxBranchesPerNode?: number;
  };
  asOf?: string;
}

interface RecommendPaymentPathResponse {
  status: "ok" | "partial" | "needs_facts" | "needs_review" | "no_match";
  evaluatedAt: string;
  dataVersion: string;
  candidates: readonly PaymentPathCandidate[];
  blocked: readonly BlockedPath[];
  diagnostics: readonly ActionableDiagnostic[];
}
~~~

**已 shipped 的實際整合方式**（取代本節原先規劃的獨立 `{kind: "payment_path",
payment_path: {...}}` envelope）：`recommend` 只有一個公開 request 形狀——
merchant-first `recommendationIntent`（`merchant`/`amount`/`fx`/`routeFacts`/
`country`/`market`/`channel`/`paymentMethod`/`occurredAt`/`cardIds`/
`routeIds`/`limit`/`page`/`cursor`/`resultVersion`）。`recommendIntent()`
內部把同一個 intent 轉成上述 `RecommendPaymentPathRequest` 呼叫路徑引擎，
再把每個 `PaymentPathCandidate` 併入同一個 `candidates[]`（`kind:
'direct_card' | 'payment_path'`），與卡片候選一起排序、分頁。沒有獨立的
payment-path 專用 tool，也沒有帶 discriminant 的 envelope；`RecommendPaymentPathRequest`/
`RecommendPaymentPathResponse` 只是內部呼叫路徑引擎時的契約形狀，不是額外的
public surface。

既有 flat payload（例如 amount、merchant、mcc、country、channel、paymentMethod、
asOf、routeIds、limit）只可由 compatibility adapter 轉成上述 nested body。adapter
不得補造 funding source、transition、edge evidence、fee 或 valuation；無法映射
時必須回 actionable diagnostic。

limit 的第一版 deployment default 為 20、最大值為 20；maxHops default 為
6、maxEvents default 為 4、maxBranchesPerNode default 為 8。呼叫者超過
上限要回 INVALID_INPUT，不可靜默截斷。若 deployment 另行調低上限，回應必須
帶出實際 limits 與 partial／truncated_by_bound 診斷。

### 4.3 有界生成演算法

實作順序必須符合以下步驟：

1. 驗證金額、幣別、時間與 source filters；拒絕未知 query 欄位。
2. 以 sourceFilter 篩出同一 user 的 active funding seeds。沒有 filter 時，
   以 held cards、active accounts、active wallet_balance records 及明示可用
   cash facts 生成 seed；既有 wallet balance 可以直接作 purchase 的 funding
   起點，不需要虛構一個先前 top_up，也不可把帳戶當成 card 或為非卡來源製造
   cardId。
3. 讀取 route records 與 evidence-backed edge templates。只連接 endpoint
   identity、role、market、currency 及 transition 相容的 edge；不以 provider
   名稱或品牌相似度接邊。
4. 每加入一條 edge，檢查 cycle、hop、event、branch 上限及 edge evidence。
   未完成但可解釋的 branch 放入 blocked；不得將它擴寬為任意中介。
5. 只接受以 merchant node 結束且全部必要 edge 有 evidence 的完整 graph。
6. 將完整 graph 正規化成 event plan；對每個 event 評估 event-local rules，
   再評估條款明示的 cross-event relation。
7. 依 component 的 combination policy、cap pool 與 fee/valuation facts 產生
   read-only reward projection。
8. 計算 status、diagnostics、effort 與 path signature，去除相同 signature。
9. 依第 8 節穩定排序，回傳 ready/conditional candidates，並依 include 設定
   回傳 blocked 與 no-match diagnostics。

禁止以下生成捷徑：

- 看到 PayPay 就連到所有台灣 wallet。
- 看到 card layer 就新增一個 card_authorization。
- 看到 wallet provider 就假設它接受所有 card/account。
- 看到同一 wallet 的兩筆 event 就決定哪一筆餘額先被花掉。
- 以 routeId 的文字名稱取代 graph edge 或 selector。

### 4.4 去重與完整性

Path signature 至少包含：

~~~text
specVersion
ordered (node role, stable identity)
ordered transition kind
event boundaries and funding identity
merchant identity and market
currency/conversion mode
~~~

不同 funding source、不同 transition、不同 event boundary 即使畫面品牌相同，
仍是不同 candidate。相同 signature 但不同 evidence 版本要合併 evidence 並在
衝突時回 needs_review，不能任選一筆繼續計算。

## 5. Event plan 與 wallet 語意

### 5.1 Planned event 結構

~~~typescript
interface PlannedPaymentEvent {
  planEventId: string;
  kind: "top_up" | "purchase";
  amount: Money;
  fromNodeId: string;
  toNodeId: string;
  transition: TransitionKind;
  routeEdgeIds: readonly string[];
  evidenceIds: readonly string[];
  relations?: readonly {
    type: "planned_precedes" | "planned_enables";
    eventId: string;
  }[];
  eligibility: EligibilityResult;
  rewards: readonly PlannedRewardComponent[];
}
~~~

planEventId 是候選內 correlation ID，不是 durable transaction ID，也不可拿來
寫 ledger。planned_enables 表示如果使用者按計畫執行，事件序列有明示的先後
關係；它不表示之後的 wallet purchase 一定消費了該次 top-up。

### 5.2 必須能表達的三種基本拓撲

#### A. Direct card

~~~text
funding_source(card)
  -- card_authorization/direct_settlement -->
acceptance_network? --> merchant
event plan: one purchase
~~~

發卡行 rule 只能在 transaction funding 明確是該 HeldCard 時命中。Apple Pay、
實體刷卡或其他 payment method 是否屬 direct card，仍要由 rule/edge evidence
證明，不由 UI 名稱推導。

#### B. Account → wallet → merchant

~~~text
funding_source(account)
  -- account_debit or wallet_top_up -->
wallet_balance
  -- wallet_debit -->
acceptance_network/payment_service?
  -- merchant_settlement -->
merchant
event plan: top_up (若需要) + purchase
~~~

若使用者已有 wallet balance，候選可以只含 wallet-funded purchase；若建議先從
bank account 儲值，必須有 top-up transition、top-up amount policy 與 wallet
可用證據。不能無證據假設「剛好儲值 purchase amount」或自動扣某個帳戶。

既有 wallet balance 作為 seed 時，完整圖可以從 wallet_balance 開始：

~~~text
wallet_balance --wallet_debit--> payment_service?
  --service_to_acceptance--> acceptance_network?
  --merchant_settlement--> merchant
event plan: one purchase
~~~

這個 seed 只證明目前有可用 aggregate balance；它不證明 balance 的來源，也不
建立任何 historical top_up relation。

#### C. Card → wallet → acceptance network → merchant

~~~text
funding_source(card)
  -- wallet_top_up -->
wallet_balance
  -- wallet_debit -->
acceptance_network
  -- merchant_settlement -->
merchant
event plan: top_up + purchase
~~~

信用卡的 issuer reward 只能評估 top_up event，且只有當 issuer 條款明確涵蓋
該 top-up descriptor、amount、currency 與期間才可命中。不能因 purchase 最後
在 card issuer 或 card network layer 就把 wallet purchase 改標為 direct card。

### 5.3 混合餘額與 provenance

一般 fungible wallet 只有 aggregate balance fact。候選 purchase 可評估 wallet
本身的通用優惠，但不得產生下列未被證實的關係：

~~~text
purchase E2 funded_by top_up E1 because E1 happened first
~~~

只有當 provider 回傳 source-lot allocation，或官方 campaign 要求且資料提供
了可驗證 allocation 時，才可加入 source-specific relation。否則：

- 不使用 FIFO、LIFO 或比例分攤。
- top-up reward 與 purchase reward 各自按 event facts 評估。
- 需要 source-specific provenance 的 rule 回 unknown／needs_review。
- 一般 wallet purchase rule 若不需要 provenance，仍可獨立回 ready。

## 6. Eligibility、evidence 與狀態

### 6.1 Eligibility facts

| rule 主體 | 必須驗證 | 缺少時 | 禁止推論 |
| --- | --- | --- | --- |
| card_issuer | HeldCard、CardProduct、card ID、issuer、card period、該 event funding | unknown／needs_facts | 任何 account/wallet/cash 都不是該 card |
| payment_provider | provider/app、wallet/account subtype、event transition、user enrollment（若條款要求） | unknown／needs_review | provider 品牌不代表所有 funding |
| merchant_loyalty | canonical merchant、market、會員／enrollment 與活動期間 | unknown／needs_facts | Gold 不等於商家會員 |
| member/Gold | user-scoped membership fact、program、effective window | unknown | Gold 是資格條件，不是 route node |
| cross-event campaign | event IDs、明示 relation、順序、window、count、reversal state | unknown／needs_review | 同 wallet／同 provider 不等於有因果關係 |

### 6.2 Candidate 與 component status

候選採四段狀態：

- ready：完整 graph、必要 evidence、eligibility 與 reward facts 均可計算；
  可比較金額不一定存在，valuation/fee 的未知需另列。
- conditional：路徑和 rule 可辨識，但需使用者 action、尚未完成的 enrollment、
  top-up amount policy 或其他明示前置條件。
- blocked：缺少、過期、衝突或未驗證的必要 fact/evidence；不可主張 reward。
- no_match：所有必要 facts 已知，但沒有任何適用 reward rule，或 rule 明確
  排除該 path/event。

Component 另帶 eligibility.status：
matched | no_match | unknown | needs_review | stale。candidate 不得把
unknown、needs_review、stale 轉成零元 reward。只有 rule 明示 reward 為零，
才可輸出數值零。

整體 response status 定義：

| status | 條件 |
| --- | --- |
| ok | 至少一個 ready candidate，沒有會影響主要結果的未處理阻塞 |
| partial | 有 ready candidate，同時有 conditional/blocked branch，或受 bound 截斷 |
| needs_facts | 沒有 ready，但至少一個 branch 缺 user/evidence/fx/fee/valuation fact |
| needs_review | 沒有 ready，主要原因是 evidence conflict、stacking 未知或 rule review |
| no_match | 路徑與 rule facts 都已知且明確沒有命中 |

## 7. Reward components、stacking 與 cap preview

### 7.1 Event-local 計算

每個 planned event 各自評估 active rules。至少保留：

~~~typescript
interface PlannedRewardComponent {
  eventPlanId: string;
  sponsor: string;
  componentKind: "merchant_loyalty" | "payment_provider" | "card_issuer";
  ruleId: string;
  ruleVersion: string;
  evidenceIds: readonly string[];
  nativeGross: RewardAmount;
  nativeCapped?: RewardAmount;
  capPools: readonly CapPreview[];
  combination: RewardCombinationPolicy;
  stackingAssessment: "confirmed" | "possible" | "unknown";
  status: "matched" | "no_match" | "unknown" | "needs_review" | "stale";
}
~~~

同一 top-up 與 later purchase 是不同 event、不同 eligibility evaluation。跨 event
campaign 只有在 rule 明示 relation、window、count、reversal 行為時才可使用。
不能因為它們最後都在同一 wallet 就重複發出同一 reward。

### 7.2 Stacking policy

Route compatibility 與 reward combination 是兩個不同判斷：

- route selector 決定某 event 的 graph 是否符合 route condition。
- additive、replace、best_of、exclusive、prerequisite 決定 matched components
  如何組合。

沒有下列任一明示條款時，不得自行套用一般規則：

- 同 sponsor 互斥；
- 不同 sponsor 一定可疊加；
- route 越具體就自動覆蓋通則；
- 同一 card、wallet 或 provider 的所有活動都可相加。

同一 (eventPlanId, ruleId, ruleVersion) 只能產生一個 component。相同 sponsor
與 benefit group 的多個候選必須依各 rule 的 combination policy 決定；policy
未知時 component 為 needs_review，不進入 confirmed total。

### 7.3 Shared cap preview

Cap pool 只在 rule 明示共享時共享。top-up 與 purchase 預設不同 event scope、
不同 cap consumption；campaign 可以明示跨 event/shared pool，但不能以相同
issuer、provider 或 rule prefix 推導共享。

候選的 cap 計算是 snapshot preview：

~~~text
previewRemainingBefore = current durable usage at asOf
previewConsumed = min(eligible amount/reward, remaining cap)
previewRemainingAfter = before - previewConsumed
~~~

上述結果只放在 response；planned query 不寫入 usage。若 cap period、timezone、
currency conversion 或 current usage 不可確定，component 為 unknown，不以
min(..., 0) 偽造結果。

## 8. Reward、fee、valuation 與比較排序

### 8.1 不混淆 native reward

候選回應必須保留每個 component 的 native reward vector。不可把點數、里程、
現金或不同幣別直接相加成單一 Money：

~~~typescript
interface RewardProjection {
  grossByUnit: readonly RewardAmount[];
  cappedByUnit: readonly RewardAmount[];
  valuedByComponent: readonly {
    componentId: string;
    value?: Money;
    valuationSnapshotId?: string;
    status: "known" | "unknown";
  }[];
  fees: readonly FeeAmount[];
  netValue?: Money;
  comparisonStatus: "comparable" | "unknown";
  unknownReasons: readonly string[];
}
~~~

語意如下：

- grossByUnit：各 component 尚未套 cap 的 native reward。
- cappedByUnit：依 cap preview 後的 native reward。
- valuedByComponent：使用明確、有效、scope 相符的 Reward Valuation 轉成比較
  幣別；不是模型估價。
- netValue：所有必要 component 已有 valuation 且所有必要 fee/markup/FX facts
  已知時，才可計算
  sum(capped valued rewards) - explicit user-paid fees - explicit FX markup。
- fee、valuation、FX 或 currency conversion 未知時，保留 unknown，不可當零。

netValue unknown 不會抹掉已能確認的 native reward；但在 net_value objective
下該 candidate 只能是 conditional/blocked comparison，不能以猜測數字壓過
可比較的 ready candidate。

### 8.2 確定排序

先以 status bucket 排序：

~~~text
ready > conditional > blocked(unknown/needs_review/stale) > no_match
~~~

blocked 中的未確定結果只作透明診斷，不作 confirmed recommendation。相同
bucket 內採以下 lexicographic order：

1. comparisonStatus=comparable 優先。
2. 若 objective 是 net_value 且都有值，netValue 降冪。
3. cappedByUnit 只有在 unit/currency 相同或已明確 valuation 時才比較，
   否則維持獨立欄位並標 unknown。
4. grossByUnit 在同 unit/currency 下降冪。
5. 明確且可比較的 user-paid fee 升冪。
6. evidence trust tier 與 freshness 降冪；不能以 Agent 自評 confidence 代替
   source status。
7. user effort 升冪（需做的 action 數、步驟與不可逆操作層級都要明示）。
8. canonical path signature 升冪作最後 tie-breaker。

no_match 不進入主要 ready candidate 排序；使用者要求 include.noMatch 時
才附在末端並說明「已知無適用優惠」，不輸出虛構的零 reward。

## 9. 具體路徑與證據界線

以下例子要分成「模型可驗證 fixture」與「產品資料狀態」。前者證明演算法真的
能通過多層路徑，後者才決定特定產品現在是否可用。

### 9.1 Model fixtures：必須有正向 ready 例

測試 fixture 可以建立明確標記為 model_fixture 的 edge evidence：

**Fixture ML-DIRECT-001：卡片直刷**

~~~text
Card C1 --card_authorization--> Acceptance N1 --merchant_settlement--> Merchant M1
~~~

C1 被 user 持有，card rule 是 active，merchant/method facts 與 evidence 都已知；
結果為一個 purchase event、至少一個 card issuer component、ready。這是模型
測試，不表示任一真實商店適用。

**Fixture ML-ACCOUNT-WALLET-001：帳戶儲值後錢包消費**

~~~text
Account A1 --wallet_top_up/account_debit--> Wallet W1
Wallet W1 --wallet_debit--> Acceptance N1
Acceptance N1 --merchant_settlement--> Merchant M1
~~~

A1、W1 均為同一 user 的 active facts，每一條 edge 有 fixture evidence；wallet
purchase rule 與 account top-up rule 的 owner、cap、stacking 已明示。結果必須
含 top_up + purchase 兩個 planned events，至少一個 ready candidate，且不得
依賴 cardId。

**Fixture ML-CARD-WALLET-001：信用卡儲值後經受理網路消費**

~~~text
Card C1 --wallet_top_up--> Wallet W1
Wallet W1 --wallet_debit--> Acceptance N1
Acceptance N1 --merchant_settlement--> Merchant M1
~~~

C1 的 issuer rule 明確寫出適用 wallet_top_up，W1 provider rule 明確寫出適用
wallet_debit，兩者 stacking 明示 additive；結果必須分別歸屬 top-up 與
purchase event。若拿掉 issuer top-up evidence，wallet purchase 仍可獨立 ready，
但 issuer component 必須 unknown／排除，不能改成 direct card。

這些 fixtures 的通過條件是 bounded graph 與 evaluator contract 的模型測試；
它們不構成任何 PayPay、街口、Pay+、悠遊付、銀行或卡片活動的官方證據。

### 9.2 Product-data cases：未證實就必須 unknown

**PayPay → 街口 → 聯名卡**：只有當期官方資料同時證明 PayPay acceptance、
街口 service、信用卡到街口的 wallet_top_up、街口 wallet settlement，以及
issuer 對該 top-up descriptor 的回饋時，才能產生 ready 的雙事件候選。僅看到
PayPay 或街口合作公告時，route 只能是 blocked/unknown；不能推定 direct card。

**銀行帳戶 → wallet → merchant**：若官方 edge evidence、使用者 active account
與 wallet account facts 齊全，可按 ML-ACCOUNT-WALLET-001 的拓撲評估。若只知道
wallet 品牌而不知道該銀行帳戶是否可作 top-up，缺 edge 就 blocked。

**信用卡 → wallet → acceptance network → merchant**：issuer 的一般海外消費
條款不能代替 top-up 條款。缺 top-up descriptor、currency、fee 或 settlement
證據時，保留 wallet purchase 的獨立結果，issuer component 不得計入。

**Inbound evidence 不等於 outbound**：例如研究資料只證明某 payment provider
能從海外受理網路接收入站交易，不能用來生成台灣使用者 outbound
wallet → acceptance 路徑。該 branch 必須是 unknown/needs_review，直至取得
精確方向與 transition 的當期官方 evidence。

## 10. 驗收矩陣

下表的 M 是不依賴現實產品名稱的 deterministic model fixture；D 是
production data admission／evidence contract；C 是與現有 runtime 的相容性。
兩者不得混為同一個通過證明。

> C-06～C-08 描述的「public branch」／「payment_path branch」是整合前的
> migration 階段規劃；實際 shipped 結果是 §4.2 所述的統一 `recommend`
> intent（單一 request 形狀，內部合併 candidates），沒有獨立的 payment_path
> branch 或版本後綴 adapter。這幾列保留作為歷史遷移語意的紀錄，讀者請以
> §1.2／§4.2 的現況說明為準。

| ID | 類型 | Given | When | Then |
| --- | --- | --- | --- | --- |
| M-01 | bound | 12 個 seed、每個最多 8 條 edge | 生成 candidate | 不超過 declared max branches/candidates；輸出 limits 與截斷 diagnostic |
| M-02 | bound | 含 cycle、超過 6 hops、超過 4 events 的 graph | 生成 | cycle/超限 branch 被 blocked 或丟棄；不進 ready |
| M-03 | identity | 相同品牌但 node ID、role 或 transition 不同 | 生成 | 不合併、不以 provider label 接邊 |
| M-04 | determinism | 相同 query、dataVersion、policyVersion | 重複執行 | path signature、status、排序與 diagnostics 相同 |
| M-05 | direct | ML-DIRECT-001 fixture | planned purchase | 一個 purchase event；card issuer reward 可 ready |
| M-06 | account multi-hop | ML-ACCOUNT-WALLET-001 fixture | planned purchase | top_up + purchase；至少一個 ready；無 cardId 假造 |
| M-07 | card multi-hop | ML-CARD-WALLET-001 fixture | planned purchase | top_up + purchase；issuer/provider components 分 event、按 additive 疊加 |
| M-08 | incomplete graph | wallet node 沒有 merchant settlement edge | 生成 | candidate 不得 ready；回 blocked/unknown diagnostic |
| M-09 | source isolation | user A route/account 與 user B route/account | user A 查詢 | 不出現 user B 的 node、route、account、card 或 rule scope |
| M-10 | source filter | request 指定不存在、他人或 inactive routeId | 查詢 | fail closed；不 fallback 到相似 route |
| M-11 | no FIFO | wallet balance 來自 A1、A2 混合，無 allocation | 評估 purchase | 不生成 funded_by(A1) 或 funded_by(A2)；source-specific rule unknown |
| M-12 | fungible usable | 同上，但 wallet 通用 purchase rule 不需 provenance | 評估 | 通用 wallet component 可 ready；不因缺 lot allocation 阻塞無關 rule |
| M-13 | top-up amount | top-up 觸發金額或 auto-top-up policy 缺失 | 生成 account/card → wallet | top_up plan conditional/blocked；不得猜成 purchase amount |
| M-14 | event boundary | top-up 後兩筆 purchase | 評估 | 三個獨立 plan event；不得把 top-up reward 重複套到兩筆 purchase |
| M-15 | cross-event | rule 明示 funded_by、window、count 與 reversal | 評估 event chain | 只有 relation facts 符合才命中；缺 relation 為 unknown |
| M-16 | Gold | user 有有效 Gold fact | 生成 | Gold 僅在 eligibility predicate 出現；graph node 數與 route topology 不變 |
| M-17 | issuer gate | card issuer rule，event funding 是 account/wallet | 評估 | issuer component no_match；不得把一般卡回饋移到非卡 event |
| M-18 | provider gate | wallet rule 只允許 W1 provider/subtype | 使用 W2 或不同 subtype | no_match 或 unknown（依 fact 是否完整）；不因同品牌文字命中 |
| M-19 | stacking unknown | merchant + provider + issuer 均命中但 stacking 未載明 | 組合 | candidate/component needs_review；不得自動相加 |
| M-20 | stacking explicit | 不同 owner，policy 明示 additive | 組合 | 各 component 各自保留 rule/version/unit/cap，才計 additive projection |
| M-21 | same owner | 同 sponsor 多個 rule，policy 是 best_of/replace | 組合 | 依明示 policy 選擇；不使用「更具體必覆蓋」通則 |
| M-22 | shared cap | 兩 component 明示同一 cap pool | preview | 共享 usage 計一次並保留 capPoolRef；不同 pool 不得合併 |
| M-23 | cross-event cap | top_up、purchase 無 shared-cap 條款 | preview | 各 event 使用各自 cap；不按 owner/rule prefix 推導共享 |
| M-24 | planned purity | 任一 ready/conditional planned candidate | 查詢前後讀取 store | transactions、reward ledger、components、cap usage 完全不變 |
| M-25 | native units | 現金、點數、里程並存，無 valuation | 排序 | 各 unit 分列；netValue unknown；不得變成 0 或直接相加 |
| M-26 | known valuation | 所有 component 有 scope/period 相符 valuation，fee/FX 已知 | objective=net_value | netValue 可計算且按降冪排序 |
| M-27 | unknown fee | route service fee 或 FX markup 未知且 objective=net_value | 排序 | net comparisonStatus unknown；不以零費用計算 |
| M-28 | evidence stale | edge 或 rule validTo 早於 asOf | 查詢 | 該 candidate stale/blocked；不可 ready |
| M-29 | evidence conflict | 同一 edge 有衝突 official claims | 查詢 | needs_review；不可任選較高 reward 版本 |
| M-30 | inbound/outbound | 僅有 inbound partner evidence | 生成 outbound route | blocked/unknown；不生成 ready |
| M-31 | no match | graph/evidence/facts 全知，所有 rule 明確排除 | 查詢 | status=no_match；不輸出虛構零 reward |
| C-01 | legacy recommend | 舊 card-only transaction | 呼叫現有 recommend | 行為、limit 與 card ranking 不變 |
| C-02 | v1 adapter | 現有 v1 route 無 layers 或單一 card issuer layer | 呼叫 target adapter | 可轉 direct candidate；與既有 evidence gate 一致 |
| C-03 | ambiguous adapter | 現有 layers 可串但無法推導 transitions | adapter | blocked/needs_review；不得製造 transition |
| C-04 | route identity | 舊 routeId 綁定一條 concrete route | 評估 | routeId 只作 exact constraint；不作 reusable selector |
| C-05 | fake card guard | account/wallet rule 沒有 cardId | 建立／評估 | 不要求或製造 fake cardId；card issuer 仍嚴格要求 HeldCard |
| C-06 | public branch | 統一 recommend 收到 payment_path branch | 查詢 | 走 canonical nested request；不新增版本後綴工具 |
| C-07 | flat adapter | 舊 flat amount/merchant/routeIds payload | 查詢 | 僅轉換成 canonical body；不補造 edge、evidence、fee 或 valuation |
| C-08 | branch isolation | card branch 與 payment_path branch 輸入混用未知欄位 | 查詢 | reject unknown fields；不得靜默把 flat 欄位套到另一 branch |
| D-01 | official edge | source snapshot 明示 exact from/to/transition/market | production admission | edge 可進 ready eligibility |
| D-02 | fixture isolation | evidence provenance=model_fixture | production query | fixture 不被當 official；除 model test 外不可 ready |
| D-03 | freshness | official source 在 validity window 內且 reviewState=accepted | 查詢 | freshness tier 可參與排序 |
| D-04 | user confirmation | route/account 未 confirmation | 查詢 | 只能 candidate/blocked；不得進 ready |
| D-05 | product claim | 只提供品牌合作公告，缺 funding/settlement edge | 查詢 | 不推導完整 path；diagnostic 指向缺失 edge |

## 11. 分段實作與 migration

**狀態**：以下 Phase 0～5 與「Legacy recommend 相容策略」描述的遷移路徑已經
走完；本節保留作為完成歷程的紀錄。差異之處：最終沒有走「獨立 payment_path
branch」這條路，而是把路徑候選直接併入統一 `recommend` intent 的
`candidates[]`（見 §1.2、§4.2）。閱讀本節時請把「payment_path branch」理解為
「候選是 payment_path kind 的 candidate」，不是一個獨立的公開 branch 或 tool。

本文件原是 target specification；實作分段完成，每段都有對應矩陣行通過，
不以「所有真實產品路徑都 blocked」作為多層功能完成的證明。

### Phase 0：保留舊 seam 與資料隔離

- 保留現有 card-oriented recommend、rankCards 與 record_transaction。
- 保留 PaymentRouteRecord.id 作為 concrete identity。
- 在 read-only path query 中明確帶 ownerUser、asOf、dataVersion。
- model fixture 與 production official evidence 使用不同 provenance namespace。

### Phase 1：direct-card adapter

- 把已 confirmed、active、evidence fresh 且可無歧義映射的 route 轉成一個
  direct purchase event。
- 舊 cardId rule 以 compatibility adapter 評估。
- 任何 account/cash path 不可塞入空字串或 fake cardId。
- 先通過 M-05、M-24、C-01、C-02、C-05。

### Phase 2：typed edges 與 bounded graph

- 為 route data 引入 typed transition 與 edge evidence；既有 layers 無法補證時
  保持 blocked。
- 實作 branch/hop/event bounds、cycle guard、path signature、user isolation。
- 只有 endpoint、role、transition、market、currency 全部相容才能接邊。
- 通過 M-01～M-04、M-08～M-10、D-01～D-05。

### Phase 3：top_up/purchase plan

- 將 top_up 與 purchase 建成獨立 planned events。
- 以 explicit relation 支援 cross-event eligibility；不建立 wallet lot
  allocation，除非未來另有 provider allocation evidence。
- 通過 M-06、M-07、M-11～M-15、M-24。

### Phase 4：non-card offers、stacking、caps

- 讓 payment provider、merchant loyalty、account/wallet facts 有明確 applies-to
  與 sponsor；不得延用 fake cardId。
- 分離 route selector 與 reward combination policy。
- 只按 explicit cap pool 計算 read-only preview。
- 通過 M-16～M-24。

### Phase 5：comparison 與 uncertainty-aware ranking

- 加入 native reward vectors、valuation snapshot、fee/FX facts 與 user effort。
- 實作 status bucket 與 deterministic tie-breakers。
- 通過 M-25～M-31。

### Legacy recommend 相容策略

1. 不在第一版直接改變舊 recommend 的 card-only 輸入／輸出。
2. 多層能力接入統一公開 recommend 的 payment_path branch；不新增版本後綴工具。
   既有窄版 payment-path dispatch alias 僅作內部／相容 adapter 的遷移來源。
3. 既有 cardId、ruleId、routeId 保留為 identity／exact constraint，不把它們
   升格成完整 route policy。
4. 舊 flat payload 只經 compatibility adapter 映射到 canonical payment_path
   request；不允許 flat 欄位繞過 owner、evidence 或 bounds gate。
5. OfferRuleVersion.cardId 尚為必填的舊規則照舊評估；非卡 rule 的 canonical
   target 應在未來 versioned schema 中加入，不能用假 card ID 遷移。
6. 先以 shadow evaluation 比較舊 direct-card recommendation 與 payment_path
   branch；差異只在有明確 typed route/evidence 的 candidate 才允許進入新輸出。
7. 真實事件仍走 event-scoped recording API；planned path 永遠不呼叫 ledger
   write。退款、reversal 與跨 event campaign 依實際事件 identity 另行處理。

公開 recommend 的既有 card branch 與 payment_path branch 必須由同一個 user
scope、evidence gate、limit policy 與 actionable error contract 管理，但兩者的
canonical request 不互相扁平化。card branch 的舊輸入仍可保持相容；payment_path
branch 是新多層規格的唯一 canonical public branch。

## 12. 產品資料與模型測試的明確分離

每個 acceptance report 必須標記：

- model_semantics_pass：使用 deterministic fixture，證明 graph、event、
  stacking、cap、ranking 的程式語意。
- official_data_pass：使用當期第一方 source snapshot，證明某一產品 exact edge、
  funding、settlement、reward 與有效期。
- integration_unverified：sidecar、第三方服務、真實 Chromium/支付授權或 staging
  未測試時的明確狀態。

只有 model_semantics_pass + official_data_pass + user facts pass 才能在 production
回 ready。模型 fixture 通過而官方資料缺失時，production 結果必須仍為
unknown、needs_review 或 no_match，依缺失性質區分。任何報告不得以
「品牌看起來相同」或「所有 candidate 都 blocked」宣稱多層產品路徑完成。

## 13. 未決但不可默認的問題

以下問題要由後續 domain/產品決策明示，不得在 evaluator 中猜測：

- provider 是否為每次 purchase 自動 top-up、top-up 金額與觸發時點；
- wallet balance 的 source-lot allocation 是否由 provider 提供；
- top-up refund/reversal 是否連帶追回後續 purchase 或 campaign reward；
- cap 是否跨 top-up 與 purchase event 共享；
- points/miles 的 comparison valuation 與有效期間；
- partial/split tender 的 event 邊界與各自 fee；
- 某一 Gold／會員資格是否與指定 campaign additive、replace 或 prerequisite。

在上述 facts 未明示前，採 unknown／needs_review fail-closed；不將未知條件
轉成 false、零 reward 或可疊加。
