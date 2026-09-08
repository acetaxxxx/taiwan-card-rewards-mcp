import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore { private state: StoredState = emptyState(); read() { return structuredClone(this.state); } write(next: StoredState) { this.state = structuredClone(next); } update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); } close() {} }
const route = { status: 'active' as const, idempotencyKey: 'path', layers: [{ kind: 'card_issuer' as const, providerId: 'bank', evidenceIds: ['official-route'] }], funding: { kind: 'credit_card' as const, cardId: 'card-1' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://bank.example/offer', authority: 'issuer' as const, confidence: 'high' as const, evidenceIds: ['official-route'], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'user' } };

describe('proactive payment path recommendation', () => {
  it('returns a bounded candidate with events and reward breakdown for an evidenced active route', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });
    const evidence = service.submitEvidence({ id: 'official-route', requirementId: 'route', sourceIdentity: 'jko', sourceType: 'official', authority: 'wallet', claim: { route: 'paypay-jko-card' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'route-hash', reviewState: 'accepted', sourceUrl: 'https://www.jkopay.com/application/faq' });
    service.upsertPaymentRoute({ ...route, evidenceIds: [evidence.id], layers: route.layers.map((layer) => ({ ...layer, evidenceIds: [evidence.id] })) });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 10000, currency: 'TWD' }, merchant: 'shop', asOf: '2026-09-02T00:00:00Z' });
    expect(result.status).toBe('ok'); expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toEqual(expect.objectContaining({ routeId: expect.any(String), fundingSource: route.funding, grossReward: { amountMinor: 0, currency: 'TWD' } }));
    expect(result.candidates[0]?.events.length).toBeGreaterThan(0);
  });
  it('fails closed for unverified or non-active routes and remains user scoped', () => {
    const store = new MemoryStore(); const one = new RewardService(store, 'u1'); const two = new RewardService(store, 'u2');
    one.upsertPaymentRoute({ ...route, status: 'candidate', confirmation: undefined, evidenceIds: undefined, idempotencyKey: 'candidate' });
    expect(one.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } }).candidates).toHaveLength(0);
    expect(two.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } }).candidates).toHaveLength(0);
  });
});
