import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) { const state = this.read(); change(state); this.write(state); return this.read(); }
  close() {}
}

const at = '2026-09-10T00:00:00Z';

describe('payment-route FX recovery', () => {
  it('diagnoses the affected edge and applies only an exact ephemeral route fact on retry', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card', issuer: 'Issuer', productName: 'Card' });
    const evidence = service.submitEvidence({ id: 'edge-evidence', requirementId: 'route', sourceIdentity: 'issuer', sourceType: 'official', authority: 'issuer', claim: {}, observedAt: at, confidence: 'high', contentHash: 'edge', reviewState: 'accepted', sourceUrl: 'https://issuer.example/route' });
    const route = service.upsertPaymentRoute({
      status: 'active', layers: [{ kind: 'card_issuer', providerId: 'Issuer', evidenceIds: [evidence.id] }],
      funding: { kind: 'credit_card', cardId: 'card' }, observedAt: at, sourceUrl: 'https://issuer.example/route', authority: 'issuer', confidence: 'high', evidenceIds: [evidence.id],
      confirmation: { confirmedAt: at, confirmedBy: 'u1' }, idempotencyKey: 'route',
      nodes: [{ id: 'funding', kind: 'funding_source', displayName: 'Card' }, { id: 'merchant', kind: 'merchant', displayName: 'Shop' }],
      edges: [{ edgeId: 'settle', fromNodeId: 'funding', toNodeId: 'merchant', transition: 'direct_settlement', evidenceIds: [evidence.id], fee: { amountMinor: 10, currency: 'USD' } }],
    });
    service.upsertOffer(
      { id: 'source', url: 'https://issuer.example/offer', fetchedAt: at, contentHash: 'source', parserVersion: '1', verified: true },
      { id: 'rule', cardId: 'card', routeId: route.id, version: '1', sourceSnapshotId: 'source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'flat', amountMinor: 100, currency: 'TWD' }, componentKind: 'payment_provider', sponsor: 'Issuer', benefitGroup: 'route', stacking: 'confirmed', combination: { mode: 'additive', groupId: 'route', version: '1' } },
    );
    const intent = { merchant: 'Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: at, routeIds: [route.id] };
    const before = store.read();

    const missing = service.recommendIntent(intent);
    const action = missing.requiredActions.find((candidate) => candidate.fxResolutionRequest);
    expect(missing.candidates[0]?.status).toBe('blocked');
    expect(action).toEqual(expect.objectContaining({ owner: 'agent', candidateIds: [missing.candidates[0]!.id], submission: { tool: 'recommend', field: 'routeFacts' } }));
    expect(action?.fxResolutionRequest).toEqual(expect.objectContaining({ baseCurrency: 'USD', quoteCurrency: 'TWD', scope: { kind: 'route_edge', routeId: route.id, edgeId: 'settle' }, rateDirection: 'base_to_quote' }));

    const wrongEdge = service.recommendIntent({ ...intent, routeFacts: [{ routeId: route.id, edgeId: 'other', fx: { id: 'fx-wrong', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32_000_000, capturedAt: at, provider: 'network', rateType: 'card_scheme' } }] });
    expect(wrongEdge.candidates[0]?.status).toBe('blocked');

    const wrongScope = service.recommendIntent({ ...intent, routeFacts: [{ routeId: route.id, edgeId: 'settle', fx: { id: 'fx-scope', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32_000_000, capturedAt: at, provider: 'network', rateType: 'card_scheme', cardIdScope: 'other-card', issuerScope: 'Other issuer' } }] });
    expect(wrongScope.candidates[0]?.status).toBe('blocked');

    const stale = service.recommendIntent({ ...intent, routeFacts: [{ routeId: route.id, edgeId: 'settle', fx: { id: 'fx-stale', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32_000_000, capturedAt: '2026-08-01T00:00:00Z', maxAgeSeconds: 3600, provider: 'network', rateType: 'card_scheme' } }] });
    expect(stale.candidates[0]?.status).toBe('blocked');
    expect(stale.requiredActions.some((candidate) => candidate.fxResolutionRequest?.scope?.edgeId === 'settle')).toBe(true);

    const recovered = service.recommendIntent({ ...intent, routeFacts: [{ routeId: route.id, edgeId: 'settle', fx: { id: 'fx', baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32_000_000, capturedAt: at, provider: 'network', rateType: 'card_scheme', cardIdScope: 'card', issuerScope: 'Issuer' } }] });
    expect(recovered.candidates[0]).toEqual(expect.objectContaining({ status: 'ready', reward: { amountMinor: 100, currency: 'TWD' } }));
    expect(recovered.candidates[0]?.id).toBe(missing.candidates[0]?.id);
    expect(recovered.requiredActions.some((candidate) => candidate.fxResolutionRequest)).toBe(false);
    expect(store.read()).toEqual(before);
  });
});
