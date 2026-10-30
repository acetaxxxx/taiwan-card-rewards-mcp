# Offline MCP backup and recovery on a VPS

The HTTP MCP service stores user ledgers and principal bindings in the `/data` named volume. The administrator wrapper stops the Compose `mcp` service and verifies that no running Docker container mounts the named volume before starting a one-off administrator container. It restarts the service afterward only if it was already running and no interrupted restore remains. The wrapper and the service must run on the **same VPS and Docker daemon**, with the same Compose project name and named volume. Use the same SSH administrator account for all maintenance; its per-volume lock is stored under `~/.local/state/taiwan-card-rewards-mcp/`, independent of `TMPDIR` and the Compose checkout path. Do not run other services, host processes, or another Compose project against the volume; the wrapper cannot detect a process directly modifying Docker's host volume files or prevent an administrator from bypassing the wrapper.

Copy `compose.yaml`, its required `.env`, and `scripts/mcp-admin.sh` together to the VPS, and run commands from that Compose directory. The image must contain `dist/admin-cli.js`; the wrapper uses the same image, named volume, and non-root user as the service. It requires Docker Compose, `flock`, `sha256sum`, and Linux Bash. Create the Compose service at least once before using the wrapper. This wrapper supports the named volume mounted at `/data`; it refuses bind mounts. Protect the Compose files, `.env`, data volume, and backups with appropriate host permissions. No command uploads a backup off the VPS.

## Create and inspect backups

```sh
./scripts/mcp-admin.sh backup
./scripts/mcp-admin.sh list
```

Backups are in `/data/.backups` on the named volume, separate from the backed-up data tree. Each backup has a manifest, checksums, and a complete snapshot of all tenant directories and principal bindings. Legacy FileStore lock files and unfinished JSON temporary files are excluded. Symlinks and unexpected root entries are refused. The default retention is seven completed backups; set `MCP_BACKUP_KEEP` in the shell before running the wrapper to change it. A failed backup never prunes old backups; retention runs only after the new snapshot has passed validation. Backups contain all users' private data: do not publish them or place them inside an image. Local backups are lost if the VPS or its storage is lost.

Back up before deployments and administrator recovery. The wrapper briefly interrupts MCP traffic while doing so. Always verify a restore procedure before relying on backups.

## Identify a user

An HTTP principal key is SHA-256 of the exact JSON pair `[issuer, subject]`. It is not a Google email or an OAuth client ID. Establish the correct issuer and user subject from Cloudflare Access through its authenticated administrative interface or a deliberately controlled diagnostic that **verifies the Access assertion**; do not copy unverified request headers, tokens, or email values into commands or logs. Confirm account ownership out of band before proceeding. Never paste a bearer token or raw Access JWT into a command.

```sh
./scripts/mcp-admin.sh identity-key '<exact-issuer>' '<verified-subject>'
./scripts/mcp-admin.sh resolve-tenant '<principal-key>'
```

A principal that has been rebound may map to a different original tenant key. Use `resolve-tenant` to find the tenant directory key for single-tenant restore. A revoked principal cannot be resolved; consult your trusted administrative records and backups if recovery is needed. Do not use a service-token identity to recover a person's ledger.

## Restore

Stopping the service is mandatory. A fresh backup of the **entire current data root** is automatically created before any restore; its ID is printed so the administrator can reverse the operation. Restore replaces the selected state, does not merge transactions, and must be explicitly confirmed with the exact ID/key. The service is restarted after the command when it was previously running and no restore journal remains.

```sh
# Replace all tenants and principal bindings with the chosen snapshot.
./scripts/mcp-admin.sh restore-all '<backup-id>' --confirm '<backup-id>' --confirm-identity-rollback RESTORE-PRINCIPAL-MAPPINGS

# Replace exactly one tenant; other tenants and current principal bindings remain unchanged.
./scripts/mcp-admin.sh restore-tenant '<backup-id>' '<tenant-key>' --confirm '<tenant-key>'
```

Validate the backup ID, target owner, and expected data before confirming. A tenant restore only works when that tenant key exists in the selected snapshot; it cannot automatically translate between different historical tenant keys. The overwritten tenant's changes after the snapshot are lost unless recovered from the automatic pre-restore backup. A full restore whose principal mappings differ from the live mappings additionally requires the exact `RESTORE-PRINCIPAL-MAPPINGS` acknowledgement; it may restore an old mapping or remove a revocation and give an earlier identity access again. The tool validates checksums and stored-state schemas, and refuses symlinks and mismatched owner identifiers. Checksums detect accidental corruption; they do not establish authenticity against someone able to alter both snapshot and manifest.

## Rebind a changed Cloudflare identity

After independently confirming the user's old and new verified identities, derive their principal keys. Rebinding writes a versioned mapping from the new principal to the existing tenant, revokes the old principal, and leaves the original tenant key and record owners unchanged. It fails when the old principal is already revoked, the target already has data or a binding, the target is revoked, or the existing ledger contains unexpected owners. No automatic email matching or merging occurs. A full pre-change backup is created first.

```sh
./scripts/mcp-admin.sh rebind '<old-principal-key>' '<new-principal-key>' --confirm '<new-principal-key>'
```

The mapping is read at service startup, so the wrapper restarts the previously running service after the operation. If a restore or rebind must be reversed, use the printed pre-operation backup ID and review the effect of a full restore on other users first.

## Interrupted restore

If a restore is interrupted, a journal makes service startup fail closed. The wrapper leaves the service stopped when that journal exists. After confirming no other process accesses the volume, run:

```sh
./scripts/mcp-admin.sh recover-restore --confirm RECOVER-RESTORE
```

This rolls back the incomplete restore from its staging directory. If staging data is missing or the journal is corrupt, do not start the service: inspect the intact pre-operation backup and seek manual recovery. Once the operation is clean, start a previously stopped service with `./scripts/mcp-admin.sh start`, which takes the same lock and verifies that the restore journal is gone. Do not edit or delete the journal to bypass the guard.
