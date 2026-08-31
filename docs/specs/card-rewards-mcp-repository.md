# taiwan-card-rewards-mcp: independent repository and Aion integration contract

Status: proposed for Phase 1

## Boundary

`taiwan-card-rewards-mcp` is an independent product repository. It owns the rewards
evaluator, file-backed store, MCP protocol adapter, public-source adapters,
release tags, and its own CI. Aion/AionCore owns conversation UX, Assistant
and Skill configuration, MCP process launch, and the parent process security
boundary. AionCore must not contain card, offer, transaction, or cap domain
logic.

The current `aion-self-host/card-rewards-core/` is a working copy and must be
preserved until the independent repository has passed remote CI and a release
review. It is not a reason to modify `aionCore/`.

## Release and reproducibility contract

- Every Aion descriptor pins an immutable package version, for example
  `taiwan-card-rewards-mcp@0.1.0`; never use `latest`, a moving tag, or an
  unbounded version range in production.
- The independent repository commits `package-lock.json`. CI uses a fixed
  Node version, `npm ci --ignore-scripts`, `npm run typecheck`, `npm run build`,
  and `npm test`.
- A release is a signed/approved Git tag and npm package whose tarball is
  inspected for only the intended `dist/` files. Release notes record the
  evaluator/schema version and migration compatibility.
- The MCP package does not open HTTP, SSE, or Streamable HTTP listeners. It
  communicates only through line-delimited JSON-RPC on stdin/stdout; logs go
  to stderr and contain no user payloads or secrets.

Example Aion stdio descriptor (illustrative; package version is mandatory):

```json
{
  "name": "taiwan-card-rewards-mcp",
  "transport": {
    "type": "stdio",
    "command": "npx",
    "args": ["--yes", "taiwan-card-rewards-mcp@0.1.0", "--data-dir", "/srv/aion/users/<user>/taiwan-card-rewards-mcp"]
  },
  "enabled": true
}
```

The actual data directory must be supplied by the trusted Aion parent at
process launch. It must not be an LLM-controlled tool argument.

## Identity and tenant trust boundary

- The parent creates one MCP process per Aion user and supplies one fixed,
  absolute, existing, readable `--data-dir` for that process.
- The MCP canonicalizes the path with `realpath`, rejects missing/non-directory
  paths, filesystem roots, unknown startup arguments, and tool-level path
  overrides. The canonical directory is the sole tenant boundary.
- `--user`, if present, is display/metadata only. It is not authorization,
  account selection, or a storage partition. The MCP must not expose a
  `user_id` field in tool schemas.
- Reusing one data directory is explicit data sharing. A chat message cannot
  switch data directory or user. Missing or malformed startup scope is a
  process-start failure, not an anonymous fallback.
- Tools/Skills/Agents may choose when to invoke a tool and provide business
  inputs; they cannot forge identity, change `data-dir`, select another
  tenant, or bypass fail-closed results.

## Skill and Assistant contract

The Aion Skill is an interaction adapter, not a second database or calculator.
It may:

1. collect merchant, MCC, country, channel, payment method, currency, amount,
   date, and planned/actual intent;
2. call `register_card`, `upsert_offer`, `recommend`, `record_transaction`,
   and `remaining_caps` with the MCP schemas;
3. display source URL, fetched time, rule version, cap period, and
   `unknown`/`stale`/`needs_review` states; and
4. ask the user for missing facts instead of guessing.

It may not store state in Markdown, invent a user id, pass arbitrary paths,
or convert an uncertain result into a recommendation. The Assistant/Agent
provides persona and tool-use policy only; deterministic reward and cap
calculation remains in the MCP package.

## Data and privacy contract

The MCP may persist card aliases/descriptors, public source snapshots and
versioned rules, actual transactions, idempotency keys, and derived cap usage
under the fixed data directory. It must never persist PAN, full card number,
CVV/CVC, OTP, cookies, bank credentials, provider keys, or session tokens.
Planned transactions are read-only. Actual transactions require an
idempotency key; duplicate keys with different payloads fail. Refunds require
an existing linked actual transaction. Missing rules, missing source snapshots,
stale/contradictory rules, missing FX, or missing cap usage fail closed.

## Safe migration from the current working copy

1. Freeze the current working copy and record its file list, package version,
   lockfile hash, and CI status. Do not delete it or mix it with AionCore.
2. Create the independent repository and copy only `card-rewards-core/` files
   into its repository root. Preserve `src/`, `tests/`, `fixtures/`,
   `package.json`, `package-lock.json`, `tsconfig.json`, README, and ignore
   rules. Review the npm package file list before publishing.
3. Move `.github/workflows/card-rewards-core.yml` to the independent repo's
   `.github/workflows/ci.yml`; remove the path filter, set working directory
   to repository root, and retain fixed Node plus `npm ci` checks.
4. Run CI remotely on a review branch, inspect the package tarball and MCP
   startup contract, then publish a versioned prerelease. Configure a test
   Aion MCP descriptor with that exact version and a disposable data directory.
5. After smoke/review approval, tag and publish the immutable release. Update
   Aion's descriptor/Skill reference in a separate change. Keep the original
   working copy until rollback is confirmed.

## Rollback

Rollback means pinning Aion to the previous known-good package version and
using its existing data directory. Never “repair” state by deleting a tenant
directory automatically; export, inspect, and migrate it explicitly.
