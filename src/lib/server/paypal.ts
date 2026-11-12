import { z } from 'zod';

/** Deliberately has no production-host or environment override. */
export const PAYPAL_SANDBOX_API = 'https://api-m.sandbox.paypal.com';
export type PayPalErrorCode = 'configuration' | 'authentication' | 'rate-limit' | 'timeout' | 'unavailable' | 'rejected' | 'invalid-response';
export class PayPalProviderError extends Error {
  constructor(public code: PayPalErrorCode, message: string, public status?: number, public uncertain = false) { super(message); this.name = 'PayPalProviderError'; }
}
export type PayPalInvoiceInput = { invoiceNumber: string; recipientEmail: string; description: string; amountCents: number; reference?: string };
export type PayPalPayment = { id: string; amountCents: number; date?: string };
export type PayPalInvoiceSnapshot = {
  provider: 'paypal-sandbox'; id: string; invoiceNumber: string; status: string; currency: 'USD';
  recipientEmail: string; description: string; reference?: string;
  amountCents: number; dueCents: number; confirmedCents: number; pendingCents: number; refundedCents: number;
  payments: PayPalPayment[]; payerUrl?: string; checkedAt: string; warnings: string[];
};
export interface PayPalSandboxProvider {
  createDraft(input: PayPalInvoiceInput, requestId: string): Promise<PayPalInvoiceSnapshot>;
  sendInvoice(id: string, requestId: string): Promise<PayPalInvoiceSnapshot>;
  getInvoice(id: string): Promise<PayPalInvoiceSnapshot>;
  findInvoice(invoiceNumber: string): Promise<PayPalInvoiceSnapshot | null>;
}
const invoiceIdSchema = z.string().regex(/^INV2-[A-Z0-9-]{8,25}$/);
const invoiceNumberSchema = z.string().regex(/^[A-Za-z0-9_-]{1,25}$/);
const requestIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,38}$/);
const inputSchema = z.object({ invoiceNumber: invoiceNumberSchema, recipientEmail: z.email().max(254), description: z.string().trim().min(1).max(1000), amountCents: z.number().int().positive().max(99_999_999), reference: z.string().trim().min(1).max(120).optional() }).strict();
const moneySchema = z.object({ currency_code: z.literal('USD'), value: z.string().regex(/^\d{1,13}(?:\.\d{1,2})?$/) });
const transactionSchema = z.object({ type: z.string().optional(), payment_id: z.string().optional(), refund_id: z.string().optional(), payment_date: z.string().optional(), amount: moneySchema.optional() });
const invoiceSchema = z.object({
  id: invoiceIdSchema, status: z.string().min(1).max(64),
  detail: z.object({ invoice_number: z.string().min(1).max(25), currency_code: z.literal('USD'), reference: z.string().optional(), metadata: z.object({ recipient_view_url: z.string().optional() }).optional() }),
  primary_recipients: z.array(z.object({ billing_info: z.object({ email_address: z.string().optional() }).optional() })).optional(),
  items: z.array(z.object({ name: z.string().optional(), description: z.string().optional() })).optional(),
  amount: moneySchema, due_amount: moneySchema.optional(),
  payments: z.object({ paid_amount: moneySchema.optional(), transactions: z.array(transactionSchema).max(1000).optional() }).optional(),
  refunds: z.object({ refund_amount: moneySchema.optional(), transactions: z.array(transactionSchema).max(1000).optional() }).optional(),
  links: z.array(z.object({ href: z.string(), rel: z.string(), method: z.string().optional() })).optional(),
});
function invalid(message = 'PayPal returned invoice data that could not be verified.'): never { throw new PayPalProviderError('invalid-response', message); }
export function paypalUsdCents(value: string): number {
  if (!/^\d{1,13}(?:\.\d{1,2})?$/.test(value)) return invalid('PayPal returned an invalid USD amount.');
  const [whole, decimal = ''] = value.split('.');
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) return invalid('PayPal returned an amount outside the supported range.');
  return Number(cents);
}
function dollars(cents: number) { return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`; }
async function safeErrorCodes(response: Response): Promise<string> {
  try {
    const body = await response.clone().json() as unknown;
    if (!body || typeof body !== 'object') return '';
    const record = body as Record<string, unknown>;
    const issues = Array.isArray(record.details) ? record.details.map(value => value && typeof value === 'object' ? (value as Record<string, unknown>).issue : undefined) : [];
    const codes = [...new Set([record.name, ...issues].filter((value): value is string => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)))].slice(0, 3);
    return codes.length ? ` Provider codes: ${codes.join(', ')}.` : '';
  } catch { return ''; }
}
export function safeSandboxPayerUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:' && url.hostname === 'www.sandbox.paypal.com' && !url.port && !url.username && !url.password && /^\/(?:invoice\/p|invoice\/payerView\/details|invoicing\/pay)\//.test(url.pathname)) return url.href;
  } catch { /* Invalid provider links are never followed. */ }
  return undefined;
}
/** Only a server-authenticated invoice response may enter this normalizer. No offline payment mutation is exposed. */
export function normalizePayPalInvoice(raw: unknown): PayPalInvoiceSnapshot {
  const parsed = invoiceSchema.safeParse(raw);
  if (!parsed.success) return invalid();
  const invoice = parsed.data; const warnings: string[] = [];
  const amountCents = paypalUsdCents(invoice.amount.value);
  const dueCents = invoice.due_amount ? paypalUsdCents(invoice.due_amount.value) : amountCents;
  const rawPayments = invoice.payments?.transactions ?? [];
  const rawRefunds = invoice.refunds?.transactions ?? [];
  const confirmedStatus = ['PAID', 'PARTIALLY_PAID', 'PARTIALLY_REFUNDED', 'REFUNDED'].includes(invoice.status);
  const payments: PayPalPayment[] = [];
  const seen = new Map<string, number>();
  for (const tx of rawPayments) {
    if (tx.type !== 'PAYPAL') { warnings.push('External or unidentified payment entries are excluded from sandbox collection.'); continue; }
    if (!tx.payment_id || !/^[A-Za-z0-9]{1,22}$/.test(tx.payment_id) || !tx.amount) return invalid('PayPal payment evidence was incomplete.');
    const cents = paypalUsdCents(tx.amount.value);
    if (seen.has(tx.payment_id)) { if (seen.get(tx.payment_id) !== cents) return invalid('PayPal returned conflicting payment entries.'); continue; }
    seen.set(tx.payment_id, cents);
    if (confirmedStatus) payments.push({ id: tx.payment_id, amountCents: cents, ...(tx.payment_date ? { date: tx.payment_date } : {}) });
  }
  const gross = payments.reduce((sum, tx) => sum + tx.amountCents, 0);
  let refundedCents = 0; const refundIds = new Map<string, number>();
  for (const tx of rawRefunds) {
    if (tx.type !== 'PAYPAL') { warnings.push('External or unidentified refunds are excluded from PayPal refund totals.'); continue; }
    if (!tx.refund_id || !/^[A-Za-z0-9]{1,22}$/.test(tx.refund_id) || !tx.amount) return invalid('PayPal refund evidence was incomplete.');
    const cents = paypalUsdCents(tx.amount.value);
    if (refundIds.has(tx.refund_id)) { if (refundIds.get(tx.refund_id) !== cents) return invalid('PayPal returned conflicting refund entries.'); continue; }
    refundIds.set(tx.refund_id, cents); refundedCents += cents;
  }
  if (![gross, refundedCents].every(Number.isSafeInteger) || gross > amountCents || refundedCents > amountCents) return invalid('PayPal payment totals require manual reconciliation.');
  let confirmedCents = Math.max(0, gross - refundedCents);
  if (['REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'REFUNDED_EXTERNAL'].includes(invoice.status) && !refundedCents) {
    // Do not keep a stale positive collection when refund detail is absent.
    confirmedCents = 0; warnings.push('Refund state requires complete PayPal refund evidence before collection can be confirmed.');
  }
  const pendingCents = invoice.status === 'PAYMENT_PENDING' ? Math.min(amountCents, invoice.payments?.paid_amount ? paypalUsdCents(invoice.payments.paid_amount.value) : amountCents) : 0;
  if (invoice.status === 'PAYMENT_PENDING') warnings.push('Payment is pending. No new collection has been confirmed.');
  if (['PAID', 'PARTIALLY_PAID'].includes(invoice.status) && !payments.length) warnings.push('PayPal reports a paid state without a verified PayPal transaction; collection remains unconfirmed.');
  const rawPayerUrl = invoice.detail.metadata?.recipient_view_url ?? invoice.links?.find(link => ['payer-view', 'payer_view', 'recipient-view'].includes(link.rel))?.href;
  const payerUrl = safeSandboxPayerUrl(rawPayerUrl);
  if (rawPayerUrl && !payerUrl) warnings.push('An unexpected payment link was withheld.');
  return { provider: 'paypal-sandbox', id: invoice.id, invoiceNumber: invoice.detail.invoice_number, status: invoice.status, currency: 'USD', recipientEmail: invoice.primary_recipients?.[0]?.billing_info?.email_address ?? '', description: invoice.items?.[0]?.description ?? invoice.items?.[0]?.name ?? '', ...(invoice.detail.reference ? { reference: invoice.detail.reference } : {}), amountCents, dueCents, confirmedCents, pendingCents, refundedCents, payments, ...(payerUrl ? { payerUrl } : {}), checkedAt: new Date().toISOString(), warnings: [...new Set(warnings)] };
}

export class PayPalSandbox implements PayPalSandboxProvider {
  private token?: { value: string; expires: number };
  constructor(private env: Record<string, string | undefined> = process.env, private fetcher: typeof fetch = fetch) {}
  private async fetchSafe(path: string, init: RequestInit, mutation: boolean): Promise<Response> {
    let response: Response;
    try { response = await this.fetcher(`${PAYPAL_SANDBOX_API}${path}`, { ...init, signal: AbortSignal.timeout(20_000), redirect: 'error', cache: 'no-store' }); }
    catch (error) {
      const timeout = error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name);
      throw new PayPalProviderError(timeout ? 'timeout' : 'unavailable', mutation ? 'PayPal sandbox did not confirm this operation. Reconcile the original invoice before retrying.' : 'PayPal sandbox could not be reached. Retry the status check.', undefined, mutation);
    }
    if (!response.ok) {
      // Only bounded enum-shaped codes from invoice errors are exposed. Never include
      // messages, descriptions, fields, debug IDs, or raw bodies that can echo inputs.
      const codes = path.startsWith('/v2/invoicing/') ? await safeErrorCodes(response) : '';
      if ([401, 403].includes(response.status)) {
        this.token = undefined;
        const message = response.status === 403 && path.startsWith('/v2/invoicing/')
          ? 'PayPal sandbox denied Invoicing access (HTTP 403). Enable Invoicing under Apps & Credentials → your sandbox app → Features, then retry. If it is already enabled, check the sandbox merchant account permissions.'
          : 'PayPal sandbox rejected authentication (HTTP ' + response.status + '). Check that the client ID and secret belong to the same sandbox app.';
        throw new PayPalProviderError('authentication', message + codes, response.status);
      }
      if (response.status === 429) throw new PayPalProviderError('rate-limit', 'PayPal sandbox rate limit reached. Wait before checking again.', 429, mutation);
      if (response.status >= 500 || response.status === 408) throw new PayPalProviderError('unavailable', mutation ? 'PayPal sandbox did not confirm this operation. Reconcile before retrying.' : 'PayPal sandbox is temporarily unavailable.', response.status, mutation);
      throw new PayPalProviderError('rejected', `PayPal sandbox rejected the request (HTTP ${response.status}).${codes} Check the invoice and sandbox account.`, response.status, mutation && response.status === 409);
    }
    return response;
  }
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expires > Date.now()) return this.token.value;
    const client = this.env.PAYPAL_CLIENT_ID?.trim(); const secret = this.env.PAYPAL_CLIENT_SECRET?.trim();
    if (!client || !secret) throw new PayPalProviderError('configuration', 'PayPal sandbox credentials are not configured.');
    const response = await this.fetchSafe('/v1/oauth2/token', { method: 'POST', headers: { Authorization: `Basic ${Buffer.from(`${client}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'https://uri.paypal.com/services/invoicing' }).toString() }, false);
    let body: unknown; try { body = await response.json(); } catch { return invalid('PayPal returned an invalid authentication response.'); }
    const parsed = z.object({ access_token: z.string().min(1), token_type: z.string(), expires_in: z.number().positive() }).safeParse(body);
    if (!parsed.success || parsed.data.token_type.toLowerCase() !== 'bearer') return invalid('PayPal returned an invalid authentication response.');
    this.token = { value: parsed.data.access_token, expires: Date.now() + Math.max(0, Math.min(parsed.data.expires_in, 28_800) - 60) * 1000 };
    return this.token.value;
  }
  private async request(path: string, body?: Record<string, unknown>, requestId?: string, mutation = false): Promise<unknown> {
    const token = await this.accessToken();
    const response = await this.fetchSafe(path, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json', Prefer: 'return=representation', ...(requestId ? { 'PayPal-Request-Id': requestId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) }, mutation);
    if (response.status === 204) return {};
    try { return await response.json(); } catch { throw new PayPalProviderError('invalid-response', 'PayPal returned an unreadable result. Reconcile before repeating an operation.', undefined, mutation); }
  }
  async createDraft(input: PayPalInvoiceInput, requestId: string): Promise<PayPalInvoiceSnapshot> {
    const data = inputSchema.parse(input); requestIdSchema.parse(requestId);
    const body = { detail: { invoice_number: data.invoiceNumber, currency_code: 'USD', payment_term: { term_type: 'DUE_ON_RECEIPT' }, note: 'PayPal Sandbox test invoice. No real money. Separate from simulated Demo records.', ...(data.reference ? { reference: data.reference } : {}) }, primary_recipients: [{ billing_info: { email_address: data.recipientEmail } }], items: [{ name: data.description.slice(0, 127), description: data.description, quantity: '1', unit_amount: { currency_code: 'USD', value: dollars(data.amountCents) } }], configuration: { partial_payment: { allow_partial_payment: false }, allow_tip: false, tax_calculated_after_discount: false, tax_inclusive: false } };
    const raw = await this.request('/v2/invoicing/invoices', body, requestId, true);
    try { return normalizePayPalInvoice(raw); } catch (error) { if (error instanceof PayPalProviderError) error.uncertain = true; throw error; }
  }
  async getInvoice(id: string): Promise<PayPalInvoiceSnapshot> {
    invoiceIdSchema.parse(id);
    const snapshot = normalizePayPalInvoice(await this.request(`/v2/invoicing/invoices/${id}`));
    if (snapshot.id !== id) return invalid('PayPal returned a different invoice.');
    return snapshot;
  }
  async sendInvoice(id: string, requestId: string): Promise<PayPalInvoiceSnapshot> {
    invoiceIdSchema.parse(id); requestIdSchema.parse(requestId);
    await this.request(`/v2/invoicing/invoices/${id}/send`, { send_to_recipient: false, send_to_invoicer: false }, requestId, true);
    try { return await this.getInvoice(id); } catch (error) { if (error instanceof PayPalProviderError) error.uncertain = true; throw error; }
  }
  async findInvoice(invoiceNumber: string): Promise<PayPalInvoiceSnapshot | null> {
    invoiceNumberSchema.parse(invoiceNumber);
    const raw = await this.request('/v2/invoicing/search-invoices?page=1&page_size=100&total_required=true', { invoice_number: invoiceNumber });
    const parsed = z.object({ items: z.array(z.object({ id: invoiceIdSchema, detail: z.object({ invoice_number: z.string() }) })).optional(), total_pages: z.number().optional() }).safeParse(raw);
    if (!parsed.success) return invalid('PayPal returned an invalid invoice search.');
    if ((parsed.data.total_pages ?? 1) > 1) return invalid('Invoice search is ambiguous. No replacement invoice was created.');
    const matches = (parsed.data.items ?? []).filter(item => item.detail.invoice_number === invoiceNumber);
    if (matches.length > 1) return invalid('Multiple PayPal invoices match the saved reference. Manual reconciliation is required.');
    return matches.length ? this.getInvoice(matches[0].id) : null;
  }
}
