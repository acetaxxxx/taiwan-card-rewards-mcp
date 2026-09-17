---
name: card-rewards-evidence
description: Research official Taiwan card-rewards terms and register cards, payment accounts, routes, or offers with traceable non-sensitive evidence.
---

# Taiwan card-rewards evidence

Before constructing an MCP payload, read the shared [`mcp-tools.md`](../references/mcp-tools.md). Use this skill when the task is official offer research, merchant verification, or onboarding a card, payment account, route, or benefit fact. When an ingestion response exposes `nextAction`, `coverage`, diagnostics, or a manifest revision, load [`agent-scenario-playbook.md`](../workflows/agent-scenario-playbook.md) for the exact source, manifest, correction, and finalization loop.

- Follow [`workflows/research-and-evidence-submission.md`](workflows/research-and-evidence-submission.md) for official-source research and evidence-backed offer updates.
- Follow [`workflows/card-onboarding-and-benefit-enrollment.md`](workflows/card-onboarding-and-benefit-enrollment.md) to save reusable, non-sensitive user facts.

For official ingestion, use the server-owned action loop:
`create_ingestion` (which resumes an existing source scope) → `get_ingestion` →
the returned submit action → `get_ingestion` again. Submit one source, manifest,
or leaf at a time; never choose a leaf order or claim completion. If an action
is expired, reread the flow and start the new revision returned by MCP instead of
resending the old action or opening a duplicate draft.

Keep a source snapshot, effective period, conditions, and confirmation traceable. When evidence conflicts or is incomplete, retain the MCP status and ask for the missing fact rather than activating an offer or route.
