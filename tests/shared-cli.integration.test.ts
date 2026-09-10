import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

type Rpc = { jsonrpc: string; id: number; result?: any; error?: any };

function bridge(dataDir: string): { process: ChildProcess; send: (method: string, params?: unknown) => Promise<Rpc>; close: () => Promise<void> } {
  const child = spawn(process.execPath, [resolve('dist/cli.js'), '--data-dir', dataDir, '--user', 'integration-user', '--shared-bridge'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
  let nextId = 0;
  const pending = new Map<number, (response: Rpc) => void>();
  lines.on('line', (line) => { const response = JSON.parse(line) as Rpc; pending.get(response.id)?.(response); pending.delete(response.id); });
  const send = (method: string, params?: unknown) => new Promise<Rpc>((resolveResponse) => { const id = ++nextId; pending.set(id, resolveResponse); child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n'); });
  const close = () => new Promise<void>((resolveClose) => { child.once('close', () => resolveClose()); child.stdin!.end(); });
  return { process: child, send, close };
}

describe('shared CLI owner/bridge integration', () => {
  it('auto-spawns one owner and two bridges share reads and mutations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shared-cli-'));
    const first = bridge(dir); const second = bridge(dir);
    let ownerPid: number | undefined;
    try {
      expect((await first.send('initialize')).result.serverInfo.name).toBe('taiwan_card_rewards_mcp');
      expect((await second.send('tools/list')).result.tools.length).toBeGreaterThan(0);
      const write = await first.send('tools/call', { name: 'register_card', arguments: { card: { id: 'shared-card', issuer: 'Bank', productName: 'Shared' } } });
      expect(write.error).toBeUndefined();
      const read = await second.send('tools/call', { name: 'list_cards', arguments: {} });
      expect(JSON.stringify(read.result)).toContain('shared-card');
      ownerPid = JSON.parse(readFileSync(join(dir, '.mcp/owner.metadata.json'), 'utf8')).pid as number;
    } finally {
      await first.close(); await second.close();
      if (ownerPid) { try { process.kill(ownerPid, 'SIGTERM'); } catch {} }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  it('keeps different data directories isolated', async () => {
    const left = mkdtempSync(join(tmpdir(), 'shared-left-')); const right = mkdtempSync(join(tmpdir(), 'shared-right-'));
    const a = bridge(left); const b = bridge(right);
    const owners: number[] = [];
    try {
      await a.send('tools/call', { name: 'register_card', arguments: { card: { id: 'left-card', issuer: 'Bank', productName: 'Left' } } });
      const read = await b.send('tools/call', { name: 'list_cards', arguments: {} });
      expect(JSON.stringify(read.result)).not.toContain('left-card');
      for (const dir of [left, right]) { try { owners.push(JSON.parse(readFileSync(join(dir, '.mcp/owner.metadata.json'), 'utf8')).pid as number); } catch {} }
    } finally { await a.close(); await b.close(); for (const pid of owners) { try { process.kill(pid, 'SIGTERM'); } catch {} } rmSync(left, { recursive: true, force: true }); rmSync(right, { recursive: true, force: true }); }
  }, 20_000);
});
