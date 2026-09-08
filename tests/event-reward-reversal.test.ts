import { describe, expect, it } from 'vitest';
import { EventRewardLedger, createPaymentEventRewardCandidate, validatePaymentEvent } from '../src/index.js';

describe('event-aware refund and reversal provenance', () => {
  const purchase = validatePaymentEvent({ id: 'evt_purchase', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' }, occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' } });
  const candidate = createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: purchase.id, ruleId: 'rule_wallet', ruleVersion: 'v2', evidenceId: 'evidence-1', sponsor: 'wallet', benefitGroup: 'purchase', capPoolId: 'cap-1', reward: { kind: 'percentage', rateBps: 100 } });
  const cap = { id: 'cap-1', metric: 'reward' as const, period: 'calendar_month' as const, limit: 500, currency: 'TWD', timezone: 'Asia/Taipei' };

  const refund = (id: string, amountMinor: number, originalEventId = purchase.id) => validatePaymentEvent({ id, kind: 'refund', amount: { amountMinor, currency: 'TWD' }, occurredAt: '2026-09-07T02:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' }, relations: { refunds: [originalEventId] } });

  it('reverses proportional reward and matching cap usage, then the remaining reward on final refund', () => {
    const ledger = new EventRewardLedger('user-a', [cap]);
    const original = ledger.record(candidate, purchase, 'reward-1');
    const partial = ledger.reverse(refund('evt_refund_partial', 10000), 'refund-1');
    expect(partial).toMatchObject({ originalEventId: purchase.id, ruleId: 'rule_wallet', ruleVersion: 'v2', evidenceId: 'evidence-1', sponsor: 'wallet', benefitGroup: 'purchase', refundedAmount: { amountMinor: 10000, currency: 'TWD' }, reward: { amountMinor: -100, currency: 'TWD' }, capUsage: { poolId: 'cap-1', consumedAmount: -100 } });
    const final = ledger.reverse(refund('evt_refund_final', 30000), 'refund-2');
    expect(final.reward).toEqual({ amountMinor: -300, currency: 'TWD' });
    expect(final.capUsage).toMatchObject({ poolId: 'cap-1', consumedAmount: -300 });
    expect(ledger.reverse(refund('evt_refund_partial', 10000), 'refund-1')).toEqual(partial);
    expect(original.reward).toEqual({ amountMinor: 400, currency: 'TWD' });
  });

  it('rejects missing, unknown, unrelated, over-refund, and conflicting idempotency', () => {
    const ledger = new EventRewardLedger('user-a', [cap]);
    ledger.record(candidate, purchase, 'reward-1');
    const noRelation = validatePaymentEvent({ id: 'refund-no-relation', kind: 'refund', amount: { amountMinor: 1, currency: 'TWD' }, occurredAt: '2026-09-07T02:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' } });
    expect(() => ledger.reverse(noRelation, 'missing-relation')).toThrow(/INVALID_REFUND_RELATION/);
    expect(() => ledger.reverse(refund('refund-unknown', 1, 'evt_missing'), 'unknown')).toThrow(/ORIGINAL_REWARD_NOT_FOUND/);
    expect(() => ledger.reverse(refund('refund-unrelated', 1, 'evt_other'), 'unrelated')).toThrow(/ORIGINAL_REWARD_NOT_FOUND/);
    expect(() => ledger.reverse(refund('refund-too-large', 40001), 'over-refund')).toThrow(/OVER_REFUND/);
    ledger.reverse(refund('refund-idempotent', 1000), 'refund-idempotent-key');
    expect(() => ledger.reverse(refund('refund-idempotent', 2000), 'refund-idempotent-key')).toThrow(/IDEMPOTENCY_CONFLICT/);
  });
});
