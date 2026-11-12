import { z } from 'zod';

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
const ID = z.string().min(1).max(150);
export type Client = { id: string; name: string; contact: string; email: string; color: string; notes: string };
export type Project = { id: string; clientId: string; name: string; category: string; due: string; status: string; accepted: boolean; deliveryVersion: number; delivery: string; links: { title: string; url: string }[]; milestones: { id: string; title: string; amount: number; status: string }[] };
export type Utterance = { id: string; speaker: string; start: number; end: number; text: string; original: string };
export type Conversation = { id: string; projectId: string; title: string; kind: string; status: string; created: string; speakers: Record<string, string>; utterances: Utterance[]; filename?: string; source: 'sample' | 'manual' | 'upload' | 'microphone'; clarification?: string; answer?: string };
export type Proposal = { id: string; projectId: string; title: string; version: number; status: string; ownerApproved: boolean; clientAccepted: boolean; items: { id: string; title: string; amount: number; evidence: string }[]; assumptions: string; deadline: string };
export type Change = { id: string; projectId: string; title: string; classification: 'Included' | 'Extra' | 'Unclear'; amount: number; version: number; ownerApproved: boolean; clientAccepted: boolean; status: string; evidence: string; clarification: string; answer: string; deadline: string };
export type Invoice = { id: string; projectId: string; clientId: string; coverage: string; purpose: 'deposit' | 'change' | 'final'; amount: number; paid: number; status: 'draft' | 'sent' | 'pending' | 'partially paid' | 'paid' | 'unknown' | 'canceled'; rawStatus: string; recipient: string; version: number; providerRef: string; po: string; blocker: string; due: string; events: { id: string; status: string; amount: number; at: string }[] };
export type Audit = { id: string; at: string; type: string; title: string; detail: string; href: string; actor: string };
export type Run = { id: string; projectId: string; goal: string; status: string; steps: { tool: string; result: string; href: string }[]; created: string };
export type Approval = { id: string; actor: string; target: string; version: number; action: string; amount?: number; recipient?: string; at: string };
export type DeskState = { schemaVersion: 1; revision: number; clients: Client[]; projects: Project[]; conversations: Conversation[]; proposals: Proposal[]; changes: Change[]; invoices: Invoice[]; activity: Audit[]; runs: Run[]; approvals: Approval[]; layouts: Record<string, unknown>; settings: { name: string; email: string; rate: number; reminder: string }; scenario: string };
export type Actor = 'owner' | 'client';
const commandSchema = z.object({ type: z.string(), id: ID.optional(), projectId: ID.optional(), version: z.number().int().positive().optional(), data: z.record(z.string(), z.unknown()).optional() });
export type Command = z.infer<typeof commandSchema>;
const str = (d: Record<string, unknown>, k: string, fallback = '') => z.string().max(20000).parse(d[k] ?? fallback).trim();
const amount = (v: unknown) => z.number().int().min(0).max(100_000_000).parse(v);
const requireThat: (ok: unknown, message: string) => asserts ok = (ok, message) => { if (!ok) throw new Error(message); };
/** Parse form text without passing decimal dollars through binary floating-point arithmetic. */
export function parseUsd(value: unknown): number {
  requireThat(typeof value === 'string', 'Enter a USD amount with at most two decimal places.');
  const text = value.trim();
  requireThat(/^(?:\d+|\d*\.\d{1,2})$/.test(text), 'Enter a non-negative USD amount with at most two decimal places; do not use commas or exponents.');
  const [whole = '', fraction = ''] = text.split('.');
  const cents = BigInt(whole || '0') * BigInt(100) + BigInt(fraction.padEnd(2, '0'));
  requireThat(cents <= BigInt(100_000_000), 'The maximum supported amount is $1,000,000.00.');
  return Number(cents);
}
const now = () => new Date().toISOString();
const uid = (prefix: string) => `demo_${prefix}_${globalThis.crypto.randomUUID()}`;
export function totals(s: DeskState, projectId?: string) {
  const projects = s.projects.filter(p => !projectId || p.id === projectId);
  const ids = new Set(projects.map(p => p.id));
  const agreed = s.proposals.filter(p => ids.has(p.projectId) && p.status === 'active').reduce((n, p) => n + p.items.reduce((a, i) => a + i.amount, 0), 0) + s.changes.filter(c => ids.has(c.projectId) && c.classification === 'Extra' && c.ownerApproved && c.clientAccepted).reduce((n, c) => n + c.amount, 0);
  const invoices = s.invoices.filter(i => ids.has(i.projectId) && !['draft', 'canceled'].includes(i.status));
  const invoiced = invoices.reduce((n, i) => n + i.amount, 0);
  const paid = invoices.reduce((n, i) => n + i.paid, 0);
  return { agreed, invoiced, paid, outstanding: invoiced - paid, unbilled: Math.max(0, agreed - invoiced) };
}
export function baseline(s: DeskState, projectId: string) { return s.proposals.find(p => p.projectId === projectId && p.status === 'active'); }
export function funding(s: DeskState, projectId: string) { return s.invoices.some(i => i.projectId === projectId && i.purpose === 'deposit' && i.paid === i.amount && i.status === 'paid'); }
export function applyCommand(previous: DeskState, input: Command, actor: Actor = 'owner'): DeskState {
  const c = commandSchema.parse(input);
  const s = structuredClone(previous);
  const d = c.data ?? {};
  const clientCommands = ['proposal.accept', 'proposal.feedback', 'change.accept', 'change.feedback', 'delivery.accept', 'payment.simulate'];
  requireThat(actor === 'owner' || clientCommands.includes(c.type), 'Owner access is required for this action.');
  // A demo role is a UX simulation, never connected authorization.
  if (['proposal.accept', 'proposal.feedback', 'change.accept', 'change.feedback', 'delivery.accept'].includes(c.type)) requireThat(actor === 'client', 'Open the simulated client portal to record a client decision.');
  const project = s.projects.find(p => p.id === c.projectId);
  let title = ''; let detail = ''; let href = '/activity';
  const approve = (target: string, version: number, action: string, value?: number, recipient?: string) => s.approvals.push({ id: uid('approval'), actor, target, version, action, amount: value, recipient, at: now() });
  switch (c.type) {
    case 'client.save': {
      const email = z.email().parse(str(d, 'email')); const name = str(d, 'name'); requireThat(name.length > 0, 'Client name is required.');
      const existing = s.clients.find(x => x.id === c.id);
      if (existing) Object.assign(existing, { name, email, contact: str(d, 'contact'), notes: str(d, 'notes') });
      else s.clients.push({ id: c.id ?? uid('client'), name, email, contact: str(d, 'contact'), notes: str(d, 'notes'), color: '#b7c4ab' });
      title = existing ? 'Client details updated' : 'A new client joined your desk'; href = '/clients'; break;
    }
    case 'project.create': {
      const clientId = str(d, 'clientId'); requireThat(s.clients.some(x => x.id === clientId), 'Choose an existing client.');
      const name = str(d, 'name'); requireThat(name, 'Project name is required.');
      s.projects.push({ id: c.id ?? uid('project'), clientId, name, category: str(d, 'category', 'Consulting'), due: str(d, 'due', '2026-11-20'), status: 'proposed', accepted: false, deliveryVersion: 0, delivery: '', links: [], milestones: [] });
      title = 'Project created'; href = '/projects'; break;
    }
    case 'conversation.create': {
      requireThat(project, 'Choose a project before adding a conversation.');
      const text = str(d, 'text'); const source = z.enum(['sample', 'manual', 'upload', 'microphone']).parse(d.source ?? 'manual');
      requireThat(source !== 'manual' || text.length > 0, 'Add a note to continue.');
      s.conversations.push({ id: c.id ?? uid('conversation'), projectId: project.id, title: str(d, 'title', 'Client conversation'), kind: source === 'manual' ? 'Text note' : source === 'microphone' ? 'Voice session' : 'Recording', source, status: source === 'upload' ? 'processing' : 'ready', created: now(), speakers: { A: s.settings.name, B: s.clients.find(x => x.id === project.clientId)?.contact ?? 'Client' }, filename: str(d, 'filename'), utterances: source === 'sample' ? sampleUtterances() : [{ id: uid('excerpt'), speaker: 'B', start: 0, end: 20, text: text || 'Synthetic transcript preview. Replace this with your reviewed notes; no transcription provider was called.', original: text || 'Synthetic transcript preview. Replace this with your reviewed notes; no transcription provider was called.' }], clarification: source === 'sample' ? 'Is Friday a firm launch date, or can delivery move to Monday?' : 'Confirm the delivery deadline and any fixed constraints.' });
      title = 'Conversation added'; detail = source === 'upload' ? 'Source metadata retained. Demo processing produces a labeled synthetic preview, not a provider transcript.' : 'Source recorded for review.'; href = `/conversations/${s.conversations.at(-1)!.id}`; break;
    }
    case 'conversation.update': {
      const conv = s.conversations.find(x => x.id === c.id); requireThat(conv, 'Conversation not found.');
      if (d.status) conv.status = z.enum(['ready', 'reviewed', 'failed', 'processing']).parse(d.status);
      if (d.answer !== undefined) conv.answer = str(d, 'answer');
      if (d.speaker) conv.speakers[str(d, 'speaker')] = str(d, 'name');
      if (d.utterance) { const u = conv.utterances.find(x => x.id === d.utterance); requireThat(u, 'Excerpt not found.'); u.text = str(d, 'text'); }
      title = 'Conversation review saved'; detail = 'Original text and timestamp references preserved.'; href = `/conversations/${conv.id}`; break;
    }
    case 'proposal.create': {
      requireThat(project, 'Choose a project.');
      requireThat(!baseline(s, project.id), 'This project already has active scope. Use a change review.');
      s.proposals.push({ id: c.id ?? uid('proposal'), projectId: project.id, title: str(d, 'title', 'Launch essentials'), version: 1, status: 'draft', ownerApproved: false, clientAccepted: false, items: [{ id: uid('item'), title: str(d, 'scope', 'Discovery, design, build, and one revision'), amount: amount(d.amount ?? 100000), evidence: project.id === 'demo_acme' ? 'demo_discovery:u2' : '' }], assumptions: 'Client supplies copy and assets. One revision included. No tax applied.', deadline: str(d, 'deadline', project.due) });
      title = 'Proposal drafted'; href = `/proposals/${s.proposals.at(-1)!.id}`; break;
    }
    case 'proposal.edit': {
      const p = s.proposals.find(x => x.id === c.id); requireThat(p, 'Proposal not found.'); requireThat(p.status !== 'active' && !p.clientAccepted, 'Accepted scope is immutable. Open a change review instead.');
      requireThat(c.version === p.version, 'This version changed. Reload and review the latest proposal.');
      if (d.title !== undefined) p.title = str(d, 'title');
      if (d.amount !== undefined) { p.items = [{ ...p.items[0], amount: amount(d.amount), title: str(d, 'scope', p.items.map(i => i.title).join('; ')) }]; }
      if (d.assumptions !== undefined) p.assumptions = str(d, 'assumptions');
      if (d.deadline !== undefined) p.deadline = str(d, 'deadline');
      p.version++; p.ownerApproved = false; p.clientAccepted = false; p.status = 'draft';
      title = 'New proposal version saved'; detail = `Version ${p.version} requires fresh agreement.`; href = `/proposals/${p.id}`; break;
    }
    case 'proposal.share': case 'proposal.accept': case 'proposal.activate': case 'proposal.feedback': {
      const p = s.proposals.find(x => x.id === c.id); requireThat(p, 'Proposal not found.'); requireThat(c.version === p.version, 'Stale agreement. Review the current version.');
      requireThat(p.status !== 'active', 'Scope is already active and immutable.');
      if ((c.type === 'proposal.share' && p.ownerApproved) || (c.type === 'proposal.accept' && p.clientAccepted)) return previous;
      const pr = s.projects.find(x => x.id === p.projectId)!;
      if (c.type === 'proposal.share') { p.ownerApproved = true; p.status = 'shared'; approve(p.id, p.version, 'share proposal'); title = 'Proposal approved and shared'; }
      if (c.type === 'proposal.accept') { requireThat(p.status === 'shared' && p.ownerApproved, 'Owner must share this version first.'); p.clientAccepted = true; p.status = 'client accepted'; approve(p.id, p.version, 'accept proposal'); title = 'Client accepted this proposal version'; }
      if (c.type === 'proposal.feedback') { requireThat(p.status === 'shared', 'Only a shared proposal can receive feedback.'); p.status = 'changes requested'; p.clientAccepted = false; p.ownerApproved = false; detail = str(d, 'feedback'); requireThat(detail, 'Describe the requested change.'); title = 'Client requested proposal changes'; }
      if (c.type === 'proposal.activate') { requireThat(p.ownerApproved && p.clientAccepted, 'Both owner and client agreement are required.'); requireThat(!baseline(s, p.projectId), 'Only one proposal may be active.'); p.status = 'active'; pr.status = 'awaiting deposit'; pr.due = p.deadline; const a = p.items.reduce((n, i) => n + i.amount, 0); const deposit = Math.round(a * 30 / 100); pr.milestones = [{ id: `${p.id}:deposit`, title: 'Project deposit', amount: deposit, status: 'planned' }, { id: `${p.id}:final`, title: 'Delivery & handover', amount: a - deposit, status: 'planned' }]; title = 'Agreed scope activated'; }
      href = `/proposals/${p.id}`; break;
    }
    case 'change.create': {
      requireThat(project && baseline(s, project.id), 'Activate an agreed baseline before reviewing additions.');
      const titleValue = str(d, 'title'); requireThat(titleValue, 'Describe the request.');
      s.changes.push({ id: c.id ?? uid('change'), projectId: project.id, title: titleValue, classification: z.enum(['Included', 'Extra', 'Unclear']).parse(d.classification ?? 'Unclear'), amount: amount(d.amount ?? 25000), version: 1, ownerApproved: false, clientAccepted: false, status: 'investigating', evidence: str(d, 'evidence'), clarification: 'What is the exact deliverable, and is the current deadline fixed?', answer: '', deadline: str(d, 'deadline', project.due) });
      title = 'Request queued for scope review'; href = '/changes'; break;
    }
    case 'change.edit': case 'change.approve': case 'change.accept': case 'change.feedback': {
      const change = s.changes.find(x => x.id === c.id); requireThat(change, 'Change request not found.'); requireThat(c.version === change.version, 'Stale approval. Review the current change version.');
      if ((c.type === 'change.approve' && change.ownerApproved) || (c.type === 'change.accept' && change.clientAccepted)) return previous;
      if (c.type === 'change.edit') { requireThat(!change.clientAccepted, 'An accepted change is immutable.'); if (d.answer !== undefined) change.answer = str(d, 'answer'); if (d.amount !== undefined) change.amount = amount(d.amount); if (d.deadline !== undefined) change.deadline = str(d, 'deadline'); if (d.classification) change.classification = z.enum(['Included', 'Extra', 'Unclear']).parse(d.classification); if (d.evidence !== undefined) change.evidence = str(d, 'evidence'); change.version++; change.ownerApproved = false; change.status = 'proposed'; title = 'Change draft updated'; }
      if (c.type === 'change.approve') { requireThat(baseline(s, change.projectId), 'Activate the agreed baseline first.'); const [conversationId, utteranceId] = change.evidence.split(':'); requireThat(s.conversations.some(conv => conv.id === conversationId && conv.projectId === change.projectId && conv.utterances.some(u => u.id === utteranceId)), 'Attach a valid source excerpt from this project.'); if (change.classification === 'Included') change.amount = 0; requireThat(change.classification !== 'Unclear' && change.answer && change.evidence, 'Resolve the question and attach source evidence before approval.'); change.ownerApproved = true; change.status = change.classification === 'Included' ? 'included in scope' : 'owner approved'; approve(change.id, change.version, 'approve change', change.amount); title = 'Owner approved change'; }
      if (c.type === 'change.accept') { requireThat(change.ownerApproved, 'Owner review is required first.'); change.clientAccepted = true; change.status = change.classification === 'Included' ? 'included in scope' : 'client accepted'; approve(change.id, change.version, 'accept change', change.amount); title = 'Client accepted change version'; }
      if (c.type === 'change.feedback') { requireThat(!change.clientAccepted, 'Accepted changes cannot be rewritten.'); detail = str(d, 'feedback'); requireThat(detail, 'Describe your feedback.'); change.answer = detail; change.status = 'clarification needed'; change.ownerApproved = false; change.version++; title = 'Client requested clarification'; }
      href = `/changes/${change.id}`; break;
    }
    case 'invoice.prepare': {
      requireThat(project, 'Project not found.'); const p = baseline(s, project.id); requireThat(p, 'Activate an owner/client agreed proposal before billing.');
      const purpose = z.enum(['deposit', 'change', 'final']).parse(d.purpose);
      let value = 0; let coverage = ''; let version = p.version;
      if (purpose === 'change') { const ch = s.changes.find(x => x.id === d.changeId && x.projectId === project.id); requireThat(ch && ch.classification === 'Extra' && ch.ownerApproved && ch.clientAccepted, 'Both parties must accept the extra before billing.'); coverage = ch.id; value = ch.amount; version = ch.version; }
      else { const m = project.milestones.find(x => x.id === `${p.id}:${purpose}`); requireThat(m, 'Milestone missing.'); if (purpose === 'final') requireThat(project.accepted, 'Client delivery acceptance is required before final billing.'); value = m.amount; coverage = m.id; }
      requireThat(value > 0, 'There is no billable amount for this coverage.');
      requireThat(!s.invoices.some(i => i.coverage === coverage && i.status !== 'canceled'), 'This work already has an invoice. Open the existing invoice instead.');
      const client = s.clients.find(x => x.id === project.clientId)!;
      s.invoices.push({ id: c.id ?? uid('invoice'), projectId: project.id, clientId: client.id, coverage, purpose, amount: value, paid: 0, status: 'draft', rawStatus: 'DEMO_LOCAL_DRAFT', recipient: client.email, version, providerRef: '', po: '', blocker: '', due: '2026-11-20', events: [] });
      title = 'Invoice prepared for review'; detail = `${money(value)} · ${client.email} · ${purpose} · version ${version}`; href = `/billing/${s.invoices.at(-1)!.id}`; break;
    }
    case 'invoice.send': {
      const i = s.invoices.find(x => x.id === c.id); requireThat(i, 'Invoice not found.'); requireThat(i.status === 'draft', i.status === 'unknown' ? 'Outcome uncertain: reconcile before retrying.' : 'This invoice has already been issued.');
      requireThat(c.version === i.version && d.amount === i.amount && d.recipient === i.recipient, 'Invoice details changed. Review recipient, amount, and version again.');
      if (i.purpose === 'change') { const ch = s.changes.find(x => x.id === i.coverage); requireThat(ch?.clientAccepted && ch.ownerApproved && ch.version === i.version, 'Change agreement is stale.'); }
      approve(i.id, i.version, 'send invoice', i.amount, i.recipient);
      i.providerRef = `demo_paypal_${i.id}`; i.status = d.timeout ? 'unknown' : 'sent'; i.rawStatus = d.timeout ? 'DEMO_OUTCOME_UNKNOWN' : 'DEMO_SENT';
      i.events.push({ id: uid('event'), status: i.status, amount: 0, at: now() });
      title = d.timeout ? 'Invoice send outcome uncertain' : 'Simulated invoice issued'; detail = `${money(i.amount)} · ${i.recipient}. No external request was made.`; href = `/billing/${i.id}`; break;
    }
    case 'invoice.reconcile': {
      const i = s.invoices.find(x => x.id === c.id); requireThat(i && i.status !== 'draft', 'Issue the invoice first.'); if (i.status === 'unknown') { i.status = 'sent'; i.rawStatus = 'DEMO_RECONCILED_SENT'; }
      title = 'Simulated provider state re-read'; detail = `Existing operation retained; current state: ${i.status}. No second invoice created.`; href = `/billing/${i.id}`; break;
    }
    case 'invoice.po': case 'invoice.remind': {
      const i = s.invoices.find(x => x.id === c.id); requireThat(i && !['draft', 'paid', 'canceled'].includes(i.status), 'Choose an issued unpaid invoice.');
      if (c.type === 'invoice.po') { i.po = str(d, 'po'); requireThat(i.po, 'A purchase-order reference is required.'); i.blocker = ''; title = 'Purchase-order reference corrected'; detail = i.po; }
      else { requireThat(i.status !== 'unknown', 'Reconcile the uncertain outcome before collection.'); requireThat(i.status !== 'pending', 'Payment is pending. Reconcile before requesting another payment.'); title = 'Simulated collection reminder recorded'; detail = `To ${i.recipient}: ${str(d, 'message', 'Please review the outstanding invoice.')} No message was sent.`; }
      href = `/billing/${i.id}`; break;
    }
    case 'payment.simulate': {
      const i = s.invoices.find(x => x.id === c.id); requireThat(i && !['draft', 'canceled', 'unknown'].includes(i.status), 'Only an issued, reconciled invoice can receive a simulated payment.');
      const status = z.enum(['pending', 'paid', 'partially paid']).parse(d.status); const eventId = str(d, 'eventId') || uid('payment');
      if (i.events.some(e => e.id === eventId)) return previous;
      const paid = status === 'paid' ? i.amount : status === 'partially paid' ? amount(d.amount) : i.paid;
      requireThat(paid <= i.amount && paid >= i.paid, 'A payment event cannot reduce confirmed collection or exceed the invoice.');
      i.paid = paid; i.status = i.paid === i.amount ? 'paid' : status; i.rawStatus = `DEMO_${i.status.toUpperCase().replaceAll(' ', '_')}`;
      i.events.push({ id: eventId, status: i.status, amount: paid, at: now() });
      const pr = s.projects.find(x => x.id === i.projectId)!;
      if (i.status === 'paid') {
        const m = pr.milestones.find(m => m.id === i.coverage); if (m) m.status = 'paid';
        if (i.purpose === 'deposit' && pr.status === 'awaiting deposit') pr.status = 'active';
      }
      if (i.purpose === 'change') { const ch = s.changes.find(x => x.id === i.coverage); if (ch) ch.status = i.status === 'paid' ? 'ready' : 'funding pending'; }
      const t = totals(s, pr.id); if (pr.accepted && t.paid === t.agreed && t.agreed > 0) pr.status = 'completed';
      title = `Simulated payment ${i.status}`; detail = `${money(i.paid)} confirmed on this invoice. Source: demo adapter, not PayPal.`; href = `/billing/${i.id}`; break;
    }
    case 'delivery.submit': case 'delivery.accept': case 'project.link': {
      requireThat(project, 'Project not found.');
      if (c.type === 'delivery.submit') { requireThat(!project.accepted, 'Accepted delivery is immutable. Open a new scope review.'); requireThat(funding(s, project.id), 'Confirm the deposit before starting delivery.'); requireThat(s.changes.filter(ch => ch.projectId === project.id && ch.classification === 'Extra' && ch.clientAccepted).every(ch => s.invoices.some(i => i.coverage === ch.id && i.status === 'paid')), 'Accepted extras must be funded before delivery.'); project.delivery = str(d, 'delivery'); requireThat(project.delivery, 'Attach delivery evidence.'); project.deliveryVersion++; project.status = 'awaiting acceptance'; const m = project.milestones.at(-1); if (m) m.status = 'delivered'; title = 'Delivery shared for client review'; }
      if (c.type === 'delivery.accept') { requireThat(c.version === project.deliveryVersion, 'Delivery changed. Review the current delivery version.'); requireThat(project.status === 'awaiting acceptance' && project.delivery, 'Delivery evidence must be shared first.'); project.accepted = true; project.status = 'accepted'; const m = project.milestones.at(-1); if (m) m.status = 'client accepted'; approve(project.id, project.deliveryVersion, 'accept delivery'); title = 'Client accepted delivery'; }
      if (c.type === 'project.link') { const url = z.url().parse(str(d, 'url')); requireThat(/^https?:\/\//.test(url), 'Use an HTTP or HTTPS link.'); project.links.push({ title: str(d, 'title', 'Project file'), url }); title = 'Project link attached'; }
      href = `/projects/${project.id}`; break;
    }
    case 'layout.save': { const name = str(d, 'name'); requireThat(name, 'Choose a layout name.'); s.layouts[name] = d.layout; title = `Workspace “${name}” saved`; detail = 'Presentation only. Commercial records are unchanged.'; href = '/workspace'; break; }
    case 'settings.save': { s.settings = { name: str(d, 'name'), email: z.email().parse(str(d, 'email')), rate: amount(d.rate), reminder: str(d, 'reminder') }; title = 'Workspace preferences saved'; href = '/settings'; break; }
    default: throw new Error('Unsupported command. No changes were made.');
  }
  s.revision++;
  s.activity.unshift({ id: uid('audit'), at: now(), type: c.type, title, detail, href, actor });
  return s;
}
export function sampleUtterances(): Utterance[] {
  return [
    { id: 'u1', speaker: 'A', start: 0, end: 8, text: 'Let’s agree on what a successful launch looks like. Is Friday a firm deadline?' },
    { id: 'u2', speaker: 'B', start: 8, end: 23, text: 'We need a five-page launch website, responsive design, a contact form, and one revision. We can supply the copy and images. Our budget is $1,000.' },
    { id: 'u3', speaker: 'A', start: 23, end: 34, text: 'That is $300 to start and $700 after you accept the delivery. Animation would be additional scope.' },
    { id: 'u4', speaker: 'B', start: 34, end: 44, text: 'Could we fix the headline copy and add a custom hero animation? We haven’t decided whether Friday is essential.' },
  ].map(u => ({ ...u, original: u.text }));
}
export function seed(empty = false): DeskState {
  const s: DeskState = { schemaVersion: 1, revision: 0, clients: [], projects: [], conversations: [], proposals: [], changes: [], invoices: [], approvals: [], activity: [], runs: [], layouts: {}, settings: { name: 'Alex Morgan', email: 'alex@example.test', rate: 12500, reminder: 'Hi, a quick reminder that your invoice is ready for review. Let me know if you need a purchase-order reference.' }, scenario: 'discovery' };
  if (empty) return s;
  s.clients = [ { id: 'demo_acme_client', name: 'Acme Studio', contact: 'Jamie Chen', email: 'jamie@acme.example', color: '#afc5ad', notes: 'Independent product studio. A thoughtful launch, without the rush.' }, { id: 'demo_north_client', name: 'Northstar', contact: 'Sam Rivera', email: 'sam@northstar.example', color: '#c9b6dc', notes: 'Brand strategy and editorial.' }, { id: 'demo_form_client', name: 'Form & Field', contact: 'Robin Ellis', email: 'robin@form.example', color: '#e0c0a2', notes: 'A design practice for everyday places.' } ];
  s.projects = [ { id: 'demo_acme', clientId: 'demo_acme_client', name: 'Launch website', category: 'Web design', due: '2026-11-16', status: 'proposed', accepted: false, deliveryVersion: 0, delivery: '', links: [{ title: 'Creative direction brief', url: 'https://example.com/brief' }], milestones: [] }, { id: 'demo_north', clientId: 'demo_north_client', name: 'Brand story & positioning', category: 'Writing', due: '2026-11-20', status: 'discovery', accepted: false, deliveryVersion: 0, delivery: '', links: [], milestones: [] }, { id: 'demo_form', clientId: 'demo_form_client', name: 'Digital identity system', category: 'Design', due: '2026-11-24', status: 'discovery', accepted: false, deliveryVersion: 0, delivery: '', links: [], milestones: [] } ];
  s.conversations = [{ id: 'demo_discovery', projectId: 'demo_acme', title: 'A clearer picture of the launch', kind: 'Sample recording', source: 'sample', status: 'ready', created: '2026-11-12T08:30:00Z', speakers: { A: 'Alex Morgan', B: 'Jamie Chen' }, utterances: sampleUtterances(), clarification: 'Is Friday a firm launch date, or can delivery move to Monday?' }];
  s.proposals = [{ id: 'demo_launch_proposal', projectId: 'demo_acme', title: 'A considered launch', version: 1, status: 'draft', ownerApproved: false, clientAccepted: false, items: [ { id: 'demo_design', title: 'Five-page responsive website', amount: 70000, evidence: 'demo_discovery:u2' }, { id: 'demo_form_item', title: 'Contact form & launch handover', amount: 20000, evidence: 'demo_discovery:u2' }, { id: 'demo_revision', title: 'One round of copy corrections', amount: 10000, evidence: 'demo_discovery:u2' } ], assumptions: 'Client supplies final copy and images. One revision included. Hero animation excluded. Friday deadline needs clarification.', deadline: '2026-11-16' }];
  s.changes = [ { id: 'demo_copy', projectId: 'demo_acme', title: 'Correct the hero headline', classification: 'Included', amount: 0, version: 1, ownerApproved: false, clientAccepted: false, status: 'investigating', evidence: 'demo_discovery:u4', clarification: 'Is this a copy correction within the included revision?', answer: 'Yes, a headline correction within the agreed revision.', deadline: '2026-11-16' }, { id: 'demo_animation', projectId: 'demo_acme', title: 'Add a custom hero animation', classification: 'Extra', amount: 25000, version: 1, ownerApproved: false, clientAccepted: false, status: 'clarification needed', evidence: 'demo_discovery:u4', clarification: 'Does the hero need a custom animation, and can delivery move to Monday?', answer: '', deadline: '2026-11-16' } ];
  s.activity = [{ id: 'demo_welcome', at: '2026-11-12T08:30:00Z', type: 'workspace.created', title: 'Your desk is ready', detail: 'Synthetic workspace loaded. Start with the Acme discovery conversation.', href: '/conversations/demo_discovery', actor: 'owner' }];
  return s;
}

const minor = z.number().int().min(0).max(100_000_000);
const demoId = z.string().startsWith('demo_').max(150);
const linkSchema = z.object({ title: z.string(), url: z.string() });
const eventSchema = z.object({ id: ID, status: z.string(), amount: minor, at: z.string() });
export const persistedStateSchema: z.ZodType<DeskState> = z.object({
  schemaVersion: z.literal(1), revision: z.number().int().min(0),
  clients: z.array(z.object({ id: demoId, name: z.string(), contact: z.string(), email: z.string(), color: z.string(), notes: z.string() })),
  projects: z.array(z.object({ id: demoId, clientId: demoId, name: z.string(), category: z.string(), due: z.string(), status: z.string(), accepted: z.boolean(), deliveryVersion: z.number().int().nonnegative().default(1), delivery: z.string(), links: z.array(linkSchema), milestones: z.array(z.object({ id: ID, title: z.string(), amount: minor, status: z.string() })) })),
  conversations: z.array(z.object({ id: demoId, projectId: demoId, title: z.string(), kind: z.string(), status: z.string(), created: z.string(), speakers: z.record(z.string(), z.string()), utterances: z.array(z.object({ id: ID, speaker: z.string(), start: z.number().nonnegative(), end: z.number().nonnegative(), text: z.string(), original: z.string() })), filename: z.string().optional(), source: z.enum(['sample','manual','upload','microphone']), clarification: z.string().optional(), answer: z.string().optional() })),
  proposals: z.array(z.object({ id: demoId, projectId: demoId, title: z.string(), version: z.number().int().positive(), status: z.string(), ownerApproved: z.boolean(), clientAccepted: z.boolean(), items: z.array(z.object({ id: ID, title: z.string(), amount: minor, evidence: z.string() })), assumptions: z.string(), deadline: z.string() })),
  changes: z.array(z.object({ id: demoId, projectId: demoId, title: z.string(), classification: z.enum(['Included','Extra','Unclear']), amount: minor, version: z.number().int().positive(), ownerApproved: z.boolean(), clientAccepted: z.boolean(), status: z.string(), evidence: z.string(), clarification: z.string(), answer: z.string(), deadline: z.string() })),
  invoices: z.array(z.object({ id: demoId, projectId: demoId, clientId: demoId, coverage: ID, purpose: z.enum(['deposit','change','final']), amount: minor, paid: minor, status: z.enum(['draft','sent','pending','partially paid','paid','unknown','canceled']), rawStatus: z.string().startsWith('DEMO_'), recipient: z.email(), version: z.number().int().positive(), providerRef: z.union([z.literal(''), demoId]), po: z.string(), blocker: z.string(), due: z.string(), events: z.array(eventSchema) }).refine(i => i.paid <= i.amount, 'Paid cannot exceed invoice amount')),
  activity: z.array(z.object({ id: ID, at: z.string(), type: z.string(), title: z.string(), detail: z.string(), href: z.string(), actor: z.string() })),
  runs: z.array(z.object({ id: demoId, projectId: demoId, goal: z.string(), status: z.string(), steps: z.array(z.object({ tool: z.string(), result: z.string(), href: z.string() })).max(8), created: z.string() })),
  approvals: z.array(z.object({ id: demoId, actor: z.string(), target: ID, version: z.number().int().positive(), action: z.string(), amount: minor.optional(), recipient: z.string().optional(), at: z.string() })),
  layouts: z.record(z.string(), z.unknown()), settings: z.object({ name: z.string(), email: z.string(), rate: minor, reminder: z.string() }), scenario: z.string(),
});

/** One row is an increase in confirmed synthetic collection, never a cumulative event snapshot. */
export function confirmedPaymentRows(state: DeskState, projectId: string) {
  return state.invoices.filter(i => i.projectId === projectId).flatMap(invoice => {
    let confirmed = 0;
    return invoice.events.flatMap(event => {
      const next = Math.max(confirmed, event.amount);
      const delta = next - confirmed;
      confirmed = next;
      return delta > 0 ? [{ id: event.id, invoiceId: invoice.id, projectId, amount: delta, source: 'demo-adapter', at: event.at }] : [];
    });
  });
}
