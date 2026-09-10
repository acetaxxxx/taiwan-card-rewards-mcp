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
│  - Pure, deterministic calculation & uncertainty-aware ranking (default 10) │
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
  --data-dir /absolute/tenant-directory
```

Pin a release tag for repeatable use:

```bash
npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#v0.11.0 \
  --data-dir /absolute/tenant-directory
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
| `--data-dir <path>` | **Required** | Absolute directory for user storage. Missing nested directories are created securely, then canonicalized via `realpath`; filesystem roots (`/`) and non-directories are rejected. Tools cannot override this path. |
| `--user <id>` | **Optional** | Display and audit log metadata only. Never used as an access control or storage partition selector. |

---

## 3. The MCP Tool Surface

The MCP server exposes reward tools plus bounded merchant resolution and generic
benefit tools. Standalone `confirm_offer` is not part of the surface; candidate
activation is folded directly into `upsert_offer`. There is no separate
preflight tool — `recommend` is the single recommendation entry point and its
response already carries every diagnostic an Agent needs.

| Tool Name | Persistence | Description | Key Fail-Closed Errors |
|---|:---:|---|---|
| `calculate_reward` | Read-only | Pure stateless evaluation of a rule against a transaction with evaluation context; use it to verify a rule's math before persisting via `upsert_offer`, or to show hypothetical math for an unconfirmed candidate offer. | `INSUFFICIENT_FACTS`, `SOURCE_UNAVAILABLE`, `NEEDS_REVIEW`, `STALE` |
| `register_card` | Mutating | Register or update a card product descriptor (`id`, `issuer`, `productName`, `network`, `country`). | `INVALID_CARD`, `STORE_UNAVAILABLE` |
| `list_cards` | Read-only | List all registered cards in the user's store. | `STORE_UNAVAILABLE` |
| `upsert_offer` | Mutating | Ingest an official or candidate source snapshot and versioned rule; activates candidate if valid confirmation is supplied. | `INVALID_OFFER`, `INVALID_CONFIRMATION`, `STORE_UNAVAILABLE` |
| `recommend` | Read-only | Merchant-first planned recommendation; reads registered cards and verified routes and returns direct-card and multi-layer payment-path candidates together in one ranked list. Results are bounded (default 10) and do not mutate usage. | `INSUFFICIENT_FACTS`, `NEEDS_REVIEW`, `STALE` |
| `upsert_payment_route` | Mutating | Register a payment route; MCP assigns its route identity, trusts the caller's self-asserted `evidenceIds` directly, and stores no credentials. | `INVALID_INPUT`, `IDEMPOTENCY_CONFLICT`, `SENSITIVE_FIELD_FORBIDDEN` |
| `list_payment_routes` | Read-only | List the current user's registered payment routes as bounded projections. | `INVALID_INPUT`, `STORE_UNAVAILABLE` |
| `upsert_payment_capability` | Mutating | Register a public payment capability separately from user-owned routes/accounts; trusts self-asserted `evidenceIds` directly. | `UNAUTHENTICATED`, `NEEDS_REVIEW`, `IDEMPOTENCY_CONFLICT`, `STORE_UNAVAILABLE` |
| `list_payment_capabilities` | Read-only | List public payment capabilities available for planned route generation. | `UNAUTHENTICATED`, `STORE_UNAVAILABLE` |
| `register_payment_account` | Mutating | Register a wallet or linked bank account identity with evidence; never send credentials or account numbers. | `INVALID_CONFIRMATION`, `IDEMPOTENCY_CONFLICT`, `SENSITIVE_FIELD_FORBIDDEN` |
| `list_payment_accounts` | Read-only | List user-scoped account identities before constructing payment routes. | `INVALID_INPUT`, `STORE_UNAVAILABLE` |
| `search_active_offers` | Read-only | Search current active offers and return bounded canonical merchant/offer records; it never applies a reward. | `MISSING_REQUIRED_FACT`, `NOT_FOUND`, `STALE` |
| `resolve_merchant` | Read-only | Validate an Agent-provided canonical merchant ID/name and return bounded merchant facts; it never interprets aliases or applies a reward. | `MERCHANT_AMBIGUOUS`, `MISSING_REQUIRED_FACT`, `NOT_FOUND` |
| `record_transaction` | Mutating | Record an actual purchase (with `idempotencyKey`) or linked refund, updating durable cap usage. | `IDEMPOTENCY_CONFLICT`, `INVALID_REFUND`, `INSUFFICIENT_FACTS`, `NEEDS_REVIEW` |
| `record_event_reward` | Mutating | Re-evaluate an event-local rule or explicit `funded_by` chain on the server, then record only a matched, non-stacking reward. | `UNKNOWN_EVENT_FACTS`, `NEEDS_REVIEW`, `INELIGIBLE_EVENT_REWARD`, `IDEMPOTENCY_CONFLICT`, `STORE_CORRUPT` |
| `reverse_event_reward` | Mutating | Reverse a recorded event reward from one explicit refund/reversal event, restoring proportional reward and cap usage. | `INVALID_REFUND`, `AMBIGUOUS_ORIGINAL`, `OVER_REFUND`, `IDEMPOTENCY_CONFLICT` |
| `remaining_caps` | Read-only | Query remaining reward cap balances per rule and usageKey derived from actual transactions. | `INVALID_INPUT`, `STORE_UNAVAILABLE` |
| `get_user_benefit_status` | Read-only | Show current benefit plus available-now and action-required candidates. | `CARD_NOT_FOUND`, `STORE_UNAVAILABLE` |
| `upsert_user_benefit_status` | Mutating | Record or correct a user-confirmed completed card switch or campaign registration. | `CARD_NOT_FOUND`, `INVALID_CONFIRMATION`, `IDEMPOTENCY_CONFLICT` |

