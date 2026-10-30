#!/usr/bin/env node
import { startHttpMcpService } from './http-service.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write([
    'taiwan-card-rewards-mcp-http - Streamable HTTP MCP service',
    '',
    'Configure these environment variables:',
    '  MCP_DATA_ROOT                       Persistent absolute storage root',
    '  MCP_HTTP_PUBLIC_URL                 Canonical HTTPS MCP endpoint, e.g. https://mcp.example.com/mcp',
    '  MCP_AUTH_MODE                       oauth (default) or cloudflare-access',
    '',
    'For cloudflare-access:',
    '  MCP_CF_ACCESS_ISSUER                Cloudflare Access team URL',
    '  MCP_CF_ACCESS_AUDIENCE              Access application AUD tag',
    '',
    'For oauth:',
    '  MCP_OAUTH_ISSUER                    OAuth/OIDC issuer URL',
    '  MCP_OAUTH_METADATA_URL              Authorization server metadata URL',
    '  MCP_OAUTH_JWKS_URL                  URL containing signing keys for JWT access tokens',
    '  MCP_OAUTH_USER_GRANT_CLAIM          JWT claim that marks a delegated user grant',
    '  MCP_OAUTH_USER_GRANT_VALUE          Required value of that delegated-grant claim',
    '',
    '  MCP_HTTP_DIAGNOSTIC_LOGS            Request/response JSON diagnostics (set 1 to enable; Compose defaults to 1)',
    'Optional: MCP_HTTP_HOST, MCP_HTTP_PORT, MCP_HTTP_ALLOWED_HOSTS, MCP_HTTP_ALLOWED_ORIGINS,',
    '          MCP_HTTP_MAX_TENANTS, MCP_HTTP_LOG_DIR, MCP_OAUTH_REQUIRED_SCOPE.',
  ].join('\n') + '\n');
} else {
  startHttpMcpService().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'HTTP MCP startup failed'}\n`);
    process.exitCode = 1;
  });
}
