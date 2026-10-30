import * as fs from 'node:fs';
import * as path from 'node:path';

const requiredScopeDefault = 'mcp';

export interface OAuthAuthConfig {
  mode: 'oauth';
  issuer: string;
  metadataUrl: URL;
  jwksUrl: URL;
  userGrantClaim: string;
  userGrantValue: string;
  requiredScope: string;
}

export interface CloudflareAccessAuthConfig {
  mode: 'cloudflare-access';
  issuer: string;
  audience: string;
  jwksUrl: URL;
}

export interface HttpServiceConfig {
  dataRoot: string;
  publicUrl: URL;
  mcpPath: string;
  auth: OAuthAuthConfig | CloudflareAccessAuthConfig;
  port: number;
  host: string;
  allowedHosts: string[];
  allowedOrigins: Set<string>;
  maxTenants: number;
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function secureUrl(raw: string, name: string, allowLocalHttp = false): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { throw new Error(`${name} must be a valid URL`); }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(allowLocalHttp && local && url.protocol === 'http:')) {
    throw new Error(`${name} must use HTTPS (HTTP is allowed only for localhost)`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, query parameters, or a fragment`);
  return url;
}

function positiveInteger(raw: string | undefined, fallback: number, name: string): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function canonicalDataRoot(raw: string): string {
  if (!path.isAbsolute(raw)) throw new Error('MCP_DATA_ROOT must be an absolute path');
  const normalized = path.normalize(raw);
  if (normalized === path.parse(normalized).root) throw new Error('MCP_DATA_ROOT cannot be a filesystem root');
  fs.mkdirSync(normalized, { recursive: true, mode: 0o700 });
  const canonical = fs.realpathSync(normalized);
  if (canonical === path.parse(canonical).root || !fs.statSync(canonical).isDirectory()) throw new Error('MCP_DATA_ROOT must be a non-root directory');
  fs.chmodSync(canonical, 0o700);
  fs.accessSync(canonical, fs.constants.R_OK | fs.constants.W_OK);
  return canonical;
}

function parseOrigins(raw: string | undefined): Set<string> {
  if (!raw?.trim()) return new Set();
  const origins = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const canonical = new Set<string>();
  for (const value of origins) {
    let url: URL;
    try { url = new URL(value); }
    catch { throw new Error('MCP_HTTP_ALLOWED_ORIGINS must be a comma-separated list of origins'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error('MCP_HTTP_ALLOWED_ORIGINS entries must be exact http(s) origins without paths');
    }
    canonical.add(url.origin);
  }
  return canonical;
}

export function loadHttpServiceConfig(): HttpServiceConfig {
  const publicUrl = secureUrl(requiredEnv('MCP_HTTP_PUBLIC_URL'), 'MCP_HTTP_PUBLIC_URL', true);
  if (publicUrl.pathname === '/' || publicUrl.pathname.endsWith('/')) throw new Error('MCP_HTTP_PUBLIC_URL must identify a non-root endpoint path without a trailing slash');
  const mode = process.env.MCP_AUTH_MODE?.trim() || 'oauth';
  let auth: HttpServiceConfig['auth'];
  if (mode === 'oauth') {
    const issuer = requiredEnv('MCP_OAUTH_ISSUER');
    secureUrl(issuer, 'MCP_OAUTH_ISSUER', true);
    const metadataUrl = secureUrl(requiredEnv('MCP_OAUTH_METADATA_URL'), 'MCP_OAUTH_METADATA_URL', true);
    const jwksUrl = secureUrl(requiredEnv('MCP_OAUTH_JWKS_URL'), 'MCP_OAUTH_JWKS_URL', true);
    const userGrantClaim = requiredEnv('MCP_OAUTH_USER_GRANT_CLAIM');
    const userGrantValue = requiredEnv('MCP_OAUTH_USER_GRANT_VALUE');
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(userGrantClaim)) throw new Error('MCP_OAUTH_USER_GRANT_CLAIM must be a JWT claim name');
    const requiredScope = process.env.MCP_OAUTH_REQUIRED_SCOPE?.trim() || requiredScopeDefault;
    if (!/^[\x21\x23-\x5B\x5D-\x7E]+$/.test(requiredScope)) throw new Error('MCP_OAUTH_REQUIRED_SCOPE must be one OAuth scope token');
    auth = { mode, issuer, metadataUrl, jwksUrl, userGrantClaim, userGrantValue, requiredScope };
  } else if (mode === 'cloudflare-access') {
    const issuerUrl = secureUrl(requiredEnv('MCP_CF_ACCESS_ISSUER'), 'MCP_CF_ACCESS_ISSUER');
    if (issuerUrl.pathname !== '/') throw new Error('MCP_CF_ACCESS_ISSUER must be a Cloudflare Access team origin');
    const issuer = issuerUrl.origin;
    auth = { mode, issuer, audience: requiredEnv('MCP_CF_ACCESS_AUDIENCE'), jwksUrl: new URL('/cdn-cgi/access/certs', issuer) };
  } else {
    throw new Error('MCP_AUTH_MODE must be oauth or cloudflare-access');
  }
  const port = positiveInteger(process.env.MCP_HTTP_PORT, 8080, 'MCP_HTTP_PORT');
  if (port > 65535) throw new Error('MCP_HTTP_PORT must not exceed 65535');
  const maxTenants = positiveInteger(process.env.MCP_HTTP_MAX_TENANTS, 1000, 'MCP_HTTP_MAX_TENANTS');
  const allowedHosts = new Set([publicUrl.hostname.toLowerCase()]);
  for (const host of (process.env.MCP_HTTP_ALLOWED_HOSTS ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    let parsed: URL;
    try { parsed = new URL(`http://${host}`); }
    catch { throw new Error('MCP_HTTP_ALLOWED_HOSTS must contain valid hostnames'); }
    if (parsed.host !== host || parsed.username || parsed.password || parsed.pathname !== '/') throw new Error('MCP_HTTP_ALLOWED_HOSTS entries must be hostnames without ports or paths');
    allowedHosts.add(parsed.hostname.toLowerCase());
  }
  return {
    dataRoot: canonicalDataRoot(requiredEnv('MCP_DATA_ROOT')),
    publicUrl,
    mcpPath: publicUrl.pathname,
    auth,
    port,
    host: process.env.MCP_HTTP_HOST?.trim() || '0.0.0.0',
    allowedHosts: [...allowedHosts],
    allowedOrigins: parseOrigins(process.env.MCP_HTTP_ALLOWED_ORIGINS),
    maxTenants,
  };
}
