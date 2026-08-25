import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import test from 'node:test';

import { IDBFactory } from 'fake-indexeddb';

import {
  VOICE_OPERATION_TTL_MS,
  createVoiceUploadStore,
} from '../public/voice-upload-store.js';

const START_MS = Date.parse('2026-08-25T08:00:00.000Z');
const SCOPE = 'scope-production-v1';

function uuidSequence(...values) {
  let index = 0;
  return () => values[index++] ?? `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function newStore({
  uuid = uuidSequence('11111111-1111-4111-8111-111111111111'),
  indexedDBImpl = new IDBFactory(),
  databaseName = `voice-store-${globalThis.crypto.randomUUID()}`,
} = {}) {
  return createVoiceUploadStore({
    databaseName,
    indexedDBImpl,
    cryptoImpl: webcrypto,
    uuid,
    now: () => START_MS,
  });
}

async function createStore(options = {}) {
  const store = newStore(options);
  await store.bindScope(SCOPE, { nowMs: START_MS });
  return store;
}

async function bindExisting(store, clientSessionScope, nowMs) {
  return store.bindScope(clientSessionScope, {
    nowMs,
    expectedActiveScope: await store.readActiveScope(),
  });
}

function wav(bytes = [82, 73, 70, 70, 1, 2, 3, 4]) {
  return new Blob([Uint8Array.from(bytes)], { type: 'audio/wav' });
}

async function blobBytes(blob) {
  return [...new Uint8Array(await blob.arrayBuffer())];
}

async function createBoundReadyOperation(store, {
  clientMessageId = '44444444-4444-4444-8444-444444444444',
  text = 'Where exactly is Academic Registry?',
  voiceDraftId = '33333333-3333-4333-8333-333333333333',
} = {}) {
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 700,
  });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-release-fixture',
    nowMs: START_MS,
  });
  await store.writeResult({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
    patch: { state: 'ready', transcript: 'Where is Academic Registry?', voiceDraftId },
  });
  const bound = await store.bindMessage({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    voiceDraftId,
    clientMessageId,
    text,
    nowMs: START_MS + 2,
  });
  return {
    bound,
    identity: {
      clientUploadId: operation.clientUploadId,
      clientSessionScope: SCOPE,
      voiceDraftId,
      clientMessageId,
      text,
    },
  };
}

test('commitRecording stores exact WAV identity atomically with lowercase SHA and fixed one-hour TTL', async () => {
  const store = await createStore();
  const audio = wav();

  const committed = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio,
    durationMs: 1_234,
  });

  assert.equal(committed.clientUploadId, '11111111-1111-4111-8111-111111111111');
  assert.match(committed.requestSha256, /^[0-9a-f]{64}$/);
  assert.equal(committed.requestSha256, 'c4ffde8d57d64bbc7a1220d8bf9560d208511252d9173d1359f5cf9a7b2f14dc');
  assert.equal(committed.mimeType, 'audio/wav');
  assert.equal(committed.byteLength, 8);
  assert.equal(committed.createdAt, START_MS);
  assert.equal(committed.expiresAt, START_MS + VOICE_OPERATION_TTL_MS);
  assert.equal(committed.state, 'queued');
  assert.deepEqual(await blobBytes(committed.blob), await blobBytes(audio));

  const durable = await store.get(committed.clientUploadId);
  assert.deepEqual(await blobBytes(durable.blob), await blobBytes(audio));
  assert.equal(durable.requestSha256, committed.requestSha256);
});

test('twenty concurrent claims produce exactly one live lease winner', async () => {
  const store = await createStore();
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 900,
  });

  const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: `worker-${index}`,
    nowMs: START_MS + 100,
  })));

  const winners = claims.filter(Boolean);
  assert.equal(winners.length, 1);
  assert.equal(winners[0].leaseGeneration, 1);
  assert.equal(winners[0].leaseExpiresAt, START_MS + 15_100);
  assert.match(winners[0].leaseToken, /^[0-9a-f-]{36}$/i);
});

test('expired lease can be taken over and stale leader completion cannot overwrite the winner', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ),
  });
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 1_000,
  });
  const first = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-old',
    nowMs: START_MS,
  });
  const second = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-new',
    nowMs: START_MS + 15_001,
  });

  assert.equal(second.leaseGeneration, first.leaseGeneration + 1);
  assert.notEqual(second.leaseToken, first.leaseToken);
  assert.equal(await store.transition({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: first.leaseOwnerId,
    leaseToken: first.leaseToken,
    leaseGeneration: first.leaseGeneration,
    nowMs: START_MS + 15_002,
    patch: { state: 'terminal', failureCode: 'STALE_RESULT' },
  }), false);
  assert.ok(await store.transition({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: second.leaseOwnerId,
    leaseToken: second.leaseToken,
    leaseGeneration: second.leaseGeneration,
    nowMs: START_MS + 15_002,
    patch: { state: 'polling', serverState: 'transcribing' },
  }));

  const durable = await store.get(operation.clientUploadId);
  assert.equal(durable.state, 'polling');
  assert.equal(durable.failureCode, null);
});

test('new same-scope recording atomically supersedes old unfinished recording and clears sensitive fields', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
    ),
  });
  const first = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav([1, 2, 3, 4]),
    durationMs: 800,
  });
  const lease = await store.claimById({
    clientUploadId: first.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-first',
    nowMs: START_MS,
  });
  await store.writeResult({
    clientUploadId: first.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 10,
    patch: {
      state: 'ready',
      transcript: 'Private transcript',
      voiceDraftId: '33333333-3333-4333-8333-333333333333',
    },
  });

  const second = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav([5, 6, 7, 8]),
    durationMs: 700,
  });
  const superseded = await store.get(first.clientUploadId);

  assert.equal(second.clientUploadId, '22222222-2222-4222-8222-222222222222');
  assert.equal(superseded.state, 'cancel_pending');
  assert.equal(superseded.blob, null);
  assert.equal(superseded.transcript, null);
  assert.equal(superseded.voiceDraftId, null);
  assert.equal(superseded.messageBinding, null);
  assert.equal(superseded.leaseOwnerId, null);
  assert.equal(superseded.leaseToken, null);
  assert.equal(superseded.leaseExpiresAt, 0);
  assert.ok(superseded.leaseGeneration > lease.leaseGeneration);
  assert.equal((await store.listByScope(SCOPE)).length, 2);
});

test('an aborted duplicate-key transaction leaves the previous operation unchanged', async () => {
  const duplicateId = '11111111-1111-4111-8111-111111111111';
  const store = await createStore({ uuid: () => duplicateId });
  const first = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav([1, 2, 3, 4]),
    durationMs: 500,
  });

  await assert.rejects(store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav([9, 9, 9, 9]),
    durationMs: 600,
  }), (error) => error?.name === 'ConstraintError');

  const durable = await store.get(first.clientUploadId);
  assert.equal(durable.state, 'queued');
  assert.equal(durable.leaseGeneration, 0);
  assert.deepEqual(await blobBytes(durable.blob), [1, 2, 3, 4]);
  assert.equal((await store.listByScope(SCOPE)).length, 1);
});

test('cancel clears sensitive data, preserves a cleanup tombstone, and fences the old lease', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ),
  });
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 1_000,
  });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-old',
    nowMs: START_MS,
  });
  await store.writeResult({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
    patch: { state: 'polling', transcript: 'Sensitive partial text' },
  });

  const cancelled = await store.cancel({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    nowMs: START_MS + 2,
  });
  assert.equal(cancelled.state, 'cancel_pending');
  assert.equal(cancelled.blob, null);
  assert.equal(cancelled.transcript, null);
  assert.equal(cancelled.postAuthorized, false);
  assert.equal(cancelled.leaseOwnerId, null);
  assert.ok(cancelled.leaseGeneration > lease.leaseGeneration);
  assert.equal(await store.transition({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 3,
    patch: { state: 'ready' },
  }), false);

  const cleanupLease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-cleanup',
    nowMs: START_MS + 3,
  });
  assert.equal(cleanupLease.state, 'cancel_pending');
  assert.equal(cleanupLease.blob, null);
});

test('scope binding purges mismatches before work and clearScope fences every late writer', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 1_000,
  });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-old',
    nowMs: START_MS,
  });

  assert.deepEqual(await store.bindScope('scope-new', { nowMs: START_MS + 1 }), { purged: 1, expired: 0 });
  assert.equal(await store.get(operation.clientUploadId), undefined);
  assert.equal(await store.writeResult({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 2,
    patch: { state: 'ready', transcript: 'Must not return' },
  }), false);

  const replacement = await store.commitRecording({
    clientSessionScope: 'scope-new',
    audio: wav([5, 6, 7]),
    durationMs: 500,
  });
  const replacementLease = await store.claimById({
    clientUploadId: replacement.clientUploadId,
    clientSessionScope: 'scope-new',
    workerId: 'worker-new',
    nowMs: START_MS + 3,
  });
  assert.equal(await store.clearScope('scope-new'), 1);
  assert.equal(await store.transition({
    clientUploadId: replacement.clientUploadId,
    clientSessionScope: 'scope-new',
    workerId: replacementLease.leaseOwnerId,
    leaseToken: replacementLease.leaseToken,
    leaseGeneration: replacementLease.leaseGeneration,
    nowMs: START_MS + 4,
    patch: { state: 'polling' },
  }), false);
});

test('TTL expiry removes sensitive fields but retains a claimable remote-cancel tombstone', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    ),
  });
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 1_000,
  });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-old',
    nowMs: operation.expiresAt - 100,
  });

  assert.deepEqual(await store.bindScope(SCOPE, { nowMs: operation.expiresAt }), { purged: 0, expired: 1 });
  const expired = await store.get(operation.clientUploadId);
  assert.equal(expired.state, 'cancel_pending');
  assert.equal(expired.blob, null);
  assert.equal(expired.transcript, null);
  assert.equal(expired.expiresAt, START_MS + VOICE_OPERATION_TTL_MS);
  assert.ok(expired.leaseGeneration > lease.leaseGeneration);
  assert.equal(await store.transition({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: operation.expiresAt + 1,
    patch: { state: 'ready' },
  }), false);
  assert.ok(await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker-cleanup',
    nowMs: operation.expiresAt + 1,
  }));
});

test('lease renewal is exact-CAS and cannot be extended beyond the sensitive-data TTL', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const operation = await store.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav(),
    durationMs: 1_000,
  });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: operation.expiresAt - 10_000,
  });
  const renewed = await store.renewLease({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: operation.expiresAt - 9_000,
  });
  assert.equal(renewed.leaseExpiresAt, operation.expiresAt);
  assert.equal(await store.renewLease({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
    leaseGeneration: lease.leaseGeneration,
    nowMs: operation.expiresAt - 8_000,
  }), false);
});

test('claimNext prioritizes remote cancellation before starting the replacement upload', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      '22222222-2222-4222-8222-222222222222',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  await store.commitRecording({ clientSessionScope: SCOPE, audio: wav([1]), durationMs: 100 });
  await store.commitRecording({ clientSessionScope: SCOPE, audio: wav([2]), durationMs: 100 });

  const claimed = await store.claimNext({
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: START_MS + 1,
  });
  assert.equal(claimed.clientUploadId, '11111111-1111-4111-8111-111111111111');
  assert.equal(claimed.state, 'cancel_pending');
});

test('ready transcript can be durably bound to one exact outgoing message before network send', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const operation = await store.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 700 });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: START_MS,
  });
  const voiceDraftId = '33333333-3333-4333-8333-333333333333';
  await store.writeResult({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
    patch: { state: 'ready', transcript: 'Where is Academic Registry?', voiceDraftId },
  });

  const bound = await store.bindMessage({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    voiceDraftId,
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Where exactly is Academic Registry?',
    nowMs: START_MS + 2,
  });
  assert.deepEqual(bound.messageBinding, {
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Where exactly is Academic Registry?',
    replyLanguage: 'en',
    replyMode: 'text',
  });
  assert.deepEqual((await store.get(operation.clientUploadId)).messageBinding, bound.messageBinding);
  assert.equal(await store.bindMessage({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    voiceDraftId: '55555555-5555-4555-8555-555555555555',
    clientMessageId: '66666666-6666-4666-8666-666666666666',
    text: 'Must not overwrite',
    nowMs: START_MS + 3,
  }), false);
});

test('releaseMessageBinding atomically clears only the exact current binding and preserves the ready draft', async () => {
  const store = await createStore();
  const { bound, identity } = await createBoundReadyOperation(store);

  for (const mismatch of [
    { clientUploadId: '99999999-9999-4999-8999-999999999999' },
    { clientSessionScope: 'scope-other' },
    { voiceDraftId: '88888888-8888-4888-8888-888888888888' },
    { clientMessageId: '77777777-7777-4777-8777-777777777777' },
    { text: 'Different exact text' },
  ]) {
    assert.equal(await store.releaseMessageBinding({
      ...identity,
      ...mismatch,
      nowMs: START_MS + 3,
    }), false);
    assert.deepEqual((await store.get(identity.clientUploadId)).messageBinding, bound.messageBinding);
  }

  const released = await store.releaseMessageBinding({ ...identity, nowMs: START_MS + 4 });

  assert.equal(released.messageBinding, null);
  assert.equal(released.state, 'ready');
  assert.equal(released.voiceDraftId, identity.voiceDraftId);
  assert.equal(released.transcript, 'Where is Academic Registry?');
  assert.equal(released.blob, bound.blob);
  assert.equal(released.revision, bound.revision + 1);
  assert.equal((await store.get(identity.clientUploadId)).messageBinding, null);
  assert.equal(await store.releaseMessageBinding({ ...identity, nowMs: START_MS + 5 }), false);
});

test('releaseMessageBinding is generation-fenced and only one concurrent exact release can win', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-binding-release-${globalThis.crypto.randomUUID()}`;
  const firstTab = newStore({ indexedDBImpl, databaseName });
  const secondTab = newStore({ indexedDBImpl, databaseName });
  await firstTab.bindScope(SCOPE, { nowMs: START_MS });
  await bindExisting(secondTab, SCOPE, START_MS);
  const { identity } = await createBoundReadyOperation(firstTab);

  const outcomes = await Promise.all([
    firstTab.releaseMessageBinding({ ...identity, nowMs: START_MS + 3 }),
    secondTab.releaseMessageBinding({ ...identity, nowMs: START_MS + 3 }),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal((await firstTab.get(identity.clientUploadId)).messageBinding, null);

  await firstTab.clearScope(SCOPE);
  await bindExisting(firstTab, SCOPE, START_MS + 4);
  const replacement = await createBoundReadyOperation(firstTab, {
    clientMessageId: '66666666-6666-4666-8666-666666666666',
    text: 'Replacement binding',
    voiceDraftId: '55555555-5555-4555-8555-555555555555',
  });
  assert.equal(await secondTab.releaseMessageBinding({
    ...replacement.identity,
    nowMs: START_MS + 5,
  }), false);
  assert.deepEqual(
    (await firstTab.get(replacement.identity.clientUploadId)).messageBinding,
    { clientMessageId: '66666666-6666-4666-8666-666666666666', text: 'Replacement binding', replyLanguage: 'en', replyMode: 'text' },
  );
});

test('a new recording never erases a ready draft already bound to an ambiguously sent message', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      '22222222-2222-4222-8222-222222222222',
    ),
  });
  const first = await store.commitRecording({ clientSessionScope: SCOPE, audio: wav([1]), durationMs: 100 });
  const lease = await store.claimById({
    clientUploadId: first.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: START_MS,
  });
  const voiceDraftId = '33333333-3333-4333-8333-333333333333';
  await store.writeResult({
    clientUploadId: first.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
    patch: { state: 'ready', transcript: 'Bound transcript', voiceDraftId },
  });
  await store.bindMessage({
    clientUploadId: first.clientUploadId,
    clientSessionScope: SCOPE,
    voiceDraftId,
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Edited and sent, response not confirmed',
    nowMs: START_MS + 2,
  });

  await store.commitRecording({ clientSessionScope: SCOPE, audio: wav([2]), durationMs: 100 });
  const stillBound = await store.get(first.clientUploadId);
  assert.equal(stillBound.state, 'ready');
  assert.equal(stillBound.voiceDraftId, voiceDraftId);
  assert.deepEqual(stillBound.messageBinding, {
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Edited and sent, response not confirmed',
    replyLanguage: 'en',
    replyMode: 'text',
  });
});

