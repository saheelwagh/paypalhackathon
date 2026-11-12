import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxInvoice, SandboxLedger, SandboxTerms } from '../src/lib/sandbox-contract';
import { FileSandboxRepository, type SandboxRepository } from '../src/lib/server/sandbox-repository';
import { SandboxBillingService } from '../src/lib/server/sandbox-service';
import { SandboxWebhookError, SandboxWebhookService, sandboxWebhookStatus } from '../src/lib/server/sandbox-webhooks';
import { PayPalProviderError, type PayPalInvoiceInput, type PayPalInvoiceSnapshot, type PayPalSandboxProvider } from '../src/lib/server/paypal';

class MemoryRepository implements SandboxRepository {
  data: SandboxLedger = { schemaVersion: 1, mode: 'paypal-sandbox', invoices: [] };
  private queue = Promise.resolve();
  async read() { return structuredClone(this.data); }
  async transact<T>(update: (ledger: SandboxLedger) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => { const copy = structuredClone(this.data); const result = await update(copy); this.data = copy; return structuredClone(result); });
    this.queue = task.then(() => {}, () => {}); return task;
  }
}
class Provider implements PayPalSandboxProvider {
  creates = 0; sends = 0; reads = 0; searches = 0; snapshot!: PayPalInvoiceSnapshot;
  beforeRead?: () => Promise<void>;
  async createDraft(input: PayPalInvoiceInput) {
    this.creates++;
    this.snapshot = { provider: 'paypal-sandbox', id: 'INV2-ABCD-EFGH-IJKL-MNOP', invoiceNumber: input.invoiceNumber, status: 'DRAFT', currency: 'USD', recipientEmail: input.recipientEmail, description: input.description, reference: input.reference, amountCents: input.amountCents, dueCents: input.amountCents, confirmedCents: 0, pendingCents: 0, refundedCents: 0, payments: [], checkedAt: new Date().toISOString(), warnings: [] };
    return structuredClone(this.snapshot);
  }
  async sendInvoice(id: string) { assert.equal(id, this.snapshot.id); this.sends++; this.snapshot.status = 'SENT'; return structuredClone(this.snapshot); }
  async getInvoice(id: string) { assert.equal(id, this.snapshot.id); this.reads++; await this.beforeRead?.(); return structuredClone(this.snapshot); }
  async findInvoice(): Promise<PayPalInvoiceSnapshot | null> { this.searches++; throw new Error('Webhook processing must not discover or import invoices'); }
}
class Verifier {
  valid = true; calls = 0; beforeVerify?: () => Promise<void>;
  async verify(_headers: Headers, _event: Record<string, unknown>, webhookId: string) { this.calls++; assert.equal(webhookId, 'TESTWEBHOOK123'); await this.beforeVerify?.(); return this.valid; }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
const terms: SandboxTerms = { projectReference: 'Webhook test project', coverageReference: 'Deposit', recipientEmail: 'buyer@example.test', description: 'Webhook sandbox test', amountCents: 30015, currency: 'USD' };
const event = (id = 'WH-test-1', type = 'INVOICING.INVOICE.PAID', invoiceId = 'INV2-ABCD-EFGH-IJKL-MNOP') => ({ id, event_type: type, resource: { id: invoiceId, status: 'PAID', amount: { currency_code: 'USD', value: '99999999.99' } } });
const registration = () => ({ id: 'TESTWEBHOOK123', url: 'https://receiver.example.test/api/paypal-sandbox/webhook', enabled: true, ownerToken: randomUUID() });
async function invoiceResult(result: ReturnType<SandboxBillingService['execute']>): Promise<SandboxInvoice> { const value = await result; assert('invoice' in value); return value.invoice; }
async function setup(repository: SandboxRepository = new MemoryRepository()) {
  const provider = new Provider(); const billing = new SandboxBillingService(repository, provider); const verifier = new Verifier();
  const invoice = await invoiceResult(billing.execute({ action: 'create', requestId: randomUUID(), terms }));
  await billing.execute({ action: 'send', id: invoice.id, version: invoice.version, confirmSandbox: true });
  provider.reads = 0;
  const service = new SandboxWebhookService(repository, provider, verifier); const owner = registration(); await service.setRegistration(owner);
  return { repository, provider, verifier, service, invoice, owner };
}
const paid = (provider: Provider) => Object.assign(provider.snapshot, { status: 'PAID', confirmedCents: 30015, pendingCents: 0, dueCents: 0, payments: [{ id: 'PAYMENT1', amountCents: 30015 }] });
const makeReady = (repository: SandboxRepository) => repository.transact(ledger => { for (const receipt of ledger.webhooks!.events) receipt.nextAttemptAt = new Date(0).toISOString(); });

test('invalid signatures and malformed events cannot mutate invoices or the durable inbox', async () => {
  const { service, repository, verifier, provider } = await setup(); const original = await repository.read(); verifier.valid = false;
  await assert.rejects(service.receive(new Headers(), event()), error => error instanceof SandboxWebhookError && error.status === 400);
  await assert.rejects(service.receive(new Headers(), { id: 'demo approval', event_type: 'INVOICING.INVOICE.PAID' }), /Invalid/);
  assert.deepEqual(await repository.read(), original); assert.equal(provider.reads, 0); assert.equal(verifier.calls, 1);
});

test('events are verified before deduplication, reordered object keys deduplicate, and conflicting IDs fail', async () => {
  const { service, repository, verifier, provider } = await setup(); paid(provider);
  assert.deepEqual(await service.receive(new Headers(), event()), { accepted: true, duplicate: false });
  assert.deepEqual(await service.receive(new Headers(), { resource: event().resource, event_type: event().event_type, id: event().id }), { accepted: true, duplicate: true });
  await assert.rejects(service.receive(new Headers(), { ...event(), resource: { ...event().resource, status: 'CANCELLED' } }), error => error instanceof SandboxWebhookError && error.status === 409);
  verifier.valid = false;
  await assert.rejects(service.receive(new Headers(), event()), /signature/); verifier.valid = true;
  assert.equal(verifier.calls, 4); assert.equal((await repository.read()).webhooks!.events.length, 1);
  await service.drain(); await service.receive(new Headers(), event()); await service.drain();
  assert.equal(provider.reads, 1, 'Duplicate delivery does not trigger a second reconciliation');
  assert.equal((await repository.read()).invoices[0].confirmedCents, 30015);
});

test('a verified PAID payload cannot supply amounts, payment records or approval; pending GET remains pending', async () => {
  const { service, repository, provider } = await setup();
  Object.assign(provider.snapshot, { status: 'PAYMENT_PENDING', pendingCents: 30015, confirmedCents: 0, payments: [] });
  const approval = (await repository.read()).invoices[0].approval;
  await service.receive(new Headers(), { ...event(), approval: { actor: 'synthetic' }, payment_id: 'FAKE-PAYMENT' });
  assert.deepEqual(await service.drain(), { processed: 1, pending: 0 });
  const ledger = await repository.read(); const current = ledger.invoices[0];
  assert.equal(current.state, 'pending'); assert.equal(current.pendingCents, 30015); assert.equal(current.confirmedCents, 0);
  assert.deepEqual(current.confirmedPayments, []); assert.deepEqual(current.approval, approval);
  assert.equal(current.lastWebhook?.eventId, 'WH-test-1'); assert.equal(ledger.webhooks!.events[0].state, 'processed');
  assert.equal(provider.creates, 1); assert.equal(provider.sends, 1); assert.equal(provider.searches, 0);
});

test('out-of-order invoice notifications always reread the current invoice and cannot undo a refund', async () => {
  const { service, repository, provider } = await setup(); paid(provider);
  await service.receive(new Headers(), event('WH-paid')); await service.drain();
  Object.assign(provider.snapshot, { status: 'PARTIALLY_REFUNDED', confirmedCents: 20014, refundedCents: 10001 });
  await service.receive(new Headers(), event('WH-refund', 'INVOICING.INVOICE.REFUNDED')); await service.drain();
  await service.receive(new Headers(), event('WH-delayed-paid')); await service.drain();
  const invoice = (await repository.read()).invoices[0];
  assert.equal(invoice.state, 'refunded'); assert.equal(invoice.confirmedCents, 20014); assert.equal(provider.reads, 3);
});

test('transient provider failures remain durably queued and recover without another create or send', async () => {
  const { service, repository, provider } = await setup(); paid(provider);
  provider.beforeRead = async () => { throw new PayPalProviderError('unavailable', 'Sandbox temporarily unavailable.'); };
  await service.receive(new Headers(), event());
  assert.deepEqual(await service.drain(), { processed: 0, pending: 1 });
  let ledger = await repository.read(); const receipt = ledger.webhooks!.events[0];
  assert.equal(receipt.state, 'pending'); assert.equal(receipt.attempts, 1); assert.match(receipt.lastError!, /unavailable/);
  assert.equal(ledger.invoices[0].state, 'sent'); assert.equal(ledger.invoices[0].refreshLease, undefined); assert.equal(receipt.leaseToken, undefined);
  await service.drain(); assert.equal(provider.reads, 1, 'Backoff prevents an immediate provider retry');
  provider.beforeRead = undefined; await makeReady(repository);
  assert.deepEqual(await service.drain(), { processed: 1, pending: 0 });
  ledger = await repository.read(); assert.equal(ledger.invoices[0].state, 'paid'); assert.equal(ledger.webhooks!.events[0].attempts, 2);
  assert.equal(provider.creates, 1); assert.equal(provider.sends, 1); assert.equal(provider.searches, 0);
});

test('notification before provider visibility retries briefly while using only current authenticated state', async () => {
  const { service, repository, provider } = await setup();
  await service.receive(new Headers(), event());
  assert.deepEqual(await service.drain(), { processed: 0, pending: 1 });
  assert.equal((await repository.read()).invoices[0].confirmedCents, 0);
  paid(provider); await makeReady(repository);
  assert.deepEqual(await service.drain(), { processed: 1, pending: 0 });
  assert.equal((await repository.read()).invoices[0].state, 'paid');
});

test('cancellation notifications stay queued until the original invoice read exposes cancellation', async () => {
  const { service, repository, provider } = await setup();
  await service.receive(new Headers(), event('WH-cancel', 'INVOICING.INVOICE.CANCELLED'));
  assert.deepEqual(await service.drain(), { processed: 0, pending: 1 });
  let ledger = await repository.read();
  assert.equal(ledger.invoices[0].state, 'sent'); assert.equal(ledger.webhooks!.events[0].state, 'pending');
  provider.snapshot.status = 'CANCELLED'; await makeReady(repository);
  assert.deepEqual(await service.drain(), { processed: 1, pending: 0 });
  ledger = await repository.read(); assert.equal(ledger.invoices[0].state, 'canceled'); assert.equal(ledger.webhooks!.events[0].state, 'processed');
});

test('known invoice notifications remain queued beyond five minutes when their change is not yet visible', async () => {
  for (const type of ['INVOICING.INVOICE.PAID', 'INVOICING.INVOICE.SENT', 'INVOICING.INVOICE.REFUNDED', 'INVOICING.INVOICE.CANCELLED']) {
    const { service, repository, provider } = await setup();
    provider.snapshot.status = type === 'INVOICING.INVOICE.SENT' ? 'DRAFT' : 'SENT';
    await service.receive(new Headers(), event('WH-late-visible', type));
    await repository.transact(ledger => { ledger.webhooks!.events[0].receivedAt = new Date(Date.now() - 301_000).toISOString(); });
    assert.deepEqual(await service.drain(), { processed: 0, pending: 1 }, type);
    const receipt = (await repository.read()).webhooks!.events[0];
    assert.equal(receipt.state, 'pending', type); assert.match(receipt.lastError!, /not exposed/, type); assert.equal(receipt.processedAt, undefined, type);
    assert.equal(provider.reads, 1, type); assert.equal((await repository.read()).invoices[0].confirmedCents, 0, type);
  }
});

test('a stopped webhook listener keeps queued receipts without claiming them or requesting PayPal', async () => {
  const { service, repository, provider, owner } = await setup(); paid(provider);
  await service.receive(new Headers(), event()); await service.stop(owner.ownerToken);
  const queued = (await repository.read()).webhooks!.events[0];
  assert.deepEqual(await service.drain(), { processed: 0, pending: 1 });
  assert.equal(provider.reads, 0); assert.deepEqual((await repository.read()).webhooks!.events[0], queued);
  assert.equal((await repository.read()).invoices[0].state, 'sent');
});

test('unknown invoice events wait for local ownership then expire without discovery or import', async () => {
  const { service, repository, provider } = await setup();
  await service.receive(new Headers(), event('WH-unknown', 'INVOICING.INVOICE.PAID', 'INV2-XXXX-XXXX-XXXX-XXXX'));
  assert.deepEqual(await service.drain(), { processed: 0, pending: 1 });
  await repository.transact(ledger => { ledger.webhooks!.events[0].receivedAt = new Date(Date.now() - 301_000).toISOString(); }); await makeReady(repository);
  assert.deepEqual(await service.drain(), { processed: 1, pending: 0 });
  const ledger = await repository.read(); assert.equal(ledger.invoices.length, 1); assert.equal(ledger.webhooks!.events[0].state, 'ignored');
  assert.equal(provider.reads, 0); assert.equal(provider.searches, 0);
});

test('unsupported event types and ambiguous IDs are authenticated but ignored', async () => {
  const { service, repository, provider, verifier } = await setup();
  await service.receive(new Headers(), event('WH-unrelated', 'PAYMENT.CAPTURE.COMPLETED'));
  await service.receive(new Headers(), { ...event('WH-ambiguous'), resource: { id: provider.snapshot.id, invoice: { id: 'INV2-XXXX-XXXX-XXXX-XXXX' } } });
  await service.drain();
  assert.equal(verifier.calls, 2); assert.equal(provider.reads, 0); assert((await repository.read()).webhooks!.events.every(receipt => receipt.state === 'ignored'));
});

test('parallel workers lease one receipt and a busy invoice retries without concurrent provider reads', async () => {
  const { service, repository, provider } = await setup(); paid(provider);
  await service.receive(new Headers(), event('WH-one')); await service.receive(new Headers(), event('WH-two'));
  const entered = deferred(); const release = deferred(); provider.beforeRead = async () => { entered.resolve(); await release.promise; };
  const first = service.drain(1); await entered.promise;
  const second = await service.drain(1); assert.equal(second.processed, 0); assert.equal(provider.reads, 1);
  release.resolve(); await first; provider.beforeRead = undefined; await makeReady(repository); await service.drain();
  assert.equal(provider.reads, 2); assert.equal((await repository.read()).webhooks!.events.filter(receipt => receipt.state === 'processed').length, 2);
});

test('expired receipt leases recover after a worker restart and retain file-backed deduplication', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fbd-webhook-tests-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ledger.json'); const { service, provider, verifier, repository } = await setup(new FileSandboxRepository(filename)); paid(provider);
  await service.receive(new Headers(), event());
  await repository.transact(ledger => { const receipt = ledger.webhooks!.events[0]; receipt.state = 'processing'; receipt.leaseToken = randomUUID(); receipt.leaseUntil = new Date(0).toISOString(); receipt.attempts = 1; });
  const restarted = new SandboxWebhookService(new FileSandboxRepository(filename), provider, verifier);
  assert.deepEqual(await restarted.drain(), { processed: 1, pending: 0 });
  assert.deepEqual(await restarted.receive(new Headers(), event()), { accepted: true, duplicate: true });
  assert.equal((await repository.read()).webhooks!.events[0].attempts, 2); assert.equal((await repository.read()).invoices[0].confirmedCents, 30015);
});

