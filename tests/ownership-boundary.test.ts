import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import { validateContext, validateToolArgs, validateTransaction } from '../src/validation.js';
import type { OfferRuleVersion, OfferSourceSnapshot, TransactionTuple } from '../src/types.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read(): StoredState { return structuredClone(this.state); }
  write(next: StoredState): void { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close(): void {}
}

describe('agent workspace and durable-state ownership', () => {
  it('isolates user-scoped idempotency and ledger records while sharing verified catalog facts', () => {
    const store = new MemoryStore();
    const alice = new RewardService(store, 'alice');
    const bob = new RewardService(store, 'bob');
    const snapshot: OfferSourceSnapshot = { id: 's1', url: 'https://bank.example/offer', fetchedAt: '2026-08-01T00:00:00Z', contentHash: 'h1', parserVersion: 'v1', verified: true };
    const rule: OfferRuleVersion = { id: 'r1', cardId: 'c1', version: '1', sourceSnapshotId: 's1', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } };
    alice.registerCard({ id: 'c1', issuer: 'Bank', productName: 'Card' });
    alice.upsertOffer(snapshot, rule);
    const tx: TransactionTuple = { idempotencyKey: 'same-key', cardId: 'c1', kind: 'purchase', mode: 'actual', occurredAt: '2026-08-20T00:00:00Z', amount: { amountMinor: 1000, currency: 'TWD' } };
    alice.recordTransaction(tx);
    expect(() => bob.recordTransaction(tx)).not.toThrow(/IDEMPOTENCY_CONFLICT/);
    expect(store.read().transactions).toHaveLength(2);
  });

  it('rejects caller ownership, storage, path, and credential overrides recursively', () => {
    expect(() => validateToolArgs('list_cards', { user_id: 'bob' })).toThrow(/UNKNOWN_FIELD/);
    expect(() => validateTransaction({ cardId: 'c1', kind: 'purchase', mode: 'planned', occurredAt: '2026-08-20T00:00:00Z', amount: { amountMinor: 1, currency: 'TWD' }, path: '/tmp/raw' })).toThrow(/UNKNOWN_FIELD/);
    expect(() => validateContext({ token: 'secret' })).toThrow(/UNKNOWN_FIELD/);
  });
});
