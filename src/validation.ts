import { SUPPORTED_PREDICATE_FIELDS } from './types.js';
import type { CardDescriptor, CardProduct, CapPeriod, CapPoolDefinition, CardSwitchCampaign, CardSwitchConfirmation, CardSwitchInput, CardSwitchEnrollment, CardSwitchProjection, EligibilityFact, EvaluationContext, FxSnapshot, HeldCard, MerchantIdentity, MerchantProvenance, Money, OfferConfirmation, OfferProvenance, OfferRuleVersion, OfferSourceSnapshot, Predicate, PredicateValue, RewardBreakdown, RewardSpec, RuleMatch, TransactionTuple, PaymentRouteKind, RewardComponentKind, RewardComponentRecord, PaymentRouteContext, PaymentRouteRecord, PaymentCapabilityRecord, PaymentAccountRecord, PaymentEvent, PaymentEventKind, PaymentEventRule, PaymentEventChainRule, EventRewardLedgerRecord, EventRewardReversalRecord, EventRewardCapUsageRecord, PaymentEventRewardCandidate, PaymentEventRewardCandidateInput, PaymentEventMatch, RewardValuationSnapshot, PaymentRouteSelector, FundingInstrument, ListTransactionsOptions, TransactionTimeBasis, AppliedFxRate, FxRateType, IngestionSourceScope, IngestionFlowRecord, IngestionDraftTombstone } from './types.js';
import type { StoredState } from './store.js';
import type { EvidenceRecord, FactCandidate } from './types.js';
import { RewardServiceError } from './errors.js';
import type { RecommendationIntent } from './types.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/;
const HOST = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RewardServiceError('INVALID_INPUT', `${name} must be an object`);
  return value as Record<string, unknown>;
}

/** Validators reconstruct declared fields, so unknown input is intentionally dropped. */
function keys(_value: Record<string, unknown>, _allowed: readonly string[], _name: string): void {}

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

export function validateRewardValuationSnapshot(value: unknown): RewardValuationSnapshot {
  const item = object(value, 'reward valuation snapshot');
  keys(item, ['id', 'nativeUnit', 'rateNumerator', 'rateDenominator', 'targetCurrency', 'asOf', 'validTo', 'version', 'evidenceId', 'ownerUser'], 'reward valuation snapshot');
  return {
    id: requiredString(item.id, 'reward valuation snapshot.id', true),
    nativeUnit: requiredString(item.nativeUnit, 'reward valuation snapshot.nativeUnit', true),
    rateNumerator: safeInt(item.rateNumerator, 'reward valuation snapshot.rateNumerator', 1),
    rateDenominator: safeInt(item.rateDenominator, 'reward valuation snapshot.rateDenominator', 1),
    targetCurrency: requiredString(item.targetCurrency, 'reward valuation snapshot.targetCurrency', true).toUpperCase(),
    asOf: iso(item.asOf, 'reward valuation snapshot.asOf'),
    ...(item.validTo === undefined ? {} : { validTo: iso(item.validTo, 'reward valuation snapshot.validTo') }),
    version: requiredString(item.version, 'reward valuation snapshot.version', true),
    evidenceId: requiredString(item.evidenceId, 'reward valuation snapshot.evidenceId', true),
    ...(item.ownerUser === undefined ? {} : { ownerUser: requiredString(item.ownerUser, 'reward valuation snapshot.ownerUser', true) }),
  };
}

