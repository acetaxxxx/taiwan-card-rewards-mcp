# Authoring a Card-Rewards Agent Skill

This guide helps an AI agent create a thin, portable skill that uses
`taiwan-card-rewards-mcp`. The skill is an interaction adapter: the MCP owns
deterministic calculations, source/rule provenance, and the user-scoped ledger.
The skill may ask questions and select when to call tools, but it does not
become a second database or calculator. A copyable starting point is
[`card-rewards-skill-template.md`](card-rewards-skill-template.md).

## 1. Define the boundary before writing files

Write down the skill's user-facing jobs (for example, discover offers, compare
cards, record a purchase, or inspect a benefit switch) and the MCP tools each
job uses. Keep the skill portable: do not embed a user ID, data directory,
credential, token, machine path, or provider-specific private configuration.
Do not create a fixed auto-installer. The host or user chooses installation,
permissions, and package version.

The skill should contain conversation policy and display formatting only. Put
money arithmetic, cap usage, rule matching, source trust, idempotency, and
refund accounting behind MCP calls.

Completion criterion: every skill action has a named MCP tool or is an explicit
user question; no action requires the skill to calculate or persist ledger truth.

## 2. Pin and validate the MCP connection

Use a published immutable package version in deployment configuration. Never
use `latest`, a moving tag, an unbounded range, or a model-provided command
path. Updates are deliberate: review the release notes, update the pinned
version, run the host's handshake/tool smoke check, then deploy.

At startup, validate the MCP handshake and tool list before business calls:

1. Confirm the expected protocol and server identity.
2. Confirm every required tool exists with the expected input shape.
3. Confirm the process is bound by the trusted host to the intended user scope.
4. Treat a missing, malformed, or unexpected handshake as unavailable.

When a call fails, return a clear unavailable/error state and ask the user or
operator to repair the connection. Do not generate fallback calculation code,
silently use a different data store, or turn an MCP error into a recommendation.

Completion criterion: the skill can stop safely at handshake failure and can
prove that each write call uses a validated schema.

## 3. Research and ingest offers in layers

Prefer first-party issuer/bank/network pages and official terms. Third-party
articles, search results, screenshots, OCR, and user-provided text are useful
candidate evidence, not authoritative rules. Preserve the distinction:

- source snapshot: URL, fetched/snapshot time, content hash or fingerprint, and
  parser/provenance metadata;
- rule version: declarative conditions, reward unit/rate, caps, effective dates,
  and the source snapshot it interprets;
- user state: held card, enrollment, plan selection, and usage facts.

Never activate a candidate merely because it was fetched or parsed. Keep
unknown, conflicting, stale, or unreviewed candidates visible with their reason.
When an offer changes, fetch a new snapshot and create a new rule version with
new effective dates; preserve prior versions for historical transactions.

Completion criterion: every displayed offer has a traceable source snapshot,
rule version, effective interval, and explicit data status.

## 4. Follow the update and recommendation workflow

For an offer refresh, gather the official URL, capture the snapshot, translate
the evidence into typed declarative fields, and submit it through the MCP. Ask
the user to resolve missing eligibility facts or confirm candidate terms before
claiming a confident result.

For a recommendation:

1. Collect merchant/MCC, country, channel, payment method, amount and currency,
   date, and planned/actual intent.
2. Load the user's cards and relevant enrollment/plan facts.
3. Call the calculation or ranking tool with the source/rule and FX context.
4. Show reward unit, currency, cap period/remaining cap, rule version, source
   time, and all unknown/stale/needs-review reasons.
5. Present the result as facts and options. The agent may recommend based on
   user preferences, but the evaluator remains the calculation authority.

Planned evaluation is read-only. For an actual purchase, obtain a stable,
client-generated idempotency key and call the recording tool only after the
user confirms that the transaction is real. For a refund, require a recorded
purchase link and preserve the original accounting context.

For card benefit switching, inspect status and candidates first. Record or
adjust a switch only after the user confirms the completed bank-app action.
Same-day repeat writes may be accepted with a warning; the skill should show
`alreadySwitchedToday` and let the user decide.

Completion criterion: every recommendation and write displays its provenance,
scope, status, and user-confirmation boundary.

## 5. Ask-user question templates

Use short, answerable questions. Ask only for facts that change the result:

```text
To calculate this offer, I need: [merchant/MCC, country, channel, payment
method, amount/currency, or date]. Which value should I use?
```

```text
This offer is [candidate/stale/needs_review] because [reason]. The official
source is [URL], captured [time], rule version [version]. Do you want to
review and confirm these terms?
```

```text
I have a planned spend of [amount/currency]. Should I only calculate it, or
did it already settle and should I record it with an idempotency key?
```

```text
The bank app action must be completed before I record it. Did you complete the
switch, and may I save the confirmed benefit [benefit] for this card?
```

Completion criterion: a missing fact produces a question, not an assumption;
every mutation has an affirmative user confirmation immediately before it.

## 6. Final review checklist

- MCP package/version is pinned and handshake/tool schemas are checked.
- MCP errors stop the flow; no fallback calculator, anonymous scope, or default
  data store is introduced.
- Official sources are preferred and third-party material remains candidate
  evidence.
- Snapshots, rule versions, effective dates, eligibility, reward units, caps,
  and FX provenance remain visible.
- User identity and data scope come from the trusted host, never tool input.
- Planned calls do not write; actual writes use idempotency; refunds link to a
  recorded purchase.
- Every write (offer activation, transaction, enrollment, or switch) follows
  explicit user confirmation.
- No PAN, CVV/CVC, OTP, password, cookie, bank credential, session token, or
  private local configuration appears in the skill.

The skill is ready when all checklist items are true and the host's own
handshake, schema, and package smoke checks pass.
