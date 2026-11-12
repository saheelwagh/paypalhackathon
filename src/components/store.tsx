'use client';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { applyCommand, seed, type Actor, type Command, type DeskState } from '@/lib/domain';
import { loadScenario } from '@/lib/scenarios';
import { DemoWorkspaceRepository, DEMO_STORAGE_KEY } from '@/lib/demo-repository';
import { runDemoAgent, type Goal } from '@/lib/agent';
type ContextValue = { state: DeskState; ready: boolean; error: string; message: string; dispatch: (command: Command, actor?: Actor) => Promise<boolean>; reset: (empty?: boolean, scenario?: string) => Promise<void>; run: (goal: Goal, projectId: string, context?: string, simulateFailure?: boolean) => Promise<string | undefined>; clearError: () => void; audio: Record<string, string>; attachAudio: (id: string, blob: Blob) => void };
const Context = createContext<ContextValue | null>(null);
export function Store({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DeskState>(seed); const repository = useRef<DemoWorkspaceRepository | null>(null);
  const [ready, setReady] = useState(false); const [error, setError] = useState(''); const [message, setMessage] = useState(''); const [audio, setAudio] = useState<Record<string, string>>({}); const audioRef = useRef(audio); audioRef.current = audio;
  useEffect(() => {
    repository.current = new DemoWorkspaceRepository(localStorage, seed(), navigator.locks);
    try { setState(repository.current.read()); } catch { setError('Saved demo data is incompatible. Reset the sample workspace in Settings to recover.'); }
    setReady(true);
    const sync = (event: StorageEvent) => { if (event.key === DEMO_STORAGE_KEY) { try { setState(repository.current!.read()); } catch { setError('Could not load the changed workspace. Reload or reset the sample.'); } } };
    window.addEventListener('storage', sync); return () => { window.removeEventListener('storage', sync); Object.values(audioRef.current).forEach(URL.revokeObjectURL); };
  }, []);
  useEffect(() => { if (!message) return; const t = setTimeout(() => setMessage(''), 4500); return () => clearTimeout(t); }, [message]);
  async function dispatch(c: Command, actor: Actor = 'owner') { setError(''); try { const next = await repository.current!.transact(s => applyCommand(s, c, actor)); setState(next); setMessage(next.activity[0]?.title ?? 'Saved'); return true; } catch (e) { setError(e instanceof Error ? e.message : 'The action could not be completed.'); return false; } }
  async function run(goal: Goal, projectId: string, context = '', simulateFailure = false) { setError(''); try { let id = ''; const next = await repository.current!.transact(s => { const result = runDemoAgent(s, goal, projectId, context, { simulateFailure }); id = result.id; return { ...s, revision: s.revision + 1, runs: [result, ...s.runs], activity: [{ id: `demo_audit_${crypto.randomUUID()}`, at: result.created, type: 'agent.run', title: 'Simulated assistant reviewed the evidence', detail: result.goal, href: `/activity/${result.id}`, actor: 'owner' }, ...s.activity] }; }); setState(next); return id; } catch (e) { setError(e instanceof Error ? e.message : 'Assistant failed. Your work is preserved.'); } }
  async function reset(empty = false, scenario = 'discovery') { try { const next = await repository.current!.replace(empty ? seed(true) : loadScenario(scenario)); setState(next); setError(''); setMessage(empty ? 'Empty workspace selected' : 'Synthetic scenario loaded'); } catch { setError('Could not replace demo data. Browser storage may be unavailable or full.'); } }
  return <Context.Provider value={{ state, ready, error, message, dispatch, reset, run, clearError: () => setError(''), audio, attachAudio: (id, blob) => setAudio(old => { if (old[id]) URL.revokeObjectURL(old[id]); return { ...old, [id]: URL.createObjectURL(blob) }; }) }}>{children}</Context.Provider>;
}
export function useDesk() { const value = useContext(Context); if (!value) throw new Error('Workspace provider missing'); return value; }
