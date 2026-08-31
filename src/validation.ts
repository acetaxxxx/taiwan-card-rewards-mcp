import type { CardDescriptor, CardProduct, CapPeriod, EligibilityFact, EvaluationContext, FxSnapshot, HeldCard, Money, OfferConfirmation, OfferProvenance, OfferRuleVersion, OfferSourceSnapshot, Predicate, PredicateValue, RewardSpec, RuleMatch, TransactionTuple } from './types.js';
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
  keys(item, ['id', 'cardId', 'version', 'sourceSnapshotId', 'status', 'validFrom', 'validTo', 'settlementCurrency', 'match', 'predicate', 'requires', 'reward', 'cap', 'confirmation'], 'rule');
  const status = requiredString(item.status, 'rule.status');
  if (!['candidate', 'active', 'stale', 'superseded', 'needs_review', 'unknown'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'rule.status is invalid');
  const rewardItem = object(item.reward, 'rule.reward');
  keys(rewardItem, ['kind', 'rateBps', 'amountMinor', 'currency'], 'rule.reward');
  const kind = requiredString(rewardItem.kind, 'rule.reward.kind');
  if (kind !== 'percentage' && kind !== 'flat') throw new RewardServiceError('INVALID_INPUT', 'rule.reward.kind is invalid');
  const reward: RewardSpec = kind === 'percentage' ? { kind: 'percentage', rateBps: finiteRate(rewardItem.rateBps, 'rule.reward.rateBps') } : { kind: 'flat', amountMinor: safeInt(rewardItem.amountMinor, 'rule.reward.amountMinor'), ...(rewardItem.currency === undefined ? {} : { currency: requiredString(rewardItem.currency, 'rule.reward.currency', true).toUpperCase() }) };
  let cap: OfferRuleVersion['cap'];
  if (item.cap !== undefined) {
    const capItem = object(item.cap, 'rule.cap');
    keys(capItem, ['kind', 'cap', 'usageKey'], 'rule.cap');
    const capKind = requiredString(capItem.kind, 'rule.cap.kind');
    if (!['calendar_month', 'billing_cycle', 'campaign'].includes(capKind)) throw new RewardServiceError('INVALID_INPUT', 'rule.cap.kind is invalid');
    cap = { kind: capKind as CapPeriod['kind'], cap: validateMoney(capItem.cap, 'rule.cap.cap'), usageKey: requiredString(capItem.usageKey, 'rule.cap.usageKey', true) };
  }
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
  return { id: requiredString(item.id, 'rule.id', true), cardId: requiredString(item.cardId, 'rule.cardId', true), version: requiredString(item.version, 'rule.version'), sourceSnapshotId: requiredString(item.sourceSnapshotId, 'rule.sourceSnapshotId', true), status: status as OfferRuleVersion['status'], validFrom, ...(validTo ? { validTo } : {}), settlementCurrency: requiredString(item.settlementCurrency, 'rule.settlementCurrency', true).toUpperCase(), match: validateMatch(item.match), ...(predicate ? { predicate } : {}), ...(requires?.length ? { requires } : {}), reward, ...(cap ? { cap } : {}), ...(confirmation ? { confirmation } : {}) };
}

export function validateTransaction(value: unknown): TransactionTuple {
  const item = object(value, 'transaction');
  keys(item, ['idempotencyKey', 'cardId', 'kind', 'mode', 'merchant', 'mcc', 'country', 'channel', 'paymentMethod', 'occurredAt', 'amount', 'fx', 'refundOfId', 'originalRewardMinor'], 'transaction');
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
  return { cardId: requiredString(item.cardId, 'transaction.cardId', true), kind: kind as TransactionTuple['kind'], mode: mode as TransactionTuple['mode'], occurredAt, amount: validateMoney(item.amount, 'transaction.amount'), ...(optional('idempotencyKey') ? { idempotencyKey: optional('idempotencyKey') } : {}), ...(optional('merchant') ? { merchant: optional('merchant') } : {}), ...(optional('mcc') ? { mcc: optional('mcc') } : {}), ...(optional('country', true) ? { country: optional('country', true) } : {}), ...(optional('channel') ? { channel: optional('channel') } : {}), ...(optional('paymentMethod') ? { paymentMethod: optional('paymentMethod') } : {}), ...(fx ? { fx } : {}), ...(optional('refundOfId', true) ? { refundOfId: optional('refundOfId', true) } : {}), ...(originalRewardMinor === undefined ? {} : { originalRewardMinor }) };
}

export function validateContext(value: unknown): EvaluationContext {
  const item = object(value, 'context');
  keys(item, ['now', 'usageByKey', 'sourceSnapshots', 'userConfirmed', 'heldCards', 'eligibilityFacts', 'userFacts'], 'context');
  const now = requiredString(item.now, 'context.now');
  if (!Number.isFinite(Date.parse(now))) throw new RewardServiceError('INVALID_INPUT', 'context.now must be an ISO date');
  const usageByKey: Record<string, Money> = {};
  if (item.usageByKey !== undefined) {
    const usage = object(item.usageByKey, 'context.usageByKey');
    for (const [key, value] of Object.entries(usage)) usageByKey[requiredString(key, 'context.usageByKey key', true)] = validateMoney(value, `context.usageByKey.${key}`);
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
    ...(item.userConfirmed === undefined ? {} : { userConfirmed: item.userConfirmed }),
    ...(heldCards ? { heldCards } : {}),
    ...(eligibilityFacts ? { eligibilityFacts } : {}),
    ...(userFacts ? { userFacts } : {}),
  };
}

export function validateToolArgs(name: string, value: unknown): Record<string, unknown> {
  const args = object(value, 'tool arguments');
  const allowed: Record<string, string[]> = { register_card: ['card'], list_cards: [], upsert_offer: ['snapshot', 'rule', 'confirmation'], recommend: ['transaction', 'limit'], record_transaction: ['transaction'], remaining_caps: ['cardId'], fetch_public_offer: ['url'], calculate_reward: ['rule', 'transaction', 'context'], rank_cards: ['cards', 'rules', 'transaction', 'context'] };
  if (!allowed[name]) throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  keys(args, allowed[name], `tool ${name}`);
  return args;
}
