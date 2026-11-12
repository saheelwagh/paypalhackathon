import { PAYPAL_SANDBOX_API } from './paypal';

/** Invoicing notifications are signals to retrieve the current invoice, never payment evidence. */
export const PAYPAL_INVOICE_WEBHOOK_EVENTS = [
  'INVOICING.INVOICE.CREATED', 'INVOICING.INVOICE.SENT', 'INVOICING.INVOICE.CANCELLED',
  'INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.SCHEDULED', 'INVOICING.INVOICE.UPDATED',
] as const;
export const PAYPAL_WEBHOOK_MAX_EVENT_BYTES = 256 * 1024;
export type PayPalWebhookRegistration = { id: string; url: string; eventTypes: string[] };
export type PayPalWebhookErrorCode = 'configuration' | 'invalid-input' | 'authentication' | 'rate-limit' | 'timeout' | 'unavailable' | 'rejected' | 'invalid-response';
export class PayPalWebhookError extends Error {
  constructor(public code: PayPalWebhookErrorCode, message: string, public status?: number) { super(message); this.name = 'PayPalWebhookError'; }
}
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const idPattern = /^[A-Za-z0-9]{1,50}$/;
const invoiceIdPattern = /^INV2-[A-Z0-9-]{8,25}$/;
const badInput = (): never => { throw new PayPalWebhookError('invalid-input', 'The sandbox webhook request is invalid.'); };
const badResponse = (): never => { throw new PayPalWebhookError('invalid-response', 'PayPal sandbox returned an invalid webhook response.'); };

export function isSupportedPayPalInvoiceEvent(eventType: unknown): boolean {
  return typeof eventType === 'string' && (PAYPAL_INVOICE_WEBHOOK_EVENTS as readonly string[]).includes(eventType);
}
/** Handles both documented invoice payload shapes without following untrusted links. */
export function invoiceIdFromPayPalEvent(event: unknown): string | null {
  if (!record(event) || !isSupportedPayPalInvoiceEvent(event.event_type) || !record(event.resource)) return null;
  const direct = event.resource.id;
  const nested = record(event.resource.invoice) ? event.resource.invoice.id : undefined;
  const directId = typeof direct === 'string' && invoiceIdPattern.test(direct) ? direct : null;
  const nestedId = typeof nested === 'string' && invoiceIdPattern.test(nested) ? nested : null;
  if (directId && nestedId && directId !== nestedId) return null;
  return directId ?? nestedId;
}

function certificateUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && ['api.sandbox.paypal.com', 'api-m.sandbox.paypal.com'].includes(url.hostname)
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && /^\/v1\/notifications\/certs\/[A-Za-z0-9_-]{1,200}$/.test(url.pathname);
  } catch { return false; }
}
function registrationUrl(value: string): string {
  try {
    const url = new URL(value);
    // Registrations need a public HTTPS receiver. The client never requests this URL itself.
    const host = url.hostname;
    if (value.length > 2048 || url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash
      || !host.includes('.') || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':')
      || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)) return badInput();
    return url.href;
  } catch { return badInput(); }
}
function normalizeRegistration(value: unknown): PayPalWebhookRegistration {
  if (!record(value) || typeof value.id !== 'string' || !idPattern.test(value.id) || typeof value.url !== 'string' || value.url.length > 2048
    || !Array.isArray(value.event_types) || value.event_types.length > 500) return badResponse();
  const eventTypes = value.event_types.map(type => {
    if (!record(type) || typeof type.name !== 'string' || !/^[A-Z0-9.*_-]{1,120}$/.test(type.name)) return badResponse();
    return type.name;
  });
  return { id: value.id, url: value.url, eventTypes };
}
async function responseJson(response: Response): Promise<unknown> {
  // Bound provider response reads as well as incoming webhook bodies.
  if (!response.body) return badResponse();
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 512 * 1024) { await reader.cancel(); return badResponse(); }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch { return badResponse(); }
  finally { reader.releaseLock(); }
}

