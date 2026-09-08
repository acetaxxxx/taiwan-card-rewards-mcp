import { describe, expect, it } from 'vitest';
import { EventRewardLedger, createPaymentEventRewardCandidate, validatePaymentEvent } from '../src/index.js';

describe('event-aware cap consumption', () => {
  const event = validatePaymentEvent({ id: 'evt_purchase_1', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' }, occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' } });
  const candidate = createPaymentEventRewardCandidate({ eligibility: { status: 'matched', reasons: [] }, eventId: event.id, ruleId: 'rule_1', ruleVersion: '1', evidenceId: 'e1', sponsor: 'wallet', benefitGroup: 'purchase', capPoolId: 'cap-1', reward: { kind: 'percentage', rateBps: 100 } });
  const cap = { id: 'cap-1', metric: 'reward' as const, period: 'calendar_month' as const, limit: 500, currency: 'TWD', timezone: 'Asia/Taipei' };

  it('consumes a user-scoped cap once and caps later event rewards at remaining allowance', () => {
    const ledger = new EventRewardLedger('user-a', [cap]);
    const first = ledger.record(candidate, event, 'reward-1');
    expect(first.reward).toEqual({ amountMinor: 400, currency: 'TWD' });
    expect(ledger.record(candidate, event, 'reward-1')).toEqual(first);
    const second = ledger.record({ ...candidate!, eventId: 'evt_purchase_2' }, { ...event, id: 'evt_purchase_2' }, 'reward-2');
    expect(second.reward).toEqual({ amountMinor: 100, currency: 'TWD' });
    expect(new EventRewardLedger('user-b', [cap]).record(candidate, event, 'reward-1').reward.amountMinor).toBe(400);
  });

  it('fails closed for missing cap, timezone, currency mismatch, or ambiguous period', () => {
    expect(() => new EventRewardLedger('user-a').record(candidate, event, 'missing-cap')).toThrow(/CAP_NOT_FOUND/);
    expect(() => new EventRewardLedger('user-a', [{ ...cap, timezone: undefined }]).record(candidate, event, 'missing-timezone')).toThrow(/CAP_TIMEZONE_REQUIRED/);
    expect(() => new EventRewardLedger('user-a', [{ ...cap, currency: 'USD' }]).record(candidate, event, 'currency-mismatch')).toThrow(/CAP_CURRENCY_MISMATCH/);
    expect(() => new EventRewardLedger('user-a', [{ ...cap, period: 'quarter' }]).record(candidate, event, 'ambiguous-period')).toThrow(/CAP_PERIOD_AMBIGUOUS/);
  });
});
