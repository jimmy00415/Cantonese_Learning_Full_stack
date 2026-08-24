import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AtomicFileStore } from '../src/stores/atomic-file-store.js';

async function createStore(t) {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-store-'));
  const store = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await store.init();
  t.after(() => store.close());
  return { directory, store };
}

test('atomic store creates one conversation and resumes the same token', async (t) => {
  const { store } = await createStore(t);
  const first = await store.createOrResumeSession({ tokenHash: 'a'.repeat(64), now: '2026-08-25T00:00:00.000Z' });
  const resumed = await store.createOrResumeSession({ tokenHash: 'a'.repeat(64), now: '2026-08-25T00:00:01.000Z' });

  assert.equal(first.created, true);
  assert.equal(resumed.created, false);
  assert.equal(resumed.session.id, first.session.id);
  assert.equal(resumed.conversation.id, first.conversation.id);
});

test('atomic store accepts idempotent messages transactionally and preserves durable cursors', async (t) => {
  const { directory, store } = await createStore(t);
  const { session, conversation } = await store.createOrResumeSession({ tokenHash: 'b'.repeat(64), now: '2026-08-25T00:00:00.000Z' });
  const input = {
    sessionId: session.id,
    conversationId: conversation.id,
    clientMessageId: '11111111-1111-4111-8111-111111111111',
    requestHash: 'request-hash',
    text: '你好',
    voiceDraftId: null,
    now: '2026-08-25T00:00:01.000Z',
  };
  const accepted = await store.acceptMessage(input);
  const retry = await store.acceptMessage(input);
  const second = await store.acceptMessage({ ...input, clientMessageId: '22222222-2222-4222-8222-222222222222', requestHash: 'request-hash-2', text: '早晨' });

  assert.equal(accepted.message.sequence, 1);
  assert.equal(accepted.turn.state, 'accepted');
  assert.equal(accepted.event.cursor, 1);
  assert.equal(retry.idempotent, true);
  assert.equal(retry.message.id, accepted.message.id);
  assert.equal(second.message.sequence, 2);
  await assert.rejects(
    store.acceptMessage({ ...input, text: 'different', requestHash: 'different-hash' }),
    { code: 'IDEMPOTENCY_CONFLICT' },
  );

  await store.close();
  const reopened = new AtomicFileStore({ filePath: join(directory, 'store.json') });
  await reopened.init();
  t.after(() => reopened.close());
  const messages = await reopened.listMessages({ sessionId: session.id, conversationId: conversation.id, after: 1 });
  const events = await reopened.listEvents({ sessionId: session.id, conversationId: conversation.id, afterCursor: 0 });
  assert.deepEqual(messages.map((message) => message.sequence), [2]);
  assert.deepEqual(events.map((event) => event.cursor), [1, 2]);
});

test('atomic store rejects corruption and removes only owned session data', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-corrupt-'));
  const filePath = join(directory, 'store.json');
  await writeFile(filePath, '{not-json}', 'utf8');
  const corruptStore = new AtomicFileStore({ filePath });
  await assert.rejects(corruptStore.init(), /corrupt/i);

  const { store } = await createStore(t);
  const owner = await store.createOrResumeSession({ tokenHash: 'c'.repeat(64), now: '2026-08-25T00:00:00.000Z' });
  const other = await store.createOrResumeSession({ tokenHash: 'd'.repeat(64), now: '2026-08-25T00:00:00.000Z' });
  await store.acceptMessage({ sessionId: owner.session.id, conversationId: owner.conversation.id, clientMessageId: '33333333-3333-4333-8333-333333333333', requestHash: 'h', text: 'owner', now: '2026-08-25T00:00:01.000Z' });
  await assert.rejects(store.listMessages({ sessionId: other.session.id, conversationId: owner.conversation.id, after: 0 }), { code: 'NOT_FOUND' });
  await store.deleteSession({ sessionId: owner.session.id });
  assert.equal(await store.getSessionByTokenHash('c'.repeat(64)), null);
  assert.ok(await store.getSessionByTokenHash('d'.repeat(64)));
});

test('atomic store rejects persisted default chat quota boundaries without incrementing them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hb-v1-quota-'));
  const filePath = join(directory, 'store.json');
  const expiresAt = '2026-08-26T00:00:00.000Z';
  await writeFile(filePath, JSON.stringify({
    schemaVersion: 1, sessions: [], conversations: [], messages: [], turns: [], events: [], mediaAssets: [], serviceState: {},
    rateLimitBuckets: [
      { id: 'short', subjectHash: 'session-hash', quota: 'messages-5m', windowStart: '2026-08-25T00:00:00.000Z', count: 30, expiresAt },
      { id: 'daily', subjectHash: 'session-hash', quota: 'messages-day', windowStart: '2026-08-25T00:00:00.000Z', count: 300, expiresAt },
    ],
  }), 'utf8');
  const store = new AtomicFileStore({ filePath });
  await store.init();
  const short = await store.consumeRateLimit({ subjectHash: 'session-hash', quota: 'messages-5m', windowStart: '2026-08-25T00:00:00.000Z', limit: 30, expiresAt });
  const daily = await store.consumeRateLimit({ subjectHash: 'session-hash', quota: 'messages-day', windowStart: '2026-08-25T00:00:00.000Z', limit: 300, expiresAt });
  assert.deepEqual(short, { allowed: false, count: 30, expiresAt });
  assert.deepEqual(daily, { allowed: false, count: 300, expiresAt });
  await store.close();
});

test('atomic store serializes idle no-change claims without persisting or weakening claim races', async (t) => {
  const { directory, store } = await createStore(t);
  const filePath = join(directory, 'store.json');
  const before = await stat(filePath, { bigint: true });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const idleClaims = await Promise.all(Array.from({ length: 8 }, (_, index) => store.claimNextTurn({
    workerId: `idle-${index}`,
    leaseToken: `idle-token-${index}`,
    now: new Date(Date.parse('2026-08-25T00:00:00.000Z') + index),
    leaseUntil: new Date(Date.parse('2026-08-25T00:00:10.000Z') + index),
  })));
  const after = await stat(filePath, { bigint: true });
  assert.deepEqual(idleClaims, Array(8).fill(null));
  assert.equal(after.mtimeNs, before.mtimeNs);

  const owner = await store.createOrResumeSession({ tokenHash: 'idle-race-owner', now: '2026-08-25T00:01:00.000Z' });
  const acceptedPromise = store.acceptMessage({
    sessionId: owner.session.id,
    conversationId: owner.conversation.id,
    clientMessageId: '75000000-0000-4000-8000-000000000000',
    requestHash: 'idle-race-hash',
    text: 'race safely',
    now: '2026-08-25T00:01:01.000Z',
  });
  const firstClaimPromise = store.claimNextTurn({
    workerId: 'race-first', leaseToken: 'race-first-token',
    now: new Date('2026-08-25T00:01:02.000Z'), leaseUntil: new Date('2026-08-25T00:01:12.000Z'),
  });
  const secondClaimPromise = store.claimNextTurn({
    workerId: 'race-second', leaseToken: 'race-second-token',
    now: new Date('2026-08-25T00:01:02.000Z'), leaseUntil: new Date('2026-08-25T00:01:12.000Z'),
  });
  const [accepted, firstClaim, secondClaim] = await Promise.all([acceptedPromise, firstClaimPromise, secondClaimPromise]);
  assert.equal(firstClaim.id, accepted.turn.id);
  assert.equal(firstClaim.leaseToken, 'race-first-token');
  assert.equal(secondClaim, null);
});
