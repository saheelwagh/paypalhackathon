import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export const PAYPAL_WEBHOOK_PATH = '/api/paypal-sandbox/webhook';
export const MAX_WEBHOOK_BYTES = 256 * 1024;
const signatureHeaders = ['paypal-auth-algo', 'paypal-cert-url', 'paypal-transmission-id', 'paypal-transmission-sig', 'paypal-transmission-time'] as const;

type RelayOptions = {
  appOrigin?: string;
  fetcher?: typeof fetch;
  maxBytes?: number;
  readTimeoutMs?: number;
  upstreamTimeoutMs?: number;
  maxConcurrent?: number;
};
class RelayRequestError extends Error { constructor(public status: number) { super('Webhook relay request rejected.'); } }
function reply(response: ServerResponse, status: number) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...(status >= 400 ? { Connection: 'close' } : {}), ...(status === 503 ? { 'Retry-After': '2' } : {}) });
  response.end(JSON.stringify({ accepted: status >= 200 && status < 300 }));
}
function targetOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('The webhook relay can forward only to a loopback HTTP application origin.');
  return url.origin;
}
function forwardedHeaders(request: IncomingMessage): Headers {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) throw new RelayRequestError(415);
  const headers = new Headers({ 'Content-Type': contentType });
  for (const name of signatureHeaders) {
    const value = request.headers[name];
    const occurrences = request.rawHeaders.filter((_, i) => i % 2 === 0 && request.rawHeaders[i].toLowerCase() === name).length;
    if (typeof value !== 'string' || !value.length || value.length > 4096 || occurrences !== 1) throw new RelayRequestError(400);
    headers.set(name, value);
  }
  return headers;
}
async function readBytes(request: IncomingMessage, maximum: number, timeoutMs: number): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new RelayRequestError(413);
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new RelayRequestError(415);
  return new Promise((resolve, reject) => {
    let bytes = 0; const chunks: Buffer[] = [];
    const timer = setTimeout(() => finish(new RelayRequestError(408)), timeoutMs);
    function cleanup() { clearTimeout(timer); request.off('data', data); request.off('end', end); request.off('error', fail); request.off('aborted', aborted); }
    function finish(error?: Error) { cleanup(); if (error) { request.resume(); reject(error); } else resolve(Buffer.concat(chunks, bytes)); }
    function data(chunk: Buffer) { bytes += chunk.byteLength; if (bytes > maximum) finish(new RelayRequestError(413)); else chunks.push(chunk); }
    function end() { finish(bytes ? undefined : new RelayRequestError(400)); }
    function fail() { finish(new RelayRequestError(400)); }
    function aborted() { finish(new RelayRequestError(400)); }
    request.on('data', data); request.once('end', end); request.once('error', fail); request.once('aborted', aborted);
  });
}

/** Expose this server to the tunnel, never the Next.js app. No dashboard or mutation route is forwarded. */
export function createWebhookRelay(options: RelayOptions = {}) {
  const target = targetOrigin(options.appOrigin ?? 'http://127.0.0.1:3002') + PAYPAL_WEBHOOK_PATH;
  const fetcher = options.fetcher ?? fetch;
  const maximum = options.maxBytes ?? MAX_WEBHOOK_BYTES;
  const maxConcurrent = options.maxConcurrent ?? 8;
  let inFlight = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== PAYPAL_WEBHOOK_PATH) { request.resume(); reply(response, 404); return; }
    if (inFlight >= maxConcurrent) { request.resume(); reply(response, 503); return; }
    inFlight++;
    try {
      const headers = forwardedHeaders(request);
      const body = await readBytes(request, maximum, options.readTimeoutMs ?? 5_000);
      // A cold verifier may need both OAuth and signature verification (20 seconds each).
      const upstream = await fetcher(target, { method: 'POST', headers, body: new Uint8Array(body), signal: AbortSignal.timeout(options.upstreamTimeoutMs ?? 45_000), redirect: 'error', cache: 'no-store' });
      // No provider/body/ledger information is returned through the public relay.
      if (upstream.body) await upstream.body.cancel().catch(() => {});
      reply(response, upstream.status >= 200 && upstream.status < 300 ? upstream.status : upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502);
    } catch (error) { request.resume(); reply(response, error instanceof RelayRequestError ? error.status : 503); }
    finally { inFlight--; }
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 10_000;
  server.keepAliveTimeout = 1_000;
  server.maxHeadersCount = 40;
  return server;
}
