import { describe, expect, it } from 'vitest';
import { EventRewardLedger, createPaymentEventRewardCandidate, validatePaymentEvent } from '../src/index.js';

describe('event-aware reward ledger', () => {
  const event = validatePaymentEvent({
    id: 'evt_purchase_1', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' },
    occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' },
  });
  const candidate = createPaymentEventRewardCandidate({
    eligibility: { status: 'matched', reasons: [] }, eventId: event.id, ruleId: 'rule_wallet_1', ruleVersion: '1', evidenceId: 'evidence_1', sponsor: 'easy_wallet', benefitGroup: 'purchase', reward: { kind: 'percentage', rateBps: 100 },
  });

  it('records a calculable candidate against target event, rule evidence, and idempotency key', () => {
    const ledger = new EventRewardLedger('user-a');
    const record = ledger.record(candidate, event, 'event-reward-1');
    expect(record).toMatchObject({ idempotencyKey: 'event-reward-1', ownerUser: 'user-a', eventId: event.id, ruleId: 'rule_wallet_1', ruleVersion: '1', sponsor: 'easy_wallet', benefitGroup: 'purchase', evidenceId: 'evidence_1' });
    expect(record.reward).toEqual({ amountMinor: 400, currency: 'TWD' });
  });

  it('replays idempotently, rejects conflicts, and fails closed for ineligible/uncomputable candidates', () => {
    const ledger = new EventRewardLedger('user-a');
    const first = ledger.record(candidate, event, 'event-reward-1');
    expect(ledger.record(candidate, event, 'event-reward-1')).toEqual(first);
    expect(() => ledger.record({ ...candidate!, ruleVersion: '2' }, event, 'event-reward-1')).toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(() => ledger.record(undefined, event, 'event-reward-2')).toThrow(/INELIGIBLE_EVENT_REWARD/);
    const noSpec = createPaymentEventRewardCandidate({ ...candidate!, eligibility: { status: 'matched', reasons: [] }, reward: undefined });
    expect(() => ledger.record(noSpec, event, 'event-reward-3')).toThrow(/REWARD_NOT_CALCULABLE/);
    expect(ledger.list()).toHaveLength(1);
  });
});
