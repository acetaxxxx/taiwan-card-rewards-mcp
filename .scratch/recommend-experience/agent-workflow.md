# Agent workflow：登記、推薦、匯率更新與完整優惠探索

Status: needs-triage

這是[推薦體驗改善提案](spec.md)的目標操作流程，尚未實作。供實作者與 Agent skill 作者使用；現行部署仍以實際 MCP handshake、tools/list schema 與回應為準。`refresh_fx`、`research_fx_policy` 是提案中的 action codes，不是可直接呼叫的工具名稱。新的 FX／政策保存入口尚待定義。

## 1. 啟動與能力確認

1. 讀取 MCP 公布的工具契約，確認 recommend 支援的輸入、估算結果、requiredActions、分頁與補件方式。
2. 若支援新版契約，依以下流程操作。若只有舊版，依已公布 schema 呼叫，清楚回報尚不支援參考匯率估算／完整分頁等能力。
3. 以工具回傳為計算依據；新版功能缺失時不能由 Agent 自算回饋補成 MCP 結果。

完成標準：每個工具呼叫與補交欄位都有實際 schema 支持。能力確認在連線或版本改變時執行，不要求每次推薦重新掃描全部工具。

## 2. 使用者新增卡片、優惠或付款方式

觸發：使用者要求新增，或 recommend 明確回傳持有資料／相關政策缺失。

1. 確認產品與必要持有事實；使用管理工具查重並登記。卡片 ID、路徑 ID 由 MCP 契約管理，使用者只需說產品名稱與持有／綁定情況。
2. 主動查官方產品條款、優惠條款及相關 FAQ。涉及外幣時，同時查換匯政策：換匯方、rateType、換匯時點、加價、手續費及計算基礎、可取得報價的來源。
3. 將優惠 Rule Version、換匯政策、當期 FX observation 分開準備。重用已有且仍有效的政策引用，避免同產品每筆優惠重複研究。
4. 透過當前可用 ingestion 工具提交 typed facts、來源、觀察時間與有效期間；候選啟用依既有 confirmation 契約處理。只把來源支持的內容寫成已知政策。
5. 檢查寫入回應的 status 和 requiredActions。研究型 action 由 Agent 繼續查；持有、綁定、會員、活動登記等使用者事實才詢問使用者。
6. 官方來源仍未提供的條件，保留 unknown 與已查來源；讓推薦繼續以適當可信度處理。

完成標準：登記結果經工具確認；相關換匯政策已保存並可引用，或明確列為未解缺項。只說「已新增卡片」不等於已完成優惠與換匯政策建檔。

## 3. 使用者詢問在哪裡怎麼付最划算

觸發：商家推薦、預計消費、比較付款方式。

1. 從對話取商家及已知金額、幣別、國家、通路、消費時間與限制。先用已知資訊呼叫 recommend；只提供商家時進入探索。
2. 讓 MCP 讀取持卡、帳戶、權益與路徑；只有管理、查重或使用者明確要求限制候選時才查清單。正常推薦不先選 cardId、routeId、ruleId。
3. 讀取 candidates、status、requiredActions、coverage、resultVersion 與 nextCursor。確認各候選是政策匹配試算、舊匯率估算、公共參考估算，還是缺資料。
4. 先展示可用的第一頁（預設 10 筆）：付款步驟、可套用優惠、預估支出／回饋、主要前提，以及匯率來源與時間。金額未知時只展示路徑與規則條件。
5. 有可執行的 Agent actions 時，先告知「目前是參考估算，正在更新相關匯率」，接著執行第 4 節；不能展示初估後就把可處理的 refresh action 當成完成。

完成標準：使用者已有可理解的選項或必要問題；所有缺項已分派到 Agent 研究、使用者事實或明確的外部阻礙。第一頁不是全體優惠。

## 4. 缺項與匯率更新循環

