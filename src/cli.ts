#!/usr/bin/env node
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseStartupArgs, StartupContractError } from './startup.js';
import type { StartupConfig } from './startup.js';
import { FileStore, contentHash, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { RewardServiceError } from './errors.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { evaluateOffer, rankCards } from './evaluator.js';
import { validateUserBenefitInput, validateContext, validateToolArgs, validateRecommendationTransaction, validateTransaction, validateCard, validateCapPool, validateConfirmation, validateRule, validateSnapshot } from './validation.js';
import { projectPage, ProjectionTooLargeError } from './projections.js';
import { SharedMcpClient, SharedMcpOwner, connectSharedBridge } from './shared-mcp.js';
import { runStdioBridge } from './shared-cli.js';
import type { CardDescriptor, RankingEntry, PaymentPathRequest } from './types.js';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

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

function parseRecommendationInput(args: Record<string, unknown>): { transaction: ReturnType<typeof validateRecommendationTransaction>; options: { cardIds?: readonly string[]; context?: ReturnType<typeof validateContext> } } {
  let transaction = validateRecommendationTransaction(args.transaction);
  if (args.merchant !== undefined) {
    if (!args.merchant || typeof args.merchant !== 'object' || Array.isArray(args.merchant)) throw new RewardServiceError('INVALID_INPUT', 'merchant must be an object');
    const merchant = args.merchant as Record<string, unknown>;
    for (const key of Object.keys(merchant)) if (!['canonicalId', 'canonicalNameZhHant', 'rawStatement', 'market', 'country'].includes(key)) throw new RewardServiceError('UNKNOWN_FIELD', `recommend.merchant contains unsupported field: ${key}`);
    for (const key of ['canonicalId', 'canonicalNameZhHant', 'rawStatement', 'market', 'country']) if (merchant[key] !== undefined && (typeof merchant[key] !== 'string' || !merchant[key].trim())) throw new RewardServiceError('INVALID_INPUT', `recommend.merchant.${key} must be a non-empty string`);
    if (transaction.merchant === undefined && typeof merchant.rawStatement === 'string') transaction = { ...transaction, merchant: merchant.rawStatement };
    if (transaction.country === undefined && typeof merchant.country === 'string') transaction = { ...transaction, country: merchant.country };
  }
  let cardIds: string[] | undefined;
  if (args.cardIds !== undefined) {
    if (!Array.isArray(args.cardIds) || args.cardIds.length > 128) throw new RewardServiceError('INVALID_INPUT', 'recommend.cardIds must be an array with at most 128 items');
    cardIds = args.cardIds.map((value, index) => {
      if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_:-]{0,127}$/.test(value)) throw new RewardServiceError('INVALID_INPUT', `recommend.cardIds[${index}] is invalid`);
      return value;
    });
  }
  const context = args.context === undefined ? undefined : validateContext(args.context);
  return { transaction, options: { ...(cardIds === undefined ? {} : { cardIds }), ...(context === undefined ? {} : { context }) } };
}

async function processJsonRpc(service: RewardService, request: JsonRpc): Promise<Reply> {
  try {
    if (request.method === 'initialize') return { jsonrpc: '2.0', id: request.id ?? null, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'taiwan_card_rewards_mcp', version: packageJson.version }, instructions: mcpInstructions } };
    if (request.method === 'tools/list') return { jsonrpc: '2.0', id: request.id ?? null, result: { tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) } };
    if (request.method === 'tools/call') return { jsonrpc: '2.0', id: request.id ?? null, result: toolResult(await callTool(service, request.params ?? {})) };
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32601, message: `Method not found: ${request.method ?? ''}` } };
  } catch (error) {
    const code = error instanceof RewardServiceError || error instanceof StartupContractError ? error.code : error instanceof ProjectionTooLargeError ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
    const data = error instanceof RewardServiceError && error.details !== undefined ? { code, details: error.details } : { code };
    return { jsonrpc: '2.0', id: request.id ?? null, error: { code: -32000, message: code, data } };
  }
}

