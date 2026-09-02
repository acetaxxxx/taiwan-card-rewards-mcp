import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { assertToolDataDir, parseStartupArgs, StartupContractError } from '../src/index.js';

describe('startup contract', () => {
  it('requires and canonicalizes an existing non-root data directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rewards-'));
    const nested = path.join(parent, 'tenant');
    fs.mkdirSync(nested);
    const config = parseStartupArgs(['--data-dir', path.join(nested, '..', 'tenant'), '--user', 'label']);
    expect(config.dataDir).toBe(fs.realpathSync(nested));
    expect(config.user).toBe('label');
    fs.rmSync(parent, { recursive: true, force: true });
  });
  it('rejects missing argument, relative, root, unknown, and tool-overridden paths', () => {
    expect(() => parseStartupArgs([])).toThrowError(StartupContractError);
    expect(() => parseStartupArgs(['--data-dir', 'relative'])).toThrowError(/absolute/);
    expect(() => parseStartupArgs(['--data-dir', path.parse(process.cwd()).root])).toThrowError(/root/);
    expect(() => parseStartupArgs(['--data-dir', process.cwd(), '--oops'])).toThrowError(/unsupported/);
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rewards-'));
    const config = parseStartupArgs(['--data-dir', parent]);
    expect(() => assertToolDataDir(config, path.join(parent, 'other'))).toThrowError(/override/);
    fs.rmSync(parent, { recursive: true, force: true });
  });
  it('creates nested missing absolute data directories', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rewards-'));
    const nested = path.join(parent, 'one', 'two', 'tenant');
    const config = parseStartupArgs(['--data-dir', nested]);
    expect(fs.statSync(nested).isDirectory()).toBe(true);
    expect(config.dataDir).toBe(fs.realpathSync(nested));
    fs.rmSync(parent, { recursive: true, force: true });
  });
  it('rejects an existing regular file as data directory', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'card-rewards-'));
    const file = path.join(parent, 'not-a-directory');
    fs.writeFileSync(file, 'x');
    expect(() => parseStartupArgs(['--data-dir', file])).toThrowError(/directory/);
    fs.rmSync(parent, { recursive: true, force: true });
  });
});
