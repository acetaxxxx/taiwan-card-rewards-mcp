# 04: Govern official source snapshots and candidate activation

**What to build:** User-assisted offer input becomes an auditable candidate and can become an active Rule Version only after traceable official provenance, complete semantics, and explicit Offer Confirmation.

**Blocked by:** 02: Add Predicate AST evaluation and the Calculation Trust Gate

**Status:** ready-for-agent

- [ ] Structured candidate input records source description, submitter, timestamp, content fingerprint, and required offer semantics.
- [ ] Official provenance may be a URL, page, announcement identifier, or equivalent traceable source description; absent provenance cannot activate a rule.
- [ ] Offer Confirmation explicitly covers source, period, conditions, exclusions, reward unit, and cap.
- [ ] Candidate, active, stale, and needs-review transitions are explicit and cannot be silently bypassed.
- [ ] Source changes create immutable versions and historical calculations retain their original version.
- [ ] Raw images are not retained by default; image/OCR handling remains outside the MCP boundary.
