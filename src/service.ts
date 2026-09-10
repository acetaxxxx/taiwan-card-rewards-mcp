import * as crypto from 'node:crypto';
import { type LedgerStore, type RecordedTransaction, type StoredState } from './store.js';
import { EventRewardLedger, convertMinor, createPaymentEventRewardCandidate, decidePaymentEventRewards, evaluateOffer, evaluatePredicate, matchPaymentEvent, matchPaymentEventChain, rankCards, resolveCyclePeriodKey } from './evaluator.js';
import type { CardDescriptor, CardSwitchInput, CardSwitchProjection, CardSwitchStatus, CapPeriod, CapPoolDefinition, EvaluationContext, MerchantIdentity, MerchantResolution, Money, OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, RankingEntry, RewardBreakdown, RewardComponentRecord, TransactionTuple, UserBenefitInput, UserBenefitStatus, RecommendationPreflight, RecommendationRequiredAction, RecommendationRequirement, Diagnostic, EvidenceRecord, PaymentRouteRecord, PaymentCapabilityRecord, PaymentAccountRecord, EventRewardLedgerRecord, EventRewardReversalRecord, PaymentPathRequest, PaymentPathRecommendation, PaymentPathCandidate, PaymentPathEvent, EligibilityFact, RewardValuationSnapshot, FxResolutionRequest, FxRateObservation, AppliedFxRate, RecommendationIntent, RecommendationIntentResult, IntentCandidate, FxPolicyRecord, FxPolicyResearchRequest, FxObservationRecord, FxSnapshot } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateCapPool, validateConfirmation, validateEligibilityFact, validateMerchant, validateRecommendationTransaction, validateRule, validateSnapshot, validateTransaction, validateEvidence, validateFactCandidate, validatePaymentRouteRecord, validatePaymentCapability, validatePaymentAccountRecord, validateEventRewardInput, validatePaymentEvent, validatePaymentEventChainRule, validatePaymentEventRule, validateRewardValuationSnapshot, validateFxPolicy, validateFxObservation } from './validation.js';
import { cardSwitchStatus, projectionFromInput } from './card-switch.js';
import { buildFxResolutionRequest, freezeAppliedFxRate, deriveConversionOwner } from './fx.js';
import { validateRecommendationIntent } from './validation.js';

export { RewardServiceError } from './errors.js';

export interface RemainingCap { ruleId: string; usageKey: string; remaining: Money; }

type MerchantOnboardingInput = Omit<MerchantIdentity, 'canonicalId'> & { canonicalId?: string };

function nowIso(): string { return new Date().toISOString(); }
function componentId(transactionId: string, ruleId: string, version: string): string { return `${encodeURIComponent(transactionId)}:${encodeURIComponent(ruleId)}:${encodeURIComponent(version)}`; }
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

export class RewardService {
  constructor(readonly store: LedgerStore, readonly metadataUser: string | undefined) {}

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
    if (Object.keys(source).some((key) => !['event', 'sourceEvents', 'rule', 'chainRule', 'candidate', 'idempotencyKey'].includes(key))) throw new RewardServiceError('UNKNOWN_FIELD', 'validated event reward contains unsupported field');
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
    if (Object.keys(source).some((key) => !['event', 'idempotencyKey'].includes(key))) throw new RewardServiceError('UNKNOWN_FIELD', 'event reward reversal contains unsupported field');
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

  upsertFxPolicy(input: unknown): FxPolicyRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'FX policy requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validateFxPolicy({ ...source, id: source.id ?? 'policy_input' });
    const state = this.store.read();
    const evidence = state.evidence.find((candidate) => candidate.id === parsed.evidenceId && candidate.ownerUser === this.metadataUser);
    if (!evidence || evidence.sourceType !== 'official' || evidence.reviewState !== 'accepted' || evidence.authority === 'user') throw new RewardServiceError('NEEDS_REVIEW', 'FX policy requires accepted official evidence owned by the current user');
    const existing = (state.fxPolicies ?? []).find((candidate) => candidate.ownerUser === this.metadataUser && candidate.idempotencyKey === parsed.idempotencyKey);
    const desired = { ...parsed, id: existing?.id ?? ownedId('fxp'), ownerUser: this.metadataUser };
    if (existing) { if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different FX policy'); return existing; }
    this.store.update((next) => { next.fxPolicies = [...(next.fxPolicies ?? []), desired]; });
    return desired;
  }

  listFxPolicies(): readonly FxPolicyRecord[] {
    if (!this.metadataUser) return [];
    return (this.store.read().fxPolicies ?? []).filter((policy) => policy.ownerUser === this.metadataUser);
  }

  upsertFxObservation(input: unknown): FxObservationRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'FX observation requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validateFxObservation({ ...source, id: source.id ?? 'observation_input' });
    if (!parsed.sourceUrl?.startsWith('https://') || !parsed.contentHash) throw new RewardServiceError('INVALID_INPUT', 'FX observation requires an HTTPS sourceUrl and contentHash');
    const state = this.store.read();
    const existing = (state.fxObservations ?? []).find((candidate) => candidate.ownerUser === this.metadataUser && candidate.idempotencyKey === parsed.idempotencyKey);
    const desired = { ...parsed, id: existing?.id ?? ownedId('fxp'), ownerUser: this.metadataUser };
    if (existing) { if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different FX observation'); return existing; }
    this.store.update((next) => { next.fxObservations = [...(next.fxObservations ?? []), desired]; });
    return desired;
  }

  listFxObservations(): readonly FxObservationRecord[] {
    if (!this.metadataUser) return [];
    return (this.store.read().fxObservations ?? []).filter((observation) => observation.ownerUser === this.metadataUser);
  }

  upsertPaymentCapability(input: unknown): PaymentCapabilityRecord {
    if (!this.metadataUser) throw new RewardServiceError('UNAUTHENTICATED', 'payment capability requires an authenticated user');
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validatePaymentCapability({ ...source, id: source.id ?? 'capability_input', status: source.status ?? 'active' });
    const state = this.store.read();
    const evidence = parsed.evidenceIds.map((id) => state.evidence.find((candidate) => candidate.id === id && candidate.ownerUser === this.metadataUser));
    if (evidence.some((candidate) => !candidate || candidate.sourceType !== 'official' || candidate.reviewState !== 'accepted')) throw new RewardServiceError('NEEDS_REVIEW', 'payment capability requires accepted official evidence owned by the current user');
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
      if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different payment route'); return existing;
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

  private context(state: StoredState, now = nowIso(), forTransaction?: TransactionTuple): EvaluationContext {
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
    const offers = state.rules.filter((rule) => {
      if (rule.status !== 'active' || (input.cardId && rule.cardId !== input.cardId)) return false;
      const source = state.snapshots.find((snapshot) => snapshot.id === rule.sourceSnapshotId);
      if (!source?.verified || Date.parse(rule.validFrom) > Date.parse(asOf) || (rule.validTo && Date.parse(rule.validTo) < Date.parse(asOf))) return false;
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
    const conf = confirmation
      ? validateConfirmation(confirmation)
      : (rule.confirmation ? validateConfirmation(rule.confirmation) : undefined);

    if (conf) {
      const sourceRef = conf.sourceReference.toLowerCase();
      const snapshotUrl = snapshot.url.toLowerCase();
      const provUrl = snapshot.provenance?.sourceUrl?.toLowerCase();
      const provDesc = snapshot.provenance?.sourceDescription?.toLowerCase();
      const matchesSource =
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
      rule = { ...rule, status: 'active', confirmation: conf };
      snapshot = { ...snapshot, verified: true };
    }

    if (!snapshot.id || !snapshot.url || !snapshot.contentHash || !snapshot.parserVersion) throw new RewardServiceError('INVALID_OFFER', 'source snapshot metadata is incomplete');
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
          existingSnapshot.url !== snapshot.url ||
          existingSnapshot.contentHash !== snapshot.contentHash ||
          existingSnapshot.parserVersion !== snapshot.parserVersion ||
          JSON.stringify(existingSnapshot.provenance) !== JSON.stringify(snapshot.provenance)
        ) {
          throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable source snapshot');
        }
      }
      const existingRule = state.rules.find((item) => item.id === storedRule.id && item.version === storedRule.version);
      if (existingRule) {
        const { confirmation: c1, status: s1, ...r1 } = existingRule;
        const { confirmation: c2, status: s2, ...r2 } = storedRule;
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable rule version');
        }
      }
      const snapshotIndex = state.snapshots.findIndex((item) => item.id === snapshot.id);
      if (snapshotIndex >= 0) state.snapshots[snapshotIndex] = snapshot;
      else state.snapshots.push(snapshot);
      const ruleIndex = state.rules.findIndex((item) => item.id === storedRule.id);
      if (ruleIndex >= 0) state.rules[ruleIndex] = storedRule;
      else state.rules.push(storedRule);
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
    const result = this.upsertOffer(snapshot, rule, confirmation);
    return result.rule;
  }

