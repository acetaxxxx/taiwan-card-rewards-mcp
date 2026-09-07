import { describe, expect, it } from 'vitest';
import { evaluateOffer, validateRule } from '../src/index.js';
import type { EvaluationContext, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const baseRule: OfferRuleVersion = {
  id: 'rule-route', cardId: 'card-1', version: '1', sourceSnapshotId: 'source-1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD',
  match: {}, reward: { kind: 'percentage', rateBps: 100 },
};
const tx: TransactionTuple = { cardId: 'card-1', routeId: 'route_A', kind: 'purchase', mode: 'planned', occurredAt: '2026-08-01T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' } };
const context: EvaluationContext = { now: '2026-08-01T00:00:00Z', sourceSnapshots: { 'source-1': { id: 'source-1', url: 'https://example.invalid', fetchedAt: '2026-07-01T00:00:00Z', contentHash: 'hash', parserVersion: '1' } }, paymentRoutes: [{ id: 'route_A', status: 'active', layers: [], funding: { kind: 'credit_card', cardId: 'card-1' }, observedAt: '2026-07-01T00:00:00Z', idempotencyKey: 'route-key' }] };

describe('payment route rule binding', () => {
  it('applies an exact route-bound rule only to the matching route', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A' });
    expect(evaluateOffer(rule, tx, context).status).toBe('ok');
    expect(evaluateOffer(rule, { ...tx, routeId: 'route_B' }, context).status).toBe('no_match');
  });

  it('keeps legacy rules generic when no route binding is supplied', () => {
    expect(evaluateOffer(baseRule, tx, context).status).toBe('ok');
    expect(evaluateOffer(baseRule, { ...tx, routeId: undefined }, context).status).toBe('ok');
  });

  it('fails closed when a route-bound rule references a stale route', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A' });
    const result = evaluateOffer(rule, tx, { ...context, paymentRoutes: [{ id: 'route_A', status: 'stale', layers: [], funding: { kind: 'cash' }, observedAt: '2026-07-01T00:00:00Z', idempotencyKey: 'route-key' }] });
    expect(result.status).toBe('stale');
  });

  it('does not apply issuer rewards to account or cash terminal funding', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A', componentKind: 'card_issuer' });
    const result = evaluateOffer(rule, tx, { ...context, paymentRoutes: [{ id: 'route_A', status: 'active', layers: [], funding: { kind: 'cash' }, observedAt: '2026-07-01T00:00:00Z', idempotencyKey: 'route-key' }] });
    expect(result.status).toBe('no_match');
  });

  it('fails closed when the evaluation context omits the route registry', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A' });
    const result = evaluateOffer(rule, tx, { ...context, paymentRoutes: undefined });
    expect(result.status).toBe('unknown');
    expect(result.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'missing_required_fact' })]));
  });

  it('does not apply a route-specific rule outside the route validity window', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A' });
    const result = evaluateOffer(rule, tx, {
      ...context,
      paymentRoutes: [{ ...context.paymentRoutes![0]!, validTo: '2026-07-31T23:59:59Z' }],
    });
    expect(result.status).toBe('stale');
  });

  it('also gates generic issuer rules by known terminal funding', () => {
    const issuerRule = validateRule({ ...baseRule, componentKind: 'card_issuer' });
    const result = evaluateOffer(issuerRule, tx, {
      ...context,
      paymentRoutes: [{ ...context.paymentRoutes![0]!, funding: { kind: 'account', subtype: 'wallet_balance' } }],
    });
    expect(result.status).toBe('no_match');
  });

  it('does not let a route registered for another card satisfy the transaction', () => {
    const rule = validateRule({ ...baseRule, routeId: 'route_A', componentKind: 'card_issuer' });
    const result = evaluateOffer(rule, tx, {
      ...context,
      paymentRoutes: [{ ...context.paymentRoutes![0]!, funding: { kind: 'credit_card', cardId: 'card-2' } }],
    });
    expect(result.status).toBe('no_match');
  });
});
