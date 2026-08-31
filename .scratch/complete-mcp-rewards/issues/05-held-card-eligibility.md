# 05: Support Card Product, Held Card, and Eligibility Facts

**What to build:** Calculation and recommendation requests distinguish issuer Card Products from user-held cards and their eligibility/plan facts, so missing eligibility inputs produce explicit uncertainty.

**Blocked by:** 02: Add Predicate AST evaluation and the Calculation Trust Gate

**Status:** ready-for-agent

- [ ] Stateless calculation inputs can represent Card Products, Held Cards, and Eligibility Facts separately.
- [ ] Product terms are not inferred as proof that a user holds or qualifies for a card/plan.
- [ ] Required missing or conflicting eligibility facts return explicit unknown or needs-review results.
- [ ] Matching and exclusions use the correct held-card and eligibility context.
- [ ] Tests cover eligible, ineligible, missing, and conflicting facts.
