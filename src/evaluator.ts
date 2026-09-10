import type {
  CapPeriod,
  CardDescriptor,
  EvaluationContext,
  EvaluationStatus,
  HeldCard,
  Money,
  OfferRuleVersion,
  Predicate,
  RankingEntry,
  CapPoolDefinition,
  Diagnostic,
  RewardBreakdown,
  TransactionTuple,
  PaymentEvent,
  PaymentEventMatch,
  PaymentEventRule,
  PaymentEventChainRule,
  PaymentEventRewardCandidate,
  PaymentEventRewardCandidateInput,
  PaymentEventRewardDecision,
  EventRewardLedgerRecord,
  EventRewardReversalRecord,
  AppliedFxRate,
} from './types.js';
import { RewardServiceError } from './errors.js';
import type { LedgerStore } from './store.js';

function diagnostic(code: Diagnostic['code'], path: string, requiredFacts: readonly string[], retryAction: string): Diagnostic {
  return { code, path, requiredFacts, retryAction };
}


function poolCaps(rule: OfferRuleVersion, context: EvaluationContext): readonly CapPeriod[] {
  if (!rule.capPoolRefs?.length) return [];
  return rule.capPoolRefs.map((id) => {
    const pool = context.capPools?.find((candidate) => candidate.id === id);
    if (!pool) return { kind: 'calendar_month', cap: { amountMinor: 0, currency: rule.settlementCurrency }, usageKey: `__missing_pool__${id}`, capPoolId: id, metric: 'reward' };
    return { kind: pool.period === 'billing_cycle' ? 'billing_cycle' : pool.period === 'campaign' ? 'campaign' : 'calendar_month', cap: { amountMinor: pool.limit, currency: pool.currency ?? rule.settlementCurrency }, usageKey: pool.id, capPoolId: pool.id, metric: pool.metric, timezone: pool.timezone };
  });
}

function roundReward(raw: number, mode: OfferRuleVersion['reward']['roundingMode']): number {
  if (mode === 'ceil') return Math.ceil(raw);
  if (mode === 'half_up' || mode === 'nearest') return Math.floor(raw + 0.5);
  return Math.floor(raw);
}

const has = (value: string | undefined, allowed: string[] | undefined): boolean | undefined => {
  if (!allowed?.length) return true;
  if (value === undefined) return undefined;
  return allowed.includes(value);
};

function matchRule(rule: OfferRuleVersion, tx: TransactionTuple): string[] | false {
  const checks: Array<[string, boolean | undefined]> = [
    ['merchant', has(tx.merchant, rule.match.merchants)],
    ['mcc', has(tx.mcc, rule.match.mccs)],
    ['country', has(tx.country, rule.match.countries)],
    ['channel', has(tx.channel, rule.match.channels)],
    ['paymentMethod', has(tx.paymentMethod, rule.match.paymentMethods)],
  ];
  const unknown = checks.filter(([, result]) => result === undefined).map(([name]) => `missing ${name}`);
  if (unknown.length) return unknown;
  return checks.some(([, result]) => result === false) ? false : [];
}

/** Matches only facts belonging to this event; it never traverses funded_by relations. */
export function matchPaymentEvent(rule: PaymentEventRule, event: PaymentEvent): PaymentEventMatch {
  const reasons: string[] = [];
  if (event.kind !== rule.eventKind) return { status: 'no_match', reasons: [`event kind is ${event.kind}`] };
  if (rule.fundingKind !== undefined && event.funding.kind !== rule.fundingKind) return { status: 'no_match', reasons: ['funding kind does not match'] };
  if (rule.fundingSubtype !== undefined && (event.funding.kind !== 'account' || event.funding.subtype !== rule.fundingSubtype)) return { status: 'no_match', reasons: ['funding subtype does not match'] };
  if (rule.fundingKind === 'credit_card' && event.funding.kind === 'credit_card' && event.funding.cardId === undefined) return { status: 'unknown', reasons: ['credit-card identity is missing'] };
  if (rule.channel !== undefined && event.channel === undefined) reasons.push('missing channel');
  else if (rule.channel !== undefined && event.channel !== rule.channel) return { status: 'no_match', reasons: ['channel does not match'] };
  if (rule.paymentMethod !== undefined && event.paymentMethod === undefined) reasons.push('missing payment method');
  else if (rule.paymentMethod !== undefined && event.paymentMethod !== rule.paymentMethod) return { status: 'no_match', reasons: ['payment method does not match'] };
  return reasons.length ? { status: 'unknown', reasons } : { status: 'matched', reasons: [] };
}

/** Checks one explicitly evidenced funded_by edge; it never discovers or allocates relations. */
export function matchPaymentEventChain(rule: PaymentEventChainRule, target: PaymentEvent, events: readonly PaymentEvent[]): PaymentEventMatch {
  const targetMatch = matchPaymentEvent(rule.targetRule, target);
  if (targetMatch.status !== 'matched') return targetMatch;
  const relatedIds = target.relations?.funded_by;
  if (!relatedIds?.length) return { status: 'no_match', reasons: ['funded_by relation is missing'] };
  if (relatedIds.length !== 1) return { status: 'unknown', reasons: ['funded_by relation has ambiguous wallet provenance'] };
  const sources = events.filter((event) => event.id === relatedIds[0]);
  if (!sources.length) return { status: 'unknown', reasons: ['funded_by source event is unavailable'] };
  if (sources.length !== 1) return { status: 'unknown', reasons: ['funded_by source event is ambiguous'] };
  const source = sources[0]!;
  const sourceMatch = matchPaymentEvent(rule.sourceRule, source);
  if (sourceMatch.status !== 'matched') return sourceMatch;
  const sourceTime = Date.parse(source.occurredAt);
  const targetTime = Date.parse(target.occurredAt);
  if (!Number.isFinite(sourceTime) || !Number.isFinite(targetTime)) return { status: 'unknown', reasons: ['event timestamps are invalid'] };
  if (sourceTime > targetTime) return { status: 'no_match', reasons: ['funded_by source occurs after target event'] };
  if (targetTime - sourceTime > rule.windowSeconds * 1000) return { status: 'no_match', reasons: ['funded_by source is outside the eligibility window'] };
  return { status: 'matched', reasons: [] };
}

