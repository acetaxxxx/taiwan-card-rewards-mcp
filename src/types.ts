export type Currency = string;
export type EvaluationStatus = 'ok' | 'no_match' | 'unknown' | 'needs_review' | 'stale';
export type TransactionKind = 'purchase' | 'refund';
export type TransactionMode = 'planned' | 'actual';
export type PredicateValue = string | number | boolean | readonly string[];
export type PredicateLeafOperator = 'EQUALS' | 'MATCH_ALLOWLIST';
export type PredicateGroupOperator = 'AND' | 'OR';
export type Predicate =
  | { op: PredicateGroupOperator; rules: readonly Predicate[] }
  | { op: 'NOT'; rule: Predicate }
  | { field: string; op: PredicateLeafOperator; value: PredicateValue };
export type CalculationTrustRequirement = 'source_verified' | 'user_confirmation';

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
  kind: 'percentage' | 'flat';
  /** Basis points: 100 = 1%. */
  rateBps?: number | undefined;
  amountMinor?: number | undefined;
  currency?: Currency | undefined;
}

export interface CapPeriod {
  kind: 'calendar_month' | 'billing_cycle' | 'campaign';
  cap: Money;
  /** Usage comes from the ledger, never from this rule document. */
  usageKey: string;
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
  cap?: CapPeriod | undefined;
  confirmation?: OfferConfirmation | undefined;
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

export interface EvaluationContext {
  now: string;
  usageByKey?: Readonly<Record<string, Money>> | undefined;
  sourceSnapshots?: Readonly<Record<string, OfferSourceSnapshot>> | undefined;
  userConfirmed?: boolean | undefined;
  heldCards?: readonly HeldCard[] | undefined;
  eligibilityFacts?: readonly EligibilityFact[] | undefined;
  userFacts?: Readonly<Record<string, PredicateValue>> | undefined;
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
