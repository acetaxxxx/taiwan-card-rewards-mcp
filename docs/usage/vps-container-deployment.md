# Deploy the HTTP MCP server to a VPS

This deployment runs one MCP container and exposes its HTTP port only on the VPS loopback interface. The existing host `cloudflared` process forwards the public HTTPS MCP hostname to that loopback port. Cloudflare Access Managed OAuth and the Google identity provider protect the hostname; the container validates the Cloudflare Access application assertion for each MCP request.

Run planned starts, updates, backups, restores, and identity recovery as the same SSH administrator account. The scripts share a per-volume `flock` in that account's `~/.local/state/taiwan-card-rewards-mcp/`; direct Docker commands can bypass the lock and race with maintenance.

## Prerequisites

- A VPS with Docker Engine and Compose, persistent local storage, and the existing host-based Cloudflare Tunnel. Use one MCP process for the data volume; never run another container or stdio process against the same tenant directories.
- A Cloudflare Access application for the MCP hostname, using the existing Google identity provider and an Access policy allowing the chosen accounts. Managed OAuth client registration, redirect URIs, and policies must be configured and verified in Cloudflare separately; the application JWT audience tag is available in the Access application settings.
- A GHCR image from this repository. The first publication creates the package; make it Public in Package settings before expecting anonymous pulls. GitHub does not allow a Public package to be made Private again. For a private package, authenticate the VPS to GHCR with a suitably scoped credential.

## Configure and start

1. On the VPS obtain `compose.yaml`, `.env.example`, and the deployment scripts from the intended release. Copy `.env.example` to `.env`. Set `MCP_IMAGE` to a specific `ghcr.io/acetaxxxx/taiwan-card-rewards-mcp` version tag or immutable digest. Feature branches also publish branch and `sha-<commit>` tags; `latest` follows `main` and is not an immutable deployment reference.
2. Set `MCP_HTTP_PUBLIC_URL` to the HTTPS URL ending in the MCP path, `MCP_CF_ACCESS_ISSUER` to the Cloudflare Access team issuer (for example `https://team.cloudflareaccess.com`), and `MCP_CF_ACCESS_AUDIENCE` to the application AUD tag. The values must match the Access application protecting this hostname. Set `MCP_HTTP_HOST_PORT` if the host port must differ from `8080`. The container binds to `0.0.0.0:8080`, while Compose publishes only `127.0.0.1:<host-port>:8080`.
3. Pull the image, initialize the data and log volume ownership, and start the service for the first time. The container's `node` user has UID/GID 1000; both volume roots must be owned by that user and have mode `0700`. The initialization command is intended for a new deployment and changes the volume roots, not the ownership of existing tenant files. After bootstrap, use `scripts/mcp-admin.sh` for planned starts, updates, backups, and recovery.

   ```sh
   docker compose pull
   docker compose run --rm --no-deps --user root --entrypoint sh mcp -c 'chown 1000:1000 /data /logs && chmod 700 /data /logs'
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 mcp
   ```

4. Route the public MCP hostname through the existing Tunnel to `http://127.0.0.1:<host-port>`. `cloudflared` is running on the VPS host, so that address is the host's loopback. Verify that the original Host header is accepted by the MCP service. The Compose health check uses the public URL's host header because `/healthz` is behind the service's Host allowlist.
5. Once the service validates Access assertions, enable Managed OAuth on the intended Access application, then verify unauthenticated requests receive OAuth discovery and complete the real ChatGPT/Gemini login and tool flows. Confirm two user accounts are isolated and the same account maps as intended across clients.

The `.env` file is local configuration and must not be committed. It contains configuration values, not user tokens. Access assertions and authorization headers are never logged.

## MCP request logs and rotation

Compose defaults `MCP_HTTP_DIAGNOSTIC_LOGS` to `1`; direct process runs leave it disabled unless explicitly set to `1`. Each MCP request log records the HTTP method, path without query parameters, allowlisted JSON-RPC method, status, duration, processing phase, authentication state and mode, normalized Origin, Cloudflare Ray ID, bounded sanitized User-Agent, and bounded request/response bodies. Authenticated requests also record `tenantRef`, the resolved tenant directory's pseudonymous 64-character identity key. A verified OAuth `client_id` or `azp` claim is recorded if the issuer provides one. `initialize` records the client-reported name and version; `tools/call` records the tool name and, when the response is captured, the MCP result status and machine-readable error code. Client-reported fields and User-Agent are untrusted hints, not verified client identities.

