import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore { private state: StoredState = emptyState(); read() { return structuredClone(this.state); } write(next: StoredState) { this.state = structuredClone(next); } update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); } close() {} }
const input = { status: 'active' as const, idempotencyKey: 'route-key', layers: [{ kind: 'payment_provider' as const, providerId: 'unknown-provider' }, { kind: 'card_issuer' as const, providerId: 'bank' }], funding: { kind: 'credit_card' as const, cardId: 'card-1' }, observedAt: '2026-09-05T00:00:00Z', confirmation: { confirmedAt: '2026-09-05T00:00:00Z', confirmedBy: 'user' } };

describe('first-class payment route onboarding', () => {
  it('creates MCP-owned route identity and keeps ordered layers/funding', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const route = service.upsertPaymentRoute(input);
    expect(route.id).toMatch(/^route_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(route.layers.map((layer) => layer.kind)).toEqual(['payment_provider', 'card_issuer']);
    expect(route.funding).toEqual(input.funding);
    expect(service.upsertPaymentRoute({ ...input, id: 'attacker-id' }).id).toBe(route.id);
  });
  it('is idempotent and user scoped', () => {
    const store = new MemoryStore();
    const one = new RewardService(store, 'u1');
    const two = new RewardService(store, 'u2');
    const route = one.upsertPaymentRoute(input);
    expect(one.listPaymentRoutes()).toHaveLength(1);
    expect(two.listPaymentRoutes()).toHaveLength(0);
    expect(() => one.upsertPaymentRoute({ ...input, layers: [{ kind: 'payment_provider' as const, providerId: 'changed' }, { kind: 'card_issuer' as const, providerId: 'bank' }] })).toThrow(/different payment route/);
    expect(route.status).toBe('active');
  });
  it('rejects credential fields while accepting unknown provider identifiers as candidates', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    expect(() => service.upsertPaymentRoute({ ...input, apiToken: 'secret' })).toThrow();
    expect(service.upsertPaymentRoute({ ...input, status: 'candidate', confirmation: undefined }).layers[0]?.providerId).toBe('unknown-provider');
  });

  it('records acceptance, app, interoperability, and account-funding facts without provider enums', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const route = service.upsertPaymentRoute({
      status: 'active',
      idempotencyKey: 'paypay-taishin-account',
      layers: [
        { kind: 'merchant_acceptance', providerId: 'paypay_qr', evidenceIds: ['ev-paypay'] },
        { kind: 'consumer_app', appId: 'taishin_pay_plus', evidenceIds: ['ev-taishin'] },
        { kind: 'interoperability_scheme', providerId: 'hivex', evidenceIds: ['ev-hivex'] },
      ],
      funding: { kind: 'account', subtype: 'foreign_currency_account' },
      evidenceIds: ['ev-paypay', 'ev-taishin'],
      observedAt: '2026-09-05T00:00:00Z',
      confirmation: { confirmedAt: '2026-09-05T00:00:00Z', confirmedBy: 'user' },
    });
    expect(route.layers.map((layer) => layer.kind)).toEqual(['merchant_acceptance', 'consumer_app', 'interoperability_scheme']);
    expect(route.funding).toEqual({ kind: 'account', subtype: 'foreign_currency_account' });
    expect(route.evidenceIds).toEqual(['ev-paypay', 'ev-taishin']);
  });
});
