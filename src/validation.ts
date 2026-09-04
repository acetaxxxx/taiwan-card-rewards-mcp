import type { CardDescriptor, CardProduct, CapPeriod, CapPoolDefinition, CardSwitchCampaign, CardSwitchConfirmation, CardSwitchInput, CardSwitchEnrollment, CardSwitchProjection, EligibilityFact, EvaluationContext, FxSnapshot, HeldCard, Money, OfferConfirmation, OfferProvenance, OfferRuleVersion, OfferSourceSnapshot, Predicate, PredicateValue, RewardBreakdown, RewardSpec, RuleMatch, TransactionTuple, PaymentRouteKind, RewardComponentKind } from './types.js';
import type { StoredState } from './store.js';
import { RewardServiceError } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RewardServiceError('INVALID_INPUT', `${name} must be an object`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new RewardServiceError('UNKNOWN_FIELD', `${name} contains unsupported field: ${key}`);
}

function requiredString(value: unknown, name: string, id = false): string {
  if (typeof value !== 'string' || !value.trim() || value.length > 512 || (id && !ID.test(value))) throw new RewardServiceError('INVALID_INPUT', `${name} must be a valid string`);
  return value;
}

function optionalString(value: unknown, name: string, id = false): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, id);
}

function safeInt(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new RewardServiceError('INVALID_INPUT', `${name} must be a safe integer >= ${min}`);
  return value;
}

function finiteRate(value: unknown, name: string, min = 0, max = 1_000_000_000_000): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new RewardServiceError('INVALID_INPUT', `${name} must be finite, bounded, and >= ${min}`);
  return value;
}

function list(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) throw new RewardServiceError('INVALID_INPUT', `${name} must be an array`);
  return value.map((item) => requiredString(item, `${name} item`, true));
}

export function validateTimezone(value: unknown, name: string): string {
  const tz = requiredString(value, name);
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
  } catch {
    throw new RewardServiceError('INVALID_INPUT', `${name} must be a valid IANA timezone`);
  }
  return tz;
}

export function validateMoney(value: unknown, name: string): Money {
  const item = object(value, name);
  keys(item, ['amountMinor', 'currency'], name);
  return { amountMinor: safeInt(item.amountMinor, `${name}.amountMinor`), currency: requiredString(item.currency, `${name}.currency`, true).toUpperCase() };
}

