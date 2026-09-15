---
name: card-rewards-recommendation
description: Recommend Taiwan credit-card rewards for a merchant, payment route, or foreign-currency purchase; recover missing facts and explain unresolved candidates.
---

# Taiwan card-rewards recommendation

Before constructing an MCP payload, read the shared [`mcp-tools.md`](../references/mcp-tools.md). Use this skill for a planned purchase, card comparison, merchant ambiguity, payment-path choice, or FX estimate.

- Start merchant intent with [`workflows/recommendation-intent.md`](workflows/recommendation-intent.md).
- Resolve an ambiguous merchant with [`workflows/merchant-resolution-and-disambiguation.md`](workflows/merchant-resolution-and-disambiguation.md); discover offers with [`workflows/offer-discovery-and-pagination.md`](workflows/offer-discovery-and-pagination.md).
- For a wallet, payment route, or foreign currency, read [`workflows/payment-route-and-fx.md`](workflows/payment-route-and-fx.md).
- When `recommend` returns `requiredActions`, follow [`workflows/preflight-and-required-actions.md`](workflows/preflight-and-required-actions.md) and retry only after the required facts or official evidence are available.

Return a recommendation only at the certainty represented by the MCP response. A blocked or unknown candidate is useful output when the missing fact matters.
