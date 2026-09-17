import * as crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { type LedgerStore, type RecordedTransaction, type StoredState, contentHash } from './store.js';
import { EventRewardLedger, convertMinor, createPaymentEventRewardCandidate, decidePaymentEventRewards, evaluateOffer, evaluatePredicate, matchPaymentEvent, matchPaymentEventChain, matchPaymentRouteSelector, rankCards, resolveCyclePeriodKey } from './evaluator.js';
import type { CardDescriptor, CardSwitchInput, CardSwitchProjection, CardSwitchStatus, CapPeriod, CapPoolDefinition, Diagnostic, EvaluationContext, MerchantIdentity, MerchantResolution, Money, OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, RewardBreakdown, RewardComponentRecord, TransactionTuple, UserBenefitInput, UserBenefitStatus, EvidenceRecord, PaymentRouteRecord, PaymentCapabilityRecord, PaymentAccountRecord, EventRewardLedgerRecord, EventRewardReversalRecord, PaymentPathRequest, PaymentPathRecommendation, PaymentPathCandidate, PaymentPathEvent, EligibilityFact, RewardValuationSnapshot, FxResolutionRequest, FxEvaluationContext, AppliedFxRate, RecommendationIntent, RecommendationIntentResult, IntentCandidate, FxSnapshot, ListTransactionsOptions, ListTransactionsResult, TransactionSummaryItem, TransactionDetailItem, FundingInstrument, TransactionListItem, IngestionFlowRecord, IngestionSourceScope, IngestionDraftTombstone, IngestionBenefitLeafSubmission, IngestionBenefitArtifact, IngestionExclusionArtifact, AppliedExclusion, IngestionCompletionProof, IngestionParentContinuation } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateCapPool, validateConfirmation, validateEligibilityFact, validateMerchant, validateRecommendationTransaction, validateRule, validateSnapshot, validateTransaction, validateEvidence, validateFactCandidate, validatePaymentRouteRecord, validatePaymentCapability, validatePaymentAccountRecord, validateEventRewardInput, validatePaymentEvent, validatePaymentEventChainRule, validatePaymentEventRule, validateRewardValuationSnapshot, validateListTransactionsOptions, validateIngestionSourceScope, validateIngestionSourceCapture, validateIngestionManifest, validateIngestionBenefitLeaf, validateIngestionExclusionLeaf, validateIngestionParentContinuation } from './validation.js';
import { cardSwitchStatus, projectionFromInput } from './card-switch.js';
import { buildFxResolutionRequest, freezeAppliedFxRate, deriveConversionOwner, isFxFresh, isFxCompatible, getFxScopeSpecificity, findBestMatchingFx } from './fx.js';
import { validateRecommendationIntent, validateRecommendationSupplementalFacts } from './validation.js';
import { projectPage } from './projections.js';

export { RewardServiceError } from './errors.js';

export function computeIntentFingerprint(intent: RecommendationIntent): string {
  const normalized = {
    merchant: intent.merchant,
    amount: intent.amount,
    country: intent.country,
    market: intent.market,
    channel: intent.channel,
    paymentMethod: intent.paymentMethod,
    occurredAt: intent.occurredAt,
    cardIds: intent.cardIds,
    routeIds: intent.routeIds,
  };
  return crypto.createHash('sha256').update(JSON.stringify(normalized)).digest('hex').slice(0, 16);
}

export interface RemainingCap { ruleId: string; usageKey: string; remaining: Money; }

type MerchantOnboardingInput = Omit<MerchantIdentity, 'canonicalId'> & { canonicalId?: string };

function nowIso(): string { return new Date().toISOString(); }
function componentId(transactionId: string, ruleId: string, version: string): string {
  return `cmp_${crypto.createHash('sha256').update(`${transactionId}\u0000${ruleId}\u0000${version}`).digest('hex').slice(0, 32)}`;
}
const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function merchantId(): string {
  let time = Date.now();
  let encoded = '';
  for (let i = 0; i < 10; i += 1) { encoded = ULID_ALPHABET[time % 32] + encoded; time = Math.floor(time / 32); }
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 16; i += 1) encoded += ULID_ALPHABET[bytes[i % bytes.length]! % 32];
  return `mch_${encoded}`;
}
function ownedId(prefix: 'ev' | 'fact' | 'route' | 'acct' | 'valuation' | 'fxp' | 'cap'): string {
  let time = Date.now();
  let encoded = '';
  for (let i = 0; i < 10; i += 1) { encoded = ULID_ALPHABET[time % 32] + encoded; time = Math.floor(time / 32); }
  const bytes = crypto.randomBytes(10);
  for (let i = 0; i < 16; i += 1) encoded += ULID_ALPHABET[bytes[i % bytes.length]! % 32];
  return `${prefix}_${encoded}`;
}
function routeId(): string { return ownedId('route'); }
function accountId(): string { return ownedId('acct'); }
function normalizedMerchantKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

function fundingMatches(a: TransactionTuple, b: TransactionTuple): boolean {
  const fA = a.funding ?? (a.cardId ? { kind: 'credit_card' as const, cardId: a.cardId } : undefined);
  const fB = b.funding ?? (b.cardId ? { kind: 'credit_card' as const, cardId: b.cardId } : undefined);
  if (!fA || !fB) return false;
  if (fA.kind !== fB.kind) return false;
  if (fA.kind === 'credit_card') return (fA as { cardId?: string }).cardId === (fB as { cardId?: string }).cardId;
  if (fA.kind === 'account') {
    const accA = fA as { subtype: string; accountId?: string };
    const accB = fB as { subtype: string; accountId?: string };
    return accA.subtype === accB.subtype && accA.accountId === accB.accountId;
  }
  return true; // cash
}

export class RewardService {
  private readonly workflowNow: () => Date;
  private readonly ingestionDraftTtlMs: number;
  private readonly ingestionTombstoneRetentionMs: number;

  constructor(readonly store: LedgerStore, readonly metadataUser: string | undefined, options: { now?: () => Date; ingestionDraftTtlMs?: number; ingestionTombstoneRetentionMs?: number } = {}) {
    this.workflowNow = options.now ?? (() => new Date());
    this.ingestionDraftTtlMs = options.ingestionDraftTtlMs ?? 7 * 24 * 60 * 60 * 1000;
    this.ingestionTombstoneRetentionMs = options.ingestionTombstoneRetentionMs ?? 30 * 24 * 60 * 60 * 1000;
    if (!Number.isSafeInteger(this.ingestionDraftTtlMs) || this.ingestionDraftTtlMs < 1 || !Number.isSafeInteger(this.ingestionTombstoneRetentionMs) || this.ingestionTombstoneRetentionMs < 1) throw new RewardServiceError('INVALID_INPUT', 'ingestion draft retention settings must be positive integers');
    this.sweepExpiredIngestions();
  }

