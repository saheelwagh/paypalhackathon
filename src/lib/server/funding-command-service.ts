import { buildFundingContext, FundingCommandError, fundingCommandResultSchema, fundingCommandSchema, normalizeFundingName, parseFundingCommand, type FundingCommandAction, type FundingCommandContext, type FundingCommandIntent, type FundingCommandResult } from '../funding-commands';
import { projectViews, type SandboxFundingObligation, type SandboxProjectView } from '../sandbox-project-contract';
import { SandboxProjectError, SandboxProjectService } from './sandbox-project-service';
import type { SandboxRepository } from './sandbox-repository';
export { FundingCommandError } from '../funding-commands';

function named<T>(items: T[], name: string, id: (item: T) => string, title: (item: T) => string, label: string): T {
  const query = normalizeFundingName(name);
  const exactId = items.find(item => id(item) === query);
  if (exactId) return exactId;
  if (/^(?:demo_|sbx(?:p|c)?_)/.test(query)) throw new FundingCommandError(`That ${label} does not belong to these PayPal sandbox projects.`, 404);
  const exact = items.filter(item => normalizeFundingName(title(item)) === query);
  const matches = exact.length ? exact : items.filter(item => normalizeFundingName(title(item)).includes(query));
  if (matches.length > 1) throw new FundingCommandError(`“${name}” matches more than one ${label}. Use the complete unique name or ID.`, 409);
  if (!matches.length) throw new FundingCommandError(`No PayPal sandbox ${label} matches “${name}”. Open the project list and use a current name or ID.`, 404);
  return matches[0];
}
function selectProject(views: SandboxProjectView[], context: FundingCommandContext, name?: string): SandboxProjectView {
  if (name) return named(views, name, view => view.project.id, view => view.project.terms.title, 'project');
  const view = views.find(item => item.project.id === context.projectId);
  if (!view) throw new FundingCommandError('Select a PayPal sandbox project first. Try “show projects” or “open project NAME”.', 409);
  return view;
}
function assertCurrent(views: SandboxProjectView[], view: SandboxProjectView, expected: FundingCommandContext): void {
  const current = buildFundingContext(views, view.project.id);
  if (expected.projectId !== view.project.id) throw new FundingCommandError('Open that project first, then review its current funding before preparing an invoice.', 409);
  if (expected.revision !== current.revision || expected.fingerprint !== current.fingerprint) throw new FundingCommandError('This project or its funding changed. Review the refreshed project and run the command again.', 409);
}
function changeRow(view: SandboxProjectView, name?: string): SandboxFundingObligation {
  const rows = view.funding.obligations.filter(row => row.purpose === 'change');
  if (name) return named(rows, name, row => row.sourceId, row => row.title, 'change');
  if (rows.length > 1) throw new FundingCommandError('This project has more than one change. Include the unique change name or ID.', 409);
  if (!rows.length) throw new FundingCommandError('This project has no sandbox change. Use the project review controls to add one.', 409);
  return rows[0];
}
function prepareRow(view: SandboxProjectView, intent: Extract<FundingCommandIntent, { type: 'prepare' }>): SandboxFundingObligation {
  if (intent.purpose === 'change') return changeRow(view, intent.changeSelector);
  if (intent.purpose !== 'next') return view.funding.obligations.find(row => row.purpose === intent.purpose)!;
  // The next eligible source is deterministic, and is frozen by the context check at reservation.
  const eligible = view.funding.obligations.find(row => row.canPrepare);
  if (eligible) return eligible;
  const outstanding = view.funding.obligations.find(row => !row.funded && row.invoiceId);
  if (outstanding) return outstanding;
  const blocked = view.funding.obligations.find(row => !row.funded);
  throw new FundingCommandError(blocked?.blockedReason ?? 'All sandbox invoices are already funded. No new invoice is required.', 409);
}
function assertReady(row: SandboxFundingObligation): void {
  if (!row.invoiceId && !row.canPrepare) throw new FundingCommandError(row.blockedReason ?? 'This source is not ready for a sandbox invoice.', 409);
}
function result(value: FundingCommandResult): FundingCommandResult { return fundingCommandResultSchema.parse(value); }

