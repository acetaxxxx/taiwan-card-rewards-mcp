#!/usr/bin/env node
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assertNoInterruptedRestore, createBackup, rebindPrincipal, recoverInterruptedRestore, requireDataRoot, restoreBackup } from './admin-storage.js';
import { loadPrincipalBindings, principalKey, resolveTenantKey } from './principal-bindings.js';

function main(args: string[]): void {
  const [command, ...rest] = args;
  if (command === '--help' || command === '-h') {
    process.stdout.write([
      'Offline administrator operations (use scripts/mcp-admin.sh, not this command directly):',
      '  backup',
      '  list',
      '  identity-key <issuer> <subject>',
      '  resolve-tenant <principal-key>',
      '  restore-all <backup-id> --confirm <backup-id> --confirm-identity-rollback RESTORE-PRINCIPAL-MAPPINGS',
      '  restore-tenant <backup-id> <tenant-key> --confirm <tenant-key>',
      '  rebind <old-principal-key> <new-principal-key> --confirm <new-principal-key>',
      '  recover-restore --confirm RECOVER-RESTORE',
    ].join('\n') + '\n');
    return;
  }
  if (process.env.MCP_ADMIN_OFFLINE_ACK !== 'yes') throw new Error('offline operations must be run through scripts/mcp-admin.sh after stopping the service');
  const root = requireDataRoot(process.env.MCP_DATA_ROOT ?? '/data');
  const keep = Number(process.env.MCP_BACKUP_KEEP ?? '7');
  if (!Number.isSafeInteger(keep) || keep < 1 || keep > 10000) throw new Error('MCP_BACKUP_KEEP must be an integer between 1 and 10000');
  if (command === 'check' && rest.length === 0) { assertNoInterruptedRestore(root); return; }
  if (command === 'identity-key' && rest.length === 2) { process.stdout.write(`${principalKey(rest[0]!, rest[1]!)}\n`); return; }
  if (command === 'resolve-tenant' && rest.length === 1) {
    assertNoInterruptedRestore(root);
    process.stdout.write(`${resolveTenantKey(loadPrincipalBindings(root), rest[0]!)}\n`); return;
  }
  if (command === 'list' && rest.length === 0) {
    assertNoInterruptedRestore(root);
    const folder = path.join(root, '.backups');
    if (fs.existsSync(folder)) {
      const stat = fs.lstatSync(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid backup directory');
      for (const name of fs.readdirSync(folder).filter((v) => /^backup-\d{8}T\d{9}Z-[a-f0-9]{12}$/.test(v)).sort().reverse()) process.stdout.write(`${name}\n`);
    }
    return;
  }
  if (command === 'backup' && rest.length === 0) { process.stdout.write(`Backup created: ${createBackup(root, keep)}\n`); return; }
  if (command === 'restore-all' && rest.length === 5 && rest[1] === '--confirm' && rest[2] === rest[0]
    && rest[3] === '--confirm-identity-rollback' && rest[4] === 'RESTORE-PRINCIPAL-MAPPINGS') {
    process.stdout.write(`Restored. Previous data backup: ${restoreBackup(root, rest[0]!, undefined, keep, true)}\n`); return;
  }
  if (command === 'restore-tenant' && rest.length === 4 && rest[2] === '--confirm' && rest[3] === rest[1]) {
    process.stdout.write(`Restored. Previous data backup: ${restoreBackup(root, rest[0]!, rest[1]!, keep)}\n`); return;
  }
  if (command === 'rebind' && rest.length === 4 && rest[2] === '--confirm' && rest[3] === rest[1]) {
    process.stdout.write(`Rebound. Previous data backup: ${rebindPrincipal(root, rest[0]!, rest[1]!, keep)}\n`); return;
  }
  if (command === 'recover-restore' && rest.length === 2 && rest[0] === '--confirm' && rest[1] === 'RECOVER-RESTORE') {
    recoverInterruptedRestore(root); process.stdout.write('Interrupted restore rolled back.\n'); return;
  }
  throw new Error('invalid command or confirmation; use --help for usage');
}

try { main(process.argv.slice(2)); }
catch (error) { process.stderr.write(`${error instanceof Error ? error.message : 'administrator operation failed'}\n`); process.exitCode = 1; }
