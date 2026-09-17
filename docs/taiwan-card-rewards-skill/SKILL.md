---
name: taiwan-card-rewards
description: "Route Taiwan credit-card rewards requests to the correct MCP workflow: planned recommendation, official evidence and onboarding, or actual transaction and reward ledger handling."
---

# Taiwan Card Rewards

Use this as the installed bundle's base skill. Before constructing an MCP payload, read [`references/mcp-tools.md`](references/mcp-tools.md). Then choose one task skill. For any response with `nextAction`, `requiredActions`, diagnostics, manifest coverage, or typed retry fields, also load [`agent-scenario-playbook.md`](workflows/agent-scenario-playbook.md) and follow its read → single action → reread loop. For real-world operational scenarios (user corrections/write-back, marketing vs contract terms, channel exceptions, dual-rail FX spread drag, and statement reconciliation), follow [`workflows/agent-real-world-scenarios.md`](workflows/agent-real-world-scenarios.md):

| User intent | Load |
|---|---|
| Which card, offer, wallet route, or FX choice is best for a future purchase? | [`card-rewards-recommendation`](card-rewards-recommendation/SKILL.md) |
| Research official terms, resolve a merchant, or save a card, route, account, offer, or benefit fact? | [`card-rewards-evidence`](card-rewards-evidence/SKILL.md) |
| Record an actual transaction, refund, event reward, reversal, or inspect a reward cap? | [`card-rewards-ledger`](card-rewards-ledger/SKILL.md) |

If the user has not said whether a purchase is planned or actual, ask before a write. When a response is `unknown`, `stale`, `needs_review`, or contains `requiredActions`, follow the selected skill's recovery flow and keep the result unresolved until the required fact or official evidence is available.

## Canonical action loop

The MCP owns workflow state. On every write or recovery step, execute only the
tool and arguments named by the returned `nextAction`/`requiredActions`, then
call the corresponding read tool (`get_ingestion` or `recommend`) again. Never
invent an action order, mutate a phase, mark a manifest complete, or describe a
candidate as active before the MCP returns its completion proof. If an action is
stale or expired, reread state; resume the existing source-scoped draft when it
is still available, and create a new revision only when the MCP requires it.

Field names and constraints come from the public `tools/list` response and
[`src/mcp-contract.ts`](../../src/mcp-contract.ts); this skill contains semantic
workflow guidance only and does not duplicate the JSON schema.

This bundle is runtime guidance only. MCP installation, host configuration, repository development instructions, ADRs, and implementation notes live outside it.