export function validateCard(value: unknown): CardDescriptor {
  const item = object(value, 'card');
  keys(item, ['id', 'issuer', 'productName', 'network', 'last4', 'country', 'billingCycleDay', 'timezone'], 'card');
  const last4 = optionalString(item.last4, 'card.last4');
  if (last4 !== undefined && !/^\d{4}$/.test(last4)) throw new RewardServiceError('INVALID_INPUT', 'card.last4 must contain four digits');
  const billingCycleDay = item.billingCycleDay === undefined ? undefined : safeInt(item.billingCycleDay, 'card.billingCycleDay', 1);
  if (billingCycleDay !== undefined && billingCycleDay > 31) throw new RewardServiceError('INVALID_INPUT', 'card.billingCycleDay must be between 1 and 31');
  const timezone = item.timezone === undefined ? undefined : validateTimezone(item.timezone, 'card.timezone');
  return {
    id: requiredString(item.id, 'card.id', true),
    issuer: requiredString(item.issuer, 'card.issuer'),
    productName: requiredString(item.productName, 'card.productName'),
    ...(optionalString(item.network, 'card.network') ? { network: optionalString(item.network, 'card.network') } : {}),
    ...(last4 ? { last4 } : {}),
    ...(optionalString(item.country, 'card.country', true) ? { country: optionalString(item.country, 'card.country', true) } : {}),
    ...(billingCycleDay !== undefined ? { billingCycleDay } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
  };
}

export function validateCardProduct(value: unknown): CardProduct {
  const item = object(value, 'cardProduct');
  keys(item, ['id', 'issuer', 'productName', 'network', 'country'], 'cardProduct');
  return {
    id: requiredString(item.id, 'cardProduct.id', true),
    issuer: requiredString(item.issuer, 'cardProduct.issuer'),
    productName: requiredString(item.productName, 'cardProduct.productName'),
    ...(optionalString(item.network, 'cardProduct.network') ? { network: optionalString(item.network, 'cardProduct.network') } : {}),
    ...(optionalString(item.country, 'cardProduct.country', true) ? { country: optionalString(item.country, 'cardProduct.country', true) } : {}),
  };
}

export function validateHeldCard(value: unknown): HeldCard {
  const item = object(value, 'heldCard');
  keys(item, ['id', 'cardProductId', 'alias', 'billingCycleDay', 'timezone', 'plan', 'status'], 'heldCard');
  const billingCycleDay = item.billingCycleDay === undefined ? undefined : safeInt(item.billingCycleDay, 'heldCard.billingCycleDay', 1);
  if (billingCycleDay !== undefined && billingCycleDay > 31) throw new RewardServiceError('INVALID_INPUT', 'heldCard.billingCycleDay must be between 1 and 31');
  const timezone = item.timezone === undefined ? undefined : validateTimezone(item.timezone, 'heldCard.timezone');
  const status = optionalString(item.status, 'heldCard.status');
  if (status !== undefined && status !== 'active' && status !== 'inactive') throw new RewardServiceError('INVALID_INPUT', 'heldCard.status must be active or inactive');
  return {
    id: requiredString(item.id, 'heldCard.id', true),
    cardProductId: requiredString(item.cardProductId, 'heldCard.cardProductId', true),
    ...(optionalString(item.alias, 'heldCard.alias') ? { alias: optionalString(item.alias, 'heldCard.alias') } : {}),
    ...(billingCycleDay !== undefined ? { billingCycleDay } : {}),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(optionalString(item.plan, 'heldCard.plan') ? { plan: optionalString(item.plan, 'heldCard.plan') } : {}),
    ...(status !== undefined ? { status: status as 'active' | 'inactive' } : {}),
  };
}

export function validateEligibilityFact(value: unknown): EligibilityFact {
  const item = object(value, 'eligibilityFact');
  keys(item, ['id', 'cardId', 'factKey', 'value', 'validFrom', 'validTo'], 'eligibilityFact');
  const factKey = requiredString(item.factKey, 'eligibilityFact.factKey');
  if (!/^(user\.)?[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(factKey)) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFact.factKey is invalid');
  if (item.value === undefined) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFact.value is required');
  if (!['string', 'number', 'boolean'].includes(typeof item.value) && (!Array.isArray(item.value) || item.value.some((entry) => typeof entry !== 'string'))) {
    throw new RewardServiceError('INVALID_INPUT', 'eligibilityFact.value must be scalar or string array');
  }
  const validFrom = optionalString(item.validFrom, 'eligibilityFact.validFrom');
  const validTo = optionalString(item.validTo, 'eligibilityFact.validTo');
  if (validFrom && (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFact.validFrom must be an ISO date-time');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFact.validTo must be an ISO date-time');
  return {
    ...(optionalString(item.id, 'eligibilityFact.id', true) ? { id: optionalString(item.id, 'eligibilityFact.id', true) } : {}),
    ...(optionalString(item.cardId, 'eligibilityFact.cardId', true) ? { cardId: optionalString(item.cardId, 'eligibilityFact.cardId', true) } : {}),
    factKey,
    value: item.value as PredicateValue,
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

export function validateProvenance(value: unknown): OfferProvenance {
  const item = object(value, 'provenance');
  keys(item, ['sourceUrl', 'sourceDescription', 'submitter', 'submittedAt', 'contentFingerprint'], 'provenance');
  const submittedAt = requiredString(item.submittedAt, 'provenance.submittedAt');
  if (!Number.isFinite(Date.parse(submittedAt)) || !submittedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'provenance.submittedAt must be an ISO date-time');
  return {
    ...(optionalString(item.sourceUrl, 'provenance.sourceUrl') ? { sourceUrl: optionalString(item.sourceUrl, 'provenance.sourceUrl') } : {}),
    ...(optionalString(item.sourceDescription, 'provenance.sourceDescription') ? { sourceDescription: optionalString(item.sourceDescription, 'provenance.sourceDescription') } : {}),
    ...(optionalString(item.submitter, 'provenance.submitter') ? { submitter: optionalString(item.submitter, 'provenance.submitter') } : {}),
    submittedAt,
    contentFingerprint: requiredString(item.contentFingerprint, 'provenance.contentFingerprint'),
  };
}

export function validateSnapshot(value: unknown): OfferSourceSnapshot {
  const item = object(value, 'snapshot');
  keys(item, ['id', 'url', 'fetchedAt', 'contentHash', 'parserVersion', 'validFrom', 'validTo', 'excerpt', 'verified', 'sourceType', 'provenance'], 'snapshot');
  const url = requiredString(item.url, 'snapshot.url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a public origin URL without credentials');
  const fetchedAt = requiredString(item.fetchedAt, 'snapshot.fetchedAt');
  if (!Number.isFinite(Date.parse(fetchedAt)) || !fetchedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'snapshot.fetchedAt must be an ISO date-time');
  const validFrom = optionalString(item.validFrom, 'snapshot.validFrom');
  const validTo = optionalString(item.validTo, 'snapshot.validTo');
  if (validFrom && (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validFrom must be an ISO date-time');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validTo must be an ISO date-time');
  if (item.verified !== undefined && typeof item.verified !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'snapshot.verified must be boolean');
  let sourceType: OfferSourceSnapshot['sourceType'];
  if (item.sourceType !== undefined) {
    const st = requiredString(item.sourceType, 'snapshot.sourceType');
    if (st !== 'official' && st !== 'user_input') throw new RewardServiceError('INVALID_INPUT', 'snapshot.sourceType is invalid');
    sourceType = st;
  }
  const provenance = item.provenance !== undefined ? validateProvenance(item.provenance) : undefined;
  return {
    id: requiredString(item.id, 'snapshot.id', true),
    url,
    fetchedAt,
    contentHash: requiredString(item.contentHash, 'snapshot.contentHash'),
    parserVersion: requiredString(item.parserVersion, 'snapshot.parserVersion'),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    ...(item.excerpt === undefined ? {} : { excerpt: requiredString(item.excerpt, 'snapshot.excerpt') }),
    ...(item.verified === undefined ? {} : { verified: item.verified }),
    ...(sourceType ? { sourceType } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

function validatePredicate(value: unknown, name = 'rule.predicate', depth = 0): Predicate {
  if (depth > 16) throw new RewardServiceError('INVALID_INPUT', `${name} is too deeply nested`);
  const item = object(value, name);
  const op = requiredString(item.op, `${name}.op`);
  if (op === 'AND' || op === 'OR') {
    keys(item, ['op', 'rules'], name);
    if (!Array.isArray(item.rules) || item.rules.length === 0 || item.rules.length > 64) throw new RewardServiceError('INVALID_INPUT', `${name}.rules must be a non-empty array`);
    return { op, rules: item.rules.map((child, index) => validatePredicate(child, `${name}.rules[${index}]`, depth + 1)) };
  }
  if (op === 'NOT') {
    keys(item, ['op', 'rule'], name);
    return { op, rule: validatePredicate(item.rule, `${name}.rule`, depth + 1) };
  }
  if (op !== 'EQUALS' && op !== 'MATCH_ALLOWLIST') throw new RewardServiceError('INVALID_INPUT', `${name} operator is unsupported`);
  keys(item, ['field', 'op', 'value'], name);
  const field = requiredString(item.field, `${name}.field`);
  if (!/^(transaction|user)\.[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(field)) throw new RewardServiceError('INVALID_INPUT', `${name}.field is unsupported`);
  if (op === 'MATCH_ALLOWLIST') {
    if (!Array.isArray(item.value) || item.value.length === 0 || item.value.some((entry) => typeof entry !== 'string')) throw new RewardServiceError('INVALID_INPUT', `${name}.value must be a non-empty string array`);
  } else if (!['string', 'number', 'boolean'].includes(typeof item.value)) throw new RewardServiceError('INVALID_INPUT', `${name}.value must be scalar`);
  return { field, op, value: item.value as PredicateValue };
}

function validateMatch(value: unknown): RuleMatch {
  const item = object(value, 'rule.match');
  keys(item, ['merchants', 'mccs', 'countries', 'channels', 'paymentMethods'], 'rule.match');
  return { ...(list(item.merchants, 'rule.match.merchants') ? { merchants: list(item.merchants, 'rule.match.merchants') } : {}), ...(list(item.mccs, 'rule.match.mccs') ? { mccs: list(item.mccs, 'rule.match.mccs') } : {}), ...(list(item.countries, 'rule.match.countries') ? { countries: list(item.countries, 'rule.match.countries') } : {}), ...(list(item.channels, 'rule.match.channels') ? { channels: list(item.channels, 'rule.match.channels') } : {}), ...(list(item.paymentMethods, 'rule.match.paymentMethods') ? { paymentMethods: list(item.paymentMethods, 'rule.match.paymentMethods') } : {}) };
}

export function validateConfirmation(value: unknown): OfferConfirmation {
  const item = object(value, 'confirmation');
  keys(item, ['confirmedAt', 'confirmedBy', 'sourceReference', 'offerPeriod', 'rewardUnit', 'rewardConditionsSummary', 'capSummary'], 'confirmation');
  const confirmedAt = requiredString(item.confirmedAt, 'confirmation.confirmedAt');
  if (!Number.isFinite(Date.parse(confirmedAt)) || !confirmedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'confirmation.confirmedAt must be an ISO date-time');
  const periodItem = object(item.offerPeriod, 'confirmation.offerPeriod');
  keys(periodItem, ['validFrom', 'validTo'], 'confirmation.offerPeriod');
  const validFrom = requiredString(periodItem.validFrom, 'confirmation.offerPeriod.validFrom');
  if (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'confirmation.offerPeriod.validFrom must be an ISO date-time');
  const validTo = optionalString(periodItem.validTo, 'confirmation.offerPeriod.validTo');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'confirmation.offerPeriod.validTo must be an ISO date-time');
  return {
    confirmedAt,
    confirmedBy: requiredString(item.confirmedBy, 'confirmation.confirmedBy'),
    sourceReference: requiredString(item.sourceReference, 'confirmation.sourceReference'),
    offerPeriod: { validFrom, ...(validTo ? { validTo } : {}) },
    rewardUnit: requiredString(item.rewardUnit, 'confirmation.rewardUnit', true).toUpperCase(),
    ...(optionalString(item.rewardConditionsSummary, 'confirmation.rewardConditionsSummary') ? { rewardConditionsSummary: optionalString(item.rewardConditionsSummary, 'confirmation.rewardConditionsSummary') } : {}),
    ...(optionalString(item.capSummary, 'confirmation.capSummary') ? { capSummary: optionalString(item.capSummary, 'confirmation.capSummary') } : {}),
  };
}

export function validateRule(value: unknown): OfferRuleVersion {
  const item = object(value, 'rule');
  keys(item, ['id', 'cardId', 'version', 'sourceSnapshotId', 'status', 'validFrom', 'validTo', 'settlementCurrency', 'match', 'predicate', 'requires', 'reward', 'capPoolRefs', 'confirmation', 'combination', 'componentKind', 'useSettlementAmount', 'stacking'], 'rule');
  const status = requiredString(item.status, 'rule.status');
  if (!['candidate', 'active', 'stale', 'superseded', 'needs_review', 'unknown'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'rule.status is invalid');
  const rewardItem = object(item.reward, 'rule.reward');
  keys(rewardItem, ['kind', 'code', 'rateBps', 'amountMinor', 'currency', 'roundingMode', 'roundingScope', 'unitAmountMinor', 'unitRewardMinor', 'stepAmountMinor', 'stepRewardMinor'], 'rule.reward');
  const kind = requiredString(rewardItem.kind, 'rule.reward.kind');
  const roundingMode = rewardItem.roundingMode === undefined ? undefined : requiredString(rewardItem.roundingMode, 'rule.reward.roundingMode');
  const roundingScope = rewardItem.roundingScope === undefined ? undefined : requiredString(rewardItem.roundingScope, 'rule.reward.roundingScope');
  if (roundingMode !== undefined && !['floor', 'ceil', 'half_up', 'nearest'].includes(roundingMode)) throw new RewardServiceError('INVALID_INPUT', 'rule.reward.roundingMode is invalid');
  if (roundingScope !== undefined && !['per_transaction', 'per_period'].includes(roundingScope)) throw new RewardServiceError('INVALID_INPUT', 'rule.reward.roundingScope is invalid');
  const reward: RewardSpec = { kind, ...(rewardItem.code === undefined ? {} : { code: requiredString(rewardItem.code, 'rule.reward.code', true) }), ...(rewardItem.rateBps === undefined ? {} : { rateBps: finiteRate(rewardItem.rateBps, 'rule.reward.rateBps') }), ...(rewardItem.amountMinor === undefined ? {} : { amountMinor: safeInt(rewardItem.amountMinor, 'rule.reward.amountMinor') }), ...(rewardItem.currency === undefined ? {} : { currency: requiredString(rewardItem.currency, 'rule.reward.currency', true).toUpperCase() }), ...(roundingMode ? { roundingMode: roundingMode as RewardSpec['roundingMode'] } : {}), ...(roundingScope ? { roundingScope: roundingScope as RewardSpec['roundingScope'] } : {}), ...(rewardItem.unitAmountMinor === undefined ? {} : { unitAmountMinor: safeInt(rewardItem.unitAmountMinor, 'rule.reward.unitAmountMinor', 1) }), ...(rewardItem.unitRewardMinor === undefined ? {} : { unitRewardMinor: safeInt(rewardItem.unitRewardMinor, 'rule.reward.unitRewardMinor') }), ...(rewardItem.stepAmountMinor === undefined ? {} : { stepAmountMinor: safeInt(rewardItem.stepAmountMinor, 'rule.reward.stepAmountMinor', 1) }), ...(rewardItem.stepRewardMinor === undefined ? {} : { stepRewardMinor: safeInt(rewardItem.stepRewardMinor, 'rule.reward.stepRewardMinor') }) };
  const validFrom = requiredString(item.validFrom, 'rule.validFrom');
  if (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'rule.validFrom must be an ISO date-time');
  const validTo = optionalString(item.validTo, 'rule.validTo');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'rule.validTo must be an ISO date-time');
  let predicate: Predicate | undefined;
  if (item.predicate !== undefined) predicate = validatePredicate(item.predicate);
  let requires: OfferRuleVersion['requires'] | undefined;
  if (item.requires !== undefined) {
    if (!Array.isArray(item.requires) || item.requires.some((entry) => entry !== 'source_verified' && entry !== 'user_confirmation')) throw new RewardServiceError('INVALID_INPUT', 'rule.requires contains an unsupported trust requirement');
    requires = [...new Set(item.requires)] as OfferRuleVersion['requires'];
  }
  const confirmation = item.confirmation !== undefined ? validateConfirmation(item.confirmation) : undefined;
  let combination: OfferRuleVersion['combination'];
  if (item.combination !== undefined) {
    const c = object(item.combination, 'rule.combination');
    keys(c, ['mode', 'groupId', 'version', 'priority', 'prerequisiteRuleIds'], 'rule.combination');
    const mode = requiredString(c.mode, 'rule.combination.mode');
    if (!mode) throw new RewardServiceError('INVALID_INPUT', 'rule.combination.mode is required');
    combination = { mode, groupId: requiredString(c.groupId, 'rule.combination.groupId', true), version: requiredString(c.version, 'rule.combination.version'), ...(c.priority === undefined ? {} : { priority: safeInt(c.priority, 'rule.combination.priority') }), ...(c.prerequisiteRuleIds === undefined ? {} : { prerequisiteRuleIds: Array.isArray(c.prerequisiteRuleIds) ? c.prerequisiteRuleIds.map((v) => requiredString(v, 'rule.combination.prerequisiteRuleIds', true)) : [] }) };
  }
  let capPoolRefs: string[] | undefined;
  if (item.capPoolRefs !== undefined) {
    if (!Array.isArray(item.capPoolRefs) || item.capPoolRefs.length === 0 || item.capPoolRefs.some((v) => typeof v !== 'string' || !v.trim())) throw new RewardServiceError('INVALID_INPUT', 'rule.capPoolRefs must be a non-empty string array');
    capPoolRefs = [...new Set(item.capPoolRefs.map((v) => requiredString(v, 'rule.capPoolRefs', true)))];
  }
  const componentKind = item.componentKind === undefined ? undefined : requiredString(item.componentKind, 'rule.componentKind');
  if (componentKind !== undefined && !['merchant_loyalty', 'payment_provider', 'card_issuer'].includes(componentKind)) throw new RewardServiceError('INVALID_INPUT', 'rule.componentKind is invalid');
  const stacking = item.stacking === undefined ? undefined : requiredString(item.stacking, 'rule.stacking');
  if (stacking !== undefined && stacking !== 'confirmed' && stacking !== 'possible') throw new RewardServiceError('INVALID_INPUT', 'rule.stacking is invalid');
  if (item.useSettlementAmount !== undefined && typeof item.useSettlementAmount !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'rule.useSettlementAmount must be boolean');
  return { id: requiredString(item.id, 'rule.id', true), cardId: requiredString(item.cardId, 'rule.cardId', true), version: requiredString(item.version, 'rule.version'), sourceSnapshotId: requiredString(item.sourceSnapshotId, 'rule.sourceSnapshotId', true), status: status as OfferRuleVersion['status'], validFrom, ...(validTo ? { validTo } : {}), settlementCurrency: requiredString(item.settlementCurrency, 'rule.settlementCurrency', true).toUpperCase(), match: validateMatch(item.match), ...(predicate ? { predicate } : {}), ...(requires?.length ? { requires } : {}), reward, ...(capPoolRefs ? { capPoolRefs } : {}), ...(componentKind ? { componentKind: componentKind as OfferRuleVersion['componentKind'] } : {}), ...(item.useSettlementAmount === undefined ? {} : { useSettlementAmount: item.useSettlementAmount }), ...(stacking ? { stacking: stacking as OfferRuleVersion['stacking'] } : {}), ...(confirmation ? { confirmation } : {}), ...(combination ? { combination } : {}) };
}

export function validateCapPool(value: unknown): CapPoolDefinition {
  const item = object(value, 'capPool');
  keys(item, ['id', 'name', 'metric', 'period', 'limit', 'currency', 'timezone'], 'capPool');
  const metric = requiredString(item.metric, 'capPool.metric');
  const period = requiredString(item.period, 'capPool.period');
  if (!['calendar_month', 'billing_cycle', 'quarter', 'year', 'campaign'].includes(period) || !['spend', 'reward', 'transaction_count'].includes(metric)) throw new RewardServiceError('STORE_CORRUPT', 'capPool period or metric is invalid');
  const limit = safeInt(item.limit, 'capPool.limit', 0);
  return {
    id: requiredString(item.id, 'capPool.id', true),
    ...(item.name === undefined ? {} : { name: requiredString(item.name, 'capPool.name') }),
    metric: metric as CapPoolDefinition['metric'],
    period: period as CapPoolDefinition['period'],
    limit,
    ...(item.currency === undefined ? {} : { currency: requiredString(item.currency, 'capPool.currency', true).toUpperCase() }),
    ...(item.timezone === undefined ? {} : { timezone: validateTimezone(item.timezone, 'capPool.timezone') }),
  };
}

export function validateTransaction(value: unknown): TransactionTuple {
  const item = object(value, 'transaction');
  keys(item, ['idempotencyKey', 'cardId', 'kind', 'mode', 'merchant', 'mcc', 'country', 'channel', 'paymentMethod', 'occurredAt', 'amount', 'fx', 'refundOfId', 'originalRewardMinor', 'route', 'settlementAmount'], 'transaction');
  const kind = requiredString(item.kind, 'transaction.kind');
  const mode = requiredString(item.mode, 'transaction.mode');
  if (!['purchase', 'refund'].includes(kind) || !['planned', 'actual'].includes(mode)) throw new RewardServiceError('INVALID_INPUT', 'transaction kind or mode is invalid');
  let fx: FxSnapshot | undefined;
  if (item.fx !== undefined) {
    const fxItem = object(item.fx, 'transaction.fx');
    keys(fxItem, ['id', 'baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt', 'maxAgeSeconds'], 'transaction.fx');
    fx = {
      id: requiredString(fxItem.id, 'transaction.fx.id', true),
      baseCurrency: requiredString(fxItem.baseCurrency, 'transaction.fx.baseCurrency', true).toUpperCase(),
      quoteCurrency: requiredString(fxItem.quoteCurrency, 'transaction.fx.quoteCurrency', true).toUpperCase(),
      ratePpm: finiteRate(fxItem.ratePpm, 'transaction.fx.ratePpm', 1),
      capturedAt: requiredString(fxItem.capturedAt, 'transaction.fx.capturedAt'),
      ...(fxItem.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: safeInt(fxItem.maxAgeSeconds, 'transaction.fx.maxAgeSeconds', 1) }),
    };
  }
  const optional = (key: string, id = false) => optionalString(item[key], `transaction.${key}`, id);
  const occurredAt = requiredString(item.occurredAt, 'transaction.occurredAt');
  if (!Number.isFinite(Date.parse(occurredAt)) || !occurredAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'transaction.occurredAt must be an ISO date-time');
  if (fx && (!Number.isFinite(Date.parse(fx.capturedAt)) || !fx.capturedAt.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'transaction.fx.capturedAt must be an ISO date-time');
  const originalRewardMinor = item.originalRewardMinor === undefined ? undefined : safeInt(item.originalRewardMinor, 'transaction.originalRewardMinor');
  let route: TransactionTuple['route'];
  if (item.route !== undefined) { const routeItem = object(item.route, 'transaction.route'); keys(routeItem, ['kind', 'providerId', 'appId', 'displayName'], 'transaction.route'); const routeKind = requiredString(routeItem.kind, 'transaction.route.kind'); if (!['direct_card', 'wallet', 'merchant_app'].includes(routeKind)) throw new RewardServiceError('INVALID_INPUT', 'transaction.route.kind is invalid'); route = { kind: routeKind as PaymentRouteKind, ...(optionalString(routeItem.providerId, 'transaction.route.providerId', true) ? { providerId: optionalString(routeItem.providerId, 'transaction.route.providerId', true) } : {}), ...(optionalString(routeItem.appId, 'transaction.route.appId', true) ? { appId: optionalString(routeItem.appId, 'transaction.route.appId', true) } : {}), ...(optionalString(routeItem.displayName, 'transaction.route.displayName') ? { displayName: optionalString(routeItem.displayName, 'transaction.route.displayName') } : {}) }; }
  const settlementAmount = item.settlementAmount === undefined ? undefined : validateMoney(item.settlementAmount, 'transaction.settlementAmount');
  return { cardId: requiredString(item.cardId, 'transaction.cardId', true), kind: kind as TransactionTuple['kind'], mode: mode as TransactionTuple['mode'], occurredAt, amount: validateMoney(item.amount, 'transaction.amount'), ...(optional('idempotencyKey') ? { idempotencyKey: optional('idempotencyKey') } : {}), ...(optional('merchant') ? { merchant: optional('merchant') } : {}), ...(optional('mcc') ? { mcc: optional('mcc') } : {}), ...(optional('country', true) ? { country: optional('country', true) } : {}), ...(optional('channel') ? { channel: optional('channel') } : {}), ...(optional('paymentMethod') ? { paymentMethod: optional('paymentMethod') } : {}), ...(fx ? { fx } : {}), ...(optional('refundOfId', true) ? { refundOfId: optional('refundOfId', true) } : {}), ...(originalRewardMinor === undefined ? {} : { originalRewardMinor }), ...(route ? { route } : {}), ...(settlementAmount ? { settlementAmount } : {}) };
}

function validateUsageKey(key: string, name: string): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 256) throw new RewardServiceError('INVALID_INPUT', `${name} is invalid`);
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new RewardServiceError('INVALID_INPUT', `${name} is forbidden`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_:|-]{0,255}$/.test(key)) throw new RewardServiceError('INVALID_INPUT', `${name} contains invalid characters`);
  return key;
}

export function validateContext(value: unknown): EvaluationContext {
  const item = object(value, 'context');
  keys(item, ['now', 'usageByKey', 'sourceSnapshots', 'capPools', 'userConfirmed', 'heldCards', 'eligibilityFacts', 'userFacts'], 'context');
  const now = item.now === undefined ? new Date().toISOString() : requiredString(item.now, 'context.now');
  if (!Number.isFinite(Date.parse(now))) throw new RewardServiceError('INVALID_INPUT', 'context.now must be an ISO date');
  const usageByKey: Record<string, Money> = {};
  if (item.usageByKey !== undefined) {
    const usage = object(item.usageByKey, 'context.usageByKey');
    for (const [key, value] of Object.entries(usage)) usageByKey[validateUsageKey(key, 'context.usageByKey key')] = validateMoney(value, `context.usageByKey.${key}`);
  }
  const sourceSnapshots: Record<string, OfferSourceSnapshot> = {};
  if (item.sourceSnapshots !== undefined) {
    const snapshots = object(item.sourceSnapshots, 'context.sourceSnapshots');
    for (const [key, value] of Object.entries(snapshots)) {
      const snapshot = validateSnapshot(value);
      if (snapshot.id !== key) throw new RewardServiceError('INVALID_INPUT', 'source snapshot map key must match snapshot.id');
      sourceSnapshots[key] = snapshot;
    }
  }
  let capPools: CapPoolDefinition[] | undefined;
  if (item.capPools !== undefined) {
    if (!Array.isArray(item.capPools)) throw new RewardServiceError('INVALID_INPUT', 'context.capPools must be an array');
    capPools = item.capPools.map(validateCapPool);
  }
  if (item.userConfirmed !== undefined && typeof item.userConfirmed !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'context.userConfirmed must be boolean');
  let heldCards: HeldCard[] | undefined;
  if (item.heldCards !== undefined) {
    if (!Array.isArray(item.heldCards)) throw new RewardServiceError('INVALID_INPUT', 'context.heldCards must be an array');
    heldCards = item.heldCards.map(validateHeldCard);
  }
  let eligibilityFacts: EligibilityFact[] | undefined;
  if (item.eligibilityFacts !== undefined) {
    if (!Array.isArray(item.eligibilityFacts)) throw new RewardServiceError('INVALID_INPUT', 'context.eligibilityFacts must be an array');
    eligibilityFacts = item.eligibilityFacts.map(validateEligibilityFact);
  }
  let userFacts: Record<string, PredicateValue> | undefined;
  if (item.userFacts !== undefined) {
    const factsObj = object(item.userFacts, 'context.userFacts');
    userFacts = {};
    for (const [key, val] of Object.entries(factsObj)) {
      if (!/^(user\.)?[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(key)) throw new RewardServiceError('INVALID_INPUT', `context.userFacts key is invalid: ${key}`);
      if (!['string', 'number', 'boolean'].includes(typeof val) && (!Array.isArray(val) || val.some((entry) => typeof entry !== 'string'))) {
        throw new RewardServiceError('INVALID_INPUT', `context.userFacts[${key}] must be scalar or string array`);
      }
      userFacts[key] = val as PredicateValue;
    }
  }
  return {
    now,
    ...(Object.keys(usageByKey).length ? { usageByKey } : {}),
    ...(Object.keys(sourceSnapshots).length ? { sourceSnapshots } : {}),
    ...(capPools ? { capPools } : {}),
    ...(item.userConfirmed === undefined ? {} : { userConfirmed: item.userConfirmed }),
    ...(heldCards ? { heldCards } : {}),
    ...(eligibilityFacts ? { eligibilityFacts } : {}),
    ...(userFacts ? { userFacts } : {}),
  };
}

function validateSignedMoney(value: unknown, name: string): Money {
  const item = object(value, name);
  keys(item, ['amountMinor', 'currency'], name);
  if (typeof item.amountMinor !== 'number' || !Number.isSafeInteger(item.amountMinor)) throw new RewardServiceError('INVALID_INPUT', `${name}.amountMinor must be a safe integer`);
  return { amountMinor: item.amountMinor, currency: requiredString(item.currency, `${name}.currency`, true).toUpperCase() };
}

export function validateRewardBreakdown(value: unknown): RewardBreakdown {
  const item = object(value, 'reward');
  keys(item, ['status', 'cardId', 'transaction', 'ruleId', 'ruleVersion', 'sourceSnapshotId', 'grossReward', 'cappedReward', 'capRemainingBefore', 'capRemainingAfter', 'unknownReasons', 'components'], 'reward');
  const status = requiredString(item.status, 'reward.status');
  if (!['ok', 'no_match', 'unknown', 'needs_review', 'stale'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'reward.status is invalid');
  if (!Array.isArray(item.unknownReasons) || item.unknownReasons.some((reason) => typeof reason !== 'string')) throw new RewardServiceError('INVALID_INPUT', 'reward.unknownReasons must be a string array');
  let components: RewardBreakdown['components'];
  if (item.components !== undefined) { if (!Array.isArray(item.components)) throw new RewardServiceError('INVALID_INPUT', 'reward.components must be an array'); components = item.components.map((value) => { const c = object(value, 'reward.component'); keys(c, ['kind', 'ruleId', 'ruleVersion', 'sourceSnapshotId', 'reward', 'unit', 'confidence', 'sourceReference', 'observedAt'], 'reward.component'); const confidence = requiredString(c.confidence, 'reward.component.confidence'); if (confidence !== 'confirmed' && confidence !== 'possible') throw new RewardServiceError('INVALID_INPUT', 'reward.component.confidence is invalid'); return { kind: requiredString(c.kind, 'reward.component.kind') as never, ruleId: requiredString(c.ruleId, 'reward.component.ruleId', true), ruleVersion: requiredString(c.ruleVersion, 'reward.component.ruleVersion'), sourceSnapshotId: requiredString(c.sourceSnapshotId, 'reward.component.sourceSnapshotId', true), ...(c.reward === undefined ? {} : { reward: validateSignedMoney(c.reward, 'reward.component.reward') }), unit: requiredString(c.unit, 'reward.component.unit'), confidence: confidence as 'confirmed' | 'possible', ...(c.sourceReference === undefined ? {} : { sourceReference: requiredString(c.sourceReference, 'reward.component.sourceReference') }), ...(c.observedAt === undefined ? {} : { observedAt: iso(c.observedAt, 'reward.component.observedAt') }) }; }); }
  return {
    status: status as RewardBreakdown['status'],
    cardId: requiredString(item.cardId, 'reward.cardId', true),
    transaction: validateTransaction(item.transaction),
    ...(item.ruleId === undefined ? {} : { ruleId: requiredString(item.ruleId, 'reward.ruleId', true) }),
    ...(item.ruleVersion === undefined ? {} : { ruleVersion: requiredString(item.ruleVersion, 'reward.ruleVersion') }),
    ...(item.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: requiredString(item.sourceSnapshotId, 'reward.sourceSnapshotId', true) }),
    ...(item.grossReward === undefined ? {} : { grossReward: validateSignedMoney(item.grossReward, 'reward.grossReward') }),
    ...(item.cappedReward === undefined ? {} : { cappedReward: validateSignedMoney(item.cappedReward, 'reward.cappedReward') }),
    ...(item.capRemainingBefore === undefined ? {} : { capRemainingBefore: validateMoney(item.capRemainingBefore, 'reward.capRemainingBefore') }),
    ...(item.capRemainingAfter === undefined ? {} : { capRemainingAfter: validateMoney(item.capRemainingAfter, 'reward.capRemainingAfter') }),
    unknownReasons: [...item.unknownReasons], ...(components ? { components } : {}),
  };
}

function iso(value: unknown, name: string): string {
  const result = requiredString(value, name);
  if (!Number.isFinite(Date.parse(result)) || !result.includes('T')) throw new RewardServiceError('INVALID_INPUT', `${name} must be an ISO date-time`);
  return result;
}

export function validateCardSwitchCampaign(value: unknown): CardSwitchCampaign {
  const item = object(value, 'campaign');
  keys(item, ['id', 'issuer', 'network', 'cardId', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'effectiveFrom', 'effectiveTo', 'eligibility', 'rewardCaps'], 'campaign');
  const effectiveTo = item.effectiveTo === undefined ? undefined : iso(item.effectiveTo, 'campaign.effectiveTo');
  const eligibility = item.eligibility === undefined ? undefined : list(item.eligibility, 'campaign.eligibility');
  const rewardCaps = item.rewardCaps === undefined ? undefined : (Array.isArray(item.rewardCaps) ? item.rewardCaps.map((cap, i) => validateMoney(cap, `campaign.rewardCaps[${i}]`)) : (() => { throw new RewardServiceError('INVALID_INPUT', 'campaign.rewardCaps must be an array'); })());
  return { id: requiredString(item.id, 'campaign.id', true), issuer: requiredString(item.issuer, 'campaign.issuer'), ...(optionalString(item.network, 'campaign.network') ? { network: optionalString(item.network, 'campaign.network') } : {}), ...(optionalString(item.cardId, 'campaign.cardId', true) ? { cardId: optionalString(item.cardId, 'campaign.cardId', true) } : {}), sourceUrl: requiredString(item.sourceUrl, 'campaign.sourceUrl'), sourceSnapshotAt: iso(item.sourceSnapshotAt, 'campaign.sourceSnapshotAt'), ruleVersion: requiredString(item.ruleVersion, 'campaign.ruleVersion'), effectiveFrom: iso(item.effectiveFrom, 'campaign.effectiveFrom'), ...(effectiveTo ? { effectiveTo } : {}), ...(eligibility ? { eligibility } : {}), ...(rewardCaps ? { rewardCaps } : {}) };
}

export function validateCardSwitchEnrollment(value: unknown): CardSwitchEnrollment {
  const item = object(value, 'enrollment');
  keys(item, ['campaignId', 'cardId', 'enrolled', 'usageByPeriod'], 'enrollment');
  const usageByPeriod: Record<string, Money> = {};
  if (item.usageByPeriod !== undefined) for (const [key, money] of Object.entries(object(item.usageByPeriod, 'enrollment.usageByPeriod'))) usageByPeriod[requiredString(key, 'enrollment usage key', true)] = validateSignedMoney(money, `enrollment.usageByPeriod.${key}`);
  return { campaignId: requiredString(item.campaignId, 'enrollment.campaignId', true), cardId: requiredString(item.cardId, 'enrollment.cardId', true), enrolled: item.enrolled === true, ...(Object.keys(usageByPeriod).length ? { usageByPeriod } : {}) };
}

export function validateCardSwitchConfirmation(value: unknown): CardSwitchConfirmation {
  const item = object(value, 'confirmation');
  keys(item, ['confirmedBy', 'confirmedAtUtc', 'completed'], 'confirmation');
  if (item.completed !== true) throw new RewardServiceError('INVALID_CONFIRMATION', 'bank-app action must be completed and user-confirmed');
  return { confirmedBy: requiredString(item.confirmedBy, 'confirmation.confirmedBy'), confirmedAtUtc: iso(item.confirmedAtUtc, 'confirmation.confirmedAtUtc'), completed: true };
}

export function validateCardSwitchInput(value: unknown): CardSwitchInput {
  const item = object(value, 'input');
  keys(item, ['action', 'cardId', 'timezone', 'switchedAtUtc', 'benefit', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'confirmation', 'idempotencyKey', 'adjustmentReason', 'campaign', 'enrollment'], 'input');
  const action = requiredString(item.action, 'input.action');
  if (action !== 'record' && action !== 'adjust') throw new RewardServiceError('INVALID_INPUT', 'input.action must be record or adjust');
  return { action, cardId: requiredString(item.cardId, 'input.cardId', true), timezone: validateTimezone(item.timezone, 'input.timezone'), switchedAtUtc: iso(item.switchedAtUtc, 'input.switchedAtUtc'), benefit: requiredString(item.benefit, 'input.benefit'), sourceUrl: requiredString(item.sourceUrl, 'input.sourceUrl'), sourceSnapshotAt: iso(item.sourceSnapshotAt, 'input.sourceSnapshotAt'), ruleVersion: requiredString(item.ruleVersion, 'input.ruleVersion'), confirmation: validateCardSwitchConfirmation(item.confirmation), idempotencyKey: requiredString(item.idempotencyKey, 'input.idempotencyKey', true), ...(item.adjustmentReason === undefined ? {} : { adjustmentReason: requiredString(item.adjustmentReason, 'input.adjustmentReason') }), ...(item.campaign === undefined ? {} : { campaign: validateCardSwitchCampaign(item.campaign) }), ...(item.enrollment === undefined ? {} : { enrollment: validateCardSwitchEnrollment(item.enrollment) }) };
}

export function validateUserBenefitInput(value: unknown): import('./types.js').UserBenefitInput {
  const item = object(value, 'input');
  keys(item, ['kind', 'action', 'cardId', 'campaignId', 'timezone', 'completedAt', 'effectiveFrom', 'effectiveTo', 'benefit', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'confirmation', 'idempotencyKey', 'adjustmentReason'], 'input');
  const kind = requiredString(item.kind, 'input.kind');
  if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('INVALID_INPUT', 'input.kind is invalid');
  const action = requiredString(item.action, 'input.action');
  if (action !== 'record' && action !== 'adjust') throw new RewardServiceError('INVALID_INPUT', 'input.action must be record or adjust');
  return { kind, action, cardId: requiredString(item.cardId, 'input.cardId', true), ...(optionalString(item.campaignId, 'input.campaignId', true) ? { campaignId: optionalString(item.campaignId, 'input.campaignId', true) } : {}), timezone: validateTimezone(item.timezone, 'input.timezone'), completedAt: iso(item.completedAt, 'input.completedAt'), effectiveFrom: iso(item.effectiveFrom, 'input.effectiveFrom'), ...(item.effectiveTo === undefined ? {} : { effectiveTo: iso(item.effectiveTo, 'input.effectiveTo') }), benefit: requiredString(item.benefit, 'input.benefit'), sourceUrl: requiredString(item.sourceUrl, 'input.sourceUrl'), sourceSnapshotAt: iso(item.sourceSnapshotAt, 'input.sourceSnapshotAt'), ruleVersion: requiredString(item.ruleVersion, 'input.ruleVersion'), confirmation: validateCardSwitchConfirmation(item.confirmation), idempotencyKey: requiredString(item.idempotencyKey, 'input.idempotencyKey', true), ...(item.adjustmentReason === undefined ? {} : { adjustmentReason: requiredString(item.adjustmentReason, 'input.adjustmentReason') }) };
}

export function validateCardSwitchProjection(value: unknown): CardSwitchProjection {
  const item = object(value, 'cardSwitch');
  keys(item, ['kind', 'cardId', 'timezone', 'switchedAtUtc', 'switchedAtLocal', 'switchedLocalDate', 'benefit', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'confirmation', 'action', 'idempotencyKey', 'adjustmentReason', 'effectiveFrom', 'effectiveTo', 'campaignId'], 'cardSwitch');
  const action = requiredString(item.action, 'cardSwitch.action');
  if (action !== 'record' && action !== 'adjust') throw new RewardServiceError('STORE_CORRUPT', 'cardSwitch.action is invalid');
  const kind = item.kind === undefined ? 'card_switch' : requiredString(item.kind, 'cardSwitch.kind');
  if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('STORE_CORRUPT', 'cardSwitch.kind is invalid');
  return { kind, cardId: requiredString(item.cardId, 'cardSwitch.cardId', true), timezone: validateTimezone(item.timezone, 'cardSwitch.timezone'), switchedAtUtc: iso(item.switchedAtUtc, 'cardSwitch.switchedAtUtc'), switchedAtLocal: requiredString(item.switchedAtLocal, 'cardSwitch.switchedAtLocal'), switchedLocalDate: requiredString(item.switchedLocalDate, 'cardSwitch.switchedLocalDate'), benefit: requiredString(item.benefit, 'cardSwitch.benefit'), sourceUrl: requiredString(item.sourceUrl, 'cardSwitch.sourceUrl'), sourceSnapshotAt: iso(item.sourceSnapshotAt, 'cardSwitch.sourceSnapshotAt'), ruleVersion: requiredString(item.ruleVersion, 'cardSwitch.ruleVersion'), confirmation: validateCardSwitchConfirmation(item.confirmation), action, idempotencyKey: requiredString(item.idempotencyKey, 'cardSwitch.idempotencyKey', true), ...(item.adjustmentReason === undefined ? {} : { adjustmentReason: requiredString(item.adjustmentReason, 'cardSwitch.adjustmentReason') }), ...(item.effectiveFrom === undefined ? {} : { effectiveFrom: iso(item.effectiveFrom, 'cardSwitch.effectiveFrom') }), ...(item.effectiveTo === undefined ? {} : { effectiveTo: iso(item.effectiveTo, 'cardSwitch.effectiveTo') }), ...(item.campaignId === undefined ? {} : { campaignId: requiredString(item.campaignId, 'cardSwitch.campaignId', true) }) };
}

export function validateStoredState(value: unknown): StoredState {
  const item = object(value, 'stored state');
  keys(item, ['schemaVersion', 'cards', 'snapshots', 'rules', 'transactions', 'campaigns', 'switchEnrollments', 'cardSwitches', 'capPools'], 'stored state');
  if (item.schemaVersion !== 2) throw new RewardServiceError('INCOMPATIBLE_SCHEMA', 'schema v1 or another unsupported schema requires explicit migration or reset; data was not deleted');
  if (!Array.isArray(item.cards) || !Array.isArray(item.snapshots) || !Array.isArray(item.rules) || !Array.isArray(item.transactions)) throw new RewardServiceError('STORE_CORRUPT', 'state collections must be arrays');
  const transactions = item.transactions.map((value, index) => {
    const record = object(value, `stored state.transactions[${index}]`);
    keys(record, ['transaction', 'reward'], `stored state.transactions[${index}]`);
    const transaction = validateTransaction(record.transaction);
    const reward = validateRewardBreakdown(record.reward);
    if (JSON.stringify(reward.transaction) !== JSON.stringify(transaction)) throw new RewardServiceError('STORE_CORRUPT', `stored state.transactions[${index}] transaction mismatch`);
    return { transaction, reward };
  });
  const campaigns = item.campaigns === undefined ? [] : (Array.isArray(item.campaigns) ? item.campaigns.map(validateCardSwitchCampaign) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'campaigns must be an array'); })());
  const switchEnrollments = item.switchEnrollments === undefined ? [] : (Array.isArray(item.switchEnrollments) ? item.switchEnrollments.map(validateCardSwitchEnrollment) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'switchEnrollments must be an array'); })());
  const cardSwitches = item.cardSwitches === undefined ? [] : (Array.isArray(item.cardSwitches) ? item.cardSwitches.map(validateCardSwitchProjection) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'cardSwitches must be an array'); })());
  const capPools = item.capPools === undefined ? [] : (Array.isArray(item.capPools) ? item.capPools.map(validateCapPool) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'capPools must be an array'); })());
  if (new Set(capPools.map((pool) => pool.id)).size !== capPools.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate cap pool id');
  return { schemaVersion: 2, cards: item.cards.map(validateCard), snapshots: item.snapshots.map(validateSnapshot), rules: item.rules.map(validateRule), transactions, campaigns, switchEnrollments, cardSwitches, capPools };
}

export function validateToolArgs(name: string, value: unknown): Record<string, unknown> {
  const args = object(value, 'tool arguments');
  const allowed: Record<string, string[]> = { register_card: ['card'], list_cards: [], upsert_offer: ['snapshot', 'rule', 'confirmation', 'capPools'], recommend: ['transaction', 'limit'], record_transaction: ['transaction'], remaining_caps: ['cardId', 'asOf'], calculate_reward: ['rule', 'transaction', 'context'], rank_cards: ['cards', 'rules', 'transaction', 'context'], get_user_benefit_status: ['kind', 'cardId', 'asOfUtc'], upsert_user_benefit_status: ['input'] };
  if (!allowed[name]) throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  keys(args, allowed[name], `tool ${name}`);
  return args;
}
