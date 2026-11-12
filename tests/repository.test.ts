import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DemoWorkspaceRepository } from '../src/lib/demo-repository';
import { applyCommand, seed } from '../src/lib/domain';
import { loadScenario } from '../src/lib/scenarios';
function memoryStorage() { const data = new Map<string, string>(); return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); } }; }
function locks() { let tail = Promise.resolve(); return { request: (_name: string, callback: () => unknown) => { const next = tail.then(callback); tail = next.then(() => undefined, () => undefined); return next; } } as unknown as Pick<LockManager, 'request'>; }
test('two competing repositories reserve invoice coverage once under the shared lock contract', async () => { const storage = memoryStorage(); const manager = locks(); const a = new DemoWorkspaceRepository(storage, loadScenario('accepted-delivery'), manager); const b = new DemoWorkspaceRepository(storage, loadScenario('accepted-delivery'), manager); await a.replace(loadScenario('accepted-delivery')); const results = await Promise.allSettled([a.transact(s => applyCommand(s, { type: 'invoice.prepare', id: 'demo_final_a', projectId: 'demo_acme', data: { purpose: 'final' } })), b.transact(s => applyCommand(s, { type: 'invoice.prepare', id: 'demo_final_b', projectId: 'demo_acme', data: { purpose: 'final' } }))]); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1); assert.equal(a.read().invoices.filter(i => i.purpose === 'final').length, 1); assert.equal(b.read().invoices.filter(i => i.purpose === 'final').length, 1); });

test('reload reads the same synthetic state and malformed data is recoverable by explicit replacement', async () => { const storage = memoryStorage(); const a = new DemoWorkspaceRepository(storage); await a.replace(loadScenario('completed')); const b = new DemoWorkspaceRepository(storage); assert.equal(b.read().invoices.reduce((n,i) => n+i.paid,0), 125000); storage.setItem('business-desk:demo:v1','broken'); assert.throws(() => b.read()); await b.replace(seed(true)); assert.equal(a.read().clients.length, 0); });
test('storage failure does not claim successful persistence', async () => { const repo = new DemoWorkspaceRepository({ getItem: () => null, setItem: () => { throw new Error('Quota exceeded'); } }); await assert.rejects(repo.transact(s => applyCommand(s, { type: 'client.save', data: { name: 'Client', email: 'client@example.test', contact: 'Client' } })), /Quota/); assert.equal(repo.read().clients.length, 3); });

test('repository snapshots cannot be mutated outside a committed transaction', async () => {
  const initial = seed(); const storage = memoryStorage(); const repo = new DemoWorkspaceRepository(storage, initial);
  initial.clients.length = 0; const read = repo.read(); read.clients.length = 0;
  assert.equal(repo.read().clients.length, 3);
  await assert.rejects(repo.transact(s => { s.clients.length = 0; throw new Error('Rejected update'); }), /Rejected update/);
  assert.equal(repo.read().clients.length, 3);
  const next = seed(true); const returned = await repo.replace(next);
  next.clients.push(seed().clients[0]); returned.clients.push(seed().clients[0]);
  assert.equal(repo.read().clients.length, 0);
});
