import { describe, expect, it } from 'vitest';
import type { LedgerStore, StoredState } from '../src/store.js';
import { emptyState } from '../src/store.js';
import { RewardService } from '../src/service.js';
import { RewardServiceError } from '../src/errors.js';

describe('payment account onboarding', () => {
  class MemoryStore implements LedgerStore {
    private state: StoredState = emptyState();
    read(): StoredState { return structuredClone(this.state); }
    write(next: StoredState): void { this.state = structuredClone(next); }
    update(mutator: (state: StoredState) => void): StoredState { const next = this.read(); mutator(next); this.write(next); return this.read(); }
    close(): void { /* no-op */ }
  }

  it('onboards a confirmed JKO PAY wallet without credentials', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const account = service.upsertPaymentAccount({
      providerId: 'jkopay',
      kind: 'wallet_balance',
      displayName: '街口支付',
      status: 'active',
      observedAt: '2026-09-05T00:00:00Z',
      confirmation: { confirmedAt: '2026-09-05T00:00:00Z', confirmedBy: 'user' },
      evidenceIds: ['evidence-jkopay'],
      idempotencyKey: 'account-jkopay-1',
    });

    expect(account.id).toMatch(/^acct_/);
    expect(account.ownerUser).toBe('u1');
    expect(service.listPaymentAccounts()).toHaveLength(1);
    const route = service.upsertPaymentRoute({
      status: 'active', layers: [{ kind: 'wallet', providerId: 'jkopay', displayName: '街口支付' }],
      funding: { kind: 'account', subtype: 'wallet_balance', accountId: account.id },
      observedAt: '2026-09-05T00:00:00Z', confirmation: { confirmedAt: '2026-09-05T00:00:00Z', confirmedBy: 'user' },
      idempotencyKey: 'route-jkopay-1',
    });
    expect(route.funding).toMatchObject({ kind: 'account', accountId: account.id });
  });

  it('fails closed for unconfirmed active accounts and replays idempotently', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    expect(() => service.upsertPaymentAccount({
      providerId: 'jkopay', kind: 'wallet_balance', displayName: '街口支付', status: 'active',
      observedAt: '2026-09-05T00:00:00Z', idempotencyKey: 'account-jkopay-2',
    })).toThrowError(RewardServiceError);
    const input = {
      providerId: 'jkopay', kind: 'wallet_balance', displayName: '街口支付', status: 'candidate',
      observedAt: '2026-09-05T00:00:00Z', idempotencyKey: 'account-jkopay-3',
    };
    expect(service.upsertPaymentAccount(input)).toEqual(service.upsertPaymentAccount(input));
  });
});
