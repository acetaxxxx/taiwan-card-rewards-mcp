import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { evaluateOffer, FileStore, RewardService } from '../src/index.js';
import type {
  CardDescriptor,
  EvaluationContext,
  FxSnapshot,
  HeldCard,
  OfferRuleVersion,
  OfferSourceSnapshot,
  TransactionTuple,
} from '../src/types.js';

const source: OfferSourceSnapshot = {
  id: 'snap-fx',
  url: 'https://bank.example/overseas-promo',
  fetchedAt: '2026-08-01T00:00:00Z',
  contentHash: 'h1',
  parserVersion: '1.0',
};

const fxFreshUsd: FxSnapshot = {
  id: 'fx-usd-twd-1',
  baseCurrency: 'USD',
  quoteCurrency: 'TWD',
  ratePpm: 32_000_000, // 1 USD = 32.000000 TWD
  capturedAt: '2026-08-19T00:00:00Z',
};

const fxStaleUsd: FxSnapshot = {
  id: 'fx-usd-twd-old',
  baseCurrency: 'USD',
  quoteCurrency: 'TWD',
  ratePpm: 32_000_000,
  capturedAt: '2026-08-01T00:00:00Z', // 19 days before 2026-08-20, exceeds 7 days
};

const foreignCardRule: OfferRuleVersion = {
  id: 'rule-foreign',
  cardId: 'card-travel',
  version: '1',
  sourceSnapshotId: 'snap-fx',
  status: 'active',
  validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD',
  match: { countries: ['US'] },
  reward: { kind: 'percentage', rateBps: 300 }, // 3%
  capPoolRefs: ['pool-foreign-cycle'],
};

const calendarMonthRule: OfferRuleVersion = {
  id: 'rule-cal-month',
  cardId: 'card-local',
  version: '1',
  sourceSnapshotId: 'snap-fx',
  status: 'active',
  validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD',
  match: {},
  reward: { kind: 'percentage', rateBps: 500 }, // 5%
  capPoolRefs: ['pool-cal-month'],
};

const foreignPool: CapPoolDefinition = {
  id: 'pool-foreign-cycle',
  metric: 'reward',
  period: 'billing_cycle',
  limit: 30000,
  currency: 'TWD',
};

const calMonthPool: CapPoolDefinition = {
  id: 'pool-cal-month',
  metric: 'reward',
  period: 'calendar_month',
  limit: 50000,
  currency: 'TWD',
};