async function runOwner(config: StartupConfig): Promise<void> {
  const store: LedgerStore = new FileStore(config);
  const service = new RewardService(store, config.user);
  const owner = new SharedMcpOwner({ dataDir: config.dataDir, handler: async (request) => {
    const response = await processJsonRpc(service, request as JsonRpc);
    return { id: response.id, ...(response.result === undefined ? {} : { result: response.result }), ...(response.error === undefined ? {} : { error: response.error }) };
  } });
  const close = async () => { await owner.close(); store.close(); process.exit(0); };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  await owner.listen();
  await new Promise<void>(() => { /* owner lifetime is controlled by SIGINT/SIGTERM */ });
}

async function runBridge(config: StartupConfig): Promise<void> {
  const client = await connectSharedBridge({ dataDir: config.dataDir, spawnOwner: async () => {
    const args = [process.argv[1]!, '--data-dir', config.dataDir, ...(config.user ? ['--user', config.user] : []), '--shared-owner'];
    const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } });
  await runStdioBridge({ input: process.stdin, output: process.stdout, client });
}

async function main(): Promise<void> {
  const config = parseStartupArgs(process.argv.slice(2));
  if (config.mode === 'shared-owner') { await runOwner(config); return; }
  if (config.mode === 'shared-bridge') { await runBridge(config); return; }
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
    const response = await processJsonRpc(service, request);
    process.stdout.write(`${JSON.stringify(response)}\n`);
  }
  store.close();
}

