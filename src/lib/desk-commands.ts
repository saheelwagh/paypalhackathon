import { z } from 'zod';
import { money, totals, type DeskState } from './domain';

export type DeskAction =
  | { type: 'select-project'; projectId: string }
  | { type: 'filter'; filter: 'all' | 'changes' | 'included' | 'extra' | 'unapproved' | 'pending' }
  | { type: 'select-change'; changeId: string }
  | { type: 'layout'; view: 'review' | 'compare' | 'collect' | 'money' }
  | { type: 'review'; target: 'change' | 'invoice' | 'delivery'; id: string }
  | { type: 'undo' } | { type: 'save' } | { type: 'reset' };
export type DeskCommandResult = { provider: 'demo' | 'nebius'; message: string; actions: DeskAction[]; steps: { tool: string; result: string }[] };
const demoId = z.string().startsWith('demo_').max(150);
const selectedId = z.union([z.literal(''), demoId]);
const cents = z.number().int().min(0).max(1_000_000_000);
export function redactDeskText(text: string, limit = 500): string {
  return text.replace(/https?:\/\/\S+/gi, '[link omitted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email omitted]')
    .replace(/\b(?:api[_ -]?key|secret|token|password|authorization)\s*[:=]\s*\S+/gi, '[credential omitted]')
    .replace(/\bBearer\s+\S+/gi, '[credential omitted]')
    .replace(/\bsk-[A-Za-z0-9_-]+/g, '[credential omitted]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[identifier omitted]')
    .slice(0, limit);
}
const text = (max: number) => z.string().max(max).transform(value => redactDeskText(value, max));
/** Strict, bounded synthetic context. No email, notes, credentials, approvals, audio, or provider IDs. */
export const deskCommandContextSchema = z.object({
  schemaVersion: z.literal(1), mode: z.literal('demo'), projectId: selectedId, selectedId,
  projects: z.array(z.object({ id: demoId, name: text(160), clientName: text(160), due: text(30), status: text(60), deliverySubmitted: z.boolean(), deliveryAccepted: z.boolean() }).strict()).max(30),
  proposals: z.array(z.object({ id: demoId, projectId: demoId, title: text(160), amount: cents, deadline: text(30), version: z.number().int().positive(), status: text(60), clientAccepted: z.boolean() }).strict()).max(12),
  changes: z.array(z.object({ id: demoId, projectId: demoId, title: text(160), classification: z.enum(['Included', 'Extra', 'Unclear']), amount: cents, version: z.number().int().positive(), status: text(60), ownerApproved: z.boolean(), clientAccepted: z.boolean(), evidence: text(150) }).strict()).max(40),
  invoices: z.array(z.object({ id: demoId, projectId: demoId, purpose: z.enum(['deposit', 'change', 'final']), amount: cents, paid: cents, status: z.enum(['draft', 'sent', 'pending', 'partially paid', 'paid', 'unknown', 'canceled']) }).strict()).max(40),
  evidence: z.array(z.object({ id: demoId, projectId: demoId, text: text(500), source: z.literal('untrusted-demo-evidence') }).strict()).max(8),
  totals: z.object({ agreed: cents, invoiced: cents, paid: cents, outstanding: cents, unbilled: cents }).strict(),
}).strict().superRefine((context, ctx) => {
  const ids = new Set(context.projects.map(project => project.id));
  if (context.projectId && !ids.has(context.projectId)) ctx.addIssue({ code: 'custom', message: 'Unknown project context.' });
  for (const record of [...context.proposals, ...context.changes, ...context.invoices, ...context.evidence]) {
    if (record.projectId !== context.projectId) ctx.addIssue({ code: 'custom', message: 'Record is outside the selected project.' });
  }
});
export type DeskCommandContext = z.infer<typeof deskCommandContextSchema>;
export const deskActionSchema: z.ZodType<DeskAction> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('select-project'), projectId: demoId }).strict(),
  z.object({ type: z.literal('filter'), filter: z.enum(['all', 'changes', 'included', 'extra', 'unapproved', 'pending']) }).strict(),
  z.object({ type: z.literal('select-change'), changeId: demoId }).strict(),
  z.object({ type: z.literal('layout'), view: z.enum(['review', 'compare', 'collect', 'money']) }).strict(),
  z.object({ type: z.literal('review'), target: z.enum(['change', 'invoice', 'delivery']), id: demoId }).strict(),
  z.object({ type: z.literal('undo') }).strict(), z.object({ type: z.literal('save') }).strict(), z.object({ type: z.literal('reset') }).strict(),
]);
export function buildDeskCommandContext(state: DeskState, projectId: string, selection: string): DeskCommandContext {
  const projects = state.projects.filter(project => project.id.startsWith('demo_'));
  const chosen = projects.find(project => project.id === projectId) ?? projects[0];
  const scopedId = chosen?.id ?? '';
  const knownProjects = [chosen, ...projects.filter(project => project !== chosen)].filter(project => !!project).slice(0, 30);
  return deskCommandContextSchema.parse({
    schemaVersion: 1, mode: 'demo', projectId: scopedId, selectedId: selection.startsWith('demo_') ? selection : '',
    projects: knownProjects.map(project => ({ id: project.id, name: redactDeskText(project.name, 160), clientName: redactDeskText(state.clients.find(client => client.id === project.clientId)?.name ?? '', 160), due: project.due, status: project.status, deliverySubmitted: !!project.delivery, deliveryAccepted: project.accepted })),
    proposals: state.proposals.filter(proposal => proposal.projectId === scopedId).slice(0, 12).map(proposal => ({ id: proposal.id, projectId: scopedId, title: redactDeskText(proposal.title, 160), amount: proposal.items.reduce((sum, item) => sum + item.amount, 0), deadline: proposal.deadline, version: proposal.version, status: proposal.status, clientAccepted: proposal.clientAccepted })),
    changes: state.changes.filter(change => change.projectId === scopedId).slice(0, 40).map(change => ({ id: change.id, projectId: scopedId, title: redactDeskText(change.title, 160), classification: change.classification, amount: change.amount, version: change.version, status: change.status, ownerApproved: change.ownerApproved, clientAccepted: change.clientAccepted, evidence: change.evidence })),
    invoices: state.invoices.filter(invoice => invoice.projectId === scopedId).slice(0, 40).map(invoice => ({ id: invoice.id, projectId: scopedId, purpose: invoice.purpose, amount: invoice.amount, paid: invoice.paid, status: invoice.status })),
    evidence: state.conversations.filter(conversation => conversation.projectId === scopedId).flatMap(conversation => conversation.utterances.map(utterance => ({ id: `${conversation.id}:${utterance.id}`, projectId: scopedId, text: redactDeskText(utterance.text), source: 'untrusted-demo-evidence' as const }))).slice(0, 8),
    totals: scopedId ? totals(state, scopedId) : { agreed: 0, invoiced: 0, paid: 0, outstanding: 0, unbilled: 0 },
  });
}
/** Validation authorizes presentation changes only, never a business command or financial mutation. */
export function validateDeskActions(context: DeskCommandContext, input: unknown): DeskAction[] {
  const actions = z.array(deskActionSchema).max(8).parse(input);
  let projectId = context.projectId;
  for (const action of actions) {
    if (action.type === 'select-project') {
      if (!context.projects.some(project => project.id === action.projectId)) throw new Error('The requested project is not in this demo context.');
      projectId = action.projectId;
    }
    if (action.type === 'select-change' && !context.changes.some(change => change.id === action.changeId && change.projectId === projectId)) throw new Error('The requested change is not in the selected project.');
    if (action.type === 'review') {
      const known = action.target === 'change' ? context.changes.some(change => change.id === action.id && change.projectId === projectId)
        : action.target === 'invoice' ? context.invoices.some(invoice => invoice.id === action.id && invoice.projectId === projectId)
          : context.projects.some(project => project.id === action.id && project.id === projectId);
      if (!known) throw new Error('The requested review is not in the selected project.');
    }
  }
  return actions;
}
export function describeDeskActions(actions: DeskAction[]): string {
  return actions.map(action => action.type === 'select-project' ? 'select project' : action.type === 'select-change' ? 'select requested change' : action.type === 'filter' ? `show ${action.filter}` : action.type === 'layout' ? `open ${action.view} view` : action.type === 'review' ? `open ${action.target} review` : `${action.type} layout`).join('; ');
}
const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
export function interpretDemoCommand(state: DeskState, projectId: string, selection: string, message: string): DeskCommandResult {
  const query = normalize(message.slice(0, 2000));
  const matches = state.projects.filter(project => [project.name, state.clients.find(client => client.id === project.clientId)?.name ?? ''].some(name => normalize(name).length > 2 && query.includes(normalize(name))));
  const chosenId = matches.length === 1 ? matches[0].id : projectId;
  const context = buildDeskCommandContext(state, chosenId, selection);
  const actions: DeskAction[] = [];
  const result = (explanation?: string): DeskCommandResult => ({ provider: 'demo', message: explanation ?? `Demo command: ${describeDeskActions(actions)}. Commercial records stay unchanged.`, actions: validateDeskActions(context, actions), steps: [{ tool: 'readDemoDesk', result: `Read the selected synthetic project and ${context.changes.length} change requests.` }, { tool: 'planViewChanges', result: actions.length ? describeDeskActions(actions) : 'No supported view action selected.' }] });
  if (!query) return result('Type a desk command, such as “show pending payments” or “compare this change”.');
  if (/\b(delete|refund|pay now|mark paid|transfer|payout|charge|send money)\b/.test(query)) return result('This command surface can show records and open reviews. It cannot execute payments, refunds, approvals, or delete business records.');
  if (matches.length > 1) return result('More than one project matches. Select one project before applying this command.');
  if (chosenId !== projectId && context.projectId) actions.push({ type: 'select-project', projectId: context.projectId });
  if (/\b(undo|revert last|go back one)\b/.test(query)) { actions.push({ type: 'undo' }); return result(); }
  if (/\b(save|remember)\b/.test(query) && /\b(layout|view|workspace|report)\b/.test(query)) { actions.push({ type: 'save' }); return result(); }
  if (/\b(reset|restore default|start over)\b/.test(query) && /\b(layout|view|workspace|report)\b/.test(query)) { actions.push({ type: 'reset' }); return result(); }
  const selectedChange = context.changes.find(change => query.includes(normalize(change.title)) || normalize(change.title).split(' ').filter(word => word.length > 4).some(word => query.includes(word))) ?? context.changes.find(change => change.id === selection);
  const invoicePurpose = (['deposit', 'change', 'final'] as const).find(purpose => new RegExp(`\\b${purpose}\\b`).test(query));
  const selectedInvoice = invoicePurpose ? context.invoices.find(invoice => invoice.purpose === invoicePurpose) : context.invoices.find(invoice => invoice.id === selection);
  if (/\b(review|open|inspect|approve|send invoice|issue invoice)\b/.test(query)) {
    if (/\b(delivery|handover)\b/.test(query) && context.projectId) actions.push({ type: 'review', target: 'delivery', id: context.projectId });
    else if (/\b(invoice|bill)\b/.test(query)) {
      if (selectedInvoice) actions.push({ type: 'review', target: 'invoice', id: selectedInvoice.id });
      else return result('No matching invoice exists in this project. Select an existing invoice or prepare its draft through the review controls.');
    }
    else if (selectedChange) actions.push({ type: 'select-change', changeId: selectedChange.id }, { type: 'review', target: 'change', id: selectedChange.id });
  }
  if (/\b(compare|comparison|alternatives|options|side by side)\b/.test(query)) { if (selectedChange && !actions.some(action => action.type === 'select-change')) actions.push({ type: 'select-change', changeId: selectedChange.id }); actions.push({ type: 'layout', view: 'compare' }); }
  else if (/\b(money|totals|balance|revenue|financial|finances|collected|paid so far|how much)\b/.test(query)) actions.push({ type: 'layout', view: 'money' });
  else if (/\b(collection|collections|overdue|unpaid|pending|payments|invoices)\b/.test(query)) actions.push({ type: 'layout', view: 'collect' });
  else if (/\b(review|scope|changes|requests)\b/.test(query) && !actions.some(action => action.type === 'review')) actions.push({ type: 'layout', view: 'review' });
  let filter: Extract<DeskAction, { type: 'filter' }>['filter'] | undefined;
  if (/\b(unapproved|not approved|awaiting approval|need approval|needs approval|missing acceptance|not accepted)\b/.test(query)) filter = 'unapproved';
  else if (/\b(pending|awaiting payment|waiting for payment)\b/.test(query)) filter = 'pending';
  else if (/\b(included|in scope|already covered|no extra charge)\b/.test(query)) filter = 'included';
  else if (/\b(extra|extras|additional|additions|out of scope)\b/.test(query)) filter = 'extra';
  else if (/\b(all changes|requested changes|change requests|scope changes)\b/.test(query)) filter = 'changes';
  else if (/\b(show all|everything|clear filters|remove filters|unfilter)\b/.test(query)) filter = 'all';
  if (filter) actions.push({ type: 'filter', filter });
  if (!actions.length) return result('I could not match a desk action. Try “show only extras”, “compare this change”, “show pending payments”, “review final invoice”, or “save layout”.');
  const t = context.totals;
  return result(actions.some(action => action.type === 'layout' && action.view === 'money') ? `Demo totals: agreed ${money(t.agreed)}, invoiced ${money(t.invoiced)}, confirmed ${money(t.paid)}, outstanding ${money(t.outstanding)}. Opening the money view.` : undefined);
}
