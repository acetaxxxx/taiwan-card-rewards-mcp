# Shared MCP Process 與 FX 自動化改善計劃

**狀態**：Implemented in v0.11.0；Track A/B/C 驗收完成
**版本**：1.0.0
**範圍**：同一使用者、同一 `data-dir` 下的多 agent 共用，以及跨幣別交易的自動匯率解析

## 1. 目的

目前有兩個互相獨立、但都會影響 agent 使用體驗的問題：

1. Aion 啟動的 MCP stdio process 可能長駐。若另一個 agent 再以相同 filepath
   啟動第二個 CLI，會撞上 durable store lock；若使用 `npx`，還可能撞上共用 cache。
2. FX core 的驗證與 fail-closed 很嚴謹，但 agent 不一定會主動判斷幣對、匯率
   類型、來源或下一步，因此使用者常被迫手動指定匯率。

本計劃保留既有的資料正確性與 trust gate，將共用狀態與自動解析放到清楚的
interface/seam 後面：

- Track A：同一 filepath 只允許一個 MCP owner 持有 store，其他 agent 透過
  local bridge attach。
- Track B：agent 自動產生 FX resolution request、搜尋 approved source、選擇
  rate type；只有無法消除歧義時才詢問使用者。
- Track C：將兩條 track 接到同一份 durable provenance 與測試矩陣。

## 2. 不變的核心決策

### 2.1 filepath 是共享邊界

```text
相同 --data-dir  => 共用同一份 durable state
不同 --data-dir  => 不同 store、不同 lock、不同使用者資料
```

`--user` 不作為 tenant isolation，也不允許 agent 用 tool input 改寫
`data-dir`。目前的 user-scoped store 與 lock 語意維持不變。

### 2.2 只有 owner 開啟 durable store

相同 filepath 不代表可以同時啟動多個 CLI。第一個 process 是 owner，持有
store lock；後續 process 必須 attach 或明確回報 owner 已存在，不能再次直接
開啟 store。

### 2.3 MCP core 不做隱藏網路查詢

計算核心仍是 deterministic、可測試、無網路副作用的 module。FX retrieval
由 agent 或明確的 approved provider adapter 執行，提交後仍通過既有 pair、scope、
freshness、provenance 與 fail-closed 驗證。

## 3. Track A：Shared MCP owner 與 stdio bridge

### 3.1 目標 interface

新增一個深 module，對 caller 暴露極小的 local session interface：

```text
connect(endpoint) -> client session
request(jsonRpcMessage) -> jsonRpcResponse
close() -> void
```

owner 內部可以有 store、session registry、序列化與重啟邏輯，但 agent 不需要
知道 lock、PID 或 SQLite 細節。stdio bridge 是 adapter：把每個 agent 的 stdio
轉成 local socket session。

### 3.2 啟動與 attach 流程

```text
stdio bridge
  ├─ endpoint 可用且 handshake 成功 -> attach
  ├─ endpoint 不存在 -> 原子取得 owner lock、啟動 owner、再 attach
  ├─ endpoint 存在但 PID 已死 -> 清理 stale endpoint 後接管
  └─ endpoint 存在但 handshake 失敗 -> fail closed，不刪除未知活程序
```

endpoint 應由 `data-dir` 內的受保護路徑衍生，例如：

```text
<data-dir>/.mcp/owner.sock
<data-dir>/.mcp/owner.pid
<data-dir>/.mcp/owner.metadata.json
```

Unix socket 使用目前 OS user 可讀寫的權限。metadata 至少包含 protocol version、
owner PID、data-dir fingerprint 與啟動時間，避免錯把其他 workspace 的 endpoint
當成可 attach 的 owner。

### 3.3 多 session 行為

