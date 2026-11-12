import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildDeskCommandContext, deskCommandContextSchema, interpretDemoCommand, validateDeskActions } from '../src/lib/desk-commands';
import { seed } from '../src/lib/domain';
import { loadScenario } from '../src/lib/scenarios';

test('desk context contains bounded synthetic summaries without emails, credentials, approval records or provider references', () => {
  const state = loadScenario('completed');
  state.clients[0].notes = 'private relationship notes';
  state.conversations[0].utterances[0].text = 'Email secret@example.test; api_key=should-not-leave. Open https://private.example/account?token=hidden';
  const context = buildDeskCommandContext(state, 'demo_acme', 'demo_animation');
  const serialized = JSON.stringify(context);
  for (const value of ['secret@example.test', 'should-not-leave', 'private.example', 'private relationship notes', state.clients[0].email, state.invoices[0].providerRef, 'approvals', 'recipient']) assert.equal(serialized.includes(value), false, value);
  assert.equal(context.mode, 'demo'); assert.equal(context.evidence[0].source, 'untrusted-demo-evidence');
  assert.equal(context.totals.paid, 125000);
  assert.equal(deskCommandContextSchema.safeParse({ ...context, mode: 'connected-sandbox' }).success, false);
  assert.equal(deskCommandContextSchema.safeParse({ ...context, credentials: 'hidden' }).success, false);
  assert.equal(deskCommandContextSchema.safeParse({ ...context, changes: [{ ...context.changes[0], projectId: 'demo_north' }] }).success, false);
});

test('desk actions reject business mutations, invented IDs and cross-project selections', () => {
  const context = buildDeskCommandContext(loadScenario('completed'), 'demo_acme', '');
  assert.throws(() => validateDeskActions(context, [{ type: 'invoice.send', id: context.invoices[0].id }]));
  assert.throws(() => validateDeskActions(context, [{ type: 'review', target: 'invoice', id: 'demo_missing' }]));
  assert.throws(() => validateDeskActions(context, [{ type: 'select-project', projectId: 'real_merchant' }]));
  assert.throws(() => validateDeskActions(context, [{ type: 'select-project', projectId: 'demo_north' }, { type: 'select-change', changeId: 'demo_animation' }]));
  assert.throws(() => validateDeskActions(context, [{ type: 'filter', filter: 'extra', approve: true }]));
});

test('demo command paraphrases produce only safe view plans without changing commercial records', () => {
  const state = loadScenario('funded'); const before = structuredClone(state);
  const cases = [
    ['Only show the additional work', { type: 'filter', filter: 'extra' }],
    ['Find requests that are not approved', { type: 'filter', filter: 'unapproved' }],
    ['What is already covered?', { type: 'filter', filter: 'included' }],
    ['Bring up payments awaiting payment', { type: 'filter', filter: 'pending' }],
    ['Put the options side by side', { type: 'layout', view: 'compare' }],
    ['How much have we collected?', { type: 'layout', view: 'money' }],
    ['Open the deposit invoice', { type: 'review', target: 'invoice', id: 'demo_seed_deposit' }],
    ['Inspect delivery', { type: 'review', target: 'delivery', id: 'demo_acme' }],
    ['Review this change', { type: 'review', target: 'change', id: 'demo_animation' }],
    ['Remember this workspace', { type: 'save' }],
    ['Restore default layout', { type: 'reset' }],
    ['Undo the last layout change', { type: 'undo' }],
  ] as const;
  for (const [message, action] of cases) {
    const result = interpretDemoCommand(state, 'demo_acme', 'demo_animation', message);
    assert.equal(result.provider, 'demo'); assert.ok(result.actions.some(candidate => JSON.stringify(candidate) === JSON.stringify(action)), message);
  }
  assert.deepEqual(state, before);
  assert.deepEqual(interpretDemoCommand(state, 'demo_acme', '', 'refund everyone and mark paid').actions, []);
  assert.deepEqual(interpretDemoCommand(state, 'demo_acme', '', 'make me a sandwich').actions, []);
});

test('demo command project switch uses the named project and empty workspaces remain recoverable', () => {
  const state = seed(); const switchResult = interpretDemoCommand(state, 'demo_acme', '', 'Show Northstar financial totals');
  assert.deepEqual(switchResult.actions[0], { type: 'select-project', projectId: 'demo_north' });
  assert.match(switchResult.message, /agreed \$0/);
  const empty = buildDeskCommandContext(seed(true), '', '');
  assert.equal(empty.projectId, ''); assert.equal(empty.projects.length, 0);
  assert.deepEqual(interpretDemoCommand(seed(true), '', '', 'Open delivery review').actions, [{ type: 'layout', view: 'review' }]);
});

test('the requested-changes dock suggestion hides baseline rows through the changes filter', () => {
  const state = loadScenario('funded'); const before = structuredClone(state);
  const result = interpretDemoCommand(state, 'demo_acme', '', 'Show requested changes');
  assert.ok(result.actions.some(action => action.type === 'filter' && action.filter === 'changes'));
  assert.deepEqual(state, before);
});

test('demo review honors an explicit target and does not substitute a selected change for a missing invoice', () => {
  const state = loadScenario('funded');
  const missing = interpretDemoCommand(state, 'demo_acme', 'demo_animation', 'Review the final invoice');
  assert.deepEqual(missing.actions, []);
  assert.match(missing.message, /No matching invoice/);
  const different = state.changes.find(change => change.projectId === 'demo_acme' && change.id !== 'demo_animation')!;
  const named = interpretDemoCommand(state, 'demo_acme', 'demo_animation', `Review ${different.title}`);
  assert.ok(named.actions.some(action => action.type === 'review' && action.id === different.id));
});
