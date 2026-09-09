import { describe, expect, it } from 'vitest';
import { validatePaymentEvent } from '../src/index.js';

describe('canonical PaymentEvent seam', () => {
  it('represents an account-funded top-up without requiring cardId and preserves evidenced relations', () => {
    const event = validatePaymentEvent({
      id: 'evt_topup_1',
      kind: 'top_up',
      amount: { amountMinor: 100000, currency: 'TWD' },
      occurredAt: '2026-09-07T00:00:00Z',
      funding: { kind: 'account', subtype: 'linked_bank_account' },
      relations: { caused_by: ['evt_bank_debit_1'] },
    });
    expect(event.cardId).toBeUndefined();
    expect(event.kind).toBe('top_up');
    expect(event.relations?.caused_by).toEqual(['evt_bank_debit_1']);
  });

  it('represents a wallet purchase and refuses unsupported or sensitive relation payloads', () => {
    const event = validatePaymentEvent({
      id: 'evt_purchase_1', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' },
      occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' },
      routeId: 'route_wallet_1', relations: { funded_by: ['evt_topup_1'] },
    });
    expect(event.relations?.funded_by).toEqual(['evt_topup_1']);
    const mixedBalance = validatePaymentEvent({ ...event, id: 'evt_purchase_mixed', relations: undefined });
    expect(mixedBalance.relations).toBeUndefined();
    expect(() => validatePaymentEvent({ ...event, cvv: '123' })).toThrow();
    expect(() => validatePaymentEvent({ ...event, kind: 'unknown' })).toThrow();
  });
});
