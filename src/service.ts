import * as crypto from 'node:crypto';
import { type LedgerStore, type RecordedTransaction, type StoredState } from './store.js';
import { EventRewardLedger, convertMinor, createPaymentEventRewardCandidate, decidePaymentEventRewards, evaluateOffer, matchPaymentEvent, matchPaymentEventChain, rankCards, resolveCyclePeriodKey } from './evaluator.js';
import type { CardDescriptor, CardSwitchInput, CardSwitchProjection, CardSwitchStatus, CapPeriod, CapPoolDefinition, EvaluationContext, MerchantIdentity, MerchantResolution, Money, OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, RankingEntry, RewardBreakdown, RewardComponentRecord, TransactionTuple, UserBenefitInput, UserBenefitStatus, RecommendationPreflight, RecommendationRequiredAction, RecommendationRequirement, Diagnostic, EvidenceRecord, PaymentRouteRecord, PaymentAccountRecord, EventRewardLedgerRecord, EventRewardReversalRecord, PaymentPathRequest, PaymentPathRecommendation, PaymentPathCandidate } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateCapPool, validateConfirmation, validateMerchant, validateRecommendationTransaction, validateRule, validateSnapshot, validateTransaction, validateEvidence, validateFactCandidate, validatePaymentRouteRecord, validatePaymentAccountRecord, validateEventRewardInput, validatePaymentEvent, validatePaymentEventChainRule, validatePaymentEventRule } from './validation.js';
import { cardSwitchStatus, projectionFromInput } from './card-switch.js';

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
function ownedId(prefix: 'ev' | 'fact' | 'route' | 'acct'): string {
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
    return new EventRewardLedger(this.metadataUser, state.capPools, this.store).record(createPaymentEventRewardCandidate(parsed.candidate), parsed.event, parsed.idempotencyKey);
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
    return ledger.record(candidate, event, String(source.idempotencyKey));
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
    const existing = state.evidence.filter((candidate) => candidate.requirementId === parsed.requirementId && candidate.reviewState === 'accepted');
    if (existing.some((candidate) => JSON.stringify(candidate.claim) !== JSON.stringify(parsed.claim))) throw new RewardServiceError('NEEDS_REVIEW', `conflict for evidence requirement ${parsed.requirementId}`);
    const retry = existing.find((candidate) => JSON.stringify(candidate.claim) === JSON.stringify(parsed.claim) && candidate.sourceIdentity === parsed.sourceIdentity);
    if (retry) return retry;
    const evidence = { ...parsed, id: ownedId('ev') };
    this.store.update((next) => { next.evidence.push(evidence); });
    return evidence;
  }

  listEvidence(): readonly EvidenceRecord[] { return this.store.read().evidence; }

  upsertPaymentRoute(input: unknown): PaymentRouteRecord {
    const source = typeof input === 'object' && input !== null ? input as Record<string, unknown> : {};
    const parsed = validatePaymentRouteRecord({ ...source, id: 'route_input', ...(source.status === undefined ? { status: source.confirmation ? 'active' : 'candidate' } : {}), ...(source.ownerUser === undefined ? {} : { ownerUser: source.ownerUser }) });
    if (parsed.status === 'active' && !parsed.confirmation) throw new RewardServiceError('INVALID_CONFIRMATION', 'active payment routes require explicit user confirmation');
    const state = this.store.read();
    const accountId = parsed.funding.kind === 'account' ? parsed.funding.accountId : undefined;
    if (accountId !== undefined) {
      const account = state.paymentAccounts.find((candidate) => candidate.id === accountId && (candidate.ownerUser === this.metadataUser || (candidate.ownerUser === undefined && this.metadataUser === undefined)));
      if (!account) throw new RewardServiceError('INVALID_INPUT', 'payment route references an unknown payment account');
      if (parsed.status === 'active' && account.status !== 'active') throw new RewardServiceError('NEEDS_REVIEW', 'active payment routes require an active payment account');
    }
    const existing = state.paymentRoutes.find((route) => route.idempotencyKey === parsed.idempotencyKey && (route.ownerUser === this.metadataUser || (route.ownerUser === undefined && this.metadataUser === undefined)));
    const desired = { ...parsed, id: existing?.id ?? routeId(), ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
    if (existing) { if (JSON.stringify({ ...existing, id: parsed.id, ownerUser: parsed.ownerUser }) !== JSON.stringify({ ...desired, id: parsed.id, ownerUser: parsed.ownerUser })) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different payment route'); return existing; }
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
    if (rule.sourceSnapshotId !== snapshot.id || !rule.id || !rule.cardId) throw new RewardServiceError('INVALID_OFFER', 'rule must reference its source snapshot');
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
    if (foreignRule && parsed.routeContext && !parsed.routeContext.conversionOwner) {
      requirements.push({ id: 'route', category: 'payment_route', path: 'transaction.routeContext.conversionOwner', status: 'missing', retryAction: 'ask_user' });
      diagnostics.push({ code: 'missing_required_fact', path: 'transaction.routeContext.conversionOwner', requiredFacts: ['transaction.routeContext.conversionOwner'], retryAction: 'ask_user' });
      requiredActions.push({ action: 'ask_user', path: 'transaction.routeContext.conversionOwner', requiredFacts: ['transaction.routeContext.conversionOwner'] });
    }
    if (foreignRule && !parsed.fx) {
      requirements.push({ id: 'fx', category: 'fx_rate', path: 'transaction.fx', status: 'missing', retryAction: 'query_approved_fx_source' });
      diagnostics.push({ code: 'fx_missing', path: 'transaction.fx', requiredFacts: ['transaction.fx'], retryAction: 'query_approved_fx_source' });
      requiredActions.push({ action: 'refresh_external_data', path: 'transaction.fx', requiredFacts: ['transaction.fx'] });
    } else if (foreignRule && parsed.fx && parsed.fx.baseCurrency !== parsed.amount.currency) {
      requirements.push({ id: 'fx', category: 'fx_rate', path: 'transaction.fx.baseCurrency', status: 'invalid', retryAction: 'rebuild_snapshot' });
      diagnostics.push({ code: 'fx_pair_mismatch', path: 'transaction.fx.baseCurrency', requiredFacts: [`base currency ${parsed.amount.currency}`], retryAction: 'rebuild_snapshot' });
      requiredActions.push({ action: 'refresh_external_data', path: 'transaction.fx', requiredFacts: [`base currency ${parsed.amount.currency}`] });
    }
    const dataVersion = crypto.createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
    const blocking = diagnostics.some((diagnostic) => diagnostic.code !== 'no_active_offer');
    return { ready: !blocking, knownFacts, requirements, requiredActions, diagnostics, evaluatedAt, dataVersion };
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
    if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 20)) throw new RewardServiceError('INVALID_INPUT', 'payment path limit must be 1..20');
    const maxHops = input.maxHops ?? 6; const maxEvents = input.maxEvents ?? 4; const maxBranchesPerNode = input.maxBranchesPerNode ?? 8;
    if (![maxHops, maxEvents, maxBranchesPerNode].every((value) => Number.isSafeInteger(value) && value >= 1 && value <= 20)) throw new RewardServiceError('INVALID_INPUT', 'payment path bounds are invalid');
    const state = this.store.read();
    const requested = input.routeIds === undefined ? undefined : new Set(input.routeIds);
    const visibleRoutes = this.listPaymentRoutes().filter((route) => requested === undefined || requested.has(route.id));
    const routes = visibleRoutes.filter((route) => {
      if (route.status !== 'active' || !route.confirmation) return false;
      if (route.authority === undefined || route.confidence !== 'high' || !route.sourceUrl?.startsWith('https://') || !route.evidenceIds?.length) return false;
      if (route.validFrom && Date.parse(route.validFrom) > Date.parse(asOf)) return false;
      if (route.validTo && Date.parse(route.validTo) < Date.parse(asOf)) return false;
      if (route.funding.kind === 'account' && route.funding.subtype === 'wallet_balance') { const account = state.paymentAccounts.find((candidate) => candidate.id === (route.funding as { accountId?: string }).accountId && candidate.ownerUser === this.metadataUser); if (!account?.balance || account.balance.amountMinor < input.amount.amountMinor || account.balance.currency !== input.amount.currency) return false; }
      const validEvidence = (id: string) => state.evidence.some((evidence) => evidence.id === id && evidence.sourceType === 'official' && evidence.reviewState === 'accepted' && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(asOf)));
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
      const validEvidence = (id: string) => state.evidence.some((evidence) => evidence.id === id && evidence.sourceType === 'official' && evidence.reviewState === 'accepted' && (!evidence.validTo || Date.parse(evidence.validTo) >= Date.parse(asOf)));
      const usable = (edge: NonNullable<PaymentRouteRecord['edges']>[number]) => { const fromRole = route.nodes?.find((node) => node.id === edge.fromNodeId)?.kind; const toRole = route.nodes?.find((node) => node.id === edge.toNodeId)?.kind; const legal = edge.transition === 'wallet_top_up' ? fromRole === 'funding_source' && toRole === 'wallet_balance' : edge.transition === 'account_debit' ? fromRole === 'funding_source' && ['wallet_balance', 'merchant'].includes(toRole ?? '') : edge.transition === 'wallet_debit' ? fromRole === 'wallet_balance' && ['payment_service', 'acceptance_network', 'merchant'].includes(toRole ?? '') : edge.transition === 'service_to_acceptance' ? fromRole === 'payment_service' && toRole === 'acceptance_network' : edge.transition === 'merchant_settlement' ? ['wallet_balance', 'payment_service', 'acceptance_network'].includes(fromRole ?? '') && toRole === 'merchant' : edge.transition === 'direct_settlement' ? fromRole === 'funding_source' && toRole === 'merchant' : edge.transition === 'card_authorization' ? fromRole === 'funding_source' && ['acceptance_network', 'merchant'].includes(toRole ?? '') : false; const claims = edge.evidenceIds.map((id) => state.evidence.find((candidate) => candidate.id === id)?.claim).filter(Boolean).map((claim) => JSON.stringify(claim)); return legal && new Set(claims).size <= 1 && edge.provenance !== 'model_fixture' && edge.evidenceIds.length > 0 && edge.evidenceIds.every(validEvidence) && edge.evidenceIds.every((id) => { const evidence = state.evidence.find((candidate) => candidate.id === id); return evidence?.claim.fromRole === undefined || (evidence.claim.fromRole === fromRole && evidence.claim.toRole === toRole && evidence.claim.transition === edge.transition && (edge.fromMarket === undefined || evidence.claim.fromMarket === edge.fromMarket) && (edge.toMarket === undefined || evidence.claim.toMarket === edge.toMarket) && (edge.market === undefined || evidence.claim.market === edge.market) && (edge.currency === undefined || evidence.claim.currency === edge.currency)); }); };
      const adjacency = new Map<string, typeof route.edges>();
      for (const edge of [...route.edges].sort((a, b) => a.edgeId.localeCompare(b.edgeId))) { if (!usable(edge)) { branchBlocked.push({ routeId: route.id, reason: `edge ${edge.edgeId} lacks exact current evidence` }); continue; } const outgoing = adjacency.get(edge.fromNodeId) ?? []; if (outgoing.length < maxBranchesPerNode) adjacency.set(edge.fromNodeId, [...outgoing, edge]); else branchBlocked.push({ routeId: route.id, reason: `branch exceeds maxBranchesPerNode=${maxBranchesPerNode}` }); }
      const starts = route.nodes.filter((node) => node.kind === 'funding_source').map((node) => node.id).sort();
      const paths: PathOption[] = [];
      const visit = (nodeId: string, seen: Set<string>, path: NonNullable<PaymentRouteRecord['edges']>[number][]) => {
        if (path.length > maxHops || path.length >= maxEvents || paths.length >= (input.limit ?? 20)) { if (path.length >= maxEvents) branchBlocked.push({ routeId: route.id, reason: `branch exceeds maxEvents=${maxEvents}` }); if (paths.length >= (input.limit ?? 20)) branchBlocked.push({ routeId: route.id, reason: 'truncated_by_bound:maxCandidates' }); return; }
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
      const events = pathEdges?.length
        ? pathEdges.map((edge) => ({ kind: edge.transition === 'wallet_top_up' || edge.transition === 'account_debit' ? 'top_up' as const : 'purchase' as const, fromNodeId: edge.fromNodeId, toNodeId: edge.toNodeId }))
        : route.layers.length === 0
        ? [{ kind: route.funding.kind === 'credit_card' ? 'card_authorization' as const : 'account_debit' as const, fromNodeId: 'funding', toNodeId: 'funding' }]
        : route.layers.map((_, index) => ({ kind: index < route.layers.length - 1 ? 'top_up' as const : 'purchase' as const, fromNodeId: index === 0 ? 'funding' : `node-${index}`, toNodeId: `node-${index + 1}` }));
      const transaction: TransactionTuple = { cardId: route.funding.kind === 'credit_card' ? (route.funding.cardId ?? '') : '', routeId: route.id, kind: 'purchase', mode: 'planned', occurredAt: asOf, amount: input.amount, ...(input.merchant === undefined ? {} : { merchant: input.merchant }), ...(input.mcc === undefined ? {} : { mcc: input.mcc }), ...(input.country === undefined ? {} : { country: input.country }), ...(input.channel === undefined ? {} : { channel: input.channel }), ...(input.paymentMethod === undefined ? {} : { paymentMethod: input.paymentMethod }) };
      const card = state.cards.find((candidate) => candidate.id === transaction.cardId);
      const evaluations = card ? state.rules.filter((rule) => rule.cardId === card.id).map((rule) => ({ rule, result: evaluateOffer(rule, transaction, this.context(state, asOf, transaction)) })).filter(({ result }) => result.status === 'ok') : [];
      const ranking = evaluations.length ? evaluations[0]?.result : undefined;
      const zero = { amountMinor: 0, currency: input.amount.currency };
      const matchedRules = evaluations.filter(({ rule }) => rule.stacking !== 'possible').map(({ rule, result }) => ({ ruleId: rule.id, ruleVersion: rule.version, component: rule.componentKind ?? 'card_issuer', reward: result.cappedReward ?? zero }));
      const sum = (field: 'grossReward' | 'cappedReward') => matchedRules.reduce((amount, item) => amount + (item.reward.amountMinor), 0);
      const cappedReward = matchedRules.length ? { amountMinor: sum('cappedReward'), currency: input.amount.currency } : zero;
      const grossReward = matchedRules.length ? { amountMinor: sum('grossReward'), currency: input.amount.currency } : zero;
      const pathSignature = JSON.stringify({ version: 1, nodes, edges: pathEdges ?? events, funding: route.funding, merchant: input.merchant, currency: input.amount.currency });
      return { id: `path:${pathSignature}`, routeId: route.id, nodes, events, fundingSource: route.funding, grossReward, netReward: cappedReward, cappedReward, matchedRules, pathSignature, status: 'ready', exclusionReasons: matchedRules.length ? evaluations.length === matchedRules.length ? [] : ['possible stacking policy excluded'] : ['no applicable verified card rule'] };
    });
    const accepted = new Set(routes.map((route) => route.id));
    const blocked = [...visibleRoutes.filter((route) => !accepted.has(route.id)).map((route) => ({ routeId: route.id, reason: route.status !== 'active' || !route.confirmation ? 'route is not active and confirmed' : 'route has no admissible terminal branch' })), ...branchBlocked];
    return { status: candidates.length ? (blocked.length ? 'partial' : 'ok') : (blocked.length ? 'needs_review' : 'no_match'), candidates, evaluatedAt: asOf, blocked, limits: { maxCandidates: input.limit ?? 20, maxHops, maxEvents, maxBranchesPerNode } };
  }

  recordTransaction(transaction: TransactionTuple): RewardBreakdown {
    transaction = validateTransaction(transaction);
    if (transaction.mode !== 'actual') throw new RewardServiceError('INVALID_TRANSACTION', 'record_transaction only accepts actual transactions');
    if (!transaction.idempotencyKey) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'actual transactions require idempotencyKey');
    const requestedTransaction = transaction;
    const state = this.store.read();
    let originalRecord: RecordedTransaction | undefined;
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
      transaction = { ...original.transaction, ...transaction, amount: { ...transaction.amount, amountMinor: refundAmount }, originalRewardMinor: rewardToReverse };
    }
    const evaluationTransaction = transaction.kind === 'refund'
      ? { ...transaction, occurredAt: visibleTransactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId)?.transaction.occurredAt ?? transaction.occurredAt }
      : transaction;
    const card = state.cards.find((item) => item.id === transaction.cardId);
    const context = this.context(state, evaluationTransaction.occurredAt, evaluationTransaction);
    const reward = card ? rankCards([card], state.rules, evaluationTransaction, context, 1)[0] : undefined;
    if (!reward || reward.status !== 'ok') {
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
    const record: RecordedTransaction = { transaction: requestedTransaction, reward: { ...reward, transaction: requestedTransaction }, ...(this.metadataUser === undefined ? {} : { ownerUser: this.metadataUser }) };
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
