# taiwan-card-rewards-mcp

An AionCore-external, dependency-light contract and deterministic evaluator for Taiwan credit-card rewards. The evaluator remains pure; the taiwan-card-rewards-mcp stdio server adds a tenant-bound JSON durable store for cards, offer snapshots/rules, and actual transactions. It never stores PAN, CVV, OTP, cookies, bank credentials, or provider keys.

## Choose the right documentation

- **Users installing the MCP and runtime skills:** copy [`installation/INSTALL_WITH_AI.md`](installation/INSTALL_WITH_AI.md) into an AI coding agent after filling in the three requested paths.
- **Runtime agents serving card-rewards users:** install the complete [`docs/taiwan-card-rewards-skill/`](docs/taiwan-card-rewards-skill/) bundle. Its base `SKILL.md` routes to contract, recommendation, evidence, and ledger skills.
- **Contributors and coding agents changing this repository:** follow [`AGENTS.md`](AGENTS.md) and the contributor material under [`docs/agents/`](docs/agents/). Root `AGENTS.md` is not a user skill.

## Startup contract (file-backed npx mode)

The executable must require `--data-dir <absolute-directory>`. Startup securely creates a missing directory (including nested parents), then canonicalizes it with the filesystem real path; it rejects non-directory paths, filesystem roots, unreadable paths, and unknown startup arguments. The AI Agent or UI obtains and parses bank pages, images, or PDFs before submitting structured snapshots; the MCP does not make outbound network requests. This canonical directory is the sole tenant boundary and must be passed to every persistence operation; tools cannot override it. `--user`, if accepted, is display metadata only and never an authorization or storage selector. Reusing one `data-dir` is an explicit decision to share its data. Never store PAN, CVV, OTP, bank credentials, or provider keys.

The store takes an exclusive process lock (`card-rewards.lock`) for the lifetime of the stdio process. A second process using the same directory is rejected, including after an unclean shutdown; stale locks must be investigated and removed by an operator only after confirming that no process owns the directory.

## Run as an Aion stdio MCP server

Build with `npm run build`, then configure Aion's stdio MCP server with command `npx` (or the installed `taiwan-card-rewards-mcp` binary) and arguments `--data-dir /absolute/tenant-directory`. GitHub source installs are supported with `npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#main`; npm runs the package `prepare` script to build `dist/`. Pin release `#v0.14.0` for repeatable use. Agents using the same data directory attach through one shared owner process and local stdio bridges; different data directories remain isolated. The process reads newline-delimited JSON-RPC from stdin and writes responses to stdout; it does not open an HTTP/SSE listener. Reusing one data directory is explicit shared tenancy; `--user` is display metadata only.

Schema v2 (package/server 0.14.0) exposes 20 tools: a single merchant-first `recommend` entry point whose `candidates[]` unifies direct-card and multi-layer payment-path results (no separate preflight tool, no payment-path envelope), payment-account and payment-route onboarding/listing, and event-scoped reward recording/reversal. `tools/list` explicitly publishes canonical camelCase input property names; the MCP adapter accepts equivalent snake_case spelling at every nested input boundary and normalizes it before validation. Foreign-currency amounts use a single agent-supplied `fx` snapshot trusted directly once it passes currency-pair and freshness checks; there is no separate FX policy/observation storage layer. Payment routes and capabilities are usable by default once the caller supplies self-asserted `evidenceIds` — no separate evidence-submission tool exists or is required. Bounded list projections accept up to 50 items and invalid bounds return `INVALID_INPUT`. Recommendations can require an explicit, evidenced cross-event `funded_by` path; the server recomputes eligibility and fails closed on ambiguity. Account onboarding stores only opaque provider identities and evidence, never credentials or account numbers. It also supports MCP-owned `ev_<ULID>`/`fact_<ULID>` evidence identities and typed `PaymentRouteContext`. For comprehensive workflow instructions, see the [AI Agent Usage Guide](docs/usage/ai-agent-usage-guide.md), [recommendation skill](docs/taiwan-card-rewards-skill/card-rewards-recommendation/SKILL.md), and [ledger skill](docs/taiwan-card-rewards-skill/card-rewards-ledger/SKILL.md). Planned transactions never mutate the store. Repeated actual calls require the same idempotency key and payload; mismatches fail closed. Refunds must reference an existing recorded transaction or event reward.

## Boundaries

- Money uses integer minor units; percentage rewards use basis points; FX uses a captured parts-per-million rate.
- `evaluateOffer` is pure. Planned transactions never mutate usage. Actual transactions require an idempotency key; refunds require a source transaction id and original reward amount.
- Missing merchant/channel/payment/currency/date facts, missing cap usage, stale or unreviewed rules, and missing FX snapshots return `unknown`, `stale`, or `needs_review`; callers must not turn those into a confident recommendation.
- The file store is intentionally a narrow Phase 1 implementation. The future auth-aware sidecar can replace it while preserving the evaluator and MCP names.

## Planning and documentation

The design, research, specifications, and agent usage guides are kept under `docs/`:

- `installation/INSTALL_WITH_AI.md` — copyable instructions for an AI agent to install the MCP configuration and runtime skill bundle
- `docs/usage/ai-agent-usage-guide.md` — AI Agent usage guide for installation, workflows, and fail-closed safety
- `docs/taiwan-card-rewards-skill/card-rewards-ledger/` — actual transaction, event-scoped top-up, wallet, cross-event, and reversal skill
- `docs/integration/skill-adapters/` — adapter authoring guide, template, manifest, and Agent/MCP integration responsibilities
- `installation/README.md` — installation and skill-distribution SOP
- `schemas/card-rewards-state.schema.json` — persisted `card-rewards.json` JSON Schema (schemaVersion 2; incompatible older data requires explicit migration/reset)
- `docs/design/codebase-design.md` — package boundaries and implementation seam
- `docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md` — domain and rule-source decisions
- `docs/research/archive/taiwan-credit-cards-official-research.md` — first-party source research
- `docs/specs/taiwan-card-rewards-mcp-reference-study.md` — reference-project comparison and product plan
- `docs/specs/card-rewards-mcp-repository.md` — independent-repository and Aion integration contract
- `docs/integration/CARD_REWARDS_SKILL_BINDING_PLAN.md` — planned Skill/Agent binding; not an installed Skill
- `docs/integration/SHARED-MCP-AND-FX-AUTOMATION-PLAN.md` — shared MCP and FX automation release plan

## TDD and CI strategy

GitHub Actions runs on Ubuntu 24.04 with Node 22.14.0: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, and `npm test`. The workflow is path-scoped to this package and uses the committed lockfile; it never invokes `npx` without a pinned package version. Fixtures should cover exact-match, missing condition, stale rule, cap exhaustion, planned-vs-actual non-mutation, duplicate idempotency, refund, currency mismatch, FX conversion, and deterministic Top-5 ties. Keep bank-specific rules out of the core tests.

## Sidecar migration notes

The Phase 0 types are designed to serialize directly into a future auth-aware HTTP sidecar. Add repositories for `cards`, `offer_source_snapshots`, `offer_rule_versions`, `transactions`, and `cap_usage`; require a signed Aion user context at the boundary; enforce unique `(user_id, idempotency_key)`; preserve rule/source versions; and reject missing/expired/conflicting data. The sidecar may expose the same MCP names while keeping the evaluator pure.
