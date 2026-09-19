# Recommendation System Enhancements (Case6 Analysis v3)

## Context & Purpose
This document provides AI agents with specifications for the improved recommendation flow in `taiwan-card-rewards-mcp`, adhering to natural user inputs, decoupled exchange rates, and proactive payment exploration.

## 1. Natural Currency Input (ISO 4217)
- **Zero-Decimal Currencies (JPY, KRW)**:
  - Users and agents provide natural amounts directly. For 30,000 JPY, input `30000` (1 JPY = 1 minor unit).
  - **NEVER** multiply JPY amounts by 100.
- **Two-Decimal Currencies (TWD, USD, EUR)**:
  - Natural inputs (e.g. 500 TWD) are scaled to minor units (50,000 cents) internally by the MCP engine.

## 2. FX Rate Architecture & Decoupling
- **Standard `recommend` Call (No `fx` Required)**:
  - By default, `recommend` requires **no `fx` input at all**. The engine automatically applies appropriate benchmark rates (spot selling for credit cards, cash selling for cross-border wallets).
- **Removal of Single Top-Level `fx` Constraint**:
  - The historical single top-level `fx` object with an exclusive `rateType` (e.g. `cash_selling`) is removed from recommended tool usage patterns. It must never poison or fail-close other payment paths (e.g., credit cards requiring `card_scheme`).
- **Route-Specific Clearing via `routeFacts`**:
  - Direct credit cards automatically evaluate under card scheme spot selling rates (`spot_selling` / `card_scheme`).
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
