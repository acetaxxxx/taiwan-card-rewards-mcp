# Agent scenario playbook

Use this playbook after reading `references/mcp-tools.md`. The public
`tools/list` response and `src/mcp-contract.ts` are the schema authority; this
file defines only the order of reads, writes, and stopping conditions. On every
write, execute the server-returned action, then reread the named read tool.

## Recommendation

| Scenario | Start and read | Only allowed next step | Reread | Completion |
|---|---|---|---|---|
| Facts complete (fast path) | Call `recommend`; read `status`, `candidates`, `coverage`, `resultVersion`, and `requiredActions`. | Present only `ready` candidates from the returned scope. | No write; call `recommend` again only for a new page. | Every presented candidate is `ready`, with scope and source details. |
| Merchant ambiguity | Read `requiredActions[]` for `action: resolve_merchant`, its `candidateIds`, `path`, and `requiredFacts`. | Ask the user to choose; then call `recommend` with that resolved merchant, preserving the original intent. | `recommend` with the same intent and new merchant fact. | The merchant action is gone or the unresolved choice is explicitly reported. |
| Missing amount/currency, route, eligibility, or evidence | Read `requiredActions[]`, each `owner`, `path`, `requiredFacts`, `submission`, and candidate `exclusionReasons`; also read `fxResolutionRequest`. | For `owner:user`, ask only the named fact. For `owner:agent`, obtain the named evidence or route/card fact; submit through the returned `submission.tool` when present. | `recommend` with only the newly supplied fact/evidence. | The action is validated away, or the response remains `partial`/`needs_input` and is reported. |
| Typed retry: stale or conflicting facts | Read `resultVersion`, `requiredActions`, and the structured error (`code`, `path`, `requiredFacts`, `nextAction`). | Preserve the original intent; send only new `supplementalFacts` and the returned `expectedResultVersion`. Never merge facts locally. | Call `recommend` again from the original intent. | Retry returns a new validated result, or the conflict is surfaced without guessing. |
| Unverified/stale benefit | Read candidate `status`, `exclusionReasons`, and `requiredActions` for `refresh_external_data`/`review_candidate`. | Refresh the official source or use `create_ingestion` for the declared source scope; do not activate the old rule. | `get_ingestion` after each ingestion action, then `recommend` after completion. | A fresh verified rule is returned, or stale/unknown remains visible. |

## Official source ingestion

| Scenario | Start and read | Only allowed next step | Reread | Completion |
|---|---|---|---|---|
| Create or resume | Call `create_ingestion` with the source scope; read `flow`, `nextAction`, and `manifestCorrectionAction`/`coverage` when present. | Execute exactly the returned `nextAction`; an identical source scope resumes its draft. | `get_ingestion` after every write. | A current server action exists, or the flow is terminal with its proof/reason. |
| Submit source | Read `nextAction.kind: SUBMIT_SOURCE`, `actionId`, and `expectedRevision`. | Call `submit_ingestion_source` with that action and one immutable source capture. | `get_ingestion`. | `nextAction.kind` advances to `SUBMIT_MANIFEST`, or the server returns a typed unresolved state. |
| Submit manifest/leaf | Read `nextAction`, `coverage`, and for leaves `leafId`; use the server order and dependency blockers. | Call `submit_ingestion_manifest`, `submit_benefit_leaf`, or `submit_exclusion_leaf` exactly as returned, one item at a time. | `get_ingestion`; inspect `coverage.pendingLeafIds`, `blockedLeafIds`, and `blockedBy`. | Coverage has no pending/blocked leaves and `nextAction.kind` is `FINALIZE`. |
| Correct a manifest revision | Read `manifestCorrectionAction.actionId` and `expectedRevision`; retain the old revision in the response. | Call `correct_ingestion_manifest` with a new idempotency key and complete replacement manifest. | `get_ingestion`; verify `manifestRevision`, `manifestHistory`, and coverage. | New server revision is visible; stale action retries fail closed and same payload retries idempotently. |
| Finalize, awaiting confirmation, complete | Read `nextAction.kind: FINALIZE`, coverage, candidate artifacts, and `completionProof` when present. | Call `finalize_ingestion` only when the returned action permits it; if proof says awaiting confirmation, ask for confirmation and follow the returned action. | `get_ingestion`; on completion read `completionProof` and `leafTotals`. | `status: complete` plus immutable `completionProof`; never infer activation from candidates. |
| Expired or stale action | Read the error code/details and then the current flow with `get_ingestion`. | Use the newly returned action/revision, resume the existing draft, or create a new revision only when MCP says so. | `get_ingestion` after the recovery write. | A current action is accepted, or the terminal/error state is reported without resending stale input. |

## Actual ledger handoff

Start with the planned recommendation result and read its `status`, selected
candidate, payment route, FX status, and `requiredActions`. Only after the user
confirms an actual purchase call `record_transaction` (or the returned event
tool) with a stable idempotency key. Reread with the corresponding list/status
tool and report the stored transaction, reward decision, and cap effects. A
planned `recommend` result never writes the ledger; an unresolved response must
be resolved before handoff.
