import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { evaluateOffer } from '../src/evaluator.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close(): void {}
}

describe('MerchantIdentity and active-offer discovery runtime', () => {
  it('generates MCP-owned candidate IDs and resolves only exact normalized names after confirmation', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const merchant = service.registerMerchant({ canonicalNameZhHant: '全聯福利中心', canonicalNameLocale: 'zh-Hant-TW', status: 'active', officialAliases: ['全聯'], operatingMarkets: ['TW'], provenance: { version: '1', updatedAt: '2026-08-01T00:00:00Z' } });
    expect(merchant.canonicalId).toMatch(/^mch_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(merchant.status).toBe('candidate');
    expect(service.resolveMerchant(' 全聯 ').resolutionStatus).toBe('confirmed');
    expect(service.resolveMerchant('全聯福利中心').merchant?.canonicalId).toBe(merchant.canonicalId);
    expect(service.resolveMerchant('全聯', { country: 'JP' }).resolutionStatus).toBe('unresolved');
    expect(service.confirmMerchant(merchant.canonicalId).status).toBe('active');
  });

  it('returns only active, verified, in-window offers with stable bounded pages', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    const merchant = service.registerMerchant({ canonicalNameZhHant: '全聯', canonicalNameLocale: 'zh-Hant-TW', status: 'candidate', provenance: { version: '1', updatedAt: '2026-08-01T00:00:00Z' } });
    service.confirmMerchant(merchant.canonicalId);
    service.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer({ id: 's1', url: 'https://bank.example/o', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true, validTo: '2026-12-31T23:59:59Z' }, { id: 'r1', cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z', validTo: '2026-12-31T23:59:59Z', settlementCurrency: 'TWD', match: { merchants: [merchant.canonicalId] }, reward: { kind: 'percentage', rateBps: 100 } });
    const found = service.searchActiveOffers({ rawQuery: '全聯', limit: 1, page: 1, asOf: '2026-08-20T00:00:00Z' });
    expect(found.offers.map((rule) => rule.id)).toEqual(['r1']);
    expect(found.pageInfo).toMatchObject({ page: 1, limit: 1, total: 1, totalPages: 1, hasMore: false });
    expect(service.searchActiveOffers({ rawQuery: '全聯', asOf: '2027-01-01T00:00:00Z' }).offers).toHaveLength(0);
  });

  it('provides actionable merchant and FX recovery diagnostics without guessing', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const unresolved = service.resolveMerchant('不存在的商家');
    expect(unresolved.resolutionStatus).toBe('unresolved');
    expect(unresolved.requiredFacts).toContain('transaction.merchant');
    const result = evaluateOffer({ id: 'r', cardId: 'c', version: '1', sourceSnapshotId: 's', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } }, { cardId: 'c', kind: 'purchase', mode: 'planned', occurredAt: '2026-08-20T00:00:00Z', amount: { amountMinor: 100, currency: 'JPY' } }, { now: '2026-08-20T00:00:00Z', sourceSnapshots: { s: { id: 's', url: 'https://bank.example', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true } } });
    expect(result.diagnostics?.[0]).toMatchObject({ code: 'fx_missing', path: 'transaction.fx', retryAction: 'query_approved_fx_source' });
  });
});
