import assert from 'node:assert/strict';
import test from 'node:test';

import { createVoiceUploadCoordinator } from '../public/voice-upload-coordinator.js';

const START_MS = Date.parse('2026-08-25T08:00:00.000Z');
const SCOPE = 'scope-production-v1';
const UPLOAD_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT_ID = '22222222-2222-4222-8222-222222222222';
const SHA256 = 'a'.repeat(64);

function voiceOperation(overrides = {}) {
  return {
    clientUploadId: UPLOAD_ID,
    clientSessionScope: SCOPE,
    requestSha256: SHA256,
    mimeType: 'audio/wav',
    blob: new Blob([Uint8Array.from([82, 73, 70, 70, 1, 2, 3, 4])], { type: 'audio/wav' }),
    state: 'queued',
    postAuthorized: true,
    serverState: null,
    nextActionAt: START_MS,
    retryAfterAt: null,
    networkFailureCount: 0,
    transcript: null,
    voiceDraftId: null,
    failureCode: null,
    retryable: false,
    messageBinding: null,
    expiresAt: START_MS + 60 * 60 * 1_000,
    leaseOwnerId: null,
    leaseToken: null,
    leaseGeneration: 0,
    leaseExpiresAt: 0,
    ...overrides,
  };
}

function responseData(operation, patch = {}) {
  return {
    clientUploadId: operation.clientUploadId,
    requestSha256: operation.requestSha256,
    ...patch,
  };
}

function createClock(start = START_MS) {
  let current = start;
  const sleeps = [];
  return {
    sleeps,
    now: () => current,
    sleep: async (milliseconds, { signal } = {}) => {
      if (signal?.aborted) throw signal.reason;
      sleeps.push(milliseconds);
      current += milliseconds;
      if (signal?.aborted) throw signal.reason;
    },
  };
}

function createTransport({ get = [], post = [], remove = [] } = {}) {
  const calls = [];
  let sendMessageCalls = 0;

  async function take(kind, queue, input) {
    calls.push({ kind, input });
    if (queue.length === 0) throw new Error(`Unexpected ${kind} transport call`);
    const next = queue.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(input) : next;
  }

  return {
    calls,
    get sendMessageCalls() { return sendMessageCalls; },
    getUploadStatus: (input) => take('GET', get, input),
    postUpload: (input) => take('POST', post, input),
    deleteUpload: (input) => take('DELETE', remove, input),
    sendMessage: () => { sendMessageCalls += 1; },
  };
}

