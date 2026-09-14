# 使用者回饋導向的優惠、付款路徑與交易歷史

Status: ready-for-agent

日期：2026-09-14

本規格依 `userFeedback/` 四個案例及後續產品討論制定。它取代研究階段中「另建輕量 Payment Journal」的提案：使用者看見且操作的唯一記帳主體是 `Transaction`，不是另一套帳本服務。

## Problem Statement

使用者目前無法可靠地將對話中的優惠更正保留下來；若優惠條款列出指定行動支付，系統也無法把清單轉成可比較的付款候選。推薦引擎雖已能從獨立 Payment Capability 建立部分暫存路徑，但 Offer Rule 尚不能以可重用的 Payment Route Selector 表達「限哪些支付服務、受理網路、資金來源與轉折」，因此使用者仍可能必須預先登記具體組合。

另一方面，交易資料已存在，卻沒有依時間區間列出歷史交易的 MCP 工具；`record_transaction` 又受限於信用卡識別，帳戶、錢包與現金支出不能用同一個自然的交易入口記錄。這使旅程回溯必須穿透資料檔，並迫使 Agent 在一般記帳與回饋事件之間選擇不同工具。

FX 也存在兩種相反的失敗：同一清算脈絡被要求重複查價，或不同清算脈絡錯誤共用匯率。Gemini 3.8 Flash Medium 需要短而明確的工具契約，才能在上述流程中穩定工作。

## Solution

MCP 對 Agent 提供一個以使用者意圖為中心的公開介面：優惠可由使用者明確確認後以私有、不可變版本啟用；優惠細則中的指定行動支付清單會成為 Payment Route Selector 的資料；推薦時將 selector、共享 Payment Capability 與使用者的 Funding Instrument 組合成暫存 Generated Route；實際支出一律以 Transaction 寫入，並用時間區間查詢歷史。

推薦、`record_transaction`、`list_transactions`、`upsert_offer` 是本功能的最高驗收縫。Reward Ledger、事件資格、Cap 與 FX 資料留在 MCP 內部作為 Transaction 的關聯結果，不要求 Agent 面對另一套記帳服務。

## User Stories

1. 作為持卡使用者，我想在確認優惠更正後立即讓自己的推薦使用新規則，以免對話壓縮後再次得到舊答案。
2. 作為持卡使用者，我想知道一筆優惠是 `user_confirmed` 還是 `official_evidence`，以便判斷信任程度。
3. 作為持卡使用者，我想撤銷或再次更正自己的優惠版本，以保留歷史而不改寫過去交易。
4. 作為使用者，我想讓自己的更正只影響自己的推薦，不污染其他使用者或公共優惠資料。
5. 作為使用者，我想讓「限指定行動支付」依細則中的完整清單判定，而不是由 Agent 猜測品牌名稱。
6. 作為使用者，我想在條款列出多個行動支付時看到每個可用支付服務產生的候選，而不是只看到其中一個。
7. 作為使用者，我想讓同一優惠在不同付款服務、受理網路或資金來源上保有正確的差異。
8. 作為使用者，我想讓推薦自動把我已持有的卡片或帳戶與可用支付能力組合，而不必先登記每一種組合。
9. 作為使用者，我想讓「卡片儲值錢包」與「卡片直接付款」被視為不同路徑，以免錯算發卡行回饋。
10. 作為使用者，我想在路徑資訊不足時看到明確待辦，而不是得到憑空推論的可用路徑。
11. 作為使用者，我想讓我的帳戶、錢包與現金支出和信用卡支出使用相同的交易記錄方式。
12. 作為使用者，我想記錄沒有回饋的現金支出，以便完整回溯旅程支出。
13. 作為使用者，我想用起訖時間直接列出交易，並按頁取得後續資料。
14. 作為使用者，我想在需要時展開一筆交易的回饋、上限、付款路徑與 FX 資料，而不是每次都收到大量細節。
15. 作為使用者，我想讓退款連結原始交易，避免重複記帳或錯誤扣回上限。
16. 作為使用者，我想讓同一 JCB 或相同清算條件的候選共用一次 FX 查詢，避免每張卡重複等待。
17. 作為使用者，我想避免卡組織匯率被套用到銀行、錢包或 DCC 清算路徑。
18. 作為 Agent，我想從 MCP 回傳的 selector、required actions 與 FX 相容條件完成流程，而不必記憶品牌專屬 SOP。
19. 作為 Agent，我想在使用者更正優惠時先展示差異並取得確認，再執行寫入。
20. 作為 Agent，我想在外部資料無法取得時停止重試，保留已知結果與缺口說明。
21. 作為系統維護者，我想保留規則版本、Transaction、Reward Component 與來源之間的可追溯關係。
22. 作為系統維護者，我想讓公開 Payment Capability 與使用者私有持有事實維持隔離。

