import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceMessageController } from '../public/voice-message-controller.js';

const SCOPE = 'scope-production-v1';
const OTHER_SCOPE = 'scope-replacement';
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const MESSAGE_ID = '33333333-3333-4333-8333-333333333333';
const START_MS = Date.parse('2026-08-25T08:00:00.000Z');
const AUDIO = new Blob([Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' });

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function operation(overrides = {}) {
  return {
    clientUploadId: UPLOAD_ID,
    clientSessionScope: SCOPE,
    state: 'ready',
    transcript: 'Where is Academic Registry?',
    voiceDraftId: DRAFT_ID,
    messageBinding: null,
    createdAt: START_MS,
    expiresAt: START_MS + 60 * 60_000,
    ...overrides,
  };
}

function canonicalVoiceMessage(overrides = {}) {
  return {
    id: 'canonical-voice-message',
    clientMessageId: MESSAGE_ID,
    voiceDraftId: DRAFT_ID,
    role: 'user',
    kind: 'voice',
    sequence: 1,
    status: 'accepted',
    text: 'Where is Academic Registry?',
    ...overrides,
  };
}

function createCapture(overrides = {}) {
  const calls = [];
  let handle = overrides.handle;
  return {
    calls,
    setHandle(next) { handle = next; },
    async preflightPermission(input) {
      calls.push({ method: 'preflightPermission', input });
      if (overrides.preflightPermission) return overrides.preflightPermission(input);
      return { state: 'ready', permission: 'ready' };
    },
    begin() {
      calls.push({ method: 'begin' });
      if (overrides.begin) return overrides.begin();
      if (!handle) throw new Error('capture handle was not configured');
      return handle;
    },
    finish(reason) {
      calls.push({ method: 'finish', reason });
      if (overrides.finish) return overrides.finish(reason);
      return handle?.result;
    },
    cancel(reason) {
      calls.push({ method: 'cancel', reason });
      return overrides.cancel?.(reason) ?? { status: 'cancelled', reason };
    },
    dispose() {
      calls.push({ method: 'dispose' });
      return overrides.dispose?.();
    },
  };
}

function createStore({ operations = [], timeline = [], commitResult, releaseBinding } = {}) {
  const calls = [];
  const rows = new Map(operations.map((item) => [item.clientUploadId, { ...item }]));
  let activeScope = operations[0]
    ? { clientSessionScope: operations[0].clientSessionScope, scopeGeneration: 1 }
    : null;
  return {
    calls,
    rows,
    async readActiveScope() {
      calls.push({ method: 'readActiveScope' });
      return activeScope ? { ...activeScope } : null;
    },
    async bindScope(clientSessionScope, options) {
      calls.push({ method: 'bindScope', clientSessionScope, options });
      activeScope = { clientSessionScope, scopeGeneration: activeScope?.scopeGeneration ?? 1 };
      for (const [id, row] of rows) {
        if (row.clientSessionScope !== clientSessionScope) rows.delete(id);
      }
      return { purged: 0, expired: 0 };
    },
    async commitRecording(input) {
      calls.push({ method: 'commitRecording', input });
      timeline.push('store.commitRecording');
      const committed = commitResult ?? operation({
        clientSessionScope: input.clientSessionScope,
        state: 'queued',
        transcript: null,
        voiceDraftId: null,
        messageBinding: null,
        blob: input.audio,
        durationMs: input.durationMs,
      });
      rows.set(committed.clientUploadId, { ...committed });
      return { ...committed };
    },
    async listByScope(clientSessionScope) {
      calls.push({ method: 'listByScope', clientSessionScope });
      return [...rows.values()]
        .filter((row) => row.clientSessionScope === clientSessionScope)
        .sort((left, right) => left.createdAt - right.createdAt)
        .map((row) => ({ ...row }));
    },
    async get(clientUploadId) {
      calls.push({ method: 'get', clientUploadId });
      const row = rows.get(clientUploadId);
      return row ? { ...row } : undefined;
    },
    async bindMessage(input) {
      calls.push({ method: 'bindMessage', input });
      timeline.push('store.bindMessage');
      const row = rows.get(input.clientUploadId);
      if (!row || row.clientSessionScope !== input.clientSessionScope || row.voiceDraftId !== input.voiceDraftId) {
        return false;
      }
      if (row.messageBinding
        && (row.messageBinding.clientMessageId !== input.clientMessageId || row.messageBinding.text !== input.text)) {
        return false;
      }
      const bound = {
        ...row,
        messageBinding: { clientMessageId: input.clientMessageId, text: input.text },
      };
      rows.set(input.clientUploadId, bound);
      return { ...bound };
    },
    async releaseMessageBinding(input) {
      calls.push({ method: 'releaseMessageBinding', input });
      timeline.push('store.releaseMessageBinding');
      if (releaseBinding) return releaseBinding(input, rows);
      const row = rows.get(input.clientUploadId);
      if (!row
        || row.clientSessionScope !== input.clientSessionScope
        || row.voiceDraftId !== input.voiceDraftId
        || row.messageBinding?.clientMessageId !== input.clientMessageId
        || row.messageBinding?.text !== input.text) return false;
      const released = { ...row, messageBinding: null };
      rows.set(input.clientUploadId, released);
      return { ...released };
    },
    async consume(input) {
      calls.push({ method: 'consume', input });
      timeline.push('store.consume');
      const row = rows.get(input.clientUploadId);
      if (!row || row.clientSessionScope !== input.clientSessionScope) return false;
      rows.delete(input.clientUploadId);
      return true;
    },
  };
}

function createCoordinator({
  results = [],
  retryResults = [],
  cancelResult = { state: 'terminal', failureCode: 'VOICE_UPLOAD_CANCELLED' },
  timeline = [],
} = {}) {
  const calls = [];
  let disposed = false;
  return {
    calls,
    async runById(input) {
      calls.push({ method: 'runById', input });
      timeline.push('coordinator.runById');
      const next = results.shift() ?? { state: 'idle' };
      return typeof next === 'function' ? next(input) : next;
    },
    async cancel(input) {
      calls.push({ method: 'cancel', input });
      timeline.push('coordinator.cancel');
      return typeof cancelResult === 'function' ? cancelResult(input) : cancelResult;
    },
    async retry(input) {
      calls.push({ method: 'retry', input });
      timeline.push('coordinator.retry');
      const next = retryResults.shift() ?? { state: 'retryable', failureCode: 'VOICE_TRANSCRIPTION_FAILED' };
      return typeof next === 'function' ? next(input) : next;
    },
    dispose() {
      calls.push({ method: 'dispose' });
      disposed = true;
    },
    get disposed() { return disposed; },
  };
}

function createChat({ send = [], retry = [], messages = [], timeline = [] } = {}) {
  const calls = [];
  let currentMessages = [...messages];
  return {
    calls,
    setMessages(next) { currentMessages = [...next]; },
    snapshot() { return { messages: currentMessages.map((item) => ({ ...item })) }; },
    async sendMessage(input) {
      calls.push({ method: 'sendMessage', input });
      timeline.push('chat.sendMessage');
      const next = send.shift() ?? true;
      return typeof next === 'function' ? next(input) : await next;
    },
    async retryUnconfirmed(clientMessageId) {
      calls.push({ method: 'retryUnconfirmed', clientMessageId });
      timeline.push('chat.retryUnconfirmed');
      const next = retry.shift() ?? false;
      return typeof next === 'function' ? next(clientMessageId) : await next;
    },
  };
}

function controllerFor({ capture, store, coordinator, chat, onChange } = {}) {
  const timeline = [];
  return {
    timeline,
    capture: capture ?? createCapture(),
    store: store ?? createStore({ timeline }),
    coordinator: coordinator ?? createCoordinator({ timeline }),
    chat: chat ?? createChat({ timeline }),
    build() {
      return createVoiceMessageController({
        capture: this.capture,
        store: this.store,
        coordinator: this.coordinator,
        chat: this.chat,
        now: () => START_MS,
        onChange,
      });
    },
  };
}

async function readyController(context, { scope = SCOPE } = {}) {
  const controller = context.build();
  await controller.resume({ clientSessionScope: scope });
  return controller;
}

test('microphone permission preflight is impossible until the user explicitly confirms consent', async () => {
  const context = controllerFor();
  const controller = context.build();

  await assert.rejects(
    controller.preflightPermission(),
    (error) => error.code === 'VOICE_CONSENT_REQUIRED' && error.textSafe === true,
  );
  assert.equal(context.capture.calls.length, 0);
  assert.equal(controller.snapshot().consent, 'required');

  controller.confirmConsent();
  await controller.preflightPermission();

  assert.deepEqual(context.capture.calls, [{ method: 'preflightPermission', input: { consent: true } }]);
  assert.equal(controller.snapshot().consent, 'granted');
  assert.equal(controller.snapshot().permission, 'ready');
});

test('hold finish commits only canonical WAV durably before coordinator work and produces an editable draft without chat send', async () => {
  const started = deferred();
  const result = deferred();
  const timeline = [];
  const capture = createCapture({ handle: { started: started.promise, result: result.promise } });
  const store = createStore({ timeline });
  const coordinator = createCoordinator({
    timeline,
    results: [{ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Where is Academic Registry?', voiceDraftId: DRAFT_ID }],
  });
  const chat = createChat({ timeline });
  const controller = controllerFor({ capture, store, coordinator, chat }).build();
  await controller.resume({ clientSessionScope: SCOPE });
  controller.confirmConsent();
  await controller.preflightPermission();

  const hold = controller.beginHold();
  started.resolve({ status: 'recording', startedAt: START_MS });
  await hold.started;
  assert.equal(controller.snapshot().phase, 'recording');

  const finished = controller.finishHold();
  result.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 1_250, completionReason: 'release' });
  await finished;

  assert.deepEqual(timeline, ['store.commitRecording', 'coordinator.runById']);
  const commit = store.calls.find(({ method }) => method === 'commitRecording');
  assert.strictEqual(commit.input.audio, AUDIO);
  assert.equal(commit.input.durationMs, 1_250);
  assert.equal(commit.input.clientSessionScope, SCOPE);
  assert.deepEqual(coordinator.calls[0], {
    method: 'runById', input: { clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE },
  });
  assert.equal(chat.calls.length, 0, 'transcription readiness must never auto-send chat');
  assert.deepEqual(controller.snapshot().draft, {
    text: 'Where is Academic Registry?', voiceDraftId: DRAFT_ID,
  });
  assert.equal(controller.snapshot().phase, 'draft-ready');
});

test('capture auto-finish is processed once even if finishHold races the same result', async () => {
  const started = Promise.resolve({ status: 'recording', startedAt: START_MS });
  const result = deferred();
  const capture = createCapture({ handle: { started, result: result.promise } });
  const store = createStore();
  const coordinator = createCoordinator({
    results: [{ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Automatic stop text', voiceDraftId: DRAFT_ID }],
  });
  const controller = await readyController(controllerFor({ capture, store, coordinator }));
  controller.confirmConsent();
  await controller.preflightPermission();
  const hold = controller.beginHold();
  await hold.started;

  const release = controller.finishHold();
  result.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 55_000, completionReason: 'max-duration' });
  await Promise.all([hold.completion, release]);

  assert.equal(store.calls.filter(({ method }) => method === 'commitRecording').length, 1);
  assert.equal(coordinator.calls.filter(({ method }) => method === 'runById').length, 1);
  assert.equal(capture.calls.filter(({ method }) => method === 'finish').length, 1);
});

test('manual voice send binds caller identity first, sends the same normalized tuple, and consumes only canonical acceptance', async () => {
  const timeline = [];
  const ready = operation();
  const store = createStore({ operations: [ready], timeline });
  const chat = createChat({
    timeline,
    send: [() => {
      chat.setMessages([canonicalVoiceMessage({ text: 'Edited transcript' })]);
      return true;
    }],
  });
  const context = controllerFor({ store, chat, coordinator: createCoordinator({ timeline }) });
  const controller = await readyController(context);
  controller.setDraft('  Edited transcript  \n');

  assert.equal(await controller.sendDraft({ clientMessageId: MESSAGE_ID }), true);

  assert.deepEqual(timeline, ['store.bindMessage', 'chat.sendMessage', 'store.consume']);
  assert.deepEqual(store.calls.find(({ method }) => method === 'bindMessage').input, {
    clientUploadId: UPLOAD_ID,
    clientSessionScope: SCOPE,
    voiceDraftId: DRAFT_ID,
    clientMessageId: MESSAGE_ID,
    text: 'Edited transcript',
    nowMs: START_MS,
  });
  assert.deepEqual(chat.calls[0].input, {
    clientMessageId: MESSAGE_ID,
    voiceDraftId: DRAFT_ID,
    text: 'Edited transcript',
  });
  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().draft, null);
});

test('ambiguous send keeps the exact durable binding and retry delegates only to chat retryUnconfirmed', async () => {
  const networkError = new Error('raw network diagnostics must not leak');
  const store = createStore({ operations: [operation()] });
  const chat = createChat({ send: [Promise.reject(networkError)], retry: [true] });
  const controller = await readyController(controllerFor({ store, chat }));

  await assert.rejects(
    controller.sendDraft({ clientMessageId: MESSAGE_ID }),
    (error) => error.code === 'VOICE_SEND_NOT_CONFIRMED'
      && error.textSafe === true
      && !error.message.includes('raw network'),
  );
  assert.deepEqual(store.rows.get(UPLOAD_ID).messageBinding, {
    clientMessageId: MESSAGE_ID,
    text: 'Where is Academic Registry?',
  });
  assert.equal(controller.snapshot().phase, 'send-unconfirmed');
  assert.equal(store.calls.some(({ method }) => method === 'consume'), false);

  chat.setMessages([canonicalVoiceMessage()]);
  assert.equal(await controller.retrySend(), true);

  assert.deepEqual(chat.calls.find(({ method }) => method === 'retryUnconfirmed'), {
    method: 'retryUnconfirmed', clientMessageId: MESSAGE_ID,
  });
  assert.equal(store.calls.filter(({ method }) => method === 'bindMessage').length, 1, 'retry never rebinds');
  assert.equal(store.rows.has(UPLOAD_ID), false);
});

test('429 keeps the same voice binding and exposes a safe rate-limit state without consuming', async () => {
  const rateLimit = new Error('provider internals');
  rateLimit.code = 'RATE_LIMITED';
  rateLimit.status = 429;
  rateLimit.retryAfter = '10';
  const store = createStore({ operations: [operation()] });
  const chat = createChat({ send: [Promise.reject(rateLimit)] });
  const controller = await readyController(controllerFor({ store, chat }));

  await assert.rejects(
    controller.sendDraft({ clientMessageId: MESSAGE_ID }),
    (error) => error.code === 'RATE_LIMITED' && error.textSafe === true,
  );

  assert.equal(controller.snapshot().phase, 'send-rate-limited');
  assert.equal(controller.snapshot().error.copy, 'Please wait before retrying this voice message.');
  assert.deepEqual(controller.snapshot().binding, {
    clientMessageId: MESSAGE_ID,
    text: 'Where is Academic Registry?',
  });
  assert.deepEqual(store.rows.get(UPLOAD_ID).messageBinding, controller.snapshot().binding);
  assert.equal(store.calls.some(({ method }) => method === 'consume'), false);
});

test('explicit rejected send releases only its exact durable binding before coordinated removal', async () => {
  const rejected = Object.assign(new Error('private validation diagnostics'), {
    code: 'INVALID_REQUEST',
    status: 400,
  });
  const timeline = [];
  const store = createStore({ operations: [operation()], timeline });
  const coordinator = createCoordinator({ timeline });
  const chat = createChat({ send: [Promise.reject(rejected)], timeline });
  const controller = await readyController(controllerFor({ store, coordinator, chat }));

  await assert.rejects(
    controller.sendDraft({ clientMessageId: MESSAGE_ID }),
    (error) => error.code === 'VOICE_SEND_REJECTED' && error.textSafe === true,
  );
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(controller.snapshot().error.code, 'VOICE_SEND_REJECTED');

  const result = await controller.remove();

  assert.equal(result.state, 'terminal');
  assert.deepEqual(store.calls.find(({ method }) => method === 'releaseMessageBinding').input, {
    clientUploadId: UPLOAD_ID,
    clientSessionScope: SCOPE,
    voiceDraftId: DRAFT_ID,
    clientMessageId: MESSAGE_ID,
    text: 'Where is Academic Registry?',
    nowMs: START_MS,
  });
  assert.ok(
    timeline.indexOf('store.releaseMessageBinding') < timeline.indexOf('coordinator.cancel'),
    'the local exact binding must be released before remote cancellation begins',
  );
  assert.equal(store.rows.get(UPLOAD_ID).messageBinding, null);
  assert.equal(chat.calls.filter(({ method }) => method !== 'sendMessage').length, 0);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().draft, null);
});

