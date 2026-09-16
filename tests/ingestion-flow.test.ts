import { describe, expect, it } from 'vitest';
import { emptyState, RewardService, type LedgerStore, type StoredState } from '../src/index.js';

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
    expect(() => service.submitIngestionSource({ flowId: created.flow.id, actionId: 'wrong', expectedRevision: 1, sourceCapture: { sourceType: 'official', url: 'https://other.example/offers', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'sha256:other', artifactRef: 'artifact:other', submitter: 'agent-a', submittedAt: '2026-09-16T00:00:01Z' } })).toThrow(/INVALID_FLOW_ACTION/);
  });

  it('rejects cyclic manifests and returns the first dependency-ready leaf deterministically', () => {
    const service = new RewardService(new MemoryStore(), 'user-a');
    const created = service.createIngestion({ sourceScope: { kind: 'offer_family', value: 'bank-a' }, idempotencyKey: 'm-1' });
    const sourced = service.submitIngestionSource({ flowId: created.flow.id, actionId: created.nextAction?.actionId, expectedRevision: 1, sourceCapture: { sourceType: 'user_input', description: 'terms', retrievedAt: '2026-09-16T00:00:00Z', contentHash: 'h', artifactRef: 'artifact:terms', submitter: 'user-a', submittedAt: '2026-09-16T00:00:00Z' } });
    expect(() => service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'a', kind: 'benefit', summary: 'a', evidenceLocator: 'artifact:a', dependsOn: ['b'] }, { id: 'b', kind: 'exclusion', summary: 'b', evidenceLocator: 'artifact:b', dependsOn: ['a'] }] })).toThrow(/cycle/);
    const result = service.submitIngestionManifest({ flowId: created.flow.id, actionId: sourced.nextAction?.actionId, expectedRevision: 2, manifest: [{ id: 'z', kind: 'benefit', summary: 'z', evidenceLocator: 'artifact:z', dependsOn: ['a'] }, { id: 'a', kind: 'exclusion', summary: 'a', evidenceLocator: 'artifact:a', dependsOn: [] }] });
    expect(result.flow.status).toBe('processing_leaves');
    expect(result.nextAction).toEqual(expect.objectContaining({ kind: 'PROCESS_LEAF', leafId: 'a', expectedRevision: 3 }));
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
    expect(service.searchActiveOffers({ cardId: 'card-1' }).offers).toHaveLength(0);
    expect(service.submitBenefitLeaf({ flowId: created.flow.id, actionId: manifested.nextAction?.actionId, expectedRevision: 3, idempotencyKey: 'leaf-1', leafId: 'benefit-1', evidenceRefs: ['page:1#benefit'], offer: { snapshot: { id: 'snapshot-benefit-1', url: 'https://bank.example/offers', fetchedAt: '2026-09-16T00:00:00.000Z', contentHash: 'source-hash', parserVersion: '1', verified: true, sourceType: 'official' }, rule: { id: 'rule-benefit-1', cardId: 'card-1', version: '1', sourceSnapshotId: 'snapshot-benefit-1', status: 'candidate', validFrom: '2026-01-01T00:00:00.000Z', settlementCurrency: 'TWD', match: { channels: ['online'] }, reward: { kind: 'percentage', rateBps: 300 } } }, localExclusions: [{ scope: 'benefit', predicate: { field: 'transaction.paymentMethod', op: 'EQUALS', value: 'excluded-pay' }, evidenceRefs: ['page:1#exclude'] }] })).toEqual(expect.objectContaining({ artifact: submitted.artifact }));
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
});