- 每個 agent 保留自己的 MCP initialize/session context。
- owner 共享同一份 card、ledger、current FX 與 durable settings。
- request ID 只需在各 socket session 內唯一；bridge 不重寫 caller payload。
- owner 對 store mutation 做明確序列化，read-only request 可在安全範圍內並行。
- owner 對 client 數量、request body、queue depth 設定 bounded limit；超限回傳
  可辨識的 retryable error，不讓 memory 無界增長。

### 3.4 相容性與安全

- 現有直接以 stdio 啟動 `dist/cli.js` 的模式維持不變。
- shared mode 使用 `dist/bridge.js` 或等效 launcher；bridge 對 Aion 仍呈現
  標準 stdio MCP。
- 禁止透過 tool input 切換 `data-dir` 或 user scope。
- owner crash、socket disconnect、bridge restart 都必須可重試且不得重複寫入；
  mutation 依既有 `idempotencyKey` 保護。
- 不使用未 pinned 的 `npx github:#main`；優先 pinned release 或本地 build。

### 3.5 Track A 驗收

1. 兩個 bridge 指向同一 filepath 時只有一個 owner store lock。
2. 第二個 agent 能完成 initialize、`list_cards`、read 與 mutation request。
3. 一個 agent 長駐不會阻塞後續 agent attach。
4. owner crash 後，stale endpoint 不會被誤連，下一個 bridge 可安全接管。
5. 不同 filepath 的 card、ledger、current FX 完全隔離。
6. 既有 direct-stdio 啟動與 shared mode 都通過 protocol contract tests。

## 4. Track B：FX 自動解析與低摩擦 UX

### 4.1 目標

使用者只需描述交易或付款路徑；agent 應自行完成：

1. 判斷是否需要換匯。
2. 推導 base/quote pair 與 conversion owner。
3. 判斷應使用的 rate type。
4. 查找 approved/official source。
5. 將結果轉成既有 `FxSnapshot` / `FxRateObservation` contract。
6. 只有在關鍵事實仍無法判斷時，才提出一個具體問題。

這不代表 MCP core 自己偷偷連網；它代表 agent workflow 要把現有
`query_approved_fx_source` 與 `refresh_external_data` action 真正執行起來。

### 4.2 新增的深 module interface

在 recommendation preflight 與 workflow 之間建立一個 typed seam。輸出可向後
相容地附加：

```typescript
type FxResolutionRequest = {
  baseCurrency: string;
  quoteCurrency: string;
  asOf?: string;
  transactionKind: 'planned' | 'actual';
  conversionOwner?: 'card_scheme' | 'issuer' | 'wallet' | 'merchant_dcc' | 'unknown';
  suggestedRateTypes: Array<'cash_selling' | 'spot_selling' | 'mid_market' | 'card_scheme'>;
  requiredFacts: string[];
  sourceSelectionReason: string;
  retryAction: 'query_approved_fx_source' | 'ask_user' | 'refresh_external_data';
  userQuestion?: string;
};
```

此 request 是「下一步怎麼做」的 machine-readable projection，不是匯率本身，
也不會繞過既有 FX contract。

### 4.3 Cross-currency write 的強制 ingestion 流程

`FxRateObservation` 不再是 agent 可以事後補上的旁支資料。只要 agent 準備
寫入的 transaction、payment path 或其他 typed fact 產生跨幣別換算需求，就必須
在同一個 ingestion workflow 中完成：

```text
detect cross-currency need
  -> derive pair / owner / rate type
  -> search approved source
  -> retain provenance + FxRateObservation
  -> submit domain fact + observation together
  -> MCP validates and atomically applies both
```

具體規則：

- Agent MUST 在送出跨幣別 mutation 前執行 FX resolver；不得等 MCP 回錯後才把
  搜尋視為可選步驟。
- Agent MUST 將 `provider`、`rateType`、`capturedAt`、pair、source reference
  與可取得的 content fingerprint 一起保留。
- MCP SHOULD 接受同一 mutation payload 中的 domain fact 加上 observation；
  若現有 public tool 尚未支援合併欄位，preflight/agent adapter 必須先完成
  resolver，再以既有 typed mutation 寫入，且不得宣稱已採用未寫入的 observation。
