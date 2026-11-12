'use client';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { useDesk } from './store';
import { ArrowUpRight, X, Inbox, Search } from 'lucide-react';
export function Badge({ children, tone }: { children: ReactNode; tone?: string }) { const text = String(children).toLowerCase(); const kind = tone || (/paid|active|accepted|completed|ready|included/.test(text) && !/unpaid|await|not/.test(text) ? 'green' : /pending|await|clarif|draft|proposed|investigating|shared/.test(text) ? 'amber' : /fail|unknown|error|overdue/.test(text) ? 'red' : 'neutral'); return <span className={`badge ${kind}`}><i />{children}</span>; }
export function PageTitle({ eyebrow, title, subtitle, actions }: { eyebrow?: string; title: string; subtitle?: string; actions?: ReactNode }) { return <div className="page-title"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div><div className="page-actions">{actions}</div></div>; }
export function Card({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }
export function CardHeader({ title, meta, href }: { title: string; meta?: string; href?: string }) { return <div className="card-header"><h2>{title}</h2>{href ? <Link href={href}>{meta || 'View all'} <ArrowUpRight size={14} /></Link> : meta ? <span className="muted">{meta}</span> : null}</div>; }
export function Empty({ title = 'A little room for what’s next.', text, action }: { title?: string; text: string; action?: ReactNode }) { return <div className="empty"><Inbox size={30} strokeWidth={1.3} /><h3>{title}</h3><p>{text}</p>{action}</div>; }
export function SearchBox({ value, onChange, placeholder = 'Search your records…' }: { value: string; onChange: (s: string) => void; placeholder?: string }) { return <label className="search"><Search size={16} /><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e => onChange(e.target.value)} /></label>; }
export function Modal({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null); const close = useRef(onClose); close.current = onClose;
  const titleId = useId(); const { error, clearError } = useDesk();
  useEffect(() => { const d = ref.current!; d.showModal(); const onCancel = (e: Event) => { e.preventDefault(); close.current(); }; d.addEventListener('cancel', onCancel); return () => { d.removeEventListener('cancel', onCancel); d.close(); }; }, []);
  return <dialog ref={ref} className="modal" aria-labelledby={titleId} onClick={e => { if (e.target === e.currentTarget) onClose(); }}><div className="modal-heading"><h2 id={titleId}>{title}</h2><button type="button" aria-label="Close dialog" className="icon-button" onClick={onClose}><X size={19} /></button></div>{error && <div className="modal-error" role="alert"><span>{error}</span><button type="button" onClick={clearError}>Dismiss</button></div>}{children}</dialog>;
}
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>; }
export function Tabs({ values, current, onChange }: { values: string[]; current: string; onChange: (tab: string) => void }) { return <div className="tabs" role="tablist">{values.map(t => <button key={t} role="tab" aria-selected={current === t} className={current === t ? 'selected' : ''} onClick={() => onChange(t)}>{t}</button>)}</div>; }
export function Avatar({ name, color = '#dfe7d9', size = 'normal' }: { name: string; color?: string; size?: string }) { return <span className={`avatar ${size}`} style={{ background: color }}>{name.split(/\s|&/).filter(Boolean).slice(0, 2).map(x => x[0]).join('')}</span>; }
export function date(value: string) { return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); }
