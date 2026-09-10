import { RewardServiceError } from './errors.js';
import type { McpToolContract } from './types.js';

/** Instructions surfaced to MCP hosts so the user-facing agent knows the safe workflow. */
export const mcpInstructions = [
  'Use this server for Taiwan card-reward calculations and a single-user durable ledger.',
  'Call recommend directly with the merchant and any known spend facts; it reads registered cards and verified routes itself. Use list_cards only when managing or explicitly restricting cards.',
  'The Agent or UI must obtain and parse bank pages, images, or PDFs before calling this server. Treat user/OCR-derived offers as unverified candidates.',
  'Store candidate offers with upsert_offer. Evidenced offers are usable by default; ask the user only when evidence conflicts or remains ambiguous, and mark a route or offer failed when the user says it is unavailable.',
  'Before storing a merchant-specific offer, call resolve_merchant and put only a confirmed canonical mch_<ULID> in rule.match.merchants. If the merchant is not yet cataloged but official evidence identifies it, pass one strict candidate merchant object in the same upsert_offer call; MCP generates the canonical ID, binds the rule, and persists both atomically. Ask the user on ambiguity, keep unresolved offers and newly onboarded merchants as candidates, and never invent merchant IDs.',
  'Use recommend for planned evaluation against registered cards and routes; use calculate_reward to verify a single rule before persisting it or to show hypothetical math for an unconfirmed candidate offer. Planned calls do not consume caps.',
  'Call recommend directly even when facts may be missing, stale, or conflicting; use consistently evidenced payment routes by default, ask the user only for conflicts or ambiguity, and mark a route failed when the user says it is unavailable. Its candidates cover both direct card charges and multi-hop payment paths in one ranked list. Follow candidate-scoped requiredActions and retry only after obtaining new facts or evidence.',
  'Intent recommendations default to page size 10. Use limit plus 1-based page for normal continuation; legacy cursor/nextCursor remains supported. Keep the same intent and resultVersion; discoveredCount is not a final total until explorationComplete is true.',
  'Use record_transaction with a stable idempotencyKey for actual purchases and linked refunds. Input property names are camelCase as shown in each tool schema; the MCP adapter also accepts equivalent snake_case names. Never send PAN, CVV, OTP, passwords, tokens, or user_id.',
  'Use register_payment_account to onboard a confirmed wallet or linked bank account; store only provider identity and evidence, never account numbers or credentials. Use list_payment_accounts before building payment routes.',
  'For event-scoped rewards, use record_event_reward with exactly one event-local rule or explicit funded_by chain; the server recomputes eligibility for the authenticated user. Use reverse_event_reward with exactly one refund relation. Unknown or needs_review events fail closed.',
  'Treat unknown, stale, and needs_review as fail-closed: ask for missing facts or confirmation; never guess or convert them to zero reward.',
  'For foreign-currency transactions, fetch the current rate yourself and provide it inline as an fx snapshot (rate, capturedAt, provider, rateType); it is trusted directly once it passes the currency-pair and freshness checks. When a period boundary needs timezone, ask the user and provide an explicit IANA timezone; the server never guesses a missing timezone. Use remaining_caps to inspect actual usage and cap balances.',
  'For benefits, use get_user_benefit_status to inspect candidates and upsert_user_benefit_status only after the user confirms a completed action; same-day writes are allowed but return warnings.',
].join(' ');

