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

const source = { id: 'source-1', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'hash', parserVersion: '1', verified: true };
const transaction = { cardId: 'card-1', kind: 'purchase' as const, mode: 'planned' as const, merchant: '全聯', mcc: '5411', country: 'TW', occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 1000, currency: 'TWD' } };

describe('recommendation preflight public service seam', () => {
  it('returns ready with known facts and deterministic evaluation metadata', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer(source, { id: 'rule-1', cardId: 'card-1', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });

    const result = service.preflightRecommendation(transaction);

    expect(result.ready).toBe(true);
    expect(result.knownFacts).toEqual(expect.arrayContaining(['card:card-1', 'transaction:amount', 'transaction:occurredAt']));
    expect(result.requirements).toEqual([]);
    expect(result.requiredActions).toEqual([]);
    expect(result.diagnostics).toEqual([]);
    expect(result.evaluatedAt).toBe(transaction.occurredAt);
    expect(result.dataVersion).toMatch(/^[a-f0-9]{16}$/);
  });

  it('fails closed with a targeted merchant action and does not mutate durable state', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer(source, { id: 'rule-1', cardId: 'card-1', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: { merchants: ['mch_missing'] }, reward: { kind: 'percentage', rateBps: 100 } });
    const before = store.read();

    const result = service.preflightRecommendation({ ...transaction, merchant: '未知商家' });

    expect(result.ready).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: 'merchant_ambiguous', path: 'transaction.merchant', requiredFacts: ['transaction.market'], retryAction: 'resolve_merchant' });
    expect(result.requiredActions[0]).toMatchObject({ action: 'resolve_merchant' });
    expect(store.read()).toEqual(before);
  });

  it('reports stale rules and missing FX as separate recovery diagnostics', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank', productName: 'Card' });
    service.upsertOffer({ ...source, verified: true }, { id: 'rule-1', cardId: 'card-1', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2020-01-01T00:00:00Z', validTo: '2020-12-31T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const result = service.preflightRecommendation({ ...transaction, amount: { amountMinor: 1000, currency: 'USD' } });
    expect(result.ready).toBe(false);
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'stale_rule', retryAction: 'refresh_external_data' }),
      expect.objectContaining({ code: 'fx_missing', path: 'transaction.fx', retryAction: 'query_approved_fx_source' }),
    ]));
  });

  it('returns invalid_input diagnostics rather than throwing for malformed pre-flight input', () => {
    const result = new RewardService(new MemoryStore(), 'u1').preflightRecommendation({ amount: 'not-money' });
    expect(result.ready).toBe(false);
    expect(result.diagnostics[0]).toMatchObject({ code: 'invalid_input', path: 'transaction', retryAction: 'fix_payload' });
  });
});
