# Implementation progress

Branch: enhance-user-exp

Implementation changes are committed incrementally on `enhance-user-exp`; the branch is not pushed by this workflow unless explicitly requested.

| Ticket | Progress | Evidence / next check |
| --- | --- | --- |
| 01 | Implemented and integrated | Public merchant-only entry, unified candidates/rule terms, three-route fixture, read-only and legacy checks; covered by the current full suite |
| 02 | Implemented and verified | Candidate-scoped recovery actions, multi-target/stale FX diagnostics, route-edge facts, source/scope metadata, intent preflight parity, and read-only retry; current full suite passed (51 files / 236 tests) |
| 03 | Implemented and verified | FX policy typed ingestion/evidence gate, candidate-scoped `research_fx_policy` actions, and optional missing-policy requirements on card/offer/route ingestion are covered by public schema, dispatcher, service, and tests |
| 04 | Implemented and verified | Scoped FX observation persistence/reuse, direct-card isolation, exact edge-over-route selection, policy rate compatibility, refresh actions, and read-only retry are covered by targeted and full tests |
| 05 | Implemented and verified | Public reference/stale/unavailable output, policy freshness windows, fallback source, route FX status, merchant-first net-spend projection, research fields for estimate windows, and multi-route fee/FX ranking are covered by targeted and full tests |
| 06 | Implemented and verified | Stable intent cursor and canonical `limit + page` pagination, resultVersion-bound restart, 10-item pages, route rule-set coverage, actions and coverage semantics are covered by targeted and full tests |
| 07 | Implemented and verified | Separate typed capability persistence, explicit transition requirements, ephemeral wallet/account route generation, capability-scoped binding actions, ADR 0009 ownership/version strategy, layered reward projection, and duplicate-rule protection are covered by targeted and full tests |
| 08 | In progress | Canonical workflow, default usable routes, page pagination, FX recovery guidance, and public contract checks are aligned; deterministic public trace now covers direct recommendation, FX recovery/retry, observation refresh, and page continuation; actual model trace remains |

Each slice is reviewed against the public contract and independent acceptance tests. A passing fixture alone is insufficient: rule matching, uncertainty, and candidate-specific recovery are reviewed before advancing dependencies.

Review note for 06: legacy payment-path IDs contain a serialized path signature, including evaluation facts. The new intent envelope should use bounded stable topology identities for candidate IDs, while resultVersion captures changing amounts/rates/state. Continuation must not use unbounded serialized candidate bodies as identity.
