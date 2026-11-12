'use client';

import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { LoaderCircle } from 'lucide-react';
import Link from 'next/link';
import { money } from '@/lib/domain';
import { fundingAgentResponseSchema, type FundingAgentResponse } from '@/lib/funding-agent-contract';
import { buildFundingContext, fundingCommandResultSchema, type FundingCommandAction, type FundingCommandContext, type FundingCommandResult } from '@/lib/funding-commands';
import type { SandboxProjectView } from '@/lib/sandbox-project-contract';
import { createLedgerPoller } from '@/lib/sandbox-ledger-poll';
import VoiceCommandPanel, { type VoiceCommandExecution } from './voice-command-panel';

const providers = [
  { id: 'funding-nebius', label: 'Nebius · natural language', route: 'NEBIUS / SANDBOX', requiresModel: true, disclosure: 'Run sends your request and minimal sandbox project details to Nebius. Draft preparation has a separate preview; sending always needs review.', notice: 'Nebius interprets your request. The server resolves sandbox records and validates every action; a model cannot approve, send, or confirm payment.' },
  { id: 'funding-local', label: 'Funding · local rules', route: 'SANDBOX / LOCAL RULES', suggestions: ['Show projects', 'Show payments', 'Inspect deposit invoice', 'Prepare next invoice'], notice: 'Local rules use fixed phrases and the sandbox ledger. No simulated Demo data authorizes a financial action.' },
];
type DraftPreview = Extract<FundingAgentResponse, { kind: 'draft-preview' }>;

