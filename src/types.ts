export type Currency = string;
export type EvaluationStatus = 'ok' | 'no_match' | 'unknown' | 'needs_review' | 'stale';
export type TransactionKind = 'purchase' | 'refund';
export type TransactionMode = 'planned' | 'actual';
export type PaymentRouteKind = 'direct_card' | 'wallet' | 'merchant_app';
export interface PaymentRoute { kind: PaymentRouteKind; providerId?: string | undefined; appId?: string | undefined; displayName?: string | undefined; }
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
export type PaymentRouteLayer = 'merchant' | 'payment_provider' | 'card_issuer';
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
  route: PaymentRouteLayer;
  provider?: string | undefined;
  reward: RewardAmount;
  capUsages: readonly ComponentCapUsage[];
  appliedAtUtc: string;
}
export type PredicateValue = string | number | boolean | readonly string[];
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

export interface OfferConfirmation {
  confirmedAt: string;
  confirmedBy: string;
  sourceReference: string;
  offerPeriod: { validFrom: string; validTo?: string | undefined };
  rewardUnit: string;
  rewardConditionsSummary?: string | undefined;
  capSummary?: string | undefined;
}

export interface OfferSourceSnapshot {
  id: string;
  url: string;
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
  cardId: string;
  version: string;
  sourceSnapshotId: string;
  status: 'candidate' | 'active' | 'stale' | 'superseded' | 'needs_review' | 'unknown';
  validFrom: string;
  validTo?: string | undefined;
  settlementCurrency: Currency;
  match: RuleMatch;
  predicate?: Predicate | undefined;
  requires?: readonly CalculationTrustRequirement[] | undefined;
  reward: RewardSpec;
  componentKind?: RewardComponentKind | undefined;
  useSettlementAmount?: boolean | undefined;
  stacking?: StackingConfidence | undefined;
  confirmation?: OfferConfirmation | undefined;
  combination?: RewardCombinationPolicy | undefined;
  /** Schema v2 canonical cap references. */
  capPoolRefs?: readonly string[] | undefined;
}

export interface FxSnapshot {
  id: string;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  /** quote minor units per base minor unit, in parts per million. */
  ratePpm: number;
  capturedAt: string;
  maxAgeSeconds?: number | undefined;
}

export interface CycleWindow {
  kind: CapPeriod['kind'];
  key: string;
  startIso?: string | undefined;
  endIso?: string | undefined;
}

export interface TransactionTuple {
  idempotencyKey?: string | undefined;
  cardId: string;
  kind: TransactionKind;
  mode: TransactionMode;
  merchant?: string | undefined;
  mcc?: string | undefined;
  country?: string | undefined;
  channel?: string | undefined;
  paymentMethod?: string | undefined;
  occurredAt: string;
  amount: Money;
  fx?: FxSnapshot | undefined;
  refundOfId?: string | undefined;
  originalRewardMinor?: number | undefined;
  route?: PaymentRoute | undefined;
  settlementAmount?: Money | undefined;
}

export interface RewardBreakdown {
  status: EvaluationStatus;
  cardId: string;
  transaction: TransactionTuple;
  ruleId?: string | undefined;
  ruleVersion?: string | undefined;
  sourceSnapshotId?: string | undefined;
  grossReward?: Money | undefined;
  cappedReward?: Money | undefined;
  capRemainingBefore?: Money | undefined;
  capRemainingAfter?: Money | undefined;
  unknownReasons: string[];
  components?: readonly RewardComponent[] | undefined;
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
  usageByPeriod?: Readonly<Record<string, Money>> | undefined;
}

export interface CardSwitchProjection {
  kind?: UserBenefitKind | undefined;
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
}

export interface RankingEntry extends RewardBreakdown {
  rank: number;
}

export interface McpToolContract {
  name: string;
  description: string;
  readOnly: boolean;
  inputSchema: Record<string, unknown>;
  failClosedErrors: string[];
}
