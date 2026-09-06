# Agent-Supplied FX Lookup, Provenance, Freshness, and Fail-Closed Boundary Specification

> **Policy amendment**：匯率儲存與 scope 的簡化規則以
> [FX Snapshot 儲存與 Current Rate 簡化政策](fx-snapshot-storage-and-current-rate-policy-specification.md)
> 為準；本文件仍規範 pair validation、freshness、整數計算與 fail-closed
> 語意。兩者衝突時，以修訂文件為準。

**Status**: Target Normative Specification
**Version**: 0.6.0 Target
**Target Repository**: `taiwan-card-rewards-mcp`
**Conforms to**: [`CONTEXT.md`](../../CONTEXT.md), [ADR 0001](../adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md), [ADR 0003](../adr/0003-complete-initial-mcp-surface-with-layered-trust-gates.md), [ADR 0004](../adr/0004-generic-benefit-status-and-schema-v2.md), [ADR 0005](../adr/0005-payment-route-opportunity-stacking.md), [ADR 0006](../adr/0006-multi-component-reward-ledger-and-cap-attribution.md), [Schema v2 Specification](card-rewards-schema-v2-specification.md), and [Multi-Component Ledger Spec](multi-component-ledger-and-cap-attribution-specification.md).

---

## 1. Introduction and Scope

### 1.1 Purpose
This specification formalizes the **Foreign Exchange (FX) Data Contract, Provenance Protocol, Freshness Window, and Fail-Closed Evaluation Boundary** for `taiwan-card-rewards-mcp`. It establishes the strict architectural boundary between external AI Agents (responsible for live FX retrieval and provenance capture) and the MCP Calculation Core (responsible for pure, deterministic integer currency conversion and fail-closed state validation).

