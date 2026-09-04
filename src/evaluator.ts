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
  RewardBreakdown,
  TransactionTuple,
} from './types.js';


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
      return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for settlement currency'] };
    }
    const txTime = Date.parse(tx.occurredAt);
    const fxTime = Date.parse(tx.fx.capturedAt);
    const maxAgeMs = (tx.fx.maxAgeSeconds ?? 7 * 24 * 3600) * 1000;
    if (Number.isFinite(txTime) && Number.isFinite(fxTime) && Math.abs(txTime - fxTime) > maxAgeMs) {
      return { ...base, status: 'stale', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['FX snapshot is stale'] };
    }
  }

  const basis = rule.useSettlementAmount === true ? (tx.settlementAmount ?? tx.amount) : tx.amount;
  const settlementAmount = convertMinor(basis, rule.settlementCurrency, tx);
  if (settlementAmount === undefined) {
    return { ...base, status: 'unknown', ruleId: rule.id, ruleVersion: rule.version, unknownReasons: ['missing FX snapshot for settlement currency'] };
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
      return a.cardId < b.cardId ? -1 : a.cardId > b.cardId ? 1 : 0;
    })
    .slice(0, limit);
  return entries.map((entry, index) => ({ ...entry, rank: index + 1 }));
}
