# taiwan-card-rewards-mcp

An AionCore-external, dependency-light contract and deterministic evaluator for Taiwan credit-card rewards. The evaluator remains pure; the taiwan-card-rewards-mcp stdio server adds a tenant-bound JSON durable store for cards, offer snapshots/rules, and actual transactions. It never stores PAN, CVV, OTP, cookies, bank credentials, or provider keys.

## Startup contract (file-backed npx mode)

The executable must require `--data-dir <absolute-existing-directory>`. Startup canonicalizes it with the filesystem real path, rejects missing/non-directory paths and filesystem roots, and rejects unknown startup arguments. The AI Agent or UI obtains and parses bank pages, images, or PDFs before submitting structured snapshots; the MCP does not make outbound network requests. This canonical directory is the sole tenant boundary and must be passed to every persistence operation; tools cannot override it. `--user`, if accepted, is display metadata only and never an authorization or storage selector. Reusing one `data-dir` is an explicit decision to share its data. Never store PAN, CVV, OTP, bank credentials, or provider keys.

The store takes an exclusive process lock (`card-rewards.lock`) for the lifetime of the stdio process. A second process using the same directory is rejected, including after an unclean shutdown; stale locks must be investigated and removed by an operator only after confirming that no process owns the directory.

## Run as an Aion stdio MCP server

Build with `npm run build`, then configure Aion's stdio MCP server with command `npx` (or the installed `taiwan-card-rewards-mcp` binary) and arguments `--data-dir /absolute/existing/tenant-directory`. GitHub source installs are supported with `npx --yes github:acetaxxxx/taiwan-card-rewards-mcp#main`; npm runs the package `prepare` script to build `dist/`. Pin a release tag such as `#v0.2.2` for repeatable use. The process reads newline-delimited JSON-RPC from stdin and writes responses to stdout; it does not open an HTTP/SSE listener. Each user must receive a separate process and data directory. Reusing one data directory is explicit shared tenancy; `--user` is display metadata only.

Available tools are the existing 9 reward tools plus `get_card_switch_status` and `upsert_card_switch` for confirmed benefit switching. For comprehensive workflow instructions, see the [AI Agent Usage Guide](docs/agents/usage-guide.md). Phase 1 recommendation and cap usage read only actual transactions; planned transactions never mutate the store. Repeated actual calls require the same idempotency key and payload; mismatches fail closed. Refunds must reference an existing recorded transaction.

## Boundaries

- Money uses integer minor units; percentage rewards use basis points; FX uses a captured parts-per-million rate.
- `evaluateOffer` is pure. Planned transactions never mutate usage. Actual transactions require an idempotency key; refunds require a source transaction id and original reward amount.
- Missing merchant/channel/payment/currency/date facts, missing cap usage, stale or unreviewed rules, and missing FX snapshots return `unknown`, `stale`, or `needs_review`; callers must not turn those into a confident recommendation.
- The file store is intentionally a narrow Phase 1 implementation. The future auth-aware sidecar can replace it while preserving the evaluator and MCP names.

## Planning and documentation

The design, research, specifications, and agent usage guides are kept under `docs/`:

- `docs/agents/usage-guide.md` — AI Agent usage guide for installation, workflows, and fail-closed safety
- `schemas/card-rewards-state.schema.json` — persisted `card-rewards.json` JSON Schema (schemaVersion 1)
- `docs/design/codebase-design.md` — package boundaries and implementation seam
- `docs/adr/0001-independent-card-rewards-domain-and-agent-supplied-rules.md` — domain and rule-source decisions
- `docs/research/taiwan-credit-cards-official-research.md` — first-party source research
- `docs/specs/taiwan-card-rewards-mcp-reference-study.md` — reference-project comparison and product plan
- `docs/specs/card-rewards-mcp-repository.md` — independent-repository and Aion integration contract
- `docs/integration/CARD_REWARDS_SKILL_BINDING_PLAN.md` — planned Skill/Agent binding; not an installed Skill

## TDD and CI strategy

GitHub Actions runs on Ubuntu 24.04 with Node 22.14.0: `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`, and `npm test`. The workflow is path-scoped to this package and uses the committed lockfile; it never invokes `npx` without a pinned package version. Fixtures should cover exact-match, missing condition, stale rule, cap exhaustion, planned-vs-actual non-mutation, duplicate idempotency, refund, currency mismatch, FX conversion, and deterministic Top-5 ties. Keep bank-specific rules out of the core tests.

## Sidecar migration notes

The Phase 0 types are designed to serialize directly into a future auth-aware HTTP sidecar. Add repositories for `cards`, `offer_source_snapshots`, `offer_rule_versions`, `transactions`, and `cap_usage`; require a signed Aion user context at the boundary; enforce unique `(user_id, idempotency_key)`; preserve rule/source versions; and reject missing/expired/conflicting data. The sidecar may expose the same MCP names while keeping the evaluator pure.
