# Cloudflare Tunnel MCP deployment

Status: ready-for-human

## Problem Statement

Users need to connect ChatGPT and Gemini to a private, multi-user rewards ledger hosted on a VPS through an existing Cloudflare Tunnel and Google-backed Access policy. The current HTTP adapter expects a different OAuth JWT and the PID file lock can prevent recovery after a container restart. The VPS also needs deployable images and safe administrator backup and account recovery operations.

## Solution

Use Cloudflare Access Managed OAuth and verify its signed per-user assertion at the origin, while keeping the existing OAuth and stdio modes. Run one HTTP process and one container on the VPS with isolated tenant data, distribute an image through GHCR, and provide offline administrator backup, restore, and identity recovery operations.

## User Stories

1. As a user, I want to sign in with my allowed Google account, so that I can connect my MCP client.
2. As a user, I want ChatGPT and Gemini to discover OAuth, so that I need not manually enter client credentials when dynamic registration works.
3. As a user, I want an isolated rewards ledger, so that another user cannot access it.
4. As a user, I want both MCP clients to access the same ledger when they have the same verified principal.
5. As an operator, I want invalid, expired, forged, wrong-audience, and machine assertions rejected, so that caller-supplied identities cannot select a ledger.
6. As an operator, I want HTTP updates to serialize within a single process, so that concurrent requests do not overwrite each other.
7. As an operator, I want restart after a crash without stale PID locks, so that the container recovers.
8. As an operator, I want a single instance and durable data volume, so that image updates preserve data.
9. As an operator, I want a manual full backup with seven retained by default, so that I can recover from mistakes.
10. As an operator, I want full and individual tenant restoration, so that unrelated tenants are not affected by a targeted restore.
11. As an operator, I want manually confirmed principal rebinding, so that a user whose Cloudflare subject changed can recover their existing ledger.
12. As an operator, I want verified images in public GHCR with branch, commit, main and version tags, so that the VPS can pull a traceable version.
13. As an existing stdio user, I want existing locking and behavior retained, so that local use remains compatible.
14. As an operator, I want a manual VPS rollout and rollback procedure, so that an image update cannot silently change Cloudflare settings.

## Implementation Decisions

- Explicit mutually exclusive authentication modes: existing JWT Bearer OAuth and Cloudflare Access. Access mode validates a Cloudflare-signed application assertion, configured issuer, application audience, expiry, type and nonempty personal subject; key retrieval failure is fail closed. Cloudflare owns public OAuth challenges and discovery in that mode.
- Both adapters produce a verified issuer/subject for the existing tenant registry. Different principals are isolated. No email-based automatic merge or machine identity. Allowlist resides in Cloudflare Access.
- HTTP single-process mode does not depend on stale PID lock files; stdio locking remains. A deployment operator must prevent simultaneous containers or direct writers sharing a data root. Store operations remain synchronous and atomic replace; the HTTP tenant registry reuses one store per tenant.
- Start with empty ledgers; no import from stdio. Merchant catalog remains per tenant despite the documented deployment-shared future target.
- Backups are manually initiated, cover the whole data root, and stay on the VPS. Stop and confirm the service is stopped; retain seven successful snapshots by default, configurable; prune only tool-owned snapshots after successful backup. No scheduled or off-site backups.
- Full and single-tenant restores replace the selected data, do not merge, require explicit target and confirmation, validate backup and preserve a pre-operation backup. Restore and rebind are offline, fail on conflicts, and do not affect unrelated tenants. Rebinding uses an administrator-controlled principal-to-tenant mapping to preserve historical owner identifiers; it must revoke the old principal, prevent collisions, fail closed on invalid mapping, and provide a rollback plan.
- Compose uses one container, persistent volume, loopback-only host port, non-root runtime, and a pinned image tag or digest. Existing cloudflared runs on VPS host. Release workflow runs checks before publishing, public GHCR, no VPS or Cloudflare changes.

## Testing Decisions

- Verify observable HTTP behavior with real signed test JWTs including missing/forged/expired/wrong issuer/audience/type/subject, rotation and no cross-user reads; preserve bearer/stdio behavior.
- Exercise persistence restart, multi-request write behavior, backup retention, failed backups, full/single restore, rebind and conflict rejection with realistic persisted data. Inspect prior persistence and MCP integration tests.
- Validate container and workflow configuration; actual Cloudflare, Google, ChatGPT, Gemini, and VPS integration remain acceptance steps after environment configuration.

## Out of Scope

- Off-site or scheduled backups, multi-replica storage, shared merchant catalog, migration of existing stdio ledgers, automatic deployment or changes to existing Cloudflare policy.

## Further Notes

- Cloudflare Managed OAuth returns opaque client tokens and forwards signed Access assertions. The Access subject may change when a user is removed and re-added or moves organizations.
- Confirm real client registration, redirect URIs, access policies, VPS architecture and permissions during deployment.

## Remaining acceptance work

- Feature-branch image publish now passes in [GitHub Actions run 40995141820](https://github.com/acetaxxxx/taiwan-card-rewards-mcp/actions/runs/40995141820). The new package is Private and anonymous manifest access returns 403; change it to Public in Package settings (GitHub makes this change irreversible), then confirm anonymous pull access.
- Configure an isolated Cloudflare Access application and Managed OAuth policy for the test hostname, preserving existing Tunnel and Access applications.
- Deploy on the target VPS with the host `cloudflared` route and verify startup, loopback-only host publishing, backups, restore, restart and rollback.
- Complete real ChatGPT and Gemini OAuth connection, PKCE, tool discovery and representative tool calls; verify two-user isolation and same-principal behavior across clients.
- Confirm no caller can bypass Access to the origin and operational logs contain no access tokens or private ledger data.