/** Fixed sandbox host and a dedicated OAuth scope; never fetches caller-supplied certificate URLs. */
export class PayPalSandboxWebhooks {
  private token?: { value: string; expires: number };
  constructor(private env: Record<string, string | undefined> = process.env, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try { response = await this.fetcher(`${PAYPAL_SANDBOX_API}${path}`, { ...init, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(20_000) }); }
    catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new PayPalWebhookError(timeout ? 'timeout' : 'unavailable', 'PayPal sandbox did not confirm the webhook request.');
    }
    if (!response.ok) {
      // Never expose upstream body, headers, tokens, identifiers or potentially echoed request data.
      if ([401, 403].includes(response.status)) { this.token = undefined; throw new PayPalWebhookError('authentication', 'PayPal sandbox rejected webhook authentication.', response.status); }
      if (response.status === 429) throw new PayPalWebhookError('rate-limit', 'PayPal sandbox webhook rate limit reached.', 429);
      if (response.status >= 500 || response.status === 408) throw new PayPalWebhookError('unavailable', 'PayPal sandbox webhooks are temporarily unavailable.', response.status);
      throw new PayPalWebhookError('rejected', `PayPal sandbox rejected the webhook request (HTTP ${response.status}).`, response.status);
    }
    return response;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const client = this.env.PAYPAL_CLIENT_ID?.trim(); const secret = this.env.PAYPAL_CLIENT_SECRET?.trim();
    if (!client || !secret) throw new PayPalWebhookError('configuration', 'PayPal sandbox credentials are not configured.');
    const raw = await responseJson(await this.request('/v1/oauth2/token', {
      method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://uri.paypal.com/services/applications/webhooks' }),
    }));
    if (!record(raw) || typeof raw.access_token !== 'string' || !raw.access_token || raw.access_token.length > 8192 || raw.token_type !== 'Bearer'
      || typeof raw.expires_in !== 'number' || !Number.isFinite(raw.expires_in) || raw.expires_in <= 0) return badResponse();
    this.token = { value: raw.access_token, expires: Date.now() + Math.max(0, Math.min(raw.expires_in, 28_800) - 60) * 1000 };
    return this.token.value;
  }
  private async api(path: string, method = 'GET', body?: unknown): Promise<Response> {
    const token = await this.accessToken();
    return this.request(path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async verify(headers: Headers | Record<string, string>, event: Record<string, unknown>, webhookId: string): Promise<boolean> {
    if (!idPattern.test(webhookId)) return badInput();
    let h: Headers;
    try { h = new Headers(headers); } catch { return badInput(); }
    const auth_algo = h.get('paypal-auth-algo') ?? ''; const cert_url = h.get('paypal-cert-url') ?? '';
    const transmission_id = h.get('paypal-transmission-id') ?? ''; const transmission_sig = h.get('paypal-transmission-sig') ?? '';
    const transmission_time = h.get('paypal-transmission-time') ?? '';
    if (auth_algo !== 'SHA256withRSA' || cert_url.length > 500 || !certificateUrl(cert_url)
      || !/^[A-Za-z0-9_-]{1,50}$/.test(transmission_id) || !/^[A-Za-z0-9+/]{40,2046}={0,2}$/.test(transmission_sig)
      || transmission_time.length > 100 || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(transmission_time)
      || !Number.isFinite(Date.parse(transmission_time)) || !record(event)) return badInput();
    // Do not expire old signed retries. Durable event-ID deduplication belongs to the inbox.
    try { if (Buffer.byteLength(JSON.stringify(event), 'utf8') > PAYPAL_WEBHOOK_MAX_EVENT_BYTES) return badInput(); }
    catch { return badInput(); }
    const raw = await responseJson(await this.api('/v1/notifications/verify-webhook-signature', 'POST', {
      auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id: webhookId, webhook_event: event,
    }));
    if (!record(raw) || (raw.verification_status !== 'SUCCESS' && raw.verification_status !== 'FAILURE')) return badResponse();
    return raw.verification_status === 'SUCCESS';
  }
  async listWebhooks(): Promise<PayPalWebhookRegistration[]> {
    const raw = await responseJson(await this.api('/v1/notifications/webhooks'));
    if (!record(raw) || !Array.isArray(raw.webhooks) || raw.webhooks.length > 100) return badResponse();
    return raw.webhooks.map(normalizeRegistration);
  }
  async createWebhook(url: string, eventTypes: readonly string[] = PAYPAL_INVOICE_WEBHOOK_EVENTS): Promise<PayPalWebhookRegistration> {
    const safeUrl = registrationUrl(url);
    if (!eventTypes.length || eventTypes.length > PAYPAL_INVOICE_WEBHOOK_EVENTS.length || new Set(eventTypes).size !== eventTypes.length || !eventTypes.every(isSupportedPayPalInvoiceEvent)) return badInput();
    const created = normalizeRegistration(await responseJson(await this.api('/v1/notifications/webhooks', 'POST', { url: safeUrl, event_types: eventTypes.map(name => ({ name })) })));
    if (created.url !== safeUrl || [...created.eventTypes].sort().join(',') !== [...eventTypes].sort().join(',')) return badResponse();
    return created;
  }
  /** Call only for a registration owned by this application; never follows provider links. */
  async deleteWebhook(id: string): Promise<void> {
    if (!idPattern.test(id)) return badInput();
    await this.api(`/v1/notifications/webhooks/${id}`, 'DELETE');
  }
}