test('explicit rejected removal fails closed when the exact binding cannot be released', async () => {
  const rejected = Object.assign(new Error('private authorization diagnostics'), {
    code: 'FORBIDDEN',
    status: 403,
  });
  const store = createStore({
    operations: [operation()],
    releaseBinding: async () => false,
  });
  const coordinator = createCoordinator();
  const chat = createChat({ send: [Promise.reject(rejected)] });
  const controller = await readyController(controllerFor({ store, coordinator, chat }));
  await assert.rejects(controller.sendDraft({ clientMessageId: MESSAGE_ID }));

  await assert.rejects(
    controller.remove(),
    (error) => error.code === 'VOICE_REMOVE_BLOCKED' && error.textSafe === true,
  );

  assert.equal(coordinator.calls.some(({ method }) => method === 'cancel'), false);
  assert.deepEqual(controller.snapshot().binding, {
    clientMessageId: MESSAGE_ID,
    text: 'Where is Academic Registry?',
  });
});

test('scope fence during exact rejected release prevents late remote cancel and state mutation', async () => {
  const rejected = Object.assign(new Error('private validation diagnostics'), {
    code: 'INVALID_REQUEST',
    status: 400,
  });
  const releaseStarted = deferred();
  const release = deferred();
  const store = createStore({
    operations: [operation()],
    releaseBinding: async (_input, rows) => {
      releaseStarted.resolve();
      const result = await release.promise;
      if (result) rows.set(UPLOAD_ID, { ...rows.get(UPLOAD_ID), messageBinding: null });
      return result;
    },
  });
  const coordinator = createCoordinator();
  const chat = createChat({ send: [Promise.reject(rejected)] });
  const controller = await readyController(controllerFor({ store, coordinator, chat }));
  await assert.rejects(controller.sendDraft({ clientMessageId: MESSAGE_ID }));

  const removing = controller.remove();
  const started = await Promise.race([
    releaseStarted.promise.then(() => true),
    new Promise((resolve) => setImmediate(() => resolve(false))),
  ]);
  assert.equal(started, true, 'remove must await exact binding release');
  controller.cancel('hidden');
  release.resolve({ ...store.rows.get(UPLOAD_ID), messageBinding: null });

  assert.deepEqual(await removing, { state: 'stale' });
  assert.equal(coordinator.calls.some(({ method }) => method === 'cancel'), false);
  assert.equal(controller.snapshot().phase, 'suspended');
});

