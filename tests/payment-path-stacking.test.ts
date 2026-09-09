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

function setup() {
  const store = new MemoryStore(); const service = new RewardService(store, 'u1');
  const evidence = service.submitEvidence({ id: 'stack-route', requirementId: 'route', sourceIdentity: 'wallet', sourceType: 'official', authority: 'wallet', claim: { route: 'wallet-purchase' }, observedAt: '2026-09-01T00:00:00Z', confidence: 'high', contentHash: 'stack-route-hash', reviewState: 'accepted', sourceUrl: 'https://wallet.example/terms' });
  const account = service.upsertPaymentAccount({ providerId: 'wallet', kind: 'wallet_balance', displayName: 'Wallet', status: 'active', observedAt: '2026-09-01T00:00:00Z', balance: { amountMinor: 500, currency: 'TWD' }, evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' }, idempotencyKey: 'stack-account' });
  const route = service.upsertPaymentRoute({ status: 'active', idempotencyKey: 'stack-route', layers: [], funding: { kind: 'account', subtype: 'wallet_balance', accountId: account.id }, observedAt: '2026-09-01T00:00:00Z', sourceUrl: 'https://wallet.example/terms', authority: 'wallet', confidence: 'high', evidenceIds: [evidence.id], confirmation: { confirmedAt: '2026-09-01T00:00:00Z', confirmedBy: 'u1' } });
  return { store, service, route };
}

function rule(routeId: string, id: string, sponsor: string, benefitGroup: string, amountMinor: number, combination?: Record<string, unknown>, capPoolRefs?: readonly string[]) {
  return { id, version: '1', sourceSnapshotId: `snapshot-${id}`, status: 'active' as const, validFrom: '2026-09-01T00:00:00Z', settlementCurrency: 'TWD', match: {}, reward: { kind: 'cash', amountMinor, currency: 'TWD' }, componentKind: 'payment_provider' as const, routeId, sponsor, benefitGroup, eventRule: { id: `event-${id}`, version: '1', eventKind: 'purchase' as const, fundingKind: 'account' as const, fundingSubtype: 'wallet_balance' as const }, ...(combination === undefined ? {} : { combination }), ...(capPoolRefs === undefined ? {} : { capPoolRefs }) };
}

function addRule(service: RewardService, input: ReturnType<typeof rule>, capPools?: readonly { id: string; metric: 'reward'; period: 'calendar_month'; limit: number; currency: 'TWD'; timezone: string }[]) {
  service.upsertOffer({ id: input.sourceSnapshotId, url: 'https://wallet.example/terms', fetchedAt: '2026-09-01T00:00:00Z', contentHash: `${input.id}-hash`, parserVersion: '1', verified: true }, input as never, undefined, capPools);
}

describe('planned reward stacking and cap preview', () => {
  it('does not silently stack duplicate benefits from one sponsor/group', () => {
    const { service, route } = setup();
    addRule(service, rule(route.id, 'wallet-a', 'wallet', 'purchase', 10));
    addRule(service, rule(route.id, 'wallet-b', 'wallet', 'purchase', 20));
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id] });
    expect(result.status).toBe('needs_review');
    expect(result.candidates[0]?.matchedRules).toHaveLength(0);
    expect(result.candidates[0]?.exclusionReasons).toContain('ambiguous stacking policy');
  });

  it('accepts separate cross-sponsor components only with explicit additive policy', () => {
    const { service, route } = setup();
    const additive = { mode: 'additive', groupId: 'wallet-stack', version: '1' };
    addRule(service, rule(route.id, 'wallet-a', 'wallet', 'purchase', 10, additive));
    addRule(service, rule(route.id, 'merchant-a', 'merchant', 'purchase', 20, additive));
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id] });
    expect(result.status).toBe('ok');
    expect(result.candidates[0]?.matchedRules).toHaveLength(2);
    expect(result.candidates[0]?.cappedReward).toEqual({ amountMinor: 30, currency: 'TWD' });
  });

  it('previews an explicit shared reward cap without mutating recommendation state', () => {
    const { service, route, store } = setup();
    const additive = { mode: 'additive', groupId: 'wallet-stack', version: '1' };
    const pool = { id: 'shared-reward', metric: 'reward' as const, period: 'calendar_month' as const, limit: 15, currency: 'TWD' as const, timezone: 'Asia/Taipei' };
    addRule(service, rule(route.id, 'wallet-a', 'wallet', 'purchase', 10, additive, [pool.id]), [pool]);
    addRule(service, rule(route.id, 'merchant-a', 'merchant', 'purchase', 20, additive, [pool.id]));
    const before = JSON.stringify(store.read().eventRewardLedger);
    const result = service.recommendPaymentPaths({ amount: { amountMinor: 100, currency: 'TWD' }, routeIds: [route.id] });
    expect(result.candidates[0]?.cappedReward).toEqual({ amountMinor: 15, currency: 'TWD' });
    expect(result.candidates[0]?.matchedRules.map((item) => item.reward.amountMinor)).toEqual([10, 5]);
    expect(JSON.stringify(store.read().eventRewardLedger)).toBe(before);
  });
});
