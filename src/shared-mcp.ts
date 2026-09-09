import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';

export const SHARED_MCP_PROTOCOL = 'taiwan_card_rewards_mcp.shared.v1';
const MAX_QUEUE = 64;
const MAX_LINE_BYTES = 256 * 1024;

export type SharedRpcRequest = { id: string | number | null; method: string; params?: unknown };
export type SharedRpcResponse = { id: string | number | null; result?: unknown; error?: { code: number; message: string } };

export type SharedBridgeInput = { dataDir: string; spawnOwner: () => void | Promise<void>; attempts?: number; delayMs?: number };

export async function connectSharedBridge(options: SharedBridgeInput): Promise<SharedMcpClient> {
  const client = new SharedMcpClient(options.dataDir);
  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 50;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await client.connect(); return client; } catch (error) {
      if (!(error instanceof SharedMcpError) || (error.code !== 'ENDPOINT_UNAVAILABLE' && error.code !== 'HANDSHAKE_FAILED')) throw error;
      if (attempt === 0) await options.spawnOwner();
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw new SharedMcpError('ENDPOINT_UNAVAILABLE', 'owner did not become available');
}

export type OwnerMetadata = {
  protocol: typeof SHARED_MCP_PROTOCOL;
  pid: number;
  dataDirFingerprint: string;
  startedAt: string;
  socketPath: string;
};

export class SharedMcpError extends Error {
  constructor(public readonly code: 'OWNER_EXISTS' | 'HANDSHAKE_FAILED' | 'QUEUE_FULL' | 'ENDPOINT_UNAVAILABLE', message: string) {
    super(`${code}: ${message}`);
    this.name = 'SharedMcpError';
  }
}

export function sharedEndpoint(dataDir: string): { directory: string; socketPath: string; metadataPath: string } {
  const directory = path.join(dataDir, '.mcp');
  return { directory, socketPath: path.join(directory, 'owner.sock'), metadataPath: path.join(directory, 'owner.metadata.json') };
}

function fingerprint(dataDir: string): string {
  return crypto.createHash('sha256').update(path.resolve(dataDir)).digest('hex');
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) {
    return !(error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH');
  }
}

function writePrivate(file: string, body: string): void {
  fs.writeFileSync(file, body, { encoding: 'utf8', mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch { /* Windows */ }
}

export type SharedOwnerOptions = {
  dataDir: string;
  handler: (request: SharedRpcRequest) => Promise<SharedRpcResponse> | SharedRpcResponse;
  maxQueue?: number;
};

/** Local-only owner endpoint. The caller owns the durable store and supplies the RPC handler. */
export class SharedMcpOwner {
  readonly endpoint: ReturnType<typeof sharedEndpoint>;
  readonly metadata: OwnerMetadata;
  private readonly server: net.Server;
  private readonly maxQueue: number;
  private queueDepth = 0;
  private closed = false;

  constructor(private readonly options: SharedOwnerOptions) {
    this.endpoint = sharedEndpoint(options.dataDir);
    this.maxQueue = options.maxQueue ?? MAX_QUEUE;
    this.metadata = { protocol: SHARED_MCP_PROTOCOL, pid: process.pid, dataDirFingerprint: fingerprint(options.dataDir), startedAt: new Date().toISOString(), socketPath: this.endpoint.socketPath };
    this.server = net.createServer((socket) => this.handleSocket(socket));
  }

  async listen(): Promise<void> {
    fs.mkdirSync(this.endpoint.directory, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(this.endpoint.directory, 0o700); } catch { /* Windows */ }
    if (fs.existsSync(this.endpoint.metadataPath)) {
      try {
        const old = JSON.parse(fs.readFileSync(this.endpoint.metadataPath, 'utf8')) as Partial<OwnerMetadata>;
        if (old.pid && processIsAlive(old.pid)) throw new SharedMcpError('OWNER_EXISTS', 'an owner process is alive');
      } catch (error) {
        if (error instanceof SharedMcpError) throw error;
      }
      fs.rmSync(this.endpoint.metadataPath, { force: true });
    }
    if (fs.existsSync(this.endpoint.socketPath)) {
      try { fs.unlinkSync(this.endpoint.socketPath); } catch { throw new SharedMcpError('OWNER_EXISTS', 'owner endpoint is not removable'); }
    }
    writePrivate(this.endpoint.metadataPath, JSON.stringify(this.metadata));
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { this.server.off('listening', onListen); reject(error); };
      const onListen = () => { this.server.off('error', onError); resolve(); };
      this.server.once('error', onError);
      this.server.once('listening', onListen);
      this.server.listen(this.endpoint.socketPath);
    });
    try { fs.chmodSync(this.endpoint.socketPath, 0o600); } catch { /* Windows */ }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
    try { fs.rmSync(this.endpoint.socketPath, { force: true }); } catch {}
    try { fs.rmSync(this.endpoint.metadataPath, { force: true }); } catch {}
  }

  private handleSocket(socket: net.Socket): void {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) { socket.destroy(); return; }
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) return;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let request: SharedRpcRequest;
        try { request = JSON.parse(line) as SharedRpcRequest; } catch { socket.destroy(); return; }
        if (this.queueDepth >= this.maxQueue) {
          socket.write(JSON.stringify({ id: request.id ?? null, error: { code: -32001, message: 'QUEUE_FULL' } }) + '\n');
          continue;
        }
        this.queueDepth += 1;
        Promise.resolve(this.options.handler(request)).catch(() => ({ id: request.id ?? null, error: { code: -32000, message: 'INTERNAL_ERROR' } })).then((response) => {
          this.queueDepth -= 1;
          if (!socket.destroyed) socket.write(JSON.stringify(response) + '\n');
        });
      }
    });
  }
}

