# Merchant-first recommendation workflow

Use this workflow for a user asking what to use at a merchant. `recommend` is
planned and read-only: it does not write transactions or consume caps. Do not
list cards/routes first. `recommendation_preflight` accepts the same intent as
an optional diagnostic; its legacy `{ transaction, context }` shape remains
supported.

## Steps

1. Build one intent object. Required: `merchant` (string, or an object with at
   least one of `name`, `rawStatement`, `canonicalId`, `canonicalNameZhHant`).
   Add only known `amount` (`amountMinor` + `currency`), `country`, `market`,
   `channel`, `paymentMethod`, and ISO `occurredAt`. Add `cardIds` or `routeIds`
   only when the user explicitly limits comparison. `limit` is 1..128 (default
   page size 10). Use `cursor` only to continue the same result. Never choose a
   `ruleId`.
2. Call `recommend` with that intent. If using the optional diagnostic instead,
   call `recommendation_preflight` with the same intent. Do not convert a
   preflight result into a separate transaction or choose a card from it.
3. Read `status`, typed `candidates`, `requiredActions`, `coverage`,
   `pageSize`, `hasMore`, `nextCursor`, `resultVersion`, and `evaluatedAt`. Each candidate has `kind` (`direct_card` or `payment_path`),
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

## FX recovery

`fxResolutionRequest` (or `fxResolutionRequests`) is a lookup request, not an
observation. Use its `baseCurrency`, `quoteCurrency`, `asOf`, `conversionOwner`,
`suggestedRateTypes`, `rateDirection`, `scope`, `sourceStatus`, `purpose`,
`freshness`, `requiredFields`, `sourceUrls`, `referenceSourceUrls`, and
`submission` exactly as given.

For planned requests, `referenceSourceUrls` may provide the BOT URL as a public
fallback. A submitted `fxObservation` from that source is a
`reference_estimate`, not a card, wallet, issuer, or merchant settlement policy.
For `discovery_required` or actual use, discover the real approved source; do
not fall back to BOT as confirmed policy. Return the validated typed FX snapshot
through the requested `submission` (usually `recommend.fxObservation` for a
public reference, `recommend.fx` for a policy quote, or `recommend.routeFacts`)
and repeat the original intent. `routeFacts` entries
identify `routeId`, optional `edgeId`, and one matching FX scope; duplicate
route/edge scopes are invalid. Use `upsert_fx_observation` when the observation
should be reused, preserving `sourceKind: public_reference` for public rates.

If research fails, retain the candidate's `unknown`/estimate label and report the
source failure. Never invent a source, rate, field, or completion.

## Scope limits

Results are bounded to the current user state and declared coverage. Continue
with `nextCursor` while `hasMore` is true; `coverage.total` is authoritative
only when `explorationComplete` is true. Public reference estimates remain
estimates until the applicable provider policy is confirmed.
