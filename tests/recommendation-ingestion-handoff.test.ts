import { describe, expect, it } from 'vitest';
import { RewardService, computeIntentFingerprint } from '../src/service.js';
import { emptyState, type LedgerStore, type StoredState } from '../src/store.js';

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

function setupEnvironment(service: RewardService) {
  // Register card
  service.registerCard({ id: 'card-tw', issuer: 'TaiwanBank', productName: 'Taiwan Card', network: 'VISA' });
  
  // Register merchant
  const merchant = service.registerMerchant({
    canonicalNameZhHant: '全聯福利中心',
    canonicalNameLocale: 'zh-Hant-TW',
    status: 'candidate',
    operatingMarkets: ['TW'],
    provenance: { version: '1', updatedAt: asOf },
  });
  service.confirmMerchant(merchant.canonicalId);

  // Upsert stale offer rule
  service.upsertOffer(
    { id: 'src-tw-stale', url: 'https://bank.tw/terms', fetchedAt: '2025-01-01T00:00:00Z', contentHash: 'h-stale', parserVersion: '1', verified: true },
    {
      id: 'rule-tw-stale',
      familyId: 'family-tw-groceries',
      cardId: 'card-tw',
      version: '1',
      sourceSnapshotId: 'src-tw-stale',
      status: 'stale',
      validFrom: '2025-01-01T00:00:00Z',
      validTo: '2025-12-31T23:59:59Z',
      settlementCurrency: 'TWD',
      match: {},
      reward: { kind: 'percentage', rateBps: 300 },
    },
  );
}

