# Agent Workspace 與 MCP Durable State Ownership 規格

**狀態**：Target normative specification，待獨立 Review
**版本**：0.1.0
**語言**：繁體中文

## 1. 核心決策

Agent workspace 與 MCP durable state 是兩種不同生命週期與信任層級的資料：

- Agent workspace 保存可重做、可審閱的原始研究材料。
- MCP durable state 只保存經 typed contract 驗證、會影響計算或帳本的資料。
- MCP 不把 data directory 或原始檔案 path 暴露給 Agent，也不允許 Agent 直接
  修改 durable JSON。

## 2. Ownership Matrix

| 資料 | Agent workspace | MCP durable state |
|---|---:|---:|
| 銀行 PDF、HTML、截圖、OCR 原文 | 保存原件 | 保存 reference/fingerprint，必要時保存最小 excerpt |
| FX provider response | 可保存原始 response | 保存採用的 typed snapshot 與 provenance |
| Merchant research notes | 可保存草稿 | 只保存已確認 canonical fact，不保存 Agent alias 推論 |
| Offer source snapshot | 可先保存候選原文 | 保存驗證後的 snapshot metadata 與版本 |
| Offer Rule Version | 不作 authoritative ledger | 保存 candidate/active/stale 與版本 |
| Card、Held Card、Eligibility | 對話暫存 | 保存 user-scoped typed facts |
| Recorded Purchase、Refund、cap usage | 不作權威記錄 | 保存完整帳本與計算 trace |

## 3. Ingestion Boundary

所有進入 MCP 的資料都必須通過 typed mutation 或正式 input contract：

1. Agent 讀取或整理外部資料。
2. Agent 保留 raw evidence 與來源引用。
3. Agent 將候選資料轉成 typed payload。
4. MCP 驗證 schema、scope、時間、provenance、版本與 domain invariants。
5. 只有通過 trust gate 的資料才能成為 active rule 或 durable ledger fact。

`upsert_offer` 可以接收候選 snapshot；候選必須經來源與使用者確認後才可
啟用。FX snapshot 可作為 calculation observation；只有實際被 durable
transaction 採用時才必須寫入稽核記錄。

## 4. ID、Fingerprint 與冪等

- MCP 為 persisted snapshot、rule record 與 audit record 生成 authoritative
  UUID/ULID。
- Agent supplied reference 只能是 correlation metadata。
- `idempotencyKey` 標識一次 user-scoped mutation。
- MCP 對 canonical payload 生成 fingerprint，避免相同重試產生重複 record。
- 同一 idempotency key 搭配不同 payload 必須回 `IDEMPOTENCY_CONFLICT`，不覆寫
  舊資料。

## 5. TOCTOU 與原子啟用

外部來源在 Agent 讀取後可能改變，因此 payload 必須帶來源時間、版本或
content fingerprint。MCP 啟用 rule 時再次驗證：

- source snapshot 存在且 fingerprint 對應；
- `validFrom`/`validTo` 與 rule version 合法；
- provenance、confirmation 與 required facts 足夠；
- candidate → active 與相關 index 更新以同一個原子寫入完成。

無法確認來源一致性時回 `source_untrusted` 或 `needs_review`，不得直接啟用。

## 6. Privacy 與 Scope

- 每一個 MCP process 綁定一個 user-scoped store。
- Tool input 不接受用來切換 tenant 的 `user_id`、`data_dir` 或 path override。
- 回應只回傳當次 projection 所需欄位。
- raw evidence 的絕對路徑、cookie、credential、token、卡號與敏感資料不得
  進入 MCP contract。
- audit record 可保存 provenance reference，但不代表 MCP 已驗證該 URL 的內容；
  trust 狀態必須明確標示。

## 7. 網路責任

MCP evaluator 與 ledger core 不做隱藏網路查詢。Agent 或外部 approved
research adapter 取得 FX、銀行頁面與 merchant evidence，再以 typed payload
交給 MCP。未來若加入 provider adapter，必須產生相同的 immutable snapshot
contract，不能改變核心的 fail-closed 邊界。

## 8. 驗收條件

1. 直接修改 MCP data directory 不被視為合法 ingestion。
2. candidate source 不會未經 confirmation 變成 active rule。
3. durable transaction 能追溯實際採用的 rule version、FX snapshot 與 source
   fingerprint。
4. 相同 idempotency request 不重複寫入；衝突 payload fail closed。
5. raw evidence 與 typed durable state 可以分開保存，任一方缺失時都有明確
   recovery 狀態。
