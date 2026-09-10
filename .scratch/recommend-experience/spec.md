# 以消費意圖為入口的推薦流程

Status: needs-triage

日期：2026-09-10

本文件是依目前程式與文件整理的改善提案，尚未實作，也不代表現有 MCP 接受下列新 payload。目標是讓使用者說出想在哪裡消費，Agent 就能取得完整付款路徑、可套用規則與必要追問。

Agent 執行登記、推薦、匯率更新或完整優惠探索時，目標步驟與完成標準集中於 [Agent workflow](agent-workflow.md)。實作新版工具時須同步遷移 canonical skill、usage guide 與範例，不能只改 API。

## 1. 問題與現況證據

目前 Interface 要求呼叫者理解過多內部步驟。依 codebase-design 的原則，推薦 Module 應把候選探索、資料讀取與條件檢查放在 Implementation，讓 Agent 面對小而完整的 Interface。

| 現況 | 原始碼／文件 | 使用體驗問題 |
| --- | --- | --- |
| 指示推薦前先 `list_cards` | `src/mcp-contract.ts` 的 server instructions | MCP 已持有的資料仍要求 Agent 查詢、再編排 |
| `recommend` 的 `cardId`、`cardIds` 都不是必填；未指定 `cardIds` 時讀取 store 全部卡片 | `recommendationTransaction` schema；`src/service.ts` 的 `recommend` | 範例帶入 cardId，造成必須先選卡才能推薦卡的錯覺 |
| preflight 與 recommend 是兩個 public tools，分別執行 | `src/cli.ts` dispatcher | Agent 要記呼叫順序與重試條件，recommend 本身沒有統一回復流程 |
| preflight 收 transaction；payment path 收另一種 envelope | `src/mcp-contract.ts` | 不是同一個消費意圖貫穿檢查與推薦 |
| preflight 在沒有選定 card 時掃描所有 active rules，最後聚合成單一 ready | `preflightRecommendation` | 可能因與可用候選無關的資料缺失，要求額外補資料 |
| path service 自行列出使用者路徑，但範例要求先 list accounts/routes 並指定 routeIds | `recommendPaymentPaths`；skill workflow | 把尋找付款方式的工作交回 Agent |
| path service 目前只考慮已登記、active、confirmed 且證據符合門檻的路徑 | `recommendPaymentPaths` | 沒有登記不等於商家不能用，但容易只看到空結果 |
| public payment_path dispatcher 沒傳 eligibilityFacts | `src/cli.ts`；usage guide | schema 與 runtime 不一致，額外增加 Agent 判斷成本 |

因此，問題同時包含文件誤導與工具設計；只縮短操作說明不足以解決。

## 2. 目標體驗

正常流程只有：

1. 使用者提供商家，以及已知的金額、幣別、國家或線上／實體情境。
2. Agent 呼叫 `recommend`。
3. MCP 自動讀取使用者資料、解析商家、建立候選付款路徑、選規則、檢查缺項並計算。
4. 有可用結果就展示；需要外部資料或使用者回答時，依結構化 action 補齊，再呼叫同一個 `recommend`。

卡片、帳戶、路徑及權益狀態的 list tools 是管理或明確查詢用途，不是每次推薦的必經步驟。第一次使用缺少持卡／帳戶資料時，才進入 onboarding。

只提供商家也可以開始：回傳候選路徑、規則條件和必要問題；沒有金額時不能宣稱已算出最佳淨回饋。提供金額與幣別後才能處理門檻、上限與數值比較。

## 3. 建議輸入契約

以下為新介面草案，欄位須在實作時納入正式 schema：

```json
{
  "merchant": { "name": "示例商家", "country": "JP" },
  "amount": { "amountMinor": 10000, "currency": "JPY" },
  "channel": "in_store"
}
```

