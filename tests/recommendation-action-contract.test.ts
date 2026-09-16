import { describe, expect, it } from 'vitest';
import { RewardService } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';
import { isDeepStrictEqual } from 'node:util';

class MemoryStore implements LedgerStore {
  private state = emptyState();
  read() { return structuredClone(this.state); }
  write(state: StoredState) { this.state = structuredClone(state); }
  update(change: (state: StoredState) => void) {
    const state = this.read();
    change(state);
    this.write(state);
    return this.read();
  }
  close() {}
}

const asOf = '2026-09-15T00:00:00Z';

function setupBaseEnv(service: RewardService) {
  service.registerCard({ id: 'card-tw', issuer: 'TaiwanBank', productName: 'Taiwan Card', network: 'VISA' });
  service.upsertOffer(
    { id: 'src-tw', url: 'https://bank.tw/terms', fetchedAt: asOf, contentHash: 'h-tw', parserVersion: '1', verified: true },
    {
      id: 'rule-tw',
      cardId: 'card-tw',
      version: '1',
      sourceSnapshotId: 'src-tw',
      status: 'active',
      validFrom: '2026-01-01T00:00:00Z',
      settlementCurrency: 'TWD',
      match: {},
      reward: { kind: 'percentage', rateBps: 200 },
    },
  );
}