test('canonical reconciliation ignores optimistic rows and consumes only durable accepted voice identity', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  const controller = await readyController(controllerFor({ store }));

  assert.equal(await controller.reconcileChatSnapshot({
    messages: [canonicalVoiceMessage({ sequence: undefined, sendState: 'unconfirmed' })],
  }), false);
  assert.equal(store.rows.has(UPLOAD_ID), true);

  assert.equal(await controller.reconcileChatSnapshot({
    messages: [canonicalVoiceMessage({ status: 'failed' })],
  }), true, 'a canonical failed turn still proves the user voice message was accepted');
  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().draft, null);
});

test('Remove always coordinates remote cancellation, clears local presentation, and never sends chat', async () => {
  const store = createStore({ operations: [operation()] });
  const coordinator = createCoordinator();
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));

  const result = await controller.remove();

  assert.deepEqual(result, { state: 'terminal', failureCode: 'VOICE_UPLOAD_CANCELLED' });
  assert.deepEqual(coordinator.calls[0], {
    method: 'cancel', input: { clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE },
  });
  assert.equal(store.calls.some(({ method }) => method === 'consume'), false);
  assert.equal(chat.calls.length, 0);
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().phase, 'ready');
});

test('Remove accepts attached-conflict consumption from coordinator without a second local consume', async () => {
  const store = createStore({ operations: [operation()] });
  const coordinator = createCoordinator({
    cancelResult: { state: 'consumed', failureCode: 'VOICE_DRAFT_ALREADY_ATTACHED' },
  });
  const controller = await readyController(controllerFor({ store, coordinator }));

  await controller.remove();

  assert.equal(coordinator.calls.filter(({ method }) => method === 'cancel').length, 1);
  assert.equal(store.calls.some(({ method }) => method === 'consume'), false);
  assert.equal(controller.snapshot().phase, 'ready');
});

