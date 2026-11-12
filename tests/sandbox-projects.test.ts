import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SandboxInvoice, SandboxLedger } from '../src/lib/sandbox-contract';
import { FileSandboxRepository, type SandboxRepository } from '../src/lib/server/sandbox-repository';
import { SandboxBillingService } from '../src/lib/server/sandbox-service';
import { SandboxWebhookService } from '../src/lib/server/sandbox-webhooks';
import { PayPalProviderError, type PayPalInvoiceInput, type PayPalInvoiceSnapshot, type PayPalSandboxProvider } from '../src/lib/server/paypal';
import { SandboxProjectService } from '../src/lib/server/sandbox-project-service';
import type { SandboxProjectTerms, SandboxProjectView } from '../src/lib/sandbox-project-contract';

/** Provider fixtures exercise application invariants, never claim an actual PayPal transaction. */
class MemoryRepository implements SandboxRepository {
  data: SandboxLedger = { schemaVersion: 1, mode: 'paypal-sandbox', invoices: [] };
  private queue = Promise.resolve();
  async read() { return structuredClone(this.data); }
  async transact<T>(update: (ledger: SandboxLedger) => T | Promise<T>): Promise<T> {
    const task = this.queue.then(async () => {
      const copy = structuredClone(this.data); const result = await update(copy);
      this.data = copy; return structuredClone(result);
    });
    this.queue = task.then(() => {}, () => {}); return task;
  }
}
class Provider implements PayPalSandboxProvider {
  creates = 0; sends = 0; reads = 0; searches = 0;
  invoices = new Map<string, PayPalInvoiceSnapshot>();
  loseCreate = false; loseSend = false;
  beforeSend?: (id: string) => Promise<void>;
  beforeRead?: (id: string) => Promise<void>;
  async createDraft(input: PayPalInvoiceInput) {
    const id = `INV2-TEST-${String(++this.creates).padStart(4, '0')}`;
    const snapshot: PayPalInvoiceSnapshot = { provider: 'paypal-sandbox', id, invoiceNumber: input.invoiceNumber, status: 'DRAFT', currency: 'USD', recipientEmail: input.recipientEmail, description: input.description, reference: input.reference, amountCents: input.amountCents, dueCents: input.amountCents, confirmedCents: 0, pendingCents: 0, refundedCents: 0, payments: [], checkedAt: new Date().toISOString(), warnings: [] };
    this.invoices.set(id, snapshot);
    if (this.loseCreate) throw new PayPalProviderError('timeout', 'Original fixture create was not confirmed.', undefined, true);
    return structuredClone(snapshot);
  }
  async sendInvoice(id: string) {
    this.sends++; await this.beforeSend?.(id);
    this.snapshot(id).status = 'UNPAID';
    if (this.loseSend) throw new PayPalProviderError('timeout', 'Original fixture send was not confirmed.', undefined, true);
    return structuredClone(this.snapshot(id));
  }
  async getInvoice(id: string) { this.reads++; await this.beforeRead?.(id); return structuredClone(this.snapshot(id)); }
  async findInvoice(number: string) { this.searches++; const invoice = [...this.invoices.values()].find(invoice => invoice.invoiceNumber === number); return invoice ? structuredClone(invoice) : null; }
  snapshot(id: string) { const snapshot = this.invoices.get(id); assert(snapshot, 'Original fixture invoice must exist'); return snapshot; }
  settle(invoice: SandboxInvoice, cents = invoice.terms.amountCents) {
    const snapshot = this.snapshot(invoice.provider!.id);
    Object.assign(snapshot, { status: cents === snapshot.amountCents ? 'PAID' : 'PARTIALLY_PAID', dueCents: snapshot.amountCents - cents, confirmedCents: cents, pendingCents: 0, refundedCents: 0, payments: [{ id: `PAYMENT${invoice.invoiceNumber.replaceAll('-', '')}`, amountCents: cents }], checkedAt: new Date().toISOString() });
  }
  pending(invoice: SandboxInvoice) {
    const snapshot = this.snapshot(invoice.provider!.id);
    Object.assign(snapshot, { status: 'PAYMENT_PENDING', confirmedCents: 0, pendingCents: snapshot.amountCents, payments: [], checkedAt: new Date().toISOString() });
  }
  refund(invoice: SandboxInvoice, cents: number) {
    const snapshot = this.snapshot(invoice.provider!.id);
    Object.assign(snapshot, { status: cents === snapshot.amountCents ? 'REFUNDED' : 'PARTIALLY_REFUNDED', confirmedCents: snapshot.amountCents - cents, refundedCents: cents, pendingCents: 0, checkedAt: new Date().toISOString() });
  }
}
async function asInvoice(result: ReturnType<SandboxBillingService['execute']>): Promise<SandboxInvoice> { const value = await result; assert('invoice' in value); return value.invoice; }

