import { applyCommand, seed, type Actor, type Command, type DeskState } from './domain';
export const scenarios = [
  { id: 'discovery', name: 'Fresh discovery · no agreement yet' },
  { id: 'funded', name: 'Deposit funded · ready for change review' },
  { id: 'pending', name: 'Client says paid · provider pending' },
  { id: 'po', name: 'Collection blocked · missing PO reference' },
  { id: 'unknown', name: 'Send timed out · reconcile existing operation' },
  { id: 'transcription-failure', name: 'Transcription failed · source preserved' },
  { id: 'ambiguous', name: 'Ambiguous request · clarification needed' },
  { id: 'duplicate', name: 'Animation already invoiced · prevent duplicates' },
  { id: 'accepted-delivery', name: 'Delivery accepted · final balance ready' },
  { id: 'completed', name: 'Journey complete · $1,250 confirmed' },
] as const;
export function loadScenario(name: string): DeskState {
  let s = seed(); const act = (c: Command, actor: Actor = 'owner') => { s = applyCommand(s, c, actor); };
  if (!scenarios.some(x => x.id === name)) throw new Error('Unknown demo scenario.');
  if (name === 'transcription-failure') s.conversations[0].status = 'failed';
  if (name === 'ambiguous') { s.changes[1].classification = 'Unclear'; s.changes[1].status = 'clarification needed'; }
  if (!['discovery', 'transcription-failure', 'ambiguous'].includes(name)) {
    act({ type: 'conversation.update', id: 'demo_discovery', data: { answer: 'Monday delivery is fine.' } });
    act({ type: 'proposal.share', id: 'demo_launch_proposal', version: 1 });
    act({ type: 'proposal.accept', id: 'demo_launch_proposal', version: 1 }, 'client');
    act({ type: 'proposal.activate', id: 'demo_launch_proposal', version: 1 });
    act({ type: 'invoice.prepare', id: 'demo_seed_deposit', projectId: 'demo_acme', data: { purpose: 'deposit' } });
    const i = s.invoices[0];
    act({ type: 'invoice.send', id: i.id, version: i.version, data: { amount: i.amount, recipient: i.recipient, timeout: name === 'unknown' } });
    if (name === 'po') { s.invoices[0].blocker = 'Missing purchase-order reference'; s.invoices[0].due = '2026-11-10'; }
    if (name === 'pending') act({ type: 'payment.simulate', id: i.id, data: { status: 'pending', eventId: 'demo_pending_event' } }, 'client');
    if (!['po', 'unknown', 'pending'].includes(name)) {
      act({ type: 'payment.simulate', id: i.id, data: { status: 'paid', eventId: 'demo_deposit_event' } }, 'client');
      if (['duplicate', 'accepted-delivery', 'completed'].includes(name)) {
        act({ type: 'change.edit', id: 'demo_animation', version: 1, data: { answer: 'Custom hero animation. Monday delivery agreed as fixture text.' } });
        act({ type: 'change.approve', id: 'demo_animation', version: 2 });
        act({ type: 'change.accept', id: 'demo_animation', version: 2 }, 'client');
        act({ type: 'invoice.prepare', id: 'demo_seed_extra', projectId: 'demo_acme', data: { purpose: 'change', changeId: 'demo_animation' } });
        const extra = s.invoices[1];
        act({ type: 'invoice.send', id: extra.id, version: extra.version, data: { amount: extra.amount, recipient: extra.recipient } });
        if (name !== 'duplicate') {
          act({ type: 'payment.simulate', id: extra.id, data: { status: 'paid', eventId: 'demo_extra_event' } }, 'client');
          act({ type: 'delivery.submit', projectId: 'demo_acme', data: { delivery: 'Synthetic delivery evidence: five responsive pages, working contact form, custom animation, and handover notes.' } });
          act({ type: 'delivery.accept', projectId: 'demo_acme', version: 1 }, 'client');
          if (name === 'completed') {
            act({ type: 'invoice.prepare', id: 'demo_seed_final', projectId: 'demo_acme', data: { purpose: 'final' } }); const final = s.invoices[2];
            act({ type: 'invoice.send', id: final.id, version: final.version, data: { amount: final.amount, recipient: final.recipient } });
            act({ type: 'payment.simulate', id: final.id, data: { status: 'paid', eventId: 'demo_final_event' } }, 'client');
          }
        }
      }
    }
  }
  s.scenario = name;
  s.activity = [{ id: `demo_scenario_${name}`, at: new Date().toISOString(), type: 'fixture.loaded', title: `Synthetic scenario: ${scenarios.find(x => x.id === name)!.name}`, detail: 'All preceding decisions and payments are seeded fixture history, not actions by real people or providers.', href: '/settings', actor: 'fixture' }, ...s.activity.map(a => ({ ...a, title: `Seeded: ${a.title}`, actor: 'fixture' }))];
  return s;
}