Request bodies are captured only after service authentication succeeds; rejected requests still record status and phase, plus an allowlisted method header when supplied. JSON body capture is capped at 256 KiB per body and has a one-second read limit. Short `text/plain` errors and complete JSON-RPC messages from bounded `text/event-stream` responses may be captured. Sensitive-key values are redacted recursively, including PAN/card/account numbers, CVV/CVC/OTP/PIN, passwords/passcodes, cookies, credentials/private keys, secrets, tokens, API keys, authorization, user IDs/principals, email, phone, display name, data directory, and path fields. The redactor also checks JSON encoded inside string fields. Invalid, oversized, timed-out, and unparseable stream bodies are marked as omitted. Access assertions, authorization header values, and raw issuer/subject/email claims are never logged.

Request and response bodies can still contain allowed card and transaction details from any tenant, and `tenantRef` links activity by tenant, so treat these logs as private. The detailed log lives in the separate `mcp_logs` volume at `/logs/mcp-http.log`; the volume persists across container updates and is not included in tenant-data backups. The log directory has mode `0700` and files have mode `0600`. The deployment wrapper repairs the log volume root ownership and mode without changing existing log files. Do not copy output into public issues or the repository. `scripts/mcp-http-logs.sh 20` prints recent call metadata, client hints, tenant references, outcomes, and body sizes; `scripts/mcp-http-logs.sh --with-bodies 20` explicitly prints captured values. `docker compose logs --since=24h mcp` shows request metadata and body byte counts without body values. Set `MCP_HTTP_DIAGNOSTIC_LOGS=0` in `.env` and redeploy with `./scripts/mcp-admin.sh deploy` to disable request diagnostics.

The application rotates detailed logs at 10 MiB per file and retains at most five files (about 50 MiB total). Rotation is size-based, so low-volume logs remain until new records exceed the limit. Compose also rotates Docker stdout/stderr metadata logs with the compressed `json-file` driver at 10 MiB per file and five files. See [Docker's json-file rotation options](https://docs.docker.com/engine/logging/drivers/json-file/).

## Image publication

`.github/workflows/container.yml` runs the project's checks in a `verify` job before building the image. Successful pushes publish multi-platform `linux/amd64` and `linux/arm64` images to GHCR with branch/tag and full commit SHA tags; `main` also publishes `latest`. Pull requests build the image after verification without publishing it. The workflow uses the repository `GITHUB_TOKEN` with `packages: write`; it does not deploy to the VPS.

## Updating and recovery

Update `.env` to the new pinned image, then use the deployment wrapper. It uses the same per-volume lock as backup and recovery, takes a fresh backup, pulls the image, starts the service, and waits for the container health check:

```sh
./scripts/mcp-admin.sh deploy
docker compose ps
docker compose logs --tail=100 mcp
```

Check health and authenticate through the actual Tunnel before considering the update complete. If deployment fails, inspect the logs, set `MCP_IMAGE` to the previous tag or digest, and run `./scripts/mcp-admin.sh deploy` again. Confirm storage-schema compatibility first: an old image may not understand data migrated by the new image. All planned admin and deployment operations must use this wrapper; direct `docker compose stop`, `start`, `up`, or `pull` can race with an admin operation. Do not use `docker compose down -v` on the production deployment, because it removes the data volume.

The default Compose project `taiwan-card-rewards` names the volumes `taiwan-card-rewards_mcp_data` and `taiwan-card-rewards_mcp_logs`. Overriding `COMPOSE_PROJECT_NAME` changes both volume names; use a consistent project name for deployment, backups, and restoration. Existing volumes must have usable ownership and permissions before starting the non-root container. `docker compose down -v` removes both tenant data and diagnostic logs. Backups stored on the VPS do not protect against loss of the VPS or its disk.
