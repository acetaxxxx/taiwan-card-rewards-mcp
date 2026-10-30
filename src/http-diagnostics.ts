import * as fs from 'node:fs';
import * as path from 'node:path';

const maxDiagnosticBodyBytes = 256 * 1024;
const maxDiagnosticBodyReadMs = 1000;
const maxDiagnosticLogBytes = 10 * 1024 * 1024;
const maxDiagnosticLogFiles = 5;
const diagnosticRpcMethods = new Set([
  'initialize',
  'notifications/initialized',
  'notifications/cancelled',
  'notifications/progress',
  'ping',
  'tools/list',
  'tools/call',
  'resources/list',
  'resources/read',
  'resources/templates/list',
  'prompts/list',
  'prompts/get',
  'logging/setLevel',
  'completion/complete',
  'roots/list',
]);

export interface DiagnosticBodySnapshot {
  value?: unknown;
  capturedBytes: number;
  truncated?: true;
  omitted?: 'invalid_json' | 'capture_timeout' | 'read_failed' | 'too_large' | 'unsupported_content_type' | 'streaming_response';
}

export interface DiagnosticRequestSnapshot {
  rpcMethod?: string;
  body?: DiagnosticBodySnapshot;
}

interface BoundedBodyCapture {
  body: DiagnosticBodySnapshot;
  rpcMethod?: string;
}

let diagnosticLogPath: string | undefined;
let diagnosticLogInitialized = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function classifyRpcMethod(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  return diagnosticRpcMethods.has(value) ? value : 'other';
}

function methodFromPrefix(value: string): string | undefined {
  const match = /"method"\s*:\s*"((?:\\.|[^"\\])*)"/.exec(value);
  if (!match) return undefined;
  try { return classifyRpcMethod(JSON.parse(`"${match[1]}"`)); }
  catch { return undefined; }
}

function shouldRedactKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return normalized === 'pan'
    || normalized.endsWith('pan')
    || normalized.includes('cardnumber')
    || normalized.includes('cardno')
    || normalized.includes('accountnumber')
    || normalized.includes('accountno')
    || normalized.includes('cvv')
    || normalized.includes('cvc')
    || normalized.includes('securitycode')
    || normalized.includes('otp')
    || normalized === 'pin'
    || normalized.includes('password')
    || normalized.includes('passcode')
    || normalized.includes('cookie')
    || normalized.includes('credential')
    || normalized.includes('privatekey')
    || normalized.includes('secret')
    || normalized.includes('token')
    || normalized.includes('apikey')
    || normalized === 'authorization'
    || normalized === 'userid'
    || normalized === 'userprincipal'
    || normalized === 'owneruser'
    || normalized === 'principal'
    || normalized === 'subject'
    || normalized === 'email'
    || normalized === 'phone'
    || normalized === 'displayname'
    || normalized === 'datadir'
    || normalized === 'path';
}

function redactDiagnosticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactDiagnosticValue);
  if (typeof value === 'string' && /^[\[{]/.test(value.trim())) {
    try {
      const nested: unknown = JSON.parse(value);
      if (Array.isArray(nested) || isRecord(nested)) return JSON.stringify(redactDiagnosticValue(nested));
    } catch { /* Keep ordinary text unchanged. */ }
  }
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
    key,
    shouldRedactKey(key) ? '[REDACTED]' : redactDiagnosticValue(nested),
  ]));
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'));
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, allowPlainText = false): Promise<BoundedBodyCapture | undefined> {
  if (!stream) return undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try { reader = stream.getReader(); }
  catch { return { body: { capturedBytes: 0, omitted: 'read_failed' } }; }

  const chunks: Uint8Array[] = [];
  const deadline = Date.now() + maxDiagnosticBodyReadMs;
  let capturedBytes = 0;
  let truncated = false;
  let omitted: DiagnosticBodySnapshot['omitted'];
  let streamComplete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    while (capturedBytes < maxDiagnosticBodyBytes) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        omitted = 'capture_timeout';
        truncated = true;
        break;
      }
      const timeout = new Promise<{ kind: 'timeout' }>((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'timeout' }), remainingMs);
      });
      const next = await Promise.race([
        reader.read().then((result) => ({ kind: 'read' as const, result })),
        timeout,
      ]);
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (next.kind === 'timeout') {
        omitted = 'capture_timeout';
        truncated = true;
        break;
      }
      if (next.result.done) {
        streamComplete = true;
        break;
      }
      const remainingBytes = maxDiagnosticBodyBytes - capturedBytes;
      const chunk = next.result.value;
      const copied = chunk.byteLength > remainingBytes ? chunk.slice(0, remainingBytes) : chunk.slice();
      chunks.push(copied);
      capturedBytes += copied.byteLength;
      if (chunk.byteLength > remainingBytes || capturedBytes === maxDiagnosticBodyBytes) {
        omitted = 'too_large';
        truncated = true;
        break;
      }
    }
  } catch {
    omitted = 'read_failed';
  } finally {
    if (timer) clearTimeout(timer);
    if (!streamComplete) void reader.cancel().catch(() => undefined).finally(() => reader.releaseLock());
    else reader.releaseLock();
  }

  const bytes = new Uint8Array(capturedBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const prefix = new TextDecoder().decode(bytes);
  let rpcMethod = methodFromPrefix(prefix);
  if (omitted) {
    return { body: { capturedBytes, ...(truncated ? { truncated: true as const } : {}), omitted }, ...(rpcMethod ? { rpcMethod } : {}) };
  }
  try {
    const value: unknown = JSON.parse(prefix);
    rpcMethod = Array.isArray(value) ? 'batch' : classifyRpcMethod(isRecord(value) ? value.method : undefined) ?? rpcMethod;
    return { body: {
      value: redactDiagnosticValue(value),
      capturedBytes,
      ...(truncated ? { truncated: true as const } : {}),
    }, ...(rpcMethod ? { rpcMethod } : {}) };
  } catch {
    if (allowPlainText && !truncated) return { body: { value: prefix, capturedBytes } };
    return { body: { capturedBytes, omitted: 'invalid_json', ...(truncated ? { truncated: true as const } : {}) }, ...(rpcMethod ? { rpcMethod } : {}) };
  }
}

export function httpDiagnosticsEnabled(): boolean {
  return process.env.MCP_HTTP_DIAGNOSTIC_LOGS === '1';
}

function assertRegularLogFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('MCP HTTP diagnostic log entries must be regular files');
}

export function initializeHttpDiagnosticLog(): void {
  diagnosticLogInitialized = true;
  diagnosticLogPath = undefined;
  if (!httpDiagnosticsEnabled()) return;
  const directory = process.env.MCP_HTTP_LOG_DIR?.trim();
  if (!directory) return;
  if (!path.isAbsolute(directory)) throw new Error('MCP_HTTP_LOG_DIR must be an absolute path');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('MCP_HTTP_LOG_DIR must be a real directory');
  fs.chmodSync(directory, 0o700);
  diagnosticLogPath = path.join(directory, 'mcp-http.log');
  for (let index = 0; index < maxDiagnosticLogFiles - 1; index += 1) {
    const rotatedPath = `${diagnosticLogPath}.${index + 1}`;
    assertRegularLogFile(rotatedPath);
    if (fs.existsSync(rotatedPath)) fs.chmodSync(rotatedPath, 0o600);
  }
  assertRegularLogFile(diagnosticLogPath);
  if (fs.existsSync(diagnosticLogPath)) fs.chmodSync(diagnosticLogPath, 0o600);
}