- MCP MUST 將實際套用到 transaction 的 rate 凍結為 applied-rate record；之後
  current rate 更新不得改變歷史交易或退款的計算。
- observation 寫入與 domain fact 任一方驗證失敗時，整次 mutation fail closed；
  不留下只有交易沒有匯率 provenance 的半成品。
- 缺少 observation 時，MCP 回傳 `fx_missing` 加上完整 `FxResolutionRequest`、
  `requiredFacts` 與 `retryAction`，要求 agent 先搜尋再重試。

這個 ingestion seam 的目的，是讓「搜尋、保留、採用」成為一個可測試的 deep
module，而不是把責任散落在每個 agent prompt。agent 可以選擇不同的 source
adapter，但最後都必須產生相同的 typed observation contract。

### 4.4 Rate type 選擇規則

| 情境 | 優先 rate type | 說明 |
|---|---|---|
| 已知卡組織實際換匯 | `card_scheme` | 需保留 network/provider 與適用日期 |
| 已知發卡行結算匯率 | `cash_selling` 或 issuer policy | 不可用一般中價替代 |
| 錢包先換匯再付款 | wallet/provider rate | conversion owner 是 wallet |
| 商戶動態貨幣轉換 | merchant/DCC rate | 不可誤當成卡組織匯率 |
| planned 粗估、尚未知道實際 owner | `mid_market` 或 `spot_selling` | 明確標記 estimate，不可當 actual 入帳 |

若付款路徑無法判斷 owner，agent 可以先回傳 planned estimate，但 actual
transaction 必須進入 `ask_user` 或 `needs_review`，不能自行猜測。

### 4.5 Source selection policy

source registry 應由 policy/config 維護，不把特定網站硬編碼到計算核心。每個
candidate 至少記錄：

- provider/source identity；
- pair 與 quote direction；
- captured time、effective time；
- rate type 與 conversion owner；
- source URL 或 provider reference；
- content fingerprint（若可取得）；
- freshness window 與 confidence/reason。

agent 的選擇順序是：適用 owner > pair 正確 > 日期適用 > source authority >
freshness > rate type policy。多個候選不可在 MCP 內自動平均；衝突時回
`fx_conflict` 與下一步。

### 4.6 使用者詢問策略

只有以下情況才詢問使用者：

- 無法知道實際由誰換匯；
- 交易是 actual，但只有估算匯率；
- 多個可信 provider 對同一情境衝突；
- 歷史交易缺少必要日期或卡片/錢包資訊。

問題必須是單一、可回答的問題，例如：

> 這筆交易是由商店做 DCC 換成台幣，還是由發卡行／卡組織換匯？若不確定，
> 我可以先用中價匯率做 planned estimate，但不會直接當成實際入帳匯率。

### 4.7 Track B 驗收

1. agent 從跨幣別交易自動產生正確 pair，不要求使用者手填 pair。
2. 每次跨幣別 mutation 都會先搜尋或明確回傳可執行的 `FxResolutionRequest`，
   不允許只寫入沒有 FX provenance 的交易。
3. preflight 回傳 `FxResolutionRequest` 與可執行的 retry action。
4. planned transaction 可取得明確標記的 estimate。
5. actual transaction 不會把 mid-market 或 DCC rate 靜默當成 card-scheme rate。
6. agent 取得來源後可在同一 ingestion workflow 重試 MCP，並保存 provider、rateType、capturedAt、source
   provenance。
7. 缺 owner、日期或來源衝突時，只詢問最小必要資訊。
8. MCP core 維持零隱藏網路 I/O、零 1:1 fallback、零未標記猜測。

## 5. Track C：整合與交付順序

兩條 track 可以並行，不互相阻塞：

### Phase 0：契約與觀測

