import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createLocalJWKSet, createRemoteJWKSet, customFetch, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCloudflareAccessGate, createTokenVerifier } from '../src/http-auth.js';
import { loadHttpServiceConfig, type CloudflareAccessAuthConfig } from '../src/http-config.js';
import { createTenantRegistry } from '../src/http-tenants.js';
import { principalKey } from '../src/principal-bindings.js';
import { createHttpHandler } from '../src/http-service.js';

const issuer = 'https://team.cloudflareaccess.com';
const audience = 'access-application-audience';
const config: CloudflareAccessAuthConfig = {
  mode: 'cloudflare-access', issuer, audience, jwksUrl: new URL(`${issuer}/cdn-cgi/access/certs`),
};

describe('Cloudflare Access identity assertion', () => {
  let privateKey: CryptoKey;
  let otherPrivateKey: CryptoKey;
  let keys: ReturnType<typeof createLocalJWKSet>;
  let firstJwk: JWK;
  let secondJwk: JWK;

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256', { extractable: true });
    const otherPair = await generateKeyPair('RS256', { extractable: true });
    privateKey = pair.privateKey;
    otherPrivateKey = otherPair.privateKey;
    firstJwk = { ...await exportJWK(pair.publicKey), kid: 'key-1', alg: 'RS256' };
    secondJwk = { ...await exportJWK(otherPair.publicKey), kid: 'key-2', alg: 'RS256' };
    keys = createLocalJWKSet({ keys: [firstJwk] });
  });

  async function assertion(overrides: { iss?: string; aud?: string; sub?: string; type?: string; exp?: number; nbf?: number; common_name?: string } = {}, key = privateKey) {
    const token = new SignJWT({ type: overrides.type ?? 'app', ...(overrides.common_name ? { common_name: overrides.common_name } : {}) })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' })
      .setIssuer(overrides.iss ?? issuer)
      .setAudience(overrides.aud ?? audience)
      .setSubject(overrides.sub ?? 'user-123')
      .setExpirationTime(overrides.exp ?? Math.floor(Date.now() / 1000) + 300);
    if (overrides.nbf !== undefined) token.setNotBefore(overrides.nbf);
    return token.sign(key);
  }

  async function request(token?: string, extraHeaders: Record<string, string> = {}) {
    const headers = new Headers(extraHeaders);
    if (token !== undefined) headers.set('Cf-Access-Jwt-Assertion', token);
    return createCloudflareAccessGate(config, keys)(new Request('https://mcp.example.com/mcp', { headers }));
  }

  it('accepts a signed, application-scoped user assertion and uses issuer/sub as identity', async () => {
    const result = await request(await assertion());
    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) throw new Error('expected authenticated principal');
    expect(result.extra).toEqual({ issuer, subject: 'user-123' });
  });

  it('rejects absent assertions even when a caller supplies a bearer token or identity headers', async () => {
    const result = await request(undefined, { Authorization: 'Bearer arbitrary', 'X-User-Id': 'user-123' });
    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(401);
  });

  it('rejects invalid signature, issuer, audience, expiration, token type and missing user identity', async () => {
    const noExpiry = await new SignJWT({ type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(issuer).setAudience(audience).setSubject('user-123').sign(privateKey);
    const noSubject = await new SignJWT({ type: 'app' }).setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(issuer).setAudience(audience).setExpirationTime('5m').sign(privateKey);
    const invalid = [
      'not-a-jwt',
      noExpiry,
      noSubject,
      await assertion({}, otherPrivateKey),
      await assertion({ iss: 'https://wrong.cloudflareaccess.com' }),
      await assertion({ aud: 'wrong-application' }),
      await assertion({ exp: Math.floor(Date.now() / 1000) - 60 }),
      await assertion({ nbf: Math.floor(Date.now() / 1000) + 300 }),
      await assertion({ type: 'org' }),
      await assertion({ sub: '' }),
      await assertion({ common_name: 'machine-token.access' }),
    ];
    for (const token of invalid) {
      const result = await request(token);
      expect(result).toBeInstanceOf(Response);
      expect((result as Response).status).toBe(401);
    }
  });

  it('retains existing bearer OAuth token validation', async () => {
    const resource = new URL('https://mcp.example.com/mcp');
    const oauth = { mode: 'oauth' as const, issuer, metadataUrl: new URL(`${issuer}/metadata`), jwksUrl: config.jwksUrl, userGrantClaim: 'gty', userGrantValue: 'authorization_code', requiredScope: 'mcp' };
    const metadata = { issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, response_types_supported: ['code'] };
    const token = async (grant: string) => new SignJWT({ gty: grant, scope: 'mcp', client_id: 'client' })
      .setProtectedHeader({ alg: 'RS256', kid: 'key-1' }).setIssuer(issuer).setAudience(resource.href).setSubject('user-123').setExpirationTime('5m').sign(privateKey);
    const verifier = createTokenVerifier(oauth, resource, metadata, keys);
    expect((await verifier.verifyAccessToken(await token('authorization_code'))).extra).toEqual({ issuer, subject: 'user-123' });
    await expect(verifier.verifyAccessToken(await token('client-credentials'))).rejects.toThrow();
  });

  it('refreshes the Cloudflare JWKS when the signing key rotates', async () => {
    let currentKeys = [firstJwk];
    const remoteKeys = createRemoteJWKSet(config.jwksUrl, {
      [customFetch]: async () => Response.json({ keys: currentKeys }),
    });
    const gate = createCloudflareAccessGate(config, remoteKeys);
    const signed = async (kid: string, key: CryptoKey) => new SignJWT({ type: 'app' })
      .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setAudience(audience).setSubject('user-123').setExpirationTime('5m').sign(key);
    const requestFor = (token: string) => new Request('https://mcp.example.com/mcp', { headers: { 'Cf-Access-Jwt-Assertion': token } });
    vi.useFakeTimers();
    try {
      expect(await gate(requestFor(await signed('key-1', privateKey)))).not.toBeInstanceOf(Response);
      currentKeys = [secondJwk];
      vi.setSystemTime(Date.now() + 31_000);
      expect(await gate(requestFor(await signed('key-2', otherPrivateKey)))).not.toBeInstanceOf(Response);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects valid-looking assertions when Cloudflare JWKS cannot be fetched', async () => {
    const unavailableKeys = createRemoteJWKSet(config.jwksUrl, {
      [customFetch]: async () => new Response('unavailable', { status: 503 }),
    });
    const gate = createCloudflareAccessGate(config, unavailableKeys);
    const response = await gate(new Request('https://mcp.example.com/mcp', {
      headers: { 'Cf-Access-Jwt-Assertion': await assertion() },
    }));
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(401);
  });

  it('serves the HTTP MCP protocol only to verified principals and isolates users', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-cf-http-')));
    const publicUrl = new URL('https://mcp.example.com/mcp');
    const registry = createTenantRegistry(dir, 10);
    const handler = createHttpHandler({ dataRoot: dir, publicUrl, mcpPath: '/mcp', auth: config, host: '127.0.0.1', port: 8080, allowedHosts: ['mcp.example.com'], allowedOrigins: new Set(), maxTenants: 10 }, undefined, registry, keys);
    const call = async (token: string | undefined, method: string, params: Record<string, unknown> = {}) => {
      const headers = new Headers({ 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'MCP-Protocol-Version': '2025-11-25' });
      if (token) headers.set('Cf-Access-Jwt-Assertion', token);
      return handler.fetch(new Request(publicUrl, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    };
    const result = async (response: Response) => {
      expect(response.status).toBe(200);
      const body = await response.text();
      const data = response.headers.get('content-type')?.includes('text/event-stream')
        ? body.split('\n').find((line) => line.startsWith('data:'))?.slice(5).trim()
        : body;
      if (!data) throw new Error('missing MCP response');
      return JSON.parse(data);
    };
    try {
      expect((await call(undefined, 'tools/list')).status).toBe(401);
      expect((await handler.fetch(new Request('https://mcp.example.com/.well-known/oauth-authorization-server'))).status).toBe(404);
      const a = await assertion({ sub: 'user-a' });
      const b = await assertion({ sub: 'user-b' });
      const init = await result(await call(a, 'initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'integration-test', version: '1' } }));
      expect(init.result.serverInfo.name).toBe('taiwan_card_rewards_mcp');
      const listed = await result(await call(a, 'tools/list'));
      expect(listed.result.tools).toHaveLength(28);
      const registered = await result(await call(a, 'tools/call', { name: 'register_card', arguments: { card: { id: 'a-card', issuer: 'A Bank', productName: 'A Card' } } }));
      expect(registered.result.isError).not.toBe(true);
      const aCards = await result(await call(a, 'tools/call', { name: 'list_cards', arguments: {} }));
      const bCards = await result(await call(b, 'tools/call', { name: 'list_cards', arguments: {} }));
      expect(aCards.result.content[0].text).toContain('a-card');
      expect(bCards.result.content[0].text).not.toContain('a-card');
    } finally {
      await handler.close();
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('tenant identity bindings', () => {
  it('fails closed when restore journal exists, including a dangling symlink', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-cf-restore-')));
    try {
      symlinkSync(join(dir, 'missing'), join(dir, '.admin-restore-journal.json'));
      expect(() => createTenantRegistry(dir, 10)).toThrow(/unfinished restore/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('denies a revoked identity and sends its replacement to the original tenant', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-cf-tenant-')));
    const oldKey = principalKey(issuer, 'old-subject');
    const newKey = principalKey(issuer, 'new-subject');
    writeFileSync(join(dir, 'principal-bindings.json'), JSON.stringify({ version: 1, bindings: { [newKey]: oldKey }, revoked: [oldKey] }));
    mkdirSync(join(dir, oldKey));
    const registry = createTenantRegistry(dir, 10);
    const info = (subject: string) => ({ token: 'opaque', clientId: 'client', scopes: [], extra: { issuer, subject } });
    try {
      expect(() => registry.service(info('old-subject'))).toThrow(/revoked/);
      const original = registry.service(info('new-subject'));
      const other = registry.service(info('other-subject'));
      expect(original.metadataUser).toBe(oldKey);
      expect(other.metadataUser).not.toBe(oldKey);
      original.registerCard({ id: 'card-a', issuer: 'Bank A', productName: 'Card A' });
      expect(other.listCards()).toEqual([]);
      expect(original.listCards()).toHaveLength(1);
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not create an empty ledger when a rebound tenant directory is missing', () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-cf-missing-')));
    const oldKey = principalKey(issuer, 'old');
    const newKey = principalKey(issuer, 'new');
    writeFileSync(join(dir, 'principal-bindings.json'), JSON.stringify({ version: 1, bindings: { [newKey]: oldKey }, revoked: [oldKey] }));
    const registry = createTenantRegistry(dir, 10);
    try {
      expect(() => registry.service({ token: 't', clientId: 'c', scopes: [], extra: { issuer, subject: 'new' } })).toThrow();
    } finally {
      registry.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('HTTP auth mode configuration', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cf-config-'));
  afterEach(() => { vi.unstubAllEnvs(); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('starts Cloudflare mode with its own settings and does not require bearer OAuth metadata', () => {
    vi.stubEnv('MCP_DATA_ROOT', dir);
    vi.stubEnv('MCP_HTTP_PUBLIC_URL', 'https://mcp.example.com/mcp');
    vi.stubEnv('MCP_AUTH_MODE', 'cloudflare-access');
    vi.stubEnv('MCP_CF_ACCESS_ISSUER', `${issuer}/`);
    vi.stubEnv('MCP_CF_ACCESS_AUDIENCE', audience);
    vi.stubEnv('MCP_OAUTH_ISSUER', '');
    const loaded = loadHttpServiceConfig();
    expect(loaded.auth).toEqual({ mode: 'cloudflare-access', issuer, audience, jwksUrl: new URL(`${issuer}/cdn-cgi/access/certs`) });
  });

  it('retains oauth as the default mode', () => {
    vi.stubEnv('MCP_DATA_ROOT', dir);
    vi.stubEnv('MCP_HTTP_PUBLIC_URL', 'https://mcp.example.com/mcp');
    vi.stubEnv('MCP_AUTH_MODE', '');
    vi.stubEnv('MCP_OAUTH_ISSUER', issuer);
    vi.stubEnv('MCP_OAUTH_METADATA_URL', `${issuer}/metadata`);
    vi.stubEnv('MCP_OAUTH_JWKS_URL', `${issuer}/keys`);
    vi.stubEnv('MCP_OAUTH_USER_GRANT_CLAIM', 'gty');
    vi.stubEnv('MCP_OAUTH_USER_GRANT_VALUE', 'authorization_code');
    expect(loadHttpServiceConfig().auth.mode).toBe('oauth');
  });
});