test('resume binds the authoritative scope and restores ready or pending operations without auto-send', async () => {
  const readyStore = createStore({ operations: [operation()] });
  const readyChat = createChat();
  const readyContext = controllerFor({ store: readyStore, chat: readyChat });
  const restoredReadyController = await readyController(readyContext);

  assert.deepEqual(readyStore.calls.slice(0, 3), [
    { method: 'readActiveScope' },
    { method: 'bindScope', clientSessionScope: SCOPE, options: { expectedActiveScope: SCOPE, nowMs: START_MS } },
    { method: 'listByScope', clientSessionScope: SCOPE },
  ]);
  assert.deepEqual(restoredReadyController.snapshot().draft, {
    text: 'Where is Academic Registry?', voiceDraftId: DRAFT_ID,
  });
  assert.equal(readyChat.calls.length, 0);

  const pending = operation({ state: 'queued', transcript: null, voiceDraftId: null });
  const pendingStore = createStore({ operations: [pending] });
  const pendingCoordinator = createCoordinator({
    results: [{ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Recovered transcript', voiceDraftId: DRAFT_ID }],
  });
  const pendingChat = createChat();
  const restoredPendingController = await readyController(controllerFor({
    store: pendingStore, coordinator: pendingCoordinator, chat: pendingChat,
  }));

  assert.equal(pendingCoordinator.calls[0].method, 'runById');
  assert.deepEqual(restoredPendingController.snapshot().draft, {
    text: 'Recovered transcript', voiceDraftId: DRAFT_ID,
  });
  assert.equal(pendingChat.calls.length, 0);
});

test('escape and pointercancel share the idempotent capture cancel seam and fence late WAV completion', async () => {
  for (const reason of ['escape', 'pointercancel']) {
    const result = deferred();
    const capture = createCapture({
      handle: { started: Promise.resolve({ status: 'recording' }), result: result.promise },
    });
    const store = createStore();
    const controller = await readyController(controllerFor({ capture, store }));
    controller.confirmConsent();
    await controller.preflightPermission();
    const hold = controller.beginHold();
    await hold.started;

    assert.equal(controller.cancel(reason).status, 'cancelled');
    result.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 500 });
    await hold.completion;

    assert.equal(capture.calls.some((call) => call.method === 'cancel' && call.reason === reason), true, reason);
    assert.equal(store.calls.some(({ method }) => method === 'commitRecording'), false, reason);
    assert.equal(controller.snapshot().phase, 'ready', reason);
  }
});

