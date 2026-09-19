# Recommendation System Enhancements (Case6 Analysis v3)

## Context & Purpose
This document provides AI agents with specifications for the improved recommendation flow in `taiwan-card-rewards-mcp`, adhering to natural user inputs, decoupled exchange rates, and proactive payment exploration.

## 1. Natural Currency Input (ISO 4217)
- **Direct Natural Amounts**:
  - Agents can input natural currency amounts directly without manual calculations or multiplication.
  - Examples:
    - USD: `4.8` (or `4.80`) -> automatically scaled to `480` minor units.
    - TWD: `20` -> automatically scaled to `2000` minor units.
    - JPY: `30000` -> automatically kept as `30000` minor units (0 decimals).
  - Supported input formats in `recommend`:
    1. `{ "amount": { "amount": 4.8, "currency": "USD" } }`
    2. `{ "amount": { "value": 4.8, "currency": "USD" } }`
    3. Flat format: `{ "amount": 4.8, "currency": "USD" }`
    4. Backwards compatible: `{ "amount": { "amountMinor": 480, "currency": "USD" } }`
    5. Float resilience: `{ "amount": { "amountMinor": 4.8, "currency": "USD" } }` (auto-detected and scaled)

## 2. FX Rate Architecture & Decoupling
- **Standard `recommend` Call (No `fx` Required)**:
  - By default, `recommend` requires **no `fx` input at all**. The engine automatically applies appropriate benchmark rates (spot selling for credit cards, cash selling for cross-border wallets).
- **Natural Exchange Rate Input (`rate` vs `ratePpm`)**:
  - Agents can directly supply the natural quote rate displayed on screen/bank quotes (e.g. `"rate": 0.215` for JPY/TWD or `"rate": 32.5` for USD/TWD), or use the alias `"exchangeRate"`.
  - The MCP server automatically converts `rate` to `ratePpm` (`Math.round(rate * 1_000_000)`). Agents **do not need to calculate `ratePpm`**.
  - Float resilience: If an agent mistakenly supplies a floating rate in `ratePpm` (e.g. `"ratePpm": 0.215`), the server auto-detects it and scales it by 1,000,000.
  - Backwards compatibility: Legacy integer `ratePpm` (e.g. `215000`) is fully supported.
- **Removal of Single Top-Level `fx` Constraint**:
  - The historical single top-level `fx` object with an exclusive `rateType` (e.g. `cash_selling`) is removed from recommended tool usage patterns. It must never poison or fail-close other payment paths (e.g., credit cards requiring `card_scheme`).
- **Route-Specific Clearing via `routeFacts`**:
  - Direct credit cards automatically evaluate under card scheme spot selling rates (`spot_selling` / `card_scheme`).
    - Credit card `routeFacts` example:
      ```json
      {
        "routeId": "card:fubon-jcb",
        "fx": {
          "id": "fx_quote_jpy_twd_jcb",
          "baseCurrency": "JPY",
          "quoteCurrency": "TWD",
          "rate": 0.215,
          "capturedAt": "2026-09-17T12:00:00Z",
          "provider": "JCB",
          "rateType": "card_scheme",
          "cardScheme": "jcb",
          "sourceUrl": "https://www.jcb.tw/rate/jpy.html"
        }
      }
      ```
  - Cross-border e-wallets (e.g., TaishinPay+ or Jkopay scanning Japanese PayPay) automatically evaluate under partner bank cash selling rates (`cash_selling`).
  - Route-specific rate overrides on retry should strictly be supplied via the `routeFacts: [{ routeId, edgeId, fx }]` array, preventing cross-route rate poisoning.
- **Live Quote Snapshots**:
  - `contentHash` is optional in `FxResolutionRequest`.


## 3. Automatic Payment Posture Fanout
- When `paymentMethod` is omitted in `recommend`, the engine automatically evaluates available payment postures for each card.
- Cards with mobile payment boosts (e.g., Union Bank Jihe Card 4.0% via Apple Pay vs 2.5% physical swipe) will have their optimal posture surfaced prominently in the ranked candidates, without requiring additional user prompting or query parameters.

## 4. Default Multi-Layer Route Exploration
- In `recommend`, cross-border payment routes (such as PayPay QR acceptance) are included by default.
- If merchant-specific acceptance evidence is not yet recorded, the route is presented with an annotated prerequisite ("If merchant accepts PayPay") and calculated net spend reflecting the cash selling spread.
