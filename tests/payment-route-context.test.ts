import { describe, expect, it } from 'vitest';
import { validateTransaction } from '../src/validation.js';

describe('payment route and FX mechanism context', () => {
  it('round-trips complete route chain, conversion metadata, and fee/DCC context', () => {
    const transaction = { cardId: 'c1', kind: 'purchase' as const, mode: 'planned' as const, occurredAt: '2026-09-05T00:00:00Z', amount: { amountMinor: 1000, currency: 'USD' }, routeContext: { merchantId: 'm1', walletProviderId: 'wallet', paymentMethod: 'wallet', intermediateProviderId: 'provider', cardNetwork: 'visa', issuer: 'bank', fundingSource: 'card', transactionCurrency: 'USD', settlementCurrency: 'TWD', billingCurrency: 'TWD', conversionOwner: 'card_network', rateType: 'card_scheme' as const, conversionTiming: 'clearing' as const, foreignTransactionFee: { amountMinor: 20, currency: 'TWD' }, markup: { amountMinor: 5, currency: 'TWD' }, serviceFee: { amountMinor: 2, currency: 'TWD' }, dcc: false } };
    expect(validateTransaction(transaction).routeContext).toEqual(transaction.routeContext);
  });
});
