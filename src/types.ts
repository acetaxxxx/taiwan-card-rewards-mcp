export type Currency = string;
export type EvaluationStatus = 'ok' | 'no_match' | 'unknown' | 'needs_review' | 'stale';
export type TransactionKind = 'purchase' | 'refund';
export type TransactionMode = 'planned' | 'actual';

export interface Money {
  amountMinor: number;
  currency: Currency;
}

export interface CardDescriptor {
  id: string;
  issuer: string;
  productName: string;
  network?: string;
  last4?: string;
  country?: string;
}

export interface OfferSourceSnapshot {
  id: string;
  url: string;
  fetchedAt: string;
  contentHash: string;
  parserVersion: string;
  validFrom?: string;
  validTo?: string;
  excerpt?: string;
}

export interface RuleMatch {
  merchants?: string[];
  mccs?: string[];
  countries?: string[];
  channels?: string[];
  paymentMethods?: string[];
}

export interface RewardSpec {
  kind: 'percentage' | 'flat';
  /** Basis points: 100 = 1%. */
  rateBps?: number;
  amountMinor?: number;
  currency?: Currency;
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
  status: 'active' | 'stale' | 'needs_review' | 'unknown';
  validFrom: string;
  validTo?: string;
  settlementCurrency: Currency;
  match: RuleMatch;
  reward: RewardSpec;
  cap?: CapPeriod;
}

export interface FxSnapshot {
  id: string;
  baseCurrency: Currency;
  quoteCurrency: Currency;
  /** quote minor units per base minor unit, in parts per million. */
  ratePpm: number;
  capturedAt: string;
}

export interface TransactionTuple {
  idempotencyKey?: string;
  cardId: string;
  kind: TransactionKind;
  mode: TransactionMode;
  merchant?: string;
  mcc?: string;
  country?: string;
  channel?: string;
  paymentMethod?: string;
  occurredAt: string;
  amount: Money;
  fx?: FxSnapshot;
  refundOfId?: string;
  originalRewardMinor?: number;
}

export interface RewardBreakdown {
  status: EvaluationStatus;
  cardId: string;
  transaction: TransactionTuple;
  ruleId?: string;
  ruleVersion?: string;
  sourceSnapshotId?: string;
  grossReward?: Money;
  cappedReward?: Money;
  capRemainingBefore?: Money;
  capRemainingAfter?: Money;
  unknownReasons: string[];
}

export interface EvaluationContext {
  now: string;
  usageByKey?: Readonly<Record<string, Money>>;
  sourceSnapshots?: Readonly<Record<string, OfferSourceSnapshot>>;
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
