# requiredActions reference

`recommend` is the single recommendation entry point (see
[`recommendation-intent.md`](recommendation-intent.md) for the call loop). There
is no separate preflight tool — every diagnostic an Agent needs comes back on
the same `recommend` response as `requiredActions[]`, `fxResolutionRequest(s)`,
and each candidate's own `status`/`exclusionReasons`. This page is the
action-by-action playbook for resolving `requiredActions[]`.

Each entry has `id`, `action`, `owner` (`agent` or `user`), `path`,
`requiredFacts`, optional `candidateIds` (which candidates are affected),
optional `submission` (`{tool, field}` — where the recovered fact should be
sent), and `completionCondition`. Never guess past a `completionCondition`;
if no new fact or evidence is available, stop and report the partial/unknown
result instead of retrying endlessly.

## Action types

| `action` | `owner` | Meaning | Resolution |
|---|---|---|---|
| `resolve_merchant` | user | Merchant name matched more than one canonical candidate | Ask the user to pick one; call `resolve_merchant` directly if you need the candidate list, then repeat `recommend` with the resolved identity |
| `research_merchant` | agent | Merchant name did not match any known canonical identity | Research the merchant (official source, resolve_merchant with tighter facts); do not invent a canonical ID |
| `ask_user` | user | A user-owned fact is missing (amount/currency, at least one held card or payment method, or — via `fxResolutionRequest.retryAction` — the FX conversion owner for an actual settlement) | Ask the user the specific missing fact named in `requiredFacts`, then repeat `recommend` |
| `bind_payment_method` | user | A payment capability could generate a route, but the user has no matching held card/account | Register the missing card or account (`submission.tool` names `register_card` or `register_payment_account`), then repeat `recommend` |
| `review_payment_route` | agent | A registered route was blocked (e.g. missing/expired edge evidence) | Refresh the route's evidence via `upsert_payment_route` (`submission.tool`), then repeat `recommend` |
| `review_candidate` | agent | A candidate is `unknown`/`blocked` for a reason not covered by another action (see the candidate's own `exclusionReasons`) | Obtain the missing evidence/fact named in `requiredFacts`, then repeat `recommend` |
| `query_approved_fx_source` | agent | A candidate needs a foreign-currency conversion and no usable `fx` was supplied (see `fxResolutionRequest`) | Fetch a current rate from an appropriate source and add it as `fx` (or a `routeFacts` entry), then repeat `recommend` — see the FX section in `recommendation-intent.md` |
| `refresh_external_data` | agent | A supplied `fx` snapshot was stale or mismatched, or an offer rule needs a newer source | Refresh the relevant snapshot/`fx` and repeat `recommend` |

## Non-blocking note

`coverage.notes` carries informational context only (scope disclaimers, whether
path exploration was bounded) — never a blocking condition. A candidate can be
`ready` even while other candidates in the same response carry
`requiredActions`.
