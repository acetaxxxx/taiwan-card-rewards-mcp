# Merchant-first recommendation workflow

Use this workflow for a user asking what to use at a merchant. `recommend` is
planned and read-only: it does not write transactions or consume caps. Do not
list cards/routes first. `recommend` is the single entry point — there is no
separate preflight call; its `candidates` array already mixes direct-card and
payment-path results in one ranked list.

## Steps

1. Build one intent object. Required: `merchant` (string, or an object with at
   least one of `name`, `rawStatement`, `canonicalId`, `canonicalNameZhHant`).
   Add only known `amount` (`amountMinor` + `currency`), `country`, `market`,
   `channel`, `paymentMethod`, and ISO `occurredAt`. Add `cardIds` or `routeIds`
   only when the user explicitly limits comparison. `limit` is 1..128 (default
   page size 10), and `page` is 1-based (default 1). Use `limit` + `page` for
   normal continuation; `cursor` is retained only for legacy callers. Never
   choose a `ruleId`. For foreign currency, fetch the current rate yourself and
   add it as `fx` (see the FX section below).
2. Call `recommend` with that intent.
3. Read `status`, typed `candidates`, `requiredActions`, `coverage`,
   `page`, `pageSize`, `hasMore`, `resultVersion`, and `evaluatedAt`. Each candidate has `kind` (`direct_card` or `payment_path`),
   `status`, `matchedRules`, and `exclusionReasons`; show those facts without
   turning `unknown`/`blocked` into zero reward.
4. Branch on the result:
   - `ready`: present ready candidates and their rule/source details. Completion
     check: every presented candidate is marked `ready` and its scope is stated.
   - `partial`: present ready candidates, label unresolved candidates/actions,
     and continue only with new evidence or user facts. Completion check: each
     action is either completed by a validated retry or explicitly reported as
     pending.
   - `needs_input`: ask only the user fact named by a user-owned action (for
     example merchant choice or amount/currency). Agent-owned actions require
     external research, not a guessed answer. Completion check: the requested
     fact/evidence is present before retrying.
   - `no_match`: report no match only within `coverage`; do not claim the
     market has no offer.
5. Preserve the original intent on every retry. Apply only the new fact/evidence
   or FX data; call the same `recommend` entry again and let MCP recompute.
   If the response has the same unresolved action(s) and no new evidence or
   user fact is available, stop: report the partial/unknown result and ask only
   the needed user fact. Do not retry endlessly.

See [`preflight-and-required-actions.md`](preflight-and-required-actions.md) for
the full action-type-by-action-type playbook (what each `requiredActions[].action`
means and how to resolve it).

## FX

For any foreign-currency amount, fetch the current rate yourself and attach it
inline as a single `fx` snapshot (`id`, `baseCurrency`, `quoteCurrency`,
`ratePpm`, `capturedAt`, `provider`, `rateType`, optional `sourceUrl`/
`contentHash`/`maxAgeSeconds`). It is trusted directly once it passes the
currency-pair and freshness checks — there is no separate policy or observation
storage step. If a candidate needs FX but none was supplied (or the supplied
snapshot is stale or mismatched), `recommend` returns a
`requiredActions[]` entry with `action: "query_approved_fx_source"` (or
`"ask_user"` when the conversion owner cannot be determined for an actual
settlement) and a machine-readable `fxResolutionRequest` describing
`baseCurrency`, `quoteCurrency`, `conversionOwner`, `suggestedRateTypes`, and
`sourceUrls`/`referenceSourceUrls` to check. Fetch a fresh rate from an
appropriate source, add it as `fx` (or, for a specific route/edge, as an entry
in `routeFacts`), and repeat the same intent.

`routeFacts` entries identify `routeId`, optional `edgeId`, and one matching FX
snapshot; duplicate route/edge scopes are invalid, and an exact `routeFacts`
match takes priority over the general `fx` field for that edge. If research
fails, retain the candidate's `unknown`/estimate label (see `fxEstimate.status`
on the candidate) and report the source failure. Never invent a rate or fall
back to 1:1.

## Pagination recovery

When `hasMore` is true, request the next 1-based `page` with the same intent,
`limit`, `occurredAt`, and the returned `resultVersion`. Keep `resultVersion`
stable across pages. If the
result version changes, restart at page 1 and report that the underlying user
data changed. `nextCursor` may be used only by legacy integrations.

## Scope limits

Results are bounded to the current user state and declared coverage. Continue
with `page` while `hasMore` is true; `coverage.total` is authoritative
only when `explorationComplete` is true. An `fxEstimate` remains an estimate
(see its `status`) until the applicable provider rate is confirmed.