export class SharedMcpClient {
  private socket: net.Socket | undefined;
  private buffer = '';
  private readonly pending = new Map<string | number, { id: string | number | null; resolve: (response: SharedRpcResponse) => void; reject: (error: Error) => void }>();
  private sequence = 0;

  constructor(private readonly dataDir: string) {}

  async connect(): Promise<OwnerMetadata> {
    const endpoint = sharedEndpoint(this.dataDir);
    let metadata: OwnerMetadata;
    try { metadata = JSON.parse(fs.readFileSync(endpoint.metadataPath, 'utf8')) as OwnerMetadata; } catch { throw new SharedMcpError('ENDPOINT_UNAVAILABLE', 'owner metadata is unavailable'); }
    if (metadata.protocol !== SHARED_MCP_PROTOCOL || metadata.dataDirFingerprint !== fingerprint(this.dataDir) || !processIsAlive(metadata.pid)) throw new SharedMcpError('HANDSHAKE_FAILED', 'owner metadata handshake failed');
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.createConnection(endpoint.socketPath);
      candidate.once('connect', () => resolve(candidate));
      candidate.once('error', () => reject(new SharedMcpError('ENDPOINT_UNAVAILABLE', 'owner socket is unavailable')));
    });
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.receive(chunk));
    socket.on('close', () => { for (const pending of this.pending.values()) pending.reject(new SharedMcpError('ENDPOINT_UNAVAILABLE', 'owner disconnected')); this.pending.clear(); });
    return metadata;
  }

  request(method: string, params?: unknown, requestId?: string | number | null): Promise<SharedRpcResponse> {
    if (!this.socket || this.socket.destroyed) return Promise.reject(new SharedMcpError('ENDPOINT_UNAVAILABLE', 'client is not connected'));
    const id = `bridge-${++this.sequence}`;
    return new Promise((resolve, reject) => { this.pending.set(id, { id: requestId ?? null, resolve, reject }); this.socket?.write(JSON.stringify({ id, method, ...(params === undefined ? {} : { params }) }) + '\n'); });
  }

  close(): void { this.socket?.destroy(); this.socket = undefined; }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n'); if (newline < 0) return;
      const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
      try { const response = JSON.parse(line) as SharedRpcResponse; if (response.id === null) continue; const pending = this.pending.get(response.id); if (pending) { this.pending.delete(response.id); pending.resolve({ ...response, id: pending.id }); } } catch { /* owner validates requests; malformed responses are ignored */ }
    }
  }
}
