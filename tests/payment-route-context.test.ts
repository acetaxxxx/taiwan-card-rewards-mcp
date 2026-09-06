import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { validateTransaction } from '../src/validation.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore { private state: StoredState = emptyState(); read() { return structuredClone(this.state); } write(next: StoredState) { this.state = structuredClone(next); } update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); } close() {} }

describe('payment route and FX mechanism context', () => {
  it('round-trips complete route chain, conversion metadata, and fee/DCC context', () => {
    const transaction = { cardId: 'c1', kind: 'purchase' as const, mode: 'planned' as const, occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 1000, currency: 'USD' }, routeContext: { merchantId: 'm1', walletProviderId: 'wallet', paymentMethod: 'wallet', intermediateProviderId: 'provider', cardNetwork: 'visa', issuer: 'bank', fundingSource: 'card', transactionCurrency: 'USD', settlementCurrency: 'TWD', billingCurrency: 'TWD', conversionOwner: 'card_network', rateType: 'card_scheme' as const, conversionTiming: 'clearing' as const, foreignTransactionFee: { amountMinor: 20, currency: 'TWD' }, markup: { amountMinor: 5, currency: 'TWD' }, serviceFee: { amountMinor: 2, currency: 'TWD' }, dcc: false } };
    expect(validateTransaction(transaction).routeContext).toEqual(transaction.routeContext);
  });

  it('fails closed when a foreign route lacks conversion owner', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    service.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer({ id: 's', url: 'https://bank.example', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true }, { id: 'r', cardId: 'c1', version: '1', sourceSnapshotId: 's', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const result = service.preflightRecommendation({ cardId: 'c1', kind: 'purchase', mode: 'planned', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 1000, currency: 'USD' }, routeContext: { transactionCurrency: 'USD', settlementCurrency: 'TWD' } });
    expect(result.ready).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_required_fact', path: 'transaction.routeContext.conversionOwner' })]));
  });
});