/** Turns known eligibility into an unpersisted candidate; amount calculation is deliberately separate. */
export function createPaymentEventRewardCandidate(input: PaymentEventRewardCandidateInput): PaymentEventRewardCandidate | undefined {
  if (input.eligibility.status !== 'matched') return undefined;
  const { eligibility: _eligibility, ...candidate } = input;
  return candidate;
}

/** Applies only explicit non-stacking boundaries; it never writes a ledger or invents reward amounts. */
export function decidePaymentEventRewards(candidates: readonly PaymentEventRewardCandidate[]): PaymentEventRewardDecision {
  if (!candidates.length) return { status: 'no_match', candidates: [], reasons: [] };
  const groups = new Map<string, PaymentEventRewardCandidate[]>();
  for (const candidate of candidates) {
    const key = `${candidate.sponsor}\u0000${candidate.benefitGroup}`;
    const group = groups.get(key) ?? [];
    group.push(candidate);
    groups.set(key, group);
  }
  const allAdditive = candidates.every((candidate) => candidate.combination?.mode === 'additive');
  const duplicateGroup = [...groups.values()].some((group) => group.length > 1);
  if (duplicateGroup && !allAdditive) return { status: 'needs_review', candidates: [], reasons: ['same sponsor and benefit group are not explicitly combinable'] };
  if (groups.size > 1 && !allAdditive) return { status: 'needs_review', candidates: [], reasons: ['cross-sponsor candidates require explicit additive combination policy'] };
  return { status: 'matched', candidates: [...candidates], reasons: [] };
}

/** First event-aware ledger seam; records are user-scoped in memory until durable migration is specified. */
export class EventRewardLedger {
  private readonly records = new Map<string, EventRewardLedgerRecord>();
  private readonly reversals = new Map<string, EventRewardReversalRecord>();
  private readonly capUsage = new Map<string, number>();
  private readonly capPools: readonly CapPoolDefinition[];
  private readonly store: LedgerStore | undefined;

  constructor(readonly ownerUser: string, capPools: readonly CapPoolDefinition[] = [], store?: LedgerStore) {
    if (!ownerUser.trim()) throw new RewardServiceError('INVALID_INPUT', 'event reward ledger ownerUser is required');
    this.capPools = capPools;
    this.store = store;
    if (store) {
      const state = store.read();
      for (const record of state.eventRewardLedger.filter((entry) => entry.ownerUser === ownerUser)) this.records.set(record.idempotencyKey, record);
      for (const reversal of state.eventRewardReversals.filter((entry) => entry.ownerUser === ownerUser)) this.reversals.set(reversal.idempotencyKey, reversal);
      for (const usage of state.eventRewardCapUsage.filter((entry) => entry.ownerUser === ownerUser)) this.capUsage.set(`${usage.poolId}|${usage.periodKey}`, usage.consumedAmount);
    }
  }

  private persist(): void {
    if (!this.store) return;
    this.store.update((state) => {
      state.eventRewardLedger = [...state.eventRewardLedger.filter((entry) => entry.ownerUser !== this.ownerUser), ...this.records.values()];
      state.eventRewardReversals = [...state.eventRewardReversals.filter((entry) => entry.ownerUser !== this.ownerUser), ...this.reversals.values()];
      state.eventRewardCapUsage = [...state.eventRewardCapUsage.filter((entry) => entry.ownerUser !== this.ownerUser), ...[...this.capUsage.entries()].map(([key, consumedAmount]) => { const separator = key.indexOf('|'); return { ownerUser: this.ownerUser, poolId: key.slice(0, separator), periodKey: key.slice(separator + 1), consumedAmount }; })];
    });
  }

