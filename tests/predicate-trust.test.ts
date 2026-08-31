import { describe, expect, it } from 'vitest';
import { evaluateOffer } from '../src/evaluator.js';
import { validateRule } from '../src/validation.js';
import type { EvaluationContext, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const transaction: TransactionTuple = {
  cardId: 'c1', kind: 'purchase', mode: 'planned', occurredAt: '2026-08-20T00:00:00Z',
  amount: { amountMinor: 10000, currency: 'TWD' }, merchant: 'store-a', country: 'JP',
};
const source = { id: 's1', url: 'https://bank.example/', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'hash', parserVersion: '1' };
const context: EvaluationContext = { now: '2026-08-20T00:00:00Z', sourceSnapshots: { s1: source } };
const rule = (extra: Partial<OfferRuleVersion> = {}): OfferRuleVersion => ({
  id: 'r1', cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z',
  settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 }, ...extra,
});

describe('predicate AST and calculation trust gate', () => {
  it('accepts supported nested predicates and rejects unknown operators', () => {
    expect(validateRule({ ...rule(), predicate: { op: 'AND', rules: [{ field: 'transaction.country', op: 'EQUALS', value: 'JP' }] } })).toHaveProperty('predicate');
    expect(() => validateRule({ ...rule(), predicate: { op: 'XOR', rules: [] } })).toThrow(/operator/);
  });

  it('evaluates nested predicates and fails closed when a fact is missing', () => {
    const predicate = { op: 'AND' as const, rules: [
      { field: 'transaction.country', op: 'EQUALS' as const, value: 'JP' },
      { field: 'transaction.merchant', op: 'MATCH_ALLOWLIST' as const, value: ['store-a'] },
    ] };
    expect(evaluateOffer(rule({ predicate }), transaction, context).status).toBe('ok');
    expect(evaluateOffer(rule({ predicate }), { ...transaction, merchant: undefined }, context).unknownReasons).toContain('missing transaction.merchant');
  });

  it('supports NOT predicates and preserves unknown facts under negation', () => {
    const predicate = { op: 'NOT' as const, rule: { field: 'transaction.country', op: 'EQUALS' as const, value: 'US' } };
    expect(validateRule({ ...rule(), predicate })).toHaveProperty('predicate');
    expect(evaluateOffer(rule({ predicate }), transaction, context).status).toBe('ok');
    expect(evaluateOffer(rule({ predicate }), { ...transaction, country: undefined }, context).unknownReasons).toContain('missing transaction.country');
  });

  it('does not calculate confidently when required trust evidence is absent', () => {
    const trustedRule = rule({ requires: ['source_verified', 'user_confirmation'] });
    const result = evaluateOffer(trustedRule, transaction, context);
    expect(result.status).toBe('needs_review');
    expect(result.unknownReasons).toEqual(expect.arrayContaining(['source is not verified', 'user confirmation is required']));
  });
});