/** Local interpretation can prepare an exact source-bound draft, but never contacts PayPal. */
export class FundingCommandService {
  constructor(private readonly repository: SandboxRepository) {}
  async execute(raw: unknown): Promise<FundingCommandResult> {
    const parsed = fundingCommandSchema.safeParse(raw);
    if (!parsed.success) throw new FundingCommandError('Invalid Funding command. Use a single message and the current sandbox project context; amounts, recipients, approvals, and payment records are not accepted.');
    const request = parsed.data;
    const intent = parseFundingCommand(request.message);
    return this.resolve(request, intent);
  }
  /** Server-only read planning: callers validate the model intent before using this method. */
  async planIntent(intent: FundingCommandIntent, context: FundingCommandContext): Promise<FundingCommandResult> {
    return this.resolve({ action: 'plan', context }, intent);
  }
  private async resolve(request: { action: 'plan' | 'run'; context: FundingCommandContext }, intent: FundingCommandIntent): Promise<FundingCommandResult> {
    const views = projectViews(await this.repository.read());
    if (intent.type === 'projects') return result({ provider: 'funding-local', message: 'Showing PayPal sandbox projects.', context: {}, action: { type: 'projects' } });
    const view = selectProject(views, request.context, intent.type === 'project' ? intent.selector : intent.projectSelector);
    const context = buildFundingContext(views, view.project.id);
    if (intent.type === 'project') return result({ provider: 'funding-local', message: `Selected ${view.project.terms.title}.`, context, action: { type: 'project', projectId: view.project.id } });
    if (intent.type === 'inspect') {
      let row: SandboxFundingObligation | undefined;
      if (intent.section === 'change') row = changeRow(view, intent.changeSelector);
      else if (intent.section === 'deposit' || intent.section === 'final') row = view.funding.obligations.find(item => item.purpose === intent.section);
      if (intent.invoiceId && !view.invoices.some(invoice => invoice.id === intent.invoiceId)) throw new FundingCommandError('That invoice does not belong to the selected sandbox project. Standalone and simulated Demo invoices are separate.', 404);
      return result({ provider: 'funding-local', message: `Showing ${row?.title ?? intent.section} for ${view.project.terms.title}.`, context,
        action: { type: 'inspect', projectId: view.project.id, section: intent.section, ...(row?.purpose === 'change' ? { changeId: row.sourceId } : {}), ...((intent.invoiceId ?? row?.invoiceId) ? { invoiceId: intent.invoiceId ?? row?.invoiceId } : {}) } });
    }

    assertCurrent(views, view, request.context);
    const row = prepareRow(view, intent); assertReady(row);
    const action: Extract<FundingCommandResult['action'], { type: 'invoice' }> = { type: 'invoice', projectId: view.project.id, purpose: row.purpose, sourceId: row.sourceId,
      sourceVersion: row.sourceVersion, amountCents: row.amountCents, ...(row.invoiceId ? { invoiceId: row.invoiceId } : {}) };
    if (request.action === 'plan') return result({ provider: 'funding-local', message: `${row.invoiceId ? 'Open the original' : 'Prepare a local draft for the'} ${row.title.toLowerCase()} invoice for ${view.project.terms.title}. Separate invoice approval and sending remain required.`, context, action });

    const guarded: SandboxRepository = {
      read: () => this.repository.read(),
      transact: update => this.repository.transact(ledger => {
        const currentViews = projectViews(ledger);
        const current = selectProject(currentViews, request.context);
        assertCurrent(currentViews, current, request.context);
        const currentRow = prepareRow(current, intent); assertReady(currentRow);
        if (currentRow.purpose !== row.purpose || currentRow.sourceId !== row.sourceId || currentRow.sourceVersion !== row.sourceVersion || currentRow.amountCents !== row.amountCents) throw new FundingCommandError('The next invoice changed. Review the project and run the command again.', 409);
        return update(ledger);
      }),
    };
    try {
      const prepared = await new SandboxProjectService(guarded).execute({ action: 'prepare-invoice', id: view.project.id, revision: view.project.revision,
        version: row.sourceVersion, purpose: row.purpose, ...(row.purpose === 'change' ? { changeId: row.sourceId } : {}) });
      if (!('project' in prepared) || !prepared.invoice) throw new FundingCommandError('The project did not return a source-bound invoice. Review the project before retrying.', 409);
      return result({ provider: 'funding-local', message: row.invoiceId ? `Opened the original ${row.title.toLowerCase()} invoice. No duplicate was created.` : `Prepared the ${row.title.toLowerCase()} draft from the agreed sandbox source. Review and approve the invoice before sending it.`,
        context: buildFundingContext([prepared.project], view.project.id), action: { ...action, invoiceId: prepared.invoice.id }, preparation: { invoiceId: prepared.invoice.id, existing: !!row.invoiceId } });
    } catch (error) {
      if (error instanceof SandboxProjectError) throw new FundingCommandError(error.message, error.status);
      throw error;
    }
  }
}

/** Apply a signed, already resolved source. Never reinterpret "next" during confirmation or replay. */
export async function prepareFrozenFundingInvoice(repository: SandboxRepository, action: Extract<FundingCommandAction, { type: 'invoice' }>, expected: FundingCommandContext): Promise<FundingCommandResult> {
  try {
    return await repository.transact(async ledger => {
      const views = projectViews(ledger);
      const view = selectProject(views, { ...expected, projectId: action.projectId });
      const row = view.funding.obligations.find(item => item.purpose === action.purpose && item.sourceId === action.sourceId);
      if (expected.projectId !== action.projectId || !row || row.sourceVersion !== action.sourceVersion || row.amountCents !== action.amountCents || (action.invoiceId && row.invoiceId !== action.invoiceId)) {
        throw new FundingCommandError('The reviewed invoice source changed. Request a fresh preview.', 409);
      }
      // A replay can only reopen the exact existing source reservation. It cannot create the next obligation.
      if (row.invoiceId) return result({ provider: 'funding-local', message: 'Opened the original source-bound invoice. No duplicate was created.',
        action: { ...action, invoiceId: row.invoiceId }, context: buildFundingContext(views, view.project.id), preparation: { invoiceId: row.invoiceId, existing: true } });
      assertCurrent(views, view, expected); assertReady(row);
      // The real repository owns the outer transaction; this adapter reuses that same locked ledger.
      const scoped: SandboxRepository = { read: async () => ledger, transact: async update => update(ledger) };
      const prepared = await new SandboxProjectService(scoped).execute({ action: 'prepare-invoice', id: view.project.id, revision: view.project.revision,
        version: row.sourceVersion, purpose: row.purpose, ...(row.purpose === 'change' ? { changeId: row.sourceId } : {}) });
      if (!('project' in prepared) || !prepared.invoice) throw new FundingCommandError('The reviewed source did not return its original invoice. Reopen the project.', 409);
      return result({ provider: 'funding-local', message: 'Prepared the reviewed local sandbox draft. Approval and sending still require separate exact-version review.',
        context: buildFundingContext([prepared.project], view.project.id), action: { ...action, invoiceId: prepared.invoice.id }, preparation: { invoiceId: prepared.invoice.id, existing: false } });
    });
  } catch (error) {
    if (error instanceof SandboxProjectError) throw new FundingCommandError(error.message, error.status);
    throw error;
  }
}