const terms: SandboxProjectTerms = { title: 'Webhook funded website', recipientEmail: 'buyer@example.test', scope: 'Five pages and launch handover; animation excluded.', baseAmountCents: 100000, depositCents: 30000, currency: 'USD' };
const changeTerms = { title: 'Hero animation', description: 'An additional agreed hero animation outside the baseline.', amountCents: 25000 };
function setup(repository: SandboxRepository = new MemoryRepository()) {
  const provider = new Provider(); const billing = new SandboxBillingService(repository, provider);
  const projects = new SandboxProjectService(repository);
  const webhooks = new SandboxWebhookService(repository, provider, { verify: async () => true });
  return { repository, provider, billing, projects, webhooks };
}
type Context = ReturnType<typeof setup>;
async function asProject(result: ReturnType<SandboxProjectService['execute']>): Promise<SandboxProjectView> {
  const value = await result; assert('project' in value); return value.project;
}
async function current(context: Context, id: string): Promise<SandboxProjectView> {
  const result = await context.projects.execute({ action: 'list' }); assert('projects' in result);
  const project = result.projects.find(view => view.project.id === id); assert(project); return project;
}
async function createProject(context: Context, overrides: Partial<SandboxProjectTerms> = {}, agreed = true) {
  let view = await asProject(context.projects.execute({ action: 'create-project', requestId: randomUUID(), terms: { ...terms, ...overrides } }));
  if (agreed) view = await asProject(context.projects.execute({ action: 'agree-project', id: view.project.id, revision: view.project.revision, version: view.project.version, confirmSandbox: true }));
  return view;
}
async function change(context: Context, id: string, overrides = {}) {
  let view = await current(context, id);
  view = await asProject(context.projects.execute({ action: 'add-change', id, revision: view.project.revision, requestId: randomUUID(), terms: { ...changeTerms, ...overrides } }));
  const addition = view.project.changes.at(-1)!;
  view = await asProject(context.projects.execute({ action: 'approve-change', id, revision: view.project.revision, changeId: addition.id, version: addition.version, confirmSandbox: true }));
  view = await asProject(context.projects.execute({ action: 'agree-change', id, revision: view.project.revision, changeId: addition.id, version: addition.version, confirmSandbox: true }));
  return { view, changeId: addition.id };
}
async function prepare(context: Context, id: string, purpose: 'deposit' | 'change' | 'final', changeId?: string) {
  const view = await current(context, id);
  const version = purpose === 'change' ? view.project.changes.find(change => change.id === changeId)!.version : purpose === 'final' ? view.project.delivery!.version : view.project.version;
  const result = await context.projects.execute({ action: 'prepare-invoice', id, revision: view.project.revision, version, purpose, ...(changeId ? { changeId } : {}) });
  assert('invoice' in result && result.invoice); return result.invoice;
}
async function send(context: Context, invoice: SandboxInvoice) { return asInvoice(context.billing.execute({ action: 'send', id: invoice.id, version: invoice.version, confirmSandbox: true })); }
async function refresh(context: Context, invoice: SandboxInvoice) { return asInvoice(context.billing.execute({ action: 'refresh', id: invoice.id })); }
async function pay(context: Context, invoice: SandboxInvoice) { context.provider.settle(invoice); return refresh(context, invoice); }
async function delivered(context: Context, id: string) {
  let view = await current(context, id);
  view = await asProject(context.projects.execute({ action: 'submit-delivery', id, revision: view.project.revision, summary: 'All agreed pages and animation delivered for sandbox review.' }));
  return asProject(context.projects.execute({ action: 'accept-delivery', id, revision: view.project.revision, version: view.project.delivery!.version, confirmSandbox: true }));
}

