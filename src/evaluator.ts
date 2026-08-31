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
  RewardBreakdown,
  TransactionTuple,
} from './types.js';

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
    const checkTime = Number.isFinite(txTime) ? txTime : (Number.isFinite(nowTime) ? nowTime : Date.now());

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

type PredicateOutcome = {
  matched: boolean;
  missing: string[];
  conflicts: string[];
};

function evaluatePredicate(predicate: Predicate, tx: TransactionTuple, context: EvaluationContext): PredicateOutcome {
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
  const tz = (card && 'timezone' in card && typeof card.timezone === 'string') ? card.timezone : 'Asia/Taipei';
  const { year, month, day } = getZonedDateParts(occurredAtIso, tz);

  if (cap.kind === 'calendar_month') {
    const padMonth = String(month).padStart(2, '0');
    return `${cap.usageKey}:${year}-${padMonth}`;
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
    return `${cap.usageKey}:${closeYear}-${padMonth}`;
  }

  return cap.usageKey;
}

export function evaluateOffer(
  rule: OfferRuleVersion,
  tx: TransactionTuple,
  context: EvaluationContext,
): RewardBreakdown {
  const base = { status: 'no_match' as EvaluationStatus, cardId: tx.cardId, transaction: tx, unknownReasons: [] as string[] };
  const inputErrors = invalidActual(tx);
  if (inputErrors.length) return { ...base, status: 'unknown', unknownReasons: inputErrors };
  if (rule.cardId !== tx.cardId) return base;
  if (rule.status !== 'active') {
    return { ...base, status: rule.status === 'stale' ? 'stale' : 'needs_review', ruleId: rule.id, unknownReasons: [`rule status is ${rule.status}`] };
  }
  const trustReasons: string[] = [];
  const source = context.sourceSnapshots?.[rule.sourceSnapshotId];
  if (!source) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing offer source snapshot'] };
  }
  if (rule.requires?.includes('source_verified') && source.verified !== true) trustReasons.push('source is not verified');
  if (rule.requires?.includes('user_confirmation') && context.userConfirmed !== true) trustReasons.push('user confirmation is required');
  if (trustReasons.length) return { ...base, status: 'needs_review', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: trustReasons };
  const sourceExpiry = source.validTo ? Date.parse(source.validTo) : Number.POSITIVE_INFINITY;
  const now = Date.parse(context.now);
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
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for settlement currency'] };
    }
    const txTime = Date.parse(tx.occurredAt);
    const fxTime = Date.parse(tx.fx.capturedAt);
    const maxAgeMs = (tx.fx.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
    if (Number.isFinite(txTime) && Number.isFinite(fxTime) && Math.abs(txTime - fxTime) > maxAgeMs) {
      return { ...base, status: 'stale', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['FX snapshot is stale'] };
    }
  }

  const settlementAmount = convertMinor(tx.amount, rule.settlementCurrency, tx);
  if (settlementAmount === undefined) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for settlement currency'] };
  }
  let grossMinor: number;
  if (tx.kind === 'refund') grossMinor = -(tx.originalRewardMinor ?? 0);
  else if (rule.reward.kind === 'percentage') grossMinor = Math.floor((settlementAmount * (rule.reward.rateBps ?? 0)) / 10_000);
  else {
    if (rule.reward.currency && rule.reward.currency !== rule.settlementCurrency) {
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['flat reward currency mismatch'] };
    }
    grossMinor = rule.reward.amountMinor ?? 0;
  }
  const money = (amountMinor: number): Money => ({ amountMinor, currency: rule.settlementCurrency });
  let cappedMinor = grossMinor;
  let capRemainingBefore: Money | undefined;
  let capRemainingAfter: Money | undefined;
  if (rule.cap) {
    const periodKey = resolveCyclePeriodKey(undefined, rule.cap, tx.occurredAt);
    const usage = context.usageByKey?.[periodKey] ?? context.usageByKey?.[rule.cap.usageKey];
    if (!usage) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing ledger usage for cap'] };
    const usedMinor = convertMinor(usage, rule.cap.cap.currency, tx);
    if (usedMinor === undefined) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for cap currency'] };
    const remaining = Math.max(0, rule.cap.cap.amountMinor - usedMinor);
    capRemainingBefore = { amountMinor: remaining, currency: rule.cap.cap.currency };
    cappedMinor = Math.min(grossMinor, remaining);
    capRemainingAfter = { amountMinor: Math.max(0, remaining - Math.max(0, cappedMinor)), currency: rule.cap.cap.currency };
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
      const usable = results.filter((result) => result.status === 'ok');
      if (usable.length) {
        const best = usable.sort((a, b) => (b.cappedReward?.amountMinor ?? 0) - (a.cappedReward?.amountMinor ?? 0))[0];
        if (best) return best;
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
      return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
    })
    .slice(0, limit);
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