---

## 4. Workflow Guidelines for AI Agents

### A. Card Management & Discovery
1. For a recommendation, call `recommend` directly with the merchant-first intent. `list_cards` is for management, explicit inventory requests, or onboarding checks; it is not a normal recommendation prerequisite.
2. If the user holds a new card, call `register_card` with card descriptors (e.g. `{ id: "esun-kumamon", issuer: "ESunBank", productName: "Kumamon Card", network: "JCB", country: "TW" }`).

For the merchant-first recommendation shape, follow [`recommendation-intent.md`](taiwan-card-rewards-skill/workflows/recommendation-intent.md). `recommend` is the only entry point; there is no separate preflight call or legacy transaction branch.

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

3. **Merchant Identity Resolution**:
   - The Agent does not load the full merchant catalog. It sends the raw label
     and known market facts to `resolve_merchant`; matching is exact/NFKC-only
     and bounded, never fuzzy or embedding-based.
   - If the user asks which merchants currently have offers, call
     `search_active_offers` and use its canonical IDs/names. If the candidate is
     ambiguous or missing facts, call `resolve_merchant` for validation and ask
     the user to choose when needed.
   - After a candidate is confirmed, call `recommend` with the resolved
     transaction facts. The Agent never selects `ruleId`.
   - `recommend` and `resolve_merchant` never create identities. When official
     evidence identifies a merchant that is not cataloged yet,
     `upsert_offer` may atomically onboard one strict candidate merchant and
     bind the submitted rule to its MCP-generated canonical ID.

### C. Planned Spend Recommendations vs Actual Purchases
- **Planned Evaluation (Simulation / Intent)**:
  - Set `mode: "planned"`.
  - Call `recommend` against registered cards and routes; use `calculate_reward` to verify a single rule before persisting it or to show hypothetical math for an unconfirmed candidate offer.
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
  - `billing_cycle`: Computed from the card or cap pool's explicit IANA `timezone`; missing timezone is fail-closed.
- **Foreign Currency Spend**:
- If transaction currency differs from rule settlement currency (e.g. JPY spend on TWD card), an `fx` object with `ratePpm`, `capturedAt`, and `maxAgeSeconds` is required. Include `provider` and `rateType` when available, plus `sourceUrl`/`contentHash` for auditability.
- Missing or stale FX snapshots fail closed (`unknown` or `stale`).

For the merchant-first intent, treat `fxResolutionRequest` as a typed request for
external lookup, not as an already-obtained rate. Use its currency pair, conversion owner,
suggested rate types, time, and required facts to query an approved source. The Bank
of Taiwan quote page may be a public reference candidate, but it is not the actual
policy or settlement rate of a card, wallet, or issuer. Return the validated typed `fx`
snapshot with the same intent and call `recommend` again so MCP recomputes the result.
There is no separate FX policy or observation store: the Agent supplies a fresh
`fx` snapshot on each new evaluation. A successful actual transaction or event
freezes the applied rate and provenance in its durable ledger record; a refund
reuses only that original frozen rate, not a current or globally stored quote.

### F. Top-ups, Wallet Purchases & Cross-Event Rewards

The Agent owns fact gathering and official-source research. The MCP owns strict
validation, event matching, stacking decisions, idempotency, cap consumption,
and durable ledger writes. The MCP does not browse bank pages and must never
infer a provider, issuer, or funding source that is not explicitly evidenced.

#### Canonical call sequence

1. Ask for the route facts: direction, provider/app, merchant, funding source,
   payment method, channel, amount, currency, timestamp, and whether the event
   is a top-up, purchase, refund, or reversal.
