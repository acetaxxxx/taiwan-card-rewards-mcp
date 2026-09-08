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
    expect(one.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } })).toEqual(expect.objectContaining({ candidates: [], blocked: [expect.objectContaining({ reason: expect.stringContaining('active') })] }));
    expect(two.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } }).candidates).toHaveLength(0);
  });
  it('generates a bounded multi-layer plan without mutating the ledger', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'multi', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'account-wallet-merchant' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'multi-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const account = service.upsertPaymentAccount({ providerId: 'bank', kind: 'linked_bank_account', displayName: 'Bank', status: 'active', observedAt: '2026-09-01T00:00:00Z', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'account' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'multi-route', layers: [{ kind: 'wallet', providerId: 'wallet', evidenceIds: [evidence.id] }, { kind: 'merchant_acceptance', providerId: 'network', evidenceIds: [evidence.id] }], funding: { kind: 'account', subtype: 'linked_bank_account', accountId: account.id }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const before = store.read(); const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, limit: 20 });
    expect(result.candidates[0]?.events).toHaveLength(2); expect(store.read()).toEqual(before);
  });
  it('rejects model-fixture edges at the production service boundary', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'fixture', requirementId: 'route', sourceIdentity: 'fixture', sourceType: 'official', authority: 'wallet', claim: { route: 'fixture' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'fixture-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'fixture-route', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'cash', kind: 'funding_source', displayName: 'cash' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'e', fromNodeId: 'cash', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], provenance: 'model_fixture' }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    expect(service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } }).candidates).toHaveLength(0);
  });
  it('is deterministic and rejects bounds beyond the public limit', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    expect(() => service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, limit: 21 })).toThrow(/limit/);
    const first = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z' });
    const second = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z' });
    expect(second).toEqual(first);
  });
  it('enumerates two terminal branches from one funding seed in stable order', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'graph', requirementId: 'route', sourceIdentity: 'graph', sourceType: 'official', authority: 'wallet', claim: { route: 'graph' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'graph-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'graph-route', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'source', kind: 'funding_source', displayName: 'source' }, { id: 'w1', kind: 'wallet_balance', displayName: 'W1' }, { id: 'w2', kind: 'wallet_balance', displayName: 'W2' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'a', fromNodeId: 'source', toNodeId: 'w1', transition: 'wallet_top_up', evidenceIds: [evidence.id] }, { edgeId: 'b', fromNodeId: 'source', toNodeId: 'w2', transition: 'wallet_top_up', evidenceIds: [evidence.id] }, { edgeId: 'c', fromNodeId: 'w1', toNodeId: 'merchant', transition: 'merchant_settlement', evidenceIds: [evidence.id] }, { edgeId: 'd', fromNodeId: 'w2', toNodeId: 'merchant', transition: 'merchant_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } });
    expect(result.candidates).toHaveLength(2); expect(result.candidates[0]?.pathSignature).not.toBe(result.candidates[1]?.pathSignature);
  });
  it('admits only an explicitly confirmed wallet balance seed with sufficient balance', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const account = service.upsertPaymentAccount({ providerId: 'wallet', kind: 'wallet_balance', displayName: 'W', status: 'active', observedAt: '2026-09-01T00:00:00Z', balance: { amountMinor: 100, currency: 'TWD' }, confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'wallet-balance' });
    const evidence = service.submitEvidence({ id: 'wallet-seed', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'wallet' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'wallet-seed-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'wallet-route', layers: [{ kind: 'wallet', providerId: 'wallet', evidenceIds: [evidence.id] }], funding: { kind: 'account', subtype: 'wallet_balance', accountId: account.id }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    expect(service.recommendPaymentPaths({ amount: { amountMinor: 50, currency: 'TWD' } }).candidates).toHaveLength(1);
  });
});
