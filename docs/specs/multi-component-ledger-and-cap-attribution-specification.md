# Multi-Component Reward Ledger, Per-Component Refunds, and Cap-Pool Attribution Specification

**Status**: Target Normative Specification (Amended)
**Version**: 0.6.0
**Target Repository**: `taiwan-card-rewards-mcp`
**Conforms to**: [`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md), [ADR 0003](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md), [ADR 0004](../adr/0004-generic-benefit-status-and-schema-v2.md), [ADR 0005](../adr/0005-payment-route-opportunity-stacking.md), [ADR 0006](../adr/0006-multi-component-reward-ledger-and-cap-attribution.md), and [Schema v2 Specification](card-rewards-schema-v2-specification.md).

---

## 1. Introduction and Scope

### 1.1 Purpose
This specification formalizes the **v0.6.0 Multi-Component Reward Ledger** for `taiwan-card-rewards-mcp`. It establishes the normative data models, composite component identities, ledger storage structures, proportional refund algorithms, shared cap pool attribution rules, and backward compatibility invariants for transactions that yield multiple stacked reward components across payment routes, wallets, merchant loyalty programs, and bank card issuers (conforming to ADR 0005 and `CONTEXT.md`).

### 1.2 Normative Language
The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) and [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt).

### 1.3 Scope
- Data contracts for multi-component purchases and refunds.
- Composite component identity `(transactionId, ruleId, ruleVersion)` with collision-safe canonical encoding.
- Cardinality invariant `(transactionId, ruleId) <= 1` across applied rules.
- Separate top-level `rewardComponents` durable collection and referential integrity.
- Attribution of cap pool consumption across independent and shared cap pools.
- Exact integer proportional partial refund and remainder balancing algorithms.
- Deduplication of `spend` and `transaction_count` metrics on shared pools.
- Heterogeneous native reward unit handling without lossy forced summation.
- Public MCP tool response compatibility (`record_transaction`, `recommend`, `calculate_reward`, `rank_cards`, `remaining_caps`).
- Legacy single-rule record compatibility and fail-closed boundaries.

---

## 2. Ledger Architecture and Data Models

### 2.1 Storage Collections and Relationships

In v0.6.0, `StoredState` introduces a dedicated `rewardComponents` collection linked directly to `transactions`.

```
┌────────────────────────────────────────┐
│             StoredState                │
├────────────────────────────────────────┤
│  - schemaVersion: 2                    │
│  - cards: CardDescriptor[]             │
│  - rules: OfferRuleVersion[]           │
│  - capPools: CapPoolDefinition[]       │
│  - transactions: TransactionRecord[]   │ 1
│  - rewardComponents: ComponentRecord[] ├───┐ (1:N referential relationship)
│  - cardSwitches: BenefitStatus[]       │   │
└────────────────────────────────────────┘   │
                                             ▼
┌────────────────────────────────────────────────────────────────────────┐
│                       RewardComponentRecord                            │
├────────────────────────────────────────────────────────────────────────┤
│  - componentId: string (Canonical: enc(txId):enc(ruleId):enc(version)) │
│  - transactionId: string (FK -> transactions.id; immutable identity)   │
│  - ruleId: string (FK -> rules.id)                                     │
│  - ruleVersion: string                                                 │
│  - route: 'merchant' | 'payment_provider' | 'card_issuer'              │
│  - provider?: string (e.g. 'wowprime', 'pxpayplus', 'cathaybk')        │
│  - reward: RewardAmount ({ value, unitType, unitName, currency })      │
│  - capUsages: ComponentCapUsage[]                                      │
│  - appliedAtUtc: string (ISO 8601 UTC)                                 │
└────────────────────────────────────────────────────────────────────────┘
```

### 2.2 TypeScript Data Contracts and Identity Encoding

#### Composite Identity and Encoding
Each `RewardComponentRecord` has a logical composite identity tuple `(transactionId, ruleId, ruleVersion)`.
To eliminate delimiter collision risks across IDs containing colons, dashes, or special characters, the primary key `componentId` MUST be generated using the canonical collision-safe encoding:
$$\text{componentId} = \text{encodeURIComponent}(\text{transactionId}) + \text{":"} + \text{encodeURIComponent}(\text{ruleId}) + \text{":"} + \text{encodeURIComponent}(\text{ruleVersion})$$

#### Data Structures
```typescript
export type PaymentRouteLayer = 'merchant' | 'payment_provider' | 'card_issuer';

export interface ComponentCapUsage {
  poolId: string;
  periodKey: string; // e.g. "2026-09" or billing cycle key "2026-09-15"
  metric: 'reward' | 'spend' | 'transaction_count';
  /**
   * For 'reward': reward value consumed.
   * For 'spend': qualifying spend consumed.
   * For 'transaction_count': transaction count consumed (0 or 1).
   */
  consumedAmount: number;
}

export interface RewardComponentRecord {
  /**
   * Primary key: Collision-safe canonical encoding of (transactionId, ruleId, ruleVersion)
   * `${encodeURIComponent(transactionId)}:${encodeURIComponent(ruleId)}:${encodeURIComponent(ruleVersion)}`
   */
  componentId: string;
  /**
   * Durable persisted transaction identity; immutable across retries.
   * Matches TransactionRecord.id / idempotencyKey for actual records.
   */
  transactionId: string;
  ruleId: string;
  ruleVersion: string;
  route: PaymentRouteLayer;
  provider?: string | undefined;
  reward: RewardAmount;
  capUsages: readonly ComponentCapUsage[];
  appliedAtUtc: string;
}

export interface TransactionRecordV2 {
  id: string; // Durable transaction identity (matches idempotencyKey)
  kind: 'purchase' | 'refund';
  mode: 'actual';
  cardId: string;
  occurredAt: string; // ISO 8601 UTC
  timezone: string; // e.g. "Asia/Taipei"
  settlementAmountMinor: number;
  settlementCurrency: string;
  originalAmountMinor?: number | undefined;
  originalCurrency?: string | undefined;
  idempotencyKey: string;

  // Refund-specific linkage
  refundOfId?: string | undefined; // FK -> original purchase transactionId
  refundProportion?: number | undefined; // Ratio in basis points (10000 = 100%) or rational

  // Multi-component linkage
  componentIds: readonly string[];

  // Legacy compatibility fields (preserved for existing readers)
  ruleId?: string | undefined;
  ruleVersion?: string | undefined;
  rewardMinor?: number | undefined;

  recordedAtUtc: string;
}
```

---

## 3. Accounting Boundaries & Cardinality Invariants

### 3.1 Strict Accounting Invariant
1. **Applied Rules Only**: ONLY rules that have successfully passed the Combination Policy Resolver and are marked as *actually applied* to the transaction SHALL generate `RewardComponentRecord`s and consume cap pools.
2. **Exclusion of Candidates**: Candidate offers, action-required offers (`availableAfterActions`), and matching rules discarded by combination policies (`replace`, `best_of` alternatives, or unmet `prerequisite`s) MUST NOT be written to `rewardComponents` and MUST NOT alter any cap pool balance.
3. **Optional Calculation Traces**: Traces of unapplied or discarded candidate rules MAY be returned in the transient ephemeral JSON-RPC calculation breakdown for user transparency, but MUST NOT be persisted to durable state.

### 3.2 Cardinality Invariant `(transactionId, ruleId) <= 1`
For any given transaction $T$, the ledger MUST enforce that at most one component exists per `ruleId`:
$$\forall T, \forall R \in \text{Rules}, \quad |\{ C \in \text{Components}(T) \mid C.\text{ruleId} = R.\text{id} \}| \le 1$$

If multiple versions of the same rule or contradictory rule evaluations attempt to record more than one component for the same `(transactionId, ruleId)` tuple, the evaluator and ledger write MUST fail closed with status `needs_review` and error `CARDINALITY_CONFLICT`.

---

## 4. Multi-Unit and Currency Handling

### 4.1 Heterogeneous Native Rewards
When a transaction triggers multiple components across layers, each component yields rewards in its native unit (per `CONTEXT.md` Reward Unit definition):
- **Merchant Layer**: e.g., 30 點 瘋點數 (`unitType: 'point'`, `unitName: '瘋點數'`).
- **Payment Provider Layer**: e.g., 50 點 全點 (`unitType: 'point'`, `unitName: '全點'`).
- **Card Issuer Layer**: e.g., 9000 minor TWD (90.00 TWD) (`unitType: 'currency'`, `unitName: 'TWD'`).

### 4.2 Prohibition of Forced Summation
1. The ledger and calculation engine MUST NOT coerce or collapse different `unitName`s or `currency` codes into a single scalar value without an explicit, provenance-bearing valuation snapshot.
2. Transient calculation responses (`calculate_reward`, `recommend`, `rank_cards`) and persistent query responses (`record_transaction`, `remaining_caps`) MUST return an array of component breakdowns grouped by native unit.

---

## 5. Proportional Partial Refund Algorithm

### 5.1 Refund Principles
1. **Immutable Snapshot Basis**: A refund MUST be calculated strictly against the original `RewardComponentRecord`s captured at the time of the purchase. It MUST NOT re-evaluate present-day rules, active campaigns, or current benefit states.
2. **Fixed Rounding with Final-Step Remainder Balancing**:
   - For partial refund ratio $\rho = \frac{\Delta S_{\text{refund}}}{S_{\text{original}}}$ ($0 < \rho \le 1$):
   - For intermediate refunds, the reversed reward for component $k$ is:
     $$R_{\text{rev}, k} = \lfloor R_{\text{orig}, k} \times \rho \rfloor$$
   - The system tracks cumulative reversed rewards per component $\sum R_{\text{rev}, k}$.
   - Upon the final refund (when cumulative refunded spend reaches $S_{\text{original}}$), the remainder adjustment is applied to prevent point leakage or rounding drift:
     $$R_{\text{final}, k} = R_{\text{orig}, k} - \sum_{\text{prior}} R_{\text{rev}, k}$$
3. **Cap Pool Restoration**: Each component reverses its recorded `capUsages` in exact proportion to the refund, restoring headroom to the original historical `(poolId, periodKey)`.
4. **Idempotency**: Repeated submission of a refund with the same `idempotencyKey` and identical payload MUST return the existing refund record without double-restoring caps. Mismatched payloads with the same key MUST fail closed (`IDEMPOTENCY_CONFLICT`).

---

## 6. Shared Cap Pool Attribution and Deduplication

### 6.1 Unique Period Aggregation Key
Cap pool usage is aggregated strictly by the tuple:
$$\text{AggregationKey} = (\text{poolId}, \text{periodKey})$$
where `periodKey` is deterministically resolved from the transaction's `occurredAt` and the pool's `period` kind (`calendar_month`, `billing_cycle`, `quarter`, `year`, `campaign`) in the rule's resolved timezone.

### 6.2 Deduplication of Spend and Transaction Count Metrics
When multiple applied rules on a single transaction reference the same `CapPoolDefinition`:
1. **`reward` Metric**:
   - Each rule consumes the reward pool by its own earned reward amount:
     $$\Delta \text{Usage}(\text{pool}) = \sum_{C \in \text{Components}} C.\text{reward}.\text{value}$$
2. **`spend` Metric**:
   - Qualifying spend against a shared spend pool is consumed **exactly once per transaction**, NOT multiplied by the number of applied rules:
     $$\Delta \text{Usage}(\text{pool}) = S_{\text{qualifying}}$$
3. **`transaction_count` Metric**:
   - A single transaction consumes **exactly 1 count** from a shared count pool, regardless of how many matching rules reference that pool:
     $$\Delta \text{Usage}(\text{pool}) = 1$$

### 6.3 Atomicity and Rollback
All cap updates across all referenced pools MUST be committed atomically with the transaction and component records. If any cap constraint fails closed during validation, no state mutation SHALL occur.

---

## 7. Atomic Persistence and Referential Integrity

### 7.1 Referential Invariants
1. Every `RewardComponentRecord.transactionId` MUST reference a valid `TransactionRecord.id`.
2. Every `RewardComponentRecord.ruleId` MUST reference an existing `OfferRuleVersion.id`.
3. Every `TransactionRecord.componentIds` array MUST exactly match the set of components having `transactionId === TransactionRecord.id`.
4. Deleting or overwriting individual component records independently of their parent transaction is strictly prohibited.

### 7.2 Storage File Format
In the single-tenant JSON store (`card-rewards.json`), components are stored under the top-level key `rewardComponents`:
```json
{
  "schemaVersion": 2,
  "cards": [...],
  "rules": [...],
  "capPools": [...],
  "transactions": [...],
  "rewardComponents": [...],
  "cardSwitches": [...]
}
```

---

## 8. Legacy Compatibility and Fail-Closed Boundaries

### 8.1 Backward Compatibility with v0.4.0 / v0.5.0 Records
1. Legacy transactions created without `rewardComponents` (having only `ruleId` and `rewardMinor`) remain readable.
2. In-memory and API queries for legacy records populate a synthetic single-component view:
   - `componentId`: `${encodeURIComponent(tx.id)}:${encodeURIComponent(tx.ruleId || 'legacy-rule')}:${encodeURIComponent(tx.ruleVersion || '1.0.0')}`
   - `transactionId`: `tx.id`
   - `route`: `'card_issuer'`
   - `reward`: `{ value: tx.rewardMinor || 0, unitType: 'currency', unitName: tx.settlementCurrency, currency: tx.settlementCurrency }`
3. **Fail-Closed on Granular Legacy Operations**: Any operation requiring per-component refund precision or per-route cap reconciliation on a legacy transaction that lacks component breakdowns MUST fail closed with `needs_review` and diagnostic reason `"Legacy transaction lacks granular component breakdown"`. The system MUST NOT guess historical component splits.

---

## 9. Public MCP Response Compatibility (Version 0.6.0)

All 10 public MCP tools retain full wire compatibility:

1. **`record_transaction`**:
   - Returns the created `transaction` record along with `components: RewardComponentRecord[]` and updated `capBalances`.
2. **`recommend` & `calculate_reward`**:
   - Returns `appliedComponents: RewardComponentRecord[]` and `candidateComponents: CandidateTrace[]` alongside aggregated `netReward` summaries.
3. **`remaining_caps`**:
   - Queries real-time headroom across all registered `CapPoolDefinition`s for the card's active period.

---

## 10. Phased Roadmap: Mixed Native Reward Model

To ensure steady, incremental delivery, the multi-unit reward model is phased as follows:

| Phase | Target Version | Capability | Status |
|---|:---:|---|:---:|
| **Phase 1** | **v0.6.0** | Independent native reward components, composite component identity `(txId, ruleId, version)`, per-component ledger persistence, exact proportional refunds, shared cap pool deduplication, and zero-coercion reporting. | **Target (This Spec)** |
| **Phase 2** | **v0.7.0+** | Optional user-configured `RewardValuation` snapshots (e.g. 1 點小樹點 = 1.0 TWD, 1 哩 = 0.5 TWD) enabling deterministic estimated total comparison in user's preferred currency, with mandatory valuation provenance. | Future Extension |

---

## 11. Concrete Acceptance Test Scenarios

### Scenario 1: Triple-Stack Purchase Recording
- **Transaction**: NT$2,000 spend (`txId: "tx-01"`) at 王品牛排 using 瘋 Pay bound to CUBE Card.
- **Rules Applied**:
  1. `rule-wow-loyalty` (v1.0.0): 3% 瘋點數 $\rightarrow$ 60 點 瘋點數 (`route: 'merchant'`).
  2. `rule-wowpay-bank` (v1.0.0): 5% 瘋點數 $\rightarrow$ 100 點 瘋點數 (`route: 'payment_provider'`, consumes `pool-wowpay-monthly`).
  3. `rule-cube-dining` (v2.0.0): 3% 小樹點 $\rightarrow$ 60 點 小樹點 (`route: 'card_issuer'`, consumes `pool-cube-general`).
- **Ledger Output**:
  - `transactions`: 1 record with `id: "tx-01"` and `componentIds: ["tx-01:rule-wow-loyalty:1.0.0", "tx-01:rule-wowpay-bank:1.0.0", "tx-01:rule-cube-dining:2.0.0"]`.
  - `rewardComponents`: 3 distinct records with respective composite IDs.
  - Cap pools `pool-wowpay-monthly` and `pool-cube-general` each updated accurately.

### Scenario 2: Proportional Partial Refund (50%)
- **Transaction**: NT$1,000 partial refund of Scenario 1 ($\rho = 0.5$).
- **Expected Refund Components**:
  1. `rule-wow-loyalty`: $\lfloor 60 \times 0.5 \rfloor = 30$ 點 瘋點數 reversed.
  2. `rule-wowpay-bank`: $\lfloor 100 \times 0.5 \rfloor = 50$ 點 瘋點數 reversed; `pool-wowpay-monthly` restores 50.
  3. `rule-cube-dining`: $\lfloor 60 \times 0.5 \rfloor = 30$ 點 小樹點 reversed; `pool-cube-general` restores 30.

### Scenario 3: Shared Spend Pool Deduplication
- **Transaction**: NT$5,000 spend matching two rules ($R_A$ and $R_B$) sharing `pool-overseas-spend` (metric: `spend`, limit: NT$20,000).
- **Expected Result**: `pool-overseas-spend` consumption increases by exactly NT$5,000 (NOT NT$10,000).

---

## 12. Document History and Cross-References

| Version | Date | Author / Role | Changes |
|---|---|---|---|
| 0.6.0 | 2026-09-04 | Source & Policy Researcher | Initial target specification for multi-component reward ledger, per-component refunds, and cap-pool attribution. |
| 0.6.0-rev1 | 2026-09-05 | Source & Policy Researcher | Spec amendment: Composite component identity `(txId, ruleId, version)` with collision-safe canonical encoding and `(txId, ruleId) <= 1` cardinality invariant. |

**Cross References**:
- [`CONTEXT.md`](../../CONTEXT.md): Root Domain Glossary and Invariants (Reward Component terminology).
- [`docs/adr/0005-payment-route-opportunity-stacking.md`](../adr/0005-payment-route-opportunity-stacking.md): Payment Route Opportunity Stacking Decision.
- [`docs/adr/0006-multi-component-reward-ledger-and-cap-attribution.md`](../adr/0006-multi-component-reward-ledger-and-cap-attribution.md): Multi-Component Ledger Decision.
- [`docs/specs/card-rewards-schema-v2-specification.md`](card-rewards-schema-v2-specification.md): Base Schema v2 Specification.
- [`docs/research/wallet-and-merchant-app-stacked-rewards.md`](../research/wallet-and-merchant-app-stacked-rewards.md): Payment Wallet Research Notes.
