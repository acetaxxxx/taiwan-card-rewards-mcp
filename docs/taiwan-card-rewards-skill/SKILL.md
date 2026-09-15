---
name: taiwan-card-rewards
description: "Route Taiwan credit-card rewards requests to the correct MCP workflow: planned recommendation, official evidence and onboarding, or actual transaction and reward ledger handling."
---

# Taiwan Card Rewards

Use this as the installed bundle's base skill. Before constructing an MCP payload, read [`references/mcp-tools.md`](references/mcp-tools.md). Then choose one task skill:

| User intent | Load |
|---|---|
| Which card, offer, wallet route, or FX choice is best for a future purchase? | [`card-rewards-recommendation`](card-rewards-recommendation/SKILL.md) |
| Research official terms, resolve a merchant, or save a card, route, account, offer, or benefit fact? | [`card-rewards-evidence`](card-rewards-evidence/SKILL.md) |
| Record an actual transaction, refund, event reward, reversal, or inspect a reward cap? | [`card-rewards-ledger`](card-rewards-ledger/SKILL.md) |

If the user has not said whether a purchase is planned or actual, ask before a write. When a response is `unknown`, `stale`, `needs_review`, or contains `requiredActions`, follow the selected skill's recovery flow and keep the result unresolved until the required fact or official evidence is available.

This bundle is runtime guidance only. MCP installation, host configuration, repository development instructions, ADRs, and implementation notes live outside it.
