import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import { validateRecommendationIntent } from '../src/validation.js';
import { buildFxResolutionRequest } from '../src/fx.js';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) { const state = this.read(); change(state); this.write(state); return this.read(); }
  close() {}
}

const at = '2026-09-10T00:00:00Z';
function addRule(service: RewardService, cardId: string, ruleId: string, settlementCurrency: string) {
  service.upsertOffer(
    { id: `source-${ruleId}`, url: `https://issuer.example/${ruleId}`, fetchedAt: at, contentHash: ruleId, parserVersion: '1', verified: true },
    { id: ruleId, cardId, version: '1', sourceSnapshotId: `source-${ruleId}`, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency, match: {}, reward: { kind: 'percentage', rateBps: 100 } },
  );
}

describe('candidate-level recovery', () => {
  it('keeps every target currency for one candidate and deduplicates duplicate rule requirements', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    service.registerCard({ id: 'card', issuer: 'Issuer', productName: 'Card' });
    addRule(service, 'card', 'twd-one', 'TWD');
    addRule(service, 'card', 'twd-two', 'TWD');
    addRule(service, 'card', 'usd', 'USD');

    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: at });
    const fxActions = result.requiredActions.filter((action) => action.fxResolutionRequest);

    expect(fxActions).toHaveLength(2);
    expect(fxActions.map((action) => action.fxResolutionRequest!.quoteCurrency).sort()).toEqual(['TWD', 'USD']);
    expect(fxActions.every((action) => action.candidateIds?.[0] === 'card:card')).toBe(true);
    expect(new Set(fxActions.map((action) => action.id)).size).toBe(2);
  });

  it('turns a stale supplied observation into an actionable refresh and never mutates the ledger', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card', issuer: 'Issuer', productName: 'Card' });
    addRule(service, 'card', 'twd', 'TWD');
    const before = store.read();

    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: at, fx: { id: 'old', baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 220, capturedAt: '2026-08-01T00:00:00Z', maxAgeSeconds: 3600, provider: 'network', rateType: 'card_scheme', sourceUrl: 'https://network.example/rate', contentHash: 'old' } });
    const action = result.requiredActions.find((candidate) => candidate.fxResolutionRequest?.quoteCurrency === 'TWD');

    expect(result.candidates[0]?.status).toBe('unknown');
    expect(action).toEqual(expect.objectContaining({ owner: 'agent', candidateIds: ['card:card'], submission: { tool: 'recommend', field: 'fx' } }));
    expect(action?.completionCondition).toContain('without new evidence, stop retrying fx_stale');
    expect(store.read()).toEqual(before);
  });

  it('rejects unbounded or duplicate route fact scopes', () => {
    const fx = { id: 'fx', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32_000_000, capturedAt: at, provider: 'bank', rateType: 'spot_selling' as const };
    expect(() => validateRecommendationIntent({ merchant: 'Shop', routeFacts: [{ routeId: 'r', edgeId: 'e', fx }, { routeId: 'r', edgeId: 'e', fx: { ...fx, id: 'fx2' } }] })).toThrow(/duplicate/);
    expect(() => validateRecommendationIntent({ merchant: 'Shop', routeFacts: Array.from({ length: 129 }, (_, index) => ({ routeId: `r${index}`, fx: { ...fx, id: `fx${index}` } })) })).toThrow(/128/);
  });

  it('does not present the public reference URL as an actual settlement source', () => {
    const actual = buildFxResolutionRequest({ transaction: { amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: at, mode: 'actual' }, targetCurrency: 'TWD' });
    const reference = buildFxResolutionRequest({ transaction: { amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: at, mode: 'planned' }, targetCurrency: 'TWD' });
    expect(actual).toEqual(expect.objectContaining({ sourceStatus: 'discovery_required', purpose: 'policy_research', submission: { tool: 'record_transaction', field: 'transaction.fx' } }));
    expect(actual.sourceUrls).toBeUndefined();
    expect(reference).toEqual(expect.objectContaining({ sourceStatus: 'known', purpose: 'reference_estimate', sourceUrls: ['https://rate.bot.com.tw/xrt?Lang=zh-TW'], rateDirection: 'base_to_quote' }));
  });
});
