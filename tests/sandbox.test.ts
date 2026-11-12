import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxInvoice, SandboxLedger, SandboxTerms } from '../src/lib/sandbox-contract';
import { FileSandboxRepository, type SandboxRepository } from '../src/lib/server/sandbox-repository';
import { SandboxBillingService } from '../src/lib/server/sandbox-service';
import { PayPalProviderError, type PayPalInvoiceInput, type PayPalInvoiceSnapshot, type PayPalSandboxProvider } from '../src/lib/server/paypal';

const terms: SandboxTerms = { projectReference: 'Launch website', coverageReference: 'Deposit', recipientEmail: 'buyer@example.test', description: 'Sandbox scope deposit', amountCents: 30015, currency: 'USD' };
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
  creates = 0; sends = 0; reads = 0; searches = 0;
  snapshot?: PayPalInvoiceSnapshot;
  beforeCreate?: () => Promise<void>; beforeRead?: () => Promise<void>; beforeSend?: () => Promise<void>;
  loseCreate = false; loseSend = false; hideSearch = false;
  async createDraft(input: PayPalInvoiceInput, _requestId: string) {
    this.creates++; await this.beforeCreate?.();
    this.snapshot = { provider: 'paypal-sandbox', id: 'INV2-ABCD-EFGH-IJKL-MNOP', invoiceNumber: input.invoiceNumber, status: 'DRAFT', currency: 'USD', recipientEmail: input.recipientEmail, description: input.description, reference: input.reference, amountCents: input.amountCents, dueCents: input.amountCents, confirmedCents: 0, pendingCents: 0, refundedCents: 0, payments: [], checkedAt: new Date().toISOString(), warnings: [] };
    if (this.loseCreate) throw new PayPalProviderError('timeout', 'Original create was not confirmed.', undefined, true);
    return structuredClone(this.snapshot);
  }
  async sendInvoice(id: string, _requestId: string) {
    assert.equal(id, this.snapshot!.id); this.sends++; await this.beforeSend?.();
    this.snapshot!.status = 'SENT';
    if (this.loseSend) throw new PayPalProviderError('timeout', 'Original send was not confirmed.', undefined, true);
    return structuredClone(this.snapshot!);
  }
  async getInvoice(id: string) { assert.equal(id, this.snapshot!.id); this.reads++; await this.beforeRead?.(); return structuredClone(this.snapshot!); }
  async findInvoice(number: string) { this.searches++; assert.equal(number, this.snapshot!.invoiceNumber); return this.hideSearch ? null : structuredClone(this.snapshot!); }
}
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
async function invoiceResult(result: ReturnType<SandboxBillingService['execute']>): Promise<SandboxInvoice> { const value = await result; assert('invoice' in value); return value.invoice; }
const create = (service: SandboxBillingService, override: Partial<SandboxTerms> = {}, requestId = randomUUID()) => invoiceResult(service.execute({ action: 'create', requestId, terms: { ...terms, ...override } }));
const send = (service: SandboxBillingService, invoice: SandboxInvoice) => invoiceResult(service.execute({ action: 'send', id: invoice.id, version: invoice.version, confirmSandbox: true }));
const refresh = (service: SandboxBillingService, invoice: SandboxInvoice) => invoiceResult(service.execute({ action: 'refresh', id: invoice.id }));
function setup() { const repository = new MemoryRepository(); const provider = new Provider(); return { repository, provider, service: new SandboxBillingService(repository, provider) }; }

