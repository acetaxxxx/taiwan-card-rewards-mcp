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
import { callMcpTool } from './mcp-dispatch.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { loadHttpServiceConfig, type HttpServiceConfig } from './http-config.js';
import { createTokenVerifier, loadAuthorizationServerMetadata } from './http-auth.js';
import { createTenantRegistry } from './http-tenants.js';
import { getMcpErrorData } from './mcp-errors.js';

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

function createHttpHandler(config: HttpServiceConfig, metadata: OAuthMetadata, tenants: ReturnType<typeof createTenantRegistry>) {
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(config.publicUrl);
  const authMetadata: AuthMetadataOptions = {
    oauthMetadata: metadata,
    resourceServerUrl: config.publicUrl,
    scopesSupported: [config.requiredScope],
    resourceName: 'Taiwan Card Rewards MCP',
    dangerouslyAllowInsecureIssuerUrl: new URL(config.issuer).protocol === 'http:',
  };
  const authGate = requireBearerAuth({
    verifier: createTokenVerifier(config, metadata),
    expectedResource: config.publicUrl,
    requiredScopes: [config.requiredScope],
    resourceMetadataUrl,
  });
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
      const metadataResponse = oauthMetadataResponse(request, authMetadata);
      if (metadataResponse) return metadataResponse;
      if (url.pathname !== config.mcpPath) return new Response('Not found', { status: 404 });
      const origin = request.headers.get('origin');
      if (origin && !config.allowedOrigins.has(origin)) return new Response('Origin not allowed', { status: 403 });
      if (request.method === 'OPTIONS') {
        if (!origin) return new Response(null, { status: 204, headers: { Allow: 'GET, POST, DELETE, OPTIONS' } });
        return new Response(null, {
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
      }
      const authInfo = await authGate(request);
      if (authInfo instanceof Response) return addCors(authInfo, origin);
      return addCors(await protocolHandler.fetch(request, { authInfo }), origin);
    },
  };
  return { handler: toNodeHandler(fetchHandler, { maxRequestBodySize }), close: protocolHandler.close };
}

function respond(res: http.ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': String(Buffer.byteLength(body)), ...headers });
  res.end(body);
}

export async function startHttpMcpService(): Promise<void> {
  const config = loadHttpServiceConfig();
  const metadata = await loadAuthorizationServerMetadata(config);
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