function createStore(initialOperation, { rejectWrites = false } = {}) {
  let operation = { ...initialOperation };
  let leaseSequence = 0;
  const calls = [];

  function leaseMatches(input) {
    return operation
      && operation.clientUploadId === input.clientUploadId
      && operation.clientSessionScope === input.clientSessionScope
      && operation.leaseOwnerId === input.workerId
      && operation.leaseToken === input.leaseToken
      && operation.leaseGeneration === input.leaseGeneration
      && operation.leaseExpiresAt > input.nowMs
      && (operation.expiresAt > input.nowMs || operation.state === 'cancel_pending');
  }

  function claim(input) {
    calls.push({ method: 'claim', input });
    if (!operation
      || operation.clientUploadId !== input.clientUploadId
      || operation.clientSessionScope !== input.clientSessionScope
      || operation.state === 'ready'
      || operation.state === 'terminal'
      || operation.leaseExpiresAt > input.nowMs) return null;
    leaseSequence += 1;
    operation = {
      ...operation,
      leaseOwnerId: input.workerId,
      leaseToken: `lease-${leaseSequence}`,
      leaseGeneration: operation.leaseGeneration + 1,
      leaseExpiresAt: operation.state === 'cancel_pending' && operation.expiresAt <= input.nowMs
        ? input.nowMs + 15_000
        : Math.min(input.nowMs + 15_000, operation.expiresAt),
    };
    return { ...operation };
  }

  function write(method, input) {
    calls.push({ method, input });
    if (rejectWrites || !leaseMatches(input)) return false;
    operation = { ...operation, ...input.patch };
    if (operation.state === 'ready') {
      operation = { ...operation, blob: null, leaseOwnerId: null, leaseToken: null, leaseExpiresAt: 0 };
    } else if (operation.state === 'terminal') {
      operation = {
        ...operation,
        blob: null,
        transcript: null,
        voiceDraftId: null,
        messageBinding: null,
        leaseOwnerId: null,
        leaseToken: null,
        leaseExpiresAt: 0,
      };
    }
    return { ...operation };
  }

  return {
    calls,
    snapshot: () => (operation ? { ...operation } : null),
    claimById: async (input) => claim(input),
    claimNext: async (input) => claim({ ...input, clientUploadId: operation?.clientUploadId }),
    renewLease: async (input) => {
      calls.push({ method: 'renewLease', input });
      if (!leaseMatches(input)) return false;
      operation = {
        ...operation,
        leaseExpiresAt: operation.state === 'cancel_pending' && operation.expiresAt <= input.nowMs
          ? input.nowMs + 15_000
          : Math.min(input.nowMs + 15_000, operation.expiresAt),
      };
      return { ...operation };
    },
    transition: async (input) => write('transition', input),
    writeResult: async (input) => write('writeResult', input),
    get: async (clientUploadId) => (
      operation?.clientUploadId === clientUploadId ? { ...operation } : undefined
    ),
    cancel: async (input) => {
      calls.push({ method: 'cancel', input });
      if (!operation
        || operation.clientUploadId !== input.clientUploadId
        || operation.clientSessionScope !== input.clientSessionScope
        || operation.messageBinding) return false;
      operation = {
        ...operation,
        state: 'cancel_pending',
        postAuthorized: false,
        blob: null,
        transcript: null,
        voiceDraftId: null,
        messageBinding: null,
        leaseOwnerId: null,
        leaseToken: null,
        leaseGeneration: operation.leaseGeneration + 1,
        leaseExpiresAt: 0,
      };
      return { ...operation };
    },
    consume: async (input) => {
      calls.push({ method: 'consume', input });
      if (!operation
        || operation.clientUploadId !== input.clientUploadId
        || operation.clientSessionScope !== input.clientSessionScope) return false;
      operation = null;
      return true;
    },
  };
}

function coordinatorFor({ operation = voiceOperation(), transport, clock = createClock(), storeOptions } = {}) {
  const store = createStore(operation, storeOptions);
  const coordinator = createVoiceUploadCoordinator({
    store,
    transport,
    clock,
    random: () => 'coordinator-worker',
  });
  return { coordinator, store, clock };
}

test('GET-first 404 uploads the exact durable identity once, polls Retry-After, and persists an editable draft with lease CAS', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [
      { status: 404, data: null },
      { status: 200, data: responseData(operation, {
        state: 'ready', transcript: 'Where is Academic Registry?', voiceDraftId: DRAFT_ID, retryable: false,
      }) },
    ],
    post: [{
      status: 202,
      data: responseData(operation, { state: 'uploading', retryable: false }),
      location: `/api/v1/voice/uploads/${UPLOAD_ID}`,
      retryAfter: '2',
    }],
  });
  const { coordinator, store, clock } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'ready');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'POST', 'GET']);
  assert.equal(transport.calls[1].input.clientUploadId, UPLOAD_ID);
  assert.equal(transport.calls[1].input.requestSha256, SHA256);
  assert.strictEqual(transport.calls[1].input.audio, operation.blob);
  assert.equal(transport.calls[1].input.mimeType, 'audio/wav');
  assert.deepEqual(clock.sleeps, [2_000]);
  const persisted = store.calls.findLast(({ method }) => method === 'writeResult');
  assert.deepEqual({
    clientUploadId: persisted.input.clientUploadId,
    clientSessionScope: persisted.input.clientSessionScope,
    workerId: persisted.input.workerId,
    leaseToken: persisted.input.leaseToken,
    leaseGeneration: persisted.input.leaseGeneration,
  }, {
    clientUploadId: UPLOAD_ID,
    clientSessionScope: SCOPE,
    workerId: 'coordinator-worker',
    leaseToken: 'lease-1',
    leaseGeneration: 1,
  });
  assert.deepEqual(persisted.input.patch, {
    state: 'ready',
    serverState: 'ready',
    transcript: 'Where is Academic Registry?',
    voiceDraftId: DRAFT_ID,
    failureCode: null,
    retryable: false,
  });
  assert.equal(transport.sendMessageCalls, 0, 'the coordinator never auto-sends transcript text');
});

