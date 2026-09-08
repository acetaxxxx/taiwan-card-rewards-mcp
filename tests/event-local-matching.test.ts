import { describe, expect, it } from 'vitest';
import { matchPaymentEvent, validatePaymentEvent, validatePaymentEventRule } from '../src/index.js';

describe('event-local reward matching', () => {
  const topUp = validatePaymentEvent({
    id: 'evt_topup_1', kind: 'top_up', amount: { amountMinor: 100000, currency: 'TWD' },
    occurredAt: '2026-09-07T00:00:00Z', funding: { kind: 'account', subtype: 'linked_bank_account' },
    paymentMethod: 'bank_transfer', channel: 'wallet_top_up',
  });
  const purchase = validatePaymentEvent({
    id: 'evt_purchase_1', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' },
    occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' },
    paymentMethod: 'easy_wallet', channel: 'in_store',
  });

  it('matches only the event kind and validated funding/channel facts', () => {
    const topUpRule = validatePaymentEventRule({ id: 'event_rule_topup', version: '1', eventKind: 'top_up', fundingKind: 'account', fundingSubtype: 'linked_bank_account', channel: 'wallet_top_up' });
    const purchaseRule = validatePaymentEventRule({ id: 'event_rule_purchase', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance', paymentMethod: 'easy_wallet', channel: 'in_store' });

    expect(matchPaymentEvent(topUpRule, topUp).status).toBe('matched');
    expect(matchPaymentEvent(topUpRule, purchase).status).toBe('no_match');
    expect(matchPaymentEvent(purchaseRule, purchase).status).toBe('matched');
  });

  it('does not infer an issuer/card reward from unknown mixed wallet provenance', () => {
    const issuerRule = validatePaymentEventRule({ id: 'event_rule_issuer', version: '1', eventKind: 'purchase', fundingKind: 'credit_card', paymentMethod: 'easy_wallet' });
    expect(matchPaymentEvent(issuerRule, purchase).status).not.toBe('matched');
  });
});
