import type { PageInfo } from './projections.js';

export type Currency = string;
export type FxRateType = 'cash_selling' | 'spot_selling' | 'mid_market' | 'card_scheme';
export type EvaluationStatus = 'ok' | 'no_match' | 'unknown' | 'needs_review' | 'stale';
export type TransactionKind = 'purchase' | 'refund';
export type TransactionMode = 'planned' | 'actual';
export type PaymentRouteKind = 'direct_card' | 'wallet' | 'merchant_app';
export type ConversionOwner = 'merchant' | 'wallet' | 'payment_provider' | 'card_network' | 'issuer' | 'bank' | 'acquirer' | 'card_scheme' | 'merchant_dcc' | 'unknown';
export type ConversionTiming = 'transaction' | 'clearing' | 'settlement' | 'posting';
export interface PaymentRoute { kind: PaymentRouteKind; providerId?: string | undefined; appId?: string | undefined; displayName?: string | undefined; }
export interface PaymentRouteContext {
  merchantId?: string; acceptanceProviderId?: string; consumerAppId?: string; walletProviderId?: string; interoperabilitySchemeId?: string; paymentMethod?: string; intermediateProviderId?: string; cardNetwork?: string; issuer?: string; fundingSource?: string; fundingSubtype?: 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account';
  transactionCurrency: Currency; settlementCurrency?: Currency; billingCurrency?: Currency; conversionOwner?: ConversionOwner; rateType?: FxRateType; conversionTiming?: ConversionTiming;
  foreignTransactionFee?: Money; markup?: Money; serviceFee?: Money; dcc?: boolean;
}
export type PaymentEventKind = 'top_up' | 'purchase' | 'refund' | 'reversal' | 'reward_issuance' | 'reward_redemption';
export type PaymentEventFunding = { kind: 'credit_card'; cardId?: string } | { kind: 'account'; subtype: 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account'; accountId?: string } | { kind: 'cash' };
export interface PaymentEventRelations { funded_by?: readonly string[]; caused_by?: readonly string[]; refunds?: readonly string[]; }
export interface PaymentEvent { id: string; kind: PaymentEventKind; amount: Money; occurredAt: string; funding: PaymentEventFunding; cardId?: string; routeId?: string; channel?: string; paymentMethod?: string; relations?: PaymentEventRelations; fx?: FxSnapshot | undefined; }
export interface PaymentEventRule { id: string; version: string; eventKind: PaymentEventKind; fundingKind?: PaymentEventFunding['kind']; fundingSubtype?: Extract<PaymentEventFunding, { kind: 'account' }>['subtype']; channel?: string; paymentMethod?: string; }
export interface PaymentEventMatch { status: 'matched' | 'no_match' | 'unknown'; reasons: readonly string[]; }
export interface PaymentEventChainRule { id: string; version: string; relation: 'funded_by'; windowSeconds: number; sourceRule: PaymentEventRule; targetRule: PaymentEventRule; }
export interface PaymentEventRewardCandidate { eventId: string; ruleId: string; ruleVersion: string; evidenceId: string; sponsor: string; benefitGroup: string; reward?: RewardSpec; combination?: RewardCombinationPolicy; capPoolId?: string; }
export interface PaymentEventRewardCandidateInput extends PaymentEventRewardCandidate { eligibility: PaymentEventMatch; }
export interface PaymentEventRewardDecision { status: 'matched' | 'no_match' | 'needs_review'; candidates: readonly PaymentEventRewardCandidate[]; reasons: readonly string[]; }
export interface EventRewardLedgerRecord { idempotencyKey: string; ownerUser: string; eventId: string; eventAmount: Money; ruleId: string; ruleVersion: string; evidenceId: string; sponsor: string; benefitGroup: string; reward: Money; rewardSpecFingerprint: string; capUsage?: { poolId: string; periodKey: string; consumedAmount: number }; appliedFx?: AppliedFxRate | undefined; }
export interface EventRewardReversalRecord { idempotencyKey: string; ownerUser: string; eventId: string; originalEventId: string; refundedAmount: Money; ruleId: string; ruleVersion: string; evidenceId: string; sponsor: string; benefitGroup: string; reward: Money; capUsage?: { poolId: string; periodKey: string; consumedAmount: number }; }
export interface EventRewardCapUsageRecord { ownerUser: string; poolId: string; periodKey: string; consumedAmount: number; }
export type PaymentRouteLayerKind = 'merchant_loyalty' | 'merchant_acceptance' | 'consumer_app' | 'payment_provider' | 'wallet' | 'interoperability_scheme' | 'intermediate_provider' | 'card_network' | 'card_issuer';
export interface PaymentRouteLayer { kind: PaymentRouteLayerKind; providerId?: string; appId?: string; paymentMethod?: string; displayName?: string; evidenceIds?: readonly string[]; }
export type FundingInstrument =
  | { kind: 'credit_card'; cardId?: string }
  | { kind: 'account'; subtype: 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account'; accountId?: string }
  | { kind: 'cash' };
export interface PaymentRouteRecord {
  id: string;
  status: 'candidate' | 'active' | 'stale' | 'conflict' | 'needs_review' | 'failed';
  layers: readonly PaymentRouteLayer[];
  funding: FundingInstrument;
  sourceUrl?: string;
  sourceSnapshotId?: string;
  contentHash?: string;
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  authority?: EvidenceAuthority;
  confidence?: 'high' | 'medium' | 'low';
  confirmation?: { confirmedAt: string; confirmedBy: string };
  failure?: { failedAt: string; failedBy: string; reason: string };
  evidenceIds?: readonly string[];
  idempotencyKey: string;
  ownerUser?: string;
  nodes?: readonly PaymentPathNode[];
  edges?: readonly PaymentPathEdge[];
}
export interface PaymentCapabilityRecord {
  id: string;
  status: 'candidate' | 'active' | 'stale' | 'conflict' | 'needs_review';
  providerId: string;
  acceptanceProviderId?: string;
  consumerAppId?: string;
  merchant?: string;
  market?: string;
  channel?: string;
  fundingKinds: readonly ('credit_card' | 'account' | 'cash')[];
  transitions: readonly PaymentPathTransition[];
  sourceUrl?: string;
  evidenceIds: readonly string[];
  observedAt: string;
  validFrom?: string;
  validTo?: string;
  idempotencyKey: string;
  ownerUser?: string;
}
export type PaymentPathNodeRole = 'funding_source' | 'wallet_balance' | 'payment_service' | 'acceptance_network' | 'merchant';
export type PaymentPathTransition = 'card_authorization' | 'account_debit' | 'wallet_top_up' | 'wallet_debit' | 'service_to_acceptance' | 'merchant_settlement' | 'direct_settlement' | 'split_tender';
export interface PaymentPathEdge { edgeId: string; fromNodeId: string; toNodeId: string; transition: PaymentPathTransition; evidenceIds: readonly string[]; provenance?: 'official' | 'model_fixture'; direction?: 'inbound' | 'outbound'; fromMarket?: string; toMarket?: string; market?: string; currency?: string; validFrom?: string; validTo?: string; fee?: Money; markup?: Money; foreignTransactionFee?: Money; fx?: FxSnapshot; dcc?: { selected: boolean; fee?: Money }; }
export type PaymentAccountKind = 'linked_bank_account' | 'wallet_balance' | 'foreign_currency_account';
export interface PaymentAccountRecord {
  id: string;
  providerId: string;
  kind: PaymentAccountKind;
  displayName: string;
  status: 'candidate' | 'active' | 'stale' | 'needs_review';
  observedAt: string;
  sourceUrl?: string;
  sourceSnapshotId?: string;
  evidenceIds?: readonly string[];
  confirmation?: { confirmedAt: string; confirmedBy: string };
  idempotencyKey: string;
  ownerUser?: string;
  balance?: Money;
}
export type StackingConfidence = 'confirmed' | 'possible';
export type RewardComponentKind = 'merchant_loyalty' | 'payment_provider' | 'card_issuer';
export interface RewardComponent {
  kind: RewardComponentKind;
  ruleId: string;
  ruleVersion: string;
  sourceSnapshotId: string;
  reward?: Money | undefined;
  unit: string;
  confidence: StackingConfidence;
  sourceReference?: string | undefined;
  observedAt?: string | undefined;
}
export type RewardComponentRouteLayer = 'merchant' | 'payment_provider' | 'card_issuer';
export interface ComponentCapUsage {
  poolId: string;
  periodKey: string;
  metric: 'reward' | 'spend' | 'transaction_count';
  consumedAmount: number;
}
export interface RewardAmount {
  value: number;
  unitType: 'currency' | 'point' | 'mile' | string;
  unitName: string;
  currency?: Currency | undefined;
}
export interface RewardComponentRecord {
  componentId: string;
  transactionId: string;
  ruleId: string;
  ruleVersion: string;
  route: RewardComponentRouteLayer;
  provider?: string | undefined;
  reward: RewardAmount;
  capUsages: readonly ComponentCapUsage[];
  appliedAtUtc: string;
}
export type PredicateValue = string | number | boolean | readonly string[];
export const SUPPORTED_PREDICATE_FIELDS = [
  'transaction.country',
  'transaction.merchant',
  'transaction.mcc',
  'transaction.channel',
  'transaction.amount.currency',
  'transaction.routeContext.dcc',
  'transaction.funding.kind',
  'transaction.route.kind',
  'transaction.paymentMethod',
] as const;
export type SupportedPredicateField = typeof SUPPORTED_PREDICATE_FIELDS[number];
export type PredicateLeafOperator = 'EQUALS' | 'MATCH_ALLOWLIST';
export type PredicateGroupOperator = 'AND' | 'OR';
export type Predicate =
  | { op: PredicateGroupOperator; rules: readonly Predicate[] }
  | { op: 'NOT'; rule: Predicate }
  | { field: string; op: PredicateLeafOperator; value: PredicateValue };
export type CalculationTrustRequirement = 'source_verified' | 'user_confirmation';
export type RewardCombinationMode = 'additive' | 'replace' | 'best_of' | 'exclusive' | 'prerequisite';
export interface RewardCombinationPolicy { mode: RewardCombinationMode | string; groupId: string; version: string; priority?: number | undefined; prerequisiteRuleIds?: readonly string[] | undefined; }

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export interface CardDescriptor {
  id: string;
  issuer: string;
  productName: string;
  network?: string | undefined;
  last4?: string | undefined;
  country?: string | undefined;
  billingCycleDay?: number | undefined;
  timezone?: string | undefined;
}

export interface CardProduct {
  id: string;
  issuer: string;
  productName: string;
  network?: string | undefined;
  country?: string | undefined;
}

export interface HeldCard {
  id: string;
  cardProductId: string;
  alias?: string | undefined;
  billingCycleDay?: number | undefined;
  timezone?: string | undefined;
  plan?: string | undefined;
  status?: 'active' | 'inactive' | undefined;
}

export interface EligibilityFact {
  id?: string | undefined;
  evidenceId?: string | undefined;
  version?: string | undefined;
  cardId?: string | undefined;
  factKey: string;
  value: PredicateValue;
  validFrom?: string | undefined;
  validTo?: string | undefined;
}

export interface OfferProvenance {
  sourceUrl?: string | undefined;
  sourceDescription?: string | undefined;
  submitter?: string | undefined;
  submittedAt: string;
  contentFingerprint: string;
}

export interface MerchantProvenance {
  sourceSnapshotId?: string | undefined;
  sourceUrl?: string | undefined;
  version: string;
  updatedAt: string;
  notes?: string | undefined;
}

export interface MerchantIdentity {
  canonicalId: string;
  canonicalNameZhHant: string;
  canonicalNameLocale: 'zh-Hant-TW';
  officialAliases?: readonly string[] | undefined;
  operatingMarkets?: readonly string[] | undefined;
  mccs?: readonly string[] | undefined;
  channels?: readonly ('in_store' | 'online')[] | undefined;
  status: 'candidate' | 'active' | 'deprecated';
  supersededBy?: string | undefined;
  provenance: MerchantProvenance;
}

export type MerchantResolutionStatus = 'confirmed' | 'ambiguous' | 'unresolved' | 'needs_facts';
export interface MerchantResolution {
  resolutionStatus: MerchantResolutionStatus;
  merchant?: MerchantIdentity | undefined;
  boundedCandidates: readonly MerchantIdentity[];
  requiredFacts?: readonly string[] | undefined;
  catalogVersion: string;
}

export interface OfferConfirmation {
  confirmedAt: string;
  confirmedBy: string;
  /** Official source reference when one exists; user confirmations may omit it. */
  sourceReference?: string | undefined;
  /** The authority that allowed this rule version to become active. */
  trustBasis?: 'official_verified' | 'user_confirmed' | undefined;
  /** Stable fingerprint of the terms the user reviewed and accepted. */
  termsFingerprint?: string | undefined;
  offerPeriod: { validFrom: string; validTo?: string | undefined };
  rewardUnit: string;
  rewardConditionsSummary?: string | undefined;
  capSummary?: string | undefined;
}

export interface OfferSourceSnapshot {
  id: string;
  ownerUser?: string | undefined;
  /** Public URL for official snapshots; omitted for a user attestation. */
  url?: string | undefined;
  fetchedAt: string;
  contentHash: string;
  parserVersion: string;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  excerpt?: string | undefined;
  verified?: boolean | undefined;
  sourceType?: 'official' | 'user_input' | undefined;
  provenance?: OfferProvenance | undefined;
}

export interface RuleMatch {
  merchants?: string[] | undefined;
  mccs?: string[] | undefined;
  countries?: string[] | undefined;
  channels?: string[] | undefined;
  paymentMethods?: string[] | undefined;
}

export interface RewardSpec {
  /** Extensible semantic identifier; unsupported kinds are evaluated as unknown. */
  kind: string;
  code?: string | undefined;
  /** Basis points: 100 = 1%. */
  rateBps?: number | undefined;
  amountMinor?: number | undefined;
  currency?: Currency | undefined;
  roundingMode?: 'floor' | 'ceil' | 'half_up' | 'nearest' | undefined;
  roundingScope?: 'per_transaction' | 'per_period' | undefined;
  unitAmountMinor?: number | undefined;
  unitRewardMinor?: number | undefined;
  stepAmountMinor?: number | undefined;
  stepRewardMinor?: number | undefined;
}

export interface CapPeriod {
  kind: 'calendar_month' | 'billing_cycle' | 'campaign';
  cap: Money;
  /** Usage comes from the ledger, never from this rule document. */
  usageKey: string;
  capPoolId?: string | undefined;
  capPoolRefs?: readonly string[] | undefined;
  metric?: 'spend' | 'reward' | 'transaction_count' | undefined;
  timezone?: string | undefined;
}
export interface CapPoolDefinition {
  id: string;
  name?: string | undefined;
  metric: 'spend' | 'reward' | 'transaction_count';
  period: 'calendar_month' | 'billing_cycle' | 'quarter' | 'year' | 'campaign';
  limit: number;
  currency?: Currency | undefined;
  timezone?: string | undefined;
}

export interface OfferRuleVersion {
  id: string;
  cardId?: string;
  version: string;
  sourceSnapshotId: string;
  /** Public rules are unscoped; user-confirmed rules belong to one owner. */
  ownerUser?: string | undefined;
  trustBasis?: 'official_verified' | 'user_confirmed' | undefined;
  /** Stable family key used to select one version without double counting. */
  familyId?: string | undefined;
  supersedesRuleId?: string | undefined;
  supersessionReason?: 'user_correction' | 'user_revocation' | 'official_refresh' | undefined;
  status: 'candidate' | 'active' | 'stale' | 'superseded' | 'needs_review' | 'unknown';
  validFrom: string;
  validTo?: string | undefined;
  settlementCurrency: Currency;
  match: RuleMatch;
  predicate?: Predicate | undefined;
  /** Source-backed exclusions applied to this rule during ingestion. */
  sharedExclusions?: readonly AppliedExclusion[] | undefined;
  requires?: readonly CalculationTrustRequirement[] | undefined;
  reward: RewardSpec;
  componentKind?: RewardComponentKind | undefined;
  sponsor?: string | undefined;
  benefitGroup?: string | undefined;
  useSettlementAmount?: boolean | undefined;
  stacking?: StackingConfidence | undefined;
  confirmation?: OfferConfirmation | undefined;
  combination?: RewardCombinationPolicy | undefined;
  /** Schema v2 canonical cap references. */
  capPoolRefs?: readonly string[] | undefined;
  /** Optional exact PaymentRoute binding; absent means the legacy generic rule. */
  routeId?: string | undefined;
  /** Optional reusable Payment Route Selector over route roles, transitions, and allowlists */
  routeSelector?: PaymentRouteSelector | undefined;
  /** Optional recommendation-time event eligibility; exactly one may be supplied. */
  eventRule?: PaymentEventRule | undefined;
  eventChainRule?: PaymentEventChainRule | undefined;
}

export interface PaymentRouteSelector {
  /** Open provider or consumerApp allowlist for payment services (e.g. ['line_pay', 'jko_pay', 'taishin_pay_plus']) */
  paymentServices?: readonly string[] | undefined;
  paymentServiceAllowlist?: readonly string[] | undefined;
  /** Open provider allowlist for merchant acceptance networks (e.g. ['paypay', 'twqr']) */
  acceptanceNetworks?: readonly string[] | undefined;
  acceptanceNetworkAllowlist?: readonly string[] | undefined;
  /** Allowed funding kinds (e.g. ['credit_card', 'account', 'cash']) */
  fundingKinds?: readonly ('credit_card' | 'account' | 'cash')[] | undefined;
  /** Node roles required by the route */
  nodeRoles?: readonly PaymentPathNodeRole[] | undefined;
  /** Route transitions required by the route */
  transitions?: readonly PaymentPathTransition[] | undefined;
  /** Route transitions forbidden by the route */
  excludedTransitions?: readonly PaymentPathTransition[] | undefined;
  /** Optional validity window for this selector */
  validFrom?: string | undefined;
  validTo?: string | undefined;
}

export interface FxSnapshot {
  id: string;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  /** quote minor units per base minor unit, in parts per million. */
  ratePpm: number;
  capturedAt: string;
  maxAgeSeconds?: number | undefined;
  /** Primary source/provider identity supplied by the Agent or host. */
  provider: string;
  /** Quotation convention used by the source. */
  rateType: FxRateType;
  /** Optional source URL and immutable content fingerprint for auditability. */
  sourceUrl?: string | undefined;
  contentHash?: string | undefined;
  /** Optional scope restrictions for card-specific or issuer-specific quotes. */
  cardIdScope?: string | undefined;
  issuerScope?: string | undefined;
  rateDirection?: 'base_to_quote' | 'quote_to_base' | undefined;
  conversionOwner?: ConversionOwner | undefined;
  conversionTiming?: ConversionTiming | undefined;
  cardScheme?: string | undefined;
  routeIdScope?: string | undefined;
  edgeIdScope?: string | undefined;
}

export interface AppliedFxRate {
  snapshotId: string;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  ratePpm: number;
  capturedAt: string;
  provider: string;
  rateType: FxRateType;
  sourceUrl?: string | undefined;
  contentHash?: string | undefined;
  conversionOwner?: string | undefined;
  appliedAtUtc: string;
}

export interface RewardValuationSnapshot {
  id: string;
  nativeUnit: string;
  rateNumerator: number;
  rateDenominator: number;
  targetCurrency: Currency;
  asOf: string;
  validTo?: string | undefined;
  version: string;
  evidenceId: string;
  ownerUser?: string | undefined;
}

export interface CycleWindow {
  kind: CapPeriod['kind'];
  key: string;
  startIso?: string | undefined;
  endIso?: string | undefined;
}

export interface TransactionTuple {
  idempotencyKey?: string | undefined;
  routeId?: string | undefined;
  cardId?: string | undefined;
  funding?: FundingInstrument | undefined;
  kind: TransactionKind;
  mode: TransactionMode;
  merchant?: string | undefined;
  mcc?: string | undefined;
  country?: string | undefined;
  channel?: string | undefined;
  paymentMethod?: string | undefined;
  occurredAt: string;
  recordedAt?: string | undefined;
  amount: Money;
  fx?: FxSnapshot | undefined;
  refundOfId?: string | undefined;
  originalRewardMinor?: number | undefined;
  route?: PaymentRoute | undefined;
  settlementAmount?: Money | undefined;
  routeContext?: PaymentRouteContext | undefined;
}

export interface RewardBreakdown {
  status: EvaluationStatus;
  cardId?: string | undefined;
  transaction: TransactionTuple;
  ruleId?: string | undefined;
  ruleVersion?: string | undefined;
  sourceSnapshotId?: string | undefined;
  grossReward?: Money | undefined;
  cappedReward?: Money | undefined;
  capRemainingBefore?: Money | undefined;
  capRemainingAfter?: Money | undefined;
  unknownReasons: string[];
  /** Exclusions that matched, including the source leaf and its evidence. */
  matchedExclusions?: readonly AppliedExclusion[] | undefined;
  diagnostics?: readonly Diagnostic[] | undefined;
  components?: readonly RewardComponent[] | undefined;
}

export type TransactionTimeBasis = 'occurred_at' | 'recorded_at';

export interface ListTransactionsOptions {
  startDate?: string | undefined;
  endDate?: string | undefined;
  timeBasis?: TransactionTimeBasis | undefined;
  fundingKind?: 'credit_card' | 'account' | 'cash' | undefined;
  cardId?: string | undefined;
  limit?: number | undefined;
  page?: number | undefined;
  projection?: 'summary' | 'detail' | undefined;
}

export interface TransactionSummaryItem {
  idempotencyKey?: string | undefined;
  occurredAt: string;
  recordedAt?: string | undefined;
  kind: TransactionKind;
  amount: Money;
  funding: FundingInstrument;
  cardId?: string | undefined;
  merchant?: string | undefined;
  channel?: string | undefined;
  rewardStatus?: EvaluationStatus | undefined;
  rewardAmount?: Money | undefined;
  refundOfId?: string | undefined;
}

export interface TransactionDetailItem {
  transaction: TransactionTuple;
  reward: RewardBreakdown;
  appliedFx?: AppliedFxRate | undefined;
  capUsages?: readonly ComponentCapUsage[] | undefined;
  components?: readonly RewardComponentRecord[] | undefined;
  route?: PaymentRoute | PaymentRouteRecord | undefined;
}

export type TransactionListItem = TransactionSummaryItem | TransactionDetailItem;

export interface ListTransactionsResult {
  transactions: readonly TransactionListItem[];
  items: readonly TransactionListItem[];
  pageInfo: PageInfo;
}

export interface Diagnostic {
  code: 'missing_required_fact' | 'invalid_fact' | 'conflicting_fact' | 'unsupported_field' | 'stale_fact' | 'fx_missing' | 'fx_stale' | 'fx_pair_mismatch' | 'fx_scope_mismatch' | 'fx_conflict' | 'merchant_ambiguous' | 'merchant_not_found' | 'no_active_offer' | 'source_untrusted' | 'stale_rule' | 'invalid_input' | 'needs_review';
  path: string;
  requiredFacts: readonly string[];
  retryAction: string;
  message: string;
  nextAction: string;
  candidateIds?: readonly string[] | undefined;
}

export interface FxResolutionRequest {
  baseCurrency: string;
  quoteCurrency: string;
  asOf?: string | undefined;
  transactionKind: 'planned' | 'actual';
  conversionOwner?: 'card_scheme' | 'issuer' | 'wallet' | 'merchant_dcc' | 'unknown' | undefined;
  suggestedRateTypes: Array<'cash_selling' | 'spot_selling' | 'mid_market' | 'card_scheme'>;
  requiredFacts: string[];
  sourceSelectionReason: string;
  retryAction: 'query_approved_fx_source' | 'ask_user' | 'refresh_external_data';
  userQuestion?: string | undefined;
  sourceUrls?: readonly string[];
  referenceSourceUrls?: readonly string[];
  sourceStatus?: 'known' | 'discovery_required';
  purpose?: 'path_quote' | 'policy_research' | 'reference_estimate';
  rateDirection?: 'base_to_quote';
  cardScheme?: string | undefined;
  scope?: { kind: 'public_reference' | 'card' | 'issuer' | 'route' | 'route_edge' | 'card_scheme'; cardId?: string; issuer?: string; routeId?: string; edgeId?: string; cardScheme?: string };
  freshness?: { maxAgeSeconds?: number; targetTime?: string };
  requiredFields?: readonly string[];
  submission?: { tool: string; field: string };
}

export interface FxEvaluationContext {
  baseCurrency: Currency;
  quoteCurrency: Currency;
  rateDirection?: 'base_to_quote' | 'quote_to_base' | undefined;
  conversionOwner?: ConversionOwner | 'card_scheme' | 'issuer' | 'wallet' | 'merchant_dcc' | 'unknown' | undefined;
  conversionTiming?: ConversionTiming | undefined;
  rateType?: FxRateType | undefined;
  /** Known clearing provider; a quote from another provider is not reusable. */
  provider?: string | undefined;
  cardScheme?: string | undefined;
  cardId?: string | undefined;
  issuer?: string | undefined;
  routeId?: string | undefined;
  edgeId?: string | undefined;
  asOf?: string | undefined;
  requireFresh?: boolean | undefined;
}


export type EvidenceSourceType = 'official' | 'trusted_secondary' | 'community' | 'user_provided';
export type EvidenceAuthority = 'issuer' | 'network' | 'wallet' | 'merchant' | 'secondary' | 'community' | 'user';
export type EvidenceReviewState = 'accepted' | 'candidate' | 'conflict' | 'rejected';
export interface EvidenceRecord {
  id: string;
  requirementId: string;
  sourceIdentity: string;
  sourceType: EvidenceSourceType;
  authority: EvidenceAuthority;
  claim: Readonly<Record<string, string | number | boolean>>;
  observedAt: string;
  validFrom?: string | undefined;
  validTo?: string | undefined;
  refreshAfter?: string | undefined;
  confidence: 'high' | 'medium' | 'low';
  contentHash: string;
  reviewState: EvidenceReviewState;
  sourceUrl?: string | undefined;
  ownerUser?: string | undefined;
}
export interface FactCandidate {
  id: string;
  requirementId: string;
  fact: Readonly<Record<string, string | number | boolean>>;
  evidenceId: string;
  reviewState: EvidenceReviewState;
}

export type CardSwitchAction = 'record' | 'adjust';

export interface CardSwitchConfirmation {
  confirmedBy: string;
  confirmedAtUtc: string;
  completed: boolean;
}

export interface CardSwitchCampaign {
  id: string;
  issuer: string;
  network?: string | undefined;
  cardId?: string | undefined;
  sourceUrl: string;
  sourceSnapshotAt: string;
  ruleVersion: string;
  effectiveFrom: string;
  effectiveTo?: string | undefined;
  eligibility?: readonly string[] | undefined;
  rewardCaps?: readonly Money[] | undefined;
}

export interface CardSwitchEnrollment {
  campaignId: string;
  cardId: string;
  enrolled: boolean;
  enrolledAt?: string | undefined;
  usageByPeriod?: Readonly<Record<string, Money>> | undefined;
}

export interface CardSwitchProjection {
  kind?: UserBenefitKind | undefined;
  ownerUser?: string | undefined;
  cardId: string;
  timezone: string;
  switchedAtUtc: string;
  switchedAtLocal: string;
  switchedLocalDate: string;
  benefit: string;
  sourceUrl: string;
  sourceSnapshotAt: string;
  ruleVersion: string;
  confirmation: CardSwitchConfirmation;
  action: CardSwitchAction;
  idempotencyKey: string;
  adjustmentReason?: string | undefined;
  effectiveFrom?: string | undefined;
  effectiveTo?: string | undefined;
  campaignId?: string | undefined;
}

export interface CardSwitchInput {
  action: CardSwitchAction;
  cardId: string;
  timezone: string;
  switchedAtUtc: string;
  benefit: string;
  sourceUrl: string;
  sourceSnapshotAt: string;
  ruleVersion: string;
  confirmation: CardSwitchConfirmation;
  idempotencyKey: string;
  adjustmentReason?: string | undefined;
  campaign?: CardSwitchCampaign | undefined;
  enrollment?: CardSwitchEnrollment | undefined;
}

export interface CardSwitchStatus {
  cardId: string;
  current?: CardSwitchProjection | undefined;
  alreadySwitchedToday: boolean;
  availableCandidates: readonly CardSwitchCampaign[];
  currentlyUnavailable: readonly { campaign: CardSwitchCampaign; reason: string }[];
  warnings: readonly string[];
}

export type UserBenefitKind = 'card_switch' | 'campaign_registration';
export interface UserBenefitInput {
  kind: UserBenefitKind;
  action: CardSwitchAction;
  cardId: string;
  campaignId?: string | undefined;
  timezone: string;
  completedAt: string;
  effectiveFrom: string;
  effectiveTo?: string | undefined;
  benefit: string;
  sourceUrl: string;
  sourceSnapshotAt: string;
  ruleVersion: string;
  confirmation: CardSwitchConfirmation;
  idempotencyKey: string;
  adjustmentReason?: string | undefined;
}

export interface UserBenefitStatus extends CardSwitchStatus {
  kind: UserBenefitKind;
  availableNow: readonly CardSwitchCampaign[];
  availableAfterActions: readonly { campaign: CardSwitchCampaign; requiredActions: readonly string[] }[];
}

export interface EvaluationContext {
  now?: string | undefined;
  usageByKey?: Readonly<Record<string, Money>> | undefined;
  sourceSnapshots?: Readonly<Record<string, OfferSourceSnapshot>> | undefined;
  userConfirmed?: boolean | undefined;
  heldCards?: readonly HeldCard[] | undefined;
  eligibilityFacts?: readonly EligibilityFact[] | undefined;
  userFacts?: Readonly<Record<string, PredicateValue>> | undefined;
  capPools?: readonly CapPoolDefinition[] | undefined;
  benefitStatuses?: readonly UserBenefitStatus[] | undefined;
  paymentRoutes?: readonly PaymentRouteRecord[] | undefined;
  paymentEvents?: { target: PaymentEvent; sourceEvents: readonly PaymentEvent[] } | undefined;
}

export interface RankingEntry extends RewardBreakdown {
  rank: number;
}

/** Merchant-first planned intent; absent amount means discovery, not zero spend. */
export interface RecommendationIntent {
  merchant: string | { rawStatement?: string; name?: string; canonicalId?: string; canonicalNameZhHant?: string; country?: string; market?: string };
  amount?: Money;
  country?: string;
  market?: string;
  channel?: string;
  paymentMethod?: string;
  occurredAt?: string;
  cardIds?: readonly string[];
  routeIds?: readonly string[];
  limit?: number;
  page?: number;
  cursor?: string;
  resultVersion?: string;
  fx?: FxSnapshot;
  routeFacts?: readonly { routeId: string; edgeId?: string; fx: FxSnapshot }[];
  eligibilityFacts?: readonly EligibilityFact[];
  /** Typed facts supplied on a stateless retry; never persisted by recommendation. */
  supplementalFacts?: RecommendationSupplementalFacts | undefined;
  /** Version returned by the preceding recommendation that this retry expects. */
  expectedResultVersion?: string | undefined;
}

export interface RecommendationSupplementalFacts {
  merchant?: { canonicalId: string; canonicalNameZhHant?: string; country?: string; market?: string } | undefined;
  amount?: Money | undefined;
  transaction?: {
    amount?: Money;
    country?: string;
    market?: string;
    channel?: string;
    paymentMethod?: string;
    occurredAt?: string;
  } | undefined;
  fx?: FxSnapshot | undefined;
  routeFacts?: readonly { routeId: string; edgeId?: string; fx: FxSnapshot }[] | undefined;
  eligibilityFacts?: readonly EligibilityFact[] | undefined;
  benefitEvidence?: readonly {
    evidenceId: string;
    observedAt: string;
    sourceUrl?: string;
    contentHash?: string;
    scope?: string;
  }[] | undefined;
}
export interface IntentCandidate {
  id: string;
  kind: 'direct_card' | 'payment_path';
  cardId?: string;
  routeId?: string;
  fundingSource?: FundingInstrument;
  nodes: readonly PaymentPathNode[];
  events: readonly PaymentPathEvent[];
  status: 'ready' | 'unknown' | 'blocked' | 'no_match';
  matchedRules: readonly IntentRule[];
  reward?: Money;
  netSpend?: Money;
  exclusionReasons: readonly string[];
  fxEstimate?: { status: 'estimated' | 'estimated_fallback' | 'stale_estimate' | 'unavailable'; provider?: string; capturedAt?: string; sourceUrl?: string; assumption: string };
}
export interface IntentRule {
  ruleId: string;
  ruleVersion: string;
  component: RewardComponentKind;
  sourceSnapshotId: string;
  sourceUrl?: string | undefined;
  trustBasis?: 'official_verified' | 'user_confirmed' | undefined;
  ownerUser?: string | undefined;
  confirmedAt?: string | undefined;
  sourceSummary?: string | undefined;
  validFrom: string;
  validTo?: string;
  conditions: RuleMatch;
  rewardTerms: RewardSpec;
  combination?: RewardCombinationPolicy;
  stacking?: 'confirmed' | 'possible';
  status: 'matched' | 'potential' | 'unknown' | 'excluded';
  reward?: Money;
  reasons: readonly string[];
}
export interface RecommendationAction {
  id: string;
  action: string;
  owner: 'agent' | 'user';
  path?: string | undefined;
  requiredFacts: readonly string[];
  candidateIds?: readonly string[] | undefined;
  submission?: { tool: string; field: string } | undefined;
  completionCondition?: string | undefined;
  diagnostic?: Diagnostic | undefined;
  fxResolutionRequest?: FxResolutionRequest | undefined;
}

export interface RecommendationIntentResult {
  status: 'ready' | 'partial' | 'needs_input' | 'no_match';
  candidates: readonly IntentCandidate[];
  requiredActions: readonly RecommendationAction[];
  coverage: {
    scope: string;
    discoveredCount: number;
    bounded: boolean;
    explorationComplete: boolean;
    total?: number | undefined;
    notes: readonly string[];
    actionCount?: number | undefined;
    unpopulatedScopes?: readonly string[] | undefined;
  };
  evaluatedAt: string;
  fxResolutionRequest?: FxResolutionRequest | undefined;
  fxResolutionRequests?: readonly FxResolutionRequest[] | undefined;
  pageSize: number;
  page: number;
  hasMore: boolean;
  nextCursor?: string | undefined;
  resultVersion: string;
  diagnostics?: readonly Diagnostic[] | undefined;
}

export interface PaymentPathRequest {
  amount: Money;
  merchant?: string;
  mcc?: string;
  country?: string;
  channel?: string;
  paymentMethod?: string;
  asOf?: string;
  routeIds?: readonly string[];
  limit?: number;
  maxHops?: number;
  maxEvents?: number;
  maxBranchesPerNode?: number;
  eligibilityFacts?: readonly EligibilityFact[] | undefined;
  routeFacts?: readonly { routeId: string; edgeId?: string; fx: FxSnapshot }[] | undefined;
  /** Internal continuation mode used by the merchant-first intent engine. */
  continuation?: boolean | undefined;
  /** Internal planned candidates generated from public capabilities. */
  routes?: readonly PaymentRouteRecord[] | undefined;
}
export interface PaymentPathNode { id: string; kind: string; displayName: string; }
export interface PaymentPathEventEligibility { status: 'ready' | 'unknown' | 'no_match' | 'needs_facts'; reasons: readonly string[]; }
export interface PlannedRewardCapUse { poolId: string; grossAmount: Money; cappedAmount: Money; }
export interface PlannedRewardComponent { ruleId: string; ruleVersion: string; component: RewardComponentKind; sponsor?: string; benefitGroup?: string; nativeUnit?: string; status: 'ready' | 'unknown' | 'no_match'; reward?: Money; capUses?: readonly PlannedRewardCapUse[]; reasons: readonly string[]; }
export interface PaymentPathEvent {
  kind: 'top_up' | 'purchase' | 'account_debit' | 'card_authorization';
  fromNodeId: string;
  toNodeId: string;
  planEventId?: string;
  amount?: Money;
  fee?: Money;
  markup?: Money;
  foreignTransactionFee?: Money;
  fx?: FxSnapshot;
  dcc?: { selected: boolean; fee?: Money };
  transition?: PaymentPathTransition;
  routeEdgeIds?: readonly string[];
  evidenceIds?: readonly string[];
  provenance?: 'official' | 'model_fixture';
  relations?: readonly { type: 'planned_precedes' | 'planned_enables'; eventId: string }[];
  eligibility?: PaymentPathEventEligibility;
  rewards?: readonly PlannedRewardComponent[];
}
export interface PaymentPathCandidate {
  id: string;
  routeId: string;
  nodes: readonly PaymentPathNode[];
  events: readonly PaymentPathEvent[];
  fundingSource: FundingInstrument;
  grossReward: Money;
  netReward: Money;
  cappedReward: Money;
  feeTotal?: Money;
  netValue?: Money;
  requiredActions?: readonly string[];
  userEffort?: number;
  evidenceTier?: number;
  evidenceFreshness?: string;
  matchedRules: readonly { ruleId: string; ruleVersion: string; component: string; sponsor?: string; benefitGroup?: string; nativeUnit?: string; nativeReward?: Money; reward: Money; capUses?: readonly PlannedRewardCapUse[] }[];
  exclusionReasons: readonly string[];
  status?: 'ready' | 'blocked' | 'no_match';
  pathSignature?: string;
  diagnostics?: readonly Diagnostic[] | undefined;
}
export interface PaymentPathRecommendation { status: 'ok' | 'partial' | 'needs_facts' | 'needs_review' | 'no_match'; candidates: readonly PaymentPathCandidate[]; evaluatedAt: string; blocked?: readonly { routeId: string; reason: string }[]; diagnostics?: readonly string[]; limits?: { maxCandidates: number; maxHops: number; maxEvents: number; maxBranchesPerNode: number }; }

/** A non-sensitive, canonical handle used to deduplicate unfinished source ingestion. */
export interface IngestionSourceScope { kind: 'official_url' | 'offer_family'; value: string; }
export type IngestionFlowStatus = 'awaiting_source' | 'awaiting_manifest' | 'processing_leaves' | 'ready_to_finalize' | 'complete' | 'needs_review' | 'conflict' | 'failed' | 'cancelled' | 'expired';
export interface IngestionSourceCapture { sourceType: 'official' | 'user_input'; url?: string; description?: string; retrievedAt: string; contentHash: string; artifactRef: string; submitter: string; submittedAt: string; }
export interface IngestionManifestLeaf { id: string; kind: 'benefit' | 'exclusion'; summary: string; evidenceLocator: string; dependsOn: readonly string[]; disposition?: 'materialized' | 'ignored' | 'superseded'; dispositionReason?: string; dispositionEvidence?: string; }
export interface IngestionLocalExclusion { scope: 'benefit'; predicate: Predicate; evidenceRefs: readonly string[]; }
export type IngestionExclusionTarget = 'merchant' | 'transaction_fact' | 'payment_route' | 'payment_method';
export interface IngestionExclusionScope { kind: 'all_benefits' | 'benefit_ids'; benefitIds?: readonly string[]; }
/** A persisted exclusion retains provenance after its candidate rule is finalized. */
export interface AppliedExclusion { sourceLeafId: string; sourceFlowId: string; target: IngestionExclusionTarget; predicate: Predicate; evidenceRefs: readonly string[]; }
export interface IngestionExclusionLeafSubmission { flowId: string; actionId: string; expectedRevision: number; idempotencyKey: string; leafId: string; target: IngestionExclusionTarget; scope: IngestionExclusionScope; predicate: Predicate; evidenceRefs: readonly string[]; disposition?: 'materialized' | 'ignored'; reason?: string; }
export interface IngestionExclusionArtifact extends AppliedExclusion { id: string; revision: number; scope: IngestionExclusionScope; idempotencyKey: string; payloadHash: string; status: 'candidate'; }
export interface IngestionMerchantReference { rawQuery: string; canonicalId?: string; country?: string; market?: string; mcc?: string; channel?: string; candidate?: Omit<MerchantIdentity, 'canonicalId' | 'status'> & { canonicalId?: string; status?: 'candidate' }; }
export interface IngestionBenefitLeafSubmission { flowId: string; actionId: string; expectedRevision: number; idempotencyKey: string; leafId: string; offer: { snapshot: OfferSourceSnapshot; rule: OfferRuleVersion; capPools?: readonly CapPoolDefinition[]; merchant?: Omit<MerchantIdentity, 'canonicalId'> & { canonicalId?: string }; }; merchantRefs?: readonly IngestionMerchantReference[]; evidenceRefs: readonly string[]; localExclusions?: readonly IngestionLocalExclusion[]; }
export interface IngestionBenefitArtifact { id: string; flowId: string; revision: number; leafId: string; ruleId: string; ruleVersion: string; snapshotId: string; evidenceRefs: readonly string[]; localExclusions: readonly IngestionLocalExclusion[]; idempotencyKey: string; payloadHash: string; status: 'candidate'; }
export interface IngestionCompletionProof {
  flowId: string;
  finalizeActionId: string;
  finalizedRevision: number;
  completedAt: string;
  sourceCapture: Pick<IngestionSourceCapture, 'artifactRef' | 'contentHash' | 'retrievedAt' | 'sourceType'>;
  leafTotals: { total: number; materialized: number; ignored: number; superseded: number; };
  leaves: readonly { id: string; kind: IngestionManifestLeaf['kind']; disposition: NonNullable<IngestionManifestLeaf['disposition']>; reason?: string; evidenceLocator: string; evidenceRefs: readonly string[]; }[];
  activatedRules: readonly { ruleId: string; ruleVersion: string; }[];
  awaitingConfirmationRules: readonly { ruleId: string; ruleVersion: string; reason: string; }[];
}
export interface IngestionFlowRecord {
  id: string;
  ownerUser: string;
  sourceScope: IngestionSourceScope;
  revision: number;
  status: IngestionFlowStatus;
  idempotencyKey: string;
  createdAt: string;
  lastActivityAt: string;
  expiresAt: string;
  sourceCapture?: IngestionSourceCapture;
  manifest?: readonly IngestionManifestLeaf[];
  benefitArtifacts?: readonly IngestionBenefitArtifact[];
  exclusionArtifacts?: readonly IngestionExclusionArtifact[];
  completionProof?: IngestionCompletionProof;
}
export interface IngestionDraftTombstone {
  id: string;
  ownerUser: string;
  sourceScope: IngestionSourceScope;
  revision: number;
  createdAt: string;
  expiredAt: string;
  retentionExpiresAt: string;
}

export interface McpToolContract {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  failClosedErrors: string[];
}