  createIngestion(input: unknown): ReturnType<RewardService['inspectIngestion']> {
    const ownerUser = this.requireIngestionOwner();
    const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : (() => { throw new RewardServiceError('INVALID_INPUT', 'ingestion create input must be an object'); })();
    const sourceScope = validateIngestionSourceScope(item.sourceScope);
    const idempotencyKey = typeof item.idempotencyKey === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(item.idempotencyKey) ? item.idempotencyKey : (() => { throw new RewardServiceError('INVALID_INPUT', 'idempotencyKey must be a valid identifier'); })();
    let parentContinuation: IngestionParentContinuation | undefined;
    if (item.parentContinuation !== undefined) {
      parentContinuation = validateIngestionParentContinuation(item.parentContinuation);
      if (parentContinuation.sourceScope && !this.sameSourceScope(parentContinuation.sourceScope, sourceScope)) {
        throw new RewardServiceError('INVALID_INPUT', 'parent continuation source scope does not match ingestion source scope');
      }
    }
    this.sweepExpiredIngestions();
    const now = this.workflowNow();
    const result = this.store.update((state) => {
      const byKey = state.ingestionFlows.find((flow) => flow.ownerUser === ownerUser && flow.idempotencyKey === idempotencyKey);
      if (byKey && !this.sameSourceScope(byKey.sourceScope, sourceScope)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different ingestion source scope', { code: 'IDEMPOTENCY_CONFLICT', path: 'idempotencyKey', requiredFacts: [], retryAction: 'create_ingestion_with_new_idempotency_key', affectedIds: [byKey.id] });
      if (byKey) {
        if (parentContinuation?.childFlowId && parentContinuation.childFlowId !== byKey.id) {
          throw new RewardServiceError('INVALID_INPUT', 'childFlowId in continuation does not match existing flow');
        }
        if (parentContinuation && !byKey.parentContinuation) {
          byKey.parentContinuation = { ...parentContinuation, childFlowId: byKey.id };
        }
        return;
      }
      const existing = state.ingestionFlows.find((flow) => flow.ownerUser === ownerUser && flow.status !== 'complete' && this.sameSourceScope(flow.sourceScope, sourceScope));
      if (existing) {
        if (parentContinuation?.childFlowId && parentContinuation.childFlowId !== existing.id) {
          throw new RewardServiceError('INVALID_INPUT', 'childFlowId in continuation does not match existing flow');
        }
        if (parentContinuation && !existing.parentContinuation) {
          existing.parentContinuation = { ...parentContinuation, childFlowId: existing.id };
        }
        return;
      }
      const stamp = now.toISOString();
      const flowId = `flow_${crypto.randomUUID().replace(/-/g, '')}`;
      if (parentContinuation?.childFlowId && parentContinuation.childFlowId !== flowId) {
        throw new RewardServiceError('INVALID_INPUT', 'childFlowId in continuation does not match newly created flow');
      }
      state.ingestionFlows.push({
        id: flowId,
        ownerUser,
        sourceScope,
        revision: 1,
        status: 'awaiting_source',
        idempotencyKey,
        createdAt: stamp,
        lastActivityAt: stamp,
        expiresAt: new Date(now.getTime() + this.ingestionDraftTtlMs).toISOString(),
        ...(parentContinuation ? { parentContinuation: { ...parentContinuation, childFlowId: flowId } } : {}),
      });
    });
    const flow = result.ingestionFlows.find((candidate) => candidate.ownerUser === ownerUser && candidate.idempotencyKey === idempotencyKey) ?? result.ingestionFlows.find((candidate) => candidate.ownerUser === ownerUser && candidate.status !== 'complete' && this.sameSourceScope(candidate.sourceScope, sourceScope));
    if (!flow) throw new RewardServiceError('STORE_UNAVAILABLE', 'ingestion flow was not persisted');
    return this.presentIngestion(flow);
  }

  flagIngestionReview(flowId: string, reason = 'ingestion requires review'): IngestionFlowRecord {
    const ownerUser = this.requireIngestionOwner();
    let updated: IngestionFlowRecord | undefined;
    this.store.update((state) => {
      const flow = state.ingestionFlows.find((c) => c.id === flowId && c.ownerUser === ownerUser);
      if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
      if (flow.status === 'complete') throw new RewardServiceError('INVALID_FLOW_ACTION', 'completed flow cannot be marked needs_review');
      flow.status = 'needs_review';
      flow.terminalReason = reason;
      flow.lastActivityAt = this.workflowNow().toISOString();
      updated = flow;
    });
    if (!updated) throw new RewardServiceError('STORE_UNAVAILABLE', 'failed to update flow status');
    return updated;
  }

  failIngestion(flowId: string, reason = 'ingestion failed'): IngestionFlowRecord {
    const ownerUser = this.requireIngestionOwner();
    let updated: IngestionFlowRecord | undefined;
    this.store.update((state) => {
      const flow = state.ingestionFlows.find((c) => c.id === flowId && c.ownerUser === ownerUser);
      if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
      if (flow.status === 'complete') throw new RewardServiceError('INVALID_FLOW_ACTION', 'completed flow cannot be failed');
      flow.status = 'failed';
      flow.terminalReason = reason;
      flow.lastActivityAt = this.workflowNow().toISOString();
      updated = flow;
    });
    if (!updated) throw new RewardServiceError('STORE_UNAVAILABLE', 'failed to update flow status');
    return updated;
  }

  cancelIngestion(flowId: string, reason = 'ingestion cancelled'): IngestionFlowRecord {
    const ownerUser = this.requireIngestionOwner();
    let updated: IngestionFlowRecord | undefined;
    this.store.update((state) => {
      const flow = state.ingestionFlows.find((c) => c.id === flowId && c.ownerUser === ownerUser);
      if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
      if (flow.status === 'complete') throw new RewardServiceError('INVALID_FLOW_ACTION', 'completed flow cannot be cancelled');
      flow.status = 'cancelled';
      flow.terminalReason = reason;
      flow.lastActivityAt = this.workflowNow().toISOString();
      updated = flow;
    });
    if (!updated) throw new RewardServiceError('STORE_UNAVAILABLE', 'failed to update flow status');
    return updated;
  }

  inspectIngestion(flowId: string): { flow: IngestionFlowRecord | Omit<IngestionDraftTombstone, 'retentionExpiresAt'> & { status: 'expired' }; nextAction: { actionId: string; kind: 'SUBMIT_SOURCE' | 'SUBMIT_MANIFEST' | 'PROCESS_LEAF' | 'FINALIZE'; expectedRevision: number; completionCondition: string; leafId?: string } | undefined } {
    const ownerUser = this.requireIngestionOwner();
    if (!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(flowId)) throw new RewardServiceError('INVALID_INPUT', 'flowId is invalid');
    this.sweepExpiredIngestions();
    const state = this.store.read();
    const flow = state.ingestionFlows.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser);
    if (flow) return this.presentIngestion(flow);
    const tombstone = state.ingestionDraftTombstones.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser);
    if (tombstone) return { flow: { id: tombstone.id, ownerUser: tombstone.ownerUser, sourceScope: tombstone.sourceScope, revision: tombstone.revision, createdAt: tombstone.createdAt, expiredAt: tombstone.expiredAt, status: 'expired' }, nextAction: undefined };
    throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
  }

  submitIngestionSource(input: unknown): ReturnType<RewardService['inspectIngestion']> {
    const ownerUser = this.requireIngestionOwner();
    const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : (() => { throw new RewardServiceError('INVALID_INPUT', 'source submission must be an object'); })();
    const flowId = typeof item.flowId === 'string' ? item.flowId : (() => { throw new RewardServiceError('INVALID_INPUT', 'flowId is required'); })();
    const actionId = typeof item.actionId === 'string' ? item.actionId : (() => { throw new RewardServiceError('INVALID_INPUT', 'actionId is required'); })();
    const expectedRevision = typeof item.expectedRevision === 'number' && Number.isSafeInteger(item.expectedRevision) ? item.expectedRevision : (() => { throw new RewardServiceError('INVALID_INPUT', 'expectedRevision is required'); })();
    const capture = validateIngestionSourceCapture(item.sourceCapture);
    this.sweepExpiredIngestions();
    this.store.update((state) => {
      const flow = state.ingestionFlows.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser);
      if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
      if (flow.status === 'awaiting_manifest' && flow.sourceCapture && JSON.stringify(flow.sourceCapture) === JSON.stringify(capture)) return;
      const action = this.presentIngestion(flow).nextAction;
      if (!action || flow.status !== 'awaiting_source') throw new RewardServiceError('INVALID_FLOW_ACTION', 'flow does not accept source submission', { code: 'INVALID_FLOW_ACTION', path: 'actionId', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id] });
      if (expectedRevision !== flow.revision || actionId !== action.actionId) throw new RewardServiceError('STALE_REVISION', 'source submission action is stale', { code: 'STALE_REVISION', path: expectedRevision !== flow.revision ? 'expectedRevision' : 'actionId', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id] });
      if (!this.captureMatchesScope(capture, flow.sourceScope)) throw new RewardServiceError('SOURCE_SCOPE_CONFLICT', 'source capture does not match the flow source scope', { code: 'SOURCE_SCOPE_CONFLICT', path: 'sourceCapture.url', requiredFacts: ['sourceScope-compatible identity'], retryAction: 'submit_ingestion_source', affectedIds: [flow.id] });
      flow.sourceCapture = capture;
      flow.status = 'awaiting_manifest';
      flow.revision += 1;
      flow.lastActivityAt = this.workflowNow().toISOString();
    });
    return this.inspectIngestion(flowId);
  }

  submitIngestionManifest(input: unknown): ReturnType<RewardService['inspectIngestion']> {
    const ownerUser = this.requireIngestionOwner(); const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : (() => { throw new RewardServiceError('INVALID_INPUT', 'manifest submission must be an object'); })();
    const flowId = typeof item.flowId === 'string' ? item.flowId : (() => { throw new RewardServiceError('INVALID_INPUT', 'flowId is required'); })(); const actionId = typeof item.actionId === 'string' ? item.actionId : (() => { throw new RewardServiceError('INVALID_INPUT', 'actionId is required'); })(); const expectedRevision = typeof item.expectedRevision === 'number' && Number.isSafeInteger(item.expectedRevision) ? item.expectedRevision : (() => { throw new RewardServiceError('INVALID_INPUT', 'expectedRevision is required'); })(); const manifest = validateIngestionManifest(item.manifest);
    this.store.update((state) => { const flow = state.ingestionFlows.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser); if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`); const action = this.presentIngestion(flow).nextAction; if (!action || action.kind !== 'SUBMIT_MANIFEST') throw new RewardServiceError('INVALID_FLOW_ACTION', 'flow does not accept a manifest', { code: 'INVALID_FLOW_ACTION', path: 'actionId', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id] }); if (actionId !== action.actionId || expectedRevision !== flow.revision) throw new RewardServiceError('STALE_REVISION', 'manifest submission action is stale', { code: 'STALE_REVISION', path: actionId !== action.actionId ? 'actionId' : 'expectedRevision', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id] }); flow.manifest = manifest; flow.manifestRevision = 1; flow.manifestHistory = []; flow.manifestCorrectionKeys = []; flow.status = 'processing_leaves'; flow.revision += 1; flow.lastActivityAt = this.workflowNow().toISOString(); });
    return this.inspectIngestion(flowId);
  }

  correctIngestionManifest(input: unknown): ReturnType<RewardService['inspectIngestion']> {
    const ownerUser = this.requireIngestionOwner(); const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : (() => { throw new RewardServiceError('INVALID_INPUT', 'manifest correction must be an object'); })();
    const flowId = typeof item.flowId === 'string' ? item.flowId : (() => { throw new RewardServiceError('INVALID_INPUT', 'flowId is required'); })(); const actionId = typeof item.actionId === 'string' ? item.actionId : (() => { throw new RewardServiceError('INVALID_INPUT', 'actionId is required'); })(); const expectedRevision = typeof item.expectedRevision === 'number' && Number.isSafeInteger(item.expectedRevision) ? item.expectedRevision : (() => { throw new RewardServiceError('INVALID_INPUT', 'expectedRevision is required'); })(); const idempotencyKey = typeof item.idempotencyKey === 'string' ? item.idempotencyKey : (() => { throw new RewardServiceError('INVALID_INPUT', 'idempotencyKey is required'); })(); const manifest = validateIngestionManifest(item.manifest); const payloadHash = contentHash(JSON.stringify(manifest));
    this.store.update((state) => { const flow = state.ingestionFlows.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser); if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`); if (flow.status === 'complete' || flow.status === 'expired' || flow.manifest === undefined) throw new RewardServiceError('INVALID_FLOW_ACTION', 'manifest correction is not available for this flow'); const action = this.manifestCorrectionAction(flow); if (actionId !== action.actionId || expectedRevision !== flow.revision) throw new RewardServiceError('STALE_REVISION', 'manifest correction action is stale'); const prior = (flow.manifestCorrectionKeys ?? []).find((entry) => entry.idempotencyKey === idempotencyKey); if (prior) { if (prior.payloadHash !== payloadHash) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'manifest correction idempotency key belongs to a different payload'); return; } if ((flow.manifest ?? []).some((leaf) => leaf.disposition !== undefined) || (flow.benefitArtifacts?.length ?? 0) > 0 || (flow.exclusionArtifacts?.length ?? 0) > 0) throw new RewardServiceError('INVALID_FLOW_ACTION', 'manifest correction must precede leaf processing'); const previousRevision = flow.manifestRevision ?? 1; flow.manifestHistory = [...(flow.manifestHistory ?? []), { revision: previousRevision, manifest: flow.manifest, supersededByRevision: previousRevision + 1 }]; flow.manifest = manifest; flow.manifestRevision = previousRevision + 1; flow.manifestCorrectionKeys = [...(flow.manifestCorrectionKeys ?? []), { idempotencyKey, payloadHash, revision: flow.manifestRevision }]; flow.revision += 1; flow.lastActivityAt = this.workflowNow().toISOString(); });
    return this.inspectIngestion(flowId);
  }

  submitBenefitLeaf(input: unknown): { artifact?: IngestionBenefitArtifact; flow: ReturnType<RewardService['inspectIngestion']> } {
    const ownerUser = this.requireIngestionOwner();
    const parsed = validateIngestionBenefitLeaf(input);
    this.sweepExpiredIngestions();
    const before = this.store.read();
    const flow = before.ingestionFlows.find((candidate) => candidate.id === parsed.flowId && candidate.ownerUser === ownerUser);
    if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${parsed.flowId} not found`);
    const existing = flow.benefitArtifacts?.find((artifact) => artifact.idempotencyKey === parsed.idempotencyKey);
    const payloadHash = contentHash(JSON.stringify(parsed));
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'benefit leaf idempotencyKey already belongs to a different payload', { code: 'IDEMPOTENCY_CONFLICT', path: 'idempotencyKey', requiredFacts: [], retryAction: 'submit_benefit_leaf_with_new_idempotency_key', affectedIds: [existing.id] });
      return { artifact: existing, flow: this.inspectIngestion(flow.id) };
    }
    const action = this.presentIngestion(flow).nextAction;
    const leaf = flow.manifest?.find((candidate) => candidate.id === parsed.leafId);
    if (!action || action.kind !== 'PROCESS_LEAF' || action.leafId !== parsed.leafId) throw new RewardServiceError('INVALID_FLOW_ACTION', 'benefit leaf is not the server-owned next action', { code: 'INVALID_FLOW_ACTION', path: 'leafId', requiredFacts: ['get_ingestion.nextAction.leafId'], retryAction: 'get_ingestion', affectedIds: [flow.id] });
    if (!leaf || leaf.kind !== 'benefit' || leaf.disposition !== undefined) throw new RewardServiceError('INVALID_INPUT', 'leafId must identify a pending benefit leaf');
    if (parsed.expectedRevision !== flow.revision || parsed.actionId !== action.actionId) throw new RewardServiceError('STALE_REVISION', 'benefit leaf action is stale', { code: 'STALE_REVISION', path: parsed.expectedRevision !== flow.revision ? 'expectedRevision' : 'actionId', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id, leaf.id] });
    if (parsed.disposition !== 'materialized') {
      this.store.update((state) => {
        const current = state.ingestionFlows.find((candidate) => candidate.id === flow.id && candidate.ownerUser === ownerUser);
        if (!current || current.revision !== parsed.expectedRevision) throw new RewardServiceError('STALE_REVISION', 'benefit leaf changed while recording disposition');
        const currentLeaf = current.manifest?.find((candidate) => candidate.id === parsed.leafId);
        if (!currentLeaf || currentLeaf.disposition !== undefined) throw new RewardServiceError('INVALID_FLOW_ACTION', 'benefit leaf was already processed');
        if (current.manifest) current.manifest = current.manifest.map((candidate) => candidate.id === parsed.leafId ? { ...candidate, disposition: parsed.disposition!, dispositionReason: parsed.reason!, dispositionEvidence: parsed.evidenceRefs[0]! } : candidate);
        current.revision += 1;
        current.status = current.manifest?.every((candidate) => candidate.disposition !== undefined) ? 'ready_to_finalize' : 'processing_leaves';
        current.lastActivityAt = this.workflowNow().toISOString();
      });
      return { flow: this.inspectIngestion(flow.id) };
    }
    const offer = parsed.offer;
    if (!offer) throw new RewardServiceError('INVALID_INPUT', 'materialized benefit requires offer');
    if (!flow.sourceCapture || offer.snapshot.contentHash !== flow.sourceCapture.contentHash || (flow.sourceCapture.url !== undefined && offer.snapshot.url !== flow.sourceCapture.url)) throw new RewardServiceError('SOURCE_SCOPE_CONFLICT', 'benefit offer snapshot does not match the captured source', { code: 'SOURCE_SCOPE_CONFLICT', path: 'offer.snapshot', requiredFacts: ['source capture contentHash and URL'], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId] });
    if (offer.rule.status !== 'candidate') throw new RewardServiceError('INVALID_OFFER', 'benefit leaf materialization must create a candidate rule');
    if (!['percentage', 'flat', 'step', 'per_unit'].includes(offer.rule.reward.kind)) throw new RewardServiceError('NEEDS_REVIEW', `benefit leaf uses unsupported reward semantics: ${offer.rule.reward.kind}`, { code: 'UNSUPPORTED_REWARD_UNIT', path: 'offer.rule.reward.kind', requiredFacts: ['a supported reward kind or an authoritative valuation/adapter for this reward unit'], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId] });
    let materializedRule = offer.rule;
    let merchant = offer.merchant;
    if (parsed.merchantRefs?.length) {
      const resolvedIds: string[] = [];
      for (const [index, reference] of parsed.merchantRefs.entries()) {
        const resolution = this.resolveMerchant(reference.canonicalId ?? reference.rawQuery, { ...(reference.country === undefined ? {} : { country: reference.country }), ...(reference.market === undefined ? {} : { market: reference.market }), ...(reference.mcc === undefined ? {} : { mcc: reference.mcc }), ...(reference.channel === undefined ? {} : { channel: reference.channel }) });
        if (resolution.resolutionStatus === 'confirmed') { resolvedIds.push(resolution.merchant!.canonicalId); continue; }
        if (resolution.resolutionStatus === 'ambiguous') throw new RewardServiceError('NEEDS_REVIEW', 'benefit leaf merchant reference is ambiguous; choose one returned candidate', { code: 'MERCHANT_AMBIGUOUS', path: `merchantRefs[${index}]`, requiredFacts: resolution.requiredFacts ?? ['one canonical merchant candidate'], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId, ...resolution.boundedCandidates.map((candidate) => candidate.canonicalId)], merchantResolution: { rawQuery: reference.rawQuery, status: resolution.resolutionStatus, candidates: resolution.boundedCandidates } });
        if (!reference.candidate) throw new RewardServiceError('NEEDS_REVIEW', 'benefit leaf merchant is not in the MCP catalog; provide the source-backed candidate merchant', { code: 'MERCHANT_UNRESOLVED', path: `merchantRefs[${index}]`, requiredFacts: ['source-backed merchant candidate'], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId], merchantResolution: { rawQuery: reference.rawQuery, status: resolution.resolutionStatus, candidates: [] } });
        merchant = { ...reference.candidate, status: 'candidate' };
      }
      if (resolvedIds.length) materializedRule = { ...materializedRule, match: { ...materializedRule.match, merchants: resolvedIds } };
      else materializedRule = { ...materializedRule, match: { ...materializedRule.match, merchants: [] } };
    }
    const knownMerchants = new Set(before.merchants.map((candidate) => candidate.canonicalId));
    const unresolvedMerchant = merchant === undefined ? materializedRule.match.merchants?.find((id) => !knownMerchants.has(id)) : undefined;
    if (unresolvedMerchant !== undefined) throw new RewardServiceError('NEEDS_REVIEW', 'benefit leaf references an unresolved canonical merchant', { code: 'MERCHANT_UNRESOLVED', path: 'offer.rule.match.merchants', requiredFacts: [`confirmed canonical merchant ${unresolvedMerchant}`], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId, unresolvedMerchant], merchantResolution: { rawQuery: unresolvedMerchant, status: 'unresolved', candidates: [] } });
    const knownPools = new Set([...before.capPools, ...(offer.capPools ?? [])].map((pool) => pool.id));
    const unresolvedPool = offer.rule.capPoolRefs?.find((id) => !knownPools.has(id));
    if (unresolvedPool !== undefined) throw new RewardServiceError('NEEDS_REVIEW', 'benefit leaf references an unresolved cap pool', { code: 'NEEDS_REVIEW', path: 'offer.rule.capPoolRefs', requiredFacts: [`validated cap pool ${unresolvedPool}`], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId, unresolvedPool] });
    if (offer.rule.routeId !== undefined && !before.paymentRoutes.some((route) => route.id === offer.rule.routeId)) throw new RewardServiceError('NEEDS_REVIEW', 'benefit leaf references an unresolved payment route', { code: 'NEEDS_REVIEW', path: 'offer.rule.routeId', requiredFacts: [`validated payment route ${offer.rule.routeId}`], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, parsed.leafId, offer.rule.routeId] });
    const sharedExclusions = this.appliedSharedExclusions(flow, leaf.id);
    if (parsed.localExclusions?.some((local) => sharedExclusions.some((shared) => isDeepStrictEqual(local.predicate, shared.predicate)))) throw new RewardServiceError('NEEDS_REVIEW', 'local and shared exclusion duplicate each other', { code: 'EXCLUSION_SCOPE_CONFLICT', path: 'localExclusions', requiredFacts: ['one non-overlapping exclusion scope'], retryAction: 'submit_benefit_leaf', affectedIds: [flow.id, leaf.id, ...sharedExclusions.map((shared) => shared.sourceLeafId)] });
    if (sharedExclusions.length) materializedRule = { ...materializedRule, sharedExclusions };
    const result = this.upsertOffer(offer.snapshot, materializedRule, undefined, offer.capPools, merchant);
    const artifact: IngestionBenefitArtifact = { id: `artifact_${crypto.randomUUID().replace(/-/g, '')}`, flowId: flow.id, revision: flow.revision, leafId: leaf.id, ruleId: result.rule.id, ruleVersion: result.rule.version, snapshotId: result.snapshot.id, evidenceRefs: parsed.evidenceRefs, localExclusions: parsed.localExclusions ?? [], idempotencyKey: parsed.idempotencyKey, payloadHash, status: 'candidate' };
    this.store.update((state) => {
      const current = state.ingestionFlows.find((candidate) => candidate.id === flow.id && candidate.ownerUser === ownerUser);
      if (!current || current.revision !== parsed.expectedRevision) throw new RewardServiceError('STALE_REVISION', 'benefit leaf changed while materializing');
      const currentLeaf = current.manifest?.find((candidate) => candidate.id === parsed.leafId);
      if (!currentLeaf || currentLeaf.disposition !== undefined) throw new RewardServiceError('INVALID_FLOW_ACTION', 'benefit leaf was already processed');
      if (current.manifest) current.manifest = current.manifest.map((candidate) => candidate.id === parsed.leafId ? { ...candidate, disposition: 'materialized' as const } : candidate);
      current.benefitArtifacts = [...(current.benefitArtifacts ?? []), artifact];
      current.revision += 1;
      current.status = current.manifest?.every((candidate) => candidate.disposition !== undefined) ? 'ready_to_finalize' : 'processing_leaves';
      current.lastActivityAt = this.workflowNow().toISOString();
    });
    return { artifact, flow: this.inspectIngestion(flow.id) };
  }

  submitExclusionLeaf(input: unknown): { artifact?: IngestionExclusionArtifact; flow: ReturnType<RewardService['inspectIngestion']> } {
    const ownerUser = this.requireIngestionOwner();
    const parsed = validateIngestionExclusionLeaf(input);
    const disposition = parsed.disposition ?? 'materialized';
    this.sweepExpiredIngestions();
    const before = this.store.read();
    const flow = before.ingestionFlows.find((candidate) => candidate.id === parsed.flowId && candidate.ownerUser === ownerUser);
    if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${parsed.flowId} not found`);
    const payloadHash = contentHash(JSON.stringify(parsed));
    const existing = flow.exclusionArtifacts?.find((artifact) => artifact.idempotencyKey === parsed.idempotencyKey);
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'exclusion leaf idempotencyKey already belongs to a different payload', { code: 'IDEMPOTENCY_CONFLICT', path: 'idempotencyKey', requiredFacts: [], retryAction: 'submit_exclusion_leaf_with_new_idempotency_key', affectedIds: [existing.id] });
      return { artifact: existing, flow: this.inspectIngestion(flow.id) };
    }
    const action = this.presentIngestion(flow).nextAction;
    const leaf = flow.manifest?.find((candidate) => candidate.id === parsed.leafId);
    if (!action || action.kind !== 'PROCESS_LEAF' || action.leafId !== parsed.leafId || !leaf || leaf.kind !== 'exclusion' || leaf.disposition !== undefined) throw new RewardServiceError('INVALID_FLOW_ACTION', 'exclusion leaf is not the server-owned next action', { code: 'INVALID_FLOW_ACTION', path: 'leafId', requiredFacts: ['get_ingestion.nextAction.leafId'], retryAction: 'get_ingestion', affectedIds: [flow.id] });
    if (parsed.expectedRevision !== flow.revision || parsed.actionId !== action.actionId) throw new RewardServiceError('STALE_REVISION', 'exclusion leaf action is stale', { code: 'STALE_REVISION', path: parsed.expectedRevision !== flow.revision ? 'expectedRevision' : 'actionId', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id, leaf.id] });
    // An ignored exclusion is retained as an audit decision but does not apply
    // to benefits, so it must not require dependency coverage for every target.
    if (disposition === 'materialized') this.assertExclusionScope(flow, leaf.id, parsed.scope);
    const artifact = disposition === 'materialized' ? { id: `artifact_${crypto.randomUUID().replace(/-/g, '')}`, revision: flow.revision, sourceLeafId: leaf.id, sourceFlowId: flow.id, target: parsed.target, scope: parsed.scope, predicate: parsed.predicate, evidenceRefs: parsed.evidenceRefs, idempotencyKey: parsed.idempotencyKey, payloadHash, status: 'candidate' as const } : undefined;
    this.store.update((state) => {
      const current = state.ingestionFlows.find((candidate) => candidate.id === flow.id && candidate.ownerUser === ownerUser);
      if (!current || current.revision !== parsed.expectedRevision) throw new RewardServiceError('STALE_REVISION', 'exclusion leaf changed while materializing');
      if (current.manifest) current.manifest = current.manifest.map((candidate) => candidate.id === leaf.id ? { ...candidate, disposition, ...(parsed.reason === undefined ? {} : { dispositionReason: parsed.reason, dispositionEvidence: parsed.evidenceRefs[0]! }) } : candidate);
      if (artifact) current.exclusionArtifacts = [...(current.exclusionArtifacts ?? []), artifact];
      current.revision += 1;
      current.status = current.manifest?.every((candidate) => candidate.disposition !== undefined) ? 'ready_to_finalize' : 'processing_leaves';
      current.lastActivityAt = this.workflowNow().toISOString();
    });
    return { ...(artifact === undefined ? {} : { artifact }), flow: this.inspectIngestion(flow.id) };
  }

  finalizeIngestion(input: unknown): { proof: IngestionCompletionProof; flow: ReturnType<RewardService['inspectIngestion']> } {
    const ownerUser = this.requireIngestionOwner();
    const item = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : (() => { throw new RewardServiceError('INVALID_INPUT', 'finalize input must be an object'); })();
    const flowId = typeof item.flowId === 'string' ? item.flowId : (() => { throw new RewardServiceError('INVALID_INPUT', 'flowId is required'); })();
    const actionId = typeof item.actionId === 'string' ? item.actionId : (() => { throw new RewardServiceError('INVALID_INPUT', 'actionId is required'); })();
    const expectedRevision = typeof item.expectedRevision === 'number' && Number.isSafeInteger(item.expectedRevision) ? item.expectedRevision : (() => { throw new RewardServiceError('INVALID_INPUT', 'expectedRevision is required'); })();
    this.sweepExpiredIngestions();
    let proof: IngestionCompletionProof | undefined;
    this.store.update((state) => {
      const flow = state.ingestionFlows.find((candidate) => candidate.id === flowId && candidate.ownerUser === ownerUser);
      if (!flow) throw new RewardServiceError('FLOW_NOT_FOUND', `ingestion flow ${flowId} not found`);
      if (flow.status === 'complete' && flow.completionProof) {
        if (actionId === flow.completionProof.finalizeActionId && expectedRevision === flow.completionProof.finalizedRevision) { proof = flow.completionProof; return; }
        throw new RewardServiceError('STALE_REVISION', 'completed flow only accepts an exact finalize retry', { code: 'STALE_REVISION', path: actionId !== flow.completionProof.finalizeActionId ? 'actionId' : 'expectedRevision', requiredFacts: [], retryAction: 'create_ingestion', affectedIds: [flow.id] });
      }
      const action = this.presentIngestion(flow).nextAction;
      if (!action || action.kind !== 'FINALIZE') throw new RewardServiceError('INVALID_FLOW_ACTION', 'flow is not ready to finalize', { code: 'INVALID_FLOW_ACTION', path: 'actionId', requiredFacts: ['a complete and materialized manifest'], retryAction: 'get_ingestion', affectedIds: [flow.id] });
      if (actionId !== action.actionId || expectedRevision !== flow.revision) throw new RewardServiceError('STALE_REVISION', 'finalize action is stale', { code: 'STALE_REVISION', path: actionId !== action.actionId ? 'actionId' : 'expectedRevision', requiredFacts: [], retryAction: 'get_ingestion', affectedIds: [flow.id] });
      this.assertFinalizeReady(state, flow);
      const activatedRules: Array<{ ruleId: string; ruleVersion: string }> = [];
      const awaitingConfirmationRules: Array<{ ruleId: string; ruleVersion: string; reason: string }> = [];
      for (const artifact of flow.benefitArtifacts ?? []) {
        const ruleIndex = state.rules.findIndex((rule) => rule.id === artifact.ruleId && rule.version === artifact.ruleVersion);
        const rule = state.rules[ruleIndex]!;
        const snapshot = state.snapshots.find((candidate) => candidate.id === artifact.snapshotId)!;
        const activationReason = this.activationHoldReason(state, rule, snapshot);
        if (activationReason) { awaitingConfirmationRules.push({ ruleId: rule.id, ruleVersion: rule.version, reason: activationReason }); continue; }
        if (rule.supersedesRuleId) {
          const predecessor = state.rules.find((candidate) => candidate.id === rule.supersedesRuleId);
          if (
            !predecessor ||
            predecessor.status !== 'active' ||
            predecessor.cardId !== rule.cardId ||
            predecessor.componentKind !== rule.componentKind ||
            (predecessor.ownerUser ?? undefined) !== (rule.ownerUser ?? undefined)
          ) {
            throw new RewardServiceError('NEEDS_REVIEW', 'superseded active rule is missing, card mismatched, or no longer active', {
              code: 'RULE_CONFLICT',
              path: 'rule.supersedesRuleId',
              requiredFacts: ['an active predecessor rule on the same card and tenant'],
              retryAction: 'get_ingestion',
              affectedIds: [flow.id, rule.id, rule.supersedesRuleId],
            });
          }
          predecessor.status = 'superseded';
        }
        state.rules[ruleIndex] = { ...rule, status: 'active', trustBasis: 'official_verified' };
        activatedRules.push({ ruleId: rule.id, ruleVersion: rule.version });
      }
      const leaves = (flow.manifest ?? []).map((leaf) => ({ id: leaf.id, kind: leaf.kind, disposition: leaf.disposition!, ...(leaf.dispositionReason === undefined ? {} : { reason: leaf.dispositionReason }), evidenceLocator: leaf.evidenceLocator, evidenceRefs: leaf.kind === 'benefit' ? flow.benefitArtifacts?.find((artifact) => artifact.leafId === leaf.id)?.evidenceRefs ?? (leaf.dispositionEvidence === undefined ? [] : [leaf.dispositionEvidence]) : flow.exclusionArtifacts?.find((artifact) => artifact.sourceLeafId === leaf.id)?.evidenceRefs ?? (leaf.dispositionEvidence === undefined ? [] : [leaf.dispositionEvidence]) }));
      proof = { flowId: flow.id, finalizeActionId: actionId, finalizedRevision: flow.revision, completedAt: this.workflowNow().toISOString(), sourceCapture: { artifactRef: flow.sourceCapture!.artifactRef, contentHash: flow.sourceCapture!.contentHash, retrievedAt: flow.sourceCapture!.retrievedAt, sourceType: flow.sourceCapture!.sourceType }, leafTotals: { total: leaves.length, materialized: leaves.filter((leaf) => leaf.disposition === 'materialized').length, ignored: leaves.filter((leaf) => leaf.disposition === 'ignored').length, superseded: leaves.filter((leaf) => leaf.disposition === 'superseded').length }, leaves, activatedRules, awaitingConfirmationRules };
      flow.completionProof = proof;
      flow.status = 'complete';
      flow.revision += 1;
      flow.lastActivityAt = this.workflowNow().toISOString();
    });
    if (!proof) throw new RewardServiceError('STORE_UNAVAILABLE', 'finalization did not persist a completion proof');
    return { proof, flow: this.inspectIngestion(flowId) };
  }

  sweepExpiredIngestions(): { expired: number; purgedTombstones: number } {
    const now = this.workflowNow();
    let expired = 0;
    let purgedTombstones = 0;
    this.store.update((state) => {
      const retained: IngestionFlowRecord[] = [];
      for (const flow of state.ingestionFlows) {
        if (flow.status === 'complete' || Date.parse(flow.expiresAt) > now.getTime()) { retained.push(flow); continue; }
        expired += 1;
        state.ingestionDraftTombstones.push({ id: flow.id, ownerUser: flow.ownerUser, sourceScope: flow.sourceScope, revision: flow.revision, createdAt: flow.createdAt, expiredAt: now.toISOString(), retentionExpiresAt: new Date(now.getTime() + this.ingestionTombstoneRetentionMs).toISOString() });
      }
      state.ingestionFlows = retained;
      const before = state.ingestionDraftTombstones.length;
      state.ingestionDraftTombstones = state.ingestionDraftTombstones.filter((tombstone) => Date.parse(tombstone.retentionExpiresAt) > now.getTime());
      purgedTombstones = before - state.ingestionDraftTombstones.length;
    });
    return { expired, purgedTombstones };
  }

  private requireIngestionOwner(): string {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'ingestion flows require an authenticated user');
    return this.metadataUser;
  }

  private sameSourceScope(a: IngestionSourceScope, b: IngestionSourceScope): boolean { return a.kind === b.kind && a.value === b.value; }

  getRuleSourceScope(state: StoredState, rule: OfferRuleVersion, cardId: string): IngestionSourceScope {
    const snapshot = state.snapshots.find((s) => s.id === rule.sourceSnapshotId);
    if (snapshot?.url && /^https:\/\//i.test(snapshot.url)) {
      try {
        const parsed = new URL(snapshot.url);
        const urlPart = snapshot.url.split('#')[0];
        if (urlPart) return { kind: 'official_url', value: urlPart };
      } catch {
        // ignore invalid URL
      }
    }
    const rawFamily = rule.familyId || `card-${cardId}`;
    const normalizedFamily = rawFamily.toLowerCase().replace(/[^a-z0-9_:-]/g, '-');
    return { kind: 'offer_family', value: normalizedFamily };
  }

  collectRecommendationSourceScopes(state: StoredState): IngestionSourceScope[] {
    const scopes: IngestionSourceScope[] = [];
    for (const card of state.cards) {
      const cardRules = state.rules.filter((r) => r.cardId === card.id && (r.ownerUser === this.metadataUser || r.ownerUser === undefined));
      for (const rule of cardRules) {
        const scope = this.getRuleSourceScope(state, rule, card.id);
        if (!scopes.some((s) => this.sameSourceScope(s, scope))) {
          scopes.push(scope);
        }
      }
      const defaultCardScope: IngestionSourceScope = { kind: 'offer_family', value: `card-${card.id}`.toLowerCase().replace(/[^a-z0-9_:-]/g, '-') };
      if (!scopes.some((s) => this.sameSourceScope(s, defaultCardScope))) {
        scopes.push(defaultCardScope);
      }
    }
    return scopes;
  }

  private captureMatchesScope(capture: NonNullable<IngestionFlowRecord['sourceCapture']>, scope: IngestionSourceScope): boolean {
    if (scope.kind === 'official_url') return capture.sourceType === 'official' && capture.url === scope.value;
    return capture.sourceType === 'user_input' || capture.sourceType === 'official';
  }

  private dependencyClosure(flow: IngestionFlowRecord, leafId: string): readonly string[] {
    const manifest = new Map((flow.manifest ?? []).map((leaf) => [leaf.id, leaf]));
    const seen = new Set<string>();
    const visit = (id: string): void => { for (const dependency of manifest.get(id)?.dependsOn ?? []) if (!seen.has(dependency)) { seen.add(dependency); visit(dependency); } };
    visit(leafId);
    return [...seen];
  }

  private assertExclusionScope(flow: IngestionFlowRecord, exclusionLeafId: string, scope: { kind: 'all_benefits' | 'benefit_ids'; benefitIds?: readonly string[] }): void {
    const benefits = (flow.manifest ?? []).filter((leaf) => leaf.kind === 'benefit');
    const targets = scope.kind === 'all_benefits' ? benefits.map((leaf) => leaf.id) : [...(scope.benefitIds ?? [])];
    if (!targets.length || targets.some((id) => !benefits.some((leaf) => leaf.id === id))) throw new RewardServiceError('NEEDS_REVIEW', 'exclusion scope identifies an unknown or ambiguous benefit', { code: 'EXCLUSION_SCOPE_AMBIGUOUS', path: 'scope.benefitIds', requiredFacts: ['existing benefit leaf IDs'], retryAction: 'submit_exclusion_leaf', affectedIds: [flow.id, exclusionLeafId, ...targets] });
    const uncovered = targets.filter((id) => !this.dependencyClosure(flow, id).includes(exclusionLeafId));
    if (uncovered.length) throw new RewardServiceError('NEEDS_REVIEW', 'every scoped benefit must depend on its shared exclusion', { code: 'EXCLUSION_SCOPE_AMBIGUOUS', path: 'scope', requiredFacts: ['manifest dependency from each scoped benefit to the exclusion leaf'], retryAction: 'submit_ingestion_manifest', affectedIds: [flow.id, exclusionLeafId, ...uncovered] });
  }

  private appliedSharedExclusions(flow: IngestionFlowRecord, benefitLeafId: string): readonly AppliedExclusion[] {
    const dependencies = new Set(this.dependencyClosure(flow, benefitLeafId));
    const exclusions = (flow.exclusionArtifacts ?? []).filter((artifact) => dependencies.has(artifact.sourceLeafId) && (artifact.scope.kind === 'all_benefits' || artifact.scope.benefitIds?.includes(benefitLeafId)));
    const unresolved = [...dependencies].filter((id) => flow.manifest?.find((leaf) => leaf.id === id)?.kind === 'exclusion' && !exclusions.some((artifact) => artifact.sourceLeafId === id));
    if (unresolved.length) throw new RewardServiceError('NEEDS_REVIEW', 'benefit depends on an unresolved or ignored exclusion', { code: 'EXCLUSION_UNRESOLVED', path: 'manifest.dependsOn', requiredFacts: ['materialized shared exclusion'], retryAction: 'submit_exclusion_leaf', affectedIds: [flow.id, benefitLeafId, ...unresolved] });
    return exclusions.map(({ sourceLeafId, sourceFlowId, target, predicate, evidenceRefs }) => ({ sourceLeafId, sourceFlowId, target, predicate, evidenceRefs }));
  }

  private assertFinalizeReady(state: StoredState, flow: IngestionFlowRecord): void {
    if (!flow.sourceCapture || !flow.manifest?.length || flow.manifest.some((leaf) => leaf.disposition === undefined)) throw new RewardServiceError('INVALID_FLOW_ACTION', 'finalization requires a source capture and a full manifest disposition');
    if (flow.manifest.some((leaf) => leaf.disposition !== 'materialized' && (!leaf.dispositionReason || !leaf.dispositionEvidence))) throw new RewardServiceError('NEEDS_REVIEW', 'non-materialized leaf disposition requires reason and evidence', { code: 'MANIFEST_INCOMPLETE', path: 'manifest', requiredFacts: ['reason and evidence for ignored or superseded leaves'], retryAction: 'get_ingestion', affectedIds: [flow.id] });
    for (const leaf of flow.manifest) {
      if (leaf.kind === 'benefit' && leaf.disposition === 'materialized' && !(flow.benefitArtifacts ?? []).some((artifact) => artifact.leafId === leaf.id)) throw new RewardServiceError('NEEDS_REVIEW', 'materialized benefit has no candidate artifact', { code: 'MANIFEST_INCOMPLETE', path: 'manifest', requiredFacts: ['candidate benefit artifact'], retryAction: 'get_ingestion', affectedIds: [flow.id, leaf.id] });
      if (leaf.kind === 'exclusion' && leaf.disposition === 'materialized' && !(flow.exclusionArtifacts ?? []).some((artifact) => artifact.sourceLeafId === leaf.id)) throw new RewardServiceError('NEEDS_REVIEW', 'materialized exclusion has no candidate artifact', { code: 'MANIFEST_INCOMPLETE', path: 'manifest', requiredFacts: ['candidate exclusion artifact'], retryAction: 'get_ingestion', affectedIds: [flow.id, leaf.id] });
    }
    for (const artifact of flow.benefitArtifacts ?? []) {
      const rule = state.rules.find((candidate) => candidate.id === artifact.ruleId && candidate.version === artifact.ruleVersion);
      const snapshot = state.snapshots.find((candidate) => candidate.id === artifact.snapshotId);
      if (!rule || !snapshot || rule.status !== 'candidate' || rule.sourceSnapshotId !== snapshot.id || snapshot.contentHash !== flow.sourceCapture.contentHash || (flow.sourceCapture.url !== undefined && snapshot.url !== flow.sourceCapture.url)) throw new RewardServiceError('NEEDS_REVIEW', 'candidate offer no longer matches its immutable source capture', { code: 'SOURCE_STALE', path: 'benefitArtifacts', requiredFacts: ['candidate rule and immutable source snapshot matching the flow capture'], retryAction: 'get_ingestion', affectedIds: [flow.id, artifact.ruleId, artifact.snapshotId] });
      validateRule(rule); validateSnapshot(snapshot);
      const nowMs = this.workflowNow().getTime();
      if (snapshot.validTo !== undefined && Date.parse(snapshot.validTo) < nowMs) {
        throw new RewardServiceError('NEEDS_REVIEW', 'candidate offer source snapshot is expired', { code: 'SOURCE_STALE', path: 'snapshot.validTo', requiredFacts: ['active, unexpired source snapshot'], retryAction: 'create_ingestion', affectedIds: [flow.id, artifact.ruleId, artifact.snapshotId] });
      }
      if (rule.validTo !== undefined && Date.parse(rule.validTo) < nowMs) {
        throw new RewardServiceError('NEEDS_REVIEW', 'candidate rule is expired', { code: 'SOURCE_STALE', path: 'rule.validTo', requiredFacts: ['active, unexpired offer rule'], retryAction: 'create_ingestion', affectedIds: [flow.id, artifact.ruleId] });
      }
      for (const capPoolId of rule.capPoolRefs ?? []) if (!state.capPools.some((pool) => pool.id === capPoolId)) throw new RewardServiceError('NEEDS_REVIEW', 'candidate rule refers to a missing cap pool', { code: 'CANONICAL_REFERENCE_MISSING', path: 'rule.capPoolRefs', requiredFacts: ['existing cap pool'], retryAction: 'get_ingestion', affectedIds: [flow.id, rule.id, capPoolId] });
      if (rule.routeId && !state.paymentRoutes.some((route) => route.id === rule.routeId && route.status === 'active')) throw new RewardServiceError('NEEDS_REVIEW', 'candidate rule refers to an unavailable payment route', { code: 'CANONICAL_REFERENCE_MISSING', path: 'rule.routeId', requiredFacts: ['active payment route'], retryAction: 'get_ingestion', affectedIds: [flow.id, rule.id, rule.routeId] });
    }
  }

  private activationHoldReason(state: StoredState, rule: OfferRuleVersion, snapshot: OfferSourceSnapshot): string | undefined {
    if (snapshot.sourceType !== 'official' || snapshot.verified !== true) return 'source is not an official verified snapshot';
    if (rule.requires?.includes('user_confirmation')) return 'rule requires user confirmation';
    if (rule.match.merchants?.some((id) => !state.merchants.some((merchant) => merchant.canonicalId === id && merchant.status === 'active'))) return 'canonical merchant is awaiting confirmation';
    return undefined;
  }

  private manifestCorrectionAction(flow: IngestionFlowRecord): { actionId: string; kind: 'CORRECT_MANIFEST'; expectedRevision: number; completionCondition: string } {
    return { actionId: `act_${crypto.createHash('sha256').update(`${flow.id}:${flow.revision}:CORRECT_MANIFEST`).digest('hex').slice(0, 24)}`, kind: 'CORRECT_MANIFEST', expectedRevision: flow.revision, completionCondition: 'Replace the manifest before any leaf is processed; the previous revision remains in audit history.' };
  }

  private presentIngestion(flow: IngestionFlowRecord): { flow: IngestionFlowRecord; nextAction: { actionId: string; kind: 'SUBMIT_SOURCE' | 'SUBMIT_MANIFEST' | 'PROCESS_LEAF' | 'FINALIZE'; expectedRevision: number; completionCondition: string; leafId?: string } | undefined; manifestCorrectionAction?: { actionId: string; kind: 'CORRECT_MANIFEST'; expectedRevision: number; completionCondition: string } } {
    const leaf = flow.status === 'processing_leaves' ? [...(flow.manifest ?? [])].sort((a, b) => a.id.localeCompare(b.id)).find((candidate) => candidate.disposition === undefined && candidate.dependsOn.every((dependency) => flow.manifest?.find((entry) => entry.id === dependency)?.disposition !== undefined)) : undefined;
    const kind = flow.status === 'awaiting_source' ? 'SUBMIT_SOURCE' : flow.status === 'awaiting_manifest' ? 'SUBMIT_MANIFEST' : leaf ? 'PROCESS_LEAF' : flow.status === 'ready_to_finalize' ? 'FINALIZE' : undefined;
    const nextAction = kind === undefined ? undefined : { actionId: `act_${crypto.createHash('sha256').update(`${flow.id}:${flow.revision}:${kind}:${leaf?.id ?? ''}`).digest('hex').slice(0, 24)}`, kind: kind as 'SUBMIT_SOURCE' | 'SUBMIT_MANIFEST' | 'PROCESS_LEAF' | 'FINALIZE', expectedRevision: flow.revision, completionCondition: kind === 'SUBMIT_SOURCE' ? 'Submit one immutable source capture for this flow.' : kind === 'SUBMIT_MANIFEST' ? 'Submit the complete source manifest for this flow.' : kind === 'FINALIZE' ? 'Atomically validate and finalize the complete manifest.' : 'Materialize, ignore, or supersede this leaf.', ...(leaf ? { leafId: leaf.id } : {}) };
    return { flow: structuredClone(flow), nextAction, ...(flow.manifest && flow.status !== 'complete' ? { manifestCorrectionAction: this.manifestCorrectionAction(flow) } : {}) };
  }

  recordEventReward(input: unknown): EventRewardLedgerRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'event reward recording requires an authenticated user');
    const parsed = validateEventRewardInput(input);
    const state = this.store.read();
    const candidate = createPaymentEventRewardCandidate(parsed.candidate);
    const rewardCurrency = candidate?.reward?.currency;
    const isCrossCurrency = rewardCurrency !== undefined && rewardCurrency !== parsed.event.amount.currency;
    let appliedFx: AppliedFxRate | undefined;
    if (isCrossCurrency) {
      if (!parsed.event.fx) {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: parsed.event.amount, occurredAt: parsed.event.occurredAt, mode: 'actual' },
          targetCurrency: rewardCurrency,
        });
        throw new RewardServiceError('fx_missing', 'missing FX snapshot for event reward', {
          code: 'fx_missing',
          path: 'event.fx',
          requiredFacts: fxReq.requiredFacts,
          retryAction: fxReq.retryAction,
          fxResolutionRequest: fxReq,
        });
      }
      if (parsed.event.fx.rateType === 'mid_market') {
        throw new RewardServiceError('NEEDS_REVIEW', 'mid_market rate cannot be used for actual event reward settlement');
      }
      appliedFx = freezeAppliedFxRate(parsed.event.fx, nowIso());
    }
    return new EventRewardLedger(this.metadataUser, state.capPools, this.store).record(candidate, parsed.event, parsed.idempotencyKey, appliedFx);
  }

  recordValidatedEventReward(input: unknown): EventRewardLedgerRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'event reward recording requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    if (source.rule !== undefined && source.chainRule !== undefined) throw new RewardServiceError('INVALID_INPUT', 'validated event reward accepts either rule or chainRule, not both');
    if (source.rule === undefined && source.chainRule === undefined) throw new RewardServiceError('INVALID_INPUT', 'validated event reward requires a rule or chainRule');
    if (source.chainRule !== undefined && source.sourceEvents === undefined) throw new RewardServiceError('INVALID_INPUT', 'validated event reward chainRule requires sourceEvents');
    const event = validatePaymentEvent(source.event);
    const sourceEventsValue = source.sourceEvents === undefined ? [] : source.sourceEvents;
    if (!Array.isArray(sourceEventsValue) || sourceEventsValue.length > 16) throw new RewardServiceError('INVALID_INPUT', 'sourceEvents must contain at most 16 events');
    const sourceEvents = sourceEventsValue.map(validatePaymentEvent);
    const parsedCandidate = validateEventRewardInput({ event, candidate: source.candidate, idempotencyKey: source.idempotencyKey }).candidate;
    const eligibility = source.chainRule === undefined ? matchPaymentEvent(validatePaymentEventRule(source.rule), event) : matchPaymentEventChain(validatePaymentEventChainRule(source.chainRule), event, sourceEvents);
    const candidate = createPaymentEventRewardCandidate({ ...parsedCandidate, eventId: event.id, eligibility });
    const state = this.store.read();
    const ledger = new EventRewardLedger(this.metadataUser, state.capPools, this.store);
    if (candidate) {
      const existingEventReward = ledger.list().some((record) => record.eventId === event.id && record.idempotencyKey !== source.idempotencyKey);
      if (existingEventReward) throw new RewardServiceError('NEEDS_REVIEW', 'event reward candidates require an explicit stacking decision before durable recording');
      const decision = decidePaymentEventRewards([candidate]);
      if (decision.status !== 'matched') throw new RewardServiceError('NEEDS_REVIEW', 'event reward combination policy requires review');
    }
    const rewardCurrency = candidate?.reward?.currency;
    const isCrossCurrency = rewardCurrency !== undefined && rewardCurrency !== event.amount.currency;
    let appliedFx: AppliedFxRate | undefined;
    if (isCrossCurrency) {
      if (!event.fx) {
        const fxReq = buildFxResolutionRequest({
          transaction: { amount: event.amount, occurredAt: event.occurredAt, mode: 'actual' },
          targetCurrency: rewardCurrency,
        });
        throw new RewardServiceError('fx_missing', 'missing FX snapshot for event reward', {
          code: 'fx_missing',
          path: 'event.fx',
          requiredFacts: fxReq.requiredFacts,
          retryAction: fxReq.retryAction,
          fxResolutionRequest: fxReq,
        });
      }
      if (event.fx.rateType === 'mid_market') {
        throw new RewardServiceError('NEEDS_REVIEW', 'mid_market rate cannot be used for actual event reward settlement');
      }
      appliedFx = freezeAppliedFxRate(event.fx, nowIso());
    }
    return ledger.record(candidate, event, String(source.idempotencyKey), appliedFx);
  }

  reverseEventReward(input: unknown): EventRewardReversalRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'event reward reversal requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const event = validatePaymentEvent(source.event);
    const idempotencyKey = typeof source.idempotencyKey === 'string' ? source.idempotencyKey : (() => { throw new RewardServiceError('INVALID_INPUT', 'event reward reversal idempotencyKey is required'); })();
    const state = this.store.read();
    return new EventRewardLedger(this.metadataUser, state.capPools, this.store).reverse(event, idempotencyKey);
  }

  submitEvidence(input: unknown): EvidenceRecord {
    const parsed = validateEvidence(input);
    const state = this.store.read();
    const existing = state.evidence.filter((candidate) => candidate.requirementId === parsed.requirementId && candidate.reviewState === 'accepted' && (candidate.ownerUser === this.metadataUser || (candidate.ownerUser === undefined && this.metadataUser === undefined)));
    if (existing.some((candidate) => JSON.stringify(candidate.claim) !== JSON.stringify(parsed.claim))) throw new RewardServiceError('NEEDS_REVIEW', `conflict for evidence requirement ${parsed.requirementId}`);
    const retry = existing.find((candidate) => JSON.stringify(candidate.claim) === JSON.stringify(parsed.claim) && candidate.sourceIdentity === parsed.sourceIdentity);
    if (retry) return retry;
    const evidence = { ...parsed, id: ownedId('ev'), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    this.store.update((next) => { next.evidence.push(evidence); });
    return evidence;
  }

  listEvidence(): readonly EvidenceRecord[] { return this.store.read().evidence; }

  submitRewardValuationSnapshot(input: unknown): RewardValuationSnapshot {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'reward valuation requires an authenticated user');
    const parsed = validateRewardValuationSnapshot(input);
    const state = this.store.read();
    const evidence = state.evidence.find((candidate) => candidate.id === parsed.evidenceId && candidate.ownerUser === this.metadataUser);
    if (!evidence || evidence.reviewState !== 'accepted' || evidence.sourceType !== 'official' || evidence.authority === 'user') throw new RewardServiceError('NEEDS_REVIEW', 'valuation requires accepted official owned evidence');
    const now = Date.now();
    if (Date.parse(evidence.observedAt) > now || (evidence.validTo !== undefined && Date.parse(evidence.validTo) <= now) || (evidence.refreshAfter !== undefined && Date.parse(evidence.refreshAfter) <= now)) throw new RewardServiceError('NEEDS_REVIEW', 'valuation evidence is stale or invalid');
    const claim = evidence.claim;
    if (claim.nativeUnit !== parsed.nativeUnit || claim.targetCurrency !== parsed.targetCurrency || claim.rateNumerator !== parsed.rateNumerator || claim.rateDenominator !== parsed.rateDenominator || (claim.version !== undefined && claim.version !== parsed.version)) throw new RewardServiceError('NEEDS_REVIEW', 'valuation does not match its evidence claim');
    const existing = (state.valuationSnapshots ?? []).find((candidate) => candidate.ownerUser === this.metadataUser && candidate.evidenceId === parsed.evidenceId && candidate.version === parsed.version);
    if (existing) return existing;
    const snapshot = { ...parsed, id: ownedId('valuation'), ownerUser: this.metadataUser };
    this.store.update((next) => { next.valuationSnapshots = [...(next.valuationSnapshots ?? []), snapshot]; });
    return snapshot;
  }

  listRewardValuationSnapshots(): readonly RewardValuationSnapshot[] {
    if (!this.metadataUser) return [];
    return (this.store.read().valuationSnapshots ?? []).filter((snapshot) => snapshot.ownerUser === this.metadataUser);
  }

  upsertPaymentCapability(input: unknown): PaymentCapabilityRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'payment capability requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validatePaymentCapability({ ...source, id: source.id ?? 'capability_input', status: source.status ?? 'active' });
    if (parsed.evidenceIds.length === 0) throw new RewardServiceError('NEEDS_REVIEW', 'payment capability requires at least one self-asserted evidenceId');
    const state = this.store.read();
    const existing = (state.paymentCapabilities ?? []).find((candidate) => candidate.idempotencyKey === parsed.idempotencyKey);
    const { ownerUser: _ownerUser, ...publicCapability } = parsed;
    const desired: PaymentCapabilityRecord = { ...publicCapability, id: existing?.id ?? ownedId('cap') };
    if (existing) { if (JSON.stringify({ ...existing, id: parsed.id }) !== JSON.stringify({ ...desired, id: parsed.id })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different payment capability'); return existing; }
    this.store.update((next) => { next.paymentCapabilities = [...(next.paymentCapabilities ?? []), desired]; });
    return desired;
  }

  listPaymentCapabilities(): readonly PaymentCapabilityRecord[] { return this.store.read().paymentCapabilities ?? []; }

  upsertPaymentRoute(input: unknown): PaymentRouteRecord {
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validatePaymentRouteRecord({ ...source, id: 'route_input', ...(source.status === undefined ? { status: 'active' } : {}), ...(source.ownerUser === undefined ? {} : { ownerUser: source.ownerUser }) });
    const state = this.store.read();
    const accountId = parsed.funding.kind === 'account' ? parsed.funding.accountId : undefined;
    if (accountId !== undefined) {
      const account = state.paymentAccounts.find((candidate) => candidate.id === accountId && (candidate.ownerUser === this.metadataUser || (candidate.ownerUser === undefined && this.metadataUser === undefined)));
      if (!account) throw new RewardServiceError('INVALID_INPUT', 'payment route references an unknown payment account');
      if (parsed.status === 'active' && account.status !== 'active') throw new RewardServiceError('NEEDS_REVIEW', 'active payment routes require an active payment account');
    }
    const existing = state.paymentRoutes.find((route) => route.idempotencyKey === parsed.idempotencyKey && (route.ownerUser === this.metadataUser || (route.ownerUser === undefined && this.metadataUser === undefined)));
    const desired = { ...parsed, id: existing?.id ?? routeId(), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    if (existing) {
      if (parsed.status === 'failed' && existing.status !== 'failed') {
        if (!parsed.failure) throw new RewardServiceError('INVALID_INPUT', 'failed payment routes require failure details');
        const failed: PaymentRouteRecord = { ...existing, status: 'failed', failure: parsed.failure };
        this.store.update((next) => { next.paymentRoutes = next.paymentRoutes.map((route) => route.id === existing.id ? failed : route); });
        return failed;
      }
      if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different payment route');
      return existing;
    }
    this.store.update((next) => { next.paymentRoutes.push(desired); });
    return desired;
  }

  listPaymentRoutes(): readonly PaymentRouteRecord[] { const state = this.store.read(); return state.paymentRoutes.filter((route) => route.ownerUser === this.metadataUser || (route.ownerUser === undefined && this.metadataUser === undefined)); }

  upsertPaymentAccount(input: unknown): PaymentAccountRecord {
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validatePaymentAccountRecord({ ...source, id: 'account_input', ...(source.status === undefined ? { status: source.confirmation ? 'active' : 'candidate' } : {}), ...(source.ownerUser === undefined ? {} : { ownerUser: source.ownerUser }) });
    const state = this.store.read();
    const existing = state.paymentAccounts.find((account) => account.idempotencyKey === parsed.idempotencyKey && (account.ownerUser === this.metadataUser || (account.ownerUser === undefined && this.metadataUser === undefined)));
    const desired = { ...parsed, id: existing?.id ?? accountId(), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    if (existing) { if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different payment account'); return existing; }
    this.store.update((next) => { next.paymentAccounts.push(desired); });
    return desired;
  }

  listPaymentAccounts(): readonly PaymentAccountRecord[] { const state = this.store.read(); return state.paymentAccounts.filter((account) => account.ownerUser === this.metadataUser || (account.ownerUser === undefined && this.metadataUser === undefined)); }

  submitFactCandidate(input: unknown) {
    const parsed = validateFactCandidate(input);
    const state = this.store.read();
    const retry = state.factCandidates.find((candidate) => candidate.requirementId === parsed.requirementId && candidate.evidenceId === parsed.evidenceId && JSON.stringify(candidate.fact) === JSON.stringify(parsed.fact));
    if (retry) return retry;
    const candidate = { ...parsed, id: ownedId('fact') };
    this.store.update((next) => { next.factCandidates.push(candidate); });
    return candidate;
  }

  private visibleTransactions(state: StoredState): RecordedTransaction[] {
    return state.transactions.filter((record) => record.ownerUser === this.metadataUser || (record.ownerUser === undefined && this.metadataUser === undefined));
  }

  private visibleSwitches(state: StoredState): CardSwitchProjection[] {
    return state.cardSwitches.filter((projection) => projection.ownerUser === this.metadataUser || (projection.ownerUser === undefined && this.metadataUser === undefined));
  }

  /** Builds a cap-aware evaluation context; public so callers can drive `rankCards`/`evaluateOffer` directly for dry-run inspection. */
  context(state: StoredState, now = nowIso(), forTransaction?: TransactionTuple): EvaluationContext {
    const usageByKey: Record<string, Money> = {};
    const targetDate = forTransaction?.occurredAt ?? now;

    // Collect unique (pool, card) combinations across all rules
    const uniquePoolCards = new Map<string, { pool: CapPoolDefinition; card: CardDescriptor | undefined; capPeriod: CapPeriod }>();
    for (const rule of state.rules) {
      const card = state.cards.find((c) => c.id === rule.cardId);
      for (const cap of this.ruleCaps(rule, state.capPools)) {
        const poolDef = state.capPools.find((p) => p.id === (cap.capPoolId ?? cap.usageKey));
        if (poolDef) {
          const dedupeKey = `${poolDef.id}|${card?.id ?? 'default'}`;
          if (!uniquePoolCards.has(dedupeKey)) {
            uniquePoolCards.set(dedupeKey, { pool: poolDef, card, capPeriod: cap });
          }
        }
      }
    }

    // Also include any standalone capPools not referenced by active rules
    for (const pool of state.capPools) {
      const dedupeKey = `${pool.id}|default`;
      if (![...uniquePoolCards.keys()].some((k) => k.startsWith(`${pool.id}|`))) {
        const kind = pool.period === 'billing_cycle' ? 'billing_cycle' : pool.period === 'campaign' ? 'campaign' : 'calendar_month';
        uniquePoolCards.set(dedupeKey, {
          pool,
          card: undefined,
          capPeriod: { kind, cap: { amountMinor: pool.limit, currency: pool.currency ?? 'TWD' }, usageKey: pool.id, capPoolId: pool.id, metric: pool.metric },
        });
      }
    }

    const totals = new Map<string, { amountMinor: number; currency: string; invalid: boolean }>();

    for (const { pool, card, capPeriod } of uniquePoolCards.values()) {
      const period = resolveCyclePeriodKey(card, capPeriod, targetDate);
      const key = `${pool.id}|${period}`;
      if (totals.has(key)) continue;

      const currency = pool.currency ?? capPeriod.cap.currency ?? 'TWD';
      const bucket = { amountMinor: 0, currency, invalid: false };

      for (const record of this.visibleTransactions(state)) {
        if (record.transaction.mode !== 'actual') continue;
        const contributingRuleIds = record.reward.components?.map((component) => component.ruleId) ?? (record.reward.ruleId ? [record.reward.ruleId] : []);
        const contributingRules = contributingRuleIds.map((id) => state.rules.find((candidate) => candidate.id === id)).filter((candidate): candidate is OfferRuleVersion => Boolean(candidate));
        if (!contributingRules.some((candidate) => candidate.capPoolRefs?.includes(pool.id))) continue;
        const contributingCard = state.cards.find((c) => c.id === contributingRules[0]?.cardId) ?? card;
        if (resolveCyclePeriodKey(contributingCard, capPeriod, record.transaction.occurredAt) !== period) continue;
        let amount: number | undefined;
        if (pool.metric === 'transaction_count') {
          amount = record.transaction.kind === 'refund' ? -1 : 1;
        } else if (pool.metric === 'spend') {
          amount = convertMinor(record.transaction.amount, currency, record.transaction);
        } else {
          const componentRewards = record.reward.components?.filter((component) => contributingRules.some((candidate) => candidate.id === component.ruleId && candidate.capPoolRefs?.includes(pool.id))).map((component) => component.reward).filter((reward): reward is Money => Boolean(reward)) ?? [];
          amount = componentRewards.length ? componentRewards.reduce((sum, reward) => sum + (convertMinor(reward, currency, record.transaction) ?? 0), 0) : (record.reward.cappedReward ? convertMinor(record.reward.cappedReward, currency, record.transaction) : 0);
        }
        if (amount === undefined) {
          bucket.invalid = true;
        } else {
          bucket.amountMinor += pool.metric === 'reward'
            ? amount
            : record.transaction.kind === 'refund' ? -amount : amount;
        }
      }
      totals.set(key, bucket);
    }

    for (const [key, total] of totals) if (!total.invalid) {
      const period = key.slice(key.indexOf('|') + 1);
      const poolId = key.slice(0, key.indexOf('|'));
      usageByKey[key] = { amountMinor: total.amountMinor, currency: total.currency };
      usageByKey[period] = { amountMinor: total.amountMinor, currency: total.currency };
      usageByKey[poolId] = { amountMinor: total.amountMinor, currency: total.currency };
    }

    return {
      now,
      usageByKey,
      sourceSnapshots: Object.fromEntries(state.snapshots.map((snapshot) => [snapshot.id, snapshot])),
      capPools: state.capPools,
      paymentRoutes: this.listPaymentRoutes(),
    };
  }

  private ruleCaps(rule: OfferRuleVersion, pools: readonly CapPoolDefinition[]): readonly CapPeriod[] {
    if (!rule.capPoolRefs?.length) return [];
    return rule.capPoolRefs.map((id) => {
      const pool = pools.find((candidate) => candidate.id === id);
      if (!pool) throw new RewardServiceError('INVALID_OFFER', `rule references missing cap pool ${id}`);
      const kind = pool.period === 'billing_cycle' ? 'billing_cycle' : pool.period === 'campaign' ? 'campaign' : 'calendar_month';
      return { kind, cap: { amountMinor: pool.limit, currency: pool.currency ?? rule.settlementCurrency }, usageKey: pool.id, capPoolId: pool.id, metric: pool.metric, timezone: pool.timezone };
    });
  }

  registerCard(card: CardDescriptor): CardDescriptor {
    card = validateCard(card);
    if (!card.id || !card.issuer || !card.productName) throw new RewardServiceError('INVALID_CARD', 'card id, issuer, and productName are required');
    let result!: CardDescriptor;
    this.store.update((state) => {
      const index = state.cards.findIndex((item) => item.id === card.id);
      if (index >= 0) state.cards[index] = card;
      else state.cards.push(card);
      result = card;
    });
    return result;
  }

  listCards(): CardDescriptor[] { return this.store.read().cards; }

  registerMerchant(input: Omit<MerchantIdentity, 'canonicalId'> & { canonicalId?: string }): MerchantIdentity {
    const candidate = validateMerchant({ ...input, canonicalId: merchantId(), status: 'candidate' });
    let result = candidate;
    this.store.update((state) => {
      const duplicate = state.merchants.find((merchant) => normalizedMerchantKey(merchant.canonicalNameZhHant) === normalizedMerchantKey(candidate.canonicalNameZhHant) && JSON.stringify(merchant.operatingMarkets ?? []) === JSON.stringify(candidate.operatingMarkets ?? []));
      if (duplicate) { result = duplicate; return; }
      state.merchants.push(candidate);
    });
    return result;
  }

  listMerchants(): readonly MerchantIdentity[] { return this.store.read().merchants; }

  confirmMerchant(canonicalId: string): MerchantIdentity {
    let result!: MerchantIdentity;
    this.store.update((state) => {
      const index = state.merchants.findIndex((merchant) => merchant.canonicalId === canonicalId);
      if (index < 0) throw new RewardServiceError('MERCHANT_NOT_FOUND', `merchant ${canonicalId} not found`);
      const merchant = state.merchants[index]!;
      if (merchant.status === 'deprecated') throw new RewardServiceError('INVALID_INPUT', 'deprecated merchant cannot be activated');
      result = { ...merchant, status: 'active' };
      state.merchants[index] = result;
    });
    return result;
  }

  deprecateMerchant(canonicalId: string, supersededBy: string): MerchantIdentity {
    let result!: MerchantIdentity;
    this.store.update((state) => {
      const index = state.merchants.findIndex((merchant) => merchant.canonicalId === canonicalId);
      if (index < 0 || !state.merchants.some((merchant) => merchant.canonicalId === supersededBy)) throw new RewardServiceError('MERCHANT_NOT_FOUND', 'merchant supersession target not found');
      result = { ...state.merchants[index]!, status: 'deprecated', supersededBy };
      state.merchants[index] = result;
    });
    return result;
  }

  resolveMerchant(rawQuery: string, facts: { country?: string; market?: string; mcc?: string; channel?: string } = {}): MerchantResolution {
    if (typeof rawQuery !== 'string' || rawQuery.length === 0 || [...rawQuery].length > 128) throw new RewardServiceError('INVALID_INPUT', 'merchant query must contain 1..128 Unicode characters');
    const state = this.store.read();
    const active = state.merchants.filter((merchant) => merchant.status !== 'deprecated');
    const exactId = active.find((merchant) => merchant.canonicalId === rawQuery);
    const matches = exactId ? [exactId] : active.filter((merchant) => [merchant.canonicalNameZhHant, ...(merchant.officialAliases ?? [])].some((name) => normalizedMerchantKey(name) === normalizedMerchantKey(rawQuery)));
    const compatible = matches.filter((merchant) => {
      if (facts.country && merchant.operatingMarkets?.length && !merchant.operatingMarkets.includes(facts.country.toUpperCase())) return false;
      if (facts.market && merchant.operatingMarkets?.length && !merchant.operatingMarkets.includes(facts.market.toUpperCase())) return false;
      if (facts.mcc && merchant.mccs?.length && !merchant.mccs.includes(facts.mcc)) return false;
      if (facts.channel && merchant.channels?.length && !merchant.channels.includes(facts.channel as 'in_store' | 'online')) return false;
      return true;
    }).map((merchant) => merchant.status === 'deprecated' && merchant.supersededBy ? state.merchants.find((next) => next.canonicalId === merchant.supersededBy) ?? merchant : merchant);
    const candidates = compatible.slice(0, 10);
    const catalogVersion = crypto.createHash('sha256').update(JSON.stringify(state.merchants)).digest('hex').slice(0, 16);
    if (candidates.length === 1) return { resolutionStatus: 'confirmed', merchant: candidates[0], boundedCandidates: candidates, catalogVersion };
    if (candidates.length > 1) return { resolutionStatus: 'ambiguous', boundedCandidates: candidates, requiredFacts: facts.country || facts.market ? undefined : ['transaction.country'], catalogVersion };
    return { resolutionStatus: 'unresolved', boundedCandidates: [], requiredFacts: ['transaction.merchant'], catalogVersion };
  }

  searchActiveOffers(input: { rawQuery?: string; cardId?: string; canonicalMerchantId?: string; country?: string; market?: string; mcc?: string; channel?: string; asOf?: string; limit?: number; page?: number } = {}): { offers: readonly OfferRuleVersion[]; pageInfo: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean } } {
    const limit = input.limit ?? 10;
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(page) || page < 1) throw new RewardServiceError('INVALID_INPUT', 'limit must be 1..20 and page must be a positive integer');
    const asOf = input.asOf ?? nowIso();
    const state = this.store.read();
    const marketMerchantIds = input.market
      ? new Set(state.merchants.filter((merchant) => merchant.operatingMarkets?.includes(input.market!.toUpperCase())).map((merchant) => merchant.canonicalId))
      : undefined;
    const isVisibleActiveOffer = (rule: OfferRuleVersion): boolean => {
      const source = state.snapshots.find((snapshot) => snapshot.id === rule.sourceSnapshotId);
      const isTrusted = rule.trustBasis === 'user_confirmed' || source?.verified === true;
      const isCurrent = Date.parse(rule.validFrom) <= Date.parse(asOf)
        && (!rule.validTo || Date.parse(rule.validTo) >= Date.parse(asOf));
      return rule.status === 'active'
        && (rule.ownerUser === undefined || rule.ownerUser === this.metadataUser)
        && Boolean(source && isTrusted && isCurrent);
    };
    const offers = state.rules.filter((rule) => {
      if (!isVisibleActiveOffer(rule)) return false;
      if (input.cardId && rule.cardId !== input.cardId) return false;
      if (input.channel && rule.match.channels?.length && !rule.match.channels.includes(input.channel)) return false;
      if (input.country && rule.match.countries?.length && !rule.match.countries.includes(input.country)) return false;
      if (input.mcc && rule.match.mccs?.length && !rule.match.mccs.includes(input.mcc)) return false;
      if (input.canonicalMerchantId && !rule.match.merchants?.includes(input.canonicalMerchantId)) return false;
      if (marketMerchantIds && rule.match.merchants?.length && !rule.match.merchants.some((merchantId) => marketMerchantIds.has(merchantId))) return false;
      if (!input.rawQuery) return true;
      const resolved = this.resolveMerchant(input.rawQuery, { ...(input.country === undefined ? {} : { country: input.country }), ...(input.market === undefined ? {} : { market: input.market }), ...(input.mcc === undefined ? {} : { mcc: input.mcc }), ...(input.channel === undefined ? {} : { channel: input.channel }) });
      return resolved.resolutionStatus === 'confirmed' && rule.match.merchants?.includes(resolved.merchant!.canonicalId);
    }).sort((a, b) => a.id.localeCompare(b.id));
    const start = (page - 1) * limit;
    return { offers: offers.slice(start, start + limit), pageInfo: { page, limit, total: offers.length, totalPages: Math.ceil(offers.length / limit), hasMore: start + limit < offers.length } };
  }

  getCardSwitchStatus(cardId: string, asOfUtc = nowIso()): CardSwitchStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${cardId} not found`);
    const current = this.visibleSwitches(state).filter((item) => item.cardId === cardId).at(-1);
    return cardSwitchStatus(card, current, state.campaigns, asOfUtc);
  }

  getUserBenefitStatus(kind: UserBenefitInput['kind'], cardId: string, asOfUtc = nowIso()): UserBenefitStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${cardId} not found`);
    const current = this.visibleSwitches(state).filter((item) => item.cardId === cardId && (item.kind ?? 'card_switch') === kind).at(-1);
    const base = cardSwitchStatus(card, current, state.campaigns, asOfUtc);
    const availableNow = base.availableCandidates.filter((candidate) => !candidate.eligibility?.length);
    const availableAfterActions = base.availableCandidates.filter((candidate) => Boolean(candidate.eligibility?.length)).map((campaign) => ({ campaign, requiredActions: campaign.eligibility ?? [] }));
    return { kind, ...base, availableNow, availableAfterActions };
  }

  upsertUserBenefitStatus(input: UserBenefitInput): UserBenefitStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === input.cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${input.cardId} not found`);
    if (input.kind === 'campaign_registration' && !input.campaignId) throw new RewardServiceError('INVALID_INPUT', 'campaignId is required for campaign_registration');
    const projection = { ...projectionFromInput({ ...input, switchedAtUtc: input.completedAt, effectiveFrom: input.effectiveFrom, ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }), ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }) }), kind: input.kind, ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    const duplicate = this.visibleSwitches(state).find((item) => item.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(projection)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different benefit status');
      return this.getUserBenefitStatus(input.kind, input.cardId, input.completedAt);
    }
    this.store.update((next) => {
      const index = next.cardSwitches.findIndex((item) => (item.ownerUser === this.metadataUser || (item.ownerUser === undefined && this.metadataUser === undefined)) && item.cardId === input.cardId && (item.kind ?? 'card_switch') === input.kind);
      if (index >= 0) next.cardSwitches[index] = projection;
      else next.cardSwitches.push(projection);
      if (input.kind === 'campaign_registration' && input.campaignId) {
        const enrollment = { campaignId: input.campaignId, cardId: input.cardId, enrolled: true, ...(input.completedAt ? { enrolledAt: input.completedAt } : {}) };
        const enrollmentIndex = next.switchEnrollments.findIndex((item) => item.campaignId === input.campaignId && item.cardId === input.cardId);
        if (enrollmentIndex >= 0) next.switchEnrollments[enrollmentIndex] = enrollment;
        else next.switchEnrollments.push(enrollment);
      }
    });
    return this.getUserBenefitStatus(input.kind, input.cardId, input.completedAt);
  }

  upsertCardSwitch(input: CardSwitchInput): CardSwitchStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === input.cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${input.cardId} not found`);
    const projection = { ...projectionFromInput(input), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    const duplicate = this.visibleSwitches(state).find((item) => item.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(projection)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different card switch');
      return cardSwitchStatus(card, duplicate, state.campaigns, input.switchedAtUtc);
    }
    this.store.update((next) => {
      if (input.campaign) {
        const index = next.campaigns.findIndex((item) => item.id === input.campaign!.id);
        if (index >= 0) next.campaigns[index] = input.campaign!;
        else next.campaigns.push(input.campaign!);
      }
      if (input.enrollment) {
        const index = next.switchEnrollments.findIndex((item) => item.campaignId === input.enrollment!.campaignId && item.cardId === input.enrollment!.cardId);
        if (index >= 0) next.switchEnrollments[index] = input.enrollment!;
        else next.switchEnrollments.push(input.enrollment!);
      }
      next.cardSwitches.push(projection);
    });
    const next = this.store.read();
    const current = this.visibleSwitches(next).filter((item) => item.cardId === input.cardId).at(-1);
    return cardSwitchStatus(card, current, next.campaigns, input.switchedAtUtc);
  }

  upsertOffer(
    snapshot: OfferSourceSnapshot,
    rule: OfferRuleVersion,
    confirmation?: OfferConfirmation,
    capPools?: readonly CapPoolDefinition[],
    merchant?: MerchantOnboardingInput,
  ): { snapshot: OfferSourceSnapshot; rule: OfferRuleVersion; merchant?: MerchantIdentity } {
    snapshot = validateSnapshot(snapshot);
    if (merchant !== undefined && merchant.status !== undefined && merchant.status !== 'candidate') throw new RewardServiceError('INVALID_INPUT', 'new merchants must start as candidate');
    const merchantDraft = merchant === undefined ? undefined : validateMerchant({ ...merchant, canonicalId: 'mch_pending', status: 'candidate' });
    rule = validateRule(rule);
    if (merchantDraft?.provenance.sourceSnapshotId !== undefined && merchantDraft.provenance.sourceSnapshotId !== snapshot.id) throw new RewardServiceError('INVALID_OFFER', 'merchant provenance must reference the offer source snapshot');
    const incomingPools = (capPools ?? []).map((pool) => validateCapPool(pool));
    if (snapshot.sourceType === 'user_input' && !this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'user-input offers require an authenticated user');
    if (snapshot.sourceType === 'user_input' && this.metadataUser) {
      rule = { ...rule, ownerUser: this.metadataUser, trustBasis: rule.trustBasis ?? 'user_confirmed' };
      snapshot = { ...snapshot, ownerUser: this.metadataUser };
    }
    const conf = confirmation
      ? validateConfirmation(confirmation)
      : (rule.confirmation ? validateConfirmation(rule.confirmation) : undefined);

    if (snapshot.sourceType === 'user_input' && rule.status === 'active' && !conf) {
      throw new RewardServiceError('INVALID_CONFIRMATION', 'user_input offers require explicit user confirmation before activation');
    }

    if (conf) {
      const trustBasis = conf.trustBasis ?? (snapshot.sourceType === 'user_input' ? 'user_confirmed' : 'official_verified');
      if (trustBasis === 'user_confirmed') {
        if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'user-confirmed offers require an authenticated user');
        if (snapshot.sourceType !== 'user_input') throw new RewardServiceError('INVALID_CONFIRMATION', 'user-confirmed offers require a user_input snapshot');
        if (conf.confirmedBy !== this.metadataUser) throw new RewardServiceError('INVALID_CONFIRMATION', 'confirmation owner must match the authenticated user');
      }
      const sourceRef = conf.sourceReference?.toLowerCase();
      const snapshotUrl = snapshot.url?.toLowerCase();
      const provUrl = snapshot.provenance?.sourceUrl?.toLowerCase();
      const provDesc = snapshot.provenance?.sourceDescription?.toLowerCase();
      const matchesSource = !sourceRef || !snapshotUrl ? trustBasis === 'user_confirmed' :
        sourceRef === snapshotUrl ||
        snapshotUrl.includes(sourceRef) ||
        sourceRef.includes(snapshotUrl) ||
        (provUrl && (sourceRef === provUrl || sourceRef.includes(provUrl) || provUrl.includes(sourceRef))) ||
        (provDesc && (sourceRef === provDesc || provDesc.includes(sourceRef)));
      if (!matchesSource) {
        throw new RewardServiceError('INVALID_CONFIRMATION', 'sourceReference does not match offer source provenance');
      }
      if (
        conf.rewardUnit !== rule.settlementCurrency &&
        (!rule.reward.currency || conf.rewardUnit !== rule.reward.currency)
      ) {
        throw new RewardServiceError('INVALID_CONFIRMATION', 'confirmation rewardUnit does not match rule settlement currency');
      }
      rule = { ...rule, status: 'active', trustBasis, confirmation: conf, ...(trustBasis === 'user_confirmed' && this.metadataUser ? { ownerUser: this.metadataUser } : {}) };
      if (trustBasis === 'user_confirmed' && this.metadataUser) snapshot = { ...snapshot, ownerUser: this.metadataUser };
      if (trustBasis === 'official_verified') snapshot = { ...snapshot, verified: true };
    }

    if (!snapshot.id || !snapshot.contentHash || !snapshot.parserVersion || (snapshot.sourceType !== 'user_input' && !snapshot.url)) throw new RewardServiceError('INVALID_OFFER', 'source snapshot metadata is incomplete');
    if (rule.sourceSnapshotId !== snapshot.id || !rule.id || (!rule.cardId && (!rule.componentKind || rule.componentKind === 'card_issuer'))) throw new RewardServiceError('INVALID_OFFER', 'rule must reference its source snapshot and a card or non-card component');
    let onboardedMerchant: MerchantIdentity | undefined;
    let storedRule = rule;
    this.store.update((state) => {
      if (merchantDraft) {
        if ((rule.match.merchants?.length ?? 0) > 1) throw new RewardServiceError('INVALID_OFFER', 'merchant onboarding accepts one merchant selector per offer');
        const normalizedName = normalizedMerchantKey(merchantDraft.canonicalNameZhHant);
        const operatingMarkets = JSON.stringify(merchantDraft.operatingMarkets ?? []);
        onboardedMerchant = state.merchants.find((item) => normalizedMerchantKey(item.canonicalNameZhHant) === normalizedName && JSON.stringify(item.operatingMarkets ?? []) === operatingMarkets)
          ?? { ...merchantDraft, canonicalId: merchantId() };
        storedRule = { ...rule, match: { ...rule.match, merchants: [onboardedMerchant.canonicalId] } };
        if (storedRule.status === 'active' && onboardedMerchant.status !== 'active') throw new RewardServiceError('INVALID_OFFER', 'merchant-specific active offers require an active merchant; keep the offer candidate until the merchant is confirmed');
      }
      for (const pool of incomingPools) {
        const existingPool = state.capPools.find((item) => item.id === pool.id);
        if (existingPool && JSON.stringify(existingPool) !== JSON.stringify(pool)) throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable cap pool');
        if (!existingPool) state.capPools.push(pool);
      }
      for (const ref of storedRule.capPoolRefs ?? []) if (!state.capPools.some((pool) => pool.id === ref)) throw new RewardServiceError('INVALID_OFFER', `rule references missing cap pool ${ref}`);
      const existingSnapshot = state.snapshots.find((item) => item.id === snapshot.id);
      if (existingSnapshot) {
        if (
          (existingSnapshot.ownerUser ?? undefined) !== (snapshot.ownerUser ?? undefined) ||
          existingSnapshot.url !== snapshot.url ||
          existingSnapshot.contentHash !== snapshot.contentHash ||
          existingSnapshot.parserVersion !== snapshot.parserVersion ||
          JSON.stringify(existingSnapshot.provenance) !== JSON.stringify(snapshot.provenance)
        ) {
          throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable source snapshot');
        }
      }
      const existingRule = state.rules.find((item) => item.id === storedRule.id && item.version === storedRule.version && (item.ownerUser ?? undefined) === (storedRule.ownerUser ?? undefined));
      if (storedRule.ownerUser !== undefined && !existingRule && storedRule.supersedesRuleId === undefined && state.rules.some((item) => item.id === storedRule.id && item.ownerUser === storedRule.ownerUser && item.version !== storedRule.version)) {
        throw new RewardServiceError('INVALID_OFFER', 'private rule version changes must reference supersedesRuleId');
      }
      if (existingRule) {
        const { confirmation: c1, status: s1, trustBasis: t1, ownerUser: o1, ...r1 } = existingRule;
        const { confirmation: c2, status: s2, trustBasis: t2, ownerUser: o2, ...r2 } = storedRule;
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable rule version');
        }
      }
      const snapshotIndex = state.snapshots.findIndex((item) => item.id === snapshot.id);
      if (snapshotIndex >= 0) state.snapshots[snapshotIndex] = snapshot;
      else state.snapshots.push(snapshot);
      const ruleIndex = state.rules.findIndex((item) => item.id === storedRule.id && item.version === storedRule.version && (item.ownerUser ?? undefined) === (storedRule.ownerUser ?? undefined));
      if (ruleIndex >= 0) state.rules[ruleIndex] = storedRule;
      else {
        if (storedRule.supersedesRuleId !== undefined) {
          const predecessorIndex = state.rules.findIndex((item) => item.id === storedRule.supersedesRuleId && (item.ownerUser ?? undefined) === (storedRule.ownerUser ?? undefined) && item.status === 'active');
          if (predecessorIndex < 0) throw new RewardServiceError('INVALID_OFFER', 'supersedesRuleId must reference an active rule owned by the same user');
          if (storedRule.status === 'active') {
            state.rules[predecessorIndex] = { ...state.rules[predecessorIndex]!, status: 'superseded' };
          }
        }
        state.rules.push(storedRule);
      }
      if (onboardedMerchant && !state.merchants.some((item) => item.canonicalId === onboardedMerchant!.canonicalId)) state.merchants.push(onboardedMerchant);
    });
    return { snapshot, rule: storedRule, ...(onboardedMerchant ? { merchant: onboardedMerchant } : {}) };
  }

  confirmOffer(ruleId: string, confirmation: OfferConfirmation): OfferRuleVersion {
    const state = this.store.read();
    const rule = state.rules.find((item) => item.id === ruleId);
    if (!rule) throw new RewardServiceError('RULE_NOT_FOUND', `rule ${ruleId} not found`);
    const snapshot = state.snapshots.find((item) => item.id === rule.sourceSnapshotId);
    if (!snapshot) throw new RewardServiceError('INVALID_CONFIRMATION', 'missing source snapshot for candidate rule');
    if (rule.ownerUser !== undefined && rule.ownerUser !== this.metadataUser) throw new RewardServiceError('RULE_NOT_FOUND', `rule ${ruleId} not found`);
    const result = this.upsertOffer(snapshot, rule, confirmation);
    return result.rule;
  }

  /** Merchant-first recommendation entry point; the single public entry point for recommendations. */
  recommendIntent(value: unknown): RecommendationIntentResult {
    let input = validateRecommendationIntent(value);
    let details = typeof input.merchant === 'string' ? { name: input.merchant } : input.merchant;
    let rawMerchant = details.canonicalId ?? details.name ?? details.rawStatement ?? details.canonicalNameZhHant!;
    let country = input.country ?? details.country;
    let market = input.market ?? details.market;
    const state = this.store.read();
    let cursorOffset = 0;
    const pageSize = input.limit!;
    const requestedPage = input.page ?? 1;
    let cursorEvaluatedAt: string | undefined;
    let cursorVersion: string | undefined;
    if (input.cursor !== undefined) {
      try {
        const decoded = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8')) as { v?: number; offset?: number; evaluatedAt?: string; resultVersion?: string };
        const offset = decoded.offset;
        if (decoded.v !== 1 || !Number.isSafeInteger(offset) || typeof offset !== 'number' || offset < 0 || typeof decoded.evaluatedAt !== 'string' || typeof decoded.resultVersion !== 'string') throw new Error('invalid cursor');
        cursorOffset = offset;
        cursorEvaluatedAt = decoded.evaluatedAt;
        cursorVersion = decoded.resultVersion;
      } catch {
        throw new RewardServiceError('INVALID_INPUT', 'cursor is invalid; restart the recommendation');
      }
    } else {
      cursorOffset = (requestedPage - 1) * pageSize;
    }
    const evaluatedAt = input.occurredAt ?? cursorEvaluatedAt ?? nowIso();
    const originalRetryIntent = { ...input };
    const retryFacts = input.supplementalFacts === undefined ? undefined : validateRecommendationSupplementalFacts(input.supplementalFacts);
    const conflict = (path: string, requiredFacts: readonly string[], message: string): never => {
      throw new RewardServiceError('INVALID_INPUT', message, { code: 'conflicting_fact', path, requiredFacts, retryAction: 'resolve_conflict', nextAction: 'resolve_conflict', message });
    };
    if (retryFacts?.benefitEvidence) {
      for (const fact of retryFacts.benefitEvidence) {
        const evidence = state.evidence.find((candidate) => candidate.id === fact.evidenceId && (candidate.ownerUser === this.metadataUser || candidate.ownerUser === undefined));
        if (!evidence) throw new RewardServiceError('INVALID_INPUT', `supplemental benefit evidence ${fact.evidenceId} is not available`, { code: 'invalid_fact', path: 'supplementalFacts.benefitEvidence', requiredFacts: ['accepted evidence owned by the current user or public evidence'], retryAction: 'submit_evidence', nextAction: 'submit_evidence', message: `supplemental benefit evidence ${fact.evidenceId} is not available` });
        if (fact.contentHash !== undefined && evidence.contentHash !== fact.contentHash) conflict('supplementalFacts.benefitEvidence.contentHash', ['evidence contentHash matching the accepted record'], 'supplemental benefit evidence contentHash conflicts with the accepted record');
      }
    }
    if (retryFacts?.merchant) {
      if (typeof input.merchant !== 'string' && input.merchant.canonicalId !== undefined && input.merchant.canonicalId !== retryFacts.merchant.canonicalId) conflict('supplementalFacts.merchant.canonicalId', ['one canonical merchant identity'], 'supplemental merchant identity conflicts with the original intent');
      input = { ...input, merchant: retryFacts.merchant, ...(input.country === undefined && retryFacts.merchant.country ? { country: retryFacts.merchant.country } : {}), ...(input.market === undefined && retryFacts.merchant.market ? { market: retryFacts.merchant.market } : {}) };
    }
    if (retryFacts?.amount) {
      if (input.amount && !isDeepStrictEqual(input.amount, retryFacts.amount)) conflict('supplementalFacts.amount', ['one transaction amount and currency'], 'supplemental amount conflicts with the original intent');
      input = { ...input, amount: retryFacts.amount };
    }
    if (retryFacts?.transaction) {
      if (retryFacts.transaction.amount) {
        if (input.amount && !isDeepStrictEqual(input.amount, retryFacts.transaction.amount)) conflict('supplementalFacts.transaction.amount', ['one transaction amount and currency'], 'supplemental transaction amount conflicts with the original intent');
        input = { ...input, amount: retryFacts.transaction.amount };
      }
      for (const field of ['country', 'market', 'channel', 'paymentMethod', 'occurredAt'] as const) {
        const supplied = retryFacts.transaction[field];
        if (supplied !== undefined && input[field] !== undefined && input[field] !== supplied) conflict(`supplementalFacts.transaction.${field}`, [`one transaction ${field}`], `supplemental transaction ${field} conflicts with the original intent`);
      }
      const { amount: _amount, ...transactionFacts } = retryFacts.transaction;
      input = { ...input, ...transactionFacts };
    }
    if (retryFacts?.fx) {
      if (input.fx && !isDeepStrictEqual(input.fx, retryFacts.fx)) conflict('supplementalFacts.fx', ['one FX observation for the retry'], 'supplemental FX observation conflicts with the original intent');
      input = { ...input, fx: retryFacts.fx };
    }
    if (retryFacts?.routeFacts) {
      const existing = new Map((input.routeFacts ?? []).map((fact) => [`${fact.routeId}|${fact.edgeId ?? '*'}`, fact]));
      for (const fact of retryFacts.routeFacts) {
        const key = `${fact.routeId}|${fact.edgeId ?? '*'}`;
        if (existing.has(key) && !isDeepStrictEqual(existing.get(key), fact)) conflict(`supplementalFacts.routeFacts.${key}`, ['one FX observation per route/edge scope'], 'supplemental route FX observation conflicts with the original intent');
        existing.set(key, fact);
      }
      input = { ...input, routeFacts: [...existing.values()] };
    }
    if (retryFacts?.eligibilityFacts) {
      const existing = [...(input.eligibilityFacts ?? [])];
      for (const fact of retryFacts.eligibilityFacts) {
        const sameKey = existing.filter((candidate) => candidate.factKey === fact.factKey && candidate.cardId === fact.cardId);
        if (sameKey.some((candidate) => !isDeepStrictEqual(candidate.value, fact.value))) conflict(`supplementalFacts.eligibilityFacts.${fact.factKey}`, [`one value for ${fact.factKey}`], `supplemental eligibility fact ${fact.factKey} conflicts with the original intent`);
        if (!sameKey.some((candidate) => isDeepStrictEqual(candidate, fact))) existing.push(fact);
      }
      input = { ...input, eligibilityFacts: existing };
    }
    details = typeof input.merchant === 'string' ? { name: input.merchant } : input.merchant;
    rawMerchant = details.canonicalId ?? details.name ?? details.rawStatement ?? details.canonicalNameZhHant!;
    country = input.country ?? details.country;
    market = input.market ?? details.market;
    const targetChildFlowId = input.childFlowId ?? input.resumedFlowId ?? retryFacts?.childFlowId ?? retryFacts?.resumedFlowId;
    let targetChildFlow: IngestionFlowRecord | undefined;
    if (targetChildFlowId !== undefined) {
      if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'child ingestion continuation requires an authenticated user');
      const flow = state.ingestionFlows.find((c) => c.id === targetChildFlowId);
      if (!flow) {
        throw new RewardServiceError('FLOW_NOT_FOUND', `child ingestion flow ${targetChildFlowId} not found`);
      }
      if (flow.ownerUser !== this.metadataUser) {
        throw new RewardServiceError('UNAUTHORIZED', `child ingestion flow ${targetChildFlowId} belongs to another user`);
      }
      const {
        expectedResultVersion: _expectedResultVersion,
        supplementalFacts: _supplementalFacts,
        resultVersion: _resultVersion,
        cursor: _cursor,
        page: _page,
        childFlowId: _childFlowId,
        resumedFlowId: _resumedFlowId,
        ...baselineIntentForFingerprint
      } = originalRetryIntent;
      if (flow.parentContinuation) {
        const currentFingerprint = computeIntentFingerprint(baselineIntentForFingerprint);
        if (flow.parentContinuation.intentFingerprint !== currentFingerprint) {
          throw new RewardServiceError('INVALID_INPUT', `child ingestion flow ${targetChildFlowId} continuation does not match recommendation intent fingerprint`);
        }
      }
      const validScopes = this.collectRecommendationSourceScopes(state);
      if (!validScopes.some((s) => this.sameSourceScope(s, flow.sourceScope))) {
        throw new RewardServiceError('INVALID_INPUT', `child ingestion flow ${targetChildFlowId} source scope does not match any card or rule in this recommendation`);
      }
      targetChildFlow = flow;
    }
    const expectedResultVersion = input.expectedResultVersion ?? (retryFacts ? input.resultVersion : undefined);
    const {
      expectedResultVersion: _baselineExpectedResultVersion,
      supplementalFacts: _baselineSupplementalFacts,
      resultVersion: _baselineResultVersion,
      cursor: _baselineCursor,
      page: _baselinePage,
      childFlowId: _baselineChildFlowId,
      resumedFlowId: _baselineResumedFlowId,
      ...baselineIntent
    } = originalRetryIntent;
    const baselineVersion = crypto.createHash('sha256').update(JSON.stringify({ state, intent: baselineIntent, evaluatedAt })).digest('hex').slice(0, 16);
    if (expectedResultVersion !== undefined && expectedResultVersion !== baselineVersion) {
      throw new RewardServiceError('INVALID_INPUT', 'recommendation resultVersion is stale; restart the original intent', { code: 'stale_fact', path: 'expectedResultVersion', requiredFacts: ['current recommendation resultVersion'], retryAction: 'restart_recommendation', nextAction: 'restart_recommendation', message: 'the recommendation changed before the typed retry was submitted' });
    }
    const resultVersion = crypto.createHash('sha256').update(JSON.stringify({
      state,
      intent: { ...input, cursor: undefined, page: undefined, resultVersion: undefined, expectedResultVersion: undefined, supplementalFacts: undefined, childFlowId: undefined, resumedFlowId: undefined },
      evaluatedAt,
    })).digest('hex').slice(0, 16);
    if (cursorVersion !== undefined && cursorVersion !== resultVersion) throw new RewardServiceError('INVALID_INPUT', 'recommendation resultVersion changed; restart the recommendation');
    if (input.resultVersion !== undefined && !retryFacts && input.resultVersion !== resultVersion) throw new RewardServiceError('INVALID_INPUT', 'recommendation resultVersion changed; restart the recommendation');
    const resolution = this.resolveMerchant(rawMerchant, {
      ...(country ? { country } : {}), ...(market ? { market } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    });
    const actions: Array<RecommendationIntentResult['requiredActions'][number]> = [];
    const addAction = (action: RecommendationIntentResult['requiredActions'][number]) => {
      const existing = actions.find((candidate) => candidate.id === action.id);
      if (!existing) {
        actions.push({
          ...action,
          candidateIds: action.candidateIds ? [...action.candidateIds].sort() : undefined,
          ...(action.diagnostic ? {
            diagnostic: {
              ...action.diagnostic,
              candidateIds: action.candidateIds ? [...action.candidateIds].sort() : action.diagnostic.candidateIds,
            },
          } : {}),
        });
        return;
      }
      const candidateIds = [...new Set([...(existing.candidateIds ?? []), ...(action.candidateIds ?? [])])].sort();
      if (candidateIds.length) {
        (existing as { candidateIds?: readonly string[] }).candidateIds = candidateIds;
        if (existing.diagnostic) {
          (existing.diagnostic as { candidateIds?: readonly string[] }).candidateIds = candidateIds;
        }
      }
    };
    if (resolution.resolutionStatus !== 'confirmed') {
      const isAmbiguous = resolution.resolutionStatus === 'ambiguous';
      const actionName = isAmbiguous ? 'resolve_merchant' : 'research_merchant';
      const owner = isAmbiguous ? 'user' : 'agent';
      const code = isAmbiguous ? 'merchant_ambiguous' : 'merchant_not_found';
      addAction({
        id: 'merchant',
        action: actionName,
        owner,
        path: 'merchant',
        requiredFacts: ['confirmed merchant identity and market'],
        submission: { tool: 'recommend', field: 'merchant' },
        completionCondition: 'repeat recommend after merchant identity and market are resolved; without new facts, stop retrying',
        diagnostic: {
          code,
          path: 'merchant',
          requiredFacts: ['confirmed merchant identity and market'],
          retryAction: actionName,
          nextAction: actionName,
          message: isAmbiguous
            ? `merchant '${rawMerchant}' is ambiguous across multiple markets`
            : `merchant '${rawMerchant}' identity is not confirmed in the catalog`,
        },
      });
    }
    if (!input.amount) {
      addAction({
        id: 'amount',
        action: 'ask_user',
        owner: 'user',
        path: 'amount',
        requiredFacts: ['amount.amountMinor', 'amount.currency'],
        submission: { tool: 'recommend', field: 'amount' },
        completionCondition: 'repeat recommend with a positive amount and currency',
        diagnostic: {
          code: 'missing_required_fact',
          path: 'amount',
          requiredFacts: ['amount.amountMinor', 'amount.currency'],
          retryAction: 'ask_user',
          nextAction: 'ask_user',
          message: 'transaction amount and currency are required to evaluate rewards',
        },
      });
    }
    const merchant = resolution.merchant?.canonicalId;
    const transaction = input.amount ? validateRecommendationTransaction({
      kind: 'purchase', mode: 'planned', occurredAt: evaluatedAt, amount: input.amount,
      ...(merchant ? { merchant } : {}), ...(country ? { country } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
      ...(input.fx ? { fx: input.fx } : {}),
    }) : undefined;
    const context = {
      ...this.context(state, evaluatedAt, transaction),
      ...(input.eligibilityFacts ? { eligibilityFacts: input.eligibilityFacts } : {}),
    };
    const cards = state.cards.filter(card => input.cardIds === undefined || input.cardIds.includes(card.id));
    const registeredRoutes = this.listPaymentRoutes().filter(route =>
      (input.routeIds === undefined || input.routeIds.includes(route.id)) &&
      (input.cardIds === undefined || (route.funding.kind === 'credit_card' && input.cardIds.includes(route.funding.cardId ?? ''))));
    const generatedRoutes: PaymentRouteRecord[] = [];
    if (transaction && this.metadataUser) {
      const generatedCapabilityIds = new Set<string>();
      const validCapability = (capability: PaymentCapabilityRecord) => capability.status === 'active' &&
        (!capability.merchant || capability.merchant === rawMerchant || capability.merchant === merchant) &&
        (!capability.channel || capability.channel === input.channel) &&
        (!capability.validFrom || Date.parse(capability.validFrom) <= Date.parse(evaluatedAt)) &&
        (!capability.validTo || Date.parse(capability.validTo) >= Date.parse(evaluatedAt)) &&
        capability.evidenceIds.length > 0;
      for (const capability of this.listPaymentCapabilities().filter(validCapability)) {
        const fundingOptions: PaymentRouteRecord['funding'][] = [];
        if (capability.fundingKinds.includes('credit_card')) for (const card of cards) fundingOptions.push({ kind: 'credit_card', cardId: card.id });
        if (capability.fundingKinds.includes('account')) for (const account of state.paymentAccounts.filter((candidate) => candidate.ownerUser === this.metadataUser && candidate.status === 'active')) fundingOptions.push({ kind: 'account', subtype: account.kind, accountId: account.id });
        if (capability.fundingKinds.includes('cash')) fundingOptions.push({ kind: 'cash' });
        for (const funding of fundingOptions) {
          if (input.routeIds !== undefined) continue;
          const seed = funding.kind === 'credit_card' ? funding.cardId! : funding.kind === 'account' ? funding.accountId! : funding.kind;
          const providerNode = { id: 'service', kind: 'payment_service' as const, displayName: capability.consumerAppId ?? capability.providerId };
          const acceptanceNode = { id: 'acceptance', kind: 'acceptance_network' as const, displayName: capability.acceptanceProviderId ?? 'acceptance network' };
          const walletNode = { id: 'wallet', kind: 'wallet_balance' as const, displayName: capability.providerId };
          const evidenceIds = capability.evidenceIds;
          const sourceUrl = capability.sourceUrl ?? state.evidence.find((evidence) => evidence.id === evidenceIds[0])?.sourceUrl;
          const layers = [{ kind: 'merchant_acceptance' as const, providerId: capability.acceptanceProviderId ?? capability.providerId }, ...(capability.consumerAppId ? [{ kind: 'consumer_app' as const, appId: capability.consumerAppId }] : []), { kind: 'payment_provider' as const, providerId: capability.providerId }];

          if (funding.kind === 'credit_card') {
            const supportsTopUp = capability.transitions.includes('wallet_top_up') && capability.transitions.includes('wallet_debit') && capability.transitions.includes('merchant_settlement');
            const supportsDirectAuth = capability.transitions.includes('card_authorization') && capability.transitions.includes('merchant_settlement');
            if (supportsTopUp) {
              const nodes = [{ id: 'funding', kind: 'funding_source' as const, displayName: seed }, walletNode, providerNode, acceptanceNode, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant }];
              const edges = [{ edgeId: 'fund', fromNodeId: 'funding', toNodeId: 'wallet', transition: 'wallet_top_up' as const, evidenceIds }, { edgeId: 'pay', fromNodeId: 'wallet', toNodeId: 'acceptance', transition: 'wallet_debit' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }];
              const id = supportsDirectAuth ? `generated_${capability.id}_${seed}_topup` : `generated_${capability.id}_${seed}`;
              generatedRoutes.push({ id, status: 'active', layers, funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:${seed}:topup`, nodes, edges });
              generatedCapabilityIds.add(capability.id);
            }
            if (supportsDirectAuth) {
              const nodes = [{ id: 'funding', kind: 'funding_source' as const, displayName: seed }, providerNode, acceptanceNode, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant }];
              const edges = capability.transitions.includes('service_to_acceptance')
                ? [{ edgeId: 'auth', fromNodeId: 'funding', toNodeId: 'service', transition: 'card_authorization' as const, evidenceIds }, { edgeId: 'route', fromNodeId: 'service', toNodeId: 'acceptance', transition: 'service_to_acceptance' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }]
                : [{ edgeId: 'auth', fromNodeId: 'funding', toNodeId: 'service', transition: 'card_authorization' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'service', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }];
              const id = supportsTopUp ? `generated_${capability.id}_${seed}_direct` : `generated_${capability.id}_${seed}`;
              generatedRoutes.push({ id, status: 'active', layers, funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:${seed}:direct`, nodes, edges });
              generatedCapabilityIds.add(capability.id);
            }
          }

          if (funding.kind === 'account') {
            const supportsWallet = capability.transitions.includes('wallet_debit') && (capability.transitions.includes('account_debit') || capability.transitions.includes('wallet_top_up')) && capability.transitions.includes('merchant_settlement');
            const supportsDirectDebit = capability.transitions.includes('account_debit') && !capability.transitions.includes('wallet_debit') && capability.transitions.includes('merchant_settlement');
            if (supportsWallet) {
              const nodes = [{ id: 'funding', kind: 'funding_source' as const, displayName: seed }, walletNode, providerNode, acceptanceNode, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant }];
              const edges = [{ edgeId: 'debit', fromNodeId: 'funding', toNodeId: 'wallet', transition: 'account_debit' as const, evidenceIds }, { edgeId: 'pay', fromNodeId: 'wallet', toNodeId: 'acceptance', transition: 'wallet_debit' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }];
              generatedRoutes.push({ id: `generated_${capability.id}_${seed}`, status: 'active', layers, funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:${seed}`, nodes, edges });
              generatedCapabilityIds.add(capability.id);
            } else if (supportsDirectDebit) {
              const nodes = [{ id: 'funding', kind: 'funding_source' as const, displayName: seed }, providerNode, acceptanceNode, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant }];
              const edges = capability.transitions.includes('service_to_acceptance')
                ? [{ edgeId: 'debit', fromNodeId: 'funding', toNodeId: 'service', transition: 'account_debit' as const, evidenceIds }, { edgeId: 'route', fromNodeId: 'service', toNodeId: 'acceptance', transition: 'service_to_acceptance' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }]
                : [{ edgeId: 'debit', fromNodeId: 'funding', toNodeId: 'service', transition: 'account_debit' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'service', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }];
              generatedRoutes.push({ id: `generated_${capability.id}_${seed}`, status: 'active', layers, funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:${seed}`, nodes, edges });
              generatedCapabilityIds.add(capability.id);
            }
          }

          if (funding.kind === 'cash') {
            if (capability.transitions.includes('direct_settlement')) {
              const nodes = [{ id: 'funding', kind: 'funding_source' as const, displayName: 'cash' }, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant }];
              const edges = [{ edgeId: 'settle', fromNodeId: 'funding', toNodeId: 'merchant', transition: 'direct_settlement' as const, evidenceIds }];
              const cashLayers = [{ kind: 'merchant_acceptance' as const, providerId: capability.acceptanceProviderId ?? capability.providerId }];
              generatedRoutes.push({ id: `generated_${capability.id}_cash`, status: 'active', layers: cashLayers, funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:cash`, nodes, edges });
              generatedCapabilityIds.add(capability.id);
            }
          }
        }
        if (!generatedCapabilityIds.has(capability.id)) {
          const fundingKind = capability.fundingKinds.find((k) => k !== 'cash') ?? capability.fundingKinds[0]!;
          addAction({
            id: `capability:${capability.id}`,
            action: 'bind_payment_method',
            owner: 'user',
            path: `paymentCapabilities.${capability.id}`,
            requiredFacts: capability.fundingKinds.map((kind) => `held ${kind}`),
            candidateIds: [],
            submission: fundingKind === 'credit_card' ? { tool: 'register_card', field: 'card' } : { tool: 'register_payment_account', field: 'account' },
            completionCondition: `repeat recommend after registering or binding a ${fundingKind} supported by this payment capability`,
            diagnostic: {
              code: 'missing_required_fact',
              path: `paymentCapabilities.${capability.id}`,
              requiredFacts: capability.fundingKinds.map((kind) => `held ${kind}`),
              retryAction: 'bind_payment_method',
              nextAction: 'bind_payment_method',
              message: `held payment method required for capability ${capability.id}`,
            },
          });
        }
      }
    }
    const routes = [...registeredRoutes, ...generatedRoutes];
    const applicable = (cardId?: string, routeId?: string, route?: PaymentRouteRecord) => state.rules.filter(rule => {
      if (rule.status === 'superseded') return false;
      if (rule.ownerUser !== undefined && rule.ownerUser !== this.metadataUser) return false;
      if (rule.cardId !== undefined && rule.cardId !== cardId) return false;
      if (rule.routeId !== undefined && rule.routeId !== routeId) return false;
      if (rule.routeSelector !== undefined) {
        if (!route) return false;
        if (!matchPaymentRouteSelector(rule.routeSelector, route, evaluatedAt).matched) return false;
      }
      return true;
    }).filter((rule, index, rules) => {
        if (!rule.familyId) return true;
        const family = rules.filter(candidate => candidate.familyId === rule.familyId && candidate.status === 'active');
        const latest = family.at(-1);
        return latest ? (latest.id === rule.id && latest.version === rule.version) : (rules.filter(candidate => candidate.familyId === rule.familyId).at(-1)?.id === rule.id);
      });
    const projectRule = (rule: OfferRuleVersion, result?: RewardBreakdown): IntentCandidate['matchedRules'][number] => ({
      ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind ?? 'card_issuer',
      sourceSnapshotId: rule.sourceSnapshotId,
      ...(state.snapshots.find(source => source.id === rule.sourceSnapshotId)?.url
        ? { sourceUrl: state.snapshots.find(source => source.id === rule.sourceSnapshotId)!.url } : {}),
      ...(rule.trustBasis ? { trustBasis: rule.trustBasis } : {}),
      ...(rule.ownerUser ? { ownerUser: rule.ownerUser } : {}),
      ...(rule.confirmation?.confirmedAt ? { confirmedAt: rule.confirmation.confirmedAt } : {}),
      ...(state.snapshots.find(source => source.id === rule.sourceSnapshotId)?.provenance?.sourceDescription ? { sourceSummary: state.snapshots.find(source => source.id === rule.sourceSnapshotId)!.provenance!.sourceDescription } : {}),
      validFrom: rule.validFrom, ...(rule.validTo ? { validTo: rule.validTo } : {}),
      conditions: rule.match, rewardTerms: rule.reward,
      ...(rule.combination ? { combination: rule.combination } : {}),
      ...(rule.stacking ? { stacking: rule.stacking } : {}),
      status: !result ? 'potential' : result.status === 'ok' ? 'matched' : result.status === 'no_match' ? 'excluded' : 'unknown',
      ...(result?.status === 'ok' && result.cappedReward ? { reward: result.cappedReward } : {}),
      reasons: result?.unknownReasons ?? ['amount or path facts required for evaluation'],
    });
    const candidates: IntentCandidate[] = [];
    let fxResolutionRequest: FxResolutionRequest | undefined;
    const fxRequests = new Map<string, { request: FxResolutionRequest; candidateIds: Set<string>; diagnostic: string }>();
    const registerFxRequest = (request: FxResolutionRequest, candidateId: string, diagnostic: string) => {
      const scope: NonNullable<FxResolutionRequest['scope']> = request.scope ?? { kind: 'public_reference' };
      const schemeKey = request.cardScheme ?? scope.cardScheme ?? '';
      const key = [diagnostic, request.baseCurrency, request.quoteCurrency, request.conversionOwner ?? 'unknown', schemeKey, request.purpose ?? '', scope.routeId ?? '', scope.edgeId ?? '', scope.cardId ?? '', scope.issuer ?? ''].join('|');
      const existing = fxRequests.get(key);
      if (existing) existing.candidateIds.add(candidateId);
      else fxRequests.set(key, { request, candidateIds: new Set([candidateId]), diagnostic });
      fxResolutionRequest ??= request;
    };
    const allSuppliedFx: FxSnapshot[] = [
      ...(input.fx ? [input.fx] : []),
      ...(input.routeFacts?.map((f) => f.fx) ?? []),
    ];
    if (input.routeIds === undefined) for (const card of cards) {
      const rules = applicable(card.id);
      const ruleQuote = transaction ? rules.find((rule) => rule.settlementCurrency.toUpperCase() !== transaction.amount.currency.toUpperCase())?.settlementCurrency : undefined;
      const targetCurrency = (ruleQuote ?? (card.country === 'TW' ? 'TWD' : 'TWD')).toUpperCase();
      const isCrossCurrency = Boolean(transaction && transaction.amount.currency.toUpperCase() !== targetCurrency);

      const cardContext: FxEvaluationContext = {
        baseCurrency: transaction ? transaction.amount.currency : 'TWD',
        quoteCurrency: targetCurrency,
        conversionOwner: 'card_scheme',
        rateType: 'card_scheme',
        cardScheme: card.network,
        cardId: card.id,
        issuer: card.issuer,
        asOf: evaluatedAt,
        requireFresh: false,
      };
      const applicableFx = isCrossCurrency ? findBestMatchingFx(allSuppliedFx, cardContext) : undefined;
      const tx = transaction ? { ...transaction, cardId: card.id, route: { kind: 'direct_card' as const }, ...(applicableFx ? { fx: applicableFx } : { fx: undefined }) } : undefined;
      const evaluations = rules.map(rule => ({ rule, result: tx ? evaluateOffer(rule, tx, context) : undefined }));
      const projected = evaluations.map(({ rule, result }) => projectRule(rule, result));
      const row = tx ? rankCards([card], rules, tx, context, 1)[0] : undefined;
      const unresolved = projected.some(rule => rule.status === 'unknown' || rule.status === 'potential');
      if (tx) {
        for (const { rule, result } of evaluations) for (const diagnostic of result?.diagnostics ?? []) {
          if (['fx_missing', 'fx_stale', 'fx_pair_mismatch', 'fx_scope_mismatch', 'fx_conflict'].includes(diagnostic.code)) {
            const request = buildFxResolutionRequest({
              transaction: tx, rules: [rule], card,
              cardScheme: card.network,
              scope: { kind: 'card_scheme', ...(card.network ? { cardScheme: card.network } : {}) },
              submission: { tool: 'recommend', field: 'fx' },
            });
            registerFxRequest(request, `card:${card.id}`, diagnostic.code);
            continue;
          }
          if (['missing_required_fact', 'conflicting_fact', 'stale_fact', 'unsupported_field'].includes(diagnostic.code)) {
            const isEligibility = diagnostic.path.startsWith('user.') || diagnostic.path.startsWith('eligibility');
            if (isEligibility) {
              const factKey = diagnostic.path.startsWith('user.') ? diagnostic.path.slice(5) : diagnostic.path;
              const actionName = diagnostic.code === 'conflicting_fact' ? 'resolve_conflict' : diagnostic.retryAction || 'ask_user';
              addAction({
                id: `eligibility:${card.id}:${factKey}`,
                action: actionName,
                owner: 'user',
                path: 'eligibilityFacts',
                requiredFacts: diagnostic.requiredFacts.length ? diagnostic.requiredFacts : [diagnostic.path],
                candidateIds: [`card:${card.id}`],
                submission: { tool: 'recommend', field: 'eligibilityFacts' },
                completionCondition: `repeat recommend after supplying verified eligibility fact for ${diagnostic.path}; without new facts, candidate remains excluded`,
                diagnostic: {
                  code: diagnostic.code,
                  path: diagnostic.path,
                  requiredFacts: diagnostic.requiredFacts.length ? diagnostic.requiredFacts : [diagnostic.path],
                  retryAction: diagnostic.retryAction || 'ask_user',
                  nextAction: diagnostic.nextAction || 'ask_user',
                  message: diagnostic.message,
                  candidateIds: [`card:${card.id}`],
                },
              });
              continue;
            }
          }
          if (diagnostic.code === 'stale_rule' || rule.status === 'stale') {
            const sourceScope = this.getRuleSourceScope(state, rule, card.id);
            const matchingChildFlow = (targetChildFlow && this.sameSourceScope(targetChildFlow.sourceScope, sourceScope))
              ? targetChildFlow
              : state.ingestionFlows.find((flow) => flow.ownerUser === this.metadataUser && this.sameSourceScope(flow.sourceScope, sourceScope) && flow.status !== 'complete');

            const isTerminalChild = matchingChildFlow && ['failed', 'cancelled', 'needs_review'].includes(matchingChildFlow.status);
            const isIncompleteChild = matchingChildFlow && ['awaiting_source', 'awaiting_manifest', 'processing_leaves', 'ready_to_finalize'].includes(matchingChildFlow.status);

            const diagCode: Diagnostic['code'] = isTerminalChild ? (matchingChildFlow.status === 'cancelled' ? 'flow_cancelled' : matchingChildFlow.status === 'failed' ? 'flow_failed' : 'needs_review') : 'stale_rule';
            const reasonMsg = isTerminalChild
              ? `child ingestion flow ${matchingChildFlow.id} ${matchingChildFlow.status}: ${matchingChildFlow.terminalReason || 'terminal without update'}`
              : isIncompleteChild
              ? `child ingestion flow ${matchingChildFlow.id} is in progress (${matchingChildFlow.status})`
              : `offer rule ${rule.id} is stale and requires freshness verification`;

            addAction({
              id: `freshness:${rule.id}`,
              action: 'REFRESH_BENEFIT',
              owner: 'agent',
              path: `rules.${rule.id}`,
              requiredFacts: ['current verified offer terms', 'rule confirmation'],
              candidateIds: [`card:${card.id}`],
              submission: isIncompleteChild ? { tool: 'get_ingestion', field: 'flowId' } : { tool: 'create_ingestion', field: 'sourceScope' },
              completionCondition: isIncompleteChild
                ? `complete ingestion flow ${matchingChildFlow.id} to refresh rule ${rule.id}`
                : isTerminalChild
                ? `child ingestion flow ${matchingChildFlow.id} ${matchingChildFlow.status}; restart ingestion to refresh rule ${rule.id}`
                : `repeat recommend after refreshing offer terms via ingestion for rule ${rule.id}`,
              diagnostic: {
                code: diagCode,
                path: `rules.${rule.id}`,
                requiredFacts: ['current verified offer terms'],
                retryAction: isIncompleteChild ? 'complete_ingestion' : 'create_ingestion',
                nextAction: isIncompleteChild ? 'complete_ingestion' : 'create_ingestion',
                message: reasonMsg,
                candidateIds: [`card:${card.id}`],
              },
              refreshBenefit: {
                sourceScope,
                familyId: rule.familyId || `card-${card.id}`,
                sourceSnapshotId: rule.sourceSnapshotId,
                ruleId: rule.id,
                cardId: card.id,
                reason: reasonMsg,
                freshnessRequired: {
                  asOf: evaluatedAt,
                  maxAgeSeconds: 86400,
                },
                ...(matchingChildFlow ? { childFlowId: matchingChildFlow.id, flowStatus: matchingChildFlow.status } : {}),
              },
            });
            continue;
          }
          if (diagnostic.code === 'source_untrusted') {
            addAction({
              id: `source:${rule.sourceSnapshotId}`,
              action: 'provide_verified_source_snapshot',
              owner: 'agent',
              path: `snapshots.${rule.sourceSnapshotId}`,
              requiredFacts: ['verified source snapshot'],
              candidateIds: [`card:${card.id}`],
              submission: { tool: 'upsert_offer', field: 'snapshot' },
              completionCondition: `repeat recommend after providing a verified source snapshot for rule ${rule.id}`,
              diagnostic: {
                code: 'source_untrusted',
                path: `snapshots.${rule.sourceSnapshotId}`,
                requiredFacts: ['verified source snapshot'],
                retryAction: 'provide_verified_source_snapshot',
                nextAction: 'provide_verified_source_snapshot',
                message: `source snapshot for rule ${rule.id} is untrusted or missing`,
                candidateIds: [`card:${card.id}`],
              },
            });
            continue;
          }
        }
      }
      const fxEst = (() => {
        if (!isCrossCurrency) return undefined;
        if (!applicableFx) {
          return { status: 'unavailable' as const, assumption: 'no fx snapshot was supplied for this foreign-currency rule; the Agent must fetch a current rate and supply it inline before an estimate can be calculated' };
        }
        const stale = !isFxFresh(applicableFx, evaluatedAt);
        const fallback = input.fx?.id === applicableFx.id && (!applicableFx.cardIdScope && !applicableFx.issuerScope && !applicableFx.cardScheme);
        return {
          status: stale ? 'stale_estimate' as const : fallback ? 'estimated_fallback' as const : 'estimated' as const,
          provider: applicableFx.provider,
          capturedAt: applicableFx.capturedAt,
          ...(applicableFx.sourceUrl ? { sourceUrl: applicableFx.sourceUrl } : {}),
          assumption: stale
            ? 'using an expired fx snapshot beyond its freshness window; refresh before relying on the value'
            : fallback
            ? 'using the Agent-supplied fx snapshot as a general currency-pair fallback, not an exact card scheme quote'
            : 'using the card scheme exchange rate for planned estimate',
        };
      })();
      const terminalChildFlows = rules.map((r) => {
        const scope = this.getRuleSourceScope(state, r, card.id);
        return (targetChildFlow && this.sameSourceScope(targetChildFlow.sourceScope, scope))
          ? targetChildFlow
          : state.ingestionFlows.find((f) => f.ownerUser === this.metadataUser && this.sameSourceScope(f.sourceScope, scope) && ['failed', 'cancelled', 'needs_review'].includes(f.status));
      }).filter((f): f is IngestionFlowRecord => Boolean(f));
      const terminalReasons = terminalChildFlows.map((f) => `child ingestion flow ${f.id} ${f.status}: ${f.terminalReason || 'terminal without update'}`);
      const exclusionReasons = [
        ...(row?.unknownReasons ?? (!rules.length ? ['no known offer rules'] : [])),
        ...terminalReasons,
      ];
      candidates.push({
        id: `card:${card.id}`, kind: 'direct_card', cardId: card.id,
        fundingSource: { kind: 'credit_card', cardId: card.id },
        nodes: [{ id: 'funding', kind: 'funding_source', displayName: card.productName }, { id: 'merchant', kind: 'merchant', displayName: rawMerchant }],
        events: tx ? [{ kind: 'purchase', fromNodeId: 'funding', toNodeId: 'merchant', amount: tx.amount, transition: 'card_authorization' }] : [],
        status: row?.status === 'ok' ? 'ready' : !tx || unresolved || !rules.length ? 'unknown' : 'no_match',
        matchedRules: projected,
        ...(row?.status === 'ok' && row.cappedReward ? { reward: row.cappedReward } : {}),
        ...(row?.status === 'ok' && row.cappedReward && row.cappedReward.currency === transaction?.amount.currency ? { netSpend: { amountMinor: Math.max(0, (transaction?.amount.amountMinor ?? 0) - row.cappedReward.amountMinor), currency: transaction.amount.currency } } : {}),
        ...(fxEst ? { fxEstimate: fxEst } : {}),
        exclusionReasons,
      });
    }
    let pathTruncated = false;
    if (transaction && this.metadataUser) {
      const routeFactMap = new Map<string, { routeId: string; edgeId?: string; fx: FxSnapshot }>();
      for (const fact of input.routeFacts ?? []) routeFactMap.set(`${fact.routeId}|${fact.edgeId ?? '*'}`, fact);
      if (input.fx) for (const route of routes) {
        const fundingCardId = route.funding.kind === 'credit_card' ? route.funding.cardId : undefined;
        const card = fundingCardId ? state.cards.find((candidate) => candidate.id === fundingCardId) : undefined;
        for (const edge of route.edges ?? []) {
          const costs = [edge.fee, edge.markup, edge.foreignTransactionFee, edge.dcc?.selected ? edge.dcc.fee : undefined]
            .filter((cost): cost is Money => cost !== undefined && cost.currency !== transaction.amount.currency);
          for (const cost of costs) {
            const edgeContext: FxEvaluationContext = {
              baseCurrency: cost.currency,
              quoteCurrency: transaction.amount.currency,
              conversionOwner: edge.dcc?.selected ? 'merchant_dcc'
                : edge.transition === 'card_authorization' ? 'card_scheme'
                : edge.transition === 'account_debit' ? 'issuer'
                : edge.transition === 'wallet_top_up' || edge.transition === 'wallet_debit' ? 'wallet'
                : deriveConversionOwner({ route, card }),
              cardScheme: card?.network,
              cardId: card?.id,
              issuer: card?.issuer,
              routeId: route.id,
              edgeId: edge.edgeId,
              asOf: evaluatedAt,
              requireFresh: false,
            };
            if (isFxCompatible({ snapshot: input.fx, context: edgeContext })) {
              const key = `${route.id}|${edge.edgeId}`;
              if (!routeFactMap.has(key)) routeFactMap.set(key, { routeId: route.id, edgeId: edge.edgeId, fx: input.fx });
            }
          }
        }
      }
      const result = this.recommendPaymentPaths({
        amount: transaction.amount, asOf: evaluatedAt, ...(merchant ? { merchant } : {}),
        ...(country ? { country } : {}), ...(input.channel ? { channel: input.channel } : {}),
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        routeFacts: [...routeFactMap.values()],
        ...(input.eligibilityFacts ? { eligibilityFacts: input.eligibilityFacts } : {}),
        routeIds: routes.map(route => route.id), routes, limit: 128, continuation: true,
      });
      for (const path of result.candidates) {
        const cardId = path.fundingSource.kind === 'credit_card' ? path.fundingSource.cardId : undefined;
        const route = routes.find((candidate) => candidate.id === path.routeId);
        const rules = applicable(cardId, path.routeId, route);
        const projected = rules.map(rule => {
          const matched = path.matchedRules.find(item => item.ruleId === rule.id && item.ruleVersion === rule.version);
          const summary = projectRule(rule);
          return matched ? { ...summary, status: 'matched' as const, reward: matched.reward, reasons: [] } : summary;
        });
        const hasRewards = path.matchedRules.length > 0 &&
          path.matchedRules.every(rule => rule.reward.currency === transaction.amount.currency);
        const supported = path.status === 'ready' && hasRewards;
        const readyNoReward = path.status === 'ready' && path.matchedRules.length === 0;
        const fxCostEvents = path.events.filter((event) => [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined]
          .some((cost) => cost !== undefined && cost.currency !== transaction.amount.currency));
        const fxEstimate = fxCostEvents.length === 0 ? undefined : fxCostEvents.every((event) => {
          const costs = [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined]
            .filter((cost): cost is Money => cost !== undefined && cost.currency !== transaction.amount.currency);
          return costs.every((cost) => event.fx?.baseCurrency === cost.currency && event.fx.quoteCurrency === transaction.amount.currency);
        }) ? (() => {
          const stale = fxCostEvents.some((event) => !isFxFresh(event.fx!, evaluatedAt));
          const observation = fxCostEvents[0]!.fx!;
          const fallback = input.fx?.id === observation.id && (!observation.edgeIdScope && !observation.routeIdScope && !observation.cardIdScope && !observation.cardScheme);
          return { status: stale ? 'stale_estimate' as const : fallback ? 'estimated_fallback' as const : 'estimated' as const, provider: observation.provider, capturedAt: observation.capturedAt, ...(observation.sourceUrl ? { sourceUrl: observation.sourceUrl } : {}), assumption: stale ? 'using a route FX snapshot beyond its freshness window; refresh before relying on the value' : fallback ? 'using the Agent-supplied fx snapshot as a general currency-pair fallback, not an exact per-edge fact; route policy and final settlement cost remain unconfirmed' : 'using the route or edge FX snapshot for foreign-currency costs' };
        })() : { status: 'unavailable' as const, assumption: 'foreign-currency route costs cannot be compared without a matching route or edge FX snapshot' };
        const candidateStatus = supported || readyNoReward ? 'ready' : path.status === 'blocked' ? 'blocked' : 'unknown';
        const netSpend = (supported || readyNoReward || path.status === 'blocked') && path.netValue
          ? { amountMinor: transaction.amount.amountMinor - path.netValue.amountMinor, currency: transaction.amount.currency }
          : readyNoReward
          ? (path.netValue ? { amountMinor: transaction.amount.amountMinor - path.netValue.amountMinor, currency: transaction.amount.currency } : transaction.amount)
          : undefined;
        candidates.push({
          id: path.id, kind: 'payment_path', routeId: path.routeId, fundingSource: path.fundingSource,
          nodes: path.nodes, events: path.events,
          status: candidateStatus,
          matchedRules: projected, ...(supported ? { reward: path.cappedReward } : {}),
          ...(netSpend ? { netSpend } : {}),
          ...(fxEstimate ? { fxEstimate } : {}),
          exclusionReasons: path.exclusionReasons,
        });
        if (path.status === 'blocked') {
          const route = routes.find((candidate) => candidate.id === path.routeId);
          const card = cardId ? state.cards.find((candidate) => candidate.id === cardId) : undefined;
          for (const event of path.events) {
            const costs = [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined]
              .filter((value): value is Money => value !== undefined && value.currency !== transaction.amount.currency);
            for (const cost of costs) {
              const pairMatches = event.fx?.baseCurrency === cost.currency && event.fx.quoteCurrency === transaction.amount.currency;
              const fresh = pairMatches && isFxFresh(event.fx!, evaluatedAt);
              if (fresh) continue;
              const edgeId = event.routeEdgeIds?.length === 1 ? event.routeEdgeIds[0] : undefined;
              const routeKind = route?.layers.some((layer) => layer.kind === 'wallet') ? 'wallet' as const : 'direct_card' as const;
              const request = buildFxResolutionRequest({
                transaction: { amount: cost, occurredAt: evaluatedAt, mode: 'planned', route: { kind: routeKind } },
                card, targetCurrency: transaction.amount.currency,
                cardScheme: card?.network,
                scope: edgeId ? { kind: 'route_edge', routeId: path.routeId, edgeId } : { kind: 'route', routeId: path.routeId },
                submission: { tool: 'recommend', field: 'routeFacts' },
              });
              request.requiredFacts = ['routeFacts[].routeId', ...(edgeId ? ['routeFacts[].edgeId'] : []), ...request.requiredFields!.map((field) => `routeFacts[].fx.${field}`)];
              registerFxRequest(request, path.id, event.fx ? (pairMatches ? 'fx_stale' : 'fx_pair_mismatch') : 'fx_missing');
            }
          }
          if (path.diagnostics?.length) {
            for (const diag of path.diagnostics) {
              if (['missing_required_fact', 'conflicting_fact', 'stale_fact', 'unsupported_field'].includes(diag.code)) {
                const isEligibility = diag.path.startsWith('user.') || diag.path.startsWith('eligibility');
                if (isEligibility) {
                  const factKey = diag.path.startsWith('user.') ? diag.path.slice(5) : diag.path;
                  addAction({
                    id: `eligibility:${path.routeId}:${factKey}`,
                    action: diag.code === 'conflicting_fact' ? 'resolve_conflict' : diag.retryAction || 'ask_user',
                    owner: 'user',
                    path: 'eligibilityFacts',
                    requiredFacts: diag.requiredFacts.length ? diag.requiredFacts : [diag.path],
                    candidateIds: [path.id],
                    submission: { tool: 'recommend', field: 'eligibilityFacts' },
                    completionCondition: `repeat recommend after supplying verified eligibility fact for ${diag.path}; without new facts, candidate remains excluded`,
                    diagnostic: {
                      ...diag,
                      candidateIds: [path.id],
                    },
                  });
                }
              }
            }
          }
          if (path.requiredActions?.some((a) => a.includes('fee'))) {
            const hasFx = [...fxRequests.values()].some((item) => item.candidateIds.has(path.id));
            if (!hasFx) {
              addAction({
                id: `fee:${path.routeId}`,
                action: 'confirm_fee',
                owner: 'agent',
                path: `routes.${path.routeId}.fees`,
                requiredFacts: ['fee currency and schedule'],
                candidateIds: [path.id],
                submission: { tool: 'upsert_payment_route', field: 'route' },
                completionCondition: 'repeat recommend after confirming route fee schedule',
                diagnostic: {
                  code: 'missing_required_fact',
                  path: `routes.${path.routeId}.fees`,
                  requiredFacts: ['fee currency and schedule'],
                  retryAction: 'confirm_fee',
                  nextAction: 'confirm_fee',
                  message: 'route fee schedule or currency requires confirmation',
                  candidateIds: [path.id],
                },
              });
            }
          }
        }
      }
      for (const blocked of result.blocked ?? []) {
        pathTruncated ||= blocked.reason.includes('truncated_by_bound');
        const isStale = blocked.reason.includes('stale') || blocked.reason.includes('validity window');
        const code = isStale ? 'stale_fact' : blocked.reason.includes('conflict') ? 'conflicting_fact' : 'missing_required_fact';
        addAction({
          id: `route:${blocked.routeId}:${blocked.reason}`,
          action: 'review_payment_route',
          owner: 'agent',
          path: `routes.${blocked.routeId}`,
          requiredFacts: [blocked.reason],
          candidateIds: [blocked.routeId],
          submission: { tool: 'upsert_payment_route', field: 'route' },
          completionCondition: 'repeat recommend after the route has current accepted evidence',
          diagnostic: {
            code,
            path: `routes.${blocked.routeId}`,
            requiredFacts: [blocked.reason],
            retryAction: 'submit_evidence',
            nextAction: 'submit_evidence',
            message: blocked.reason,
            candidateIds: [blocked.routeId],
          },
        });
      }
      pathTruncated ||= result.candidates.length >= 128;
    } else {
      for (const route of routes) {
        const cardId = route.funding.kind === 'credit_card' ? route.funding.cardId : undefined;
        candidates.push({
          id: `route:${route.id}`, kind: 'payment_path', routeId: route.id, fundingSource: route.funding,
          nodes: route.nodes ?? route.layers.map((layer, index) => ({ id: `layer:${index}`, kind: layer.kind, displayName: layer.displayName ?? layer.providerId ?? layer.kind })),
          events: [], status: 'unknown', matchedRules: applicable(cardId, route.id, route).map(rule => projectRule(rule)),
          exclusionReasons: ['route acceptance, evidence and amount require evaluation'],
        });
      }
    }
    if (!candidates.length) {
      addAction({
        id: 'setup',
        action: 'ask_user',
        owner: 'user',
        path: 'cardIds',
        requiredFacts: ['cards or payment methods the user owns'],
        submission: { tool: 'register_card', field: 'card' },
        completionCondition: 'repeat recommend after at least one owned card or payment route is registered',
        diagnostic: {
          code: 'missing_required_fact',
          path: 'cardIds',
          requiredFacts: ['cards or payment methods the user owns'],
          retryAction: 'ask_user',
          nextAction: 'ask_user',
          message: 'no owned cards or payment routes registered for evaluation',
        },
      });
    }
    for (const candidate of candidates) if (candidate.status === 'unknown' || candidate.status === 'blocked' || candidate.matchedRules.some(rule => rule.status === 'potential' || rule.status === 'unknown')) {
      const alreadyCovered = actions.some(action => action.candidateIds?.includes(candidate.id)) ||
        [...fxRequests.values()].some(item => item.candidateIds.has(candidate.id));
      if (!alreadyCovered) {
        addAction({
          id: `candidate:${candidate.id}`,
          action: 'review_candidate',
          owner: 'agent',
          path: `candidates.${candidate.id}`,
          requiredFacts: candidate.exclusionReasons.length ? candidate.exclusionReasons : ['current applicable offer evidence and transaction facts'],
          candidateIds: [candidate.id],
          submission: { tool: 'recommend', field: 'merchant' },
          completionCondition: 'repeat recommend only after new evidence or user-owned facts are available',
          diagnostic: {
            code: 'needs_review',
            path: `candidates.${candidate.id}`,
            requiredFacts: candidate.exclusionReasons.length ? candidate.exclusionReasons : ['current applicable offer evidence and transaction facts'],
            retryAction: 'review_candidate',
            nextAction: 'review_candidate',
            message: candidate.exclusionReasons.join('; ') || 'candidate requires review',
            candidateIds: [candidate.id],
          },
        });
      }
    }
    for (const [key, { request, candidateIds, diagnostic }] of fxRequests) {
      const code = (diagnostic === 'fx_stale' || diagnostic === 'fx_pair_mismatch' || diagnostic === 'fx_scope_mismatch' || diagnostic === 'fx_conflict') ? diagnostic : 'fx_missing';
      addAction({
        id: `fx:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`,
        action: request.retryAction,
        owner: request.retryAction === 'ask_user' ? 'user' : 'agent',
        path: request.submission?.field ?? 'fx',
        requiredFacts: request.requiredFacts,
        candidateIds: [...candidateIds].sort(),
        ...(request.submission ? { submission: request.submission } : {}),
        completionCondition: `repeat recommend after supplying a validated ${request.baseCurrency}/${request.quoteCurrency} observation; without new evidence, stop retrying ${diagnostic}`,
        diagnostic: {
          code,
          path: request.submission?.field ?? 'fx',
          requiredFacts: request.requiredFacts,
          retryAction: request.retryAction,
          nextAction: request.retryAction,
          message: code === 'fx_stale'
            ? `FX snapshot for ${request.baseCurrency}/${request.quoteCurrency} is stale and must be refreshed`
            : code === 'fx_pair_mismatch'
            ? `FX snapshot currency pair does not match ${request.baseCurrency}/${request.quoteCurrency}`
            : code === 'fx_scope_mismatch'
            ? `FX snapshot scope does not match the target card or route`
            : code === 'fx_conflict'
            ? `conflicting FX observations for ${request.baseCurrency}/${request.quoteCurrency}`
            : `missing FX snapshot for ${request.baseCurrency}/${request.quoteCurrency}`,
          candidateIds: [...candidateIds].sort(),
        },
        fxResolutionRequest: request,
      });
    }
    for (const action of actions) if (action.candidateIds === undefined) {
      const affected = action.id === 'merchant'
        ? candidates.filter((candidate) => candidate.matchedRules.some((rule) => Boolean(rule.conditions.merchants?.length))).map((candidate) => candidate.id)
        : candidates.map((candidate) => candidate.id);
      const ids = (affected.length ? affected : candidates.map((c) => c.id)).sort();
      (action as { candidateIds?: readonly string[] }).candidateIds = ids;
      if (action.diagnostic && !action.diagnostic.candidateIds?.length) {
        (action.diagnostic as { candidateIds?: readonly string[] }).candidateIds = ids;
      }
    }
    const fxResolutionRequests = [...fxRequests.values()].map(({ request }) => request);
    const ready = candidates.some(candidate => candidate.status === 'ready');
    const pending = candidates.some(candidate => candidate.status === 'unknown' || candidate.status === 'blocked');
    const status: RecommendationIntentResult['status'] = ready ? (actions.length || pending ? 'partial' : 'ready')
      : pending || actions.length ? 'needs_input' : 'no_match';
    candidates.sort((a, b) => {
      const statusDiff = Number(b.status === 'ready') - Number(a.status === 'ready');
      if (statusDiff !== 0) return statusDiff;
      if (a.status === 'ready' && b.status === 'ready' && a.netSpend && b.netSpend && a.netSpend.currency === b.netSpend.currency) {
        const netSpendDiff = a.netSpend.amountMinor - b.netSpend.amountMinor;
        if (netSpendDiff !== 0) return netSpendDiff;
      }
      if (a.reward?.currency === b.reward?.currency) {
        const rewardDiff = (b.reward?.amountMinor ?? 0) - (a.reward?.amountMinor ?? 0);
        if (rewardDiff !== 0) return rewardDiff;
      }
      return a.id.localeCompare(b.id);
    });
    const page = candidates.slice(cursorOffset, cursorOffset + pageSize);
    const hasMore = cursorOffset + page.length < candidates.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, offset: cursorOffset + page.length, evaluatedAt, resultVersion })).toString('base64url') : undefined;
    const responsePage = Math.floor(cursorOffset / pageSize) + 1;
    const unpopulatedScopes: string[] = [];
    if (cards.length === 0) unpopulatedScopes.push('cards');
    if (routes.length === 0) unpopulatedScopes.push('routes');
    if (pathTruncated) unpopulatedScopes.push('bounded_routes');
    const allDiagnostics: Diagnostic[] = actions
      .map((action) => action.diagnostic)
      .filter((d): d is Diagnostic => d !== undefined);
    return {
      status, candidates: page, requiredActions: actions, evaluatedAt,
      ...(fxResolutionRequest ? { fxResolutionRequest } : {}),
      ...(fxResolutionRequests.length ? { fxResolutionRequests } : {}),
      ...(allDiagnostics.length ? { diagnostics: allDiagnostics } : {}),
      pageSize, page: responsePage, hasMore, ...(nextCursor ? { nextCursor } : {}), resultVersion,
      coverage: {
        scope: 'registered cards and payment routes; route acceptance requires evidence',
        discoveredCount: candidates.length,
        bounded: pathTruncated,
        explorationComplete: !pathTruncated,
        ...(!pathTruncated ? { total: candidates.length } : {}),
        actionCount: actions.length,
        ...(unpopulatedScopes.length ? { unpopulatedScopes } : {}),
        notes: [
          'not a market-wide catalog',
          'planned calls do not consume caps',
          ...(actions.length ? [`${actions.length} action(s) required across candidates`] : []),
          ...(pathTruncated ? ['path exploration reached a declared resource bound'] : ['all currently discovered candidates are available through continuation']),
          ...(unpopulatedScopes.length ? [`unpopulated scopes: ${unpopulatedScopes.join(', ')}`] : []),
        ],
      },
    };
  }

  /** Build only explicitly active, user-owned and officially evidenced routes. */
  recommendPaymentPaths(input: PaymentPathRequest | { kind: 'payment_path'; payment_path: PaymentPathRequest }): PaymentPathRecommendation {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'payment path recommendation requires an authenticated user');
    if ('kind' in input) input = input.payment_path;
    if (!input || !input.amount || !Number.isSafeInteger(input.amount.amountMinor) || input.amount.amountMinor < 0 || !input.amount.currency) throw new RewardServiceError('INVALID_INPUT', 'payment path amount is invalid');
    const asOf = input.asOf ?? nowIso();
    if (Number.isNaN(Date.parse(asOf))) throw new RewardServiceError('INVALID_INPUT', 'payment path asOf is invalid');
    const eligibilityFacts: readonly EligibilityFact[] = (input.eligibilityFacts ?? []).map(validateEligibilityFact);
    const maxCandidates = input.continuation ? 128 : 20;
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > maxCandidates)) throw new RewardServiceError('INVALID_INPUT', `payment path limit must be 1..${maxCandidates}`);
    const maxHops = input.maxHops ?? 6; const maxEvents = input.maxEvents ?? 4; const maxBranchesPerNode = input.maxBranchesPerNode ?? 8;
    if (![maxHops, maxEvents, maxBranchesPerNode].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 20)) throw new RewardServiceError('INVALID_INPUT', 'payment path bounds are invalid');
    const state = this.store.read();
    const requested = input.routeIds === undefined ? undefined : new Set(input.routeIds);
    const verifiedFacts: EligibilityFact[] = [];
    let invalidEligibilityEvidence = false;
    const factValues = new Map<string, string>();
    for (const fact of eligibilityFacts) {
      const key = `${fact.cardId ?? ''}|${fact.factKey}`;
      const value = JSON.stringify(fact.value);
      if (factValues.has(key) && factValues.get(key) !== value) { invalidEligibilityEvidence = true; continue; }
      factValues.set(key, value);
      verifiedFacts.push(fact);
    }
    const routeFacts = input.routeFacts ?? [];
    if (routeFacts.length > 128) throw new RewardServiceError('INVALID_INPUT', 'routeFacts must contain at most 128 entries');
    const routeFactScopes = routeFacts.map((fact) => `${fact.routeId}|${fact.edgeId ?? '*'}`);
    if (new Set(routeFactScopes).size !== routeFactScopes.length) throw new RewardServiceError('INVALID_INPUT', 'routeFacts contains duplicate route/edge scope');
    const visibleRoutes = (input.routes ?? this.listPaymentRoutes()).filter((route) => requested === undefined || requested.has(route.id)).map((route) => {
      const fundingCardId = route.funding.kind === 'credit_card' ? route.funding.cardId : undefined;
      const card = fundingCardId ? state.cards.find((candidate) => candidate.id === fundingCardId) : undefined;
      if (!route.edges) return route;
      return { ...route, edges: route.edges.map((edge) => {
        const requiredCurrencies = [edge.fee, edge.markup, edge.foreignTransactionFee, edge.dcc?.selected ? edge.dcc.fee : undefined]
          .filter((value): value is Money => value !== undefined && value.currency !== input.amount.currency)
          .map((value) => value.currency);
        if (requiredCurrencies.length === 0) return edge;

        const candidateFacts = routeFacts.filter((candidate) => candidate.routeId === route.id &&
          (candidate.edgeId === undefined || candidate.edgeId === edge.edgeId));
        const matchingSnapshots: FxSnapshot[] = [];
        for (const reqCur of requiredCurrencies) {
          const edgeContext: FxEvaluationContext = {
            baseCurrency: reqCur,
            quoteCurrency: input.amount.currency,
            conversionOwner: edge.dcc?.selected ? 'merchant_dcc'
              : edge.transition === 'card_authorization' ? 'card_scheme'
              : edge.transition === 'account_debit' ? 'issuer'
              : edge.transition === 'wallet_top_up' || edge.transition === 'wallet_debit' ? 'wallet'
              : deriveConversionOwner({ route, card }),
            cardScheme: card?.network,
            cardId: card?.id,
            issuer: card?.issuer,
            routeId: route.id,
            edgeId: edge.edgeId,
            asOf,
            requireFresh: false,
          };
          const compatible = candidateFacts.filter((c) => isFxCompatible({ snapshot: c.fx, context: edgeContext }));
          if (compatible.length > 0) {
            const asOfTime = Date.parse(asOf);
            const sorted = [...compatible].sort((a, b) => {
              const aSpec = (a.edgeId === edge.edgeId || a.fx.edgeIdScope === edge.edgeId) ? 5
                : (a.fx.routeIdScope === route.id || a.routeId === route.id) ? 4
                : (a.fx.cardIdScope && a.fx.cardIdScope === card?.id) ? 3
                : (a.fx.issuerScope && a.fx.issuerScope === card?.issuer) ? 2
                : 1;
              const bSpec = (b.edgeId === edge.edgeId || b.fx.edgeIdScope === edge.edgeId) ? 5
                : (b.fx.routeIdScope === route.id || b.routeId === route.id) ? 4
                : (b.fx.cardIdScope && b.fx.cardIdScope === card?.id) ? 3
                : (b.fx.issuerScope && b.fx.issuerScope === card?.issuer) ? 2
                : 1;
              if (bSpec !== aSpec) return bSpec - aSpec;
              const aFresh = isFxFresh(a.fx, asOf);
              const bFresh = isFxFresh(b.fx, asOf);
              if (aFresh !== bFresh) return Number(bFresh) - Number(aFresh);
              const aDist = Math.abs(asOfTime - Date.parse(a.fx.capturedAt));
              const bDist = Math.abs(asOfTime - Date.parse(b.fx.capturedAt));
              return aDist - bDist;
            });
            matchingSnapshots.push(sorted[0]!.fx);
          }
        }
        const bestFact = matchingSnapshots[0];
        return bestFact ? { ...edge, fx: bestFact } : edge;
      }) };
    });
    const routes = visibleRoutes.filter((route) => {
      if (route.status !== 'active') return false;
      if (route.authority === undefined || route.confidence !== 'high' || !route.sourceUrl?.startsWith('https://') || !route.evidenceIds?.length) return false;
      if (route.validFrom && Date.parse(route.validFrom) > Date.parse(asOf)) return false;
      if (route.validTo && Date.parse(route.validTo) < Date.parse(asOf)) return false;
      if (route.funding.kind === 'account' && route.funding.subtype === 'wallet_balance') { const account = state.paymentAccounts.find((candidate) => candidate.id === (route.funding as { accountId?: string }).accountId && candidate.ownerUser === this.metadataUser); if (!account?.balance || account.balance.amountMinor < input.amount.amountMinor || account.balance.currency !== input.amount.currency) return false; }
      if (route.edges?.length) {
        if (!route.nodes?.length) return false;
      }
      return true;
    }).sort((a, b) => `${a.id}:${a.edges?.map((edge) => edge.edgeId).sort().join(',') ?? ''}`.localeCompare(`${b.id}:${b.edges?.map((edge) => edge.edgeId).sort().join(',') ?? ''}`));
    type PathOption = { route: PaymentRouteRecord; pathEdges?: readonly NonNullable<PaymentRouteRecord['edges']>[number][] };
    const branchBlocked: { routeId: string; reason: string }[] = [];
    const routePaths: PathOption[] = routes.flatMap((route): PathOption[] => {
      if (!route.edges?.length || !route.nodes?.length) return [{ route }];
      const usable = (edge: NonNullable<PaymentRouteRecord['edges']>[number]) => {
        const from = route.nodes?.find((node) => node.id === edge.fromNodeId);
        const to = route.nodes?.find((node) => node.id === edge.toNodeId);
        const fromRole = from?.kind;
        const toRole = to?.kind;
        const legal = edge.transition === 'wallet_top_up' ? fromRole === 'funding_source' && toRole === 'wallet_balance' : edge.transition === 'account_debit' ? fromRole === 'funding_source' && ['wallet_balance', 'payment_service', 'merchant'].includes(toRole ?? '') : edge.transition === 'wallet_debit' ? fromRole === 'wallet_balance' && ['payment_service', 'acceptance_network', 'merchant'].includes(toRole ?? '') : edge.transition === 'service_to_acceptance' ? fromRole === 'payment_service' && toRole === 'acceptance_network' : edge.transition === 'merchant_settlement' ? ['wallet_balance', 'payment_service', 'acceptance_network'].includes(fromRole ?? '') && toRole === 'merchant' : edge.transition === 'direct_settlement' ? fromRole === 'funding_source' && toRole === 'merchant' : edge.transition === 'card_authorization' ? fromRole === 'funding_source' && ['payment_service', 'acceptance_network', 'merchant'].includes(toRole ?? '') : edge.transition === 'split_tender' ? ['funding_source', 'wallet_balance'].includes(fromRole ?? '') && toRole === 'merchant' : false;
        const directionIsAdmissible = edge.direction !== 'inbound';
        return legal && directionIsAdmissible && edge.provenance !== 'model_fixture' && edge.evidenceIds.length > 0 && (!edge.validFrom || Date.parse(edge.validFrom) <= Date.parse(asOf)) && (!edge.validTo || Date.parse(edge.validTo) >= Date.parse(asOf));
      };
      const adjacency = new Map<string, typeof route.edges>();
      for (const edge of [...route.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId))) { if (!usable(edge)) { branchBlocked.push({ routeId: route.id, reason: `edge ${edge.edgeId} is not admissible (invalid transition topology or direction, missing evidenceIds, model_fixture provenance, or outside its validity window)` }); continue; } const outgoing = adjacency.get(edge.fromNodeId) ?? []; if (outgoing.length < maxBranchesPerNode) adjacency.set(edge.fromNodeId, [...outgoing, edge]); else branchBlocked.push({ routeId: route.id, reason: `truncated_by_bound:maxBranchesPerNode=${maxBranchesPerNode}` }); }
      const starts = route.nodes.filter((node) => node.kind === 'funding_source').map((node) => node.id).sort();
      const paths: PathOption[] = [];
      const visit = (nodeId: string, seen: Set<string>, path: NonNullable<PaymentRouteRecord['edges']>[number][]) => {
        if (path.length > maxHops || path.length >= maxEvents || paths.length >= (input.limit ?? maxCandidates)) { if (path.length > maxHops) branchBlocked.push({ routeId: route.id, reason: `truncated_by_bound:maxHops=${maxHops}` }); if (path.length >= maxEvents) branchBlocked.push({ routeId: route.id, reason: `truncated_by_bound:maxEvents=${maxEvents}` }); if (paths.length >= (input.limit ?? maxCandidates)) branchBlocked.push({ routeId: route.id, reason: 'truncated_by_bound:maxCandidates' }); return; }
        const node = route.nodes?.find((candidate) => candidate.id === nodeId);
        if (node?.kind === 'merchant' && path.length) { paths.push({ route, pathEdges: path }); return; }
        for (const edge of adjacency.get(nodeId) ?? []) { if (seen.has(edge.toNodeId)) { branchBlocked.push({ routeId: route.id, reason: `cycle branch blocked at edge ${edge.edgeId}` }); continue; } visit(edge.toNodeId, new Set([...seen, edge.toNodeId]), [...path, edge]); }
      };
      for (const start of starts) visit(start, new Set([start]), []);
      return paths;
    });
    const candidates: PaymentPathCandidate[] = routePaths.map(({ route, pathEdges: selectedEdges }) => {
      const pathDiagnostics: Diagnostic[] = [];
      const fundingId = route.funding.kind === 'credit_card' ? route.funding.cardId : route.funding.kind === 'account' ? route.funding.accountId : undefined;
      const fundingLabel = route.funding.kind === 'credit_card' ? `card:${fundingId ?? 'unknown'}` : route.funding.kind === 'account' ? `${route.funding.subtype}:${fundingId ?? 'unknown'}` : 'cash';
      const fundingNode = { id: 'funding', kind: route.funding.kind, displayName: fundingLabel };
      const nodes = (route.nodes?.length ? [...route.nodes] : [fundingNode, ...route.layers.map((layer, index) => ({ id: `node-${index + 1}`, kind: layer.kind, displayName: layer.displayName ?? layer.providerId ?? layer.appId ?? layer.kind }))]).sort((a, b) => a.id.localeCompare(b.id));
      const pathEdges = selectedEdges;
      const events: PaymentPathEvent[] = pathEdges?.length
        ? pathEdges.map((edge) => {
          const toNode = route.nodes?.find((n) => n.id === edge.toNodeId);
          const kind = (edge.transition === 'wallet_top_up' || (edge.transition === 'account_debit' && (!toNode || toNode.kind === 'wallet_balance'))) ? 'top_up' as const : 'purchase' as const;
          return {
            kind,
            fromNodeId: edge.fromNodeId,
            toNodeId: edge.toNodeId,
            planEventId: `plan:${JSON.stringify(route.funding)}:${edge.edgeId}`,
            ...(kind === 'purchase' ? { amount: input.amount } : {}),
            ...(edge.fee === undefined ? {} : { fee: edge.fee }),
            ...(edge.markup === undefined ? {} : { markup: edge.markup }),
            ...(edge.foreignTransactionFee === undefined ? {} : { foreignTransactionFee: edge.foreignTransactionFee }),
            ...(edge.fx === undefined ? {} : { fx: edge.fx }),
            ...(edge.dcc === undefined ? {} : { dcc: edge.dcc }),
            transition: edge.transition,
            routeEdgeIds: [edge.edgeId],
            evidenceIds: edge.evidenceIds,
            provenance: edge.provenance ?? 'official',
            eligibility: kind === 'top_up' ? { status: 'unknown' as const, reasons: ['top-up amount policy is not evidenced'] } : { status: 'ready' as const, reasons: ['wallet purchase can be evaluated independently of aggregate balance provenance'] },
            rewards: [],
          };
        })
        : route.funding.kind === 'account' && route.funding.subtype === 'wallet_balance'
        ? [{ kind: 'purchase' as const, fromNodeId: 'funding', toNodeId: 'merchant', planEventId: `plan:${JSON.stringify(route.funding)}:purchase`, amount: input.amount, eligibility: { status: 'ready' as const, reasons: ['wallet purchase can be evaluated independently of aggregate balance provenance'] }, rewards: [] }]
        : route.layers.length === 0
        ? [{ kind: route.funding.kind === 'credit_card' ? 'card_authorization' as const : 'account_debit' as const, fromNodeId: 'funding', toNodeId: 'funding', planEventId: `plan:${JSON.stringify(route.funding)}:purchase`, amount: input.amount, eligibility: { status: 'ready' as const, reasons: [] }, rewards: [] }]
        : route.layers.map((_, index) => ({ kind: index < route.layers.length - 1 ? 'top_up' as const : 'purchase' as const, fromNodeId: index === 0 ? 'funding' : `node-${index}`, toNodeId: `node-${index + 1}`, planEventId: `plan:${JSON.stringify(route.funding)}:layer-${index + 1}`, ...(index === route.layers.length - 1 ? { amount: input.amount } : {}), eligibility: { status: index < route.layers.length - 1 ? 'unknown' as const : 'ready' as const, reasons: index < route.layers.length - 1 ? ['top-up amount policy is not evidenced'] : [] }, rewards: [] }));
      for (let index = 0; index < events.length - 1; index += 1) {
        const event = events[index]; const next = events[index + 1];
        if (event && next) event.relations = [{ type: 'planned_precedes', eventId: next.planEventId! }, { type: 'planned_enables', eventId: next.planEventId! }];
      }
      const plannedRewards: { ruleId: string; ruleVersion: string; component: NonNullable<OfferRuleVersion['componentKind']>; sponsor: string; benefitGroup: string; nativeUnit: string; combination?: OfferRuleVersion['combination']; capPoolRefs?: readonly string[]; reward?: Money; reasons: readonly string[] }[] = [];
      let eligibilityUncertain = invalidEligibilityEvidence;
      events.forEach((event, index) => {
        const edge = pathEdges?.[index];
        const funding = index === 0 ? route.funding : { kind: 'account' as const, subtype: 'wallet_balance' as const, ...(route.funding.kind === 'account' && route.funding.accountId ? { accountId: route.funding.accountId } : {}) };
        const plannedEvent = { id: event.planEventId!, kind: event.kind === 'top_up' ? 'top_up' as const : 'purchase' as const, amount: event.amount ?? input.amount, occurredAt: asOf, funding, routeId: route.id, ...(input.channel === undefined ? {} : { channel: input.channel }), ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }) };
        if (event.kind === 'top_up' && event.amount === undefined) return;
        for (const rule of state.rules) {
          if (rule.status !== 'active' || !rule.eventRule || !rule.componentKind || (rule.routeId !== undefined && rule.routeId !== route.id)) continue;
          if (rule.routeSelector !== undefined) {
            const selectorMatch = matchPaymentRouteSelector(rule.routeSelector, route, asOf);
            if (!selectorMatch.matched) continue;
          }
          if (plannedRewards.some((item) => item.ruleId === rule.id && item.reward !== undefined)) continue;
          const match = matchPaymentEvent(rule.eventRule, plannedEvent);
          if (match.status !== 'matched') {
            if (match.status === 'unknown') { eligibilityUncertain = true; plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.currency ?? rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), reasons: match.reasons }); }
            continue;
          }
          if (rule.predicate) {
            const predicateContext = { ...this.context(state, asOf), eligibilityFacts: verifiedFacts };
            const outcome = evaluatePredicate(rule.predicate, { cardId: '', routeId: route.id, kind: 'purchase', mode: 'planned', occurredAt: asOf, amount: input.amount }, predicateContext);
            if (!outcome.matched) {
              eligibilityUncertain = true;
              if (outcome.diagnostics?.length) pathDiagnostics.push(...outcome.diagnostics);
              plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.currency ?? rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), reasons: [...outcome.missing, ...outcome.conflicts, ...(outcome.missing.length || outcome.conflicts.length ? [] : ['eligibility fact does not match'])] });
              continue;
            }
          }
          const reward = rule.reward.amountMinor !== undefined
            ? { amountMinor: rule.reward.amountMinor, currency: rule.reward.currency ?? input.amount.currency }
            : rule.reward.rateBps !== undefined && event.amount
            ? { amountMinor: Math.floor(event.amount.amountMinor * rule.reward.rateBps / 10_000), currency: rule.reward.currency ?? input.amount.currency }
            : undefined;
          plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.currency ?? rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), ...(reward === undefined ? {} : { reward }), reasons: reward === undefined ? ['reward spec is not calculable'] : [] });
          if (reward !== undefined && event.rewards) {
            event.rewards = [...event.rewards, {
              ruleId: rule.id,
              ruleVersion: rule.version,
              component: rule.componentKind,
              sponsor: rule.sponsor ?? rule.componentKind,
              benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default',
              nativeUnit: rule.reward.currency ?? rule.reward.kind,
              status: 'ready',
              reward,
              reasons: [],
            }];
          }
        }
        if (edge && event.kind === 'top_up' && event.amount === undefined) event.eligibility = { status: 'unknown', reasons: ['top-up amount policy is not evidenced'] };
      });
      const transaction: TransactionTuple = { cardId: route.funding.kind === 'credit_card' ? (route.funding.cardId ?? '') : '', routeId: route.id, kind: 'purchase', mode: 'planned', occurredAt: asOf, amount: input.amount, ...(input.merchant === undefined ? {} : { merchant: input.merchant }), ...(input.mcc === undefined ? {} : { mcc: input.mcc }), ...(input.country === undefined ? {} : { country: input.country }), ...(input.channel === undefined ? {} : { channel: input.channel }), ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }) };
      const card = state.cards.find((candidate) => candidate.id === transaction.cardId);
      const hasPlannedTopUp = events.some((event) => event.kind === 'top_up');
      const evalContext = { ...this.context(state, asOf, transaction), paymentRoutes: visibleRoutes };
      const evaluations = (!hasPlannedTopUp)
        ? state.rules
            .filter((rule) => (card && rule.cardId === card.id) || (rule.cardId === undefined && rule.componentKind && rule.componentKind !== 'card_issuer'))
            .map((rule) => ({ rule, result: evaluateOffer(rule, transaction, evalContext) }))
            .filter(({ result }) => result.status === 'ok')
        : [];
      const ranking = evaluations.length ? evaluations[0]?.result : undefined;
      const zero = { amountMinor: 0, currency: input.amount.currency };
      const rewardGroups = new Map<string, typeof plannedRewards>();
      for (const item of plannedRewards.filter((candidate) => candidate.reward !== undefined)) rewardGroups.set(`${item.sponsor}|${item.benefitGroup}`, [...(rewardGroups.get(`${item.sponsor}|${item.benefitGroup}`) ?? []), item]);
      let stackingAmbiguous = eligibilityUncertain;
      const acceptedPlanned: typeof plannedRewards = [];
      for (const group of rewardGroups.values()) {
        if (group.length === 1) { if (group[0]) acceptedPlanned.push(group[0]); continue; }
        const modes = group.map((item) => item.combination?.mode);
        if (modes.some((mode) => mode === undefined)) { stackingAmbiguous = true; continue; }
        if (modes.every((mode) => mode === 'additive')) { acceptedPlanned.push(...group); continue; }
        const ranked = [...group].sort((a, b) => (b.combination?.priority ?? 0) - (a.combination?.priority ?? 0) || a.ruleId.localeCompare(b.ruleId));
        if (modes.every((mode) => mode === 'replace' || mode === 'best_of' || mode === 'exclusive')) { if (ranked[0]) acceptedPlanned.push(ranked[0]); }
        else stackingAmbiguous = true;
      }
      const acceptedByRule = new Map(acceptedPlanned.map((item) => [item.ruleId, item]));
      const prerequisiteMemo = new Map<string, boolean>();
      const prerequisiteReady = (item: (typeof plannedRewards)[number], visiting = new Set<string>()): boolean => {
        const cached = prerequisiteMemo.get(item.ruleId);
        if (cached !== undefined) return cached;
        const refs = item.combination?.mode === 'prerequisite' ? item.combination.prerequisiteRuleIds : undefined;
        if (item.combination?.mode !== 'prerequisite') { prerequisiteMemo.set(item.ruleId, true); return true; }
        if (!refs?.length || visiting.has(item.ruleId)) { prerequisiteMemo.set(item.ruleId, false); return false; }
        const nextVisiting = new Set(visiting).add(item.ruleId);
        const ready = refs.every((ref) => {
          const prerequisite = acceptedByRule.get(ref);
          return prerequisite !== undefined && prerequisiteReady(prerequisite, nextVisiting);
        });
        prerequisiteMemo.set(item.ruleId, ready);
        return ready;
      };
      for (const item of [...acceptedPlanned]) {
        if (item.combination?.mode === 'prerequisite' && !prerequisiteReady(item)) {
          stackingAmbiguous = true;
          acceptedByRule.delete(item.ruleId);
        }
      }
      const allExplicit = [...rewardGroups.values()].flat().every((item) => item.combination?.mode !== undefined);
      if (rewardGroups.size > 1 && !allExplicit) stackingAmbiguous = true;
      for (const item of acceptedPlanned) {
        for (const poolId of item.capPoolRefs ?? []) {
          const pool = state.capPools.find((candidate) => candidate.id === poolId);
          if (!pool || pool.metric !== 'reward' || pool.timezone === undefined || (pool.currency !== undefined && pool.currency !== item.reward?.currency)) stackingAmbiguous = true;
        }
      }
      const acceptedIds = new Set(acceptedByRule.keys());
      for (const event of events) if (event.rewards) event.rewards = event.rewards.filter((reward) => acceptedIds.has(reward.ruleId));
      const capUsed = new Map<string, number>();
      const plannedMatched = acceptedPlanned.filter((item) => acceptedByRule.has(item.ruleId)).map((item) => {
        const capUses = (item.capPoolRefs ?? []).map((poolId) => {
          const pool = state.capPools.find((candidate) => candidate.id === poolId);
          const previous = capUsed.get(poolId) ?? 0;
          const limit = pool?.limit ?? item.reward!.amountMinor;
          const capped = Math.max(0, Math.min(item.reward!.amountMinor, limit - previous));
          capUsed.set(poolId, previous + capped);
          return { poolId, grossAmount: item.reward!, cappedAmount: { amountMinor: capped, currency: item.reward!.currency } };
        });
        const cappedMinor = capUses.length ? Math.min(item.reward!.amountMinor, ...capUses.map((use) => use.cappedAmount.amountMinor)) : item.reward!.amountMinor;
        return { ruleId: item.ruleId, ruleVersion: item.ruleVersion, component: item.component, sponsor: item.sponsor, benefitGroup: item.benefitGroup, nativeUnit: item.nativeUnit, reward: { amountMinor: cappedMinor, currency: item.reward!.currency }, ...(capUses.length ? { capUses } : {}) };
      });
      for (const event of events) {
        if (!event.rewards) continue;
        event.rewards = event.rewards.map((reward) => {
          const planned = plannedMatched.find((item) => item.ruleId === reward.ruleId);
          return planned ? { ...reward, reward: planned.reward, ...(planned.capUses ? { capUses: planned.capUses } : {}) } : reward;
        });
      }
      const matchedRules = [...evaluations.filter(({ rule }) => rule.stacking !== 'possible').map(({ rule, result }) => ({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind ?? 'card_issuer', reward: result.cappedReward ?? zero })), ...plannedMatched];
      const nativeUnits = new Set(matchedRules.map((item) => ('nativeUnit' in item && typeof item.nativeUnit === 'string') ? item.nativeUnit : item.reward.currency));
      const valuationSnapshots = state.valuationSnapshots ?? [];
      const valuedRules = matchedRules.map((item) => {
        const nativeUnit = ('nativeUnit' in item && typeof item.nativeUnit === 'string') ? item.nativeUnit : item.reward.currency;
        if (nativeUnit === item.reward.currency || nativeUnit === input.amount.currency || nativeUnit === 'cash' || nativeUnit === 'cashback') return { ...item, nativeUnit };
        const snapshot = valuationSnapshots.find((candidate) => candidate.ownerUser === this.metadataUser && candidate.nativeUnit === nativeUnit && candidate.targetCurrency === input.amount.currency && Date.parse(candidate.asOf) <= Date.parse(asOf) && (candidate.validTo === undefined || Date.parse(candidate.validTo) > Date.parse(asOf)) && state.evidence.some((evidence) => evidence.id === candidate.evidenceId && evidence.ownerUser === this.metadataUser && evidence.sourceType === 'official' && evidence.reviewState === 'accepted'));
        if (!snapshot) return { ...item, nativeUnit, valuationMissing: true as const };
        return { ...item, nativeUnit, nativeReward: item.reward, reward: { amountMinor: Math.floor(item.reward.amountMinor * snapshot.rateNumerator / snapshot.rateDenominator), currency: snapshot.targetCurrency }, valuationSnapshotId: snapshot.id };
      });
      const valuationMissing = valuedRules.some((item) => 'valuationMissing' in item && item.valuationMissing);
      const nativeUnitMismatch = valuationMissing;
      const sum = (field: 'grossReward' | 'cappedReward') => valuedRules.reduce((amount, item) => amount + (item.reward.amountMinor), 0);
      const cappedReward = matchedRules.length && !stackingAmbiguous && !nativeUnitMismatch ? { amountMinor: sum('cappedReward'), currency: input.amount.currency } : zero;
      const grossReward = matchedRules.length && !stackingAmbiguous && !nativeUnitMismatch ? { amountMinor: sum('grossReward'), currency: input.amount.currency } : zero;
      const convertCost = (cost: Money, fx: NonNullable<PaymentPathEvent['fx']> | undefined): number | undefined => {
        if (cost.currency === input.amount.currency) return cost.amountMinor;
        if (!fx || fx.baseCurrency !== cost.currency || fx.quoteCurrency !== input.amount.currency) return undefined;
        return Math.floor(cost.amountMinor * fx.ratePpm / 1_000_000);
      };
      const costValues = events.flatMap((event) => [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined].filter((value): value is Money => value !== undefined).map((value) => ({ value, converted: convertCost(value, event.fx), isStale: event.fx ? !isFxFresh(event.fx, asOf) : false })));
      const feeMismatch = costValues.some((cost) => cost.converted === undefined || cost.isStale);
      const feeTotal = costValues.some((cost) => cost.converted === undefined) || costValues.length === 0 ? undefined : { amountMinor: costValues.reduce((total, cost) => total + cost.converted!, 0), currency: input.amount.currency };
      const netValue = (costValues.some((cost) => cost.converted === undefined) || nativeUnitMismatch) ? undefined : { amountMinor: cappedReward.amountMinor - (feeTotal?.amountMinor ?? 0), currency: input.amount.currency };
      const blocked = stackingAmbiguous || feeMismatch || nativeUnitMismatch;
      const pathEvidence = [...new Set(events.flatMap((event) => event.evidenceIds ?? []))].map((id) => state.evidence.find((candidate) => candidate.id === id)).filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);
      const evidenceTier = pathEvidence.length === 0 ? 0 : Math.min(...pathEvidence.map((evidence) => evidence.sourceType === 'official' && evidence.reviewState === 'accepted' ? 3 : evidence.sourceType === 'trusted_secondary' && evidence.reviewState === 'accepted' ? 2 : evidence.sourceType === 'community' && evidence.reviewState === 'accepted' ? 1 : 0));
      const evidenceFreshness = pathEvidence.length === 0 ? undefined : pathEvidence.map((evidence) => evidence.observedAt).sort()[0];
      const stableEdges = pathEdges?.map(({ fx: _fx, ...edge }) => edge) ?? events.map(({ fx: _fx, ...event }) => event);
      const pathSignature = JSON.stringify({ version: 1, nodes, edges: stableEdges, funding: route.funding, merchant: input.merchant, currency: input.amount.currency });
      return { id: `path:${pathSignature}`, routeId: route.id, nodes, events, fundingSource: route.funding, grossReward, netReward: cappedReward, cappedReward, ...(feeTotal === undefined ? {} : { feeTotal }), ...(netValue === undefined ? {} : { netValue }), requiredActions: feeMismatch ? ['confirm fee currency or provide a validated FX snapshot'] : nativeUnitMismatch ? ['provide a validated valuation snapshot for each reward unit'] : [], userEffort: feeMismatch || nativeUnitMismatch ? 1 : 0, evidenceTier, ...(evidenceFreshness === undefined ? {} : { evidenceFreshness }), matchedRules: blocked ? [] : valuedRules, pathSignature, status: blocked ? 'blocked' : 'ready', exclusionReasons: stackingAmbiguous ? ['ambiguous stacking policy'] : feeMismatch ? ['fee currency cannot be compared without validated FX'] : nativeUnitMismatch ? ['provide a fresh authoritative valuation for each reward unit'] : matchedRules.length ? evaluations.length === matchedRules.length ? [] : ['possible stacking policy excluded'] : ['no applicable verified card rule'], ...(pathDiagnostics.length ? { diagnostics: pathDiagnostics } : {}) };
    });
    const statusRank = (status: PaymentPathCandidate['status']): number => status === 'ready' ? 0 : status === 'blocked' ? 2 : status === 'no_match' ? 3 : 1;
    candidates.sort((a, b) => statusRank(a.status) - statusRank(b.status)
      || (b.netValue?.amountMinor ?? Number.NEGATIVE_INFINITY) - (a.netValue?.amountMinor ?? Number.NEGATIVE_INFINITY)
      || b.cappedReward.amountMinor - a.cappedReward.amountMinor
      || b.grossReward.amountMinor - a.grossReward.amountMinor
      || (a.feeTotal?.amountMinor ?? Number.POSITIVE_INFINITY) - (b.feeTotal?.amountMinor ?? Number.POSITIVE_INFINITY)
      || (b.evidenceTier ?? 0) - (a.evidenceTier ?? 0)
      || (b.evidenceFreshness ?? '').localeCompare(a.evidenceFreshness ?? '')
      || (a.userEffort ?? 0) - (b.userEffort ?? 0)
      || a.id.localeCompare(b.id));
    const accepted = new Set(routes.map((route) => route.id));
    const blocked = [...visibleRoutes.filter((route) => !accepted.has(route.id)).map((route) => ({ routeId: route.id, reason: route.status !== 'active' ? 'route is not active' : 'route has no admissible terminal branch' })), ...branchBlocked];
    const diagnostics = [...new Set(branchBlocked.filter((item) => item.reason.startsWith('truncated_by_bound:')).map((item) => item.reason.split(':', 2)[0] ?? 'truncated_by_bound'))];
    return { status: candidates.length ? (candidates.some((candidate) => candidate.status === 'blocked') ? 'needs_review' : blocked.length ? 'partial' : 'ok') : (blocked.length ? 'needs_review' : 'no_match'), candidates, evaluatedAt: asOf, blocked, ...(diagnostics.length ? { diagnostics } : {}), limits: { maxCandidates: input.limit ?? 20, maxHops, maxEvents, maxBranchesPerNode } };
  }

  recordTransaction(transaction: TransactionTuple): RewardBreakdown {
    transaction = validateTransaction(transaction);
    if (transaction.mode !== 'actual') throw new RewardServiceError('INVALID_TRANSACTION', 'record_transaction only accepts actual transactions');
    if (!transaction.idempotencyKey) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'actual transactions require idempotencyKey');
    const requestedTransaction = transaction;
    const recordedAt = transaction.recordedAt ?? nowIso();
    const state = this.store.read();
    let originalRecord: RecordedTransaction | undefined;
    let appliedFx: AppliedFxRate | undefined;
    const visibleTransactions = this.visibleTransactions(state);
    const duplicate = visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.idempotencyKey);
    if (duplicate) {
      const txNormalized = { ...transaction, recordedAt: duplicate.transaction.recordedAt };
      if (!isDeepStrictEqual(duplicate.transaction, txNormalized)) {
        throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different transaction');
      }
      return duplicate.reward;
    }
    if (transaction.kind === 'refund') {
      if (!transaction.refundOfId) throw new RewardServiceError('INVALID_REFUND', 'refund requires refundOfId');
      const original = visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId);
      if (!original) throw new RewardServiceError('INVALID_REFUND', 'refundOfId does not reference a recorded transaction');
      originalRecord = original;
      if (original.transaction.kind !== 'purchase') throw new RewardServiceError('INVALID_REFUND', 'refund must reference a purchase');
      if (original.transaction.amount.currency !== transaction.amount.currency) {
        throw new RewardServiceError('INVALID_REFUND', 'refund currency must match original transaction');
      }
      if (!fundingMatches(original.transaction, transaction)) {
        throw new RewardServiceError('INVALID_REFUND', 'refund must reference a transaction for the same funding instrument');
      }
      const originalAmount = original.transaction.amount.amountMinor;
      const alreadyRefunded = state.transactions
        .filter((record) => record.ownerUser === this.metadataUser && record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + record.transaction.amount.amountMinor, 0);
      const refundableAmount = Math.max(0, originalAmount - alreadyRefunded);
      const refundAmount = Math.min(transaction.amount.amountMinor, refundableAmount);
      if (refundAmount <= 0) throw new RewardServiceError('INVALID_REFUND', 'refund exceeds the original purchase amount');
      const originalReward = Math.max(0, original.reward?.cappedReward?.amountMinor ?? 0);
      const rewardAlreadyRefunded = state.transactions
        .filter((record) => record.ownerUser === this.metadataUser && record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + Math.max(0, -(record.reward?.cappedReward?.amountMinor ?? 0)), 0);
      const rewardToReverse = originalAmount > 0 ? Math.min(originalReward - rewardAlreadyRefunded, Math.floor((originalReward * refundAmount) / originalAmount)) : 0;
      transaction = {
        ...original.transaction,
        ...transaction,
        amount: { ...transaction.amount, amountMinor: refundAmount },
        originalRewardMinor: rewardToReverse,
        ...(original.transaction.fx ? { fx: original.transaction.fx } : {}),
      };
      if (original.appliedFx) {
        appliedFx = { ...original.appliedFx, appliedAtUtc: nowIso() };
      } else if (original.transaction.fx) {
        appliedFx = freezeAppliedFxRate(original.transaction.fx, nowIso());
      }
    }
    const card = transaction.cardId ? state.cards.find((item) => item.id === transaction.cardId) : undefined;
    // A non-card transaction has no card-reward evaluation path. Its audit record must
    // not inherit FX requirements from unrelated active card rules.
    const rules = card
      ? state.rules.filter((rule) => rule.status === 'active' && rule.cardId === card.id)
      : [];
    const foreignRule = rules.some((rule) => rule.settlementCurrency !== transaction.amount.currency);
    if (transaction.kind !== 'refund' && foreignRule) {
      if (!transaction.fx) {
        const fxResolutionRequest = buildFxResolutionRequest({
          transaction,
          rules,
          card,
        });
        throw new RewardServiceError('fx_missing', 'missing FX snapshot for settlement currency', {
          code: 'fx_missing',
          path: 'transaction.fx',
          requiredFacts: fxResolutionRequest.requiredFacts,
          retryAction: fxResolutionRequest.retryAction,
          fxResolutionRequest,
        });
      }
      if (transaction.fx.baseCurrency !== transaction.amount.currency) {
        throw new RewardServiceError('INVALID_INPUT', 'transaction.fx.baseCurrency does not match transaction amount currency');
      }
      if (transaction.mode === 'actual' && transaction.fx.rateType === 'mid_market') {
        throw new RewardServiceError('NEEDS_REVIEW', 'mid_market rate cannot be used for actual transaction settlement; use card_scheme or cash_selling rate');
      }
      if (transaction.mode === 'actual' && !isFxFresh(transaction.fx, transaction.occurredAt)) {
        const fxResolutionRequest = buildFxResolutionRequest({
          transaction,
          rules,
          card,
          cardScheme: card?.network,
        });
        throw new RewardServiceError('fx_stale', 'FX snapshot is stale for actual transaction settlement; refresh exchange rate', {
          code: 'fx_stale',
          path: 'transaction.fx.capturedAt',
          requiredFacts: ['transaction.fx.capturedAt'],
          retryAction: 'refresh_fx_snapshot',
          fxResolutionRequest,
        });
      }
      const actualContext: FxEvaluationContext = {
        baseCurrency: transaction.amount.currency,
        quoteCurrency: (transaction.routeContext?.settlementCurrency ?? (card?.country === 'TW' ? 'TWD' : 'TWD')),
        conversionOwner: deriveConversionOwner({ routeContext: transaction.routeContext, route: transaction.route, card }),
        cardScheme: card?.network,
        cardId: card?.id,
        issuer: card?.issuer,
        routeId: transaction.routeId,
        asOf: transaction.occurredAt,
        requireFresh: true,
      };
      if (!isFxCompatible({ snapshot: transaction.fx, context: actualContext })) {
        const fxResolutionRequest = buildFxResolutionRequest({
          transaction,
          rules,
          card,
          cardScheme: card?.network,
        });
        throw new RewardServiceError('NEEDS_REVIEW', 'supplied FX snapshot is incompatible with transaction clearing context', {
          code: 'fx_conflict',
          path: 'transaction.fx',
          requiredFacts: ['transaction.fx'],
          retryAction: fxResolutionRequest.retryAction,
          fxResolutionRequest,
        });
      }
      appliedFx = freezeAppliedFxRate(transaction.fx, nowIso(), deriveConversionOwner({ routeContext: transaction.routeContext, route: transaction.route, card }));
    }
    const evaluationTransaction = transaction.kind === 'refund'
      ? { ...transaction, occurredAt: visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId)?.transaction.occurredAt ?? transaction.occurredAt }
      : transaction;
    const context = this.context(state, evaluationTransaction.occurredAt, evaluationTransaction);
    const storedTransaction: TransactionTuple = {
      ...(transaction.kind === 'refund' && originalRecord?.transaction.fx ? { ...requestedTransaction, fx: originalRecord.transaction.fx } : requestedTransaction),
      recordedAt,
    };
    let reward: RewardBreakdown;
    if (transaction.kind === 'refund') {
      const originalRewardBreakdown = originalRecord?.reward;
      const originalRewardMinor = transaction.originalRewardMinor ?? 0;
      reward = {
        status: originalRewardBreakdown?.status ?? 'unknown',
        ...(originalRewardBreakdown?.cardId ? { cardId: originalRewardBreakdown.cardId } : (transaction.cardId ? { cardId: transaction.cardId } : {})),
        transaction: storedTransaction,
        unknownReasons: originalRewardBreakdown?.unknownReasons ?? [],
        ...(originalRewardBreakdown?.ruleId ? { ruleId: originalRewardBreakdown.ruleId } : {}),
        ...(originalRewardBreakdown?.ruleVersion ? { ruleVersion: originalRewardBreakdown.ruleVersion } : {}),
        ...(originalRewardBreakdown?.sourceSnapshotId ? { sourceSnapshotId: originalRewardBreakdown.sourceSnapshotId } : {}),
        ...(originalRewardMinor > 0 ? {
          grossReward: { amountMinor: -originalRewardMinor, currency: transaction.amount.currency },
          cappedReward: { amountMinor: -originalRewardMinor, currency: transaction.amount.currency },
        } : {}),
      };
    } else {
      const evaluated = card ? rankCards([card], state.rules, evaluationTransaction, context, 1)[0] : undefined;
      const isFxMissing = evaluated?.diagnostics?.some((d) => d.code === 'fx_missing') || evaluated?.unknownReasons?.some((r) => r.includes('missing FX snapshot'));
      if (isFxMissing) {
        const fxResolutionRequest = buildFxResolutionRequest({ transaction: evaluationTransaction, rules, card });
        throw new RewardServiceError('fx_missing', 'missing FX snapshot for settlement currency', {
          code: 'fx_missing',
          path: 'transaction.fx',
          requiredFacts: fxResolutionRequest.requiredFacts,
          retryAction: fxResolutionRequest.retryAction,
          fxResolutionRequest,
        });
      }
      if (evaluated) {
        reward = { ...evaluated, transaction: storedTransaction };
      } else {
        reward = {
          status: 'unknown',
          ...(transaction.cardId ? { cardId: transaction.cardId } : {}),
          transaction: storedTransaction,
          unknownReasons: card ? ['no usable offer rule'] : ['non-card funding or no registered card'],
        };
      }
    }
    const appliedAtUtc = nowIso();
    const originalComponents = transaction.kind === 'refund' && transaction.refundOfId
      ? state.rewardComponents.filter((component) => component.transactionId === transaction.refundOfId && visibleTransactions.some((record) => record.transaction.idempotencyKey === component.transactionId))
      : [];
    const sourceComponents = reward.status === 'ok'
      ? (reward.components?.length ? reward.components : (reward.ruleId && reward.ruleVersion && reward.sourceSnapshotId ? [{ kind: 'card_issuer' as const, ruleId: reward.ruleId, ruleVersion: reward.ruleVersion, sourceSnapshotId: reward.sourceSnapshotId, reward: reward.cappedReward, unit: reward.cappedReward?.currency ?? 'TWD', confidence: 'confirmed' as const }] : []))
      : [];
    const componentRecords: RewardComponentRecord[] = originalComponents.length
      ? originalComponents.map((component) => {
        const originalAmount = originalRecord?.transaction.amount.amountMinor ?? transaction.amount.amountMinor;
        const previousRefundAmount = visibleTransactions.filter((record) => record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId).reduce((sum, record) => sum + record.transaction.amount.amountMinor, 0);
        const previousReversed = state.rewardComponents.filter((record) => record.transactionId !== transaction.refundOfId && record.ruleId === component.ruleId && visibleTransactions.some((txRecord) => txRecord.transaction.idempotencyKey === record.transactionId && txRecord.transaction.refundOfId === transaction.refundOfId)).reduce((sum, record) => sum + Math.abs(record.reward.value), 0);
        const isFinal = previousRefundAmount + transaction.amount.amountMinor >= originalAmount;
        const reversed = isFinal ? Math.max(0, component.reward.value - previousReversed) : Math.floor((component.reward.value * transaction.amount.amountMinor) / originalAmount);
        const capUsages = component.capUsages.map((usage) => {
          const prior = state.rewardComponents.filter((record) => record.transactionId !== transaction.refundOfId && record.ruleId === component.ruleId && visibleTransactions.some((txRecord) => txRecord.transaction.idempotencyKey === record.transactionId && txRecord.transaction.refundOfId === transaction.refundOfId)).flatMap((record) => record.capUsages).filter((entry) => entry.poolId === usage.poolId && entry.periodKey === usage.periodKey).reduce((sum, entry) => sum + Math.abs(entry.consumedAmount), 0);
          const restored = isFinal ? Math.max(0, usage.consumedAmount - prior) : Math.floor((usage.consumedAmount * transaction.amount.amountMinor) / originalAmount);
          return { ...usage, consumedAmount: -restored };
        });
        return { ...component, componentId: componentId(requestedTransaction.idempotencyKey!, component.ruleId, component.ruleVersion), transactionId: requestedTransaction.idempotencyKey!, reward: { ...component.reward, value: -reversed }, capUsages, appliedAtUtc };
      })
      : sourceComponents.map((component) => {
        const appliedRule = state.rules.find((candidate) => candidate.id === component.ruleId);
        const capUsages = (appliedRule?.capPoolRefs ?? []).flatMap((poolId) => {
          const pool = state.capPools.find((candidate) => candidate.id === poolId);
          if (!pool) return [];
          const kind = pool.period === 'billing_cycle' ? 'billing_cycle' : pool.period === 'campaign' ? 'campaign' : 'calendar_month';
          const periodKey = resolveCyclePeriodKey(card, { kind, cap: { amountMinor: pool.limit, currency: pool.currency ?? appliedRule?.settlementCurrency ?? transaction.amount.currency }, usageKey: pool.id, capPoolId: pool.id, metric: pool.metric, timezone: pool.timezone }, transaction.occurredAt);
          const consumedAmount = pool.metric === 'reward' ? (component.reward?.amountMinor ?? 0) : pool.metric === 'transaction_count' ? 1 : transaction.amount.amountMinor;
          return [{ poolId, periodKey, metric: pool.metric, consumedAmount }];
        });
        return { componentId: componentId(requestedTransaction.idempotencyKey!, component.ruleId, component.ruleVersion), transactionId: requestedTransaction.idempotencyKey!, ruleId: component.ruleId, ruleVersion: component.ruleVersion, route: component.kind === 'merchant_loyalty' ? 'merchant' : component.kind === 'payment_provider' ? 'payment_provider' : 'card_issuer', ...(component.kind === 'payment_provider' ? { provider: requestedTransaction.route?.providerId } : {}), reward: { value: component.reward?.amountMinor ?? 0, unitType: 'currency', unitName: component.unit, ...(component.reward?.currency ? { currency: component.reward.currency } : {}) }, capUsages, appliedAtUtc };
      });
    const record: RecordedTransaction = {
      transaction: storedTransaction,
      reward: { ...reward, transaction: storedTransaction },
      recordedAt,
      ...(appliedFx ? { appliedFx } : {}),
      ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }),
    };
    this.store.update((next) => {
      next.transactions.push(record);
      next.rewardComponents.push(...componentRecords);
    });
    return record.reward;
  }

  listTransactions(options: ListTransactionsOptions = {}): ListTransactionsResult {
    const validated = validateListTransactionsOptions(options);
    const state = this.store.read();
    const visible = this.visibleTransactions(state);
    const timeBasis = validated.timeBasis ?? 'occurred_at';
    const getTime = (rec: RecordedTransaction): string => {
      if (timeBasis === 'recorded_at') {
        return rec.transaction.recordedAt ?? rec.recordedAt ?? rec.transaction.occurredAt;
      }
      return rec.transaction.occurredAt;
    };
    const filtered = visible.filter((rec) => {
      const t = getTime(rec);
      if (validated.startDate && Date.parse(t) < Date.parse(validated.startDate)) return false;
      if (validated.endDate && Date.parse(t) > Date.parse(validated.endDate)) return false;
      if (validated.fundingKind) {
        const kind = rec.transaction.funding?.kind ?? (rec.transaction.cardId ? 'credit_card' : undefined);
        if (kind !== validated.fundingKind) return false;
      }
      if (validated.cardId) {
        const cId = rec.transaction.cardId ?? (rec.transaction.funding?.kind === 'credit_card' ? rec.transaction.funding.cardId : undefined);
        if (cId !== validated.cardId) return false;
      }
      return true;
    });

    const projection = validated.projection ?? 'summary';
    const sortKey = (item: unknown): string => {
      const idKey = (item as { idempotencyKey?: string; transaction?: { idempotencyKey?: string } }).idempotencyKey
        ?? (item as { transaction?: { idempotencyKey?: string } }).transaction?.idempotencyKey
        ?? '';
      const timeVal = (item as { occurredAt?: string; recordedAt?: string; transaction?: { occurredAt: string; recordedAt?: string } });
      const time = timeBasis === 'recorded_at'
        ? (timeVal.recordedAt ?? timeVal.transaction?.recordedAt ?? timeVal.occurredAt ?? timeVal.transaction?.occurredAt ?? '')
        : (timeVal.occurredAt ?? timeVal.transaction?.occurredAt ?? '');
      return `${time}_${idKey}`;
    };

    const projected: TransactionListItem[] = filtered.map((rec) => {
      if (projection === 'detail') {
        const components = state.rewardComponents.filter((c) => c.transactionId === rec.transaction.idempotencyKey);
        const capUsages = components.flatMap((c) => c.capUsages);
        const route = rec.transaction.route ?? (rec.transaction.routeId ? state.paymentRoutes.find((r) => r.id === rec.transaction.routeId) : undefined);
        const detail: TransactionDetailItem = {
          transaction: rec.transaction,
          reward: rec.reward,
          ...(rec.appliedFx ? { appliedFx: rec.appliedFx } : {}),
          ...(components.length ? { components, capUsages } : {}),
          ...(route ? { route } : {}),
        };
        return detail;
      }
      const tx = rec.transaction;
      const funding: FundingInstrument = tx.funding ?? (tx.cardId ? { kind: 'credit_card', cardId: tx.cardId } : { kind: 'cash' });
      const summary: TransactionSummaryItem = {
        ...(tx.idempotencyKey ? { idempotencyKey: tx.idempotencyKey } : {}),
        occurredAt: tx.occurredAt,
        ...(tx.recordedAt ? { recordedAt: tx.recordedAt } : {}),
        kind: tx.kind,
        amount: tx.amount,
        funding,
        ...(tx.cardId ? { cardId: tx.cardId } : {}),
        ...(tx.merchant ? { merchant: tx.merchant } : {}),
        ...(tx.channel ? { channel: tx.channel } : {}),
        ...(rec.reward?.status ? { rewardStatus: rec.reward.status } : {}),
        ...(rec.reward?.cappedReward ? { rewardAmount: rec.reward.cappedReward } : {}),
        ...(tx.refundOfId ? { refundOfId: tx.refundOfId } : {}),
      };
      return summary;
    });

    const paged = projectPage(projected, {
      page: validated.page ?? 1,
      limit: validated.limit ?? 20,
      maxItems: 50,
      maxBytes: 256 * 1024,
      evaluatedAt: nowIso(),
      dataVersion: contentHash(JSON.stringify(projected)).slice(0, 16),
      sortKey,
    });

    return {
      transactions: paged.items,
      items: paged.items,
      pageInfo: paged.pageInfo,
    };
  }

  remainingCaps(cardId: string, asOf = nowIso()): RemainingCap[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(cardId)) throw new RewardServiceError('INVALID_INPUT', 'cardId is invalid');
    const state = this.store.read();
    const card = state.cards.find((c) => c.id === cardId);
    const cardRules = state.rules.filter((rule) => rule.cardId === cardId && Boolean(rule.capPoolRefs?.length));
    const uniquePoolIds = [...new Set(cardRules.flatMap((rule) => rule.capPoolRefs ?? []))];

    return uniquePoolIds.map((poolId) => {
      const pool = state.capPools.find((p) => p.id === poolId);
      if (!pool) throw new RewardServiceError('INVALID_OFFER', `missing cap pool ${poolId}`);
      const matchingRule = cardRules.find((r) => r.capPoolRefs?.includes(poolId));
      const currency = pool.currency ?? matchingRule?.settlementCurrency ?? 'TWD';
      const kind = pool.period === 'billing_cycle' ? 'billing_cycle' : pool.period === 'campaign' ? 'campaign' : 'calendar_month';
      if (!pool.timezone) throw new RewardServiceError('INSUFFICIENT_FACTS', `timezone is required for cap pool ${poolId}`);
      const capPeriod: CapPeriod = { kind, cap: { amountMinor: pool.limit, currency }, usageKey: pool.id, capPoolId: pool.id, metric: pool.metric, timezone: pool.timezone };
      const periodKey = resolveCyclePeriodKey(card, capPeriod, asOf);

      let used = 0;
      for (const record of this.visibleTransactions(state)) {
        if (record.transaction.mode !== 'actual') continue;
        const txRuleIds = record.reward.components?.map((component) => component.ruleId) ?? (record.reward.ruleId ? [record.reward.ruleId] : []);
        const txRules = txRuleIds.map((id) => state.rules.find((r) => r.id === id)).filter((r): r is OfferRuleVersion => Boolean(r));
        if (!txRules.some((r) => r.capPoolRefs?.includes(poolId))) continue;
        const txCard = state.cards.find((c) => c.id === txRules[0]?.cardId) ?? card;
        if (resolveCyclePeriodKey(txCard, capPeriod, record.transaction.occurredAt) !== periodKey) continue;
        if (pool.metric === 'transaction_count') {
          used += record.transaction.kind === 'refund' ? -1 : 1;
        } else if (pool.metric === 'spend') {
          const amount = convertMinor(record.transaction.amount, currency, record.transaction);
          if (amount !== undefined) {
            used += record.transaction.kind === 'refund' ? -amount : amount;
          }
        } else {
          const componentRewards = record.reward.components?.filter((component) => txRules.some((r) => r.id === component.ruleId && r.capPoolRefs?.includes(poolId))).map((component) => component.reward).filter((reward): reward is Money => Boolean(reward)) ?? [];
          const reward = componentRewards.length ? componentRewards.reduce((sum, item) => sum + (convertMinor(item, currency, record.transaction) ?? 0), 0) : (record.reward.cappedReward ? convertMinor(record.reward.cappedReward, currency, record.transaction) : 0);
          if (reward !== undefined) used += record.transaction.kind === 'refund' ? -Math.abs(reward) : reward;
        }
      }

      return {
        ruleId: matchingRule?.id ?? pool.id,
        usageKey: pool.id,
        remaining: { amountMinor: Math.max(0, pool.limit - used), currency },
      };
    });
  }

}
