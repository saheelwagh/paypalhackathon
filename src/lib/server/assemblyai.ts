import { z } from 'zod';

const BASE = 'https://api.assemblyai.com/v2';
export const MAX_COMMAND_AUDIO_BYTES = 8 * 1024 * 1024;
export class SpeechProviderError extends Error {
  constructor(public code: 'configuration' | 'input' | 'authentication' | 'rate-limit' | 'timeout' | 'unavailable' | 'transcription', message: string) { super(message); this.name = 'SpeechProviderError'; }
}
const transcriptSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9-]+$/), status: z.enum(['queued', 'processing', 'completed', 'error']), text: z.string().nullable().optional(), speech_model_used: z.string().nullable().optional(), audio_duration: z.number().nullable().optional() });
export type SpeechResult = { provider: 'assemblyai'; text: string; model: string; audioDuration: number | null; cleanup: 'deleted' | 'not-confirmed' };

/** Short command recordings only. No transcript or audio becomes commercial authority. */
export class AssemblyAiSpeech {
  constructor(private env: Record<string, string | undefined> = process.env, private fetcher: typeof fetch = fetch, private pause = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
    const done = () => { signal.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(done, ms);
    const abort = () => { clearTimeout(timer); reject(new DOMException('Canceled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
  })) {}

  async transcribe(audio: Uint8Array, requestSignal?: AbortSignal): Promise<SpeechResult> {
    if (!audio.byteLength || audio.byteLength > MAX_COMMAND_AUDIO_BYTES) throw new SpeechProviderError('input', 'Use a command recording up to 30 seconds and 8 MB.');
    const key = this.env.ASSEMBLYAI_API_KEY?.trim();
    if (!key) throw new SpeechProviderError('configuration', 'AssemblyAI is not configured. Type your command instead.');
    // Universal-2 is deliberately pinned for the small English command path. No silent model/provider fallback.
    const model = this.env.ASSEMBLYAI_STT_MODEL?.trim() || 'universal-2';
    if (!['universal-2', 'universal-3-5-pro', 'universal-3-pro'].includes(model)) throw new SpeechProviderError('configuration', 'The configured recorded speech model is unsupported. Use a supported AssemblyAI recorded model.');
    const signal = AbortSignal.any([AbortSignal.timeout(55_000), ...(requestSignal ? [requestSignal] : [])]);
    let transcriptId = '';
    let result: Omit<SpeechResult, 'cleanup'> | undefined;
    let cleanup: SpeechResult['cleanup'] = 'not-confirmed';
    const request = async (path: string, init: RequestInit = {}) => {
      const response = await this.fetcher(`${BASE}${path}`, { ...init, headers: { authorization: key, ...init.headers }, redirect: 'error', cache: 'no-store', signal });
      if (!response.ok) {
        if ([401, 403].includes(response.status)) throw new SpeechProviderError('authentication', 'AssemblyAI rejected the key or project permissions. Typed commands remain available.');
        if (response.status === 429) throw new SpeechProviderError('rate-limit', 'AssemblyAI rate limit reached. Retry explicitly or type your command.');
        throw new SpeechProviderError('unavailable', `AssemblyAI request failed (HTTP ${response.status}). No synthetic transcript was substituted.`);
      }
      return response.json() as Promise<unknown>;
    };
    try {
      const upload = z.object({ upload_url: z.url() }).parse(await request('/upload', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: new Blob([audio.slice().buffer as ArrayBuffer]) }));
      const uploadUrl = new URL(upload.upload_url);
      if (uploadUrl.protocol !== 'https:' || !uploadUrl.hostname.endsWith('.assemblyai.com')) throw new SpeechProviderError('unavailable', 'AssemblyAI returned an unexpected upload location.');
      let transcript = transcriptSchema.parse(await request('/transcript', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ audio_url: upload.upload_url, speech_models: [model], language_code: 'en', audio_end_at: 30_000, punctuate: true, format_text: true }) }));
      transcriptId = transcript.id;
      for (let attempt = 0; attempt < 30; attempt++) {
        if (transcript.status === 'error') throw new SpeechProviderError('transcription', 'AssemblyAI could not transcribe this recording. Your typed command and workspace are unchanged.');
        if (transcript.status === 'completed') {
          const text = transcript.text?.trim();
          if (!text) throw new SpeechProviderError('transcription', 'No speech was detected. Record again or type a command.');
          if (text.length > 2000) throw new SpeechProviderError('input', 'The transcript is too long for a desk command. Use a shorter recording.');
          result = { provider: 'assemblyai', text, model: transcript.speech_model_used || model, audioDuration: transcript.audio_duration ?? null };
          break;
        }
        await this.pause(1000, signal);
        transcript = transcriptSchema.parse(await request(`/transcript/${transcriptId}`));
      }
      if (!result) throw new SpeechProviderError('timeout', 'Transcription did not finish in time. Type your command or retry explicitly.');
    } catch (error) {
      if (error instanceof SpeechProviderError) throw error;
      if (signal.aborted || error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) throw new SpeechProviderError('timeout', 'Voice transcription was canceled or timed out. No command was executed.');
      throw new SpeechProviderError('unavailable', 'Voice transcription is unavailable. Type your command instead; no synthetic transcript was substituted.');
    } finally {
      // Delete only the temporary transcript created by this call; never a caller-supplied ID.
      if (transcriptId) {
        try {
          const response = await this.fetcher(`${BASE}/transcript/${transcriptId}`, { method: 'DELETE', headers: { authorization: key }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(4000) });
          if (response.ok) cleanup = 'deleted';
        } catch { /* Cleanup failure must not masquerade as successful deletion. */ }
      }
    }
    return { ...result!, cleanup };
  }
}