### 1.2 Normative Language
The key words **MUST**, **MUST NOT**, **REQUIRED**, **SHALL**, **SHALL NOT**, **SHOULD**, **SHOULD NOT**, **RECOMMENDED**, **NOT RECOMMENDED**, **MAY**, and **OPTIONAL** in this document are to be interpreted as described in [RFC 2119](https://www.ietf.org/rfc/rfc2119.txt) and [RFC 8174](https://www.ietf.org/rfc/rfc8174.txt).

### 1.3 Scope
- Strict responsibility partition between AI Agent (retrieval/provenance) and MCP Server (pure calculation).
- Formal `FxSnapshot` data contract including base/quote pairs, PPM rate encoding, TTL freshness windows, provider identity, and source provenance.
- Resolution of FX evaluation states (`fresh`, `stale`, `missing`, `mismatched_pair`, `scope_mismatch`, `conflict`).
- Deterministic fixed-point integer arithmetic specification for cross-currency reward calculation.
- Agent interactive retry and disambiguation protocols upon encountering fail-closed responses.
- Separation of future `FxAndValuationBook` provider adapters from core stateless evaluation.

---

## 2. Architectural Boundary & Responsibility Partition

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                 AI Agent / Client Layer                                │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Discovers cross-currency transaction need (tx.amount.currency != rule.settlement)   │
│  2. Queries official/approved rate source (e.g. Bank of Taiwan, E.Sun, Mega Bank, API) │
│  3. Converts exchange rate to integer Parts-Per-Million: ratePpm = round(rate * 1e6)   │
│  4. Packages immutable FxSnapshot with full provenance metadata                       │
│  5. Injects FxSnapshot into transaction.fx argument in MCP tool call                   │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │ JSON-RPC Tool Invocation (tx.fx)
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                        MCP Server / Deterministic Engine                               │
├────────────────────────────────────────────────────────────────────────────────────────┤
│  1. Zero Network I/O: NEVER performs HTTP requests, web scraping, or remote lookups   │
│  2. Zero Guessing: NEVER guesses missing rates, defaults to 1.0, or silently assumes   │
│  3. Validates Currency Pair: verifies fx.base == tx.amount & fx.quote == rule.settle   │
│  4. Validates Scope: checks optional cardIdScope / issuerScope matching                │
│  5. Evaluates Freshness: verifies |tx.occurredAt - fx.capturedAt| <= maxAgeSeconds     │
│  6. Computes Integer Conversion: Math.floor((amountMinor * ratePpm) / 1_000_000)       │
│  7. Enforces Fail-Closed: returns unknown / stale / needs_review on any violation      │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

### 2.1 Agent / Client Layer Responsibilities
1. **Source Retrieval**: The AI Agent or calling application SHALL obtain live or historical exchange rate quotes from approved primary sources (such as bank official rate boards, central bank publications, or designated market data APIs).
2. **PPM Rate Quantization**: The Agent MUST convert floating-point exchange rates ($R = \frac{\text{Quote}}{\text{Base}}$) into an unsigned integer Parts-Per-Million value:
   $$\text{ratePpm} = \lfloor R \times 1,000,000 + 0.5 \rfloor$$
3. **Provenance Attribution**: The Agent MUST attach provider identity (`provider`), capture timestamp (`capturedAt`), and SHOULD attach the source URL (`sourceUrl`) and quote type (`rateType`).
4. **Interactive Recovery**: When receiving a fail-closed status from the MCP server, the Agent MUST prompt the user for clarification or refresh the FX snapshot rather than fabricating numbers.

### 2.2 MCP Core Invariants
1. **Zero Remote I/O**: The MCP evaluation core (`RewardCalculator`, `evaluateOffer`, `rankCards`, `recommend`) MUST NOT initiate network requests, file-system scrapes, or dynamic external calls to fetch exchange rates.
2. **Zero Default Guessing**: If a transaction involves a currency conversion and lacks an eligible, fresh `FxSnapshot`, the engine MUST NOT fall back to a default $1:1$ parity, cached implicit rate, or approximate valuation.
3. **Stateless Snapshot Consumption**: All FX data utilized in evaluation MUST be supplied directly via the input payload (`transaction.fx` or `context.fxSnapshots`).
4. **Future Adapter Separation**: Future internal provider adapters or an `FxAndValuationBook` module MUST remain strictly decoupled from the core evaluator and generate the identical `FxSnapshot` contract defined herein.

---

## 3. Data Contract: `FxSnapshot` Specification

### 3.1 TypeScript Schema

```typescript
export type FxRateType = 'cash_selling' | 'spot_selling' | 'mid_market' | 'card_scheme';

export interface FxSnapshot {
  /** Unique snapshot identifier (e.g. "fx-bot-jpy-twd-20260905") */
  id: string;

  /**
   * Transaction spend currency (ISO 4217, 3-letter uppercase).
   * Must match tx.amount.currency.
   */
  baseCurrency: string;

  /**
   * Rule settlement currency (ISO 4217, 3-letter uppercase).
   * Must match rule.settlementCurrency.
   */
  quoteCurrency: string;

  /**
   * Exchange rate in Parts-Per-Million (PPM).
   * e.g., 0.2150 TWD per 1 JPY -> ratePpm = 215000.
   * Integer bounded: 1 <= ratePpm <= 1,000,000,000,000.
   */
  ratePpm: number;

  /** ISO 8601 UTC timestamp when rate was captured */
  capturedAt: string;

  /**
   * Maximum acceptable validity window in seconds.
   * Default: 604,800 (7 days) if omitted.
   */
  maxAgeSeconds?: number | undefined;

  /** Primary source provider name (e.g. "bank_of_taiwan", "esun_bank", "visa_scheme") */
  provider?: string | undefined;

  /** Source quotation type */
  rateType?: FxRateType | undefined;

  /** Direct primary source reference or URL */
  sourceUrl?: string | undefined;

  /** Content hash or fingerprint of the source rate table for auditability */
  contentHash?: string | undefined;

  /** Optional restriction: snapshot is only valid for this specific Card ID */
  cardIdScope?: string | undefined;

  /** Optional restriction: snapshot is only valid for cards from this Issuer */
  issuerScope?: string | undefined;
}
```

### 3.2 Canonical Currency Conversion Arithmetic
When `tx.amount.currency !== rule.settlementCurrency`, the converted settlement amount in minor units MUST be calculated as:
$$\text{settlementAmountMinor} = \left\lfloor \frac{\text{tx.amount.amountMinor} \times \text{tx.fx.ratePpm}}{1,000,000} \right\rfloor$$

All intermediate multiplications and divisions MUST use safe 64-bit integer arithmetic to prevent floating-point rounding divergence.

---

## 4. Evaluation States & Fail-Closed Boundary

When evaluating an offer rule against a transaction, the engine evaluates the FX context across five deterministic states:

```
                                  Cross-Currency Required?
                                        │
                       ┌────────────────┴────────────────┐
                      No                                Yes
                       │                                 │
                 [No FX Needed]                    tx.fx Provided?
                 Proceed Normal                          │
                                        ┌────────────────┴────────────────┐
                                       No                                Yes
                                        │                                 │
                                [Status: UNKNOWN]                  Currency Pair Match?
                                "missing FX snapshot"                     │
                                                         ┌────────────────┴────────────────┐
                                                        No                                Yes
                                                         │                                 │
                                                 [Status: UNKNOWN]                  Scope Match?
                                                 "mismatched pair"                         │
                                                                          ┌────────────────┴────────────────┐
                                                                         No                                Yes
                                                                          │                                 │
                                                                  [Status: NEEDS_REVIEW]             Freshness Valid?
                                                                  "scope mismatch"                          │
                                                                                           ┌────────────────┴────────────────┐
                                                                                          No                                Yes
                                                                                           │                                 │
                                                                                   [Status: STALE]                   [Status: FRESH]
                                                                                   "snapshot stale"                  Convert & Proceed
```

### 4.1 State Definitions and Engine Actions

| State | Condition | Evaluation Status | Resulting `unknownReasons` | Engine Behavior |
|---|---|:---:|---|---|
| **`fresh`** | Currency pairs match, scope matches, and $|T_{\text{tx}} - T_{\text{fx}}| \le \text{maxAge}$ | `ok` (if matching) | `[]` | Converts currency using `ratePpm` and proceeds with reward calculation. |
| **`missing`** | `tx.amount.currency !== rule.settlementCurrency` and `tx.fx` is undefined | `unknown` | `["missing FX snapshot for settlement currency"]` | Fails closed; reward is NOT calculated; returns `status: 'unknown'`. |
| **`mismatched_pair`** | `fx.baseCurrency !== tx.amount.currency` OR `fx.quoteCurrency !== rule.settlementCurrency` | `unknown` | `["FX currency pair does not match settlement currency"]` | Fails closed; mismatched conversion rejected. |
| **`scope_mismatch`** | `fx.cardIdScope` defined and $\ne \text{tx.cardId}$, or `fx.issuerScope` defined and $\ne \text{card.issuer}$ | `needs_review` | `["FX snapshot scope does not match card or issuer"]` | Fails closed; requires human review or correct scoped rate. |
| **`stale`** | $|T_{\text{tx}} - T_{\text{fx}}| > \text{maxAgeSeconds}$ | `stale` | `["FX snapshot is stale"]` | Fails closed; prompts Agent to fetch fresh rate snapshot. |
| **`conflict`** | Multiple conflicting FX snapshots supplied for the same currency pair | `needs_review` | `["conflicting FX snapshots provided"]` | Fails closed; rejects ambiguous rates. |

---

## 5. Agent Interactive Protocol & Recovery Workflow

When an AI Agent receives an evaluation result with non-`ok` status caused by FX conditions, it MUST execute the following deterministic protocol:

### 5.1 Protocol on `status: 'unknown'` (`missing` or `mismatched_pair`)
1. Extract required currency pair: $\text{Base} = \text{tx.amount.currency}$, $\text{Quote} = \text{rule.settlementCurrency}$.
2. Query the official bank exchange rate for the transaction's target date.
3. If an authoritative rate is obtained, construct `FxSnapshot` and re-invoke MCP tool (`calculate_reward` / `recommend`).
4. If rate is unavailable, prompt user:
   > *"這筆交易為日圓 (JPY) 消費，需以台灣發卡行台幣 (TWD) 結算。請確認當前適用匯率或允許使用即時台銀牌告匯率（例如 1 JPY = 0.215 TWD）。"*

### 5.2 Protocol on `status: 'stale'`
1. Inspect `fx.capturedAt` and determine that the rate exceeds the allowable TTL (default 7 days).
2. Fetch an updated FX snapshot from the designated official source matching `tx.occurredAt`.
3. If retroactively auditing an old transaction, set `maxAgeSeconds` explicitly to encompass the historical settlement window with user consent.

---

## 6. Public MCP Schema Alignment

In accordance with [MCP Contract Analysis](../research/mcp-contract-agent-failure-analysis.md), `tools/list` MUST fully expose `fx` inside `transaction.properties`:

```json
{
  "fx": {
    "type": "object",
    "description": "Foreign exchange rate snapshot for cross-currency settlement",
    "required": ["id", "baseCurrency", "quoteCurrency", "ratePpm", "capturedAt"],
    "properties": {
      "id": { "type": "string", "description": "Unique snapshot identifier" },
      "baseCurrency": { "type": "string", "description": "3-letter uppercase ISO currency of transaction spend" },
      "quoteCurrency": { "type": "string", "description": "3-letter uppercase ISO currency of card settlement" },
      "ratePpm": { "type": "integer", "minimum": 1, "description": "Exchange rate in Parts-Per-Million (1.0 = 1,000,000)" },
      "capturedAt": { "type": "string", "format": "date-time", "description": "ISO 8601 UTC timestamp of rate quotation" },
      "maxAgeSeconds": { "type": "integer", "minimum": 1, "description": "Validity TTL in seconds (default 604800)" },
      "provider": { "type": "string", "description": "Official exchange rate provider name" },
      "rateType": { "type": "string", "enum": ["cash_selling", "spot_selling", "mid_market", "card_scheme"] },
      "sourceUrl": { "type": "string", "format": "uri", "description": "Direct URL to official rate table" }
    }
  }
}
```

---

## 7. Concrete Acceptance Test Scenarios

### Scenario 1: Valid JPY Spend on TWD Card (Fresh FX)
- **Input**:
  - `tx.amount`: `{ amountMinor: 1000000, currency: "JPY" }` (10,000 JPY)
  - `rule.settlementCurrency`: `"TWD"`
  - `tx.occurredAt`: `"2026-09-05T12:00:00Z"`
  - `tx.fx`: `{ id: "fx-01", baseCurrency: "JPY", quoteCurrency: "TWD", ratePpm: 215000, capturedAt: "2026-09-05T10:00:00Z", maxAgeSeconds: 86400 }`
- **Expected Converted Amount**:
  $$\text{settlementAmountMinor} = \lfloor (1,000,000 \times 215,000) / 1,000,000 \rfloor = 215,000 \text{ minor TWD (NT\$2,150.00)}$$
- **Outcome**: `status: 'ok'`, reward evaluated against NT$2,150.

### Scenario 2: Stale FX Snapshot
- **Input**: `tx.occurredAt: "2026-09-05T12:00:00Z"`, `tx.fx.capturedAt: "2026-08-01T00:00:00Z"`, `maxAgeSeconds: 604800` (35 days old).
- **Outcome**: `status: 'stale'`, `unknownReasons: ["FX snapshot is stale"]`.

### Scenario 3: Missing FX on Cross-Currency Transaction
- **Input**: `tx.amount.currency: "USD"`, `rule.settlementCurrency: "TWD"`, `tx.fx: undefined`.
- **Outcome**: `status: 'unknown'`, `unknownReasons: ["missing FX snapshot for settlement currency"]`. Zero reward credited.

---

## 8. Document History & References

| Version | Date | Author / Role | Changes |
|---|---|---|---|
| 0.6.0 | 2026-09-05 | Source & Policy Researcher | Initial target specification for Agent-supplied FX lookup, provenance, freshness, and fail-closed boundary. |

**Cross References**:
- [`CONTEXT.md`](../../CONTEXT.md): Root Domain Context & Invariants.
- [`docs/design/codebase-design.md`](../design/codebase-design.md): Seam and Adapter Placement.
- [`docs/research/fx-lookup-and-merchant-identity-research.md`](../research/fx-lookup-and-merchant-identity-research.md): Primary Source Research.
- [`docs/specs/card-rewards-schema-v2-specification.md`](card-rewards-schema-v2-specification.md): Schema v2 Base Specification.
