import { describe, expect, it } from 'vitest';
import { evaluateOffer, rankCards, validateRule } from '../src/index.js';
import type { CardDescriptor, EvaluationContext, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const card: CardDescriptor = { id: 'c1', issuer: 'Bank', productName: 'Travel' };
const rule: OfferRuleVersion = {
  id: 'r1', cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD',
  match: { countries: ['JP'], channels: ['in_store'], paymentMethods: ['mobile_wallet'] }, reward: { kind: 'percentage', rateBps: 300 },
  capPoolRefs: ['p1'],
};
const tx: TransactionTuple = { cardId: 'c1', kind: 'purchase', mode: 'planned', occurredAt: '2026-08-20T00:00:00Z', amount: { amountMinor: 200000, currency: 'TWD' }, country: 'JP', channel: 'in_store', paymentMethod: 'mobile_wallet' };
const context: EvaluationContext = {
  now: '2026-08-18T00:00:00Z',
  capPools: [{ id: 'p1', metric: 'reward', period: 'calendar_month', limit: 100000, currency: 'TWD', timezone: 'Asia/Taipei' }],
  usageByKey: { 'p1|p1:2026-08': { amountMinor: 50000, currency: 'TWD' }, 'p1:2026-08': { amountMinor: 50000, currency: 'TWD' } },
  sourceSnapshots: { s1: { id: 's1', url: 'https://example.invalid/offer', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'fixture', parserVersion: '1' } },
};

describe('deterministic evaluator', () => {
  it('calculates and caps a matching offer without mutating planned usage', () => {
    const result = evaluateOffer(rule, tx, context);
    expect(result.status).toBe('ok');
    expect(result.grossReward?.amountMinor).toBe(6000);
    expect(result.cappedReward?.amountMinor).toBe(6000);
    expect(result.capRemainingAfter?.amountMinor).toBe(44000);
  });
  it('fails closed when a required condition is missing', () => {
    const result = evaluateOffer(rule, { ...tx, channel: undefined }, context);
    expect(result.status).toBe('unknown');
    expect(result.unknownReasons).toContain('missing channel');
  });
  it('supports schema v2 half-up rounding for percentage rewards', () => {
    const parsed = validateRule({
      ...rule,
      reward: { ...rule.reward, rateBps: 5000, roundingMode: 'half_up' },
    });
    const result = evaluateOffer(parsed, { ...tx, amount: { amountMinor: 1, currency: 'TWD' } }, context);
    expect(result.status).toBe('ok');
    expect(result.grossReward?.amountMinor).toBe(1);
  });
  it('ranks at most five cards and keeps uncertain entries explicit', () => {
    const result = rankCards([card], [rule], tx, context);
    expect(result).toHaveLength(1);
    expect(result[0]?.rank).toBe(1);
    expect(result[0]?.cappedReward?.amountMinor).toBe(6000);
  });
  it('requires idempotency and refund linkage for actual writes', () => {
    expect(evaluateOffer(rule, { ...tx, mode: 'actual' }, context).status).toBe('unknown');
    expect(evaluateOffer(rule, { ...tx, kind: 'refund', refundOfId: 't1' }, context).status).toBe('unknown');
  });

  it('orders Top-5 deterministically by card identity after confidence and reward', () => {
    const cards: CardDescriptor[] = [
      { id: 'c5', issuer: 'Bank', productName: 'Five' },
      { id: 'c2', issuer: 'Bank', productName: 'Two' },
      { id: 'c1', issuer: 'Bank', productName: 'One' },
    ];
    const rules = cards.map((item) => ({ ...rule, id: `r-${item.id}`, cardId: item.id }));
    const result = rankCards(cards, rules, tx, context);
    expect(result.map((entry) => entry.cardId)).toEqual(['c1', 'c2', 'c5']);
    expect(result.map((entry) => entry.rank)).toEqual([1, 2, 3]);
  });

  it('places uncertain entries after confident entries and preserves reasons', () => {
    const uncertainCards: CardDescriptor[] = [card, { id: 'c0', issuer: 'Bank', productName: 'Zero' }];
    const uncertainRules = [{ ...rule, match: {} }, { ...rule, id: 'r-c0', cardId: 'c0', match: { channels: ['online'] } }];
    const result = rankCards(uncertainCards, uncertainRules, { ...tx, channel: undefined }, context);
    expect(result.map((entry) => entry.status)).toEqual(['ok', 'unknown']);
    expect(result.map((entry) => entry.cardId)).toEqual(['c1', 'c0']);
    expect(result[1]?.unknownReasons).toContain('missing channel');
  });
});