describe('Ticket 08: Recommendation Action and Diagnostic Contract', () => {
  it('1. Fast path: returns evaluated candidates immediately without durable flow or extra round trip when facts are complete', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    const merchant = service.registerMerchant({
      canonicalNameZhHant: '全聯福利中心',
      canonicalNameLocale: 'zh-Hant-TW',
      status: 'candidate',
      operatingMarkets: ['TW'],
      provenance: { version: '1', updatedAt: asOf },
    });
    service.confirmMerchant(merchant.canonicalId);

    const beforeState = store.read();
    const result = service.recommendIntent({
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    });

    expect(result.status).toBe('ready');
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.status).toBe('ready');
    expect(result.candidates[0]?.reward).toEqual({ amountMinor: 2000, currency: 'TWD' });
    expect(result.requiredActions).toHaveLength(0);
    expect(result.resultVersion).toBeDefined();

    // Read-only guarantee: store state unchanged, no durable flows created
    expect(isDeepStrictEqual(store.read(), beforeState)).toBe(true);
    expect(store.read().ingestionFlows).toHaveLength(0);
  });

  it('2. Missing merchant: returns structured action and diagnostic with owner, candidateIds, submission, and completionCondition', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    // Unconfirmed merchant (not in catalog)
    const result = service.recommendIntent({
      merchant: 'Unregistered Unknown Shop',
      amount: { amountMinor: 50000, currency: 'TWD' },
      occurredAt: asOf,
    });

    const merchantAction = result.requiredActions.find((a) => a.id === 'merchant');
    expect(merchantAction).toBeDefined();
    expect(merchantAction?.action).toBe('research_merchant');
    expect(merchantAction?.owner).toBe('agent');
    expect(merchantAction?.candidateIds).toBeDefined();
    expect(merchantAction?.submission).toEqual({ tool: 'recommend', field: 'merchant' });
    expect(merchantAction?.completionCondition).toContain('stop retrying');
    expect(merchantAction?.diagnostic).toEqual(expect.objectContaining({
      code: 'merchant_not_found',
      path: 'merchant',
      retryAction: 'research_merchant',
    }));

    // Ambiguous merchant across markets
    for (const mkt of ['TW', 'JP']) {
      const m = service.registerMerchant({
        canonicalNameZhHant: 'Ambiguous Mart',
        canonicalNameLocale: 'zh-Hant-TW',
        status: 'candidate',
        operatingMarkets: [mkt],
        provenance: { version: '1', updatedAt: asOf },
      });
      service.confirmMerchant(m.canonicalId);
    }
    const ambiguousResult = service.recommendIntent({
      merchant: 'Ambiguous Mart',
      amount: { amountMinor: 50000, currency: 'TWD' },
      occurredAt: asOf,
    });
    const ambAction = ambiguousResult.requiredActions.find((a) => a.id === 'merchant');
    expect(ambAction?.owner).toBe('user');
    expect(ambAction?.action).toBe('resolve_merchant');
    expect(ambAction?.diagnostic?.code).toBe('merchant_ambiguous');
  });

  it('3. Missing amount/currency: returns structured action and diagnostic', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    const result = service.recommendIntent({
      merchant: 'Any Shop',
      occurredAt: asOf,
    });

    const amountAction = result.requiredActions.find((a) => a.id === 'amount');
    expect(amountAction).toBeDefined();
    expect(amountAction?.owner).toBe('user');
    expect(amountAction?.action).toBe('ask_user');
    expect(amountAction?.requiredFacts).toEqual(['amount.amountMinor', 'amount.currency']);
    expect(amountAction?.submission).toEqual({ tool: 'recommend', field: 'amount' });
    expect(amountAction?.diagnostic).toEqual(expect.objectContaining({
      code: 'missing_required_fact',
      path: 'amount',
      retryAction: 'ask_user',
    }));
  });

  it('4. Missing FX and stale FX: return structured actions with specific diagnostic codes and candidate IDs', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    // Cross-currency spend without FX snapshot
    const missingFxResult = service.recommendIntent({
      merchant: 'Tokyo Shop',
      amount: { amountMinor: 10000, currency: 'JPY' },
      occurredAt: asOf,
    });

    const fxAction = missingFxResult.requiredActions.find((a) => a.fxResolutionRequest);
    expect(fxAction).toBeDefined();
    expect(fxAction?.owner).toBe('agent');
    expect(fxAction?.candidateIds).toContain('card:card-tw');
    expect(fxAction?.diagnostic).toEqual(expect.objectContaining({
      code: 'fx_missing',
      path: 'fx',
      retryAction: 'query_approved_fx_source',
    }));

    // Supplying stale FX snapshot
    const staleFxResult = service.recommendIntent({
      merchant: 'Tokyo Shop',
      amount: { amountMinor: 10000, currency: 'JPY' },
      occurredAt: asOf,
      fx: {
        id: 'stale-fx',
        baseCurrency: 'JPY',
        quoteCurrency: 'TWD',
        ratePpm: 210000,
        capturedAt: '2026-08-01T00:00:00Z',
        maxAgeSeconds: 3600,
        provider: 'bank',
        rateType: 'card_scheme',
      },
    });

    const staleFxAction = staleFxResult.requiredActions.find((a) => a.fxResolutionRequest);
    expect(staleFxAction).toBeDefined();
    expect(staleFxAction?.diagnostic?.code).toBe('fx_stale');
    expect(staleFxAction?.completionCondition).toContain('fx_stale');
  });

  it('5. Missing and conflicting eligibility facts: returns candidate-scoped structured actions', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-member', issuer: 'Bank', productName: 'Member Card' });
    service.upsertOffer(
      { id: 'src-member', url: 'https://bank.example/terms', fetchedAt: asOf, contentHash: 'm-src', parserVersion: '1', verified: true },
      {
        id: 'rule-member',
        cardId: 'card-member',
        version: '1',
        sourceSnapshotId: 'src-member',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: {},
        predicate: { field: 'user.tier', op: 'EQUALS', value: 'VIP' },
        reward: { kind: 'percentage', rateBps: 500 },
      },
    );

    // Missing eligibility fact
    const missingResult = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
    });
    const eligAction = missingResult.requiredActions.find((a) => a.id.startsWith('eligibility:'));
    expect(eligAction).toBeDefined();
    expect(eligAction?.path).toBe('eligibilityFacts');
    expect(eligAction?.submission).toEqual({ tool: 'recommend', field: 'eligibilityFacts' });
    expect(eligAction?.candidateIds).toContain('card:card-member');
    expect(eligAction?.diagnostic).toEqual(expect.objectContaining({
      code: 'missing_required_fact',
      path: 'user.tier',
    }));

    // Conflicting eligibility facts
    const conflictResult = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
      eligibilityFacts: [
        { cardId: 'card-member', factKey: 'user.tier', value: 'VIP', version: '1' },
        { cardId: 'card-member', factKey: 'user.tier', value: 'REGULAR', version: '1' },
      ],
    });
    const conflictAction = conflictResult.requiredActions.find((a) => a.id.startsWith('eligibility:'));
    expect(conflictAction).toBeDefined();
    expect(conflictAction?.diagnostic?.code).toBe('conflicting_fact');
    expect(conflictAction?.action).toBe('resolve_conflict');

    // Stale eligibility fact
    const staleResult = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
      eligibilityFacts: [
        { cardId: 'card-member', factKey: 'user.tier', value: 'VIP', version: '1', validFrom: '2026-01-01T00:00:00Z', validTo: '2026-06-01T00:00:00Z' },
      ],
    });
    const staleAction = staleResult.requiredActions.find((a) => a.id.startsWith('eligibility:'));
    expect(staleAction).toBeDefined();
    expect(staleAction?.diagnostic?.code).toBe('stale_fact');
  });

  it('6. Benefit freshness: returns structured freshness action when offer rule is stale', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-old', issuer: 'Bank', productName: 'Old Card' });
    service.upsertOffer(
      { id: 'src-old', url: 'https://bank.example/old', fetchedAt: '2025-01-01T00:00:00Z', contentHash: 'old', parserVersion: '1', verified: true },
      {
        id: 'rule-old',
        cardId: 'card-old',
        version: '1',
        sourceSnapshotId: 'src-old',
        status: 'stale',
        validFrom: '2025-01-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: {},
        reward: { kind: 'percentage', rateBps: 100 },
      },
    );

    const result = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
    });

    const freshnessAction = result.requiredActions.find((a) => a.id === 'freshness:rule-old');
    expect(freshnessAction).toBeDefined();
    expect(freshnessAction?.action).toBe('refresh_offer');
    expect(freshnessAction?.owner).toBe('agent');
    expect(freshnessAction?.submission).toEqual({ tool: 'upsert_offer', field: 'rule' });
    expect(freshnessAction?.diagnostic).toEqual(expect.objectContaining({
      code: 'stale_rule',
      path: 'rules.rule-old',
    }));
  });

  it('7. Candidate-scoped missing facts do not block independent computable candidates (partial status)', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service); // card-tw has TWD settlement and ready rule

    // Add card-jpy that requires JPY -> TWD FX
    service.registerCard({ id: 'card-jpy', issuer: 'JapanBank', productName: 'Japan Card' });
    service.upsertOffer(
      { id: 'src-jpy', url: 'https://bank.jp/terms', fetchedAt: asOf, contentHash: 'h-jp', parserVersion: '1', verified: true },
      {
        id: 'rule-jpy',
        cardId: 'card-jpy',
        version: '1',
        sourceSnapshotId: 'src-jpy',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        settlementCurrency: 'JPY',
        match: {},
        reward: { kind: 'percentage', rateBps: 300 },
      },
    );

    const result = service.recommendIntent({
      merchant: 'Taipei Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
    });

    // card-tw should be computed and ready
    const twCandidate = result.candidates.find((c) => c.id === 'card:card-tw');
    expect(twCandidate?.status).toBe('ready');
    expect(twCandidate?.reward).toBeDefined();

    // card-jpy needs FX and is unknown
    const jpyCandidate = result.candidates.find((c) => c.id === 'card:card-jpy');
    expect(jpyCandidate?.status).toBe('unknown');

    // Overall status is partial, not blocked or needs_input
    expect(result.status).toBe('partial');
    // Actions are candidate-scoped to card-jpy
    const fxAction = result.requiredActions.find((a) => a.fxResolutionRequest);
    expect(fxAction?.candidateIds).toEqual(['card:card-jpy']);
  });

  it('8. Actions are deduplicated across candidates and coverage reports action count and unpopulated scopes', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    service.registerCard({ id: 'card-1', issuer: 'Bank1', productName: 'Card 1' });
    service.registerCard({ id: 'card-2', issuer: 'Bank2', productName: 'Card 2' });

    // Both cards need amount
    const result = service.recommendIntent({
      merchant: 'Shop',
      occurredAt: asOf,
    });

    expect(result.candidates).toHaveLength(2);
    // Amount action is deduplicated into a single action referencing both candidates
    const amountActions = result.requiredActions.filter((a) => a.id === 'amount');
    expect(amountActions).toHaveLength(1);
    expect(amountActions[0]?.candidateIds?.sort()).toEqual(['card:card-1', 'card:card-2']);

    // Coverage reports actionCount
    expect(result.coverage.actionCount).toBe(result.requiredActions.length);
    expect(result.coverage.notes.some((n) => n.includes('action(s) required'))).toBe(true);
  });

  it('9. resultVersion binds intent and state; changes invalidate old version requiring restart', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    const first = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
      limit: 1,
      page: 1,
    });

    expect(first.resultVersion).toBeDefined();

    // Valid continuation with matching resultVersion succeeds
    const second = service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
      limit: 1,
      page: 1,
      resultVersion: first.resultVersion,
    });
    expect(second.resultVersion).toBe(first.resultVersion);

    // Mutate state (e.g. register a new card)
    service.registerCard({ id: 'card-new', issuer: 'Bank', productName: 'New Card' });

    // Calling with prior resultVersion fails with restart instruction
    expect(() => service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 10000, currency: 'TWD' },
      occurredAt: asOf,
      limit: 1,
      page: 1,
      resultVersion: first.resultVersion,
    })).toThrow(/resultVersion changed; restart the recommendation/);
  });

  it('10. Read-only invariant: recommendation never consumes caps, writes transactions, or creates durable flows', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupBaseEnv(service);

    const initialSnapshot = store.read();

    service.recommendIntent({
      merchant: 'Shop',
      amount: { amountMinor: 500000, currency: 'TWD' },
      occurredAt: asOf,
    });

    const afterSnapshot = store.read();
    expect(afterSnapshot.transactions).toHaveLength(0);
    expect(afterSnapshot.ingestionFlows).toHaveLength(0);
    expect(afterSnapshot.ingestionDraftTombstones).toHaveLength(0);
    expect(isDeepStrictEqual(afterSnapshot, initialSnapshot)).toBe(true);
  });
});