test('same-scope bootstrap preserves an active expired-tombstone cleanup lease', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const operation = await store.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });
  await store.cancel({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    nowMs: operation.expiresAt,
  });
  const cleanupLease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'cleanup-worker',
    nowMs: operation.expiresAt + 1,
  });

  assert.deepEqual(await store.bindScope(SCOPE, { nowMs: operation.expiresAt + 2 }), { purged: 0, expired: 0 });
  const preserved = await store.get(operation.clientUploadId);
  assert.equal(preserved.leaseToken, cleanupLease.leaseToken);
  assert.equal(preserved.leaseGeneration, cleanupLease.leaseGeneration);
  assert.ok(await store.transition({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: cleanupLease.leaseOwnerId,
    leaseToken: cleanupLease.leaseToken,
    leaseGeneration: cleanupLease.leaseGeneration,
    nowMs: operation.expiresAt + 3,
    patch: { state: 'terminal', failureCode: 'VOICE_UPLOAD_CANCELLED' },
  }));
});

test('lease-bound provider results cannot replace canonical bytes or bypass exact message binding', async () => {
  const store = await createStore({
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const operation = await store.commitRecording({ clientSessionScope: SCOPE, audio: wav([1, 2, 3]), durationMs: 100 });
  const lease = await store.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: START_MS,
  });
  const identity = {
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
  };

  await assert.rejects(
    store.writeResult({ ...identity, patch: { blob: wav([9, 9, 9]) } }),
    /field cannot be changed: blob/,
  );
  await assert.rejects(
    store.writeResult({
      ...identity,
      patch: { messageBinding: { clientMessageId: 'forged', text: 'forged' } },
    }),
    /field cannot be changed: messageBinding/,
  );

  const durable = await store.get(operation.clientUploadId);
  assert.deepEqual(await blobBytes(durable.blob), [1, 2, 3]);
  assert.equal(durable.requestSha256, operation.requestSha256);
  assert.equal(durable.messageBinding, null);
});

