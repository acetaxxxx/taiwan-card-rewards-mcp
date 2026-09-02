import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { evaluateOffer } from '../src/evaluator.js';
import { FileStore } from '../src/store.js';
import { RewardService } from '../src/service.js';
import { validateRule, validateStoredState } from '../src/validation.js';
import type { CapPoolDefinition, EvaluationContext, OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

const source: OfferSourceSnapshot = {
  id: 's',
  url: 'https://bank.example/x',
  fetchedAt: '2026-09-01T00:00:00Z',
  contentHash: 'h',
  parserVersion: '1',
  verified: true,
};

const tx: TransactionTuple = {
  cardId: 'c',
  kind: 'purchase',
  mode: 'planned',
  occurredAt: '2026-09-02T00:00:00Z',
  amount: { amountMinor: 10000, currency: 'TWD' },
};

const base: OfferRuleVersion = {
  id: 'r',
  cardId: 'c',
  version: '1',
  sourceSnapshotId: 's',
  status: 'active',
  validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD',
  match: {},
  reward: { kind: 'percentage', rateBps: 100 },
  capPoolRefs: ['reward', 'count'],
};

const context: EvaluationContext = {
  now: '2026-09-02T01:00:00Z',
  sourceSnapshots: { s: source },
  capPools: [
    { id: 'reward', metric: 'reward', period: 'calendar_month', limit: 100, currency: 'TWD' },
    { id: 'count', metric: 'transaction_count', period: 'calendar_month', limit: 1 },
  ],
  usageByKey: {
    'reward|reward:2026-09': { amountMinor: 0, currency: 'TWD' },
    'count|count:2026-09': { amountMinor: 0, currency: 'TWD' },
  },
};

describe('Schema v2A: canonical cap pool registry and shared aggregation', () => {
  it('applies all gates from one rule referencing two pools', () => {
    expect(evaluateOffer(base, tx, context).cappedReward?.amountMinor).toBe(100);
  });

  it('uses the tightest remaining reward pool when multiple reward caps apply', () => {
    const pools: CapPoolDefinition[] = [
      { id: 'tight', metric: 'reward', period: 'calendar_month', limit: 100, currency: 'TWD' },
      { id: 'wide', metric: 'reward', period: 'calendar_month', limit: 1000, currency: 'TWD' },
    ];
    const multiPoolRule = { ...base, capPoolRefs: ['tight', 'wide'] };
    const multiPoolContext: EvaluationContext = {
      ...context,
      capPools: pools,
      usageByKey: {
        'tight|tight:2026-09': { amountMinor: 90, currency: 'TWD' },
        'wide|wide:2026-09': { amountMinor: 0, currency: 'TWD' },
      },
    };

    // Gross reward is 100; the tight pool has only 10 remaining.
    expect(evaluateOffer(multiPoolRule, tx, multiPoolContext).cappedReward?.amountMinor).toBe(10);
  });

  it('enforces spend and count gates deterministically', () => {
    const spendContext: EvaluationContext = {
      ...context,
      capPools: [{ id: 'spend', metric: 'spend', period: 'calendar_month', limit: 5000, currency: 'TWD' }],
      usageByKey: { 'spend|spend:2026-09': { amountMinor: 4000, currency: 'TWD' } },
    };
    // Tx is 10000 minor, but qualifying spend is capped at remaining 1000 minor -> 1% = 10 minor
    const spendResult = evaluateOffer({ ...base, capPoolRefs: ['spend'] }, tx, spendContext);
    expect(spendResult.cappedReward?.amountMinor).toBe(10);

    const countContext: EvaluationContext = {
      ...context,
      capPools: [{ id: 'count', metric: 'transaction_count', period: 'calendar_month', limit: 1 }],
      usageByKey: { 'count|count:2026-09': { amountMinor: 1, currency: 'TWD' } },
    };
    const countResult = evaluateOffer({ ...base, capPoolRefs: ['count'] }, tx, countContext);
    expect(countResult.status).toBe('no_match');
    expect(countResult.unknownReasons).toContain('transaction count cap exhausted');
  });

  it('fails closed when a referenced pool is absent in evaluation or service', () => {
    expect(evaluateOffer({ ...base, capPoolRefs: ['missing'] }, tx, context).status).toBe('unknown');

    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-v2a-missing-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'c', issuer: 'Bank', productName: 'Card' });
      expect(() => service.upsertOffer(source, { ...base, capPoolRefs: ['non-existent'] })).toThrow(/missing cap pool/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when conflicting pool definition is upserted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-v2a-conflict-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      const pool: CapPoolDefinition = { id: 'p1', metric: 'reward', period: 'calendar_month', limit: 100, currency: 'TWD' };
      service.upsertOffer(source, { ...base, capPoolRefs: ['p1'] }, undefined, [pool]);
      // Mutating immutable pool with different limit must throw
      const conflictingPool: CapPoolDefinition = { id: 'p1', metric: 'reward', period: 'calendar_month', limit: 200, currency: 'TWD' };
      expect(() => service.upsertOffer(source, { ...base, id: 'r2', capPoolRefs: ['p1'] }, undefined, [conflictingPool])).toThrow(/cannot modify immutable cap pool/);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails closed when FX is unavailable for a foreign pool currency', () => {
    const foreign = {
      ...context,
      capPools: [
        { id: 'reward', metric: 'reward' as const, period: 'calendar_month' as const, limit: 100, currency: 'USD' },
        { id: 'count', metric: 'transaction_count' as const, period: 'calendar_month' as const, limit: 1 },
      ],
    };
    expect(evaluateOffer(base, tx, foreign).status).toBe('unknown');
  });

  it('records a purchase under rule A, then rule B sharing same pool sees usage; remainingCaps returns one pool entry', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-v2a-shared-'));
    const store = new FileStore({ dataDir: dir });
    try {
      const service = new RewardService(store, undefined);
      service.registerCard({ id: 'c1', issuer: 'TestBank', productName: 'Shared Card' });

      const sharedPool: CapPoolDefinition = {
        id: 'shared-pool-01',
        name: 'Shared Pool',
        metric: 'reward',
        period: 'calendar_month',
        limit: 500, // 500 minor units = 5 TWD
        currency: 'TWD',
      };

      const ruleA: OfferRuleVersion = {
        id: 'rule-a',
        cardId: 'c1',
        version: '1',
        sourceSnapshotId: 's',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: { channels: ['in_store'] },
        reward: { kind: 'percentage', rateBps: 100 }, // 1%
        capPoolRefs: ['shared-pool-01'],
      };

      const ruleB: OfferRuleVersion = {
        id: 'rule-b',
        cardId: 'c1',
        version: '1',
        sourceSnapshotId: 's',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: { channels: ['online'] },
        reward: { kind: 'percentage', rateBps: 200 }, // 2%
        capPoolRefs: ['shared-pool-01'],
      };

      service.upsertOffer(source, ruleA, undefined, [sharedPool]);
      service.upsertOffer(source, ruleB);

      // Before any spend, remainingCaps should return exactly ONE entry for the shared pool
      const capsInitial = service.remainingCaps('c1', '2026-09-02T12:00:00Z');
      expect(capsInitial).toHaveLength(1);
      expect(capsInitial[0]?.usageKey).toBe('shared-pool-01');
      expect(capsInitial[0]?.remaining.amountMinor).toBe(500);

      // Record an actual purchase under Rule A (in_store: 20,000 minor -> 1% = 200 minor reward)
      const purchaseA: TransactionTuple = {
        idempotencyKey: 'tx-rule-a-1',
        cardId: 'c1',
        kind: 'purchase',
        mode: 'actual',
        occurredAt: '2026-09-02T10:00:00Z',
        amount: { amountMinor: 20000, currency: 'TWD' },
        channel: 'in_store',
      };
      const recordResult = service.recordTransaction(purchaseA);
      expect(recordResult.status).toBe('ok');
      expect(recordResult.ruleId).toBe('rule-a');
      expect(recordResult.cappedReward?.amountMinor).toBe(200);

      // After Rule A purchase, remainingCaps returns one pool entry with 300 remaining
      const capsAfterA = service.remainingCaps('c1', '2026-09-02T12:00:00Z');
      expect(capsAfterA).toHaveLength(1);
      expect(capsAfterA[0]?.usageKey).toBe('shared-pool-01');
      expect(capsAfterA[0]?.remaining.amountMinor).toBe(300);

      // Recommend for Rule B (online: 30,000 minor -> 2% = 600 minor gross reward, but capped at 300 remaining)
      const plannedB: TransactionTuple = {
        cardId: 'c1',
        kind: 'purchase',
        mode: 'planned',
        occurredAt: '2026-09-02T11:00:00Z',
        amount: { amountMinor: 30000, currency: 'TWD' },
        channel: 'online',
      };
      const recResult = service.recommend(plannedB, 1);
      expect(recResult).toHaveLength(1);
      expect(recResult[0]?.ruleId).toBe('rule-b');
      expect(recResult[0]?.grossReward?.amountMinor).toBe(600);
      expect(recResult[0]?.cappedReward?.amountMinor).toBe(300); // Sees usage from Rule A!
      expect(recResult[0]?.capRemainingAfter?.amountMinor).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('validates schema v2 roundtrip and rejects schema v1 and legacy inline caps', () => {
    // Valid v2 stored state
    const validV2 = {
      schemaVersion: 2,
      cards: [],
      snapshots: [],
      rules: [],
      transactions: [],
      campaigns: [],
      switchEnrollments: [],
      cardSwitches: [],
      capPools: [{ id: 'p', metric: 'reward', period: 'calendar_month', limit: 1, currency: 'TWD' }],
    };
    expect(() => validateStoredState(validV2)).not.toThrow();

    // Rejects schema v1
    expect(() => validateStoredState({ ...validV2, schemaVersion: 1 })).toThrow(/INCOMPATIBLE_SCHEMA/);

    // Rejects legacy inline cap
    const ruleWithInlineCap = {
      ...base,
      cap: { kind: 'calendar_month', cap: { amountMinor: 100, currency: 'TWD' }, usageKey: 'k' },
    };
    expect(() => validateRule(ruleWithInlineCap)).toThrow();

    // Rejects legacy inline caps array
    const ruleWithInlineCaps = {
      ...base,
      caps: [{ kind: 'calendar_month', cap: { amountMinor: 100, currency: 'TWD' }, usageKey: 'k' }],
    };
    expect(() => validateRule(ruleWithInlineCaps)).toThrow();
  });
});
