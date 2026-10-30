import * as http from 'node:http';
import { createRequire } from 'node:module';
import {
  OAuthError,
  OAuthErrorCode,
  Server,
  createMcpHandler,
  getOAuthProtectedResourceMetadataUrl,
  oauthMetadataResponse,
  requireBearerAuth,
  type AuthMetadataOptions,
  type OAuthMetadata,
  type Tool,
} from '@modelcontextprotocol/server';
import { hostHeaderValidation, toNodeHandler } from '@modelcontextprotocol/node';
import type { NodeIncomingMessageLike, NodeServerResponseLike } from '@modelcontextprotocol/node';
import type { JWTVerifyGetKey } from 'jose';
import { callMcpTool } from './mcp-dispatch.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { loadHttpServiceConfig, type HttpServiceConfig } from './http-config.js';
import { createCloudflareAccessGate, createTokenVerifier, loadAuthorizationServerMetadata } from './http-auth.js';
import { createTenantRegistry } from './http-tenants.js';
import { getMcpErrorData } from './mcp-errors.js';
import {
  captureDiagnosticRequest,
  captureDiagnosticResponse,
  httpDiagnosticsEnabled,
  initializeHttpDiagnosticLog,
  writeHttpDiagnostic,
  type DiagnosticBodySnapshot,
  type DiagnosticRequestSnapshot,
} from './http-diagnostics.js';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };
const maxRequestBodySize = 4 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function toolFailure(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  return { content: [{ type: 'text', text: JSON.stringify(getMcpErrorData(error)) }], isError: true };
}

function addCors(response: Response, origin: string | null): Response {
  if (!origin) return response;
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  headers.set('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, Allow');
  headers.append('Vary', 'Origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function safeOrigin(value: string | null): string | undefined {
  if (!value) return undefined;
  try { return new URL(value).origin; }
  catch { return undefined; }
}

function safeCloudflareRayId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9-]{1,64}$/.test(value) ? value : undefined;
}

export function createHttpHandler(config: HttpServiceConfig, metadata: OAuthMetadata | undefined, tenants: ReturnType<typeof createTenantRegistry>, cloudflareKeys?: JWTVerifyGetKey) {
  let authMetadata: AuthMetadataOptions | undefined;
  let authGate: (request: Request) => Promise<import('@modelcontextprotocol/server').AuthInfo | Response>;
  if (config.auth.mode === 'oauth') {
    if (!metadata) throw new Error('OAuth metadata is required for oauth mode');
    const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.publicUrl);
    authMetadata = {
      oauthMetadata: metadata,
      resourceServerUrl: config.publicUrl,
      scopesSupported: [config.auth.requiredScope],
      resourceName: 'Taiwan Card Rewards MCP',
      dangerouslyAllowInsecureIssuerUrl: new URL(config.auth.issuer).protocol === 'http:',
    };
    authGate = requireBearerAuth({
      verifier: createTokenVerifier(config.auth, config.publicUrl, metadata),
      expectedResource: config.publicUrl,
      requiredScopes: [config.auth.requiredScope],
      resourceMetadataUrl,
    });
  } else {
    authGate = createCloudflareAccessGate(config.auth, cloudflareKeys);
  }
  const protocolHandler = createMcpHandler(({ authInfo }) => {
    if (!authInfo) throw new OAuthError(OAuthErrorCode.InvalidToken, 'authenticated user identity is required');
    const service = tenants.service(authInfo);
    const server = new Server(
      { name: 'taiwan_card_rewards_mcp', version: packageJson.version },
      { capabilities: { tools: {} }, instructions: mcpInstructions },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema as Tool['inputSchema'] })),
    }));
    server.setRequestHandler('tools/call', async (request) => {
      let result;
      try {
        const value = await callMcpTool(service, request.params as unknown as Record<string, unknown>);
        const toolResult: { content: { type: 'text'; text: string }[]; structuredContent?: Record<string, unknown> } = {
          content: [{ type: 'text', text: JSON.stringify(value) }],
        };
        if (isRecord(value)) toolResult.structuredContent = value;
        result = toolResult;
      } catch (error) {
        result = toolFailure(error);
      }
      return server.projectCallToolResult(result, undefined);
    });
    return server;
  }, { legacy: 'stateless', maxRequestBodySize });

  const fetchHandler = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const isMcpEndpoint = url.pathname === config.mcpPath;
      const isMetadataEndpoint = Boolean(authMetadata && url.pathname.startsWith('/.well-known/oauth-protected-resource'));
      const diagnosticsEnabled = httpDiagnosticsEnabled();
      const startedAt = Date.now();
      const origin = request.headers.get('origin');
      const normalizedOrigin = safeOrigin(origin);
      const cfRay = safeCloudflareRayId(request.headers.get('cf-ray'));
      let requestSnapshotPromise: Promise<DiagnosticRequestSnapshot | undefined> = Promise.resolve(undefined);
      let responseSnapshotPromise: Promise<DiagnosticBodySnapshot | undefined> = Promise.resolve(undefined);
      const credentialsPresent = config.auth.mode === 'cloudflare-access'
        ? request.headers.has('cf-access-jwt-assertion')
        : /^Bearer\s+\S+/i.test(request.headers.get('authorization') ?? '');
      let authResult = credentialsPresent ? 'present' : 'missing';
      let phase = 'routing';
      let status = 500;
      const complete = (response: Response): Response => {
        status = response.status;
        if (diagnosticsEnabled && (isMcpEndpoint || isMetadataEndpoint)) {
          responseSnapshotPromise = captureDiagnosticResponse(response).catch(() => undefined);
        }
        return response;
      };

      try {
        const metadataResponse = authMetadata ? oauthMetadataResponse(request, authMetadata) : undefined;
        if (metadataResponse) {
          phase = 'oauth_discovery';
          return complete(metadataResponse);
        }
        if (!isMcpEndpoint) {
          phase = 'not_found';
          const response = new Response('Not found', { status: 404 });
          return complete(response);
        }
        if (origin && !config.allowedOrigins.has(origin)) {
          phase = 'origin_denied';
          const response = new Response('Origin not allowed', { status: 403 });
          return complete(response);
        }
        if (request.method === 'OPTIONS') {
          phase = 'preflight';
          const response = !origin
            ? new Response(null, { status: 204, headers: { Allow: 'GET, POST, DELETE, OPTIONS' } })
            : new Response(null, {
              status: 204,
              headers: {
                'Access-Control-Allow-Origin': origin,
                'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID, Accept',
                'Access-Control-Expose-Headers': 'WWW-Authenticate, MCP-Protocol-Version, MCP-Session-Id, Last-Event-ID, Allow',
                'Access-Control-Max-Age': '600',
                Vary: 'Origin',
              },
            });
          return complete(response);
        }
        phase = 'authentication';
        const authInfo = await authGate(request);
        if (authInfo instanceof Response) {
          authResult = credentialsPresent ? 'rejected' : 'missing';
          phase = 'authentication_denied';
          const response = addCors(authInfo, origin);
          return complete(response);
        }
        authResult = 'accepted';
        phase = 'mcp';
        if (diagnosticsEnabled) requestSnapshotPromise = captureDiagnosticRequest(request).catch(() => undefined);
        const response = addCors(await protocolHandler.fetch(request, { authInfo }), origin);
        return complete(response);
      } catch (error) {
        phase = 'handler_error';
        throw error;
      } finally {
        if (diagnosticsEnabled && (isMcpEndpoint || isMetadataEndpoint)) {
          const timestamp = new Date().toISOString();
          const baseRecord = {
            timestamp,
            method: request.method,
            path: url.pathname,
            status,
            durationMs: Date.now() - startedAt,
            phase,
            auth: authResult,
            ...(normalizedOrigin ? { origin: normalizedOrigin } : {}),
            ...(cfRay ? { cfRay } : {}),
          };
          void Promise.all([requestSnapshotPromise, responseSnapshotPromise]).then(([requestSnapshot, responseBody]) => {
            writeHttpDiagnostic({
              ...baseRecord,
              ...(requestSnapshot?.rpcMethod ? { rpcMethod: requestSnapshot.rpcMethod } : {}),
              ...(requestSnapshot?.body ? { requestBody: requestSnapshot.body } : {}),
              ...(responseBody ? { responseBody } : {}),
            });
          }).catch(() => writeHttpDiagnostic(baseRecord));
        }
      }
    },
  };
  return { handler: toNodeHandler(fetchHandler, { maxRequestBodySize }), fetch: fetchHandler.fetch, close: protocolHandler.close };
}