test('existing processing status never POSTs and uses retryAfterMs before canonical GET becomes ready', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [
      { status: 202, data: responseData(operation, { state: 'transcribing', retryable: false }), retryAfterMs: 1_250 },
      { status: 200, data: responseData(operation, { state: 'ready', transcript: 'Ready text', voiceDraftId: DRAFT_ID }) },
    ],
  });
  const { coordinator, clock } = coordinatorFor({ operation, transport });

  const result = await coordinator.runNext({ clientSessionScope: SCOPE });

  assert.equal(result.state, 'ready');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'GET']);
  assert.deepEqual(clock.sleeps, [1_250]);
});

test('ready response with a mismatched durable identity fails closed without persisting transcript or POSTing', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{
      status: 200,
      data: { ...responseData(operation, { state: 'ready', transcript: 'Must not persist', voiceDraftId: DRAFT_ID }), requestSha256: 'b'.repeat(64) },
    }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'terminal');
  assert.equal(result.failureCode, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
  assert.equal(store.snapshot().transcript, null);
  assert.equal(store.snapshot().failureCode, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
});

test('manual retry confirms persisted retryable failure, POSTs the same tuple once, then GETs canonical status without a retry loop', async () => {
  const operation = voiceOperation({ state: 'retryable', retryable: true, failureCode: 'VOICE_ATTEMPT_EXPIRED' });
  const retryable = responseData(operation, {
    state: 'failed', failureCode: 'VOICE_ATTEMPT_EXPIRED', retryable: true,
  });
  const transport = createTransport({
    get: [
      { status: 200, data: retryable },
      { status: 200, data: retryable },
    ],
    post: [{
      status: 202,
      data: responseData(operation, { state: 'uploading', retryable: false }),
      retryAfterMs: 500,
    }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.retry({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'retryable');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'POST', 'GET']);
  assert.equal(transport.calls.filter(({ kind }) => kind === 'POST').length, 1);
  assert.strictEqual(transport.calls[1].input.audio, operation.blob);
  assert.equal(store.snapshot().failureCode, 'VOICE_ATTEMPT_EXPIRED');
});

test('permanent server failure becomes terminal and never uploads bytes', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 200, data: responseData(operation, {
      state: 'failed', failureCode: 'VOICE_INVALID_WAV', retryable: false,
    }) }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'terminal');
  assert.equal(result.failureCode, 'VOICE_INVALID_WAV');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
  assert.equal(store.snapshot().blob, null);
});

test('401 SESSION_NOT_FOUND is terminal and cannot replay old-scope audio into a replacement cookie session', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 401, data: null, error: { code: 'SESSION_NOT_FOUND' } }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.deepEqual(result, { state: 'terminal', failureCode: 'SESSION_NOT_FOUND' });
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
  assert.equal(store.snapshot().blob, null);
  assert.equal(store.snapshot().postAuthorized, false);
});

test('ordinary runById and runNext recovery persist server retryable failure but never authorize a POST', async () => {
  for (const method of ['runById', 'runNext']) {
    const operation = voiceOperation({ state: 'retryable', retryable: true, failureCode: 'VOICE_ATTEMPT_EXPIRED' });
    const transport = createTransport({
      get: [{ status: 200, data: responseData(operation, {
        state: 'failed', failureCode: 'VOICE_ATTEMPT_EXPIRED', retryable: true,
      }) }],
    });
    const { coordinator, store } = coordinatorFor({ operation, transport });

    const result = method === 'runById'
      ? await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE })
      : await coordinator.runNext({ clientSessionScope: SCOPE });

    assert.equal(result.state, 'retryable', method);
    assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET'], method);
    assert.equal(store.snapshot().failureCode, 'VOICE_ATTEMPT_EXPIRED', method);
  }
});

test('zero Retry-After is clamped to a positive 250ms wait so processing cannot hot-poll', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [
      { status: 202, data: responseData(operation, { state: 'transcribing', retryable: false }), retryAfterMs: 0 },
      { status: 200, data: responseData(operation, { state: 'ready', transcript: 'Ready after clamp', voiceDraftId: DRAFT_ID }) },
    ],
  });
  const { coordinator, clock } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'ready');
  assert.deepEqual(clock.sleeps, [250]);
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'GET']);
});

