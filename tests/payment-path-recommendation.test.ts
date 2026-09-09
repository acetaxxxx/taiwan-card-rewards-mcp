import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore { private state: StoredState = emptyState(); read() { return structuredClone(this.state); } write(next: StoredState) { this.state = structuredClone(next); } update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); } close() {} }
const route = { status: 'active' as const, idempotencyKey: 'path', layers: [{ kind: 'card_issuer' as const, providerId: 'bank', evidenceIds: ['official-route'] }], funding: { kind: 'credit_card' as const, cardId: 'card-1' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://bank.example/offer', authority: 'issuer' as const, confidence: 'high' as const, evidenceIds: ['official-route'], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'user' } };

describe('proactive payment path recommendation', () => {
  it('preserves explicit edge fees and marks fee currency mismatches blocked', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'fee', requirementId: 'route', sourceIdentity: 'merchant', sourceType: 'official', authority: 'merchant', claim: { route: 'fee' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'fee-hash', reviewState: 'accepted', sourceUrl: 'https://merchant.example/fees' });
    const route = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'fee-route', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://merchant.example/fees', authority: 'merchant', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'cash', kind: 'funding_source', displayName: 'cash' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'fee-edge', fromNodeId: 'cash', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], fee: { amountMinor: 5, currency: 'TWD' } }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id] });
    expect(result.candidates[0]?.events[0]).toEqual(expect.objectContaining({ fee: { amountMinor: 5, currency: 'TWD' } }));
    expect(result.candidates[0]?.feeTotal).toEqual({ amountMinor: 5, currency: 'TWD' });
    expect(result.candidates[0]?.netValue).toEqual({ amountMinor: -5, currency: 'TWD' });
    const foreign = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'fee-route-usd', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://merchant.example/fees', authority: 'merchant', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'cash-usd', kind: 'funding_source', displayName: 'cash' }, { id: 'merchant-usd', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'fee-edge-usd', fromNodeId: 'cash-usd', toNodeId: 'merchant-usd', transition: 'direct_settlement', evidenceIds: [evidence.id], fee: { amountMinor: 5, currency: 'USD' } }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const blocked = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [foreign.id] });
    expect(blocked.candidates[0]).toEqual(expect.objectContaining({ status: 'blocked', requiredActions: ['confirm fee currency or provide a validated FX snapshot'] }));
    expect(blocked.candidates[0]).not.toHaveProperty('netValue');
  });
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
  it('rejects an unauthenticated path query', () => {
    const service = new RewardService(new MemoryStore(), undefined);
    expect(() => service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } })).toThrow(/authenticated/);
  });
  it('keeps a legal terminal branch when a sibling branch contains a cycle', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'cycle', requirementId: 'route', sourceIdentity: 'cycle', sourceType: 'official', authority: 'wallet', claim: { route: 'cycle' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'cycle-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'cycle-route', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 's', kind: 'funding_source', displayName: 's' }, { id: 'w', kind: 'wallet_balance', displayName: 'w' }, { id: 'm', kind: 'merchant', displayName: 'm' }], edges: [{ edgeId: 'a', fromNodeId: 's', toNodeId: 'w', transition: 'wallet_top_up', evidenceIds: [evidence.id] }, { edgeId: 'b', fromNodeId: 'w', toNodeId: 's', transition: 'wallet_debit', evidenceIds: [evidence.id] }, { edgeId: 'c', fromNodeId: 's', toNodeId: 'm', transition: 'direct_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' } });
    expect(result.candidates).toHaveLength(1); expect(result.blocked?.some((item) => item.reason.includes('edge'))).toBe(true);
  });
  it('reports branch truncation while retaining the stable first branch', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'bound', requirementId: 'route', sourceIdentity: 'bound', sourceType: 'official', authority: 'wallet', claim: { route: 'bound' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'bound-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'bound-route', layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 's', kind: 'funding_source', displayName: 's' }, { id: 'm1', kind: 'merchant', displayName: 'm1' }, { id: 'm2', kind: 'merchant', displayName: 'm2' }], edges: [{ edgeId: 'a', fromNodeId: 's', toNodeId: 'm1', transition: 'direct_settlement', evidenceIds: [evidence.id] }, { edgeId: 'b', fromNodeId: 's', toNodeId: 'm2', transition: 'direct_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, maxBranchesPerNode: 1 });
    expect(result.candidates).toHaveLength(1); expect(result.blocked?.some((item) => item.reason.includes('maxBranchesPerNode'))).toBe(true);
  });
  it('requires exact outbound market direction in public route evidence', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'direction', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { fromRole: 'funding_source', toRole: 'merchant', transition: 'direct_settlement', fromMarket: 'TW', toMarket: 'JP' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'direction-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const base = { status: 'active' as const, layers: [], funding: { kind: 'cash' as const }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet' as const, confidence: 'high' as const, evidenceIds: [evidence.id], nodes: [{ id: 'source', kind: 'funding_source', displayName: 'source' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } };
    const matching = service.upsertPaymentRoute({ ...base, idempotencyKey: 'direction-route-matching', edges: [{ edgeId: 'outbound', fromNodeId: 'source', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], fromMarket: 'TW', toMarket: 'JP', direction: 'outbound' }] });
    const inbound = service.upsertPaymentRoute({ ...base, idempotencyKey: 'direction-route-inbound', edges: [{ edgeId: 'inbound', fromNodeId: 'source', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], fromMarket: 'JP', toMarket: 'TW', direction: 'inbound' }] });
    const missingDirection = service.upsertPaymentRoute({ ...base, idempotencyKey: 'direction-route-missing', edges: [{ edgeId: 'missing', fromNodeId: 'source', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], direction: 'outbound' }] });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z', routeIds: [matching.id] });
    const rejected = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z', routeIds: [inbound.id] });
    const missing = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z', routeIds: [missingDirection.id] });
    expect(result.candidates).toHaveLength(1);
    expect(rejected.candidates).toHaveLength(0);
    expect(missing.candidates).toHaveLength(0);
    expect(rejected.blocked?.some((item) => item.reason.includes('exact current evidence'))).toBe(true);
  });
  it('keeps candidate identity and ordering stable when public graph arrays are reversed', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'permutation', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'permutation' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'permutation-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const nodes = [{ id: 'source', kind: 'funding_source', displayName: 'source' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }];
    const edges = [{ edgeId: 'z', fromNodeId: 'source', toNodeId: 'merchant', transition: 'direct_settlement' as const, evidenceIds: [evidence.id] }];
    const base = { status: 'active' as const, layers: [], funding: { kind: 'cash' as const }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet' as const, confidence: 'high' as const, evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } };
    const firstRoute = service.upsertPaymentRoute({ ...base, idempotencyKey: 'permutation-a', nodes, edges });
    const secondRoute = service.upsertPaymentRoute({ ...base, idempotencyKey: 'permutation-b', nodes: [...nodes].reverse(), edges: [...edges].reverse() });
    const first = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z', routeIds: [firstRoute.id] });
    const second = service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z', routeIds: [secondRoute.id] });
    expect(first.candidates.map((candidate) => candidate.id)).toEqual(second.candidates.map((candidate) => candidate.id));
    expect(first.candidates[0]?.events).toEqual(second.candidates[0]?.events);
  });
  it.each([
    ['expired edge evidence', { validTo: '2026-08-01T00:00:00Z' }],
    ['conflicting edge evidence', { reviewState: 'conflict' as const }],
    ['wrong-direction edge claim', { claim: { fromRole: 'merchant', toRole: 'funding_source', transition: 'direct_settlement' } }],
  ])('blocks %s without swallowing the request', (_name, override) => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'bad-edge', requirementId: 'route', sourceIdentity: 'bad', sourceType: 'official', authority: 'wallet', claim: { route: 'bad' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: `bad-${_name}`, reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms', ...override });
    service.upsertPaymentRoute({ status: 'active', idempotencyKey: `bad-${_name}`, layers: [], funding: { kind: 'cash' }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 's', kind: 'funding_source', displayName: 's' }, { id: 'm', kind: 'merchant', displayName: 'm' }], edges: [{ edgeId: 'bad', fromNodeId: 's', toNodeId: 'm', transition: 'direct_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    expect(service.recommendPaymentPaths({ amount: { amountMinor: 1, currency: 'TWD' }, asOf: '2026-09-01T00:00:00Z' }).candidates).toHaveLength(0);
  });
});
