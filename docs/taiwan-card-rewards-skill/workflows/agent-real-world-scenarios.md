# Agent Real-World Scenario Playbook

This playbook provides actionable operating procedures for common high-risk agent scenarios identified in real user interactions. Use this guide alongside [`agent-scenario-playbook.md`](agent-scenario-playbook.md) and [`references/mcp-tools.md`](../references/mcp-tools.md).

---

## Scenario 1: User Correction and Persistent Write-Back (Mutate on Acknowledge)

### Context & Failure Mode
When a user corrects a card rate, merchant qualification, or rule detail (e.g. *"Richart Travel is 3.3%, not 3.8%"* or *"China Airlines is included in travel cashback"*):
- **High-Risk Failure**: The agent verbally apologizes and acknowledges the correction in natural language, but **fails to call a mutation tool**.
- **Root Cause**: When conversation length grows and triggers context compaction (memory condensation), the conversational correction is discarded. The agent later re-queries MCP tools, receives the stale/incorrect store data, and resurrects the same bug.

### Mandatory Agent Action
1. **Never acknowledge only in text**: When the user provides a factual correction, the agent MUST trigger a persistent write-back in the **same turn**.
2. **Execute Ingestion / Update**:
   - Call `create_ingestion` with the card/issuer source scope.
   - Submit corrected benefit details via `submit_ingestion_source` and `submit_benefit_leaf` / `submit_ingestion_manifest`.
   - Complete `finalize_ingestion` to commit the correction durably.
3. **Verify Before Presentation**: Query the updated rule/recommendation and present the newly persisted state to the user.

---

## Scenario 2: Marketing Headline vs Contract Specification (Marketing Abstract vs T&C Spec)

### Context & Failure Mode
Banks frequently publish marketing headlines such as *"Up to 3.8% cashback across 7 switchable plans"* or *"Maximum 10% overseas"*.
- **High-Risk Failure**: The agent mistakes the overarching promotional ceiling (Upper Bound) for a fixed rate applicable to all sub-plans or all merchant categories.

### Mandatory Agent Action
1. **Separate Headline from T&C**:
   - Treat promotional banners (*"Up to X%"*) as marketing abstracts, not executable benefit rules.
   - Identify the exact sub-plan (e.g. "Travel" vs "Dining" vs "Digital") and verify specific category percentage rates.
2. **Fail Closed on Ambiguity**:
   - If an official rule does not explicitly specify merchant inclusions for a category, flag the candidate with `needs_review` or diagnostic notes rather than applying the top rate.

---

## Scenario 3: Cross-Channel Scope Verification (Scope Narrowness Recovery)

### Context & Failure Mode
A stored rule might have been initially captured as `channels: ["in_store"]` because the user was traveling abroad. Later, the user asks about an airline ticket or booking platform purchase (e.g. China Airlines, EVA Air, Agoda).
- **High-Risk Failure**: The agent sees `channels: ["in_store"]` in the local rule and immediately concludes that online transactions earn only the 0.3% base rate, without verifying the bank's full terms.

### Mandatory Agent Action
1. **Check Multi-Channel Exceptions**:
   - For travel, airline, hotel, and transport categories, bank terms often explicitly include online booking and mobile transactions even within overseas travel schemes.
2. **Verify Official Provenance**:
   - Check official terms before concluding a channel exclusion.
   - If the merchant is in the airline/transport sector, inspect if the card scheme or bank terms define it as an eligible travel merchant regardless of physical presence.

---

## Scenario 4: Dual-Rail Cross-Border FX Drag (FX Spread Warning)

### Context & Failure Mode
For overseas transactions (e.g. in Japan), users can pay via:
1. **Physical Card / Apple Pay (Card Scheme Rail)**: Settled via JCB, Mastercard, or Visa using wholesale spot mid-market exchange rates.
2. **QR Code Scanning (E-Wallet Rail - Taishin Pay+, JkoPay via HIVEX)**: Settled via partner banks using **bank cash selling exchange rates** (typically +1.8% to +2.3% more expensive than wholesale spot rates).
- **High-Risk Failure**: The agent compares nominal reward rates (e.g. 3.5% QR code vs 3.0% Apple Pay) without deducting the ~2% FX spread drag, falsely recommending a route that actually yields less net value.

### Mandatory Agent Action
1. **Calculate Real Net Benefit**:
   $$\text{Real Net Benefit} = \text{Gross Reward} - \text{Foreign Fee (1.5%)} - \text{FX Spread Drag}$$
2. **Proactive Warning to User**:
   - If Apple Pay / physical card is accepted at the merchant, advise the user to prioritize card payment (wholesale spot rate + full cashback).
   - If QR scan is considered, inform the user: *"QR payment uses bank cash selling rates (approx. 2% FX premium over card spot rates); unless QR-exclusive promotions outweigh the spread, contactless card payment is more cost-effective."*

---

## Scenario 5: Two-Stage Expense Settlement (Estimated vs Settled Transaction)

### Context & Failure Mode
Overseas transactions fluctuate in TWD cost until settled on the credit card statement:
- **Stage 1 (Purchase Time / Estimation)**: The exact transaction occurred, but only the foreign currency amount and spot/quote FX rate are known.
- **Stage 2 (Statement Time / Settlement)**: The bank posts the final settled TWD amount, foreign transaction fee, and actual clearing rate.

### Mandatory Agent Action
1. **Initial Recording**:
   - Call `record_transaction` using the captured transaction date, amount, currency, and known FX rate snapshot.
   - Present the recorded transaction with estimated TWD conversion and net rewards.
2. **Statement Reconciliation**:
   - When the user provides the final billing statement or exact charged amount, update or annotate the transaction record so historical cap tracking and accounting match actual bank statements.