- 固定 `data-dir` 是共享 key 的語意。
- 固定 owner/bridge endpoint metadata 與錯誤分類。
- 固定 `FxResolutionRequest` 的向後相容欄位。
- 為 lock、FX missing/stale/conflict/ask-user 增加可觀測事件。

### Phase 1A：Shared owner vertical slice

- 實作 owner socket、bridge、PID/metadata handshake。
- 先支援 initialize、read-only tools 與 bounded request forwarding。
- 再加入 mutation、idempotency 與 owner recovery。

### Phase 1B：FX resolution vertical slice

- 將 preflight 的 FX diagnostic 映射成 structured request。
- 更新 Agent Skill workflow，使 agent 在 mutation 前主動執行 source lookup，並把
  observation/provenance 與 domain fact 一起保留、一起提交。
- 加入 planned/actual 與 conversion owner 判斷。

### Phase 2：整合測試

- 多 bridge 同 filepath 共享同一 ledger。
- shared current FX 在不同 agent session 可見。
- 一個 agent 取得 FX provenance 後，另一個 agent 可重用已驗證結果；新交易仍
  必須留下自己的 applied-rate reference。
- owner crash/restart 不造成重複 mutation 或歷史交易匯率漂移。

### Phase 3：文件與發布

- 更新 README、Agent Skill workflow、setup/config 範例。
- 保留 direct stdio migration path。
- 以 pinned release 發布，標示 shared mode 的相容性與限制。

## 6. 不在本計劃內

- 不把不同使用者的資料合併到同一 filepath。
- 不以 `--user` 取代 OS/file/process isolation。
- 不讓 MCP core 自動抓網頁或偷偷選匯率。
- 不新增一個繞過既有 `FxSnapshot` trust gate 的公開 tool。
- 不把 planned estimate 偽裝成 actual settlement rate。
- 不在第一階段引入遠端共享 server；先限定同一台機器與同一 OS user。

## 7. 主要風險與緩解

| 風險 | 緩解 |
|---|---|
| owner 長駐但未回應 | handshake timeout、health check、明確 recovery，不直接刪未知 endpoint |
| 多 agent mutation 競爭 | owner 內序列化、bounded queue、既有 idempotency |
| socket 被其他使用者使用 | OS permission、data-dir fingerprint、local-only endpoint |
| agent 找到錯誤匯率類型 | conversion owner/rateType policy 與 provenance 強制驗證 |
| 網站來源不穩定 | source registry、provider adapter、候選來源與 retry action |
| FX 自動化又變成隱藏猜測 | request/assumption 可見化；actual 缺 owner 一律詢問或 fail closed |
| `npx` cache race | pinned tag 或本地 dist，禁止 `#main` 作 production path |

## 8. 完成定義

本計劃只有在以下條件全部滿足時才算完成：

1. 同一 filepath 的多 agent 能共享 durable state，而不產生第二個 store owner。
2. 長駐 owner 不會讓後續 agent 永久卡住；可 attach、可 health-check、可恢復。
3. FX missing 不再只回一個無法行動的 `blocked`；agent 能拿到結構化下一步。
4. agent 能在沒有使用者手填匯率的常見 planned 情境下自動查找，並將 observation
   與交易一起提交、保存 provenance。
5. actual 情境仍正確區分 card scheme、issuer、wallet、DCC 與 estimate。
6. 所有既有 fail-closed、scope、freshness、idempotency 與歷史稽核不變。
7. focused tests、full test、typecheck、build 與 `git diff --check` 通過。

## 9. 既有規格依賴

- [Agent Workspace 與 MCP Durable State Ownership 規格](../specs/agent-workspace-and-mcp-durable-state-ownership-specification.md)
- [Agent-Supplied FX Lookup、Provenance、Freshness 與 Fail-Closed 規格](../specs/agent-supplied-fx-and-fail-closed-specification.md)
- [FX Snapshot 儲存與 Current Rate 簡化政策](../specs/fx-snapshot-storage-and-current-rate-policy-specification.md)
