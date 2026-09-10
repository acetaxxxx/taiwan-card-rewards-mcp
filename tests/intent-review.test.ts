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
const asOf = '2026-09-10T00:00:00Z';
function baseCard(service: RewardService) {
  service.registerCard({ id: 'base-card', issuer: 'Bank', productName: 'Base card' });
  service.upsertOffer(
    { id: 'base-source', url: 'https://bank.example/terms', fetchedAt: asOf, contentHash: 'base', parserVersion: '1', verified: true },
    { id: 'base-rule', cardId: 'base-card', version: '1', sourceSnapshotId: 'base-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } },
  );
}

describe('intent recommendation independent acceptance review', () => {
  it('validates partial requests before entering calculation', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    expect(() => service.recommendIntent({ merchant: 'Shop', limit: 0 })).toThrow(/limit/);
    expect(() => service.recommendIntent({ merchant: { name: 42 } })).toThrow(/merchant/);
    expect(() => service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1, currency: 'TWD', extra: true } })).toThrow(/unsupported/);
    expect(() => service.recommendIntent({ merchant: { name: 'Shop', country: 'JP' }, country: 'TW' })).toThrow(/conflicting/);
  });

  it('uses nested merchant country for rule applicability', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    baseCard(service);
    store.update(state => { state.rules[0]!.match.countries = ['TW']; });
    const args = { amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: asOf };
    const taiwan = service.recommendIntent({ ...args, merchant: { name: 'Shop', country: 'TW' } });
    const japan = service.recommendIntent({ ...args, merchant: { name: 'Shop', country: 'JP' } });
    expect(taiwan.candidates[0]?.status).toBe('ready');
    expect(japan.candidates[0]?.matchedRules[0]?.status).toBe('excluded');
    expect(japan.candidates[0]?.reward).toBeUndefined();
  });

  it('reports missing setup rather than no_match for an empty store', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: asOf });
    expect(result.status).toBe('needs_input');
    expect(result.requiredActions.length).toBeGreaterThan(0);
  });

  it('keeps base rewards calculable when a merchant name is ambiguous', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    baseCard(service);
    for (const market of ['TW', 'JP']) {
      const merchant = service.registerMerchant({ canonicalNameZhHant: 'Shared shop', canonicalNameLocale: 'zh-Hant-TW', status: 'candidate', operatingMarkets: [market], provenance: { version: '1', updatedAt: asOf } });
      service.confirmMerchant(merchant.canonicalId);
    }
    const before = store.read();
    const result = service.recommendIntent({ merchant: 'Shared shop', amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: asOf });
    expect(result.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'ready' })]));
    expect(result.requiredActions.length).toBeGreaterThan(0);
    expect(store.read()).toEqual(before);
  });

  it('never reports missing conversion as a confident zero reward', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    baseCard(service);
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 10000, currency: 'JPY' }, occurredAt: asOf });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.candidates.every(candidate => candidate.status !== 'ready')).toBe(true);
    expect(result.status).not.toBe('no_match');
  });

  it('keeps distinct currency requirements attached to their affected candidates', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    baseCard(service);
    service.registerCard({ id: 'usd-card', issuer: 'Other bank', productName: 'USD card' });
    service.upsertOffer(
      { id: 'usd-source', url: 'https://other.example/terms', fetchedAt: asOf, contentHash: 'usd', parserVersion: '1', verified: true },
      { id: 'usd-rule', cardId: 'usd-card', version: '1', sourceSnapshotId: 'usd-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'USD', match: {}, reward: { kind: 'percentage', rateBps: 100 } },
    );
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 10000, currency: 'JPY' }, occurredAt: asOf });
    expect(result.requiredActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateIds: ['card:base-card'], fxResolutionRequest: expect.objectContaining({ baseCurrency: 'JPY', quoteCurrency: 'TWD' }) }),
      expect.objectContaining({ candidateIds: ['card:usd-card'], fxResolutionRequest: expect.objectContaining({ baseCurrency: 'JPY', quoteCurrency: 'USD' }) }),
    ]));
    store.update(state => { state.rules.find(rule => rule.id === 'usd-rule')!.cardId = 'base-card'; });
    const multiTarget = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 10000, currency: 'JPY' }, occurredAt: asOf });
    expect(multiTarget.requiredActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ candidateIds: ['card:base-card'], fxResolutionRequest: expect.objectContaining({ quoteCurrency: 'TWD' }) }),
      expect.objectContaining({ candidateIds: ['card:base-card'], fxResolutionRequest: expect.objectContaining({ quoteCurrency: 'USD' }) }),
    ]));
  });
});
