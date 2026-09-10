# Implementation progress

Branch: enhance-user-exp

Implementation changes are committed incrementally on `enhance-user-exp`; the branch is not pushed by this workflow unless explicitly requested.

| Ticket | Progress | Evidence / next check |
| --- | --- | --- |
| 01 | Implemented and integrated | Public merchant-only entry, unified candidates/rule terms, three-route fixture, read-only and legacy checks; covered by the current full suite |
| 02 | Implemented and verified | Candidate-scoped recovery actions, multi-target/stale FX diagnostics, route-edge facts, source/scope metadata, intent preflight parity, and read-only retry; `npm run build`, `npm run typecheck`, and full suite passed (49 files / 208 tests) |
| 03 | In progress | FX policy typed ingestion/evidence gate plus candidate-scoped `research_fx_policy` actions; policy completeness/conflict validation and ingestion hooks remain |
| 04 | In progress | Scoped FX observation persistence/reuse, direct-card isolation, and exact edge-over-route selection are covered; full selector policy matching remains |
| 05 | In progress | Public reference/stale/unavailable output, fallback source, and merchant-first net-spend projection are covered; route fee/FX estimate comparison remains |
| 06 | In progress | Stable intent cursor and canonical `limit + page` pagination, 10-item pages, resultVersion and coverage semantics are covered; deeper rule-set continuation remains |
| 07 | In progress | Separate typed capability persistence, explicit transition requirements, and ephemeral wallet/account route generation are covered; binding actions and full candidate coverage remain |
| 08 | Pending 05, 06, 07 | Final Agent workflow and public contract validation |

Each slice is reviewed against the public contract and independent acceptance tests. A passing fixture alone is insufficient: rule matching, uncertainty, and candidate-specific recovery are reviewed before advancing dependencies.

Review note for 06: legacy payment-path IDs contain a serialized path signature, including evaluation facts. The new intent envelope should use bounded stable topology identities for candidate IDs, while resultVersion captures changing amounts/rates/state. Continuation must not use unbounded serialized candidate bodies as identity.
