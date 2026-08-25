import assert from 'node:assert/strict';
import test from 'node:test';

import {
  acceptedVoiceComposerDraft,
  clearVoiceScopeAfterProvenDeletion,
  createVoiceActivationGate,
  createVoiceHoldFence,
  guardedVoicePreflight,
  guardedVoiceRemove,
  voicePhaseCanCancelInteraction,
} from '../public/voice-ui-guards.js';

test('accepted cleanup clears only the exact already-sent composer text', () => {
  assert.deepEqual(acceptedVoiceComposerDraft({
    phase: 'accepted-cleanup-pending',
    bindingText: 'Where is Academic Registry?',
    composerDraft: 'Where is Academic Registry?',
  }), { shouldApply: true, draft: '' });
  assert.deepEqual(acceptedVoiceComposerDraft({
    phase: 'accepted-cleanup-pending',
    bindingText: 'Where is Academic Registry?',
    composerDraft: 'A new unrelated question',
  }), { shouldApply: false, draft: 'A new unrelated question' });
  assert.deepEqual(acceptedVoiceComposerDraft({
    phase: 'send-unconfirmed',
    bindingText: 'Where is Academic Registry?',
    composerDraft: 'Where is Academic Registry?',
  }), { shouldApply: false, draft: 'Where is Academic Registry?' });
});

test('synthetic click activation is deduped after pointer or keyboard handling but remains independently reachable', () => {
  let clock = 1_000;
  const gate = createVoiceActivationGate({ now: () => clock, dedupeMs: 750 });
  assert.equal(gate.shouldHandleClick(), true);
  gate.markDirectActivation();
  assert.equal(gate.shouldHandleClick(), false);
  clock = 1_750;
  assert.equal(gate.shouldHandleClick(), true);
  clock = 2_000;
  gate.markDirectActivation();
  clock = 3_000;
  gate.markDirectActivation();
  assert.equal(gate.shouldHandleClick(), false, 'pointerup/keyup refreshes the fence after a long hold');
});

test('generic lifecycle cancellation is limited to permission and live capture phases', () => {
  for (const phase of ['permission-checking', 'starting', 'recording']) {
    assert.equal(voicePhaseCanCancelInteraction(phase), true, phase);
  }
  for (const phase of [
    'ready', 'processing', 'binding', 'sending', 'send-unconfirmed',
    'send-rate-limited', 'accepted-cleanup-pending', 'transcription-retryable', 'error',
  ]) assert.equal(voicePhaseCanCancelInteraction(phase), false, phase);
});

test('a stale hold completion cannot clear ownership from a replacement runtime hold', () => {
  const fence = createVoiceHoldFence();
  const oldHold = fence.begin();
  assert.equal(fence.isCurrent(oldHold), true);
  fence.invalidate();
  const newHold = fence.begin();
  assert.equal(fence.isCurrent(oldHold), false);
  assert.equal(fence.clear(oldHold), false);
  assert.equal(fence.isCurrent(newHold), true);
  assert.equal(fence.clear(newHold), true);
  assert.equal(fence.isCurrent(newHold), false);
});

test('guarded preflight reports ready only for the same runtime with canonical permission state', async () => {
  const runtime = {
    controller: {
      preflightPermission: async () => ({ status: 'ready' }),
      snapshot: () => ({ permission: 'ready' }),
    },
  };
  assert.equal((await guardedVoicePreflight({ runtime, isCurrent: () => true })).state, 'ready');
  assert.equal((await guardedVoicePreflight({ runtime, isCurrent: () => false })).state, 'stale');
  runtime.controller.preflightPermission = async () => ({ state: 'stale' });
  assert.equal((await guardedVoicePreflight({ runtime, isCurrent: () => true })).state, 'stale');
});

