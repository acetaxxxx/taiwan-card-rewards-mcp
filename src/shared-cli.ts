import * as readline from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import { SharedMcpClient, type SharedRpcRequest, type SharedRpcResponse } from './shared-mcp.js';

export type StdioBridgeOptions = { input: Readable; output: Writable; client: SharedMcpClient };

/** Adapts one MCP stdio session to a shared owner while leaving request ids untouched. */
export async function runStdioBridge(options: StdioBridgeOptions): Promise<void> {
  const input = readline.createInterface({ input: options.input, crlfDelay: Infinity });
  try {
    for await (const line of input) {
      if (!line.trim()) continue;
      let request: SharedRpcRequest;
      try { request = JSON.parse(line) as SharedRpcRequest; } catch { options.output.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      if (request.method.startsWith('notifications/')) continue;
      const response: SharedRpcResponse = await options.client.request(request.method, request.params, request.id);
      options.output.write(JSON.stringify({ jsonrpc: '2.0', id: response.id, ...(response.result === undefined ? {} : { result: response.result }), ...(response.error === undefined ? {} : { error: response.error }) }) + '\n');
    }
  } finally { input.close(); options.client.close(); }
}