describe('Ticket 07: Billing cycles, currencies, and FX context', () => {
  describe('Pure evaluator FX conversion and staleness', () => {
    it('converts foreign currency using fresh FX snapshot and calculates reward in settlement currency', () => {
      const tx: TransactionTuple = {
        cardId: 'card-travel',
        kind: 'purchase',
        mode: 'planned',
        occurredAt: '2026-08-20T10:00:00Z',
        amount: { amountMinor: 10000, currency: 'USD' }, // $100.00 USD
        country: 'US',
        fx: fxFreshUsd,
      };

      const context: EvaluationContext = {
        now: '2026-08-20T12:00:00Z',
        sourceSnapshots: { 'snap-fx': source },
        capPools: [foreignPool],
        usageByKey: { 'pool-foreign-cycle|pool-foreign-cycle:2026-09': { amountMinor: 0, currency: 'TWD' } },
      };

      const result = evaluateOffer(foreignCardRule, tx, context);
      expect(result.status).toBe('ok');
      // $100 USD * 32 = 3200 TWD (320000 minor) -> 3% reward = 96 TWD (9600 minor)
      expect(result.grossReward?.amountMinor).toBe(9600);
      expect(result.grossReward?.currency).toBe('TWD');
      expect(result.cappedReward?.amountMinor).toBe(9600);
      expect(result.cappedReward?.currency).toBe('TWD');
    });

    it('fails closed with unknown when FX snapshot is missing for foreign currency', () => {
      const txNoFx: TransactionTuple = {
        cardId: 'card-travel',
        kind: 'purchase',
        mode: 'planned',
        occurredAt: '2026-08-20T10:00:00Z',
        amount: { amountMinor: 10000, currency: 'USD' },
        country: 'US',
      };

      const context: EvaluationContext = {
        now: '2026-08-20T12:00:00Z',
        sourceSnapshots: { 'snap-fx': source },
        capPools: [foreignPool],
        usageByKey: { 'pool-foreign-cycle|pool-foreign-cycle:2026-09': { amountMinor: 0, currency: 'TWD' } },
      };

      const result = evaluateOffer(foreignCardRule, txNoFx, context);
      expect(result.status).toBe('unknown');
      expect(result.unknownReasons).toContain('missing FX snapshot for settlement currency');
    });

    it('fails closed with stale status when FX snapshot is older than allowed window', () => {
      const txStaleFx: TransactionTuple = {
        cardId: 'card-travel',
        kind: 'purchase',
        mode: 'planned',
        occurredAt: '2026-08-20T10:00:00Z',
        amount: { amountMinor: 10000, currency: 'USD' },
        country: 'US',
        fx: fxStaleUsd,
      };

      const context: EvaluationContext = {
        now: '2026-08-20T12:00:00Z',
        sourceSnapshots: { 'snap-fx': source },
        capPools: [foreignPool],
        usageByKey: { 'pool-foreign-cycle|pool-foreign-cycle:2026-09': { amountMinor: 0, currency: 'TWD' } },
      };

      const result = evaluateOffer(foreignCardRule, txStaleFx, context);
      expect(result.status).toBe('stale');
      expect(result.unknownReasons).toContain('FX snapshot is stale');
    });
  });

  describe('Service-level cycle resolution and multi-period cap reconciliation', () => {
    it('isolates cap consumption by calendar month and resets naturally across months', () => {
      const dir = mkdtempSync(join(tmpdir(), 'card-rewards-cycle-'));
      const store = new FileStore({ dataDir: dir });
      try {
        const service = new RewardService(store, undefined);
        service.registerCard({ id: 'card-local', issuer: 'Local Bank', productName: 'Cashback Card' });
        service.upsertOffer(source, calendarMonthRule, undefined, [calMonthPool]);

        // August spend: 8,000 TWD -> 5% = 400 TWD (40,000 minor) against 500 TWD cap (cap remaining: 100 TWD)
        const augTx: TransactionTuple = {
          idempotencyKey: 'aug-tx-1',
          cardId: 'card-local',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-15T10:00:00Z',
          amount: { amountMinor: 800000, currency: 'TWD' },
        };
        const augResult = service.recordTransaction(augTx);
        expect(augResult.cappedReward?.amountMinor).toBe(40000);

        // Second August spend: 4,000 TWD -> 5% = 200 TWD, capped at remaining 100 TWD (10,000 minor)
        const augTx2: TransactionTuple = {
          idempotencyKey: 'aug-tx-2',
          cardId: 'card-local',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-20T10:00:00Z',
          amount: { amountMinor: 400000, currency: 'TWD' },
        };
        const augResult2 = service.recordTransaction(augTx2);
        expect(augResult2.cappedReward?.amountMinor).toBe(10000);

        // September spend in new calendar month: full 500 TWD cap is available
        const sepTx: TransactionTuple = {
          idempotencyKey: 'sep-tx-1',
          cardId: 'card-local',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-09-02T10:00:00Z',
          amount: { amountMinor: 800000, currency: 'TWD' },
        };
        const sepResult = service.recordTransaction(sepTx);
        expect(sepResult.cappedReward?.amountMinor).toBe(40000); // gets full 400 TWD without August eating it
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves billing cycles with closing day (e.g. 15th) and reconciles refunds to original billing cycle', () => {
      const dir = mkdtempSync(join(tmpdir(), 'card-rewards-billing-'));
      const store = new FileStore({ dataDir: dir });
      try {
        const service = new RewardService(store, undefined);
        // Card closing day is 15th of each month
        service.registerCard({
          id: 'card-travel',
          issuer: 'Travel Bank',
          productName: 'Traveler Elite',
        });
        service.upsertOffer(source, foreignCardRule, undefined, [foreignPool]);

        // Cycle 1 (Closing 2026-08-15, period 2026-07-16..2026-08-15):
        // Spend on 2026-08-10: $50 USD = 1,600 TWD -> 3% = 48 TWD (4,800 minor)
        const cycle1Purchase: TransactionTuple = {
          idempotencyKey: 'c1-p1',
          cardId: 'card-travel',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-10T10:00:00Z',
          amount: { amountMinor: 5000, currency: 'USD' },
          country: 'US',
          fx: { ...fxFreshUsd, capturedAt: '2026-08-10T00:00:00Z' },
        };
        const res1 = service.recordTransaction(cycle1Purchase);
        expect(res1.cappedReward?.amountMinor).toBe(4800);

        // Cycle 2 (Closing 2026-09-15, period 2026-08-16..2026-09-15):
        // Spend on 2026-08-20: $100 USD = 3,200 TWD -> 3% = 96 TWD (9,600 minor)
        const cycle2Purchase: TransactionTuple = {
          idempotencyKey: 'c2-p1',
          cardId: 'card-travel',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-20T10:00:00Z',
          amount: { amountMinor: 10000, currency: 'USD' },
          country: 'US',
          fx: fxFreshUsd,
        };
        const res2 = service.recordTransaction(cycle2Purchase);
        expect(res2.cappedReward?.amountMinor).toBe(9600);

        // Refund in Cycle 2 of the purchase from Cycle 1:
        // Reverses reward using original Cycle 1 context and restores Cycle 1 cap
        const refundCycle1: TransactionTuple = {
          idempotencyKey: 'c1-ref-1',
          cardId: 'card-travel',
          kind: 'refund',
          mode: 'actual',
          refundOfId: 'c1-p1',
          occurredAt: '2026-08-25T10:00:00Z',
          amount: { amountMinor: 5000, currency: 'USD' },
        };
        const refundRes = service.recordTransaction(refundCycle1);
        expect(refundRes.cappedReward?.amountMinor).toBe(-4800);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('validates IANA timezone and rejects invalid timezones', () => {
      const dir = mkdtempSync(join(tmpdir(), 'card-rewards-tz-val-'));
      const store = new FileStore({ dataDir: dir });
      try {
        const service = new RewardService(store, undefined);
        expect(() => {
          service.registerCard({
            id: 'card-bad-tz',
            issuer: 'Bank',
            productName: 'Card',
            timezone: 'Mars/Olympus_Mons',
          });
        }).toThrow(/timezone/i);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('resolves billing cycles with Asia/Taipei timezone boundary', () => {
      const dir = mkdtempSync(join(tmpdir(), 'card-rewards-tz-bound-'));
      const store = new FileStore({ dataDir: dir });
      try {
        const service = new RewardService(store, undefined);
        service.registerCard({
          id: 'card-tw',
          issuer: 'Taipei Bank',
          productName: 'TW Card',
          billingCycleDay: 15,
          timezone: 'Asia/Taipei',
        });
        const twCyclePool: CapPoolDefinition = {
          id: 'pool-tw-cycle',
          metric: 'reward',
          period: 'billing_cycle',
          limit: 20000,
          currency: 'TWD',
        };
        service.upsertOffer(source, {
          ...calendarMonthRule,
          id: 'rule-tw-cycle',
          cardId: 'card-tw',
          capPoolRefs: ['pool-tw-cycle'],
        }, undefined, [twCyclePool]);

        // 2026-08-15T15:30:00Z is 2026-08-15 23:30:00 in Asia/Taipei (Day 15 <= 15 -> Cycle 2026-08)
        const txSameDay: TransactionTuple = {
          idempotencyKey: 'tw-tx-1',
          cardId: 'card-tw',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-15T15:30:00Z',
          amount: { amountMinor: 400000, currency: 'TWD' }, // 5% = 200 TWD (fills 200 TWD cap)
        };
        const resSameDay = service.recordTransaction(txSameDay);
        expect(resSameDay.cappedReward?.amountMinor).toBe(20000);

        // 2026-08-15T16:30:00Z is 2026-08-16 00:30:00 in Asia/Taipei (Day 16 > 15 -> Cycle 2026-09)
        // In UTC this is still Aug 15, but in Asia/Taipei it is Aug 16, which is in the NEXT billing cycle!
        // So the new cycle's 200 TWD cap is completely fresh and unconsumed!
        const txNextCycle: TransactionTuple = {
          idempotencyKey: 'tw-tx-2',
          cardId: 'card-tw',
          kind: 'purchase',
          mode: 'actual',
          occurredAt: '2026-08-15T16:30:00Z',
          amount: { amountMinor: 400000, currency: 'TWD' }, // 5% = 200 TWD
        };
        const resNextCycle = service.recordTransaction(txNextCycle);
        expect(resNextCycle.cappedReward?.amountMinor).toBe(20000);
      } finally {
        store.close();
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });
});
