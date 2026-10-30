import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { validateStoredState } from './validation.js';
import { assertPrincipalKey, loadPrincipalBindings, resolveTenantKey, savePrincipalBindings, type PrincipalBindings } from './principal-bindings.js';

const BACKUPS = '.backups';
export const RESTORE_JOURNAL = '.admin-restore-journal.json';
const STAGE_PREFIX = '.admin-restore-';
const BACKUP_PATTERN = /^backup-\d{8}T\d{9}Z-[a-f0-9]{12}$/;
const KEY_PATTERN = /^[a-f0-9]{64}$/;

type FileInfo = { path: string; sha256: string; size: number };
type Manifest = { version: 1; createdAt: string; directories: string[]; files: FileInfo[] };
type Journal = { version: 1; stage: string; oldNames: string[]; newNames: string[] };

function hash(data: Buffer): string { return crypto.createHash('sha256').update(data).digest('hex'); }
function isPlainDirectory(p: string): boolean { const s = fs.lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); }
function present(p: string): boolean {
  try { fs.lstatSync(p); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function safeName(name: string): boolean { return !!name && name !== '.' && name !== '..' && !name.includes('/') && !name.includes('\\') && !name.includes('\0'); }
function safeRelative(name: string): boolean { return !!name && !path.isAbsolute(name) && name.split('/').every(safeName); }
function isTransient(relative: string): boolean {
  const parts = relative.split('/');
  return parts.length === 2 && KEY_PATTERN.test(parts[0]!) && (parts[1] === 'card-rewards.lock' || /^card-rewards\.json\.\d+\.tmp$/.test(parts[1]!));
}
function isInternal(name: string): boolean { return name === BACKUPS || name === RESTORE_JOURNAL || name.startsWith(STAGE_PREFIX) || /^\.principal-bindings-[a-f0-9]{24}\.tmp$/.test(name); }

export function requireDataRoot(raw: string): string {
  if (!path.isAbsolute(raw)) throw new Error('data root must be absolute');
  const root = fs.realpathSync(raw);
  if (root === path.parse(root).root || !isPlainDirectory(root)) throw new Error('data root must be a non-root directory');
  return root;
}

export function assertNoInterruptedRestore(root: string): void {
  if (present(path.join(root, RESTORE_JOURNAL))) throw new Error('interrupted restore: run recover-restore before starting the service');
}

function backupRoot(root: string): string {
  const p = path.join(root, BACKUPS);
  if (!present(p)) fs.mkdirSync(p, { mode: 0o700 });
  if (!isPlainDirectory(p)) throw new Error('backup directory must be a real directory');
  return p;
}

function walk(root: string, excludedInternal = false): { directories: string[]; files: FileInfo[] } {
  const directories: string[] = [];
  const files: FileInfo[] = [];
  const visit = (rel: string) => {
    const dir = rel ? path.join(root, ...rel.split('/')) : root;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (!safeName(ent.name)) throw new Error('unsafe filename in data');
      if (!rel && excludedInternal && isInternal(ent.name)) continue;
      if (!rel && excludedInternal && !KEY_PATTERN.test(ent.name) && ent.name !== 'principal-bindings.json') throw new Error('unsupported entry in data root');
      const item = rel ? `${rel}/${ent.name}` : ent.name;
      if (excludedInternal && isTransient(item)) continue;
      const absolute = path.join(root, ...item.split('/'));
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('symbolic links are not allowed in data or backups');
      if (!rel && excludedInternal && ((KEY_PATTERN.test(ent.name) && !stat.isDirectory()) || (ent.name === 'principal-bindings.json' && !stat.isFile()))) throw new Error('invalid data root entry');
      if (stat.isDirectory()) { directories.push(item); visit(item); }
      else if (stat.isFile()) { const data = fs.readFileSync(absolute); files.push({ path: item, sha256: hash(data), size: data.length }); }
      else throw new Error('only regular files and directories can be backed up');
    }
  };
  visit('');
  return { directories, files };
}

function copySnapshot(source: string, destination: string, manifest: Manifest): void {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const dir of manifest.directories) fs.mkdirSync(path.join(destination, ...dir.split('/')), { mode: 0o700 });
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(source, ...file.path.split('/')));
    if (bytes.length !== file.size || hash(bytes) !== file.sha256) throw new Error('data changed during backup');
    fs.writeFileSync(path.join(destination, ...file.path.split('/')), bytes, { flag: 'wx', mode: 0o600 });
  }
}

