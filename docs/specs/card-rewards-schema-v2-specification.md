# Card Rewards Schema v2 Specification

**Status**: Formal Target Specification
**Version**: 2.0.0
**Target Repository**: `taiwan-card-rewards-mcp`
**Relationship to Architecture**: Operationalizes and conforms to root [`CONTEXT.md`](../../CONTEXT.md), ADR 0001, ADR 0002, ADR 0003, and ADR 0004.

---

## 1. Introduction and Scope

### 1.1 Purpose
This document specifies **Schema v2** of the `taiwan-card-rewards-mcp` system. Schema v2 formalizes the pure calculation core, generic benefit statuses (plan switching and campaign registrations), multi-pool cap aggregations, explicit reward combination policies, native unit rounding/step mechanics, and uncertainty-aware ranking.

### 1.2 Conformance and Normative Language
The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) and [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt).

This specification operationalizes the architecture and domain decisions recorded in root [`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md), [ADR 0002](../adr/0002-user-assisted-image-offer-ingestion.md), [ADR 0003](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md), and [ADR 0004](../adr/0004-generic-benefit-status-and-schema-v2.md). It does not supersede them.

### 1.3 Scope
- Pure, deterministic calculation engine for credit card rewards.
- Declarative Predicate AST and evaluation rules.
- Multi-pool cap tracking and atomic consumption across billing cycles and campaign windows.
- Generic benefit status lifecycle (`card_switch` and `campaign_registration`).
- Explicit combination policies (`additive`, `replace`, `best_of`, `exclusive`, `prerequisite`).
- Native reward units, currency contexts, and rounding/step calculations.
- Public MCP 10-tool surface (8 base reward tools + 2 benefit status tools) and JSON-RPC contracts.
- Tenant-scoped persistence, idempotency, backfilled transactions, and migration boundaries.

### 1.4 Non-Goals
- **In-process OCR or image parsing**: MCP accepts structured candidate JSON with provenance only; visual perception occurs in the agent or host UI.
- **Outbound HTTP requests by MCP**: The MCP server makes no outbound network connections. Public official and community web sources are fetched externally by the agent/host.
- **Arbitrary executable code in rules**: Rules MUST be purely declarative AST data structures; no JavaScript/Python script execution is permitted inside rules.
- **Cross-tenant data sharing or shared databases**: Each user process is bound to an isolated, canonical `--data-dir`.
- **Implicit currency or rate guessing**: Foreign exchange rates and reward valuations MUST be backed by provenance-bearing snapshots; unverified defaults are forbidden.
- **Silent data deletion or automatic destructive migration**: Migration from v1 to v2 MUST be explicit; automatic truncation or dropping of existing data stores is strictly prohibited.

---

## 2. Canonical Domain Terminology

The terms defined below are normative and conform to root [`CONTEXT.md`](../../CONTEXT.md).

1. **Card Product**: The bank-issued credit card product whose published terms govern reward eligibility (e.g., Cathay CUBE Card, E.SUN Kumamon Card).
2. **Held Card**: The user's registered instance of a Card Product, containing user-specific billing cycle day, alias, and active benefit plan.
3. **Card Alias**: A user-assigned identifier for a Held Card that avoids payment instrument identifiers (PAN, card numbers, CVV).
4. **Unresolved Card**: A user-specified card name not yet mapped to a verified Card Product; MUST NOT produce confident reward calculations.
5. **Offer Evidence**: A dated statement of an issuer's benefit, condition, exclusion, or cap with traceable official source metadata.
6. **User-Supplied Offer Input**: Transcription or structured description provided by a user (e.g., from an image or poster); classified as `candidate` input until confirmed.
7. **Offer Input Provenance**: Traceable record linking candidate input to its source URL/description, submitter, submission timestamp, and SHA-256 fingerprint.
8. **Offer Confirmation**: Explicit human-in-the-loop confirmation verifying source reference, validity period, reward unit, conditions, and cap semantics.
9. **Rule Version**: An immutable set of Offer Rule terms valid for a stated time interval and source snapshot.
10. **Rule Status**: The lifecycle state of a Rule Version: `candidate`, `active`, `stale`, `superseded`, `needs_review`, or `unknown`.
11. **Predicate AST**: A declarative tree of conditions and operators (`EQUALS`, `MATCH_ALLOWLIST`, `AND`, `OR`, `NOT`) evaluated without executing agent-supplied code.
12. **Current Benefit State**: The mutable, user-scoped state describing currently selected plans (e.g., CUBE plan) or campaign enrollments as of a given timestamp.
13. **Campaign Registration**: A time-stamped record confirming user enrollment in a bank promotion for a specified validity window.
14. **Cap Pool**: An independent, named limit on rewards, spend, or transaction counts consumed across one or more rules over a defined interval.
15. **Reward Combination Policy**: Versioned rule dictating how multiple matching offers on the same transaction combine (`additive`, `replace`, `best_of`, `exclusive`, `prerequisite`).
16. **Immediately Available Offer (`availableNow`)**: An offer whose prerequisites, plan selection, and campaign registrations are already satisfied as of transaction time.
17. **Action-Required Offer (`availableAfterActions`)**: An offer that would match if the user executes a specific action (e.g., switch plan, register for campaign).
18. **Backfilled Purchase**: An actual past transaction entered after occurrence; evaluated strictly against historical rules, confirmed benefit projections encompassing that timestamp, and historical cap pools.
19. **Calculation Trust Gate**: Invariant enforcement in the evaluator requiring verified sources and active confirmation before issuing an `ok` calculation status.

---

## 3. Schema v2 Data Models and Contracts

### 3.1 Currency, Money, and Reward Units

```typescript
export type CurrencyCode = string; // ISO 4217, e.g., "TWD", "USD", "JPY"

export interface Money {
  amountMinor: number; // Integer minor units (e.g., 10000 TWD = 100.00 TWD)
  currency: CurrencyCode;
}

export type NativeRewardUnitType = 'currency' | 'point' | 'mile';

export interface RewardAmount {
  unitType: NativeRewardUnitType;
  unitName: string; // e.g., "TWD", "小樹點", "哩程", "LINE Points"
  /**
   * For currency: integer minor units according to ISO 4217 (e.g., cents/minor).
   * For points/miles: discrete integer count (e.g., 300 points = 300).
   */
  value: number;
}
```

### 3.2 Reward Specs, Step Rewards, and Rounding Policies

```typescript
export type RoundingMode = 'floor' | 'ceil' | 'half_up';
export type RoundingScope = 'per_transaction' | 'per_statement';

export interface RoundingPolicy {
  mode: RoundingMode;
  scope: RoundingScope;
}

export interface PercentageRewardSpec {
  kind: 'percentage';
  rateBps: number; // Basis points (100 bps = 1.00%, 300 bps = 3.00%)
  roundingPolicy?: RoundingPolicy;
}

export interface FlatRewardSpec {
  kind: 'flat';
  reward: RewardAmount;
}

export interface StepRewardSpec {
  kind: 'step';
  stepSpendMinor: number; // Qualifying spend required per step (e.g., 100000 minor = 1000 TWD)
  rewardPerStep: RewardAmount; // Reward earned per complete step (e.g., 50 TWD or 50 points)
  maxSteps?: number; // Optional limit on number of steps per transaction
  discardRemainder: boolean; // MUST be true for discrete spend steps
}

export type RewardSpecV2 = PercentageRewardSpec | FlatRewardSpec | StepRewardSpec;
```

### 3.3 Combination Policies and Groups

```typescript
export type CombinationPolicyType =
  | 'additive'       // Stacks on top of base reward
  | 'replace'        // Replaces other matching offers in the same combination group
  | 'best_of'        // Highest net reward wins among competing group offers
  | 'exclusive'      // If applied, no other reward rules may apply on this card
  | 'prerequisite';  // Requires a base offer rule in the group to match and qualify first

export interface CombinationPolicy {
  type: CombinationPolicyType;
  groupId: string; // Identifier grouping related offers (e.g., "cathay-cube-base-vs-bonus")
  priority?: number; // Integer priority for deterministic tie-breaking (higher evaluated first)
  prerequisiteRuleId?: string; // Required when type is 'prerequisite'
}
```

### 3.4 Multi-Pool Cap Definitions and Persistence

In Schema v2, Cap Pools are stored in a top-level registry (`state.capPools: CapPoolDefinition[]`). Rules reference cap pools strictly by pool ID (`rule.capPoolRefs: string[]`). Rules MUST NOT duplicate pool limit definitions.

```typescript
export type CapMetric = 'reward' | 'spend' | 'transaction_count';
export type CapPeriodKind = 'calendar_month' | 'billing_cycle' | 'quarter' | 'year' | 'campaign';

export interface CapPoolDefinition {
  id: string; // Unique pool identifier (e.g., "cube-overseas-bonus-monthly-cap")
  name: string;
  metric: CapMetric;
  period: CapPeriodKind;
  /**
   * For 'reward' or 'spend': limit in integer minor currency units.
   * For 'transaction_count': limit in discrete integer count.
   */
  limit: number;
  currency?: CurrencyCode; // Required when metric is 'reward' or 'spend'
  timezone?: string; // IANA timezone, default "Asia/Taipei" for Taiwan card programs
}
```

### 3.5 Offer Rule Version v2

```typescript
export interface OfferRuleVersionV2 {
  id: string;
  cardProductId: string;
  version: string; // e.g., "2026.1.0"
  sourceSnapshotId: string;
  status: 'candidate' | 'active' | 'stale' | 'superseded' | 'needs_review' | 'unknown';
  validFrom: string; // ISO 8601 UTC
  validTo?: string; // ISO 8601 UTC
  settlementCurrency: CurrencyCode;
  rewardUnit: string; // e.g., "TWD", "小樹點"
  reward: RewardSpecV2;
  match: RuleMatch;
  predicate?: Predicate;
  requires?: readonly ('source_verified' | 'user_confirmation' | 'campaign_registration' | 'plan_selection')[];
  combination: CombinationPolicy;
  capPoolRefs?: readonly string[]; // IDs of CapPoolDefinitions consumed by this rule
  settlementTiming?: 'realtime' | 'daily_settlement_selection'; // Declared bank timing semantics
  confirmation?: OfferConfirmation;
  actionRequiredDescription?: string; // Explanatory text for availableAfterActions
}
```

### 3.6 Generic Benefit Status Model

In Schema v2, `BenefitStatus` represents the user's active, confirmed configuration as of a given timestamp. It is **current-state**, not append-only event-sourced.

```typescript
export interface CardSwitchBenefitStatus {
  kind: 'card_switch';
  id: string;
  cardId: string;
  selectedPlanId: string;
  effectiveFrom: string; // ISO 8601 UTC
  effectiveTo?: string; // ISO 8601 UTC
  confirmedAt: string; // ISO 8601 UTC
  confirmedBy: string;
}

export interface CampaignRegistrationBenefitStatus {
  kind: 'campaign_registration';
  id: string;
  cardId?: string; // Optional: card-specific vs account-wide campaign
  campaignId: string;
  registrationTime: string; // ISO 8601 UTC
  effectiveFrom: string; // ISO 8601 UTC
  effectiveTo: string; // ISO 8601 UTC
  confirmedAt: string; // ISO 8601 UTC
  confirmedBy: string;
  metadata?: Record<string, string | number | boolean>;
}

export type BenefitStatus =
  | CardSwitchBenefitStatus
  | CampaignRegistrationBenefitStatus;
```

---

## 4. Calculation and Evaluation Semantics

### 4.1 Pure Evaluator Invariants
1. The evaluator MUST be a pure, deterministic function of `(rules, benefitStatuses, capPools, transaction, context)`.
2. The evaluator MUST NOT execute network calls, read the filesystem, or call non-injected clocks. All timestamps MUST be supplied via `context.now` or `transaction.occurredAt`.
3. If an input condition is missing, ambiguous, or expired, the evaluator MUST return `unknown` or `needs_review` with an explicit diagnostic reason in `unknownReasons`. It MUST NOT return zero reward or guess values.

### 4.2 Step Reward & Rounding Algorithm
When evaluating `StepRewardSpec`:
1. Calculate the qualifying settlement spend $S$.
2. Compute step count $N = \lfloor S / \text{stepSpendMinor} \rfloor$.
3. If $\text{maxSteps}$ is defined, $N = \min(N, \text{maxSteps})$.
4. Gross reward value is $N \times \text{rewardPerStep.value}$.
5. If $\text{discardRemainder}$ is true, the remainder $S \pmod{\text{stepSpendMinor}}$ produces zero reward and does not carry over across transactions.

When evaluating `PercentageRewardSpec` with `RoundingPolicy`:
1. Compute raw reward: $V = (S \times \text{rateBps}) / 10000$.
2. Apply `RoundingMode`:
   - `floor`: $\lfloor V \rfloor$
   - `ceil`: $\lceil V \rceil$
   - `half_up`: $\lfloor V + 0.5 \rfloor$

### 4.3 Multi-Metric Cap Pool Semantics & Aggregation
When a rule references one or more `CapPoolDefinition`s, each metric acts as a specific gate:

1. **`transaction_count` Metric**:
   - Evaluates remaining transaction allowance: $\text{AvailableCount} = \text{limit} - \text{usedCount}$.
   - If $\text{AvailableCount} \le 0$, the transaction is ineligible under this rule (reward is 0).
   - Upon recording, consumes 1 count from the pool.
2. **`spend` Metric**:
   - Caps qualifying spend: $\text{AvailableSpend} = \max(0, \text{limit} - \text{usedSpend})$.
   - Qualifying spend for reward calculation is $S_{\text{qual}} = \min(S_{\text{tx}}, \text{AvailableSpend})$.
   - If $S_{\text{qual}} = 0$, reward is 0.
   - Upon recording, consumes $S_{\text{qual}}$ from the spend pool.
3. **`reward` Metric**:
   - Caps earned reward amount: $\text{AvailableReward} = \max(0, \text{limit} - \text{usedReward})$.
   - Applied reward is $R_{\text{capped}} = \min(R_{\text{gross}}, \text{AvailableReward})$.
   - Upon recording, consumes $R_{\text{capped}}$ from the reward pool.
4. **Multi-Pool Aggregation**:
   - If a rule references multiple pools, all metric gates are enforced in sequence (transaction count eligibility $\rightarrow$ spend qualification $\rightarrow$ reward capping).
   - The aggregation key for pool tracking is `(poolId, periodKey)` where `periodKey` is derived from transaction timestamp and pool period kind.
   - Recording an actual purchase updates all referenced pools atomically.

### 4.4 Unified Combination Policy Resolution Algorithm
The exact same combination resolution algorithm MUST be used across `recommend`, `record_transaction`, and `rank_cards`:

1. **Partitioning**: Group matching rules on the card by `combination.groupId`.
2. **Prerequisite Resolution**: Rules with `combination.type === 'prerequisite'` apply ONLY if their `prerequisiteRuleId` matched and qualified.
3. **Group Resolution**:
   - `replace`: Select only the highest-priority matching rule in the group.
   - `best_of`: Select the matching rule yielding the highest net reward (tie-broken by `rule.id` ascending).
   - `additive`: All matching rules in the group apply; their individual gross rewards and cap consumptions are calculated independently and summed.
4. **Global Exclusive Check**: If any applied rule has `combination.type === 'exclusive'`, it MUST be the only rule applied to the transaction. If multiple exclusive rules match from different groups, the evaluator MUST fail closed with `needs_review` due to conflicting exclusive policies.
5. **Cross-Group Summation**: Total card reward is the sum of rewards from all applied rules across groups. Each applied rule consumes its referenced cap pools atomically upon recording.

### 4.5 `availableNow` vs `availableAfterActions` Breakdown
Card evaluation results MUST categorize outcomes into:
1. **`availableNow`**: Rewards immediately earned based on confirmed, active `BenefitStatus` matching transaction parameters.
2. **`availableAfterActions`**: Potential rewards achievable if the user executes specified actions (e.g., "Switch CUBE plan to Travel Joy", "Enroll in Q3 Overseas Campaign"). Each breakdown MUST list:
   - Action type (`plan_switch` or `campaign_registration`).
   - Incremental reward difference over `availableNow`.
   - Action deadline or validity window.

---

## 5. Time, Timezone, and Transaction Lifecycle

### 5.1 Timezone Rules
1. Timezone is resolved from the specific card or campaign rule definition, defaulting to `Asia/Taipei` (UTC+8) when omitted for Taiwan credit card programs.
2. Daily plan switches evaluate the active plan at `occurredAt` by default. If a rule explicitly declares `settlementTiming: 'daily_settlement_selection'` backed by official provenance, the plan active at `23:59:59.999` in the rule's timezone is used. If timing semantics are ambiguous or unverified, the evaluator MUST fail closed with `needs_review`.

### 5.2 Current-State Model and Backfilled Purchases
1. `BenefitStatus` represents current active selections without event history.
2. When evaluating a **Backfilled Purchase** (an actual historical transaction entered after occurrence):
   - If the current confirmed benefit state's `effectiveFrom`..`effectiveTo` interval encompasses historical `occurredAt`, that benefit state is applied.
   - If `occurredAt` falls outside the active effective range of the stored benefit state, backfill MUST fail closed with `needs_review` / prompt the user to provide the confirmed benefit status effective at `occurredAt`. The system MUST NOT guess or project today's status backward.
3. A Backfilled Purchase is evaluated against the historical Cap Pool period corresponding to `occurredAt`. Headroom is deducted from the historical pool; it MUST NOT deduct from the current period's cap.
4. Existing `RecordedPurchase` ledger entries are immutable and are never silently rewritten by benefit status changes.

---

## 6. Security, Trust, and Fail-Closed Boundaries

### 6.1 Trust Gates and Candidate Activation
1. Candidate rules ingested from user transcription MUST retain `OfferProvenance`.
2. Candidate rules MUST evaluate to `status: 'needs_review'` with reason `"rule status is candidate"` in standard recommendations.
3. Candidate rules are activated ONLY via `upsert_offer` supplied with an explicit, valid `OfferConfirmation`.

### 6.2 Fail-Closed Taxonomy
The system MUST return explicit non-confident statuses when conditions are unresolved:
- `INSUFFICIENT_FACTS`: A required transaction condition (channel, MCC, merchant) is missing.
- `NEEDS_REVIEW`: Rule is candidate, unconfirmed, or has contradictory combination policies.
- `STALE`: Source snapshot or FX snapshot is past its allowed freshness window.
- `UNKNOWN`: General unresolvable condition or currency mismatch.

---

## 7. Public MCP Tool Surface (10-Tool Contract)

Schema v2 defines exactly **10 tools** on the public MCP surface. Outbound network fetching is handled externally by the host/agent, not by the MCP server.

| # | Tool Name | Read-Only | Description |
|---|---|:---:|---|
| 1 | `calculate_reward` | Yes | Pure calculation of supplied rule AST against transaction and context without persistence. |
| 2 | `rank_cards` | Yes | Pure ranking of multiple cards for a transaction using uncertainty-aware sorting. |
| 3 | `register_card` | No | Registers or updates a user's Held Card descriptor and billing cycle. |
| 4 | `list_cards` | Yes | Lists registered Held Cards for the tenant. |
| 5 | `upsert_offer` | No | Ingests snapshot and versioned rule; atomically confirms and activates candidate rules if `confirmation` is supplied. |
| 6 | `recommend` | Yes | Uncertainty-aware Top-5 card recommendation using stored active rules, benefit statuses, and ledger caps. |
| 7 | `record_transaction` | No | Durably records actual purchase or refund with idempotency and multi-pool cap updates. |
| 8 | `remaining_caps` | Yes | Queries real-time remaining cap balances across all active cap pools for a card. |
| 9 | `get_user_benefit_status` | Yes | Queries user's active benefit state (`card_switch`, `campaign_registration`). |
| 10 | `upsert_user_benefit_status` | No | Records or updates user's confirmed benefit state for a plan selection or campaign enrollment. |

---

## 8. Migration and Incompatibility Policy

### 8.1 Breaking Schema Changes
Schema v2 is a breaking format change:
- `OfferRuleVersionV2` requires explicit `combination` and `capPoolRefs`.
- Storage introduces independent `CapPool` and `BenefitStatus` tables/collections.
- Legacy v1 data files cannot be parsed directly by v2 parsers.

### 8.2 Incompatible-Schema Fail Closed
1. Startup of Schema v2 engine against an incompatible v1 data directory MUST fail closed with error `SCHEMA_MIGRATION_REQUIRED`.
2. The engine MUST NEVER automatically delete, truncate, or wipe existing data files.
3. Operators/users MUST explicitly execute an external migration procedure or manually reset/initialize a new data directory.

---

## 9. Concrete Edge Cases and Acceptance Test Scenarios

### Edge Case 1: Plan Switch Timing Semantics
- **Scenario**: Transaction occurred at 14:00 Taipei time on 2026-09-02. CUBE plan was "Shopping" at transaction time; user switched to "Travel Joy" at 20:00 on the same day.
- **Rule Policy**: Cathay CUBE rule explicitly declares `settlementTiming: 'daily_settlement_selection'` backed by official provenance.
- **Expected Result**: Evaluator with `asOf = 2026-09-02T23:59:59+08:00` resolves "Travel Joy" and grants 3% travel reward; evaluation before 20:00 notes `availableAfterActions` for travel categories if plan is switched. If `settlementTiming` is undeclared, evaluator uses plan active at 14:00.

### Edge Case 2: Multi-Metric Pool Interaction
- **Scenario**: Rule references Spend Pool ($10,000 TWD spend limit, $2,000 used) and Reward Pool ($500 TWD reward limit, $450 used).
- **Transaction**: Spend of $12,000 TWD at 5% reward rate.
- **Evaluation**:
  1. Available spend headroom $= 10000 - 2000 = 8000\text{ TWD}$.
  2. Qualifying spend $S_{\text{qual}} = \min(12000, 8000) = 8000\text{ TWD}$.
  3. Gross reward $= 8000 \times 5\% = 400\text{ TWD}$.
  4. Available reward headroom $= 500 - 450 = 50\text{ TWD}$.
  5. Capped reward $= \min(400, 50) = 50\text{ TWD}$.
- **Expected Result**: Capped reward is 50 TWD. Upon recording, Spend Pool increases by $8,000$ (reaches limit); Reward Pool increases by $50$ (reaches limit).

### Edge Case 3: Step Reward Remainder Discard
- **Scenario**: Step reward grants 50 TWD per 1,000 TWD spend, max 3 steps.
- **Transaction**: Spend of 2,800 TWD.
- **Expected Result**: Step count $N = \lfloor 2800 / 1000 \rfloor = 2$. Reward $= 2 \times 50 = 100\text{ TWD}$. The remaining 800 TWD spend yields 0 reward.

### Edge Case 4: Backfilled Purchase with Ambiguous Historical Benefit
- **Scenario**: On October 5, user backfills a purchase that occurred on June 15. Stored CUBE plan switch only has `effectiveFrom: 2026-09-01`.
- **Expected Result**: Evaluator fails closed with `needs_review` and diagnostic reason `"Benefit status not confirmed for historical date 2026-06-15"`, prompting the user to supply the active plan on June 15.

---

## 10. Target Specification & Implementation Status

This document defines the **target normative specification** for Schema v2. Package/server version 0.4.0 implements the canonical top-level cap-pool registry, shared multi-metric aggregation, current benefit projections, fail-closed combination resolution, and the ten-tool MCP surface described above.

The persisted/runtime compatibility shape has a few deliberate differences from the illustrative v2 interfaces in Sections 3 and 4:
1. Runtime rules use `combination.mode` and `prerequisiteRuleIds`; the normative `type` and singular `prerequisiteRuleId` names describe the same policy concepts.
2. Runtime accepts `roundingMode: 'floor' | 'ceil' | 'half_up' | 'nearest'`; `nearest` is retained as a legacy alias for non-negative reward values, while `half_up` is the canonical v2 spelling.
3. Runtime stores `roundingScope: 'per_transaction' | 'per_period'`; statement-level aggregation is not inferred by the evaluator and must remain an explicit future extension.
4. `capPoolRefs` and `combination` are optional on a rule that does not use those features; when present, pool references are canonical and missing/ambiguous references fail closed.
5. Benefit state is a current projection. A backfilled transaction can use a confirmed projection whose effective interval covers `occurredAt`; absent historical benefit facts cannot be reconstructed and must remain `needs_review` rather than being inferred from today.

The implementation and schema JSON are versioned together; incompatible older data requires explicit migration or reset and is never silently deleted.

---

## 11. Document History and Cross-References

| Version | Date | Author / Role | Changes |
|---|---|---|---|
| 2.0.0 | 2026-09-02 | Source & Policy Researcher | Formal Schema v2 specification conforming to CONTEXT.md and ADR 0004. |

**Cross References**:
- [`CONTEXT.md`](../../CONTEXT.md): Root Domain Glossary and Invariants.
- [`docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md`](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md)
- [`docs/adr/0002-user-assisted-image-offer-ingestion.md`](../adr/0002-user-assisted-image-offer-ingestion.md)
- [`docs/adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md`](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md)
- [`docs/adr/0004-generic-benefit-status-and-schema-v2.md`](../adr/0004-generic-benefit-status-and-schema-v2.md)
- [`docs/specs/card-rewards-mcp-repository.md`](card-rewards-mcp-repository.md)
- [`docs/specs/taiwan-card-rewards-mcp-reference-study.md`](taiwan-card-rewards-mcp-reference-study.md)
