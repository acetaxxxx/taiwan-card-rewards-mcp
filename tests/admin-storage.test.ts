import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertNoInterruptedRestore, createBackup, rebindPrincipal, recoverInterruptedRestore, restoreBackup } from '../src/admin-storage.js';
import { loadPrincipalBindings, principalKey, resolveTenantKey } from '../src/principal-bindings.js';
import { emptyState } from '../src/store.js';

const roots: string[] = [];
function root(): string { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-admin-')); roots.push(dir); return dir; }
const a = principalKey('https://access.example', 'alice');
const b = principalKey('https://access.example', 'bob');
const c = principalKey('https://access.example', 'alice-new');
const d = principalKey('https://access.example', 'alice-newer');
function writeTenant(dir: string, key: string, label: string): void {
  fs.mkdirSync(path.join(dir, key), { recursive: true });
  const state = emptyState();
  state.cards.push({ id: label, issuer: 'Test', productName: label });
  state.eventRewardCapUsage.push({ ownerUser: key, poolId: 'pool', periodKey: '2026-01', consumedAmount: 1 });
  fs.writeFileSync(path.join(dir, key, 'card-rewards.json'), JSON.stringify(state));
}
function readCard(dir: string, key: string): string { return JSON.parse(fs.readFileSync(path.join(dir, key, 'card-rewards.json'), 'utf8')).cards[0].id; }
function backupIds(dir: string): string[] { return fs.readdirSync(path.join(dir, '.backups')).filter((name) => name.startsWith('backup-')); }
afterEach(() => { for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('offline backup and administrator recovery', () => {
  it('backs up all tenants without transient locks, restores one tenant without changing another, and preserves a rollback snapshot', () => {
    const dir = root(); writeTenant(dir, a, 'a-old'); writeTenant(dir, b, 'b-old');
    fs.writeFileSync(path.join(dir, a, 'card-rewards.lock'), 'stale');
    fs.writeFileSync(path.join(dir, a, 'card-rewards.json.1.tmp'), 'transient');
    const id = createBackup(dir);
    expect(fs.existsSync(path.join(dir, '.backups', id, 'data', a, 'card-rewards.lock'))).toBe(false);
    writeTenant(dir, a, 'a-new'); writeTenant(dir, b, 'b-new');
    const rollback = restoreBackup(dir, id, a);
    expect(readCard(dir, a)).toBe('a-old');
    expect(readCard(dir, b)).toBe('b-new');
    expect(fs.existsSync(path.join(dir, '.backups', rollback))).toBe(true);
    expect(fs.existsSync(path.join(dir, a, 'card-rewards.lock'))).toBe(false);
  });

  it('restores the entire service, including principal bindings, and snapshots the newer state first', () => {
    const dir = root(); writeTenant(dir, a, 'a-old'); writeTenant(dir, b, 'b-old');
    const id = createBackup(dir);
    writeTenant(dir, a, 'a-new'); writeTenant(dir, b, 'b-new');
    const rollback = restoreBackup(dir, id);
    expect(readCard(dir, a)).toBe('a-old'); expect(readCard(dir, b)).toBe('b-old');
    restoreBackup(dir, rollback, undefined, 7, true);
    expect(readCard(dir, a)).toBe('a-new'); expect(readCard(dir, b)).toBe('b-new');
  });

  it('requires explicit acknowledgement before a full restore changes or revives principal bindings', () => {
    const dir = root(); writeTenant(dir, a, 'alice-data');
    const beforeRebind = createBackup(dir);
    rebindPrincipal(dir, a, c);
    expect(() => restoreBackup(dir, beforeRebind)).toThrow(/explicit identity rollback confirmation/);
    expect(resolveTenantKey(loadPrincipalBindings(dir), c)).toBe(a);
    restoreBackup(dir, beforeRebind, undefined, 7, true);
    expect(resolveTenantKey(loadPrincipalBindings(dir), a)).toBe(a);
    expect(readCard(dir, a)).toBe('alice-data');
  });

  it('keeps only the configured number of successful snapshots, and a failure does not prune any', () => {
    const dir = root(); writeTenant(dir, a, 'good');
    for (let i = 0; i < 5; i++) createBackup(dir, 3);
    expect(backupIds(dir)).toHaveLength(3);
    fs.symlinkSync('/tmp', path.join(dir, a, 'bad-link'));
    expect(() => createBackup(dir, 1)).toThrow(/symbolic links/);
    expect(backupIds(dir)).toHaveLength(3);
  });

  it('refuses tampered backups before touching live data', () => {
    const dir = root(); writeTenant(dir, a, 'old'); const id = createBackup(dir);
    writeTenant(dir, a, 'current');
    fs.appendFileSync(path.join(dir, '.backups', id, 'data', a, 'card-rewards.json'), ' ');
    expect(() => restoreBackup(dir, id, a)).toThrow(/integrity/);
    expect(readCard(dir, a)).toBe('current');
  });

  it('rebinds a principal without rewriting owner records and revokes old principals across repeated rebindings', () => {
    const dir = root(); writeTenant(dir, a, 'original');
    rebindPrincipal(dir, a, c);
    let map = loadPrincipalBindings(dir);
    expect(resolveTenantKey(map, c)).toBe(a); expect(() => resolveTenantKey(map, a)).toThrow(/revoked/);
    expect(JSON.parse(fs.readFileSync(path.join(dir, a, 'card-rewards.json'), 'utf8')).eventRewardCapUsage[0].ownerUser).toBe(a);
    rebindPrincipal(dir, c, d);
    map = loadPrincipalBindings(dir);
    expect(resolveTenantKey(map, d)).toBe(a); expect(() => resolveTenantKey(map, c)).toThrow(/revoked/);
    expect(() => rebindPrincipal(dir, d, a)).toThrow(/revoked/);
    writeTenant(dir, b, 'other');
    expect(() => rebindPrincipal(dir, d, b)).toThrow(/already/);
    expect(resolveTenantKey(loadPrincipalBindings(dir), d)).toBe(a);
  });

  it('fails closed on conflicting owners and dangling mapping symlinks', () => {
    const dir = root(); writeTenant(dir, a, 'old');
    const file = path.join(dir, a, 'card-rewards.json');
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    state.eventRewardCapUsage[0].ownerUser = b;
    fs.writeFileSync(file, JSON.stringify(state));
    expect(() => rebindPrincipal(dir, a, c)).toThrow(/different owner/);
    expect(fs.existsSync(path.join(dir, 'principal-bindings.json'))).toBe(false);
    fs.symlinkSync('/missing/nonexistent', path.join(dir, 'principal-bindings.json'));
    expect(() => loadPrincipalBindings(dir)).toThrow(/invalid principal bindings/);
  });

  it('detects an interrupted multi-directory restore and rolls back to the original files', () => {
    const dir = root(); writeTenant(dir, a, 'original-a'); writeTenant(dir, b, 'original-b');
    const stage = '.admin-restore-0123456789abcdef01234567';
    fs.mkdirSync(path.join(dir, stage, 'old'), { recursive: true });
    fs.mkdirSync(path.join(dir, stage, 'new'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.admin-restore-journal.json'), JSON.stringify({ version: 1, stage, oldNames: [a, b], newNames: [a, b] }));
    fs.renameSync(path.join(dir, a), path.join(dir, stage, 'old', a));
    writeTenant(dir, a, 'partial-new-a');
    expect(() => assertNoInterruptedRestore(dir)).toThrow(/interrupted/);
    recoverInterruptedRestore(dir);
    expect(readCard(dir, a)).toBe('original-a'); expect(readCard(dir, b)).toBe('original-b');
    expect(() => assertNoInterruptedRestore(dir)).not.toThrow();
  });

  it('keeps the journal and fails closed when recovery cannot find an original entry', () => {
    const dir = root();
    const key = a;
    const stage = '.admin-restore-0123456789abcdef01234567';
    fs.mkdirSync(path.join(dir, stage, 'old'), { recursive: true });
    fs.mkdirSync(path.join(dir, stage, 'new'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.admin-restore-journal.json'), JSON.stringify({ version: 1, stage, oldNames: [key], newNames: [key] }));
    expect(() => recoverInterruptedRestore(dir)).toThrow(/original restore entry missing/);
    expect(fs.existsSync(path.join(dir, '.admin-restore-journal.json'))).toBe(true);
  });
});
