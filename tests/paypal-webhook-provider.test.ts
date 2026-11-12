import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandboxWebhooks, PayPalWebhookError, PAYPAL_INVOICE_WEBHOOK_EVENTS, PAYPAL_WEBHOOK_MAX_EVENT_BYTES, invoiceIdFromPayPalEvent, isSupportedPayPalInvoiceEvent } from '../src/lib/server/paypal-webhook-provider';

const env = { PAYPAL_CLIENT_ID: 'test-only-client', PAYPAL_CLIENT_SECRET: 'test-only-secret' };
const invoiceId = 'INV2-ABCD-EFGH-IJKL-MNOP';
const webhookId = '3RT45678SP234567B';
const event = { id: 'WH-test-event', event_type: 'INVOICING.INVOICE.PAID', resource: { id: invoiceId, status: 'PAYMENT_PENDING' }, summary: 'Preserve signed fields' };
const headers = () => new Headers({
  'PAYPAL-AUTH-ALGO': 'SHA256withRSA',
  'PAYPAL-CERT-URL': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-sandbox-test',
  'PAYPAL-TRANSMISSION-ID': 'a1b2c3d4-1234-5678-9012-123456789abc',
  'PAYPAL-TRANSMISSION-SIG': Buffer.alloc(256, 5).toString('base64'),
  'PAYPAL-TRANSMISSION-TIME': '2026-11-12T01:00:00Z',
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const oauth = () => json({ access_token: 'test-only-access-token', token_type: 'Bearer', expires_in: 3600 });
const setup = (replies: Response[]) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const provider = new PayPalSandboxWebhooks({ ...env, PAYPAL_BASE_URL: 'https://api-m.paypal.com' }, (async (url, init) => {
    calls.push({ url: String(url), init: init! }); assert(replies.length, 'Unexpected provider request'); return replies.shift()!;
  }) as typeof fetch);
  return { provider, calls };
};
const registration = (url = 'https://receiver.example.test/api/paypal-sandbox/webhook', types: readonly string[] = PAYPAL_INVOICE_WEBHOOK_EVENTS) => ({ id: webhookId, url, event_types: types.map(name => ({ name })), links: [{ href: 'https://untrusted.example.test/delete', rel: 'delete' }] });

test('signature verification uses explicit webhook OAuth scope, fixed sandbox host and unchanged event', async () => {
  const { provider, calls } = setup([oauth(), json({ verification_status: 'SUCCESS' }), json({ verification_status: 'FAILURE' })]);
  assert.equal(await provider.verify(headers(), event, webhookId), true);
  assert.equal(await provider.verify(Object.fromEntries(headers()), event, webhookId), false);
  assert.equal(calls.length, 3, 'Reuses scoped token and never fetches the caller certificate URL');
  assert.deepEqual([...new URLSearchParams(String(calls[0].init.body)).entries()], [['grant_type', 'client_credentials'], ['scope', 'https://uri.paypal.com/services/applications/webhooks']]);
  assert(calls.every(call => call.url.startsWith('https://api-m.sandbox.paypal.com/') && call.init.redirect === 'error' && call.init.cache === 'no-store'));
  assert.equal(calls[1].url, 'https://api-m.sandbox.paypal.com/v1/notifications/verify-webhook-signature');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), {
    auth_algo: 'SHA256withRSA', cert_url: headers().get('paypal-cert-url'), transmission_id: headers().get('paypal-transmission-id'),
    transmission_sig: headers().get('paypal-transmission-sig'), transmission_time: headers().get('paypal-transmission-time'), webhook_id: webhookId, webhook_event: event,
  });
});

