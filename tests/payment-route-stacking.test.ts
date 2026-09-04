import { describe, expect, it } from 'vitest';
import { evaluateOffer, rankCards } from '../src/evaluator.js';
import { validateTransaction } from '../src/validation.js';
import type { CardDescriptor, EvaluationContext, OfferRuleVersion, TransactionTuple } from '../src/types.js';

const card: CardDescriptor = { id: 'c', issuer: 'Bank', productName: 'Card' };
const source = { id: 's', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'h', parserVersion: '1', verified: true };
const ctx: EvaluationContext = { now: '2026-09-02T00:00:00Z', sourceSnapshots: { s: source } };
const tx: TransactionTuple = { cardId: 'c', kind: 'purchase', mode: 'planned', occurredAt: '2026-09-02T00:00:00Z', amount: { amountMinor: 10000, currency: 'TWD' }, settlementAmount: { amountMinor: 7000, currency: 'TWD' }, route: { kind: 'wallet', providerId: 'linepay', appId: 'linepay' } };
const rule = (id: string, kind: OfferRuleVersion['componentKind'], rateBps: number, useSettlementAmount = false): OfferRuleVersion => ({ id, cardId: 'c', version: '1', sourceSnapshotId: 's', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps }, componentKind: kind, stacking: 'confirmed', useSettlementAmount });

describe('payment routes and stacking', () => {
  it('preserves route snapshot and applies settlement amount only to issuer rule', () => {
    const parsed = validateTransaction(tx);
    expect(parsed.route?.providerId).toBe('linepay');
    expect(evaluateOffer(rule('issuer', 'card_issuer', 100, true), tx, ctx).cappedReward?.amountMinor).toBe(70);
    expect(evaluateOffer(rule('merchant', 'merchant_loyalty', 100), tx, ctx).cappedReward?.amountMinor).toBe(100);
  });
  it('merges compatible independent components and preserves breakdown', () => {
    const result = rankCards([card], [rule('merchant', 'merchant_loyalty', 100), rule('issuer', 'card_issuer', 100, true)], tx, ctx)[0];
    expect(result?.cappedReward?.amountMinor).toBe(170);
    expect(result?.components).toHaveLength(2);
  });
  it('keeps possible confidence auditable and stale evidence fail-closed', () => {
    const possible = evaluateOffer({ ...rule('provider', 'payment_provider', 100), stacking: 'possible' }, tx, ctx);
    expect(possible.components?.[0]?.confidence).toBe('possible');
    const stale = evaluateOffer(rule('provider', 'payment_provider', 100), tx, { ...ctx, sourceSnapshots: { s: { ...source, validTo: '2026-01-01T00:00:00Z' } } });
    expect(stale.status).toBe('stale');
  });
});
