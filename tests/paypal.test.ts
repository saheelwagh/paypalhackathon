import test from 'node:test';
import assert from 'node:assert/strict';
import { PayPalSandbox, PayPalProviderError, normalizePayPalInvoice, paypalUsdCents, safeSandboxPayerUrl } from '../src/lib/server/paypal';

const env = { PAYPAL_CLIENT_ID: 'test-only-client', PAYPAL_CLIENT_SECRET: 'test-only-secret' };
const invoiceId = 'INV2-ABCD-EFGH-IJKL-MNOP';
const fixture = (overrides: Record<string, unknown> = {}) => ({ id: invoiceId, status: 'DRAFT', detail: { invoice_number: 'FBD-test-1', currency_code: 'USD', metadata: { recipient_view_url: `https://www.sandbox.paypal.com/invoice/p/${invoiceId}` } }, primary_recipients: [{ billing_info: { email_address: 'buyer@example.test' } }], items: [{ name: 'Sandbox scope', description: 'Sandbox scope' }], amount: { currency_code: 'USD', value: '1000.49' }, due_amount: { currency_code: 'USD', value: '1000.49' }, ...overrides });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const oauth = () => json({ access_token: 'test-only-access-token', token_type: 'Bearer', expires_in: 3600 });
const payment = (id = 'TRANSACTION1', value = '1000.49', type = 'PAYPAL') => ({ type, payment_id: id, amount: { currency_code: 'USD', value } });
test('PayPal draft and send stay on fixed sandbox host with exact cents and notifications suppressed', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [oauth(), json(fixture(), 201), json({ href: 'ignored' }), json(fixture({ status: 'SENT' }))];
  const provider = new PayPalSandbox({ ...env, PAYPAL_BASE_URL: 'https://api-m.paypal.com' }, (async (url, init) => { calls.push({ url: String(url), init: init! }); return replies.shift()!; }) as typeof fetch);
  const result = await provider.createDraft({ invoiceNumber: 'FBD-test-1', recipientEmail: 'buyer@example.test', description: 'Sandbox scope', amountCents: 100049 }, 'create-test-1');
  assert.equal(result.amountCents, 100049); assert.equal(result.confirmedCents, 0);
  assert.equal((await provider.sendInvoice(result.id, 'send-test-1')).status, 'SENT');
  assert(calls.every(call => call.url.startsWith('https://api-m.sandbox.paypal.com/')));
  assert.equal(calls.length, 4, 'OAuth token is cached inside the provider');
  assert.deepEqual([...new URLSearchParams(String(calls[0].init.body)).entries()], [['grant_type', 'client_credentials'], ['scope', 'https://uri.paypal.com/services/invoicing']]);
  assert.equal(JSON.parse(String(calls[1].init.body)).items[0].unit_amount.value, '1000.49');
  assert.equal(new Headers(calls[1].init.headers).get('PayPal-Request-Id'), 'create-test-1');
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { send_to_recipient: false, send_to_invoicer: false });
  assert(calls.every(call => call.init.redirect === 'error'));
  assert(!JSON.stringify(result).includes('test-only'));
});
test('PayPal amounts reject exponent, rounding, foreign currency, unsafe cents and forged payer URLs', () => {
  assert.equal(paypalUsdCents('0.01'), 1); assert.equal(paypalUsdCents('1000.49'), 100049);
  for (const value of ['1e3', '1.001', '-1', 'Infinity', '90071992547409.92']) assert.throws(() => paypalUsdCents(value));
  assert.throws(() => normalizePayPalInvoice(fixture({ amount: { currency_code: 'EUR', value: '1.00' } })));
  for (const url of ['https://www.paypal.com/invoice/p/abc', 'https://www.sandbox.paypal.com.evil.test/invoice/p/abc', 'javascript:alert(1)', 'https://user@www.sandbox.paypal.com/invoice/p/abc', 'https://www.sandbox.paypal.com:8443/invoice/p/abc']) assert.equal(safeSandboxPayerUrl(url), undefined);
});
test('pending and manual payment states cannot be converted into confirmed collection', () => {
  const transactions = [payment()];
  for (const status of ['PAYMENT_PENDING', 'SENT', 'MARKED_AS_PAID', 'PAID_EXTERNAL', 'UNKNOWN_NEW_STATUS']) {
    const result = normalizePayPalInvoice(fixture({ status, payments: { paid_amount: { currency_code: 'USD', value: '1000.49' }, transactions } }));
    assert.equal(result.confirmedCents, 0); assert.deepEqual(result.payments, []);
    if (status === 'PAYMENT_PENDING') assert.equal(result.pendingCents, 100049);
  }
  assert.equal(normalizePayPalInvoice(fixture({ status: 'PAID', due_amount: { currency_code: 'USD', value: '0.00' }, payments: { transactions: [payment('OFFLINE', '1000.49', 'EXTERNAL')] } })).confirmedCents, 0);
  assert.equal(normalizePayPalInvoice(fixture({ status: 'PAID', payments: { paid_amount: { currency_code: 'USD', value: '1000.49' } } })).confirmedCents, 0);
});
test('verified PayPal payment IDs deduplicate, partial collection remains exact and refunds reduce it', () => {
  const partial = normalizePayPalInvoice(fixture({ status: 'PARTIALLY_PAID', payments: { transactions: [payment('PAY1', '300.15'), payment('PAY1', '300.15')] } }));
  assert.equal(partial.confirmedCents, 30015); assert.equal(partial.payments.length, 1);
  const refunded = normalizePayPalInvoice(fixture({ status: 'PARTIALLY_REFUNDED', payments: { transactions: [payment()] }, refunds: { transactions: [{ type: 'PAYPAL', refund_id: 'REFUND1', amount: { currency_code: 'USD', value: '250.01' } }] } }));
  assert.equal(refunded.confirmedCents, 75048); assert.equal(refunded.refundedCents, 25001);
  assert.equal(normalizePayPalInvoice(fixture({ status: 'REFUNDED', payments: { transactions: [payment()] } })).confirmedCents, 0);
  assert.throws(() => normalizePayPalInvoice(fixture({ status: 'PAID', payments: { transactions: [payment('PAY1', '10.00'), payment('PAY1', '11.00')] } })));
});
test('unrecognized foreign or incomplete transaction evidence fails closed', () => {
  assert.throws(() => normalizePayPalInvoice(fixture({ status: 'PAID', payments: { transactions: [{ type: 'PAYPAL', payment_id: 'PAY1' }] } })));
  assert.throws(() => normalizePayPalInvoice(fixture({ status: 'PAID', payments: { transactions: [payment('PAY1', '1001.00')] } })));
  assert.throws(() => normalizePayPalInvoice(fixture({ status: 'PAID', payments: { transactions: [{ ...payment(), amount: { currency_code: 'EUR', value: '1.00' } }] } })));
});
test('invoice reconciliation uses exact invoice number and retrieves authoritative details', async () => {
  const calls: string[] = [];
  const replies = [oauth(), json({ items: [{ id: invoiceId, detail: { invoice_number: 'FBD-test-1' } }, { id: 'INV2-ABCD-EFGH-IJKL-QQQQ', detail: { invoice_number: 'FBD-test-10' } }], total_pages: 1 }), json(fixture())];
  const provider = new PayPalSandbox(env, (async (url) => { calls.push(String(url)); return replies.shift()!; }) as typeof fetch);
  assert.equal((await provider.findInvoice('FBD-test-1'))?.id, invoiceId);
  assert(calls[1].includes('/search-invoices?')); assert(calls[2].endsWith(`/${invoiceId}`));
});
test('missing credentials and invalid draft input never contact PayPal', async () => {
  let calls = 0; const fake = (async () => { calls++; return oauth(); }) as typeof fetch;
  await assert.rejects(new PayPalSandbox({}, fake).getInvoice(invoiceId), /not configured/);
  await assert.rejects(new PayPalSandbox(env, fake).createDraft({ invoiceNumber: 'FBD-test-1', recipientEmail: 'buyer@example.test', description: 'Scope', amountCents: 10.1 }, 'test-id'));
  await assert.rejects(new PayPalSandbox(env, fake).getInvoice('../../production'));
  assert.equal(calls, 0);
});
test('uncertain writes remain uncertain and upstream errors do not leak credentials or request data', async () => {
  const replies = [oauth(), json({ message: 'sensitive credential echo' }, 503)];
  const provider = new PayPalSandbox(env, (async () => replies.shift()!) as typeof fetch);
  await assert.rejects(provider.createDraft({ invoiceNumber: 'FBD-test-1', recipientEmail: 'buyer@example.test', description: 'Scope', amountCents: 1 }, 'test-id'), error => error instanceof PayPalProviderError && error.uncertain && !error.message.includes('sensitive'));
  await assert.rejects(new PayPalSandbox(env, (async () => json({ secret: 'sensitive credential echo' }, 401)) as typeof fetch).getInvoice(invoiceId), error => error instanceof PayPalProviderError && error.code === 'authentication' && !error.message.includes('sensitive'));
});
test('post-send read failure never reports send as safely retryable', async () => {
  const replies = [oauth(), json({}), json({}, 404)];
  await assert.rejects(new PayPalSandbox(env, (async () => replies.shift()!) as typeof fetch).sendInvoice(invoiceId, 'send-test'), error => error instanceof PayPalProviderError && error.uncertain);
});

