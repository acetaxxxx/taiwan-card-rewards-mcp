# 04: 建立 Manifest 與 coverage ledger

Status: completed

**Blocked by:** 03.

**What to build:** 將完整來源拆成具穩定 ID、類型與依賴的 semantic leaves，讓 MCP 能決定下一個工作並證明 coverage。

## Definition of done

- [x] Manifest leaf 至少支援 `benefit` 與 `exclusion` 類型、source-local stable ID、摘要、evidence locator 與 dependency IDs。
- [x] Manifest 為 closed schema；重複 ID、未知類型、缺依賴、自我依賴與 dependency cycle 會 fail closed 並指出路徑。
- [x] 成功提交後進入 `processing_leaves`，MCP 以 deterministic order 回下一個可處理 leaf action。
- [x] 每個 leaf 最終只能有 `materialized`、`ignored` 或 `superseded` disposition；ignored/superseded 必須有理由和 evidence linkage。
- [x] Coverage 回傳總數、各 disposition 數量、pending/blocked leaf IDs 與 `complete=false`。
- [x] 修正版 manifest 必須建立新 revision 並保留舊版稽核關係，不在原 revision 中偷偷增刪 leaf。
- [x] Large manifest 有明確上限或分頁策略；超限回可恢復診斷，不接受部分截斷後宣稱完整。
- [x] 整合測試涵蓋多 benefit、shared exclusion、依賴順序、cycle、duplicate 與 interrupted resume。

## Evidence and Audit Notes

- **DoD 1 (Leaf types and IDs):** Proven by `src/types.ts` (`IngestionManifestLeaf`), `src/validation.ts` (`validateIngestionManifestLeaf`), and `tests/ingestion-flow.test.ts`.
- **DoD 2 (Closed schema & cycle validation):** Proven by `src/validation.ts` (`validateIngestionManifest` checks max 128, duplicates, missing dependencies, cycles) and `tests/ingestion-flow.test.ts` ("rejects cyclic manifests and returns the first dependency-ready leaf deterministically").
- **DoD 3 (processing_leaves & deterministic nextAction):** Proven by `src/service.ts` (`submitIngestionManifest` advances revision to 3 and sets status to `processing_leaves`; `presentIngestion` deterministically sorts available leaves).
- **DoD 4 (Leaf dispositions & evidence linkage):** Proven by `src/types.ts`, `src/validation.ts` (`validateIngestionExclusionLeaf` enforces reason and evidenceRefs for ignored disposition), and `tests/ingestion-flow.test.ts` (lines 62-75, 159-166).
- **DoD 5 (Coverage ledger with complete=false):** Proven by `src/service.ts` (`manifestCoverage` returns deterministic disposition totals, pending/blocked IDs and dependency blockers for every non-complete manifest), `src/types.ts` (`IngestionCoverageLedger`), and service/public MCP tests.
- **DoD 6 (Manifest revisioning during processing):** Proven by `src/service.ts` (`correctIngestionManifest` creates server-owned revisions and preserves `manifestHistory`), `src/validation.ts`, and correction/idempotency tests.
- **DoD 7 (Large manifest bounds):** Proven by `src/validation.ts` (`validateIngestionManifest` enforces 1..128 leaves and bounds on dependencies).
- **DoD 8 (Integration tests):** Proven by `tests/ingestion-flow.test.ts` and `tests/public-workflow-e2e.test.ts`.
