import { describe, expect, it } from 'vitest';
import { evaluateOffer, rankCards } from '../src/evaluator.js';
import { validateRule, validateStoredState } from '../src/validation.js';
import type { CardDescriptor, EvaluationContext, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const card: CardDescriptor = { id: 'c1', issuer: 'Bank', productName: 'Card', timezone: 'Asia/Taipei' };
const tx: TransactionTuple = { cardId: 'c1', kind: 'purchase', mode: 'planned', occurredAt: '2026-09-01T01:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } };
const source = { id: 's1', url: 'https://bank.example/offer', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true };
const context: EvaluationContext = { now: '2026-09-01T02:00:00Z', sourceSnapshots: { s1: source }, capPools: [{ id: 'pool', name: 'Pool', metric: 'reward', period: 'calendar_month', limit: 500, currency: 'TWD' }], usageByKey: { 'pool|pool:2026-09': { amountMinor: 100, currency: 'TWD' } } };
const rule = (id: string, refs = ['pool']): OfferRuleVersion => ({ id, cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 }, capPoolRefs: refs });

describe('Schema v2 regression seams', () => {
  it('uses one canonical shared cap pool across two rules', () => {
    const result = rankCards([card], [rule('r1'), rule('r2')], tx, context, 5)[0];
    expect(result?.status).toBe('ok');
    expect(result?.cappedReward?.amountMinor).toBe(200);
  });

  it('enforces spend and transaction-count metrics as gates', () => {
    const spendContext: EvaluationContext = { ...context, capPools: [{ id: 'spend', metric: 'spend', period: 'calendar_month', limit: 5000, currency: 'TWD' }], usageByKey: { 'spend|spend:2026-09': { amountMinor: 4000, currency: 'TWD' } } };
    expect(evaluateOffer({ ...rule('rs', ['spend']), reward: { kind: 'percentage', rateBps: 100 } }, tx, spendContext).cappedReward?.amountMinor).toBe(10);
    const countContext: EvaluationContext = { ...context, capPools: [{ id: 'count', metric: 'transaction_count', period: 'calendar_month', limit: 1 }], usageByKey: { 'count|count:2026-09': { amountMinor: 1, currency: 'TWD' } } };
    expect(evaluateOffer(rule('rc', ['count']), tx, countContext).status).toBe('no_match');
  });

  it('round-trips canonical pool refs and fails closed on inline cap ambiguity', () => {
    const parsed = validateRule(rule('round'));
    expect(parsed.capPoolRefs).toEqual(['pool']);
    expect(() => validateRule({ ...rule('bad'), cap: { kind: 'calendar_month', cap: { amountMinor: 1, currency: 'TWD' }, usageKey: 'x' }, capPoolRefs: ['pool'] })).toThrow();
    expect(() => validateStoredState({ schemaVersion: 2, cards: [], snapshots: [], rules: [], transactions: [], campaigns: [], switchEnrollments: [], cardSwitches: [], capPools: [{ id: 'p', metric: 'reward', period: 'calendar_month', limit: 1, currency: 'TWD' }] })).not.toThrow();
  });

  it('resolves additive and priority replacement deterministically', () => {
    const additive = rankCards([card], [{ ...rule('a'), combination: { mode: 'additive', groupId: 'g', version: '1' } }, { ...rule('b'), combination: { mode: 'additive', groupId: 'h', version: '1' } }], tx, context, 5)[0];
    expect(additive?.cappedReward?.amountMinor).toBe(200);
    const replaced = rankCards([card], [{ ...rule('low'), combination: { mode: 'replace', groupId: 'g', version: '1', priority: 1 } }, { ...rule('high'), reward: { kind: 'percentage', rateBps: 200 }, combination: { mode: 'replace', groupId: 'g', version: '1', priority: 2 } }], tx, context, 5)[0];
    expect(replaced?.ruleId).toBe('high');
  });

  it('fails closed when a matching rule declares an unsupported combination mode', () => {
    const result = rankCards([card], [{ ...rule('unsupported'), combination: { mode: 'stack_if_lucky', groupId: 'g', version: '1' } }], tx, context, 5)[0];
    expect(result?.status).toBe('needs_review');
    expect(result?.unknownReasons).toContain('unsupported combination policy');
  });
});
