import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createEventStreamHandler, EventHub } from '../src/services/events.js';
import { createDispatcher } from '../src/services/dispatcher.js';
import { createTurnProcessor } from '../src/services/turn-processor.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

const ORIGIN = 'https://v1.example.test';

async function createStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-turn-'));
  const filePath = join(directory, 'store.json');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  t.after(() => store.close());
  return { store, filePath };
}

async function createOwnedConversation(store, suffix = 'one') {
  const { session, conversation } = await store.createOrResumeSession({ tokenHash: `token-${suffix}`, now: '2026-08-25T00:00:00.000Z' });
  return { session, conversation };
}

async function accept(store, owner, clientMessageId, text, now) {
  return store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId,
    requestHash: `hash-${clientMessageId}`,
    text,
    now,
  });
}

function finalMessage(text = 'Grounded answer') {
  return {
    text,
    citations: [],
    cards: [],
    suggestedReplies: [],
    needsClarification: false,
    groundingStatus: 'unverified',
  };
}

function lease(workerId, token, nowMs, durationMs = 15_000) {
  return { workerId, leaseToken: token, now: new Date(nowMs), leaseUntil: new Date(nowMs + durationMs) };
}

test('turn api claims only the earliest nonterminal per conversation and fences every worker mutation', async (t) => {
  const { store } = await createStore(t);
  const firstOwner = await createOwnedConversation(store, 'first');
  const secondOwner = await createOwnedConversation(store, 'second');
  const first = await accept(store, firstOwner, '11111111-1111-4111-8111-111111111111', 'first', '2026-08-25T00:00:01.000Z');
  const later = await accept(store, firstOwner, '22222222-2222-4222-8222-222222222222', 'later', '2026-08-25T00:00:02.000Z');
  const other = await accept(store, secondOwner, '33333333-3333-4333-8333-333333333333', 'other', '2026-08-25T00:00:03.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');

  const claimedFirst = await store.claimNextTurn(lease('worker-a', 'lease-a', base));
  assert.equal(claimedFirst.id, first.turn.id);
  const claimedOther = await store.claimNextTurn(lease('worker-b', 'lease-b', base));
  assert.equal(claimedOther.id, other.turn.id);
  const blockedLater = await store.claimNextTurn(lease('worker-c', 'lease-c', base));
  assert.equal(blockedLater, null);

  await assert.rejects(store.setTurnState({ turnId: first.turn.id, leaseToken: 'stale', state: 'retrieving', now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.renewTurnLease({ turnId: first.turn.id, leaseToken: 'stale', leaseUntil: new Date(base + 30_000), now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'stale', message: finalMessage(), now: new Date(base + 1) }), (error) => error.code === 'LEASE_LOST');

  const transitioned = await store.setTurnState({ turnId: first.turn.id, leaseToken: 'lease-a', state: 'retrieving', now: new Date(base + 2) });
  assert.equal(transitioned.turn.state, 'retrieving');
  assert.equal(transitioned.event.type, 'turn.state');
  const renewed = await store.renewTurnLease({ turnId: first.turn.id, leaseToken: 'lease-a', leaseUntil: new Date(base + 40_000), now: new Date(base + 3) });
  assert.equal(renewed.leaseExpiresAt, new Date(base + 40_000).toISOString());
  assert.equal(later.turn.state, 'accepted');
});

test('turn api context is turn-ordered and excludes later accepted input from an earlier prompt', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'user one', '2026-08-25T00:00:01.000Z');
  const second = await accept(store, owner, '22222222-2222-4222-8222-222222222222', 'user two', '2026-08-25T00:00:02.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('worker-a', 'lease-a', base));

  const contextOne = await store.getTurnContext({ turnId: first.turn.id });
  assert.deepEqual(contextOne.messages.map((message) => [message.role, message.text]), [['user', 'user one']]);

  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'lease-a', state: 'retrieving', now: new Date(base + 1) });
  await store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'lease-a', message: finalMessage('assistant one'), now: new Date(base + 2) });
  const claimedSecond = await store.claimNextTurn(lease('worker-b', 'lease-b', base + 3));
  assert.equal(claimedSecond.id, second.turn.id);
  const contextTwo = await store.getTurnContext({ turnId: second.turn.id });
  assert.deepEqual(contextTwo.messages.map((message) => [message.role, message.text]), [
    ['user', 'user one'], ['assistant', 'assistant one'], ['user', 'user two'],
  ]);
});