test('durable active-scope generation fences old tabs across replacement and same-scope clear', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-scope-fence-${globalThis.crypto.randomUUID()}`;
  const oldTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence('11111111-1111-4111-8111-111111111111'),
  });
  const currentTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence(
      '22222222-2222-4222-8222-222222222222',
      '33333333-3333-4333-8333-333333333333',
    ),
  });
  await oldTab.bindScope(SCOPE, { nowMs: START_MS });
  await bindExisting(currentTab, SCOPE, START_MS);
  await oldTab.commitRecording({ clientSessionScope: SCOPE, audio: wav([1]), durationMs: 100 });

  await currentTab.bindScope('scope-new', { nowMs: START_MS + 1 });
  await assert.rejects(
    oldTab.bindScope(SCOPE, { nowMs: START_MS + 1 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await assert.rejects(
    oldTab.commitRecording({ clientSessionScope: SCOPE, audio: wav([2]), durationMs: 100 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await currentTab.commitRecording({ clientSessionScope: 'scope-new', audio: wav([3]), durationMs: 100 });

  const sameScopeStaleTab = newStore({ indexedDBImpl, databaseName });
  await bindExisting(sameScopeStaleTab, 'scope-new', START_MS + 2);
  assert.equal(await currentTab.clearScope('scope-new'), 1);
  await assert.rejects(
    sameScopeStaleTab.bindScope('scope-new', { nowMs: START_MS + 2 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await assert.rejects(
    oldTab.commitRecording({ clientSessionScope: 'scope-new', audio: wav([4]), durationMs: 100 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await assert.rejects(
    currentTab.commitRecording({ clientSessionScope: 'scope-new', audio: wav([5]), durationMs: 100 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );

  await bindExisting(currentTab, 'scope-new', START_MS + 3);
  const afterRebind = await currentTab.commitRecording({
    clientSessionScope: 'scope-new',
    audio: wav([6]),
    durationMs: 100,
  });
  assert.equal(afterRebind.clientSessionScope, 'scope-new');
});

test('twenty claims across two independent database connections still have one winner', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-two-tabs-${globalThis.crypto.randomUUID()}`;
  const firstTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const secondTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  });
  await firstTab.bindScope(SCOPE, { nowMs: START_MS });
  await bindExisting(secondTab, SCOPE, START_MS);
  const operation = await firstTab.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });

  const claims = await Promise.all(Array.from({ length: 20 }, (_, index) => (
    index % 2 === 0 ? firstTab : secondTab
  ).claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: `worker-${index}`,
    nowMs: START_MS + 1,
  })));
  assert.equal(claims.filter(Boolean).length, 1);
});