test('sandbox project journey reserves distinct exact deposit/change/final invoices and derives funding from provider reads', async () => {
  const context = setup(); let view = await createProject(context); const id = view.project.id;
  assert.equal(view.funding.depositFunded, false); assert.equal(view.funding.complete, false);
  let deposit = await prepare(context, id, 'deposit'); assert.equal(deposit.terms.amountCents, 30000);
  deposit = await send(context, deposit); await pay(context, deposit);
  view = await current(context, id); assert.equal(view.funding.depositFunded, true);
  const { changeId } = await change(context, id);
  view = await current(context, id); assert.equal(view.funding.changesFunded, false); assert.equal(view.funding.canSubmitDelivery, false);
  let extra = await prepare(context, id, 'change', changeId); assert.equal(extra.terms.amountCents, 25000);
  extra = await send(context, extra); await pay(context, extra);
  view = await current(context, id); assert.equal(view.funding.canSubmitDelivery, true);
  await delivered(context, id);
  let final = await prepare(context, id, 'final'); assert.equal(final.terms.amountCents, 70000, 'Final is baseline remainder; it must not rebill the extra');
  final = await send(context, final); await pay(context, final);
  view = await current(context, id); assert.equal(view.funding.complete, true);
  assert.deepEqual({ agreed: view.funding.agreedCents, invoiced: view.funding.invoicedCents, confirmed: view.funding.confirmedCents, outstanding: view.funding.outstandingCents, unbilled: view.funding.unbilledCents }, { agreed: 125000, invoiced: 125000, confirmed: 125000, outstanding: 0, unbilled: 0 });
  assert.equal(new Set(view.invoices.map(invoice => invoice.id)).size, 3);
  assert.equal(view.invoices.reduce((sum, invoice) => sum + invoice.terms.amountCents, 0), 125000);
  assert.equal(view.invoices.reduce((sum, invoice) => sum + invoice.confirmedCents, 0), 125000);
  assert.equal(context.provider.creates, 3); assert.equal(context.provider.sends, 3);
});

test('pending and partial collections never unlock project delivery, and an extra must be funded independently', async () => {
  const context = setup(); const { project } = await createProject(context); const id = project.id;
  let deposit = await send(context, await prepare(context, id, 'deposit'));
  context.provider.settle(deposit, 29999); await refresh(context, deposit);
  let view = await current(context, id); assert.equal(view.funding.depositFunded, false);
  await assert.rejects(delivered(context, id));
  context.provider.pending(deposit); deposit = await refresh(context, deposit);
  assert.equal(deposit.confirmedCents, 29999); assert.equal(deposit.pendingCents, 1);
  view = await current(context, id); assert.equal(view.funding.depositFunded, false);
  await pay(context, deposit); const { changeId } = await change(context, id);
  let extra = await send(context, await prepare(context, id, 'change', changeId));
  context.provider.pending(extra); extra = await refresh(context, extra);
  assert.equal(extra.confirmedCents, 0);
  view = await current(context, id); assert.equal(view.funding.depositFunded, true); assert.equal(view.funding.changesFunded, false);
  await assert.rejects(delivered(context, id));
  await pay(context, extra); view = await current(context, id); assert.equal(view.funding.canSubmitDelivery, true);
});