const closed = (properties: Record<string, unknown>, required: readonly string[] = []): Record<string, unknown> => ({ type: 'object', additionalProperties: false, properties, ...(required.length ? { required } : {}) });
const string = { type: 'string' };
const date = { type: 'string', format: 'date-time' };
const money = closed({ amountMinor: { type: 'integer', minimum: 0 }, currency: string }, ['amountMinor', 'currency']);
const card = closed({ id: string, issuer: string, productName: string, network: string, last4: { type: 'string', pattern: '^\\d{4}$' }, country: string, billingCycleDay: { type: 'integer', minimum: 1, maximum: 31 }, timezone: string }, ['id', 'issuer', 'productName']);
const provenance = closed({ sourceUrl: string, sourceDescription: string, submitter: string, submittedAt: date, contentFingerprint: string }, ['submittedAt', 'contentFingerprint']);
const snapshot = closed({ id: string, url: { type: 'string', format: 'uri' }, fetchedAt: date, contentHash: string, parserVersion: string, validFrom: date, validTo: date, excerpt: string, verified: { type: 'boolean' }, sourceType: { type: 'string', enum: ['official', 'user_input'] }, provenance }, ['id', 'url', 'fetchedAt', 'contentHash', 'parserVersion']);
const match = closed({ merchants: { type: 'array', items: string, maxItems: 128 }, mccs: { type: 'array', items: string, maxItems: 128 }, countries: { type: 'array', items: string, maxItems: 128 }, channels: { type: 'array', items: string, maxItems: 128 }, paymentMethods: { type: 'array', items: string, maxItems: 128 } });
const reward = closed({ kind: string, code: string, rateBps: { type: 'number', minimum: 0, maximum: 1_000_000_000_000 }, amountMinor: { type: 'integer', minimum: 0 }, currency: string, roundingMode: { type: 'string', enum: ['floor', 'ceil', 'half_up', 'nearest'] }, roundingScope: { type: 'string', enum: ['per_transaction', 'per_period'] }, unitAmountMinor: { type: 'integer', minimum: 0 }, unitRewardMinor: { type: 'integer', minimum: 0 }, stepAmountMinor: { type: 'integer', minimum: 0 }, stepRewardMinor: { type: 'integer', minimum: 0 } }, ['kind']);
const predicate: Record<string, unknown> = closed({ op: { type: 'string', enum: ['AND', 'OR', 'NOT', 'EQUALS', 'MATCH_ALLOWLIST'] }, field: string, value: {}, rules: { type: 'array', items: { type: 'object', additionalProperties: false }, maxItems: 64 }, rule: { type: 'object', additionalProperties: false } }, ['op']);
const recommendationEventRule = closed({ id: string, version: string, eventKind: { type: 'string', enum: ['top_up', 'purchase', 'refund', 'reversal', 'reward_issuance', 'reward_redemption'] }, fundingKind: { type: 'string', enum: ['credit_card', 'account', 'cash'] }, fundingSubtype: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] }, channel: string, paymentMethod: string }, ['id', 'version', 'eventKind']);
const recommendationEventChainRule = closed({ id: string, version: string, relation: { const: 'funded_by' }, windowSeconds: { type: 'integer', minimum: 1, maximum: 2678400 }, sourceRule: recommendationEventRule, targetRule: recommendationEventRule }, ['id', 'version', 'relation', 'windowSeconds', 'sourceRule', 'targetRule']);
const rule = closed({ id: string, cardId: string, routeId: string, version: string, sourceSnapshotId: string, status: { type: 'string', enum: ['candidate', 'active', 'stale', 'superseded', 'needs_review', 'unknown'] }, validFrom: date, validTo: date, settlementCurrency: string, match, predicate, requires: { type: 'array', items: { type: 'string', enum: ['source_verified', 'user_confirmation'] } }, reward, capPoolRefs: { type: 'array', items: string, maxItems: 128 }, confirmation: closed({ confirmedAt: date, confirmedBy: string, sourceReference: string, offerPeriod: closed({ validFrom: date, validTo: date }, ['validFrom']), rewardUnit: string, rewardConditionsSummary: string, capSummary: string }, ['confirmedAt', 'confirmedBy', 'sourceReference', 'offerPeriod', 'rewardUnit']), componentKind: { type: 'string', enum: ['merchant_loyalty', 'payment_provider', 'card_issuer'] }, sponsor: string, benefitGroup: string, useSettlementAmount: { type: 'boolean' }, stacking: { type: 'string', enum: ['confirmed', 'possible'] }, combination: closed({ mode: string, groupId: string, version: string, priority: { type: 'integer' }, prerequisiteRuleIds: { type: 'array', items: string } }, ['mode', 'groupId', 'version']), eventRule: recommendationEventRule, eventChainRule: recommendationEventChainRule }, ['id', 'version', 'sourceSnapshotId', 'status', 'validFrom', 'settlementCurrency', 'match', 'reward']);
const fx = closed({ id: string, baseCurrency: string, quoteCurrency: string, ratePpm: { type: 'integer', minimum: 1 }, capturedAt: date, maxAgeSeconds: { type: 'integer', minimum: 1 }, provider: string, rateType: { type: 'string', enum: ['cash_selling', 'spot_selling', 'mid_market', 'card_scheme'] }, sourceUrl: { type: 'string', format: 'uri' }, contentHash: string, cardIdScope: string, issuerScope: string }, ['id', 'baseCurrency', 'quoteCurrency', 'ratePpm', 'capturedAt', 'provider', 'rateType']);
const route = closed({ kind: { type: 'string', enum: ['direct_card', 'wallet', 'merchant_app'] }, providerId: string, appId: string, displayName: string }, ['kind']);
const routeContext = closed({ merchantId: string, acceptanceProviderId: string, consumerAppId: string, walletProviderId: string, interoperabilitySchemeId: string, paymentMethod: string, intermediateProviderId: string, cardNetwork: string, issuer: string, fundingSource: string, fundingSubtype: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] }, transactionCurrency: string, settlementCurrency: string, billingCurrency: string, conversionOwner: { type: 'string', enum: ['merchant', 'wallet', 'payment_provider', 'card_network', 'issuer', 'bank', 'acquirer', 'unknown'] }, rateType: { type: 'string', enum: ['cash_selling', 'spot_selling', 'mid_market', 'card_scheme'] }, conversionTiming: { type: 'string', enum: ['transaction', 'clearing', 'settlement', 'posting'] }, foreignTransactionFee: money, markup: money, serviceFee: money, dcc: { type: 'boolean' } }, ['transactionCurrency']);
const paymentRouteNode = closed({ id: string, kind: { type: 'string', enum: ['funding_source', 'wallet_balance', 'payment_service', 'acceptance_network', 'merchant'] }, displayName: string }, ['id', 'kind', 'displayName']);
const paymentRouteEdge = closed({ edgeId: string, fromNodeId: string, toNodeId: string, transition: { type: 'string', enum: ['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'] }, evidenceIds: { type: 'array', items: string, maxItems: 64 }, provenance: { type: 'string', enum: ['official', 'model_fixture'] }, direction: { type: 'string', enum: ['inbound', 'outbound'] }, fromMarket: string, toMarket: string, market: string, currency: string, validFrom: date, validTo: date, fee: money, markup: money, foreignTransactionFee: money, fx, dcc: closed({ selected: { type: 'boolean' }, fee: money }, ['selected']) }, ['edgeId', 'fromNodeId', 'toNodeId', 'transition', 'evidenceIds']);
const paymentRoute = closed({ id: string, status: { type: 'string', enum: ['candidate', 'active', 'stale', 'conflict', 'needs_review', 'failed'] }, layers: { type: 'array', items: closed({ kind: { type: 'string', enum: ['merchant_loyalty', 'merchant_acceptance', 'consumer_app', 'payment_provider', 'wallet', 'interoperability_scheme', 'intermediate_provider', 'card_network', 'card_issuer'] }, providerId: string, appId: string, paymentMethod: string, displayName: string, evidenceIds: { type: 'array', items: string, maxItems: 32 } }) }, funding: closed({ kind: { type: 'string', enum: ['credit_card', 'account', 'cash'] }, cardId: string, accountId: string, subtype: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] } }, ['kind']), sourceUrl: string, sourceSnapshotId: string, contentHash: string, observedAt: date, validFrom: date, validTo: date, authority: { type: 'string', enum: ['issuer', 'network', 'wallet', 'merchant', 'secondary', 'community', 'user'] }, confidence: { type: 'string', enum: ['high', 'medium', 'low'] }, confirmation: closed({ confirmedAt: date, confirmedBy: string }, ['confirmedAt', 'confirmedBy']), failure: closed({ failedAt: date, failedBy: string, reason: string }, ['failedAt', 'failedBy', 'reason']), evidenceIds: { type: 'array', items: string, maxItems: 64 }, nodes: { type: 'array', items: paymentRouteNode, maxItems: 128 }, edges: { type: 'array', items: paymentRouteEdge, maxItems: 256 }, idempotencyKey: string }, ['layers', 'funding', 'observedAt', 'idempotencyKey']);
const paymentCapability = closed({ id: string, status: { type: 'string', enum: ['candidate', 'active', 'stale', 'conflict', 'needs_review'] }, providerId: string, acceptanceProviderId: string, consumerAppId: string, merchant: string, market: string, channel: string, fundingKinds: { type: 'array', items: { type: 'string', enum: ['credit_card', 'account', 'cash'] }, minItems: 1, maxItems: 3 }, transitions: { type: 'array', items: { type: 'string', enum: ['card_authorization', 'account_debit', 'wallet_top_up', 'wallet_debit', 'service_to_acceptance', 'merchant_settlement', 'direct_settlement', 'split_tender'] }, minItems: 1 }, sourceUrl: string, evidenceIds: { type: 'array', items: string, minItems: 1, maxItems: 64 }, observedAt: date, validFrom: date, validTo: date, idempotencyKey: string }, ['providerId', 'fundingKinds', 'transitions', 'evidenceIds', 'observedAt', 'idempotencyKey']);
const paymentAccount = closed({ id: string, providerId: string, kind: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] }, displayName: string, status: { type: 'string', enum: ['candidate', 'active', 'stale', 'needs_review'] }, observedAt: date, sourceUrl: string, sourceSnapshotId: string, evidenceIds: { type: 'array', items: string, maxItems: 64 }, confirmation: closed({ confirmedAt: date, confirmedBy: string }, ['confirmedAt', 'confirmedBy']), idempotencyKey: string }, ['providerId', 'kind', 'displayName', 'observedAt', 'idempotencyKey']);
const merchantIdentity = closed({ canonicalId: string, canonicalNameZhHant: string, canonicalNameLocale: { const: 'zh-Hant-TW' }, officialAliases: { type: 'array', items: { type: 'string', maxLength: 512 }, maxItems: 128 }, operatingMarkets: { type: 'array', items: string, maxItems: 64 }, mccs: { type: 'array', items: string, maxItems: 64 }, channels: { type: 'array', items: { type: 'string', enum: ['in_store', 'online'] }, maxItems: 2 }, status: { type: 'string', enum: ['candidate'] }, supersededBy: string, provenance: closed({ sourceSnapshotId: string, sourceUrl: string, version: string, updatedAt: date, notes: string }, ['version', 'updatedAt']) }, ['canonicalNameZhHant', 'canonicalNameLocale', 'provenance']);
const transaction = closed({ idempotencyKey: string, routeId: string, cardId: string, kind: { type: 'string', enum: ['purchase', 'refund'] }, mode: { type: 'string', enum: ['planned', 'actual'] }, merchant: string, mcc: string, country: string, channel: string, paymentMethod: string, occurredAt: date, amount: money, fx, refundOfId: string, originalRewardMinor: { type: 'integer', minimum: 0 }, route, routeContext, settlementAmount: money }, ['cardId', 'kind', 'mode', 'occurredAt', 'amount']);
const paymentEvent = closed({ id: string, kind: { type: 'string', enum: ['top_up', 'purchase', 'refund', 'reversal', 'reward_issuance', 'reward_redemption'] }, amount: money, occurredAt: date, funding: closed({ kind: { type: 'string', enum: ['credit_card', 'account', 'cash'] }, cardId: string, accountId: string, subtype: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] } }, ['kind']), cardId: string, routeId: string, channel: string, paymentMethod: string, relations: closed({ funded_by: { type: 'array', items: string, maxItems: 16 }, caused_by: { type: 'array', items: string, maxItems: 16 }, refunds: { type: 'array', items: string, maxItems: 16 } }), fx }, ['id', 'kind', 'amount', 'occurredAt', 'funding']);
const eventRewardCandidate = closed({ eventId: string, ruleId: string, ruleVersion: string, evidenceId: string, sponsor: string, benefitGroup: string, reward, combination: closed({ mode: string, groupId: string, version: string, priority: { type: 'integer', minimum: 0 } }, ['mode', 'groupId', 'version']), capPoolId: string, eligibility: closed({ status: { type: 'string', enum: ['matched', 'no_match', 'unknown'] }, reasons: { type: 'array', items: string, maxItems: 32 } }, ['status']) }, ['eventId', 'ruleId', 'ruleVersion', 'evidenceId', 'sponsor', 'benefitGroup', 'eligibility']);
const eventRule = closed({ id: string, version: string, eventKind: { type: 'string', enum: ['top_up', 'purchase', 'refund', 'reversal', 'reward_issuance', 'reward_redemption'] }, fundingKind: { type: 'string', enum: ['credit_card', 'account', 'cash'] }, fundingSubtype: { type: 'string', enum: ['linked_bank_account', 'wallet_balance', 'foreign_currency_account'] }, channel: string, paymentMethod: string }, ['id', 'version', 'eventKind']);
const eventChainRule = closed({ id: string, version: string, relation: { const: 'funded_by' }, windowSeconds: { type: 'integer', minimum: 1, maximum: 2678400 }, sourceRule: eventRule, targetRule: eventRule }, ['id', 'version', 'relation', 'windowSeconds', 'sourceRule', 'targetRule']);
const eventCandidateCombination = closed({ mode: string, groupId: string, version: string, priority: { type: 'integer' } }, ['mode', 'groupId', 'version']);
const eventCandidateEligibility = closed({ status: { type: 'string', enum: ['matched', 'no_match', 'unknown'] }, reasons: { type: 'array', items: string, maxItems: 32 } }, ['status']);
const validatedEventRewardCandidate = closed({ eventId: string, ruleId: string, ruleVersion: string, evidenceId: string, sponsor: string, benefitGroup: string, reward, combination: eventCandidateCombination, capPoolId: string, eligibility: eventCandidateEligibility }, ['eventId', 'ruleId', 'ruleVersion', 'evidenceId', 'sponsor', 'benefitGroup', 'eligibility']);
const validatedEventRewardV2Schema = { ...closed({ event: paymentEvent, sourceEvents: { type: 'array', items: paymentEvent, maxItems: 16 }, rule: eventRule, chainRule: eventChainRule, candidate: validatedEventRewardCandidate, idempotencyKey: string }, ['event', 'candidate', 'idempotencyKey']), oneOf: [{ required: ['rule'], not: { required: ['chainRule'] } }, { required: ['chainRule', 'sourceEvents'], not: { required: ['rule'] } }] };
const eligibilityFact = closed({ id: string, evidenceId: string, version: string, cardId: string, factKey: string, value: { oneOf: [string, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: string }] }, validFrom: date, validTo: date }, ['factKey', 'value']);
const recommendationIntent = closed({ merchant: { oneOf: [string, closed({ canonicalId: string, canonicalNameZhHant: string, rawStatement: string, name: string, market: string, country: string })] }, amount: money, fx, routeFacts: { type: 'array', items: closed({ routeId: string, edgeId: string, fx }, ['routeId', 'fx']), maxItems: 128 }, eligibilityFacts: { type: 'array', items: eligibilityFact, maxItems: 128 }, country: string, market: string, channel: string, paymentMethod: string, occurredAt: date, cardIds: { type: 'array', items: string, maxItems: 128 }, routeIds: { type: 'array', items: string, maxItems: 128 }, limit: { type: 'integer', minimum: 1, maximum: 128 }, page: { type: 'integer', minimum: 1 }, cursor: string, resultVersion: string }, ['merchant']);
const heldCard = closed({ id: string, cardProductId: string, alias: string, billingCycleDay: { type: 'integer', minimum: 1, maximum: 31 }, timezone: string, plan: string, status: { type: 'string', enum: ['active', 'inactive'] } }, ['id', 'cardProductId']);
const userFacts = { type: 'object', additionalProperties: false, patternProperties: { '^(user\\.)?[A-Za-z][A-Za-z0-9_.]{0,127}$': { oneOf: [string, { type: 'number' }, { type: 'boolean' }, { type: 'array', items: string }] } } };
const capPool = closed({ id: string, name: string, metric: { type: 'string', enum: ['spend', 'reward', 'transaction_count'] }, period: { type: 'string', enum: ['calendar_month', 'billing_cycle', 'quarter', 'year', 'campaign'] }, limit: { type: 'integer', minimum: 0 }, currency: string, timezone: string }, ['id', 'metric', 'period', 'limit']);
const context = closed({ now: date, usageByKey: { type: 'object', additionalProperties: false, patternProperties: { '^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$': money } }, sourceSnapshots: { type: 'object', additionalProperties: false, patternProperties: { '^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$': snapshot } }, capPools: { type: 'array', items: capPool }, userConfirmed: { type: 'boolean' }, heldCards: { type: 'array', items: heldCard }, eligibilityFacts: { type: 'array', items: eligibilityFact }, userFacts, paymentEvents: closed({ target: paymentEvent, sourceEvents: { type: 'array', items: paymentEvent, maxItems: 16 } }, ['target', 'sourceEvents']) });
const page = { limit: { type: 'integer', minimum: 1, maximum: 20 }, page: { type: 'integer', minimum: 1 } };
const listPage = { limit: { type: 'integer', minimum: 1, maximum: 50 }, page: { type: 'integer', minimum: 1 } };
const projection = { projection: { type: 'string', enum: ['summary', 'detail', 'calculation', 'audit'] } };

