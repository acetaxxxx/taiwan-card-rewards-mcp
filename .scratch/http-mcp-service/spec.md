# 多使用者 Streamable HTTP MCP service

Status: ready-for-human

## Problem Statement

目前 MCP 只能透過 stdio 連線，ChatGPT 與 Gemini 網頁版無法直接連到 repo 中執行的 MCP。Card Rewards 資料包含個人卡片、Offer Rule、交易與 Reward Ledger；若多位使用者連到同一個 HTTP process，只提供不同登入憑證並不會自動隔離他們的資料。

## Solution

新增符合 MCP Streamable HTTP 的 `/mcp` endpoint，保留既有 stdio 啟動方式與 28 個 canonical tools。HTTP 呼叫須經 OAuth 2.1 驗證；server 從已驗證的 token 取得使用者身分，為每個使用者建立獨立的資料儲存範圍。工具不得接受呼叫者指定的 `dataDir` 或 `userId` 作為授權依據。

第一版維持單一 MCP service process，使用持久化儲存空間保存每個使用者的 FileStore。部署至少需要一個固定的 HTTPS MCP URL 和外部 OAuth/OIDC authorization server。多個 service replica 共用 JSON 檔案、水平擴充與資料庫遷移不在第一版範圍。

## User Stories

1. As a ChatGPT user, I want to connect a remote MCP URL over Streamable HTTP, so that I can use the card-rewards tools from ChatGPT web.
2. As an eligible Gemini Apps user, I want to connect the same remote MCP URL, so that I can use the card-rewards tools from Gemini web and mobile.
3. As a service operator, I want each user to authenticate through OAuth, so that private card and transaction data is never exposed through an anonymous endpoint.
4. As an authenticated user, I want my verified identity to select only my own data store, so that another user cannot read or change my Card Products, Offer Rules, or Reward Ledger.
5. As a service operator, I want the tenant identity to come from a verified issuer and subject claim, so that caller-supplied IDs and paths cannot select another user's storage.
6. As a service operator, I want tokens checked for issuer, audience, expiry, and required scope on every request, so that expired or incorrectly issued credentials fail closed.
7. As a service operator, I want the OAuth authorization server and MCP resource metadata to be discoverable, so that supported ChatGPT and Gemini clients can complete their authorization flows.
8. As an existing stdio MCP user, I want the current startup path and tool behavior to remain available, so that adding remote access does not break local MCP clients.
9. As an MCP client, I want `tools/list` to advertise the same canonical tool names, descriptions, and schemas, so that stdio and HTTP clients use one contract.
10. As a user, I want the service to preserve current validation, fail-closed statuses, idempotency, and sensitive-field rejection, so that HTTP access does not weaken the Card Rewards domain invariants.
11. As a service operator, I want process startup and shutdown to create and release per-user storage locks cleanly, so that concurrent service processes cannot write the same FileStore.
12. As a service operator, I want the service to use a stable external URL and persistent storage, so that client connections remain usable and user data survives restarts.
13. As an operator testing the integration, I want to inspect and call the endpoint with MCP Inspector, so that I can verify protocol, authentication, schemas, and representative tool results before connecting web clients.

## Implementation Decisions

- Add a transport-neutral MCP server/dispatcher module that owns tool registration and dispatch. Keep stdio and Streamable HTTP as adapters over the same tool contract and RewardService behavior.
- Use the official MCP TypeScript SDK's Streamable HTTP implementation. Support Gemini's documented `2025-11-25` handshake and the newer `2026-07-28` stateless protocol on the same endpoint where the SDK supports both.
- Preserve the current raw JSON tool schemas and snake_case argument normalization. Keep the existing domain validation in force after protocol parsing.
- Configure an external OAuth 2.1/OIDC authorization server. Publish Protected Resource Metadata and challenge unauthenticated MCP requests; validate bearer tokens per request, including signature, issuer, resource audience, expiry, and required scope.
- Require delegated authorization-code + PKCE tokens whose verified `sub` identifies the end user. The operator configures a signed JWT claim/value pair that the authorization server emits only on user-delegated tokens; the service rejects tokens missing that marker so client-credentials tokens cannot select a per-user store.
- Accept signed JWT access tokens whose keys are published through the configured JWKS URL; require the public MCP endpoint URL as audience and one configured OAuth scope. Publish the authorization server metadata provided by the operator.
- Derive a stable tenant key from the verified issuer and subject, then map it internally to a per-user FileStore. Use a one-way hash for filesystem paths. Do not use email, MCP arguments, headers supplied as a user selector, or `--user` as the storage authorization key.
- Require a single service instance over a persistent data root for the FileStore implementation. Reject malformed or missing identity context before opening a tenant store. Document that horizontal scaling needs a transactional shared persistence adapter.
- Keep the service host-agnostic: accept the deployment port and canonical public MCP URL as configuration, and let the deployment terminate HTTPS. Do not add a product-specific hosting provider or OAuth account setup flow.
- Configure the service with `MCP_DATA_ROOT`, `MCP_HTTP_PUBLIC_URL`, `MCP_OAUTH_ISSUER`, `MCP_OAUTH_METADATA_URL`, and `MCP_OAUTH_JWKS_URL`; keep browser Origin checks on an exact operator-provided allowlist.
- Do not add a custom web UI. The MCP endpoint exposes the existing tools to client applications.

## Testing Decisions

- A good test exercises the public MCP endpoint or stdio adapter, checking observable protocol responses, authentication outcomes, and tenant isolation rather than private dispatcher functions.
- Cover legacy initialize/list/call over Streamable HTTP, the modern discovery request when supported, tool contract parity, missing/invalid/expired token rejection, and two authenticated subjects receiving isolated data.
- Keep existing stdio contract and startup behavior covered through the same public entry points.
- Prior art includes `mcp-contract.test.ts`, `startup.test.ts`, `shared-cli.integration.test.ts`, and `shared-mcp.test.ts`.

## Out of Scope

- Creating or operating the external OAuth/OIDC provider, registering ChatGPT and Gemini client applications, DNS/TLS setup, or deploying the service to a specific cloud provider.
- Multi-replica deployments, shared JSON-file access, database migration, and large-scale account lifecycle management.
- A custom UI, new Card Rewards tools, changing the domain schema, or altering existing stdio user behavior.
- Changing client-side plan, region, language, or workspace eligibility for ChatGPT or Gemini Apps.

## Further Notes

- ChatGPT's current custom MCP documentation requires OAuth for private user data or write actions and does not accept a custom API key as the user's authentication method. Gemini Apps supports its own Connected Apps onboarding and OAuth flow. The chosen authorization server must support the client-registration flow required by each client.
- Gemini Connected Apps currently documents account and region restrictions, including US availability, personal Google accounts, Keep Activity, and English. Gemini API remote MCP is a separate product surface.
- ChatGPT does not document a specific MCP protocol revision for custom web connections. The implementation should keep a real ChatGPT connection check as an acceptance step.
- The FileStore remains single-process and tenant-bound. A persistent data volume is required, and a later database adapter is the path to multiple service replicas.
