import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest, type Server } from 'node:http';
import { createWebhookRelay, PAYPAL_WEBHOOK_PATH } from '../src/lib/server/webhook-relay';

const signedHeaders = { 'Content-Type': 'application/json', 'paypal-auth-algo': 'SHA256withRSA', 'paypal-cert-url': 'https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1', 'paypal-transmission-id': 'test-delivery', 'paypal-transmission-sig': 'test-signature', 'paypal-transmission-time': '2026-11-12T12:00:00Z' };
async function listen(server: Server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); const address = server.address(); assert(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}`; }
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };

test('webhook relay forwards only the callback bytes and signature headers to loopback', async () => {
  const seen: { url: string; headers: Headers; body: string }[] = [];
  const relay = createWebhookRelay({ fetcher: async (url, init) => { seen.push({ url: String(url), headers: new Headers(init?.headers), body: new TextDecoder().decode(init?.body as Uint8Array) }); return new Response('private upstream body', { status: 202 }); } });
  const origin = await listen(relay);
  try {
    const body = '{\n  "id": "WH-test", "resource": {"text": "café"}\n}';
    const response = await fetch(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: { ...signedHeaders, Authorization: 'must-not-forward', Cookie: 'must-not-forward', Origin: 'https://untrusted.example', 'X-Forwarded-Host': 'untrusted.example' }, body });
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { accepted: true });
    assert.equal(seen.length, 1); assert.equal(seen[0].url, 'http://127.0.0.1:3002' + PAYPAL_WEBHOOK_PATH); assert.equal(seen[0].body, body);
    for (const name of ['authorization', 'cookie', 'origin', 'x-forwarded-host']) assert.equal(seen[0].headers.has(name), false);
    assert.equal(seen[0].headers.get('paypal-transmission-sig'), 'test-signature');
  } finally { await close(relay); }
});

test('public relay cannot expose the app or alternate callback paths', async () => {
  let calls = 0; const relay = createWebhookRelay({ fetcher: async () => { calls++; return new Response('{}'); } }); const origin = await listen(relay);
  try {
    for (const [method, path] of [['GET', '/'], ['GET', PAYPAL_WEBHOOK_PATH], ['POST', '/api/paypal-sandbox'], ['POST', PAYPAL_WEBHOOK_PATH + '?admin=1'], ['OPTIONS', PAYPAL_WEBHOOK_PATH]]) {
      assert.equal((await fetch(origin + path, { method, ...(method === 'POST' ? { headers: signedHeaders, body: '{}' } : {}) })).status, 404);
    }
    assert.equal(calls, 0);
    assert.throws(() => createWebhookRelay({ appOrigin: 'https://remote.example' }), /loopback/);
    assert.throws(() => createWebhookRelay({ appOrigin: 'http://127.0.0.1:3002/other' }), /loopback/);
  } finally { await close(relay); }
});

test('relay rejects oversized, unsigned, compressed, empty and non-JSON requests before forwarding', async () => {
  let calls = 0; const relay = createWebhookRelay({ maxBytes: 32, fetcher: async () => { calls++; return new Response('{}'); } }); const origin = await listen(relay);
  try {
    const cases = [
      { headers: signedHeaders, body: 'x'.repeat(33), status: 413 },
      { headers: { 'Content-Type': 'application/json' }, body: '{}', status: 400 },
      { headers: { ...signedHeaders, 'Content-Encoding': 'gzip' }, body: '{}', status: 415 },
      { headers: { ...signedHeaders, 'Content-Type': 'text/plain' }, body: '{}', status: 415 },
      { headers: signedHeaders, body: '', status: 400 },
    ];
    for (const item of cases) assert.equal((await fetch(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: item.headers, body: item.body })).status, item.status);
    assert.equal(calls, 0);
  } finally { await close(relay); }
});

test('relay bounds concurrency and hides upstream errors', async () => {
  const entered = deferred(); const release = deferred();
  const relay = createWebhookRelay({ maxConcurrent: 1, fetcher: async () => { entered.resolve(); await release.promise; return new Response('private rejection details', { status: 403 }); } }); const origin = await listen(relay);
  try {
    const first = fetch(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: signedHeaders, body: '{}' }); await entered.promise;
    assert.equal((await fetch(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: signedHeaders, body: '{}' })).status, 503);
    release.resolve(); const response = await first; assert.equal(response.status, 403); assert.deepEqual(await response.json(), { accepted: false });
  } finally { release.resolve(); await close(relay); }
});

test('relay times out incomplete request bodies without contacting the app', async () => {
  let calls = 0; const relay = createWebhookRelay({ readTimeoutMs: 25, fetcher: async () => { calls++; return new Response('{}'); } }); const origin = await listen(relay);
  try {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: { ...signedHeaders, 'Content-Length': '5' } }, response => { response.resume(); resolve(response.statusCode); request.destroy(); });
      request.on('error', error => { if ((error as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(error); }); request.write('{');
    });
    assert.equal(status, 408); assert.equal(calls, 0);
  } finally { await close(relay); }
});

test('relay checks streamed size and rejects duplicate signature headers', async () => {
  let calls = 0; const relay = createWebhookRelay({ maxBytes: 32, fetcher: async () => { calls++; return new Response('{}'); } }); const origin = await listen(relay);
  try {
    const send = (headers: Record<string, string | string[]>, chunks: string[]) => new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject); for (const chunk of chunks) request.write(chunk); request.end();
    });
    assert.equal(await send(signedHeaders, ['x'.repeat(20), 'x'.repeat(20)]), 413);
    assert.equal(await send({ ...signedHeaders, 'paypal-transmission-id': ['delivery-one', 'delivery-two'] }, ['{}']), 400);
    assert.equal(calls, 0);
  } finally { await close(relay); }
});

test('upstream failures return a retryable generic response without credentials or redirect following', async () => {
  let calls = 0;
  const relay = createWebhookRelay({ fetcher: async (_url, init) => { calls++; assert.equal(init?.redirect, 'error'); throw new Error('sensitive upstream failure'); } }); const origin = await listen(relay);
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await fetch(origin + PAYPAL_WEBHOOK_PATH, { method: 'POST', headers: signedHeaders, body: '{}' });
      assert.equal(response.status, 503); assert.equal(response.headers.get('retry-after'), '2'); assert.deepEqual(await response.json(), { accepted: false });
    }
    assert.equal(calls, 2);
  } finally { await close(relay); }
});
