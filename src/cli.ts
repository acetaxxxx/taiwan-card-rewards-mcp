#!/usr/bin/env node
import * as readline from 'node:readline';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { getHelpText, parseStartupArgs, StartupContractError } from './startup.js';
import type { StartupConfig } from './startup.js';
import { FileStore, type LedgerStore } from './store.js';
import { RewardService } from './service.js';
import { mcpInstructions, mcpTools } from './mcp-contract.js';
import { SharedMcpClient, SharedMcpOwner, connectSharedBridge } from './shared-mcp.js';
import type { SharedRpcResponse } from './shared-mcp.js';
import { runStdioBridge } from './shared-cli.js';
import { callMcpTool } from './mcp-dispatch.js';
import { getMcpErrorData } from './mcp-errors.js';

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
async function processJsonRpc(service: RewardService, request: JsonRpc): Promise<Reply> {
  try {
    if (request.method === 'initialize') return successReply(request.id, initializeResult());
    if (request.method === 'tools/list') return successReply(request.id, toolListResult());
    if (request.method === 'tools/call') return successReply(request.id, toolResult(await callMcpTool(service, request.params ?? {})));
    return errorReply(request.id, -32601, `Method not found: ${request.method ?? ''}`);
  } catch (error) {
    const data = getMcpErrorData(error);
    return errorReply(request.id, -32000, data.code, data);
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
  if (config.help) {
    process.stdout.write(`${getHelpText()}\n`);
    return;
  }
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


main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : 'startup failed'}\n`); process.exitCode = 1; });
