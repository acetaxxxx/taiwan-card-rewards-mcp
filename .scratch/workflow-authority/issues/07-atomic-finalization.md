# 07: 原子 finalize 並產生 completion proof

Status: ready-for-agent

**Blocked by:** 05, 06.

**What to build:** 只有完整 manifest 被 accounted for、所有依賴和 candidate artifacts 通過驗證時，才一次啟用 ingestion 產生的 Rule Versions。

## Definition of done

- [ ] `ready_to_finalize` 只在所有 leaves 有合法 disposition、materialized dependencies 完整且無 unresolved diagnostics 時出現。
- [ ] Finalize 重新驗證 source freshness、canonical references、rule conflicts、trust basis、supersession 與完整 dependency closure。
- [ ] Candidate activation、prior-version supersession、cap/canonical references 和 flow completion 在單一 store update 中完成。
- [ ] 任一驗證或 persistence failure 保留先前 active catalog，不留下部分啟用或半完成 flow。
- [ ] Completion proof 包含 source/manifest revision、leaf totals、每個 disposition、activated rule IDs/versions、ignored reasons 與 evidence coverage。
- [ ] Duplicate finalize idempotently 回傳同一 proof；不同 revision 或已修改 candidate 會 fail closed。
- [ ] Completed flow 不再接受 leaf submissions；correction/official refresh 使用明確的新 ingestion revision。
- [ ] Public MCP E2E 驗證多 benefit＋shared exclusion、interrupted resume、atomic rollback、supersession 與 recommendation visibility。
