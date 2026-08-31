#!/usr/bin/env node
import * as readline from 'node:readline';
import { parseStartupArgs, StartupContractError } from './startup.js';
import { FileStore, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { RewardServiceError } from './errors.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { evaluateOffer, rankCards } from './evaluator.js';
import { validateContext, validateToolArgs, validateTransaction, validateCard, validateConfirmation, validateRule, validateSnapshot } from './validation.js';

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
      if (request.method === 'initialize') reply(request.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'taiwan-card-rewards-mcp', version: '0.2.0' }, instructions: mcpInstructions });
      else if (request.method === 'tools/list') reply(request.id, { tools: mcpTools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })) });
      else if (request.method === 'tools/call') reply(request.id, toolResult(await callTool(service, request.params ?? {})));
      else failure(request.id, -32601, `Method not found: ${request.method ?? ''}`);
    } catch (error) {
      const code = error instanceof RewardServiceError || error instanceof StartupContractError ? error.code : 'INTERNAL_ERROR';
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
  switch (name) {
    case 'register_card': return service.registerCard(validateCard(args.card));
    case 'list_cards': return service.listCards();
    case 'upsert_offer': return service.upsertOffer(validateSnapshot(args.snapshot), validateRule(args.rule), args.confirmation !== undefined ? validateConfirmation(args.confirmation) : undefined);
    case 'recommend': return service.recommend(validateTransaction(args.transaction), typeof args.limit === 'number' ? args.limit : 5);
    case 'record_transaction': return service.recordTransaction(validateTransaction(args.transaction));
    case 'remaining_caps': return service.remainingCaps(String(args.cardId));
    case 'calculate_reward': return evaluateOffer(validateRule(args.rule), validateTransaction(args.transaction), validateContext(args.context));
    case 'rank_cards': {
      if (!Array.isArray(args.cards) || !Array.isArray(args.rules)) throw new RewardServiceError('INVALID_INPUT', 'cards and rules must be arrays');
      return rankCards(args.cards.map(validateCard), args.rules.map(validateRule), validateTransaction(args.transaction), validateContext(args.context), 5);
    }
    default: throw new RewardServiceError('TOOL_NOT_FOUND', `unknown tool: ${name}`);
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
