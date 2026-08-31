# 08: Expose the complete MCP contract with public-source security

**What to build:** The complete eight-tool stdio MCP surface provides stable structured outcomes for calculation, source governance, card management, recommendations, ledger operations, and cap inspection under strict identity and input boundaries. Source retrieval and parsing remain outside the MCP.

**Blocked by:** 03: Deliver deterministic uncertainty-aware Top-5 ranking; 04: Govern official source snapshots and candidate activation; 05: Support Card Product, Held Card, and Eligibility Facts; 07: Reconcile billing cycles, currencies, and FX context

**Status:** completed

- [x] All eight tools are exposed with stable schemas and structured success, uncertainty, stale, needs-review, and rejection errors.
- [x] The MCP remains stdio-only and receives identity/storage scope from the trusted parent; tools cannot override user IDs or data paths.
- [x] Unknown and sensitive fields, PAN/CVV/OTP/cookies/tokens, and credential-like values are rejected.
- [x] Public fetching allows only trusted official hosts and rejects credentials, custom ports, redirects, private/loopback addresses, oversized responses, invalid content types, and timeouts.
- [x] JSON-RPC initialize, tools/list, tools/call, malformed requests, unknown tools, and stdout/stderr separation are covered by contract tests.
- [x] An end-to-end demonstration covers candidate review, deterministic recommendation, actual purchase, refund, and remaining-cap inspection.
