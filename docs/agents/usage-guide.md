# AI Agent Usage Guide for `taiwan-card-rewards-mcp`

`taiwan-card-rewards-mcp` provides a deterministic calculation engine and user-scoped durable ledger for Taiwan credit-card rewards. It operates as a single-tenant stdio MCP server under strict privacy, input validation, and fail-closed safety boundaries.

---

## 1. Architectural Philosophy & Agent Responsibilities

The system enforces a strict separation of concerns between the AI Agent and the MCP server:

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           AI Agent / AionCore                           │
│  - Natural language conversation & intent elicitation                   │
│  - Multi-modal perception (Image / PDF / OCR processing outside MCP)    │
│  - Candidate rule transcription & structured argument preparation       │
│  - User confirmation dialog & preference clarification                  │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │ JSON-RPC over stdio
                                     ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                        taiwan-card-rewards-mcp                          │
│  - Pure, deterministic calculation & uncertainty-aware ranking (Top-5) │
│  - User-scoped JSON ledger (cards, snapshots, rules, transactions)     │
│  - Exclusive process locking & atomic file persistence                  │
│  - Official source governance & calculation trust gates                 │
│  - Idempotent purchase recording & refund cap reconciliation           │
│  - Fail-closed evaluation & strict sensitive-field rejection            │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Installation & Startup Contract

For a GitHub checkout, run `npm ci --ignore-scripts && npm run build`, then configure the host with `node dist/cli.js`. Git-based `npx` installation is also supported: npm runs the package `prepare` script and builds `dist/` automatically.

```bash
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#main \
  --data-dir /absolute/existing/tenant-directory
```

Pin a release tag for repeatable use:

```bash
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#v0.2.2 \
  --data-dir /absolute/existing/tenant-directory
```

### Process Boundary & Single-Tenant Scope
- **Transport**: Standard I/O only (`stdio` newline-delimited JSON-RPC). No HTTP, SSE, or network ports are opened.
- **Tenant Isolation**: The parent process launches **one independent MCP process per user**, bound to a dedicated `--data-dir`.
- **Exclusive Lock**: Upon startup, the process acquires an exclusive file lock (`card-rewards.lock`) in its `--data-dir`. Concurrent processes sharing the same directory are rejected (`LOCK_EXISTS`).

### Command & Arguments

```bash
node dist/cli.js --data-dir <absolute-path> [--user <user-id>]
```

| Argument | Requirement | Description |
|---|:---:|---|
| `--data-dir <path>` | **Required** | Absolute, existing directory for user storage. Canonicalized via `realpath`; filesystem roots (`/`) are rejected. Tools cannot override this path. |
| `--user <id>` | **Optional** | Display and audit log metadata only. Never used as an access control or storage partition selector. |

---

## 3. The MCP Tool Surface

The MCP server exposes the 9 reward tools plus two card-switch tools. Standalone `confirm_offer` is not part of the surface; candidate activation is folded directly into `upsert_offer`.

| Tool Name | Persistence | Description | Key Fail-Closed Errors |
|---|:---:|---|---|
| `calculate_reward` | Read-only | Pure stateless evaluation of a rule against a transaction with evaluation context. | `INSUFFICIENT_FACTS`, `SOURCE_UNAVAILABLE`, `NEEDS_REVIEW`, `STALE` |
| `rank_cards` | Read-only | Pure stateless deterministic ranking (Top-5) across supplied cards and rules. | `INSUFFICIENT_FACTS`, `SOURCE_UNAVAILABLE`, `NEEDS_REVIEW`, `STALE` |
| `register_card` | Mutating | Register or update a card product descriptor (`id`, `issuer`, `productName`, `network`, `country`). | `INVALID_CARD`, `STORE_UNAVAILABLE` |
| `list_cards` | Read-only | List all registered cards in the user's store. | `STORE_UNAVAILABLE` |
| `upsert_offer` | Mutating | Ingest an official or candidate source snapshot and versioned rule; activates candidate if valid confirmation is supplied. | `INVALID_OFFER`, `INVALID_CONFIRMATION`, `STORE_UNAVAILABLE` |
| `recommend` | Read-only | Recommend up to 5 cards evaluated against registered cards and actual ledger usage without mutating usage. | `INSUFFICIENT_FACTS`, `NEEDS_REVIEW`, `STALE` |
| `record_transaction` | Mutating | Record an actual purchase (with `idempotencyKey`) or linked refund, updating durable cap usage. | `IDEMPOTENCY_CONFLICT`, `INVALID_REFUND`, `INSUFFICIENT_FACTS`, `NEEDS_REVIEW` |
| `remaining_caps` | Read-only | Query remaining reward cap balances per rule and usageKey derived from actual transactions. | `INVALID_INPUT`, `STORE_UNAVAILABLE` |
| `get_card_switch_status` | Read-only | Show latest confirmed switch, available candidates, and unavailable campaigns with reasons. | `CARD_NOT_FOUND`, `STORE_UNAVAILABLE` |
| `upsert_card_switch` | Mutating | Record or adjust a user-confirmed completed bank-app switch with idempotency. | `CARD_NOT_FOUND`, `INVALID_CONFIRMATION`, `IDEMPOTENCY_CONFLICT` |

---

## 4. Workflow Guidelines for AI Agents

### A. Card Management & Discovery
1. Call `list_cards` to inspect existing cards held by the user.
2. If the user holds a new card, call `register_card` with card descriptors (e.g. `{ id: "esun-kumamon", issuer: "ESunBank", productName: "Kumamon Card", network: "JCB", country: "TW" }`).