test('hidden and pagehide stop recording and upload work, preserve durable recovery, and fence late results', async () => {
  for (const reason of ['hidden', 'pagehide']) {
    const coordinatorResult = deferred();
    const captureResult = deferred();
    const capture = createCapture({
      handle: { started: Promise.resolve({ status: 'recording' }), result: captureResult.promise },
    });
    const store = createStore();
    const coordinator = createCoordinator({ results: [() => coordinatorResult.promise] });
    const controller = await readyController(controllerFor({ capture, store, coordinator }));
    controller.confirmConsent();
    await controller.preflightPermission();
    const hold = controller.beginHold();
    await hold.started;
    captureResult.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 900 });
    while (coordinator.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    controller.cancel(reason);
    assert.equal(coordinator.disposed, true, reason);
    assert.equal(capture.calls.some((call) => call.method === 'cancel' && call.reason === reason), true, reason);
    assert.equal(store.rows.has(UPLOAD_ID), true, 'durable operation remains for recovery');

    coordinatorResult.resolve({ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Late transcript', voiceDraftId: DRAFT_ID });
    await hold.completion;
    assert.equal(controller.snapshot().phase, 'suspended', reason);
    assert.equal(controller.snapshot().draft, null, reason);
  }
});

test('dispose fences pending permission and capture completions and releases both injected lifecycles', async () => {
  const permission = deferred();
  const capture = createCapture({ preflightPermission: () => permission.promise });
  const store = createStore();
  const coordinator = createCoordinator();
  const controller = await readyController(controllerFor({ capture, store, coordinator }));
  controller.confirmConsent();
  const preflight = controller.preflightPermission();

  controller.dispose();
  permission.resolve({ state: 'ready', permission: 'ready' });
  await preflight;

  assert.equal(capture.calls.some(({ method }) => method === 'dispose'), true);
  assert.equal(coordinator.disposed, true);
  assert.equal(controller.snapshot().phase, 'disposed');
  assert.equal(controller.snapshot().permission, 'unknown');
});

test('scope replacement fences an older resume completion and never exposes its transcript in the new scope', async () => {
  const oldList = deferred();
  const calls = [];
  let listCalls = 0;
  const store = {
    async readActiveScope() { return { clientSessionScope: SCOPE, scopeGeneration: 1 }; },
    async bindScope(clientSessionScope, options) {
      calls.push({ method: 'bindScope', clientSessionScope, options });
      return { purged: 0, expired: 0 };
    },
    async listByScope(clientSessionScope) {
      listCalls += 1;
      if (listCalls === 1) return oldList.promise;
      return clientSessionScope === OTHER_SCOPE ? [] : [operation()];
    },
    async commitRecording() { throw new Error('not expected'); },
    async get() { return undefined; },
    async bindMessage() { return false; },
    async releaseMessageBinding() { return false; },
    async consume() { return false; },
  };
  const coordinator = createCoordinator();
  const controller = controllerFor({ store, coordinator }).build();
  const oldResume = controller.resume({ clientSessionScope: SCOPE });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await controller.resume({ clientSessionScope: OTHER_SCOPE });

  oldList.resolve([operation()]);
  await oldResume;

  assert.equal(controller.snapshot().clientSessionScope, OTHER_SCOPE);
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().phase, 'suspended');
  assert.equal(calls.some((call) => call.clientSessionScope === OTHER_SCOPE), true);
});

test('snapshot and notifications are immutable copies and unsafe dependency errors become fixed safe copy', async () => {
  const snapshots = [];
  const capture = createCapture({
    preflightPermission: async () => { throw new Error('device label and private diagnostic'); },
  });
  const context = controllerFor({ capture, onChange: (value) => snapshots.push(value) });
  const controller = await readyController(context);
  controller.confirmConsent();

  await assert.rejects(
    controller.preflightPermission(),
    (error) => error.code === 'VOICE_PERMISSION_FAILED'
      && error.textSafe === true
      && error.message === 'Microphone access is blocked. Allow it in your browser or device settings, then retry—or continue by typing.',
  );

  const snapshot = controller.snapshot();
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.error), true);
  assert.equal(snapshot.error.copy.includes('private diagnostic'), false);
  assert.throws(() => { snapshot.phase = 'tampered'; }, TypeError);
  assert.equal(controller.snapshot().phase, 'error');
  assert.equal(snapshots.every((value) => Object.isFrozen(value)), true);
});

test('hidden fences a pending consented preflight so a late permission result cannot reactivate voice', async () => {
  const permission = deferred();
  const capture = createCapture({ preflightPermission: () => permission.promise });
  const coordinator = createCoordinator();
  const controller = await readyController(controllerFor({ capture, coordinator }));
  controller.confirmConsent();
  const checking = controller.preflightPermission();

  controller.cancel('hidden');
  permission.resolve({ state: 'ready', permission: 'ready' });
  assert.deepEqual(await checking, { state: 'stale' });

  assert.equal(controller.snapshot().phase, 'suspended');
  assert.equal(controller.snapshot().permission, 'unknown');
  assert.equal(coordinator.disposed, true);
});

test('escape during pending preflight stays permission-safe instead of exposing a ready record control', async () => {
  const permission = deferred();
  const capture = createCapture({ preflightPermission: () => permission.promise });
  const controller = await readyController(controllerFor({ capture }));
  controller.confirmConsent();
  const checking = controller.preflightPermission();

  controller.cancel('escape');
  permission.resolve({ state: 'ready', permission: 'ready' });
  await checking;

  assert.equal(controller.snapshot().permission, 'unknown');
  assert.equal(controller.snapshot().phase, 'idle');
});

test('late durable commit after pagehide is preserved for recovery but cannot start coordinator transport', async () => {
  const result = deferred();
  const commit = deferred();
  const capture = createCapture({
    handle: { started: Promise.resolve({ status: 'recording' }), result: result.promise },
  });
  const baseStore = createStore();
  baseStore.commitRecording = async (input) => {
    baseStore.calls.push({ method: 'commitRecording', input });
    const saved = await commit.promise;
    baseStore.rows.set(saved.clientUploadId, { ...saved });
    return saved;
  };
  const coordinator = createCoordinator();
  const controller = await readyController(controllerFor({ capture, store: baseStore, coordinator }));
  controller.confirmConsent();
  await controller.preflightPermission();
  const hold = controller.beginHold();
  await hold.started;
  result.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 750 });
  while (!baseStore.calls.some(({ method }) => method === 'commitRecording')) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  controller.cancel('pagehide');
  commit.resolve(operation({ state: 'queued', transcript: null, voiceDraftId: null, blob: AUDIO }));
  assert.deepEqual(await hold.completion, { state: 'stale' });

  assert.equal(baseStore.rows.has(UPLOAD_ID), true);
  assert.equal(coordinator.calls.some(({ method }) => method === 'runById'), false);
  assert.equal(controller.snapshot().phase, 'suspended');
});