2. Call `list_payment_accounts` first. If the user wants to add a wallet such as JKO PAY, call `register_payment_account` with the provider identity and evidence only; then resolve or register the route with `list_payment_routes` and, when confirmed,
   `upsert_payment_route`. Research official evidence outside MCP, then ingest
   the offer with `upsert_offer` only after the source and user confirmation
   requirements are satisfied.
3. For a planned action, use `recommend`; planned actions never create event
   ledger records.
4. For an actual event, submit `record_event_reward` with the target event,
   either an `eventRule` or a `chainRule` (exactly one), any required bounded
   `sourceEvents`, the reward candidate, and an idempotency key. The server
   recomputes eligibility; a caller-provided `matched` status is not trusted.
5. If the user later reports a refund or reversal, submit
   `reverse_event_reward` with exactly one explicit refund relation to the
   original event. Never reverse by merchant name or by a guessed transaction.

#### Example: linked bank account → wallet top-up → wallet purchase

The Agent must represent the two economic events separately:

```json
{
  "event": {
    "id": "evt_purchase_illustrative",
    "kind": "purchase",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-06T07:10:00Z",
    "funding": { "kind": "account", "subtype": "wallet_balance", "accountId": "wallet_illustrative" },
    "relations": { "funded_by": ["evt_topup_illustrative"] }
  },
  "sourceEvents": [{
    "id": "evt_topup_illustrative",
    "kind": "top_up",
    "amount": { "amountMinor": 10000, "currency": "TWD" },
    "occurredAt": "2026-09-06T07:00:00Z",
    "funding": { "kind": "account", "subtype": "linked_bank_account", "accountId": "bank_illustrative" }
  }],
  "chainRule": {
    "id": "chain_illustrative",
    "version": "evidence-version-1",
    "relation": "funded_by",
    "sourceRule": { "id": "source-rule", "version": "1", "eventKind": "top_up", "fundingKind": "account", "fundingSubtype": "linked_bank_account" },
    "targetRule": { "id": "target-rule", "version": "1", "eventKind": "purchase", "fundingKind": "account", "fundingSubtype": "wallet_balance" },
    "windowSeconds": 2592000
  },
  "candidate": {
    "eventId": "evt_purchase_illustrative",
    "ruleId": "rule_illustrative",
    "ruleVersion": "evidence-version-1",
    "evidenceId": "ev_official_illustrative",
    "sponsor": "sponsor_illustrative",
    "benefitGroup": "benefit_illustrative",
    "eligibility": { "status": "matched", "reasons": [] }
  },
  "idempotencyKey": "event-reward-illustrative"
}
```

The example proves a relationship only when `E1`, `E2`, and the explicit
`funded_by` relation are supplied. Mixed wallet balances, missing sources,
duplicate sources, expired windows, and ambiguous provenance return `unknown`
or `needs_review`; the Agent must not allocate the balance automatically.

#### PayPay, EasyWallet, and card-funded wallet routes

For proactive route selection, call the normal merchant-first `recommend` intent, optionally narrowed with `routeIds`. Its `candidates[]` already mixes `direct_card` and `payment_path` results in one ranked list — there is no separate path-only tool or envelope. It considers only the current user's active routes with self-asserted `evidenceIds` and returns bounded nodes, transitions, funding source, reward totals, matched rules, and explicit exclusions. Routes are usable by default once evidenceIds are supplied; ask only when facts conflict or are ambiguous, and mark a route failed when the user says it is unavailable. It never invents mixed wallet funding, unregistered routes, or unverified cross-border paths; absent evidence yields no candidate. When Gold/member-dependent prerequisites are known and evidenced, include them in the public `eligibilityFacts` array; otherwise retain the candidate's required action or blocked status.

Do not collapse these into one card purchase:

- A card top-up followed by a wallet purchase is two events. A wallet purchase
  does not automatically inherit the card issuer's reward.
- PayPay inbound TWQR acceptance, PayPay outbound wallet top-up, and a bank
  account's EasyWallet top-up are different route directions and require
  separate evidence.
- If the official terms do not identify the issuer, wallet, channel, or funding
  path, return `unknown`/`needs_review` rather than recording a reward.
- `record_transaction` remains the legacy purchase/refund path. Use the event
  tools when top-up provenance or cross-event eligibility affects the decision.

---

## 5. Fail-Closed Statuses & Agent Action Guide

### Card benefit switching

Call `get_user_benefit_status` before discussing or recording a benefit.
It returns the latest per-card projection, `availableCandidates`, and
`currentlyUnavailable` campaigns with reasons; candidates with unknown
eligibility remain visible with warnings. The agent decides which campaign to
recommend. After the user confirms that the change was completed in the bank
app, call `upsert_user_benefit_status` with `input.action` set to `record` or `adjust`,
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
