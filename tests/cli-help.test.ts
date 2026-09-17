import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getHelpText } from '../src/index.js';

describe('CLI --help and usage verification', () => {
  const cliPath = path.resolve('dist/cli.js');

  it('prints help and exits with 0 on --help without side effects', () => {
    const result = spawnSync(process.execPath, [cliPath, '--help'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(getHelpText().trim());
    expect(result.stdout).toContain('taiwan-card-rewards-mcp');
    expect(result.stdout).toContain('--data-dir <path>');
    expect(result.stdout).toContain('--user <label>');
    expect(result.stdout).toContain('-h, --help');
    expect(result.stdout).toContain('JSON-RPC Model:');
    expect(result.stdout).toContain('stdin');
    expect(result.stdout).toContain('stdout');
    expect(result.stdout).not.toContain('--shared-owner');
    expect(result.stdout).not.toContain('--shared-bridge');
  });

  it('prints identical help and exits with 0 on -h', () => {
    const result = spawnSync(process.execPath, [cliPath, '-h'], { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout.trim()).toBe(getHelpText().trim());
  });

  it('does not create nonexistent data-dir when --help is supplied', () => {
    const nonexistentDir = path.join(path.resolve('.'), `temp-help-test-${Date.now()}`);
    expect(fs.existsSync(nonexistentDir)).toBe(false);
    try {
      const result = spawnSync(process.execPath, [cliPath, '--data-dir', nonexistentDir, '--help'], { encoding: 'utf8' });
      expect(result.status).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage:');
      expect(fs.existsSync(nonexistentDir)).toBe(false);
    } finally {
      if (fs.existsSync(nonexistentDir)) {
        fs.rmSync(nonexistentDir, { recursive: true, force: true });
      }
    }
  });

  it('fails with MISSING_DATA_DIR when invoked without required arguments', () => {
    const result = spawnSync(process.execPath, [cliPath], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MISSING_DATA_DIR');
  });

  it('fails with UNKNOWN_ARGUMENT when given unadvertised/unsupported flag without help', () => {
    const result = spawnSync(process.execPath, [cliPath, '--unsupported-flag'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('UNKNOWN_ARGUMENT');
  });
});
