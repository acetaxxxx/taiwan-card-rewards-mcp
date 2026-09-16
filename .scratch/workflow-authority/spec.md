# MCP Workflow Authority

Status: ready-for-agent

## Goal

Make the MCP the authority for offer ingestion and recommendation progress while keeping the Agent responsible for external research and semantic extraction. The MCP must decide what is missing, validate every submitted result, prove when work is complete, and retain deterministic reward evaluation.

The approved architecture source is [`docs/architecture/mcp-flow-control.md`](../../docs/architecture/mcp-flow-control.md).

## Product outcomes

- A complete official source can be ingested without the Agent inventing phases or declaring completion.
- Every source unit is represented by a stable manifest leaf and ends with an explicit disposition.
- Candidate rules remain invisible to recommendation until finalization validates and atomically activates the complete ingestion.
- Recommendation keeps its one-call fast path and returns structured, executable actions when facts are missing, stale, malformed, or conflicting.
- Benefit refresh can hand off to ingestion and safely resume the original recommendation.
- Agents learn the workflow from MCP schemas and action responses; skills contain operating guidance rather than a duplicate schema.

## Module boundaries

### Flow Kernel

The Flow Kernel owns flow identity, revision checks, action correlation, idempotency, lifecycle transitions, and terminal status. Its Interface is limited to create, inspect, accept an expected action result, and finalize or cancel. It does not know benefit, exclusion, FX, merchant, or reward semantics.

### Ingestion Flow

The Ingestion Flow owns source capture, manifest coverage, leaf dependencies, leaf dispositions, materialization readiness, and completion proof. It uses the existing canonical offer and evidence behavior through an internal Adapter rather than duplicating it.

### Offer Catalog

The Offer Catalog owns source snapshots, candidate Rule Versions, canonical references, supersession, and atomic activation. Partially processed ingestion state is not an active offer index.

### Recommendation Flow

The Recommendation Flow remains a stateless, read-only Interface for the first release. It derives required actions from the intent and current state, binds retries to `resultVersion`, and re-evaluates after typed facts are supplied. It does not persist a recommendation session or consume caps.

### Evaluation Engine

The existing evaluator remains the deterministic authority for predicates, exclusions, route matching, FX, fees, caps, stacking, and reward breakdowns. The workflow layer cannot override its fail-closed results.

## Shared action contract

Every actionable response identifies at least:

- `flowId` when the action belongs to a durable flow;
- `flowType`;
- `revision`;
- stable `actionId`;
- typed `kind` and `owner` (`agent`, `user`, or `mcp`);
- affected leaf or recommendation candidate identifiers;
- required facts and accepted submission path;
- completion condition;
- structured diagnostics.

Durable action submissions include `flowId`, `actionId`, `expectedRevision`, `idempotencyKey`, and a typed payload. Duplicate identical submissions return the prior result. Reuse with different content fails with a conflict. Results for stale or unexpected actions do not mutate state.

## Diagnostic contract

Missing fields, unsupported formats, stale evidence, and conflicting data return enough information for an Agent to recover:

- stable `code`;
- precise `path`;
- human-readable `message`;
- `requiredFacts`;
- `retryAction`;
- affected leaf or candidate identifiers when applicable.

`unknown`, `no_match`, `needs_review`, and invalid input remain distinct. An Agent cannot convert an unresolved diagnostic into success by asserting completion.

## Ingestion lifecycle

The canonical lifecycle is:

`awaiting_source → awaiting_manifest → processing_leaves → ready_to_finalize → complete`

Terminal or intervention states are `needs_review`, `conflict`, `failed`, and `cancelled`. Every transition is validated by the MCP. A source and manifest are immutable within a revision; corrections create an explicit replacement revision rather than silently rewriting prior evidence.

Manifest leaf types initially cover benefit and exclusion units. Each leaf has a stable source-local identifier, type, optional dependencies, and exactly one terminal disposition: `materialized`, `ignored`, or `superseded`. Ignored and superseded leaves require a reason and retain evidence linkage.

Shared exclusions are first-class leaves. Benefit leaves reference them through manifest dependencies. Finalization fails closed when a required leaf is unresolved, a dependency is cyclic or missing, canonical references are ambiguous, or candidate rules conflict.

## Draft ownership, expiry, and cleanup

An unfinished ingestion is a durable draft, so an Agent can recover from an interrupted turn without recreating evidence. A draft carries `lastActivityAt` and `expiresAt`; activity only extends the expiry after the MCP accepts an expected action result.

The MCP permits one active draft per `(ownerUser, normalized source scope)`, where source scope identifies the official source or a declared target family. A repeated create returns the existing flow rather than opening a duplicate. This is deliberately not a global one-card lock: one official source can cover multiple products, and a user must remain able to register a Held Card while benefit research is incomplete.

