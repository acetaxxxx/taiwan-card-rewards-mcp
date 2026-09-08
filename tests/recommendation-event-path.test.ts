import { describe, expect, it } from 'vitest';
import { rankCards } from '../src/evaluator.js';
import { validateContext, validateRule, validateToolArgs } from '../src/validation.js';
import { mcpTools } from '../src/mcp-contract.js';

const snapshot = { id: 'snap-route', url: 'https://wallet.example/terms', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'hash', parserVersion: '1', verified: true };
const card = { id: 'card-1', issuer: 'Bank', productName: 'Reward Card' };
const target = { id: 'purchase-1', kind: 'purchase' as const, amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: '2026-09-05T00:00:00Z', funding: { kind: 'account' as const, subtype: 'wallet_balance' as const }, channel: 'jkopay', paymentMethod: 'wallet_balance', relations: { funded_by: ['topup-1'] } };
const source = { id: 'topup-1', kind: 'top_up' as const, amount: { amountMinor: 10000, currency: 'TWD' }, occurredAt: '2026-09-04T00:00:00Z', funding: { kind: 'account' as const, subtype: 'linked_bank_account' as const }, channel: 'jkopay', paymentMethod: 'linked_bank_account' };

function rule() {
  return validateRule({
    id: 'jkopay-chain', cardId: 'card-1', version: '1', sourceSnapshotId: 'snap-route', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: { channels: ['jkopay'] },
    reward: { kind: 'percentage', rateBps: 300 }, componentKind: 'payment_provider',
    eventChainRule: { id: 'jkopay-funded', version: '1', relation: 'funded_by', windowSeconds: 172800, sourceRule: { id: 'source', version: '1', eventKind: 'top_up', fundingKind: 'account', fundingSubtype: 'linked_bank_account', channel: 'jkopay', paymentMethod: 'linked_bank_account' }, targetRule: { id: 'target', version: '1', eventKind: 'purchase', fundingKind: 'account', fundingSubtype: 'wallet_balance', channel: 'jkopay', paymentMethod: 'wallet_balance' } },
  });
}

describe('recommendation cross-event payment path', () => {
  it('recommends a card when an explicit funded_by path is matched', () => {
    const result = rankCards([card], [rule()], { cardId: 'card-1', kind: 'purchase', mode: 'planned', occurredAt: target.occurredAt, amount: target.amount, channel: 'jkopay', paymentMethod: 'wallet_balance' }, validateContext({ now: '2026-09-05T00:00:00Z', sourceSnapshots: { [snapshot.id]: snapshot }, paymentEvents: { target, sourceEvents: [source] } }));
    expect(result[0]?.status).toBe('ok');
  });

  it('does not recommend when wallet provenance is missing or ambiguous', () => {
    const result = rankCards([card], [rule()], { cardId: 'card-1', kind: 'purchase', mode: 'planned', occurredAt: target.occurredAt, amount: target.amount, channel: 'jkopay', paymentMethod: 'wallet_balance' }, validateContext({ now: '2026-09-05T00:00:00Z', sourceSnapshots: { [snapshot.id]: snapshot }, paymentEvents: { target: { ...target, relations: undefined }, sourceEvents: [source] } }));
    expect(result[0]?.status).not.toBe('ok');
  });

  it('exposes the same event-path contract through recommend', () => {
    const tool = mcpTools.find((candidate) => candidate.name === 'recommend');
    expect(tool?.inputSchema).toHaveProperty('properties.context');
    expect(() => validateToolArgs('recommend', {
      transaction: { kind: 'purchase', mode: 'planned', occurredAt: target.occurredAt, amount: target.amount },
      context: { paymentEvents: { target, sourceEvents: [source] } },
    })).not.toThrow();
  });
});