test('ready transition clears canonical audio and lease, while exact binding is concurrent-idempotent and consumable', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-binding-${globalThis.crypto.randomUUID()}`;
  const firstTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  const secondTab = newStore({ indexedDBImpl, databaseName });
  await firstTab.bindScope(SCOPE, { nowMs: START_MS });
  await bindExisting(secondTab, SCOPE, START_MS);
  const operation = await firstTab.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });
  const lease = await firstTab.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'worker',
    nowMs: START_MS,
  });
  const voiceDraftId = '33333333-3333-4333-8333-333333333333';
  const ready = await firstTab.writeResult({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: lease.leaseOwnerId,
    leaseToken: lease.leaseToken,
    leaseGeneration: lease.leaseGeneration,
    nowMs: START_MS + 1,
    patch: { state: 'ready', transcript: 'Ready text', voiceDraftId },
  });
  assert.equal(ready.blob, null);
  assert.equal(ready.leaseOwnerId, null);
  assert.equal(ready.leaseToken, null);
  assert.equal(ready.leaseExpiresAt, 0);

  const binding = {
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    voiceDraftId,
    clientMessageId: '44444444-4444-4444-8444-444444444444',
    text: 'Exact edited text',
    nowMs: START_MS + 2,
  };
  const [first, second] = await Promise.all([
    firstTab.bindMessage(binding),
    secondTab.bindMessage(binding),
  ]);
  assert.deepEqual(first.messageBinding, second.messageBinding);
  assert.equal(await secondTab.bindMessage({
    ...binding,
    clientMessageId: '55555555-5555-4555-8555-555555555555',
  }), false);
  assert.equal(await secondTab.cancel({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    nowMs: START_MS + 3,
  }), false);
  assert.deepEqual((await firstTab.get(operation.clientUploadId)).messageBinding, first.messageBinding);
  assert.equal(await firstTab.consume({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
  }), true);
  assert.equal(await secondTab.consume({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
  }), false);
});

test('stale same-scope tab cannot claim or cancel operations created after a clear generation fence', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-clear-fence-${globalThis.crypto.randomUUID()}`;
  const staleTab = newStore({ indexedDBImpl, databaseName });
  const currentTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence(
      '11111111-1111-4111-8111-111111111111',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    ),
  });
  await staleTab.bindScope(SCOPE, { nowMs: START_MS });
  await bindExisting(currentTab, SCOPE, START_MS);
  await currentTab.clearScope(SCOPE);
  await bindExisting(currentTab, SCOPE, START_MS + 1);
  const operation = await currentTab.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });

  assert.equal(await staleTab.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'stale-worker',
    nowMs: START_MS + 2,
  }), null);
  assert.equal(await staleTab.cancel({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    nowMs: START_MS + 2,
  }), false);
  assert.ok(await currentTab.claimById({
    clientUploadId: operation.clientUploadId,
    clientSessionScope: SCOPE,
    workerId: 'current-worker',
    nowMs: START_MS + 2,
  }));
});

