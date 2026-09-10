import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SharedMcpClient, SharedMcpError, SharedMcpOwner, sharedEndpoint, SHARED_MCP_PROTOCOL } from '../src/index.js';

describe('shared MCP owner and stdio-bridge transport seam', () => {
  it('forwards initialize/read requests through one owner and preserves per-client session ids', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mcp-'));
    const owner = new SharedMcpOwner({ dataDir: dir, handler: (request) => ({ id: request.id, result: { method: request.method, session: request.params } }) });
    const first = new SharedMcpClient(dir); const second = new SharedMcpClient(dir);
    try {
      await owner.listen();
      const metadata = await first.connect();
      await second.connect();
      expect(metadata.protocol).toBe(SHARED_MCP_PROTOCOL);
      expect(metadata.dataDirFingerprint).toHaveLength(64);
      const a = await first.request('initialize', { session: 'a' });
      const b = await second.request('list_cards', { session: 'b' });
      expect(a.result).toEqual({ method: 'initialize', session: { session: 'a' } });
      expect(b.result).toEqual({ method: 'list_cards', session: { session: 'b' } });
    } finally { first.close(); second.close(); await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('allows only one owner and refuses attaching a different data directory', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mcp-owner-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mcp-other-'));
    const owner = new SharedMcpOwner({ dataDir: dir, handler: (request) => ({ id: request.id, result: true }) });
    const duplicate = new SharedMcpOwner({ dataDir: dir, handler: (request) => ({ id: request.id, result: false }) });
    try { await owner.listen(); await expect(duplicate.listen()).rejects.toMatchObject({ code: 'OWNER_EXISTS' }); await expect(new SharedMcpClient(other).connect()).rejects.toMatchObject({ code: 'ENDPOINT_UNAVAILABLE' }); }
    finally { await owner.close(); await duplicate.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); fs.rmSync(other, { recursive: true, force: true }); }
  });

  it('recovers a stale endpoint only when the recorded pid is dead', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mcp-stale-'));
    const endpoint = sharedEndpoint(dir);
    fs.mkdirSync(endpoint.directory, { recursive: true });
    fs.writeFileSync(endpoint.metadataPath, JSON.stringify({ protocol: SHARED_MCP_PROTOCOL, pid: 2147483647, dataDirFingerprint: 'wrong', startedAt: 'yesterday', socketPath: endpoint.socketPath }));
    const owner = new SharedMcpOwner({ dataDir: dir, handler: (request) => ({ id: request.id, result: 'recovered' }) });
    const client = new SharedMcpClient(dir);
    try { await owner.listen(); await client.connect(); await expect(client.request('read')).resolves.toMatchObject({ result: 'recovered' }); }
    finally { client.close(); await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns a bounded queue error instead of growing memory without limit', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shared-mcp-queue-'));
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const owner = new SharedMcpOwner({ dataDir: dir, maxQueue: 1, handler: async (request) => { await blocked; return { id: request.id, result: true }; } });
    const client = new SharedMcpClient(dir);
    try { await owner.listen(); await client.connect(); const first = client.request('mutation'); const second = await client.request('mutation'); expect(second.error?.message).toBe('QUEUE_FULL'); release(); await first; }
    finally { client.close(); await owner.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
});
