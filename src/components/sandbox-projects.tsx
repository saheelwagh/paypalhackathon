'use client';

import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, FileCheck2, LoaderCircle, Pencil, Plus, RefreshCw, X } from 'lucide-react';
import { money, parseUsd } from '@/lib/domain';
import type { SandboxInvoice, SandboxWebhookStatus } from '@/lib/sandbox-contract';
import type { SandboxProject, SandboxProjectTerms, SandboxProjectView, SandboxProjectFunding, SandboxFundingObligation, SandboxChangeTerms } from '@/lib/sandbox-project-contract';
import { createLedgerPoller, type LedgerPoller } from '@/lib/sandbox-ledger-poll';
import { RecordsGrid } from './grid';
import FundingCommandDock from './funding-command-dock';
import type { FundingCommandAction } from '@/lib/funding-commands';
import { Badge, Card, Empty, Field, PageTitle, SearchBox } from './ui';
import './sandbox.css';
import './sandbox-projects.css';

type ListResponse = { projects: SandboxProjectView[]; configured: boolean; mode: 'paypal-sandbox'; ledgerReadAt: string; webhooks: SandboxWebhookStatus };
type MutationResponse = { project: SandboxProjectView; invoice?: SandboxInvoice };
type ProjectFields = { title: string; recipientEmail: string; scope: string; baseAmount: string; deposit: string };
type ChangeFields = { title: string; description: string; amount: string };
type Editor = { kind: 'project' | 'change-new' | 'change-edit' | 'delivery'; revision: number; version: number; changeId?: string; requestId: string };
type Inspector = 'scope' | 'changes' | 'delivery' | 'ledger';
type Review = { kind: 'project' | 'approve-change' | 'agree-change' | 'delivery'; view: SandboxProjectView; changeId?: string };
const emptyProject: ProjectFields = { title: '', recipientEmail: '', scope: '', baseAmount: '', deposit: '' };
const emptyChange: ChangeFields = { title: '', description: '', amount: '' };
const friendly = (value: string) => value.replaceAll('-', ' ');
const projectColumns = [
  { field: 'title', headerName: 'PROJECT', width: 190, flex: 1.4 },
  { field: 'agreed', headerName: 'AGREED · USD', money: true, width: 110 },
  { field: 'confirmed', headerName: 'CONFIRMED · USD', money: true, width: 125 },
  { field: 'pending', headerName: 'PENDING · USD', money: true, width: 110 },
  { field: 'unbilled', headerName: 'UNBILLED · USD', money: true, width: 115 },
  { field: 'status', headerName: 'FUNDING STAGE', status: true, width: 190, flex: 1.5 },
];
const obligationColumns = [
  { field: 'title', headerName: 'OBLIGATION', width: 215, flex: 1.5 },
  { field: 'amount', headerName: 'AMOUNT · USD', money: true, width: 120 },
  { field: 'confirmed', headerName: 'CONFIRMED · USD', money: true, width: 125 },
  { field: 'pending', headerName: 'PENDING · USD', money: true, width: 110 },
  { field: 'status', headerName: 'INVOICE / FUNDING', status: true, width: 170, flex: 1.3 },
  { field: 'version', headerName: 'SOURCE VERSION', width: 130 },
];

async function request<T>(body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/paypal-sandbox/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal });
  const value = await response.json().catch(() => ({ error: 'The project ledger returned an unreadable response. Reopen the current record before retrying.' }));
  if (!response.ok) throw new Error(typeof value.error === 'string' ? value.error : 'The sandbox project request failed.');
  return value as T;
}

function ReviewDialog({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const heading = useId();
  const close = useRef(onClose); close.current = onClose;
  const pending = useRef(busy); pending.current = busy;
  useEffect(() => {
    const dialog = ref.current!; dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); if (!pending.current) close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); };
  }, []);
  return <dialog ref={ref} className="sandbox-dialog sandbox-project-review" aria-labelledby={heading} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}><div className="modal-heading"><h2 id={heading}>{title}</h2><button className="icon-button" type="button" aria-label="Close sandbox project review" disabled={busy} onClick={onClose}><X size={19} /></button></div>{children}</dialog>;
}