function rotateDiagnosticLog(filePath: string): void {
  const oldestPath = `${filePath}.${maxDiagnosticLogFiles - 1}`;
  assertRegularLogFile(oldestPath);
  if (fs.existsSync(oldestPath)) fs.rmSync(oldestPath);
  for (let index = maxDiagnosticLogFiles - 2; index >= 1; index -= 1) {
    const fromPath = `${filePath}.${index}`;
    const toPath = `${filePath}.${index + 1}`;
    assertRegularLogFile(fromPath);
    if (fs.existsSync(fromPath)) fs.renameSync(fromPath, toPath);
  }
  assertRegularLogFile(filePath);
  if (fs.existsSync(filePath)) fs.renameSync(filePath, `${filePath}.1`);
}

function appendRotatingDiagnosticLog(filePath: string, line: string): void {
  const data = Buffer.from(`${line}\n`);
  assertRegularLogFile(filePath);
  const currentSize = fs.existsSync(filePath) ? fs.statSync(filePath).size : 0;
  if (currentSize > 0 && currentSize + data.byteLength > maxDiagnosticLogBytes) rotateDiagnosticLog(filePath);
  fs.appendFileSync(filePath, data, { mode: 0o600 });
}

function writeMetadataSummary(record: Record<string, unknown>, bodyLogFailed = false): void {
  const requestBody = isRecord(record.requestBody) ? record.requestBody : undefined;
  const responseBody = isRecord(record.responseBody) ? record.responseBody : undefined;
  const metadata = { ...record };
  delete metadata.requestBody;
  delete metadata.responseBody;
  process.stderr.write(`${JSON.stringify({
    ...metadata,
    ...(requestBody ? {
      requestBodyBytes: requestBody.capturedBytes,
      ...(requestBody.truncated ? { requestBodyTruncated: true } : {}),
      ...(requestBody.omitted ? { requestBodyOmitted: requestBody.omitted } : {}),
    } : {}),
    ...(responseBody ? {
      responseBodyBytes: responseBody.capturedBytes,
      ...(responseBody.truncated ? { responseBodyTruncated: true } : {}),
      ...(responseBody.omitted ? { responseBodyOmitted: responseBody.omitted } : {}),
    } : {}),
    ...(bodyLogFailed ? { bodyLogFailed: true } : {}),
  })}\n`);
}

export async function captureDiagnosticRequest(request: Request): Promise<DiagnosticRequestSnapshot> {
  const headerMethod = classifyRpcMethod(request.headers.get('mcp-method'));
  if (request.method !== 'POST') return headerMethod ? { rpcMethod: headerMethod } : {};
  const contentType = request.headers.get('content-type');
  if (contentType && !isJsonContentType(contentType)) {
    return {
      ...(headerMethod ? { rpcMethod: headerMethod } : {}),
      body: { capturedBytes: 0, omitted: 'unsupported_content_type' },
    };
  }
  const capture = await readBoundedBody(request.clone().body);
  const rpcMethod = headerMethod ?? capture?.rpcMethod;
  return {
    ...(rpcMethod ? { rpcMethod } : {}),
    ...(capture ? { body: capture.body } : {}),
  };
}

export async function captureDiagnosticResponse(response: Response): Promise<DiagnosticBodySnapshot | undefined> {
  const contentType = response.headers.get('content-type');
  if (contentType?.toLowerCase().startsWith('text/event-stream')) {
    return { capturedBytes: 0, omitted: 'streaming_response' };
  }
  const isPlainText = contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain';
  if (!isJsonContentType(contentType) && !isPlainText) return undefined;
  return (await readBoundedBody(response.clone().body, isPlainText))?.body;
}

export function writeHttpDiagnostic(record: Record<string, unknown>): void {
  if (!httpDiagnosticsEnabled()) return;
  if (!diagnosticLogInitialized) initializeHttpDiagnosticLog();
  const event = { event: 'mcp_http_request', timestamp: new Date().toISOString(), ...record };
  if (!diagnosticLogPath) {
    writeMetadataSummary(event, Boolean(record.requestBody || record.responseBody));
    return;
  }
  try {
    appendRotatingDiagnosticLog(diagnosticLogPath, JSON.stringify(event));
    writeMetadataSummary(event);
  } catch {
    writeMetadataSummary(event, true);
  }
}