test('delivery acceptance remains historical after refunds while funding and a prepared final send are blocked', async () => {
  const context = setup(); const { project } = await createProject(context); const id = project.id;
  const deposit = await send(context, await prepare(context, id, 'deposit')); await pay(context, deposit);
  const deliveredView = await delivered(context, id); const delivery = structuredClone(deliveredView.project.delivery);
  const final = await prepare(context, id, 'final'); const before = context.provider.creates;
  context.provider.refund(deposit, 1); await refresh(context, deposit);
  let view = await current(context, id);
  assert.deepEqual(view.project.delivery, delivery); assert.equal(view.funding.canPrepareFinal, false); assert.equal(view.funding.complete, false);
  await assert.rejects(send(context, final)); assert.equal(context.provider.creates, before);
  await pay(context, deposit); const sentFinal = await send(context, final); await pay(context, sentFinal);
  assert.equal((await current(context, id)).funding.complete, true);
  context.provider.refund(sentFinal, 1); await refresh(context, sentFinal);
  view = await current(context, id); assert.equal(view.funding.complete, false); assert.deepEqual(view.project.delivery, delivery);
});

test('stale baseline/change decisions fail and editing clears old approvals before acceptance', async () => {
  const context = setup(); const draft = await createProject(context, {}, false); const id = draft.project.id;
  let view = await asProject(context.projects.execute({ action: 'edit-project', id, revision: draft.project.revision, version: draft.project.version, terms: { ...terms, scope: 'Revised page scope.' } }));
  assert.equal(view.project.version, draft.project.version + 1);
  await assert.rejects(context.projects.execute({ action: 'agree-project', id, revision: view.project.revision, version: draft.project.version, confirmSandbox: true }));
  view = await asProject(context.projects.execute({ action: 'agree-project', id, revision: view.project.revision, version: view.project.version, confirmSandbox: true }));
  await assert.rejects(context.projects.execute({ action: 'edit-project', id, revision: view.project.revision, version: view.project.version, terms }));
  view = await asProject(context.projects.execute({ action: 'add-change', id, revision: view.project.revision, requestId: randomUUID(), terms: changeTerms }));
  const original = view.project.changes.at(-1)!;
  view = await asProject(context.projects.execute({ action: 'approve-change', id, revision: view.project.revision, changeId: original.id, version: original.version, confirmSandbox: true }));
  view = await asProject(context.projects.execute({ action: 'edit-change', id, revision: view.project.revision, changeId: original.id, version: original.version, terms: { ...changeTerms, amountCents: 25100 } }));
  const edited = view.project.changes.find(change => change.id === original.id)!;
  assert.equal(edited.version, original.version + 1);
  await assert.rejects(context.projects.execute({ action: 'agree-change', id, revision: view.project.revision, changeId: original.id, version: original.version, confirmSandbox: true }));
  await assert.rejects(context.projects.execute({ action: 'agree-change', id, revision: view.project.revision, changeId: edited.id, version: edited.version, confirmSandbox: true }), 'The edit must revoke owner approval, even with a current version');
  await assert.rejects(prepare(context, id, 'change', edited.id));
  view = await asProject(context.projects.execute({ action: 'approve-change', id, revision: view.project.revision, changeId: edited.id, version: edited.version, confirmSandbox: true }));
  view = await asProject(context.projects.execute({ action: 'agree-change', id, revision: view.project.revision, changeId: edited.id, version: edited.version, confirmSandbox: true }));
  await assert.rejects(context.projects.execute({ action: 'edit-change', id, revision: view.project.revision, changeId: edited.id, version: edited.version, terms: changeTerms }));
});

test('concurrent preparations and retries reserve one original invoice per stable project obligation', async () => {
  const context = setup(); const { project } = await createProject(context); const id = project.id;
  const command = { action: 'prepare-invoice', id, revision: project.revision, version: project.version, purpose: 'deposit' };
  const results = await Promise.allSettled([context.projects.execute(command), context.projects.execute(command)]);
  assert(results.some(result => result.status === 'fulfilled'));
  let ledger = await context.repository.read(); assert.equal(ledger.invoices.length, 1); assert.equal(context.provider.creates, 0);
  const original = ledger.invoices[0];
  const replay = await prepare(context, id, 'deposit'); assert.equal(replay.id, original.id);
  ledger = await context.repository.read(); assert.equal(ledger.invoices.length, 1);
  const sent = await send(context, original); context.provider.loseSend = false;
  await assert.rejects(send(context, sent));
  assert.equal(context.provider.creates, 1); assert.equal(context.provider.sends, 1);
});

