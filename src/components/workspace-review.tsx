'use client';
import { useEffect, useRef, type MouseEvent } from 'react';
import { ArrowLeft, ShieldCheck, UserRound, X } from 'lucide-react';
import { ActivityPage, BillingPage, ChangesPage, ConversationsPage, PortalPage, ProjectsPage, ProposalsPage } from './pages';
import { useDesk } from './store';

export type WorkspaceReview = { kind: 'change' | 'invoice' | 'delivery' | 'project' | 'proposal' | 'conversation' | 'activity' | 'client'; id: string; anchor?: string };
export function reviewFromHref(href: string): WorkspaceReview | undefined {
  const url = new URL(href, 'http://desk.local');
  const [section, id] = url.pathname.split('/').filter(Boolean);
  const kinds: Record<string, WorkspaceReview['kind']> = { changes: 'change', billing: 'invoice', projects: 'project', proposals: 'proposal', conversations: 'conversation', activity: 'activity', portal: 'client' };
  if (kinds[section] && id) return { kind: kinds[section], id, anchor: url.hash.slice(1) };
}
export default function WorkspaceReviewDrawer({ target, projectId, onClose, onTarget, onNew, onWorkspace }: { target: WorkspaceReview; projectId: string; onClose: () => void; onTarget: (target: WorkspaceReview) => void; onNew: (type: string) => void; onWorkspace: (href: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null); const content = useRef<HTMLDivElement>(null); const lastOwnerTarget = useRef<WorkspaceReview>({ kind: 'delivery', id: projectId });
  if (target.kind !== 'client') lastOwnerTarget.current = target;
  const { state, error, clearError } = useDesk();
  const targetProjectId = target.kind === 'change' ? state.changes.find(record => record.id === target.id)?.projectId : target.kind === 'invoice' ? state.invoices.find(record => record.id === target.id)?.projectId : target.kind === 'proposal' ? state.proposals.find(record => record.id === target.id)?.projectId : target.kind === 'conversation' ? state.conversations.find(record => record.id === target.id)?.projectId : target.kind === 'activity' ? state.runs.find(record => record.id === target.id)?.projectId : target.id;
  const reviewProjectId = targetProjectId || projectId;
  const project = state.projects.find(p => p.id === reviewProjectId);
  const client = state.clients.find(c => c.id === project?.clientId);
  useEffect(() => { const el = dialog.current!; el.showModal(); return () => el.close(); }, []);
  useEffect(() => { content.current?.scrollTo({ top: 0 }); if (target.anchor) requestAnimationFrame(() => content.current?.querySelector(`#${CSS.escape(target.anchor!)}`)?.scrollIntoView({ block: 'center' })); }, [target.kind, target.id, target.anchor]);
  function navigate(href: string) {
    const next = reviewFromHref(href);
    if (next) onTarget(next);
    else if (href.startsWith('/workspace')) { onWorkspace(href); onClose(); }
  }
  function captureLink(event: MouseEvent<HTMLDivElement>) {
    const link = (event.target as HTMLElement).closest('a');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === '_blank') return;
    const url = new URL(link.href);
    if (url.origin !== window.location.origin) return;
    const href = url.pathname + url.search + url.hash;
    if (reviewFromHref(href) || href.startsWith('/workspace')) { event.preventDefault(); event.stopPropagation(); navigate(href); }
  }
  const ownerTarget = lastOwnerTarget.current;
  const labels: Record<WorkspaceReview['kind'], string> = { change: 'Review scope & agreement', invoice: 'Review payment request', delivery: 'Delivery & acceptance', project: 'Project records', proposal: 'Review the proposal', conversation: 'Conversation evidence', activity: 'Action evidence', client: 'Simulated client decision' };
  return <dialog ref={dialog} className="desk-review" aria-label={labels[target.kind]} onCancel={event => { event.preventDefault(); onClose(); }} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="desk-review-header"><div><span>{client?.name || 'Current project'} · {project?.name}</span><h2>{labels[target.kind]}</h2></div><button className="desk-icon" aria-label="Close review drawer" onClick={onClose}><X size={19} /></button></div>
    <div className="desk-review-role"><button className={target.kind !== 'client' ? 'active' : ''} onClick={() => onTarget(ownerTarget)}><ShieldCheck size={14} />Owner review</button><button className={target.kind === 'client' ? 'active' : ''} onClick={() => onTarget({ kind: 'client', id: reviewProjectId })}><UserRound size={14} />Simulated client</button><span>Decisions require an explicit click.</span></div>
    {error && <div className="desk-review-error" role="alert"><span>{error}</span><button onClick={clearError}>Dismiss</button></div>}
    <div ref={content} className="desk-review-content" onClickCapture={captureLink}>
      {target.kind === 'change' && <ChangesPage key={target.id} id={target.id} onNew={onNew} onNavigate={navigate} />}
      {target.kind === 'invoice' && <BillingPage key={target.id} id={target.id} onNew={onNew} />}
      {(target.kind === 'delivery' || target.kind === 'project') && <ProjectsPage key={`${target.kind}:${target.id}`} id={target.id} initialTab={target.kind === 'delivery' ? 'Deliverables' : undefined} onNew={onNew} onNavigate={navigate} />}
      {target.kind === 'proposal' && <ProposalsPage key={target.id} id={target.id} onNew={onNew} />}
      {target.kind === 'conversation' && <ConversationsPage key={target.id} id={target.id} onNew={onNew} onNavigate={navigate} />}
      {target.kind === 'activity' && <ActivityPage key={target.id} id={target.id} />}
      {target.kind === 'client' && <><div className="desk-client-notice">You are intentionally previewing {client?.contact || 'the client'}’s role. Acceptance is recorded only when you review and confirm a specific version below.</div><PortalPage key={target.id} path={`/portal/${target.id}`} /></>}
    </div>
    <div className="desk-review-footer"><span>Demo records · no real invoice, email, or money movement</span><button onClick={onClose}><ArrowLeft size={13} />Back to the desk</button></div>
  </dialog>;
}