test('late bind completion after hidden cannot POST chat while preserving the exact durable binding', async () => {
  const bind = deferred();
  const baseStore = createStore({ operations: [operation()] });
  baseStore.bindMessage = async (input) => {
    baseStore.calls.push({ method: 'bindMessage', input });
    const bound = await bind.promise;
    baseStore.rows.set(UPLOAD_ID, { ...baseStore.rows.get(UPLOAD_ID), messageBinding: bound.messageBinding });
    return bound;
  };
  const chat = createChat();
  const controller = await readyController(controllerFor({ store: baseStore, chat }));
  const sending = controller.sendDraft({ clientMessageId: MESSAGE_ID });
  await new Promise((resolve) => setTimeout(resolve, 0));

  controller.cancel('hidden');
  bind.resolve(operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } }));
  assert.equal(await sending, false);

  assert.equal(chat.calls.length, 0);
  assert.deepEqual(baseStore.rows.get(UPLOAD_ID).messageBinding, {
    clientMessageId: MESSAGE_ID,
    text: 'Where is Academic Registry?',
  });
  assert.equal(controller.snapshot().phase, 'suspended');
});

test('coordinator ready identity mismatch fails closed and never exposes the foreign transcript', async () => {
  const foreignUploadId = '44444444-4444-4444-8444-444444444444';
  const result = deferred();
  const capture = createCapture({
    handle: { started: Promise.resolve({ status: 'recording' }), result: result.promise },
  });
  const coordinator = createCoordinator({
    results: [{
      state: 'ready', clientUploadId: foreignUploadId, transcript: 'Foreign transcript', voiceDraftId: DRAFT_ID,
    }],
  });
  const controller = await readyController(controllerFor({ capture, coordinator }));
  controller.confirmConsent();
  await controller.preflightPermission();
  const hold = controller.beginHold();
  await hold.started;
  result.resolve({ status: 'ready', audio: AUDIO, mimeType: 'audio/wav', durationMs: 1_000 });

  await assert.rejects(
    hold.completion,
    (error) => error.code === 'VOICE_TRANSCRIPTION_FAILED' && error.textSafe === true,
  );
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().operation.clientUploadId, UPLOAD_ID);
});

test('resume of an exact bound draft consumes it only when canonical history proves acceptance', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  const chat = createChat({ messages: [canonicalVoiceMessage()] });
  const controller = await readyController(controllerFor({ store, chat }));

  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().phase, 'ready');
});

test('Remove cannot erase a bound ambiguous voice identity when coordinator reports idle', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  const coordinator = createCoordinator({ cancelResult: { state: 'idle' } });
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));

  await assert.rejects(
    controller.remove(),
    (error) => error.code === 'VOICE_REMOVE_BLOCKED' && error.textSafe === true,
  );

  assert.equal(store.rows.has(UPLOAD_ID), true);
  assert.deepEqual(controller.snapshot().binding, bound.messageBinding);
  assert.equal(store.calls.some(({ method }) => method === 'releaseMessageBinding'), false);
  assert.equal(chat.calls.length, 0);
});

test('a scope replacement disposes the old coordinator and fences its late ready result', async () => {
  const coordinatorResult = deferred();
  const pending = operation({ state: 'queued', transcript: null, voiceDraftId: null });
  let currentScope = SCOPE;
  const store = {
    async readActiveScope() { return { clientSessionScope: currentScope, scopeGeneration: 1 }; },
    async bindScope(clientSessionScope) { currentScope = clientSessionScope; return { purged: 0, expired: 0 }; },
    async listByScope(clientSessionScope) { return clientSessionScope === SCOPE ? [pending] : []; },
    async commitRecording() { throw new Error('not expected'); },
    async get() { return undefined; },
    async bindMessage() { return false; },
    async releaseMessageBinding() { return false; },
    async consume() { return false; },
  };
  const coordinator = createCoordinator({ results: [() => coordinatorResult.promise] });
  const controller = controllerFor({ store, coordinator }).build();
  const oldResume = controller.resume({ clientSessionScope: SCOPE });
  while (!coordinator.calls.some(({ method }) => method === 'runById')) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  await controller.resume({ clientSessionScope: OTHER_SCOPE });
  coordinatorResult.resolve({ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Old private text', voiceDraftId: DRAFT_ID });
  await oldResume;

  assert.equal(coordinator.disposed, true);
  assert.equal(controller.snapshot().clientSessionScope, OTHER_SCOPE);
  assert.equal(controller.snapshot().draft, null);
});

test('snapshots never expose the canonical WAV Blob and dispose is idempotent', async () => {
  const capture = createCapture();
  const coordinator = createCoordinator();
  const controller = await readyController(controllerFor({ capture, coordinator }));

  const serialized = JSON.stringify(controller.snapshot());
  assert.equal(serialized.includes('blob'), false);
  assert.equal(serialized.includes('audio'), false);

  controller.dispose();
  controller.dispose();
  assert.equal(capture.calls.filter(({ method }) => method === 'dispose').length, 1);
  assert.equal(coordinator.calls.filter(({ method }) => method === 'dispose').length, 1);
});

test('permission preflight accepts the exact voice-capture success contract with status ready', async () => {
  const capture = createCapture({
    preflightPermission: async () => ({ status: 'ready', mimeType: 'audio/mp4' }),
  });
  const controller = await readyController(controllerFor({ capture }));
  controller.confirmConsent();

  assert.deepEqual(await controller.preflightPermission(), { status: 'ready', mimeType: 'audio/mp4' });
  assert.equal(controller.snapshot().permission, 'ready');
  assert.equal(controller.snapshot().phase, 'ready');
});

test('fire-and-forget capture cancel and disposal observe asynchronous rejection without leaking it', async () => {
  const capture = createCapture({
    cancel: () => Promise.reject(new Error('async cancel failure')),
    dispose: () => Promise.reject(new Error('async dispose failure')),
  });
  const coordinator = createCoordinator();
  const controller = await readyController(controllerFor({ capture, coordinator }));

  assert.doesNotThrow(() => controller.cancel('escape'));
  assert.doesNotThrow(() => controller.dispose());
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(controller.snapshot().phase, 'disposed');
});

test('parallel chat canonical notification cannot be overwritten as unconfirmed when sendMessage resolves later', async () => {
  const store = createStore({ operations: [operation()] });
  let controller;
  const chat = createChat({
    send: [async () => {
      chat.setMessages([canonicalVoiceMessage()]);
      assert.equal(await controller.reconcileChatSnapshot(chat.snapshot()), true);
      return true;
    }],
  });
  controller = await readyController(controllerFor({ store, chat }));

  assert.equal(await controller.sendDraft({ clientMessageId: MESSAGE_ID }), true);

  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().binding, null);
  assert.equal(controller.snapshot().error, null);
});

test('resume displays the exact bound edited text and prevents edits that would misrepresent retry identity', async () => {
  const boundText = 'Edited exact text sent before the response was lost';
  const bound = operation({
    transcript: 'Original automatic transcript',
    messageBinding: { clientMessageId: MESSAGE_ID, text: boundText },
  });
  const store = createStore({ operations: [bound] });
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, chat }));

  assert.deepEqual(controller.snapshot().draft, { text: boundText, voiceDraftId: DRAFT_ID });
  assert.deepEqual(controller.snapshot().binding, { clientMessageId: MESSAGE_ID, text: boundText });
  assert.throws(
    () => controller.setDraft('Different text must not appear on exact-ID retry'),
    (error) => error.code === 'VOICE_MESSAGE_ALREADY_BOUND' && error.textSafe === true,
  );
  assert.equal(controller.snapshot().draft.text, boundText);
});

