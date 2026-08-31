# 03: Deliver deterministic uncertainty-aware Top-5 ranking

**What to build:** A card comparison request returns at most five deterministic Reward Breakdowns, ranking confident results before uncertain results while preserving every uncertainty reason.

**Blocked by:** 02: Add Predicate AST evaluation and the Calculation Trust Gate

**Status:** ready-for-agent

- [ ] `ok` results rank before `unknown`, `stale`, and `needs_review` results.
- [ ] Ranking uses an explicit stable tie-break that includes card identity and never depends on iteration order.
- [ ] Results are limited to five without hiding the status or reasons of returned entries.
- [ ] Repeated identical requests produce byte-equivalent ordering and values.
- [ ] Tests cover ties, no-match cards, uncertainty, truncation, and repeated requests.
