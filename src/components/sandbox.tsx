'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, ArrowUpRight, Check, ExternalLink, LoaderCircle, Pencil, Plus, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { money, parseUsd } from '@/lib/domain';
import type { SandboxInvoice, SandboxTerms, SandboxWebhookStatus } from '@/lib/sandbox-contract';
import { createLedgerPoller, type LedgerPoller } from '@/lib/sandbox-ledger-poll';
import { RecordsGrid } from './grid';
import FundingCommandDock from './funding-command-dock';
import { Badge, Card, Empty, Field, PageTitle, SearchBox } from './ui';
import './sandbox.css';

type ListResponse = { invoices: SandboxInvoice[]; projectLabels: Record<string, string>; configured: boolean; mode: 'paypal-sandbox'; ledgerReadAt: string; webhooks: SandboxWebhookStatus };
type DraftFields = { projectReference: string; coverageReference: string; recipientEmail: string; description: string; amount: string };
const emptyFields: DraftFields = { projectReference: '', coverageReference: '', recipientEmail: '', description: '', amount: '' };
const fieldsFor = (invoice: SandboxInvoice): DraftFields => ({ ...invoice.terms, amount: (invoice.terms.amountCents / 100).toFixed(2) });
const displayState = (invoice: SandboxInvoice) => invoice.state.replaceAll('-', ' ');

async function request<T>(body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/api/paypal-sandbox', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store', signal });
  const result = await response.json().catch(() => ({ error: 'The server returned an unreadable response. Reload the ledger before retrying.' }));
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : 'The sandbox request could not be completed.');
  return result as T;
}

function SandboxDialog({ title, children, busy, onClose }: { title: string; children: ReactNode; busy: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const heading = useId();
  const close = useRef(onClose); close.current = onClose;
  const pending = useRef(busy); pending.current = busy;
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const cancel = (event: Event) => { event.preventDefault(); if (!pending.current) close.current(); };
    dialog.addEventListener('cancel', cancel);
    return () => { dialog.removeEventListener('cancel', cancel); dialog.close(); };
  }, []);
  return <dialog ref={ref} className="sandbox-dialog" aria-labelledby={heading} onClick={event => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="modal-heading"><h2 id={heading}>{title}</h2><button type="button" className="icon-button" aria-label="Close sandbox review" disabled={busy} onClick={onClose}><X size={19} /></button></div>{children}
  </dialog>;
}