test('reload retry falls back to chat send only after retryUnconfirmed strictly proves no optimistic row', async () => {
  const boundText = 'Exact durable text from the interrupted bind-to-send window';
  const bound = operation({
    transcript: 'Older automatic transcript',
    messageBinding: { clientMessageId: MESSAGE_ID, text: boundText },
  });
  const store = createStore({ operations: [bound] });
  const timeline = [];
  const chat = createChat({
    timeline,
    retry: [false],
    send: [(input) => {
      chat.setMessages([canonicalVoiceMessage({ text: input.text })]);
      return true;
    }],
  });
  const controller = await readyController(controllerFor({ store, chat }));

  assert.equal(await controller.retrySend(), true);

  assert.deepEqual(chat.calls, [
    { method: 'retryUnconfirmed', clientMessageId: MESSAGE_ID },
    {
      method: 'sendMessage',
      input: { clientMessageId: MESSAGE_ID, voiceDraftId: DRAFT_ID, text: boundText },
    },
  ]);
  assert.equal(store.calls.some(({ method }) => method === 'bindMessage'), false);
  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().phase, 'ready');
});

test('retryUnconfirmed rejection never falls back to chat send and keeps the exact durable binding', async () => {
  for (const failure of [
    Object.assign(new Error('rate limit internals'), { code: 'RATE_LIMITED', status: 429 }),
    new Error('ambiguous network internals'),
  ]) {
    const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
    const store = createStore({ operations: [bound] });
    const chat = createChat({ retry: [Promise.reject(failure)] });
    const controller = await readyController(controllerFor({ store, chat }));

    await assert.rejects(
      controller.retrySend(),
      (error) => error.textSafe === true
        && error.code === (failure.status === 429 ? 'RATE_LIMITED' : 'VOICE_SEND_NOT_CONFIRMED'),
    );

    assert.equal(chat.calls.filter(({ method }) => method === 'sendMessage').length, 0);
    assert.deepEqual(store.rows.get(UPLOAD_ID).messageBinding, bound.messageBinding);
    assert.deepEqual(controller.snapshot().binding, bound.messageBinding);
  }
});

test('canonical acceptance cleanup failure exposes fixed safe copy and never offers another send', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  store.consume = async (input) => {
    store.calls.push({ method: 'consume', input });
    throw new Error('private IndexedDB quota and device path');
  };
  const controller = await readyController(controllerFor({ store }));

  await assert.rejects(
    controller.reconcileChatSnapshot({ messages: [canonicalVoiceMessage()] }),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED'
      && error.textSafe === true
      && !error.message.includes('IndexedDB'),
  );

  assert.equal(controller.snapshot().phase, 'accepted-cleanup-pending');
  assert.equal(controller.snapshot().error.copy, 'Your message was accepted. Local voice-draft cleanup will retry after refresh.');
  await assert.rejects(
    controller.retrySend(),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED' && error.textSafe === true,
  );
});

test('retryAcceptedCleanup retries only local consume and clears accepted presentation on success', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  const originalConsume = store.consume.bind(store);
  let failCleanup = true;
  store.consume = async (input) => {
    if (failCleanup) {
      store.calls.push({ method: 'consume', input });
      throw new Error('private IndexedDB cleanup diagnostics');
    }
    return originalConsume(input);
  };
  const coordinator = createCoordinator();
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));
  chat.setMessages([canonicalVoiceMessage()]);
  await assert.rejects(
    controller.reconcileChatSnapshot(chat.snapshot()),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED',
  );
  failCleanup = false;

  assert.equal(await controller.retryAcceptedCleanup(), true);

  assert.equal(store.rows.has(UPLOAD_ID), false);
  assert.equal(controller.snapshot().phase, 'ready');
  assert.equal(controller.snapshot().draft, null);
  assert.equal(controller.snapshot().binding, null);
  assert.equal(chat.calls.length, 0);
  assert.equal(coordinator.calls.length, 0);
});

