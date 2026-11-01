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
  omitted?: 'invalid_json' | 'invalid_sse' | 'capture_timeout' | 'read_failed' | 'too_large' | 'unsupported_content_type' | 'streaming_response';
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
    || normalized === 'tenantref'
    || normalized === 'tenantid'
    || normalized === 'principal'
    || normalized === 'subject'
    || normalized === 'sub'
    || normalized === 'email'
    || normalized === 'phone'
    || normalized === 'displayname'
    || normalized === 'datadir'
    || normalized === 'path';
}

export function sanitizeDiagnosticHint(value: string | null, limit: number): string | undefined {
  if (!value) return undefined;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[^\s,;]+/gi, '[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{48,}\b/g, '[REDACTED]')
    .replace(/\+?\d[\d(). -]{8,}\d/g, '[REDACTED]');
  return normalized.slice(0, limit) || undefined;
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
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
    const normalizedKey = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (normalizedKey === 'clientinfo') {
      if (!isRecord(nested)) return [key, '[REDACTED]'];
      const clientInfo: Record<string, string> = {};
      const name = sanitizeDiagnosticHint(typeof nested.name === 'string' ? nested.name : null, 128);
      const version = sanitizeDiagnosticHint(typeof nested.version === 'string' ? nested.version : null, 80);
      if (name) clientInfo.name = name;
      if (version) clientInfo.version = version;
      return [key, clientInfo];
    }
    return [key, shouldRedactKey(key) ? '[REDACTED]' : redactDiagnosticValue(nested)];
  }));
}

function isJsonContentType(value: string | null): boolean {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  return mediaType === 'application/json' || Boolean(mediaType?.endsWith('+json'));
}

async function readBoundedBody(stream: ReadableStream<Uint8Array> | null, allowPlainText = false, includePartialText = false): Promise<BoundedBodyCapture | undefined> {
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
    return { body: {
      ...(includePartialText && capturedBytes > 0 ? { value: prefix } : {}),
      capturedBytes,
      ...(truncated ? { truncated: true as const } : {}),
      omitted,
    }, ...(rpcMethod ? { rpcMethod } : {}) };
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
  const isEventStream = contentType?.toLowerCase().startsWith('text/event-stream') ?? false;
  const isPlainText = contentType?.split(';', 1)[0]?.trim().toLowerCase() === 'text/plain';
  if (!isJsonContentType(contentType) && !isPlainText && !isEventStream) return undefined;
  const capture = await readBoundedBody(response.clone().body, isPlainText || isEventStream, isEventStream);
  if (!capture || !isEventStream) return capture?.body;
  const rawText = typeof capture.body.value === 'string' ? capture.body.value : undefined;
  if (rawText === undefined) return capture.body;
  const messages = parseSseMessages(rawText);
  if (messages.length === 0) {
    return {
      capturedBytes: capture.body.capturedBytes,
      ...(capture.body.truncated ? { truncated: true as const } : {}),
      omitted: capture.body.omitted ?? 'invalid_sse',
    };
  }
  return {
    value: redactDiagnosticValue(messages),
    capturedBytes: capture.body.capturedBytes,
    ...(capture.body.truncated ? { truncated: true as const } : {}),
    ...(capture.body.omitted ? { omitted: capture.body.omitted } : {}),
  };
}

function parseSseMessages(value: string): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const frame of value.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (!data || data === '[DONE]') continue;
    try {
      const parsed: unknown = JSON.parse(data);
      if (isRecord(parsed)) messages.push(parsed);
    } catch { /* Ignore non-JSON SSE events; only JSON-RPC frames aid MCP diagnosis. */ }
  }
  return messages;
}

function boundedDiagnosticText(value: unknown, limit: number): string | undefined {
  return sanitizeDiagnosticHint(typeof value === 'string' ? value : null, limit);
}

function rpcMessages(body: unknown): Record<string, unknown>[] {
  if (!isRecord(body) || !Object.hasOwn(body, 'value')) return [];
  const value = body.value;
  if (Array.isArray(value)) return value.filter(isRecord);
  return isRecord(value) ? [value] : [];
}

function safeErrorCode(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value;
  return undefined;
}

function toolErrorCodeFromResult(result: Record<string, unknown>): string | number | undefined {
  if (!Array.isArray(result.content)) return undefined;
  for (const item of result.content) {
    if (!isRecord(item) || typeof item.text !== 'string') continue;
    try {
      const parsed: unknown = JSON.parse(item.text);
      if (isRecord(parsed)) {
        const code = safeErrorCode(parsed.code);
        if (code !== undefined) return code;
      }
    } catch { /* Tool content can be ordinary text. */ }
  }
  return undefined;
}

function diagnosticRpcSummary(record: Record<string, unknown>): Record<string, unknown> {
  const requests = rpcMessages(record.requestBody);
  const request = requests.find((message) => typeof message.method === 'string') ?? requests[0];
  if (!request) return {};
  const method = typeof request.method === 'string' ? request.method : record.rpcMethod;
  const summary: Record<string, unknown> = {};
  if (method === 'initialize' && isRecord(request.params) && isRecord(request.params.clientInfo)) {
    const name = boundedDiagnosticText(request.params.clientInfo.name, 128);
    const version = boundedDiagnosticText(request.params.clientInfo.version, 80);
    if (name) summary.mcpClientName = name;
    if (version) summary.mcpClientVersion = version;
  }
  if (method !== 'tools/call' || !isRecord(request.params)) return summary;
  const toolName = boundedDiagnosticText(request.params.name, 128);
  if (toolName && /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(toolName)) summary.toolName = toolName;

  const responses = rpcMessages(record.responseBody);
  const response = request.id === undefined
    ? responses.find((message) => Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))
    : responses.find((message) => message.id === request.id);
  if (!response) return summary;
  if (isRecord(response.error)) {
    summary.toolOutcome = 'rpc_error';
    const code = safeErrorCode(response.error.code);
    if (code !== undefined) summary.jsonRpcErrorCode = code;
    return summary;
  }
  if (!isRecord(response.result)) return summary;
  summary.toolOutcome = response.result.isError === true ? 'tool_error' : 'success';
  if (typeof response.result.isError === 'boolean') summary.toolIsError = response.result.isError;
  if (response.result.isError === true) {
    const code = toolErrorCodeFromResult(response.result);
    if (code !== undefined) summary.toolErrorCode = code;
  }
  return summary;
}

export function writeHttpDiagnostic(record: Record<string, unknown>): void {
  if (!httpDiagnosticsEnabled()) return;
  if (!diagnosticLogInitialized) initializeHttpDiagnosticLog();
  const event = { event: 'mcp_http_request', timestamp: new Date().toISOString(), ...record, ...diagnosticRpcSummary(record) };
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
