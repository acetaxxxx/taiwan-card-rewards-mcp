import { describe, expect, it } from 'vitest';
import { emptyState, evaluateOffer, RewardService, type LedgerStore, type StoredState } from '../src/index.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close(): void {}
}

describe('ingestion flow spine', () => {
  it('deduplicates an active owner/source draft and exposes one stable action', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a', { now: () => new Date('2026-09-16T00:00:00.000Z') });
    const first = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://BANK.example/offers#section' }, idempotencyKey: 'ingest-1' });
    const retry = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/offers' }, idempotencyKey: 'ingest-2' });
    expect(retry.flow.id).toBe(first.flow.id);
    expect(first.flow.sourceScope.value).toBe('https://bank.example/offers');
    expect(first.nextAction).toEqual(expect.objectContaining({ kind: 'SUBMIT_SOURCE', expectedRevision: 1 }));
    expect(service.inspectIngestion(first.flow.id).nextAction?.actionId).toBe(first.nextAction?.actionId);
  });

  it('fails closed across owners and turns expired drafts into bounded tombstones', () => {
    const store = new MemoryStore();
    let now = new Date('2026-09-16T00:00:00.000Z');
    const options = { now: () => now, ingestionDraftTtlMs: 1_000, ingestionTombstoneRetentionMs: 1_000 };
    const owner = new RewardService(store, 'user-a', options);
    const flow = owner.createIngestion({ sourceScope: { kind: 'offer_family', value: 'bank-a-travel' }, idempotencyKey: 'ingest-1' }).flow;
    expect(() => new RewardService(store, 'user-b', options).inspectIngestion(flow.id)).toThrow(/FLOW_NOT_FOUND/);
    now = new Date('2026-09-16T00:00:02.000Z');
    expect(owner.sweepExpiredIngestions()).toEqual({ expired: 1, purgedTombstones: 0 });
    expect(owner.inspectIngestion(flow.id)).toEqual(expect.objectContaining({ flow: expect.objectContaining({ status: 'expired' }), nextAction: undefined }));
    const replacement = owner.createIngestion({ sourceScope: { kind: 'offer_family', value: 'bank-a-travel' }, idempotencyKey: 'ingest-2' });
    expect(replacement.flow.id).not.toBe(flow.id);
  });

  it('atomically captures a compatible source once and advances to manifest submission', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/offers' }, idempotencyKey: 'ingest-1' });
    const submitted = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/offers', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'sha256:offers', artifactRef: 'artifact:offers-2026', submitter: 'agent-a', submittedAt: '2026-09-16T00:00:01Z' } });
    expect(submitted.flow).toEqual(expect.objectContaining({ status: 'awaiting_manifest', revision: 2 }));
    expect(submitted.nextAction).toEqual(expect.objectContaining({ kind: 'SUBMIT_MANIFEST', expectedRevision: 2 }));
    const beforeUnknownAction = service.store.read();
    expect(() => service.submitIngestionSource({ flowId: created.flow.id, actionId: 'wrong', expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://other.example/offers', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'sha256:other', artifactRef: 'artifact:other', submitter: 'agent-a', submittedAt: '2026-09-16T00:00:01Z' } })).toThrow(/INVALID_FLOW_ACTION/);
    expect(service.store.read()).toEqual(beforeUnknownAction);
  });

  it('rejects cyclic manifests and returns the first dependency-ready leaf deterministically', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'offer_family', value: 'bank-a' }, idempotencyKey: 'm-1' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'user_input', description: 'terms', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'h', artifactRef: 'artifact:terms', submitter: 'user-a', submittedAt: '2026-09-16T00:00:00Z' } });
    expect(() => service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'a', kind: 'benefit', summary: 'a', evidenceLocator: 'artifact:a', dependsOn: ['b'] }, { id: 'b', kind: 'exclusion', summary: 'b', evidenceLocator: 'artifact:b', dependsOn: ['a'] }] })).toThrow(/cycle/);
    const result = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'z', kind: 'benefit', summary: 'z', evidenceLocator: 'artifact:z', dependsOn: ['a'] }, { id: 'a', kind: 'exclusion', summary: 'a', evidenceLocator: 'artifact:a', dependsOn: [] }] });
    expect(result.flow.status).toBe('processing_leaves');
    expect(result.nextAction).toEqual(expect.objectContaining({ kind: 'PROCESS_LEAF', leafId: 'a', expectedRevision: 3 }));
    expect(result.coverage).toEqual({ total: 2, materialized: 0, ignored: 0, superseded: 0, pending: 1, blocked: 1, pendingLeafIds: ['a'], blockedLeafIds: ['z'], blockedBy: [{ leafId: 'z', dependsOn: ['a'] }], complete: false });
  });

  it('creates manifest correction revisions and preserves superseded lineage', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'offer_family', value: 'correction' }, idempotencyKey: 'correction-flow' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'user_input', description: 'terms', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'correction-hash', artifactRef: 'artifact:correction', submitter: 'user-a', submittedAt: '2026-09-16T00:00:00Z' } });
    const first = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'old-leaf', kind: 'benefit', summary: 'old', evidenceLocator: 'page:1', dependsOn: [] }] });
    const correction = first.manifestCorrectionAction!;
    const revised = service.correctIngestionManifest({ flowId: created.flow.id, actionId: correction.actionId, expectedRevision: correction.expectedRevision, idempotencyKey: 'correction-1', manifest: [{ id: 'new-leaf', kind: 'benefit', summary: 'new', evidenceLocator: 'page:2', dependsOn: [] }] });
    expect(revised.flow.manifestRevision).toBe(2);
    expect(revised.flow.manifestHistory).toEqual([expect.objectContaining({ revision: 1, supersededByRevision: 2, manifest: [expect.objectContaining({ id: 'old-leaf' })] })]);
    expect(revised.flow.manifest?.[0]?.id).toBe('new-leaf');
    expect(() => service.correctIngestionManifest({ flowId: created.flow.id, actionId: correction.actionId, expectedRevision: correction.expectedRevision, idempotencyKey: 'correction-2', manifest: [{ id: 'third-leaf', kind: 'benefit', summary: 'third', evidenceLocator: 'page:3', dependsOn: [] }] })).toThrow(/STALE_REVISION/);
    const retry = service.correctIngestionManifest({ flowId: created.flow.id, actionId: revised.manifestCorrectionAction!.actionId, expectedRevision: revised.manifestCorrectionAction!.expectedRevision, idempotencyKey: 'correction-1', manifest: [{ id: 'new-leaf', kind: 'benefit', summary: 'new', evidenceLocator: 'page:2', dependsOn: [] }] });
    expect(retry.flow.manifestRevision).toBe(2);
    expect(() => service.correctIngestionManifest({ flowId: created.flow.id, actionId: revised.manifestCorrectionAction!.actionId, expectedRevision: revised.manifestCorrectionAction!.expectedRevision, idempotencyKey: 'correction-1', manifest: [{ id: 'different', kind: 'benefit', summary: 'different', evidenceLocator: 'page:4', dependsOn: [] }] })).toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it('materializes one benefit leaf as a candidate artifact without activating it', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/offers' }, idempotencyKey: 'ingest-benefit' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/offers', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'source-hash', artifactRef: 'artifact:offers', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-1', kind: 'benefit', summary: 'online reward', evidenceLocator: 'page:1', dependsOn: [] }] });
    const submitted = service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'leaf-1', leafId: 'benefit-1', evidenceRefs: ['page:1#benefit'], offer: { snapshot: { id: 'snapshot-benefit-1', url: 'https://bank.example/offers', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'source-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-benefit-1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-benefit-1', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: { channels: ['online'] }, reward: { kind: 'percentage', rateBps: 300 } } }, localExclusions: [{ scope: 'benefit', predicate: { field: 'transaction.paymentMethod', op: 'EQUALS', value: 'excluded-pay' }, evidenceRefs: ['page:1#exclude'] }] });
    expect(submitted.artifact).toEqual(expect.objectContaining({ flowId: created.flow.id, leafId: 'benefit-1', ruleId: 'rule-benefit-1', status: 'candidate', evidenceRefs: ['page:1#benefit'] }));
    expect(submitted.artifact.localExclusions).toHaveLength(1);
    expect(submitted.flow.flow.status).toBe('ready_to_finalize');
    expect(submitted.flow.coverage).toEqual({ total: 1, materialized: 1, ignored: 0, superseded: 0, pending: 0, blocked: 0, pendingLeafIds: [], blockedLeafIds: [], blockedBy: [], complete: false });
    expect(service.searchActiveOffers({ cardId: 'card-1' }).offers).toHaveLength(0);
    expect(service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'leaf-1', leafId: 'benefit-1', evidenceRefs: ['page:1#benefit'], offer: { snapshot: { id: 'snapshot-benefit-1', url: 'https://bank.example/offers', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'source-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-benefit-1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-benefit-1', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: { channels: ['online'] }, reward: { kind: 'percentage', rateBps: 300 } } }, localExclusions: [{ scope: 'benefit', predicate: { field: 'transaction.paymentMethod', op: 'EQUALS', value: 'excluded-pay' }, evidenceRefs: ['page:1#exclude'] }] })).toEqual(expect.objectContaining({ artifact: submitted.artifact }));
    const action = submitted.flow.nextAction!;
    expect(action).toEqual(expect.objectContaining({ kind: 'FINALIZE', expectedRevision: 4 }));
    const finalized = service.finalizeIngestion({ flowId: created.flow.id, actionId: action.actionId, expectedRevision: action.expectedRevision });
    expect(finalized.proof).toEqual(expect.objectContaining({ flowId: created.flow.id, leafTotals: { total: 1, materialized: 1, ignored: 0, superseded: 0 }, activatedRules: [{ ruleId: 'rule-benefit-1', ruleVersion: '1' }] }));
    expect(finalized.flow.flow.status).toBe('complete');
    expect(service.searchActiveOffers({ cardId: 'card-1' }).offers).toHaveLength(1);
    const terminalState = (service.store as MemoryStore).read();
    expect(() => service.submitBenefitLeaf({ flowId: created.flow.id, actionId: action.actionId, expectedRevision: action.expectedRevision, idempotencyKey: 'terminal-retry', leafId: 'benefit-1', evidenceRefs: ['page:1#benefit'], offer: { snapshot: { id: 'snapshot-benefit-1', url: 'https://bank.example/offers', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'source-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-benefit-1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-benefit-1', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 } } } })).toThrow();
    expect((service.store as MemoryStore).read()).toEqual(terminalState);
    expect(service.finalizeIngestion({ flowId: created.flow.id, actionId: action.actionId, expectedRevision: action.expectedRevision }).proof).toEqual(finalized.proof);
    expect(service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/offers' }, idempotencyKey: 'ingest-benefit-revision-2' }).flow.id).not.toBe(created.flow.id);
  });

  it('records ignored and superseded leaf decisions with reason and evidence', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'offer_family', value: 'decisions' }, idempotencyKey: 'decisions-1' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'user_input', description: 'terms', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'decision-hash', artifactRef: 'artifact:decisions', submitter: 'user-a', submittedAt: '2026-09-16T00:00:00Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-ignored', kind: 'benefit', summary: 'ignored', evidenceLocator: 'page:1', dependsOn: [] }, { id: 'exclusion-superseded', kind: 'exclusion', summary: 'superseded', evidenceLocator: 'page:2', dependsOn: [] }] });
    const ignored = service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'ignored-1', leafId: 'benefit-ignored', disposition: 'ignored', reason: 'not applicable', evidenceRefs: ['page:1#reason'] });
    expect(ignored.artifact).toBeUndefined();
    const superseded = service.submitExclusionLeaf({ flowId: created.flow.id, actionId: ignored.flow.nextAction?.actionId, expectedRevision: 4, idempotencyKey: 'superseded-1', leafId: 'exclusion-superseded', target: 'merchant', scope: { kind: 'all_benefits' }, predicate: { field: 'transaction.merchant', op: 'EQUALS', value: 'old' }, disposition: 'superseded', reason: 'replaced', evidenceRefs: ['page:2#replacement'] });
    expect(superseded.artifact).toBeUndefined();
    const final = service.finalizeIngestion({ flowId: created.flow.id, actionId: superseded.flow.nextAction?.actionId, expectedRevision: 5 });
    expect(final.proof.leafTotals).toEqual({ total: 2, materialized: 0, ignored: 1, superseded: 1 });
    expect(final.proof.leaves).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'benefit-ignored', disposition: 'ignored', reason: 'not applicable', evidenceRefs: ['page:1#reason'] }), expect.objectContaining({ id: 'exclusion-superseded', disposition: 'superseded', reason: 'replaced', evidenceRefs: ['page:2#replacement'] })]));
  });

  it('keeps a leaf pending with structured diagnostics when canonical references are missing', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/missing-ref' }, idempotencyKey: 'ingest-missing-ref' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/missing-ref', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'missing-ref-hash', artifactRef: 'artifact:missing-ref', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-missing-ref', kind: 'benefit', summary: 'benefit with unresolved merchant', evidenceLocator: 'page:2', dependsOn: [] }] });
    expect(() => service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'missing-ref-1', leafId: 'benefit-missing-ref', evidenceRefs: ['page:2#benefit'], offer: { snapshot: { id: 'snapshot-missing-ref', url: 'https://bank.example/missing-ref', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'missing-ref-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-missing-ref', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-missing-ref', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: { merchants: ['mch_not_cataloged'] }, reward: { kind: 'percentage', rateBps: 300 } } } })).toThrow(/NEEDS_REVIEW/);
    expect(service.inspectIngestion(created.flow.id).flow).toEqual(expect.objectContaining({ revision: 3, status: 'processing_leaves' }));
    expect(service.inspectIngestion(created.flow.id).flow.manifest?.[0]).not.toHaveProperty('disposition');
  });

  it('resolves merchant references inside leaf submission and returns candidates on ambiguity', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a');
    service.registerMerchant({ canonicalNameZhHant: '測試商家', canonicalNameLocale: 'zh-Hant-TW', status: 'candidate', operatingMarkets: ['TW'], provenance: { version: '1', updatedAt: '2026-09-16T00:00:00.000Z', sourceSnapshotId: 'merchant-source' } });
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/merchant-ref' }, idempotencyKey: 'ingest-merchant-ref' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/merchant-ref', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'merchant-ref-hash', artifactRef: 'artifact:merchant-ref', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-merchant-ref', kind: 'benefit', summary: 'merchant reward', evidenceLocator: 'page:3', dependsOn: [] }] });
    service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'merchant-ref-1', leafId: 'benefit-merchant-ref', merchantRefs: [{ rawQuery: '測試商家', market: 'TW' }], evidenceRefs: ['page:3#benefit'], offer: { snapshot: { id: 'snapshot-merchant-ref', url: 'https://bank.example/merchant-ref', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'merchant-ref-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-merchant-ref', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-merchant-ref', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 } } } });
    expect(store.read().rules[0]?.match.merchants).toEqual([store.read().merchants[0]?.canonicalId]);
  });

  it('returns inline merchant candidates and accepts the selected candidate on retry', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    for (const market of ['TW', 'JP']) service.registerMerchant({ canonicalNameZhHant: '同名商家', canonicalNameLocale: 'zh-Hant-TW', status: 'candidate', operatingMarkets: [market], provenance: { version: '1', updatedAt: '2026-09-16T00:00:00.000Z', sourceSnapshotId: 'merchant-source' } });
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/ambiguous' }, idempotencyKey: 'ingest-ambiguous' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/ambiguous', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'ambiguous-hash', artifactRef: 'artifact:ambiguous', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-ambiguous', kind: 'benefit', summary: 'ambiguous merchant reward', evidenceLocator: 'page:4', dependsOn: [] }] });
    const base = { flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'ambiguous-1', leafId: 'benefit-ambiguous', evidenceRefs: ['page:4#benefit'], offer: { snapshot: { id: 'snapshot-ambiguous', url: 'https://bank.example/ambiguous', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'ambiguous-hash', parserVersion: '1', verified: true, sourceType: 'official' as const }, rule: { id: 'rule-ambiguous', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-ambiguous', status: 'candidate' as const, validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD' as const, match: {}, reward: { kind: 'percentage', rateBps: 300 } } } };
    let error: any;
    try { service.submitBenefitLeaf({ ...base, merchantRefs: [{ rawQuery: '同名商家' }] }); } catch (caught) { error = caught; }
    expect(error?.code).toBe('NEEDS_REVIEW');
    expect(error?.details).toEqual(expect.objectContaining({ code: 'MERCHANT_AMBIGUOUS', retryAction: 'submit_benefit_leaf', merchantResolution: expect.objectContaining({ status: 'ambiguous', candidates: expect.arrayContaining([expect.objectContaining({ canonicalNameZhHant: '同名商家' })]) }) }));
    const selected = error.details.merchantResolution.candidates[0].canonicalId;
    service.submitBenefitLeaf({ ...base, merchantRefs: [{ rawQuery: '同名商家', canonicalId: selected }] });
    expect(service.inspectIngestion(created.flow.id).flow.manifest?.[0]?.disposition).toBe('materialized');
  });

  it('keeps a leaf pending when reward semantics are unsupported', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/unsupported-reward' }, idempotencyKey: 'ingest-unsupported-reward' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/unsupported-reward', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'unsupported-reward-hash', artifactRef: 'artifact:unsupported-reward', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-unsupported-reward', kind: 'benefit', summary: 'points reward', evidenceLocator: 'page:5', dependsOn: [] }] });
    let error: any;
    try { service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'unsupported-reward-1', leafId: 'benefit-unsupported-reward', evidenceRefs: ['page:5#benefit'], offer: { snapshot: { id: 'snapshot-unsupported-reward', url: 'https://bank.example/unsupported-reward', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'unsupported-reward-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-unsupported-reward', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-unsupported-reward', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'points', code: 'bank-points' } } } }); } catch (caught) { error = caught; }
    expect(error?.code).toBe('NEEDS_REVIEW');
    expect(error?.details).toEqual(expect.objectContaining({ code: 'UNSUPPORTED_REWARD_UNIT', path: 'offer.rule.reward.kind', retryAction: 'submit_benefit_leaf' }));
    expect(service.inspectIngestion(created.flow.id).flow.manifest?.[0]).not.toHaveProperty('disposition');
  });

  it('applies a source-scoped shared exclusion to every dependent benefit and preserves its evaluator provenance', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/shared-exclusion' }, idempotencyKey: 'shared-exclusion' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/shared-exclusion', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'shared-hash', artifactRef: 'artifact:shared', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'exclude-wallet', kind: 'exclusion', summary: 'wallet excluded', evidenceLocator: 'page:1#exclude', dependsOn: [] }, { id: 'benefit-a', kind: 'benefit', summary: 'benefit A', evidenceLocator: 'page:1#a', dependsOn: ['exclude-wallet'] }, { id: 'benefit-b', kind: 'benefit', summary: 'benefit B', evidenceLocator: 'page:1#b', dependsOn: ['exclude-wallet'] }] });
    const exclusion = service.submitExclusionLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'exclude-wallet-v1', leafId: 'exclude-wallet', target: 'payment_method', scope: { kind: 'all_benefits' }, predicate: { field: 'transaction.paymentMethod', op: 'EQUALS', value: 'wallet-x' }, evidenceRefs: ['page:1#exclude'] });
    expect(exclusion.artifact).toEqual(expect.objectContaining({ sourceLeafId: 'exclude-wallet', status: 'candidate' }));
    const next = exclusion.flow.nextAction!;
    const submitBenefit = (leafId: string, ruleId: string, actionId: string, revision: number) => service.submitBenefitLeaf({ flowId: created.flow.id, actionId, expectedRevision: revision, idempotencyKey: `${leafId}-v1`, leafId, evidenceRefs: [`page:1#${leafId}`], offer: { snapshot: { id: `snapshot-${leafId}`, url: 'https://bank.example/shared-exclusion', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'shared-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: ruleId, cardId: 'card-1', version: '1', sourceSnapshotId: `snapshot-${leafId}`, status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 } } } });
    const first = submitBenefit(next.leafId!, 'rule-a', next.actionId, next.expectedRevision);
    expect(first.flow.flow.manifest?.find((leaf) => leaf.id === 'benefit-a')?.disposition).toBe('materialized');
    expect(first.flow.nextAction?.leafId).toBe('benefit-b');
    const second = submitBenefit(first.flow.nextAction!.leafId!, 'rule-b', first.flow.nextAction!.actionId, first.flow.nextAction!.expectedRevision);
    expect(second.flow.flow.status).toBe('ready_to_finalize');
    const pristine = store.read();
    const interrupted = store.read();
    interrupted.snapshots = interrupted.snapshots.filter((snapshot) => snapshot.id !== 'snapshot-benefit-b');
    store.write(interrupted);
    expect(() => service.finalizeIngestion({ flowId: created.flow.id, actionId: second.flow.nextAction!.actionId, expectedRevision: second.flow.nextAction!.expectedRevision })).toThrow(/candidate offer no longer matches/);
    expect(store.read().rules.filter((rule) => rule.id === 'rule-a' || rule.id === 'rule-b').map((rule) => rule.status)).toEqual(['candidate', 'candidate']);
    store.write(pristine);
    const finalized = service.finalizeIngestion({ flowId: created.flow.id, actionId: second.flow.nextAction!.actionId, expectedRevision: second.flow.nextAction!.expectedRevision });
    expect(finalized.proof.activatedRules).toEqual([{ ruleId: 'rule-a', ruleVersion: '1' }, { ruleId: 'rule-b', ruleVersion: '1' }]);
    expect(service.searchActiveOffers({ cardId: 'card-1' }).offers).toHaveLength(2);
    const candidate = store.read().rules.find((rule) => rule.id === 'rule-a')!;
    expect(candidate.sharedExclusions).toEqual([expect.objectContaining({ sourceLeafId: 'exclude-wallet', evidenceRefs: ['page:1#exclude'] })]);
    const evaluated = evaluateOffer({ ...candidate, status: 'active' }, { cardId: 'card-1', kind: 'purchase', mode: 'planned', occurredAt: '2026-09-16T00:00:00.000Z', amount: { amountMinor: 10000, currency: 'TWD' }, paymentMethod: 'wallet-x' }, { sourceSnapshots: { [candidate.sourceSnapshotId]: store.read().snapshots.find((snapshot) => snapshot.id === candidate.sourceSnapshotId)! } });
    expect(evaluated.status).toBe('no_match');
    expect(evaluated.matchedExclusions?.[0]).toEqual(expect.objectContaining({ sourceLeafId: 'exclude-wallet' }));

    // Duplicate finalize idempotently returns the same proof
    const duplicate = service.finalizeIngestion({ flowId: created.flow.id, actionId: second.flow.nextAction!.actionId, expectedRevision: second.flow.nextAction!.expectedRevision });
    expect(duplicate.proof).toEqual(finalized.proof);

    // Mismatched revision/actionId on completed flow fails closed with STALE_REVISION
    expect(() => service.finalizeIngestion({ flowId: created.flow.id, actionId: second.flow.nextAction!.actionId, expectedRevision: 999 })).toThrow(/completed flow only accepts an exact finalize retry/);
    expect(() => service.finalizeIngestion({ flowId: created.flow.id, actionId: 'act_wrong', expectedRevision: second.flow.nextAction!.expectedRevision })).toThrow(/completed flow only accepts an exact finalize retry/);

    // Completed flow rejects subsequent leaf submissions
    expect(() => service.submitBenefitLeaf({ flowId: created.flow.id, actionId: 'act_any', expectedRevision: 99, idempotencyKey: 'late-benefit', leafId: 'benefit-a', evidenceRefs: ['page:1'], offer: { snapshot: { id: 'snap-late', url: 'https://bank.example/shared-exclusion', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'shared-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-late', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-late', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } } } })).toThrow(/benefit leaf is not the server-owned next action/);
    expect(() => service.submitExclusionLeaf({ flowId: created.flow.id, actionId: 'act_any', expectedRevision: 99, idempotencyKey: 'late-exclusion', leafId: 'exclude-wallet', target: 'merchant', scope: { kind: 'all_benefits' }, predicate: { field: 'transaction.merchant', op: 'EQUALS', value: 'x' }, evidenceRefs: ['page:1'] })).toThrow(/exclusion leaf is not the server-owned next action/);
  });

  it('holds candidate rules awaiting confirmation when user confirmation or verified source is missing', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/awaiting-conf' }, idempotencyKey: 'awaiting-conf' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/awaiting-conf', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'awaiting-conf-hash', artifactRef: 'artifact:awaiting-conf', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'benefit-awaiting', kind: 'benefit', summary: 'benefit awaiting confirmation', evidenceLocator: 'page:1', dependsOn: [] }] });
    const next = manifested.nextAction!;
    const leaf = service.submitBenefitLeaf({ flowId: created.flow.id, actionId: next.actionId, expectedRevision: next.expectedRevision, idempotencyKey: 'leaf-awaiting-1', leafId: 'benefit-awaiting', evidenceRefs: ['page:1'], offer: { snapshot: { id: 'snapshot-awaiting', url: 'https://bank.example/awaiting-conf', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'awaiting-conf-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-awaiting', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-awaiting', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 200 }, requires: ['user_confirmation'] } } });
    const finalizeAction = leaf.flow.nextAction!;
    const finalized = service.finalizeIngestion({ flowId: created.flow.id, actionId: finalizeAction.actionId, expectedRevision: finalizeAction.expectedRevision });
    expect(finalized.proof.activatedRules).toEqual([]);
    expect(finalized.proof.awaitingConfirmationRules).toEqual([{ ruleId: 'rule-awaiting', ruleVersion: '1', reason: 'rule requires user confirmation' }]);
    expect(store.read().rules.find((r) => r.id === 'rule-awaiting')?.status).toBe('candidate');
  });

  it('supersedes matching predecessor rules atomically and rejects cross-card supersession', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a');
    // Seed existing active rule on card-1 and active rule on card-2
    service.upsertOffer(
      { id: 'snap-seed-1', url: 'https://bank.example/seed-1', fetchedAt: '2026-01-01T00:00:00.000Z', contentHash: 'seed-hash-1', parserVersion: '1', verified: true, sourceType: 'official' },
      { id: 'rule-seed-card1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-seed-1', status: 'active', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } }
    );
    service.upsertOffer(
      { id: 'snap-seed-2', url: 'https://bank.example/seed-2', fetchedAt: '2026-01-01T00:00:00.000Z', contentHash: 'seed-hash-2', parserVersion: '1', verified: true, sourceType: 'official' },
      { id: 'rule-seed-card2', cardId: 'card-2', version: '1', sourceSnapshotId: 'snap-seed-2', status: 'active', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } }
    );

    // 1. Cross-card supersession fails closed
    const crossIngestion = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/cross' }, idempotencyKey: 'cross-ingest' });
    const crossSourced = service.submitIngestionSource({ flowId: crossIngestion.flow.id, actionId: crossIngestion.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/cross', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'cross-hash', artifactRef: 'artifact:cross', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const crossManifested = service.submitIngestionManifest({ flowId: crossIngestion.flow.id, actionId: crossSourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'leaf-cross', kind: 'benefit', summary: 'cross-card attempt', evidenceLocator: 'page:1', dependsOn: [] }] });
    const crossLeaf = service.submitBenefitLeaf({ flowId: crossIngestion.flow.id, actionId: crossManifested.nextAction!.actionId, expectedRevision: crossManifested.nextAction!.expectedRevision, idempotencyKey: 'cross-leaf-1', leafId: 'leaf-cross', evidenceRefs: ['page:1'], offer: { snapshot: { id: 'snap-cross', url: 'https://bank.example/cross', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'cross-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-new-card1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-cross', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 }, supersedesRuleId: 'rule-seed-card2' } } });
    expect(() => service.finalizeIngestion({ flowId: crossIngestion.flow.id, actionId: crossLeaf.flow.nextAction!.actionId, expectedRevision: crossLeaf.flow.nextAction!.expectedRevision })).toThrow(/superseded active rule is missing, card mismatched, or no longer active/);
    expect(store.read().rules.find((r) => r.id === 'rule-seed-card2')?.status).toBe('active');

    // 2. Matching card supersession succeeds and supersedes predecessor
    const validIngestion = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/valid-super' }, idempotencyKey: 'valid-super' });
    const validSourced = service.submitIngestionSource({ flowId: validIngestion.flow.id, actionId: validIngestion.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/valid-super', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'valid-super-hash', artifactRef: 'artifact:valid-super', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const validManifested = service.submitIngestionManifest({ flowId: validIngestion.flow.id, actionId: validSourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'leaf-valid', kind: 'benefit', summary: 'valid supersession', evidenceLocator: 'page:1', dependsOn: [] }] });
    const validLeaf = service.submitBenefitLeaf({ flowId: validIngestion.flow.id, actionId: validManifested.nextAction!.actionId, expectedRevision: validManifested.nextAction!.expectedRevision, idempotencyKey: 'valid-leaf-1', leafId: 'leaf-valid', evidenceRefs: ['page:1'], offer: { snapshot: { id: 'snap-valid-super', url: 'https://bank.example/valid-super', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'valid-super-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-seed-card1-v2', cardId: 'card-1', version: '2', sourceSnapshotId: 'snap-valid-super', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 }, supersedesRuleId: 'rule-seed-card1' } } });
    const finalized = service.finalizeIngestion({ flowId: validIngestion.flow.id, actionId: validLeaf.flow.nextAction!.actionId, expectedRevision: validLeaf.flow.nextAction!.expectedRevision });
    expect(finalized.proof.activatedRules).toEqual([{ ruleId: 'rule-seed-card1-v2', ruleVersion: '2' }]);
    expect(store.read().rules.find((r) => r.id === 'rule-seed-card1')?.status).toBe('superseded');
    expect(store.read().rules.find((r) => r.id === 'rule-seed-card1-v2')?.status).toBe('active');
  });

  it('fails closed when snapshot or rule validTo is expired at finalization', () => {
    const fixedNow = new Date('2026-09-16T12:00:00.000Z');
    const store = new MemoryStore();
    const service = new RewardService(store, 'user-a', { now: () => fixedNow });

    // Expired snapshot
    const expiredSnapFlow = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/expired-snap' }, idempotencyKey: 'exp-snap' });
    const snapSourced = service.submitIngestionSource({ flowId: expiredSnapFlow.flow.id, actionId: expiredSnapFlow.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/expired-snap', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'exp-snap-hash', artifactRef: 'artifact:exp-snap', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const snapManifested = service.submitIngestionManifest({ flowId: expiredSnapFlow.flow.id, actionId: snapSourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'leaf-exp-snap', kind: 'benefit', summary: 'expired snapshot', evidenceLocator: 'p:1', dependsOn: [] }] });
    const snapLeaf = service.submitBenefitLeaf({ flowId: expiredSnapFlow.flow.id, actionId: snapManifested.nextAction!.actionId, expectedRevision: snapManifested.nextAction!.expectedRevision, idempotencyKey: 'exp-snap-leaf', leafId: 'leaf-exp-snap', evidenceRefs: ['p:1'], offer: { snapshot: { id: 'snap-expired', url: 'https://bank.example/expired-snap', fetchedAt: '2026-08-01T00:00:00.000Z', validTo: '2026-09-01T00:00:00.000Z', contentHash: 'exp-snap-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-exp-snap', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-expired', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } } } });
    expect(() => service.finalizeIngestion({ flowId: expiredSnapFlow.flow.id, actionId: snapLeaf.flow.nextAction!.actionId, expectedRevision: snapLeaf.flow.nextAction!.expectedRevision })).toThrow(/candidate offer source snapshot is expired/);

    // Expired rule
    const expiredRuleFlow = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/expired-rule' }, idempotencyKey: 'exp-rule' });
    const ruleSourced = service.submitIngestionSource({ flowId: expiredRuleFlow.flow.id, actionId: expiredRuleFlow.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/expired-rule', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'exp-rule-hash', artifactRef: 'artifact:exp-rule', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const ruleManifested = service.submitIngestionManifest({ flowId: expiredRuleFlow.flow.id, actionId: ruleSourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'leaf-exp-rule', kind: 'benefit', summary: 'expired rule', evidenceLocator: 'p:1', dependsOn: [] }] });
    const ruleLeaf = service.submitBenefitLeaf({ flowId: expiredRuleFlow.flow.id, actionId: ruleManifested.nextAction!.actionId, expectedRevision: ruleManifested.nextAction!.expectedRevision, idempotencyKey: 'exp-rule-leaf', leafId: 'leaf-exp-rule', evidenceRefs: ['p:1'], offer: { snapshot: { id: 'snap-ok', url: 'https://bank.example/expired-rule', fetchedAt: '2026-08-01T00:00:00.000Z', contentHash: 'exp-rule-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-expired', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-ok', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-09-01T00:00:00.000Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } } } });
    expect(() => service.finalizeIngestion({ flowId: expiredRuleFlow.flow.id, actionId: ruleLeaf.flow.nextAction!.actionId, expectedRevision: ruleLeaf.flow.nextAction!.expectedRevision })).toThrow(/candidate rule is expired/);
  });

  it('rejects ambiguous shared-exclusion scope and requires a reason to ignore an exclusion', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'official_url', value: 'https://bank.example/ambiguous-exclusion' }, idempotencyKey: 'ambiguous-exclusion' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://bank.example/ambiguous-exclusion', retrievedAt: '2026-09-16T00:00:00.000Z', contentHash: 'ambiguous-exclusion-hash', artifactRef: 'artifact:ambiguous-exclusion', submitter: 'agent', submittedAt: '2026-09-16T00:00:00.000Z' } });
    const manifested = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'exclude', kind: 'exclusion', summary: 'exclude', evidenceLocator: 'page:1', dependsOn: [] }, { id: 'benefit', kind: 'benefit', summary: 'benefit', evidenceLocator: 'page:2', dependsOn: ['exclude'] }] });
    expect(() => service.submitExclusionLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'ambiguous', leafId: 'exclude', target: 'merchant', scope: { kind: 'benefit_ids', benefitIds: ['unknown-benefit'] }, predicate: { field: 'transaction.merchant', op: 'EQUALS', value: 'merchant-a' }, evidenceRefs: ['page:1'] })).toThrow(/unknown or ambiguous benefit/);
    expect(() => service.submitExclusionLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'ignored', leafId: 'exclude', target: 'merchant', scope: { kind: 'all_benefits' }, predicate: { field: 'transaction.merchant', op: 'EQUALS', value: 'merchant-a' }, evidenceRefs: ['page:1'], disposition: 'ignored' })).toThrow(/ignored exclusion requires a reason/);
  });
});