Expired drafts move to a terminal `expired` state. They can no longer accept submissions. Their incomplete candidate artifacts and unreferenced source payloads are purged; a minimal tenant-scoped tombstone remains for an operator-configured retention period to explain why a retry must create a new revision. Active rules, historical transactions, completion proofs, and evidence referenced by completed work are never cleanup targets.

Expiry is enforced during MCP startup and mutating flow operations, so it remains safe without a background worker. A maintenance sweep is also available to an operator or scheduler for timely cleanup while the MCP is idle. The TTL, tombstone retention, and sweep cadence are configuration with documented defaults and testable clock injection.

## Atomic visibility

Source capture, manifest work, and leaf materialization may persist durable workflow state and candidate artifacts. They must not make incomplete rules visible to the active offer index. Finalization validates the complete dependency closure and activates all accepted Rule Versions in one store update. Failure leaves the prior active catalog unchanged.

## Recommendation lifecycle

The existing `recommend` tool remains the primary Interface:

- complete facts take the fast path and return evaluated candidates immediately;
- missing knowledge returns candidate-scoped actions using the shared action and diagnostic vocabulary;
- retry uses the original intent plus typed facts and the expected `resultVersion`;
- changed relevant state invalidates the old result version and requests a restart;
- recommendation remains read-only and does not create a durable session.

A benefit-refresh action may create a linked child ingestion. The parent continuation records only the intent fingerprint and child flow identity needed to resume. Completion of the child causes a fresh recommendation evaluation; it does not reuse a prior ranking or bypass current validation.

## Security and trust invariants

- The MCP performs no outbound network access.
- External documents and Agent extractions are untrusted inputs until validated.
- Source hashes, retrieval time, provenance, and artifact references are preserved.
- Public and user-confirmed trust bases remain distinct and tenant isolation remains enforced.
- No payment credential, account number, PAN, authentication token, or raw secret is accepted.
- Recommendation never writes transactions or consumes caps.
- Candidate rules cannot become active through a workflow-status update alone.

## Compatibility and migration

- Existing public tools keep working while the new ingestion flow is introduced.
- Existing stored state migrates without rewriting historical transactions, Rule Versions, or reward components.
- New persistent workflow collections require a schema migration and strict validation.
- The implementation must not create a generic workflow-definition language. Shared infrastructure is limited to lifecycle mechanics; domain actions remain typed.
- Legacy `recommend` inputs remain supported through the existing normalization Adapter.

## Delivery order

```text
01 contract and ADR
 ├─ 02 ingestion flow spine → 03 source capture → 04 manifest coverage
 │                                      ├─ 05 benefit leaves ─┐
 │                                      └─ 06 exclusions ─────┴→ 07 finalize
 └─ 08 recommendation actions → 09 typed retry
                                      07 + 09 → 10 refresh handoff
                                                    ↓
                                             11 Agent E2E
```

## Overall definition of done

- [ ] All eleven tickets meet their individual DoD and are moved out of `ready-for-agent`.
- [ ] Public MCP schema, dispatcher, service behavior, storage validation, and documentation agree.
- [ ] A public MCP trace ingests a multi-benefit source with a shared exclusion and proves full manifest coverage.
- [ ] Interrupted and duplicate submissions resume idempotently; stale or conflicting submissions fail without partial activation.
- [ ] Same-source draft creation returns the existing active flow; expiry purges only incomplete artifacts and leaves active/historical data intact.
- [ ] Recommendation fast path remains a single read-only call.
- [ ] Missing merchant, FX, transaction, or benefit freshness returns structured reasons and executable actions.
- [ ] A benefit refresh completes through child ingestion and a fresh recommendation evaluation.
- [ ] Existing storage, transaction, refund, cap, route, FX, predicate, and recommendation behavior remains compatible.
- [ ] Typecheck, build, full tests, public MCP contract tests, migration tests, and Agent workflow traces pass.
- [ ] The installed bundle at `docs/taiwan-card-rewards-skill/` teaches the workflow through MCP actions and does not duplicate payload schemas.

## Non-goals

- A universal BPMN-style workflow engine or user-defined workflow language.
- Network access from the MCP.
- Scheduled source or FX refresh inside the MCP process.
- Durable recommendation sessions in the first release.
- Replacing the existing evaluator, transaction ledger, route model, or trust gates.

## Approved decisions

- Eleven-ticket delivery plan approved by the user.
- Recommendation uses stateless retry and `resultVersion` for the first release.
- The architecture document lives under `docs/architecture/`.
