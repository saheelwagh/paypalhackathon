import { createHash, randomUUID } from 'node:crypto';
import type { SandboxInvoice, SandboxLedger } from '../sandbox-contract';
import { projectInvoiceBinding, projectInvoiceMatches, projectInvoiceTerms, projectView, projectViews, sandboxProjectCommandSchema, type SandboxChange, type SandboxDecision, type SandboxProject, type SandboxProjectBinding, type SandboxProjectView } from '../sandbox-project-contract';
import type { SandboxRepository } from './sandbox-repository';

export class SandboxProjectError extends Error {
  constructor(message: string, public status = 409) { super(message); this.name = 'SandboxProjectError'; }
}
const now = () => new Date().toISOString();
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const baseHash = (project: SandboxProject) => digest({ id: project.id, version: project.version, terms: project.terms });
const changeHash = (project: SandboxProject, change: SandboxChange) => digest({ projectId: project.id, projectVersion: project.version, projectTerms: project.terms, id: change.id, version: change.version, title: change.title, description: change.description, amountCents: change.amountCents });
const commercialHash = (project: SandboxProject) => digest({ baseline: baseHash(project), changes: project.changes.filter(change => change.agreement).map(change => ({ id: change.id, hash: changeHash(project, change) })).sort((a, b) => a.id.localeCompare(b.id)) });
const deliveryHash = (project: SandboxProject) => digest({ projectId: project.id, version: project.delivery!.version, summary: project.delivery!.summary, commercialHash: project.delivery!.commercialHash });
const decision = (version: number, termsHash: string): SandboxDecision => ({ version, termsHash, recordedAt: now(), actor: 'local-sandbox-owner' });
const validDecision = (value: SandboxDecision | undefined, version: number, hash: string) => !!value && value.version === version && value.termsHash === hash && value.actor === 'local-sandbox-owner';
const normalize = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
function getProject(ledger: SandboxLedger, id: string): SandboxProject {
  const project = ledger.projects?.find(project => project.id === id);
  if (!project) throw new SandboxProjectError('Sandbox project not found. Simulated Demo projects cannot be used here.', 404);
  return project;
}
function getChange(project: SandboxProject, id: string, version: number): SandboxChange {
  const change = project.changes.find(change => change.id === id);
  if (!change) throw new SandboxProjectError('This change does not belong to the sandbox project.', 404);
  if (change.version !== version) throw new SandboxProjectError('The change version changed. Reload and review the current version.');
  return change;
}
function requireAgreement(project: SandboxProject) {
  if (!validDecision(project.agreement, project.version, baseHash(project))) throw new SandboxProjectError('Record agreement for the current sandbox project version first.');
}
function guardTotal(project: SandboxProject, replacement?: { changeId?: string; amountCents: number }) {
  const total = project.terms.baseAmountCents + project.changes.filter(change => change.id !== replacement?.changeId).reduce((sum, change) => sum + change.amountCents, 0) + (replacement?.amountCents ?? 0);
  if (!Number.isSafeInteger(total) || total > 99_999_999) throw new SandboxProjectError('The complete project amount exceeds the supported exact-money limit.', 400);
}
function matchVersion(actual: number, expected: number) {
  if (actual !== expected) throw new SandboxProjectError('This source version changed. Reload and review the current version.');
}
function bump(project: SandboxProject) { project.revision++; project.updatedAt = now(); }

/** Validate persisted source authority and one-to-one invoice coverage, including after restart. */
export function validateSandboxProjects(ledger: SandboxLedger): void {
  const projects = ledger.projects ?? [];
  const ids = new Set<string>(); const requests = new Set<string>(); const bindings = new Set<string>();
  for (const project of projects) {
    if (ids.has(project.id) || requests.has(project.createRequestId)) throw new SandboxProjectError('Duplicate sandbox project identity requires recovery.');
    ids.add(project.id); requests.add(project.createRequestId); guardTotal(project);
    if (project.agreement && !validDecision(project.agreement, project.version, baseHash(project))) throw new SandboxProjectError('Sandbox project agreement does not match its current version.');
    const changeIds = new Set<string>(); const changeRequests = new Set<string>();
    for (const change of project.changes) {
      if (changeIds.has(change.id) || changeRequests.has(change.requestId)) throw new SandboxProjectError('Duplicate sandbox change identity requires recovery.');
      changeIds.add(change.id); changeRequests.add(change.requestId);
      if (change.approval && !validDecision(change.approval, change.version, changeHash(project, change))) throw new SandboxProjectError('Sandbox change approval does not match its current version.');
      if (change.agreement && (!project.agreement || !change.approval || !validDecision(change.agreement, change.version, changeHash(project, change)))) throw new SandboxProjectError('Sandbox change agreement has no matching approval.');
    }
    if (project.delivery && (!project.agreement || project.changes.some(change => !change.agreement) || project.delivery.commercialHash !== commercialHash(project))) throw new SandboxProjectError('Sandbox delivery does not match the agreed commercial scope.');
    if (project.delivery?.acceptance && !validDecision(project.delivery.acceptance, project.delivery.version, deliveryHash(project))) throw new SandboxProjectError('Sandbox delivery acceptance does not match its current version.');
  }
  for (const invoice of ledger.invoices) {
    const binding = invoice.projectBinding;
    if (!binding) continue;
    const project = projects.find(project => project.id === binding.projectId);
    if (!project || !projectInvoiceMatches(project, invoice)) throw new SandboxProjectError('A project invoice differs from its accepted sandbox source. Preserve the ledger for recovery.');
    const key = `${binding.projectId}:${binding.purpose}:${binding.sourceId}`;
    if (bindings.has(key)) throw new SandboxProjectError('More than one invoice reserves a sandbox project obligation. Preserve the original records.');
    bindings.add(key);
  }
}