test('turn api reclaims expired work, prevents stale fail/delivery, and preserves terminal failure after reload', async (t) => {
  const { store, filePath } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'recover me', '2026-08-25T00:00:01.000Z');
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  await store.claimNextTurn(lease('worker-a', 'expired-token', base, 10));
  await store.setTurnState({ turnId: first.turn.id, leaseToken: 'expired-token', state: 'generating', now: new Date(base + 1) });
  const reclaimed = await store.claimNextTurn(lease('worker-b', 'fresh-token', base + 11));
  assert.equal(reclaimed.id, first.turn.id);
  assert.equal(reclaimed.attempt, 2);
  await assert.rejects(store.failTurn({ turnId: first.turn.id, leaseToken: 'expired-token', failureCode: 'PROVIDER_UNAVAILABLE', now: new Date(base + 12) }), (error) => error.code === 'LEASE_LOST');
  await assert.rejects(store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'expired-token', message: finalMessage('stale'), now: new Date(base + 12) }), (error) => error.code === 'LEASE_LOST');
  await store.failTurn({ turnId: first.turn.id, leaseToken: 'fresh-token', failureCode: 'ANSWER_FAILED', now: new Date(base + 12) });
  await store.close();

  const reopened = new AtomicFileStore({ filePath });
  await reopened.init();
  t.after(() => reopened.close());
  const messages = await reopened.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 });
  const events = await reopened.listEvents({ sessionId: owner.session.id, conversationId: owner.conversation.id, afterCursor: 0 });
  assert.equal(messages[0].status, 'failed');
  assert.equal(messages[0].failureCode, 'ANSWER_FAILED');
  assert.equal(events.at(-1).type, 'turn.failed');
  assert.equal(events.at(-1).payloadJson.failureCode, 'ANSWER_FAILED');
});

test('turn api dispatcher polling finds persisted work without wake and racing dispatchers deliver once', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'persisted before wake', '2026-08-25T00:00:01.000Z');
  let answerCalls = 0;
  const answerService = {
    async answer({ beforeProvider }) {
      answerCalls += 1;
      await beforeProvider();
      await new Promise((resolve) => setTimeout(resolve, 10));
      return finalMessage('one reply');
    },
  };
  const eventHub = new EventHub();
  const processor = createTurnProcessor({ store, answerService, eventHub });
  const first = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher-a', pollIntervalMs: 5, leaseDurationMs: 1000, renewalIntervalMs: 100 });
  const second = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher-b', pollIntervalMs: 5, leaseDurationMs: 1000, renewalIntervalMs: 100 });
  first.start();
  second.start();
  t.after(async () => { await first.stop(); await second.stop(); eventHub.close(); });

  const deadline = Date.now() + 2000;
  let delivered = [];
  while (Date.now() < deadline) {
    delivered = (await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 })).filter((message) => message.role === 'assistant');
    if (delivered.length === 1) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].text, 'one reply');
  assert.equal(answerCalls, 1);
});

test('turn api processes two accepted messages in order and duplicate client IDs create one assistant reply', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  const first = await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'first user', '2026-08-25T00:00:01.000Z');
  const duplicate = await store.acceptMessage({
    sessionId: owner.session.id, conversationId: owner.conversation.id,
    clientMessageId: '11111111-1111-4111-8111-111111111111', requestHash: 'hash-11111111-1111-4111-8111-111111111111',
    text: 'first user', now: '2026-08-25T00:00:01.500Z',
  });
  const second = await accept(store, owner, '22222222-2222-4222-8222-222222222222', 'second user', '2026-08-25T00:00:02.000Z');
  assert.equal(duplicate.idempotent, true);
  assert.equal(duplicate.turn.id, first.turn.id);

  const answerService = {
    async answer({ text, beforeProvider }) {
      await beforeProvider();
      return finalMessage(`reply to ${text}`);
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'ordered-worker', leaseDurationMs: 1000, renewalIntervalMs: 100 });
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(await dispatcher.runOnce(), true);
  assert.equal(await dispatcher.runOnce(), false);
  const messages = await store.listMessages({ sessionId: owner.session.id, conversationId: owner.conversation.id, after: 0 });
  assert.deepEqual(messages.map((message) => [message.role, message.text, message.turnId]), [
    ['user', 'first user', first.turn.id],
    ['user', 'second user', second.turn.id],
    ['assistant', 'reply to first user', first.turn.id],
    ['assistant', 'reply to second user', second.turn.id],
  ]);
  assert.equal(messages.filter((message) => message.role === 'assistant' && message.turnId === first.turn.id).length, 1);
});

