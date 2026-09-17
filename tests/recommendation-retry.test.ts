import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) { const next = this.read(); change(next); this.write(next); return this.read(); }
  close() {}
}

describe('typed stateless recommendation retry', () => {
  it('re-evaluates the original intent after validated supplemental facts', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer(
      { id: 'source-1', url: 'https://bank.example/terms', fetchedAt: '2026-09-16T00:00:00Z', contentHash: 'hash-1', parserVersion: '1', verified: true },
      { id: 'rule-1', cardId: 'card-1', version: '1', sourceSnapshotId: 'source-1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 300 } },
    );
    const merchant = service.registerMerchant({ canonicalNameZhHant: 'Retry Shop', canonicalNameLocale: 'zh-Hant-TW', status: 'candidate', operatingMarkets: ['TW'], provenance: { version: '1', updatedAt: '2026-09-16T00:00:00Z' } });
    service.confirmMerchant(merchant.canonicalId);
    const first = service.recommendIntent({ merchant: merchant.canonicalId, country: 'TW', occurredAt: '2026-09-16T00:00:00Z' });
    expect(first.requiredActions.some((action) => action.id === 'amount')).toBe(true);
    const retried = service.recommendIntent({
      merchant: merchant.canonicalId,
      country: 'TW',
      occurredAt: '2026-09-16T00:00:00Z',
      resultVersion: first.resultVersion,
      supplementalFacts: { amount: { amountMinor: 1000, currency: 'TWD' } },
    });
    expect(retried.candidates[0]?.status).toBe('ready');
    expect(retried.candidates[0]?.reward).toEqual({ amountMinor: 30, currency: 'TWD' });
    expect(retried.resultVersion).not.toBe(first.resultVersion);
  });

  it('rejects stale versions and conflicting typed facts without mutating state', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    const before = store.read();
    expect(() => service.recommendIntent({ merchant: 'Shop', expectedResultVersion: 'stale', supplementalFacts: { amount: { amountMinor: 1, currency: 'TWD' } } })).toThrow(/stale/);
    expect(() => service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1, currency: 'TWD' }, supplementalFacts: { amount: { amountMinor: 2, currency: 'TWD' } } })).toThrow(/conflicts/);
    expect(store.read()).toEqual(before);
  });
});