- 必填只有商家識別輸入；商家名稱歧義以候選與追問回傳，不要求 Agent 先取得 canonical ID。
- amount 可省略以探索；一旦提供，minor units 與 currency 必須一起提供，不默認 TWD。
- 推薦固定是 planned purchase，不讓 Agent 每次填 kind/mode，也不在此寫 ledger。
- 未指定時間代表本次評估時間，回傳 evaluatedAt；未來消費可指定 occurredAt。涉及本地日期的規則仍使用明確的 Timezone Authority，不能從執行環境猜時區。
- cardIds、routeIds 只保留為可選限制，使用者說「只比較這兩張」才指定；ruleId 不由 Agent 選。
- 補資料使用同一 request 加上有型別的 facts/evidence；不接受任意 context 覆寫 store 的持有關係或可信度。
- FX 需能依路徑／轉換步驟描述多組匯率，不能假定所有付款方式共用一筆 transaction.fx。

## 4. 回傳完整付款方式，而非先分選卡／選路徑

所有候選使用同一結構：直接刷卡是最短 Payment Route；錢包付款、帳戶扣款、儲值後付款是具有不同 Route Transitions 的候選。

每個候選至少包含：

- 可讀的付款步驟與 Funding Instrument，例如「以 A 卡在商家直接刷卡」或「由 B 帳戶儲值 W 錢包，再付款」。這些只是結構示意，不是已驗證的實際品牌路徑。
- 是否立即可用、仍缺哪些條件，以及相關 action IDs。
- 各層 Reward Components、matched rules 的 ID／版本／來源與有效期間、排除原因、Reward Cap 餘額。
- 原生回饋單位、費用、估值依據與可計算的淨值；未知值不填 0。
- Stacking Assessment。possible 與 confirmed 分開呈現，不把機會估計說成保證；維持 ADR 0005 的既有政策。
- 排序依據與資料覆蓋範圍，例如「目前已知可用路徑中的排序」，不宣稱涵蓋市場所有支付方式。

建議頂層用 `status`、`candidates`、`requiredActions`、`coverage`、`evaluatedAt`：

| status（新提案） | 意義 |
| --- | --- |
| ready | 已找到可計算候選，且本次範圍內沒有影響比較的待補項目 |
| partial | 有可用或明確標示的估算結果，也有尚待補資料的候選；排序可能隨補件改變 |
| needs_input | 只有探索結果或沒有可確認結果，需要補資料 |
| no_match | 足夠證據判定已評估範圍無符合路徑；不是空資料庫的替代訊號 |

candidate 仍保留 unknown／stale／needs_review 等精確狀態；頂層狀態不取代 Calculation Trust Gate。coverage 應包含候選探索是否截斷、資料缺口及分頁資訊。

## 5. 將 preflight 收進推薦內部

共用流程：normalize intent → load user state → resolve merchant → discover candidates → inspect candidate requirements → evaluate ready/estimable candidates → return results and actions。

不要把目前 `preflightRecommendation` 原封不動放到 recommend 最前面，遇到 ready=false 就整批拒絕。需求檢查必須與實際候選及規則匹配共用邏輯，且依候選隔離：某條外幣路徑缺匯率，不影響其他可計算路徑；商家專屬優惠未解析，不應阻擋不依賴商家的基本回饋。

`recommendation_preflight` 可先保留為相容入口，呼叫同一內部流程的診斷模式；新版 Agent 正常流程不需要它。待相容遷移完成，再移除 public tool，避免兩套檢查逐漸分歧。

## 6. 缺項回復必須可直接執行

每個 required action 應包含穩定識別、code、owner（agent/user）、受影響候選、requiredFacts、補回欄位與完成條件。同一缺項去重，補件後重新驗證，不接受 Agent 宣告已通過。

| 缺項 | 處理方式 |
| --- | --- |
| 匯率缺失或過期 | Agent 依指定幣別對、provider／rateType、時間及 freshness 要求查外部來源，帶回 snapshot 再 recommend |
| 商家名稱有歧義 | MCP 回傳有界候選；Agent 問市場／分店等有辨識力的問題 |
| 金額或幣別未知 | 顯示探索候選，問消費金額／幣別，不提供確定淨值排序 |
| 不知道持有卡片／錢包 | 進入一次性的資料登記；不是要求使用者先選出推薦目標 |
| 帳戶綁定、活動登記未知 | 詢問使用者，只影響相關候選 |
| 優惠或受理證據過期 | Agent 查官方資料，經現有 ingestion／confirmation 流程更新後重試 |
| 已明確不符合條件 | 列出 exclusion，不反覆要求使用者補不可能改變結論的資料 |

