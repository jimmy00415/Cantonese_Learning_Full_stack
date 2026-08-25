import assert from 'node:assert/strict';
import test from 'node:test';

import { createChatController } from '../public/chat-controller.js';

function envelope(data, status = 200) {
  return new Response(JSON.stringify({ data, error: null, requestId: 'request-1' }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function failure(code = 'INTERNAL_ERROR', status = 500, headers = {}) {
  return new Response(JSON.stringify({ data: null, error: { code, message: 'Safe failure.' }, requestId: 'request-1' }), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function bootstrapData({ scope = 'scope-one', messages = [], capabilities = {} } = {}) {
  return {
    session: { id: `session-${scope}` },
    clientSessionScope: scope,
    conversation: { id: `conversation-${scope}` },
    messages,
    capabilities,
    knowledgeSnapshotDate: '2026-08-25',
  };
}

function message(overrides = {}) {
  return {
    id: 'message-1', clientMessageId: null, sequence: 1, role: 'assistant', kind: 'text',
    status: 'delivered', text: 'Hello', citations: [], cards: [], suggestedReplies: [],
    createdAt: '2026-08-25T08:00:00.000Z', ...overrides,
  };
}

function queuedFetch(...items) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (items.length === 0) throw new Error(`Unexpected fetch ${url}`);
    const next = items.shift();
    if (typeof next === 'function') return next(url, options);
    if (next instanceof Error) throw next;
    return next;
  };
  return { calls, fetchImpl, remaining: () => items.length };
}

class FakeEventSource {
  static instances = [];

  constructor(url) {
    this.url = url;
    this.listeners = new Map();
    this.closed = false;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, { lastEventId = '', data = '{}' } = {}) {
    for (const listener of this.listeners.get(type) ?? []) listener({ type, lastEventId, data });
  }

  close() { this.closed = true; }
}

function storage() {
  const values = new Map();
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  };
}

async function eventually(check, messageText = 'condition was not reached') {
  const deadline = Date.now() + 500;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail(messageText);
}

function controllerFor(fetchImpl, overrides = {}) {
  FakeEventSource.instances = [];
  return createChatController({
    fetchImpl,
    EventSourceImpl: FakeEventSource,
    storage: overrides.storage ?? storage(),
    uuid: overrides.uuid ?? (() => '11111111-1111-4111-8111-111111111111'),
    now: overrides.now ?? (() => new Date('2026-08-25T08:00:00.000Z')),
    scheduleReconnect: overrides.scheduleReconnect ?? ((callback) => callback()),
    onChange: overrides.onChange,
  });
}

test('chat controller bootstraps ordered history and keeps event cursor separate from message sequence', async () => {
  const store = storage();
  store.setItem('hk-buddy:v1:scope', 'scope-one');
  store.setItem('hk-buddy:v1:scope-one:event-cursor', '8');
  const first = message({ id: 'm1', sequence: 1, role: 'user', text: 'First' });
  const third = message({ id: 'm3', sequence: 3, text: 'Third' });
  const fourth = message({ id: 'm4', sequence: 4, role: 'user', text: 'Fourth' });
  const network = queuedFetch(
    envelope(bootstrapData({ messages: [third, first] })),
    envelope({ messages: [], activeTurn: null }),
    envelope({ messages: [fourth], activeTurn: { id: 'turn-4', state: 'retrieving' } }),
    envelope({ messages: [fourth], activeTurn: { id: 'turn-4', state: 'retrieving' } }),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });

  await controller.start();
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['m1', 'm3']);
  assert.equal(controller.snapshot().lastMessageSequence, 3);
  assert.equal(controller.snapshot().eventCursor, 8);
  assert.equal(FakeEventSource.instances[0].url, '/api/v1/events?afterCursor=8');
  assert.equal(network.calls[0].url, '/api/v1/session');
  assert.equal(network.calls[0].options.credentials, 'same-origin');
  assert.equal(network.calls[1].url, '/api/v1/messages?after=3');

  FakeEventSource.instances[0].emit('turn.state', { lastEventId: '9', data: '{"text":"untrusted"}' });
  await eventually(() => network.calls.length === 3);
  assert.equal(network.calls[2].url, '/api/v1/messages?after=3');
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['m1', 'm3', 'm4']);
  assert.equal(controller.snapshot().lastMessageSequence, 4);
  assert.equal(controller.snapshot().eventCursor, 9);

  FakeEventSource.instances[0].emit('message.accepted', { lastEventId: '9' });
  await eventually(() => network.calls.length === 4);
  assert.equal(network.calls[3].url, '/api/v1/messages?after=4');
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['m1', 'm3', 'm4']);
});