test('sandbox drafts need a fresh explicit approval for the exact current version', async () => {
  const { service, provider } = setup(); const draft = await create(service);
  assert.equal(draft.state, 'draft'); assert.equal(draft.approval, undefined); assert.equal(provider.creates, 0);
  await assert.rejects(service.execute({ action: 'send', id: draft.id, version: 1, confirmSandbox: false }), /Invalid sandbox request/);
  const edited = await invoiceResult(service.execute({ action: 'edit', id: draft.id, version: 1, terms: { ...terms, amountCents: 30016 } }));
  assert.equal(edited.version, 2); assert.equal(edited.approval, undefined);
  await assert.rejects(send(service, draft), /changed/);
  const sent = await send(service, edited);
  assert.equal(sent.approval?.version, 2); assert.equal(sent.approval?.actor, 'local-sandbox-owner'); assert.equal(sent.state, 'sent'); assert.equal(sent.confirmedCents, 0);
  assert.equal(provider.snapshot?.amountCents, 30016);
  await assert.rejects(service.execute({ action: 'edit', id: sent.id, version: 2, terms }), /Only an unsubmitted/);
});

test('sandbox replay and canonical duplicate coverage reserve one invoice even under concurrent creation', async () => {
  const { service, provider } = setup(); const requestId = randomUUID();
  const [one, replay] = await Promise.all([create(service, {}, requestId), create(service, {}, requestId)]);
  assert.equal(one.id, replay.id);
  await assert.rejects(create(service, { amountCents: 10 }, requestId), /different invoice terms/);
  await assert.rejects(create(service, { projectReference: '  LAUNCH   WEBSITE ', coverageReference: 'DEPOSIT' }), /already has a sandbox invoice/);
  const outcomes = await Promise.allSettled([create(service, { coverageReference: 'Animation' }), create(service, { coverageReference: 'animation' })]);
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(provider.creates, 0);
});

test('parallel send and later replay cannot create or send a second provider invoice', async () => {
  const { service, provider } = setup(); const draft = await create(service);
  const entered = deferred(); const release = deferred(); provider.beforeCreate = async () => { entered.resolve(); await release.promise; };
  const first = send(service, draft); await entered.promise;
  await assert.rejects(send(service, draft), /operation in progress/);
  release.resolve(); const sent = await first;
  await assert.rejects(send(service, sent), /already submitted/);
  assert.equal(provider.creates, 1); assert.equal(provider.sends, 1);
});

test('demo IDs, approvals, payments and provider snapshots are rejected at the sandbox command boundary', async () => {
  const { service, provider } = setup();
  await assert.rejects(service.execute({ action: 'create', requestId: randomUUID(), terms, approval: { approved: true } }), /Invalid sandbox request/);
  await assert.rejects(service.execute({ action: 'create', requestId: randomUUID(), terms, confirmedCents: 30015 }), /Invalid sandbox request/);
  await assert.rejects(service.execute({ action: 'send', id: 'demo_invoice_1', version: 1, confirmSandbox: true }), /Invalid sandbox request/);
  const draft = await create(service);
  await assert.rejects(service.execute({ action: 'refresh', id: draft.id, provider: { status: 'PAID', confirmedCents: 30015 } }), /Invalid sandbox request/);
  await assert.rejects(service.execute({ action: 'send', id: draft.id, version: 1, confirmSandbox: true, approval: 'demo-approval' }), /Invalid sandbox request/);
  assert.equal(provider.creates, 0); assert.equal(provider.reads, 0);
});

test('pending status preserves previously confirmed cents and never counts the pending remainder as paid', async () => {
  const { service, provider } = setup(); const draft = await create(service, { amountCents: 100049 }); await send(service, draft);
  Object.assign(provider.snapshot!, { status: 'PARTIALLY_PAID', confirmedCents: 30015, dueCents: 70034, payments: [{ id: 'PAYMENT1', amountCents: 30015 }] });
  const partial = await refresh(service, draft); assert.equal(partial.confirmedCents, 30015);
  Object.assign(provider.snapshot!, { status: 'PAYMENT_PENDING', confirmedCents: 0, pendingCents: 100049, payments: [] });
  const pending = await refresh(service, draft);
  assert.equal(pending.state, 'pending'); assert.equal(pending.confirmedCents, 30015); assert.equal(pending.pendingCents, 70034);
  assert.deepEqual(pending.confirmedPayments, [{ id: 'PAYMENT1', amountCents: 30015 }]);
  assert.deepEqual(pending.provider?.payments, [], 'latest pending provider snapshot stays distinct from prior settled evidence');
  Object.assign(provider.snapshot!, { status: 'PAID', confirmedCents: 100049, pendingCents: 0, dueCents: 0, payments: [{ id: 'PAYMENT1', amountCents: 30015 }, { id: 'PAYMENT2', amountCents: 70034 }] });
  const paid = await refresh(service, draft); assert.equal(paid.state, 'paid'); assert.equal(paid.confirmedCents, 100049);
  Object.assign(provider.snapshot!, { status: 'PARTIALLY_REFUNDED', confirmedCents: 75048, refundedCents: 25001 });
  assert.equal((await refresh(service, draft)).confirmedCents, 75048);
});

