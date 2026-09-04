import { type LedgerStore, type RecordedTransaction, type StoredState } from './store.js';
import { convertMinor, evaluateOffer, rankCards, resolveCyclePeriodKey } from './evaluator.js';
import type { CardDescriptor, CardSwitchInput, CardSwitchStatus, CapPeriod, CapPoolDefinition, EvaluationContext, Money, OfferConfirmation, OfferRuleVersion, OfferSourceSnapshot, RankingEntry, RewardBreakdown, TransactionTuple, UserBenefitInput, UserBenefitStatus } from './types.js';
import type { StartupConfig } from './startup.js';
import { RewardServiceError } from './errors.js';
import { validateCard, validateCapPool, validateConfirmation, validateRule, validateSnapshot, validateTransaction } from './validation.js';
import { cardSwitchStatus, projectionFromInput } from './card-switch.js';

export { RewardServiceError } from './errors.js';

export interface RemainingCap { ruleId: string; usageKey: string; remaining: Money; }

function nowIso(): string { return new Date().toISOString(); }

export class RewardService {
  constructor(readonly store: LedgerStore, readonly metadataUser: string | undefined) {}

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

      for (const record of state.transactions) {
        if (record.transaction.mode !== 'actual') continue;
        const contributingRule = state.rules.find((candidate) => candidate.id === record.reward.ruleId);
        const contributingPoolRefs = contributingRule?.capPoolRefs ?? [];
        if (!contributingPoolRefs.includes(pool.id)) continue;
        const contributingCard = state.cards.find((c) => c.id === contributingRule?.cardId) ?? card;
        if (resolveCyclePeriodKey(contributingCard, capPeriod, record.transaction.occurredAt) !== period) continue;
        let amount: number | undefined;
        if (pool.metric === 'transaction_count') {
          amount = record.transaction.kind === 'refund' ? -1 : 1;
        } else if (pool.metric === 'spend') {
          amount = convertMinor(record.transaction.amount, currency, record.transaction);
        } else {
          amount = record.reward.cappedReward ? convertMinor(record.reward.cappedReward, currency, record.transaction) : 0;
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

  getCardSwitchStatus(cardId: string, asOfUtc = nowIso()): CardSwitchStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${cardId} not found`);
    const current = state.cardSwitches.filter((item) => item.cardId === cardId).at(-1);
    return cardSwitchStatus(card, current, state.campaigns, asOfUtc);
  }

  getUserBenefitStatus(kind: UserBenefitInput['kind'], cardId: string, asOfUtc = nowIso()): UserBenefitStatus {
    const state = this.store.read();
    const card = state.cards.find((item) => item.id === cardId);
    if (!card) throw new RewardServiceError('CARD_NOT_FOUND', `card ${cardId} not found`);
    const current = state.cardSwitches.filter((item) => item.cardId === cardId && (item.kind ?? 'card_switch') === kind).at(-1);
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
    const projection = { ...projectionFromInput({ ...input, switchedAtUtc: input.completedAt, effectiveFrom: input.effectiveFrom, ...(input.effectiveTo === undefined ? {} : { effectiveTo: input.effectiveTo }), ...(input.campaignId === undefined ? {} : { campaignId: input.campaignId }) }), kind: input.kind };
    const duplicate = state.cardSwitches.find((item) => item.idempotencyKey === input.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate) !== JSON.stringify(projection)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different benefit status');
      return this.getUserBenefitStatus(input.kind, input.cardId, input.completedAt);
    }
    this.store.update((next) => {
      const index = next.cardSwitches.findIndex((item) => item.cardId === input.cardId && (item.kind ?? 'card_switch') === input.kind);
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
    const projection = projectionFromInput(input);
    const duplicate = state.cardSwitches.find((item) => item.idempotencyKey === input.idempotencyKey);
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
    const current = next.cardSwitches.filter((item) => item.cardId === input.cardId).at(-1);
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

  recommend(transaction: TransactionTuple, limit = 5): RankingEntry[] {
    transaction = validateTransaction(transaction);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 5) throw new RewardServiceError('INVALID_INPUT', 'limit must be a safe integer from 1 to 5');
    const state = this.store.read();
    return rankCards(state.cards, state.rules, transaction, this.context(state, nowIso(), transaction), Math.min(5, Math.max(1, limit)));
  }

  recordTransaction(transaction: TransactionTuple): RewardBreakdown {
    transaction = validateTransaction(transaction);
    if (transaction.mode !== 'actual') throw new RewardServiceError('INVALID_TRANSACTION', 'record_transaction only accepts actual transactions');
    if (!transaction.idempotencyKey) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'actual transactions require idempotencyKey');
    const requestedTransaction = transaction;
    const state = this.store.read();
    const duplicate = state.transactions.find((record) => record.transaction.idempotencyKey === transaction.idempotencyKey);
    if (duplicate) {
      if (JSON.stringify(duplicate.transaction) !== JSON.stringify(transaction)) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'idempotencyKey already belongs to a different transaction');
      return duplicate.reward;
    }
    if (transaction.kind === 'refund') {
      if (!transaction.refundOfId) throw new RewardServiceError('INVALID_REFUND', 'refund requires refundOfId');
      const original = state.transactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId);
      if (!original) throw new RewardServiceError('INVALID_REFUND', 'refundOfId does not reference a recorded transaction');
      if (original.transaction.cardId !== transaction.cardId) throw new RewardServiceError('INVALID_REFUND', 'refund must reference a transaction for the same card');
      if (original.transaction.kind !== 'purchase') throw new RewardServiceError('INVALID_REFUND', 'refund must reference a purchase');
      const originalAmount = original.transaction.amount.amountMinor;
      const alreadyRefunded = state.transactions
        .filter((record) => record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + record.transaction.amount.amountMinor, 0);
      const refundableAmount = Math.max(0, originalAmount - alreadyRefunded);
      const refundAmount = Math.min(transaction.amount.amountMinor, refundableAmount);
      if (refundAmount <= 0) throw new RewardServiceError('INVALID_REFUND', 'refund exceeds the original purchase amount');
      const originalReward = Math.max(0, original.reward.cappedReward?.amountMinor ?? 0);
      const rewardAlreadyRefunded = state.transactions
        .filter((record) => record.transaction.kind === 'refund' && record.transaction.refundOfId === transaction.refundOfId)
        .reduce((sum, record) => sum + Math.max(0, -(record.reward.cappedReward?.amountMinor ?? 0)), 0);
      const rewardToReverse = Math.min(originalReward - rewardAlreadyRefunded, Math.floor((originalReward * refundAmount) / originalAmount));
      transaction = { ...original.transaction, ...transaction, amount: { ...transaction.amount, amountMinor: refundAmount }, originalRewardMinor: rewardToReverse };
    }
    const evaluationTransaction = transaction.kind === 'refund'
      ? { ...transaction, occurredAt: state.transactions.find((record) => record.transaction.idempotencyKey === transaction.refundOfId)?.transaction.occurredAt ?? transaction.occurredAt }
      : transaction;
    const card = state.cards.find((item) => item.id === transaction.cardId);
    const context = this.context(state, evaluationTransaction.occurredAt, evaluationTransaction);
    const reward = card ? rankCards([card], state.rules, evaluationTransaction, context, 1)[0] : undefined;
    if (!reward || reward.status !== 'ok') {
      const code = reward?.status === 'unknown' ? 'INSUFFICIENT_FACTS' : 'NEEDS_REVIEW';
      const reason = reward?.unknownReasons?.join('; ') || 'no usable offer rule';
      throw new RewardServiceError(code, reason);
    }
    const record: RecordedTransaction = { transaction: requestedTransaction, reward: { ...reward, transaction: requestedTransaction } };
    this.store.update((next) => { next.transactions.push(record); });
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
      for (const record of state.transactions) {
        if (record.transaction.mode !== 'actual') continue;
        const txRule = state.rules.find((r) => r.id === record.reward.ruleId);
        if (!txRule?.capPoolRefs?.includes(poolId)) continue;
        const txCard = state.cards.find((c) => c.id === txRule.cardId) ?? card;
        if (resolveCyclePeriodKey(txCard, capPeriod, record.transaction.occurredAt) !== periodKey) continue;
        if (pool.metric === 'transaction_count') {
          used += record.transaction.kind === 'refund' ? -1 : 1;
        } else if (pool.metric === 'spend') {
          const amount = convertMinor(record.transaction.amount, currency, record.transaction);
          if (amount !== undefined) {
            used += record.transaction.kind === 'refund' ? -amount : amount;
          }
        } else {
          const reward = record.reward.cappedReward;
          const amount = reward ? convertMinor(reward, currency, record.transaction) : 0;
          if (amount !== undefined) {
            used += record.transaction.kind === 'refund' ? -Math.abs(amount) : amount;
          }
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