test('chat controller resets only SSE cursor and fully repairs prior-row mutations on resync', async () => {
  const accepted = message({ id: 'user-1', sequence: 1, clientMessageId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', role: 'user', status: 'accepted', text: 'Question' });
  const failed = { ...accepted, status: 'failed', failureCode: 'PROVIDER_TIMEOUT' };
  const audioReady = message({ id: 'assistant-2', sequence: 2, mediaId: 'media-1' });
  const network = queuedFetch(
    envelope(bootstrapData({ messages: [accepted] })),
    envelope({ messages: [], activeTurn: { id: 'turn-1', state: 'retrieving' } }),
    envelope({ messages: [failed], activeTurn: null }),
    envelope({ messages: [failed], activeTurn: null }),
    envelope({ messages: [failed, audioReady], activeTurn: null }),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  const firstSource = FakeEventSource.instances[0];

  firstSource.emit('resync_required');
  await eventually(() => network.calls.length === 3 && FakeEventSource.instances.length === 2);
  assert.equal(network.calls[2].url, '/api/v1/messages?after=0');
  assert.equal(controller.snapshot().eventCursor, 0);
  assert.equal(controller.snapshot().lastMessageSequence, 1);
  assert.equal(controller.snapshot().messages[0].failureCode, 'PROVIDER_TIMEOUT');
  assert.equal(controller.snapshot().activeTurn, null);
  assert.equal(FakeEventSource.instances[1].url, '/api/v1/events?afterCursor=0');

  FakeEventSource.instances[1].emit('turn.failed', { lastEventId: '5', data: '{"failureCode":"FAKE_PAYLOAD"}' });
  await eventually(() => network.calls.length === 4);
  assert.equal(network.calls[3].url, '/api/v1/messages?after=0');
  assert.equal(controller.snapshot().messages[0].failureCode, 'PROVIDER_TIMEOUT');
  assert.equal(controller.retryUnconfirmed(accepted.clientMessageId), false);

  FakeEventSource.instances[1].emit('audio.ready', { lastEventId: '6' });
  await eventually(() => network.calls.length === 5);
  assert.equal(network.calls[4].url, '/api/v1/messages?after=0');
  assert.equal(controller.snapshot().messages[1].mediaId, 'media-1');
});

test('chat controller reconciles a 202 optimistic send by clientMessageId and clears the draft only after acceptance', async () => {
  let resolveSend;
  const sendResponse = new Promise((resolve) => { resolveSend = resolve; });
  const accepted = message({
    id: 'persisted-user', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'How do I use Duo?',
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    () => sendResponse,
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('How do I use Duo?');

  const sending = controller.sendText('How do I use Duo?');
  assert.equal(controller.snapshot().messages[0].sendState, 'sending');
  assert.equal(controller.snapshot().draft, 'How do I use Duo?');
  resolveSend(envelope({ idempotent: false, message: accepted, turn: { id: 'turn-1', state: 'accepted' } }, 202));
  await sending;

  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['persisted-user']);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(network.calls[1].url, '/api/v1/messages');
  assert.equal(network.calls[1].options.credentials, 'same-origin');
  assert.deepEqual(JSON.parse(network.calls[1].options.body), {
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    text: 'How do I use Duo?',
    replyLanguage: 'en',
    replyMode: 'text',
  });
});

test('chat controller defaults to en text and an ambiguous retry keeps the captured preferences', async () => {
  const accepted = message({
    id: 'preference-user', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Immutable request',
    replyLanguage: 'yue-Hant-HK', replyMode: 'voice',
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    new Error('response lost'),
    envelope({ idempotent: true, message: accepted, turn: { id: 'turn-pref', state: 'accepted' } }, 202),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  assert.equal(controller.snapshot().replyLanguage, 'en');
  assert.equal(controller.snapshot().replyMode, 'text');
  controller.setReplyPreferences({ replyLanguage: 'yue-Hant-HK', replyMode: 'voice' });
  await assert.rejects(controller.sendText('Immutable request'), /response lost/);
  controller.setReplyPreferences({ replyLanguage: 'cmn-Hans-CN', replyMode: 'text' });
  const optimistic = controller.snapshot().messages[0];
  assert.equal(optimistic.replyLanguage, 'yue-Hant-HK');
  assert.equal(optimistic.replyMode, 'voice');
  await controller.retryUnconfirmed(optimistic.clientMessageId);
  assert.deepEqual(JSON.parse(network.calls[2].options.body), {
    clientMessageId: optimistic.clientMessageId,
    text: 'Immutable request',
    replyLanguage: 'yue-Hant-HK',
    replyMode: 'voice',
  });
});

test('chat controller preserves a caller-bound voice message identity and draft through an ambiguous retry', async () => {
  const clientMessageId = '44444444-4444-4444-8444-444444444444';
  const voiceDraftId = '55555555-5555-4555-8555-555555555555';
  const text = 'Where can I collect my student card?';
  const accepted = message({
    id: 'persisted-voice-user', sequence: 1, role: 'user', kind: 'voice', status: 'accepted',
    clientMessageId, text, voiceDraftId, mediaId: voiceDraftId,
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    new Error('voice message response was lost'),
    envelope({ idempotent: true, message: accepted, turn: { id: 'turn-voice', state: 'accepted' } }, 202),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft(text);

  await assert.rejects(
    controller.sendMessage({ text, voiceDraftId, clientMessageId }),
    /response was lost/i,
  );
  const unconfirmed = controller.snapshot().messages[0];
  assert.equal(unconfirmed.kind, 'voice');
  assert.equal(unconfirmed.voiceDraftId, voiceDraftId);
  assert.equal(unconfirmed.clientMessageId, clientMessageId);
  assert.deepEqual(JSON.parse(network.calls[1].options.body), { clientMessageId, text, voiceDraftId, replyLanguage: 'en', replyMode: 'text' });

  assert.equal(await controller.retryUnconfirmed(clientMessageId), true);
  assert.deepEqual(JSON.parse(network.calls[2].options.body), { clientMessageId, text, voiceDraftId, replyLanguage: 'en', replyMode: 'text' });
  assert.equal(controller.snapshot().messages[0].id, accepted.id);
  assert.equal(controller.snapshot().draft, '');
});

test('chat controller rejects malformed caller-bound voice identities before creating an optimistic send', async () => {
  const network = queuedFetch(envelope(bootstrapData()));
  const controller = controllerFor(network.fetchImpl);
  await controller.start();

  await assert.rejects(
    controller.sendMessage({
      text: 'Do not send this',
      voiceDraftId: 'not-a-draft-id',
      clientMessageId: 'not-a-message-id',
    }),
    (error) => error.code === 'INVALID_MESSAGE_IDENTITY',
  );
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(network.calls.length, 1);
});

test('chat controller preserves an unconfirmed draft and retries with the exact original identity', async () => {
  const accepted = message({
    id: 'persisted-user', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Where is the library?',
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    new Error('network unavailable'),
    envelope({ idempotent: true, message: accepted, turn: { id: 'turn-1', state: 'accepted' } }, 202),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('Where is the library?');

  await assert.rejects(controller.sendText('Where is the library?'), /network unavailable/i);
  const unconfirmed = controller.snapshot().messages[0];
  assert.equal(unconfirmed.sendState, 'unconfirmed');
  assert.equal(controller.snapshot().draft, 'Where is the library?');

  assert.equal(await controller.retryUnconfirmed(unconfirmed.clientMessageId), true);
  assert.equal(JSON.parse(network.calls[2].options.body).clientMessageId, unconfirmed.clientMessageId);
  assert.equal(controller.snapshot().messages[0].id, 'persisted-user');
  assert.equal(controller.snapshot().draft, '');
});

test('chat controller requires clear confirmation then closes SSE, clears scoped state, and bootstraps a new guest session', async () => {
  const store = storage();
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old', messages: [message()] })),
    envelope({ messages: [], activeTurn: null }),
    envelope({ deleted: true }),
    envelope(bootstrapData({ scope: 'scope-new', messages: [] }), 201),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });
  await controller.start();
  controller.setDraft('keep until confirmed');
  store.setItem('hk-buddy:v1:scope-old:event-cursor', '4');
  const oldSource = FakeEventSource.instances[0];

  assert.deepEqual(await controller.clearSession({ confirmed: false }), { confirmationRequired: true });
  assert.equal(network.calls.length, 2);
  assert.equal(oldSource.closed, false);

  assert.deepEqual(await controller.clearSession({ confirmed: true }), { deleted: true });
  assert.equal(network.calls[2].url, '/api/v1/session');
  assert.equal(network.calls[2].options.method, 'DELETE');
  assert.equal(network.calls[2].options.credentials, 'same-origin');
  assert.equal(oldSource.closed, true);
  assert.equal(store.getItem('hk-buddy:v1:scope-old:draft'), null);
  assert.equal(store.getItem('hk-buddy:v1:scope-old:event-cursor'), null);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(FakeEventSource.instances.length, 2);
});

test('chat controller fences Retry send while a confirmed clear is waiting for DELETE', async () => {
  let resolveDelete;
  const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    new Error('send response was lost'),
    () => deleteResponse,
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('Keep this exact retry');
  await assert.rejects(controller.sendText(controller.snapshot().draft), /response was lost/i);
  const clientMessageId = controller.snapshot().messages[0].clientMessageId;

  const clearing = controller.clearSession({ confirmed: true });
  await eventually(() => network.calls.length === 3);
  assert.equal(controller.snapshot().ready, false);
  await assert.rejects(
    controller.retryUnconfirmed(clientMessageId),
    (error) => error.code === 'CHAT_NOT_READY',
  );
  assert.equal(network.calls.length, 3, 'Retry cannot create a POST during clear');

  resolveDelete(envelope({ deleted: true }));
  await clearing;
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.equal(network.calls.length, 4);
});

test('chat controller defaults voice capability false without permanently deciding the UI control', async () => {
  const network = queuedFetch(envelope(bootstrapData({ capabilities: {} })));
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  assert.equal(controller.snapshot().capabilities.voiceInput, false);
  assert.equal(controller.snapshot().capabilities.voiceInputPreview, false);
});

test('chat controller resumes canonical active-turn state even when the saved SSE cursor is already current', async () => {
  const store = storage();
  store.setItem('hk-buddy:v1:scope', 'scope-one');
  store.setItem('hk-buddy:v1:scope-one:event-cursor', '12');
  const accepted = message({ id: 'user-1', sequence: 1, role: 'user', status: 'accepted', text: 'Question' });
  const network = queuedFetch(
    envelope(bootstrapData({ messages: [accepted] })),
    envelope({ messages: [], activeTurn: { id: 'turn-1', state: 'generating' } }),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });

  await controller.start();

  assert.equal(network.calls[1].url, '/api/v1/messages?after=1');
  assert.equal(controller.snapshot().activeTurn.state, 'generating');
  assert.equal(controller.snapshot().lastMessageSequence, 1);
  assert.equal(controller.snapshot().eventCursor, 12);
  assert.equal(FakeEventSource.instances[0].url, '/api/v1/events?afterCursor=12');
});

test('chat controller refresh serialization recovers after one rejected backfill', async () => {
  const recovered = message({ id: 'recovered-1', sequence: 1, role: 'user', text: 'Recovered' });
  const network = queuedFetch(
    envelope(bootstrapData()),
    failure('INTERNAL_ERROR', 503),
    envelope({ messages: [recovered], activeTurn: null }),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();

  await assert.rejects(controller.refresh(), /Safe failure/);
  await controller.refresh();

  assert.equal(network.calls[1].url, '/api/v1/messages?after=0');
  assert.equal(network.calls[2].url, '/api/v1/messages?after=0');
  assert.equal(controller.snapshot().messages[0].id, 'recovered-1');
  assert.equal(controller.snapshot().connection, 'connected');
});

test('chat controller reconnects from the last committed cursor after an SSE backfill failure', async () => {
  const store = storage();
  const recovered = message({ id: 'recovered-2', sequence: 1, role: 'user', text: 'Recovered from SSE' });
  const network = queuedFetch(
    envelope(bootstrapData()),
    failure('INTERNAL_ERROR', 503),
    envelope({ messages: [recovered], activeTurn: null }),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });
  await controller.start();
  const source = FakeEventSource.instances[0];

  source.emit('turn.state', { lastEventId: '1' });
  await eventually(() => network.calls.length === 2 && FakeEventSource.instances.length === 2);
  assert.equal(source.closed, true);
  assert.equal(controller.snapshot().eventCursor, 0);
  assert.equal(store.getItem('hk-buddy:v1:scope-one:event-cursor'), null);

  const recoveredSource = FakeEventSource.instances[1];
  assert.equal(recoveredSource.url, '/api/v1/events?afterCursor=0');
  recoveredSource.emit('message.accepted', { lastEventId: '2' });
  await eventually(() => network.calls.length === 3 && controller.snapshot().messages.length === 1);

  assert.equal(network.calls[2].url, '/api/v1/messages?after=0');
  assert.equal(controller.snapshot().messages[0].id, 'recovered-2');
  assert.equal(controller.snapshot().eventCursor, 2);
  assert.equal(store.getItem('hk-buddy:v1:scope-one:event-cursor'), '2');
  assert.equal(controller.snapshot().connection, 'connected');
});

test('chat controller rejects a second submit while the first acceptance is unresolved', async () => {
  let resolveSend;
  const sendResponse = new Promise((resolve) => { resolveSend = resolve; });
  let uuidCounter = 0;
  const uuid = () => `${String(uuidCounter += 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const accepted = message({
    id: 'persisted-user', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '00000001-1111-4111-8111-111111111111', text: 'One message',
  });
  const network = queuedFetch(envelope(bootstrapData()), () => sendResponse);
  const controller = controllerFor(network.fetchImpl, { uuid });
  await controller.start();

  const first = controller.sendText('One message');
  await assert.rejects(
    controller.sendText('One message'),
    (error) => error.code === 'MESSAGE_SEND_IN_PROGRESS',
  );
  assert.equal(network.calls.length, 2);
  assert.equal(controller.snapshot().messages.length, 1);

  resolveSend(envelope({ idempotent: false, message: accepted, turn: { id: 'turn-1', state: 'accepted' } }, 202));
  await first;
});

test('chat controller fences a late accepted send from a cleared session', async () => {
  let resolveOldSend;
  const oldSendResponse = new Promise((resolve) => { resolveOldSend = resolve; });
  const acceptedOld = message({
    id: 'old-message', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Old question',
  });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldSendResponse,
    envelope({ deleted: true }),
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);

  await controller.start();
  controller.setDraft('Old question');
  const oldSend = controller.sendText('Old question');
  await eventually(() => network.calls.length === 2);

  await controller.clearSession({ confirmed: true });
  controller.setDraft('New-session draft');
  resolveOldSend(envelope({
    idempotent: false,
    message: acceptedOld,
    turn: { id: 'old-turn', state: 'accepted' },
  }, 202));

  assert.equal(await oldSend, false);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().activeTurn, null);
  assert.equal(controller.snapshot().draft, 'New-session draft');
});

test('confirmed clear fences a late old send before the DELETE response settles', async () => {
  let resolveOldSend;
  let resolveDelete;
  const oldSendResponse = new Promise((resolve) => { resolveOldSend = resolve; });
  const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
  const acceptedOld = message({
    id: 'old-message', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Old question',
  });
  let notifications = 0;
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldSendResponse,
    () => deleteResponse,
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl, { onChange: () => { notifications += 1; } });

  await controller.start();
  controller.setDraft('Old question');
  const oldSend = controller.sendText('Old question');
  await eventually(() => network.calls.length === 2);
  const clear = controller.clearSession({ confirmed: true });
  await eventually(() => network.calls.length === 3);
  const beforeLateCompletion = controller.snapshot();
  const notificationsBeforeLateCompletion = notifications;

  resolveOldSend(envelope({
    idempotent: false,
    message: acceptedOld,
    turn: { id: 'old-turn', state: 'accepted' },
  }, 202));
  assert.equal(await oldSend, false);
  assert.deepEqual(controller.snapshot(), beforeLateCompletion);
  assert.equal(notifications, notificationsBeforeLateCompletion);
  assert.equal(controller.snapshot().activeTurn, null);
  assert.equal(controller.snapshot().messages.some((item) => item.id === 'old-message'), false);

  resolveDelete(envelope({ deleted: true }));
  assert.deepEqual(await clear, { deleted: true });
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
});

test('confirmed clear fences a late old canonical refresh while DELETE is pending', async () => {
  let resolveOldRefresh;
  let resolveDelete;
  const oldRefreshResponse = new Promise((resolve) => { resolveOldRefresh = resolve; });
  const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
  let notifications = 0;
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldRefreshResponse,
    () => deleteResponse,
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl, { onChange: () => { notifications += 1; } });

  await controller.start();
  const oldRefresh = controller.refresh();
  await eventually(() => network.calls.length === 2);
  const clear = controller.clearSession({ confirmed: true });
  await eventually(() => network.calls.length === 3);
  const beforeLateCompletion = controller.snapshot();
  const notificationsBeforeLateCompletion = notifications;

  resolveOldRefresh(envelope({
    messages: [message({ id: 'late-old-backfill', sequence: 1 })],
    activeTurn: { id: 'late-old-turn', state: 'generating' },
  }));
  assert.equal(await oldRefresh, false);
  assert.deepEqual(controller.snapshot(), beforeLateCompletion);
  assert.equal(notifications, notificationsBeforeLateCompletion);

  resolveDelete(envelope({ deleted: true }));
  assert.deepEqual(await clear, { deleted: true });
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().activeTurn, null);
});

test('failed DELETE reloads same-session canonical truth without claiming the chat was cleared', async () => {
  let resolveOldSend;
  let resolveDelete;
  const oldSendResponse = new Promise((resolve) => { resolveOldSend = resolve; });
  const deleteResponse = new Promise((resolve) => { resolveDelete = resolve; });
  const acceptedOld = message({
    id: 'accepted-before-delete-failed', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Keep accepted truth',
  });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldSendResponse,
    () => deleteResponse,
    envelope(bootstrapData({ scope: 'scope-old', messages: [acceptedOld] })),
    envelope({ messages: [], activeTurn: null }),
  );
  const controller = controllerFor(network.fetchImpl);

  await controller.start();
  controller.setDraft('Keep accepted truth');
  const oldSend = controller.sendText('Keep accepted truth');
  await eventually(() => network.calls.length === 2);
  const clear = controller.clearSession({ confirmed: true });
  await eventually(() => network.calls.length === 3);

  resolveOldSend(envelope({
    idempotent: false,
    message: acceptedOld,
    turn: { id: 'old-turn', state: 'accepted' },
  }, 202));
  assert.equal(await oldSend, false);
  resolveDelete(failure('DELETE_FAILED', 500));

  await assert.rejects(
    clear,
    (error) => error.code === 'DELETE_FAILED' && error.deleted === false && error.recovered === true,
  );
  assert.equal(controller.snapshot().ready, true);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-old');
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), [acceptedOld.id]);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(controller.snapshot().activeTurn, null);
});

test('failed DELETE recovery turns an unresolved old send into exact-ID unconfirmed retry', async () => {
  let rejectOldSend;
  const oldSendResponse = new Promise((resolve, reject) => { rejectOldSend = reject; });
  const clientMessageId = '11111111-1111-4111-8111-111111111111';
  const accepted = message({
    id: 'accepted-on-idempotent-retry', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId, text: 'Keep this pending draft',
  });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldSendResponse,
    failure('DELETE_FAILED', 500),
    envelope(bootstrapData({ scope: 'scope-old', messages: [] })),
    envelope({ idempotent: true, message: accepted, turn: { id: 'turn-retry', state: 'accepted' } }, 202),
  );
  const controller = controllerFor(network.fetchImpl);

  await controller.start();
  controller.setDraft('Keep this pending draft');
  const oldSend = controller.sendText('Keep this pending draft');
  await eventually(() => network.calls.length === 2);

  await assert.rejects(
    controller.clearSession({ confirmed: true }),
    (error) => error.code === 'DELETE_FAILED' && error.deleted === false && error.recovered === true,
  );
  assert.equal(controller.snapshot().ready, true);
  assert.equal(controller.snapshot().messages[0].sendState, 'unconfirmed');
  assert.equal(controller.snapshot().draft, 'Keep this pending draft');

  assert.equal(await controller.retryUnconfirmed(clientMessageId), true);
  assert.equal(JSON.parse(network.calls[4].options.body).clientMessageId, clientMessageId);
  assert.equal(controller.snapshot().messages[0].id, accepted.id);
  assert.equal(controller.snapshot().draft, '');

  rejectOldSend(new Error('late original send rejection'));
  assert.equal(await oldSend, false);
  assert.equal(controller.snapshot().messages[0].id, accepted.id);
  assert.equal(controller.snapshot().activeTurn.id, 'turn-retry');
});

test('lost DELETE response followed by a new scope clears old local truth instead of migrating its draft', async () => {
  const store = storage();
  const oldMessage = message({ id: 'old-private-message', sequence: 1, role: 'user', text: 'Private old history' });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old', messages: [oldMessage] })),
    envelope({ messages: [], activeTurn: null }),
    new Error('DELETE response was lost after revocation'),
    envelope(bootstrapData({ scope: 'scope-new', messages: [] }), 201),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });

  await controller.start();
  controller.setDraft('Private old draft');
  store.setItem('hk-buddy:v1:scope-old:event-cursor', '9');

  assert.deepEqual(
    await controller.clearSession({ confirmed: true }),
    { deleted: true, recovered: true },
  );
  assert.equal(controller.snapshot().ready, true);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(controller.snapshot().eventCursor, 0);
  assert.equal(store.getItem('hk-buddy:v1:scope-old:draft'), null);
  assert.equal(store.getItem('hk-buddy:v1:scope-old:event-cursor'), null);
  assert.equal(store.getItem('hk-buddy:v1:scope'), 'scope-new');
});

test('ambiguous DELETE plus failed scope recovery reports an unknown outcome without migrating the old draft', async () => {
  const store = storage();
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    new Error('DELETE response was lost'),
    new Error('scope recovery unavailable'),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });

  await controller.start();
  controller.setDraft('Keep only under the unresolved old scope');

  await assert.rejects(
    controller.clearSession({ confirmed: true }),
    (error) => error.code === 'CLEAR_OUTCOME_UNKNOWN' && error.deleted === null,
  );
  assert.equal(controller.snapshot().ready, false);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-old');
  assert.equal(controller.snapshot().draft, 'Keep only under the unresolved old scope');
  assert.equal(store.getItem('hk-buddy:v1:scope-old:draft'), 'Keep only under the unresolved old scope');
  assert.equal(store.getItem('hk-buddy:v1:scope'), 'scope-old');
});

test('chat controller fences a late canonical backfill from a cleared session', async () => {
  let resolveOldRefresh;
  const oldRefreshResponse = new Promise((resolve) => { resolveOldRefresh = resolve; });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldRefreshResponse,
    envelope({ deleted: true }),
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);

  await controller.start();
  const oldRefresh = controller.refresh();
  await eventually(() => network.calls.length === 2);
  await controller.clearSession({ confirmed: true });

  resolveOldRefresh(envelope({
    messages: [message({ id: 'old-backfill', sequence: 1 })],
    activeTurn: { id: 'old-turn', state: 'generating' },
  }));
  await oldRefresh;

  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().activeTurn, null);
  assert.equal(controller.snapshot().connection, 'connected');
});

test('chat controller keeps the newest bootstrap when an older bootstrap completes late', async () => {
  let resolveOldBootstrap;
  const oldBootstrapResponse = new Promise((resolve) => { resolveOldBootstrap = resolve; });
  const network = queuedFetch(
    () => oldBootstrapResponse,
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);

  const oldStart = controller.start();
  await eventually(() => network.calls.length === 1);
  await controller.start();
  resolveOldBootstrap(envelope(bootstrapData({
    scope: 'scope-old',
    messages: [message({ id: 'old-bootstrap-message' })],
  }), 201));
  await oldStart;

  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(FakeEventSource.instances.length, 1);
});

test('chat controller prunes an unconfirmed optimistic send when canonical backfill proves acceptance', async () => {
  const clientMessageId = '11111111-1111-4111-8111-111111111111';
  const accepted = message({
    id: 'accepted-after-lost-response', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId, text: 'Accepted despite the lost response',
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    new Error('response was lost'),
    envelope({ messages: [accepted], activeTurn: { id: 'turn-1', state: 'retrieving' } }),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft(accepted.text);

  await assert.rejects(controller.sendText(accepted.text), /response was lost/);
  assert.equal(controller.snapshot().messages[0].sendState, 'unconfirmed');
  await controller.refresh();

  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), [accepted.id]);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(controller.retryUnconfirmed(clientMessageId), false);
});

test('chat controller prunes a same-scope optimistic send accepted in bootstrapped history', async () => {
  const clientMessageId = '11111111-1111-4111-8111-111111111111';
  const accepted = message({
    id: 'accepted-on-resume', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId, text: 'Resume this accepted message',
  });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-one' })),
    new Error('response was lost'),
    envelope(bootstrapData({ scope: 'scope-one', messages: [accepted] }), 200),
    envelope({ messages: [], activeTurn: { id: 'turn-1', state: 'retrieving' } }),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft(accepted.text);
  await assert.rejects(controller.sendText(accepted.text), /response was lost/);

  await controller.start();

  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), [accepted.id]);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(controller.retryUnconfirmed(clientMessageId), false);
});

test('chat controller clears a normalized matching draft but preserves a substantively edited draft', async () => {
  const firstAccepted = message({
    id: 'accepted-trimmed', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '00000001-1111-4111-8111-111111111111', text: 'Trim this question',
  });
  const secondAccepted = message({
    id: 'accepted-before-edit', sequence: 2, role: 'user', status: 'accepted',
    clientMessageId: '00000002-1111-4111-8111-111111111111', text: 'Original question',
  });
  let resolveSecond;
  const secondResponse = new Promise((resolve) => { resolveSecond = resolve; });
  let uuidCounter = 0;
  const uuid = () => `${String(uuidCounter += 1).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const network = queuedFetch(
    envelope(bootstrapData()),
    envelope({ idempotent: false, message: firstAccepted, turn: { id: 'turn-1', state: 'accepted' } }, 202),
    () => secondResponse,
  );
  const controller = controllerFor(network.fetchImpl, { uuid });
  await controller.start();

  controller.setDraft('Trim this question  \n');
  await controller.sendText(controller.snapshot().draft);
  assert.equal(controller.snapshot().draft, '');

  controller.setDraft('Original question');
  const sending = controller.sendText(controller.snapshot().draft);
  controller.setDraft('A different follow-up');
  resolveSecond(envelope({
    idempotent: false,
    message: secondAccepted,
    turn: { id: 'turn-2', state: 'accepted' },
  }, 202));
  await sending;
  assert.equal(controller.snapshot().draft, 'A different follow-up');
});

test('chat controller distinguishes known HTTP rejection from an ambiguous network outcome and obeys Retry-After', async () => {
  let clock = new Date('2026-08-25T08:00:00.000Z');
  const accepted = message({
    id: 'accepted-after-rate-limit', sequence: 1, role: 'user', status: 'accepted',
    clientMessageId: '11111111-1111-4111-8111-111111111111', text: 'Please accept this later',
  });
  const network = queuedFetch(
    envelope(bootstrapData()),
    failure('RATE_LIMITED', 429, { 'Retry-After': '10' }),
    envelope({ idempotent: false, message: accepted, turn: { id: 'turn-later', state: 'accepted' } }, 202),
  );
  const controller = controllerFor(network.fetchImpl, { now: () => new Date(clock) });
  await controller.start();
  controller.setDraft('Please accept this later');

  await assert.rejects(
    controller.sendText(controller.snapshot().draft),
    (error) => error.code === 'RATE_LIMITED' && error.status === 429 && error.retryAfter === '10',
  );
  assert.equal(controller.snapshot().messages[0].sendState, 'retryable-rejection');
  assert.equal(controller.snapshot().draft, 'Please accept this later');
  const clientMessageId = controller.snapshot().messages[0].clientMessageId;
  await assert.rejects(
    controller.retryUnconfirmed(clientMessageId),
    (error) => error.code === 'RATE_LIMITED' && error.retryAfter === '10',
  );
  assert.equal(network.calls.length, 2);
  clock = new Date(clock.getTime() + 10_000);
  assert.equal(await controller.retryUnconfirmed(clientMessageId), true);
  assert.deepEqual(JSON.parse(network.calls[2].options.body), {
    clientMessageId,
    text: 'Please accept this later',
    replyLanguage: 'en',
    replyMode: 'text',
  });
  assert.equal(controller.snapshot().messages[0].id, accepted.id);
});

test('chat controller marks an explicit 401 rejection as rejected without offering idempotent retry', async () => {
  const network = queuedFetch(
    envelope(bootstrapData()),
    failure('UNAUTHORIZED', 401),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('Keep this editable');

  await assert.rejects(controller.sendText(controller.snapshot().draft), (error) => error.status === 401);

  const rejected = controller.snapshot().messages[0];
  assert.equal(rejected.sendState, 'rejected');
  assert.equal(controller.snapshot().draft, 'Keep this editable');
  assert.equal(controller.retryUnconfirmed(rejected.clientMessageId), false);
});

test('chat controller preserves the draft and bootstraps a new guest after SESSION_NOT_FOUND', async () => {
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    failure('SESSION_NOT_FOUND', 401),
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('Retry this in the new guest chat');
  const oldSource = FakeEventSource.instances[0];

  await assert.rejects(
    controller.sendText(controller.snapshot().draft),
    (error) => error.code === 'SESSION_RECOVERED',
  );

  assert.equal(oldSource.closed, true);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.equal(controller.snapshot().draft, 'Retry this in the new guest chat');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(FakeEventSource.instances.length, 2);
});

test('chat controller reports cleared truth when restart fails after DELETE succeeded', async () => {
  const store = storage();
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old', messages: [message()] })),
    envelope({ messages: [], activeTurn: null }),
    envelope({ deleted: true }),
    new Error('new guest bootstrap unavailable'),
  );
  const controller = controllerFor(network.fetchImpl, { storage: store });
  await controller.start();
  controller.setDraft('This must be revoked');
  const oldSource = FakeEventSource.instances[0];

  await assert.rejects(
    controller.clearSession({ confirmed: true }),
    (error) => error.code === 'CLEARED_RESTART_FAILED' && error.deleted === true,
  );

  assert.equal(oldSource.closed, true);
  assert.equal(controller.snapshot().ready, false);
  assert.equal(controller.snapshot().clientSessionScope, null);
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().draft, '');
  assert.equal(store.getItem('hk-buddy:v1:scope-old:draft'), null);
});

test('chat controller lets a new-scope refresh pass an unresolved old refresh queue', async () => {
  let resolveOldRefresh;
  const unresolvedOldRefresh = new Promise((resolve) => { resolveOldRefresh = resolve; });
  const newMessage = message({ id: 'new-scope-message', sequence: 1, text: 'New scope truth' });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => unresolvedOldRefresh,
    envelope({ deleted: true }),
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
    envelope({ messages: [newMessage], activeTurn: null }),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  const oldRefresh = controller.refresh();
  await eventually(() => network.calls.length === 2);

  await controller.clearSession({ confirmed: true });
  await controller.refresh();
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['new-scope-message']);

  resolveOldRefresh(envelope({
    messages: [message({ id: 'late-old-message', sequence: 1 })],
    activeTurn: { id: 'late-old-turn', state: 'generating' },
  }));
  await oldRefresh;
  assert.deepEqual(controller.snapshot().messages.map((item) => item.id), ['new-scope-message']);
  assert.equal(controller.snapshot().activeTurn, null);
});

test('chat controller consumes a late old-session send rejection after clear', async () => {
  let rejectOldSend;
  const oldSendResponse = new Promise((resolve, reject) => { rejectOldSend = reject; });
  const network = queuedFetch(
    envelope(bootstrapData({ scope: 'scope-old' })),
    () => oldSendResponse,
    envelope({ deleted: true }),
    envelope(bootstrapData({ scope: 'scope-new' }), 201),
  );
  const controller = controllerFor(network.fetchImpl);
  await controller.start();
  controller.setDraft('Old in-flight question');
  const oldSend = controller.sendText(controller.snapshot().draft);
  await eventually(() => network.calls.length === 2);

  await controller.clearSession({ confirmed: true });
  controller.setDraft('New-session draft');
  rejectOldSend(new Error('late old-session network rejection'));

  assert.equal(await oldSend, false);
  assert.equal(controller.snapshot().clientSessionScope, 'scope-new');
  assert.deepEqual(controller.snapshot().messages, []);
  assert.equal(controller.snapshot().draft, 'New-session draft');
});
