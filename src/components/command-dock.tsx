'use client';
import { useRef } from 'react';
import { useDesk } from './store';
import VoiceCommandPanel, { type VoiceCommandProvider } from './voice-command-panel';
import { buildDeskCommandContext, interpretDemoCommand, validateDeskActions, type DeskCommandResult } from '@/lib/desk-commands';

const providers: VoiceCommandProvider[] = [
  { id: 'demo', label: 'Local · Demo interpreter', route: 'LOCAL / DEMO', notice: 'Typed demo commands stay in this browser.' },
  { id: 'nebius', label: 'Nebius · live model', route: 'NEBIUS / LIVE', notice: 'Selected demo context is sent to Nebius.', requiresModel: true },
];
type Props = { projectId: string; selectedId: string; onResult: (result: DeskCommandResult) => Promise<void> | void; disabled?: boolean };

/** The shared microphone has no authority to apply a business decision. */
export default function CommandDock({ projectId, selectedId, onResult, disabled = false }: Props) {
  const { state } = useDesk();
  const current = useRef({ state, projectId, selectedId, onResult }); current.current = { state, projectId, selectedId, onResult };
  return <VoiceCommandPanel
    contextKey={`${projectId}:${selectedId}:${state.revision}`}
    disabled={disabled || !projectId}
    providers={providers}
    initialProvider="demo"
    suggestions={['Show requested changes', 'Compare the animation', 'Show pending payments']}
    safetyNotice="Commands change views and open reviews; they cannot approve agreements, send invoices, or mark payments paid."
    run={async (message, provider, execution) => {
      const snapshot = current.current;
      let response: DeskCommandResult;
      if (provider === 'demo') response = interpretDemoCommand(snapshot.state, snapshot.projectId, snapshot.selectedId, message);
      else if (provider === 'nebius') {
        const context = buildDeskCommandContext(snapshot.state, snapshot.projectId, snapshot.selectedId);
        const http = await fetch('/api/desk-command', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message, context }), signal: execution.signal });
        const body = await http.json();
        if (!http.ok) throw new Error(body.error || 'The live command could not be completed.');
        if (body.provider !== 'nebius' || typeof body.message !== 'string' || !Array.isArray(body.steps)) throw new Error('The command service returned an invalid result.');
        response = { ...body, actions: validateDeskActions(context, body.actions) };
      } else throw new Error('This command provider is unavailable.');
      execution.assertCurrent();
      if (current.current.projectId !== snapshot.projectId || current.current.selectedId !== snapshot.selectedId || current.current.state.revision !== snapshot.state.revision) throw new Error('The project or its records changed while this command was running. Review the current context and retry.');
      execution.beginApply();
      await snapshot.onResult(response);
      return { message: response.message, summary: `${response.provider === 'nebius' ? 'Live Nebius' : 'Local demo'} · ${response.actions.length} view/review actions`, steps: response.steps };
    }}
  />;
}
