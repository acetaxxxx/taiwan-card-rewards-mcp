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
      fundingKinds: ['credit_card'], market: 'JP', channel: 'in_store', merchant: 'shop',
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
    service.upsertPaymentCapability({ providerId: 'wallet.example', consumerAppId: 'wallet-app', acceptanceProviderId: 'qr-network', fundingKinds: ['credit_card'], sourceUrl: 'https://wallet.example/terms', evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'generation-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    expect(result.candidates.some((candidate) => candidate.kind === 'payment_path' && candidate.routeId?.startsWith('generated_'))).toBe(true);
    expect(store.read().paymentRoutes).toHaveLength(0);
  });

  it('generates an account-funded planned route with explicit debit and wallet transitions', () => {
    const service = new RewardService(new MemoryStore(), 'u1');
    const account = service.upsertPaymentAccount({ providerId: 'bank', kind: 'linked_bank_account', displayName: 'Bank account', status: 'active', observedAt: '2026-09-01T00:00:00Z', confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'generated-account' });
    const evidence = service.submitEvidence({ id: 'account-capability-evidence', requirementId: 'payment-capability', sourceIdentity: 'wallet.example', sourceType: 'official', authority: 'wallet', claim: { capability: 'account wallet acceptance' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'account-capability-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
    service.upsertPaymentCapability({ providerId: 'wallet.example', acceptanceProviderId: 'qr-network', fundingKinds: ['account'], evidenceIds: [evidence.id], observedAt: '2026-09-01T00:00:00Z', idempotencyKey: 'account-capability' });
    const result = service.recommendIntent({ merchant: 'shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-02T00:00:00Z' });
    const candidate = result.candidates.find((item) => item.routeId?.endsWith(`_${account.id}`));
    expect(candidate).toEqual(expect.objectContaining({ kind: 'payment_path', routeId: expect.stringContaining('generated_') }));
    expect(candidate?.events.map((event) => event.transition)).toEqual(['account_debit', 'wallet_debit', 'merchant_settlement']);
  });
});
