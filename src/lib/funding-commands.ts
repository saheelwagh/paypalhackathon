import { z } from 'zod';
import { sandboxChangeId, sandboxProjectId, type SandboxProjectView } from './sandbox-project-contract';

export class FundingCommandError extends Error {
  constructor(message: string, public status = 400) { super(message); this.name = 'FundingCommandError'; }
}

const revision = z.number().int().positive();
const invoiceId = z.string().regex(/^sbx_[a-f0-9-]{36}$/);
const purpose = z.enum(['deposit', 'change', 'final']);
const section = z.enum(['funding', 'payments', 'deposit', 'change', 'final']);
export const fundingCommandContextSchema = z.object({
  projectId: sandboxProjectId.optional(), revision: revision.optional(), fingerprint: z.string().min(1).max(14_000).optional(),
}).strict().refine(value => (!value.projectId && !value.revision && !value.fingerprint) || !!(value.projectId && value.revision && value.fingerprint), 'Use a complete selected-project context.');
export type FundingCommandContext = z.infer<typeof fundingCommandContextSchema>;

/** A concurrency token, not authority: only server-owned ledger records can authorize preparation. */
export function buildFundingContext(projects: SandboxProjectView[], selectedId?: string): FundingCommandContext {
  const view = projects.find(item => item.project.id === selectedId);
  if (!view) return {};
  const snapshots = view.invoices.map(invoice => [
    invoice.id, invoice.version, invoice.state, invoice.confirmedCents, invoice.pendingCents,
    invoice.provider?.provider ?? null, invoice.provider?.status ?? null,
  ]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { projectId: view.project.id, revision: view.project.revision,
    fingerprint: JSON.stringify([view.project.id, view.project.revision, snapshots]) };
}

export const fundingCommandSchema = z.object({
  action: z.enum(['plan', 'run']), message: z.string().trim().min(1).max(500), context: fundingCommandContextSchema,
}).strict();
export type FundingCommandRequest = z.infer<typeof fundingCommandSchema>;
export const fundingCommandActionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('projects') }).strict(),
  z.object({ type: z.literal('project'), projectId: sandboxProjectId }).strict(),
  z.object({ type: z.literal('inspect'), projectId: sandboxProjectId, section, changeId: sandboxChangeId.optional(), invoiceId: invoiceId.optional() }).strict(),
  z.object({ type: z.literal('invoice'), projectId: sandboxProjectId, purpose, sourceId: z.union([sandboxProjectId, sandboxChangeId]), sourceVersion: revision,
    amountCents: z.number().int().min(1).max(99_999_999), invoiceId: invoiceId.optional() }).strict(),
]);
export const fundingCommandResultSchema = z.object({
  provider: z.literal('funding-local'), message: z.string().min(1).max(1000), context: fundingCommandContextSchema,
  action: fundingCommandActionSchema, preparation: z.object({ invoiceId, existing: z.boolean() }).strict().optional(),
}).strict().superRefine((result, ctx) => {
  if (result.action.type === 'projects' && result.context.projectId) ctx.addIssue({ code: 'custom', message: 'Project-list navigation must clear the selected-project context.' });
  if (result.action.type !== 'projects' && result.action.projectId !== result.context.projectId) ctx.addIssue({ code: 'custom', message: 'The action must match its selected-project context.' });
  if (result.preparation && (result.action.type !== 'invoice' || result.action.invoiceId !== result.preparation.invoiceId)) ctx.addIssue({ code: 'custom', message: 'Prepared invoice identity must match the action.' });
  if (result.action.type === 'invoice' && ((result.action.purpose === 'change') !== result.action.sourceId.startsWith('sbxc_'))) ctx.addIssue({ code: 'custom', message: 'Invoice source must match its purpose.' });
  if (result.action.type === 'invoice' && result.action.purpose !== 'change' && result.action.sourceId !== result.action.projectId) ctx.addIssue({ code: 'custom', message: 'Baseline invoice source must be its selected project.' });
  if (result.action.type === 'inspect' && ((result.action.section === 'change') !== !!result.action.changeId)) ctx.addIssue({ code: 'custom', message: 'Change inspection requires its own change identity.' });
});
export type FundingCommandResult = z.infer<typeof fundingCommandResultSchema>;
export type FundingCommandAction = z.infer<typeof fundingCommandActionSchema>;
export type FundingCommandIntent =
  | { type: 'projects' }
  | { type: 'project'; selector: string }
  | { type: 'inspect'; section: z.infer<typeof section>; projectSelector?: string; changeSelector?: string; invoiceId?: string }
  | { type: 'prepare'; purpose: 'next' | z.infer<typeof purpose>; projectSelector?: string; changeSelector?: string };