  record(candidate: PaymentEventRewardCandidate | undefined, event: PaymentEvent, idempotencyKey: string, appliedFx?: AppliedFxRate | undefined): EventRewardLedgerRecord {
    if (!idempotencyKey.trim()) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'event reward idempotencyKey is required');
    if (!candidate) throw new RewardServiceError('INELIGIBLE_EVENT_REWARD', 'event reward candidate is not eligible');
    if (candidate.eventId !== event.id) throw new RewardServiceError('INVALID_INPUT', 'candidate eventId does not match event');
    const reward = candidate.reward;
    const rewardSpecFingerprint = JSON.stringify(reward);
    const existing = this.records.get(idempotencyKey);
    if (existing) {
      if (existing.eventId !== candidate.eventId || existing.ruleId !== candidate.ruleId || existing.ruleVersion !== candidate.ruleVersion || existing.evidenceId !== candidate.evidenceId || existing.sponsor !== candidate.sponsor || existing.benefitGroup !== candidate.benefitGroup || existing.rewardSpecFingerprint !== rewardSpecFingerprint) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'event reward idempotencyKey already belongs to a different reward');
      return existing;
    }
    if (!reward) throw new RewardServiceError('REWARD_NOT_CALCULABLE', 'event reward candidate has no calculable RewardSpec');
    let amountMinor: number;
    let currency = event.amount.currency;
    if (reward?.rateBps !== undefined && Number.isSafeInteger(reward.rateBps) && reward.rateBps >= 0) {
      amountMinor = Math.floor((event.amount.amountMinor * reward.rateBps) / 10_000);
    } else if (reward?.amountMinor !== undefined && Number.isSafeInteger(reward.amountMinor) && reward.amountMinor >= 0) {
      amountMinor = reward.amountMinor;
      if (reward.currency !== undefined) currency = reward.currency;
    } else {
      throw new RewardServiceError('REWARD_NOT_CALCULABLE', 'event reward candidate has no calculable RewardSpec');
    }
    let capUsage: EventRewardLedgerRecord['capUsage'];
    if (candidate.capPoolId !== undefined) {
      const cap = this.capPools.find((pool) => pool.id === candidate.capPoolId);
      if (!cap) throw new RewardServiceError('CAP_NOT_FOUND', `event reward cap pool ${candidate.capPoolId} is not registered`);
      if (cap.metric !== 'reward') throw new RewardServiceError('CAP_METRIC_UNSUPPORTED', 'event reward cap must use reward metric');
      if (cap.currency !== undefined && cap.currency !== event.amount.currency) throw new RewardServiceError('CAP_CURRENCY_MISMATCH', 'event reward cap currency does not match event currency');
      if (cap.timezone === undefined) throw new RewardServiceError('CAP_TIMEZONE_REQUIRED', 'event reward cap requires an explicit timezone');
      if (cap.period !== 'calendar_month') throw new RewardServiceError('CAP_PERIOD_AMBIGUOUS', 'event reward cap period requires event-specific cycle facts');
      let periodKey: string;
      try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: cap.timezone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(event.occurredAt));
        const year = parts.find((part) => part.type === 'year')?.value;
        const month = parts.find((part) => part.type === 'month')?.value;
        if (!year || !month) throw new Error('missing period parts');
        periodKey = `${year}-${month}`;
      } catch {
        throw new RewardServiceError('CAP_TIMEZONE_REQUIRED', 'event reward cap timezone is invalid');
      }
      const usageKey = `${cap.id}|${periodKey}`;
      const used = this.capUsage.get(usageKey) ?? 0;
      const remaining = Math.max(0, cap.limit - used);
      if (remaining <= 0) throw new RewardServiceError('CAP_EXHAUSTED', 'event reward cap has no remaining allowance');
      amountMinor = Math.min(amountMinor, remaining);
      capUsage = { poolId: cap.id, periodKey, consumedAmount: amountMinor };
    }
    const desired: EventRewardLedgerRecord = { idempotencyKey, ownerUser: this.ownerUser, eventId: candidate.eventId, eventAmount: event.amount, ruleId: candidate.ruleId, ruleVersion: candidate.ruleVersion, evidenceId: candidate.evidenceId, sponsor: candidate.sponsor, benefitGroup: candidate.benefitGroup, reward: { amountMinor, currency }, rewardSpecFingerprint, ...(capUsage ? { capUsage } : {}), ...(appliedFx ? { appliedFx } : {}) };
    this.records.set(idempotencyKey, desired);
    if (capUsage) this.capUsage.set(`${capUsage.poolId}|${capUsage.periodKey}`, (this.capUsage.get(`${capUsage.poolId}|${capUsage.periodKey}`) ?? 0) + capUsage.consumedAmount);
    this.persist();
    return desired;
  }

  list(): readonly EventRewardLedgerRecord[] { return [...this.records.values()]; }

  /** Reverses exactly one evidenced original reward, without discovering or allocating relations. */
  reverse(event: PaymentEvent, idempotencyKey: string): EventRewardReversalRecord {
    if (!idempotencyKey.trim()) throw new RewardServiceError('IDEMPOTENCY_REQUIRED', 'event reward reversal idempotencyKey is required');
    if (event.kind !== 'refund' && event.kind !== 'reversal') throw new RewardServiceError('INVALID_INPUT', 'event reward reversal requires a refund or reversal event');
    const existing = this.reversals.get(idempotencyKey);
    const relatedIds = event.relations?.refunds;
    if (!relatedIds || relatedIds.length !== 1 || !relatedIds[0]) throw new RewardServiceError('INVALID_REFUND_RELATION', 'refund must explicitly reference exactly one original event');
    const originalEventId = relatedIds[0];
    if (existing) {
      if (existing.eventId !== event.id || existing.originalEventId !== originalEventId || existing.refundedAmount.amountMinor !== event.amount.amountMinor || existing.refundedAmount.currency !== event.amount.currency) throw new RewardServiceError('IDEMPOTENCY_CONFLICT', 'event reward reversal idempotencyKey already belongs to a different refund');
      return existing;
    }
    const originals = [...this.records.values()].filter((record) => record.eventId === originalEventId);
    if (!originals.length) throw new RewardServiceError('ORIGINAL_REWARD_NOT_FOUND', 'refund relation does not identify a recorded reward');
    if (originals.length !== 1) throw new RewardServiceError('ORIGINAL_REWARD_AMBIGUOUS', 'refund relation identifies more than one recorded reward');
    const original = originals[0]!;
    if (event.amount.currency !== original.eventAmount.currency || event.amount.amountMinor <= 0) throw new RewardServiceError('INVALID_REFUND', 'refund amount must be positive and match the original event currency');
    const priorRefunded = [...this.reversals.values()].filter((record) => record.originalEventId === originalEventId).reduce((sum, record) => sum + record.refundedAmount.amountMinor, 0);
    const remainingEventAmount = original.eventAmount.amountMinor - priorRefunded;
    if (event.amount.amountMinor > remainingEventAmount) throw new RewardServiceError('OVER_REFUND', 'refund exceeds the unreversed original event amount');
    const priorRewardReversed = [...this.reversals.values()].filter((record) => record.originalEventId === originalEventId).reduce((sum, record) => sum + Math.abs(record.reward.amountMinor), 0);
    const remainingReward = Math.max(0, original.reward.amountMinor - priorRewardReversed);
    const finalRefund = event.amount.amountMinor === remainingEventAmount;
    const rewardAmount = finalRefund ? remainingReward : Math.min(remainingReward, Math.floor((original.reward.amountMinor * event.amount.amountMinor) / original.eventAmount.amountMinor));
    let capUsage: EventRewardReversalRecord['capUsage'];
    if (original.capUsage) {
      const priorCapReleased = [...this.reversals.values()].filter((record) => record.originalEventId === originalEventId && record.capUsage?.poolId === original.capUsage?.poolId).reduce((sum, record) => sum + Math.abs(record.capUsage?.consumedAmount ?? 0), 0);
      const remainingCap = Math.max(0, original.capUsage.consumedAmount - priorCapReleased);
      const release = finalRefund ? remainingCap : Math.min(remainingCap, Math.floor((original.capUsage.consumedAmount * event.amount.amountMinor) / original.eventAmount.amountMinor));
      capUsage = { poolId: original.capUsage.poolId, periodKey: original.capUsage.periodKey, consumedAmount: -release };
      const usageKey = `${capUsage.poolId}|${capUsage.periodKey}`;
      this.capUsage.set(usageKey, Math.max(0, (this.capUsage.get(usageKey) ?? 0) - release));
    }
    const desired: EventRewardReversalRecord = { idempotencyKey, ownerUser: this.ownerUser, eventId: event.id, originalEventId, refundedAmount: event.amount, ruleId: original.ruleId, ruleVersion: original.ruleVersion, evidenceId: original.evidenceId, sponsor: original.sponsor, benefitGroup: original.benefitGroup, reward: { amountMinor: -rewardAmount, currency: original.reward.currency }, ...(capUsage ? { capUsage } : {}) };
    this.reversals.set(idempotencyKey, desired);
    this.persist();
    return desired;
  }

  listReversals(): readonly EventRewardReversalRecord[] { return [...this.reversals.values()]; }
}

