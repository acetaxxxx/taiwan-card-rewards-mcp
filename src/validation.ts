import type { CardDescriptor, CapPeriod, EvaluationContext, FxSnapshot, Money, OfferRuleVersion, OfferSourceSnapshot, RuleMatch, TransactionTuple } from './types.js';
import { RewardServiceError } from './errors.js';

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
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

function finiteRate(value: unknown, name: string, min = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > 1_000_000) throw new RewardServiceError('INVALID_INPUT', `${name} must be finite, bounded, and >= ${min}`);
  return value;
}

function list(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 128) throw new RewardServiceError('INVALID_INPUT', `${name} must be an array`);
  return value.map((item) => requiredString(item, `${name} item`, true));
}

export function validateMoney(value: unknown, name: string): Money {
  const item = object(value, name);
  keys(item, ['amountMinor', 'currency'], name);
  return { amountMinor: safeInt(item.amountMinor, `${name}.amountMinor`), currency: requiredString(item.currency, `${name}.currency`, true).toUpperCase() };
}

export function validateCard(value: unknown): CardDescriptor {
  const item = object(value, 'card');
  keys(item, ['id', 'issuer', 'productName', 'network', 'last4', 'country'], 'card');
  const last4 = optionalString(item.last4, 'card.last4');
  if (last4 !== undefined && !/^\d{4}$/.test(last4)) throw new RewardServiceError('INVALID_INPUT', 'card.last4 must contain four digits');
  return { id: requiredString(item.id, 'card.id', true), issuer: requiredString(item.issuer, 'card.issuer'), productName: requiredString(item.productName, 'card.productName'), ...(optionalString(item.network, 'card.network') ? { network: optionalString(item.network, 'card.network') } : {}), ...(last4 ? { last4 } : {}), ...(optionalString(item.country, 'card.country', true) ? { country: optionalString(item.country, 'card.country', true) } : {}) };
}

