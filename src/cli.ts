#!/usr/bin/env node
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseStartupArgs, StartupContractError } from './startup.js';
import type { StartupConfig } from './startup.js';
import { FileStore, contentHash, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { RewardServiceError } from './errors.js';
import { mcpInstructions, mcpTools, normalizeMcpToolArguments } from './mcp-contract.js';
import { evaluateOffer } from './evaluator.js';
import { validateUserBenefitInput, validateContext, validateToolArgs, validateTransaction, validateCard, validateCapPool, validateConfirmation, validateRule, validateSnapshot } from './validation.js';
import { projectPage, ProjectionInputError, ProjectionTooLargeError } from './projections.js';
import { SharedMcpClient, SharedMcpOwner, connectSharedBridge } from './shared-mcp.js';
import type { SharedRpcResponse } from './shared-mcp.js';
import { runStdioBridge } from './shared-cli.js';
import type { CardDescriptor } from './types.js';

const packageJson = createRequire(import.meta.url)('../package.json') as { version: string };

type JsonRpcId = string | number | null;
type JsonRpc = { jsonrpc?: string; id?: JsonRpcId; method?: string; params?: Record<string, unknown> };
type Reply = { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } };

function responseId(id: JsonRpc['id']): JsonRpcId { return id ?? null; }
function successReply(id: JsonRpc['id'], result: unknown): Reply { return { jsonrpc: '2.0', id: responseId(id), result }; }
function errorReply(id: JsonRpc['id'], code: number, message: string, data?: unknown): Reply {
  const error: NonNullable<Reply['error']> = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id: responseId(id), error };
}
function writeReply(response: Reply): void { process.stdout.write(`${JSON.stringify(response)}\n`); }
function reply(id: JsonRpc['id'], result: unknown): void { writeReply(successReply(id, result)); }
function failure(id: JsonRpc['id'], code: number, message: string, data?: unknown): void { writeReply(errorReply(id, code, message, data)); }
function toolResult(value: unknown): { content: readonly { type: 'text'; text: string }[]; structuredContent: unknown } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value };
}
function initializeResult(): Record<string, unknown> {
  return {
    protocolVersion: '2024-11-05',
    capabilities: { tools: {} },
    serverInfo: { name: 'taiwan_card_rewards_mcp', version: packageJson.version },
    instructions: mcpInstructions,
  };
}
function toolListResult(): { tools: readonly { name: string; description: string; inputSchema: Record<string, unknown> }[] } {
  return { tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) };
}
function sharedResponse(response: Reply): SharedRpcResponse {
  const result: SharedRpcResponse = { id: response.id };
  if (response.result !== undefined) result.result = response.result;
  if (response.error !== undefined) result.error = { code: response.error.code, message: response.error.message };
  return result;
}
type MerchantResolutionFacts = Parameters<RewardService['resolveMerchant']>[1];
type ActiveOfferSearch = Parameters<RewardService['searchActiveOffers']>[0];

function merchantResolutionFacts(args: Record<string, unknown>): MerchantResolutionFacts {
  const facts: MerchantResolutionFacts = {};
  for (const field of ['country', 'market', 'mcc', 'channel'] as const) {
    if (typeof args[field] === 'string') facts[field] = args[field];
  }
  return facts;
}

function activeOfferSearch(args: Record<string, unknown>): ActiveOfferSearch {
  const search: ActiveOfferSearch = {};
  for (const field of ['rawQuery', 'cardId', 'canonicalMerchantId', 'country', 'market', 'mcc', 'channel', 'asOf'] as const) {
    if (typeof args[field] === 'string') search[field] = args[field];
  }
  for (const field of ['limit', 'page'] as const) {
    if (typeof args[field] === 'number') search[field] = args[field];
  }
  return search;
}
async function processJsonRpc(service: RewardService, request: JsonRpc): Promise<Reply> {
  try {
    if (request.method === 'initialize') return successReply(request.id, initializeResult());
    if (request.method === 'tools/list') return successReply(request.id, toolListResult());
    if (request.method === 'tools/call') return successReply(request.id, toolResult(await callTool(service, request.params ?? {})));
    return errorReply(request.id, -32601, `Method not found: ${request.method ?? ''}`);
  } catch (error) {
    const code = error instanceof RewardServiceError || error instanceof StartupContractError ? error.code : error instanceof ProjectionInputError ? error.code : error instanceof ProjectionTooLargeError ? 'PAYLOAD_TOO_LARGE' : 'INTERNAL_ERROR';
    const data = error instanceof RewardServiceError && error.details !== undefined ? { code, details: error.details } : { code };
    return errorReply(request.id, -32000, code, data);
  }
}