test('PayPal automatic cancellation is a canceled invoice, not an outstanding sent invoice', async () => {
  const { service, provider } = setup(); const draft = await create(service); await send(service, draft);
  provider.snapshot!.status = 'AUTO_CANCELLED';
  const canceled = await refresh(service, draft);
  assert.equal(canceled.state, 'canceled'); assert.equal(canceled.confirmedCents, 0);
  await assert.rejects(send(service, canceled), /already submitted/);
  assert.equal(provider.creates, 1); assert.equal(provider.sends, 1);
});

test('unknown creation reconciles its saved invoice number and requires another review before original-draft send', async () => {
  const { service, provider } = setup(); const draft = await create(service); provider.loseCreate = true;
  const unknown = await send(service, draft); assert.equal(unknown.state, 'unknown'); assert.equal(unknown.provider, undefined);
  await assert.rejects(send(service, unknown), /already submitted or uncertain/);
  provider.hideSearch = true; const missing = await refresh(service, draft); assert.equal(missing.state, 'unknown'); assert.equal(provider.creates, 1);
  provider.hideSearch = false; const recovered = await refresh(service, draft); assert.equal(recovered.state, 'draft'); assert.equal(recovered.provider?.id, provider.snapshot?.id);
  assert.equal(provider.sends, 0);
  const sent = await send(service, recovered); assert.equal(sent.state, 'sent'); assert.equal(provider.creates, 1); assert.equal(provider.sends, 1);
});

test('unknown send refreshes the original provider invoice without issuing or sending another one', async () => {
  const { service, provider } = setup(); const draft = await create(service); provider.loseSend = true;
  const unknown = await send(service, draft); assert.equal(unknown.state, 'unknown'); assert(unknown.provider);
  await assert.rejects(send(service, unknown), /already submitted or uncertain/);
  const reconciled = await refresh(service, unknown); assert.equal(reconciled.state, 'sent'); assert.equal(reconciled.provider?.id, unknown.provider?.id);
  assert.equal(provider.creates, 1); assert.equal(provider.sends, 1); assert.equal(provider.searches, 0);
});

test('provider-side amount or scope changes block sending the reviewed version', async () => {
  for (const patch of [{ amountCents: 1 }, { description: 'Changed remotely' }, { recipientEmail: 'different@example.test' }, { reference: 'forged-reference' }]) {
    const { service, provider } = setup(); const draft = await create(service);
    provider.beforeRead = async () => { Object.assign(provider.snapshot!, patch); };
    const result = await send(service, draft);
    assert.equal(result.state, 'unknown'); assert.match(result.lastError!, /terms differ/); assert.equal(provider.sends, 0);
  }
});

test('a refresh lease prevents parallel status reads and releases after provider read failure', async () => {
  const { service, provider } = setup(); const draft = await create(service); await send(service, draft);
  const entered = deferred(); const release = deferred(); provider.beforeRead = async () => { entered.resolve(); await release.promise; };
  const first = refresh(service, draft); await entered.promise;
  await assert.rejects(refresh(service, draft), /operation in progress/);
  release.resolve(); await first;
  provider.beforeRead = async () => { throw new PayPalProviderError('unavailable', 'Read unavailable.'); };
  await assert.rejects(refresh(service, draft), /Read unavailable/);
  provider.beforeRead = undefined; assert.equal((await refresh(service, draft)).state, 'sent');
});

