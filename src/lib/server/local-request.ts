/** Local development endpoints are deliberately unavailable to public/forwarded hosts. */
export class LocalRequestError extends Error {
  constructor(public status: number, message: string) { super(message); this.name = 'LocalRequestError'; }
}
const isLoopback = (host: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(host.toLowerCase());
export function requireLocalSameOrigin(request: Request): void {
  let url: URL; let origin: URL; let host: URL;
  const hostHeader = request.headers.get('host')?.toLowerCase() || '';
  try { url = new URL(request.url); origin = new URL(request.headers.get('origin') || ''); host = new URL(`${url.protocol}//${hostHeader}`); }
  catch { throw new LocalRequestError(403, 'This endpoint requires a same-origin local browser request.'); }
  // NextURL normalizes loopback aliases to localhost. Same-origin is measured
  // against the actual incoming Host, while both internal URL and Host stay local.
  if (!['http:', 'https:'].includes(url.protocol) || !isLoopback(url.hostname) || !isLoopback(host.hostname) || hostHeader !== host.host.toLowerCase() || url.port !== host.port || origin.origin !== host.origin || origin.username || origin.password) {
    throw new LocalRequestError(403, 'This endpoint is restricted to the local desktop workspace.');
  }
  const forwardedHost = request.headers.get('x-forwarded-host');
  const forwardedFor = request.headers.get('x-forwarded-for');
  const site = request.headers.get('sec-fetch-site');
  if ((forwardedHost && forwardedHost.toLowerCase() !== host.host.toLowerCase()) || (forwardedFor && !forwardedFor.split(',').every(address => isLoopback(address.trim()))) || request.headers.get('forwarded') || (site && site !== 'same-origin' && site !== 'none')) {
    throw new LocalRequestError(403, 'Forwarded or cross-origin provider requests are unavailable.');
  }
}
export const requireLocalRequest = requireLocalSameOrigin;
export async function readBoundedJson(request: Request, maxBytes = 48_000, timeoutMs = 5_000): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new LocalRequestError(415, 'Send a JSON command request.');
  const declared = request.headers.get('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes)) throw new LocalRequestError(413, 'The command context is too large.');
  if (!request.body) throw new LocalRequestError(400, 'The command request is empty.');
  const reader = request.body.getReader(); const decoder = new TextDecoder();
  let bytes = 0; let source = ''; let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new LocalRequestError(408, 'Reading the command timed out. Retry explicitly.')); void reader.cancel().catch(() => {}); }, timeoutMs); });
  try {
    while (true) {
      const chunk = await Promise.race([reader.read(), timeout]);
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) { void reader.cancel().catch(() => {}); throw new LocalRequestError(413, 'The command context is too large.'); }
      source += decoder.decode(chunk.value, { stream: true });
    }
    source += decoder.decode();
    try { return JSON.parse(source); } catch { throw new LocalRequestError(400, 'The command request is not valid JSON.'); }
  } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
}