test('poll wait is bounded inside operation TTL and terminally clears audio before expiry instead of issuing a late GET', async () => {
  const operation = voiceOperation({ expiresAt: START_MS + 1_000 });
  const transport = createTransport({
    get: [{
      status: 202,
      data: responseData(operation, { state: 'transcribing', retryable: false }),
      retryAfterMs: 5_000,
    }],
  });
  const { coordinator, store, clock } = coordinatorFor({ operation, transport });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.deepEqual(result, { state: 'terminal', failureCode: 'VOICE_OPERATION_EXPIRED' });
  assert.deepEqual(clock.sleeps, [999]);
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
  assert.equal(store.snapshot().blob, null);
});

test('cancel checks server before DELETE and can never POST the recording', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 202, data: responseData(operation, { state: 'uploading', retryable: false }) }],
    remove: [{ status: 200, data: responseData(operation, {
      state: 'failed', failureCode: 'VOICE_UPLOAD_CANCELLED', retryable: false,
    }) }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.cancel({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.equal(result.state, 'terminal');
  assert.equal(result.failureCode, 'VOICE_UPLOAD_CANCELLED');
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'DELETE']);
  assert.equal(store.snapshot().state, 'terminal');
});

test('cancel 409 VOICE_DRAFT_ALREADY_ATTACHED consumes the local operation and never POSTs', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 200, data: responseData(operation, {
      state: 'ready', transcript: 'Already used', voiceDraftId: DRAFT_ID, retryable: false,
    }) }],
    remove: [{ status: 409, data: null, error: { code: 'VOICE_DRAFT_ALREADY_ATTACHED' } }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });

  const result = await coordinator.cancel({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.deepEqual(result, { state: 'consumed', failureCode: 'VOICE_DRAFT_ALREADY_ATTACHED' });
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET', 'DELETE']);
  assert.equal(store.snapshot(), null);
  assert.equal(store.calls.filter(({ method }) => method === 'consume').length, 1);
});

test('cancelled 410 is terminal without DELETE retry or POST', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 410, data: null, error: { code: 'VOICE_UPLOAD_CANCELLED' } }],
  });
  const { coordinator } = coordinatorFor({ operation, transport });

  const result = await coordinator.cancel({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.deepEqual(result, { state: 'terminal', failureCode: 'VOICE_UPLOAD_CANCELLED' });
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
});

test('dispose aborts active transport and fences a late ready completion from every durable write', async () => {
  const operation = voiceOperation();
  let resolveStatus;
  let observedSignal;
  let startedResolve;
  const started = new Promise((resolve) => { startedResolve = resolve; });
  const transport = createTransport({
    get: [({ signal }) => {
      observedSignal = signal;
      startedResolve();
      return new Promise((resolve) => { resolveStatus = resolve; });
    }],
  });
  const { coordinator, store } = coordinatorFor({ operation, transport });
  const running = coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });
  await started;

  coordinator.dispose();
  assert.equal(observedSignal.aborted, true);
  resolveStatus({ status: 200, data: responseData(operation, {
    state: 'ready', transcript: 'Late transcript', voiceDraftId: DRAFT_ID,
  }) });

  assert.deepEqual(await running, { state: 'disposed' });
  assert.equal(store.calls.some(({ method }) => method === 'writeResult' || method === 'transition'), false);
});

test('lease CAS rejection fences the current tab after GET and prevents further transport work', async () => {
  const operation = voiceOperation();
  const transport = createTransport({
    get: [{ status: 200, data: responseData(operation, {
      state: 'ready', transcript: 'Cannot win stale lease', voiceDraftId: DRAFT_ID,
    }) }],
  });
  const { coordinator, store } = coordinatorFor({
    operation,
    transport,
    storeOptions: { rejectWrites: true },
  });

  const result = await coordinator.runById({ clientUploadId: UPLOAD_ID, clientSessionScope: SCOPE });

  assert.deepEqual(result, { state: 'lease_lost' });
  assert.deepEqual(transport.calls.map(({ kind }) => kind), ['GET']);
  const write = store.calls.find(({ method }) => method === 'writeResult');
  assert.equal(write.input.workerId, 'coordinator-worker');
  assert.equal(write.input.leaseToken, 'lease-1');
  assert.equal(write.input.leaseGeneration, 1);
});