type FactResolution =
  | { kind: 'ok'; value: unknown }
  | { kind: 'missing'; reason: string }
  | { kind: 'conflict'; reason: string };

function resolveFieldFact(field: string, tx: TransactionTuple, context: EvaluationContext): FactResolution {
  if (field.startsWith('transaction.')) {
    const key = field.slice('transaction.'.length) as keyof TransactionTuple;
    const val = tx[key];
    if (val === undefined) return { kind: 'missing', reason: `missing ${field}` };
    return { kind: 'ok', value: val };
  }

  if (field.startsWith('user.')) {
    const txTime = tx.occurredAt ? Date.parse(tx.occurredAt) : NaN;
    const nowTime = context?.now ? Date.parse(context.now) : NaN;
    const checkTime = Number.isFinite(txTime) ? txTime : nowTime;
    if (!Number.isFinite(checkTime)) return { kind: 'missing', reason: 'missing evaluation timestamp' };

    if (context?.userFacts && field in context.userFacts) {
      return { kind: 'ok', value: context.userFacts[field] };
    }

    if (context?.eligibilityFacts?.length) {
      const matchingFacts = context.eligibilityFacts.filter((fact) => {
        const key = fact.factKey.startsWith('user.') ? fact.factKey : `user.${fact.factKey}`;
        if (key !== field) return false;
        if (fact.cardId) {
          if (fact.cardId === tx.cardId) return true;
          const held = context.heldCards?.find((h) => h.id === tx.cardId);
          if (held && (held.id === fact.cardId || held.cardProductId === fact.cardId)) return true;
          return false;
        }
        return true;
      });

      const validFacts = matchingFacts.filter((fact) => {
        if (fact.validFrom) {
          const from = Date.parse(fact.validFrom);
          if (Number.isFinite(from) && checkTime < from) return false;
        }
        if (fact.validTo) {
          const to = Date.parse(fact.validTo);
          if (Number.isFinite(to) && checkTime > to) return false;
        }
        return true;
      });

      if (validFacts.length > 0 && validFacts[0]) {
        const distinctValues = new Set(validFacts.map((f) => JSON.stringify(f.value)));
        if (distinctValues.size > 1) {
          return { kind: 'conflict', reason: `conflicting user facts for ${field}` };
        }
        return { kind: 'ok', value: validFacts[0].value };
      }

      if (matchingFacts.length > 0) {
        return { kind: 'missing', reason: `missing ${field}` };
      }
    }

    if (context.heldCards?.length) {
      const held = context.heldCards.find((h) => h.id === tx.cardId || h.cardProductId === tx.cardId);
      if (held) {
        const subKey = field.slice('user.'.length);
        if (subKey === 'plan' && held.plan !== undefined) {
          return { kind: 'ok', value: held.plan };
        }
        if (subKey === 'billingCycleDay' && held.billingCycleDay !== undefined) {
          return { kind: 'ok', value: held.billingCycleDay };
        }
        if (subKey === 'status' && held.status !== undefined) {
          return { kind: 'ok', value: held.status };
        }
        if (subKey === 'alias' && held.alias !== undefined) {
          return { kind: 'ok', value: held.alias };
        }
      }
    }

    return { kind: 'missing', reason: `missing ${field}` };
  }

  return { kind: 'missing', reason: `unsupported field ${field}` };
}

export type PredicateOutcome = {
  matched: boolean;
  missing: string[];
  conflicts: string[];
};