function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid backup manifest');
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1 || typeof obj.createdAt !== 'string' || !Number.isFinite(Date.parse(obj.createdAt)) || !Array.isArray(obj.directories) || !Array.isArray(obj.files)) throw new Error('invalid backup manifest');
  if (!obj.directories.every((v) => typeof v === 'string' && safeRelative(v)) || new Set(obj.directories).size !== obj.directories.length) throw new Error('invalid backup directories');
  const files: FileInfo[] = [];
  for (const item of obj.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('invalid backup file entry');
    const row = item as Record<string, unknown>;
    if (typeof row.path !== 'string' || !safeRelative(row.path) || typeof row.sha256 !== 'string' || !KEY_PATTERN.test(row.sha256) || !Number.isSafeInteger(row.size) || (row.size as number) < 0) throw new Error('invalid backup file entry');
    files.push({ path: row.path, sha256: row.sha256, size: row.size as number });
  }
  if (new Set(files.map((entry) => entry.path)).size !== files.length) throw new Error('duplicate backup file');
  return { version: 1, createdAt: obj.createdAt, directories: obj.directories as string[], files };
}

function validateTenantLedger(file: string, tenantKey: string): void {
  const state = validateStoredState(JSON.parse(fs.readFileSync(file, 'utf8')));
  const checkOwners = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(checkOwners); return; }
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (key === 'ownerUser' && item !== undefined && item !== tenantKey) throw new Error('tenant contains a different owner; manual review required');
      checkOwners(item);
    }
  };
  checkOwners(state);
}

function inspectBackup(root: string, id: string): { data: string; manifest: Manifest } {
  if (!BACKUP_PATTERN.test(id)) throw new Error('invalid backup ID');
  const dir = path.join(backupRoot(root), id);
  if (!isPlainDirectory(dir)) throw new Error('backup must be a real directory');
  const manifestFile = path.join(dir, 'manifest.json');
  const manifestStat = fs.lstatSync(manifestFile);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 16 * 1024 * 1024) throw new Error('invalid backup manifest file');
  const manifest = parseManifest(JSON.parse(fs.readFileSync(manifestFile, 'utf8')));
  const data = path.join(dir, 'data');
  if (!isPlainDirectory(data)) throw new Error('invalid backup data directory');
  const actual = walk(data);
  const order = <T extends { path: string }>(a: T, b: T) => a.path.localeCompare(b.path);
  if (JSON.stringify([...actual.directories].sort()) !== JSON.stringify([...manifest.directories].sort())
    || JSON.stringify([...actual.files].sort(order)) !== JSON.stringify([...manifest.files].sort(order))) throw new Error('backup integrity check failed');
  loadPrincipalBindings(data);
  for (const file of actual.files) {
    const [tenant, name, ...rest] = file.path.split('/');
    if (tenant && KEY_PATTERN.test(tenant) && name === 'card-rewards.json' && rest.length === 0) validateTenantLedger(path.join(data, tenant, name), tenant);
  }
  return { data, manifest };
}

function pruneBackups(root: string, keep: number, protectedId: string): void {
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10000) throw new Error('backup retention must be between 1 and 10000');
  const folder = backupRoot(root);
  const ids = fs.readdirSync(folder).filter((name) => BACKUP_PATTERN.test(name)).sort().reverse();
  const removals = ids.filter((id) => id !== protectedId).slice(Math.max(0, keep - 1));
  for (const id of removals) {
    // Only complete, verified tool-created backup directories may be pruned.
    inspectBackup(root, id);
  }
  for (const id of removals) {
    fs.rmSync(path.join(folder, id), { recursive: true });
  }
}

function pruneAfterSuccess(root: string, keep: number, protectedId: string): void {
  try { pruneBackups(root, keep, protectedId); }
  catch { process.stderr.write('Warning: operation completed but old backups could not be pruned; inspect backups manually.\n'); }
}

