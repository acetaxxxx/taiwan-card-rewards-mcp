import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) { const state = this.read(); change(state); this.write(state); return this.read(); }
  close() {}
}

describe('FX policy and observation persistence', () => {
  it('stores policy and observation separately with tenant ownership and idempotency', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    const evidence = service.submitEvidence({ id: 'evidence-fx-policy', requirementId: 'fx-policy:issuer', sourceIdentity: 'issuer.example', sourceType: 'official', authority: 'issuer', claim: { policyKey: 'issuer-jpy', rateType: 'cash_selling' }, observedAt: '2026-09-10T00:00:00Z', confidence: 'high', contentHash: 'policy-hash', reviewState: 'accepted', sourceUrl: 'https://issuer.example/fx' });
    const policy = service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', scope: { kind: 'issuer', issuer: 'Example Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: evidence.id, observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' });
    const observation = service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Example Bank', rateType: 'cash_selling', conversionOwner: 'issuer', sourceUrl: 'https://issuer.example/rates', contentHash: 'rate-hash', idempotencyKey: 'observation-1' });

    expect(service.listFxPolicies()).toEqual([policy]);
    expect(service.listFxObservations()).toEqual([observation]);
    expect(service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', scope: { kind: 'issuer', issuer: 'Example Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: evidence.id, observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' })).toEqual(policy);
    expect(service.store.read().fxPolicies).toHaveLength(1);
    expect(service.store.read().fxObservations).toHaveLength(1);
  });

  it('rejects observations without provenance and policies without accepted official evidence', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    expect(() => service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Bank', rateType: 'cash_selling', idempotencyKey: 'observation-1' })).toThrow(/sourceUrl and contentHash/);
    expect(() => service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', scope: { kind: 'issuer', issuer: 'Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: 'missing', observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' })).toThrow(/accepted official evidence/);
  });

  it('reuses a fresh stored observation during planned recommendation', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-09T00:00:00Z', maxAgeSeconds: 86400, provider: 'Bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/rate', contentHash: 'rate', idempotencyKey: 'obs-1' });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    expect(result.requiredActions.some((action) => action.fxResolutionRequest?.quoteCurrency === 'TWD')).toBe(false);
    expect(result.candidates.find((candidate) => candidate.cardId === 'card-jpy')?.matchedRules[0]?.status).toBe('matched');
  });

  it('returns a stale estimate with a refresh action instead of dropping the candidate', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-01T00:00:00Z', maxAgeSeconds: 3600, provider: 'Bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/rate', contentHash: 'rate', idempotencyKey: 'obs-stale' });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    const candidate = result.candidates.find((item) => item.cardId === 'card-jpy');
    expect(candidate?.fxEstimate?.status).toBe('stale_estimate');
    expect(result.requiredActions.some((action) => action.fxResolutionRequest?.quoteCurrency === 'TWD')).toBe(true);
  });

  it('preserves route and edge scope when persisting observations', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    const observation = service.upsertFxObservation({ baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32000000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Wallet', rateType: 'spot_selling', sourceUrl: 'https://wallet.example/rate', contentHash: 'route-rate', routeIdScope: 'route-1', edgeIdScope: 'edge-1', idempotencyKey: 'route-obs-1' });
    expect(observation.routeIdScope).toBe('route-1');
    expect(observation.edgeIdScope).toBe('edge-1');
    expect(() => service.upsertFxObservation({ baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32000000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Wallet', rateType: 'spot_selling', sourceUrl: 'https://wallet.example/rate', contentHash: 'route-rate', edgeIdScope: 'edge-2', idempotencyKey: 'bad-scope' })).toThrow(/requires routeIdScope/);
  });
});
