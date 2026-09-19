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

  it('Issue 4: Natural currency amount input (USD 4.8, TWD 20, JPY 30000) with automatic minor-unit scaling', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'usd-card', issuer: 'Bank', productName: 'US Card', network: 'VISA' });
    const source = { id: 's1', url: 'https://example.com', fetchedAt: at, contentHash: 'h1', parserVersion: '1', verified: true as const };

    service.upsertOffer(source, {
      id: 'rule-usd-5pct',
      cardId: 'usd-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'USD',
      match: {},
      reward: { kind: 'percentage', rateBps: 500 }, // 5%
    });

    // 1. Agent inputs natural USD: amount: { amount: 4.8, currency: 'USD' } -> 480 minor units
    const res1 = service.recommendIntent({
      merchant: 'Uber',
      amount: { amount: 4.8, currency: 'USD' },
      occurredAt: at,
    });
    const cand1 = res1.candidates.find(c => c.id === 'card:usd-card');
    expect(cand1?.status).toBe('ready');
    // 5% of 480 cents = 24 cents
    expect(cand1?.reward).toEqual({ amountMinor: 24, currency: 'USD' });

    // 2. Agent inputs top-level amount: 4.8, currency: 'USD'
    const res2 = service.recommendIntent({
      merchant: 'Uber',
      amount: 4.8,
      currency: 'USD',
      occurredAt: at,
    } as any);
    const cand2 = res2.candidates.find(c => c.id === 'card:usd-card');
    expect(cand2?.status).toBe('ready');
    expect(cand2?.reward).toEqual({ amountMinor: 24, currency: 'USD' });

    // 3. Agent mistakenly inputs float in amountMinor: { amountMinor: 4.8, currency: 'USD' }
    const res3 = service.recommendIntent({
      merchant: 'Uber',
      amount: { amountMinor: 4.8, currency: 'USD' },
      occurredAt: at,
    });
    const cand3 = res3.candidates.find(c => c.id === 'card:usd-card');
    expect(cand3?.status).toBe('ready');
    expect(cand3?.reward).toEqual({ amountMinor: 24, currency: 'USD' });

    // 4. Natural TWD: amount: { amount: 20, currency: 'TWD' } -> 2000 minor units
    service.registerCard({ id: 'twd-card', issuer: 'Bank', productName: 'TW Card', network: 'VISA' });
    service.upsertOffer(source, {
      id: 'rule-twd-10pct',
      cardId: 'twd-card',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: {},
      reward: { kind: 'percentage', rateBps: 1000 }, // 10%
    });
    const res4 = service.recommendIntent({
      merchant: 'FamilyMart',
      amount: { amount: 20, currency: 'TWD' },
      occurredAt: at,
    });
    const cand4 = res4.candidates.find(c => c.id === 'card:twd-card');
    expect(cand4?.status).toBe('ready');
    // 10% of 2000 cents = 200 cents (2.00 TWD)
    expect(cand4?.reward).toEqual({ amountMinor: 200, currency: 'TWD' });
  });

  it('Issue 5: routeFacts with credit card scheme FX example', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'fubon-jcb', issuer: 'Fubon', productName: 'J Premium Card', network: 'JCB' });
    const source = { id: 's1', url: 'https://example.com', fetchedAt: at, contentHash: 'h1', parserVersion: '1', verified: true as const };

    service.upsertOffer(source, {
      id: 'rule-fubon-jpy',
      cardId: 'fubon-jcb',
      version: '1',
      sourceSnapshotId: source.id,
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: { countries: ['JP'] },
      reward: { kind: 'percentage', rateBps: 300 }, // 3.0%
    });

    // Credit card routeFacts example
    const creditCardRouteFx: FxSnapshot = {
      id: 'fx_quote_jpy_twd_jcb',
      baseCurrency: 'JPY',
      quoteCurrency: 'TWD',
      ratePpm: 215_000, // 0.215
      capturedAt: at,
      maxAgeSeconds: 86400,
      provider: 'JCB',
      rateType: 'card_scheme',
      cardScheme: 'jcb',
      sourceUrl: 'https://www.jcb.tw/rate/jpy.html',
    };

    const res = service.recommendIntent({
      merchant: 'Bic Camera',
      amount: { amount: 50000, currency: 'JPY' },
      country: 'JP',
      occurredAt: at,
      routeFacts: [
        {
          routeId: 'card:fubon-jcb',
          fx: creditCardRouteFx,
        },
      ],
    });

    const cand = res.candidates.find(c => c.id === 'card:fubon-jcb');
    expect(cand?.status).toBe('ready');
    // 50,000 JPY * 0.215 = 10,750 TWD = 1,075,000 minor units
    // 3% of 1,075,000 = 32,250 minor units (322.50 TWD)
    expect(cand?.reward).toEqual({ amountMinor: 32250, currency: 'TWD' });
  });
});

