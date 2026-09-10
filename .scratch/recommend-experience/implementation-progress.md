# Implementation progress

Branch: enhance-user-exp

Implementation changes are not committed or pushed yet. Planning commit: 0924840.

| Ticket | Progress | Evidence / next check |
| --- | --- | --- |
| 01 | Implemented and integrated | Public merchant-only entry, unified candidates/rule terms, three-route fixture, read-only and legacy checks; covered by the current full suite |
| 02 | Implemented and verified | Candidate-scoped recovery actions, multi-target/stale FX diagnostics, route-edge facts, source/scope metadata, intent preflight parity, and read-only retry; `npm run build`, `npm run typecheck`, and full suite passed (49 files / 208 tests) |
| 03 | Pending 02 | Policy ingestion and persistence |
| 04 | Pending 03 | FX observation persistence and reuse |
| 05 | Pending 04 | Reference/stale estimates and refresh |
| 06 | Pending 02 | Complete continuation, 10 per page |
| 07 | Pending 03, 06 | Evidenced generated route candidates |
| 08 | Pending 05, 06, 07 | Final Agent workflow and public contract validation |

Current work uses scoped sub-agents for implementation and documentation; the primary agent reviews source and adds independent acceptance tests. A passing fixture alone is insufficient: rule matching, uncertainty, and candidate-specific recovery are reviewed before advancing dependencies.

Review note for 06: legacy payment-path IDs contain a serialized path signature, including evaluation facts. The new intent envelope should use bounded stable topology identities for candidate IDs, while resultVersion captures changing amounts/rates/state. Continuation must not use unbounded serialized candidate bodies as identity.
