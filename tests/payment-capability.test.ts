import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state: StoredState = emptyState();
  read() { return structuredClone(this.state); }
  write(next: StoredState) { this.state = structuredClone(next); }
  update(mutator: (state: StoredState) => void) { const next = this.read(); mutator(next); this.write(next); return this.read(); }
  close() {}
}

describe('public payment capability persistence', () => {
  it('stores an evidence-backed capability separately from user routes', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const evidence = service.submitEvidence({ id: 'capability-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'merchant acceptance' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'capability-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const capability = service.upsertPaymentCapability({
      providerId: 'wallet.example', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-network',
      fundingKinds: ['credit_card'], transitions: ['wallet_top_up', 'wallet_debit', 'merchant_settlement'], market: 'JP', channel: 'in_store', merchant: 'shop',
      sourceUrl: 'https://wallet.example/terms', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'capability-1',
    });
    expect(capability.id).toMatch(/^cap_/);
    expect(capability.ownerUser).toBeUndefined();
    expect(service.listPaymentCapabilities()).toEqual([capability]);
    expect(service.listPaymentRoutes()).toEqual([]);
  });

  it('generates a planned wallet route from a capability and a held card without persisting a route', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'held-card', issuer: 'Bank', productName: 'Card' });
    const evidence = service.submitEvidence({ id: 'generation-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'wallet acceptance' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'generation-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentCapability({ providerId: 'wallet.example', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-network', fundingKinds: ['credit_card'], transitions: ['wallet_top_up', 'wallet_debit', 'merchant_settlement'], sourceUrl: 'https://wallet.example/terms', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'generation-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    expect(result.candidates.some((candidate) => candidate.kind === 'payment_path' && candidate.routeId?.startsWith('generated_'))).toBe(true);
    expect(store.read().paymentRoutes).toHaveLength(0);
  });

  it('generates an account-funded planned route with explicit debit and wallet transitions', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const account = service.upsertPaymentAccount({ providerId: 'bank', kind: 'linked_bank_account', displayName: 'Bank account', status: 'active', observedAt: '2026-09-01T00:00:00Z', confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'generated-account' });
    const evidence = service.submitEvidence({ id: 'account-capability-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'account wallet acceptance' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'account-capability-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentCapability({ providerId: 'wallet.example', acceptanceProviderId: 'qr-network', fundingKinds: ['account'], transitions: ['account_debit', 'wallet_debit', 'merchant_settlement'], evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'account-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    const candidate = result.candidates.find((item) => item.routeId?.endsWith(`_${account.id}`));
    expect(candidate).toEqual(expect.objectContaining({ kind: 'payment_path', routeId: expect.stringContaining('generated_') }));
    expect(candidate?.events.map((event) => event.transition)).toEqual(['account_debit', 'wallet_debit', 'merchant_settlement']);
  });

  it('returns a capability-scoped binding action when no matching funding is held', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const evidence = service.submitEvidence({ id: 'binding-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'wallet acceptance' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'binding-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const capability = service.upsertPaymentCapability({ providerId: 'wallet.example', acceptanceProviderId: 'qr-network', fundingKinds: ['credit_card'], transitions: ['wallet_top_up', 'wallet_debit', 'merchant_settlement'], evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'binding-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    expect(result.requiredActions).toEqual(expect.arrayContaining([expect.objectContaining({ id: `capability:${capability.id}`, action: 'bind_payment_method', owner: 'user', submission: { tool: 'register_card', field: 'card' }, requiredFacts: ['held credit_card'] })]));
  });

  it('projects layered rewards onto a generated wallet route without treating top-up as a purchase', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    service.registerCard({ id: 'layered-card', issuer: 'Bank', productName: 'Layered Card' });
    const evidence = service.submitEvidence({ id: 'layered-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'layered wallet payment' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'layered-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    const source = { id: 'layered-offer-source', url: 'https://wallet.example/terms', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'layered-offer', parserVersion: '1', verified: true as const };
    service.upsertOffer(source, { id: 'layered-provider-rule', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 80, currency: 'TWD' }, componentKind: 'payment_provider', sponsor: 'Wallet', benefitGroup: 'wallet', stacking: 'confirmed', combination: { mode: 'additive', groupId: 'layered-provider', version: '1' }, eventRule: { id: 'layered-provider-event', version: '1', eventKind: 'purchase' } });
    service.upsertOffer(source, { id: 'layered-loyalty-rule', version: '1', sourceSnapshotId: source.id, status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 20, currency: 'TWD' }, componentKind: 'merchant_loyalty', sponsor: 'Merchant', benefitGroup: 'merchant', stacking: 'confirmed', combination: { mode: 'additive', groupId: 'layered-loyalty', version: '1' }, eventRule: { id: 'layered-loyalty-event', version: '1', eventKind: 'purchase' } });
    const capability = service.upsertPaymentCapability({ providerId: 'wallet.example', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-network', fundingKinds: ['credit_card'], transitions: ['wallet_top_up', 'wallet_debit', 'merchant_settlement'], evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'layered-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    const candidate = result.candidates.find((item) => item.routeId === `generated_${capability.id}_layered-card`);
    expect(candidate).toEqual(expect.objectContaining({ kind: 'payment_path', status: 'ready', reward: { amountMinor: 100, currency: 'TWD' } }));
    expect(candidate?.matchedRules.map((rule) => rule.component)).toEqual(expect.arrayContaining(['payment_provider', 'merchant_loyalty']));
    expect(candidate?.events.map((event) => event.kind)).toEqual(['top_up', 'purchase', 'purchase']);
    expect(candidate?.events[0]?.transition).toBe('wallet_top_up');
    expect(candidate?.events.some((event) => event.transition === 'card_authorization')).toBe(false);
  });
});