test('schema, indexes, dispose fence, and reopen preserve the durable operation contract', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-schema-${globalThis.crypto.randomUUID()}`;
  const first = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence('11111111-1111-4111-8111-111111111111'),
  });
  await first.bindScope(SCOPE, { nowMs: START_MS });
  const operation = await first.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });
  await first.dispose();
  await assert.rejects(
    first.commitRecording({ clientSessionScope: SCOPE, audio: wav([9]), durationMs: 100 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );

  const reopened = newStore({ indexedDBImpl, databaseName });
  await bindExisting(reopened, SCOPE, START_MS + 1);
  assert.equal((await reopened.get(operation.clientUploadId)).schemaVersion, 1);
  await reopened.dispose();

  const database = await new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(databaseName);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  assert.equal(database.version, 2);
  assert.equal(database.objectStoreNames.contains('voice_upload_operations'), true);
  assert.equal(database.objectStoreNames.contains('voice_upload_metadata'), true);
  const transaction = database.transaction('voice_upload_operations', 'readonly');
  const objectStore = transaction.objectStore('voice_upload_operations');
  assert.equal(objectStore.keyPath, 'clientUploadId');
  assert.equal(objectStore.indexNames.contains('clientSessionScope'), true);
  assert.equal(objectStore.indexNames.contains('expiresAt'), true);
  database.close();
});

test('dispose during a pending digest fences commit before any Blob can reach IndexedDB', async () => {
  let resolveDigest;
  let markDigestStarted;
  const digestStarted = new Promise((resolve) => { markDigestStarted = resolve; });
  const digestPending = new Promise((resolve) => { resolveDigest = resolve; });
  const store = createVoiceUploadStore({
    databaseName: `voice-dispose-race-${globalThis.crypto.randomUUID()}`,
    indexedDBImpl: new IDBFactory(),
    cryptoImpl: {
      randomUUID: () => '11111111-1111-4111-8111-111111111111',
      subtle: {
        digest() {
          markDigestStarted();
          return digestPending;
        },
      },
    },
    uuid: () => '11111111-1111-4111-8111-111111111111',
    now: () => START_MS,
  });
  await store.bindScope(SCOPE, { nowMs: START_MS });

  const commit = store.commitRecording({ clientSessionScope: SCOPE, audio: wav(), durationMs: 100 });
  await digestStarted;
  await store.dispose();
  resolveDigest(new Uint8Array(32).buffer);

  await assert.rejects(commit, (error) => error?.code === 'VOICE_SCOPE_FENCED');
  assert.deepEqual(await store.listByScope(SCOPE), []);
});

test('fresh-instance scope replacement requires an exact active-metadata CAS handoff', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-bootstrap-cas-${globalThis.crypto.randomUUID()}`;
  const authoritativeTab = newStore({ indexedDBImpl, databaseName });
  const freshTab = newStore({ indexedDBImpl, databaseName });
  await authoritativeTab.bindScope(SCOPE, { nowMs: START_MS });
  const expectedOld = await freshTab.readActiveScope();

  await assert.rejects(
    freshTab.bindScope(SCOPE, { nowMs: START_MS + 1 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await assert.rejects(
    freshTab.bindScope('scope-new', { nowMs: START_MS + 1 }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );
  await authoritativeTab.bindScope('scope-current', { nowMs: START_MS + 2 });
  await assert.rejects(
    freshTab.bindScope('scope-new', {
      nowMs: START_MS + 3,
      expectedActiveScope: expectedOld,
    }),
    (error) => error?.code === 'VOICE_SCOPE_FENCED',
  );

  const expectedCurrent = await freshTab.readActiveScope();
  assert.deepEqual(await freshTab.bindScope('scope-new', {
    nowMs: START_MS + 4,
    expectedActiveScope: expectedCurrent,
  }), { purged: 0, expired: 0 });
  assert.deepEqual(await freshTab.readActiveScope(), {
    clientSessionScope: 'scope-new',
    scopeGeneration: expectedCurrent.scopeGeneration + 1,
  });
});

test('dispose before bind transaction activation cannot mutate active scope or delete durable audio', async () => {
  const indexedDBImpl = new IDBFactory();
  const databaseName = `voice-bind-dispose-${globalThis.crypto.randomUUID()}`;
  const currentTab = newStore({
    indexedDBImpl,
    databaseName,
    uuid: uuidSequence('11111111-1111-4111-8111-111111111111'),
  });
  const freshTab = newStore({ indexedDBImpl, databaseName });
  await currentTab.bindScope(SCOPE, { nowMs: START_MS });
  const operation = await currentTab.commitRecording({
    clientSessionScope: SCOPE,
    audio: wav([1, 2, 3]),
    durationMs: 100,
  });
  const expectedActiveScope = await freshTab.readActiveScope();

  const pendingBind = freshTab.bindScope('scope-new', {
    nowMs: START_MS + 1,
    expectedActiveScope,
  });
  await freshTab.dispose();
  await assert.rejects(pendingBind, (error) => error?.code === 'VOICE_SCOPE_FENCED');

  assert.deepEqual(await currentTab.readActiveScope(), expectedActiveScope);
  assert.deepEqual(await blobBytes((await currentTab.get(operation.clientUploadId)).blob), [1, 2, 3]);
});
