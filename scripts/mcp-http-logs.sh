#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
line_count=20
include_bodies=0
line_count_set=0
for argument in "$@"; do
  case "$argument" in
    --with-bodies) include_bodies=1 ;;
    --help|-h)
      printf '%s\n' 'Usage: scripts/mcp-http-logs.sh [--with-bodies] [line-count]'
      exit 0
      ;;
    *)
      if [[ "$line_count_set" == 1 || ! "$argument" =~ ^[1-9][0-9]{0,3}$ ]]; then
        printf '%s\n' 'Usage: scripts/mcp-http-logs.sh [--with-bodies] [line-count]' >&2
        exit 2
      fi
      line_count=$argument
      line_count_set=1
      ;;
  esac
done
if [[ ! "$line_count" =~ ^[1-9][0-9]{0,3}$ ]]; then
  printf '%s\n' 'Usage: scripts/mcp-http-logs.sh [--with-bodies] [line-count]' >&2
  exit 2
fi

docker compose exec -T -e "MCP_HTTP_LOG_TAIL=$line_count" -e "MCP_HTTP_LOG_BODIES=$include_bodies" mcp node -e '
const fs = require("node:fs");
const directory = "/logs";
const limit = Number(process.env.MCP_HTTP_LOG_TAIL);
const includeBodies = process.env.MCP_HTTP_LOG_BODIES === "1";
const paths = [4, 3, 2, 1].map((suffix) => `${directory}/mcp-http.log.${suffix}`);
paths.push(`${directory}/mcp-http.log`);
const lines = [];
let total = 0;
function omitBody(entry, key) {
  const body = entry[key];
  if (!body || typeof body !== "object") return;
  delete entry[key];
  entry[`${key}Captured`] = body.value !== undefined;
  if (typeof body.capturedBytes === "number") entry[`${key}Bytes`] = body.capturedBytes;
  if (body.truncated) entry[`${key}Truncated`] = true;
  if (typeof body.omitted === "string") entry[`${key}Omitted`] = body.omitted;
}
for (const filePath of paths) {
  if (!fs.existsSync(filePath)) continue;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); }
    catch { continue; }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (!includeBodies) {
      omitBody(entry, "requestBody");
      omitBody(entry, "responseBody");
    }
    lines[total % limit] = JSON.stringify(entry);
    total += 1;
  }
}
if (lines.length) {
  const ordered = total <= limit ? lines : lines.slice(total % limit).concat(lines.slice(0, total % limit));
  process.stdout.write(`${ordered.join("\n")}\n`);
}
'