export function evaluatePredicate(predicate: Predicate, tx: TransactionTuple, context: EvaluationContext): PredicateOutcome {
  if (predicate.op === 'NOT') {
    const child = evaluatePredicate(predicate.rule, tx, context);
    if (child.conflicts.length) return { matched: false, missing: [], conflicts: child.conflicts };
    if (child.missing.length) return { matched: false, missing: child.missing, conflicts: [] };
    return { matched: !child.matched, missing: [], conflicts: [] };
  }
  if ('rules' in predicate) {
    const children = predicate.rules.map((child) => evaluatePredicate(child, tx, context));
    const conflicts = children.flatMap((c) => c.conflicts);
    if (conflicts.length) return { matched: false, missing: [], conflicts };
    const missing = children.flatMap((c) => c.missing);
    if (predicate.op === 'AND') {
      if (children.some((c) => !c.matched && c.missing.length === 0)) {
        return { matched: false, missing: [], conflicts: [] };
      }
      if (missing.length) return { matched: false, missing, conflicts: [] };
      return { matched: true, missing: [], conflicts: [] };
    }
    if (children.some((c) => c.matched)) return { matched: true, missing: [], conflicts: [] };
    if (missing.length) return { matched: false, missing, conflicts: [] };
    return { matched: false, missing: [], conflicts: [] };
  }

  const fact = resolveFieldFact(predicate.field, tx, context);
  if (fact.kind === 'conflict') {
    return { matched: false, missing: [], conflicts: [fact.reason] };
  }
  if (fact.kind === 'missing') {
    return { matched: false, missing: [fact.reason], conflicts: [] };
  }
  const actual = fact.value;
  if (predicate.op === 'EQUALS') {
    return { matched: actual === predicate.value, missing: [], conflicts: [] };
  }
  if (predicate.op === 'MATCH_ALLOWLIST') {
    const matched = Array.isArray(predicate.value) && predicate.value.includes(String(actual));
    return { matched, missing: [], conflicts: [] };
  }
  return { matched: false, missing: [`unsupported operator for ${predicate.field}`], conflicts: [] };
}

export function convertMinor(amount: Money, currency: string, tx: TransactionTuple): number | undefined {
  if (amount.currency === currency) return amount.amountMinor;
  if (tx.fx?.baseCurrency === amount.currency && tx.fx.quoteCurrency === currency) {
    return Math.floor((amount.amountMinor * tx.fx.ratePpm) / 1_000_000);
  }
  return undefined;
}

function invalidActual(tx: TransactionTuple): string[] {
  const errors: string[] = [];
  if (tx.mode === 'actual' && !tx.idempotencyKey) errors.push('actual transaction requires idempotencyKey');
  if (tx.kind === 'refund' && !tx.refundOfId) errors.push('refund requires refundOfId');
  if (tx.kind === 'refund' && tx.originalRewardMinor === undefined) errors.push('refund requires originalRewardMinor');
  return errors;
}

function getZonedDateParts(isoString: string, timeZone: string): { year: number; month: number; day: number } {
  const date = new Date(isoString);
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    let year = date.getUTCFullYear();
    let month = date.getUTCMonth() + 1;
    let day = date.getUTCDate();
    for (const part of parts) {
      if (part.type === 'year') year = parseInt(part.value, 10);
      if (part.type === 'month') month = parseInt(part.value, 10);
      if (part.type === 'day') day = parseInt(part.value, 10);
    }
    return { year, month, day };
  } catch {
    return {
      year: date.getUTCFullYear(),
      month: date.getUTCMonth() + 1,
      day: date.getUTCDate(),
    };
  }
}

export function resolveCyclePeriodKey(
  card: CardDescriptor | HeldCard | undefined,
  cap: CapPeriod,
  occurredAtIso: string,
): string {
  const tz = cap.timezone ?? ((card && 'timezone' in card && typeof card.timezone === 'string') ? card.timezone : undefined);
  if (!tz) throw new Error('timezone is required to resolve cap period');
  const { year, month, day } = getZonedDateParts(occurredAtIso, tz);

  if (cap.kind === 'calendar_month') {
    const padMonth = String(month).padStart(2, '0');
    return `${cap.capPoolId ?? cap.usageKey}:${year}-${padMonth}`;
  }

  if (cap.kind === 'billing_cycle') {
    let closingDay = 15;
    if (card && 'billingCycleDay' in card && typeof card.billingCycleDay === 'number') {
      closingDay = card.billingCycleDay;
    }
    let closeYear = year;
    let closeMonth = month;

    if (day > closingDay) {
      closeMonth += 1;
      if (closeMonth > 12) {
        closeMonth = 1;
        closeYear += 1;
      }
    }
    const padMonth = String(closeMonth).padStart(2, '0');
    return `${cap.capPoolId ?? cap.usageKey}:${closeYear}-${padMonth}`;
  }

  return cap.capPoolId ?? cap.usageKey;
}