test('bound invoice terms cannot be changed through the standalone API or manufactured by client input', async () => {
  const context = setup(); const { project } = await createProject(context); const invoice = await prepare(context, project.id, 'deposit');
  await assert.rejects(context.billing.execute({ action: 'edit', id: invoice.id, version: invoice.version, terms: { ...invoice.terms, amountCents: 1 } }));
  await assert.rejects(context.billing.execute({ action: 'create', requestId: randomUUID(), terms: { ...invoice.terms, coverageReference: 'Forged deposit' }, projectBinding: invoice.projectBinding }));
  await assert.rejects(context.projects.execute({ action: 'prepare-invoice', id: project.id, revision: project.revision, version: project.version, purpose: 'deposit', amountCents: 1 }));
  await assert.rejects(context.projects.execute({ action: 'create-project', requestId: randomUUID(), terms, agreement: { actor: 'demo-client', version: 1 } }));
  await assert.rejects(context.projects.execute({ action: 'agree-project', id: 'demo_acme', revision: 1, version: 1, confirmSandbox: true }));
  await assert.rejects(context.projects.execute({ action: 'agree-project', id: project.id, revision: project.revision, version: project.version, confirmSandbox: false }));
  assert.equal(context.provider.creates, 0);
});

test('legacy paid invoices and another project never fund a project with matching human labels or buyer', async () => {
  const context = setup(); const first = await createProject(context); const second = await createProject(context);
  const standalone = await asInvoice(context.billing.execute({ action: 'create', requestId: randomUUID(), terms: { projectReference: terms.title, coverageReference: 'Deposit', recipientEmail: terms.recipientEmail, description: terms.scope, amountCents: terms.depositCents, currency: 'USD' } }));
  await pay(context, await send(context, standalone));
  assert.equal((await current(context, first.project.id)).funding.depositFunded, false);
  assert.equal((await current(context, second.project.id)).funding.depositFunded, false);
  const bound = await send(context, await prepare(context, first.project.id, 'deposit')); await pay(context, bound);
  const firstNow = await current(context, first.project.id); const secondNow = await current(context, second.project.id);
  assert.equal(firstNow.funding.depositFunded, true); assert.equal(firstNow.invoices.length, 1);
  assert.equal(secondNow.funding.depositFunded, false); assert.equal(secondNow.invoices.length, 0);
});

test('an uncertain project send reconciles its original provider invoice without creating a second obligation', async () => {
  const context = setup(); const { project } = await createProject(context); const draft = await prepare(context, project.id, 'deposit');
  context.provider.loseSend = true; const unknown = await send(context, draft); assert.equal(unknown.state, 'unknown');
  assert.equal((await current(context, project.id)).funding.depositFunded, false);
  await assert.rejects(send(context, unknown));
  assert.equal((await prepare(context, project.id, 'deposit')).id, unknown.id);
  assert.equal((await context.repository.read()).invoices.length, 1);
  const reconciled = await refresh(context, unknown); assert.equal(reconciled.provider!.id, unknown.provider!.id);
  await pay(context, reconciled);
  assert.equal((await current(context, project.id)).funding.depositFunded, true);
  assert.equal(context.provider.creates, 1); assert.equal(context.provider.sends, 1);
});

