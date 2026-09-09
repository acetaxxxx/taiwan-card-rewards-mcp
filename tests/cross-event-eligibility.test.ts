import { describe, expect, it } from 'vitest';
import { matchPaymentEventChain, validatePaymentEvent, validatePaymentEventChainRule } from '../src/index.js';

describe('evidence-aware cross-event eligibility', () => {
  const topUp = validatePaymentEvent({
    id: 'evt_topup_1', kind: 'top_up', amount: { amountMinor: 100000, currency: 'TWD' },
    occurredAt: '2026-09-07T00:00:00Z', funding: { kind: 'account', subtype: 'linked_bank_account' },
    paymentMethod: 'bank_transfer', channel: 'wallet_top_up',
  });
  const purchase = validatePaymentEvent({
    id: 'evt_purchase_1', kind: 'purchase', amount: { amountMinor: 40000, currency: 'TWD' },
    occurredAt: '2026-09-07T01:00:00Z', funding: { kind: 'account', subtype: 'wallet_balance' },
    paymentMethod: 'easy_wallet', channel: 'in_store', relations: { funded_by: ['evt_topup_1'] },
  });
  const rule = validatePaymentEventChainRule({
    id: 'chain_rule_1', version: '1', relation: 'funded_by', windowSeconds: 86400,
    sourceRule: { id: 'source_1', version: '1', eventKind: 'top_up', fundingKind: 'account', fundingSubtype: 'linked_bank_account', channel: 'wallet_top_up' },
    targetRule: { id: 'target_1', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance', paymentMethod: 'easy_wallet', channel: 'in_store' },
  });

  it('matches an evidenced linked-bank top-up to its funded wallet purchase within the window', () => {
    expect(matchPaymentEventChain(rule, purchase, [topUp, purchase]).status).toBe('matched');
  });

  it('fails closed for another source, missing/expired relation, or mixed wallet provenance', () => {
    const otherSource = validatePaymentEvent({ ...topUp, id: 'evt_paypay_topup', paymentMethod: 'paypay', funding: { kind: 'account', subtype: 'wallet_balance' } });
    const noRelation = validatePaymentEvent({ ...purchase, id: 'evt_purchase_no_relation', relations: undefined });
    const expiredPurchase = validatePaymentEvent({ ...purchase, id: 'evt_purchase_expired', occurredAt: '2026-09-09T00:00:00Z' });
    const mixedPurchase = validatePaymentEvent({ ...purchase, id: 'evt_purchase_mixed', relations: { funded_by: ['evt_topup_1', 'evt_paypay_topup'] } });
    const otherPurchase = validatePaymentEvent({ ...purchase, id: 'evt_purchase_other_source', relations: { funded_by: ['evt_paypay_topup'] } });

    expect(matchPaymentEventChain(rule, otherPurchase, [otherSource, otherPurchase]).status).toBe('no_match');
    expect(matchPaymentEventChain(rule, noRelation, [topUp, noRelation]).status).toBe('no_match');
    expect(matchPaymentEventChain(rule, expiredPurchase, [topUp, expiredPurchase]).status).toBe('no_match');
    expect(matchPaymentEventChain(rule, mixedPurchase, [topUp, otherSource, mixedPurchase]).status).toBe('unknown');
  });
});