export const mcpTools: readonly McpToolContract[] = [
  { name: 'calculate_reward', description: 'Evaluate supplied offer rules for one planned or actual transaction; no persistence.', readOnly: true, inputSchema: closed({ rule, transaction, context }, ['rule', 'transaction', 'context']), failClosedErrors: ['INSUFFICIENT_FACTS', 'SOURCE_UNAVAILABLE', 'NEEDS_REVIEW', 'STALE'] },
  { name: 'register_card', description: 'Register or replace a card descriptor.', readOnly: false, inputSchema: closed({ card }, ['card']), failClosedErrors: ['STORE_UNAVAILABLE'] },
  { name: 'list_cards', description: 'List registered card descriptors as a bounded projection.', readOnly: true, inputSchema: closed({ ...listPage, ...projection }), failClosedErrors: ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'STORE_UNAVAILABLE'] },
  { name: 'upsert_offer', description: 'Store a public offer source snapshot and versioned rule, optionally atomically onboarding one candidate merchant and confirming candidate rules.', readOnly: false, inputSchema: closed({ snapshot, rule, merchant: merchantIdentity, confirmation: rule.properties && (rule.properties as Record<string, unknown>).confirmation, capPools: { type: 'array', items: capPool } }, ['snapshot', 'rule']), failClosedErrors: ['INVALID_OFFER', 'INVALID_CONFIRMATION', 'STORE_UNAVAILABLE'] },
  { name: 'recommend', description: 'Return bounded merchant-first recommendations across registered cards and verified payment paths in one unified, ranked candidate list.', readOnly: true, inputSchema: recommendationIntent, failClosedErrors: ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'INSUFFICIENT_FACTS', 'NEEDS_REVIEW', 'STALE'] },
  { name: 'upsert_payment_route', description: 'Register a payment route with an MCP-owned identity; routes are usable by default once the agent supplies self-asserted evidence, and a user denial marks the existing route failed; never stores credentials.', readOnly: false, inputSchema: closed({ route: paymentRoute }, ['route']), failClosedErrors: ['INVALID_INPUT', 'IDEMPOTENCY_CONFLICT', 'SENSITIVE_FIELD_FORBIDDEN'] },
  { name: 'upsert_payment_capability', description: 'Store a public payment capability separately from user-owned routes and accounts; usable by default once the agent supplies self-asserted evidence.', readOnly: false, inputSchema: closed({ capability: paymentCapability }, ['capability']), failClosedErrors: ['UNAUTHENTICATED', 'NEEDS_REVIEW', 'IDEMPOTENCY_CONFLICT', 'STORE_UNAVAILABLE'] },
  { name: 'list_payment_capabilities', description: 'List evidence-backed public payment capabilities available for planned route generation.', readOnly: true, inputSchema: closed({}), failClosedErrors: ['UNAUTHENTICATED', 'STORE_UNAVAILABLE'] },
  { name: 'list_payment_routes', description: 'List routes registered for the current user; returns bounded typed route projections.', readOnly: true, inputSchema: closed({ ...listPage, ...projection }), failClosedErrors: ['INVALID_INPUT', 'STORE_UNAVAILABLE'] },
  { name: 'register_payment_account', description: 'Onboard a wallet or linked bank account identity with evidence; never stores credentials or account numbers.', readOnly: false, inputSchema: closed({ account: paymentAccount }, ['account']), failClosedErrors: ['INVALID_INPUT', 'INVALID_CONFIRMATION', 'IDEMPOTENCY_CONFLICT', 'SENSITIVE_FIELD_FORBIDDEN', 'STORE_UNAVAILABLE'] },
  { name: 'list_payment_accounts', description: 'List user-scoped payment account identities available for explicit payment-route construction.', readOnly: true, inputSchema: closed({ ...listPage, ...projection }), failClosedErrors: ['INVALID_INPUT', 'STORE_UNAVAILABLE'] },
  { name: 'record_transaction', description: 'Record an actual purchase or linked refund and update durable usage.', readOnly: false, inputSchema: closed({ transaction }, ['transaction']), failClosedErrors: ['IDEMPOTENCY_CONFLICT', 'INVALID_REFUND', 'INSUFFICIENT_FACTS', 'NEEDS_REVIEW', 'fx_missing'] },
  { name: 'record_event_reward', description: 'Recompute event-local or explicitly funded_by chain eligibility server-side before recording an event reward.', readOnly: false, inputSchema: validatedEventRewardV2Schema, failClosedErrors: ['UNAUTHENTICATED', 'NO_MATCH', 'INSUFFICIENT_FACTS', 'NEEDS_REVIEW', 'IDEMPOTENCY_CONFLICT', 'STORE_UNAVAILABLE', 'fx_missing'] },
  { name: 'reverse_event_reward', description: 'Reverse one durable event reward using exactly one explicit refund relation; proportional and idempotent.', readOnly: false, inputSchema: closed({ event: paymentEvent, idempotencyKey: string }, ['event', 'idempotencyKey']), failClosedErrors: ['UNAUTHENTICATED', 'INVALID_REFUND_RELATION', 'ORIGINAL_REWARD_NOT_FOUND', 'OVER_REFUND', 'IDEMPOTENCY_CONFLICT', 'STORE_UNAVAILABLE'] },
  { name: 'remaining_caps', description: 'Report bounded remaining reward cap projections derived from actual transactions.', readOnly: true, inputSchema: closed({ cardId: string, asOf: date, ...page, ...projection }, ['cardId']), failClosedErrors: ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'STORE_UNAVAILABLE'] },
  { name: 'get_user_benefit_status', description: 'Inspect a user benefit status and separate available-now from action-required candidates.', readOnly: true, inputSchema: closed({ kind: { type: 'string', enum: ['card_switch', 'campaign_registration'] }, cardId: string, asOfUtc: date, projection: { type: 'string', enum: ['summary', 'detail'] } }, ['kind', 'cardId']), failClosedErrors: ['CARD_NOT_FOUND', 'STORE_UNAVAILABLE'] },
  { name: 'upsert_user_benefit_status', description: 'Record or correct a user-confirmed completed card switch or campaign registration.', readOnly: false, inputSchema: closed({ input: closed({ kind: { type: 'string', enum: ['card_switch', 'campaign_registration'] }, action: { type: 'string', enum: ['record', 'adjust'] }, cardId: string, campaignId: string, timezone: string, completedAt: date, effectiveFrom: date, effectiveTo: date, benefit: string, sourceUrl: string, sourceSnapshotAt: date, ruleVersion: string, confirmation: closed({ confirmedBy: string, confirmedAtUtc: date, completed: { type: 'boolean' } }, ['confirmedBy', 'confirmedAtUtc', 'completed']), idempotencyKey: string, adjustmentReason: string }, ['kind', 'action', 'cardId', 'timezone', 'completedAt', 'effectiveFrom', 'benefit', 'sourceUrl', 'sourceSnapshotAt', 'ruleVersion', 'confirmation', 'idempotencyKey']) }, ['input']), failClosedErrors: ['CARD_NOT_FOUND', 'IDEMPOTENCY_CONFLICT', 'INVALID_CONFIRMATION', 'STORE_UNAVAILABLE'] },
  { name: 'resolve_merchant', description: 'Resolve an exact canonical merchant identity using bounded deterministic matching; never applies aliases or fuzzy matches.', readOnly: true, inputSchema: closed({ rawQuery: { type: 'string', minLength: 1, maxLength: 128 }, country: string, market: string, mcc: string, channel: string }, ['rawQuery']), failClosedErrors: ['INVALID_INPUT', 'INSUFFICIENT_FACTS'] },
  { name: 'search_active_offers', description: 'Search active, verified, in-window offers with bounded 1-based pagination; read-only and never activates rules.', readOnly: true, inputSchema: closed({ rawQuery: { type: 'string', maxLength: 128 }, cardId: string, canonicalMerchantId: string, country: string, market: string, mcc: string, channel: string, asOf: date, ...page, projection: { type: 'string', enum: ['summary', 'detail'] } }), failClosedErrors: ['INVALID_INPUT', 'PAYLOAD_TOO_LARGE', 'INSUFFICIENT_FACTS'] },
];