export default function SandboxPage({ id }: { id?: string }) {
  const router = useRouter(); const searchParams = useSearchParams();
  const paymentEvidence = useRef<HTMLDetailsElement>(null);
  const inspectPayments = searchParams.get('inspect') === 'payments';
  const [invoices, setInvoices] = useState<SandboxInvoice[]>([]);
  const [projectLabels, setProjectLabels] = useState<Record<string, string>>({});
  const [configured, setConfigured] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [ledgerReadAt, setLedgerReadAt] = useState('');
  const [syncError, setSyncError] = useState('');
  const [visible, setVisible] = useState(true);
  const [webhooks, setWebhooks] = useState<SandboxWebhookStatus | null>(null);
  const poller = useRef<LedgerPoller | null>(null);
  const mounted = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [review, setReview] = useState<SandboxInvoice | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [editing, setEditing] = useState<SandboxInvoice | null>(null);
  const [fields, setFields] = useState<DraftFields>(emptyFields);
  const createKey = useRef<string>('');
  const selected = invoices.find(invoice => invoice.id === id);
  const creating = id === 'new';
  function inspectPaymentEvidence() {
    if (!paymentEvidence.current) return;
    paymentEvidence.current.open = true;
    paymentEvidence.current.scrollIntoView({ block: 'start' });
  }
  useEffect(() => { if (selected && inspectPayments) inspectPaymentEvidence(); }, [selected?.id, inspectPayments]);

  const load = useCallback(() => { poller.current?.refresh(); }, []);
  useEffect(() => {
    mounted.current = true;
    const controller = createLedgerPoller<ListResponse>({
      isVisible: () => document.visibilityState === 'visible',
      read: async signal => {
        const result = await request<ListResponse>({ action: 'list' }, AbortSignal.any([signal, AbortSignal.timeout(10_000)]));
        if (result.mode !== 'paypal-sandbox' || !Array.isArray(result.invoices)) throw new Error('The server did not return the sandbox ledger. Existing records remain visible.');
        return result;
      },
      onValue: result => {
        setInvoices(previous => JSON.stringify(previous) === JSON.stringify(result.invoices) ? previous : result.invoices);
        setProjectLabels(previous => JSON.stringify(previous) === JSON.stringify(result.projectLabels) ? previous : result.projectLabels ?? {});
        setConfigured(result.configured); setLoaded(true); setLedgerReadAt(result.ledgerReadAt); setWebhooks(result.webhooks); setSyncError('');
      },
      onError: cause => setSyncError(cause instanceof Error ? cause.message : 'Could not read the sandbox ledger.'),
      onBusy: setLoading,
    });
    poller.current = controller;
    const visibility = () => { setVisible(document.visibilityState === 'visible'); controller.visibilityChanged(); };
    const focus = () => controller.refresh();
    setVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', visibility); window.addEventListener('focus', focus);
    controller.start();
    return () => {
      mounted.current = false; controller.dispose();
      if (poller.current === controller) poller.current = null;
      document.removeEventListener('visibilitychange', visibility); window.removeEventListener('focus', focus);
    };
  }, []);
  useEffect(() => { setError(''); setNotice(''); setReview(null); setAcknowledged(false); setEditing(null); setFields(emptyFields); createKey.current = crypto.randomUUID(); }, [id]);

  function remember(invoice: SandboxInvoice) { setInvoices(previous => [invoice, ...previous.filter(item => item.id !== invoice.id)]); }
  async function act(body: object, success: string): Promise<SandboxInvoice | undefined> {
    if (busy) return undefined;
    poller.current?.suspend();
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await request<{ invoice: SandboxInvoice }>(body);
      if (!mounted.current) return undefined;
      remember(result.invoice);
      if (result.invoice.lastError) setError(result.invoice.lastError); else setNotice(success);
      return result.invoice;
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : 'The sandbox request failed. Re-read the original invoice before retrying.');
      return undefined;
    } finally { if (mounted.current) { setBusy(false); poller.current?.resume(); } }
  }
  async function saveDraft(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError('');
    let terms: SandboxTerms;
    try {
      terms = { projectReference: fields.projectReference.trim(), coverageReference: fields.coverageReference.trim(), recipientEmail: fields.recipientEmail.trim(), description: fields.description.trim(), amountCents: parseUsd(fields.amount), currency: 'USD' };
      if (terms.amountCents <= 0) throw new Error('Enter an amount greater than $0.00.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Enter a valid dollar amount with at most two decimal places.'); return; }
    const invoice = await act(editing ? { action: 'edit', id: editing.id, version: editing.version, terms } : { action: 'create', requestId: createKey.current, terms }, editing ? 'Saved a new version. Review it before sending to PayPal.' : 'Sandbox draft saved. No PayPal invoice has been sent.');
    if (invoice) { setEditing(null); router.push(`/sandbox/${invoice.id}`); }
  }
  const form = creating || !!editing;
  const staleEdit = !!editing && (!selected || selected.version !== editing.version || selected.state !== 'draft' || !!selected.provider);
  const staleReview = !!review && (!selected || selected.version !== review.version || selected.state !== 'draft');
  const errorBox = error ? <div className="sandbox-error" role="alert">{error}</div> : null;

  return <div className="sandbox-page">
    {selected && !form ? <div className="sandbox-console-title"><Link href="/sandbox">invoice /</Link><h1>{selected.projectBinding ? `${projectLabels[selected.projectBinding.projectId] ?? 'Sandbox project'} · ${selected.projectBinding.purpose}` : selected.terms.coverageReference}</h1><Badge>{displayState(selected)}</Badge></div> : <PageTitle eyebrow="PAYPAL / SANDBOX" title={creating ? 'new invoice.' : 'invoice console.'} subtitle="Test invoices. Verified collection." actions={!form ? <Link className="button" href="/sandbox/new"><Plus size={15} />Standalone invoice</Link> : undefined} />}
    <div className="sandbox-console-meta"><nav className="sandbox-project-nav" aria-label="Sandbox workspace"><Link href="/sandbox/projects">Project funding</Link><Link href="/sandbox" aria-current="page">Invoice ledger</Link></nav>
    <div className="sandbox-mode-strip"><span><i className="mode-led" />TEST FUNDS / FRESH SEND REVIEW</span></div>
    <AutomaticUpdates webhooks={webhooks} ledgerReadAt={ledgerReadAt} visible={visible} loading={loading} error={syncError} /></div>
    {!configured && loaded && <div className="sandbox-error" role="alert">PayPal sandbox keys are not configured on the server. Drafts can be prepared, but sending and provider refresh are unavailable.</div>}
    {!review && errorBox}
    {notice && <div className="sandbox-success" role="status"><Check size={16} />{notice}</div>}
    {form ? <>
      <Link className="button small" href={editing ? `/sandbox/${editing.id}` : '/sandbox'} onClick={() => setEditing(null)}><ArrowLeft size={13} />{editing ? 'Back to invoice' : 'All sandbox invoices'}</Link>
      <Card className="padded sandbox-form"><h2>{editing ? `Edit sandbox draft · v${editing.version}` : 'Prepare a standalone sandbox invoice'}</h2><p>Use a personal sandbox buyer account as the recipient. Standalone invoices stay outside project funding. For a deposit, approved change, or final balance, prepare the invoice from <Link href="/sandbox/projects">its sandbox project</Link>.</p>
        {staleEdit && <div className="sandbox-error" role="alert">This invoice changed while you were editing. Close the editor and review its current version before making changes.</div>}
        <form onSubmit={saveDraft}>
          <div className="form-grid"><Field label="Project reference" hint="Keep this reference consistent across the project’s invoices."><input name="projectReference" required maxLength={100} value={fields.projectReference} onChange={event => setFields(previous => ({ ...previous, projectReference: event.target.value }))} placeholder="Website launch" /></Field><Field label="Coverage reference" hint="One obligation: deposit, final milestone, or a specific addition."><input name="coverageReference" required maxLength={100} value={fields.coverageReference} onChange={event => setFields(previous => ({ ...previous, coverageReference: event.target.value }))} placeholder="Deposit (keep stable across versions)" /></Field></div>
          <div className="form-grid"><Field label="Sandbox buyer email" hint="Use a test buyer from your PayPal Developer dashboard."><input name="recipientEmail" type="email" required maxLength={254} value={fields.recipientEmail} onChange={event => setFields(previous => ({ ...previous, recipientEmail: event.target.value }))} placeholder="Your sandbox buyer email" /></Field><Field label="Amount · USD" hint="Exact dollars and cents, for example 300.15."><input name="amount" inputMode="decimal" type="text" required pattern="[0-9]+(\.[0-9]{1,2})?" value={fields.amount} onChange={event => setFields(previous => ({ ...previous, amount: event.target.value }))} placeholder="300.00" /></Field></div>
          <Field label="Invoice description" hint="The exact work and terms the payer will see."><textarea name="description" rows={4} required maxLength={1000} value={fields.description} onChange={event => setFields(previous => ({ ...previous, description: event.target.value }))} placeholder="Deposit for the agreed website scope…" /></Field>
          <p className="sandbox-note">Saving creates a local sandbox draft. Existing Demo approvals and simulated payments do not authorize this invoice. The next step reviews this exact version before contacting PayPal.</p>
          <div className="form-actions"><button type="button" className="button" disabled={busy} onClick={() => { setEditing(null); if (creating) router.push('/sandbox'); }}>Cancel</button><button type="submit" className="button primary" disabled={busy || staleEdit}>{busy ? <LoaderCircle size={14} className="sandbox-spin" /> : <Check size={14} />}{editing ? 'Save new draft version' : 'Save sandbox draft'}</button></div>
        </form>
      </Card>
    </> : selected ? <>
      <div className="sandbox-summary"><div><small>REQUESTED / USD</small><strong>{money(selected.terms.amountCents)}</strong><span>Invoice version {selected.version}</span></div><div><small>CONFIRMED COLLECTION</small><strong>{money(selected.confirmedCents)}</strong><span>Verified sandbox funds</span></div><div><small>PENDING / NOT COLLECTED</small><strong>{money(selected.pendingCents)}</strong><span>Does not unlock funded work</span></div></div>
      {selected.lastError && <div className="sandbox-error" role="alert">{selected.lastError}</div>}
      <section className="sandbox-invoice-action" aria-label="Next payment step"><h2>Next payment step</h2>
        {selected.state === 'draft' ? <><p>Review the exact recipient, amount, terms, and version before sending to PayPal sandbox.</p><button type="button" className="button primary" disabled={busy || !configured} onClick={() => { setAcknowledged(false); setReview(selected); setError(''); }}>Review & send to sandbox <ArrowUpRight size={14} /></button></>
          : ['unknown', 'creating', 'sending'].includes(selected.state) ? <><p>The original provider operation needs reconciliation. An uncertain response never authorizes a second invoice.</p><button type="button" className="button primary" disabled={busy || !configured} onClick={() => void act({ action: 'refresh', id: selected.id }, 'Re-read the original invoice from PayPal sandbox.')}><RefreshCw size={14} className={busy ? 'sandbox-spin' : ''} />{busy ? 'Reading PayPal…' : 'Reconcile original operation'}</button></>
            : selected.state === 'paid' ? <><p>PayPal confirmed {money(selected.confirmedCents)} in test funds.{selected.projectBinding ? ' Project funding updates automatically.' : ' This standalone invoice stays outside project funding.'}</p>{selected.projectBinding ? <Link className="button primary" href={`/sandbox/projects/${selected.projectBinding.projectId}`}>Continue project journey <ArrowUpRight size={14} /></Link> : <Link className="button primary" href="/sandbox">Return to invoice ledger <ArrowUpRight size={14} /></Link>}</>
              : selected.state === 'pending' ? <><p>PayPal reports a pending payment. Automatic updates will confirm collection when it settles.</p><button type="button" className="button" disabled={busy || !configured} onClick={() => void act({ action: 'refresh', id: selected.id }, 'Re-read the original invoice from PayPal sandbox.')}><RefreshCw size={14} className={busy ? 'sandbox-spin' : ''} />Check pending payment</button></>
                : ['canceled', 'refunded'].includes(selected.state) ? <><p>This invoice is {displayState(selected)}. Inspect the provider evidence before continuing.</p><button type="button" className="button" disabled={busy || !configured} onClick={() => void act({ action: 'refresh', id: selected.id }, 'Re-read the original invoice from PayPal sandbox.')}><RefreshCw size={14} className={busy ? 'sandbox-spin' : ''} />Refresh PayPal status</button></>
                  : <><p>Collect on PayPal’s sandbox payer page. Verified webhooks update this invoice; opening checkout never marks it paid.</p><PayerLink invoice={selected} /></>}
      </section>
      <details className="sandbox-inspector"><summary>Invoice terms & controls / v{selected.version}</summary><div className="sandbox-inspector-body">
        <InvoiceFacts invoice={selected} /><p className="sandbox-description">{selected.terms.description}</p>
        {selected.projectBinding ? <p className="sandbox-note">Bound project obligation: <strong>{selected.projectBinding.purpose}</strong> · source version {selected.projectBinding.sourceVersion}. <Link href={`/sandbox/projects/${selected.projectBinding.projectId}`}>Open project funding →</Link></p> : <p className="sandbox-note">Standalone invoice. Its payments do not fund a sandbox project.</p>}
        <div className="form-actions">{selected.state === 'draft' && !selected.provider && !selected.projectBinding && <button type="button" className="button" disabled={busy} onClick={() => { setEditing(selected); setFields(fieldsFor(selected)); setError(''); }}><Pencil size={14} />Edit draft</button>}{selected.provider && <button type="button" className="button" disabled={busy || !configured} onClick={() => void act({ action: 'refresh', id: selected.id }, 'Re-read the original invoice from PayPal sandbox.')}><RefreshCw size={14} className={busy ? 'sandbox-spin' : ''} />Refresh PayPal status</button>}</div>
        <p className="sandbox-note">One obligation keeps its original invoice and operation identity. Notifications to the recipient are suppressed by this test integration. This local ledger has no user sign-in and is not a production payment service.</p>
      </div></details>
      <details ref={paymentEvidence} className="sandbox-inspector"><summary>Provider evidence & webhook receipt</summary><div className="sandbox-inspector-body">
        <div className="sandbox-status"><strong><ShieldCheck size={16} />PayPal evidence only</strong><p>{selected.provider ? 'Pending, offline, or manually recorded payments do not count as confirmed PayPal collection.' : 'This draft has no confirmed PayPal collection.'}</p></div>
        {selected.provider && <ProviderFacts invoice={selected} />}
        {selected.approval && <p className="sandbox-note">Fresh sandbox send review recorded for version {selected.approval.version} on {new Date(selected.approval.approvedAt).toLocaleString()}. This local test approval is separate from every Demo approval.</p>}
        <p className="sandbox-reference">Ledger reference: {selected.id}</p>
      </div></details>
    </> : id && loaded ? <Empty title="Sandbox invoice not found." text="This address does not identify an invoice in the server’s sandbox ledger." action={<Link className="button" href="/sandbox">Open sandbox ledger</Link>} /> : <>
      <LedgerSummary invoices={invoices} />
      <div className="sandbox-toolbar"><SearchBox value={query} onChange={setQuery} placeholder="Find a sandbox invoice…" /><button className="button" type="button" disabled={loading || busy} onClick={() => { setError(''); void load(); }}><RefreshCw size={14} className={loading ? 'sandbox-spin' : ''} />Refresh</button></div>
      <SandboxLedger invoices={invoices} query={query} projectLabels={projectLabels} />
      {!invoices.length && <Empty title={loaded ? 'Your sandbox ledger starts here.' : 'Reading the sandbox ledger…'} text={loaded ? 'Prepare a fresh test invoice. Demo records and their approvals are never copied into this ledger automatically.' : 'Fetching the independent server-side invoice records.'} action={loaded ? <Link className="button primary" href="/sandbox/new"><Plus size={14} />Prepare sandbox invoice</Link> : undefined} />}
      <p className="sandbox-note">Separate PayPal sandbox ledger. Select a row for payment controls and verified provider evidence.</p>
    </>}
    {!form && <FundingCommandDock projectId={selected?.projectBinding?.projectId} invoiceId={selected?.id} disabled={!loaded || busy || !!review} onInspectInvoice={inspectPaymentEvidence} />}
    {review && <SandboxDialog title="Review this sandbox send" busy={busy} onClose={() => setReview(null)}>
      <Badge tone="neutral">PayPal sandbox · test funds only</Badge><InvoiceFacts invoice={review} /><p className="sandbox-description">{review.terms.description}</p>
      {errorBox}{staleReview && <div className="sandbox-error" role="alert">This invoice changed after the review opened. Close this dialog and inspect its current version.</div>}
      <label className="checkbox"><input type="checkbox" checked={acknowledged} disabled={busy} onChange={event => setAcknowledged(event.target.checked)} /><span>I approve this exact recipient, amount, coverage, and version for a PayPal sandbox invoice. This is a test operation using sandbox funds.</span></label>
      <p>Approval contacts PayPal to create and send the invoice. It does not confirm payment or reuse any simulated Demo approval.</p>
      <div className="form-actions"><button type="button" className="button" disabled={busy} onClick={() => setReview(null)}>Cancel</button><button type="button" className="button primary" disabled={busy || !acknowledged || staleReview || !configured} onClick={async () => { const result = await act({ action: 'send', id: review.id, version: review.version, confirmSandbox: true }, 'PayPal sandbox operation recorded. Inspect the provider result below.'); if (result) setReview(null); }}>{busy && <LoaderCircle size={14} className="sandbox-spin" />}{busy ? 'Contacting PayPal…' : `Approve & send ${money(review.terms.amountCents)}`}</button></div>
    </SandboxDialog>}
  </div>;
}