test('turn api restart recovery can reclaim accepted, retrieving, and generating states once', async (t) => {
  const { store } = await createStore(t);
  const owners = await Promise.all(['accepted', 'retrieving', 'generating'].map((name) => createOwnedConversation(store, name)));
  const turns = [];
  for (let index = 0; index < owners.length; index += 1) {
    turns.push((await accept(store, owners[index], `${index + 1}0000000-0000-4000-8000-000000000000`, `state ${index}`, new Date(Date.parse('2026-08-25T00:00:01.000Z') + index))).turn);
  }
  const base = Date.parse('2026-08-25T00:01:00.000Z');
  const retrieving = await store.claimNextTurn(lease('old-retrieving', 'old-r', base, 5));
  await store.setTurnState({ turnId: retrieving.id, leaseToken: 'old-r', state: 'retrieving', now: new Date(base + 1) });
  const generating = await store.claimNextTurn(lease('old-generating', 'old-g', base, 5));
  await store.setTurnState({ turnId: generating.id, leaseToken: 'old-g', state: 'generating', now: new Date(base + 1) });

  const reclaimed = [];
  for (let index = 0; index < 3; index += 1) {
    reclaimed.push(await store.claimNextTurn(lease(`new-${index}`, `new-token-${index}`, base + 6)));
  }
  assert.deepEqual(new Set(reclaimed.map((turn) => turn.id)), new Set(turns.map((turn) => turn.id)));
  assert.equal(reclaimed.filter((turn) => turn.attempt === 2).length, 2);
  assert.equal(reclaimed.filter((turn) => turn.attempt === 1).length, 1);
  assert.equal(await store.claimNextTurn(lease('extra', 'extra-token', base + 6)), null);
});

test('turn api renewal loss aborts provider work and session deletion cannot be undone', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store);
  await accept(store, owner, '11111111-1111-4111-8111-111111111111', 'delete during work', '2026-08-25T00:00:01.000Z');
  let observedAbort = false;
  let signalProviderStarted;
  const providerStarted = new Promise((resolve) => { signalProviderStarted = resolve; });
  const answerService = {
    async answer({ beforeProvider, signal }) {
      await beforeProvider();
      await new Promise((resolve) => {
        signal.addEventListener('abort', () => { observedAbort = true; resolve(); }, { once: true });
        signalProviderStarted();
        setTimeout(resolve, 500);
      });
      return finalMessage('must never deliver');
    },
  };
  const processor = createTurnProcessor({ store, answerService, eventHub: new EventHub() });
  const dispatcher = createDispatcher({ store, processTurn: processor.processTurn, workerId: 'dispatcher', leaseDurationMs: 30, renewalIntervalMs: 10, pollIntervalMs: 1000 });
  const running = dispatcher.runOnce();
  await providerStarted;
  await store.deleteSession({ sessionId: owner.session.id });
  await running;
  assert.equal(observedAbort, true);
  assert.equal(await store.getSessionByTokenHash('token-one'), null);
});

async function startSseApp(t, configOverrides = {}) {
  const { store } = await createStore(t);
  const eventHub = new EventHub();
  const config = loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: ORIGIN, V1_SESSION_SECRET: 'x'.repeat(32), ...configOverrides });
  const app = createApp({ config, store, eventHub });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    eventHub.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const createdResponse = await fetch(`${baseUrl}/api/v1/session`, { method: 'POST', headers: { Origin: ORIGIN } });
  const created = await createdResponse.json();
  const cookie = createdResponse.headers.getSetCookie()[0].split(';')[0];
  return { baseUrl, cookie, store, eventHub, owner: { session: created.data.session, conversation: created.data.conversation } };
}

async function collectSse(response, predicate, timeoutMs = 1000) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const timeout = setTimeout(() => reader.cancel(), timeoutMs);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (predicate(text)) break;
    }
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
  return text;
}