MCP 本次設計維持零網路；「自動處理」指內部讀取與判定，以及告訴 Agent 查什麼，不代表 MCP 自行上網。無法取得資料時保留 partial/unknown，不無限重試。使用者只看到有助決策的問題，不需要接觸 cardId、routeId 或 FX payload。

## 7. 路徑探索不能只是重新包裝現有清單

短期可先自動使用現有已登記路徑，但必須明示 coverage，並把缺少路徑資料轉成 action。這能簡化呼叫，尚未完全達成「給商家就找出整套支付方法」。

完整版本需從有證據的受理關係、支付服務／資金來源相容性，加上使用者已持有的工具建立候選。共同支付能力與使用者自己的綁定／持有事實分開；可從已驗證關係組合暫存 planned 路徑，不必要求 Agent 先把每個組合 upsert 成 durable route。

不能從品牌名猜測可串接關係，也不能推定錢包餘額來源或把 top-up 當成 purchase。尚需開通／綁定的路徑放在 Action-Required 候選。此項會擴大目前僅已登記 route 的探索範圍，實作前應正式記錄資料所有權與候選生成決策。

## 8. 文件整理與實作順序

1. 修正現況文件：cardIds 選填、MCP 自動讀卡，移除不必要的「必須先 list」指示。同步 server instructions、usage guide、skill workflow/examples，避免文字各說各話。
2. 實作統一消費意圖契約、候選級 requirements 與 recommend 回復結果；保留舊輸入 adapter，並補齊 CLI/schema/service parity。不要只在 public schema 換名字。
3. 統一卡片與多層付款的結果模型，加入資料覆蓋與探索截斷說明；完成有證據的路徑探索。
4. 以新流程重寫快速入門；preflight 標示為 legacy，低階 calculate/rank、管理、證據匯入與實際交易記錄移到進階章節。

現有契約改動完成前，不能把目標流程寫成已可執行的使用指南。本次先新增此提案及文件索引，不更動 runtime 或已接受 ADR。

## 9. 驗收情境

- 使用者已有卡片／路徑：不先 list、不帶 cardId，單次 recommend 能回完整候選與規則。
- 只有商家：回探索結果與必要問題，不因缺少 transaction 樣板直接 schema rejection。
- 商家＋金額＋幣別：同一結果中包含直接刷卡和其他已證實付款路徑。
- 某路徑缺 FX：回精確 action；其他可用路徑仍可展示；補回 snapshot 後用同一入口重新評估。
- 商家歧義或無專屬優惠：只擋依賴該條件的規則，不把基本回饋全擋住。
- 空 store／沒有路徑證據：回 onboarding／research action，不謊稱商家無優惠或不支援付款。
- 多種結算幣別與 provider：分別要求對應 FX，不讓一筆快照套用全部路徑。
- 無法判定 stacking、費用或資金來源：保留不確定性，不混進確定總回饋。
- 同一需求經 public MCP 呼叫與 service 得到一致語意，包含 eligibilityFacts 與 action payload。
- 所有探索、診斷、重試均不消耗 cap、不寫交易、不自動啟用未確認規則。

## 10. 參考與決策範圍

依據 `src/mcp-contract.ts`、`src/cli.ts`、`src/service.ts`、`docs/agents/usage-guide.md`、`docs/agents/taiwan-card-rewards-skill/workflows/preflight-and-required-actions.md` 及 `CONTEXT.md`。

維持 ADR 0001 的計算／Agent 研究分工、ADR 0005 的 opportunity stacking、ADR 0007 的有證據路徑語意。工具入口整合與暫存候選生成是提案；未在本次改寫領域定義或宣布新 ADR 已接受。

## 11. 匯率：先估算，同時要求更新

### 查詢要求與回填資料（核可拆票補充）

MCP 回傳 `fxResolutionRequest`（待查要求），Agent 查完提交 `fxObservation`（已取得報價）；已有舊 observation 時可一併回傳供理解估算依據，但不能把缺報價的要求偽裝為 observation。要求須包含來源 URL、用途（政策研究／路徑報價／公共參考）、pair、rateType／買賣方向、scope、目標時間、freshness、requiredFields 與實際可用的提交入口。政策來源未知時明示需發現官方條款，不捏造銀行 URL。

