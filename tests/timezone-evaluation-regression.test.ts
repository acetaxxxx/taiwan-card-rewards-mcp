import { afterEach, describe, expect, it, vi } from 'vitest';
import { evaluateOffer } from '../src/evaluator.js';
import type { EvaluationContext, OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

const source: OfferSourceSnapshot = {
  id: 'timezone-source',
  url: 'https://bank.example/rewards',
  fetchedAt: '2026-08-01T00:00:00Z',
  contentHash: 'timezone-hash',
  parserVersion: '1',
  verified: true,
};

const rule: OfferRuleVersion = {
  id: 'timezone-rule',
  cardId: 'card-1',
  version: '1',
  sourceSnapshotId: source.id,
  status: 'active',
  validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD',
  match: {},
  reward: { kind: 'percentage', rateBps: 100 },
  capPoolRefs: ['monthly-reward'],
};

const transaction = (occurredAt: string): TransactionTuple => ({
  cardId: 'card-1',
  kind: 'purchase',
  mode: 'planned',
  occurredAt,
  amount: { amountMinor: 10_000, currency: 'TWD' },
});

const context = (overrides: Partial<EvaluationContext> = {}): EvaluationContext => ({
  sourceSnapshots: { [source.id]: source },
  capPools: [{ id: 'monthly-reward', metric: 'reward', period: 'calendar_month', limit: 100, currency: 'TWD', timezone: 'America/New_York' }],
  usageByKey: {},
  ...overrides,
});

afterEach(() => vi.useRealTimers());

describe('configurable timezone and optional evaluation time', () => {
  it('uses the persisted non-Asia IANA timezone at the period boundary', () => {
    const august = evaluateOffer(
      rule,
      transaction('2026-09-01T03:30:00Z'),
      context({ usageByKey: { 'monthly-reward|monthly-reward:2026-08': { amountMinor: 90, currency: 'TWD' } } }),
    );
    const september = evaluateOffer(
      rule,
      transaction('2026-09-01T04:30:00Z'),
      context({ usageByKey: { 'monthly-reward|monthly-reward:2026-09': { amountMinor: 0, currency: 'TWD' } } }),
    );

    expect(august.status).toBe('ok');
    expect(august.cappedReward?.amountMinor).toBe(10);
    expect(september.status).toBe('ok');
    expect(september.cappedReward?.amountMinor).toBe(100);
  });

  it('uses current time when now is omitted and honors a supplied future ISO timestamp', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-04T12:00:00Z'));
    const expiringSource = { ...source, validTo: '2026-09-05T00:00:00Z' };
    const expiringContext = context({
      sourceSnapshots: { [source.id]: expiringSource },
      usageByKey: { 'monthly-reward|monthly-reward:2026-09': { amountMinor: 0, currency: 'TWD' } },
    });

    expect(evaluateOffer(rule, transaction('2026-09-04T00:00:00Z'), expiringContext).status).toBe('ok');
    expect(evaluateOffer(rule, transaction('2026-09-04T00:00:00Z'), { ...expiringContext, now: '2026-09-06T00:00:00Z' }).status).toBe('stale');
  });

  it('fails closed when a relevant cap pool has no timezone', () => {
    const result = evaluateOffer(
      rule,
      transaction('2026-09-01T04:30:00Z'),
      context({ capPools: [{ id: 'monthly-reward', metric: 'reward', period: 'calendar_month', limit: 100, currency: 'TWD' }] }),
    );

    expect(result.status).toBe('needs_review');
    expect(result.unknownReasons).toContain('cap pool timezone is required');
  });
});
