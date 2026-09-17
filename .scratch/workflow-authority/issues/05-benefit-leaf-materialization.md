# 05: 驗證並 materialize Benefit Leaf

Status: completed

**Blocked by:** 04.

**What to build:** 將單一 benefit leaf 的語意抽取結果轉成完整 candidate Rule Version 與相關 canonical references，但不提前進入 active offer index。

## Definition of done

- [x] Benefit leaf 可表達 reward、period、eligibility、merchant inclusion、payment selector、limits、registration、local exclusions 與 evidence references。
- [x] 實作重用既有 Offer Catalog／validation／canonicalization 的 Adapter，不在 flow controller 複製 rule validation。
- [x] Merchant、route selector、cap pool、reward unit 或 evidence ambiguous 時回 structured diagnostics，leaf 保持 pending/needs_review。
- [x] 成功 materialization 建立 candidate artifact，記錄對應 source/manifest/leaf/revision，且不會被 `search_active_offers` 或 `recommend` 使用。
- [x] 相同 action/payload 重試不建立重複 Rule Version；不同 payload 重用 action 回 conflict。
- [x] Local exclusion 與 benefit 的 scope 一起保存，不能只留自然語言摘要。
- [x] 既有 `upsert_offer` 相容行為與信任邊界維持；workflow status 本身不能啟用 rule。
- [x] 測試涵蓋完整 benefit、未知 canonical merchant、缺 cap/evidence、user-confirmed source 與 candidate invisibility。

## Evidence and Audit Notes

- **DoD 1 (Benefit leaf semantics):** Proven by `src/types.ts` (`IngestionBenefitLeafSubmission`, `OfferRuleVersion`, `IngestionLocalExclusion`, `CapPoolDefinition`), `src/validation.ts` (`validateIngestionBenefitLeaf`), and `tests/ingestion-flow.test.ts`.
- **DoD 2 (Offer Catalog adapter reuse):** Proven by `src/service.ts` (`submitBenefitLeaf` delegates rule and snapshot materialization to `this.upsertOffer(...)`, avoiding duplication of rule validation logic in the flow controller).
- **DoD 3 (Structured diagnostics on ambiguous/unresolved refs):** Proven by `src/service.ts` (validates reward units, cap pools, routes, and merchants; throws `RewardServiceError('NEEDS_REVIEW', ...)` with structured details, leaving the leaf pending) and tested by `tests/ingestion-flow.test.ts` (lines 97-144).
- **DoD 4 (Candidate artifact creation & invisibility):** Proven by `src/service.ts` (`artifact` recorded with status `'candidate'`; candidate rules are excluded from `searchActiveOffers` and `recommend` until finalization) and tested by `tests/ingestion-flow.test.ts` (lines 59-75).
- **DoD 5 (Idempotency and payload hash conflict):** Proven by `src/service.ts` (checks `idempotencyKey` and verifies `payloadHash`; returns existing artifact on replay and throws `IDEMPOTENCY_CONFLICT` on divergent payload) and tested by `tests/ingestion-flow.test.ts` (lines 69-70).
- **DoD 6 (Structured local exclusion scope):** Proven by `src/types.ts` (`IngestionLocalExclusion`), `src/service.ts` (persists structured predicates and evidence on `artifact.localExclusions`), and tested by `tests/ingestion-flow.test.ts` (lines 64-66).
- **DoD 7 (Catalog compatibility & activation boundary):** Proven by `src/service.ts` (leaf materialization preserves candidate status; rules can only be activated by `finalizeIngestion`) and tested by `tests/ingestion-flow.test.ts`.
- **DoD 8 (Comprehensive test coverage):** Proven by `tests/ingestion-flow.test.ts` (tests full benefit lifecycle, unknown merchant, ambiguous merchant candidates, unsupported reward kind, candidate invisibility, and idempotency).
