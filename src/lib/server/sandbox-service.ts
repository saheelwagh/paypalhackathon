import { createHash, randomUUID } from 'node:crypto';
import type { SandboxCommand, SandboxInvoice, SandboxLedger, SandboxTerms } from '../sandbox-contract';
import { sandboxCommandSchema } from '../sandbox-contract';
import { PayPalProviderError, type PayPalInvoiceSnapshot, type PayPalSandboxProvider } from './paypal';
import type { SandboxRepository } from './sandbox-repository';
import { assertProjectInvoiceSendAllowed, SandboxProjectError } from './sandbox-project-service';

export class SandboxError extends Error {
  constructor(message: string, public status = 409) { super(message); this.name = 'SandboxError'; }
}
const timestamp = () => new Date().toISOString();
const hash = (terms: SandboxTerms) => createHash('sha256').update(JSON.stringify(terms)).digest('hex');
const coverage = (terms: SandboxTerms) => [terms.projectReference, terms.coverageReference].map(x => x.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ')).join('\u0000');
const reference = (invoice: SandboxInvoice) => `${invoice.id}:v${invoice.version}:${hash(invoice.terms).slice(0, 24)}`;
function get(ledger: SandboxLedger, id: string) {
  const invoice = ledger.invoices.find(i => i.id === id);
  if (!invoice) throw new SandboxError('Sandbox invoice not found. Demo invoices cannot be sent through this endpoint.', 404);
  return invoice;
}
function checkVersion(invoice: SandboxInvoice, version: number) {
  if (invoice.version !== version) throw new SandboxError('This sandbox invoice changed. Reload and review the current version before sending.');
}
function checkIdle(invoice: SandboxInvoice) {
  if ((invoice.operation && Date.parse(invoice.operation.leaseUntil) > Date.now()) || (invoice.refreshLease && Date.parse(invoice.refreshLease.until) > Date.now())) throw new SandboxError('This invoice already has an operation in progress. Wait, then refresh its original result.');
}
function verifyRemote(invoice: SandboxInvoice, snapshot: PayPalInvoiceSnapshot) {
  if (snapshot.provider !== 'paypal-sandbox' || snapshot.invoiceNumber !== invoice.invoiceNumber || snapshot.amountCents !== invoice.terms.amountCents || snapshot.currency !== invoice.terms.currency || snapshot.recipientEmail.toLowerCase() !== invoice.terms.recipientEmail.toLowerCase() || snapshot.description !== invoice.terms.description || snapshot.reference !== reference(invoice) || (invoice.provider && snapshot.id !== invoice.provider.id)) throw new SandboxError('PayPal invoice terms differ from the reviewed sandbox version. Sending is blocked; reconcile the original invoice in PayPal.');
}
function applySnapshot(invoice: SandboxInvoice, snapshot: PayPalInvoiceSnapshot) {
  verifyRemote(invoice, snapshot);
  const pending = snapshot.status === 'PAYMENT_PENDING';
  // Pending never becomes paid. Previously verified settled funds may remain settled.
  invoice.confirmedCents = pending && snapshot.refundedCents === 0 ? invoice.confirmedCents : snapshot.confirmedCents;
  if (!pending) invoice.confirmedPayments = snapshot.payments;
  else if (!invoice.confirmedPayments) invoice.confirmedPayments = invoice.provider?.payments ?? [];
  invoice.pendingCents = pending ? Math.min(snapshot.pendingCents, Math.max(0, invoice.terms.amountCents - invoice.confirmedCents)) : 0;
  invoice.provider = snapshot;
  invoice.state = pending ? 'pending' : ['CANCELLED', 'CANCELED', 'AUTO_CANCELLED'].includes(snapshot.status) ? 'canceled' : ['REFUNDED', 'PARTIALLY_REFUNDED', 'MARKED_AS_REFUNDED', 'REFUNDED_EXTERNAL'].includes(snapshot.status) ? 'refunded' : snapshot.status === 'DRAFT' ? 'draft' : invoice.confirmedCents === invoice.terms.amountCents ? 'paid' : invoice.confirmedCents > 0 ? 'partially-paid' : 'sent';
  invoice.updatedAt = timestamp();
  delete invoice.operation; delete invoice.lastError;
}
/** Sandbox-only billing, independent of Demo commands, approvals and localStorage. */
export class SandboxBillingService {
  constructor(private repository: SandboxRepository, private provider: PayPalSandboxProvider) {}
  async execute(raw: unknown): Promise<{ invoices: SandboxInvoice[] } | { invoice: SandboxInvoice }> {
    const parsed = sandboxCommandSchema.safeParse(raw);
    if (!parsed.success) throw new SandboxError('Invalid sandbox request. Use exact USD cents and the current invoice version; payment state and Demo approvals are not accepted.', 400);
    const command = parsed.data;
    if (command.action === 'list') return { invoices: (await this.repository.read()).invoices };
    if (command.action === 'create') return { invoice: await this.create(command) };
    if (command.action === 'edit') return { invoice: await this.edit(command) };
    if (command.action === 'send') return { invoice: await this.send(command) };
    return { invoice: await this.refresh(command.id) };
  }
  private async create(command: Extract<SandboxCommand, { action: 'create' }>) {
    return this.repository.transact(ledger => {
      const replay = ledger.invoices.find(i => i.createRequestId === command.requestId);
      if (replay) {
        if (hash(replay.terms) !== hash(command.terms)) throw new SandboxError('This request ID already belongs to different invoice terms.');
        return replay;
      }
      const existing = ledger.invoices.find(i => coverage(i.terms) === coverage(command.terms));
      if (existing) throw new SandboxError(`This billing item already has a sandbox invoice (${existing.invoiceNumber}). Open the existing invoice instead.`);
      const id = randomUUID(); const at = timestamp();
      const invoice: SandboxInvoice = { id: `sbx_${id}`, version: 1, terms: command.terms, state: 'draft', invoiceNumber: `FBD-${id.replaceAll('-', '').slice(0, 20)}`, createRequestId: command.requestId, createdAt: at, updatedAt: at, confirmedCents: 0, pendingCents: 0 };
      ledger.invoices.unshift(invoice); return invoice;
    });
  }
  private async edit(command: Extract<SandboxCommand, { action: 'edit' }>) {
    return this.repository.transact(ledger => {
      const invoice = get(ledger, command.id); checkVersion(invoice, command.version); checkIdle(invoice);
      if (invoice.projectBinding) throw new SandboxError('Project invoice terms are bound to their accepted source and cannot be edited independently.');
      if (invoice.state !== 'draft' || invoice.provider || invoice.operation) throw new SandboxError('Only an unsubmitted local sandbox draft can be edited. Provider invoices must be reconciled as their original operation.');
      if (ledger.invoices.some(i => i.id !== invoice.id && coverage(i.terms) === coverage(command.terms))) throw new SandboxError('Another sandbox invoice already covers this billing item.');
      invoice.terms = command.terms; invoice.version++; invoice.updatedAt = timestamp(); delete invoice.approval; delete invoice.lastError;
      return invoice;
    });
  }
  private async send(command: Extract<SandboxCommand, { action: 'send' }>) {
    let invoice = await this.repository.transact(ledger => {
      const invoice = get(ledger, command.id); checkVersion(invoice, command.version); checkIdle(invoice);
      if (invoice.state !== 'draft' || invoice.operation) throw new SandboxError('This invoice is already submitted or uncertain. Refresh the original invoice; do not send another one.');
      try { assertProjectInvoiceSendAllowed(ledger, invoice); }
      catch (error) { if (error instanceof SandboxProjectError) throw new SandboxError(error.message, error.status); throw error; }
      const at = timestamp();
      invoice.approval = { version: invoice.version, termsHash: hash(invoice.terms), approvedAt: at, actor: 'local-sandbox-owner' };
      invoice.operation = { kind: invoice.provider ? 'send' : 'create', requestId: randomUUID(), startedAt: at, leaseUntil: new Date(Date.now() + 90_000).toISOString() };
      invoice.state = invoice.provider ? 'sending' : 'creating'; invoice.updatedAt = at; delete invoice.lastError;
      return invoice;
    });
    try {
      if (!invoice.provider) {
        const snapshot = await this.provider.createDraft({ invoiceNumber: invoice.invoiceNumber, recipientEmail: invoice.terms.recipientEmail, description: invoice.terms.description, amountCents: invoice.terms.amountCents, reference: reference(invoice) }, invoice.operation!.requestId);
        verifyRemote(invoice, snapshot);
        if (snapshot.status !== 'DRAFT') throw new SandboxError('PayPal returned an unexpected creation state. Reconcile before continuing.');
        invoice = await this.repository.transact(ledger => {
          const current = get(ledger, invoice.id);
          if (current.operation?.requestId !== invoice.operation!.requestId) throw new SandboxError('The original operation is no longer current. Refresh before continuing.');
          current.provider = snapshot;
          current.operation = { kind: 'send', requestId: randomUUID(), startedAt: timestamp(), leaseUntil: new Date(Date.now() + 90_000).toISOString() };
          current.state = 'sending'; return current;
        });
      }
      // Read again immediately before send to catch provider-side edits after review.
      const currentRemote = await this.provider.getInvoice(invoice.provider!.id);
      verifyRemote(invoice, currentRemote);
      if (currentRemote.status !== 'DRAFT') {
        return await this.repository.transact(ledger => { const current = get(ledger, invoice.id); if (current.operation?.requestId === invoice.operation!.requestId && !current.refreshLease) applySnapshot(current, currentRemote); return current; });
      }
      // A webhook may reverse prerequisite funding while create/read is in flight.
      // Recheck the source immediately before the send mutation as well as at reservation.
      await this.repository.transact(ledger => {
        const current = get(ledger, invoice.id);
        if (current.operation?.requestId !== invoice.operation!.requestId || current.refreshLease) throw new SandboxError('The original operation changed before sending. Reconcile the original invoice.');
        try { assertProjectInvoiceSendAllowed(ledger, current); }
        catch (error) { if (error instanceof SandboxProjectError) throw new SandboxError(error.message, error.status); throw error; }
      });
      const sent = await this.provider.sendInvoice(invoice.provider!.id, invoice.operation!.requestId);
      return await this.repository.transact(ledger => { const current = get(ledger, invoice.id); if (current.operation?.requestId === invoice.operation!.requestId && !current.refreshLease) applySnapshot(current, sent); return current; });
    } catch (error) {
      const safe = error instanceof PayPalProviderError || error instanceof SandboxError ? error.message : 'The sandbox operation could not be confirmed. Refresh the original invoice before continuing.';
      // Even a read/storage failure after creation can hide a successful mutation.
      const uncertain = !(error instanceof PayPalProviderError) || error.uncertain || !!invoice.provider;
      return this.repository.transact(ledger => {
        const current = get(ledger, invoice.id);
        if (current.operation?.requestId !== invoice.operation!.requestId || current.refreshLease) return current;
        current.state = uncertain ? 'unknown' : 'draft'; current.lastError = safe; current.updatedAt = timestamp();
        if (current.operation) current.operation.leaseUntil = timestamp();
        if (!uncertain) delete current.operation;
        return current;
      });
    }
  }
  private async refresh(id: string) {
    let invoice = await this.repository.transact(ledger => {
      const invoice = get(ledger, id); checkIdle(invoice);
      if (!invoice.provider && !invoice.operation) throw new SandboxError('This draft has not been submitted to PayPal yet. Review and send it first.');
      invoice.refreshLease = { token: randomUUID(), until: new Date(Date.now() + 90_000).toISOString() };
      return invoice;
    });
    try {
      const snapshot = invoice.provider ? await this.provider.getInvoice(invoice.provider.id) : await this.provider.findInvoice(invoice.invoiceNumber);
      return await this.repository.transact(ledger => {
        const current = get(ledger, id);
        if (current.refreshLease?.token !== invoice.refreshLease!.token) throw new SandboxError('Another status check superseded this result. Refresh again.');
        if (snapshot) applySnapshot(current, snapshot);
        else { current.state = 'unknown'; current.lastError = 'PayPal has not returned the original invoice yet. No replacement was created. Check again or reconcile this invoice number in the sandbox dashboard.'; }
        delete current.refreshLease; return current;
      });
    } catch (error) {
      await this.repository.transact(ledger => { const current = get(ledger, id); if (current.refreshLease?.token === invoice.refreshLease!.token) delete current.refreshLease; });
      throw error;
    }
  }
}