test('a verified webhook updates only the bound project funding and duplicate delivery does not double count', async () => {
  const context = setup(); const one = await createProject(context); const two = await createProject(context, { title: 'Other project' });
  const deposit = await send(context, await prepare(context, one.project.id, 'deposit'));
  await context.webhooks.setRegistration({ id: 'TESTWEBHOOK123', url: 'https://receiver.example.test/api/paypal-sandbox/webhook', enabled: true, ownerToken: randomUUID() });
  context.provider.settle(deposit);
  const event = { id: 'WH-PROJECT-PAID-1', event_type: 'INVOICING.INVOICE.PAID', resource: { id: deposit.provider!.id, amount: { value: '999999.99' } } };
  await context.webhooks.receive(new Headers(), event); await context.webhooks.drain();
  await context.webhooks.receive(new Headers(), event); await context.webhooks.drain();
  const oneNow = await current(context, one.project.id);
  assert.equal(oneNow.funding.depositFunded, true); assert.equal(oneNow.invoices[0].confirmedCents, 30000);
  assert.equal((await current(context, two.project.id)).funding.depositFunded, false);
  assert.equal((await context.repository.read()).webhooks!.events.length, 1);
});

test('project amounts retain exact cents and reject invalid deposit/final schedules', async () => {
  const context = setup();
  for (const override of [{ baseAmountCents: 1000.49 }, { depositCents: 0 }, { depositCents: 100000 }, { depositCents: 100001 }]) {
    await assert.rejects(createProject(context, override));
  }
  const { project } = await createProject(context, { baseAmountCents: 100049, depositCents: 30015 });
  const deposit = await send(context, await prepare(context, project.id, 'deposit')); assert.equal(deposit.terms.amountCents, 30015);
  await pay(context, deposit); await delivered(context, project.id);
  const final = await prepare(context, project.id, 'final'); assert.equal(final.terms.amountCents, 70034);
  assert.equal(deposit.terms.amountCents + final.terms.amountCents, 100049);
});

test('a delivery decision is version-bound and cannot be accepted before funding', async () => {
  const context = setup(); const { project } = await createProject(context); const id = project.id;
  await assert.rejects(context.projects.execute({ action: 'accept-delivery', id, revision: project.revision, version: 1, confirmSandbox: true }));
  const deposit = await send(context, await prepare(context, id, 'deposit')); await pay(context, deposit);
  let view = await current(context, id);
  view = await asProject(context.projects.execute({ action: 'submit-delivery', id, revision: view.project.revision, summary: 'Initial delivery for review.' }));
  const firstVersion = view.project.delivery!.version;
  view = await asProject(context.projects.execute({ action: 'submit-delivery', id, revision: view.project.revision, summary: 'Corrected delivery for a fresh review.' }));
  assert.equal(view.project.delivery!.version, firstVersion + 1);
  await assert.rejects(context.projects.execute({ action: 'accept-delivery', id, revision: view.project.revision, version: firstVersion, confirmSandbox: true }));
  context.provider.refund(deposit, 1); await refresh(context, deposit);
  await assert.rejects(context.projects.execute({ action: 'accept-delivery', id, revision: view.project.revision, version: view.project.delivery!.version, confirmSandbox: true }));
  assert.equal((await current(context, id)).project.delivery!.acceptance, undefined);
});

test('legacy invoice files remain readable and project bindings/decisions survive a repository restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'fbd-project-ledger-')); t.after(() => rm(directory, { recursive: true, force: true }));
  const filename = join(directory, 'ledger.json'); const context = setup(new FileSandboxRepository(filename));
  const standalone = await asInvoice(context.billing.execute({ action: 'create', requestId: randomUUID(), terms: { projectReference: 'Before projects existed', coverageReference: 'Legacy item', recipientEmail: terms.recipientEmail, description: 'Separate old sandbox invoice', amountCents: 149, currency: 'USD' } }));
  await pay(context, await send(context, standalone));
  const oldText = await readFile(filename, 'utf8'); assert.equal(JSON.parse(oldText).projects, undefined);
  assert.equal((await new FileSandboxRepository(filename).read()).invoices[0].id, standalone.id);
  const { project } = await createProject(context);
  const deposit = await send(context, await prepare(context, project.id, 'deposit')); await pay(context, deposit);
  const restarted = setup(new FileSandboxRepository(filename));
  const restored = await current(restarted, project.id);
  assert.equal(restored.funding.depositFunded, true); assert.equal(restored.invoices.length, 1);
  assert.equal((await restarted.repository.read()).invoices.length, 2);
  assert.equal(restored.project.agreement!.actor, 'local-sandbox-owner');
  const original = await readFile(filename, 'utf8');
  const tampered = JSON.parse(original) as SandboxLedger;
  tampered.projects![0].agreement!.termsHash = '0'.repeat(64);
  await writeFile(filename, JSON.stringify(tampered));
  await assert.rejects(restarted.repository.read(), /invalid|agreement|decision|hash|recovery/i);
  await writeFile(filename, original);
  const forged = JSON.parse(original) as SandboxLedger;
  forged.invoices.find(invoice => invoice.projectBinding)!.projectBinding!.projectId = `sbxp_${randomUUID()}`;
  await writeFile(filename, JSON.stringify(forged));
  await assert.rejects(restarted.repository.read(), /invalid|binding|project|recovery/i);
  assert.equal(await readFile(filename, 'utf8'), JSON.stringify(forged), 'Invalid persisted data must be preserved rather than silently reset');
});

