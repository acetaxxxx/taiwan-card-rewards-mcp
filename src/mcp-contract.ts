import type { McpToolContract } from './types.js';

/** Instructions surfaced to MCP hosts so the user-facing agent knows the safe workflow. */
export const mcpInstructions = [
  'Use this server for Taiwan card-reward calculations and a single-user durable ledger.',
  'Call list_cards before recommendations; use register_card for card descriptors only.',
  'The Agent or UI must obtain and parse bank pages, images, or PDFs before calling this server. Treat user/OCR-derived offers as unverified candidates.',
  'Store candidate offers with upsert_offer. Activate only after explicit user confirmation by passing a valid confirmation object in the same call.',
  'Use recommend, calculate_reward, or rank_cards for planned evaluation; planned calls do not consume caps.',
  'Use record_transaction with a stable idempotencyKey for actual purchases and linked refunds. Never send PAN, CVV, OTP, passwords, tokens, or user_id.',
  'Treat unknown, stale, and needs_review as fail-closed: ask for missing facts or confirmation; never guess or convert them to zero reward.',
  'For foreign-currency transactions provide a current FX snapshot. Use remaining_caps to inspect actual usage and cap balances.',
].join(' ');

export const mcpTools: readonly McpToolContract[] = [
  { name: 'calculate_reward', description: 'Evaluate supplied offer rules for one planned or actual transaction; no persistence.', readOnly: true, inputSchema: { type: 'object', required: ['rule', 'transaction', 'context'] }, failClosedErrors: ['INSUFFICIENT_FACTS', 'SOURCE_UNAVAILABLE', 'NEEDS_REVIEW', 'STALE'] },
  { name: 'rank_cards', description: 'Return at most five cards ranked by deterministic reward for supplied rules.', readOnly: true, inputSchema: { type: 'object', required: ['cards', 'rules', 'transaction', 'context'] }, failClosedErrors: ['INSUFFICIENT_FACTS', 'SOURCE_UNAVAILABLE', 'NEEDS_REVIEW', 'STALE'] },
  { name: 'register_card', description: 'Register or replace a card descriptor in the file-backed tenant store.', readOnly: false, inputSchema: { type: 'object', required: ['card'] }, failClosedErrors: ['STORE_UNAVAILABLE'] },
  { name: 'list_cards', description: 'List registered card descriptors for this data directory.', readOnly: true, inputSchema: { type: 'object' }, failClosedErrors: ['STORE_UNAVAILABLE'] },
  { name: 'upsert_offer', description: 'Store a public offer source snapshot and versioned rule, optionally confirming candidate rules with Offer Confirmation.', readOnly: false, inputSchema: { type: 'object', required: ['snapshot', 'rule'] }, failClosedErrors: ['INVALID_OFFER', 'INVALID_CONFIRMATION', 'STORE_UNAVAILABLE'] },
  { name: 'recommend', description: 'Return up to five deterministic card recommendations using persisted rules and actual usage.', readOnly: true, inputSchema: { type: 'object', required: ['transaction'] }, failClosedErrors: ['INSUFFICIENT_FACTS', 'NEEDS_REVIEW', 'STALE'] },
  { name: 'record_transaction', description: 'Record an actual purchase or linked refund and update durable usage.', readOnly: false, inputSchema: { type: 'object', required: ['transaction'] }, failClosedErrors: ['IDEMPOTENCY_CONFLICT', 'INVALID_REFUND', 'INSUFFICIENT_FACTS', 'NEEDS_REVIEW'] },
  { name: 'remaining_caps', description: 'Report remaining reward cap amounts derived from actual transactions.', readOnly: true, inputSchema: { type: 'object', required: ['cardId'] }, failClosedErrors: ['STORE_UNAVAILABLE'] },
];

export const failClosedErrors = {
  UNAUTHENTICATED: 'A trusted Aion user context is missing or invalid.',
  INSUFFICIENT_FACTS: 'A required transaction condition is unknown; ask the user.',
  SOURCE_UNAVAILABLE: 'The source could not be fetched or parsed safely.',
  NEEDS_REVIEW: 'The rule is stale, conflicting, or not human-approved.',
  STATE_NOT_SUPPORTED: 'This operation is not supported by the current persistence mode.',
  STALE: 'The offer source or rule is expired and must be refreshed.',
  STORE_UNAVAILABLE: 'The tenant-bound durable store could not be read or written.',
} as const;