function InvoiceFacts({ invoice }: { invoice: SandboxInvoice }) {
  return <dl className="sandbox-facts"><div><dt>Recipient</dt><dd>{invoice.terms.recipientEmail}</dd></div><div><dt>Amount</dt><dd><strong>{money(invoice.terms.amountCents)}</strong><small>USD · PayPal sandbox</small></dd></div><div><dt>Coverage</dt><dd>{invoice.terms.projectReference} / {invoice.terms.coverageReference}</dd></div><div><dt>Invoice version</dt><dd>v{invoice.version}</dd></div></dl>;
}

function ProviderFacts({ invoice }: { invoice: SandboxInvoice }) {
  const provider = invoice.provider!;
  const settledPayments = invoice.confirmedPayments ?? provider.payments;
  return <>
    <dl className="sandbox-facts"><div><dt>Confirmed PayPal collection</dt><dd><strong>{money(invoice.confirmedCents)}</strong><small>Sandbox funds · provider evidence only</small></dd></div><div><dt>Pending</dt><dd>{money(invoice.pendingCents)}</dd></div><div><dt>PayPal amount due</dt><dd>{money(provider.dueCents)}</dd></div><div><dt>Verified refunds</dt><dd>{money(provider.refundedCents)}</dd></div><div><dt>PayPal state</dt><dd>{provider.status}</dd></div><div><dt>Last provider check</dt><dd>{new Date(provider.checkedAt).toLocaleString()}</dd></div></dl>
    {invoice.lastWebhook && <p className="sandbox-webhook-receipt"><strong>Updated after a verified PayPal webhook</strong><br />{invoice.lastWebhook.eventType} · {new Date(invoice.lastWebhook.appliedAt).toLocaleString()}<br /><span>{invoice.lastWebhook.eventId}</span></p>}
    {provider.warnings.map(warning => <p className="callout" key={warning}>{warning}</p>)}
    <p className="sandbox-reference">PayPal invoice: {provider.id}<br />Invoice number: {provider.invoiceNumber}</p>
    {settledPayments.length > 0 && <><h3>Verified PayPal transactions</h3>{settledPayments.map(payment => <div className="history-row" key={payment.id}><span className="event-dot" /><span className="sandbox-reference">{payment.id}{payment.date && <small>{payment.date}</small>}</span><strong>{money(payment.amountCents)}</strong></div>)}</>}
  </>;
}
function PayerLink({ invoice }: { invoice: SandboxInvoice }) {
  if (!invoice.provider?.payerUrl || ['draft', 'creating', 'sending', 'unknown', 'paid', 'canceled', 'refunded'].includes(invoice.state)) return null;
  let url: URL;
  try { url = new URL(invoice.provider.payerUrl); } catch { return null; }
  if (url.protocol !== 'https:' || url.hostname !== 'www.sandbox.paypal.com' || url.port || url.username || url.password || !/^\/(?:invoice\/p|invoice\/payerView\/details|invoicing\/pay)\//.test(url.pathname)) return null;
  return <a className="button full" href={url.href} target="_blank" rel="noopener noreferrer">Open PayPal sandbox payer <ExternalLink size={14} /></a>;
}
function LedgerSummary({ invoices }: { invoices: SandboxInvoice[] }) {
  const requested = invoices.filter(invoice => invoice.provider && !['DRAFT', 'CANCELLED'].includes(invoice.provider.status)).reduce((total, invoice) => total + invoice.terms.amountCents, 0);
  const confirmed = invoices.reduce((total, invoice) => total + invoice.confirmedCents, 0);
  const pending = invoices.reduce((total, invoice) => total + invoice.pendingCents, 0);
  return <div className="sandbox-summary"><div><small>REQUESTED IN SANDBOX</small><strong>{money(requested)}</strong><span>{invoices.length} separate sandbox invoice{invoices.length === 1 ? '' : 's'}</span></div><div><small>CONFIRMED PAYPAL COLLECTION</small><strong>{money(confirmed)}</strong><span>Provider-confirmed test funds only</span></div><div><small>PENDING · NOT COLLECTED</small><strong>{money(pending)}</strong><span>Opening checkout does not confirm payment</span></div></div>;
}
const sandboxColumns = [{ field: 'project', headerName: 'PROJECT', flex: 1.3 }, { field: 'coverage', headerName: 'COVERAGE', flex: 1.3 }, { field: 'amount', headerName: 'REQUESTED · USD', money: true, width: 130 }, { field: 'confirmed', headerName: 'CONFIRMED · USD', money: true, width: 130 }, { field: 'status', headerName: 'SANDBOX STATE', status: true }, { field: 'version', headerName: 'VERSION', width: 90 }];
function SandboxLedger({ invoices, query, projectLabels }: { invoices: SandboxInvoice[]; query: string; projectLabels: Record<string, string> }) {
  const rows = useMemo(() => invoices.map(invoice => ({ id: invoice.id, href: `/sandbox/${invoice.id}`, project: invoice.projectBinding ? projectLabels[invoice.projectBinding.projectId] ?? 'Sandbox project' : invoice.terms.projectReference, coverage: invoice.projectBinding ? `${invoice.projectBinding.purpose} · source v${invoice.projectBinding.sourceVersion}` : invoice.terms.coverageReference, recipient: invoice.terms.recipientEmail, amount: invoice.terms.amountCents, confirmed: invoice.confirmedCents, status: displayState(invoice), version: `v${invoice.version}` })), [invoices, projectLabels]);
  return <RecordsGrid search={query} rows={rows} columns={sandboxColumns} />;
}
function AutomaticUpdates({ webhooks, ledgerReadAt, visible, loading, error }: { webhooks: SandboxWebhookStatus | null; ledgerReadAt: string; visible: boolean; loading: boolean; error: string }) {
  const listener = error ? 'Listener status unavailable' : !webhooks ? 'Checking webhook listener…' : webhooks.listenerState === 'active' ? 'Webhook listener active' : webhooks.configured ? 'Webhook listener offline' : 'Webhook listener stopped';
  return <details className={`sandbox-auto-updates ${error || webhooks?.lastError ? 'has-error' : ''}`} aria-label="Sandbox automatic updates">
    <summary><strong><RefreshCw size={14} className={loading ? 'sandbox-spin' : ''} />SYNC / 3s</strong><span className={`sandbox-listener ${!error && webhooks?.listenerState === 'active' ? 'active' : ''}`}>{listener}</span></summary><div className="sandbox-auto-body">
    <p>{visible ? 'This grid checks the sandbox ledger every 3 seconds. Verified webhooks trigger an authenticated PayPal invoice read.' : 'Ledger checks pause while this tab is hidden and catch up when you return.'}</p>
    <div className="sandbox-auto-facts"><span>Ledger checked: <strong>{ledgerReadAt ? new Date(ledgerReadAt).toLocaleTimeString() : 'Waiting for server'}</strong></span><span>Last verified event: <strong>{webhooks?.lastVerifiedAt ? new Date(webhooks.lastVerifiedAt).toLocaleString() : 'None received yet'}</strong></span><span>Awaiting reconciliation: <strong>{webhooks?.pending ?? '—'}</strong></span></div>
    {webhooks?.lastAppliedAt && <p className="sandbox-auto-applied">Last webhook reconciliation: {new Date(webhooks.lastAppliedAt).toLocaleString()}</p>}
    {error && <p className="sandbox-auto-error" role="status">Ledger connection interrupted. Showing the last received records; automatic checks will retry. {error}</p>}
    {webhooks?.lastError && <p className="sandbox-auto-error" role="status">Webhook processing needs attention: {webhooks.lastError}</p>}
    {webhooks?.listenerState === 'offline' && <p className="sandbox-auto-error">The webhook listener is offline. Automatic ledger checks continue, but new PayPal events cannot be reconciled until it restarts.</p>}
  </div></details>;
}
