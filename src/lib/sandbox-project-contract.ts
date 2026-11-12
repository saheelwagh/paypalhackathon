import { z } from 'zod';
import type { SandboxInvoice, SandboxInvoiceState, SandboxLedger, SandboxTerms } from './sandbox-contract';

const cents = z.number().int().min(1).max(99_999_999);
const version = z.number().int().positive();
export const sandboxProjectId = z.string().regex(/^sbxp_[a-f0-9-]{36}$/);
export const sandboxChangeId = z.string().regex(/^sbxc_[a-f0-9-]{36}$/);
export const sandboxProjectTermsSchema = z.object({
  title: z.string().trim().min(1).max(100), recipientEmail: z.email().max(254).transform(value => value.toLowerCase()),
  scope: z.string().trim().min(1).max(700), baseAmountCents: cents, depositCents: cents, currency: z.literal('USD'),
}).strict().refine(terms => terms.depositCents < terms.baseAmountCents, 'The deposit must be smaller than the base amount, leaving a positive final milestone.');
export const sandboxChangeTermsSchema = z.object({ title: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(700), amountCents: cents }).strict();
export type SandboxProjectTerms = z.infer<typeof sandboxProjectTermsSchema>;
export type SandboxChangeTerms = z.infer<typeof sandboxChangeTermsSchema>;
export const sandboxDecisionSchema = z.object({ version, termsHash: z.string().regex(/^[a-f0-9]{64}$/), recordedAt: z.iso.datetime(), actor: z.literal('local-sandbox-owner') }).strict();
export type SandboxDecision = z.infer<typeof sandboxDecisionSchema>;
export const sandboxProjectSchema = z.object({
  id: sandboxProjectId, version, revision: version, terms: sandboxProjectTermsSchema, agreement: sandboxDecisionSchema.optional(),
  createRequestId: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(),
  changes: z.array(z.object({ id: sandboxChangeId, version, ...sandboxChangeTermsSchema.shape, requestId: z.uuid(), createdAt: z.iso.datetime(), updatedAt: z.iso.datetime(), approval: sandboxDecisionSchema.optional(), agreement: sandboxDecisionSchema.optional() }).strict()).max(100),
  delivery: z.object({ version, summary: z.string().trim().min(1).max(1000), commercialHash: z.string().regex(/^[a-f0-9]{64}$/), submittedAt: z.iso.datetime(), acceptance: sandboxDecisionSchema.optional() }).strict().optional(),
}).strict();
export type SandboxProject = z.infer<typeof sandboxProjectSchema>;
export type SandboxChange = SandboxProject['changes'][number];
export const sandboxProjectBindingSchema = z.object({ projectId: sandboxProjectId, purpose: z.enum(['deposit', 'change', 'final']), sourceId: z.string().regex(/^sbx[pc]_[a-f0-9-]{36}$/), sourceVersion: version, termsHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type SandboxProjectBinding = z.infer<typeof sandboxProjectBindingSchema>;
const identity = { id: sandboxProjectId, revision: version };
const source = { ...identity, version };
const change = { ...source, changeId: sandboxChangeId };
export const sandboxProjectCommandSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('create-project'), requestId: z.uuid(), terms: sandboxProjectTermsSchema }).strict(),
  z.object({ action: z.literal('edit-project'), ...source, terms: sandboxProjectTermsSchema }).strict(),
  z.object({ action: z.literal('agree-project'), ...source, confirmSandbox: z.literal(true) }).strict(),
  z.object({ action: z.literal('add-change'), ...identity, requestId: z.uuid(), terms: sandboxChangeTermsSchema }).strict(),
  z.object({ action: z.literal('edit-change'), ...change, terms: sandboxChangeTermsSchema }).strict(),
  z.object({ action: z.literal('approve-change'), ...change, confirmSandbox: z.literal(true) }).strict(),
  z.object({ action: z.literal('agree-change'), ...change, confirmSandbox: z.literal(true) }).strict(),
  z.object({ action: z.literal('submit-delivery'), ...identity, summary: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('accept-delivery'), ...source, confirmSandbox: z.literal(true) }).strict(),
  z.object({ action: z.literal('prepare-invoice'), ...source, purpose: z.enum(['deposit', 'change', 'final']), changeId: sandboxChangeId.optional() }).strict()
    .refine(command => (command.purpose === 'change') === !!command.changeId, 'A change invoice requires exactly its change ID.'),
]);
export type SandboxProjectCommand = z.infer<typeof sandboxProjectCommandSchema>;

