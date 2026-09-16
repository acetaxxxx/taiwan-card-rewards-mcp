# 02: 建立 Ingestion Flow spine

Status: ready-for-agent

**Blocked by:** 01.

**What to build:** 建立可持久化、可恢復且具 revision/idempotency 保護的 ingestion flow，先交付最小的 create → inspect → next action 垂直切片。

## Definition of done

- [ ] 新建 ingestion 會產生 MCP-owned `flowId`、revision、owner scope、建立時間與 `awaiting_source` 狀態。
- [ ] 讀取 flow 可取得目前狀態與唯一可執行的 `SUBMIT_SOURCE` action；action 帶穩定 `actionId` 和完成條件。
- [ ] 同一 idempotency key 加相同內容重試會回原 flow；不同內容重用會回結構化 conflict。
- [ ] 其他 tenant 無法讀取或提交該 flow；未驗證 metadata 時依既有安全策略 fail closed。
- [ ] Store schema migration 可讀既有 v0.15.0 state，並驗證新增 workflow collection。
- [ ] Stale revision、未知 action、terminal flow submission 都不改變 state，且回完整診斷。
- [ ] 重新啟動 MCP 後可從 FileStore 讀回 flow 並取得相同 next action。
- [ ] Public schema、CLI dispatcher、service/store Interface 與整合測試一致。

## Comments

本票不處理 source payload、manifest 或 rules；它只建立後續 domain flows 使用的窄 Interface。