test('active ownership prevents listener replacement and stopped listeners reject new events', async () => {
  const { service, repository, owner } = await setup();
  assert.equal(sandboxWebhookStatus(await repository.read()).listenerState, 'active');
  await assert.rejects(service.setRegistration(registration()), /Another sandbox webhook worker/);
  await assert.rejects(service.heartbeat(randomUUID()), /no longer owns/);
  await service.stop(randomUUID()); assert.equal(sandboxWebhookStatus(await repository.read()).configured, true);
  await repository.transact(ledger => { ledger.webhooks!.workerHeartbeatAt = new Date(0).toISOString(); });
  assert.equal(sandboxWebhookStatus(await repository.read()).listenerState, 'offline');
  await service.heartbeat(owner.ownerToken); await service.stop(owner.ownerToken);
  assert.equal(sandboxWebhookStatus(await repository.read()).listenerState, 'not-configured');
  await assert.rejects(service.receive(new Headers(), event()), /not configured/);
});

test('listener replacement during signature verification cannot persist an old registration event', async () => {
  const { service, repository, verifier } = await setup(); const entered = deferred(); const release = deferred();
  verifier.beforeVerify = async () => { entered.resolve(); await release.promise; };
  const received = service.receive(new Headers(), event()); await entered.promise;
  await repository.transact(ledger => { ledger.webhooks!.registration!.id = 'REPLACEDWEBHOOK'; });
  release.resolve(); await assert.rejects(received, /listener changed/);
  assert.equal((await repository.read()).webhooks!.events.length, 0);
});

test('remote invoice terms changes fail closed and generic provider errors are redacted in the inbox', async () => {
  const { service, repository, provider } = await setup(); paid(provider); provider.snapshot.amountCents = 1;
  await service.receive(new Headers(), event()); await service.drain();
  let ledger = await repository.read(); assert.equal(ledger.invoices[0].confirmedCents, 0); assert.match(ledger.webhooks!.events[0].lastError!, /terms differ/);
  provider.beforeRead = async () => { throw new Error('secret credential and arbitrary provider details'); }; await makeReady(repository); await service.drain();
  ledger = await repository.read(); assert(!ledger.webhooks!.events[0].lastError!.includes('secret')); assert.equal(ledger.invoices[0].confirmedCents, 0);
});
