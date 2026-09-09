import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read() { return structuredClone(this.state); }
  write(next: StoredState) { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close() {}
}

describe('planned payment events', () => {
  it('builds deterministic account-to-wallet planned events without writing the ledger', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const evidence = service.submitEvidence({ id: 'plan-route', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'account-wallet-merchant' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'plan-route-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const account = service.upsertPaymentAccount({ providerId: 'bank', kind: 'linked_bank_account', displayName: 'Bank', status: 'active', observedAt: '2026-09-01T00:00:00Z', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'plan-account' });
    const route = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'plan-route', layers: [], funding: { kind: 'account', subtype: 'linked_bank_account', accountId: account.id }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], nodes: [{ id: 'account', kind: 'funding_source', displayName: 'account' }, { id: 'wallet', kind: 'wallet_balance', displayName: 'wallet' }, { id: 'merchant', kind: 'merchant', displayName: 'merchant' }], edges: [{ edgeId: 'fund', fromNodeId: 'account', toNodeId: 'wallet', transition: 'account_debit', evidenceIds: [evidence.id] }, { edgeId: 'spend', fromNodeId: 'wallet', toNodeId: 'merchant', transition: 'merchant_settlement', evidenceIds: [evidence.id] }], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    const before = store.read();
    const first = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id], asOf: '2026-09-02T00:00:00Z' });
    const second = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id], asOf: '2026-09-02T00:00:00Z' });
    const events = first.candidates[0]?.events ?? [];
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual(expect.objectContaining({ kind: 'top_up', planEventId: expect.stringContaining('plan:'), transition: 'account_debit', routeEdgeIds: ['fund'], evidenceIds: [evidence.id] }));
    expect(events[0]?.amount).toBeUndefined();
    expect(events[0]?.eligibility?.status).toBe('unknown');
    expect(events[1]).toEqual(expect.objectContaining({ kind: 'purchase', amount: { amountMinor: 100, currency: 'TWD' }, transition: 'merchant_settlement', routeEdgeIds: ['spend'], evidenceIds: [evidence.id] }));
    expect(events[0]?.relations).toEqual([{ type: 'planned_precedes', eventId: events[1]?.planEventId }, { type: 'planned_enables', eventId: events[1]?.planEventId }]);
    expect(first.candidates[0]?.id).toBe(second.candidates[0]?.id);
    expect(store.read()).toEqual(before);
  });

  it('keeps an aggregate wallet balance as an independent purchase seed', () => {
    const store = new MemoryStore(); const service = new RewardService(store, 'u1');
    const account = service.upsertPaymentAccount({ providerId: 'wallet', kind: 'wallet_balance', displayName: 'Wallet', status: 'active', observedAt: '2026-09-01T00:00:00Z', balance: { amountMinor: 500, currency: 'TWD' }, confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'wallet-seed' });
    const evidence = service.submitEvidence({ id: 'wallet-purchase', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'wallet-purchase' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'wallet-purchase-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const route = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'wallet-purchase', layers: [], funding: { kind: 'account', subtype: 'wallet_balance', accountId: account.id }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
    service.upsertOffer({ id: 'provider-snapshot', url: 'https://wallet.example/terms', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'provider-snapshot-hash', parserVersion: '1', verified: true }, { id: 'wallet-purchase-rule', version: '1', sourceSnapshotId: 'provider-snapshot', status: 'active', validFrom: '2026-09-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'cash', amountMinor: 20, currency: 'TWD' }, componentKind: 'payment_provider', routeId: route.id, eventRule: { id: 'wallet-purchase-event', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance' } });
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id] });
    expect(result.candidates[0]?.fundingSource).toEqual({ kind: 'account', subtype: 'wallet_balance', accountId: account.id });
    expect(result.candidates[0]?.events).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'purchase', amount: { amountMinor: 100, currency: 'TWD' } })]));
    expect(result.candidates[0]?.events[0]?.rewards).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'wallet-purchase-rule', status: 'ready', reward: { amountMinor: 20, currency: 'TWD' } })]));
    expect(result.candidates[0]?.matchedRules).toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: 'wallet-purchase-rule', component: 'payment_provider' })]));
    expect(result.candidates[0]?.fundingSource).not.toHaveProperty('cardId');
  });
});