test('a stale send failure must not overwrite a newer reconciled payment result', async () => {
  const { service, provider, repository } = setup(); const draft = await create(service);
  const entered = deferred(); const release = deferred();
  provider.beforeSend = async () => { entered.resolve(); await release.promise; throw new PayPalProviderError('timeout', 'Late original failure.', undefined, true); };
  const original = send(service, draft); await entered.promise;
  await repository.transact(ledger => { ledger.invoices[0].operation!.leaseUntil = new Date(0).toISOString(); });
  Object.assign(provider.snapshot!, { status: 'PAID', confirmedCents: 30015, dueCents: 0, payments: [{ id: 'PAYMENT1', amountCents: 30015 }] });
  assert.equal((await refresh(service, draft)).state, 'paid');
  release.resolve(); await original;
  const final = await repository.read(); assert.equal(final.invoices[0].state, 'paid'); assert.equal(final.invoices[0].confirmedCents, 30015); assert.equal(final.invoices[0].lastError, undefined);
});

test('file ledger persists exact values, serializes coverage reservation across instances and rejects Demo files', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fbd-sandbox-tests-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ledger.json');
  const first = new SandboxBillingService(new FileSandboxRepository(filename), new Provider());
  const second = new SandboxBillingService(new FileSandboxRepository(filename), new Provider());
  const outcomes = await Promise.allSettled([create(first), create(second)]); assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1);
  const persisted = await new FileSandboxRepository(filename).read(); assert.equal(persisted.invoices.length, 1); assert.equal(persisted.invoices[0].terms.amountCents, 30015);
  assert(!String(await readFile(filename)).includes('PAYPAL_CLIENT_SECRET'));
  await writeFile(filename, JSON.stringify({ schemaVersion: 1, mode: 'demo', invoices: [] }));
  await assert.rejects(new FileSandboxRepository(filename).read(), /invalid/);
});

test('definite credential rejection permits an edited draft but never authorizes a stale retry', async () => {
  const { service, provider } = setup(); const draft = await create(service);
  provider.beforeCreate = async () => { throw new PayPalProviderError('authentication', 'Sandbox credential rejected.', 401); };
  const rejected = await send(service, draft); assert.equal(rejected.state, 'draft'); assert.equal(rejected.operation, undefined);
  const edited = await invoiceResult(service.execute({ action: 'edit', id: draft.id, version: 1, terms: { ...terms, description: 'Fresh reviewed scope' } }));
  assert.equal(edited.approval, undefined);
  await assert.rejects(send(service, draft), /changed/);
  provider.beforeCreate = undefined;
  assert.equal((await send(service, edited)).state, 'sent');
});

test('file transaction failures roll back and malformed persisted approval or pending values fail closed', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fbd-sandbox-invalid-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ledger.json'); const repository = new FileSandboxRepository(filename);
  const service = new SandboxBillingService(repository, new Provider()); const draft = await create(service);
  await assert.rejects(repository.transact(ledger => { ledger.invoices[0].terms.amountCents = 1; throw new Error('Abort update'); }), /Abort update/);
  assert.equal((await repository.read()).invoices[0].terms.amountCents, 30015);
  const original = await repository.read();
  for (const patch of [{ pendingCents: -1 }, { state: 'simulated-paid' }, { approval: { version: 1, termsHash: 'fake', approvedAt: draft.createdAt, actor: 'demo-owner' } }]) {
    const corrupt = structuredClone(original); Object.assign(corrupt.invoices[0], patch); await writeFile(filename, JSON.stringify(corrupt));
    await assert.rejects(repository.read(), /invalid/);
  }
});