async function callTool(service: RewardService, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  if (typeof name !== 'string') throw new RewardServiceError('INVALID_INPUT', 'tool name is required');
  const rawArgs = params.arguments ?? {};
  rejectSensitiveFields(rawArgs);
  const args = validateToolArgs(name, rawArgs);
  if (name === 'recommend' && args.kind !== undefined) {
    if (args.kind !== 'payment_path' || !args.payment_path || typeof args.payment_path !== 'object' || Array.isArray(args.payment_path) || args.transaction !== undefined) throw new RewardServiceError('INVALID_INPUT', 'recommend requires exactly one card or payment_path branch');
    const allowedPath = ['amount', 'merchant', 'mcc', 'country', 'channel', 'paymentMethod', 'asOf', 'routeIds', 'limit', 'maxHops', 'maxEvents', 'maxBranchesPerNode'];
    for (const key of Object.keys(args.payment_path as object)) if (!allowedPath.includes(key)) throw new RewardServiceError('UNKNOWN_FIELD', `recommend.payment_path contains unsupported field: ${key}`);
  }
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
    case 'upsert_offer': return service.upsertOffer(validateSnapshot(args.snapshot), validateRule(args.rule), args.confirmation !== undefined ? validateConfirmation(args.confirmation) : undefined, args.capPools === undefined ? undefined : (Array.isArray(args.capPools) ? args.capPools.map(validateCapPool) : []), args.merchant as any);
    case 'recommend': {
      if (args.kind === 'payment_path' && args.payment_path && typeof args.payment_path === 'object') {
        const body = args.payment_path as Record<string, unknown>;
        return service.recommendPaymentPaths({ amount: body.amount as PaymentPathRequest['amount'], ...(typeof body.merchant === 'string' ? { merchant: body.merchant } : {}), ...(typeof body.mcc === 'string' ? { mcc: body.mcc } : {}), ...(typeof body.country === 'string' ? { country: body.country } : {}), ...(typeof body.channel === 'string' ? { channel: body.channel } : {}), ...(typeof body.paymentMethod === 'string' ? { paymentMethod: body.paymentMethod } : {}), ...(typeof body.asOf === 'string' ? { asOf: body.asOf } : {}), ...(Array.isArray(body.routeIds) ? { routeIds: body.routeIds as string[] } : {}), ...(typeof body.limit === 'number' ? { limit: body.limit } : {}), ...(typeof body.maxHops === 'number' ? { maxHops: body.maxHops } : {}), ...(typeof body.maxEvents === 'number' ? { maxEvents: body.maxEvents } : {}), ...(typeof body.maxBranchesPerNode === 'number' ? { maxBranchesPerNode: body.maxBranchesPerNode } : {}) });
      }
      const recommendation = parseRecommendationInput(args); const hasPage = args.page !== undefined; const rows = service.recommend(recommendation.transaction, hasPage ? 20 : (typeof args.limit === 'number' ? args.limit : 10), recommendation.options); return hasPage ? paged(rows, undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as RankingEntry).cardId)) : rows;
    }
    case 'recommendation_preflight': return service.preflightRecommendation(validateRecommendationTransaction(args.transaction), { ...(args.context === undefined ? {} : { context: validateContext(args.context) }) });
    case 'upsert_payment_route': return service.upsertPaymentRoute(args.route);
    case 'list_payment_routes': { const rows = [...service.listPaymentRoutes()]; return (args.limit !== undefined || args.page !== undefined || args.projection !== undefined) ? paged(rows, typeof args.projection === 'string' ? args.projection : undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as { id: string }).id)) : rows; }
    case 'register_payment_account': return service.upsertPaymentAccount(args.account);
    case 'list_payment_accounts': { const rows = [...service.listPaymentAccounts()]; return (args.limit !== undefined || args.page !== undefined || args.projection !== undefined) ? paged(rows, typeof args.projection === 'string' ? args.projection : undefined, typeof args.page === 'number' ? args.page : undefined, typeof args.limit === 'number' ? args.limit : undefined, (item) => String((item as { id: string }).id)) : rows; }
    case 'recommend_payment_paths_v1': return service.recommendPaymentPaths({ amount: args.amount as PaymentPathRequest['amount'], ...(typeof args.merchant === 'string' ? { merchant: args.merchant } : {}), ...(typeof args.mcc === 'string' ? { mcc: args.mcc } : {}), ...(typeof args.country === 'string' ? { country: args.country } : {}), ...(typeof args.channel === 'string' ? { channel: args.channel } : {}), ...(typeof args.paymentMethod === 'string' ? { paymentMethod: args.paymentMethod } : {}), ...(typeof args.asOf === 'string' ? { asOf: args.asOf } : {}), ...(Array.isArray(args.routeIds) ? { routeIds: args.routeIds as string[] } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(Array.isArray(args.eligibilityFacts) ? { eligibilityFacts: args.eligibilityFacts as PaymentPathRequest['eligibilityFacts'] } : {}) });
    case 'record_transaction': return service.recordTransaction(validateTransaction(args.transaction));
    case 'record_event_reward':
    case 'record_event_reward_v2': return service.recordValidatedEventReward(args);
    case 'record_event_reward_v1': throw new RewardServiceError('MIGRATION_REQUIRED', 'record_event_reward_v1 cannot be safely converted without an event rule; call record_event_reward with exactly one rule or chainRule');
    case 'reverse_event_reward':
    case 'reverse_event_reward_v1': return service.reverseEventReward(args);
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
    case 'search_active_offers': return service.searchActiveOffers({ ...(typeof args.rawQuery === 'string' ? { rawQuery: args.rawQuery } : {}), ...(typeof args.cardId === 'string' ? { cardId: args.cardId } : {}), ...(typeof args.canonicalMerchantId === 'string' ? { canonicalMerchantId: args.canonicalMerchantId } : {}), ...(typeof args.country === 'string' ? { country: args.country } : {}), ...(typeof args.market === 'string' ? { market: args.market } : {}), ...(typeof args.mcc === 'string' ? { mcc: args.mcc } : {}), ...(typeof args.channel === 'string' ? { channel: args.channel } : {}), ...(typeof args.asOf === 'string' ? { asOf: args.asOf } : {}), ...(typeof args.limit === 'number' ? { limit: args.limit } : {}), ...(typeof args.page === 'number' ? { page: args.page } : {}) });
    case 'calculate_reward': return evaluateOffer(validateRule(args.rule), validateTransaction(args.transaction), validateContext(args.context));
    case 'rank_cards': {
      if (!Array.isArray(args.cards) || !Array.isArray(args.rules)) throw new RewardServiceError('INVALID_INPUT', 'cards and rules must be arrays');
      return rankCards(args.cards.map(validateCard), args.rules.map(validateRule), validateTransaction(args.transaction), validateContext(args.context), 5);
    }
    default: throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