export function createBackup(rawRoot: string, keep = 7, prune = true): string {
  const root = requireDataRoot(rawRoot);
  assertNoInterruptedRestore(root);
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10000) throw new Error('backup retention must be between 1 and 10000');
  const folder = backupRoot(root);
  const stamp = new Date().toISOString().replace(/[-:.]/g, '');
  const id = `backup-${stamp}-${crypto.randomBytes(6).toString('hex')}`;
  const temporary = path.join(folder, `.pending-${crypto.randomBytes(12).toString('hex')}`);
  const published = path.join(folder, id);
  let renamed = false;
  fs.mkdirSync(temporary, { mode: 0o700 });
  try {
    const manifest: Manifest = { version: 1, createdAt: new Date().toISOString(), ...walk(root, true) };
    copySnapshot(root, path.join(temporary, 'data'), manifest);
    fs.writeFileSync(path.join(temporary, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, published);
    renamed = true;
    inspectBackup(root, id);
  } catch (error) {
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch { /* preserve original error */ }
    if (renamed) { try { fs.rmSync(published, { recursive: true, force: true }); } catch { /* preserve original error */ } }
    throw error;
  }
  if (prune) pruneAfterSuccess(root, keep, id);
  return id;
}

function readJournal(root: string): Journal {
  const file = path.join(root, RESTORE_JOURNAL);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid restore journal');
  const value: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid restore journal');
  const j = value as Record<string, unknown>;
  if (j.version !== 1 || typeof j.stage !== 'string' || !/^\.admin-restore-[a-f0-9]{24}$/.test(j.stage) || !Array.isArray(j.oldNames) || !Array.isArray(j.newNames)
    || !j.oldNames.every((name) => typeof name === 'string' && (KEY_PATTERN.test(name) || name === 'principal-bindings.json'))
    || !j.newNames.every((name) => typeof name === 'string' && (KEY_PATTERN.test(name) || name === 'principal-bindings.json'))
    || new Set(j.oldNames).size !== j.oldNames.length || new Set(j.newNames).size !== j.newNames.length) throw new Error('invalid restore journal');
  return j as Journal;
}

