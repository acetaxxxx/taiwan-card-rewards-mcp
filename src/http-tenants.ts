import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OAuthError, OAuthErrorCode, type AuthInfo } from '@modelcontextprotocol/server';
import { RewardService } from './service.js';
import { FileStore, type LedgerStore } from './store.js';
import type { StartupConfig } from './startup.js';

export function createTenantRegistry(dataRoot: string, maxTenants: number) {
  const tenants = new Map<string, { store: LedgerStore; service: RewardService }>();
  return {
    service(authInfo: AuthInfo): RewardService {
      const identity = authInfo.extra;
      const issuer = identity?.issuer;
      const subject = identity?.subject;
      if (typeof issuer !== 'string' || !issuer || typeof subject !== 'string' || !subject) {
        throw new OAuthError(OAuthErrorCode.InvalidToken, 'verified access token has no tenant identity');
      }
      const tenantKey = crypto.createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
      let tenant = tenants.get(tenantKey);
      if (!tenant) {
        if (tenants.size >= maxTenants) throw new Error('MCP_HTTP_MAX_TENANTS limit reached');
        const dataDir = path.join(dataRoot, tenantKey);
        fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        if (fs.lstatSync(dataDir).isSymbolicLink() || fs.realpathSync(dataDir) !== dataDir) throw new Error('tenant data directory must be a direct child of MCP_DATA_ROOT');
        fs.chmodSync(dataDir, 0o700);
        const store = new FileStore({ dataDir, user: tenantKey } satisfies StartupConfig);
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