async function runOwner(config: StartupConfig): Promise<void> {
  const store: LedgerStore = new FileStore(config);
  const service = new RewardService(store, config.user);
  const owner = new SharedMcpOwner({ dataDir: config.dataDir, handler: async (request) => {
    const response = await processJsonRpc(service, request as JsonRpc);
    return sharedResponse(response);
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
    writeReply(response);
  }
  store.close();
}

async function callTool(service: RewardService, params: Record<string, unknown>): Promise<unknown> {
  const name = params.name;
  if (typeof name !== 'string') throw new RewardServiceError('INVALID_INPUT', 'tool name is required');
  const rawArgs = params.arguments ?? {};
  const args = validateToolArgs(name, normalizeMcpToolArguments(name, rawArgs));
  const maybePaged = (value: unknown[], sortKey: (item: unknown) => string, maxItems = 20): unknown => {
    if (args.limit === undefined && args.page === undefined && args.projection === undefined) return value;
    const projection = typeof args.projection === 'string' ? args.projection : undefined;
    if (projection !== undefined && !['summary', 'detail', 'calculation', 'audit'].includes(projection)) throw new RewardServiceError('INVALID_INPUT', 'projection is invalid');
    const projected = projection === 'summary' ? value.map((item) => {
      if (!item || typeof item !== 'object') return item;
      const record = item as Record<string, unknown>;
      return { id: record.id, ...(record.issuer ? { issuer: record.issuer } : {}), ...(record.productName ? { productName: record.productName } : {}), ...(record.ruleId ? { ruleId: record.ruleId } : {}), ...(record.usageKey ? { usageKey: record.usageKey } : {}), ...(record.remaining ? { remaining: record.remaining } : {}) };
    }) : value;
    const effectivePage = typeof args.page === 'number' ? args.page : 1;
    const effectiveLimit = typeof args.limit === 'number' ? args.limit : 10;
    return projectPage(projected, { page: effectivePage, limit: effectiveLimit, maxItems, maxBytes: 256 * 1024, evaluatedAt: new Date().toISOString(), dataVersion: contentHash(JSON.stringify(projected)).slice(0, 16), sortKey });
  };
  switch (name) {
    case 'create_ingestion': return service.createIngestion(args);
    case 'get_ingestion': return service.inspectIngestion(String(args.flowId));
    case 'submit_ingestion_source': return service.submitIngestionSource(args);
    case 'submit_ingestion_manifest': return service.submitIngestionManifest(args);
    case 'submit_benefit_leaf': return service.submitBenefitLeaf(args);
    case 'register_card': return service.registerCard(validateCard(args.card));
    case 'list_cards': return maybePaged(service.listCards(), (item) => String((item as CardDescriptor).id), 50);
    case 'upsert_offer': return service.upsertOffer(validateSnapshot(args.snapshot), validateRule(args.rule), args.confirmation !== undefined ? validateConfirmation(args.confirmation) : undefined, args.capPools === undefined ? undefined : (Array.isArray(args.capPools) ? args.capPools.map(validateCapPool) : []), args.merchant as any);
    case 'recommend': return service.recommendIntent(args);
    case 'upsert_payment_route': return service.upsertPaymentRoute(args.route);
    case 'list_payment_routes': return maybePaged([...service.listPaymentRoutes()], (item) => String((item as { id: string }).id), 50);
    case 'upsert_payment_capability': return service.upsertPaymentCapability(args.capability);
    case 'list_payment_capabilities': return service.listPaymentCapabilities();
    case 'register_payment_account': return service.upsertPaymentAccount(args.account);
    case 'list_payment_accounts': return maybePaged([...service.listPaymentAccounts()], (item) => String((item as { id: string }).id), 50);
    case 'record_transaction': return service.recordTransaction(validateTransaction(args.transaction));
    case 'list_transactions': return service.listTransactions(args);
    case 'record_event_reward': return service.recordValidatedEventReward(args);
    case 'reverse_event_reward': return service.reverseEventReward(args);
    case 'remaining_caps': return maybePaged(service.remainingCaps(String(args.cardId), typeof args.asOf === 'string' ? args.asOf : undefined), (item) => String((item as { usageKey: string }).usageKey));
    case 'get_user_benefit_status': {
      const kind = args.kind;
      if (kind !== 'card_switch' && kind !== 'campaign_registration') throw new RewardServiceError('INVALID_INPUT', 'kind is invalid');
      return service.getUserBenefitStatus(kind, String(args.cardId), typeof args.asOfUtc === 'string' ? args.asOfUtc : undefined);
    }
    case 'upsert_user_benefit_status': return service.upsertUserBenefitStatus(validateUserBenefitInput(args.input));
    case 'resolve_merchant': {
      if (typeof args.rawQuery !== 'string') throw new RewardServiceError('INVALID_INPUT', 'rawQuery is required');
      return service.resolveMerchant(args.rawQuery, merchantResolutionFacts(args));
    }
    case 'search_active_offers': return service.searchActiveOffers(activeOfferSearch(args));
    case 'calculate_reward': return evaluateOffer(validateRule(args.rule), validateTransaction(args.transaction), validateContext(args.context));
    default: throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