test('Invoicing permission denial explains the sandbox feature while OAuth failure remains distinct', async () => {
  const replies = [oauth(), json({ name: 'NOT_AUTHORIZED', message: 'sensitive upstream echo' }, 403)];
  await assert.rejects(new PayPalSandbox(env, (async () => replies.shift()!) as typeof fetch).getInvoice(invoiceId), error => {
    assert(error instanceof PayPalProviderError); assert.equal(error.status, 403); assert.match(error.message, /Invoicing access.*HTTP 403/); assert.match(error.message, /Apps & Credentials.*sandbox app.*Features/); assert(!error.message.includes('sensitive')); return true;
  });
  await assert.rejects(new PayPalSandbox(env, (async () => json({}, 401)) as typeof fetch).getInvoice(invoiceId), error => {
    assert(error instanceof PayPalProviderError); assert.equal(error.status, 401); assert.match(error.message, /rejected authentication/); assert(!error.message.includes('Enable Invoicing')); return true;
  });
});

test('provider rejection exposes at most three enum codes without leaking echoed error content', async () => {
  const replies = [oauth(), json({ name: 'NOT_ACCEPTABLE', message: 'secret upstream message', debug_id: 'secret-debug-id', details: [{ issue: 'INVALID_RECIPIENT', description: 'secret description', field: 'secret-field' }, { issue: 'ACCOUNT_RESTRICTED' }, { issue: 'FOURTH_CODE_WITHHELD' }, { issue: 'secret recipient@example.test' }] }, 406)];
  await assert.rejects(new PayPalSandbox(env, (async () => replies.shift()!) as typeof fetch).sendInvoice(invoiceId, 'send-test'), error => {
    assert(error instanceof PayPalProviderError); assert.equal(error.status, 406);
    assert.match(error.message, /Provider codes: NOT_ACCEPTABLE, INVALID_RECIPIENT, ACCOUNT_RESTRICTED\./);
    assert(!error.message.includes('secret')); assert(!error.message.includes('FOURTH_CODE_WITHHELD')); return true;
  });
});
