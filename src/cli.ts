#!/usr/bin/env node
import * as readline from 'node:readline';
import { parseStartupArgs, StartupContractError } from './startup.js';
import { FileStore, contentHash, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { RewardServiceError } from './errors.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { evaluateOffer, rankCards } from './evaluator.js';
import { validateUserBenefitInput, validateContext, validateToolArgs, validateTransaction, validateCard, validateCapPool, validateConfirmation, validateRule, validateSnapshot } from './validation.js';
import { projectPage, ProjectionTooLargeError } from './projections.js';
import type { CardDescriptor, RankingEntry } from './types.js';

type JsonRpc = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: '2.0'; id: string | number | null; result?: unknown; error?: { code: number; message: string; data?: unknown } };

function reply(id: JsonRpc['id'], result: unknown): void { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result } satisfies Reply)}\n`); }
function failure(id: JsonRpc['id'], code: number, message: string, data?: unknown): void { process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } } satisfies Reply)}\n`); }
function toolResult(value: unknown): unknown { return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value }; }
function rejectSensitiveFields(value: unknown): void {
  if (!value || typeof value !== 'object') return;
  for (const [key, nested] of Object.entries(value)) {
    if (/pan|card(number|_number)|cvv|cvc|otp|password|cookie|credential|secret|token|api.?key/i.test(key)) throw new RewardServiceError('SENSITIVE_FIELD_FORBIDDEN', `sensitive field is not accepted: ${key}`);
    rejectSensitiveFields(nested);
  }
}

async function main(): Promise<void> {
  const config = parseStartupArgs(process.argv.slice(2));
  const store: LedgerStore = new FileStore(config);
  const service = new RewardService(store, config.user);
  const close = () => { store.close(); process.exit(0); };
  process.once('SIGINT', close);
  process.once('SIGTERM', close);
  process.once('exit', () => { store.close(); });
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let request: JsonRpc;
    try { request = JSON.parse(line) as JsonRpc; } catch { failure(null, -32700, 'Parse error'); continue; }
    if (request.method === 'notifications/initialized' || request.method?.startsWith('notifications/')) continue;
    try {
      if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'taiwan-card-rewards-mcp', version: '0.4.0' }, instructions: mcpInstructions });
      else if (request.method === 'tools/list') reply(request.id, { tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      else if (request.method === 'tools/call') reply(request.id, toolResult(await callTool(service, request.params ?? {})));
      else failure(request.id, -32601, `Method not found: ${request.method ?? ''}`);
    } catch (error) {
      const code = error instanceof RewardServiceError || error instanceof StartupContractError ? error.code : error instanceof ProjectionTooLargeError ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
      failure(request.id, -32000, code, { code });
    }
  }
  store.close();
}

async function callTool(service: RewardService, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  if (typeof name !== 'string') throw new RewardServiceError('INVALID_INPUT', 'tool name is required');
  const rawArgs = params.arguments ?? {};
  rejectSensitiveFields(rawArgs);
  const args = validateToolArgs(name, rawArgs);
  const paged = (value: unknown[], projection: string | undefined, page: number | undefined, limit: number | undefined, sortKey: (item: unknown) => string): unknown => {
    if (projection !== undefined && !['summary', 'detail', 'calculation', 'audit'].includes(projection)) throw new RewardServiceError('INVALID_INPUT', 'projection is invalid');
    const projected = projection === 'summary' ? value.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      return { id: record.id, ...(record.issuer ? { issuer: record.issuer } : {}), ...(record.productName ? { productName: record.productName } : {}), ...(record.ruleId ? { ruleId: record.ruleId } : {}), ...(record.usageKey ? { usageKey: record.usageKey } : {}), ...(record.remaining ? { remaining: record.remaining } : {}) };
    }) : value;
    const effectivePage = page ?? 1;
    const effectiveLimit = limit ?? 10;
    return projectPage(projected, { page: effectivePage, limit: effectiveLimit, maxItems: 20, maxBytes: 256 * 1024, evaluatedAt: new Date().toISOString(), dataVersion: contentHash(JSON.stringify(projected)).slice(0, 16), sortKey });
  };
  switch (name) {
    case 'register_card': return service.registerCard(validateCard(args.card));
    case 'list_cards': { const rows = service.listCards(); return (args.limit !== undefined || args.page !== undefined || args.projection !== undefined) ? paged(rows, typeof args.projection === 'string' ? args.projection : undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as CardDescriptor).id)) : rows; }
    case 'upsert_offer': return service.upsertOffer(validateSnapshot(args.snapshot), validateRule(args.rule), args.confirmation !== undefined ? validateConfirmation(args.confirmation) : undefined, args.capPools === undefined ? undefined : (Array.isArray(args.capPools) ? args.capPools.map(validateCapPool) : []));
    case 'recommend': { const rows = service.recommend(validateTransaction(args.transaction), typeof args.limit === 'number' ? args.limit : 10); return args.page !== undefined ? paged(rows, undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as RankingEntry).cardId)) : rows; }
    case 'record_transaction': return service.recordTransaction(validateTransaction(args.transaction));
    case 'remaining_caps': { const rows = service.remainingCaps(String(args.cardId), typeof args.asOf === 'string' ? args.asOf : undefined); return (args.limit !== undefined || args.page !== undefined || args.projection !== undefined) ? paged(rows, typeof args.projection === 'string' ? args.projection : undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as { usageKey: string }).usageKey)) : rows; }
    case 'get_user_benefit_status': {
      const kind = args.kind;
      if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('INVALID_INPUT', 'kind is invalid');
      return service.getUserBenefitStatus(kind, String(args.cardId), typeof args.asOfUtc === 'string' ? args.asOfUtc : undefined);
    }
    case 'upsert_user_benefit_status': return service.upsertUserBenefitStatus(validateUserBenefitInput(args.input));
    case 'resolve_merchant': {
      if (typeof args.rawQuery !== 'string') throw new RewardServiceError('INVALID_INPUT', 'rawQuery is required');
      return service.resolveMerchant(args.rawQuery, { ...(typeof args.country === 'string' ? { country: args.country } : {}), ...(typeof args.market === 'string' ? { market: args.market } : {}), ...(typeof args.mcc === 'string' ? { mcc: args.mcc } : {}), ...(typeof args.channel === 'string' ? { channel: args.channel } : {}) });
    }
    case 'search_active_offers': return service.searchActiveOffers({ ...(typeof args.rawQuery === 'string' ? { rawQuery: args.rawQuery } : {}), ...(typeof args.cardId === 'string' ? { cardId: args.cardId } : {}), ...(typeof args.country === 'string' ? { country: args.country } : {}), ...(typeof args.channel === 'string' ? { channel: args.channel } : {}), ...(typeof args.asOf === 'string' ? { asOf: args.asOf } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.page === 'number' ? { page: args.page } : {}) });
    case 'calculate_reward': return evaluateOffer(validateRule(args.rule), validateTransaction(args.transaction), validateContext(args.context));
    case 'rank_cards': {
      if (!Array.isArray(args.cards) || !Array.isArray(args.rules)) throw new RewardServiceError('INVALID_INPUT', 'cards and rules must be arrays');
      return rankCards(args.cards.map(validateCard), args.rules.map(validateRule), validateTransaction(args.transaction), validateContext(args.context), 5);
    }
    default: throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