export default function SandboxProjectsPage({ id }: { id?: string }) {
  const router = useRouter(); const searchParams = useSearchParams(); const inspectorId = useId();
  const [projects, setProjects] = useState<SandboxProjectView[]>([]);
  const [configured, setConfigured] = useState(false); const [loaded, setLoaded] = useState(false); const [loading, setLoading] = useState(false);
  const [webhooks, setWebhooks] = useState<SandboxWebhookStatus | null>(null); const [ledgerReadAt, setLedgerReadAt] = useState('');
  const [syncError, setSyncError] = useState(''); const [visible, setVisible] = useState(true);
  const [error, setError] = useState(''); const [notice, setNotice] = useState(''); const [busy, setBusy] = useState(false);
  const [inspector, setInspector] = useState<Inspector | null>(null); const [obligationKey, setObligationKey] = useState('');
  const inspectorRef = useRef<HTMLElement>(null); const [voiceInspection, setVoiceInspection] = useState(0);
  const [query, setQuery] = useState(''); const [editor, setEditor] = useState<Editor | null>(null);
  const [projectFields, setProjectFields] = useState<ProjectFields>(emptyProject); const [changeFields, setChangeFields] = useState<ChangeFields>(emptyChange); const [deliverySummary, setDeliverySummary] = useState('');
  const [review, setReview] = useState<Review | null>(null); const [acknowledged, setAcknowledged] = useState(false);
  const mounted = useRef(false); const busyLock = useRef(false); const poller = useRef<LedgerPoller | null>(null); const createKey = useRef('');
  const selected = projects.find(view => view.project.id === id); const creating = id === 'new';

  useEffect(() => {
    mounted.current = true;
    const controller = createLedgerPoller<ListResponse>({
      isVisible: () => document.visibilityState === 'visible',
      read: async signal => {
        const result = await request<ListResponse>({ action: 'list' }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        if (result.mode !== 'paypal-sandbox' || !Array.isArray(result.projects)) throw new Error('The server did not return the sandbox project ledger.');
        return result;
      },
      onValue: result => { setProjects(previous => JSON.stringify(previous) === JSON.stringify(result.projects) ? previous : result.projects); setConfigured(result.configured); setLoaded(true); setWebhooks(result.webhooks); setLedgerReadAt(result.ledgerReadAt); setSyncError(''); },
      onError: cause => setSyncError(cause instanceof Error ? cause.message : 'The sandbox project ledger is unavailable.'), onBusy: setLoading,
    });
    poller.current = controller;
    const visibility = () => { setVisible(document.visibilityState === 'visible'); controller.visibilityChanged(); };
    const focus = () => controller.refresh();
    setVisible(document.visibilityState === 'visible'); document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus); controller.start();
    return () => { mounted.current = false; controller.dispose(); if (poller.current === controller) poller.current = null; document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus); };
  }, []);
  useEffect(() => { setInspector(null); setObligationKey(''); setEditor(null); setReview(null); setAcknowledged(false); setError(''); setNotice(''); setProjectFields(emptyProject); setChangeFields(emptyChange); setDeliverySummary(''); createKey.current = crypto.randomUUID(); }, [id]);
  const inspectSection = searchParams.get('inspect'); const inspectChange = searchParams.get('change');
  const selectedProjectId = selected?.project.id;
  useEffect(() => {
    if (!selectedProjectId || !inspectSection || !['funding', 'payments', 'deposit', 'change', 'final'].includes(inspectSection)) return;
    setInspector('ledger');
    setVoiceInspection(value => value + 1);
    setObligationKey(inspectSection === 'deposit' || inspectSection === 'final' ? `${inspectSection}:${selectedProjectId}` : inspectSection === 'change' && inspectChange ? `change:${inspectChange}` : '');
  }, [selectedProjectId, inspectSection, inspectChange]);
  useEffect(() => { if (voiceInspection) inspectorRef.current?.scrollIntoView({ block: 'start' }); }, [voiceInspection]);
  function inspectFromCommand(action: Extract<FundingCommandAction, { type: 'inspect' }>) {
    setInspector('ledger');
    setVoiceInspection(value => value + 1);
    setObligationKey(action.section === 'deposit' || action.section === 'final' ? `${action.section}:${action.projectId}` : action.section === 'change' && action.changeId ? `change:${action.changeId}` : '');
  }

  async function act(body: object, success: string): Promise<MutationResponse | undefined> {
    if (busyLock.current) return;
    busyLock.current = true; setBusy(true); setError(''); setNotice(''); poller.current?.suspend();
    try {
      const result = await request<MutationResponse>(body);
      if (!mounted.current) return;
      setProjects(previous => [result.project, ...previous.filter(view => view.project.id !== result.project.project.id)]); setNotice(success);
      return result;
    } catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'The sandbox project request failed. Current records were preserved.'); }
    finally { busyLock.current = false; if (mounted.current) { setBusy(false); poller.current?.resume(); } }
  }
  function openEditor(kind: Editor['kind'], changeId?: string) {
    if (!selected) return;
    const project = selected.project; const change = project.changes.find(item => item.id === changeId);
    setError(''); setNotice(''); setEditor({ kind, revision: project.revision, version: change?.version ?? project.version, changeId, requestId: crypto.randomUUID() });
    if (kind === 'project') setProjectFields({ title: project.terms.title, recipientEmail: project.terms.recipientEmail, scope: project.terms.scope, baseAmount: (project.terms.baseAmountCents / 100).toFixed(2), deposit: (project.terms.depositCents / 100).toFixed(2) });
    if (kind === 'change-new' || kind === 'change-edit') setChangeFields(change ? { title: change.title, description: change.description, amount: (change.amountCents / 100).toFixed(2) } : emptyChange);
    if (kind === 'delivery') setDeliverySummary(project.delivery?.summary ?? '');
  }
  function openReview(kind: Review['kind'], changeId?: string) { if (selected) { setError(''); setAcknowledged(false); setReview({ kind, view: structuredClone(selected), changeId }); } }
  const staleEditor = !!editor && (!selected || selected.project.revision !== editor.revision);
  const staleReview = !!review && (!selected || selected.project.revision !== review.view.project.revision);

  async function saveProject(event: FormEvent) {
    event.preventDefault(); setError('');
    let terms: SandboxProjectTerms;
    try {
      terms = { title: projectFields.title.trim(), recipientEmail: projectFields.recipientEmail.trim(), scope: projectFields.scope.trim(), baseAmountCents: parseUsd(projectFields.baseAmount), depositCents: parseUsd(projectFields.deposit), currency: 'USD' };
      if (terms.depositCents <= 0 || terms.baseAmountCents <= terms.depositCents) throw new Error('The deposit must be greater than $0 and less than the base scope amount.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Enter exact dollar amounts with at most two decimal places.'); return; }
    const result = await act(creating ? { action: 'create-project', requestId: createKey.current, terms } : { action: 'edit-project', id, revision: editor!.revision, version: editor!.version, terms }, 'Sandbox scope saved. Record agreement on this exact version before preparing the deposit.');
    if (result) { setEditor(null); router.push(`/sandbox/projects/${result.project.project.id}`); }
  }
  async function saveChange(event: FormEvent) {
    event.preventDefault(); setError(''); if (!editor || !selected) return;
    let terms: SandboxChangeTerms;
    try { terms = { title: changeFields.title.trim(), description: changeFields.description.trim(), amountCents: parseUsd(changeFields.amount) }; if (terms.amountCents <= 0) throw new Error('A billable change must be greater than $0.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Enter an exact change amount.'); return; }
    const result = await act(editor.kind === 'change-new' ? { action: 'add-change', id, revision: editor.revision, requestId: editor.requestId, terms } : { action: 'edit-change', id, revision: editor.revision, changeId: editor.changeId, version: editor.version, terms }, 'Change saved. Owner review and sandbox agreement are separate decisions on this version.');
    if (result) setEditor(null);
  }
  async function submitDelivery(event: FormEvent) {
    event.preventDefault(); if (!editor) return;
    const result = await act({ action: 'submit-delivery', id, revision: editor.revision, summary: deliverySummary.trim() }, 'Delivery submitted. Record its separate sandbox acceptance before preparing the final invoice.');
    if (result) setEditor(null);
  }
  async function confirmReview() {
    if (!review || !acknowledged || staleReview) return;
    const project = review.view.project; const change = project.changes.find(item => item.id === review.changeId);
    const base = { id: project.id, revision: project.revision, confirmSandbox: true };
    const command = review.kind === 'project' ? { ...base, action: 'agree-project', version: project.version }
      : review.kind === 'delivery' ? { ...base, action: 'accept-delivery', version: project.delivery!.version }
      : { ...base, action: review.kind, changeId: change!.id, version: change!.version };
    const result = await act(command, review.kind === 'approve-change' ? 'Owner change review recorded for this exact version.' : review.kind === 'delivery' ? 'Sandbox delivery acceptance recorded. The final invoice still needs its own send review.' : 'Sandbox agreement recorded for this exact version. No payment has been assumed.');
    if (result) { setReview(null); setAcknowledged(false); }
  }
  async function prepare(obligation: SandboxFundingObligation) {
    if (!selected) return;
    const result = await act({ action: 'prepare-invoice', id: selected.project.id, revision: selected.project.revision, version: obligation.sourceVersion, purpose: obligation.purpose, ...(obligation.purpose === 'change' ? { changeId: obligation.sourceId } : {}) }, 'Prepared the reserved sandbox invoice. Review its exact terms before sending.');
    if (result?.invoice) router.push(`/sandbox/${result.invoice.id}`);
  }

  const focusedObligation = selected?.funding.obligations.find(item => `${item.purpose}:${item.sourceId}` === obligationKey);
  function inspectObligation(obligation: SandboxFundingObligation) {
    setObligationKey(`${obligation.purpose}:${obligation.sourceId}`); setInspector('ledger');
  }
  function inspectNextStep() {
    if (!selected) return;
    const { project, funding } = selected;
    if (!project.agreement) { setInspector('scope'); return; }
    if (funding.status === 'ready-for-delivery' || funding.status === 'awaiting-delivery-acceptance') { setInspector('delivery'); return; }
    if (funding.status === 'changes-unfunded' && project.changes.some(change => !change.agreement)) { setInspector('changes'); return; }
    const next = funding.obligations.find(item => !item.funded && (item.purpose !== 'final' || !!project.delivery?.acceptance)) ?? funding.obligations.find(item => item.purpose === 'final');
    if (next) inspectObligation(next); else setInspector('ledger');
  }
  const form = creating || !!editor;
  const closeEditor = () => { setEditor(null); setError(''); if (creating) router.push('/sandbox/projects'); };
  const errorBox = error ? <div className="sandbox-error" role="alert">{error}</div> : null;
  return <div className="sandbox-page sandbox-projects-page">
    {selected && !form ? <div className="sandbox-console-title"><Link href="/sandbox/projects">funding /</Link><h1>{selected.project.terms.title}</h1><Badge>{friendly(selected.funding.status)}</Badge></div> : <PageTitle eyebrow="PAYPAL / SANDBOX" title={creating ? 'new engagement.' : 'funding console.'} subtitle="Deposit → changes → final collection" actions={!form ? <Link className="button primary" href="/sandbox/projects/new"><Plus size={15} />New project</Link> : undefined} />}
    <div className="sandbox-console-meta"><nav className="sandbox-project-nav" aria-label="Sandbox workspace"><Link href="/sandbox/projects" aria-current="page">Project funding</Link><Link href="/sandbox">Invoice ledger</Link></nav>
    <div className="sandbox-mode-strip"><span><i className="mode-led" />TEST FUNDS / LOCAL OWNER DECISIONS</span></div>
    <LiveFunding webhooks={webhooks} ledgerReadAt={ledgerReadAt} visible={visible} loading={loading} error={syncError} /></div>
    {!configured && loaded && <div className="sandbox-error" role="alert">PayPal sandbox keys are unavailable. Project drafts can be prepared, but provider sending and collection checks require the configured sandbox app.</div>}
    {!review && errorBox}
    {notice && <div className="sandbox-success" role="status"><Check size={16} />{notice}</div>}
    {form ? <>
      <button className="button small" type="button" disabled={busy} onClick={closeEditor}><ArrowLeft size={13} />{creating ? 'All sandbox projects' : 'Back to project'}</button>
      {staleEditor && <div className="sandbox-error" role="alert">This project changed while the editor was open. Return to the project and reopen the current version; your draft text has been preserved here.</div>}
      {creating || editor?.kind === 'project' ? <ProjectForm fields={projectFields} setFields={setProjectFields} onSubmit={saveProject} onCancel={closeEditor} busy={busy} stale={staleEditor} editing={!creating} />
        : editor?.kind === 'delivery' ? <Card className="padded sandbox-project-form"><h2>Submit delivery evidence</h2><p>Describe the delivered work and where it can be reviewed. Acceptance is a separate next step.</p><form onSubmit={submitDelivery}><Field label="Delivery summary" hint="A concrete description or reference for this sandbox delivery."><textarea required maxLength={1000} rows={5} value={deliverySummary} onChange={event => setDeliverySummary(event.target.value)} /></Field>{!selected?.funding.canSubmitDelivery && <div className="sandbox-project-warning">Delivery is blocked until the deposit and every agreed change are fully funded, with no unresolved change reviews.</div>}<div className="form-actions"><button type="button" className="button" disabled={busy} onClick={closeEditor}>Cancel</button><button type="submit" className="button primary" disabled={busy || staleEditor || !selected?.funding.canSubmitDelivery}>{busy ? 'Saving delivery…' : 'Submit delivery'}</button></div></form></Card>
          : <Card className="padded sandbox-project-form"><h2>{editor?.kind === 'change-edit' ? `Edit change · v${editor.version}` : 'Describe additional work'}</h2><p>Changes are billed separately. They never increase the original final milestone.</p><form onSubmit={saveChange}><Field label="Change title"><input required maxLength={100} value={changeFields.title} onChange={event => setChangeFields(previous => ({ ...previous, title: event.target.value }))} /></Field><Field label="Change description" hint="Describe the extra scope and its reviewed terms."><textarea required maxLength={700} rows={4} value={changeFields.description} onChange={event => setChangeFields(previous => ({ ...previous, description: event.target.value }))} /></Field><Field label="Change amount · USD" hint="Use exact dollars and cents."><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={changeFields.amount} onChange={event => setChangeFields(previous => ({ ...previous, amount: event.target.value }))} /></Field><div className="form-actions"><button type="button" className="button" disabled={busy} onClick={closeEditor}>Cancel</button><button type="submit" className="button primary" disabled={busy || staleEditor}>{busy ? 'Saving change…' : 'Save change for review'}</button></div></form></Card>}
    </> : selected ? <>
      <FundingMetrics funding={selected.funding} />
      <section className="sandbox-project-section" aria-label="Project obligations"><div className="sandbox-project-section-heading"><div><h2>Obligations ledger</h2><p>Select a row to inspect its invoice, funding, and next action.</p></div><span className="sandbox-reference">USD / {selected.funding.obligations.length} OBLIGATIONS</span></div><ObligationsGrid obligations={selected.funding.obligations} onSelect={inspectObligation} /></section>
      <div className="sandbox-project-next"><ArrowRight size={18} /><div><strong>{selected.funding.nextAction}</strong></div><button className="button primary" type="button" onClick={inspectNextStep}>{selected.funding.complete ? 'Inspect completed journey' : 'Open next step'}<ArrowRight size={13} /></button></div>
      {inspector && <section ref={inspectorRef} className="sandbox-console-inspector" aria-label="Project inspector"><div className="sandbox-console-inspector-heading"><span>PROJECT INSPECTOR / SCOPE v{selected.project.version}</span><button type="button" className="icon-button" aria-label="Close project inspector" onClick={() => setInspector(null)}><X size={16} /></button></div><div className="sandbox-console-tabs" role="tablist" aria-label="Project details">{(['scope', 'changes', 'delivery', 'ledger'] as const).map(tab => <button type="button" role="tab" id={`${inspectorId}-${tab}`} aria-controls={`${inspectorId}-panel`} aria-selected={inspector === tab} tabIndex={inspector === tab ? 0 : -1} key={tab} onClick={() => setInspector(tab)} onKeyDown={event => { const tabs = ['scope', 'changes', 'delivery', 'ledger'] as const; const index = tabs.indexOf(tab); const next = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index + tabs.length - 1) % tabs.length] : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs[3] : undefined; if (next) { event.preventDefault(); setInspector(next); document.getElementById(`${inspectorId}-${next}`)?.focus(); } }}>{tab === 'scope' ? '01 / Scope' : tab === 'changes' ? `02 / Changes (${selected.project.changes.length})` : tab === 'delivery' ? '03 / Delivery' : '04 / Evidence'}</button>)}</div>
      <div role="tabpanel" id={`${inspectorId}-panel`} aria-labelledby={`${inspectorId}-${inspector}`}>
      {inspector === 'scope' && <>
      <div className="sandbox-project-panel"><Card className="padded"><div className="sandbox-project-section-heading"><div><h2>Baseline scope</h2><p>Version {selected.project.version} · {selected.project.agreement ? 'Sandbox agreement recorded' : 'Awaiting explicit sandbox agreement'}</p></div></div><p className="sandbox-project-scope">{selected.project.terms.scope}</p><ProjectFacts project={selected.project} /><div className="sandbox-project-actions">{!selected.project.agreement && <><button className="button primary" type="button" disabled={busy} onClick={() => openReview('project')}><FileCheck2 size={14} />Review sandbox agreement</button><button className="button" type="button" disabled={busy} onClick={() => openEditor('project')}><Pencil size={14} />Edit scope</button></>}</div>{selected.project.agreement && <p className="sandbox-project-local-note">Recorded by the local sandbox owner on {new Date(selected.project.agreement.recordedAt).toLocaleString()}. This accepted version is preserved; additional work belongs in a separate change.</p>}</Card>
        <details className="sandbox-inspector sandbox-secondary-inspector"><summary>Agreement and funding rules</summary><div className="sandbox-inspector-body"><p className="sandbox-project-local-note">Agreements and delivery acceptance are explicitly reviewed decisions by the local sandbox owner. They are not authenticated client signatures. Only verified PayPal collection funds work; pending amounts do not unlock delivery.</p><p className="sandbox-project-local-note">A refund or reversal can reopen a shortfall. Records live in the separate local sandbox repository. PostgreSQL remains deferred.</p></div></details></div>
      </>}
      {inspector === 'changes' && <>
      <section className="sandbox-project-section" aria-label="Sandbox change reviews"><div className="sandbox-project-section-heading"><div><h2>Changes to the agreed work</h2><p>Owner approval and sandbox agreement are separate, version-bound decisions.</p></div><button className="button" type="button" disabled={busy || !selected.project.agreement || !!selected.project.delivery} onClick={() => openEditor('change-new')}><Plus size={14} />Add billable change</button></div>{!selected.funding.depositFunded && <p className="sandbox-project-local-note">Changes can be recorded after agreement; their invoices require a funded deposit.</p>}{selected.project.delivery && <p className="sandbox-project-local-note">The delivered scope is fixed. Finish this project’s final collection before starting a new engagement.</p>}{selected.project.changes.length ? <div className="sandbox-project-changes">{selected.project.changes.map(change => <article key={change.id} className="sandbox-project-change"><div className="sandbox-project-change-heading"><div><h3>{change.title}</h3><Badge>{change.agreement ? 'agreed' : change.approval ? 'awaiting agreement' : 'awaiting owner review'}</Badge></div><strong>{money(change.amountCents)}</strong></div><p>{change.description}</p><div className="sandbox-decision-trail"><span>Version {change.version}</span><span className={change.approval ? 'recorded' : ''}>{change.approval && <Check size={12} />}Owner review {change.approval ? 'recorded' : 'needed'}</span><span className={change.agreement ? 'recorded' : ''}>{change.agreement && <Check size={12} />}Agreement {change.agreement ? 'recorded' : 'needed'}</span></div><div className="sandbox-project-actions">{!change.approval && <button className="button primary" type="button" disabled={busy} onClick={() => openReview('approve-change', change.id)}>Review change v{change.version}</button>}{change.approval && !change.agreement && <button className="button primary" type="button" disabled={busy} onClick={() => openReview('agree-change', change.id)}>Record sandbox agreement</button>}{!change.agreement && <button className="button" type="button" disabled={busy} onClick={() => openEditor('change-edit', change.id)}><Pencil size={13} />Edit change</button>}</div></article>)}</div> : <div className="sandbox-project-empty">No additional work has been recorded.<p>A change gets its own reviewed scope, agreement, invoice, and collection.</p></div>}</section>
      </>}
      {inspector === 'delivery' && <>
      <section className="sandbox-project-section" aria-label="Sandbox delivery"><div className="sandbox-project-section-heading"><div><h2>Delivery and final collection</h2><p>The original final milestone is {money(selected.project.terms.baseAmountCents - selected.project.terms.depositCents)}.</p></div></div><Card className="padded">{selected.project.delivery ? <><div className="sandbox-project-change-heading"><h3>Delivery v{selected.project.delivery.version}</h3><Badge>{selected.project.delivery.acceptance ? 'acceptance recorded' : 'awaiting acceptance'}</Badge></div><p className="sandbox-project-scope">{selected.project.delivery.summary}</p><div className="sandbox-project-actions">{!selected.project.delivery.acceptance && <><button className="button primary" type="button" disabled={busy || !selected.funding.canAcceptDelivery} onClick={() => openReview('delivery')}>Review sandbox delivery acceptance</button><button className="button" type="button" disabled={busy || !selected.funding.canSubmitDelivery} onClick={() => openEditor('delivery')}><Pencil size={13} />Revise delivery</button></>}</div>{selected.project.delivery.acceptance && <p className="sandbox-project-local-note">Acceptance recorded on {new Date(selected.project.delivery.acceptance.recordedAt).toLocaleString()} by the local sandbox owner. Final collection is verified separately through PayPal.</p>}</> : <><p>Describe the delivered work once the deposit and all agreed changes are funded. A separate sandbox acceptance then unlocks the final invoice.</p><button className="button primary" type="button" disabled={busy || !selected.funding.canSubmitDelivery} onClick={() => openEditor('delivery')}>Prepare delivery submission</button></>}{!selected.funding.depositFunded || !selected.funding.changesFunded ? <div className="sandbox-project-warning">Delivery and final billing remain blocked by incomplete funding or unresolved changes. Pending payments do not satisfy this requirement.</div> : null}</Card></section>
      </>}
      {inspector === 'ledger' && <>
        {focusedObligation ? <ObligationAction obligation={focusedObligation} busy={busy} prepare={() => void prepare(focusedObligation)} /> : <p className="sandbox-project-local-note">Select an obligation in the grid to inspect its bound invoice.</p>}
        <JourneySteps view={selected} />
        <div className="sandbox-funding-breakdown"><div><small>INVOICED</small><strong>{money(selected.funding.invoicedCents)}</strong></div><div><small>PENDING · NOT COLLECTED</small><strong>{money(selected.funding.pendingCents)}</strong></div><div><small>OUTSTANDING</small><strong>{money(selected.funding.outstandingCents)}</strong></div></div>
        <ProjectPayments invoices={selected.invoices} />
        <p className="sandbox-project-local-note">The final remains {money(selected.project.terms.baseAmountCents - selected.project.terms.depositCents)}: original scope minus deposit. Changes have separate invoices. Pending payments never unlock work.</p>
        <p className="sandbox-reference">Project {selected.project.id} · revision {selected.project.revision}</p>
      </>}
      </div></section>}
    </> : id && loaded ? <Empty title="Sandbox project not found." text="This address does not identify a project in the separate sandbox ledger. Demo project IDs cannot be used here." action={<Link className="button" href="/sandbox/projects">Open project funding</Link>} /> : <>
      <PortfolioMetrics projects={projects} />
      <div className="sandbox-toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Find a sandbox project…" /><button className="button" type="button" disabled={busy || loading} onClick={() => poller.current?.refresh()}><RefreshCw size={14} className={loading ? 'sandbox-spin' : ''} />Refresh</button></div>
      <ProjectsGrid projects={projects} query={query} />
      {!projects.length && <Empty title={loaded ? 'Start with the agreed work.' : 'Reading sandbox projects…'} text={loaded ? 'Create a fresh sandbox project, review its scope, then follow the deposit → change → final journey with actual PayPal sandbox payments.' : 'Opening the independent project funding ledger.'} action={loaded ? <Link className="button primary" href="/sandbox/projects/new"><Plus size={14} />Create sandbox project</Link> : undefined} />}
      <p className="sandbox-note">Project-bound PayPal sandbox invoices only. Standalone invoices and simulated Demo balances stay separate.</p>
    </>}
    {!form && <FundingCommandDock projects={projects} projectId={selected?.project.id} disabled={!loaded || busy || !!review} onInspect={inspectFromCommand} />}
    {review && <ReviewDialog title={review.kind === 'project' ? 'Review the sandbox scope agreement' : review.kind === 'approve-change' ? 'Review this change as owner' : review.kind === 'agree-change' ? 'Record this sandbox change agreement' : 'Review sandbox delivery acceptance'} busy={busy} onClose={() => setReview(null)}><Badge tone="neutral">Local sandbox decision · test only</Badge><DecisionFacts review={review} />{errorBox}{staleReview && <div className="sandbox-error" role="alert">The project changed after this review opened. Close the review and inspect the latest version before recording a decision.</div>}<label className="checkbox"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>{review.kind === 'approve-change' ? 'I approve this exact change version, scope, and amount as the local sandbox owner.' : review.kind === 'delivery' ? 'I have reviewed this exact delivery version and record its acceptance for this sandbox test.' : 'I have reviewed these exact terms and record agreement on this version for this sandbox test.'} This is not an authenticated client signature or permission to use real funds.</span></label><p>This decision does not send an invoice or mark a payment collected. Every PayPal sandbox send still requires its own exact-version review.</p><div className="form-actions"><button className="button" type="button" disabled={busy} onClick={() => setReview(null)}>Cancel</button><button className="button primary" type="button" disabled={busy || !acknowledged || staleReview || (review.kind === 'delivery' && !selected?.funding.canAcceptDelivery)} onClick={() => void confirmReview()}>{busy ? <><LoaderCircle size={14} className="sandbox-spin" />Recording…</> : review.kind === 'approve-change' ? 'Record owner approval' : review.kind === 'delivery' ? 'Record sandbox acceptance' : 'Record sandbox agreement'}</button></div></ReviewDialog>}
  </div>;
}

