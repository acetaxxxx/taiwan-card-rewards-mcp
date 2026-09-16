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
});
