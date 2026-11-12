'use client';
import { useEffect, useId, useRef, useState } from 'react';
import { ArrowUp, Check, Keyboard, LoaderCircle, Mic, Square, Upload, X } from 'lucide-react';
import './command-dock.css';

export type VoiceCommandResult = { message: string; summary?: string; steps?: { tool: string; result: string }[] };
export type VoiceCommandProvider = { id: string; label: string; route: string; notice: string; disclosure?: string; suggestions?: string[]; configured?: boolean; requiresModel?: boolean };
export type VoiceCommandExecution = {
  signal: AbortSignal;
  contextKey: string;
  /** Check before applying a returned plan or changing the selected UI. */
  assertCurrent: () => void;
  /** Call immediately before an irreversible request or applying a verified plan. */
  beginApply: () => void;
};
export type VoiceCommandPanelProps = {
  contextKey: string;
  disabled?: boolean;
  label?: string;
  inputLabel?: string;
  runLabel?: string;
  placeholder?: string;
  maxLength?: number;
  suggestions: string[];
  providers: VoiceCommandProvider[];
  initialProvider?: string;
  safetyNotice: string;
  applicationKind?: 'view' | 'draft';
  focusEvent?: string;
  run: (message: string, provider: string, execution: VoiceCommandExecution) => Promise<VoiceCommandResult>;
};
type Phase = 'idle' | 'permission' | 'listening' | 'transcribing' | 'thinking' | 'applying';