export function evaluateOffer(
  rule: OfferRuleVersion,
  tx: TransactionTuple,
  context: EvaluationContext,
): RewardBreakdown {
  const evaluationNow = context.now ?? new Date().toISOString();
  const base = { status: 'no_match' as EvaluationStatus, cardId: tx.cardId, transaction: tx, unknownReasons: [] as string[] };
  const inputErrors = invalidActual(tx);
  if (inputErrors.length) return { ...base, status: 'unknown', unknownReasons: inputErrors };
  if (rule.cardId !== tx.cardId) return base;
  if (tx.routeId !== undefined) {
    if (rule.routeId !== undefined && tx.routeId !== rule.routeId) return base;
    const route = context.paymentRoutes?.find((candidate) => candidate.id === tx.routeId);
    if (!route) return { ...base, status: 'unknown', ruleId: rule.id, unknownReasons: ['payment route is not registered'], diagnostics: [diagnostic('missing_required_fact', 'transaction.routeId', ['registered payment route'], 'register_payment_route')] };
    const evaluatedAt = Date.parse(evaluationNow);
    const startsInFuture = route.validFrom !== undefined && Date.parse(route.validFrom) > evaluatedAt;
    const ended = route.validTo !== undefined && Date.parse(route.validTo) < evaluatedAt;
    if (route.status !== 'active' || startsInFuture || ended) {
      const stale = route.status === 'stale' || startsInFuture || ended;
      return { ...base, status: stale ? 'stale' : 'needs_review', ruleId: rule.id, unknownReasons: [`payment route is ${route.status}${startsInFuture || ended ? ' outside its validity window' : ''}`], diagnostics: [diagnostic(stale ? 'stale_rule' : 'needs_review', 'transaction.routeId', ['active current payment route'], 'refresh_or_resolve_payment_route')] };
    }
    if (route.funding.kind === 'credit_card' && route.funding.cardId !== undefined && route.funding.cardId !== tx.cardId) return base;
    if (rule.componentKind === 'card_issuer') {
      if (route.funding.kind !== 'credit_card') return base;
      if (route.funding.cardId === undefined) return { ...base, status: 'unknown', ruleId: rule.id, unknownReasons: ['credit-card funding card identity is not registered'], diagnostics: [diagnostic('missing_required_fact', 'paymentRoute.funding.cardId', ['registered card identity'], 'register_payment_route')] };
    }
  } else if (rule.routeId !== undefined) {
    return base;
  }
  if (rule.eventRule !== undefined || rule.eventChainRule !== undefined) {
    const path = context.paymentEvents;
    if (!path) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['recommendation payment event path is missing'], diagnostics: [diagnostic('missing_required_fact', 'context.paymentEvents', ['target event and explicit source events'], 'ask_user')] };
    if (path.target.amount.amountMinor !== tx.amount.amountMinor || path.target.amount.currency !== tx.amount.currency || path.target.occurredAt !== tx.occurredAt) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['target payment event does not match recommendation transaction'], diagnostics: [diagnostic('invalid_input', 'context.paymentEvents.target', ['target event amount and timestamp'], 'rebuild_payment_event_path')] };
    const eventMatch = rule.eventRule !== undefined ? matchPaymentEvent(rule.eventRule, path.target) : matchPaymentEventChain(rule.eventChainRule!, path.target, path.sourceEvents);
    if (eventMatch.status === 'no_match') return base;
    if (eventMatch.status === 'unknown') return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: [...eventMatch.reasons], diagnostics: [diagnostic('missing_required_fact', 'context.paymentEvents', ['complete evidenced payment path'], 'ask_user')] };
  }
  if (rule.status !== 'active') {
    return { ...base, status: rule.status === 'stale' ? 'stale' : 'needs_review', ruleId: rule.id, unknownReasons: [`rule status is ${rule.status}`], diagnostics: [diagnostic(rule.status === 'stale' ? 'stale_rule' : 'needs_review', 'rule.status', ['rule confirmation'], 'refresh_or_confirm_offer')] };
  }
  const trustReasons: string[] = [];
  const source = context.sourceSnapshots?.[rule.sourceSnapshotId];
  if (!source) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing offer source snapshot'], diagnostics: [diagnostic('source_untrusted', 'rule.sourceSnapshotId', ['source snapshot'], 'provide_verified_source_snapshot')] };
  }
  if (rule.requires?.includes('source_verified') && source.verified !== true) trustReasons.push('source is not verified');
  if (rule.requires?.includes('user_confirmation') && context.userConfirmed !== true) trustReasons.push('user confirmation is required');
  if (trustReasons.length) return { ...base, status: 'needs_review', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: trustReasons };
  const sourceExpiry = source.validTo ? Date.parse(source.validTo) : Number.POSITIVE_INFINITY;
  const now = Date.parse(evaluationNow);
  if (!Number.isFinite(now) || (source.validTo !== undefined && !Number.isFinite(sourceExpiry))) {
    return { ...base, status: 'needs_review', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['invalid source snapshot dates'] };
  }
  if (now > sourceExpiry) {
    return { ...base, status: 'stale', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['offer source snapshot is expired'] };
  }
  const at = Date.parse(tx.occurredAt);
  const from = Date.parse(rule.validFrom);
  const to = rule.validTo ? Date.parse(rule.validTo) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(at) || !Number.isFinite(from) || at < from || at > to) return base;
  if (rule.predicate) {
    const outcome = evaluatePredicate(rule.predicate, tx, context);
    if (outcome.conflicts.length) {
      return { ...base, status: 'needs_review', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: outcome.conflicts };
    }
    if (!outcome.matched && outcome.missing.length === 0) return base;
    if (outcome.missing.length) {
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: outcome.missing };
    }
  } else {
    const matched = matchRule(rule, tx);
    if (matched === false) return base;
    if (matched.length) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: matched };
  }

  if (tx.amount.currency !== rule.settlementCurrency) {
    if (!tx.fx || tx.fx.baseCurrency !== tx.amount.currency || tx.fx.quoteCurrency !== rule.settlementCurrency) {
      const code = tx.fx ? 'fx_pair_mismatch' : 'fx_missing';
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: [code === 'fx_pair_mismatch' ? 'FX currency pair does not match settlement currency' : 'missing FX snapshot for settlement currency'], diagnostics: [diagnostic(code, 'transaction.fx', ['transaction.fx.baseCurrency', 'transaction.fx.quoteCurrency', 'transaction.fx.ratePpm', 'transaction.fx.capturedAt', 'transaction.fx.provider', 'transaction.fx.rateType'], code === 'fx_pair_mismatch' ? 'rebuild_fx_snapshot_for_pair' : 'query_approved_fx_source')] };
    }
    const txTime = Date.parse(tx.occurredAt);
    const fxTime = Date.parse(tx.fx.capturedAt);
    const maxAgeMs = (tx.fx.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
    if (Number.isFinite(txTime) && Number.isFinite(fxTime) && Math.abs(txTime - fxTime) > maxAgeMs) {
      return { ...base, status: 'stale', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['FX snapshot is stale'], diagnostics: [diagnostic('fx_stale', 'transaction.fx.capturedAt', ['transaction.fx.capturedAt'], 'refresh_fx_snapshot')] };
    }
  }

  const basis = rule.useSettlementAmount === true ? (tx.settlementAmount ?? tx.amount) : tx.amount;
  const settlementAmount = convertMinor(basis, rule.settlementCurrency, tx);
  if (settlementAmount === undefined) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for settlement currency'], diagnostics: [diagnostic('fx_missing', 'transaction.fx', ['transaction.fx.ratePpm', 'transaction.fx.provider', 'transaction.fx.rateType'], 'query_approved_fx_source')] };
  }
  let grossMinor: number;
  if (tx.kind === 'refund') grossMinor = -(tx.originalRewardMinor ?? 0);
  else if (rule.reward.kind === 'percentage') {
    const raw = (settlementAmount * (rule.reward.rateBps ?? 0)) / 10_000;
    grossMinor = roundReward(raw, rule.reward.roundingMode);
  } else if (rule.reward.kind === 'step' || rule.reward.kind === 'per_unit') {
    const unit = rule.reward.stepAmountMinor ?? rule.reward.unitAmountMinor;
    const reward = rule.reward.stepRewardMinor ?? rule.reward.unitRewardMinor;
    if (!unit || reward === undefined || unit <= 0) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['unsupported reward semantics: missing unit/step amounts'] };
    const raw = (settlementAmount / unit) * reward;
    grossMinor = roundReward(raw, rule.reward.roundingMode);
  } else if (rule.reward.kind === 'flat') {
    if (rule.reward.currency && rule.reward.currency !== rule.settlementCurrency) {
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['flat reward currency mismatch'] };
    }
    grossMinor = rule.reward.amountMinor ?? 0;
  } else return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: [`unsupported reward semantics: ${rule.reward.kind}`] };
  const money = (amountMinor: number): Money => ({ amountMinor, currency: rule.settlementCurrency });
  let cappedMinor = grossMinor;
  let capRemainingBefore: Money | undefined;
  let capRemainingAfter: Money | undefined;
  const caps = poolCaps(rule, context);
  if (rule.capPoolRefs?.length && caps.some((cap) => !cap.timezone && !cap.usageKey.startsWith('__missing_pool__'))) return { ...base, status: 'needs_review', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['cap pool timezone is required'] };
  const spendCaps = caps.filter((cap) => cap.metric === 'spend');
  let qualifyingAmount = settlementAmount;
  for (const cap of spendCaps) {
    const periodKey = resolveCyclePeriodKey(undefined, cap, tx.occurredAt);
    const usage = context.usageByKey?.[`${cap.capPoolId ?? cap.usageKey}|${periodKey}`] ?? context.usageByKey?.[periodKey] ?? context.usageByKey?.[cap.usageKey];
    if (!usage) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing ledger usage for cap'] };
    const used = convertMinor(usage, cap.cap.currency, tx);
    if (used === undefined) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for cap currency'] };
    qualifyingAmount = Math.min(qualifyingAmount, Math.max(0, cap.cap.amountMinor - used));
  }
  if (qualifyingAmount !== settlementAmount) {
    if (rule.reward.kind === 'percentage') grossMinor = roundReward((qualifyingAmount * (rule.reward.rateBps ?? 0)) / 10_000, rule.reward.roundingMode);
    else if (rule.reward.kind === 'step' || rule.reward.kind === 'per_unit') { const unit = rule.reward.stepAmountMinor ?? rule.reward.unitAmountMinor; const reward = rule.reward.stepRewardMinor ?? rule.reward.unitRewardMinor; if (unit && reward !== undefined) grossMinor = roundReward((qualifyingAmount / unit) * reward, rule.reward.roundingMode); }
  }
  cappedMinor = grossMinor;
  for (const cap of caps.filter((candidate) => candidate.metric === 'transaction_count')) {
    const periodKey = resolveCyclePeriodKey(undefined, cap, tx.occurredAt);
    const usage = context.usageByKey?.[`${cap.capPoolId ?? cap.usageKey}|${periodKey}`] ?? context.usageByKey?.[periodKey] ?? context.usageByKey?.[cap.usageKey];
    if (!usage) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing ledger usage for cap'] };
    const used = usage.amountMinor;
    if (used >= cap.cap.amountMinor) return { ...base, status: 'no_match', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['transaction count cap exhausted'] };
  }
  for (const cap of caps) {
    if (cap.usageKey.startsWith('__missing_pool__')) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing cap pool definition'] };
    if (cap.metric === 'spend' || cap.metric === 'transaction_count') continue;
    const periodKey = resolveCyclePeriodKey(undefined, cap, tx.occurredAt);
    const usage = context.usageByKey?.[`${cap.capPoolId ?? cap.usageKey}|${periodKey}`] ?? context.usageByKey?.[periodKey] ?? context.usageByKey?.[cap.usageKey];
    if (!usage) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing ledger usage for cap'] };
    const usedMinor = convertMinor(usage, cap.cap.currency, tx);
    if (usedMinor === undefined) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for cap currency'] };
    const remaining = Math.max(0, cap.cap.amountMinor - usedMinor);
    capRemainingBefore = { amountMinor: remaining, currency: cap.cap.currency };
    cappedMinor = Math.min(cappedMinor, remaining);
    capRemainingAfter = { amountMinor: Math.max(0, remaining - Math.max(0, cappedMinor)), currency: cap.cap.currency };
  }
  return {
    ...base,
    status: 'ok',
    ruleId: rule.id,
    ruleVersion: rule.version,
    sourceSnapshotId: rule.sourceSnapshotId,
    grossReward: money(grossMinor),
    cappedReward: money(cappedMinor),
    ...(capRemainingBefore ? { capRemainingBefore } : {}),
    ...(capRemainingAfter ? { capRemainingAfter } : {}),
    ...(rule.componentKind ? { components: [{ kind: rule.componentKind, ruleId: rule.id, ruleVersion: rule.version, sourceSnapshotId: rule.sourceSnapshotId, reward: money(cappedMinor), unit: rule.reward.currency ?? rule.settlementCurrency, confidence: rule.stacking ?? 'confirmed', ...(source.url ? { sourceReference: source.url } : {}), observedAt: source.fetchedAt }] } : {}),
  };
}