async function naturalCommand(body: object, signal?: AbortSignal): Promise<FundingAgentResponse> {
  const timeout = AbortSignal.timeout(35_000);
  const response = await fetch('/api/paypal-sandbox/plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof result?.error === 'string' ? result.error : 'Nebius Funding is unavailable. No local fallback was applied.');
  const parsed = fundingAgentResponseSchema.safeParse(result);
  if (!parsed.success) throw new Error('The Funding planner returned an invalid result. Inspect the original project before retrying.');
  return parsed.data;
}

async function command(action: 'plan' | 'run', message: string, context: FundingCommandContext, signal?: AbortSignal): Promise<FundingCommandResult> {
  const timeout = AbortSignal.timeout(30_000);
  const response = await fetch('/api/paypal-sandbox/command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, message, context }), cache: 'no-store', signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === 'string' ? body.error : 'The Funding command could not be completed.');
  const result = fundingCommandResultSchema.safeParse(body);
  if (!result.success) throw new Error('Funding returned an invalid command result. Reopen the project before continuing.');
  return result.data;
}

export default function FundingCommandDock({ projects: suppliedProjects, projectId, invoiceId, disabled = false, onInspect, onInspectInvoice }: {
  projects?: SandboxProjectView[];
  projectId?: string;
  invoiceId?: string;
  disabled?: boolean;
  onInspect?: (action: Extract<FundingCommandAction, { type: 'inspect' }>) => void;
  onInspectInvoice?: () => void;
}) {
  const router = useRouter(); const path = usePathname();
  const [fetchedProjects, setFetchedProjects] = useState<SandboxProjectView[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [proposal, setProposal] = useState<{ value: DraftPreview; key: string } | null>(null);
  const [applying, setApplying] = useState(false);
  const [feedback, setFeedback] = useState('');
  const applyingLock = useRef(false);
  const previewRef = useRef<HTMLElement>(null);
  // Project dashboards supply their existing poll. Invoice pages share this same
  // context contract without treating a standalone invoice as a project.
  const needsProjects = suppliedProjects === undefined;
  useEffect(() => {
    if (!needsProjects) return;
    const poller = createLedgerPoller<SandboxProjectView[]>({
      isVisible: () => document.visibilityState === 'visible',
      read: async signal => {
        const response = await fetch('/api/paypal-sandbox/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }), cache: 'no-store', signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
        const body = await response.json();
        if (!response.ok || body.mode !== 'paypal-sandbox' || !Array.isArray(body.projects)) throw new Error('Sandbox project context unavailable.');
        return body.projects;
      },
      onValue: value => { setFetchedProjects(previous => JSON.stringify(previous) === JSON.stringify(value) ? previous : value); setLoaded(true); },
      onError: () => setLoaded(false), onBusy: () => {},
    });
    const visibility = () => poller.visibilityChanged(); const focus = () => poller.refresh();
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); poller.start();
    return () => { poller.dispose(); document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); };
  }, [needsProjects]);
  const projects = suppliedProjects ?? fetchedProjects;
  const context = buildFundingContext(projects, projectId);
  const unavailable = disabled || (needsProjects && !loaded) || (!!projectId && !context.projectId);
  const contextKey = JSON.stringify([path, unavailable, context]);
  const currentKey = useRef(contextKey); currentKey.current = contextKey;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (proposal && proposal.key !== contextKey && !applyingLock.current) {
      setProposal(null); setFeedback('The project or its funding changed. Run your request again to review a fresh draft preview.');
    }
  }, [contextKey, proposal]);
  useEffect(() => {
    if (!proposal) return;
    previewRef.current?.focus({ preventScroll: true });
    previewRef.current?.scrollIntoView({ block: 'nearest' });
    const timer = setTimeout(() => {
      if (!applyingLock.current) { setProposal(null); setFeedback('This draft preview expired. Run your request again; no draft was prepared.'); }
    }, Math.max(0, Date.parse(proposal.value.expiresAt) - Date.now()));
    return () => clearTimeout(timer);
  }, [proposal]);

  function applyView(action: Exclude<FundingCommandAction, { type: 'invoice' }>) {
    if (action.type === 'projects') router.push('/sandbox/projects');
    else if (action.type === 'project') router.push(`/sandbox/projects/${action.projectId}`);
    else if (action.invoiceId && action.invoiceId === invoiceId && onInspectInvoice) onInspectInvoice();
    else if (action.invoiceId) router.push(`/sandbox/${action.invoiceId}?inspect=payments`);
    else if (onInspect && action.projectId === projectId) onInspect(action);
    else {
      const query = new URLSearchParams({ inspect: action.section });
      if (action.changeId) query.set('change', action.changeId);
      router.push(`/sandbox/projects/${action.projectId}?${query.toString()}`);
    }
  }

  async function prepareReviewedDraft() {
    if (!proposal || applyingLock.current || unavailable) return;
    const reviewed = proposal;
    if (currentKey.current !== reviewed.key || Date.parse(reviewed.value.expiresAt) <= Date.now()) {
      setProposal(null); setFeedback('This draft preview is stale. Run your request again.'); return;
    }
    applyingLock.current = true; setApplying(true); setFeedback('');
    try {
      const prepared = await naturalCommand({ action: 'apply', token: reviewed.value.token, context: reviewed.value.context });
      const expected = reviewed.value.action;
      if (prepared.kind !== 'draft-prepared' || prepared.action.projectId !== expected.projectId || prepared.action.purpose !== expected.purpose || prepared.action.sourceId !== expected.sourceId || prepared.action.sourceVersion !== expected.sourceVersion || prepared.action.amountCents !== expected.amountCents || (expected.invoiceId && prepared.preparation.invoiceId !== expected.invoiceId)) throw new Error('The returned draft does not match the reviewed source.');
      if (!mounted.current) return;
      setProposal(null); setFeedback(prepared.message);
      // A visible-ledger poll may have already observed our own reservation.
      if (currentKey.current === reviewed.key || currentKey.current === JSON.stringify([path, false, prepared.context])) router.push(`/sandbox/${prepared.preparation.invoiceId}`);
      else setFeedback(`${prepared.message} Your view changed; inspect the original project for its invoice.`);
    } catch (error) {
      if (mounted.current) { setProposal(null); setFeedback(`${error instanceof Error ? error.message : 'Draft preparation could not be confirmed.'} The request may have reached the server. Check the original project for a prepared draft before retrying.`); }
    } finally { applyingLock.current = false; if (mounted.current) setApplying(false); }
  }

  async function run(message: string, provider: string, execution: VoiceCommandExecution) {
    setFeedback('');
    if (provider === 'funding-nebius') {
      const planned = await naturalCommand({ action: 'plan', message, context }, execution.signal);
      execution.assertCurrent();
      if (planned.kind === 'clarification') return { message: planned.message, summary: 'Nebius · clarification needed' };
      if (planned.kind === 'view') { execution.beginApply(); applyView(planned.action); return { message: planned.message, summary: 'Nebius · Funding view' }; }
      if (planned.kind !== 'draft-preview' || planned.context.projectId !== context.projectId || JSON.stringify(planned.context) !== JSON.stringify(context)) throw new Error('The draft preview does not match the selected project. Reopen its current funding.');
      // This applies only a review panel. The later Prepare button owns its own
      // request lifecycle; it never reuses this execution or calls the model again.
      execution.beginApply();
      setProposal({ value: planned, key: contextKey });
      return { message: 'Review the proposed invoice below. No draft has been prepared or sent.', summary: 'Nebius · draft preview' };
    }
    if (provider !== 'funding-local') throw new Error('This Funding provider is unavailable.');
    const planned = await command('plan', message, context, execution.signal);
    execution.assertCurrent();
    if (planned.action.type === 'invoice') {
      execution.beginApply();
      // Once issued, a local reservation must be reconciled, never described as canceled.
      const prepared = await command('run', message, context);
      if (!prepared.preparation || prepared.action.type !== 'invoice' || prepared.action.projectId !== planned.action.projectId || prepared.action.purpose !== planned.action.purpose || prepared.action.sourceId !== planned.action.sourceId || prepared.action.sourceVersion !== planned.action.sourceVersion || prepared.action.amountCents !== planned.action.amountCents || (planned.action.invoiceId && prepared.action.invoiceId !== planned.action.invoiceId)) throw new Error('The prepared source did not match the reviewed command. Inspect the original project.');
      let canNavigate = false;
      try { execution.assertCurrent(); canNavigate = true; }
      catch {
        // A poll can observe our own successful reservation before its response.
        // Accept only that exact returned context, on the same available screen.
        canNavigate = mounted.current && currentKey.current === JSON.stringify([path, false, prepared.context]);
      }
      if (canNavigate) router.push(`/sandbox/${prepared.preparation.invoiceId}`);
      return { message: prepared.message + (canNavigate ? '' : ' Your view changed; the invoice remains on the original project.'), summary: prepared.preparation.existing ? 'Original invoice retained' : 'Local sandbox draft prepared' };
    }
    execution.beginApply();
    applyView(planned.action);
    return { message: planned.message, summary: 'Funding view updated' };
  }

  return <>
    <VoiceCommandPanel contextKey={contextKey} disabled={unavailable || !!proposal || applying} focusEvent="funding:focus-command" label="Funding voice and text controls" inputLabel="Funding command" runLabel="Run Funding command" maxLength={1000} placeholder={projectId ? 'Has the client paid? Get my next invoice ready…' : 'Take me to the website project…'} providers={providers} initialProvider="funding-nebius" suggestions={projectId ? ['What has the client paid so far?', 'Get the next invoice ready for me', 'Take me back to my projects'] : ['Show me all my projects', ...projects.slice(0, 2).map(view => `Take me to ${view.project.terms.title}`)]} safetyNotice="Preparing saves a local draft only. Scope agreement, change approval, delivery acceptance, and sending require their separate explicit reviews. Pending payments never count as collected." applicationKind="draft" run={run} />
    {proposal && <section ref={previewRef} tabIndex={-1} className="funding-voice-preview" aria-label="Review voice invoice draft"><div className="funding-preview-heading"><span>NEBIUS / DRAFT PREVIEW</span><strong>{money(proposal.value.preview.amountCents)} <small>USD</small></strong></div><h2>{proposal.value.preview.projectTitle}</h2><p>{proposal.value.preview.sourceTitle} · source v{proposal.value.action.sourceVersion}{proposal.value.preview.existing ? ' · original invoice already reserved' : ''}</p><p>{proposal.value.message}</p><p className="sandbox-note">Server-checked sandbox terms. This step {proposal.value.preview.existing ? 'opens the original invoice' : 'prepares a local draft'}; it does not approve or send it. Preview expires after two minutes.</p><div className="form-actions"><Link className="button" href={`/sandbox/projects/${proposal.value.action.projectId}`}>Inspect project</Link><button className="button" type="button" disabled={applying} onClick={() => { setProposal(null); setFeedback('Draft preview dismissed. Nothing was prepared or sent.'); }}>Cancel preview</button><button className="button primary" type="button" disabled={applying || unavailable || proposal.key !== contextKey} onClick={() => void prepareReviewedDraft()}>{applying ? <><LoaderCircle size={14} className="sandbox-spin" />Preparing…</> : proposal.value.preview.existing ? 'Open original invoice' : 'Prepare sandbox draft'}</button></div></section>}
    {feedback && <p className="funding-command-feedback" role="status">{feedback}</p>}
  </>;
}
