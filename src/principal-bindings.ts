import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const fileName = 'principal-bindings.json';
const keyPattern = /^[a-f0-9]{64}$/;

export interface PrincipalBindings {
  version: 1;
  bindings: Readonly<Record<string, string>>;
  revoked: readonly string[];
}

export function principalKey(issuer: string, subject: string): string {
  if (!issuer || !subject) throw new Error('issuer and subject are required');
  return crypto.createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
}

export function assertPrincipalKey(value: string): void {
  if (!keyPattern.test(value)) throw new Error('principal key must be a lowercase SHA-256 hash');
}

function parsePrincipalBindings(parsed: unknown): PrincipalBindings {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid principal bindings');
  const record = parsed as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['version', 'bindings', 'revoked'].includes(key)) || record.version !== 1
    || !record.bindings || typeof record.bindings !== 'object' || Array.isArray(record.bindings) || !Array.isArray(record.revoked)) {
    throw new Error('invalid principal bindings');
  }
  const revoked = record.revoked;
  if (!revoked.every((key) => typeof key === 'string' && keyPattern.test(key)) || new Set(revoked).size !== revoked.length) throw new Error('invalid revoked principal keys');
  const revokedSet = new Set<string>(revoked);
  const entries = Object.entries(record.bindings);
  const targets = new Set<string>();
  const bindings: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, target] of entries) {
    if (!keyPattern.test(key) || typeof target !== 'string' || !keyPattern.test(target) || key === target
      || revokedSet.has(key) || !revokedSet.has(target) || targets.has(target)) throw new Error('invalid or conflicting principal bindings');
    targets.add(target);
    bindings[key] = target;
  }
  return { version: 1, bindings, revoked: [...revoked] };
}

export function loadPrincipalBindings(dataRoot: string): PrincipalBindings {
  const file = path.join(dataRoot, fileName);
  let stat: fs.Stats;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, bindings: {}, revoked: [] };
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('invalid principal bindings file');
  return parsePrincipalBindings(JSON.parse(fs.readFileSync(file, 'utf8')));
}

export function resolveTenantKey(bindings: PrincipalBindings, key: string): string {
  assertPrincipalKey(key);
  if (bindings.revoked.includes(key)) throw new Error('principal has been revoked');
  return bindings.bindings[key] ?? key;
}

export function savePrincipalBindings(dataRoot: string, value: PrincipalBindings): void {
  const file = path.join(dataRoot, fileName);
  const temporary = path.join(dataRoot, `.principal-bindings-${crypto.randomBytes(12).toString('hex')}.tmp`);
  try {
    const normalized = parsePrincipalBindings(value);
    fs.writeFileSync(temporary, `${JSON.stringify(normalized, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.rmSync(temporary, { force: true }); } catch { /* preserve original error */ }
    throw error;
  }
}