  preflightRecommendation(transaction: unknown, options: { context?: EvaluationContext } = {}): RecommendationPreflight {
    const state = this.store.read();
    let parsed: TransactionTuple;
    try {
      parsed = validateRecommendationTransaction(transaction);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'invalid recommendation transaction';
      const dataVersion = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
      return { ready: false, knownFacts: [], requirements: [{ id: 'transaction', category: 'transaction', path: 'transaction', status: 'invalid', retryAction: 'fix_payload' }], requiredActions: [{ action: 'ask_user', path: 'transaction', requiredFacts: [message] }], diagnostics: [{ code: 'invalid_input', path: 'transaction', requiredFacts: [message], retryAction: 'fix_payload' }], evaluatedAt: options.context?.now ?? nowIso(), dataVersion };
    }
    const evaluatedAt = options.context?.now ?? parsed.occurredAt;
    const requirements: RecommendationRequirement[] = [];
    const requiredActions: RecommendationRequiredAction[] = [];
    const diagnostics: Diagnostic[] = [];
    const knownFacts = ['transaction:amount', 'transaction:occurredAt'];
    let resolvedMerchantId: string | undefined;
    const card = parsed.cardId ? state.cards.find((candidate) => candidate.id === parsed.cardId) : undefined;
    if (card) knownFacts.push(`card:${card.id}`);
    else if (parsed.cardId) {
      requirements.push({ id: 'card', category: 'card', path: 'transaction.cardId', status: 'missing', retryAction: 'register_card' });
      diagnostics.push({ code: 'missing_required_fact', path: 'transaction.cardId', requiredFacts: ['transaction.cardId'], retryAction: 'register_card' });
      requiredActions.push({ action: 'ask_user', path: 'transaction.cardId', requiredFacts: ['transaction.cardId'] });
    }
    if (parsed.routeId) {
      const route = state.paymentRoutes.find((candidate) => candidate.id === parsed.routeId && (candidate.ownerUser === this.metadataUser || (candidate.ownerUser === undefined && this.metadataUser === undefined)));
      if (!route) {
        requirements.push({ id: 'route', category: 'payment_route', path: 'transaction.routeId', status: 'missing', retryAction: 'register_payment_route' });
        diagnostics.push({ code: 'missing_required_fact', path: 'transaction.routeId', requiredFacts: ['registered payment route'], retryAction: 'register_payment_route' });
        requiredActions.push({ action: 'register_payment_route', path: 'transaction.routeId', requiredFacts: ['registered payment route'] });
      } else if (route.status !== 'active' || (route.validTo && Date.parse(route.validTo) < Date.parse(evaluatedAt))) {
        requirements.push({ id: 'route', category: 'payment_route', path: 'transaction.routeId', status: route.status === 'conflict' ? 'conflict' : 'stale', retryAction: 'refresh_external_data' });
        diagnostics.push({ code: route.status === 'conflict' ? 'needs_review' : 'stale_rule', path: 'transaction.routeId', requiredFacts: ['active current payment route'], retryAction: 'refresh_external_data' });
        requiredActions.push({ action: 'refresh_external_data', path: 'transaction.routeId', requiredFacts: ['active current payment route'] });
      } else knownFacts.push(`route:${route.id}`);
    }
    const rules = state.rules.filter((rule) => rule.status === 'active' && (!card || rule.cardId === card.id));
    const merchantSpecific = rules.some((rule) => Boolean(rule.match.merchants?.length));
    if (parsed.merchant && merchantSpecific) {
      const resolution = this.resolveMerchant(parsed.merchant, { ...(parsed.country ? { country: parsed.country } : {}) });
      if (resolution.resolutionStatus !== 'confirmed') {
        requirements.push({ id: 'merchant', category: 'merchant_identity', path: 'transaction.merchant', status: resolution.resolutionStatus === 'ambiguous' ? 'needs_review' : 'missing', retryAction: 'resolve_merchant' });
        diagnostics.push({ code: 'merchant_ambiguous', path: 'transaction.merchant', requiredFacts: ['transaction.market'], retryAction: 'resolve_merchant' });
        requiredActions.push({ action: 'resolve_merchant', path: 'transaction.merchant', requiredFacts: ['transaction.market'] });
      } else { resolvedMerchantId = resolution.merchant!.canonicalId; knownFacts.push(`merchant:${resolvedMerchantId}`); }
    }
    if (!rules.length && card) {
      requirements.push({ id: 'offer', category: 'offer_rule', path: 'rules', status: 'needs_review', retryAction: 'review_offer' });
      diagnostics.push({ code: 'needs_review', path: 'rules', requiredFacts: ['verified active offer rule'], retryAction: 'review_offer' });
      requiredActions.push({ action: 'review_offer', path: 'rules', requiredFacts: ['verified active offer rule'] });
    }
    if (resolvedMerchantId && !rules.some((rule) => rule.match.merchants?.includes(resolvedMerchantId!))) {
      diagnostics.push({ code: 'no_active_offer', path: 'transaction.merchant', requiredFacts: [], retryAction: 'continue_with_base_rule' });
    }
    for (const rule of rules) {
      const snapshot = state.snapshots.find((candidate) => candidate.id === rule.sourceSnapshotId);
      if (!snapshot?.verified) {
        requirements.push({ id: `source:${rule.id}`, category: 'offer_source', path: `rules.${rule.id}.sourceSnapshotId`, status: 'needs_review', retryAction: 'review_offer' });
        diagnostics.push({ code: 'source_untrusted', path: `rules.${rule.id}.sourceSnapshotId`, requiredFacts: ['verified offer source'], retryAction: 'review_offer' });
        requiredActions.push({ action: 'review_offer', path: `rules.${rule.id}`, requiredFacts: ['verified offer source'] });
      }
      if (Date.parse(rule.validFrom) > Date.parse(evaluatedAt) || (rule.validTo !== undefined && Date.parse(rule.validTo) < Date.parse(evaluatedAt))) {
        requirements.push({ id: `rule:${rule.id}`, category: 'offer_rule', path: `rules.${rule.id}`, status: 'stale', retryAction: 'refresh_external_data' });
        diagnostics.push({ code: 'stale_rule', path: `rules.${rule.id}`, requiredFacts: ['current offer rule'], retryAction: 'refresh_external_data' });
        requiredActions.push({ action: 'refresh_external_data', path: `rules.${rule.id}`, requiredFacts: ['current offer rule'] });
      }
    }
    for (const evidence of state.evidence) {
      const relevant = evidence.requirementId.startsWith('fx') || evidence.requirementId.includes(parsed.cardId ?? '') || evidence.requirementId.includes(parsed.merchant ?? '');
      if (!relevant) continue;
      if (evidence.reviewState === 'conflict') {
        requirements.push({ id: `evidence:${evidence.id}`, category: 'external_data', path: `evidence.${evidence.id}`, status: 'conflict', retryAction: 'submit_evidence' });
        diagnostics.push({ code: evidence.requirementId.startsWith('fx') ? 'fx_conflict' : 'needs_review', path: `evidence.${evidence.id}`, requiredFacts: ['resolved evidence'], retryAction: 'submit_evidence' });
        requiredActions.push({ action: 'submit_evidence', path: `evidence.${evidence.id}`, requiredFacts: ['resolved evidence'] });
      } else if (evidence.refreshAfter !== undefined && Date.parse(evidence.refreshAfter) <= Date.parse(evaluatedAt)) {
        requirements.push({ id: `evidence:${evidence.id}`, category: 'external_data', path: `evidence.${evidence.id}`, status: 'stale', retryAction: 'refresh_external_data' });
        diagnostics.push({ code: evidence.requirementId.startsWith('fx') ? 'fx_stale' : 'stale_rule', path: `evidence.${evidence.id}`, requiredFacts: ['fresh external evidence'], retryAction: 'refresh_external_data' });
        requiredActions.push({ action: 'refresh_external_data', path: `evidence.${evidence.id}`, requiredFacts: ['fresh external evidence'] });
      }
    }
    const foreignRule = rules.some((rule) => rule.settlementCurrency !== parsed.amount.currency);
    let fxResolutionRequest: FxResolutionRequest | undefined;
    if (foreignRule) {
      fxResolutionRequest = buildFxResolutionRequest({
        transaction: parsed,
        rules,
        card,
      });
      if (parsed.routeContext && !parsed.routeContext.conversionOwner) {
        requirements.push({ id: 'route', category: 'payment_route', path: 'transaction.routeContext.conversionOwner', status: 'missing', retryAction: 'ask_user' });
        diagnostics.push({ code: 'missing_required_fact', path: 'transaction.routeContext.conversionOwner', requiredFacts: ['transaction.routeContext.conversionOwner'], retryAction: 'ask_user' });
        requiredActions.push({ action: 'ask_user', path: 'transaction.routeContext.conversionOwner', requiredFacts: ['transaction.routeContext.conversionOwner'] });
      }
      if (!parsed.fx) {
        requirements.push({ id: 'fx', category: 'fx_rate', path: 'transaction.fx', status: 'missing', retryAction: fxResolutionRequest.retryAction });
        diagnostics.push({ code: 'fx_missing', path: 'transaction.fx', requiredFacts: fxResolutionRequest.requiredFacts, retryAction: fxResolutionRequest.retryAction });
        requiredActions.push({ action: fxResolutionRequest.retryAction === 'ask_user' ? 'ask_user' : 'refresh_external_data', path: 'transaction.fx', requiredFacts: fxResolutionRequest.requiredFacts });
      } else if (parsed.fx.baseCurrency !== parsed.amount.currency) {
        requirements.push({ id: 'fx', category: 'fx_rate', path: 'transaction.fx.baseCurrency', status: 'invalid', retryAction: 'rebuild_snapshot' });
        diagnostics.push({ code: 'fx_pair_mismatch', path: 'transaction.fx.baseCurrency', requiredFacts: [`base currency ${parsed.amount.currency}`], retryAction: 'rebuild_snapshot' });
        requiredActions.push({ action: 'refresh_external_data', path: 'transaction.fx', requiredFacts: [`base currency ${parsed.amount.currency}`] });
      } else if (parsed.mode === 'actual' && parsed.fx.rateType === 'mid_market') {
        requirements.push({ id: 'fx', category: 'fx_rate', path: 'transaction.fx.rateType', status: 'needs_review', retryAction: 'query_approved_fx_source' });
        diagnostics.push({ code: 'needs_review', path: 'transaction.fx.rateType', requiredFacts: ['transaction.fx.rateType'], retryAction: 'query_approved_fx_source' });
        requiredActions.push({ action: 'refresh_external_data', path: 'transaction.fx.rateType', requiredFacts: ['transaction.fx.rateType'] });
      }
    }
    const dataVersion = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
    const blocking = diagnostics.some((diagnostic) => diagnostic.code !== 'no_active_offer');
    return { ready: !blocking, knownFacts, requirements, requiredActions, diagnostics, evaluatedAt, dataVersion, ...(fxResolutionRequest ? { fxResolutionRequest } : {}) };
  }