function eventIds(stream) {
  return [...stream.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
}

test('turn api SSE replays monotonic durable cursors and Last-Event-ID takes precedence without allowing rewind', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20', V1_SSE_PAGE_SIZE: '2' });
  for (let index = 0; index < 5; index += 1) {
    await accept(runtime.store, runtime.owner, `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `message ${index}`, new Date(Date.now() + index));
  }

  const replay = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  assert.equal(replay.status, 200);
  const replayText = await collectSse(replay, (text) => eventIds(text).length >= 5);
  assert.deepEqual(eventIds(replayText), [1, 2, 3, 4, 5]);
  assert.match(replayText, /^retry: 3000$/m);

  const reconnect = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie, 'Last-Event-ID': '4' } });
  const reconnectText = await collectSse(reconnect, (text) => eventIds(text).length >= 1);
  assert.deepEqual(eventIds(reconnectText), [5]);

  const rewind = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=5`, { headers: { Cookie: runtime.cookie, 'Last-Event-ID': '4' } });
  assert.equal(rewind.status, 400);
  assert.equal((await rewind.json()).error.code, 'INVALID_EVENT_CURSOR');
});

test('turn api SSE drains multi-page replay plus replay-race events exactly once and notifications never become payload truth', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_PAGE_SIZE: '2', V1_SSE_HEARTBEAT_MS: '20' });
  for (let index = 0; index < 5; index += 1) {
    await accept(runtime.store, runtime.owner, `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `message ${index}`, new Date(Date.now() + index));
  }
  const originalPage = runtime.store.listEventsPage.bind(runtime.store);
  let injected = false;
  runtime.store.listEventsPage = async (input) => {
    const page = await originalPage(input);
    if (!injected) {
      injected = true;
      const late = await accept(runtime.store, runtime.owner, '29999999-9999-4999-8999-999999999999', 'arrived during replay', new Date());
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: late.event.cursor, payloadJson: { forged: 'must-not-stream' } });
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: 2 });
      runtime.eventHub.publish({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id, cursor: late.event.cursor });
    }
    return page;
  };
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => eventIds(text).includes(6));
  assert.deepEqual(eventIds(stream), [1, 2, 3, 4, 5, 6]);
  assert.equal(stream.includes('must-not-stream'), false);
});

test('turn api SSE replays delivery and terminal failure with stable safe payloads only', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_PAGE_SIZE: '2' });
  const first = await accept(runtime.store, runtime.owner, '25000000-0000-4000-8000-000000000000', 'deliver', new Date());
  const second = await accept(runtime.store, runtime.owner, '26000000-0000-4000-8000-000000000000', 'fail', new Date(Date.now() + 1));
  const base = Date.now() + 100;
  await runtime.store.claimNextTurn(lease('delivery-worker', 'delivery-token', base));
  await runtime.store.setTurnState({ turnId: first.turn.id, leaseToken: 'delivery-token', state: 'retrieving', now: new Date(base + 1) });
  await runtime.store.deliverAssistant({ turnId: first.turn.id, leaseToken: 'delivery-token', message: finalMessage(), now: new Date(base + 2) });
  await runtime.store.claimNextTurn(lease('failure-worker', 'failure-token', base + 3));
  await runtime.store.setTurnState({ turnId: second.turn.id, leaseToken: 'failure-token', state: 'retrieving', now: new Date(base + 4) });
  await runtime.store.failTurn({ turnId: second.turn.id, leaseToken: 'failure-token', failureCode: 'PROVIDER_TIMEOUT', now: new Date(base + 5) });
  const highWater = await runtime.store.getEventHighWater({ sessionId: runtime.owner.session.id, conversationId: runtime.owner.conversation.id });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => eventIds(text).includes(highWater));
  assert.match(stream, /event: message\.delivered/);
  assert.match(stream, /event: turn\.failed/);
  assert.match(stream, /"failureCode":"PROVIDER_TIMEOUT"/);
  assert.equal(stream.includes('delivery-token'), false);
  assert.equal(stream.includes('failure-token'), false);
  assert.equal(stream.includes('requestHash'), false);
});

test('turn api SSE overflow emits resync_required without id and reconnect drains durable truth', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_BUFFER_SIZE: '2', V1_SSE_PAGE_SIZE: '2', V1_SSE_HEARTBEAT_MS: '20' });
  const originalHighWater = runtime.store.getEventHighWater.bind(runtime.store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.store.getEventHighWater = async (input) => { await gate; return originalHighWater(input); };
  const responsePromise = fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 1 });
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 2 });
  runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor: 3 });
  release();
  const response = await responsePromise;
  const overflow = await collectSse(response, (text) => text.includes('resync_required'));
  const block = overflow.split('\n\n').find((part) => part.includes('resync_required'));
  assert.match(block, /event: resync_required/);
  assert.doesNotMatch(block, /^id:/m);

  runtime.store.getEventHighWater = originalHighWater;
  for (let index = 0; index < 3; index += 1) {
    await accept(runtime.store, runtime.owner, `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`, `durable ${index}`, new Date(Date.now() + index));
  }
  const reconnect = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const replay = await collectSse(reconnect, (text) => eventIds(text).length >= 3);
  assert.deepEqual(eventIds(replay), [1, 2, 3]);
});

test('turn api SSE bounds unique live notifications while a durable drain is slow', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_BUFFER_SIZE: '2', V1_SSE_HEARTBEAT_MS: '1000' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const originalHighWater = runtime.store.getEventHighWater.bind(runtime.store);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  runtime.store.getEventHighWater = async (input) => { await gate; return originalHighWater(input); };
  for (const cursor of [1, 2, 3, 4]) runtime.eventHub.publish({ conversationId: runtime.owner.conversation.id, cursor });
  release();
  const stream = await collectSse(response, (text) => text.includes('resync_required'));
  const resync = stream.split('\n\n').find((part) => part.includes('resync_required'));
  assert.ok(resync);
  assert.doesNotMatch(resync, /^id:/m);
});

test('turn api SSE heartbeat has no cursor and session deletion cleans listeners', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  const stream = await collectSse(response, (text) => text.includes(': heartbeat'));
  const heartbeatBlock = stream.split('\n\n').find((part) => part.includes(': heartbeat'));
  assert.doesNotMatch(heartbeatBlock, /^id:/m);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 0);

  const live = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 1);
  const deleted = await fetch(`${runtime.baseUrl}/api/v1/session`, { method: 'DELETE', headers: { Origin: ORIGIN, Cookie: runtime.cookie } });
  assert.equal(deleted.status, 200);
  await collectSse(live, () => false, 100);
  assert.equal(runtime.eventHub.listenerCount(runtime.owner.conversation.id), 0);
});

test('turn api SSE heartbeat recovers a persisted-before-publish event on an already-live stream', async (t) => {
  const runtime = await startSseApp(t, { V1_SSE_HEARTBEAT_MS: '20' });
  const response = await fetch(`${runtime.baseUrl}/api/v1/events?afterCursor=0`, { headers: { Cookie: runtime.cookie } });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await accept(runtime.store, runtime.owner, '40000000-0000-4000-8000-000000000000', 'persisted with missed publish', new Date());
  const stream = await collectSse(response, (text) => eventIds(text).includes(1));
  assert.deepEqual(eventIds(stream), [1]);
});

test('turn api SSE closes for replay on socket backpressure and emits resync_required without a cursor', async (t) => {
  const { store } = await createStore(t);
  const owner = await createOwnedConversation(store, 'backpressure');
  await accept(store, owner, '50000000-0000-4000-8000-000000000000', 'backpressure', new Date());
  const eventHub = new EventHub();
  const request = new EventEmitter();
  request.query = { afterCursor: '0' };
  request.get = () => undefined;
  const response = new EventEmitter();
  response.locals = { requestId: 'request-1' };
  response.writableEnded = false;
  response.destroyed = false;
  response.status = () => response;
  response.set = () => response;
  response.flushHeaders = () => {};
  const writes = [];
  response.write = (value) => {
    writes.push(value);
    return writes.length !== 2;
  };
  response.end = () => {
    response.writableEnded = true;
    response.emit('close');
  };
  const handler = createEventStreamHandler({ store, eventHub, resolveSession: async () => owner, pageSize: 2, bufferSize: 2, heartbeatMs: 20 });
  await handler(request, response);
  const deadline = Date.now() + 500;
  while (!response.writableEnded && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(response.writableEnded, true);
  const resync = writes.find((value) => value.includes('resync_required'));
  assert.ok(resync);
  assert.doesNotMatch(resync, /^id:/m);
  assert.equal(eventHub.listenerCount(owner.conversation.id), 0);
});