export function recoverInterruptedRestore(rawRoot: string): void {
  const root = requireDataRoot(rawRoot);
  const journal = readJournal(root);
  const stage = path.join(root, journal.stage);
  const oldDir = path.join(stage, 'old');
  if (!isPlainDirectory(stage) || !isPlainDirectory(oldDir)) throw new Error('restore staging data missing; manual recovery required');
  const validateEntry = (p: string, name: string): void => {
    const stat = fs.lstatSync(p);
    if (stat.isSymbolicLink() || (name === 'principal-bindings.json' ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error('restore staging entry is invalid; manual recovery required');
    }
  };
  // Validate all original entries before changing any file. An absent old
  // staging entry is acceptable only when the untouched original remains.
  for (const name of journal.oldNames) {
    const old = path.join(oldDir, name);
    const current = path.join(root, name);
    if (present(old)) validateEntry(old, name);
    else if (present(current)) validateEntry(current, name);
    else throw new Error('original restore entry missing; manual recovery required');
    if (present(current)) validateEntry(current, name);
  }
  for (const name of journal.newNames) {
    const current = path.join(root, name);
    if (present(current)) validateEntry(current, name);
  }
  for (const name of new Set([...journal.oldNames, ...journal.newNames])) {
    const old = path.join(oldDir, name);
    const current = path.join(root, name);
    if (present(old)) {
      if (present(current)) fs.rmSync(current, { recursive: true, force: true });
      fs.renameSync(old, current);
    } else if (!journal.oldNames.includes(name) && present(current)) fs.rmSync(current, { recursive: true, force: true });
  }
  fs.unlinkSync(path.join(root, RESTORE_JOURNAL));
  fs.rmSync(stage, { recursive: true, force: true });
}

function restoreEntries(root: string, source: string, names: string[], oldNames: string[]): void {
  assertNoInterruptedRestore(root);
  const stageName = `${STAGE_PREFIX}${crypto.randomBytes(12).toString('hex')}`;
  const stage = path.join(root, stageName);
  fs.mkdirSync(stage, { mode: 0o700 });
  try {
    fs.mkdirSync(path.join(stage, 'new'), { mode: 0o700 });
    fs.mkdirSync(path.join(stage, 'old'), { mode: 0o700 });
    for (const name of names) fs.cpSync(path.join(source, name), path.join(stage, 'new', name), { recursive: true, errorOnExist: true, force: false });
    const journal: Journal = { version: 1, stage: stageName, oldNames, newNames: names };
    const pendingJournal = path.join(stage, 'journal.json');
    fs.writeFileSync(pendingJournal, `${JSON.stringify(journal)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(pendingJournal, path.join(root, RESTORE_JOURNAL));
    for (const name of oldNames) fs.renameSync(path.join(root, name), path.join(stage, 'old', name));
    for (const name of names) fs.renameSync(path.join(stage, 'new', name), path.join(root, name));
    fs.unlinkSync(path.join(root, RESTORE_JOURNAL));
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* completed restore remains valid */ }
  } catch (error) {
    if (present(path.join(root, RESTORE_JOURNAL))) {
      try { recoverInterruptedRestore(root); } catch { throw new Error('restore interrupted: service must remain stopped; run recover-restore'); }
    } else { try { fs.rmSync(stage, { recursive: true, force: true }); } catch { /* original error */ } }
    throw error;
  }
}

export function restoreBackup(rawRoot: string, id: string, tenantKey?: string, keep = 7, allowPrincipalRollback = false): string {
  const root = requireDataRoot(rawRoot);
  assertNoInterruptedRestore(root);
  const { data } = inspectBackup(root, id);
  let newNames: string[];
  let oldNames: string[];
  if (tenantKey !== undefined) {
    assertPrincipalKey(tenantKey);
    const tenant = path.join(data, tenantKey);
    if (!present(tenant) || !isPlainDirectory(tenant)) throw new Error('tenant does not exist in backup');
    newNames = [tenantKey];
    oldNames = present(path.join(root, tenantKey)) ? [tenantKey] : [];
  } else {
    const backupBindings = loadPrincipalBindings(data);
    const currentBindings = loadPrincipalBindings(root);
    const normalized = (value: PrincipalBindings) => JSON.stringify({
      bindings: Object.fromEntries(Object.entries(value.bindings).sort(([a], [b]) => a.localeCompare(b))),
      revoked: [...value.revoked].sort(),
      version: value.version,
    });
    if (normalized(backupBindings) !== normalized(currentBindings) && !allowPrincipalRollback) {
      throw new Error('full restore changes principal bindings or revoked identities; explicit identity rollback confirmation is required');
    }
    newNames = fs.readdirSync(data).sort();
    if (newNames.some((name) => !safeName(name) || isInternal(name))) throw new Error('invalid backup root entry');
    oldNames = fs.readdirSync(root).filter((name) => !isInternal(name)).sort();
  }
  // A fresh full snapshot is mandatory before changing any live data. Do not
  // prune it or older backups until the restoration completes successfully.
  const rollbackId = createBackup(root, keep, false);
  restoreEntries(root, data, newNames, oldNames);
  pruneAfterSuccess(root, keep, rollbackId);
  return rollbackId;
}

export function rebindPrincipal(rawRoot: string, oldKey: string, newKey: string, keep = 7): string {
  const root = requireDataRoot(rawRoot);
  assertNoInterruptedRestore(root);
  assertPrincipalKey(oldKey); assertPrincipalKey(newKey);
  if (oldKey === newKey) throw new Error('old and new principal must differ');
  const current = loadPrincipalBindings(root);
  const tenantKey = resolveTenantKey(current, oldKey);
  if (current.revoked.includes(newKey) || Object.hasOwn(current.bindings, newKey) || present(path.join(root, newKey)) || Object.values(current.bindings).includes(newKey)) throw new Error('new principal already has data or is bound or revoked');
  const tenant = path.join(root, tenantKey);
  if (!present(tenant) || !isPlainDirectory(tenant)) throw new Error('old principal has no tenant directory');
  const ledger = path.join(tenant, 'card-rewards.json');
  if (present(ledger)) {
    if (!fs.lstatSync(ledger).isFile() || fs.lstatSync(ledger).isSymbolicLink()) throw new Error('invalid tenant ledger');
    validateTenantLedger(ledger, tenantKey);
  }
  const rollbackId = createBackup(root, keep, false);
  const bindings = { ...current.bindings };
  delete bindings[oldKey];
  bindings[newKey] = tenantKey;
  const updated: PrincipalBindings = { version: 1, bindings, revoked: [...current.revoked, oldKey] };
  savePrincipalBindings(root, updated);
  pruneAfterSuccess(root, keep, rollbackId);
  return rollbackId;
}
