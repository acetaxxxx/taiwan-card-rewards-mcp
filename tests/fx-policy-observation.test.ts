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

describe('FX policy and observation persistence', () => {
  it('stores policy and observation separately with tenant ownership and idempotency', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    const evidence = service.submitEvidence({ id: 'evidence-fx-policy', requirementId: 'fx-policy:issuer', sourceIdentity: 'issuer.example', sourceType: 'official', authority: 'issuer', claim: { policyKey: 'issuer-jpy', rateType: 'cash_selling' }, observedAt: '2026-09-10T00:00:00Z', confidence: 'high', contentHash: 'policy-hash', reviewState: 'accepted', sourceUrl: 'https://issuer.example/fx' });
    const policy = service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', baseCurrency: 'JPY', quoteCurrency: 'TWD', scope: { kind: 'issuer', issuer: 'Example Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: evidence.id, observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' });
    const observation = service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Example Bank', rateType: 'cash_selling', conversionOwner: 'issuer', sourceUrl: 'https://issuer.example/rates', contentHash: 'rate-hash', idempotencyKey: 'observation-1' });

    expect(service.listFxPolicies()).toEqual([policy]);
    expect(service.listFxObservations()).toEqual([observation]);
    expect(service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', baseCurrency: 'JPY', quoteCurrency: 'TWD', scope: { kind: 'issuer', issuer: 'Example Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: evidence.id, observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' })).toEqual(policy);
    expect(service.store.read().fxPolicies).toHaveLength(1);
    expect(service.store.read().fxObservations).toHaveLength(1);
  });

  it('rejects observations without provenance and policies without accepted official evidence', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    expect(() => service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Bank', rateType: 'cash_selling', idempotencyKey: 'observation-1' })).toThrow(/sourceUrl and contentHash/);
    expect(() => service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', baseCurrency: 'JPY', quoteCurrency: 'TWD', scope: { kind: 'issuer', issuer: 'Bank' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: 'missing', observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' })).toThrow(/accepted official evidence/);
  });

  it('requires the identifier matching an FX policy scope', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    expect(() => service.upsertFxPolicy({ policyKey: 'issuer-jpy', version: '1', baseCurrency: 'JPY', quoteCurrency: 'TWD', scope: { kind: 'issuer' }, conversionOwner: 'issuer', rateType: 'cash_selling', rateDirection: 'base_to_quote', conversionTiming: 'settlement', evidenceId: 'missing', observedAt: '2026-09-10T00:00:00Z', idempotencyKey: 'policy-1' })).toThrow(/requires issuer/);
  });

  it('reuses a fresh stored observation during planned recommendation', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-09T00:00:00Z', maxAgeSeconds: 86400, provider: 'Bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/rate', contentHash: 'rate', idempotencyKey: 'obs-1' });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    expect(result.requiredActions.some((action) => action.fxResolutionRequest?.quoteCurrency === 'TWD')).toBe(false);
    expect(result.candidates.find((candidate) => candidate.cardId === 'card-jpy')?.matchedRules[0]?.status).toBe('matched');
  });

  it('does not reuse a route-scoped observation for a direct-card candidate', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-route-scope', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'route-scope-offer', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'route-scope-offer', parserVersion: '1', verified: true }, { id: 'route-scope-rule', cardId: 'card-route-scope', version: '1', sourceSnapshotId: 'route-scope-offer', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-09T00:00:00Z', maxAgeSeconds: 86400, provider: 'Wallet', rateType: 'spot_selling', sourceUrl: 'https://wallet.example/rate', contentHash: 'route-scoped-rate', routeIdScope: 'route-only', edgeIdScope: 'edge-1', idempotencyKey: 'route-scoped-observation' });
    const candidate = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' }).candidates.find((item) => item.cardId === 'card-route-scope');
    expect(candidate?.fxEstimate?.status).toBe('unavailable');
  });

  it('returns a stale estimate with a refresh action instead of dropping the candidate', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-01T00:00:00Z', maxAgeSeconds: 3600, provider: 'Bank', rateType: 'card_scheme', sourceUrl: 'https://bank.example/rate', contentHash: 'rate', idempotencyKey: 'obs-stale' });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    const candidate = result.candidates.find((item) => item.cardId === 'card-jpy');
    expect(candidate?.fxEstimate?.status).toBe('stale_estimate');
    expect(result.requiredActions.some((action) => action.fxResolutionRequest?.quoteCurrency === 'TWD')).toBe(true);
    expect(result.requiredActions.find((action) => action.fxResolutionRequest?.quoteCurrency === 'TWD')?.fxResolutionRequest?.referenceSourceUrls).toEqual(['https://rate.bot.com.tw/xrt?Lang=zh-TW']);
  });

  it('requests policy research separately from the FX observation refresh', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Example Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'policy-offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'policy-offer', parserVersion: '1', verified: true }, { id: 'policy-jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'policy-offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    const action = result.requiredActions.find((candidate) => candidate.action === 'research_fx_policy');
    expect(action).toEqual(expect.objectContaining({ owner: 'agent', submission: { tool: 'upsert_fx_policy', field: 'policy' } }));
    expect(action?.fxPolicyResearchRequest).toEqual(expect.objectContaining({ purpose: 'policy_research', scope: { kind: 'issuer', issuer: 'Example Bank' }, sourceStatus: 'discovery_required' }));
    expect(action?.requiredFacts).toEqual(expect.arrayContaining(['conversionOwner', 'rateType', 'conversionTiming', 'evidenceId']));
  });

  it('asks the user when current FX policies conflict instead of choosing by insertion order', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-conflict', issuer: 'Example Bank', productName: 'Japan Card' });
    const evidence1 = service.submitEvidence({ id: 'policy-conflict-1', requirementId: 'fx-policy:issuer:terms', sourceIdentity: 'bank-terms', sourceType: 'official', authority: 'issuer', claim: { policy: 'settlement' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'policy-conflict-1', reviewState: 'accepted', sourceUrl: 'https://bank.example/terms' });
    const evidence2 = service.submitEvidence({ id: 'policy-conflict-2', requirementId: 'fx-policy:issuer:rate', sourceIdentity: 'bank-rate', sourceType: 'official', authority: 'issuer', claim: { policy: 'posting' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'policy-conflict-2', reviewState: 'accepted', sourceUrl: 'https://bank.example/rates' });
    const base = { baseCurrency: 'JPY', quoteCurrency: 'TWD', scope: { kind: 'issuer' as const, issuer: 'Example Bank' }, conversionOwner: 'issuer' as const, rateDirection: 'base_to_quote' as const, evidenceId: evidence1.id, observedAt: '2026-09-01T00:00:00Z' };
    service.upsertFxPolicy({ ...base, policyKey: 'issuer-jpy', version: '1', rateType: 'cash_selling', conversionTiming: 'settlement', idempotencyKey: 'policy-conflict-1' });
    service.upsertFxPolicy({ ...base, evidenceId: evidence2.id, policyKey: 'issuer-jpy', version: '2', rateType: 'card_scheme', conversionTiming: 'posting', idempotencyKey: 'policy-conflict-2' });
    service.upsertOffer({ id: 'conflict-offer', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'conflict-offer', parserVersion: '1', verified: true }, { id: 'conflict-rule', cardId: 'card-conflict', version: '1', sourceSnapshotId: 'conflict-offer', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' });
    expect(result.requiredActions).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'ask_user', path: 'fxPolicy', candidateIds: ['card:card-conflict'] })]));
  });

  it('preserves route and edge scope when persisting observations', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    const observation = service.upsertFxObservation({ baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32000000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Wallet', rateType: 'spot_selling', sourceUrl: 'https://wallet.example/rate', contentHash: 'route-rate', routeIdScope: 'route-1', edgeIdScope: 'edge-1', idempotencyKey: 'route-obs-1' });
    expect(observation.routeIdScope).toBe('route-1');
    expect(observation.edgeIdScope).toBe('edge-1');
    expect(() => service.upsertFxObservation({ baseCurrency: 'USD', quoteCurrency: 'TWD', ratePpm: 32000000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Wallet', rateType: 'spot_selling', sourceUrl: 'https://wallet.example/rate', contentHash: 'route-rate', edgeIdScope: 'edge-2', idempotencyKey: 'bad-scope' })).toThrow(/requires routeIdScope/);
  });

  it('marks missing FX as unavailable instead of inventing a zero-cost estimate', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const candidate = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' }).candidates.find((item) => item.cardId === 'card-jpy');
    expect(candidate?.fxEstimate?.status).toBe('unavailable');
    expect(candidate?.netSpend).toBeUndefined();
  });

  it('accepts an Agent-supplied public reference observation as an estimate only', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    const result = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z', fxObservation: { id: 'bot-jpy', baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Bank of Taiwan', rateType: 'spot_selling', sourceUrl: 'https://rate.bot.com.tw/xrt?Lang=zh-TW', contentHash: 'bot-page' } });
    const candidate = result.candidates.find((item) => item.cardId === 'card-jpy');
    expect(candidate?.fxEstimate?.status).toBe('reference_estimate');
    expect(candidate?.status).toBe('unknown');
    expect(candidate?.fxEstimate?.assumption).toContain('issuer');
  });

  it('does not upgrade a stored public reference to a policy-current quote', () => {
    const service = new RewardService(new MemoryStore(), 'user-1');
    service.registerCard({ id: 'card-jpy', issuer: 'Bank', productName: 'Japan Card' });
    service.upsertOffer({ id: 'offer-source', url: 'https://bank.example/offer', fetchedAt: '2026-09-01T00:00:00Z', contentHash: 'offer', parserVersion: '1', verified: true }, { id: 'jpy-rule', cardId: 'card-jpy', version: '1', sourceSnapshotId: 'offer-source', status: 'active', validFrom: '2026-01-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'percentage', rateBps: 100 } });
    service.upsertFxObservation({ sourceKind: 'public_reference', baseCurrency: 'JPY', quoteCurrency: 'TWD', ratePpm: 215000, capturedAt: '2026-09-10T00:00:00Z', provider: 'Bank of Taiwan', rateType: 'spot_selling', sourceUrl: 'https://rate.bot.com.tw/xrt?Lang=zh-TW', contentHash: 'bot-page', idempotencyKey: 'obs-reference' });
    const candidate = service.recommendIntent({ merchant: 'Shop', amount: { amountMinor: 1000, currency: 'JPY' }, occurredAt: '2026-09-10T00:00:00Z' }).candidates.find((item) => item.cardId === 'card-jpy');
    expect(candidate?.fxEstimate?.status).toBe('reference_estimate');
  });
});
