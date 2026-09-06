import * as crypto from 'node:crypto';
import { type LedgerStore, type RecordedTransaction, type StoredState } from './store.js';
import { convertMinor, evaluateOffer, rankCards, resolveCyclePeriodKey } from './evaluator.js';
import type { CardDescriptor, CardSwitchInput, CardSwitchProjection, CardSwitchStatus, CapPeriod, CapPoolDefinition, EvaluationContext, MerchantIdentity, MerchantResolution, Money, OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, RankingEntry, RewardBreakdown, RewardComponentRecord, TransactionTuple, UserBenefitInput, UserBenefitStatus } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateCapPool, validateConfirmation, validateMerchant, validateRule, validateSnapshot, validateTransaction } from './validation.js';
import { cardSwitchStatus, projectionFromInput } from './card-switch.js';

export { RewardServiceError } from './errors.js';

export interface RemainingCap { ruleId: string; usageKey: string; remaining: Money; }

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
function normalizedMerchantKey(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('und').replace(/[\p{P}\p{S}]+/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export class RewardService {
  constructor(readonly store: LedgerStore, readonly metadataUser: string | undefined) {}

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

  searchActiveOffers(input: { rawQuery?: string; cardId?: string; country?: string; channel?: string; asOf?: string; limit?: number; page?: number } = {}): { offers: readonly OfferRuleVersion[]; pageInfo: { page: number; limit: number; total: number; totalPages: number; hasMore: boolean } } {
    const limit = input.limit ?? 10;
    const page = input.page ?? 1;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20 || !Number.isSafeInteger(page) || page < 1) throw new RewardServiceError('INVALID_INPUT', 'limit must be 1..20 and page must be a positive integer');
    const asOf = input.asOf ?? nowIso();
    const state = this.store.read();
    const offers = state.rules.filter((rule) => {
      if (rule.status !== 'active' || (input.cardId && rule.cardId !== input.cardId)) return false;
      const source = state.snapshots.find((snapshot) => snapshot.id === rule.sourceSnapshotId);
      if (!source?.verified || Date.parse(rule.validFrom) > Date.parse(asOf) || (rule.validTo && Date.parse(rule.validTo) < Date.parse(asOf))) return false;
      if (input.channel && rule.match.channels?.length && !rule.match.channels.includes(input.channel)) return false;
      if (input.country && rule.match.countries?.length && !rule.match.countries.includes(input.country)) return false;
      if (!input.rawQuery) return true;
      const resolved = this.resolveMerchant(input.rawQuery, { ...(input.country === undefined ? {} : { country: input.country }), ...(input.channel === undefined ? {} : { channel: input.channel }) });
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
  ): { snapshot: OfferSourceSnapshot; rule: OfferRuleVersion } {
    snapshot = validateSnapshot(snapshot);
    rule = validateRule(rule);
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
    this.store.update((state) => {
      for (const pool of incomingPools) {
        const existingPool = state.capPools.find((item) => item.id === pool.id);
        if (existingPool && JSON.stringify(existingPool) !== JSON.stringify(pool)) throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable cap pool');
        if (!existingPool) state.capPools.push(pool);
      }
      for (const ref of rule.capPoolRefs ?? []) if (!state.capPools.some((pool) => pool.id === ref)) throw new RewardServiceError('INVALID_OFFER', `rule references missing cap pool ${ref}`);
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
      const existingRule = state.rules.find((item) => item.id === rule.id && item.version === rule.version);
      if (existingRule) {
        const { confirmation: c1, status: s1, ...r1 } = existingRule;
        const { confirmation: c2, status: s2, ...r2 } = rule;
        if (JSON.stringify(r1) !== JSON.stringify(r2)) {
          throw new RewardServiceError('INVALID_OFFER', 'cannot modify immutable rule version');
        }
      }
      const snapshotIndex = state.snapshots.findIndex((item) => item.id === snapshot.id);
      if (snapshotIndex >= 0) state.snapshots[snapshotIndex] = snapshot;
      else state.snapshots.push(snapshot);
      const ruleIndex = state.rules.findIndex((item) => item.id === rule.id);
      if (ruleIndex >= 0) state.rules[ruleIndex] = rule;
      else state.rules.push(rule);
    });
    return { snapshot, rule };
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

  recommend(transaction: TransactionTuple, limit = 10): RankingEntry[] {
    transaction = validateTransaction(transaction);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new RewardServiceError('INVALID_INPUT', 'limit must be a safe integer from 1 to 20');
    const state = this.store.read();
    return rankCards(state.cards, state.rules, transaction, this.context(state, nowIso(), transaction), limit);
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