export const FUNDING_COMMAND_HELP = 'Try “show projects”, “open project NAME”, “show payments”, “inspect deposit invoice”, “prepare next invoice”, or “prepare change NAME invoice”. Select a project before preparing. Approvals, sending, and payments require their separate review controls.';
export const normalizeFundingName = (value: string) => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
function selector(value: string): string {
  const unquoted = value.trim().replace(/^(["“'])(.*)["”']$/, '$2').trim();
  if (!unquoted || unquoted.length > 150) throw new FundingCommandError(FUNDING_COMMAND_HELP);
  return unquoted;
}

/** Deliberately small grammar: one reversible view or one locally prepared invoice per utterance. */
export function parseFundingCommand(message: string): FundingCommandIntent {
  if (typeof message !== 'string' || !message.trim() || message.length > 500) throw new FundingCommandError(FUNDING_COMMAND_HELP);
  const raw = message.normalize('NFKC').trim();
  if (/[\n\r;|&]/.test(raw) || /\b(?:and|then|also|after|before|plus|followed)\b/i.test(raw)
    || /\b(?:send|sending|pay|paying|approve|approved|approval|accept|accepted|agree|agreement|refund|refunding|delete|remove|cancel|charge|capture|transfer|withdraw|void|settle|submit|sign|authorize|confirm|record|mark|set|update|edit|execute)\b/i.test(raw)) {
    throw new FundingCommandError('Funding voice commands cannot approve, send, pay, or combine actions. ' + FUNDING_COMMAND_HELP);
  }
  const text = raw.replace(/^please\s+/i, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim();
  if (/^(?:show|list|open)(?: (?:all|my|sandbox))? projects$/i.test(text)) return { type: 'projects' };
  const explicitProject = /^(?:open|select|show) project (.+)$/i.exec(text);
  if (explicitProject) return { type: 'project', selector: selector(explicitProject[1]) };

  // An explicit "for project" suffix also supports names containing the word "for".
  const split = /^(.*?) for (?:project )?(.+)$/i.exec(text);
  const body = split?.[1] ?? text;
  const projectSelector = split ? selector(split[2]) : undefined;
  const target = projectSelector ? { projectSelector } : {};

  const prepare = /^(?:prepare|draft) (?:the )?(.+)$/i.exec(body);
  if (prepare) {
    const phrase = prepare[1];
    const basic = /^(?:(next|deposit|final)(?: milestone)? )?invoice$/i.exec(phrase);
    if (basic) return { type: 'prepare', purpose: (basic[1]?.toLowerCase() ?? 'next') as 'next' | 'deposit' | 'final', ...target };
    const named = /^change (.+) invoice$/i.exec(phrase) ?? /^change invoice (?:named )?(.+)$/i.exec(phrase);
    if (named) return { type: 'prepare', purpose: 'change', changeSelector: selector(named[1]), ...target };
    if (/^change invoice$/i.test(phrase)) return { type: 'prepare', purpose: 'change', ...target };
    throw new FundingCommandError(FUNDING_COMMAND_HELP);
  }

  const inspect = /^(?:show|inspect|open|list) (?:the )?(.+)$/i.exec(body);
  if (inspect) {
    const phrase = inspect[1];
    const basic = /^(funding|payments|deposit|final|change)(?: invoice)?$/i.exec(phrase);
    if (basic) return { type: 'inspect', section: basic[1].toLowerCase() as z.infer<typeof section>, ...target };
    const specific = /^invoice (sbx_[a-f0-9-]{36})$/i.exec(phrase);
    if (specific) return { type: 'inspect', section: 'payments', invoiceId: specific[1].toLowerCase(), ...target };
    const named = /^change (.+) invoice$/i.exec(phrase) ?? /^change invoice (?:named )?(.+)$/i.exec(phrase);
    if (named) return { type: 'inspect', section: 'change', changeSelector: selector(named[1]), ...target };
  }

  const project = /^(?:open|select|show) (?:project )?(.+)$/i.exec(text);
  if (project && !/\b(?:invoice|payments|funding|projects)\b/i.test(project[1])) return { type: 'project', selector: selector(project[1]) };
  throw new FundingCommandError(FUNDING_COMMAND_HELP);
}
