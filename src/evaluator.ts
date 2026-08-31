import type {
  CardDescriptor,
  EvaluationContext,
  EvaluationStatus,
  Money,
  OfferRuleVersion,
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

function convertMinor(amount: Money, currency: string, tx: TransactionTuple): number | undefined {
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
  const source = context.sourceSnapshots?.[rule.sourceSnapshotId];
  if (!source) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing offer source snapshot'] };
  }
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
  const matched = matchRule(rule, tx);
  if (matched === false) return base;
  if (matched.length) return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: matched };

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
    const usage = context.usageByKey?.[rule.cap.usageKey];
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
      return uncertain ?? { status: 'no_match' as const, cardId: card.id, transaction: { ...tx, cardId }, unknownReasons: [] };
    })
    .filter((entry) => entry.status !== 'no_match')
    .sort((a, b) => {
      if (a.status === 'ok' && b.status !== 'ok') return -1;
      if (a.status !== 'ok' && b.status === 'ok') return 1;
      return (b.cappedReward?.amountMinor ?? -1) - (a.cappedReward?.amountMinor ?? -1);
    })
    .slice(0, limit);
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
