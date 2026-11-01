import * as fs from 'node:fs';
import * as path from 'node:path';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { RewardService } from './service.js';
import { FileStore, type LedgerStore } from './store.js';
import type { StartupConfig } from './startup.js';
import { loadPrincipalBindings, principalKey, resolveTenantKey } from './principal-bindings.js';

function assertNoPendingRestore(dataRoot: string): void {
  try {
    fs.lstatSync(path.join(dataRoot, '.admin-restore-journal.json'));
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('unfinished restore requires administrator recovery before startup');
}

export function createTenantRegistry(dataRoot: string, maxTenants: number) {
  assertNoPendingRestore(dataRoot);
  const tenants = new Map<string, { store: LedgerStore; service: RewardService }>();
  // Bindings change only while the service is stopped; reject malformed mappings at startup.
  const bindings = loadPrincipalBindings(dataRoot);
  const tenantIdentity = (authInfo: AuthInfo): { identityKey: string; tenantKey: string } => {
    const identity = authInfo.extra;
    const issuer = identity?.issuer;
    const subject = identity?.subject;
    if (typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject) {
      throw new OAuthError(OAuthErrorCode.InvalidToken, 'verified access token has no tenant identity');
    }
    const identityKey = principalKey(issuer, subject);
    return { identityKey, tenantKey: resolveTenantKey(bindings, identityKey) };
  };
  return {
    tenantRef(authInfo: AuthInfo): string {
      return tenantIdentity(authInfo).tenantKey;
    },
    service(authInfo: AuthInfo): RewardService {
      const { identityKey, tenantKey } = tenantIdentity(authInfo);
      let tenant = tenants.get(tenantKey);
      if (!tenant) {
        if (tenants.size >= maxTenants) throw new Error('MCP_HTTP_MAX_TENANTS limit reached');
        const dataDir = path.join(dataRoot, tenantKey);
        // A rebound principal must not silently get a new empty ledger if its original directory is missing.
        if (tenantKey !== identityKey) {
          const stat = fs.lstatSync(dataDir);
          if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('rebound tenant directory is unavailable');
        } else {
          fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        }
        if (fs.lstatSync(dataDir).isSymbolicLink() || fs.realpathSync(dataDir) !== dataDir) throw new Error('tenant data directory must be a direct child of MCP_DATA_ROOT');
        fs.chmodSync(dataDir, 0o700);
        const store = new FileStore({ dataDir, user: tenantKey } satisfies StartupConfig, { lock: false });
        try {
          tenant = { store, service: new RewardService(store, tenantKey) };
        } catch (error) {
          store.close();
          throw error;
        }
        tenants.set(tenantKey, tenant);
      }
      return tenant.service;
    },
    close(): void {
      for (const tenant of tenants.values()) tenant.store.close();
      tenants.clear();
    },
  };
}
