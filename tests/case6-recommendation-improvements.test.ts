import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import type { FxSnapshot } from '../src/types.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read() { return structuredClone(this.state); }
  write(next: StoredState) { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close() {}
}

describe('Case6 Recommendation Improvements', () => {
  const at = '2026-09-18T12:00:00Z';

  it('Issue 1: ISO 4217 natural currency input - converts JPY 30,000 without manual 100x multiplication', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'jcb-card', issuer: 'UnionBank', productName: 'Jihe Card', network: 'JCB' });

    const source = { id: 'source-1', url: 'https://example.com/jihe', fetchedAt: at, contentHash: 'h1', parserVersion: '1', verified: true as const };
    // 3% flat reward on Japan in-store spend
    service.upsertOffer(source, {
      id: 'rule-jpy-3pct',
      cardId: 'jcb-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'] },
      reward: { kind: 'percentage', rateBps: 300 }, // 3.0%
    });

    const jcbFx: FxSnapshot = {
      id: 'fx-jcb-jpy',
      baseCurrency: 'JPY',
      quoteCurrency: 'TWD',
      ratePpm: 215_000, // 0.215 TWD per JPY
      capturedAt: at,
      provider: 'JCB',
      cardScheme: 'JCB',
      rateType: 'card_scheme',
    };

    // Agent inputs natural 30,000 JPY (no manual 100x multiplication)
    const result = service.recommendIntent({
      merchant: 'Tokyo Yakiniku',
      amount: { amountMinor: 30_000, currency: 'JPY' },
      country: 'JP',
      occurredAt: at,
      fx: [jcbFx],
    });

    const cand = result.candidates.find(c => c.id === 'card:jcb-card');
    expect(cand).toBeDefined();
    expect(cand?.status).toBe('ready');

    // 30,000 JPY * 0.215 = 6,450 TWD = 645,000 TWD minor units
    // 3% of 645,000 = 19,350 TWD minor units (193.50 TWD)
    expect(cand?.reward?.currency).toBe('TWD');
    expect(cand?.reward?.amountMinor).toBe(19350);
  });

  it('Issue 2: Array of FX snapshots and non-poisoning of credit cards', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'jcb-card', issuer: 'UnionBank', productName: 'Jihe Card', network: 'JCB' });
    service.registerCard({ id: 'visa-card', issuer: 'Taishin', productName: 'Rose Card', network: 'VISA' });

    const source = { id: 'source-1', url: 'https://example.com/terms', fetchedAt: at, contentHash: 'h1', parserVersion: '1', verified: true as const };
    service.upsertOffer(source, {
      id: 'rule-jcb-base',
      cardId: 'jcb-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'] },
      reward: { kind: 'percentage', rateBps: 250 },
    });
    service.upsertOffer(source, {
      id: 'rule-visa-base',
      cardId: 'visa-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'] },
      reward: { kind: 'percentage', rateBps: 300 },
    });

    const jcbFx: FxSnapshot = {
      id: 'fx-jcb',
      baseCurrency: 'JPY',
      quoteCurrency: 'TWD',
      ratePpm: 215_000,
      capturedAt: at,
      provider: 'JCB',
      cardScheme: 'JCB',
      rateType: 'card_scheme',
    };
    const walletCashFx: FxSnapshot = {
      id: 'fx-taishin-cash',
      baseCurrency: 'JPY',
      quoteCurrency: 'TWD',
      ratePpm: 218_000,
      capturedAt: at,
      provider: 'TaishinBank',
      rateType: 'cash_selling', // wallet cash selling rate
    };

    // Both passed in fx array!
    const result = service.recommendIntent({
      merchant: 'Bic Camera',
      amount: { amountMinor: 50_000, currency: 'JPY' },
      country: 'JP',
      occurredAt: at,
      fx: [jcbFx, walletCashFx],
    });

    const candJcb = result.candidates.find(c => c.id === 'card:jcb-card');
    const candVisa = result.candidates.find(c => c.id === 'card:visa-card');

    // JCB card matches jcbFx and is ready
    expect(candJcb?.status).toBe('ready');
    expect(candJcb?.reward?.amountMinor).toBe(26875); // 50,000 * 0.215 * 100 * 2.5% = 26,875

    // Visa card does NOT match JCB quote and does NOT get poisoned by cash_selling!
    expect(candVisa?.status).toBe('unknown');
    expect(candVisa?.exclusionReasons).toBeDefined();
  });

  it('Issue 3: Auto-fanout of payment postures when paymentMethod is omitted', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'jihe-card', issuer: 'UnionBank', productName: 'Jihe Card', network: 'JCB' });

    const source = { id: 'source-1', url: 'https://example.com/jihe', fetchedAt: at, contentHash: 'h1', parserVersion: '1', verified: true as const };

    // Rule 1: 2.5% base reward (physical swipe or general)
    service.upsertOffer(source, {
      id: 'rule-jihe-base',
      cardId: 'jihe-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'] },
      reward: { kind: 'percentage', rateBps: 250 }, // 2.5%
      combination: { mode: 'additive', groupId: 'jihe-japan', version: '1', priority: 1 },
    });

    // Rule 2: 1.5% Apple Pay boost
    service.upsertOffer(source, {
      id: 'rule-jihe-applepay',
      cardId: 'jihe-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'], paymentMethods: ['apple_pay'] },
      reward: { kind: 'percentage', rateBps: 150 }, // 1.5%
      combination: { mode: 'additive', groupId: 'jihe-japan', version: '1', priority: 2 },
    });

    const jcbFx: FxSnapshot = {
      id: 'fx-jcb',
      baseCurrency: 'JPY',
      quoteCurrency: 'TWD',
      ratePpm: 215_000,
      capturedAt: at,
      provider: 'JCB',
      cardScheme: 'JCB',
      rateType: 'card_scheme',
    };

    // User calls recommend WITHOUT specifying paymentMethod
    const result = service.recommendIntent({
      merchant: 'Bic Camera',
      amount: { amountMinor: 30_000, currency: 'JPY' },
      country: 'JP',
      occurredAt: at,
      fx: [jcbFx],
    });

    const cand = result.candidates.find(c => c.id === 'card:jihe-card');
    expect(cand).toBeDefined();
    expect(cand?.status).toBe('ready');

    // Total reward should be 4.0% (base 2.5% + apple_pay 1.5% = 4.0%)
    // 30,000 * 0.215 = 6,450 TWD = 645,000 minor units
    // 4% of 645,000 = 25,800 TWD minor units
    expect(cand?.reward?.amountMinor).toBe(25800);

    // Apple pay rule should be matched, not unknown!
    const applePayRule = cand?.matchedRules.find(r => r.ruleId === 'rule-jihe-applepay');
    expect(applePayRule?.status).toBe('matched');

    // Payment method node should show apple_pay
    expect(cand?.nodes.some(n => n.displayName === 'apple_pay')).toBe(true);
  });
});