export function rankCards(
  cards: readonly CardDescriptor[],
  rules: readonly OfferRuleVersion[],
  tx: TransactionTuple,
  context: EvaluationContext,
  limit = 5,
): RankingEntry[] {
  const entries = cards
    .map((card) => {
      const cardRules = rules.filter((rule) => rule.cardId === card.id);
      const results = cardRules.map((rule) => evaluateOffer(rule, { ...tx, cardId: card.id }, context));
      const unsupported = results
        .map((result, index) => ({ result, rule: cardRules[index] }))
        .find(({ result, rule }) => {
          const mode = rule?.combination?.mode;
          return result.status === 'ok' && mode !== undefined && !['additive', 'replace', 'best_of', 'exclusive', 'prerequisite'].includes(mode);
        });
      if (unsupported) {
        return {
          ...unsupported.result,
          status: 'needs_review' as const,
          unknownReasons: ['unsupported combination policy'],
        };
      }
      const usable = results.map((result, index) => ({ result, rule: cardRules[index] })).filter(({ result, rule }) => {
        if (result.status !== 'ok') return false;
        const policy = rule?.combination;
        if (!policy) return true;
        if (!['additive', 'replace', 'best_of', 'exclusive', 'prerequisite'].includes(policy.mode)) return false;
        if (policy.mode === 'prerequisite') return (policy.prerequisiteRuleIds ?? []).every((id) => results.some((candidate, candidateIndex) => cardRules[candidateIndex]?.id === id && candidate.status === 'ok'));
        return true;
      });
      const grouped = new Map<string, typeof usable>();
      usable.forEach((entry, index) => { const policy = entry.rule?.combination; const key = policy?.groupId ?? `__${index}`; const list = grouped.get(key) ?? []; list.push(entry); grouped.set(key, list); });
      const candidates = [...grouped.values()].map((group) => {
        const policy = group[0]?.rule?.combination;
        if (policy?.mode === 'exclusive' && group.length > 1) return { ...group[0]!.result, status: 'needs_review' as const, unknownReasons: ['exclusive combination group has multiple matching offers'] };
        if (policy?.mode === 'additive' && group.length > 1) {
          const first = group[0]!.result;
          const gross = group.reduce((sum, entry) => sum + (entry.result.grossReward?.amountMinor ?? 0), 0);
          const capped = group.reduce((sum, entry) => sum + (entry.result.cappedReward?.amountMinor ?? 0), 0);
          return { ...first, grossReward: first.grossReward ? { ...first.grossReward, amountMinor: gross } : undefined, cappedReward: first.cappedReward ? { ...first.cappedReward, amountMinor: capped } : undefined };
        }
        if (policy?.mode === 'replace') return [...group].sort((a, b) => (b.rule?.combination?.priority ?? 0) - (a.rule?.combination?.priority ?? 0) || (a.rule?.id ?? '').localeCompare(b.rule?.id ?? ''))[0]?.result;
        return group.sort((a, b) => (b.result.cappedReward?.amountMinor ?? 0) - (a.result.cappedReward?.amountMinor ?? 0) || (a.rule?.id ?? '').localeCompare(b.rule?.id ?? ''))[0]?.result;
      }).filter((entry): entry is RewardBreakdown => Boolean(entry));
      if (candidates.length) {
        const exclusive = candidates.filter((entry) => entry.ruleId && cardRules.find((r) => r.id === entry.ruleId)?.combination?.mode === 'exclusive');
        if (exclusive.length > 1) return { ...exclusive[0]!, status: 'needs_review' as const, unknownReasons: ['multiple exclusive combination rules matched'] };
        if (exclusive.length === 1) return exclusive[0]!;
        const first = candidates[0]!;
        const components = candidates.flatMap((entry) => entry.components ?? []);
        const compatible = components.length === 0 || components.every((component) => component.unit === components[0]?.unit && component.reward?.currency === components[0]?.reward?.currency);
        const gross = candidates.reduce((sum, entry) => sum + (entry.grossReward?.amountMinor ?? 0), 0);
        const capped = candidates.reduce((sum, entry) => sum + (entry.cappedReward?.amountMinor ?? 0), 0);
        return { ...first, ...(components.length ? { components } : {}), ...(compatible ? { grossReward: first.grossReward ? { ...first.grossReward, amountMinor: gross } : undefined, cappedReward: first.cappedReward ? { ...first.cappedReward, amountMinor: capped } : undefined } : {}) };
      }
      const uncertain = results.find((result) => result.status === 'unknown' || result.status === 'needs_review' || result.status === 'stale');
      return uncertain ?? { status: 'no_match' as const, cardId: card.id, transaction: { ...tx, cardId: card.id }, unknownReasons: [] };
    })
    .filter((entry) => entry.status !== 'no_match')
    .sort((a, b) => {
      if (a.status === 'ok' && b.status !== 'ok') return -1;
      if (a.status !== 'ok' && b.status === 'ok') return 1;
      const aCapped = 'cappedReward' in a ? a.cappedReward?.amountMinor : undefined;
      const bCapped = 'cappedReward' in b ? b.cappedReward?.amountMinor : undefined;
      const rewardDifference = (bCapped ?? -1) - (aCapped ?? -1);
      if (rewardDifference !== 0) return rewardDifference;
      const aGross = 'grossReward' in a ? a.grossReward?.amountMinor : undefined;
      const bGross = 'grossReward' in b ? b.grossReward?.amountMinor : undefined;
      const grossDifference = (bGross ?? -1) - (aGross ?? -1);
      if (grossDifference !== 0) return grossDifference;
      return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
    })
    .slice(0, limit);
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
