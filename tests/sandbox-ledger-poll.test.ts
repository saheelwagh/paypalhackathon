import test from 'node:test';
import assert from 'node:assert/strict';
import { createLedgerPoller } from '../src/lib/sandbox-ledger-poll';

function fixture() {
  let visible = true;
  const timers = new Map<number, () => void>(); let sequence = 0;
  const requests: { signal: AbortSignal; resolve(value: string): void; reject(error: unknown): void }[] = [];
  const values: string[] = []; const errors: unknown[] = [];
  const poller = createLedgerPoller({
    read: signal => new Promise<string>((resolve, reject) => requests.push({ signal, resolve, reject })),
    onValue: value => values.push(value), onError: error => errors.push(error), isVisible: () => visible,
    schedule: callback => { const id = ++sequence; timers.set(id, callback); return id; },
    cancel: handle => { timers.delete(handle as number); },
  });
  return { poller, requests, values, errors, timers, visible(value: boolean) { visible = value; poller.visibilityChanged(); }, tick() { const callbacks = [...timers.values()]; timers.clear(); callbacks.forEach(callback => callback()); } };
}
const settle = () => new Promise<void>(resolve => setImmediate(resolve));

test('ledger polling serializes focus/manual refresh and schedules the next read after completion', async () => {
  const f = fixture(); f.poller.start(); f.poller.refresh(); f.poller.refresh();
  assert.equal(f.requests.length, 1);
  f.requests[0].resolve('first'); await settle();
  assert.equal(f.requests.length, 2);
  f.requests[1].resolve('second'); await settle();
  assert.deepEqual(f.values, ['first', 'second']); assert.equal(f.timers.size, 1);
  f.tick(); assert.equal(f.requests.length, 3);
  f.poller.dispose(); f.requests[2].resolve('ignored'); await settle();
  assert.deepEqual(f.values, ['first', 'second']); assert.equal(f.timers.size, 0);
});

test('a pre-mutation read cannot roll back the mutation result, even when abort is ignored', async () => {
  const f = fixture(); f.poller.start();
  f.poller.suspend(); assert.equal(f.requests[0].signal.aborted, true);
  f.poller.resume(); assert.equal(f.requests.length, 1, 'no overlap with an unsettled aborted request');
  f.requests[0].resolve('old unpaid snapshot'); await settle();
  assert.deepEqual(f.values, []); assert.equal(f.requests.length, 2);
  f.requests[1].resolve('current paid snapshot'); await settle();
  assert.deepEqual(f.values, ['current paid snapshot']); f.poller.dispose();
});

test('hidden tabs stop polling and catch up when visible without promoting late responses', async () => {
  const f = fixture(); f.poller.start(); f.visible(false);
  assert.equal(f.requests[0].signal.aborted, true);
  f.requests[0].resolve('hidden late response'); await settle(); f.tick();
  assert.deepEqual(f.values, []); assert.equal(f.requests.length, 1);
  f.visible(true); assert.equal(f.requests.length, 2);
  f.requests[1].resolve('visible current response'); await settle();
  assert.deepEqual(f.values, ['visible current response']); f.poller.dispose();
});

test('read failures preserve the last value and retry on the normal bounded cadence', async () => {
  const f = fixture(); f.poller.start(); f.requests[0].resolve('known ledger'); await settle(); f.tick();
  f.requests[1].reject(new Error('offline')); await settle();
  assert.deepEqual(f.values, ['known ledger']); assert.equal(f.errors.length, 1);
  assert.equal(f.requests.length, 2); assert.equal(f.timers.size, 1);
  f.tick(); assert.equal(f.requests.length, 3);
  f.poller.dispose(); f.requests[2].reject(new Error('disposed')); await settle();
  assert.equal(f.errors.length, 1); assert.equal(f.timers.size, 0);
});
