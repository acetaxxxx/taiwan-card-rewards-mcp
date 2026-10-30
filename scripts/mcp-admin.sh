#!/usr/bin/env bash
set -euo pipefail

# The tool operates on the same named volume as the one Compose-managed MCP.
# Only one administrator wrapper on this VPS can operate on that volume at once.
cd "$(dirname "$0")/.."
if [[ $# -eq 0 || "${1:-}" == '--help' || "${1:-}" == '-h' ]]; then
  printf '%s\n' 'Usage: scripts/mcp-admin.sh {start|deploy|backup|list|identity-key|resolve-tenant|restore-all|restore-tenant|rebind|recover-restore} ...'
  [[ $# -gt 0 ]] && exit 0 || exit 2
fi
if [[ "${1:-}" == deploy && $# -ne 1 ]]; then
  printf '%s\n' 'deploy takes no arguments; set MCP_IMAGE in .env first.' >&2
  exit 2
fi
if [[ "${1:-}" == start && $# -ne 1 ]]; then
  printf '%s\n' 'start takes no arguments.' >&2
  exit 2
fi
for cmd in docker flock sha256sum stat mkdir chmod; do
  command -v "$cmd" >/dev/null || { printf 'Required command missing: %s\n' "$cmd" >&2; exit 1; }
done
containers=()
while IFS= read -r container; do [[ -n "$container" ]] && containers+=("$container"); done < <(docker compose ps --all --quiet mcp)
if [[ ${#containers[@]} -ne 1 ]]; then
  printf '%s\n' 'Exactly one Compose mcp container must exist; create it first and remove duplicates.' >&2
  exit 1
fi
container_id=${containers[0]}
volume=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{if eq .Type "volume"}}{{.Name}}{{end}}{{end}}{{end}}' "$container_id")
if [[ -z "$volume" ]]; then
  printf '%s\n' 'Expected a named volume mounted at /data; bind mounts are not supported by this wrapper.' >&2
  exit 1
fi
lock_id=$(printf '%s' "$volume" | sha256sum | cut -d ' ' -f 1)
if [[ -z "${HOME:-}" || ! -d "$HOME" ]]; then
  printf '%s\n' 'HOME must identify the administrator account home directory.' >&2
  exit 1
fi
home_dir=$(cd "$HOME" && pwd -P)
if [[ ! -O "$home_dir" || -L "$HOME" ]]; then
  printf '%s\n' 'Run this command with the administrator account home directory.' >&2
  exit 1
fi
state_parent="$home_dir/.local/state"
for parent in "$home_dir/.local" "$state_parent"; do
  if [[ -L "$parent" ]]; then
    printf '%s\n' 'Refusing a symlink in the administrator lock path.' >&2
    exit 1
  fi
  mkdir -p "$parent"
  if [[ ! -d "$parent" || -L "$parent" || ! -O "$parent" ]]; then
    printf '%s\n' 'Administrator lock path must be owned by this account.' >&2
    exit 1
  fi
  parent_mode=$(stat -c '%a' "$parent" 2>/dev/null || stat -f '%Lp' "$parent")
  if (( (8#$parent_mode & 0022) != 0 )); then
    printf '%s\n' 'Administrator lock path must not be writable by group or other users.' >&2
    exit 1
  fi
done
lock_dir="$state_parent/taiwan-card-rewards-mcp"
if [[ -L "$lock_dir" ]]; then
  printf '%s\n' 'Refusing a symlinked administrator lock directory.' >&2
  exit 1
fi
mkdir -m 700 "$lock_dir" 2>/dev/null || true
if [[ ! -d "$lock_dir" || -L "$lock_dir" || ! -O "$lock_dir" ]]; then
  printf '%s\n' 'Administrator lock directory must be a real directory owned by this account.' >&2
  exit 1
fi
chmod 700 "$lock_dir"
lock_file="$lock_dir/$lock_id.lock"
if [[ -L "$lock_file" ]]; then
  printf '%s\n' 'Refusing a symlinked administrator lock file.' >&2
  exit 1
fi
umask 077
exec 9>>"$lock_file"
if [[ ! -f "$lock_file" || -L "$lock_file" || ! -O "$lock_file" ]]; then
  printf '%s\n' 'Administrator lock file must be a regular file owned by this account.' >&2
  exit 1
fi
chmod 600 "$lock_file"
flock -n 9 || { printf '%s\n' 'Another administrator operation is running.' >&2; exit 1; }
run_admin() {
  docker compose run --rm --no-deps --entrypoint node -e MCP_ADMIN_OFFLINE_ACK=yes -e "MCP_BACKUP_KEEP=${MCP_BACKUP_KEEP:-7}" mcp dist/admin-cli.js "$@"
}
wait_for_health() {
  local deployed_container health deployed_containers
  deployed_containers=$(docker compose ps --all --quiet mcp)
  if [[ -z "$deployed_containers" || "$deployed_containers" == *$'\n'* ]]; then
    printf '%s\n' 'Expected exactly one MCP container while checking health.' >&2
    return 1
  fi
  deployed_container=$deployed_containers
  for _ in {1..36}; do
    health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}' "$deployed_container")
    [[ "$health" == healthy ]] && return 0
    if [[ "$health" == unhealthy || "$health" == missing ]]; then
      printf 'MCP container health is %s.\n' "$health" >&2
      return 1
    fi
    sleep 5
  done
  printf '%s\n' 'MCP container health check timed out.' >&2
  return 1
}
was_running=$(docker inspect --format '{{.State.Running}}' "$container_id")
if [[ "${1:-}" == start ]]; then
  if [[ "$was_running" != true && -n $(docker ps -q --filter "volume=$volume") ]]; then
    printf '%s\n' 'Another running container mounts the data volume; refusing to start MCP.' >&2
    exit 1
  fi
  if [[ "$was_running" != true ]]; then
    run_admin check || { printf '%s\n' 'The data root needs recovery; run recover-restore before starting MCP.' >&2; exit 1; }
    docker compose start mcp >/dev/null
  fi
  if wait_for_health; then printf '%s\n' 'MCP service healthy.'; exit 0; fi
  docker compose stop mcp >/dev/null || true
  exit 1
fi
docker compose stop mcp >/dev/null
if [[ -n $(docker ps -q --filter "volume=$volume") ]]; then
  printf '%s\n' 'Another running container mounts the data volume; service remains stopped. Stop it before retrying.' >&2
  exit 1
fi
if [[ "${1:-}" == deploy ]]; then
  shift
  set +e
  run_admin backup
  backup_status=$?
  run_admin check
  check_status=$?
  set -e
  if [[ $backup_status -ne 0 || $check_status -ne 0 ]]; then
    printf '%s\n' 'Deployment stopped before pulling the new image; the data root needs attention.' >&2
    if [[ "$was_running" == true && $check_status -eq 0 ]]; then docker compose start mcp >/dev/null; fi
    exit 1
  fi
  if ! docker compose pull mcp; then
    printf '%s\n' 'Image pull failed; restarting the existing service.' >&2
    if [[ "$was_running" == true ]]; then docker compose start mcp >/dev/null; fi
    exit 1
  fi
  if ! docker compose run --rm --no-deps --user root --entrypoint sh mcp -c 'chown 1000:1000 /logs && chmod 700 /logs'; then
    printf '%s\n' 'Log volume initialization failed; restarting the existing service.' >&2
    if [[ "$was_running" == true ]]; then docker compose start mcp >/dev/null; fi
    exit 1
  fi
  if ! docker compose up -d --no-deps mcp; then
    printf '%s\n' 'Deployment failed; inspect the service and restore the previous MCP_IMAGE if needed.' >&2
    exit 1
  fi
  if wait_for_health; then printf '%s\n' 'Deployment healthy.'; exit 0; fi
  printf '%s\n' 'Inspect logs and restore the previous MCP_IMAGE if needed.' >&2
  docker compose stop mcp >/dev/null || true
  exit 1
fi
set +e
run_admin "$@"
operation_status=$?
run_admin check
check_status=$?
set -e
if [[ $check_status -ne 0 ]]; then
  printf '%s\n' 'The data root needs recovery; service remains stopped. Run recover-restore before starting it.' >&2
  exit 1
fi
if [[ "$was_running" == true ]]; then
  docker compose start mcp >/dev/null || { printf '%s\n' 'Could not restart MCP; start it after investigating.' >&2; exit 1; }
fi
exit "$operation_status"