## Implementation Decisions

1. Offer Rule 支援私有 `user_confirmed` 信任基礎。使用者提出更正後，Agent 先產生差異預覽；得到明確確認才建立新的不可變 Rule Version。官方來源可以在後續補強或提升信任基礎，但不是私有版本生效的阻塞條件。規則仍須具備明確的有效期間、回饋條件、幣別、上限與適用範圍。
2. 公共優惠與私有規則採不同可見性。使用者確認不能修改公共版本，也不能讓未驗證的資料成為其他租戶的 Payment Capability。推薦結果必須公開顯示 trust basis 與來源摘要。
3. Offer Rule 新增可重用的 Payment Route Selector，而非僅以單一具體 route ID 綁定。Selector 可限制支付服務、受理網路、資金種類、節點角色、必要 Route Transition，以及有效期間；支付服務與 App 名稱使用開放的識別值與 allowlist，不新增品牌 enum。
4. Offer ingestion 遇到「限指定行動支付」時，必須擷取細則列出的完整清單並保存為 selector 資料。若細則僅能確認一部分或使用者只確認一部分，結果必須表明涵蓋範圍，不得把未知服務視為符合。
5. 推薦會使用 Offer Rule 的 selector、Payment Capability 與目前使用者的 Held Card 或 Payment Account 建立 Generated Route。Generated Route 僅存在於 planned recommendation；一般候選不寫入 durable Payment Route Record。
6. Payment Capability 保留為可跨使用者重用的公共關係資料。Offer ingestion 可以建立或引用 capability，但不要求 Agent 為同一份細則先建立 capability、再手動複製路徑資訊至 Offer Rule。
7. Durable Payment Route Record 僅保留需要跨次使用的使用者專屬或實際觀察事實，例如已確認綁定、專屬費率、實際清算資料與使用者否決。它不是一般推薦的前置條件。
8. `record_transaction` 成為所有實際支出的單一寫入入口。Transaction 的 Funding Instrument 可為 credit card、account、wallet balance 或 cash；是否有可計算回饋不影響交易可否被記錄。每筆 Transaction 同時保留使用者提供的 `occurredAt` 與 MCP 自動寫入的 `recordedAt`；既有 idempotency 與退款關係維持適用。
9. 新增 `list_transactions` 作為單一讀取入口，至少支援起訖時間、時間依據、分頁、每頁上限、目前租戶隔離及 summary/detail 投影。預設依 `occurredAt` 查詢旅程與優惠歷史；使用者可明確改以 `recordedAt` 尋找稍後補登的紀錄。detail 投影可呈現 Reward Breakdown、Cap Usage、Payment Route 與 Applied FX；它們不是另一個 Payment Journal public domain。
10. Event-scoped reward evaluation 繼續處理 top-up、purchase、發放、兌換與沖正等回饋語意，但以交易或事件識別與 Transaction 關聯。Agent 不需為一般記帳選擇 `record_event_reward`。
11. FX Snapshot 以相容鍵重用：幣別與方向、conversion owner、conversion timing、rate type、provider 或 card scheme、以及新鮮度窗口都相同才可共用。route edge、route、card 或 issuer 的精確 scope 優先於通用 scope。
12. 不同 conversion owner、rate type、card scheme，或已過期的私人報價不得當作可用共用報價。過期資料僅能是清楚標示的 estimate；實際 Transaction 不得把 estimate 當成已結算匯率。
13. Gemini 3.8 Flash Medium 的操作文件採三層、少於 1,500 tokens 的形式：核心不變量與意圖路由；商家解析、直接推薦、使用者更正、selector 與 FX 的決策表；少量合法 payload 範例。品牌差異由資料與 MCP 回傳承載。
14. 在實作前新增或修訂決策紀錄：明確取代「無官方來源不可啟用私有規則」的假設；接受 ADR 0008 的單一 Transaction 與事件關聯方向；並補充 ADR 0007/0009，使 selector 可由 Offer Rule 驅動 planned route generation。舊 ADR 的歷史決策不刪除，而是標明被哪一份後續決策修訂。