export type SandboxFundingObligation = {
  purpose: SandboxProjectBinding['purpose']; sourceId: string; sourceVersion: number; title: string; amountCents: number; accepted: boolean;
  invoiceId?: string; invoiceState?: SandboxInvoiceState; confirmedCents: number; pendingCents: number; funded: boolean; canPrepare: boolean; blockedReason?: string;
};
export type SandboxProjectFunding = {
  agreedCents: number; invoicedCents: number; confirmedCents: number; pendingCents: number; outstandingCents: number; unbilledCents: number;
  depositFunded: boolean; changesFunded: boolean; canSubmitDelivery: boolean; canAcceptDelivery: boolean; canPrepareFinal: boolean; complete: boolean;
  status: 'awaiting-agreement' | 'deposit-unfunded' | 'changes-unfunded' | 'ready-for-delivery' | 'awaiting-delivery-acceptance' | 'final-unfunded' | 'complete';
  nextAction: string; obligations: SandboxFundingObligation[];
};
export type SandboxProjectView = { project: SandboxProject; funding: SandboxProjectFunding; invoices: SandboxInvoice[] };

/** Terms are generated from accepted sandbox sources, never from display-name matching. */
export function projectInvoiceTerms(project: SandboxProject, purpose: SandboxProjectBinding['purpose'], changeId?: string): SandboxTerms | null {
  const item = purpose === 'change' ? project.changes.find(change => change.id === changeId) : undefined;
  if (purpose === 'change' && !item) return null;
  return {
    projectReference: project.id, coverageReference: purpose === 'change' ? `change:${item!.id}` : purpose,
    recipientEmail: project.terms.recipientEmail, currency: project.terms.currency,
    amountCents: purpose === 'deposit' ? project.terms.depositCents : purpose === 'final' ? project.terms.baseAmountCents - project.terms.depositCents : item!.amountCents,
    description: purpose === 'change' ? `${project.terms.title} — Change: ${item!.title}. ${item!.description}` : `${project.terms.title} — ${purpose === 'deposit' ? 'Deposit' : 'Final milestone'}. ${project.terms.scope}`,
  };
}
export function projectInvoiceBinding(project: SandboxProject, purpose: SandboxProjectBinding['purpose'], changeId?: string): SandboxProjectBinding | null {
  if (!project.agreement || project.agreement.version !== project.version) return null;
  if (purpose === 'change') {
    const item = project.changes.find(change => change.id === changeId);
    if (!item?.approval || !item.agreement || item.approval.version !== item.version || item.agreement.version !== item.version || item.approval.termsHash !== item.agreement.termsHash) return null;
    return { projectId: project.id, purpose, sourceId: item.id, sourceVersion: item.version, termsHash: item.agreement.termsHash };
  }
  if (purpose === 'final') {
    const delivery = project.delivery;
    if (!delivery?.acceptance || delivery.acceptance.version !== delivery.version) return null;
    return { projectId: project.id, purpose, sourceId: project.id, sourceVersion: delivery.version, termsHash: delivery.acceptance.termsHash };
  }
  return { projectId: project.id, purpose, sourceId: project.id, sourceVersion: project.version, termsHash: project.agreement.termsHash };
}
export function projectInvoiceMatches(project: SandboxProject, invoice: SandboxInvoice): boolean {
  const binding = invoice.projectBinding;
  if (!binding || binding.projectId !== project.id) return false;
  const expected = projectInvoiceBinding(project, binding.purpose, binding.purpose === 'change' ? binding.sourceId : undefined);
  const terms = projectInvoiceTerms(project, binding.purpose, binding.purpose === 'change' ? binding.sourceId : undefined);
  return !!expected && !!terms && (Object.keys(expected) as (keyof SandboxProjectBinding)[]).every(key => expected[key] === binding[key])
    && (Object.keys(terms) as (keyof SandboxTerms)[]).every(key => terms[key] === invoice.terms[key]);
}