function respond(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

export async function startHttpMcpService(): Promise<void> {
  const config = loadHttpServiceConfig();
  initializeHttpDiagnosticLog();
  const metadata = config.auth.mode === 'oauth' ? await loadAuthorizationServerMetadata(config.auth) : undefined;
  const tenants = createTenantRegistry(config.dataRoot, config.maxTenants);
  const { handler, close: closeProtocol } = createHttpHandler(config, metadata, tenants);
  const validateHost = hostHeaderValidation(config.allowedHosts);
  const server = http.createServer((req, res) => {
    if (!validateHost(req, res)) return;
    const requestUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    if (requestUrl.pathname === '/healthz') {
      respond(res, 200, 'ok\n');
      return;
    }
    const wellKnown = requestUrl.pathname.startsWith('/.well-known/oauth-protected-resource') || requestUrl.pathname === '/.well-known/oauth-authorization-server';
    if (!wellKnown && requestUrl.pathname !== config.mcpPath) {
      respond(res, 404, 'not found\n');
      return;
    }
    const label = wellKnown ? 'OAuth metadata' : 'HTTP MCP';
    void handler(req as unknown as NodeIncomingMessageLike, res as unknown as NodeServerResponseLike).catch((error: unknown) => {
      process.stderr.write(`${label} adapter error: ${error instanceof Error ? error.message : 'unknown error'}\n`);
      if (!res.headersSent) respond(res, 500, 'internal server error\n');
      else res.destroy();
    });
  });

  let shutdownTask: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownTask) return shutdownTask;
    shutdownTask = (async () => {
      const serverClosed = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await closeProtocol();
      await serverClosed;
      tenants.close();
    })();
    return shutdownTask;
  };
  process.once('SIGINT', () => { void shutdown().then(() => process.exit(0)); });
  process.once('SIGTERM', () => { void shutdown().then(() => process.exit(0)); });
  process.once('exit', () => tenants.close());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  process.stderr.write(`Taiwan Card Rewards Streamable HTTP MCP listening on ${config.host}:${config.port}${config.mcpPath}\n`);
}