/** Audio is only transcribed here. A reviewed transcript always needs a separate Run. */
export default function VoiceCommandPanel({ contextKey, disabled = false, label = 'Voice and text command dock', inputLabel = 'Desk command', runLabel = 'Run desk command', placeholder = 'Show requested changes…', maxLength = 2000, suggestions, providers, initialProvider, safetyNotice, applicationKind = 'view', focusEvent = 'desk:focus-command', run }: VoiceCommandPanelProps) {
  const [text, setText] = useState('');
  const [provider, setProvider] = useState(initialProvider || providers[0]?.id || '');
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [result, setResult] = useState<VoiceCommandResult | null>(null);
  const [speechConfigured, setSpeechConfigured] = useState(false);
  const [modelConfigured, setModelConfigured] = useState(false);
  const [recordedSeconds, setRecordedSeconds] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const upload = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);
  const media = useRef<MediaStream | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const phaseRef = useRef<Phase>('idle');
  const draftContext = useRef(contextKey);
  const uploadContext = useRef({ key: contextKey, generation: 0 });
  const previousContext = useRef(contextKey);
  const current = useRef({ contextKey, disabled, run }); current.current = { contextKey, disabled, run };
  const disclosureId = useId();
  const busy = phase !== 'idle';
  const selectedProvider = providers.find(item => item.id === provider);
  const providerAvailable = (item: VoiceCommandProvider | undefined) => !!item && item.configured !== false && (!item.requiresModel || modelConfigured);

  function changePhase(next: Phase) { phaseRef.current = next; setPhase(next); }
  function releaseMicrophone() { media.current?.getTracks().forEach(track => track.stop()); media.current = null; if (timer.current) clearInterval(timer.current); timer.current = null; }
  function writeDraft(value: string) { draftContext.current = current.current.contextKey; setText(value); }
  function isCurrent(turn: number, key: string) { return mounted.current && generation.current === turn && current.current.contextKey === key; }
  function cancel() {
    if (phaseRef.current === 'applying') return;
    generation.current++; controller.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    releaseMicrophone(); changePhase('idle'); setNotice('Canceled. No command was applied. Your reviewed text is preserved.');
  }
  useEffect(() => {
    mounted.current = true;
    let active = true;
    fetch('/api/capabilities').then(r => r.json()).then(body => { if (!active) return; setModelConfigured(!!body.model?.configured); setSpeechConfigured(!!body.commandProviders?.speechConfigured); }).catch(() => { /* Configured local text runners remain available. */ });
    return () => { active = false; mounted.current = false; generation.current++; if (phaseRef.current !== 'applying') controller.current?.abort(); if (recorder.current?.state === 'recording') recorder.current.stop(); releaseMicrophone(); };
  }, []);
  useEffect(() => {
    const focus = () => { if (!current.current.disabled) input.current?.focus(); };
    window.addEventListener(focusEvent, focus);
    return () => window.removeEventListener(focusEvent, focus);
  }, [focusEvent]);
  useEffect(() => {
    if (previousContext.current === contextKey) return;
    previousContext.current = contextKey; draftContext.current = contextKey;
    setText(''); setResult(null); setError('');
    if (phaseRef.current === 'applying') {
      // The server may already have received a draft request. Never imply that
      // switching projects cancels it, and never silently rebind it to this one.
      setNotice('Context changed. The running request remains bound to the original selection.');
      return;
    }
    generation.current++; controller.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    releaseMicrophone(); changePhase('idle');
    setNotice('Project or selected records changed. The previous command was cleared; review a new command for this context.');
  }, [contextKey]);
  useEffect(() => {
    if (!disabled || phaseRef.current === 'idle' || phaseRef.current === 'applying') return;
    generation.current++; controller.current?.abort();
    if (recorder.current?.state === 'recording') recorder.current.stop();
    releaseMicrophone(); changePhase('idle');
    setNotice('Commands are paused while another action is open. Review the selected context before continuing.');
  }, [disabled]);

  async function submit() {
    const message = text.trim();
    if (phaseRef.current !== 'idle' || disabled || !message || !contextKey || !providerAvailable(selectedProvider)) return;
    if (draftContext.current !== current.current.contextKey) { writeDraft(''); setNotice('Context changed. Enter or record a new command for the current selection.'); return; }
    const snapshot = current.current; const turn = ++generation.current;
    setError(''); setNotice(''); setResult(null); changePhase('thinking');
    const abort = new AbortController(); controller.current = abort;
    let beganApplying = false;
    const assertCurrent = () => { if (!isCurrent(turn, snapshot.contextKey) || current.current.disabled || abort.signal.aborted) throw new Error('The project, selected records, or available actions changed. Review the current context before running a new command.'); };
    try {
      const response = await snapshot.run(message, provider, {
        signal: abort.signal, contextKey: snapshot.contextKey, assertCurrent,
        beginApply: () => { assertCurrent(); beganApplying = true; changePhase('applying'); },
      });
      if (!mounted.current || turn !== generation.current) return;
      // A successful runner may itself advance the project's revision. Its
      // confirmed response remains valid for the captured request context.
      if (!beganApplying) assertCurrent();
      setResult(response); setNotice(response.message + (current.current.contextKey !== snapshot.contextKey ? ' This request used the selection reviewed when you pressed Run.' : ''));
    } catch (e) {
      if (mounted.current && turn === generation.current && !abort.signal.aborted) setError((e instanceof Error ? e.message : 'Command failed.') + (beganApplying && applicationKind === 'draft' ? ' The request may have reached the server. Refresh the original project before retrying.' : ''));
    } finally { if (mounted.current && turn === generation.current) changePhase('idle'); }
  }
  async function transcribe(blob: Blob, turn: number, key: string) {
    if (!isCurrent(turn, key)) return;
    changePhase('transcribing'); setNotice('AssemblyAI is transcribing this short command.');
    const abort = new AbortController(); controller.current = abort;
    try {
      if (!blob.size || blob.size > 8 * 1024 * 1024) throw new Error('Use a recording up to 30 seconds and 8 MB.');
      const form = new FormData(); form.append('audio', blob, 'desk-command');
      const response = await fetch('/api/voice-command', { method: 'POST', body: form, signal: abort.signal });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || 'Voice transcription failed.');
      if (body.provider !== 'assemblyai' || typeof body.text !== 'string') throw new Error('The speech service returned an invalid transcript.');
      if (!isCurrent(turn, key)) return;
      draftContext.current = key; setText(body.text); setNotice(`AssemblyAI · ${body.model}. Review the transcript, then run the command.${body.cleanup === 'not-confirmed' ? ' Provider transcript cleanup could not be confirmed.' : ''}`); input.current?.focus();
    } catch (e) { if (isCurrent(turn, key) && !abort.signal.aborted) setError(e instanceof Error ? e.message : 'Voice unavailable. Type your command instead.'); }
    finally { if (isCurrent(turn, key)) changePhase('idle'); }
  }
  async function startRecording() {
    if (phaseRef.current !== 'idle' || disabled || !contextKey) return;
    const key = current.current.contextKey; const turn = ++generation.current;
    setError(''); setNotice(''); setResult(null); changePhase('permission'); setRecordedSeconds(0);
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') throw new Error('This browser cannot record audio. Upload a short command or type instead.');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!isCurrent(turn, key)) { stream.getTracks().forEach(track => track.stop()); return; }
      media.current = stream; const chunks: Blob[] = [];
      const mimeType = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'].find(type => MediaRecorder.isTypeSupported(type));
      const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined); recorder.current = rec;
      rec.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      rec.onstop = () => {
        // A delayed stop from a canceled recording must not stop the next one.
        if (recorder.current === rec) { releaseMicrophone(); recorder.current = null; }
        else stream.getTracks().forEach(track => track.stop());
        if (isCurrent(turn, key)) void transcribe(new Blob(chunks, { type: rec.mimeType }), turn, key);
      };
      rec.onerror = () => { if (isCurrent(turn, key)) { generation.current++; releaseMicrophone(); changePhase('idle'); setError('Recording failed. Type your command instead.'); } };
      rec.start(250); changePhase('listening'); const started = Date.now();
      timer.current = setInterval(() => { const elapsed = Math.floor((Date.now() - started) / 1000); setRecordedSeconds(elapsed); if (elapsed >= 30 && rec.state === 'recording') rec.stop(); }, 250);
    } catch (e) { if (isCurrent(turn, key)) { releaseMicrophone(); changePhase('idle'); setError(e instanceof Error ? e.message : 'Microphone unavailable. Type your command instead.'); } }
  }
  const status = phase === 'permission' ? 'Waiting for microphone permission…' : phase === 'listening' ? `Listening · ${recordedSeconds}s / 30s` : phase === 'transcribing' ? 'Transcribing with AssemblyAI…' : phase === 'thinking' ? 'Reading the reviewed command…' : phase === 'applying' ? applicationKind === 'draft' ? 'Applying to the reviewed project. Wait for confirmation…' : 'Updating the workspace…' : notice || 'Ready · voice or keyboard. Every business decision stays yours.';
  return <section className={`desk-command-dock phase-${phase}`} aria-label={label}>
    <div className="command-dock-top"><div><span className={`command-provider-dot ${busy ? 'busy' : ''}`} /><strong>VOICE / COMMAND</strong><span className="command-context">lancepal · operator console</span></div><span className="command-key-hint">⌘ K <span>TO FOCUS</span></span></div>
    <form className="command-composer" onSubmit={e => { e.preventDefault(); void submit(); }}>
      <div className="command-talk-control"><button type="button" className={`command-microphone ${phase === 'listening' ? 'recording' : ''}`} aria-describedby={disclosureId} title="Stop sends audio to AssemblyAI for transcription; review the transcript before Run." disabled={disabled || !contextKey || (!speechConfigured && phase !== 'listening') || busy && phase !== 'listening'} aria-label={phase === 'listening' ? 'Stop and transcribe command' : 'Record command with AssemblyAI'} onClick={() => phase === 'listening' ? recorder.current?.stop() : void startRecording()}>{phase === 'listening' ? <Square size={19}/> : <Mic size={21}/>}</button><span>{phase === 'listening' ? 'STOP / SEND' : 'PUSH TO TALK'}</span></div>
      <div className="command-recording-meter" aria-label={phase === 'listening' ? `${recordedSeconds} seconds recorded out of 30` : 'Recording duration meter idle'}><span>REC TIME</span><div aria-hidden="true">{Array.from({ length: 15 }, (_, i) => <i key={i} className={phase === 'listening' && recordedSeconds >= (i + 1) * 2 ? 'lit' : ''} />)}</div><small>{phase === 'listening' ? `${String(recordedSeconds).padStart(2, '0')} / 30 SEC` : '00 / 30 SEC'}</small></div>
      <div className="command-input-channel"><span className="command-input-label">{phase === 'transcribing' ? 'TRANSCRIPTION' : 'REVIEW / ENTER COMMAND'}<i>↵ RUN</i></span><textarea ref={input} aria-label={inputLabel} maxLength={maxLength} value={text} onChange={e => writeDraft(e.target.value)} disabled={busy || disabled} placeholder={placeholder} rows={1} onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }}/></div>
      {busy ? <button key="cancel-command" type="button" className="command-send" disabled={phase === 'applying'} aria-label={phase === 'applying' ? 'Applying command' : 'Cancel command'} onClick={event => { event.preventDefault(); cancel(); }}>{phase === 'applying' ? <LoaderCircle size={19} className="command-spin"/> : <X size={19}/>}<span>{phase === 'applying' ? 'APPLY' : 'CANCEL'}</span></button> : <button key="run-command" type="submit" className="command-send" disabled={disabled || !text.trim() || !contextKey || !providerAvailable(selectedProvider)} aria-label={runLabel}><ArrowUp size={19}/><span>RUN</span></button>}
    </form>
    <div className="command-dock-bottom"><span className="command-status" role="status" aria-live="polite">{busy ? <LoaderCircle size={12} className="command-spin"/> : result ? <Check size={12}/> : <Keyboard size={12}/>} {status}</span><span className="command-route">{selectedProvider?.route || 'UNAVAILABLE'}</span></div>
    <p id={disclosureId} className="command-audio-disclosure">{speechConfigured ? 'Microphone and uploads send audio to AssemblyAI. Review the transcript before Run.' : 'Audio is unavailable. Type a command to continue.'}</p>
    {selectedProvider?.disclosure && <p className="command-audio-disclosure">{selectedProvider.disclosure}</p>}
    <details className="command-options"><summary>Command options <span>PROVIDER · AUDIO · SHORTCUTS</span></summary><div className="command-options-body">
      <label className="command-provider-control"><span className={`command-mode-dial ${provider}`} aria-hidden="true"><i /></span><span>PROCESSOR<select aria-label="Command provider" disabled={busy || disabled} value={provider} onChange={e => { setProvider(e.target.value); setError(''); setResult(null); setNotice(''); }}><>{providers.map(item => <option key={item.id} value={item.id} disabled={!providerAvailable(item)}>{item.label}{!providerAvailable(item) ? ' · unavailable' : ''}</option>)}</></select></span></label>
      <div className="command-options-actions"><button className="command-upload" type="button" disabled={!speechConfigured || busy || disabled || !contextKey} onClick={() => { uploadContext.current = { key: current.current.contextKey, generation: generation.current }; upload.current?.click(); }}><Upload size={13}/>Audio command</button><input ref={upload} type="file" accept="audio/*,video/webm" className="sr-only" aria-label="Upload short audio command" onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file && phaseRef.current === 'idle' && !disabled && speechConfigured) { if (uploadContext.current.key !== current.current.contextKey || uploadContext.current.generation !== generation.current) { setNotice('Context changed while selecting audio. Choose the file again for this context.'); return; } setError(''); void transcribe(file, ++generation.current, current.current.contextKey); } }}/><div className="command-suggestions">{(selectedProvider?.suggestions ?? suggestions).map(s => <button type="button" key={s} disabled={busy || disabled} onClick={() => { writeDraft(s); input.current?.focus(); }}>{s}</button>)}</div></div>
      <p>{selectedProvider?.notice} {speechConfigured ? 'Stop or audio upload sends a short command to AssemblyAI. Review its transcript, then Run.' : 'Voice is unavailable; typed commands work.'} {safetyNotice}</p>
    </div></details>
    {error && <div className="command-error" role="alert"><span>{error}</span><button type="button" onClick={() => setError('')}>Dismiss</button></div>}
    {result && <details className="command-receipt"><summary>{result.summary || 'Command result'} · inspect results</summary><p>{result.message}</p><ol>{result.steps?.map((step, i) => <li key={i}><code>{step.tool}</code><span>{step.result}</span></li>)}</ol></details>}
  </section>;
}