type JsonSchema = Record<string, unknown>;

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

function camelCase(name: string): string {
  return name.replace(/_([a-zA-Z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

function schemaBranches(schema: unknown): JsonSchema[] {
  if (!isObject(schema)) return [];
  const branches = [schema];
  for (const keyword of ['allOf', 'oneOf', 'anyOf'] as const) {
    const values = schema[keyword];
    if (Array.isArray(values)) branches.push(...values.flatMap(schemaBranches));
  }
  return branches;
}

/**
 * Converts snake_case property spellings in closed schema objects. Dynamic map
 * keys stay untouched; their values still recurse into their declared schemas.
 * This preserves user-provided identifiers while accepting snake_case and
 * camelCase, without making unknown fields valid.
 */
function normalizeSchemaValue(value: unknown, schemas: readonly JsonSchema[], path: string): unknown {
  if (Array.isArray(value)) {
    const itemSchemas = schemas.flatMap((schema) => isObject(schema.items) ? schemaBranches(schema.items) : []);
    return value.map((item, index) => normalizeSchemaValue(item, itemSchemas, `${path}[${index}]`));
  }
  if (!isObject(value)) return value;

  const properties = new Map<string, JsonSchema[]>();
  const aliases = new Map<string, string>();
  const patternProperties: Array<[RegExp, JsonSchema[]]> = [];
  for (const schema of schemas.flatMap(schemaBranches)) {
    if (isObject(schema.properties)) for (const [name, child] of Object.entries(schema.properties)) {
      const children = isObject(child) ? schemaBranches(child) : [];
      properties.set(name, [...(properties.get(name) ?? []), ...children]);
      aliases.set(snakeCase(name), name);
    }
    if (isObject(schema.patternProperties)) for (const [pattern, child] of Object.entries(schema.patternProperties)) {
      if (isObject(child)) patternProperties.push([new RegExp(pattern), schemaBranches(child)]);
    }
  }

  const normalized: Record<string, unknown> = {};
  for (const [rawName, rawValue] of Object.entries(value)) {
    const matchedPatterns = patternProperties.filter(([pattern]) => pattern.test(rawName));
    // Public schemas are closed objects. Normalize any snake_case spelling in
    // those envelopes before validation, including fields that validation will
    // subsequently reject (for example an unexposed owner_user field). Keys in
    // declared dynamic maps are identifiers rather than property names.
    const name = aliases.get(rawName) ?? (properties.size > 0 && matchedPatterns.length === 0 ? camelCase(rawName) : rawName);
    if (name !== rawName && Object.prototype.hasOwnProperty.call(value, name)) {
      throw new RewardServiceError('INVALID_INPUT', `${path} must not contain both ${rawName} and ${name}`);
    }
    if (Object.prototype.hasOwnProperty.call(normalized, name)) throw new RewardServiceError('INVALID_INPUT', `${path} contains duplicate property ${name}`);
    const childSchemas = properties.get(name) ?? matchedPatterns.flatMap(([, children]) => children);
    normalized[name] = normalizeSchemaValue(rawValue, childSchemas, `${path}.${name}`);
  }
  return normalized;
}

/** Normalizes MCP arguments to the validators' camelCase model. */
export function normalizeMcpToolArguments(name: string, value: unknown): unknown {
  const tool = mcpTools.find((candidate) => candidate.name === name);
  return tool ? normalizeSchemaValue(value, schemaBranches(tool.inputSchema), `tool ${name}`) : value;
}

export const failClosedErrors = {
  UNAUTHENTICATED: 'A trusted Aion user context is missing or invalid.',
  INSUFFICIENT_FACTS: 'A required timezone or transaction condition is unknown; ask the user.',
  SOURCE_UNAVAILABLE: 'The source could not be fetched or parsed safely.',
  NEEDS_REVIEW: 'The rule is stale, conflicting, or not human-approved.',
  STATE_NOT_SUPPORTED: 'This operation is not supported by the current persistence mode.',
  STALE: 'The offer source or rule is expired and must be refreshed.',
  STORE_UNAVAILABLE: 'The tenant-bound durable store could not be read or written.',
  fx_missing: 'A foreign-currency transaction or event requires an active FX rate observation with provenance.',
} as const;