/** Called inside billing's reservation transaction, before any provider mutation. */
export function assertProjectInvoiceSendAllowed(ledger: SandboxLedger, invoice: SandboxInvoice): void {
  if (!invoice.projectBinding) return;
  const project = getProject(ledger, invoice.projectBinding.projectId);
  requireAgreement(project);
  if (!projectInvoiceMatches(project, invoice)) throw new SandboxProjectError('This invoice no longer matches the accepted sandbox source. Sending is blocked.');
  const funding = projectView(ledger, project).funding;
  if (invoice.projectBinding.purpose !== 'deposit' && !funding.depositFunded) throw new SandboxProjectError('The deposit requires confirmed PayPal collection before this invoice can be sent.');
  if (invoice.projectBinding.purpose === 'final') {
    if (!funding.changesFunded) throw new SandboxProjectError('Every change must be agreed and fully funded before sending the final invoice.');
    if (!project.delivery?.acceptance || !validDecision(project.delivery.acceptance, project.delivery.version, deliveryHash(project))) throw new SandboxProjectError('The current delivery must be accepted before sending the final invoice.');
  }
}

export class SandboxProjectService {
  constructor(private repository: SandboxRepository) {}
  async execute(raw: unknown): Promise<{ projects: SandboxProjectView[] } | { project: SandboxProjectView; invoice?: SandboxInvoice }> {
    const parsed = sandboxProjectCommandSchema.safeParse(raw);
    if (!parsed.success) throw new SandboxProjectError('Invalid sandbox project request. Use exact cents, current versions, and explicit sandbox review; Demo approvals and payment fields are not accepted.', 400);
    const command = parsed.data;
    if (command.action === 'list') return { projects: projectViews(await this.repository.read()) };
    return this.repository.transact(ledger => {
      ledger.projects ??= [];
      if (command.action === 'create-project') {
        const existing = ledger.projects.find(project => project.createRequestId === command.requestId);
        if (existing) {
          if (digest(existing.terms) !== digest(command.terms)) throw new SandboxProjectError('This request ID already belongs to different sandbox project terms.');
          return { project: projectView(ledger, existing) };
        }
        const at = now();
        const project: SandboxProject = { id: `sbxp_${randomUUID()}`, version: 1, revision: 1, terms: command.terms, createRequestId: command.requestId, createdAt: at, updatedAt: at, changes: [] };
        ledger.projects.unshift(project); return { project: projectView(ledger, project) };
      }
      const project = getProject(ledger, command.id);
      if (project.revision !== command.revision) throw new SandboxProjectError('This sandbox project changed. Reload before applying the decision.');
      if (command.action === 'edit-project') {
        matchVersion(project.version, command.version);
        if (project.agreement || project.changes.length || ledger.invoices.some(invoice => invoice.projectBinding?.projectId === project.id)) throw new SandboxProjectError('Accepted or invoiced project terms are immutable. Record a separate change for additional work.');
        project.terms = command.terms; project.version++; delete project.agreement; bump(project);
      } else if (command.action === 'agree-project') {
        matchVersion(project.version, command.version);
        if (!project.agreement) { project.agreement = decision(project.version, baseHash(project)); bump(project); }
      } else if (command.action === 'add-change') {
        requireAgreement(project);
        if (project.delivery) throw new SandboxProjectError('Delivery has already been submitted. Its agreed scope is frozen.');
        const existing = project.changes.find(change => change.requestId === command.requestId);
        if (existing) {
          if (digest({ title: existing.title, description: existing.description, amountCents: existing.amountCents }) !== digest(command.terms)) throw new SandboxProjectError('This request ID already belongs to different change terms.');
          return { project: projectView(ledger, project) };
        }
        if (project.changes.some(change => normalize(change.title) === normalize(command.terms.title))) throw new SandboxProjectError('This project already has a change with that title. Open the existing change.');
        if (project.changes.length >= 100) throw new SandboxProjectError('This sandbox project has reached its change limit.');
        guardTotal(project, { amountCents: command.terms.amountCents });
        const at = now(); project.changes.push({ id: `sbxc_${randomUUID()}`, version: 1, ...command.terms, requestId: command.requestId, createdAt: at, updatedAt: at }); bump(project);
      } else if (command.action === 'edit-change' || command.action === 'approve-change' || command.action === 'agree-change') {
        requireAgreement(project); const change = getChange(project, command.changeId, command.version);
        if (command.action === 'edit-change') {
          if (change.agreement || project.delivery || ledger.invoices.some(invoice => invoice.projectBinding?.sourceId === change.id)) throw new SandboxProjectError('Accepted or invoiced change terms are immutable.');
          if (project.changes.some(item => item.id !== change.id && normalize(item.title) === normalize(command.terms.title))) throw new SandboxProjectError('Another change already has this title.');
          guardTotal(project, { changeId: change.id, amountCents: command.terms.amountCents });
          Object.assign(change, command.terms); change.version++; delete change.approval; delete change.agreement; change.updatedAt = now(); bump(project);
        } else if (command.action === 'approve-change') {
          if (!change.approval) { change.approval = decision(change.version, changeHash(project, change)); change.updatedAt = now(); bump(project); }
        } else {
          if (!validDecision(change.approval, change.version, changeHash(project, change))) throw new SandboxProjectError('Approve this exact change version before recording its separate sandbox agreement.');
          if (!change.agreement) { change.agreement = decision(change.version, changeHash(project, change)); change.updatedAt = now(); bump(project); }
        }
      } else if (command.action === 'submit-delivery') {
        const funding = projectView(ledger, project).funding;
        if (!funding.canSubmitDelivery) throw new SandboxProjectError('Delivery requires the confirmed deposit, agreement and collection for every change, and no previously accepted delivery.');
        project.delivery = { version: (project.delivery?.version ?? 0) + 1, summary: command.summary, commercialHash: commercialHash(project), submittedAt: now() }; bump(project);
      } else if (command.action === 'accept-delivery') {
        if (!project.delivery) throw new SandboxProjectError('Submit delivery before recording acceptance.');
        matchVersion(project.delivery.version, command.version);
        if (!project.delivery.acceptance) {
          if (!projectView(ledger, project).funding.canAcceptDelivery) throw new SandboxProjectError('Delivery acceptance requires current confirmed funding for the deposit and every agreed change.');
          project.delivery.acceptance = decision(project.delivery.version, deliveryHash(project)); bump(project);
        }
      } else {
        const sourceVersion = command.purpose === 'change' ? getChange(project, command.changeId!, command.version).version : command.purpose === 'final' ? project.delivery?.version ?? 0 : project.version;
        matchVersion(sourceVersion, command.version);
        const sourceId = command.purpose === 'change' ? command.changeId! : project.id;
        const existing = ledger.invoices.find(invoice => invoice.projectBinding?.projectId === project.id && invoice.projectBinding.purpose === command.purpose && invoice.projectBinding.sourceId === sourceId);
        if (existing) return { project: projectView(ledger, project), invoice: existing };
        const row = projectView(ledger, project).funding.obligations.find(row => row.purpose === command.purpose && row.sourceId === sourceId)!;
        if (!row.canPrepare) throw new SandboxProjectError(row.blockedReason || 'This obligation is not ready for an invoice.');
        const terms = projectInvoiceTerms(project, command.purpose, command.changeId)!;
        const binding = projectInvoiceBinding(project, command.purpose, command.changeId)!;
        if (ledger.invoices.some(invoice => normalize(invoice.terms.projectReference) === normalize(terms.projectReference) && normalize(invoice.terms.coverageReference) === normalize(terms.coverageReference))) throw new SandboxProjectError('An existing sandbox invoice already reserves this project obligation. Reconcile that original invoice.');
        const uuid = randomUUID(); const at = now();
        const invoice: SandboxInvoice = { id: `sbx_${uuid}`, version: 1, terms, projectBinding: binding, state: 'draft', invoiceNumber: `FBD-${uuid.replaceAll('-', '').slice(0, 20)}`, createRequestId: randomUUID(), createdAt: at, updatedAt: at, confirmedCents: 0, pendingCents: 0 };
        ledger.invoices.unshift(invoice); bump(project); return { project: projectView(ledger, project), invoice };
      }
      return { project: projectView(ledger, project) };
    });
  }
}