test('failed accepted cleanup retry preserves accepted truth and exact immutable presentation', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  store.consume = async (input) => {
    store.calls.push({ method: 'consume', input });
    throw new Error('private cleanup diagnostics');
  };
  const coordinator = createCoordinator();
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));
  chat.setMessages([canonicalVoiceMessage()]);
  await assert.rejects(controller.reconcileChatSnapshot(chat.snapshot()));
  const before = controller.snapshot();

  await assert.rejects(
    controller.retryAcceptedCleanup(),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED'
      && error.textSafe === true
      && !error.message.includes('private cleanup'),
  );

  assert.equal(controller.snapshot().phase, 'accepted-cleanup-pending');
  assert.deepEqual(controller.snapshot().operation, before.operation);
  assert.deepEqual(controller.snapshot().draft, before.draft);
  assert.deepEqual(controller.snapshot().binding, before.binding);
  assert.equal(Object.isFrozen(controller.snapshot()), true);
  assert.equal(chat.calls.length, 0);
  assert.equal(coordinator.calls.length, 0);
});

test('dispose fences a late accepted cleanup retry without reviving cleared controller state', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  store.consume = async () => { throw new Error('first cleanup failure'); };
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, chat }));
  chat.setMessages([canonicalVoiceMessage()]);
  await assert.rejects(controller.reconcileChatSnapshot(chat.snapshot()));

  const cleanupStarted = deferred();
  const cleanup = deferred();
  store.consume = async () => {
    cleanupStarted.resolve();
    return cleanup.promise;
  };
  const retrying = controller.retryAcceptedCleanup();
  await cleanupStarted.promise;
  controller.dispose();
  cleanup.resolve(true);

  assert.equal(await retrying, false);
  assert.equal(controller.snapshot().phase, 'disposed');
  assert.equal(controller.snapshot().draft, null);
});

test('controller requires the exact message-binding release dependency', () => {
  const context = controllerFor();
  delete context.store.releaseMessageBinding;

  assert.throws(
    () => context.build(),
    /store\.releaseMessageBinding is required/,
  );
});

test('send completion preserves accepted-cleanup truth instead of relabeling it as unconfirmed', async () => {
  const store = createStore({ operations: [operation()] });
  store.consume = async () => { throw new Error('private cleanup diagnostics'); };
  const chat = createChat({
    send: [() => {
      chat.setMessages([canonicalVoiceMessage()]);
      return true;
    }],
  });
  const controller = await readyController(controllerFor({ store, chat }));

  await assert.rejects(
    controller.sendDraft({ clientMessageId: MESSAGE_ID }),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED' && error.textSafe === true,
  );

  assert.equal(controller.snapshot().phase, 'accepted-cleanup-pending');
  assert.equal(controller.snapshot().error.code, 'VOICE_ACCEPTANCE_CLEANUP_FAILED');
});

test('resume preserves accepted-cleanup truth when canonical history exists but local consume fails', async () => {
  const bound = operation({ messageBinding: { clientMessageId: MESSAGE_ID, text: 'Where is Academic Registry?' } });
  const store = createStore({ operations: [bound] });
  store.consume = async () => { throw new Error('private cleanup diagnostics'); };
  const chat = createChat({ messages: [canonicalVoiceMessage()] });
  const controller = controllerFor({ store, chat }).build();

  await assert.rejects(
    controller.resume({ clientSessionScope: SCOPE }),
    (error) => error.code === 'VOICE_ACCEPTANCE_CLEANUP_FAILED' && error.textSafe === true,
  );

  assert.equal(controller.snapshot().phase, 'accepted-cleanup-pending');
  assert.equal(controller.snapshot().error.code, 'VOICE_ACCEPTANCE_CLEANUP_FAILED');
});

test('controller requires the explicit coordinator retry seam at construction', () => {
  const context = controllerFor();
  delete context.coordinator.retry;

  assert.throws(
    () => context.build(),
    /coordinator\.retry is required/,
  );
});

test('explicit transcription retry reuses the current durable operation and ordinary resume never calls retry', async () => {
  const retryable = operation({
    state: 'retryable', transcript: null, voiceDraftId: null, failureCode: 'VOICE_TRANSCRIPTION_FAILED', retryable: true,
  });
  const store = createStore({ operations: [retryable] });
  const coordinator = createCoordinator({
    results: [{ state: 'retryable', failureCode: 'VOICE_TRANSCRIPTION_FAILED' }],
    retryResults: [{ state: 'ready', clientUploadId: UPLOAD_ID, transcript: 'Recovered exact transcript', voiceDraftId: DRAFT_ID }],
  });
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));

  assert.deepEqual(coordinator.calls, [
    { method: 'runById', input: { clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE } },
  ], 'ordinary recovery stays GET-first and cannot authorize a retry POST');
  assert.equal(controller.snapshot().phase, 'transcription-retryable');

  const result = await controller.retryTranscription();

  assert.equal(result.state, 'ready');
  assert.deepEqual(coordinator.calls[1], {
    method: 'retry', input: { clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE },
  });
  assert.deepEqual(controller.snapshot().draft, {
    text: 'Recovered exact transcript', voiceDraftId: DRAFT_ID,
  });
  assert.equal(store.calls.some(({ method }) => method === 'bindMessage'), false);
  assert.equal(chat.calls.length, 0);
});

test('failed explicit transcription retry remains retryable and never generates, binds, or sends an identity', async () => {
  const retryable = operation({
    state: 'retryable', transcript: null, voiceDraftId: null, failureCode: 'VOICE_TRANSCRIPTION_FAILED', retryable: true,
  });
  const store = createStore({ operations: [retryable] });
  const coordinator = createCoordinator({
    results: [{ state: 'retryable', failureCode: 'VOICE_TRANSCRIPTION_FAILED' }],
    retryResults: [Promise.reject(new Error('private transport diagnostics'))],
  });
  const chat = createChat();
  const controller = await readyController(controllerFor({ store, coordinator, chat }));

  await assert.rejects(
    controller.retryTranscription(),
    (error) => error.code === 'VOICE_TRANSCRIPTION_RETRYABLE'
      && error.textSafe === true
      && !error.message.includes('private transport'),
  );

  assert.equal(controller.snapshot().phase, 'transcription-retryable');
  assert.equal(controller.snapshot().operation.clientUploadId, UPLOAD_ID);
  assert.equal(store.calls.some(({ method }) => method === 'bindMessage'), false);
  assert.equal(chat.calls.length, 0);
});
