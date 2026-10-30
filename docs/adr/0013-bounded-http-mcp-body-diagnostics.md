---
status: accepted
---

# Capture bounded HTTP MCP request and response bodies

The self-hosted HTTP MCP service writes authenticated JSON-RPC request and response bodies to a separate persistent Docker volume so operators can diagnose client discovery and tool-call failures across container updates. This intentionally retains allowed card and transaction data across tenants, so JSON capture is bounded to 256 KiB per body with a one-second read limit, short plain-text errors may be captured, credential-like, identity, and forbidden override fields are recursively redacted (including JSON encoded in string fields), and streaming response bodies are omitted. The application rotates five 10 MiB files, while Docker stdout/stderr metadata logs use the compressed `json-file` driver. Access assertions, authorization headers, and unauthenticated request bodies are not logged; operators must restrict log access because the remaining payload can still contain private financial data.
