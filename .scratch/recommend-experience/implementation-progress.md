# Implementation progress

Branch: enhance-user-exp

Implementation changes are committed incrementally on `enhance-user-exp`; the branch is not pushed by this workflow unless explicitly requested.

| Ticket | Progress | Evidence / next check |
| --- | --- | --- |
| 01 | Implemented and integrated | Public merchant-only entry, unified candidates/rule terms, three-route fixture, read-only and legacy checks; covered by the current full suite |
| 02 | Implemented and verified | Candidate-scoped recovery actions, multi-target/stale FX diagnostics, route-edge facts, source/scope metadata, intent preflight parity, and read-only retry; `npm run build`, `npm run typecheck`, and full suite passed (49 files / 208 tests) |
| 03 | In progress | FX policy typed ingestion/evidence gate plus candidate-scoped `research_fx_policy` actions; policy completeness/conflict validation and ingestion hooks remain |
| 04 | Core persistence/reuse implemented | Scoped FX observation persistence and recommendation reuse; full selector policy matching remains |
| 05 | Core estimate semantics implemented | Public reference/stale/unavailable output and fallback source; route fee/net comparison remains |
| 06 | Core continuation implemented | Stable intent cursor, 10-item pages, resultVersion and coverage semantics; deeper rule-set continuation remains |
| 07 | In progress | Added separate typed payment capability persistence and ephemeral wallet route generation from active capabilities plus held cards; account generation, capability transition semantics, and full candidate coverage remain |
| 08 | Pending 05, 06, 07 | Final Agent workflow and public contract validation |

Current work uses scoped sub-agents for implementation and documentation; the primary agent reviews source and adds independent acceptance tests. A passing fixture alone is insufficient: rule matching, uncertainty, and candidate-specific recovery are reviewed before advancing dependencies.

Review note for 06: legacy payment-path IDs contain a serialized path signature, including evaluation facts. The new intent envelope should use bounded stable topology identities for candidate IDs, while resultVersion captures changing amounts/rates/state. Continuation must not use unbounded serialized candidate bodies as identity.
