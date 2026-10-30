import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { copyFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
function setup(blocking: boolean, command = 'backup', symlinkLock = false, stopped = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-wrapper-')); roots.push(dir);
  const project = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const scripts = path.join(project, 'scripts');
  fs.mkdirSync(scripts, { recursive: true });
  fs.mkdirSync(home);
  copyFileSync(path.resolve('scripts/mcp-admin.sh'), path.join(scripts, 'mcp-admin.sh'));
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const log = path.join(dir, 'calls');
  const docker = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == 'inspect' ]]; then
  if [[ "$3" == *'.State.Running'* ]]; then [[ "$FAKE_STOPPED" == 1 ]] && echo false || echo true
  elif [[ "$3" == *'.State.Health.Status'* ]]; then echo healthy
  else echo project_mcp_data; fi
  exit 0
fi
if [[ "$1 $2" == 'compose ps' ]]; then echo container-1; exit 0; fi
if [[ "$1" == 'ps' ]]; then [[ "$FAKE_BLOCKING" == 1 ]] && echo other-container; exit 0; fi
exit 0
`;
  fs.writeFileSync(path.join(bin, 'docker'), docker, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'flock'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'sha256sum'), '#!/usr/bin/env bash\ncat >/dev/null\necho 1234567890\n', { mode: 0o755 });
  if (symlinkLock) {
    const lockDir = path.join(home, '.local', 'state', 'taiwan-card-rewards-mcp');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.symlinkSync(path.join(dir, 'outside'), path.join(lockDir, '1234567890.lock'));
  }
  const result = spawnSync('bash', ['scripts/mcp-admin.sh', command], {
    cwd: project, encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, FAKE_DOCKER_LOG: log, FAKE_BLOCKING: blocking ? '1' : '0', FAKE_STOPPED: stopped ? '1' : '0', TMPDIR: dir },
  });
  return { result, calls: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '', project, tempDir: dir, home };
}
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('offline Compose administration wrapper', () => {
  it('stops the service, checks the volume, performs the operation and restarts only after a clean journal check', () => {
    const { result, calls, tempDir, home } = setup(false);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toMatch(/compose stop mcp/);
    expect(calls).toMatch(/ps -q --filter volume=project_mcp_data/);
    expect(calls).toMatch(/dist\/admin-cli.js backup/);
    expect(calls).toMatch(/dist\/admin-cli.js check/);
    expect(calls).toMatch(/compose start mcp/);
    expect(fs.existsSync(path.join(tempDir, '1234567890.lock'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.local', 'state', 'taiwan-card-rewards-mcp', '1234567890.lock'))).toBe(true);
  });
  it('refuses operation and leaves MCP stopped when another running container uses the data volume', () => {
    const { result, calls } = setup(true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Another running container');
    expect(calls).not.toMatch(/compose run/);
    expect(calls).not.toMatch(/compose start/);
  });

  it('uses the same lock while backing up and deploying a pulled image', () => {
    const { result, calls } = setup(false, 'deploy');
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toMatch(/dist\/admin-cli.js backup/);
    expect(calls).toMatch(/compose pull mcp/);
    expect(calls).toMatch(/compose up -d --no-deps mcp/);
    expect(result.stdout).toContain('Deployment healthy');
  });

  it('checks restore recovery before starting a stopped service', () => {
    const { result, calls } = setup(false, 'start', false, true);
    expect(result.status, result.stderr).toBe(0);
    expect(calls).toMatch(/dist\/admin-cli.js check/);
    expect(calls).toMatch(/compose start mcp/);
    expect(result.stdout).toContain('MCP service healthy');
  });

  it('rejects a symlinked lock file before stopping MCP', () => {
    const { result, calls } = setup(false, 'backup', true);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('symlinked administrator lock file');
    expect(calls).not.toMatch(/compose stop mcp/);
  });
});
