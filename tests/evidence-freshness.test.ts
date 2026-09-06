import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close(): void {}
}

const evidence = {
  id: 'ev-1', requirementId: 'fx:USD:TWD', sourceIdentity: 'bank-fx', sourceType: 'official' as const, authority: 'issuer' as const,
  claim: { baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32000000 }, observedAt: '2026-09-05T00:00:00Z',
  validFrom: '2026-09-05T00:00:00Z', validTo: '2026-09-06T00:00:00Z', refreshAfter: '2026-09-05T12:00:00Z', confidence: 'high' as const,
  contentHash: 'sha256:abc', reviewState: 'accepted' as const,
};

describe('external evidence and freshness gate', () => {
  it('persists typed provenance and preflight exposes accepted evidence', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.submitEvidence(evidence);
    expect(store.read().evidence[0]).toMatchObject({ ...evidence, id: expect.stringMatching(/^ev_[0-9A-HJKMNP-TV-Z]{26}$/) });
    expect(store.read().evidence[0]?.id).not.toBe(evidence.id);
    expect(service.listEvidence()[0]).toEqual(store.read().evidence[0]);
    expect(service.submitEvidence(evidence).id).toBe(store.read().evidence[0]?.id);
  });

  it('rejects unknown fields and conflicting evidence without making it authoritative', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    expect(() => service.submitEvidence({ ...evidence, token: 'secret' })).toThrow();
    service.submitEvidence(evidence);
    expect(() => service.submitEvidence({ ...evidence, id: 'ev-2', claim: { ...evidence.claim, ratePpm: 33000000 } })).toThrow(/conflict/);
  });

  it('generates MCP-owned fact candidate identities and ignores caller id', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const candidate = service.submitFactCandidate({ id: 'caller-id', requirementId: 'fx:USD:TWD', fact: { ratePpm: 32000000 }, evidenceId: 'ev-existing', reviewState: 'candidate' });
    expect(candidate.id).toMatch(/^fact_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(candidate.id).not.toBe('caller-id');
    expect(service.submitFactCandidate({ id: 'other-id', requirementId: 'fx:USD:TWD', fact: { ratePpm: 32000000 }, evidenceId: 'ev-existing', reviewState: 'candidate' }).id).toBe(candidate.id);
  });
});