function LiveFunding({ webhooks, ledgerReadAt, visible, loading, error }: { webhooks: SandboxWebhookStatus | null; ledgerReadAt: string; visible: boolean; loading: boolean; error: string }) {
  const listener = error ? 'Listener status unavailable' : !webhooks ? 'Checking webhook listener…' : webhooks.listenerState === 'active' ? 'Webhook listener active' : webhooks.configured ? 'Webhook listener offline' : 'Webhook listener stopped';
  return <details className={`sandbox-auto-updates ${error || webhooks?.lastError ? 'has-error' : ''}`} aria-label="Automatic project funding"><summary><strong><RefreshCw size={14} className={loading ? 'sandbox-spin' : ''} />SYNC / 3s</strong><span className={`sandbox-listener ${!error && webhooks?.listenerState === 'active' ? 'active' : ''}`}>{listener}</span></summary><div className="sandbox-auto-body"><p>{visible ? 'Verified PayPal invoice changes update project funding. This grid reads the local ledger every 3 seconds.' : 'Ledger checks pause while this tab is hidden and catch up when you return.'}</p><div className="sandbox-auto-facts"><span>Ledger checked: <strong>{ledgerReadAt ? new Date(ledgerReadAt).toLocaleTimeString() : 'Waiting for server'}</strong></span><span>Last verified event: <strong>{webhooks?.lastVerifiedAt ? new Date(webhooks.lastVerifiedAt).toLocaleString() : 'None received yet'}</strong></span><span>Awaiting reconciliation: <strong>{webhooks?.pending ?? '—'}</strong></span></div>{webhooks?.lastAppliedAt && <p className="sandbox-auto-applied">Last webhook reconciliation: {new Date(webhooks.lastAppliedAt).toLocaleString()}</p>}{error && <p className="sandbox-auto-error" role="status">Ledger connection interrupted. The last records remain visible and checks will retry. {error}</p>}{webhooks?.lastError && <p className="sandbox-auto-error" role="status">Webhook reconciliation needs attention: {webhooks.lastError}</p>}{webhooks && webhooks.listenerState !== 'active' && <p className="sandbox-auto-error">Automatic PayPal updates require the local webhook listener. Each existing invoice also has a manual provider refresh action.</p>}</div></details>;
}
function FundingMetrics({ funding }: { funding: Pick<SandboxProjectFunding, 'agreedCents' | 'invoicedCents' | 'confirmedCents' | 'pendingCents' | 'outstandingCents' | 'unbilledCents'> }) {
  return <div className="sandbox-project-metrics"><div><small>Agreed scope</small><strong>{money(funding.agreedCents)}</strong><span>Baseline + agreed changes</span></div><div><small>Collected</small><strong>{money(funding.confirmedCents)}</strong><span>Verified sandbox funds</span></div><div><small>Unbilled</small><strong>{money(funding.unbilledCents)}</strong><span>Agreed work awaiting invoice</span></div></div>;
}
function PortfolioMetrics({ projects }: { projects: SandboxProjectView[] }) {
  const totals = projects.reduce((sum, view) => ({ agreedCents: sum.agreedCents + view.funding.agreedCents, invoicedCents: sum.invoicedCents + view.funding.invoicedCents, confirmedCents: sum.confirmedCents + view.funding.confirmedCents, pendingCents: sum.pendingCents + view.funding.pendingCents, outstandingCents: sum.outstandingCents + view.funding.outstandingCents, unbilledCents: sum.unbilledCents + view.funding.unbilledCents }), { agreedCents: 0, invoicedCents: 0, confirmedCents: 0, pendingCents: 0, outstandingCents: 0, unbilledCents: 0 });
  return <FundingMetrics funding={totals} />;
}
function ProjectsGrid({ projects, query }: { projects: SandboxProjectView[]; query: string }) {
  const rows = useMemo(() => projects.map(({ project, funding }) => ({ id: project.id, href: `/sandbox/projects/${project.id}`, title: project.terms.title, agreed: funding.agreedCents, confirmed: funding.confirmedCents, pending: funding.pendingCents, unbilled: funding.unbilledCents, status: friendly(funding.status) })), [projects]);
  return <RecordsGrid rows={rows} columns={projectColumns} search={query} />;
}
function ObligationsGrid({ obligations, onSelect }: { obligations: SandboxFundingObligation[]; onSelect: (obligation: SandboxFundingObligation) => void }) {
  const rows = useMemo(() => obligations.map(obligation => ({ id: `${obligation.purpose}:${obligation.sourceId}`, title: obligation.title, amount: obligation.amountCents, confirmed: obligation.confirmedCents, pending: obligation.pendingCents, status: obligation.funded ? 'funded' : obligation.invoiceState ? friendly(obligation.invoiceState) : obligation.accepted ? 'not invoiced' : 'awaiting agreement', version: obligation.sourceVersion ? `v${obligation.sourceVersion}` : 'Not submitted' })), [obligations]);
  return <RecordsGrid rows={rows} columns={obligationColumns} onRowSelect={row => { const obligation = obligations.find(item => `${item.purpose}:${item.sourceId}` === row.id); if (obligation) onSelect(obligation); }} />;
}
function ProjectPayments({ invoices }: { invoices: SandboxInvoice[] }) {
  const rows = useMemo(() => invoices.map(invoice => ({ id: invoice.id, href: `/sandbox/${invoice.id}?inspect=payments`, title: invoice.projectBinding?.purpose ?? 'Invoice', requested: invoice.terms.amountCents, confirmed: invoice.confirmedCents, pending: invoice.pendingCents, status: friendly(invoice.state) })), [invoices]);
  if (!rows.length) return <p className="sandbox-project-local-note">No invoice has been prepared for this project. No PayPal payments are recorded.</p>;
  return <section aria-label="Project payment evidence"><h3>Project payments / sandbox</h3><RecordsGrid rows={rows} columns={[
    { field: 'title', headerName: 'INVOICE', flex: 1, width: 130 },
    { field: 'requested', headerName: 'REQUESTED · USD', money: true, width: 140 },
    { field: 'confirmed', headerName: 'CONFIRMED · USD', money: true, width: 140 },
    { field: 'pending', headerName: 'PENDING · USD', money: true, width: 130 },
    { field: 'status', headerName: 'PAYMENT STATE', status: true, flex: 1, width: 150 },
  ]} /><p className="sandbox-project-local-note">Select an invoice for verified PayPal transactions and its webhook receipt. Drafts and pending payments do not count as collection.</p></section>;
}
function ObligationAction({ obligation, busy, prepare }: { obligation: SandboxFundingObligation; busy: boolean; prepare: () => void }) {
  const label = obligation.purpose === 'deposit' ? 'deposit' : obligation.purpose === 'final' ? 'final' : 'change';
  return <div className="sandbox-obligation-action"><strong>{obligation.title} · {money(obligation.amountCents)}</strong><p>{obligation.funded ? 'This obligation has verified PayPal collection.' : obligation.invoiceId ? 'Keep working with the original reserved invoice. No replacement will be created.' : obligation.blockedReason || 'Prepare the exact agreed terms, then review the invoice before sending.'}</p>{obligation.invoiceId ? <Link className="button" href={`/sandbox/${obligation.invoiceId}`}>Open {label} invoice <ArrowUpRight size={13} /></Link> : <button className="button" type="button" disabled={busy || !obligation.canPrepare} onClick={prepare}>Prepare {label} invoice <ArrowRight size={13} /></button>}</div>;
}
function JourneySteps({ view }: { view: SandboxProjectView }) {
  const steps = [{ name: 'Scope agreement', done: !!view.project.agreement }, { name: 'Deposit funded', done: view.funding.depositFunded }, { name: 'Changes funded', done: view.funding.depositFunded && view.funding.changesFunded }, { name: 'Delivery accepted', done: !!view.project.delivery?.acceptance }, { name: 'Final collected', done: view.funding.complete }];
  return <ol className="sandbox-journey-steps" aria-label="Sandbox project journey">{steps.map((step, index) => <li key={step.name} className={step.done ? 'done' : ''}><span>{step.done ? <Check size={13} /> : index + 1}</span>{step.name}</li>)}</ol>;
}
function ProjectFacts({ project }: { project: SandboxProject }) {
  return <dl className="sandbox-facts"><div><dt>Sandbox buyer</dt><dd>{project.terms.recipientEmail}</dd></div><div><dt>Original scope</dt><dd>{money(project.terms.baseAmountCents)} USD</dd></div><div><dt>Deposit</dt><dd>{money(project.terms.depositCents)}</dd></div><div><dt>Original final milestone</dt><dd>{money(project.terms.baseAmountCents - project.terms.depositCents)}</dd></div><div><dt>Scope version</dt><dd>v{project.version}</dd></div></dl>;
}
function ProjectForm({ fields, setFields, busy, stale, editing, onSubmit, onCancel }: { fields: ProjectFields; setFields: (update: (previous: ProjectFields) => ProjectFields) => void; busy: boolean; stale: boolean; editing: boolean; onSubmit: (event: FormEvent) => void; onCancel: () => void }) {
  let remainder: number | undefined;
  try { const base = parseUsd(fields.baseAmount); const deposit = parseUsd(fields.deposit); if (base > deposit && deposit > 0) remainder = base - deposit; } catch { /* Incomplete inputs are not monetary values yet. */ }
  return <Card className="padded sandbox-project-form"><h2>{editing ? 'Edit the sandbox scope' : 'Start a sandbox project'}</h2><p>Enter a fresh scope and a separate sandbox Personal buyer. No Demo agreement or payment is copied.</p><form onSubmit={onSubmit}><div className="form-grid"><Field label="Project title"><input required maxLength={100} value={fields.title} onChange={event => setFields(previous => ({ ...previous, title: event.target.value }))} placeholder="Website launch" /></Field><Field label="Sandbox buyer email" hint="Use the Personal test account from the PayPal Developer dashboard."><input required type="email" maxLength={254} value={fields.recipientEmail} onChange={event => setFields(previous => ({ ...previous, recipientEmail: event.target.value }))} /></Field></div><Field label="Baseline scope" hint="The original work, deliverables, and terms being agreed."><textarea required maxLength={700} rows={5} value={fields.scope} onChange={event => setFields(previous => ({ ...previous, scope: event.target.value }))} /></Field><div className="form-grid"><Field label="Original scope amount · USD" hint="Exact dollars and cents."><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={fields.baseAmount} onChange={event => setFields(previous => ({ ...previous, baseAmount: event.target.value }))} placeholder="1000.00" /></Field><Field label="Deposit amount · USD" hint="Greater than zero and less than the original scope amount."><input required inputMode="decimal" pattern="[0-9]+(\.[0-9]{1,2})?" value={fields.deposit} onChange={event => setFields(previous => ({ ...previous, deposit: event.target.value }))} placeholder="300.00" /></Field></div><div className="sandbox-project-split"><span>Original final milestone</span><strong>{remainder === undefined ? 'Enter scope and deposit amounts' : `${money(remainder)} USD`}</strong></div><p className="sandbox-project-local-note">Saving creates only local sandbox project terms. Agreement, each invoice send, delivery acceptance, and provider collection remain separate steps. Changes are billed independently of this final milestone.</p><div className="form-actions"><button type="button" className="button" disabled={busy} onClick={onCancel}>Cancel</button><button type="submit" className="button primary" disabled={busy || stale}>{busy ? <><LoaderCircle size={14} className="sandbox-spin" />Saving…</> : editing ? 'Save scope version' : 'Create sandbox project'}</button></div></form></Card>;
}
function DecisionFacts({ review }: { review: Review }) {
  const project = review.view.project;
  if (review.kind === 'project') return <><ProjectFacts project={project} /><p className="sandbox-description">{project.terms.scope}</p></>;
  if (review.kind === 'delivery') return <><dl className="sandbox-facts"><div><dt>Project</dt><dd>{project.terms.title}</dd></div><div><dt>Delivery version</dt><dd>v{project.delivery!.version}</dd></div><div><dt>Final invoice after acceptance</dt><dd>{money(project.terms.baseAmountCents - project.terms.depositCents)} USD</dd></div></dl><p className="sandbox-description">{project.delivery!.summary}</p></>;
  const change = project.changes.find(item => item.id === review.changeId)!;
  return <><dl className="sandbox-facts"><div><dt>Project</dt><dd>{project.terms.title}</dd></div><div><dt>Change</dt><dd>{change.title}</dd></div><div><dt>Version</dt><dd>v{change.version}</dd></div><div><dt>Separate change invoice</dt><dd>{money(change.amountCents)} USD</dd></div><div><dt>Sandbox buyer</dt><dd>{project.terms.recipientEmail}</dd></div></dl><p className="sandbox-description">{change.description}</p></>;
}