## Testing Decisions

1. 測試以 public MCP 行為為主：驗證工具輸入、輸出、持久化結果與後續 recommendation，不直接斷言內部快取或私有函式。
2. 優惠更正測試涵蓋：未確認不寫入、確認後建立私有新版本、舊版本可稽核、撤銷或再更正不改寫歷史 Transaction、不同租戶互不影響，以及重試的冪等性。
3. Selector 測試涵蓋：條款列出多個指定支付服務時，各服務會產生或排除正確候選；未在 allowlist 的服務不符合；未知資料是 partial 或 action-required，不會被擴張為符合。
4. 路徑測試涵蓋：相同 capability 與不同 Held Card/Payment Account 的動態組合、Generated Route 不持久化、top-up 與 direct authorization 不混淆、以及使用者否決只影響自己的 durable route。
5. Transaction 測試涵蓋：card、account、wallet balance、cash 四種 funding；無回饋交易可寫入；`occurredAt` 與 `recordedAt` 的不同查詢結果、時間邊界、分頁穩定排序、detail 投影、租戶隔離、idempotency 與退款。
6. 回饋事件測試涵蓋：同一交易的回饋不重複發放、top-up 與 purchase 分開計算、跨事件資格依明確關係判定、退款使用原始 Rule Version 與 Cap context。
7. FX 測試涵蓋：相容鍵跨卡重用、精確 scope 覆蓋通用 scope、不同 conversion owner/rate type/scheme 不重用、過期降級為 estimate、以及實際記錄拒絕未確認匯率。
8. Agent workflow 測試使用真實 stdio MCP trace，涵蓋商家名稱解析與歧義處理、直接推薦、使用者確認更正、指定支付清單、跨卡 FX 重用、交易歷史查詢、分頁、外部來源失敗停止與多輪狀態保留。既有 public-contract、payment-capability、recommendation-pagination、recovery 與 agent-workflow trace 測試可作為先例。

## Out of Scope

- 銀行帳戶餘額、信用卡可用額度、預算、資產配置或一般 PFM 功能。
- 儲存 PAN、CVV、OTP、密碼、Token 或其他付款憑證。
- MCP 直接連網抓取銀行或支付服務頁面；外部取得仍由 Agent 或 Host 負責。
- 將使用者確認的私有優惠自動發布為公共、官方驗證的優惠資料。
- 以品牌名稱推測支付相容性、資金來源、清算匯率或回饋可疊加性。
- 修改既有歷史 Transaction 的已套用規則、FX 或回饋結果；後續更正以新版本或明確調整紀錄處理。

## Further Notes

- ADR 0007 與 ADR 0009 的 provider-neutral route graph、Payment Capability 與 Generated Route 原則可保留；本規格要求補齊其尚未落實的 Offer Rule selector 與 ingestion 連結。
- ADR 0008 已描述事件生命週期的目標模型，但仍是 Proposed。此規格要求在實作前將其與單一 Transaction public surface 的關係正式定案。
- ADR 0001 與 ADR 0003 的來源治理仍保留可追溯性與 deterministic evaluation；需修訂的只是「官方來源是私有 user-confirmed 規則唯一啟用門檻」這個假設。
- 本規格不宣布任何功能已存在。現有工具數量、舊文件與 runtime 行為可能與此目標不同，實作時須同時遷移公開契約、Agent 指引與驗收測試。