export function validateFxSnapshot(value: unknown, name: string): FxSnapshot {
  const item = object(value, name);
  keys(item, ['id', 'baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt', 'maxAgeSeconds', 'provider', 'rateType', 'sourceUrl', 'contentHash', 'cardIdScope', 'issuerScope', 'rateDirection', 'conversionOwner', 'conversionTiming', 'cardScheme', 'routeIdScope', 'edgeIdScope'], name);
  const rateType = requiredString(item.rateType, `${name}.rateType`);
  if (!['cash_selling', 'spot_selling', 'mid_market', 'card_scheme'].includes(rateType)) throw new RewardServiceError('INVALID_INPUT', `${name}.rateType is invalid`);
  if (item.rateDirection !== undefined && !['base_to_quote', 'quote_to_base'].includes(String(item.rateDirection))) {
    throw new RewardServiceError('INVALID_INPUT', `${name}.rateDirection is invalid`);
  }
  if (item.conversionOwner !== undefined && !['merchant', 'wallet', 'payment_provider', 'card_network', 'issuer', 'bank', 'acquirer', 'card_scheme', 'merchant_dcc', 'unknown'].includes(String(item.conversionOwner))) {
    throw new RewardServiceError('INVALID_INPUT', `${name}.conversionOwner is invalid`);
  }
  if (item.conversionTiming !== undefined && !['transaction', 'clearing', 'settlement', 'posting'].includes(String(item.conversionTiming))) {
    throw new RewardServiceError('INVALID_INPUT', `${name}.conversionTiming is invalid`);
  }
  return {
    id: requiredString(item.id, `${name}.id`, true),
    baseCurrency: requiredString(item.baseCurrency, `${name}.baseCurrency`, true).toUpperCase(),
    quoteCurrency: requiredString(item.quoteCurrency, `${name}.quoteCurrency`, true).toUpperCase(),
    ratePpm: finiteRate(item.ratePpm, `${name}.ratePpm`, 1),
    capturedAt: iso(item.capturedAt, `${name}.capturedAt`),
    ...(item.maxAgeSeconds === undefined ? {} : { maxAgeSeconds: safeInt(item.maxAgeSeconds, `${name}.maxAgeSeconds`, 1) }),
    provider: requiredString(item.provider, `${name}.provider`),
    rateType: rateType as FxSnapshot['rateType'],
    ...(item.sourceUrl === undefined ? {} : { sourceUrl: requiredString(item.sourceUrl, `${name}.sourceUrl`) }),
    ...(item.contentHash === undefined ? {} : { contentHash: requiredString(item.contentHash, `${name}.contentHash`) }),
    ...(item.cardIdScope === undefined ? {} : { cardIdScope: requiredString(item.cardIdScope, `${name}.cardIdScope`, true) }),
    ...(item.issuerScope === undefined ? {} : { issuerScope: requiredString(item.issuerScope, `${name}.issuerScope`) }),
    ...(item.rateDirection === undefined ? {} : { rateDirection: item.rateDirection as FxSnapshot['rateDirection'] }),
    ...(item.conversionOwner === undefined ? {} : { conversionOwner: item.conversionOwner as FxSnapshot['conversionOwner'] }),
    ...(item.conversionTiming === undefined ? {} : { conversionTiming: item.conversionTiming as FxSnapshot['conversionTiming'] }),
    ...(item.cardScheme === undefined ? {} : { cardScheme: requiredString(item.cardScheme, `${name}.cardScheme`, true) }),
    ...(item.routeIdScope === undefined ? {} : { routeIdScope: requiredString(item.routeIdScope, `${name}.routeIdScope`, true) }),
    ...(item.edgeIdScope === undefined ? {} : { edgeIdScope: requiredString(item.edgeIdScope, `${name}.edgeIdScope`, true) }),
  };
}
export function validatePaymentCapability(value: unknown): PaymentCapabilityRecord {
  const item = object(value, 'payment capability');
  keys(item, ['id', 'status', 'providerId', 'acceptanceProviderId', 'consumerAppId', 'merchant', 'market', 'channel', 'fundingKinds', 'transitions', 'sourceUrl', 'evidenceIds', 'observedAt', 'validFrom', 'validTo', 'idempotencyKey', 'ownerUser'], 'payment capability');
  const status = requiredString(item.status, 'payment capability status');
  if (!['candidate', 'active', 'stale', 'conflict', 'needs_review'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'payment capability status is invalid');
  if (!Array.isArray(item.fundingKinds) || item.fundingKinds.length === 0 || item.fundingKinds.length > 3 || item.fundingKinds.some((kind) => kind !== 'credit_card' && kind !== 'account' && kind !== 'cash')) throw new RewardServiceError('INVALID_INPUT', 'payment capability fundingKinds is invalid');
  if (!Array.isArray(item.transitions) || item.transitions.length === 0 || item.transitions.some((transition) => !['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'].includes(transition))) throw new RewardServiceError('INVALID_INPUT', 'payment capability transitions is invalid');
  const evidenceIds = Array.isArray(item.evidenceIds) ? item.evidenceIds.map((id) => requiredString(id, 'payment capability evidenceIds[]', true)) : (() => { throw new RewardServiceError('INVALID_INPUT', 'payment capability evidenceIds must be an array'); })();
  const capability: PaymentCapabilityRecord = {
    id: requiredString(item.id, 'payment capability id', true),
    status: status as PaymentCapabilityRecord['status'],
    providerId: requiredString(item.providerId, 'payment capability providerId'),
    fundingKinds: item.fundingKinds as PaymentCapabilityRecord['fundingKinds'],
    transitions: item.transitions as PaymentCapabilityRecord['transitions'],
    evidenceIds,
    observedAt: iso(item.observedAt, 'payment capability observedAt'),
    idempotencyKey: requiredString(item.idempotencyKey, 'payment capability idempotencyKey', true),
  };
  const optionalText = ['acceptanceProviderId', 'consumerAppId', 'merchant', 'market', 'channel', 'sourceUrl'] as const;
  for (const field of optionalText) {
    const parsed = optionalString(item[field], `payment capability ${field}`);
    if (parsed !== undefined) capability[field] = parsed;
  }
  const validFrom = item.validFrom === undefined ? undefined : iso(item.validFrom, 'payment capability validFrom');
  const validTo = item.validTo === undefined ? undefined : iso(item.validTo, 'payment capability validTo');
  const ownerUser = optionalString(item.ownerUser, 'payment capability ownerUser', true);
  if (validFrom !== undefined) capability.validFrom = validFrom;
  if (validTo !== undefined) capability.validTo = validTo;
  if (ownerUser !== undefined) capability.ownerUser = ownerUser;
  return capability;
}

export function validatePaymentEvent(value: unknown): PaymentEvent {
  const item = object(value, 'payment event');
  keys(item, ['id', 'kind', 'amount', 'occurredAt', 'funding', 'cardId', 'routeId', 'channel', 'paymentMethod', 'relations', 'fx'], 'payment event');
  const kind = requiredString(item.kind, 'payment event.kind');
  if (!['top_up', 'purchase', 'refund', 'reversal', 'reward_issuance', 'reward_redemption'].includes(kind)) throw new RewardServiceError('INVALID_INPUT', 'payment event kind is invalid');
  const funding = object(item.funding, 'payment event funding');
  keys(funding, ['kind', 'cardId', 'subtype', 'accountId'], 'payment event funding');
  const fundingKind = requiredString(funding.kind, 'payment event funding.kind');
  const fundingValue: PaymentEvent['funding'] = fundingKind === 'credit_card' ? { kind: 'credit_card', ...(funding.cardId === undefined ? {} : { cardId: requiredString(funding.cardId, 'payment event funding.cardId', true) }) } : fundingKind === 'account' && (funding.subtype === 'linked_bank_account' || funding.subtype === 'wallet_balance' || funding.subtype === 'foreign_currency_account') ? { kind: 'account', subtype: funding.subtype, ...(funding.accountId === undefined ? {} : { accountId: requiredString(funding.accountId, 'payment event funding.accountId', true) }) } : fundingKind === 'cash' && funding.subtype === undefined && funding.cardId === undefined && funding.accountId === undefined ? { kind: 'cash' } : (() => { throw new RewardServiceError('INVALID_INPUT', 'payment event funding is invalid'); })();
  let relations: PaymentEvent['relations'];
  if (item.relations !== undefined) {
    const relationItem = object(item.relations, 'payment event relations');
    keys(relationItem, ['funded_by', 'caused_by', 'refunds'], 'payment event relations');
    const relation = (key: string): readonly string[] | undefined => relationItem[key] === undefined ? undefined : (() => { if (!Array.isArray(relationItem[key]) || relationItem[key].length > 16) throw new RewardServiceError('INVALID_INPUT', `payment event relations.${key} must be bounded`); return relationItem[key].map((id) => requiredString(id, `payment event relations.${key}`, true)); })();
    const fundedBy = relation('funded_by');
    const causedBy = relation('caused_by');
    const refunds = relation('refunds');
    relations = {};
    if (fundedBy !== undefined) relations.funded_by = fundedBy;
    if (causedBy !== undefined) relations.caused_by = causedBy;
    if (refunds !== undefined) relations.refunds = refunds;
  }
  return {
    id: requiredString(item.id, 'payment event.id', true),
    kind: kind as PaymentEventKind,
    amount: validateMoney(item.amount, 'payment event.amount'),
    occurredAt: iso(item.occurredAt, 'payment event.occurredAt'),
    funding: fundingValue,
    ...(item.cardId === undefined ? {} : { cardId: requiredString(item.cardId, 'payment event.cardId', true) }),
    ...(item.routeId === undefined ? {} : { routeId: requiredString(item.routeId, 'payment event.routeId', true) }),
    ...(item.channel === undefined ? {} : { channel: requiredString(item.channel, 'payment event.channel') }),
    ...(item.paymentMethod === undefined ? {} : { paymentMethod: requiredString(item.paymentMethod, 'payment event.paymentMethod') }),
    ...(relations && Object.keys(relations).length ? { relations } : {}),
    ...(item.fx === undefined ? {} : { fx: validateFxSnapshot(item.fx, 'payment event.fx') }),
  };
}

export function validateEventRewardCandidate(value: unknown): PaymentEventRewardCandidateInput {
  const item = object(value, 'event reward candidate');
  keys(item, ['eventId', 'ruleId', 'ruleVersion', 'evidenceId', 'sponsor', 'benefitGroup', 'reward', 'combination', 'capPoolId', 'eligibility'], 'event reward candidate');
  const eligibilityValue = object(item.eligibility, 'event reward candidate eligibility');
  keys(eligibilityValue, ['status', 'reasons'], 'event reward candidate eligibility');
  const status = requiredString(eligibilityValue.status, 'event reward candidate eligibility.status');
  if (!['matched', 'no_match', 'unknown'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'event reward candidate eligibility.status is invalid');
  const reasons = eligibilityValue.reasons === undefined ? [] : (Array.isArray(eligibilityValue.reasons) ? eligibilityValue.reasons.map((reason) => requiredString(reason, 'event reward candidate eligibility.reasons[]')) : (() => { throw new RewardServiceError('INVALID_INPUT', 'event reward candidate eligibility.reasons must be an array'); })());
  const rewardValue = item.reward === undefined ? undefined : (() => { const reward = object(item.reward, 'event reward candidate reward'); keys(reward, ['kind', 'code', 'rateBps', 'amountMinor', 'currency', 'roundingMode', 'roundingScope', 'unitAmountMinor', 'unitRewardMinor', 'stepAmountMinor', 'stepRewardMinor'], 'event reward candidate reward'); return { kind: requiredString(reward.kind, 'event reward candidate reward.kind'), ...(reward.code === undefined ? {} : { code: requiredString(reward.code, 'event reward candidate reward.code') }), ...(reward.rateBps === undefined ? {} : { rateBps: finiteRate(reward.rateBps, 'event reward candidate reward.rateBps') }), ...(reward.amountMinor === undefined ? {} : { amountMinor: safeInt(reward.amountMinor, 'event reward candidate reward.amountMinor') }), ...(reward.currency === undefined ? {} : { currency: requiredString(reward.currency, 'event reward candidate reward.currency', true).toUpperCase() }), ...(reward.roundingMode === undefined ? {} : { roundingMode: requiredString(reward.roundingMode, 'event reward candidate reward.roundingMode') as RewardSpec['roundingMode'] }), ...(reward.roundingScope === undefined ? {} : { roundingScope: requiredString(reward.roundingScope, 'event reward candidate reward.roundingScope') as RewardSpec['roundingScope'] }) }; })();
  const combination = item.combination === undefined ? undefined : (() => { const policy = object(item.combination, 'event reward candidate combination'); keys(policy, ['mode', 'groupId', 'version', 'priority', 'prerequisiteRuleIds'], 'event reward candidate combination'); return { mode: requiredString(policy.mode, 'event reward candidate combination.mode'), groupId: requiredString(policy.groupId, 'event reward candidate combination.groupId', true), version: requiredString(policy.version, 'event reward candidate combination.version'), ...(policy.priority === undefined ? {} : { priority: safeInt(policy.priority, 'event reward candidate combination.priority', -Number.MAX_SAFE_INTEGER) }) }; })();
  return { eventId: requiredString(item.eventId, 'event reward candidate.eventId', true), ruleId: requiredString(item.ruleId, 'event reward candidate.ruleId', true), ruleVersion: requiredString(item.ruleVersion, 'event reward candidate.ruleVersion'), evidenceId: requiredString(item.evidenceId, 'event reward candidate.evidenceId', true), sponsor: requiredString(item.sponsor, 'event reward candidate.sponsor'), benefitGroup: requiredString(item.benefitGroup, 'event reward candidate.benefitGroup'), ...(rewardValue ? { reward: rewardValue } : {}), ...(combination ? { combination } : {}), ...(item.capPoolId === undefined ? {} : { capPoolId: requiredString(item.capPoolId, 'event reward candidate.capPoolId', true) }), eligibility: { status: status as PaymentEventMatch['status'], reasons } };
}

export function validateEventRewardInput(value: unknown): { event: PaymentEvent; candidate: PaymentEventRewardCandidateInput; idempotencyKey: string } {
  const item = object(value, 'event reward input');
  keys(item, ['event', 'candidate', 'idempotencyKey'], 'event reward input');
  return { event: validatePaymentEvent(item.event), candidate: validateEventRewardCandidate(item.candidate), idempotencyKey: requiredString(item.idempotencyKey, 'event reward input.idempotencyKey') };
}

export function validatePaymentEventRule(value: unknown): PaymentEventRule {
  const item = object(value, 'payment event rule');
  keys(item, ['id', 'version', 'eventKind', 'fundingKind', 'fundingSubtype', 'channel', 'paymentMethod'], 'payment event rule');
  const eventKind = requiredString(item.eventKind, 'payment event rule.eventKind');
  if (!['top_up', 'purchase', 'refund', 'reversal', 'reward_issuance', 'reward_redemption'].includes(eventKind)) throw new RewardServiceError('INVALID_INPUT', 'payment event rule.eventKind is invalid');
  const fundingKind = item.fundingKind === undefined ? undefined : requiredString(item.fundingKind, 'payment event rule.fundingKind');
  if (fundingKind !== undefined && !['credit_card', 'account', 'cash'].includes(fundingKind)) throw new RewardServiceError('INVALID_INPUT', 'payment event rule.fundingKind is invalid');
  const fundingSubtype = item.fundingSubtype === undefined ? undefined : requiredString(item.fundingSubtype, 'payment event rule.fundingSubtype');
  if (fundingSubtype !== undefined && !['linked_bank_account', 'wallet_balance', 'foreign_currency_account'].includes(fundingSubtype)) throw new RewardServiceError('INVALID_INPUT', 'payment event rule.fundingSubtype is invalid');
  if (fundingSubtype !== undefined && fundingKind !== 'account') throw new RewardServiceError('INVALID_INPUT', 'payment event rule.fundingSubtype requires account fundingKind');
  const result: PaymentEventRule = { id: requiredString(item.id, 'payment event rule.id', true), version: requiredString(item.version, 'payment event rule.version'), eventKind: eventKind as PaymentEventKind };
  if (fundingKind !== undefined) result.fundingKind = fundingKind as 'credit_card' | 'account' | 'cash';
  if (fundingSubtype !== undefined) result.fundingSubtype = fundingSubtype as 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account';
  if (item.channel !== undefined) result.channel = requiredString(item.channel, 'payment event rule.channel');
  if (item.paymentMethod !== undefined) result.paymentMethod = requiredString(item.paymentMethod, 'payment event rule.paymentMethod');
  return result;
}

export function validatePaymentEventChainRule(value: unknown): PaymentEventChainRule {
  const item = object(value, 'payment event chain rule');
  keys(item, ['id', 'version', 'relation', 'windowSeconds', 'sourceRule', 'targetRule'], 'payment event chain rule');
  if (item.relation !== 'funded_by') throw new RewardServiceError('INVALID_INPUT', 'payment event chain rule relation is invalid');
  const windowSeconds = safeInt(item.windowSeconds, 'payment event chain rule.windowSeconds', 1);
  if (windowSeconds > 31 * 24 * 60 * 60) throw new RewardServiceError('INVALID_INPUT', 'payment event chain rule.windowSeconds is too large');
  return { id: requiredString(item.id, 'payment event chain rule.id', true), version: requiredString(item.version, 'payment event chain rule.version'), relation: 'funded_by', windowSeconds, sourceRule: validatePaymentEventRule(item.sourceRule), targetRule: validatePaymentEventRule(item.targetRule) };
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
  keys(item, ['id', 'evidenceId', 'version', 'cardId', 'factKey', 'value', 'validFrom', 'validTo'], 'eligibilityFact');
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
    ...(optionalString(item.evidenceId, 'eligibilityFact.evidenceId', true) ? { evidenceId: optionalString(item.evidenceId, 'eligibilityFact.evidenceId', true) } : {}),
    ...(optionalString(item.version, 'eligibilityFact.version') ? { version: optionalString(item.version, 'eligibilityFact.version') } : {}),
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
  keys(item, ['id', 'ownerUser', 'url', 'fetchedAt', 'contentHash', 'parserVersion', 'validFrom', 'validTo', 'excerpt', 'verified', 'sourceType', 'provenance'], 'snapshot');
  const sourceType = item.sourceType === undefined ? 'official' : requiredString(item.sourceType, 'snapshot.sourceType');
  if (sourceType !== 'official' && sourceType !== 'user_input') throw new RewardServiceError('INVALID_INPUT', 'snapshot.sourceType is invalid');
  const url = item.url === undefined ? undefined : requiredString(item.url, 'snapshot.url');
  if (sourceType === 'official' && url === undefined) throw new RewardServiceError('INVALID_INPUT', 'official snapshot.url is required');
  if (url !== undefined) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a URL'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a public origin URL without credentials');
  }
  const fetchedAt = requiredString(item.fetchedAt, 'snapshot.fetchedAt');
  if (!Number.isFinite(Date.parse(fetchedAt)) || !fetchedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'snapshot.fetchedAt must be an ISO date-time');
  const validFrom = optionalString(item.validFrom, 'snapshot.validFrom');
  const validTo = optionalString(item.validTo, 'snapshot.validTo');
  if (validFrom && (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validFrom must be an ISO date-time');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validTo must be an ISO date-time');
  if (item.verified !== undefined && typeof item.verified !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'snapshot.verified must be boolean');
  const provenance = item.provenance !== undefined ? validateProvenance(item.provenance) : undefined;
  if (sourceType === 'user_input' && provenance === undefined) throw new RewardServiceError('INVALID_INPUT', 'user_input snapshot requires provenance');
  if (sourceType === 'user_input' && item.verified === true) throw new RewardServiceError('INVALID_INPUT', 'user_input snapshot cannot be verified as official');
  return {
    id: requiredString(item.id, 'snapshot.id', true),
    ...(item.ownerUser === undefined ? {} : { ownerUser: requiredString(item.ownerUser, 'snapshot.ownerUser', true) }),
    ...(url === undefined ? {} : { url }),
    fetchedAt,
    contentHash: requiredString(item.contentHash, 'snapshot.contentHash'),
    parserVersion: requiredString(item.parserVersion, 'snapshot.parserVersion'),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    ...(item.excerpt === undefined ? {} : { excerpt: requiredString(item.excerpt, 'snapshot.excerpt') }),
    ...(item.verified === undefined ? {} : { verified: item.verified }),
    sourceType,
    ...(provenance ? { provenance } : {}),
  };
}

export function validateMerchant(value: unknown): MerchantIdentity {
  const item = object(value, 'merchant');
  keys(item, ['canonicalId', 'canonicalNameZhHant', 'canonicalNameLocale', 'officialAliases', 'operatingMarkets', 'mccs', 'channels', 'status', 'supersededBy', 'provenance'], 'merchant');
  const locale = requiredString(item.canonicalNameLocale, 'merchant.canonicalNameLocale');
  if (locale !== 'zh-Hant-TW') throw new RewardServiceError('INVALID_INPUT', 'merchant canonical locale must be zh-Hant-TW');
  const status = requiredString(item.status, 'merchant.status');
  if (!['candidate', 'active', 'deprecated'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'merchant.status is invalid');
  const provenanceItem = object(item.provenance, 'merchant.provenance');
  keys(provenanceItem, ['sourceSnapshotId', 'sourceUrl', 'version', 'updatedAt', 'notes'], 'merchant.provenance');
  const updatedAt = requiredString(provenanceItem.updatedAt, 'merchant.provenance.updatedAt');
  if (!Number.isFinite(Date.parse(updatedAt)) || !updatedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'merchant.provenance.updatedAt must be an ISO date-time');
  const provenance: MerchantProvenance = { ...(optionalString(provenanceItem.sourceSnapshotId, 'merchant.provenance.sourceSnapshotId', true) ? { sourceSnapshotId: optionalString(provenanceItem.sourceSnapshotId, 'merchant.provenance.sourceSnapshotId', true) } : {}), ...(optionalString(provenanceItem.sourceUrl, 'merchant.provenance.sourceUrl') ? { sourceUrl: optionalString(provenanceItem.sourceUrl, 'merchant.provenance.sourceUrl') } : {}), version: requiredString(provenanceItem.version, 'merchant.provenance.version'), updatedAt, ...(optionalString(provenanceItem.notes, 'merchant.provenance.notes') ? { notes: optionalString(provenanceItem.notes, 'merchant.provenance.notes') } : {}) };
  const aliases = item.officialAliases === undefined ? undefined : (() => { if (!Array.isArray(item.officialAliases) || item.officialAliases.length > 128 || item.officialAliases.some((v) => typeof v !== 'string' || !v.trim() || v.length > 512)) throw new RewardServiceError('INVALID_INPUT', 'merchant.officialAliases must be bounded strings'); return [...new Set(item.officialAliases)] as string[]; })();
  const markets = list(item.operatingMarkets, 'merchant.operatingMarkets');
  const mccs = list(item.mccs, 'merchant.mccs');
  const channels = item.channels === undefined ? undefined : (() => { if (!Array.isArray(item.channels) || item.channels.some((v) => v !== 'in_store' && v !== 'online')) throw new RewardServiceError('INVALID_INPUT', 'merchant.channels is invalid'); return [...new Set(item.channels)] as ('in_store' | 'online')[]; })();
  return { canonicalId: requiredString(item.canonicalId, 'merchant.canonicalId', true), canonicalNameZhHant: requiredString(item.canonicalNameZhHant, 'merchant.canonicalNameZhHant'), canonicalNameLocale: 'zh-Hant-TW', ...(aliases ? { officialAliases: aliases } : {}), ...(markets ? { operatingMarkets: markets.map((v) => v.toUpperCase()) } : {}), ...(mccs ? { mccs } : {}), ...(channels ? { channels } : {}), status: status as MerchantIdentity['status'], ...(optionalString(item.supersededBy, 'merchant.supersededBy', true) ? { supersededBy: optionalString(item.supersededBy, 'merchant.supersededBy', true) } : {}), provenance };
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
  if (field.startsWith('transaction.') && !(SUPPORTED_PREDICATE_FIELDS as readonly string[]).includes(field)) throw new RewardServiceError('INVALID_INPUT', `${name}.field is unsupported: ${field}`);
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
  keys(item, ['confirmedAt', 'confirmedBy', 'sourceReference', 'trustBasis', 'termsFingerprint', 'offerPeriod', 'rewardUnit', 'rewardConditionsSummary', 'capSummary'], 'confirmation');
  const confirmedAt = requiredString(item.confirmedAt, 'confirmation.confirmedAt');
  if (!Number.isFinite(Date.parse(confirmedAt)) || !confirmedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'confirmation.confirmedAt must be an ISO date-time');
  const periodItem = object(item.offerPeriod, 'confirmation.offerPeriod');
  keys(periodItem, ['validFrom', 'validTo'], 'confirmation.offerPeriod');
  const validFrom = requiredString(periodItem.validFrom, 'confirmation.offerPeriod.validFrom');
  if (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'confirmation.offerPeriod.validFrom must be an ISO date-time');
  const validTo = optionalString(periodItem.validTo, 'confirmation.offerPeriod.validTo');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'confirmation.offerPeriod.validTo must be an ISO date-time');
  const sourceReference = optionalString(item.sourceReference, 'confirmation.sourceReference');
  const trustBasis = item.trustBasis === undefined ? (sourceReference ? 'official_verified' : 'user_confirmed') : requiredString(item.trustBasis, 'confirmation.trustBasis');
  if (trustBasis !== 'official_verified' && trustBasis !== 'user_confirmed') throw new RewardServiceError('INVALID_INPUT', 'confirmation.trustBasis is invalid');
  if (trustBasis === 'official_verified' && !sourceReference) throw new RewardServiceError('INVALID_CONFIRMATION', 'official confirmation requires sourceReference');
  return {
    confirmedAt,
    confirmedBy: requiredString(item.confirmedBy, 'confirmation.confirmedBy'),
    ...(sourceReference ? { sourceReference } : {}),
    ...((item.trustBasis !== undefined || !sourceReference) ? { trustBasis } : {}),
    ...(optionalString(item.termsFingerprint, 'confirmation.termsFingerprint', true) ? { termsFingerprint: optionalString(item.termsFingerprint, 'confirmation.termsFingerprint', true) } : {}),
    offerPeriod: { validFrom, ...(validTo ? { validTo } : {}) },
    rewardUnit: requiredString(item.rewardUnit, 'confirmation.rewardUnit', true).toUpperCase(),
    ...(optionalString(item.rewardConditionsSummary, 'confirmation.rewardConditionsSummary') ? { rewardConditionsSummary: optionalString(item.rewardConditionsSummary, 'confirmation.rewardConditionsSummary') } : {}),
    ...(optionalString(item.capSummary, 'confirmation.capSummary') ? { capSummary: optionalString(item.capSummary, 'confirmation.capSummary') } : {}),
  };
}

export function validatePaymentRouteSelector(value: unknown): PaymentRouteSelector {
  const item = object(value, 'routeSelector');
  keys(item, [
    'paymentServices', 'paymentServiceAllowlist',
    'acceptanceNetworks', 'acceptanceNetworkAllowlist',
    'fundingKinds', 'nodeRoles', 'transitions', 'excludedTransitions',
    'validFrom', 'validTo',
  ], 'routeSelector');

  const rawServices = item.paymentServiceAllowlist ?? item.paymentServices;
  const paymentServices = rawServices === undefined ? undefined : (Array.isArray(rawServices) ? rawServices.map((s) => requiredString(s, 'routeSelector paymentService', true)) : (() => { throw new RewardServiceError('INVALID_INPUT', 'routeSelector paymentServices must be an array'); })());

  const rawAcceptance = item.acceptanceNetworkAllowlist ?? item.acceptanceNetworks;
  const acceptanceNetworks = rawAcceptance === undefined ? undefined : (Array.isArray(rawAcceptance) ? rawAcceptance.map((s) => requiredString(s, 'routeSelector acceptanceNetwork', true)) : (() => { throw new RewardServiceError('INVALID_INPUT', 'routeSelector acceptanceNetworks must be an array'); })());

  let fundingKinds: PaymentRouteSelector['fundingKinds'];
  if (item.fundingKinds !== undefined) {
    if (!Array.isArray(item.fundingKinds) || item.fundingKinds.length === 0 || item.fundingKinds.length > 3) {
      throw new RewardServiceError('INVALID_INPUT', 'routeSelector fundingKinds must be a non-empty array of at most 3 items');
    }
    for (const kind of item.fundingKinds) {
      if (!['credit_card', 'account', 'cash'].includes(kind)) {
        throw new RewardServiceError('INVALID_INPUT', `routeSelector fundingKind is invalid: ${kind}`);
      }
    }
    fundingKinds = item.fundingKinds as PaymentRouteSelector['fundingKinds'];
  }

  let nodeRoles: PaymentRouteSelector['nodeRoles'];
  if (item.nodeRoles !== undefined) {
    if (!Array.isArray(item.nodeRoles)) throw new RewardServiceError('INVALID_INPUT', 'routeSelector nodeRoles must be an array');
    for (const role of item.nodeRoles) {
      if (!['funding_source', 'wallet_balance', 'payment_service', 'acceptance_network', 'merchant'].includes(role)) {
        throw new RewardServiceError('INVALID_INPUT', `routeSelector nodeRole is invalid: ${role}`);
      }
    }
    nodeRoles = item.nodeRoles as PaymentRouteSelector['nodeRoles'];
  }

  let transitions: PaymentRouteSelector['transitions'];
  if (item.transitions !== undefined) {
    if (!Array.isArray(item.transitions)) throw new RewardServiceError('INVALID_INPUT', 'routeSelector transitions must be an array');
    for (const t of item.transitions) {
      if (!['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'].includes(t)) {
        throw new RewardServiceError('INVALID_INPUT', `routeSelector transition is invalid: ${t}`);
      }
    }
    transitions = item.transitions as PaymentRouteSelector['transitions'];
  }

  let excludedTransitions: PaymentRouteSelector['excludedTransitions'];
  if (item.excludedTransitions !== undefined) {
    if (!Array.isArray(item.excludedTransitions)) throw new RewardServiceError('INVALID_INPUT', 'routeSelector excludedTransitions must be an array');
    for (const t of item.excludedTransitions) {
      if (!['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'].includes(t)) {
        throw new RewardServiceError('INVALID_INPUT', `routeSelector excludedTransition is invalid: ${t}`);
      }
    }
    excludedTransitions = item.excludedTransitions as PaymentRouteSelector['excludedTransitions'];
  }

  const validFrom = optionalString(item.validFrom, 'routeSelector.validFrom');
  if (validFrom && (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T'))) {
    throw new RewardServiceError('INVALID_INPUT', 'routeSelector.validFrom must be an ISO date-time');
  }
  const validTo = optionalString(item.validTo, 'routeSelector.validTo');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) {
    throw new RewardServiceError('INVALID_INPUT', 'routeSelector.validTo must be an ISO date-time');
  }

  return {
    ...(paymentServices ? { paymentServices, paymentServiceAllowlist: paymentServices } : {}),
    ...(acceptanceNetworks ? { acceptanceNetworks, acceptanceNetworkAllowlist: acceptanceNetworks } : {}),
    ...(fundingKinds ? { fundingKinds } : {}),
    ...(nodeRoles ? { nodeRoles } : {}),
    ...(transitions ? { transitions } : {}),
    ...(excludedTransitions ? { excludedTransitions } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
  };
}

export function validateRule(value: unknown): OfferRuleVersion {
  const item = object(value, 'rule');
  keys(item, ['id', 'cardId', 'version', 'sourceSnapshotId', 'ownerUser', 'trustBasis', 'familyId', 'supersedesRuleId', 'supersessionReason', 'status', 'validFrom', 'validTo', 'settlementCurrency', 'match', 'predicate', 'requires', 'reward', 'capPoolRefs', 'confirmation', 'combination', 'componentKind', 'sponsor', 'benefitGroup', 'useSettlementAmount', 'stacking', 'routeId', 'routeSelector', 'eventRule', 'eventChainRule'], 'rule');
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
  const trustBasis = item.trustBasis === undefined ? confirmation?.trustBasis : requiredString(item.trustBasis, 'rule.trustBasis');
  if (trustBasis !== undefined && trustBasis !== 'official_verified' && trustBasis !== 'user_confirmed') throw new RewardServiceError('INVALID_INPUT', 'rule.trustBasis is invalid');
  const supersessionReason = item.supersessionReason === undefined ? undefined : requiredString(item.supersessionReason, 'rule.supersessionReason');
  if (supersessionReason !== undefined && !['user_correction', 'user_revocation', 'official_refresh'].includes(supersessionReason)) throw new RewardServiceError('INVALID_INPUT', 'rule.supersessionReason is invalid');
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
  const sponsor = item.sponsor === undefined ? undefined : requiredString(item.sponsor, 'rule.sponsor', true);
  const benefitGroup = item.benefitGroup === undefined ? undefined : requiredString(item.benefitGroup, 'rule.benefitGroup', true);
  if (componentKind !== undefined && !['merchant_loyalty', 'payment_provider', 'card_issuer'].includes(componentKind)) throw new RewardServiceError('INVALID_INPUT', 'rule.componentKind is invalid');
  const stacking = item.stacking === undefined ? undefined : requiredString(item.stacking, 'rule.stacking');
  if (stacking !== undefined && stacking !== 'confirmed' && stacking !== 'possible') throw new RewardServiceError('INVALID_INPUT', 'rule.stacking is invalid');
  if (item.useSettlementAmount !== undefined && typeof item.useSettlementAmount !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'rule.useSettlementAmount must be boolean');
  if (item.eventRule !== undefined && item.eventChainRule !== undefined) throw new RewardServiceError('INVALID_INPUT', 'rule.eventRule and rule.eventChainRule are mutually exclusive');
  const eventRule = item.eventRule === undefined ? undefined : validatePaymentEventRule(item.eventRule);
  const eventChainRule = item.eventChainRule === undefined ? undefined : validatePaymentEventChainRule(item.eventChainRule);
  const routeSelector = item.routeSelector === undefined ? undefined : validatePaymentRouteSelector(item.routeSelector);
  const cardId = item.cardId === undefined ? undefined : requiredString(item.cardId, 'rule.cardId', true);
  if (cardId === undefined && (!componentKind || componentKind === 'card_issuer')) throw new RewardServiceError('INVALID_INPUT', 'non-card rules require an explicit componentKind');
  const rule: OfferRuleVersion = {
    id: requiredString(item.id, 'rule.id', true),
    version: requiredString(item.version, 'rule.version'),
    sourceSnapshotId: requiredString(item.sourceSnapshotId, 'rule.sourceSnapshotId', true),
    status: status as OfferRuleVersion['status'],
    validFrom,
    settlementCurrency: requiredString(item.settlementCurrency, 'rule.settlementCurrency', true).toUpperCase(),
    match: validateMatch(item.match),
    reward,
  };
  if (cardId) rule.cardId = cardId;
  if (item.ownerUser !== undefined) rule.ownerUser = requiredString(item.ownerUser, 'rule.ownerUser', true);
  if (trustBasis) rule.trustBasis = trustBasis as OfferRuleVersion['trustBasis'];
  if (item.familyId !== undefined) rule.familyId = requiredString(item.familyId, 'rule.familyId', true);
  if (item.supersedesRuleId !== undefined) rule.supersedesRuleId = requiredString(item.supersedesRuleId, 'rule.supersedesRuleId', true);
  if (supersessionReason) rule.supersessionReason = supersessionReason as OfferRuleVersion['supersessionReason'];
  if (validTo) rule.validTo = validTo;
  if (predicate) rule.predicate = predicate;
  if (requires?.length) rule.requires = requires;
  if (capPoolRefs) rule.capPoolRefs = capPoolRefs;
  if (componentKind) rule.componentKind = componentKind as OfferRuleVersion['componentKind'];
  if (sponsor !== undefined) rule.sponsor = sponsor;
  if (benefitGroup !== undefined) rule.benefitGroup = benefitGroup;
  if (item.useSettlementAmount !== undefined) rule.useSettlementAmount = item.useSettlementAmount;
  if (stacking) rule.stacking = stacking as OfferRuleVersion['stacking'];
  if (confirmation) rule.confirmation = confirmation;
  if (combination) rule.combination = combination;
  if (item.routeId !== undefined) rule.routeId = requiredString(item.routeId, 'rule.routeId', true);
  if (routeSelector) rule.routeSelector = routeSelector;
  if (eventRule) rule.eventRule = eventRule;
  if (eventChainRule) rule.eventChainRule = eventChainRule;
  return rule;
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

export function validateFundingInstrument(value: unknown, path = 'funding'): FundingInstrument {
  const item = object(value, path);
  keys(item, ['kind', 'cardId', 'subtype', 'accountId'], path);
  const kind = requiredString(item.kind, `${path}.kind`);
  if (kind === 'credit_card') {
    return { kind: 'credit_card', ...(item.cardId === undefined ? {} : { cardId: requiredString(item.cardId, `${path}.cardId`, true) }) };
  }
  if (kind === 'account') {
    const subtype = requiredString(item.subtype, `${path}.subtype`);
    if (!['linked_bank_account', 'wallet_balance', 'foreign_currency_account'].includes(subtype)) {
      throw new RewardServiceError('INVALID_INPUT', `${path}.subtype is invalid`);
    }
    return { kind: 'account', subtype: subtype as 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account', ...(item.accountId === undefined ? {} : { accountId: requiredString(item.accountId, `${path}.accountId`, true) }) };
  }
  if (kind === 'cash') {
    if (item.subtype !== undefined || item.cardId !== undefined || item.accountId !== undefined) {
      throw new RewardServiceError('INVALID_INPUT', `${path} cash must not contain cardId, subtype, or accountId`);
    }
    return { kind: 'cash' };
  }
  throw new RewardServiceError('INVALID_INPUT', `${path}.kind is invalid`);
}

export function validateTransaction(value: unknown): TransactionTuple {
  const item = object(value, 'transaction');
  keys(item, ['idempotencyKey', 'routeId', 'cardId', 'funding', 'recordedAt', 'kind', 'mode', 'merchant', 'mcc', 'country', 'channel', 'paymentMethod', 'occurredAt', 'amount', 'fx', 'refundOfId', 'originalRewardMinor', 'route', 'settlementAmount', 'routeContext'], 'transaction');
  const kind = requiredString(item.kind, 'transaction.kind');
  const mode = requiredString(item.mode, 'transaction.mode');
  if (!['purchase', 'refund'].includes(kind) || !['planned', 'actual'].includes(mode)) throw new RewardServiceError('INVALID_INPUT', 'transaction kind or mode is invalid');
  let fx: FxSnapshot | undefined;
  if (item.fx !== undefined) {
    fx = validateFxSnapshot(item.fx, 'transaction.fx');
  }
  const optional = (key: string, id = false) => optionalString(item[key], `transaction.${key}`, id);
  const occurredAt = requiredString(item.occurredAt, 'transaction.occurredAt');
  if (!Number.isFinite(Date.parse(occurredAt)) || !occurredAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'transaction.occurredAt must be an ISO date-time');
  let recordedAt: string | undefined;
  if (item.recordedAt !== undefined) {
    const rec = requiredString(item.recordedAt, 'transaction.recordedAt');
    if (!Number.isFinite(Date.parse(rec)) || !rec.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'transaction.recordedAt must be an ISO date-time');
    recordedAt = rec;
  }
  if (fx && (!Number.isFinite(Date.parse(fx.capturedAt)) || !fx.capturedAt.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'transaction.fx.capturedAt must be an ISO date-time');
  const originalRewardMinor = item.originalRewardMinor === undefined ? undefined : safeInt(item.originalRewardMinor, 'transaction.originalRewardMinor');
  let route: TransactionTuple['route'];
  if (item.route !== undefined) { const routeItem = object(item.route, 'transaction.route'); keys(routeItem, ['kind', 'providerId', 'appId', 'displayName'], 'transaction.route'); const routeKind = requiredString(routeItem.kind, 'transaction.route.kind'); if (!['direct_card', 'wallet', 'merchant_app'].includes(routeKind)) throw new RewardServiceError('INVALID_INPUT', 'transaction.route.kind is invalid'); route = { kind: routeKind as PaymentRouteKind, ...(optionalString(routeItem.providerId, 'transaction.route.providerId', true) ? { providerId: optionalString(routeItem.providerId, 'transaction.route.providerId', true) } : {}), ...(optionalString(routeItem.appId, 'transaction.route.appId', true) ? { appId: optionalString(routeItem.appId, 'transaction.route.appId', true) } : {}), ...(optionalString(routeItem.displayName, 'transaction.route.displayName') ? { displayName: optionalString(routeItem.displayName, 'transaction.route.displayName') } : {}) }; }
  const settlementAmount = item.settlementAmount === undefined ? undefined : validateMoney(item.settlementAmount, 'transaction.settlementAmount');
  const routeContext = item.routeContext === undefined ? undefined : validatePaymentRouteContext(item.routeContext);

  if (item.cardId === undefined && item.funding === undefined) {
    throw new RewardServiceError('INVALID_INPUT', 'transaction requires cardId or funding');
  }

  let funding: FundingInstrument;
  let cardId: string | undefined;
  if (item.funding !== undefined) {
    funding = validateFundingInstrument(item.funding, 'transaction.funding');
    if (item.cardId !== undefined) {
      cardId = requiredString(item.cardId, 'transaction.cardId', true);
      if (funding.kind === 'credit_card') {
        if (funding.cardId && funding.cardId !== cardId) {
          throw new RewardServiceError('INVALID_INPUT', 'transaction.cardId does not match transaction.funding.cardId');
        }
        funding = { kind: 'credit_card', cardId };
      } else {
        throw new RewardServiceError('INVALID_INPUT', 'transaction.cardId must not be specified for non-card funding');
      }
    } else if (funding.kind === 'credit_card' && funding.cardId) {
      cardId = funding.cardId;
    }
  } else {
    cardId = requiredString(item.cardId, 'transaction.cardId', true);
    funding = { kind: 'credit_card', cardId };
  }

  return {
    ...(cardId !== undefined ? { cardId } : {}),
    funding,
    kind: kind as TransactionTuple['kind'],
    mode: mode as TransactionTuple['mode'],
    occurredAt,
    ...(recordedAt !== undefined ? { recordedAt } : {}),
    amount: validateMoney(item.amount, 'transaction.amount'),
    ...(optional('idempotencyKey') ? { idempotencyKey: optional('idempotencyKey') } : {}),
    ...(item.routeId === undefined ? {} : { routeId: requiredString(item.routeId, 'transaction.routeId', true) }),
    ...(optional('merchant') ? { merchant: optional('merchant') } : {}),
    ...(optional('mcc') ? { mcc: optional('mcc') } : {}),
    ...(optional('country', true) ? { country: optional('country', true) } : {}),
    ...(optional('channel') ? { channel: optional('channel') } : {}),
    ...(optional('paymentMethod') ? { paymentMethod: optional('paymentMethod') } : {}),
    ...(fx ? { fx } : {}),
    ...(optional('refundOfId', true) ? { refundOfId: optional('refundOfId', true) } : {}),
    ...(originalRewardMinor === undefined ? {} : { originalRewardMinor }),
    ...(route ? { route } : {}),
    ...(settlementAmount ? { settlementAmount } : {}),
    ...(routeContext ? { routeContext } : {}),
  };
}

function validatePaymentRouteContext(value: unknown): PaymentRouteContext {
  const item = object(value, 'transaction.routeContext');
  keys(item, ['merchantId', 'acceptanceProviderId', 'consumerAppId', 'walletProviderId', 'interoperabilitySchemeId', 'paymentMethod', 'intermediateProviderId', 'cardNetwork', 'issuer', 'fundingSource', 'fundingSubtype', 'transactionCurrency', 'settlementCurrency', 'billingCurrency', 'conversionOwner', 'rateType', 'conversionTiming', 'foreignTransactionFee', 'markup', 'serviceFee', 'dcc'], 'transaction.routeContext');
  const requiredCurrency = requiredString(item.transactionCurrency, 'transaction.routeContext.transactionCurrency', true).toUpperCase();
  const owner = item.conversionOwner === undefined ? undefined : requiredString(item.conversionOwner, 'transaction.routeContext.conversionOwner');
  if (owner !== undefined && !['merchant', 'wallet', 'payment_provider', 'card_network', 'issuer', 'bank', 'acquirer', 'card_scheme', 'merchant_dcc', 'unknown'].includes(owner)) throw new RewardServiceError('INVALID_INPUT', 'transaction.routeContext.conversionOwner is invalid');
  const timing = item.conversionTiming === undefined ? undefined : requiredString(item.conversionTiming, 'transaction.routeContext.conversionTiming');
  if (timing !== undefined && !['transaction', 'clearing', 'settlement', 'posting'].includes(timing)) throw new RewardServiceError('INVALID_INPUT', 'transaction.routeContext.conversionTiming is invalid');
  const rateType = item.rateType === undefined ? undefined : requiredString(item.rateType, 'transaction.routeContext.rateType');
  if (rateType !== undefined && !['cash_selling', 'spot_selling', 'mid_market', 'card_scheme'].includes(rateType)) throw new RewardServiceError('INVALID_INPUT', 'transaction.routeContext.rateType is invalid');
  const fundingSubtype = item.fundingSubtype === undefined ? undefined : requiredString(item.fundingSubtype, 'transaction.routeContext.fundingSubtype');
  if (fundingSubtype !== undefined && !['linked_bank_account', 'wallet_balance', 'foreign_currency_account'].includes(fundingSubtype)) throw new RewardServiceError('INVALID_INPUT', 'transaction.routeContext.fundingSubtype is invalid');
  const context: PaymentRouteContext = { transactionCurrency: requiredCurrency };
  const optionalTextFields = ['merchantId', 'acceptanceProviderId', 'consumerAppId', 'walletProviderId', 'interoperabilitySchemeId', 'paymentMethod', 'intermediateProviderId', 'cardNetwork', 'issuer', 'fundingSource'] as const;
  for (const field of optionalTextFields) {
    const parsed = optionalString(item[field], `transaction.routeContext.${field}`);
    if (parsed !== undefined) context[field] = parsed;
  }
  if (fundingSubtype !== undefined) context.fundingSubtype = fundingSubtype as Exclude<PaymentRouteContext['fundingSubtype'], undefined>;
  if (item.settlementCurrency !== undefined) context.settlementCurrency = requiredString(item.settlementCurrency, 'transaction.routeContext.settlementCurrency', true).toUpperCase();
  if (item.billingCurrency !== undefined) context.billingCurrency = requiredString(item.billingCurrency, 'transaction.routeContext.billingCurrency', true).toUpperCase();
  if (owner !== undefined) context.conversionOwner = owner as Exclude<PaymentRouteContext['conversionOwner'], undefined>;
  if (rateType !== undefined) context.rateType = rateType as Exclude<PaymentRouteContext['rateType'], undefined>;
  if (timing !== undefined) context.conversionTiming = timing as Exclude<PaymentRouteContext['conversionTiming'], undefined>;
  if (item.foreignTransactionFee !== undefined) context.foreignTransactionFee = validateMoney(item.foreignTransactionFee, 'transaction.routeContext.foreignTransactionFee');
  if (item.markup !== undefined) context.markup = validateMoney(item.markup, 'transaction.routeContext.markup');
  if (item.serviceFee !== undefined) context.serviceFee = validateMoney(item.serviceFee, 'transaction.routeContext.serviceFee');
  if (item.dcc !== undefined) {
    if (typeof item.dcc !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'transaction.routeContext.dcc must be boolean');
    context.dcc = item.dcc;
  }
  return context;
}

export function validateRecommendationTransaction(value: unknown): TransactionTuple {
  const item = object(value, 'transaction');
  return validateTransaction(item.cardId === undefined && item.funding === undefined ? { ...item, cardId: 'recommendation-placeholder' } : item);
}

function validateUsageKey(key: string, name: string): string {
  if (typeof key !== 'string' || !key.trim() || key.length > 256) throw new RewardServiceError('INVALID_INPUT', `${name} is invalid`);
  if (key === '__proto__' || key === 'prototype' || key === 'constructor') throw new RewardServiceError('INVALID_INPUT', `${name} is forbidden`);
  if (!/^[A-Za-z0-9][A-Za-z0-9_:|-]{0,255}$/.test(key)) throw new RewardServiceError('INVALID_INPUT', `${name} contains invalid characters`);
  return key;
}

export function validateContext(value: unknown): EvaluationContext {
  const item = object(value, 'context');
  keys(item, ['now', 'usageByKey', 'sourceSnapshots', 'capPools', 'userConfirmed', 'heldCards', 'eligibilityFacts', 'userFacts', 'paymentEvents'], 'context');
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
  let paymentEvents: EvaluationContext['paymentEvents'];
  if (item.paymentEvents !== undefined) {
    const path = object(item.paymentEvents, 'context.paymentEvents');
    keys(path, ['target', 'sourceEvents'], 'context.paymentEvents');
    if (!Array.isArray(path.sourceEvents) || path.sourceEvents.length > 16) throw new RewardServiceError('INVALID_INPUT', 'context.paymentEvents.sourceEvents must be an array with at most 16 events');
    paymentEvents = { target: validatePaymentEvent(path.target), sourceEvents: path.sourceEvents.map(validatePaymentEvent) };
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
    ...(paymentEvents ? { paymentEvents } : {}),
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
  keys(item, ['status', 'cardId', 'transaction', 'ruleId', 'ruleVersion', 'sourceSnapshotId', 'grossReward', 'cappedReward', 'capRemainingBefore', 'capRemainingAfter', 'unknownReasons', 'diagnostics', 'components'], 'reward');
  const status = requiredString(item.status, 'reward.status');
  if (!['ok', 'no_match', 'unknown', 'needs_review', 'stale'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'reward.status is invalid');
  if (!Array.isArray(item.unknownReasons) || item.unknownReasons.some((reason) => typeof reason !== 'string')) throw new RewardServiceError('INVALID_INPUT', 'reward.unknownReasons must be a string array');
  const diagnostics = item.diagnostics === undefined ? undefined : (Array.isArray(item.diagnostics) ? item.diagnostics.map((value, index) => { const d = object(value, `reward.diagnostics[${index}]`); keys(d, ['code', 'path', 'requiredFacts', 'retryAction', 'message', 'nextAction'], 'reward diagnostic'); if (!Array.isArray(d.requiredFacts) || d.requiredFacts.some((fact) => typeof fact !== 'string')) throw new RewardServiceError('INVALID_INPUT', 'reward diagnostic requiredFacts must be strings'); const retryAction = requiredString(d.retryAction ?? d.nextAction, 'reward diagnostic retryAction'); const message = requiredString(d.message, 'reward diagnostic message'); return { code: requiredString(d.code, 'reward diagnostic code') as never, path: requiredString(d.path, 'reward diagnostic path'), requiredFacts: [...d.requiredFacts], retryAction, message, nextAction: requiredString(d.nextAction ?? retryAction, 'reward diagnostic nextAction') }; }) : (() => { throw new RewardServiceError('INVALID_INPUT', 'reward.diagnostics must be an array'); })());
  let components: RewardBreakdown['components'];
  if (item.components !== undefined) { if (!Array.isArray(item.components)) throw new RewardServiceError('INVALID_INPUT', 'reward.components must be an array'); components = item.components.map((value) => { const c = object(value, 'reward.component'); keys(c, ['kind', 'ruleId', 'ruleVersion', 'sourceSnapshotId', 'reward', 'unit', 'confidence', 'sourceReference', 'observedAt'], 'reward.component'); const confidence = requiredString(c.confidence, 'reward.component.confidence'); if (confidence !== 'confirmed' && confidence !== 'possible') throw new RewardServiceError('INVALID_INPUT', 'reward.component.confidence is invalid'); return { kind: requiredString(c.kind, 'reward.component.kind') as never, ruleId: requiredString(c.ruleId, 'reward.component.ruleId', true), ruleVersion: requiredString(c.ruleVersion, 'reward.component.ruleVersion'), sourceSnapshotId: requiredString(c.sourceSnapshotId, 'reward.component.sourceSnapshotId', true), ...(c.reward === undefined ? {} : { reward: validateSignedMoney(c.reward, 'reward.component.reward') }), unit: requiredString(c.unit, 'reward.component.unit'), confidence: confidence as 'confirmed' | 'possible', ...(c.sourceReference === undefined ? {} : { sourceReference: requiredString(c.sourceReference, 'reward.component.sourceReference') }), ...(c.observedAt === undefined ? {} : { observedAt: iso(c.observedAt, 'reward.component.observedAt') }) }; }); }
  return {
    status: status as RewardBreakdown['status'],
    ...(item.cardId === undefined ? {} : { cardId: requiredString(item.cardId, 'reward.cardId', true) }),
    transaction: validateTransaction(item.transaction),
    ...(item.ruleId === undefined ? {} : { ruleId: requiredString(item.ruleId, 'reward.ruleId', true) }),
    ...(item.ruleVersion === undefined ? {} : { ruleVersion: requiredString(item.ruleVersion, 'reward.ruleVersion') }),
    ...(item.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: requiredString(item.sourceSnapshotId, 'reward.sourceSnapshotId', true) }),
    ...(item.grossReward === undefined ? {} : { grossReward: validateSignedMoney(item.grossReward, 'reward.grossReward') }),
    ...(item.cappedReward === undefined ? {} : { cappedReward: validateSignedMoney(item.cappedReward, 'reward.cappedReward') }),
    ...(item.capRemainingBefore === undefined ? {} : { capRemainingBefore: validateMoney(item.capRemainingBefore, 'reward.capRemainingBefore') }),
    ...(item.capRemainingAfter === undefined ? {} : { capRemainingAfter: validateMoney(item.capRemainingAfter, 'reward.capRemainingAfter') }),
    unknownReasons: [...item.unknownReasons], ...(diagnostics ? { diagnostics } : {}), ...(components ? { components } : {}),
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
  keys(item, ['campaignId', 'cardId', 'enrolled', 'enrolledAt', 'usageByPeriod'], 'enrollment');
  const usageByPeriod: Record<string, Money> = {};
  if (item.usageByPeriod !== undefined) for (const [key, money] of Object.entries(object(item.usageByPeriod, 'enrollment.usageByPeriod'))) usageByPeriod[requiredString(key, 'enrollment usage key', true)] = validateSignedMoney(money, `enrollment.usageByPeriod.${key}`);
  return { campaignId: requiredString(item.campaignId, 'enrollment.campaignId', true), cardId: requiredString(item.cardId, 'enrollment.cardId', true), enrolled: item.enrolled === true, ...(item.enrolledAt === undefined ? {} : { enrolledAt: iso(item.enrolledAt, 'enrollment.enrolledAt') }), ...(Object.keys(usageByPeriod).length ? { usageByPeriod } : {}) };
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
  keys(item, ['kind', 'ownerUser', 'cardId', 'timezone', 'switchedAtUtc', 'switchedAtLocal', 'switchedLocalDate', 'benefit', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'confirmation', 'action', 'idempotencyKey', 'adjustmentReason', 'effectiveFrom', 'effectiveTo', 'campaignId'], 'cardSwitch');
  const action = requiredString(item.action, 'cardSwitch.action');
  if (action !== 'record' && action !== 'adjust') throw new RewardServiceError('STORE_CORRUPT', 'cardSwitch.action is invalid');
  const kind = item.kind === undefined ? 'card_switch' : requiredString(item.kind, 'cardSwitch.kind');
  if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('STORE_CORRUPT', 'cardSwitch.kind is invalid');
  return { kind, ...(item.ownerUser === undefined ? {} : { ownerUser: requiredString(item.ownerUser, 'cardSwitch.ownerUser', true) }), cardId: requiredString(item.cardId, 'cardSwitch.cardId', true), timezone: validateTimezone(item.timezone, 'cardSwitch.timezone'), switchedAtUtc: iso(item.switchedAtUtc, 'cardSwitch.switchedAtUtc'), switchedAtLocal: requiredString(item.switchedAtLocal, 'cardSwitch.switchedAtLocal'), switchedLocalDate: requiredString(item.switchedLocalDate, 'cardSwitch.switchedLocalDate'), benefit: requiredString(item.benefit, 'cardSwitch.benefit'), sourceUrl: requiredString(item.sourceUrl, 'cardSwitch.sourceUrl'), sourceSnapshotAt: iso(item.sourceSnapshotAt, 'cardSwitch.sourceSnapshotAt'), ruleVersion: requiredString(item.ruleVersion, 'cardSwitch.ruleVersion'), confirmation: validateCardSwitchConfirmation(item.confirmation), action, idempotencyKey: requiredString(item.idempotencyKey, 'cardSwitch.idempotencyKey', true), ...(item.adjustmentReason === undefined ? {} : { adjustmentReason: requiredString(item.adjustmentReason, 'cardSwitch.adjustmentReason') }), ...(item.effectiveFrom === undefined ? {} : { effectiveFrom: iso(item.effectiveFrom, 'cardSwitch.effectiveFrom') }), ...(item.effectiveTo === undefined ? {} : { effectiveTo: iso(item.effectiveTo, 'cardSwitch.effectiveTo') }), ...(item.campaignId === undefined ? {} : { campaignId: requiredString(item.campaignId, 'cardSwitch.campaignId', true) }) };
}

function validateEventRewardLedger(value: unknown, index: number): EventRewardLedgerRecord {
  const item = object(value, `stored state.eventRewardLedger[${index}]`);
  keys(item, ['idempotencyKey', 'ownerUser', 'eventId', 'eventAmount', 'ruleId', 'ruleVersion', 'evidenceId', 'sponsor', 'benefitGroup', 'reward', 'rewardSpecFingerprint', 'capUsage'], `stored state.eventRewardLedger[${index}]`);
  const capUsage = item.capUsage === undefined ? undefined : (() => { const cap = object(item.capUsage, 'event reward ledger capUsage'); keys(cap, ['poolId', 'periodKey', 'consumedAmount'], 'event reward ledger capUsage'); return { poolId: requiredString(cap.poolId, 'event reward ledger capUsage.poolId', true), periodKey: requiredString(cap.periodKey, 'event reward ledger capUsage.periodKey'), consumedAmount: safeInt(cap.consumedAmount, 'event reward ledger capUsage.consumedAmount', 0) }; })();
  return { idempotencyKey: requiredString(item.idempotencyKey, 'event reward ledger idempotencyKey'), ownerUser: requiredString(item.ownerUser, 'event reward ledger ownerUser', true), eventId: requiredString(item.eventId, 'event reward ledger eventId', true), eventAmount: validateMoney(item.eventAmount, 'event reward ledger eventAmount'), ruleId: requiredString(item.ruleId, 'event reward ledger ruleId', true), ruleVersion: requiredString(item.ruleVersion, 'event reward ledger ruleVersion'), evidenceId: requiredString(item.evidenceId, 'event reward ledger evidenceId', true), sponsor: requiredString(item.sponsor, 'event reward ledger sponsor'), benefitGroup: requiredString(item.benefitGroup, 'event reward ledger benefitGroup'), reward: validateMoney(item.reward, 'event reward ledger reward'), rewardSpecFingerprint: requiredString(item.rewardSpecFingerprint, 'event reward ledger rewardSpecFingerprint'), ...(capUsage ? { capUsage } : {}) };
}

function validateEventRewardReversal(value: unknown, index: number): EventRewardReversalRecord {
  const item = object(value, `stored state.eventRewardReversals[${index}]`);
  keys(item, ['idempotencyKey', 'ownerUser', 'eventId', 'originalEventId', 'refundedAmount', 'ruleId', 'ruleVersion', 'evidenceId', 'sponsor', 'benefitGroup', 'reward', 'capUsage'], `stored state.eventRewardReversals[${index}]`);
  const capUsage = item.capUsage === undefined ? undefined : (() => { const cap = object(item.capUsage, 'event reward reversal capUsage'); keys(cap, ['poolId', 'periodKey', 'consumedAmount'], 'event reward reversal capUsage'); if (typeof cap.consumedAmount !== 'number' || !Number.isSafeInteger(cap.consumedAmount) || cap.consumedAmount > 0) throw new RewardServiceError('STORE_CORRUPT', 'event reward reversal capUsage.consumedAmount must be a non-positive integer'); return { poolId: requiredString(cap.poolId, 'event reward reversal capUsage.poolId', true), periodKey: requiredString(cap.periodKey, 'event reward reversal capUsage.periodKey'), consumedAmount: cap.consumedAmount }; })();
  return { idempotencyKey: requiredString(item.idempotencyKey, 'event reward reversal idempotencyKey'), ownerUser: requiredString(item.ownerUser, 'event reward reversal ownerUser', true), eventId: requiredString(item.eventId, 'event reward reversal eventId', true), originalEventId: requiredString(item.originalEventId, 'event reward reversal originalEventId', true), refundedAmount: validateMoney(item.refundedAmount, 'event reward reversal refundedAmount'), ruleId: requiredString(item.ruleId, 'event reward reversal ruleId', true), ruleVersion: requiredString(item.ruleVersion, 'event reward reversal ruleVersion'), evidenceId: requiredString(item.evidenceId, 'event reward reversal evidenceId', true), sponsor: requiredString(item.sponsor, 'event reward reversal sponsor'), benefitGroup: requiredString(item.benefitGroup, 'event reward reversal benefitGroup'), reward: validateSignedMoney(item.reward, 'event reward reversal reward'), ...(capUsage ? { capUsage } : {}) };
}

function validateEventRewardCapUsage(value: unknown, index: number): EventRewardCapUsageRecord {
  const item = object(value, `stored state.eventRewardCapUsage[${index}]`);
  keys(item, ['ownerUser', 'poolId', 'periodKey', 'consumedAmount'], `stored state.eventRewardCapUsage[${index}]`);
  return { ownerUser: requiredString(item.ownerUser, 'event reward cap usage ownerUser', true), poolId: requiredString(item.poolId, 'event reward cap usage poolId', true), periodKey: requiredString(item.periodKey, 'event reward cap usage periodKey'), consumedAmount: safeInt(item.consumedAmount, 'event reward cap usage consumedAmount', 0) };
}

function validateAppliedFxRate(value: unknown): AppliedFxRate {
  const item = object(value, 'appliedFx');
  keys(item, ['snapshotId', 'baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt', 'provider', 'rateType', 'sourceUrl', 'contentHash', 'conversionOwner', 'appliedAtUtc'], 'appliedFx');
  return {
    snapshotId: requiredString(item.snapshotId, 'appliedFx.snapshotId', true),
    baseCurrency: requiredString(item.baseCurrency, 'appliedFx.baseCurrency', true).toUpperCase(),
    quoteCurrency: requiredString(item.quoteCurrency, 'appliedFx.quoteCurrency', true).toUpperCase(),
    ratePpm: safeInt(item.ratePpm, 'appliedFx.ratePpm', 1),
    capturedAt: iso(item.capturedAt, 'appliedFx.capturedAt'),
    provider: requiredString(item.provider, 'appliedFx.provider'),
    rateType: requiredString(item.rateType, 'appliedFx.rateType') as FxRateType,
    ...(item.sourceUrl === undefined ? {} : { sourceUrl: requiredString(item.sourceUrl, 'appliedFx.sourceUrl') }),
    ...(item.contentHash === undefined ? {} : { contentHash: requiredString(item.contentHash, 'appliedFx.contentHash') }),
    ...(item.conversionOwner === undefined ? {} : { conversionOwner: requiredString(item.conversionOwner, 'appliedFx.conversionOwner') }),
    appliedAtUtc: iso(item.appliedAtUtc, 'appliedFx.appliedAtUtc'),
  };
}

export function validateIngestionSourceScope(value: unknown): IngestionSourceScope {
  const item = object(value, 'ingestion sourceScope');
  keys(item, ['kind', 'value'], 'ingestion sourceScope');
  const kind = requiredString(item.kind, 'ingestion sourceScope.kind');
  const rawValue = requiredString(item.value, 'ingestion sourceScope.value');
  if (kind === 'official_url') {
    let url: URL;
    try { url = new URL(rawValue); } catch { throw new RewardServiceError('INVALID_INPUT', 'ingestion sourceScope.value must be an absolute HTTPS URL'); }
    if (url.protocol !== 'https:' || url.username || url.password) throw new RewardServiceError('INVALID_INPUT', 'ingestion sourceScope.value must be a credential-free HTTPS URL');
    url.hash = '';
    return { kind, value: url.toString() };
  }
  if (kind === 'offer_family') {
    const normalized = rawValue.normalize('NFKC').trim().toLocaleLowerCase('und');
    if (!/^[a-z0-9][a-z0-9_:-]{0,127}$/.test(normalized)) throw new RewardServiceError('INVALID_INPUT', 'ingestion sourceScope.value must be a normalized offer-family identifier');
    return { kind, value: normalized };
  }
  throw new RewardServiceError('INVALID_INPUT', 'ingestion sourceScope.kind is invalid');
}

function validateIngestionFlow(value: unknown): IngestionFlowRecord {
  const item = object(value, 'ingestion flow');
  keys(item, ['id', 'ownerUser', 'sourceScope', 'revision', 'status', 'idempotencyKey', 'createdAt', 'lastActivityAt', 'expiresAt'], 'ingestion flow');
  const status = requiredString(item.status, 'ingestion flow.status');
  if (!['awaiting_source', 'awaiting_manifest', 'processing_leaves', 'ready_to_finalize', 'complete', 'needs_review', 'conflict', 'failed', 'cancelled', 'expired'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'ingestion flow.status is invalid');
  return { id: requiredString(item.id, 'ingestion flow.id', true), ownerUser: requiredString(item.ownerUser, 'ingestion flow.ownerUser', true), sourceScope: validateIngestionSourceScope(item.sourceScope), revision: safeInt(item.revision, 'ingestion flow.revision', 1), status: status as IngestionFlowRecord['status'], idempotencyKey: requiredString(item.idempotencyKey, 'ingestion flow.idempotencyKey', true), createdAt: iso(item.createdAt, 'ingestion flow.createdAt'), lastActivityAt: iso(item.lastActivityAt, 'ingestion flow.lastActivityAt'), expiresAt: iso(item.expiresAt, 'ingestion flow.expiresAt') };
}

function validateIngestionDraftTombstone(value: unknown): IngestionDraftTombstone {
  const item = object(value, 'ingestion draft tombstone');
  keys(item, ['id', 'ownerUser', 'sourceScope', 'revision', 'createdAt', 'expiredAt', 'retentionExpiresAt'], 'ingestion draft tombstone');
  return { id: requiredString(item.id, 'ingestion draft tombstone.id', true), ownerUser: requiredString(item.ownerUser, 'ingestion draft tombstone.ownerUser', true), sourceScope: validateIngestionSourceScope(item.sourceScope), revision: safeInt(item.revision, 'ingestion draft tombstone.revision', 1), createdAt: iso(item.createdAt, 'ingestion draft tombstone.createdAt'), expiredAt: iso(item.expiredAt, 'ingestion draft tombstone.expiredAt'), retentionExpiresAt: iso(item.retentionExpiresAt, 'ingestion draft tombstone.retentionExpiresAt') };
}

export function validateStoredState(value: unknown): StoredState {
  const item = object(value, 'stored state');
  keys(item, ['schemaVersion', 'cards', 'snapshots', 'rules', 'transactions', 'campaigns', 'switchEnrollments', 'cardSwitches', 'capPools', 'rewardComponents', 'merchants', 'evidence', 'factCandidates', 'paymentRoutes', 'paymentCapabilities', 'paymentAccounts', 'valuationSnapshots', 'eventRewardSchemaVersion', 'eventRewardLedger', 'eventRewardReversals', 'eventRewardCapUsage', 'ingestionFlows', 'ingestionDraftTombstones'], 'stored state');
  if (item.schemaVersion !== 2 && item.schemaVersion !== 3) throw new RewardServiceError('INCOMPATIBLE_SCHEMA', 'unsupported persistent schema version; data was not deleted');
  if (item.eventRewardSchemaVersion !== undefined && item.eventRewardSchemaVersion !== 1) throw new RewardServiceError('INCOMPATIBLE_SCHEMA', 'unsupported event reward ledger schema version; data was not deleted');
  if (!Array.isArray(item.cards) || !Array.isArray(item.snapshots) || !Array.isArray(item.rules) || !Array.isArray(item.transactions)) throw new RewardServiceError('STORE_CORRUPT', 'state collections must be arrays');
  const transactions = item.transactions.map((value, index) => {
    const record = object(value, `stored state.transactions[${index}]`);
    keys(record, ['transaction', 'reward', 'ownerUser', 'appliedFx', 'recordedAt'], `stored state.transactions[${index}]`);
    const transaction = validateTransaction(record.transaction);
    const reward = validateRewardBreakdown(record.reward);
    if (JSON.stringify(reward.transaction) !== JSON.stringify(transaction)) throw new RewardServiceError('STORE_CORRUPT', `stored state.transactions[${index}] transaction mismatch`);
    return {
      transaction,
      reward,
      ...(record.ownerUser === undefined ? {} : { ownerUser: requiredString(record.ownerUser, `stored state.transactions[${index}].ownerUser`, true) }),
      ...(record.appliedFx ? { appliedFx: validateAppliedFxRate(record.appliedFx) } : {}),
      ...(record.recordedAt ? { recordedAt: iso(record.recordedAt, `stored state.transactions[${index}].recordedAt`) } : {}),
    };
  });
  const campaigns = item.campaigns === undefined ? [] : (Array.isArray(item.campaigns) ? item.campaigns.map(validateCardSwitchCampaign) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'campaigns must be an array'); })());
  const switchEnrollments = item.switchEnrollments === undefined ? [] : (Array.isArray(item.switchEnrollments) ? item.switchEnrollments.map(validateCardSwitchEnrollment) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'switchEnrollments must be an array'); })());
  const cardSwitches = item.cardSwitches === undefined ? [] : (Array.isArray(item.cardSwitches) ? item.cardSwitches.map(validateCardSwitchProjection) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'cardSwitches must be an array'); })());
  const capPools = item.capPools === undefined ? [] : (Array.isArray(item.capPools) ? item.capPools.map(validateCapPool) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'capPools must be an array'); })());
  const rewardComponents = item.rewardComponents === undefined ? [] : (Array.isArray(item.rewardComponents) ? item.rewardComponents.map((value, index) => validateRewardComponentRecord(value, index)) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'rewardComponents must be an array'); })());
  const merchants = item.merchants === undefined ? [] : (Array.isArray(item.merchants) ? item.merchants.map(validateMerchant) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'merchants must be an array'); })());
  const evidence = item.evidence === undefined ? [] : (Array.isArray(item.evidence) ? item.evidence.map(validateEvidence) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'evidence must be an array'); })());
  const factCandidates = item.factCandidates === undefined ? [] : (Array.isArray(item.factCandidates) ? item.factCandidates.map(validateFactCandidate) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'factCandidates must be an array'); })());
  const paymentRoutes = item.paymentRoutes === undefined ? [] : (Array.isArray(item.paymentRoutes) ? item.paymentRoutes.map(validatePaymentRouteRecord) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'paymentRoutes must be an array'); })());
  const paymentCapabilities = item.paymentCapabilities === undefined ? [] : (Array.isArray(item.paymentCapabilities) ? item.paymentCapabilities.map(validatePaymentCapability) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'paymentCapabilities must be an array'); })());
  const paymentAccounts = item.paymentAccounts === undefined ? [] : (Array.isArray(item.paymentAccounts) ? item.paymentAccounts.map(validatePaymentAccountRecord) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'paymentAccounts must be an array'); })());
  const valuationSnapshots = item.valuationSnapshots === undefined ? [] : (Array.isArray(item.valuationSnapshots) ? item.valuationSnapshots.map(validateRewardValuationSnapshot) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'valuationSnapshots must be an array'); })());
  const eventRewardLedger = item.eventRewardLedger === undefined ? [] : (Array.isArray(item.eventRewardLedger) ? item.eventRewardLedger.map(validateEventRewardLedger) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'eventRewardLedger must be an array'); })());
  const eventRewardReversals = item.eventRewardReversals === undefined ? [] : (Array.isArray(item.eventRewardReversals) ? item.eventRewardReversals.map(validateEventRewardReversal) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'eventRewardReversals must be an array'); })());
  const eventRewardCapUsage = item.eventRewardCapUsage === undefined ? [] : (Array.isArray(item.eventRewardCapUsage) ? item.eventRewardCapUsage.map(validateEventRewardCapUsage) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'eventRewardCapUsage must be an array'); })());
  const ingestionFlows = item.ingestionFlows === undefined ? [] : (Array.isArray(item.ingestionFlows) ? item.ingestionFlows.map(validateIngestionFlow) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'ingestionFlows must be an array'); })());
  const ingestionDraftTombstones = item.ingestionDraftTombstones === undefined ? [] : (Array.isArray(item.ingestionDraftTombstones) ? item.ingestionDraftTombstones.map(validateIngestionDraftTombstone) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'ingestionDraftTombstones must be an array'); })());
  if (new Set(capPools.map((pool) => pool.id)).size !== capPools.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate cap pool id');
  if (new Set(eventRewardLedger.map((record) => record.idempotencyKey)).size !== eventRewardLedger.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate event reward ledger idempotency key');
  if (new Set(eventRewardReversals.map((record) => record.idempotencyKey)).size !== eventRewardReversals.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate event reward reversal idempotency key');
  if (new Set(ingestionFlows.map((flow) => flow.id)).size !== ingestionFlows.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate ingestion flow id');
  if (new Set(ingestionDraftTombstones.map((tombstone) => tombstone.id)).size !== ingestionDraftTombstones.length) throw new RewardServiceError('STORE_CORRUPT', 'duplicate ingestion draft tombstone id');
  return { schemaVersion: 3, cards: item.cards.map(validateCard), snapshots: item.snapshots.map(validateSnapshot), rules: item.rules.map(validateRule), transactions, campaigns, switchEnrollments, cardSwitches, capPools, rewardComponents, merchants, evidence, factCandidates, paymentRoutes, paymentCapabilities, paymentAccounts, valuationSnapshots, eventRewardSchemaVersion: 1, eventRewardLedger, eventRewardReversals, eventRewardCapUsage, ingestionFlows, ingestionDraftTombstones };
}

function validatePaymentRouteLayer(value: unknown): PaymentRouteRecord['layers'][number] {
  const layer = object(value, 'payment route layer');
  keys(layer, ['kind', 'providerId', 'appId', 'paymentMethod', 'displayName', 'evidenceIds'], 'payment route layer');
  const kind = requiredString(layer.kind, 'payment route layer.kind');
  if (!['merchant_loyalty', 'merchant_acceptance', 'consumer_app', 'payment_provider', 'wallet', 'interoperability_scheme', 'intermediate_provider', 'card_network', 'card_issuer'].includes(kind)) throw new RewardServiceError('INVALID_INPUT', 'payment route layer kind is invalid');
  const result: PaymentRouteRecord['layers'][number] = { kind: kind as PaymentRouteRecord['layers'][number]['kind'] };
  for (const field of ['providerId', 'appId', 'paymentMethod', 'displayName'] as const) {
    const parsed = optionalString(layer[field], `payment route layer.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  if (layer.evidenceIds !== undefined) {
    if (!Array.isArray(layer.evidenceIds)) throw new RewardServiceError('INVALID_INPUT', 'payment route layer.evidenceIds must be an array');
    result.evidenceIds = layer.evidenceIds.map((id) => requiredString(id, 'payment route layer.evidenceIds[]', true));
  }
  return result;
}

function validatePaymentRouteFunding(value: unknown): FundingInstrument {
  const funding = object(value, 'payment route funding');
  keys(funding, ['kind', 'cardId', 'accountId', 'subtype'], 'payment route funding');
  const kind = requiredString(funding.kind, 'payment route funding.kind');
  if (kind === 'credit_card') {
    const cardId = optionalString(funding.cardId, 'payment route funding.cardId', true);
    return cardId === undefined ? { kind } : { kind, cardId };
  }
  if (kind === 'account') {
    const subtype = requiredString(funding.subtype, 'payment route funding.subtype');
    if (!['linked_bank_account', 'wallet_balance', 'foreign_currency_account'].includes(subtype)) throw new RewardServiceError('INVALID_INPUT', 'payment route funding kind or subtype is invalid');
    const accountId = optionalString(funding.accountId, 'payment route funding.accountId', true);
    return accountId === undefined ? { kind, subtype: subtype as Extract<FundingInstrument, { kind: 'account' }>['subtype'] } : { kind, subtype: subtype as Extract<FundingInstrument, { kind: 'account' }>['subtype'], accountId };
  }
  if (kind === 'cash' && funding.subtype === undefined && funding.cardId === undefined && funding.accountId === undefined) return { kind };
  throw new RewardServiceError('INVALID_INPUT', 'payment route funding kind or subtype is invalid');
}

function validatePaymentRouteNode(value: unknown, index: number): NonNullable<PaymentRouteRecord['nodes']>[number] {
  const node = object(value, `payment route nodes[${index}]`);
  keys(node, ['id', 'kind', 'displayName'], 'payment route node');
  const kind = requiredString(node.kind, 'payment route node.kind');
  if (!['funding_source', 'wallet_balance', 'payment_service', 'acceptance_network', 'merchant'].includes(kind)) throw new RewardServiceError('INVALID_INPUT', 'payment route node role is invalid');
  return { id: requiredString(node.id, 'payment route node.id', true), kind: kind as NonNullable<PaymentRouteRecord['nodes']>[number]['kind'], displayName: requiredString(node.displayName, 'payment route node.displayName') };
}

function validatePaymentRouteEdge(value: unknown, index: number): NonNullable<PaymentRouteRecord['edges']>[number] {
  const edge = object(value, `payment route edges[${index}]`);
  keys(edge, ['edgeId', 'fromNodeId', 'toNodeId', 'transition', 'evidenceIds', 'provenance', 'direction', 'fromMarket', 'toMarket', 'market', 'currency', 'validFrom', 'validTo', 'fee', 'markup', 'foreignTransactionFee', 'fx', 'dcc'], 'payment route edge');
  const transition = requiredString(edge.transition, 'payment route edge.transition');
  if (!['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'].includes(transition)) throw new RewardServiceError('INVALID_INPUT', 'payment route edge transition is invalid');
  if (!Array.isArray(edge.evidenceIds)) throw new RewardServiceError('INVALID_INPUT', 'payment route edge evidenceIds must be an array');
  const result: NonNullable<PaymentRouteRecord['edges']>[number] = {
    edgeId: requiredString(edge.edgeId, 'payment route edge.edgeId', true),
    fromNodeId: requiredString(edge.fromNodeId, 'payment route edge.fromNodeId', true),
    toNodeId: requiredString(edge.toNodeId, 'payment route edge.toNodeId', true),
    transition: transition as NonNullable<PaymentRouteRecord['edges']>[number]['transition'],
    evidenceIds: edge.evidenceIds.map((id) => requiredString(id, 'payment route edge.evidenceIds[]', true)),
  };
  const direction = optionalString(edge.direction, 'payment route edge.direction');
  if (direction !== undefined && direction !== 'inbound' && direction !== 'outbound') throw new RewardServiceError('INVALID_INPUT', 'payment route edge direction is invalid');
  const fromMarket = optionalString(edge.fromMarket, 'payment route edge.fromMarket', true);
  const toMarket = optionalString(edge.toMarket, 'payment route edge.toMarket', true);
  if ((fromMarket === undefined) !== (toMarket === undefined)) throw new RewardServiceError('INVALID_INPUT', 'payment route edge requires both fromMarket and toMarket');
  const provenance = optionalString(edge.provenance, 'payment route edge.provenance');
  if (provenance !== undefined) result.provenance = provenance as Exclude<NonNullable<PaymentRouteRecord['edges']>[number]['provenance'], undefined>;
  if (direction !== undefined) result.direction = direction as Exclude<NonNullable<PaymentRouteRecord['edges']>[number]['direction'], undefined>;
  if (fromMarket !== undefined && toMarket !== undefined) { result.fromMarket = fromMarket; result.toMarket = toMarket; }
  for (const field of ['market', 'currency'] as const) {
    const parsed = optionalString(edge[field], `payment route edge.${field}`);
    if (parsed !== undefined) result[field] = parsed;
  }
  if (edge.validFrom !== undefined) result.validFrom = iso(edge.validFrom, 'payment route edge.validFrom');
  if (edge.validTo !== undefined) result.validTo = iso(edge.validTo, 'payment route edge.validTo');
  if (edge.fee !== undefined) result.fee = validateMoney(edge.fee, 'payment route edge.fee');
  if (edge.markup !== undefined) result.markup = validateMoney(edge.markup, 'payment route edge.markup');
  if (edge.foreignTransactionFee !== undefined) result.foreignTransactionFee = validateMoney(edge.foreignTransactionFee, 'payment route edge.foreignTransactionFee');
  if (edge.fx !== undefined) result.fx = validateFxSnapshot(edge.fx, 'payment route edge.fx');
  if (edge.dcc !== undefined) {
    const dcc = object(edge.dcc, 'payment route edge.dcc');
    keys(dcc, ['selected', 'fee'], 'payment route edge.dcc');
    if (typeof dcc.selected !== 'boolean') throw new RewardServiceError('INVALID_INPUT', 'payment route edge.dcc.selected must be boolean');
    result.dcc = { selected: dcc.selected };
    if (dcc.fee !== undefined) result.dcc.fee = validateMoney(dcc.fee, 'payment route edge.dcc.fee');
  }
  return result;
}

export function validatePaymentRouteRecord(value: unknown): PaymentRouteRecord {
  const item = object(value, 'payment route');
  keys(item, ['id', 'status', 'layers', 'funding', 'sourceUrl', 'sourceSnapshotId', 'contentHash', 'observedAt', 'validFrom', 'validTo', 'authority', 'confidence', 'confirmation', 'failure', 'evidenceIds', 'idempotencyKey', 'ownerUser', 'nodes', 'edges'], 'payment route');
  if (!Array.isArray(item.layers)) throw new RewardServiceError('INVALID_INPUT', 'payment route layers must be an array');
  const status = requiredString(item.status, 'payment route status');
  if (!['candidate', 'active', 'stale', 'conflict', 'needs_review', 'failed'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'payment route status is invalid');
  const authority = optionalString(item.authority, 'payment route authority');
  if (authority !== undefined && !['issuer', 'network', 'wallet', 'merchant', 'secondary', 'community', 'user'].includes(authority)) throw new RewardServiceError('INVALID_INPUT', 'payment route authority is invalid');
  const confidence = optionalString(item.confidence, 'payment route confidence');
  if (confidence !== undefined && !['high', 'medium', 'low'].includes(confidence)) throw new RewardServiceError('INVALID_INPUT', 'payment route confidence is invalid');
  let confirmation: PaymentRouteRecord['confirmation'];
  if (item.confirmation !== undefined) {
    const input = object(item.confirmation, 'payment route confirmation');
    keys(input, ['confirmedAt', 'confirmedBy'], 'payment route confirmation');
    confirmation = { confirmedAt: iso(input.confirmedAt, 'payment route confirmation.confirmedAt'), confirmedBy: requiredString(input.confirmedBy, 'payment route confirmation.confirmedBy') };
  }
  let failure: PaymentRouteRecord['failure'];
  if (item.failure !== undefined) {
    const input = object(item.failure, 'payment route failure');
    keys(input, ['failedAt', 'failedBy', 'reason'], 'payment route failure');
    failure = { failedAt: iso(input.failedAt, 'payment route failure.failedAt'), failedBy: requiredString(input.failedBy, 'payment route failure.failedBy'), reason: requiredString(input.reason, 'payment route failure.reason') };
  }
  if (status === 'failed' && failure === undefined) throw new RewardServiceError('INVALID_INPUT', 'failed payment routes require failure details');
  let evidenceIds: readonly string[] | undefined;
  if (item.evidenceIds !== undefined) {
    if (!Array.isArray(item.evidenceIds)) throw new RewardServiceError('INVALID_INPUT', 'payment route evidenceIds must be an array');
    evidenceIds = item.evidenceIds.map((id) => requiredString(id, 'payment route evidenceIds[]', true));
  }
  const nodes = item.nodes === undefined ? undefined : Array.isArray(item.nodes) ? item.nodes.map(validatePaymentRouteNode) : (() => { throw new RewardServiceError('INVALID_INPUT', 'payment route nodes must be an array'); })();
  const edges = item.edges === undefined ? undefined : Array.isArray(item.edges) ? item.edges.map(validatePaymentRouteEdge) : (() => { throw new RewardServiceError('INVALID_INPUT', 'payment route edges must be an array'); })();
  if (nodes !== undefined && new Set(nodes.map((node) => node.id)).size !== nodes.length) throw new RewardServiceError('INVALID_INPUT', 'payment route node ids must be unique');
  if (edges !== undefined) {
    if (new Set(edges.map((edge) => edge.edgeId)).size !== edges.length) throw new RewardServiceError('INVALID_INPUT', 'payment route edge ids must be unique');
    const nodeIds = new Set(nodes?.map((node) => node.id) ?? []);
    if (nodes !== undefined && edges.some((edge) => !nodeIds.has(edge.fromNodeId) || !nodeIds.has(edge.toNodeId))) throw new RewardServiceError('INVALID_INPUT', 'payment route edge endpoint is unknown');
  }
  const route: PaymentRouteRecord = {
    id: requiredString(item.id, 'payment route id', true),
    status: status as PaymentRouteRecord['status'],
    layers: item.layers.map(validatePaymentRouteLayer),
    funding: validatePaymentRouteFunding(item.funding),
    observedAt: iso(item.observedAt, 'payment route observedAt'),
    idempotencyKey: requiredString(item.idempotencyKey, 'payment route idempotencyKey'),
  };
  if (item.sourceUrl !== undefined) route.sourceUrl = requiredString(item.sourceUrl, 'payment route sourceUrl');
  if (item.sourceSnapshotId !== undefined) route.sourceSnapshotId = requiredString(item.sourceSnapshotId, 'payment route sourceSnapshotId', true);
  if (item.contentHash !== undefined) route.contentHash = requiredString(item.contentHash, 'payment route contentHash');
  if (item.validFrom !== undefined) route.validFrom = iso(item.validFrom, 'payment route validFrom');
  if (item.validTo !== undefined) route.validTo = iso(item.validTo, 'payment route validTo');
  if (authority !== undefined) route.authority = authority as Exclude<PaymentRouteRecord['authority'], undefined>;
  if (confidence !== undefined) route.confidence = confidence as Exclude<PaymentRouteRecord['confidence'], undefined>;
  if (confirmation !== undefined) route.confirmation = confirmation;
  if (failure !== undefined) route.failure = failure;
  if (evidenceIds !== undefined) route.evidenceIds = evidenceIds;
  if (item.ownerUser !== undefined) route.ownerUser = requiredString(item.ownerUser, 'payment route ownerUser');
  if (nodes !== undefined) route.nodes = nodes;
  if (edges !== undefined) route.edges = edges;
  return route;
}

export function validatePaymentAccountRecord(value: unknown): PaymentAccountRecord {
  const item = object(value, 'payment account');
  keys(item, ['id', 'providerId', 'kind', 'displayName', 'status', 'observedAt', 'sourceUrl', 'sourceSnapshotId', 'evidenceIds', 'confirmation', 'idempotencyKey', 'ownerUser', 'balance'], 'payment account');
  const kind = requiredString(item.kind, 'payment account kind');
  if (!['linked_bank_account', 'wallet_balance', 'foreign_currency_account'].includes(kind)) throw new RewardServiceError('INVALID_INPUT', 'payment account kind is invalid');
  const status = requiredString(item.status, 'payment account status');
  if (!['candidate', 'active', 'stale', 'needs_review'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'payment account status is invalid');
  let confirmation: PaymentAccountRecord['confirmation'];
  if (item.confirmation !== undefined) { const value = object(item.confirmation, 'payment account confirmation'); keys(value, ['confirmedAt', 'confirmedBy'], 'payment account confirmation'); confirmation = { confirmedAt: iso(value.confirmedAt, 'payment account confirmation.confirmedAt'), confirmedBy: requiredString(value.confirmedBy, 'payment account confirmation.confirmedBy') }; }
  if (status === 'active' && !confirmation) throw new RewardServiceError('INVALID_CONFIRMATION', 'active payment accounts require explicit confirmation');
  const evidenceIds = item.evidenceIds === undefined ? undefined : (Array.isArray(item.evidenceIds) ? item.evidenceIds.map((id) => requiredString(id, 'payment account evidenceIds[]', true)) : (() => { throw new RewardServiceError('INVALID_INPUT', 'payment account evidenceIds must be an array'); })());
  let balance: PaymentAccountRecord['balance'];
  if (item.balance !== undefined) { const value = object(item.balance, 'payment account balance'); keys(value, ['amountMinor', 'currency'], 'payment account balance'); if (typeof value.amountMinor !== 'number' || !Number.isSafeInteger(value.amountMinor) || value.amountMinor < 0) throw new RewardServiceError('INVALID_INPUT', 'payment account balance amount is invalid'); balance = { amountMinor: value.amountMinor, currency: requiredString(value.currency, 'payment account balance currency') }; }
  return { id: requiredString(item.id, 'payment account id', true), providerId: requiredString(item.providerId, 'payment account providerId', true), kind: kind as PaymentAccountRecord['kind'], displayName: requiredString(item.displayName, 'payment account displayName'), status: status as PaymentAccountRecord['status'], observedAt: iso(item.observedAt, 'payment account observedAt'), ...(item.sourceUrl === undefined ? {} : { sourceUrl: requiredString(item.sourceUrl, 'payment account sourceUrl') }), ...(item.sourceSnapshotId === undefined ? {} : { sourceSnapshotId: requiredString(item.sourceSnapshotId, 'payment account sourceSnapshotId', true) }), ...(evidenceIds === undefined ? {} : { evidenceIds }), ...(confirmation === undefined ? {} : { confirmation }), idempotencyKey: requiredString(item.idempotencyKey, 'payment account idempotencyKey'), ...(item.ownerUser === undefined ? {} : { ownerUser: requiredString(item.ownerUser, 'payment account ownerUser') }), ...(balance === undefined ? {} : { balance }) };
}

export function validateEvidence(value: unknown): EvidenceRecord {
  const item = object(value, 'evidence');
  keys(item, ['id', 'requirementId', 'sourceIdentity', 'sourceType', 'authority', 'claim', 'observedAt', 'validFrom', 'validTo', 'refreshAfter', 'confidence', 'contentHash', 'reviewState', 'sourceUrl', 'ownerUser'], 'evidence');
  const claim = object(item.claim, 'evidence claim');
  for (const value of Object.values(claim)) if (!['string', 'number', 'boolean'].includes(typeof value)) throw new RewardServiceError('INVALID_INPUT', 'evidence claim values must be scalar');
  const sourceType = requiredString(item.sourceType, 'evidence sourceType');
  const authority = requiredString(item.authority, 'evidence authority');
  const confidence = requiredString(item.confidence, 'evidence confidence');
  const reviewState = requiredString(item.reviewState, 'evidence reviewState');
  if (!['official', 'trusted_secondary', 'community', 'user_provided'].includes(sourceType) || !['issuer', 'network', 'wallet', 'merchant', 'secondary', 'community', 'user'].includes(authority) || !['high', 'medium', 'low'].includes(confidence) || !['accepted', 'candidate', 'conflict', 'rejected'].includes(reviewState)) throw new RewardServiceError('INVALID_INPUT', 'evidence enum is invalid');
  return { id: requiredString(item.id, 'evidence id', true), requirementId: requiredString(item.requirementId, 'evidence requirementId'), sourceIdentity: requiredString(item.sourceIdentity, 'evidence sourceIdentity'), sourceType: sourceType as EvidenceRecord['sourceType'], authority: authority as EvidenceRecord['authority'], claim: claim as EvidenceRecord['claim'], observedAt: iso(item.observedAt, 'evidence observedAt'), ...(item.validFrom === undefined ? {} : { validFrom: iso(item.validFrom, 'evidence validFrom') }), ...(item.validTo === undefined ? {} : { validTo: iso(item.validTo, 'evidence validTo') }), ...(item.refreshAfter === undefined ? {} : { refreshAfter: iso(item.refreshAfter, 'evidence.refreshAfter') }), confidence: confidence as EvidenceRecord['confidence'], contentHash: requiredString(item.contentHash, 'evidence contentHash'), reviewState: reviewState as EvidenceRecord['reviewState'], ...(item.sourceUrl === undefined ? {} : { sourceUrl: requiredString(item.sourceUrl, 'evidence sourceUrl') }), ...(item.ownerUser === undefined ? {} : { ownerUser: requiredString(item.ownerUser, 'evidence.ownerUser') }) };
}

export function validateFactCandidate(value: unknown): FactCandidate {
  const item = object(value, 'fact candidate');
  keys(item, ['id', 'requirementId', 'fact', 'evidenceId', 'reviewState'], 'fact candidate');
  return { id: requiredString(item.id, 'fact candidate id', true), requirementId: requiredString(item.requirementId, 'fact candidate requirementId'), fact: object(item.fact, 'fact candidate fact') as FactCandidate['fact'], evidenceId: requiredString(item.evidenceId, 'fact candidate evidenceId', true), reviewState: requiredString(item.reviewState, 'fact candidate reviewState') as FactCandidate['reviewState'] };
}

function validateRewardComponentRecord(value: unknown, index: number): RewardComponentRecord {
  const item = object(value, `stored state.rewardComponents[${index}]`);
  keys(item, ['componentId', 'transactionId', 'ruleId', 'ruleVersion', 'route', 'provider', 'reward', 'capUsages', 'appliedAtUtc'], 'reward component');
  const reward = object(item.reward, 'reward component reward');
  keys(reward, ['value', 'unitType', 'unitName', 'currency'], 'reward component reward');
  if (typeof reward.value !== 'number' || !Number.isSafeInteger(reward.value)) throw new RewardServiceError('STORE_CORRUPT', 'reward component value must be an integer');
  const capUsages = Array.isArray(item.capUsages) ? item.capUsages.map((entry) => {
    const cap = object(entry, 'reward component cap usage');
    keys(cap, ['poolId', 'periodKey', 'metric', 'consumedAmount'], 'reward component cap usage');
    if (typeof cap.consumedAmount !== 'number' || !Number.isSafeInteger(cap.consumedAmount)) throw new RewardServiceError('STORE_CORRUPT', 'cap usage amount must be an integer');
    return { poolId: requiredString(cap.poolId, 'cap usage poolId', true), periodKey: requiredString(cap.periodKey, 'cap usage periodKey'), metric: requiredString(cap.metric, 'cap usage metric') as 'reward' | 'spend' | 'transaction_count', consumedAmount: cap.consumedAmount };
  }) : (() => { throw new RewardServiceError('STORE_CORRUPT', 'reward component capUsages must be an array'); })();
  const route = requiredString(item.route, 'reward component route');
  if (!['merchant', 'payment_provider', 'card_issuer'].includes(route)) throw new RewardServiceError('STORE_CORRUPT', 'reward component route is invalid');
  return { componentId: requiredString(item.componentId, 'componentId', true), transactionId: requiredString(item.transactionId, 'transactionId', true), ruleId: requiredString(item.ruleId, 'ruleId', true), ruleVersion: requiredString(item.ruleVersion, 'ruleVersion'), route: route as RewardComponentRecord['route'], ...(item.provider === undefined ? {} : { provider: requiredString(item.provider, 'provider') }), reward: { value: reward.value, unitType: requiredString(reward.unitType, 'unitType'), unitName: requiredString(reward.unitName, 'unitName'), ...(reward.currency === undefined ? {} : { currency: requiredString(reward.currency, 'reward currency', true).toUpperCase() }) }, capUsages, appliedAtUtc: iso(item.appliedAtUtc, 'appliedAtUtc') };
}

export function validateToolArgs(name: string, value: unknown): Record<string, unknown> {
  const args = object(value, 'tool arguments');
  if (name === 'recommend') return { ...validateRecommendationIntent(args) };
  const allowed: Record<string, string[]> = { register_card: ['card'], list_cards: ['limit', 'page', 'projection'], upsert_offer: ['snapshot', 'rule', 'confirmation', 'capPools', 'merchant'], upsert_payment_route: ['route'], list_payment_routes: ['limit', 'page', 'projection'], upsert_payment_capability: ['capability'], list_payment_capabilities: [], register_payment_account: ['account'], list_payment_accounts: ['limit', 'page', 'projection'], record_transaction: ['transaction'], list_transactions: ['startDate', 'endDate', 'timeBasis', 'fundingKind', 'cardId', 'limit', 'page', 'projection'], record_event_reward: ['event', 'sourceEvents', 'rule', 'chainRule', 'candidate', 'idempotencyKey'], reverse_event_reward: ['event', 'idempotencyKey'], remaining_caps: ['cardId', 'asOf', 'limit', 'page', 'projection'], calculate_reward: ['rule', 'transaction', 'context'], get_user_benefit_status: ['kind', 'cardId', 'asOfUtc', 'projection'], upsert_user_benefit_status: ['input'], resolve_merchant: ['rawQuery', 'country', 'market', 'mcc', 'channel'], search_active_offers: ['rawQuery', 'cardId', 'canonicalMerchantId', 'country', 'market', 'mcc', 'channel', 'asOf', 'limit', 'page', 'projection'] };
  if (!allowed[name]) throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  keys(args, allowed[name], `tool ${name}`);
  const normalized: Record<string, unknown> = {};
  for (const key of allowed[name]) if (args[key] !== undefined) normalized[key] = args[key];
  return normalized;
}

export function validateRecommendationIntent(value: unknown): RecommendationIntent {
  const input = object(value, 'recommend intent');
  keys(input, ['merchant', 'amount', 'country', 'market', 'channel', 'paymentMethod', 'occurredAt', 'cardIds', 'routeIds', 'limit', 'page', 'cursor', 'resultVersion', 'fx', 'routeFacts', 'eligibilityFacts'], 'recommend intent');
  let merchant: RecommendationIntent['merchant'];
  if (typeof input.merchant === 'string') merchant = requiredString(input.merchant, 'merchant');
  else {
    const fields = object(input.merchant, 'merchant');
    keys(fields, ['name', 'rawStatement', 'canonicalId', 'canonicalNameZhHant', 'country', 'market'], 'merchant');
    if (!['name', 'rawStatement', 'canonicalId', 'canonicalNameZhHant'].some(key => fields[key] !== undefined)) throw new RewardServiceError('INVALID_INPUT', 'merchant identity is required');
    merchant = {
      ...(fields.rawStatement === undefined ? {} : { rawStatement: requiredString(fields.rawStatement, 'merchant.rawStatement') }),
      ...(fields.name === undefined ? {} : { name: requiredString(fields.name, 'merchant.name') }),
      ...(fields.canonicalId === undefined ? {} : { canonicalId: requiredString(fields.canonicalId, 'merchant.canonicalId', true) }),
      ...(fields.canonicalNameZhHant === undefined ? {} : { canonicalNameZhHant: requiredString(fields.canonicalNameZhHant, 'merchant.canonicalNameZhHant') }),
      ...(fields.country === undefined ? {} : { country: requiredString(fields.country, 'merchant.country') }),
      ...(fields.market === undefined ? {} : { market: requiredString(fields.market, 'merchant.market') }),
    };
    for (const field of ['country', 'market']) if (input[field] !== undefined && fields[field] !== undefined && input[field] !== fields[field]) throw new RewardServiceError('INVALID_INPUT', `conflicting merchant ${field}`);
  }
  const limit = input.limit === undefined ? 10 : safeInt(input.limit, 'limit', 1);
  if (limit > 128) throw new RewardServiceError('INVALID_INPUT', 'limit must be 1..128');
  const page = input.page === undefined ? 1 : safeInt(input.page, 'page', 1);
  return {
    merchant, limit, page,
    ...(input.amount === undefined ? {} : { amount: validateMoney(input.amount, 'amount') }),
    ...(input.country === undefined ? {} : { country: requiredString(input.country, 'country') }),
    ...(input.market === undefined ? {} : { market: requiredString(input.market, 'market') }),
    ...(input.channel === undefined ? {} : { channel: requiredString(input.channel, 'channel') }),
    ...(input.paymentMethod === undefined ? {} : { paymentMethod: requiredString(input.paymentMethod, 'paymentMethod') }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: iso(input.occurredAt, 'occurredAt') }),
    ...(input.cardIds === undefined ? {} : { cardIds: list(input.cardIds, 'cardIds')! }),
    ...(input.routeIds === undefined ? {} : { routeIds: list(input.routeIds, 'routeIds')! }),
    ...(input.cursor === undefined ? {} : { cursor: requiredString(input.cursor, 'cursor') }),
    ...(input.resultVersion === undefined ? {} : { resultVersion: requiredString(input.resultVersion, 'resultVersion') }),
    ...(input.fx === undefined ? {} : { fx: validateFxSnapshot(input.fx, 'recommend fx') }),
    ...(input.routeFacts === undefined ? {} : { routeFacts: (() => {
      if (!Array.isArray(input.routeFacts)) throw new RewardServiceError('INVALID_INPUT', 'routeFacts must be an array');
      if (input.routeFacts.length > 128) throw new RewardServiceError('INVALID_INPUT', 'routeFacts must contain at most 128 entries');
      const facts = input.routeFacts.map((entry, index) => { const row = object(entry, `routeFacts[${index}]`); keys(row, ['routeId', 'edgeId', 'fx'], `routeFacts[${index}]`); return { routeId: requiredString(row.routeId, `routeFacts[${index}].routeId`, true), ...(row.edgeId === undefined ? {} : { edgeId: requiredString(row.edgeId, `routeFacts[${index}].edgeId`, true) }), fx: validateFxSnapshot(row.fx, `routeFacts[${index}].fx`) }; });
      const scopes = facts.map((fact) => `${fact.routeId}|${fact.edgeId ?? '*'}`);
      if (new Set(scopes).size !== scopes.length) throw new RewardServiceError('INVALID_INPUT', 'routeFacts contains duplicate route/edge scope');
      return facts;
    })() }),
    ...(input.eligibilityFacts === undefined ? {} : { eligibilityFacts: (() => {
      if (!Array.isArray(input.eligibilityFacts)) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFacts must be an array');
      if (input.eligibilityFacts.length > 128) throw new RewardServiceError('INVALID_INPUT', 'eligibilityFacts must contain at most 128 entries');
      return input.eligibilityFacts.map(validateEligibilityFact);
    })() }),
  };
}

export function validateListTransactionsOptions(value: unknown): ListTransactionsOptions {
  const item = object(value ?? {}, 'list_transactions');
  keys(item, ['startDate', 'endDate', 'timeBasis', 'fundingKind', 'cardId', 'limit', 'page', 'projection'], 'list_transactions');
  let startDate: string | undefined;
  if (item.startDate !== undefined) {
    startDate = iso(item.startDate, 'startDate');
  }
  let endDate: string | undefined;
  if (item.endDate !== undefined) {
    endDate = iso(item.endDate, 'endDate');
  }
  if (startDate && endDate && Date.parse(startDate) > Date.parse(endDate)) {
    throw new RewardServiceError('INVALID_INPUT', 'startDate cannot be after endDate');
  }
  let timeBasis: TransactionTimeBasis = 'occurred_at';
  if (item.timeBasis !== undefined) {
    const tb = requiredString(item.timeBasis, 'timeBasis');
    if (tb === 'occurred_at' || tb === 'occurredAt') timeBasis = 'occurred_at';
    else if (tb === 'recorded_at' || tb === 'recordedAt') timeBasis = 'recorded_at';
    else throw new RewardServiceError('INVALID_INPUT', 'timeBasis is invalid');
  }
  let fundingKind: 'credit_card' | 'account' | 'cash' | undefined;
  if (item.fundingKind !== undefined) {
    const fk = requiredString(item.fundingKind, 'fundingKind');
    if (!['credit_card', 'account', 'cash'].includes(fk)) throw new RewardServiceError('INVALID_INPUT', 'fundingKind is invalid');
    fundingKind = fk as 'credit_card' | 'account' | 'cash';
  }
  const cardId = item.cardId === undefined ? undefined : requiredString(item.cardId, 'cardId', true);
  let limit = 20;
  if (item.limit !== undefined) {
    limit = safeInt(item.limit, 'limit', 1);
    if (limit > 50) throw new RewardServiceError('INVALID_INPUT', 'limit must be 1..50');
  }
  let page = 1;
  if (item.page !== undefined) {
    page = safeInt(item.page, 'page', 1);
  }
  let projection: 'summary' | 'detail' = 'summary';
  if (item.projection !== undefined) {
    const p = requiredString(item.projection, 'projection');
    if (p !== 'summary' && p !== 'detail') throw new RewardServiceError('INVALID_INPUT', 'projection is invalid');
    projection = p;
  }
  return {
    ...(startDate ? { startDate } : {}),
    ...(endDate ? { endDate } : {}),
    timeBasis,
    ...(fundingKind ? { fundingKind } : {}),
    ...(cardId ? { cardId } : {}),
    limit,
    page,
    projection,
  };
}