MCP 的 `fxResolutionRequest` 是查詢要求，`fxObservation` 是 Agent 查完回填的報價；先讀要求中的 source URLs、用途、requiredFields 與提交入口。公共參考預設可查 [臺灣銀行牌告匯率](https://rate.bot.com.tw/xrt?Lang=zh-TW)，重新取得頁面並讀掛牌時間、即期欄位及買賣方向；即期欄位缺值就回報不可用。銀行／錢包政策研究仍使用對應官方條款，不能以臺銀報價替代。

1. 按 action 的 provider／policy、pair、rateType、scope 與目標時間去重。掌握整個結果集合的缺項（actions 分頁時可續取），優先更新影響目前決策的報價。一般查詢不必等全部候選更新完；要求全面比較時再擴大處理，未更新候選保留估算與 action。
2. 對 `refresh_fx`：依指定來源取得 observation，保存來源發布時間與取得時間，核對買賣方向、報價單位、幣別對、適用範圍及 freshness。一般官方資料研究在已授權瀏覽能力內直接執行。
3. 對 `research_fx_policy`／來源更新：取得官方條款並走 ingestion；資料矛盾保留 conflict，讓 MCP 判定。登入後個人報價等無法自行取得的資料，才向使用者提出具體問題。
4. 透過已公布的 observation 寫入入口保存可重用報價並檢查成功回應；新版 recommend 也可接受本次 typed evidence。若僅用於本次試算，明示尚未持久化，不宣稱下次會自動使用。
5. 將原消費意圖與新增 facts/evidence 再送 recommend。由 MCP 重算換匯基礎、費用、門檻、cap 與排序。
6. 比較新舊結果。若付款方式排序或回饋改變，向使用者說明；新 resultVersion 從第一頁開始，舊 cursor 作廢。
7. 同一 action 在沒有新 evidence／使用者回答時不重送。遇到來源不可用、資料衝突或不可支援的條件，回報已完成部分與具體缺口，保留估算標記。

完成標準：本次決策範圍內可取得的必要新資料已經過 MCP 驗證並重算；其餘 action 標示尚未處理或具體阻礙。工具呼叫成功不等於報價適用，也不代表未來實際入帳金額已確定。

## 5. 顯示更多或全部優惠

- 預設展示第一頁 10 筆，附 hasMore／已知總量及資料覆蓋範圍。所有可能優惠仍可繼續取得。
- 使用者要更多：沿同 resultVersion 的 nextCursor 取下一頁。
- 使用者要全部：持續翻頁至 hasMore=false，並取得路徑內尚未展開的優惠頁；依候選／規則識別去重呈現，保留 mutually exclusive 與 action-required 條件。
- 若探索未完成或因模型範圍限制截斷，說明未涵蓋範圍；結果總數未知就回已發現數量，不稱為全部市場優惠。
- 若資料版本改變，重啟該查詢，避免把不同排序的頁面混合。

完成標準：一般查詢交付一頁與繼續入口；「全部」查詢取完可續查頁面並交代 coverage。符合條件的優惠不因回饋較低或缺匯率而在探索階段被截掉。

## 6. 使用者看到的回應

順序固定為：付款方式與操作步驟 → 適用優惠與預估效果 → 估算／確定條件 → 下一步。

示意（不是實際優惠）：

> 目前先列出 10 個付款選項，還有後續優惠可看。其中部分用參考匯率估算；我會更新對應付款服務的報價後再比較。A 方案仍需確認活動登記，B 方案的費用尚未查到，因此目前不能確定哪個總支出最低。

只詢問會影響候選的使用者事實，例如「你是否已完成這個活動登記？」；由 Agent 處理官方匯率、政策與來源查詢。向使用者呈現產品名、時間與實際操作，不要求其填寫 FX JSON 或內部 ID。

完成標準：使用者能區分立即可用、參考估算與待完成條件；沒有把估算說成保證，也沒有把所有研究工作轉交使用者。

## 7. 推薦後的交易

推薦、翻頁、補資料重算均維持 planned/read-only。使用者明確要求記錄實際交易時，另走記帳 workflow，確認實際事件、結算事實與 idempotency；reference/stale estimate 不自動成為實際入帳資料。交易結果以記帳工具回應確認。

## 8. 文件落地與驗證

實作新版契約時，把本流程移入 canonical skill bundle 的 recommendation workflow，其他文件以觸發條件連結它，維持單一操作來源。

| 文件 | 必須同步的內容 |
| --- | --- |
| `src/mcp-contract.ts` instructions/descriptions | recommend 正常入口；回傳 actions 的處理責任；10 是 page size |
| `docs/agents/usage-guide.md` | 新版能力與 workflow 入口；planned／記帳分工 |
| skill `SKILL.md` router | 登記、推薦、FX recovery、更多／全部各分支指向同一流程 |
| skill workflow、playbook、examples | 使用實際 schema 的首次推薦、估算、補件重算、完整分頁範例 |
| authoring guide、template、舊 preflight SOP | 改引用 canonical workflow；舊契約標記適用版本或遷移說明 |

以 Agent 呼叫軌跡驗證：已有持卡資料時直接 recommend；FX action 後確實查來源、提交並重算；新增外幣產品確實查政策或記錄缺口；要求全部時確實續頁；來源失敗時保留估算並停止無效重試。僅檢查文案或 schema 通過不足以驗收 workflow。
