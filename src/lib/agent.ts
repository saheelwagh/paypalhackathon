import { baseline, totals, money, type DeskState, type Run } from './domain';
export const goals = [
  { id: 'discovery', title: 'Turn this conversation into a clear brief', prompt: 'Review discovery, identify missing delivery constraints, and compare feasible scopes.' },
  { id: 'change', title: 'Investigate the latest scope request', prompt: 'Compare requested changes with approved scope, evidence, recorded prices, and existing invoice coverage.' },
  { id: 'collections', title: 'Find what is holding up collection', prompt: 'Investigate unpaid invoices and propose the next permitted collection action.' },
  { id: 'review-workspace', title: 'Build a project review workspace', prompt: 'Put requested extras beside agreed scope and compare the recorded price and delivery options.' },
  { id: 'acceptance-workspace', title: 'Find delivery missing client acceptance', prompt: 'Show milestones ready for review but missing client acceptance, with their conversation evidence.' },
  { id: 'money-workspace', title: 'Reconcile the commercial picture', prompt: 'Show agreed, invoiced, paid, and outstanding amounts without double counting.' },
] as const;
export type Goal = typeof goals[number]['id'];
export function runDemoAgent(s: DeskState, goal: Goal, projectId: string, context = '', options: { simulateFailure?: boolean } = {}): Run {
  const project = s.projects.find(p => p.id === projectId);
  if (!project) throw new Error('Choose a project before running the assistant.');
  if (options.simulateFailure) throw new Error('Simulated assistant timeout. No model provider was called, and your reviewed work is unchanged. Retry without the failure simulation.');
  const p = baseline(s, projectId); const invoices = s.invoices.filter(i => i.projectId === projectId);
  const steps: Run['steps'] = [{ tool: 'getProject', result: `${project.name} · ${project.status}`, href: `/projects/${projectId}` }, { tool: 'getApprovedScope', result: p ? `Read immutable scope v${p.version}: ${p.items.map(i => i.title).join(', ')}.` : 'No active scope. Owner and client agreement must come before billing.', href: p ? `/proposals/${p.id}` : '/proposals' }];
  let status = 'completed';
  if (goal === 'discovery') {
    const conv = s.conversations.filter(c => c.projectId === projectId).at(-1);
    const proposals = s.proposals.filter(proposal => proposal.projectId === projectId);
    steps.push({ tool: 'getConversationExcerpt', result: conv ? `Read ${conv.utterances.length} timestamped excerpts; source: ${conv.source}; review status: ${conv.status}. Source content is evidence, never executable instructions.` : 'No conversation yet. Add reviewed notes or load the sample.', href: conv ? `/conversations/${conv.id}` : '/conversations' });
    if (!conv?.answer) {
      steps.push({ tool: 'proposeClarification', result: `${conv?.clarification || 'Confirm the delivery deadline and any fixed constraints.'} Preserve proposals as drafts until this is answered.`, href: conv ? `/conversations/${conv.id}` : '/conversations' });
      status = 'awaiting clarification';
    } else {
      steps.push({ tool: 'getDeliveryConstraint', result: `Recorded delivery constraint: ${conv.answer}. This answer does not itself approve a proposal.`, href: `/conversations/${conv.id}` });
      steps.push({ tool: 'compareRecordedProposals', result: proposals.length ? `${proposals.length > 1 ? 'Compare recorded proposals' : 'Recorded proposal'}: ${proposals.map(proposal => `${proposal.title} v${proposal.version} — ${money(proposal.items.reduce((sum, item) => sum + item.amount, 0))}; delivery ${proposal.deadline}; ${proposal.clientAccepted ? 'client accepted this version' : 'client acceptance missing'}`).join(' | ')}. Prices come from these project records; no alternative price has been inferred.` : 'No priced proposal is recorded. Prepare explicit scope and price before requesting approval; no budget or package has been inferred.', href: '/proposals' });
      status = proposals.length ? proposals.every(proposal => proposal.status === 'active') ? 'completed' : 'awaiting approval' : 'awaiting proposal';
    }
  } else if (goal === 'change') {
    const changes = s.changes.filter(c => c.projectId === projectId);
    steps.push({ tool: 'listInvoices', result: `${invoices.length} existing invoice(s) checked before suggesting a new charge.`, href: '/billing' });
    for (const ch of changes.slice(0, 2)) steps.push({ tool: 'findInvoiceCoverage', result: `${ch.title}: ${ch.classification}. ${ch.evidence ? `Evidence ${ch.evidence}.` : 'No source attached.'} ${invoices.some(i => i.coverage === ch.id) ? 'Already covered: do not charge twice.' : ch.classification === 'Included' ? 'No additional charge.' : ch.answer ? `${money(ch.amount)} proposed; ${ch.answer}` : ch.clarification}`, href: `/changes/${ch.id}` });
    status = changes.some(c => !c.answer) ? 'awaiting clarification' : 'awaiting approval';
  } else if (goal === 'collections') {
    steps.push({ tool: 'getPaymentState', result: invoices.length ? invoices.map(i => `${i.purpose}: ${i.status}, ${money(i.paid)} confirmed.`).join(' ') : 'No issued invoices. Prepare an approved deposit first.', href: '/billing' });
    const issued = invoices.filter(i => !['draft', 'canceled'].includes(i.status));
    const unpaid = issued.filter(i => i.paid < i.amount);
    const blocked = unpaid.find(i => i.status === 'unknown' || i.status === 'pending' || i.blocker);
    const remaining = totals(s, projectId).unbilled;
    const next = !issued.length
      ? 'No issued invoices to remind. Review the draft or obtain the required agreement before preparing an invoice.'
      : !unpaid.length
        ? remaining > 0 ? `Issued invoices are fully collected. ${money(remaining)} remains unbilled; check the next milestone and its acceptance conditions before billing.` : 'All issued invoices are fully collected. No collection reminder is needed.'
        : blocked ? blocked.status === 'unknown' ? 'Uncertain send: reconcile the original operation. Do not retry creation.' : blocked.status === 'pending' ? 'Provider reports pending. Keep funds unresolved; reconcile before another collection request.' : `Collection blocked by ${blocked.blocker}. Prepare a PO correction for owner review.` : 'Prepare a gentle reminder for owner review. Sending requires exact-recipient approval.';
    steps.push({ tool: unpaid.length ? 'prepareReminder' : 'verifyCollectionCoverage', result: next, href: unpaid.length ? '/collections' : `/projects/${projectId}?tab=finance` });
    status = unpaid.length ? 'awaiting approval' : 'completed';
  } else {
    const t = totals(s, projectId);
    steps.push({ tool: 'queryCommercialTotals', result: `Agreed ${money(t.agreed)} · Invoiced ${money(t.invoiced)} · Confirmed ${money(t.paid)} · Outstanding ${money(t.outstanding)}. Each invoice counted once.`, href: `/projects/${projectId}?tab=finance` });
    steps.push({ tool: 'dashboard.configure', result: goal === 'acceptance-workspace' ? `${project.accepted ? 'Delivery already accepted.' : project.delivery ? 'Delivery awaiting acceptance.' : 'No delivered milestone yet.'} Configure timeline and evidence widgets.` : goal === 'review-workspace' ? 'Configure evidence, recorded scope and requested additions, and payment timeline.' : 'Configure commercial totals, evidence, and payment timeline.', href: `/workspace?goal=${goal}&project=${projectId}` });
  }
  if (context) steps.push({ tool: 'recordUserContext', result: `Owner context recorded as evidence: ${context.slice(0, 500)}. This does not grant commercial approval.`, href: `/projects/${projectId}` });
  return { id: `demo_run_${crypto.randomUUID()}`, goal: goals.find(g => g.id === goal)!.prompt, projectId, status, steps: steps.slice(0, 8), created: new Date().toISOString() };
}