test('funding is checked again immediately before sending a final created during a concurrent refund', async () => {
  const context = setup(); const { project } = await createProject(context); const id = project.id;
  const deposit = await send(context, await prepare(context, id, 'deposit')); await pay(context, deposit); await delivered(context, id);
  const final = await prepare(context, id, 'final'); let refunded = false;
  context.provider.beforeRead = async remoteId => {
    if (remoteId !== deposit.provider!.id && !refunded) {
      refunded = true; context.provider.refund(deposit, 1); await refresh(context, deposit);
    }
  };
  const blocked = await send(context, final);
  assert.equal(blocked.state, 'unknown'); assert.match(blocked.lastError!, /deposit.*confirmed/i);
  assert(blocked.provider, 'The already-created final draft stays reserved for original-operation reconciliation');
  assert.equal(context.provider.creates, 2); assert.equal(context.provider.sends, 1, 'The final must not reach provider send after the refund');
  assert.equal((await current(context, id)).funding.complete, false);
  context.provider.beforeRead = undefined;
  const originalDraft = await refresh(context, blocked); assert.equal(originalDraft.state, 'draft');
  await pay(context, deposit);
  const finalSent = await send(context, originalDraft);
  assert.equal(finalSent.provider!.id, blocked.provider.id); assert.equal(context.provider.creates, 2); assert.equal(context.provider.sends, 2);
});

test('submitted delivery freezes its scope, and another project cannot use a change identity', async () => {
  const context = setup(); const first = await createProject(context); const second = await createProject(context);
  const deposit = await send(context, await prepare(context, first.project.id, 'deposit')); await pay(context, deposit);
  const { changeId } = await change(context, first.project.id);
  const other = await current(context, second.project.id);
  await assert.rejects(context.projects.execute({ action: 'prepare-invoice', id: other.project.id, revision: other.project.revision, version: 1, purpose: 'change', changeId }));
  await pay(context, await send(context, await prepare(context, first.project.id, 'change', changeId)));
  const submitted = await delivered(context, first.project.id);
  await assert.rejects(context.projects.execute({ action: 'add-change', id: submitted.project.id, revision: submitted.project.revision, requestId: randomUUID(), terms: { ...changeTerms, title: 'Late addition' } }));
  assert.equal((await current(context, first.project.id)).project.changes.length, 1);
});

test('canceled invoices retain their obligation reservation without claiming outstanding collection', async () => {
  const context = setup(); const { project } = await createProject(context);
  const deposit = await send(context, await prepare(context, project.id, 'deposit'));
  context.provider.snapshot(deposit.provider!.id).status = 'AUTO_CANCELLED'; await refresh(context, deposit);
  const view = await current(context, project.id);
  assert.equal(view.funding.invoicedCents, 0); assert.equal(view.funding.outstandingCents, 0); assert.equal(view.funding.depositFunded, false);
  const same = await prepare(context, project.id, 'deposit'); assert.equal(same.id, deposit.id);
  await assert.rejects(send(context, same)); assert.equal(context.provider.creates, 1);
});