test('unsupported algorithms, malformed headers and arbitrary certificate URLs fail before network', async () => {
  const { provider, calls } = setup([]);
  const changes: [string, string | null][] = [
    ['paypal-auth-algo', 'RSA-SHA256'], ['paypal-auth-algo', 'none'], ['paypal-transmission-id', 'id, duplicate'],
    ['paypal-transmission-time', 'not-a-time'], ['paypal-transmission-time', ''], ['paypal-transmission-sig', 'not-a-signature'],
    ['paypal-transmission-id', null], ['paypal-cert-url', 'https://api.paypal.com/v1/notifications/certs/CERT-x'],
    ['paypal-cert-url', 'http://api.sandbox.paypal.com/v1/notifications/certs/CERT-x'],
    ['paypal-cert-url', 'https://api.sandbox.paypal.com.evil.test/v1/notifications/certs/CERT-x'],
    ['paypal-cert-url', 'https://user:pass@api.sandbox.paypal.com/v1/notifications/certs/CERT-x'],
    ['paypal-cert-url', 'https://api.sandbox.paypal.com:8443/v1/notifications/certs/CERT-x'],
    ['paypal-cert-url', 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x?redirect=evil'],
    ['paypal-cert-url', 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-x#x'],
    ['paypal-cert-url', 'https://api.sandbox.paypal.com/v1/notifications/certs/%2e%2e/secret'],
    ['paypal-cert-url', 'https://127.0.0.1/v1/notifications/certs/CERT-x'],
  ];
  for (const [key, value] of changes) {
    const h = headers(); if (value === null) h.delete(key); else h.set(key, value);
    await assert.rejects(provider.verify(h, event, webhookId), error => error instanceof PayPalWebhookError && error.code === 'invalid-input');
  }
  assert.equal(calls.length, 0);
});

test('oversized and cyclic webhook bodies and invalid registration IDs fail before network', async () => {
  const { provider, calls } = setup([]);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(provider.verify(headers(), { data: 'x'.repeat(PAYPAL_WEBHOOK_MAX_EVENT_BYTES) }, webhookId));
  await assert.rejects(provider.verify(headers(), cyclic, webhookId));
  await assert.rejects(provider.verify(headers(), event, '../another-app'));
  await assert.rejects(provider.deleteWebhook('../another-app'));
  assert.equal(calls.length, 0);
});

test('only exact SUCCESS verifies and malformed provider responses fail closed', async () => {
  for (const reply of [{}, { verification_status: 'success' }, { verification_status: true }, { verification_status: 'SUCCESS ' }, { verification_status: ['SUCCESS'] }]) {
    const { provider } = setup([oauth(), json(reply)]);
    await assert.rejects(provider.verify(headers(), event, webhookId), error => error instanceof PayPalWebhookError && error.code === 'invalid-response');
  }
});

test('sandbox registration is narrowly subscribed and deletion never follows returned links', async () => {
  const url = 'https://receiver.example.test/api/paypal-sandbox/webhook';
  const { provider, calls } = setup([oauth(), json({ webhooks: [registration()] }), json(registration(), 201), new Response(null, { status: 204 })]);
  assert.deepEqual(await provider.listWebhooks(), [{ id: webhookId, url, eventTypes: [...PAYPAL_INVOICE_WEBHOOK_EVENTS] }]);
  assert.equal((await provider.createWebhook(url)).id, webhookId);
  await provider.deleteWebhook(webhookId);
  assert.equal(calls.length, 4);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { url, event_types: PAYPAL_INVOICE_WEBHOOK_EVENTS.map(name => ({ name })) });
  assert.equal(calls[3].url, `https://api-m.sandbox.paypal.com/v1/notifications/webhooks/${webhookId}`);
  assert.equal(calls[3].init.method, 'DELETE');
});

test('registration rejects wildcards, unrelated payment events and nonpublic or insecure URLs', async () => {
  const { provider, calls } = setup([]);
  for (const url of ['http://receiver.example.test/hook', 'https://localhost/hook', 'https://127.0.0.1/hook', 'https://[::1]/hook', 'https://local.local/hook', 'https://user:pass@receiver.example.test/hook', 'https://receiver.example.test:8443/hook', 'https://receiver.example.test/hook?token=secret']) await assert.rejects(provider.createWebhook(url));
  for (const types of [[], ['*'], ['PAYMENT.CAPTURE.COMPLETED'], ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.PAID']]) await assert.rejects(provider.createWebhook('https://receiver.example.test/hook', types));
  assert.equal(calls.length, 0);
});

test('registration response must match requested URL and subscriptions', async () => {
  for (const response of [registration('https://other.example.test/hook'), registration(undefined, ['PAYMENT.CAPTURE.COMPLETED'])]) {
    const { provider } = setup([oauth(), json(response, 201)]);
    await assert.rejects(provider.createWebhook('https://receiver.example.test/api/paypal-sandbox/webhook'), error => error instanceof PayPalWebhookError && error.code === 'invalid-response');
  }
});

test('invoice event routing accepts both shapes, rejects ambiguity, and never follows links', () => {
  assert.equal(isSupportedPayPalInvoiceEvent('INVOICING.INVOICE.PAID'), true);
  assert.equal(isSupportedPayPalInvoiceEvent('PAYMENT.CAPTURE.COMPLETED'), false);
  assert.equal(invoiceIdFromPayPalEvent(event), invoiceId);
  assert.equal(invoiceIdFromPayPalEvent({ ...event, resource: { invoice: { id: invoiceId } } }), invoiceId);
  assert.equal(invoiceIdFromPayPalEvent({ ...event, resource: { id: 'PAYMENT123', invoice: { id: invoiceId } } }), invoiceId);
  assert.equal(invoiceIdFromPayPalEvent({ ...event, resource: { id: invoiceId, invoice: { id: 'INV2-ABCD-EFGH-IJKL-XXXX' } } }), null);
  assert.equal(invoiceIdFromPayPalEvent({ ...event, event_type: 'PAYMENT.CAPTURE.COMPLETED' }), null);
  assert.equal(invoiceIdFromPayPalEvent({ ...event, resource: { links: [{ href: `https://api-m.sandbox.paypal.com/v2/invoicing/invoices/${invoiceId}` }] } }), null);
  assert.equal(invoiceIdFromPayPalEvent(null), null);
});

test('provider failures and oversized responses reveal no upstream secrets', async () => {
  for (const status of [401, 403, 429, 500, 400]) {
    const { provider } = setup([oauth(), json({ error: 'secret echoed credential', debug_id: 'secret-identifier' }, status)]);
    await assert.rejects(provider.verify(headers(), event, webhookId), error => error instanceof PayPalWebhookError && error.status === status && !error.message.includes('secret'));
  }
  const { provider } = setup([oauth(), json({ verification_status: 'SUCCESS', secret: 'x'.repeat(512 * 1024) })]);
  await assert.rejects(provider.verify(headers(), event, webhookId), error => error instanceof PayPalWebhookError && error.code === 'invalid-response');
});

test('missing configuration, OAuth malformed data and network timeouts fail safely', async () => {
  let calls = 0;
  await assert.rejects(new PayPalSandboxWebhooks({}, (async () => { calls++; return oauth(); }) as typeof fetch).listWebhooks(), error => error instanceof PayPalWebhookError && error.code === 'configuration');
  assert.equal(calls, 0);
  const { provider } = setup([json({ access_token: 'secret', expires_in: 3600, token_type: 'SomethingElse' })]);
  await assert.rejects(provider.listWebhooks(), error => error instanceof PayPalWebhookError && error.code === 'invalid-response' && !error.message.includes('secret'));
  const timedOut = new PayPalSandboxWebhooks(env, (async () => { throw new DOMException('secret details', 'TimeoutError'); }) as typeof fetch);
  await assert.rejects(timedOut.listWebhooks(), error => error instanceof PayPalWebhookError && error.code === 'timeout' && !error.message.includes('secret'));
});