  /** Merchant-first recommendation entry point. It only reads the tenant
   * store; the older transaction-shaped recommend remains unchanged. */
  recommendIntent(value: unknown): RecommendationIntentResult {
    const input = validateRecommendationIntent(value);
    const details = typeof input.merchant === 'string' ? { name: input.merchant } : input.merchant;
    const rawMerchant = details.canonicalId ?? details.name ?? details.rawStatement ?? details.canonicalNameZhHant!;
    const country = input.country ?? details.country;
    const market = input.market ?? details.market;
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
    const resultVersion = crypto.createHash('sha256').update(JSON.stringify({
      state,
      intent: { ...input, cursor: undefined, page: undefined, resultVersion: undefined },
      evaluatedAt,
    })).digest('hex').slice(0, 16);
    if (cursorVersion !== undefined && cursorVersion !== resultVersion) throw new RewardServiceError('INVALID_INPUT', 'recommendation resultVersion changed; restart the recommendation');
    if (input.resultVersion !== undefined && input.resultVersion !== resultVersion) throw new RewardServiceError('INVALID_INPUT', 'recommendation resultVersion changed; restart the recommendation');
    const resolution = this.resolveMerchant(rawMerchant, {
      ...(country ? { country } : {}), ...(market ? { market } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
    });
    const actions: Array<RecommendationIntentResult['requiredActions'][number]> = [];
    const fxPolicyRequests = new Map<string, { request: FxPolicyResearchRequest; candidateIds: Set<string> }>();
    const addAction = (action: RecommendationIntentResult['requiredActions'][number]) => {
      const existing = actions.find((candidate) => candidate.id === action.id);
      if (!existing) { actions.push(action); return; }
      const candidateIds = [...new Set([...(existing.candidateIds ?? []), ...(action.candidateIds ?? [])])].sort();
      if (candidateIds.length) (existing as { candidateIds?: readonly string[] }).candidateIds = candidateIds;
    };
    const registerFxPolicyResearch = (request: FxPolicyResearchRequest, candidateId: string) => {
      const key = JSON.stringify(request.scope);
      const existing = fxPolicyRequests.get(key);
      if (existing) existing.candidateIds.add(candidateId);
      else fxPolicyRequests.set(key, { request, candidateIds: new Set([candidateId]) });
    };
    if (resolution.resolutionStatus !== 'confirmed') addAction({
      id: 'merchant', action: resolution.resolutionStatus === 'ambiguous' ? 'resolve_merchant' : 'research_merchant',
      owner: resolution.resolutionStatus === 'ambiguous' ? 'user' : 'agent',
      path: 'merchant', requiredFacts: ['confirmed merchant identity and market'], submission: { tool: 'recommend', field: 'merchant' },
      completionCondition: 'repeat recommend after merchant identity and market are resolved; without new facts, stop retrying',
    });
    if (!input.amount) addAction({ id: 'amount', action: 'ask_user', owner: 'user', path: 'amount', requiredFacts: ['amount.amountMinor', 'amount.currency'], submission: { tool: 'recommend', field: 'amount' }, completionCondition: 'repeat recommend with a positive amount and currency' });
    const merchant = resolution.merchant?.canonicalId;
    const transaction = input.amount ? validateRecommendationTransaction({
      kind: 'purchase', mode: 'planned', occurredAt: evaluatedAt, amount: input.amount,
      ...(merchant ? { merchant } : {}), ...(country ? { country } : {}),
      ...(input.channel ? { channel: input.channel } : {}),
      ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
      ...(input.fx ? { fx: input.fx } : input.fxObservation ? { fx: input.fxObservation } : {}),
    }) : undefined;
    const context = this.context(state, evaluatedAt, transaction);
    const storedFx = (baseCurrency: string, quoteCurrency: string, card?: CardDescriptor): { observation: FxObservationRecord; stale: boolean } | undefined => {
      const target = Date.parse(evaluatedAt);
      const policy = (state.fxPolicies ?? []).filter((candidate) => candidate.ownerUser === this.metadataUser && candidate.baseCurrency === baseCurrency.toUpperCase() && candidate.quoteCurrency === quoteCurrency.toUpperCase() &&
        ((candidate.scope.kind === 'card' && candidate.scope.cardId === card?.id) || (candidate.scope.kind === 'issuer' && candidate.scope.issuer === card?.issuer)) &&
        (!candidate.validFrom || Date.parse(candidate.validFrom) <= target) && (!candidate.validTo || Date.parse(candidate.validTo) >= target))
        .sort((a, b) => Number(b.scope.kind === 'card') - Number(a.scope.kind === 'card'))[0];
      const maxEstimateAge = (policy?.maxEstimateAgeSeconds ?? 30 * 24 * 3600) * 1000;
      const candidates = (state.fxObservations ?? [])
        .filter((observation) => observation.ownerUser === this.metadataUser && observation.baseCurrency === baseCurrency.toUpperCase() && observation.quoteCurrency === quoteCurrency.toUpperCase())
        .filter((observation) => observation.routeIdScope === undefined && observation.edgeIdScope === undefined)
        .filter((observation) => !policy || (observation.rateType === policy.rateType && (observation.conversionOwner === undefined || observation.conversionOwner === policy.conversionOwner)))
        .filter((observation) => (!observation.cardIdScope || observation.cardIdScope === card?.id) && (!observation.issuerScope || observation.issuerScope === card?.issuer))
        .filter((observation) => { const captured = Date.parse(observation.capturedAt); return Number.isFinite(captured) && captured <= target && target - captured <= maxEstimateAge; })
        .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
      const observation = candidates[0];
      if (!observation) return undefined;
      const age = target - Date.parse(observation.capturedAt);
      const freshFor = (policy?.freshForSeconds ?? observation.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
      return { observation, stale: age > freshFor && age <= maxEstimateAge };
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
        capability.evidenceIds.length > 0 && capability.evidenceIds.every((id) => state.evidence.some((evidence) => evidence.id === id && evidence.ownerUser === this.metadataUser && evidence.sourceType === 'official' && evidence.reviewState === 'accepted' && (!evidence.validFrom || Date.parse(evidence.validFrom) <= Date.parse(evaluatedAt)) && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(evaluatedAt))));
      for (const capability of this.listPaymentCapabilities().filter(validCapability)) {
        const fundingOptions: PaymentRouteRecord['funding'][] = [];
        if (capability.fundingKinds.includes('credit_card')) for (const card of cards) fundingOptions.push({ kind: 'credit_card', cardId: card.id });
        if (capability.fundingKinds.includes('account')) for (const account of state.paymentAccounts.filter((candidate) => candidate.ownerUser === this.metadataUser && candidate.status === 'active')) fundingOptions.push({ kind: 'account', subtype: account.kind, accountId: account.id });
        for (const funding of fundingOptions) {
          if (input.routeIds !== undefined) continue;
          const requiredTransitions = funding.kind === 'credit_card' ? ['wallet_top_up', 'wallet_debit', 'merchant_settlement'] as const : funding.kind === 'account' ? ['account_debit', 'wallet_debit', 'merchant_settlement'] as const : [];
          if (!requiredTransitions.every((transition) => capability.transitions.includes(transition))) continue;
          const seed = funding.kind === 'credit_card' ? funding.cardId! : funding.kind === 'account' ? funding.accountId! : funding.kind;
          const providerNode = { id: 'service', kind: 'payment_service' as const, displayName: capability.consumerAppId ?? capability.providerId };
          const acceptanceNode = { id: 'acceptance', kind: 'acceptance_network' as const, displayName: capability.acceptanceProviderId ?? 'acceptance network' };
          const walletNode = { id: 'wallet', kind: 'wallet_balance' as const, displayName: capability.providerId };
          const nodes = [
            { id: 'funding', kind: 'funding_source' as const, displayName: seed },
            walletNode,
            providerNode, acceptanceNode, { id: 'merchant', kind: 'merchant' as const, displayName: rawMerchant },
          ];
          const evidenceIds = capability.evidenceIds;
          const edges = funding.kind === 'credit_card'
            ? [{ edgeId: 'fund', fromNodeId: 'funding', toNodeId: 'wallet', transition: 'wallet_top_up' as const, evidenceIds }, { edgeId: 'pay', fromNodeId: 'wallet', toNodeId: 'acceptance', transition: 'wallet_debit' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }]
            : [{ edgeId: 'debit', fromNodeId: 'funding', toNodeId: 'wallet', transition: 'account_debit' as const, evidenceIds }, { edgeId: 'pay', fromNodeId: 'wallet', toNodeId: 'acceptance', transition: 'wallet_debit' as const, evidenceIds }, { edgeId: 'settle', fromNodeId: 'acceptance', toNodeId: 'merchant', transition: 'merchant_settlement' as const, evidenceIds }];
          const sourceUrl = capability.sourceUrl ?? state.evidence.find((evidence) => evidence.id === evidenceIds[0])?.sourceUrl;
          generatedRoutes.push({ id: `generated_${capability.id}_${seed}`, status: 'active', layers: [{ kind: 'merchant_acceptance', providerId: capability.acceptanceProviderId ?? capability.providerId }, ...(capability.consumerAppId ? [{ kind: 'consumer_app' as const, appId: capability.consumerAppId }] : []), { kind: 'payment_provider', providerId: capability.providerId }], funding, ...(sourceUrl ? { sourceUrl } : {}), observedAt: capability.observedAt, ...(capability.validFrom ? { validFrom: capability.validFrom } : {}), ...(capability.validTo ? { validTo: capability.validTo } : {}), authority: 'wallet', confidence: 'high', evidenceIds, idempotencyKey: `generated:${capability.id}:${seed}`, nodes, edges });
          generatedCapabilityIds.add(capability.id);
        }
        if (!generatedCapabilityIds.has(capability.id)) {
          const fundingKind = capability.fundingKinds[0]!;
          addAction({ id: `capability:${capability.id}`, action: 'bind_payment_method', owner: 'user', path: `paymentCapabilities.${capability.id}`, requiredFacts: capability.fundingKinds.map((kind) => `held ${kind}`), candidateIds: [], submission: fundingKind === 'credit_card' ? { tool: 'register_card', field: 'card' } : { tool: 'register_payment_account', field: 'account' }, completionCondition: `repeat recommend after registering or binding a ${fundingKind} supported by this payment capability` });
        }
      }
    }
    const routes = [...registeredRoutes, ...generatedRoutes];
    const applicable = (cardId?: string, routeId?: string) => state.rules.filter(rule =>
      rule.status !== 'superseded' &&
      (rule.cardId === undefined || rule.cardId === cardId) &&
      (rule.routeId === undefined || rule.routeId === routeId));
    const projectRule = (rule: OfferRuleVersion, result?: RewardBreakdown): IntentCandidate['matchedRules'][number] => ({
      ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind ?? 'card_issuer',
      sourceSnapshotId: rule.sourceSnapshotId,
      ...(state.snapshots.find(source => source.id === rule.sourceSnapshotId)?.url
        ? { sourceUrl: state.snapshots.find(source => source.id === rule.sourceSnapshotId)!.url } : {}),
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
      const key = [diagnostic, request.baseCurrency, request.quoteCurrency, request.conversionOwner ?? 'unknown', request.purpose ?? '', scope.routeId ?? '', scope.edgeId ?? '', scope.cardId ?? '', scope.issuer ?? ''].join('|');
      const existing = fxRequests.get(key);
      if (existing) existing.candidateIds.add(candidateId);
      else fxRequests.set(key, { request, candidateIds: new Set([candidateId]), diagnostic });
      fxResolutionRequest ??= request;
    };
    if (input.routeIds === undefined) for (const card of cards) {
      const rules = applicable(card.id);
      const ruleQuote = transaction ? rules.find((rule) => rule.settlementCurrency.toUpperCase() !== transaction.amount.currency.toUpperCase())?.settlementCurrency : undefined;
      if (transaction && ruleQuote) {
        const matchingPolicies = (state.fxPolicies ?? []).filter((candidate) => candidate.ownerUser === this.metadataUser &&
          candidate.baseCurrency === transaction.amount.currency.toUpperCase() && candidate.quoteCurrency === ruleQuote.toUpperCase() &&
          ((candidate.scope.kind === 'card' && candidate.scope.cardId === card.id) ||
           (candidate.scope.kind === 'issuer' && candidate.scope.issuer === card.issuer)) &&
          (!candidate.validFrom || Date.parse(candidate.validFrom) <= Date.parse(evaluatedAt)) &&
          (!candidate.validTo || Date.parse(candidate.validTo) >= Date.parse(evaluatedAt)));
        const policySignatures = new Set(matchingPolicies.map((candidate) => JSON.stringify({ conversionOwner: candidate.conversionOwner, rateType: candidate.rateType, rateDirection: candidate.rateDirection, conversionTiming: candidate.conversionTiming, feeBasis: candidate.feeBasis, markupBasis: candidate.markupBasis })));
        if (policySignatures.size > 1) addAction({
          id: `fx-policy-conflict:${card.id}`, action: 'ask_user', owner: 'user', path: 'fxPolicy',
          requiredFacts: ['which conflicting FX policy applies to this card and transaction'], candidateIds: [`card:${card.id}`],
          completionCondition: 'repeat recommend after the applicable policy is clarified or conflicting evidence is resolved',
        });
        const policy = policySignatures.size > 1 ? undefined : matchingPolicies[0];
        if (!policy && policySignatures.size <= 1) {
          const sourceUrls = state.evidence
            .filter((evidence) => evidence.ownerUser === this.metadataUser && evidence.sourceType === 'official' && evidence.authority === 'issuer' && evidence.sourceUrl)
            .map((evidence) => evidence.sourceUrl!)
            .filter((url, index, all) => all.indexOf(url) === index)
            .sort();
          registerFxPolicyResearch({
            purpose: 'policy_research', scope: { kind: 'issuer', issuer: card.issuer },
            ...(sourceUrls.length ? { sourceUrls, sourceStatus: 'known' as const } : { sourceStatus: 'discovery_required' as const }),
            requiredFields: ['scope', 'conversionOwner', 'rateType', 'rateDirection', 'conversionTiming', 'feeBasis', 'markupBasis', 'freshForSeconds', 'maxEstimateAgeSeconds', 'sourceUrl', 'evidenceId', 'validity period'],
            submission: { tool: 'upsert_fx_policy', field: 'policy' },
          }, `card:${card.id}`);
        }
      }
      const reusable = transaction && ruleQuote ? storedFx(transaction.amount.currency, ruleQuote, card) : undefined;
      const reusableFx = reusable?.observation;
      const estimateFx = reusable?.stale ? { ...reusable.observation, maxAgeSeconds: 30 * 24 * 3600 } : reusableFx;
      const applicableFx = transaction?.fx &&
        (!transaction.fx.cardIdScope || transaction.fx.cardIdScope === card.id) &&
        (!transaction.fx.issuerScope || transaction.fx.issuerScope === card.issuer)
        ? transaction.fx : estimateFx;
      const tx = transaction ? { ...transaction, cardId: card.id, route: { kind: 'direct_card' as const }, ...(applicableFx ? { fx: applicableFx } : { fx: undefined }) } : undefined;
      const evaluations = rules.map(rule => ({ rule, result: tx ? evaluateOffer(rule, tx, context) : undefined }));
      const projected = evaluations.map(({ rule, result }) => projectRule(rule, result));
      const row = tx ? rankCards([card], rules, tx, context, 1)[0] : undefined;
      const unresolved = projected.some(rule => rule.status === 'unknown' || rule.status === 'potential');
      if (tx) {
        for (const { rule, result } of evaluations) for (const diagnostic of result?.diagnostics ?? []) {
          if (!['fx_missing', 'fx_stale', 'fx_pair_mismatch', 'fx_scope_mismatch'].includes(diagnostic.code)) continue;
          const request = buildFxResolutionRequest({
            transaction: tx, rules: [rule], card,
            scope: { kind: 'card', cardId: card.id, issuer: card.issuer },
            submission: { tool: 'recommend', field: 'fx' },
          });
          registerFxRequest(request, `card:${card.id}`, diagnostic.code);
        }
        if (!input.fx && reusable?.stale && ruleQuote) {
          const request = buildFxResolutionRequest({ transaction: tx, rules: [rules.find((rule) => rule.settlementCurrency === ruleQuote)!], card, scope: { kind: 'card', cardId: card.id, issuer: card.issuer }, submission: { tool: 'recommend', field: 'fx' } });
          registerFxRequest(request, `card:${card.id}`, 'fx_stale');
        }
      }
      candidates.push({
        id: `card:${card.id}`, kind: 'direct_card', cardId: card.id,
        fundingSource: { kind: 'credit_card', cardId: card.id },
        nodes: [{ id: 'funding', kind: 'funding_source', displayName: card.productName }, { id: 'merchant', kind: 'merchant', displayName: rawMerchant }],
        events: tx ? [{ kind: 'purchase', fromNodeId: 'funding', toNodeId: 'merchant', amount: tx.amount, transition: 'card_authorization' }] : [],
        status: row?.status === 'ok' && !input.fxObservation ? 'ready' : !tx || unresolved || !rules.length ? 'unknown' : input.fxObservation ? 'unknown' : 'no_match',
        matchedRules: projected,
        ...(row?.status === 'ok' && row.cappedReward ? { reward: row.cappedReward } : {}),
        ...(row?.status === 'ok' && row.cappedReward && row.cappedReward.currency === transaction?.amount.currency ? { netSpend: { amountMinor: Math.max(0, (transaction?.amount.amountMinor ?? 0) - row.cappedReward.amountMinor), currency: transaction.amount.currency } } : {}),
        ...(input.fxObservation ? { fxEstimate: { status: 'reference_estimate' as const, provider: input.fxObservation.provider, capturedAt: input.fxObservation.capturedAt, ...(input.fxObservation.sourceUrl ? { sourceUrl: input.fxObservation.sourceUrl } : {}), assumption: 'using an Agent-supplied public reference observation; issuer, card-scheme, fee, and eligibility terms remain unconfirmed' } } : reusable ? { fxEstimate: { status: reusable.observation.sourceKind === 'public_reference' ? 'reference_estimate' as const : reusable.stale ? 'stale_estimate' as const : 'policy_current' as const, provider: reusable.observation.provider, capturedAt: reusable.observation.capturedAt, ...(reusable.observation.sourceUrl ? { sourceUrl: reusable.observation.sourceUrl } : {}), assumption: reusable.observation.sourceKind === 'public_reference' ? 'using a stored public reference observation; issuer, card-scheme, fee, and eligibility terms remain unconfirmed' : reusable.stale ? 'using the stored observation within the planned-estimate maximum age; refresh before relying on the value' : 'using a fresh stored observation' } } : ruleQuote ? { fxEstimate: { status: 'unavailable' as const, assumption: 'no applicable stored observation is available; Agent must obtain the public reference observation before an estimate can be calculated' } } : {}),
        exclusionReasons: row?.unknownReasons ?? (!rules.length ? ['no known offer rules'] : []),
      });
    }
    let pathTruncated = false;
    if (transaction && this.metadataUser) {
      const persistedRouteFacts = (state.fxObservations ?? [])
        .filter((observation) => observation.ownerUser === this.metadataUser && observation.routeIdScope !== undefined)
        .map((observation) => ({ routeId: observation.routeIdScope!, ...(observation.edgeIdScope === undefined ? {} : { edgeId: observation.edgeIdScope }), fx: observation }));
      const routeFactMap = new Map<string, { routeId: string; edgeId?: string; fx: FxSnapshot }>();
      for (const fact of [...persistedRouteFacts, ...(input.routeFacts ?? [])]) routeFactMap.set(`${fact.routeId}|${fact.edgeId ?? '*'}`, fact);
      if (input.fxObservation) for (const route of routes) for (const edge of route.edges ?? []) {
        const costs = [edge.fee, edge.markup, edge.foreignTransactionFee, edge.dcc?.selected ? edge.dcc.fee : undefined]
          .filter((cost): cost is Money => cost !== undefined && cost.currency !== transaction.amount.currency);
        if (costs.some((cost) => cost.currency === input.fxObservation!.baseCurrency && input.fxObservation!.quoteCurrency === transaction.amount.currency)) {
          const key = `${route.id}|${edge.edgeId}`;
          if (!routeFactMap.has(key)) routeFactMap.set(key, { routeId: route.id, edgeId: edge.edgeId, fx: input.fxObservation });
        }
      }
      const result = this.recommendPaymentPaths({
        amount: transaction.amount, asOf: evaluatedAt, ...(merchant ? { merchant } : {}),
        ...(country ? { country } : {}), ...(input.channel ? { channel: input.channel } : {}),
        ...(input.paymentMethod ? { paymentMethod: input.paymentMethod } : {}),
        routeFacts: [...routeFactMap.values()],
        routeIds: routes.map(route => route.id), routes, limit: 128, continuation: true,
      });
      for (const path of result.candidates) {
        const cardId = path.fundingSource.kind === 'credit_card' ? path.fundingSource.cardId : undefined;
        const rules = applicable(cardId, path.routeId);
        const projected = rules.map(rule => {
          const matched = path.matchedRules.find(item => item.ruleId === rule.id && item.ruleVersion === rule.version);
          const summary = projectRule(rule);
          return matched ? { ...summary, status: 'matched' as const, reward: matched.reward, reasons: [] } : summary;
        });
        const supported = path.status === 'ready' && path.matchedRules.length > 0 &&
          path.matchedRules.every(rule => rule.reward.currency === transaction.amount.currency);
        const fxCostEvents = path.events.filter((event) => [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined]
          .some((cost) => cost !== undefined && cost.currency !== transaction.amount.currency));
        const fxEstimate = fxCostEvents.length === 0 ? undefined : fxCostEvents.every((event) => {
          const costs = [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined]
            .filter((cost): cost is Money => cost !== undefined && cost.currency !== transaction.amount.currency);
          return costs.every((cost) => event.fx?.baseCurrency === cost.currency && event.fx.quoteCurrency === transaction.amount.currency);
        }) ? (() => {
          const stale = fxCostEvents.some((event) => Math.abs(Date.parse(evaluatedAt) - Date.parse(event.fx!.capturedAt)) > (event.fx!.maxAgeSeconds ?? 7 * 24 * 3600) * 1000);
          const observation = fxCostEvents[0]!.fx!;
          const reference = input.fxObservation?.id === observation.id;
          return { status: reference ? 'reference_estimate' as const : stale ? 'stale_estimate' as const : 'policy_current' as const, provider: observation.provider, capturedAt: observation.capturedAt, ...(observation.sourceUrl ? { sourceUrl: observation.sourceUrl } : {}), assumption: reference ? 'using an Agent-supplied public reference observation; route policy and final settlement cost remain unconfirmed' : stale ? 'using a route FX snapshot beyond its freshness window; refresh before relying on the value' : 'using the route or edge FX snapshot for foreign-currency costs' };
        })() : { status: 'unavailable' as const, assumption: 'foreign-currency route costs cannot be compared without a matching route or edge FX snapshot' };
        candidates.push({
          id: path.id, kind: 'payment_path', routeId: path.routeId, fundingSource: path.fundingSource,
          nodes: path.nodes, events: path.events,
          status: supported ? 'ready' : path.status === 'blocked' ? 'blocked' : 'unknown',
          matchedRules: projected, ...(supported ? { reward: path.cappedReward } : {}),
          ...(supported && path.netValue ? { netSpend: { amountMinor: transaction.amount.amountMinor - path.netValue.amountMinor, currency: transaction.amount.currency } } : {}),
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
              const fresh = pairMatches && Math.abs(Date.parse(evaluatedAt) - Date.parse(event.fx!.capturedAt)) <= (event.fx!.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
              if (fresh) continue;
              const edgeId = event.routeEdgeIds?.length === 1 ? event.routeEdgeIds[0] : undefined;
              const routeKind = route?.layers.some((layer) => layer.kind === 'wallet') ? 'wallet' as const : 'direct_card' as const;
              const request = buildFxResolutionRequest({
                transaction: { amount: cost, occurredAt: evaluatedAt, mode: 'planned', route: { kind: routeKind } },
                card, targetCurrency: transaction.amount.currency,
                scope: edgeId ? { kind: 'route_edge', routeId: path.routeId, edgeId } : { kind: 'route', routeId: path.routeId },
                submission: { tool: 'recommend', field: 'routeFacts' },
              });
              request.requiredFacts = ['routeFacts[].routeId', ...(edgeId ? ['routeFacts[].edgeId'] : []), ...request.requiredFields!.map((field) => `routeFacts[].fx.${field}`)];
              registerFxRequest(request, path.id, event.fx ? (pairMatches ? 'fx_stale' : 'fx_pair_mismatch') : 'fx_missing');
            }
          }
        }
      }
      for (const blocked of result.blocked ?? []) {
        pathTruncated ||= blocked.reason.includes('truncated_by_bound');
        addAction({ id: `route:${blocked.routeId}:${blocked.reason}`, action: 'review_payment_route', owner: 'agent', path: `routes.${blocked.routeId}`, requiredFacts: [blocked.reason], candidateIds: [blocked.routeId], submission: { tool: 'upsert_payment_route', field: 'route' }, completionCondition: 'repeat recommend after the route has current accepted evidence' });
      }
      pathTruncated ||= result.candidates.length >= 128;
    } else {
      for (const route of routes) {
        const cardId = route.funding.kind === 'credit_card' ? route.funding.cardId : undefined;
        candidates.push({
          id: `route:${route.id}`, kind: 'payment_path', routeId: route.id, fundingSource: route.funding,
          nodes: route.nodes ?? route.layers.map((layer, index) => ({ id: `layer:${index}`, kind: layer.kind, displayName: layer.displayName ?? layer.providerId ?? layer.kind })),
          events: [], status: 'unknown', matchedRules: applicable(cardId, route.id).map(rule => projectRule(rule)),
          exclusionReasons: ['route acceptance, evidence and amount require evaluation'],
        });
      }
    }
    if (!candidates.length) addAction({ id: 'setup', action: 'ask_user', owner: 'user', path: 'cardIds', requiredFacts: ['cards or payment methods the user owns'], submission: { tool: 'register_card', field: 'card' }, completionCondition: 'repeat recommend after at least one owned card or payment route is registered' });
    for (const candidate of candidates) if (candidate.status === 'unknown' || candidate.status === 'blocked' || candidate.matchedRules.some(rule => rule.status === 'potential' || rule.status === 'unknown')) {
      if (![...fxRequests.values()].some(item => item.candidateIds.has(candidate.id))) addAction({ id: `candidate:${candidate.id}`, action: 'review_candidate', owner: 'agent', path: `candidates.${candidate.id}`,
        requiredFacts: candidate.exclusionReasons.length ? candidate.exclusionReasons : ['current applicable offer evidence and transaction facts'], candidateIds: [candidate.id], submission: { tool: 'recommend', field: 'merchant' }, completionCondition: 'repeat recommend only after new evidence or user-owned facts are available' });
    }
    for (const [key, { request, candidateIds, diagnostic }] of fxRequests) {
      addAction({ id: `fx:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 16)}`, action: request.retryAction, owner: request.retryAction === 'ask_user' ? 'user' : 'agent', path: request.submission?.field ?? 'fx', requiredFacts: request.requiredFacts, candidateIds: [...candidateIds].sort(), ...(request.submission ? { submission: request.submission } : {}), completionCondition: `repeat recommend after supplying a validated ${request.baseCurrency}/${request.quoteCurrency} observation; without new evidence, stop retrying ${diagnostic}`, fxResolutionRequest: request });
    }
    for (const { request, candidateIds } of fxPolicyRequests.values()) addAction({
      id: `fx-policy:${crypto.createHash('sha256').update(JSON.stringify(request.scope)).digest('hex').slice(0, 16)}`,
      action: 'research_fx_policy', owner: 'agent', path: 'fxPolicy', requiredFacts: request.requiredFields,
      candidateIds: [...candidateIds].sort(), submission: request.submission,
      completionCondition: 'repeat recommend after storing a validated policy backed by accepted official evidence',
      fxPolicyResearchRequest: request,
    });
    for (const action of actions) if (action.candidateIds === undefined) {
      const affected = action.id === 'merchant'
        ? candidates.filter((candidate) => candidate.matchedRules.some((rule) => Boolean(rule.conditions.merchants?.length))).map((candidate) => candidate.id)
        : candidates.map((candidate) => candidate.id);
      (action as { candidateIds?: readonly string[] }).candidateIds = affected.sort();
    }
    const fxResolutionRequests = [...fxRequests.values()].map(({ request }) => request);
    const ready = candidates.some(candidate => candidate.status === 'ready');
    const pending = candidates.some(candidate => candidate.status === 'unknown' || candidate.status === 'blocked');
    const status: RecommendationIntentResult['status'] = ready ? (actions.length || pending ? 'partial' : 'ready')
      : pending || actions.length ? 'needs_input' : 'no_match';
    candidates.sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready') ||
      (a.reward?.currency === b.reward?.currency ? (b.reward?.amountMinor ?? 0) - (a.reward?.amountMinor ?? 0) : 0) ||
      a.id.localeCompare(b.id));
    const page = candidates.slice(cursorOffset, cursorOffset + pageSize);
    const hasMore = cursorOffset + page.length < candidates.length;
    const nextCursor = hasMore ? Buffer.from(JSON.stringify({ v: 1, offset: cursorOffset + page.length, evaluatedAt, resultVersion })).toString('base64url') : undefined;
    const responsePage = Math.floor(cursorOffset / pageSize) + 1;
    return {
      status, candidates: page, requiredActions: actions, evaluatedAt,
      ...(fxResolutionRequest ? { fxResolutionRequest } : {}),
      ...(fxResolutionRequests.length ? { fxResolutionRequests } : {}),
      pageSize, page: responsePage, hasMore, ...(nextCursor ? { nextCursor } : {}), resultVersion,
      coverage: { scope: 'registered cards and payment routes; route acceptance requires evidence',
        discoveredCount: candidates.length, bounded: pathTruncated, explorationComplete: !pathTruncated, ...(!pathTruncated ? { total: candidates.length } : {}),
        notes: ['not a market-wide catalog', 'planned calls do not consume caps', ...(pathTruncated ? ['path exploration reached a declared resource bound'] : ['all currently discovered candidates are available through continuation'])] },
    };
  }

  recommend(transaction: unknown, limit = 10, options: { cardIds?: readonly string[]; context?: EvaluationContext } = {}): RankingEntry[] {
    let parsedTransaction = validateRecommendationTransaction(transaction);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RewardServiceError('INVALID_INPUT', 'limit must be a safe integer from 1 to 20');
    const state = this.store.read();
    if (parsedTransaction.merchant) {
      const resolution = this.resolveMerchant(parsedTransaction.merchant, { ...(parsedTransaction.country ? { country: parsedTransaction.country } : {}) });
      if (resolution.resolutionStatus === 'confirmed' && resolution.merchant) parsedTransaction = { ...parsedTransaction, merchant: resolution.merchant.canonicalId };
    }
    const cards = options.cardIds === undefined ? state.cards : state.cards.filter((card) => options.cardIds!.includes(card.id));
    const context = options.context ?? this.context(state, nowIso(), parsedTransaction);
    return rankCards(cards, state.rules, parsedTransaction, context, limit);
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
      const evidence = fact.evidenceId === undefined ? undefined : state.evidence.find((candidate) => candidate.id === fact.evidenceId);
      const claim = evidence?.claim;
      const validWindow = evidence !== undefined && (!evidence.validFrom || Date.parse(evidence.validFrom) <= Date.parse(asOf)) && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(asOf)) && (!evidence.refreshAfter || Date.parse(evidence.refreshAfter) >= Date.parse(asOf));
      const owned = evidence?.ownerUser === this.metadataUser;
      const exact = claim?.factKey === fact.factKey && JSON.stringify(claim.value) === JSON.stringify(fact.value) && (fact.version === undefined || claim.version === fact.version);
      if (fact.validFrom !== undefined || fact.validTo !== undefined || !evidence || !owned || evidence.sourceType !== 'official' || evidence.reviewState !== 'accepted' || !validWindow || !exact) { invalidEligibilityEvidence = true; continue; }
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
        const fact = routeFacts.filter((candidate) => candidate.routeId === route.id &&
          (candidate.edgeId === undefined || candidate.edgeId === edge.edgeId) &&
          requiredCurrencies.includes(candidate.fx.baseCurrency) && candidate.fx.quoteCurrency === input.amount.currency &&
          (!candidate.fx.cardIdScope || candidate.fx.cardIdScope === card?.id) &&
          (!candidate.fx.issuerScope || candidate.fx.issuerScope === card?.issuer) &&
          Math.abs(Date.parse(asOf) - Date.parse(candidate.fx.capturedAt)) <= (candidate.fx.maxAgeSeconds ?? 7 * 24 * 3600) * 1000)
          .sort((a, b) => Number(Boolean(b.edgeId)) - Number(Boolean(a.edgeId)))[0];
        return fact ? { ...edge, fx: fact.fx } : edge;
      }) };
    });
    const routes = visibleRoutes.filter((route) => {
      if (route.status !== 'active') return false;
      if (route.authority === undefined || route.confidence !== 'high' || !route.sourceUrl?.startsWith('https://') || !route.evidenceIds?.length) return false;
      if (route.validFrom && Date.parse(route.validFrom) > Date.parse(asOf)) return false;
      if (route.validTo && Date.parse(route.validTo) < Date.parse(asOf)) return false;
      if (route.funding.kind === 'account' && route.funding.subtype === 'wallet_balance') { const account = state.paymentAccounts.find((candidate) => candidate.id === (route.funding as { accountId?: string }).accountId && candidate.ownerUser === this.metadataUser); if (!account?.balance || account.balance.amountMinor < input.amount.amountMinor || account.balance.currency !== input.amount.currency) return false; }
      const validEvidence = (id: string) => state.evidence.some((evidence) => evidence.id === id && evidence.sourceType === 'official' && evidence.reviewState === 'accepted' && (!evidence.validFrom || Date.parse(evidence.validFrom) <= Date.parse(asOf)) && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(asOf)));
      if (!route.evidenceIds.every(validEvidence)) return false;
      if (route.edges?.length) {
        if (!route.nodes?.length) return false;
      }
      return true;
    }).sort((a, b) => `${a.id}:${a.edges?.map((edge) => edge.edgeId).sort().join(',') ?? ''}`.localeCompare(`${b.id}:${b.edges?.map((edge) => edge.edgeId).sort().join(',') ?? ''}`));
    type PathOption = { route: PaymentRouteRecord; pathEdges?: readonly NonNullable<PaymentRouteRecord['edges']>[number][] };
    const branchBlocked: { routeId: string; reason: string }[] = [];
    const routePaths: PathOption[] = routes.flatMap((route): PathOption[] => {
      if (!route.edges?.length || !route.nodes?.length) return [{ route }];
      const validEvidence = (id: string) => state.evidence.some((evidence) => evidence.id === id && evidence.sourceType === 'official' && evidence.reviewState === 'accepted' && (!evidence.validFrom || Date.parse(evidence.validFrom) <= Date.parse(asOf)) && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(asOf)));
      const usable = (edge: NonNullable<PaymentRouteRecord['edges']>[number]) => {
        const from = route.nodes?.find((node) => node.id === edge.fromNodeId);
        const to = route.nodes?.find((node) => node.id === edge.toNodeId);
        const fromRole = from?.kind;
        const toRole = to?.kind;
        const legal = edge.transition === 'wallet_top_up' ? fromRole === 'funding_source' && toRole === 'wallet_balance' : edge.transition === 'account_debit' ? fromRole === 'funding_source' && ['wallet_balance', 'merchant'].includes(toRole ?? '') : edge.transition === 'wallet_debit' ? fromRole === 'wallet_balance' && ['payment_service', 'acceptance_network', 'merchant'].includes(toRole ?? '') : edge.transition === 'service_to_acceptance' ? fromRole === 'payment_service' && toRole === 'acceptance_network' : edge.transition === 'merchant_settlement' ? ['wallet_balance', 'payment_service', 'acceptance_network'].includes(fromRole ?? '') && toRole === 'merchant' : edge.transition === 'direct_settlement' ? fromRole === 'funding_source' && toRole === 'merchant' : edge.transition === 'card_authorization' ? fromRole === 'funding_source' && ['acceptance_network', 'merchant'].includes(toRole ?? '') : edge.transition === 'split_tender' ? ['funding_source', 'wallet_balance'].includes(fromRole ?? '') && toRole === 'merchant' : false;
        const directionIsAdmissible = edge.direction !== 'inbound';
        const claims = edge.evidenceIds.map((id) => state.evidence.find((candidate) => candidate.id === id)?.claim).filter(Boolean).map((claim) => JSON.stringify(claim));
        const exact = edge.evidenceIds.every((id) => {
          const evidence = state.evidence.find((candidate) => candidate.id === id);
          if (!evidence) return false;
          const claim = evidence.claim;
          const requiresDirection = edge.fromMarket !== undefined || edge.toMarket !== undefined;
          const claimHasDirection = claim.fromMarket !== undefined || claim.toMarket !== undefined;
          if (claimHasDirection && !requiresDirection) return false;
          if (requiresDirection && (claim.fromRole === undefined || claim.toRole === undefined || claim.transition === undefined || claim.fromMarket === undefined || claim.toMarket === undefined)) return false;
          return (claim.fromRole === undefined && !requiresDirection) || (claim.fromRole === fromRole && claim.toRole === toRole && claim.transition === edge.transition && (edge.fromMarket === undefined || claim.fromMarket === edge.fromMarket) && (edge.toMarket === undefined || claim.toMarket === edge.toMarket) && (edge.market === undefined || claim.market === edge.market) && (edge.currency === undefined || claim.currency === edge.currency));
        });
        return legal && directionIsAdmissible && new Set(claims).size <= 1 && edge.provenance !== 'model_fixture' && edge.evidenceIds.length > 0 && edge.evidenceIds.every(validEvidence) && (!edge.validFrom || Date.parse(edge.validFrom) <= Date.parse(asOf)) && (!edge.validTo || Date.parse(edge.validTo) >= Date.parse(asOf)) && exact;
      };
      const adjacency = new Map<string, typeof route.edges>();
      for (const edge of [...route.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId))) { if (!usable(edge)) { branchBlocked.push({ routeId: route.id, reason: `edge ${edge.edgeId} lacks exact current evidence` }); continue; } const outgoing = adjacency.get(edge.fromNodeId) ?? []; if (outgoing.length < maxBranchesPerNode) adjacency.set(edge.fromNodeId, [...outgoing, edge]); else branchBlocked.push({ routeId: route.id, reason: `truncated_by_bound:maxBranchesPerNode=${maxBranchesPerNode}` }); }
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
      const fundingId = route.funding.kind === 'credit_card' ? route.funding.cardId : route.funding.kind === 'account' ? route.funding.accountId : undefined;
      const fundingLabel = route.funding.kind === 'credit_card' ? `card:${fundingId ?? 'unknown'}` : route.funding.kind === 'account' ? `${route.funding.subtype}:${fundingId ?? 'unknown'}` : 'cash';
      const fundingNode = { id: 'funding', kind: route.funding.kind, displayName: fundingLabel };
      const nodes = (route.nodes?.length ? [...route.nodes] : [fundingNode, ...route.layers.map((layer, index) => ({ id: `node-${index + 1}`, kind: layer.kind, displayName: layer.displayName ?? layer.providerId ?? layer.appId ?? layer.kind }))]).sort((a, b) => a.id.localeCompare(b.id));
      const pathEdges = selectedEdges;
      const events: PaymentPathEvent[] = pathEdges?.length
        ? pathEdges.map((edge) => {
          const kind = edge.transition === 'wallet_top_up' || edge.transition === 'account_debit' ? 'top_up' as const : 'purchase' as const;
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
          const match = matchPaymentEvent(rule.eventRule, plannedEvent);
          if (match.status !== 'matched') {
            if (match.status === 'unknown') { eligibilityUncertain = true; plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), reasons: match.reasons }); }
            continue;
          }
          if (rule.predicate) {
            const predicateContext = { ...this.context(state, asOf), eligibilityFacts: verifiedFacts };
            const outcome = evaluatePredicate(rule.predicate, { cardId: '', routeId: route.id, kind: 'purchase', mode: 'planned', occurredAt: asOf, amount: input.amount }, predicateContext);
            if (!outcome.matched) {
              eligibilityUncertain = true;
              plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), reasons: [...outcome.missing, ...outcome.conflicts, ...(outcome.missing.length || outcome.conflicts.length ? [] : ['eligibility fact does not match'])] });
              continue;
            }
          }
          const reward = rule.reward.amountMinor !== undefined
            ? { amountMinor: rule.reward.amountMinor, currency: rule.reward.currency ?? input.amount.currency }
            : rule.reward.rateBps !== undefined && event.amount
            ? { amountMinor: Math.floor(event.amount.amountMinor * rule.reward.rateBps / 10_000), currency: rule.reward.currency ?? input.amount.currency }
            : undefined;
          plannedRewards.push({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind, sponsor: rule.sponsor ?? rule.componentKind, benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default', nativeUnit: rule.reward.kind, ...(rule.combination === undefined ? {} : { combination: rule.combination }), ...(rule.capPoolRefs === undefined ? {} : { capPoolRefs: rule.capPoolRefs }), ...(reward === undefined ? {} : { reward }), reasons: reward === undefined ? ['reward spec is not calculable'] : [] });
          if (reward !== undefined && event.rewards) {
            event.rewards = [...event.rewards, {
              ruleId: rule.id,
              ruleVersion: rule.version,
              component: rule.componentKind,
              sponsor: rule.sponsor ?? rule.componentKind,
              benefitGroup: rule.benefitGroup ?? rule.combination?.groupId ?? 'default',
              nativeUnit: rule.reward.kind,
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
      const evaluations = card && !hasPlannedTopUp ? state.rules.filter((rule) => rule.cardId === card.id).map((rule) => ({ rule, result: evaluateOffer(rule, transaction, this.context(state, asOf, transaction)) })).filter(({ result }) => result.status === 'ok') : [];
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
      const costValues = events.flatMap((event) => [event.fee, event.markup, event.foreignTransactionFee, event.dcc?.selected ? event.dcc.fee : undefined].filter((value): value is Money => value !== undefined).map((value) => ({ value, converted: convertCost(value, event.fx) })));
      const feeMismatch = costValues.some((cost) => cost.converted === undefined);
      const feeTotal = feeMismatch || costValues.length === 0 ? undefined : { amountMinor: costValues.reduce((total, cost) => total + cost.converted!, 0), currency: input.amount.currency };
      const netValue = feeMismatch || nativeUnitMismatch ? undefined : { amountMinor: cappedReward.amountMinor - (feeTotal?.amountMinor ?? 0), currency: input.amount.currency };
      const blocked = stackingAmbiguous || feeMismatch || nativeUnitMismatch;
      const pathEvidence = [...new Set(events.flatMap((event) => event.evidenceIds ?? []))].map((id) => state.evidence.find((candidate) => candidate.id === id)).filter((evidence): evidence is NonNullable<typeof evidence> => evidence !== undefined);
      const evidenceTier = pathEvidence.length === 0 ? 0 : Math.min(...pathEvidence.map((evidence) => evidence.sourceType === 'official' && evidence.reviewState === 'accepted' ? 3 : evidence.sourceType === 'trusted_secondary' && evidence.reviewState === 'accepted' ? 2 : evidence.sourceType === 'community' && evidence.reviewState === 'accepted' ? 1 : 0));
      const evidenceFreshness = pathEvidence.length === 0 ? undefined : pathEvidence.map((evidence) => evidence.observedAt).sort()[0];
      const stableEdges = pathEdges?.map(({ fx: _fx, ...edge }) => edge) ?? events.map(({ fx: _fx, ...event }) => event);
      const pathSignature = JSON.stringify({ version: 1, nodes, edges: stableEdges, funding: route.funding, merchant: input.merchant, currency: input.amount.currency });
      return { id: `path:${pathSignature}`, routeId: route.id, nodes, events, fundingSource: route.funding, grossReward, netReward: cappedReward, cappedReward, ...(feeTotal === undefined ? {} : { feeTotal }), ...(netValue === undefined ? {} : { netValue }), requiredActions: feeMismatch ? ['confirm fee currency or provide a validated FX snapshot'] : nativeUnitMismatch ? ['provide a validated valuation snapshot for each reward unit'] : [], userEffort: feeMismatch || nativeUnitMismatch ? 1 : 0, evidenceTier, ...(evidenceFreshness === undefined ? {} : { evidenceFreshness }), matchedRules: blocked ? [] : valuedRules, pathSignature, status: blocked ? 'blocked' : 'ready', exclusionReasons: stackingAmbiguous ? ['ambiguous stacking policy'] : feeMismatch ? ['fee currency cannot be compared without validated FX'] : nativeUnitMismatch ? ['provide a fresh authoritative valuation for each reward unit'] : matchedRules.length ? evaluations.length === matchedRules.length ? [] : ['possible stacking policy excluded'] : ['no applicable verified card rule'] };
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
    const state = this.store.read();
    let originalRecord: RecordedTransaction | undefined;
    let appliedFx: AppliedFxRate | undefined;
    const visibleTransactions = this.visibleTransactions(state);
    const duplicate = visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate.transaction) !== JSON.stringify(transaction)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different transaction');
      return duplicate.reward;
    }
    if (transaction.kind === 'refund') {
      if (!transaction.refundOfId) throw new RewardServiceError('INVALID_REFUND', 'refund requires refundOfId');
      const original = visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId);
      if (!original) throw new RewardServiceError('INVALID_REFUND', 'refundOfId does not reference a recorded transaction');
      originalRecord = original;
      if (original.transaction.cardId !== transaction.cardId) throw new RewardServiceError('INVALID_REFUND', 'refund must reference a transaction for the same card');
      if (original.transaction.kind !== 'purchase') throw new RewardServiceError('INVALID_REFUND', 'refund must reference a purchase');
      const originalAmount = original.transaction.amount.amountMinor;
      const alreadyRefunded = state.transactions
        .filter((record) => record.ownerUser === this.metadataUser && record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + record.transaction.amount.amountMinor, 0);
      const refundableAmount = Math.max(0, originalAmount - alreadyRefunded);
      const refundAmount = Math.min(transaction.amount.amountMinor, refundableAmount);
      if (refundAmount <= 0) throw new RewardServiceError('INVALID_REFUND', 'refund exceeds the original purchase amount');
      const originalReward = Math.max(0, original.reward.cappedReward?.amountMinor ?? 0);
      const rewardAlreadyRefunded = state.transactions
        .filter((record) => record.ownerUser === this.metadataUser && record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + Math.max(0, -(record.reward.cappedReward?.amountMinor ?? 0)), 0);
      const rewardToReverse = Math.min(originalReward - rewardAlreadyRefunded, Math.floor((originalReward * refundAmount) / originalAmount));
      transaction = { ...original.transaction, ...transaction, amount: { ...transaction.amount, amountMinor: refundAmount }, originalRewardMinor: rewardToReverse, ...(original.transaction.fx ? { fx: original.transaction.fx } : {}) };
      if (original.appliedFx) {
        appliedFx = { ...original.appliedFx, appliedAtUtc: nowIso() };
      } else if (original.transaction.fx) {
        appliedFx = freezeAppliedFxRate(original.transaction.fx, nowIso());
      }
    }
    const card = state.cards.find((item) => item.id === transaction.cardId);
    const rules = state.rules.filter((rule) => rule.status === 'active' && (!card || rule.cardId === card.id));
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
      appliedFx = freezeAppliedFxRate(transaction.fx, nowIso(), deriveConversionOwner({ routeContext: transaction.routeContext, route: transaction.route, card }));
    }
    const evaluationTransaction = transaction.kind === 'refund'
      ? { ...transaction, occurredAt: visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId)?.transaction.occurredAt ?? transaction.occurredAt }
      : transaction;
    const context = this.context(state, evaluationTransaction.occurredAt, evaluationTransaction);
    const reward = card ? rankCards([card], state.rules, evaluationTransaction, context, 1)[0] : undefined;
    if (!reward || reward.status !== 'ok') {
      const isFxMissing = reward?.diagnostics?.some((d) => d.code === 'fx_missing') || reward?.unknownReasons?.some((r) => r.includes('missing FX snapshot'));
      if (isFxMissing) {
        const fxResolutionRequest = buildFxResolutionRequest({ transaction: evaluationTransaction, rules, card });
        throw new RewardServiceError('fx_missing', 'missing FX snapshot for settlement currency', { code: 'fx_missing', path: 'transaction.fx', requiredFacts: fxResolutionRequest.requiredFacts, retryAction: fxResolutionRequest.retryAction, fxResolutionRequest });
      }
      const code = reward?.status === 'unknown' ? 'INSUFFICIENT_FACTS' : 'NEEDS_REVIEW';
      const reason = reward?.unknownReasons?.join('; ') || 'no usable offer rule';
      throw new RewardServiceError(code, reason);
    }
    const appliedAtUtc = nowIso();
    const originalComponents = transaction.kind === 'refund' && transaction.refundOfId
      ? state.rewardComponents.filter((component) => component.transactionId === transaction.refundOfId && visibleTransactions.some((record) => record.transaction.idempotencyKey === component.transactionId))
      : [];
    const sourceComponents = reward.components?.length ? reward.components : (reward.ruleId && reward.ruleVersion && reward.sourceSnapshotId ? [{ kind: 'card_issuer' as const, ruleId: reward.ruleId, ruleVersion: reward.ruleVersion, sourceSnapshotId: reward.sourceSnapshotId, reward: reward.cappedReward, unit: reward.cappedReward?.currency ?? 'TWD', confidence: 'confirmed' as const }] : []);
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
    const storedTransaction: TransactionTuple = transaction.kind === 'refund' && originalRecord?.transaction.fx
      ? { ...requestedTransaction, fx: originalRecord.transaction.fx }
      : requestedTransaction;
    const record: RecordedTransaction = { transaction: storedTransaction, reward: { ...reward, transaction: storedTransaction }, ...(appliedFx ? { appliedFx } : {}), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    this.store.update((next) => { next.transactions.push(record); next.rewardComponents.push(...componentRecords); });
    return record.reward;
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