預設公共參考入口：[臺灣銀行牌告匯率](https://rate.bot.com.tw/xrt?Lang=zh-TW)（2026-09-10 確認）。由 Agent 重新取得頁面，讀取掛牌時間與即期欄位；頁面資料不會自動隨後續異動更新，且官方標示僅供參考。缺少該幣別即期報價時回 unavailable，不以現金欄位替代。此入口供參考估算，不替代銀行／錢包換匯政策研究。

多路徑推薦包含「同時比較不同完整路徑」及「每條路徑的多層優惠」。已登記路徑先支援同一商家下直接刷卡、錢包、帳戶資金路徑的比較；後續再從已驗證關係生成新組合。每條路徑保留商家／支付服務／發卡行 Reward Components、規則版本、可疊加／互斥條件及個別換匯成本，不能退化為只回卡片排名。

依使用者追加需求，planned recommendation 支援參考匯率估算。匯率缺失不移除可能適用的優惠，也不阻擋整批候選；可以算的部分先算，並要求 Agent 更新。這是對既有「過期 FX 不產生可信計算」的明確擴充：估算另外標示，不把 stale 改成 ok，也不放寬實際交易記錄門檻。

### 11.1 換匯政策與匯率數值分開保存

換匯政策是相對穩定、具版本與來源的資料：適用產品／路徑／轉換步驟、conversion owner、幣別對、報價種類與方向、換匯時點、加價／手續費及其計算基礎、官方查詢來源。當日匯率是有時間戳與適用 scope 的 observation，不應寫死在優惠規則裡。

卡片／優惠／路徑 ingestion 回應必須檢查相關政策是否已有資料。涉及換匯而政策缺漏時，保存可接受的候選資料，同時回 `research_fx_policy` action，明列需查來源與需補欄位；不能只靠 skill 提醒 Agent 自發研究。政策可由多張卡與多筆優惠引用，不要求每筆重複提交。若 Agent 忽略 action，後續 recommend 仍會回傳該缺項，候選維持 reference estimate。

銀行提供的換匯政策不等於當下報價；未知換匯時點、DCC 或費用也不能靠一個參考匯率補成確定事實。現有 `src/fx.ts` 會依 owner 建議 rateType，屬既有程式行為，不足以取代逐來源驗證的政策。

### 11.2 選擇與降級規則

先硬性驗證幣別對、provider、政策版本與 issuer/card scope 的適用性，再比較新鮮度。不能因其他卡的報價較新就套用。

1. 使用符合該路徑政策、仍有效的新鮮報價。
2. 若沒有，使用同政策最近一次可信報價，且必須在可設定的 `maxEstimateAge` 內；標示 `stale_estimate` 並要求 refresh。
3. 若仍沒有，使用可信公共參考報價；預設參考來源提議為臺灣銀行即期報價，標示 `reference_estimate`。本文件未查詢即時價格，也不宣稱它就是任何卡片或錢包實際結算匯率。
4. 連有時效限制的參考報價都沒有時，保留候選、規則與能計算的原幣回饋，換算值為 unknown；不硬編一個預設數字。

第二與第三順位受年齡政策限制；非常舊的路徑報價不可永遠優先於新參考報價。每種 provider policy 應明定 `freshFor`、`maxEstimateAge`，未配置的 stale 值不得無限沿用。參考資料本身也要有 source timestamp、取得時間及有效性檢查。

「臺銀即期」必須明確定義買入／賣出、原始報價方向及來源單位，再正規化；不能混用現金匯率、中價或反向報價。跨幣別換算若需交叉匯率，保留每一段來源與時間，整段均屬參考估算。

### 11.3 不同路徑分別估算成本與回饋

每個候選保留 `fxBasis`（policy_current / stale_estimate / reference_estimate / unavailable）、`fxAsOf`、provider、policy reference、各轉換步驟採用的 rate、assumptions 與 refresh action IDs。即使報價新鮮，未來入帳金額仍是 planned estimate。

先依各路徑換算實際回饋基礎，再套用門檻、rounding、cap 與 stacking；不能只在最後把回饋換成台幣。比較同一 comparison currency 的預估總支出、費用與回饋後淨支出，而非只比回饋百分比；同一費用不得在匯率加價與獨立 fee 重複計算。

已知費用依政策計算；未知費用保留 unknown。必要時只能顯示「已知成本的小計」，不能當完整淨支出排序。參考匯率只允許估算金額，不讓未證實的受理關係、資格或 stacking 變成 matched。

估算與政策匹配結果分組顯示，排序標示 provisional。若比較對匯率敏感，回傳排序可能改變；可提供明確假設下的敏感度情境，但不可自行編造誤差區間或保證名次穩定。

### 11.4 更新循環與保存

recommend 讀現有 cache、先回結果與去重後的 `refresh_fx` actions。action 指定 policy／provider、幣別對、rateType、scope、目標時間、新鮮度、受影響候選與補交欄位。共用同一報價的路徑只要求查一次，不受第一頁 10 筆限制；大量 actions 可另行分頁並回完整計數。

Agent 取得 observations 後，可在下次 recommend 的 typed evidence 中傳入供本次重算。若要供下次使用，另設明確的 FX observation upsert 寫入入口；recommend 本身保持 read-only。寫入入口與 schema 尚需實作，不能假定現有工具已能保存。報價更新後重新計算門檻、成本、回饋與排序，不能只換顯示數字。

只靠 Agent 的工具呼叫無法保證定時更新。基本版是按需 refresh；若要接近即時，另由 MCP 外的排程／approved provider adapter 更新 public FX cache，recommend 仍只讀資料。外部更新器是後續部署工作，不是本次文件變更已啟用的能力。

「其他人的匯率」只允許重用經驗證的公共來源 observation，不讀其他 tenant 的交易、個人報價、帳戶或結算紀錄。公開 cache 需獨立於私人 store，保留來源與驗證流程；使用者提交的資料不能直接取得 shared trusted 身分。尚未建立共享來源時只用本地可信 cache。公共 cache 的 key 應包含 provider／政策、pair、rateType 與必要 scope，避免不同路徑報價互相覆蓋；此點需修訂既有 current-rate spec 的 pair/type 簡化政策。

### 11.5 追加驗收

- 舊但仍可估算的匯率：立即回估算＋refresh action，不刪除相關候選。
- 沒有路徑報價但有公共參考：回 reference estimate，保留政策／費用缺項。
- 補入新匯率後跨過門檻或 cap：重算並允許排序變更。
- 未知費用、政策、資格不因 reference estimate 變成可信匹配。
- 錯誤 scope、過老報價或其他 tenant 私人資料不可成為 fallback。
- actual recording 不接受把 reference/stale estimate 當作已確認入帳匯率。

## 12. 全部可能優惠可取得，預設每頁 10 筆

10 是 page size，不是候選總數或探索上限。推薦要保留目前資料範圍內所有可能適用的優惠：可確認、估算、需登記／切換、缺 facts 或需更新來源的候選都能翻頁取得。已明確不符合的優惠可列 exclusions，不混入可用推薦；資料庫完全未知的優惠則以 coverage 說明，不能宣稱市場全收錄。

每個付款路徑列出 matched 與 potentially applicable rules，明示不能同時套用的組合。路徑內規則太多時也須能繼續取完，不能只保留最高回饋規則。候選展示去重不等於把互斥優惠加總。

建議回傳 `pageSize: 10`、`nextCursor`、`hasMore`、`resultVersion` 與可取得的 total；完整集合尚未探索完時，回 discoveredCount 與 explorationComplete=false，不把它稱為最終 total。

必須移除「先取前 20 再分頁」或「探索到 limit 就停止且無法續查」的實作方式。資源限制仍可保留，但需能 continuation；因 hops 等模型限制無法繼續時，明示 excluded scope，不能稱為完整探索。

分頁綁定相同 intent 與資料／匯率版本，採穩定排序與 tie-breaker；更新匯率後產生新 resultVersion 並重啟分頁，不把新排序接在舊 cursor 後面造成遺漏或重複。無法重現舊版本時明確要求 restart。

驗收至少涵蓋超過 20 個候選及單一路徑超過 10 個優惠：逐頁可取完、不重複、不漏列，缺 FX 的候選也在集合內。預設先展示 10 筆與總量／尚有更多的提示，不要求一次把所有結果塞進對話。