describe('Ticket 10: Recommendation and Ingestion Refresh Handoff', () => {
  it('1. Emits REFRESH_BENEFIT action on stale rule with sourceScope, reason, freshness, and create_ingestion contract', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const result = service.recommendIntent({
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    });

    expect(result.status).toBe('needs_input');
    const refreshAction = result.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale');
    expect(refreshAction).toBeDefined();
    expect(refreshAction?.action).toBe('REFRESH_BENEFIT');
    expect(refreshAction?.owner).toBe('agent');
    expect(refreshAction?.submission).toEqual({ tool: 'create_ingestion', field: 'sourceScope' });
    expect(refreshAction?.refreshBenefit).toEqual(expect.objectContaining({
      sourceScope: { kind: 'official_url', value: 'https://bank.tw/terms' },
      familyId: 'family-tw-groceries',
      ruleId: 'rule-tw-stale',
      cardId: 'card-tw',
      freshnessRequired: expect.objectContaining({ asOf }),
    }));
    expect(refreshAction?.refreshBenefit?.reason).toContain('rule-tw-stale');
  });

  it('2. Saves parent continuation in child ingestion without storing old rankings as truth', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const recResult = service.recommendIntent(intent);
    const refreshAction = recResult.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;
    const fingerprint = computeIntentFingerprint(intent);

    const child = service.createIngestion({
      sourceScope: refreshAction.refreshBenefit!.sourceScope,
      idempotencyKey: 'child-ingest-1',
      parentContinuation: {
        intentFingerprint: fingerprint,
        parentResultVersion: recResult.resultVersion,
        sourceScope: refreshAction.refreshBenefit!.sourceScope,
        ruleFamily: refreshAction.refreshBenefit!.familyId,
      },
    });

    expect(child.flow.id).toBeDefined();
    expect(child.flow.parentContinuation).toEqual({
      intentFingerprint: fingerprint,
      parentResultVersion: recResult.resultVersion,
      childFlowId: child.flow.id,
      sourceScope: refreshAction.refreshBenefit!.sourceScope,
      ruleFamily: refreshAction.refreshBenefit!.familyId,
    });

    // Ingestion record does NOT store old rankings or candidate rewards
    const flowRecord = store.read().ingestionFlows.find((f) => f.id === child.flow.id)!;
    expect(flowRecord).not.toHaveProperty('candidates');
    expect(flowRecord).not.toHaveProperty('rankings');
    expect(flowRecord).not.toHaveProperty('reward');
  });

  it('3. Deduplication: repeating same refresh requirement reuses existing incomplete child flow', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const recResult = service.recommendIntent(intent);
    const scope = recResult.requiredActions[0]!.refreshBenefit!.sourceScope;
    const fingerprint = computeIntentFingerprint(intent);

    const first = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'call-1',
      parentContinuation: {
        intentFingerprint: fingerprint,
        parentResultVersion: recResult.resultVersion,
      },
    });

    // Second call with different idempotency key but same owner and sourceScope
    const retry = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'call-2',
      parentContinuation: {
        intentFingerprint: fingerprint,
        parentResultVersion: recResult.resultVersion,
      },
    });

    expect(retry.flow.id).toBe(first.flow.id);
    expect(store.read().ingestionFlows.filter((f) => f.ownerUser === 'u1')).toHaveLength(1);
  });

  it('4. Parent recommendation reflects in-progress child flow', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const initial = service.recommendIntent(intent);
    const scope = initial.requiredActions[0]!.refreshBenefit!.sourceScope;
    const child = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'child-in-prog',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: initial.resultVersion,
      },
    });

    // Parent called again while child is in awaiting_source
    const inProgressRec = service.recommendIntent({
      ...intent,
      childFlowId: child.flow.id,
    });

    expect(inProgressRec.status).toBe('needs_input');
    const refreshAction = inProgressRec.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;
    expect(refreshAction.submission).toEqual({ tool: 'get_ingestion', field: 'flowId' });
    expect(refreshAction.refreshBenefit).toEqual(expect.objectContaining({
      childFlowId: child.flow.id,
      flowStatus: 'awaiting_source',
    }));
    expect(refreshAction.diagnostic?.retryAction).toBe('complete_ingestion');
  });

  it('5. Explicit deliverable status and reasons for failed, cancelled, and needs_review child flows', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const initial = service.recommendIntent(intent);
    const scope = initial.requiredActions[0]!.refreshBenefit!.sourceScope;
    const child = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'child-fail',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: initial.resultVersion,
      },
    });

    // Case 5a: Failed
    service.failIngestion(child.flow.id, 'upstream page 404');
    const failRec = service.recommendIntent({ ...intent, childFlowId: child.flow.id });
    expect(failRec.status).toBe('needs_input');
    const failAction = failRec.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;
    expect(failAction.diagnostic?.code).toBe('flow_failed');
    expect(failAction.diagnostic?.message).toContain('upstream page 404');
    expect(failRec.candidates[0]?.exclusionReasons.some((r) => r.includes('upstream page 404'))).toBe(true);

    // Case 5b: Cancelled
    const child2 = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'child-cancel',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: initial.resultVersion,
      },
    });
    service.cancelIngestion(child2.flow.id, 'cancelled by operator');
    const cancelRec = service.recommendIntent({ ...intent, childFlowId: child2.flow.id });
    const cancelAction = cancelRec.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;
    expect(cancelAction.diagnostic?.code).toBe('flow_cancelled');
    expect(cancelAction.diagnostic?.message).toContain('cancelled by operator');

    // Case 5c: Needs review
    const child3 = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'child-review',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: initial.resultVersion,
      },
    });
    service.flagIngestionReview(child3.flow.id, 'ambiguous clause in term document');
    const reviewRec = service.recommendIntent({ ...intent, childFlowId: child3.flow.id });
    const reviewAction = reviewRec.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;
    expect(reviewAction.diagnostic?.code).toBe('needs_review');
    expect(reviewAction.diagnostic?.message).toContain('ambiguous clause in term document');
  });

  it('6. Full E2E: stale benefit -> child ingestion -> manifest -> leaves -> finalize -> resumed recommendation evaluates and ranks fresh store', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };

    // Step 1: Parent recommendation reveals stale rule
    const parentRec = service.recommendIntent(intent);
    expect(parentRec.status).toBe('needs_input');
    const refreshAction = parentRec.requiredActions.find((a) => a.id === 'freshness:rule-tw-stale')!;

    // Step 2: Create child ingestion
    const child = service.createIngestion({
      sourceScope: refreshAction.refreshBenefit!.sourceScope,
      idempotencyKey: 'e2e-child',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: parentRec.resultVersion,
      },
    });

    // Step 3: Submit source
    const sourced = service.submitIngestionSource({
      flowId: child.flow.id,
      actionId: child.nextAction!.actionId,
      expectedRevision: 1,
      sourceCapture: {
        sourceType: 'official',
        url: 'https://bank.tw/terms',
        retrievedAt: asOf,
        contentHash: 'hash-new-2026',
        artifactRef: 'artifact:tw-bank-2026',
        submitter: 'agent-refresh',
        submittedAt: asOf,
      },
    });

    // Step 4: Submit manifest
    const manifested = service.submitIngestionManifest({
      flowId: child.flow.id,
      actionId: sourced.nextAction!.actionId,
      expectedRevision: 2,
      manifest: [
        {
          id: 'leaf-tw-fresh',
          kind: 'benefit',
          summary: 'Taiwan Card 2026 grocery 4% reward',
          evidenceLocator: 'section:groceries',
          dependsOn: [],
        },
      ],
    });

    // Step 5: Submit benefit leaf
    const leafResult = service.submitBenefitLeaf({
      flowId: child.flow.id,
      actionId: manifested.nextAction!.actionId,
      expectedRevision: 3,
      idempotencyKey: 'leaf-key-1',
      leafId: 'leaf-tw-fresh',
      evidenceRefs: ['section:groceries#clause1'],
      offer: {
        snapshot: {
          id: 'src-tw-fresh-2026',
          url: 'https://bank.tw/terms',
          fetchedAt: asOf,
          contentHash: 'hash-new-2026',
          parserVersion: '1',
          verified: true,
          sourceType: 'official',
        },
        rule: {
          id: 'rule-tw-fresh-2026',
          familyId: 'family-tw-groceries',
          cardId: 'card-tw',
          version: '2',
          sourceSnapshotId: 'src-tw-fresh-2026',
          status: 'candidate',
          validFrom: '2026-01-01T00:00:00Z',
          validTo: '2026-12-31T23:59:59Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 400 },
        },
      },
    });

    // Step 6: Finalize ingestion -> activates fresh rule into canonical store
    const finalizeResult = service.finalizeIngestion({
      flowId: child.flow.id,
      actionId: leafResult.flow.nextAction!.actionId,
      expectedRevision: 4,
    });
    expect(finalizeResult.flow.flow.status).toBe('complete');

    // Step 7: Resumed recommendation evaluates from fresh store
    const resumed = service.recommendIntent({
      ...intent,
      childFlowId: child.flow.id,
    });

    expect(resumed.status).toBe('ready');
    expect(resumed.candidates).toHaveLength(1);
    const candidate = resumed.candidates[0]!;
    expect(candidate.status).toBe('ready');
    // 4% of 100,000 minor units = 4,000
    expect(candidate.reward).toEqual({ amountMinor: 4000, currency: 'TWD' });
    expect(candidate.netSpend).toEqual({ amountMinor: 96000, currency: 'TWD' });
    // No remaining freshness actions
    expect(resumed.requiredActions.filter((a) => a.action === 'REFRESH_BENEFIT')).toHaveLength(0);
  });

  it('7. Relevant state change demands restart; old parentResultVersion cannot be forcibly attached', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const initial = service.recommendIntent(intent);
    const oldVersion = initial.resultVersion;

    // Mutate state by adding a fresh rule
    service.upsertOffer(
      { id: 'src-new', url: 'https://bank.tw/terms', fetchedAt: asOf, contentHash: 'h-new', parserVersion: '1', verified: true },
      {
        id: 'rule-tw-new',
        familyId: 'family-tw-groceries',
        cardId: 'card-tw',
        version: '2',
        sourceSnapshotId: 'src-new',
        status: 'active',
        validFrom: '2026-01-01T00:00:00Z',
        settlementCurrency: 'TWD',
        match: {},
        reward: { kind: 'percentage', rateBps: 500 },
      },
    );

    // Calling recommend with old expectedResultVersion must throw
    expect(() => service.recommendIntent({
      ...intent,
      expectedResultVersion: oldVersion,
    })).toThrowError(/recommendation resultVersion is stale; restart the original intent/);
  });

  it('8. No-change branch: child completion without activating new rule leaves recommendation gracefully handled', () => {
    const store = new MemoryStore();
    const service = new RewardService(store, 'u1');
    setupEnvironment(service);

    const intent = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const initial = service.recommendIntent(intent);
    const scope = initial.requiredActions[0]!.refreshBenefit!.sourceScope;

    const child = service.createIngestion({
      sourceScope: scope,
      idempotencyKey: 'no-change-child',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intent),
        parentResultVersion: initial.resultVersion,
      },
    });

    // Ingestion completes with empty manifest
    const sourced = service.submitIngestionSource({
      flowId: child.flow.id,
      actionId: child.nextAction!.actionId,
      expectedRevision: 1,
      sourceCapture: {
        sourceType: 'official',
        url: 'https://bank.tw/terms',
        retrievedAt: asOf,
        contentHash: 'hash-no-change',
        artifactRef: 'artifact:no-change',
        submitter: 'agent',
        submittedAt: asOf,
      },
    });

    service.registerCard({ id: 'card-other', issuer: 'OtherBank', productName: 'Other Card' });
    const manifested = service.submitIngestionManifest({
      flowId: child.flow.id,
      actionId: sourced.nextAction!.actionId,
      expectedRevision: 2,
      manifest: [
        {
          id: 'leaf-other',
          kind: 'benefit',
          summary: 'Other Card terms',
          evidenceLocator: 'terms:1',
          dependsOn: [],
        },
      ],
    });

    const leafResult = service.submitBenefitLeaf({
      flowId: child.flow.id,
      actionId: manifested.nextAction!.actionId,
      expectedRevision: 3,
      idempotencyKey: 'leaf-other-1',
      leafId: 'leaf-other',
      evidenceRefs: ['terms:1#other'],
      offer: {
        snapshot: {
          id: 'src-other',
          url: 'https://bank.tw/terms',
          fetchedAt: asOf,
          contentHash: 'hash-no-change',
          parserVersion: '1',
          verified: true,
          sourceType: 'official',
        },
        rule: {
          id: 'rule-other',
          familyId: 'family-other',
          cardId: 'card-other',
          version: '1',
          sourceSnapshotId: 'src-other',
          status: 'candidate',
          validFrom: '2026-01-01T00:00:00Z',
          settlementCurrency: 'TWD',
          match: {},
          reward: { kind: 'percentage', rateBps: 200 },
        },
      },
    });

    service.finalizeIngestion({
      flowId: child.flow.id,
      actionId: leafResult.flow.nextAction!.actionId,
      expectedRevision: 4,
    });

    // Resume recommendation
    const resumed = service.recommendIntent({
      ...intent,
      childFlowId: child.flow.id,
    });

    // card-other is ready, while card-tw rule is still stale -> partial status with REFRESH_BENEFIT
    expect(resumed.status).toBe('partial');
    expect(resumed.requiredActions.some((a) => a.action === 'REFRESH_BENEFIT')).toBe(true);
  });

  it('9. Tenant and family guards fail closed', () => {
    const store = new MemoryStore();
    const serviceA = new RewardService(store, 'user-a');
    const serviceB = new RewardService(store, 'user-b');
    setupEnvironment(serviceA);
    setupEnvironment(serviceB);

    const intentA = {
      merchant: '全聯福利中心',
      amount: { amountMinor: 100000, currency: 'TWD' },
      country: 'TW',
      occurredAt: asOf,
    };
    const parentA = serviceA.recommendIntent(intentA);
    const scopeA = parentA.requiredActions[0]!.refreshBenefit!.sourceScope;

    const childA = serviceA.createIngestion({
      sourceScope: scopeA,
      idempotencyKey: 'flow-user-a',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intentA),
        parentResultVersion: parentA.resultVersion,
      },
    });

    // 9a. Cross-tenant continuation linking throws UNAUTHORIZED
    expect(() => serviceB.recommendIntent({
      ...intentA,
      childFlowId: childA.flow.id,
    })).toThrowError(/UNAUTHORIZED/);

    // 9b. Continuation fingerprint mismatch throws INVALID_INPUT
    const differentIntent = {
      ...intentA,
      amount: { amountMinor: 500000, currency: 'TWD' },
    };
    expect(() => serviceA.recommendIntent({
      ...differentIntent,
      childFlowId: childA.flow.id,
    })).toThrowError(/fingerprint/);

    // 9c. Mismatched sourceScope in parentContinuation when creating ingestion throws INVALID_INPUT
    expect(() => serviceA.createIngestion({
      sourceScope: { kind: 'offer_family', value: 'unrelated-family' },
      idempotencyKey: 'mismatch-key',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intentA),
        parentResultVersion: parentA.resultVersion,
        sourceScope: { kind: 'offer_family', value: 'different-family' },
      },
    })).toThrowError(/source scope/);

    // 9d. Mismatched childFlowId in parentContinuation throws INVALID_INPUT
    expect(() => serviceA.createIngestion({
      sourceScope: { kind: 'offer_family', value: 'test-child-id-mismatch' },
      idempotencyKey: 'child-id-mismatch',
      parentContinuation: {
        intentFingerprint: computeIntentFingerprint(intentA),
        parentResultVersion: parentA.resultVersion,
        childFlowId: 'flow_nonexistent_custom_id',
      },
    })).toThrowError(/childFlowId/);
  });
});
