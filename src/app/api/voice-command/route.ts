import { AssemblyAiSpeech, MAX_COMMAND_AUDIO_BYTES, SpeechProviderError } from '@/lib/server/assemblyai';
import { LocalRequestError, requireLocalRequest } from '@/lib/server/local-request';

export const runtime = 'nodejs';
export const maxDuration = 60;
const headers = { 'Cache-Control': 'no-store' };
let processing = false;
export async function POST(request: Request) {
  try { requireLocalRequest(request); } catch { return Response.json({ error: 'Voice commands are available only from this local desktop workspace.' }, { status: 403, headers }); }
  if (processing) return Response.json({ error: 'Another voice command is being transcribed. Please wait before retrying.' }, { status: 429, headers });
  if (!request.headers.get('content-type')?.startsWith('multipart/form-data')) return Response.json({ error: 'Send a short audio recording.' }, { status: 400, headers });
  if (Number(request.headers.get('content-length')) > MAX_COMMAND_AUDIO_BYTES + 65536) return Response.json({ error: 'Recording exceeds 8 MB.' }, { status: 413, headers });
  processing = true;
  try {
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'Audio is missing.' }, { status: 400, headers });
    const chunks: Uint8Array[] = []; let size = 0; let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new LocalRequestError(408, 'Reading the recording timed out. Please retry.')); void reader.cancel().catch(() => {}); }, 5000); });
    try {
      while (true) {
        const { value, done } = await Promise.race([reader.read(), timeout]);
        if (done) break;
        size += value.byteLength;
        if (size > MAX_COMMAND_AUDIO_BYTES + 65536) { await reader.cancel(); return Response.json({ error: 'Recording exceeds 8 MB.' }, { status: 413, headers }); }
        chunks.push(value);
      }
    } finally { if (timer) clearTimeout(timer); reader.releaseLock(); }
    const form = await new Response(new Blob(chunks as BlobPart[]), { headers: { 'Content-Type': request.headers.get('content-type')! } }).formData();
    const file = form.get('audio');
    if (!(file instanceof File) || !file.size || file.size > MAX_COMMAND_AUDIO_BYTES || !/^(audio\/(webm|ogg|wav|x-wav|mpeg|mp3|mp4|aac|flac|aiff)|video\/webm)(;|$)/i.test(file.type)) return Response.json({ error: 'Use a short WebM, Ogg, WAV, MP3, MP4, FLAC, or AIFF command recording.' }, { status: 400, headers });
    const result = await new AssemblyAiSpeech().transcribe(new Uint8Array(await file.arrayBuffer()), request.signal);
    return Response.json(result, { headers });
  } catch (error) {
    if (error instanceof LocalRequestError) return Response.json({ error: error.message }, { status: error.status, headers });
    return Response.json({ error: error instanceof SpeechProviderError ? error.message : 'Could not read the voice recording. Type your command instead.' }, { status: error instanceof SpeechProviderError && error.code === 'input' ? 400 : 502, headers });
  } finally { processing = false; }
}
