import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import * as readline from 'node:readline';
import { describe, expect, it } from 'vitest';

function call(dataDir: string, name: string, args: Record<string, unknown>): Promise<any> {
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, [resolve(__dirname, '../dist/cli.js'), '--data-dir', dataDir, '--user', 'u1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
    let result: unknown;
    const timeout = setTimeout(() => { child.kill(); reject(new Error('MCP response timed out')); }, 5000);
    lines.on('line', line => { try { const response = JSON.parse(line); if (response.id === 1) { result = response; lines.close(); child.stdin!.end(); } } catch { /* diagnostic */ } });
    child.on('error', reject);
    child.on('close', code => { clearTimeout(timeout); result !== undefined && code === 0 ? resolveCall(result) : reject(new Error(`MCP exited ${code}`)); });
    child.stdin!.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })}\n`);
  });
}

describe('intent preflight compatibility', () => {
  it('delegates intent-shaped public calls to the recommend decision engine', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'recovery-preflight-'));
    try {
      const intent = { merchant: 'Shop', amount: { amountMinor: 1000, currency: 'TWD' }, occurredAt: '2026-09-10T00:00:00Z' };
      const recommend = await call(dataDir, 'recommend', intent);
      const preflight = await call(dataDir, 'recommendation_preflight', intent);
      expect(preflight.error).toBeUndefined();
      expect(preflight.result.structuredContent).toEqual(recommend.result.structuredContent);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
