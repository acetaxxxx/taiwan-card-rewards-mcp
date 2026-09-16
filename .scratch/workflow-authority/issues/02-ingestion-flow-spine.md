# 02: 建立 Ingestion Flow spine 與 draft lifecycle

Status: ready-for-human

**Blocked by:** 01.

**What to build:** 建立可持久化、可恢復且具 revision/idempotency、同來源去重與 expiry cleanup 保護的 ingestion flow，先交付最小的 create → inspect → next action 垂直切片。

## Definition of done

- [x] 新建 ingestion 會產生 MCP-owned `flowId`、revision、owner scope、建立時間與 `awaiting_source` 狀態。
- [x] Create 接受可正規化、非敏感的 source scope；同一 `(ownerUser, source scope)` 的 active create 會回既有 flow，不會堆積重複 drafts。
- [x] Source scope lock 不以 card ID 作全域互斥；一份來源可涵蓋多產品，Held Card 註冊不依賴 ingestion complete。
- [x] 讀取 flow 可取得目前狀態與唯一可執行的 `SUBMIT_SOURCE` action；action 帶穩定 `actionId` 和完成條件。
- [x] 同一 idempotency key 加相同內容重試會回原 flow；不同內容重用會回結構化 conflict。
- [x] 其他 tenant 無法讀取該 flow；未驗證 metadata 時依既有安全策略 fail closed。
- [x] Store schema migration 可讀既有 v0.15.0 state，並驗證新增 workflow collection。
- [ ] Stale revision、未知 action、terminal flow submission 都不改變 state，且回完整診斷。
- [x] 重新啟動 MCP 後可從 FileStore 讀回 flow 並取得相同 next action。
- [x] Draft 保存 `lastActivityAt`、`expiresAt` 與 terminal `expired` 狀態。
- [x] Startup 與 mutating flow operations 會 sweep 過期 drafts；另有可由 operator/scheduler 呼叫的 maintenance sweep，使用 injectable clock 做 deterministic test。
- [x] Expiry 只刪除 incomplete candidate artifacts 與未被 completed work 參照的 payload，保留 tenant-scoped minimal tombstone；active rules、完成 proof 與歷史資料不可被 sweep。
- [x] Expired draft 必須以新 revision 建立，不能直接恢復；相同 source scope 的新 flow 不受已過 retention tombstone 阻擋。
- [x] Public schema、CLI dispatcher、service/store Interface 與整合測試一致。

## Comments

本票不處理 source payload、manifest 或 rules；它只建立後續 domain flows 使用的窄 Interface 與安全的 draft 生命週期。

`SUBMIT_SOURCE` 的 revision/action 驗證與 activity 更新會由 Ticket 03 的實際 source submission 一併落地；本票不接受 source payload，因此沒有可提交的 mutation。
