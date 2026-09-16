---
status: accepted
---

# MCP workflow authority and bounded ingestion drafts

The MCP owns the progress, validation, persistence, and completion proof of offer ingestion, while an Agent remains responsible for external research and semantic extraction. This extends the existing zero-network, declarative-rule, and Calculation Trust Gate decisions because an Agent cannot safely infer whether a long source has been fully processed or whether a missing fact may be ignored.

## Decision

An Ingestion Flow is a tenant-scoped MCP lifecycle for one complete source. Its canonical progression is `awaiting_source → awaiting_manifest → processing_leaves → ready_to_finalize → complete`; `needs_review`, `conflict`, `failed`, `cancelled`, and `expired` are intervention or terminal states. Every durable action has a stable `actionId`, expected revision, idempotency key, typed result, owner, and completion condition. A stale action or a duplicate key with different content does not mutate the flow.

The Manifest is the immutable, revision-scoped coverage boundary for a source. Every Manifest Leaf ends as `materialized`, `ignored`, or `superseded`; the latter two retain a reason and evidence linkage. Shared exclusions are leaves with explicit dependencies, not text copied into arbitrary benefits. Finalization proves dependency closure and preserves the existing Calculation Trust Gate: it atomically publishes only candidates already eligible to be active. A completed flow may still report candidate rules awaiting Offer Confirmation, and completion never substitutes for confirmation.

An incomplete flow is an Ingestion Draft. The MCP permits one active draft per `(ownerUser, normalized source scope)` and returns that flow for a repeated create. The scope represents an official source or a declared offer family; it is intentionally not a global card lock because one source can cover multiple Card Products and Held Card registration remains independent from benefit research. A draft has `lastActivityAt` and `expiresAt`. Startup and mutating flow operations enforce expiry, while a maintenance sweep permits an operator or scheduler to clean drafts during idle periods. Expiry moves the flow to `expired`, purges only incomplete candidate artifacts and unreferenced payloads, and retains a minimal tenant-scoped Draft Tombstone for bounded audit retention. Active rules, Completion Proofs, historical ledger records, and evidence referenced by completed work are excluded from cleanup.

Recommendation remains a stateless, read-only operation in the first release. It returns candidate-scoped structured diagnostics and Flow Action-shaped recovery instructions, retries with typed facts and `resultVersion`, and reruns evaluation when relevant state changes. A benefit refresh may link to a child Ingestion Flow, but child completion causes a fresh recommendation evaluation rather than resurrecting an old ranking.

## Consequences

- MCP contracts expose structured `code`, `path`, `message`, `requiredFacts`, `retryAction`, and affected record identifiers for missing, malformed, stale, and conflicting data.
- The shared Flow Kernel owns lifecycle mechanics only. Ingestion, Offer Catalog, Recommendation, and Evaluation retain their domain-specific semantics; no user-defined workflow language is introduced.
- Storage gains validated workflow, candidate-artifact, and tombstone state with migration coverage and tenant isolation.
- Agent skills use MCP actions and schemas as the source of execution truth. They provide research and semantic-extraction guidance rather than a copied payload schema.

## Verification commitments

| Contract boundary | Required verification |
| --- | --- |
| Flow input schemas | Closed schemas reject unknown fields and require identity, revision, action, idempotency, and typed payload fields. |
| Lifecycle | Only documented transitions succeed; stale revision, wrong action, terminal flow, and conflicting idempotency payloads leave durable state unchanged. |
| Draft ownership | Same tenant/source scope returns one active draft; different tenants cannot inspect it; a Held Card write is independent of the draft. |
| Expiry | The injected clock expires drafts deterministically; sweep removes only incomplete artifacts and leaves active/historical records intact. |
| Publication | Finalization cannot make an unconfirmed candidate active; its Completion Proof differentiates published and awaiting-confirmation rules. |
| Recommendation | Recovery instructions are structured and candidate-scoped; retry requires matching `resultVersion` and remains read-only. |
