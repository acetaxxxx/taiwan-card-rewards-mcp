import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FileStore } from '../src/store.js';
import { validateCard, validateToolArgs } from '../src/validation.js';
import type { StartupConfig } from '../src/startup.js';

function config(dataDir: string): StartupConfig { return { dataDir: resolve(dataDir) }; }

describe('Phase 1 safety boundaries', () => {
  it('allows only one process owner for a data directory', () => {
    const dir = mkdtempSync(join(tmpdir(), 'card-rewards-'));
    const first = new FileStore(config(dir));
    expect(() => new FileStore(config(dir))).toThrow(/LOCK_EXISTS/);
    first.close();
    const second = new FileStore(config(dir));
    second.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unknown fields before domain dispatch', () => {
    expect(() => validateCard({ id: 'c1', issuer: 'issuer', productName: 'card', pan: '4111111111111111' })).toThrow(/UNKNOWN_FIELD/);
    expect(() => validateToolArgs('register_card', { card: {}, dataDir: '/tmp/other' })).toThrow(/UNKNOWN_FIELD/);
  });

});