/** Pure projection: authoritative invoice snapshots are the only funding input. */
export function projectView(ledger: SandboxLedger, project: SandboxProject): SandboxProjectView {
  const invoices = ledger.invoices.filter(invoice => invoice.projectBinding?.projectId === project.id);
  const valid = invoices.filter(invoice => projectInvoiceMatches(project, invoice));
  const accepted = !!project.agreement && project.agreement.version === project.version;
  const obligations: SandboxFundingObligation[] = [];
  function obligation(purpose: SandboxProjectBinding['purpose'], item?: SandboxChange): SandboxFundingObligation {
    const invoice = valid.find(invoice => invoice.projectBinding!.purpose === purpose && (purpose !== 'change' || invoice.projectBinding!.sourceId === item?.id));
    const expectedAmount = projectInvoiceTerms(project, purpose, item?.id)!.amountCents;
    const sourceAccepted = purpose === 'change' ? !!projectInvoiceBinding(project, purpose, item?.id) : accepted;
    const hasEvidence = invoice?.provider?.provider === 'paypal-sandbox';
    const confirmedCents = hasEvidence ? invoice!.confirmedCents : 0;
    const pendingCents = hasEvidence ? invoice!.pendingCents : 0;
    const row: SandboxFundingObligation = { purpose, sourceId: item?.id ?? project.id, sourceVersion: item?.version ?? (purpose === 'final' ? project.delivery?.version ?? 0 : project.version), title: item?.title ?? (purpose === 'deposit' ? 'Deposit' : 'Final milestone'), amountCents: expectedAmount, accepted: sourceAccepted,
      ...(invoice ? { invoiceId: invoice.id, invoiceState: invoice.state } : {}), confirmedCents, pendingCents, funded: sourceAccepted && confirmedCents === expectedAmount && pendingCents === 0, canPrepare: false };
    obligations.push(row); return row;
  }
  const deposit = obligation('deposit');
  const changeRows = project.changes.map(item => obligation('change', item));
  const final = obligation('final');
  const unresolved = changeRows.some(row => !row.accepted);
  const changesFunded = !unresolved && changeRows.every(row => row.funded);
  const ready = accepted && deposit.funded && changesFunded;
  const deliveryAccepted = !!project.delivery?.acceptance && project.delivery.acceptance.version === project.delivery.version;
  for (const row of obligations) {
    const reason = !accepted ? 'Record the current sandbox project agreement first.'
      : row.purpose === 'change' && !row.accepted ? 'Approve and record agreement for this exact change version first.'
      : row.purpose !== 'deposit' && !deposit.funded ? 'The deposit requires confirmed PayPal collection.'
      : row.purpose === 'final' && !changesFunded ? 'Every change must be agreed and fully funded before the final invoice.'
      : row.purpose === 'final' && !deliveryAccepted ? 'Submit delivery and separately record its acceptance before the final invoice.' : undefined;
    row.canPrepare = !reason && !row.invoiceId;
    row.blockedReason = row.invoiceId ? 'This obligation already has an invoice. Open and reconcile that original invoice.' : reason;
  }
  const agreedCents = accepted ? project.terms.baseAmountCents + changeRows.filter(row => row.accepted).reduce((sum, row) => sum + row.amountCents, 0) : 0;
  const issued = valid.filter(invoice => invoice.provider && !['DRAFT', 'CANCELLED', 'CANCELED', 'AUTO_CANCELLED'].includes(invoice.provider.status));
  const invoicedCents = issued.reduce((sum, invoice) => sum + invoice.terms.amountCents, 0);
  const confirmedCents = obligations.reduce((sum, row) => sum + row.confirmedCents, 0);
  const pendingCents = obligations.reduce((sum, row) => sum + row.pendingCents, 0);
  const complete = ready && deliveryAccepted && final.funded;
  const status: SandboxProjectFunding['status'] = !accepted ? 'awaiting-agreement' : !deposit.funded ? 'deposit-unfunded' : !changesFunded ? 'changes-unfunded'
    : !project.delivery ? 'ready-for-delivery' : !deliveryAccepted ? 'awaiting-delivery-acceptance' : !complete ? 'final-unfunded' : 'complete';
  const nextAction = { 'awaiting-agreement': 'Review and record the current sandbox scope agreement.', 'deposit-unfunded': 'Collect the deposit through the original PayPal sandbox invoice.', 'changes-unfunded': 'Review, agree, and collect each separate change invoice.', 'ready-for-delivery': 'Submit the delivered work for a separate acceptance decision.', 'awaiting-delivery-acceptance': 'Review and record acceptance of this exact delivery version.', 'final-unfunded': 'Collect the final baseline remainder through PayPal sandbox.', complete: 'All agreed work has verified sandbox collection.' }[status];
  const outstandingCents = issued.reduce((sum, invoice) => sum + Math.max(0, invoice.terms.amountCents - invoice.confirmedCents), 0);
  return { project, invoices, funding: { agreedCents, invoicedCents, confirmedCents, pendingCents, outstandingCents, unbilledCents: Math.max(0, agreedCents - invoicedCents), depositFunded: deposit.funded, changesFunded, canSubmitDelivery: ready && !deliveryAccepted, canAcceptDelivery: ready && !!project.delivery && !deliveryAccepted, canPrepareFinal: final.canPrepare, complete, status, nextAction, obligations } };
}
export function projectViews(ledger: SandboxLedger): SandboxProjectView[] { return (ledger.projects ?? []).map(project => projectView(ledger, project)); }
