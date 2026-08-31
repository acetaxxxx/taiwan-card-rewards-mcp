import * as dns from 'node:dns/promises';
import * as net from 'node:net';

function privateAddress(address: string): boolean {
  if (net.isIPv4(address)) {
    const octets = address.split('.').map(Number);
    const [a, b] = octets;
    return a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b !== undefined && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 0;
  }
  if (net.isIPv6(address)) return address === '::1' || address.startsWith('fc') || address.startsWith('fd') || address.startsWith('fe80:');
  return true;
}

export async function assertPublicAllowedHost(url: URL, allowedHosts: readonly string[]): Promise<void> {
  const host = url.hostname.toLowerCase();
  if (!allowedHosts.includes(host)) throw new Error('source hostname is not on the trusted official allowlist');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || net.isIP(host)) throw new Error('source hostname is not public');
  const addresses = await dns.lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateAddress(entry.address))) throw new Error('source hostname resolves to a non-public address');
}

export async function readResponseWithLimit(response: Response, limitBytes: number): Promise<string> {
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) > limitBytes) throw new Error('source response exceeds size limit');
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > limitBytes) throw new Error('source response exceeds size limit');
      chunks.push(part.value);
    }
  } finally { reader.releaseLock(); }
  return new TextDecoder().decode(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}
