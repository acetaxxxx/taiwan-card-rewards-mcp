# Deploy the HTTP MCP server to a VPS

This deployment runs one MCP container and exposes its HTTP port only on the VPS loopback interface. The existing host `cloudflared` process forwards the public HTTPS MCP hostname to that loopback port. Cloudflare Access Managed OAuth and the Google identity provider protect the hostname; the container validates the Cloudflare Access application assertion for each MCP request.

Run planned starts, updates, backups, restores, and identity recovery as the same SSH administrator account. The scripts share a per-volume `flock` in that account's `~/.local/state/taiwan-card-rewards-mcp/`; direct Docker commands can bypass the lock and race with maintenance.

## Prerequisites

- A VPS with Docker Engine and Compose, persistent local storage, and the existing host-based Cloudflare Tunnel. Use one MCP process for the data volume; never run another container or stdio process against the same tenant directories.
- A Cloudflare Access application for the MCP hostname, using the existing Google identity provider and an Access policy allowing the chosen accounts. Managed OAuth client registration, redirect URIs, and policies must be configured and verified in Cloudflare separately; the application JWT audience tag is available in the Access application settings.
- A GHCR image from this repository. The first publication creates the package; make it Public in Package settings before expecting anonymous pulls. GitHub does not allow a Public package to be made Private again. For a private package, authenticate the VPS to GHCR with a suitably scoped credential.

## Configure and start

1. On the VPS obtain `compose.yaml` and `.env.example` from the intended release. Copy `.env.example` to `.env`. Set `MCP_IMAGE` to a specific `ghcr.io/acetaxxxx/taiwan-card-rewards-mcp` version tag or immutable digest. Feature branches also publish branch and `sha-<commit>` tags; `latest` follows `main` and is not an immutable deployment reference.
2. Set `MCP_HTTP_PUBLIC_URL` to the HTTPS URL ending in the MCP path, `MCP_CF_ACCESS_ISSUER` to the Cloudflare Access team issuer (for example `https://team.cloudflareaccess.com`), and `MCP_CF_ACCESS_AUDIENCE` to the application AUD tag. The values must match the Access application protecting this hostname. Set `MCP_HTTP_HOST_PORT` if the host port must differ from `8080`. The container binds to `0.0.0.0:8080`, while Compose publishes only `127.0.0.1:<host-port>:8080`.
3. Pull the image, initialize the data volume ownership, and start the service for the first time. The container's `node` user has UID/GID 1000 and the service changes the data-root mode to `0700`; the volume root must be owned by that user. The initialization command is intended for a new deployment and changes the volume root, not the ownership of existing tenant files. After bootstrap, use `scripts/mcp-admin.sh` for planned starts, updates, backups, and recovery.

   ```sh
   docker compose pull
   docker compose run --rm --no-deps --user root --entrypoint sh mcp -c 'chown 1000:1000 /data && chmod 700 /data'
   docker compose up -d
   docker compose ps
   docker compose logs --tail=100 mcp
   ```

4. Route the public MCP hostname through the existing Tunnel to `http://127.0.0.1:<host-port>`. `cloudflared` is running on the VPS host, so that address is the host's loopback. Verify that the original Host header is accepted by the MCP service. The Compose health check uses the public URL's host header because `/healthz` is behind the service's Host allowlist.
5. Once the service validates Access assertions, enable Managed OAuth on the intended Access application, then verify unauthenticated requests receive OAuth discovery and complete the real ChatGPT/Gemini login and tool flows. Confirm two user accounts are isolated and the same account maps as intended across clients.

The `.env` file is local configuration and must not be committed. It contains configuration values, not user tokens. Do not write Access assertions or user data to logs.

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

The default Compose project `taiwan-card-rewards` names the volume `taiwan-card-rewards_mcp_data`. Overriding `COMPOSE_PROJECT_NAME` changes the actual volume name; use a consistent project name for deployment, backups, and restoration. Existing volumes must have usable ownership and permissions before starting the non-root container. Backups stored on the VPS do not protect against loss of the VPS or its disk.
