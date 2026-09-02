# ADR 0004: Generic benefit status and schema v2

## Decision

Use one generic benefit-status boundary with discriminated `card_switch` and
`campaign_registration` state. Represent reward combination policies and cap
pools explicitly, and use schema v2 as a breaking boundary requiring an
explicit migration or reset. Benefit state is current-state for this phase,
not append-only event sourcing.

## Consequences

Agents can distinguish immediately available offers from action-required
candidates and preserve source/rule provenance. Unknown semantics remain
needs-review. Existing schema data is never deleted automatically; operators
must choose migration or reset.
