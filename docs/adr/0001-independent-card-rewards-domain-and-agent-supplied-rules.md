---
status: accepted
---

# Independent Card Rewards Domain with Agent-Supplied Rules

`taiwan-card-rewards-mcp` is an independent Card Rewards bounded context. The
MCP owns Card Products, Offer Rules, deterministic Reward Calculations, and the
Reward Ledger; an AI agent owns public-source research, translation into typed
declarative rules, user questions, and contextual Recommendations. We choose
this boundary over embedding the domain in AionCore, putting calculation in a
Markdown Skill, or starting with a stateless MCP because the same auditable
calculator and user data must be reusable by Aion or another AI client without
making prompts the authority for money or cap accounting.

## Consequences

- Offer Evidence and Rule Versions must retain source, validity, and review
  provenance; agent-supplied rules are data, not executable code.
- The evaluator must preserve native reward units, currency context, cycles,
  caps, eligibility facts, idempotency, refunds, and explainable outcomes.
- The MCP may expose explicit sorting, but it does not own semantic ranking or
  the user's final recommendation.
- Unknown conditions, stale evidence, conflicting rules, and unsupported
  operators remain non-confident outcomes until the agent refreshes or asks the
  user.
- Storage and transport can evolve from a local client to a sidecar while the
  Card Rewards language and evaluator boundary remain stable.

## Boundary scenarios

- A user enters a new card name that cannot yet be matched to a product. It is
  retained as an Unresolved Card, but no confident reward is calculated.
- A plan or enrollment changes between two purchases. Each purchase uses the
  Eligibility Facts effective at its own time; the earlier result is not
  rewritten.
- A cap period rolls over, or a purchase is refunded after rollover. The new
  period starts with its own cap, while the refund still references and offsets
  the original period and Rule Version.
- A planned purchase is evaluated several times before the user decides. It
  never consumes a Reward Cap; only the eventual Recorded Purchase enters the
  Reward Ledger.
- The same actual purchase is recorded twice with the same identity. The second
  request returns the original result; a different payload is rejected rather
  than appended.
- An official source is stale, two active rules conflict, or a required FX
  observation is missing. The result is non-confident and asks for refresh or
  clarification instead of silently choosing a rule.
