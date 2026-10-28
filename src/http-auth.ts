import { OAuthError, OAuthErrorCode, type AuthInfo, type OAuthMetadata } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from 'jose';
import { secureUrl, type HttpServiceConfig } from './http-config.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export async function loadAuthorizationServerMetadata(config: HttpServiceConfig): Promise<OAuthMetadata> {
  const response = await fetch(config.metadataUrl, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`OAuth metadata request failed with HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (!isRecord(value)
    || value.issuer !== config.issuer
    || typeof value.authorization_endpoint !== 'string'
    || typeof value.token_endpoint !== 'string'
    || !Array.isArray(value.response_types_supported)
    || !value.response_types_supported.every((entry) => typeof entry === 'string')) {
    throw new Error('OAuth metadata must include the configured issuer, authorization endpoint, token endpoint, and response_types_supported');
  }
  secureUrl(value.authorization_endpoint, 'OAuth authorization_endpoint', true);
  secureUrl(value.token_endpoint, 'OAuth token_endpoint', true);
  if (value.registration_endpoint !== undefined) secureUrl(String(value.registration_endpoint), 'OAuth registration_endpoint', true);
  return value as OAuthMetadata;
}

export function createTokenVerifier(config: HttpServiceConfig, metadata: OAuthMetadata) {
  const jwks = createRemoteJWKSet(config.jwksUrl);
  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      try {
        const { payload } = await jwtVerify(token, jwks, {
          issuer: config.issuer,
          audience: config.publicUrl.href,
          algorithms: ['RS256', 'PS256', 'ES256', 'ES384', 'EdDSA'],
        });
        if (typeof payload.sub !== 'string' || payload.sub.length === 0 || typeof payload.iss !== 'string') {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token must include issuer and subject claims');
        }
        if (typeof payload.exp !== 'number') throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token must include an expiry');
        if (payload[config.userGrantClaim] !== config.userGrantValue) {
          throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token is not marked as a user-delegated grant');
        }
        const scopes = typeof payload.scope === 'string'
          ? payload.scope.split(/\s+/).filter(Boolean)
          : Array.isArray(payload.scp) && payload.scp.every((scope) => typeof scope === 'string')
            ? payload.scp
            : [];
        const clientId = typeof payload.client_id === 'string'
          ? payload.client_id
          : typeof payload.azp === 'string'
            ? payload.azp
            : payload.sub;
        return {
          token,
          clientId,
          scopes,
          expiresAt: payload.exp,
          resource: config.publicUrl,
          extra: { issuer: metadata.issuer, subject: payload.sub },
        };
      } catch (error) {
        if (error instanceof OAuthError) throw error;
        if (error instanceof joseErrors.JOSEError) throw new OAuthError(OAuthErrorCode.InvalidToken, 'access token is invalid');
        throw error;
      }
    },
  };
}
