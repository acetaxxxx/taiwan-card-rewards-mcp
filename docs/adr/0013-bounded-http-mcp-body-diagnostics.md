---
status: accepted
---

# Capture bounded HTTP MCP request and response bodies

The self-hosted HTTP MCP service writes authenticated JSON-RPC request and response bodies to a separate persistent Docker volume so operators can diagnose client discovery and tool-call failures across container updates. This intentionally retains allowed card and transaction data across tenants, so JSON capture is bounded to 256 KiB per body with a one-second read limit. Short plain-text errors and complete JSON-RPC messages from bounded Server-Sent Event responses may be captured. Credential-like, identity, and forbidden override fields are recursively redacted, including JSON encoded inside string fields.

Each authenticated request records the resolved tenant directory key as a pseudonymous `tenantRef`, plus the authentication mode. A verified OAuth `client_id` or `azp` claim is recorded when the issuer supplies one. `initialize` records the client-reported name and version; every request may also record a bounded, sanitized User-Agent. These client fields are untrusted hints unless they came from a verified OAuth claim. `tools/call` records the tool name and, when its response is captured, whether the MCP result succeeded or returned an error and the machine-readable error code. The log never records the Access assertion, authorization header, raw issuer/subject/email claims, or unauthenticated request bodies.

The application rotates five 10 MiB files, while Docker stdout/stderr metadata logs use the compressed `json-file` driver. Operators must restrict log access because captured request and response bodies can still contain private financial data, and `tenantRef` links requests made by the same tenant.
