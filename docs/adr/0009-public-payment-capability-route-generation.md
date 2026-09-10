# Public payment capability to ephemeral route generation

**Status**: Accepted

Public `PaymentCapabilityRecord` and user-owned funding facts are separate bounded contexts: capability records describe evidence-backed provider transitions, while cards and accounts describe private ownership or binding. Planned recommendations may deterministically combine an active capability with matching user funding into an ephemeral `PaymentRouteRecord`-shaped candidate whose identity is `generated_<capability-id>_<funding-id>`; it is never written to durable `paymentRoutes`. Generation is valid only while the capability, its accepted official evidence, transition set, validity window, and funding fact remain current, so capability status/evidence changes or funding removal naturally invalidate the candidate without rewriting history. A missing funding fact produces a capability-scoped binding action rather than an inferred route.

## Consequences

- Public capability data can be reused across users without exposing user ownership facts.
- Generated candidates are reproducible within one recommendation result but are not durable route identities.
- Offer rules may bind to a generated route only for the planned evaluation; durable rule and transaction records continue to reference durable route or typed facts.
- User denial applies to a durable route record; it does not mutate the public capability or silently create a negative global fact.
