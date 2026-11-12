import test from 'node:test';
import assert from 'node:assert/strict';
import { AssemblyAiSpeech, MAX_COMMAND_AUDIO_BYTES, SpeechProviderError } from '../src/lib/server/assemblyai';

const env = { ASSEMBLYAI_API_KEY: 'test-only-speech-key' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
test('short voice commands use the fixed AssemblyAI host, bounded audio, actual text, and delete only their own transcript', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const replies = [json({ upload_url: 'https://cdn.assemblyai.com/upload/test-command' }), json({ id: 'speech-1', status: 'queued' }), json({ id: 'speech-1', status: 'completed', text: 'Show pending payments.', speech_model_used: 'universal-2', audio_duration: 3 }), json({ id: 'speech-1', status: 'deleted' })];
  const fake = (async (url, init) => { calls.push({ url: String(url), init: init! }); return replies.shift()!; }) as typeof fetch;
  const result = await new AssemblyAiSpeech(env, fake, async () => {}).transcribe(new Uint8Array([1,2,3]));
  assert.equal(result.provider, 'assemblyai'); assert.equal(result.text, 'Show pending payments.'); assert.equal(result.cleanup, 'deleted');
  assert(calls.every(call => call.url.startsWith('https://api.assemblyai.com/v2/')));
  const submitted = JSON.parse(String(calls[1].init.body));
  assert.deepEqual(submitted.speech_models, ['universal-2']); assert.equal(submitted.audio_end_at, 30000);
  assert.equal(calls[3].init.method, 'DELETE'); assert.equal(calls[3].url, 'https://api.assemblyai.com/v2/transcript/speech-1');
  assert(!JSON.stringify(result).includes(env.ASSEMBLYAI_API_KEY));
});
test('missing speech credentials and oversized audio never call a provider', async () => {
  let called = false; const fake = (async () => { called = true; return json({}); }) as typeof fetch;
  await assert.rejects(new AssemblyAiSpeech({}, fake).transcribe(new Uint8Array([1])), /not configured/);
  await assert.rejects(new AssemblyAiSpeech(env, fake).transcribe(new Uint8Array(MAX_COMMAND_AUDIO_BYTES + 1)), /30 seconds/);
  assert.equal(called, false);
});
test('upstream speech errors are redacted and never turn into a fabricated transcript', async () => {
  const fake = (async () => json({ error: 'sensitive echo from upstream' }, 401)) as typeof fetch;
  await assert.rejects(new AssemblyAiSpeech(env, fake).transcribe(new Uint8Array([1])), error => error instanceof SpeechProviderError && error.code === 'authentication' && !error.message.includes('sensitive'));
});
test('speech results retain truthful cleanup status and silence produces a recoverable error', async () => {
  const make = (text: string | null) => {
    const replies = [json({ upload_url: 'https://cdn.assemblyai.com/upload/test' }), json({ id: 'speech-2', status: 'completed', text }), json({}, 503)];
    return new AssemblyAiSpeech(env, (async () => replies.shift()!) as typeof fetch, async () => {});
  };
  assert.equal((await make('Compare the animation.').transcribe(new Uint8Array([1]))).cleanup, 'not-confirmed');
  await assert.rejects(make(null).transcribe(new Uint8Array([1])), /No speech/);
});
test('speech submission rejects an unexpected upload URL without following it', async () => {
  let calls = 0;
  const fake = (async () => { calls++; return json({ upload_url: 'https://untrusted.example/voice' }); }) as typeof fetch;
  await assert.rejects(new AssemblyAiSpeech(env, fake).transcribe(new Uint8Array([1])), /unexpected upload/);
  assert.equal(calls, 1);
});