test('guarded remove cannot restore an old transcript after scope or runtime replacement', async () => {
  const runtime = { controller: { remove: async () => ({ state: 'terminal' }) } };
  const current = await guardedVoiceRemove({
    runtime, isCurrent: () => true, preservedText: 'editable transcript', bindingText: null,
  });
  assert.deepEqual(current, { apply: true, draft: 'editable transcript', result: { state: 'terminal' } });
  const stale = await guardedVoiceRemove({ runtime, isCurrent: () => false, preservedText: 'old secret transcript' });
  assert.deepEqual(stale, { apply: false, result: { state: 'terminal' } });
  runtime.controller.remove = async () => ({ state: 'stale' });
  assert.equal((await guardedVoiceRemove({ runtime, isCurrent: () => true, preservedText: 'old' })).apply, false);
});

test('consumed removal clears only the exact already-attached voice text and preserves a new draft', async () => {
  const runtime = { controller: { remove: async () => ({ state: 'consumed' }) } };
  assert.equal((await guardedVoiceRemove({
    runtime,
    isCurrent: () => true,
    preservedText: 'Where is Academic Registry?',
    bindingText: 'Where is Academic Registry?',
  })).draft, '');
  assert.equal((await guardedVoiceRemove({
    runtime,
    isCurrent: () => true,
    preservedText: 'A new unrelated question',
    bindingText: 'Where is Academic Registry?',
  })).draft, 'A new unrelated question');
});

test('proven deletion clears the exact bound scope and never purges an unrelated active scope', async () => {
  const calls = [];
  const currentRuntime = {
    scope: 'scope-old',
    store: { clearScope: async (scope) => { calls.push(['clear', scope]); return 2; } },
  };
  assert.deepEqual(await clearVoiceScopeAfterProvenDeletion({
    scope: 'scope-old', runtime: currentRuntime, createStore: () => { throw new Error('not needed'); },
  }), { cleared: true, count: 2 });
  assert.deepEqual(calls, [['clear', 'scope-old']]);

  let disposed = 0;
  const unrelated = {
    readActiveScope: async () => ({ clientSessionScope: 'scope-new', scopeGeneration: 4 }),
    bindScope: async () => { throw new Error('must not bind old over new'); },
    clearScope: async () => { throw new Error('must not clear new'); },
    dispose: async () => { disposed += 1; },
  };
  assert.deepEqual(await clearVoiceScopeAfterProvenDeletion({
    scope: 'scope-old', runtime: null, createStore: () => unrelated,
  }), { cleared: true, count: 0 });
  assert.equal(disposed, 1);
});

test('a reopened store binds with exact observed metadata before clearing the proven old scope', async () => {
  const calls = [];
  const active = { clientSessionScope: 'scope-old', scopeGeneration: 7 };
  const store = {
    readActiveScope: async () => active,
    bindScope: async (scope, options) => { calls.push(['bind', scope, options]); },
    clearScope: async (scope) => { calls.push(['clear', scope]); return 1; },
    dispose: async () => { calls.push(['dispose']); },
  };
  assert.deepEqual(await clearVoiceScopeAfterProvenDeletion({
    scope: 'scope-old', runtime: null, createStore: () => store,
  }), { cleared: true, count: 1 });
  assert.deepEqual(calls, [
    ['bind', 'scope-old', { expectedActiveScope: active }],
    ['clear', 'scope-old'],
    ['dispose'],
  ]);
});

test('a reopened store with missing metadata binds from exact null before clearing proven deletion', async () => {
  const calls = [];
  const store = {
    readActiveScope: async () => null,
    bindScope: async (scope, options) => { calls.push(['bind', scope, options]); },
    clearScope: async (scope) => { calls.push(['clear', scope]); return 3; },
    dispose: async () => { calls.push(['dispose']); },
  };
  assert.deepEqual(await clearVoiceScopeAfterProvenDeletion({
    scope: 'scope-old', runtime: null, createStore: () => store,
  }), { cleared: true, count: 3 });
  assert.deepEqual(calls, [
    ['bind', 'scope-old', { expectedActiveScope: null }],
    ['clear', 'scope-old'],
    ['dispose'],
  ]);
});