### B. Offer Ingestion, OCR & Candidate Activation
1. **Official Web Sources**: The Agent or UI retrieves official bank pages using its own approved browsing or ingestion path, then supplies an unverified structured source snapshot with provenance and content fingerprint. The MCP does not retrieve web content.
2. **Flyers, App Screenshots & OCR**: Perform image/PDF processing **outside the MCP**. Extract declarative rule fields and assemble a candidate `OfferSourceSnapshot` with `sourceType: "user_input"` and `provenance`.
3. **Candidate Activation (`upsert_offer`)**:
   - Rules created from unverified inputs or images remain in `status: "candidate"` and will fail the Calculation Trust Gate (`needs_review`).
   - To activate a candidate rule, present the extracted summary to the human user. Upon confirmation, invoke `upsert_offer` supplying the `confirmation` object:
     ```json
     {
       "snapshot": { "id": "snap-01", "url": "https://official.bank.com/offer" },
       "rule": { "id": "rule-01", "cardId": "esun-kumamon", "status": "active" },
       "confirmation": {
         "confirmedAt": "2026-08-31T00:00:00Z",
         "confirmedBy": "user",
         "sourceReference": "https://official.bank.com/offer",
         "offerPeriod": { "validFrom": "2026-01-01T00:00:00Z" },
         "rewardUnit": "TWD",
         "rewardConditionsSummary": "Japan in-store transactions",
         "capSummary": "50000 TWD per calendar month"
       }
     }
     ```

### C. Planned Spend Recommendations vs Actual Purchases
- **Planned Evaluation (Simulation / Intent)**:
  - Set `mode: "planned"`.
  - Call `recommend` (or `calculate_reward` / `rank_cards`).
  - **Planned transactions NEVER consume caps or mutate the ledger.**
- **Actual Purchase (Ledger Writing)**:
  - Set `mode: "actual"`.
  - Provide a client-generated UUID / unique string for `idempotencyKey`.
  - Call `record_transaction`.
  - **Idempotency Guarantee**: Submitting the same `idempotencyKey` with identical payload returns the previous calculation result without double-counting. Submitting the same key with different payload is rejected with `IDEMPOTENCY_CONFLICT`.

### D. Refunds & Cap Restoration
- When recording a full or partial refund:
  - Set `kind: "refund"`, `mode: "actual"`.
  - Specify `refundOfId` pointing to the original purchase's `idempotencyKey`.
  - Specify `originalRewardMinor` (the gross reward amount of the original purchase).
  - Call `record_transaction`. The engine automatically offsets the reward and restores cap capacity in the appropriate cycle period.

### E. Billing Cycles, Currencies & FX
- **Cap Period Kinds**:
  - `calendar_month`: Resets on the 1st of each calendar month in the card's timezone.
  - `billing_cycle`: Computed from the card's `billingCycleDay` and `timezone` (defaults to `Asia/Taipei`).
- **Foreign Currency Spend**:
  - If transaction currency differs from rule settlement currency (e.g. JPY spend on TWD card), an `fx` object with `ratePpm`, `capturedAt`, and `maxAgeSeconds` is required.
  - Missing or stale FX snapshots fail closed (`unknown` or `stale`).

---

## 5. Fail-Closed Statuses & Agent Action Guide

### Card benefit switching

Call `get_card_switch_status` before discussing or recording a benefit switch.
It returns the latest per-card projection, `availableCandidates`, and
`currentlyUnavailable` campaigns with reasons; candidates with unknown
eligibility remain visible with warnings. The agent decides which campaign to
recommend. After the user confirms that the change was completed in the bank
app, call `upsert_card_switch` with `input.action` set to `record` or `adjust`,
an idempotency key, timezone, source URL/snapshot, rule version, and a
`confirmation` whose `completed` value is `true`.

The server records UTC and card-timezone local timestamps/date, benefit, source,
confirmation, and adjustment reason. A second confirmed write on the same local
day is allowed and returns `alreadySwitchedToday: true` plus a warning. Never
record an intended or unconfirmed app action.

The calculation engine returns explicit evaluation statuses. Agents must handle them according to these principles:

| Status | Meaning | Agent Action |
|---|---|---|
| `ok` | Confident calculation with `grossReward` and `cappedReward`. | Present the reward breakdown and net amount to the user. |
| `no_match` | Transaction conditions explicitly do not qualify. | Explain why the card/rule did not match (e.g. wrong country or channel). |
| `unknown` | Missing critical facts (e.g. unknown MCC, missing channel, missing FX rate). | **Ask the user for clarification**; do not guess or treat as 0 reward. |
| `stale` | Offer snapshot, rule period, or FX rate is expired. | Prompt to re-fetch official source or provide refreshed rate. |
| `needs_review` | Candidate rule awaiting user confirmation or conflicting facts. | Guide user through reviewing and confirming the rule terms. |

---

## 6. Forbidden Sensitive Fields & Security Invariants

The MCP server enforces strict data minimization. Any tool call containing the following keys (at any argument nesting level) is immediately rejected:

- ❌ `pan`, `cardNumber`, `card_number`
- ❌ `cvv`, `cvc`, `otp`
- ❌ `password`, `cookie`, `credential`, `secret`, `token`, `apiKey`, `api_key`
- ❌ Tool-level `user_id`, `dataDir`, `data_dir`, `path` overrides

Agents must always store only card identity descriptors (e.g. issuer, product name, last 4 digits in an alias) and never request or forward raw payment credentials.