export function validateSnapshot(value: unknown): OfferSourceSnapshot {
  const item = object(value, 'snapshot');
  keys(item, ['id', 'url', 'fetchedAt', 'contentHash', 'parserVersion', 'validFrom', 'validTo', 'excerpt'], 'snapshot');
  const url = requiredString(item.url, 'snapshot.url');
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== '/' && parsed.pathname !== '') throw new RewardServiceError('INVALID_INPUT', 'snapshot.url must be a public origin URL without credentials');
  const fetchedAt = requiredString(item.fetchedAt, 'snapshot.fetchedAt');
  if (!Number.isFinite(Date.parse(fetchedAt)) || !fetchedAt.includes('T')) throw new RewardServiceError('INVALID_INPUT', 'snapshot.fetchedAt must be an ISO date-time');
  const validFrom = optionalString(item.validFrom, 'snapshot.validFrom');
  const validTo = optionalString(item.validTo, 'snapshot.validTo');
  if (validFrom && (!Number.isFinite(Date.parse(validFrom)) || !validFrom.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validFrom must be an ISO date-time');
  if (validTo && (!Number.isFinite(Date.parse(validTo)) || !validTo.includes('T'))) throw new RewardServiceError('INVALID_INPUT', 'snapshot.validTo must be an ISO date-time');
  return { id: requiredString(item.id, 'snapshot.id', true), url, fetchedAt, contentHash: requiredString(item.contentHash, 'snapshot.contentHash'), parserVersion: requiredString(item.parserVersion, 'snapshot.parserVersion'), ...(validFrom ? { validFrom } : {}), ...(validTo ? { validTo } : {}), ...(item.excerpt === undefined ? {} : { excerpt: requiredString(item.excerpt, 'snapshot.excerpt') }) };
}

function validateMatch(value: unknown): RuleMatch {
  const item = object(value, 'rule.match');
  keys(item, ['merchants', 'mccs', 'countries', 'channels', 'paymentMethods'], 'rule.match');
  return { ...(list(item.merchants, 'rule.match.merchants') ? { merchants: list(item.merchants, 'rule.match.merchants') } : {}), ...(list(item.mccs, 'rule.match.mccs') ? { mccs: list(item.mccs, 'rule.match.mccs') } : {}), ...(list(item.countries, 'rule.match.countries') ? { countries: list(item.countries, 'rule.match.countries') } : {}), ...(list(item.channels, 'rule.match.channels') ? { channels: list(item.channels, 'rule.match.channels') } : {}), ...(list(item.paymentMethods, 'rule.match.paymentMethods') ? { paymentMethods: list(item.paymentMethods, 'rule.match.paymentMethods') } : {}) };
}

export function validateRule(value: unknown): OfferRuleVersion {
  const item = object(value, 'rule');
  keys(item, ['id', 'cardId', 'version', 'sourceSnapshotId', 'status', 'validFrom', 'validTo', 'settlementCurrency', 'match', 'reward', 'cap'], 'rule');
  const status = requiredString(item.status, 'rule.status');
  if (!['active', 'stale', 'needs_review', 'unknown'].includes(status)) throw new RewardServiceError('INVALID_INPUT', 'rule.status is invalid');
  const rewardItem = object(item.reward, 'rule.reward');
  keys(rewardItem, ['kind', 'rateBps', 'amountMinor', 'currency'], 'rule.reward');
  const kind = requiredString(rewardItem.kind, 'rule.reward.kind');
  if (kind !== 'percentage' && kind !== 'flat') throw new RewardServiceError('INVALID_INPUT', 'rule.reward.kind is invalid');
  const reward = kind === 'percentage' ? { kind, rateBps: finiteRate(rewardItem.rateBps, 'rule.reward.rateBps') } : { kind, amountMinor: safeInt(rewardItem.amountMinor, 'rule.reward.amountMinor'), ...(rewardItem.currency === undefined ? {} : { currency: requiredString(rewardItem.currency, 'rule.reward.currency', true).toUpperCase() }) };
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
  return { id: requiredString(item.id, 'rule.id', true), cardId: requiredString(item.cardId, 'rule.cardId', true), version: requiredString(item.version, 'rule.version'), sourceSnapshotId: requiredString(item.sourceSnapshotId, 'rule.sourceSnapshotId', true), status: status as OfferRuleVersion['status'], validFrom, ...(validTo ? { validTo } : {}), settlementCurrency: requiredString(item.settlementCurrency, 'rule.settlementCurrency', true).toUpperCase(), match: validateMatch(item.match), reward, ...(cap ? { cap } : {}) };
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
    keys(fxItem, ['id', 'baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt'], 'transaction.fx');
    fx = { id: requiredString(fxItem.id, 'transaction.fx.id', true), baseCurrency: requiredString(fxItem.baseCurrency, 'transaction.fx.baseCurrency', true).toUpperCase(), quoteCurrency: requiredString(fxItem.quoteCurrency, 'transaction.fx.quoteCurrency', true).toUpperCase(), ratePpm: finiteRate(fxItem.ratePpm, 'transaction.fx.ratePpm', 1), capturedAt: requiredString(fxItem.capturedAt, 'transaction.fx.capturedAt') };
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
  keys(item, ['now', 'usageByKey', 'sourceSnapshots'], 'context');
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
  return { now, ...(Object.keys(usageByKey).length ? { usageByKey } : {}), ...(Object.keys(sourceSnapshots).length ? { sourceSnapshots } : {}) };
}

export function validateToolArgs(name: string, value: unknown): Record<string, unknown> {
  const args = object(value, 'tool arguments');
  const allowed: Record<string, string[]> = { register_card: ['card'], list_cards: [], upsert_offer: ['snapshot', 'rule'], recommend: ['transaction', 'limit'], record_transaction: ['transaction'], remaining_caps: ['cardId'], fetch_public_offer: ['url'], calculate_reward: ['rule', 'transaction', 'context'], rank_cards: ['cards', 'rules', 'transaction', 'context'] };
  if (!allowed[name]) throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  keys(args, allowed[name], `tool ${name}`);
  return args;
}
