# 02: Add Predicate AST evaluation and the Calculation Trust Gate

**What to build:** Reward rules can be represented and evaluated as validated Predicate ASTs, while only active, provenance-backed, confirmed, valid rules can produce a confident reward result.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] AND, OR, NOT, field matching, thresholds, and exclusions evaluate deterministically.
- [ ] Malformed nodes, unknown operators/fields, and invalid values fail as validation errors.
- [ ] Missing facts, stale sources, invalid status, missing provenance, missing confirmation, conflicting rules, and missing FX return explicit fail-closed statuses.
- [ ] The evaluator—not only its caller—enforces the Calculation Trust Gate.
- [ ] Pure calculator tests cover successful and uncertain outcomes with exact reasons.
