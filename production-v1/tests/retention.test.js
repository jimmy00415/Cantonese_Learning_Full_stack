import assert from 'node:assert/strict';
import test from 'node:test';

import { createMediaCleanupService } from '../src/services/media-cleanup.js';
import {
  createRetentionService,
  retentionPolicyDefaults,
  retentionReadinessSnapshot,
  runRetentionOnce,
  startRetentionWorker,
} from '../src/services/retention.js';
import {
  createRetentionCommandRuntime,
  runRetentionCleanupCommand,
} from '../scripts/retention-cleanup.js';

const DAY_MS = 24 * 60 * 60 * 1_000;

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function settleWithin(operation, timeoutMs, message) {
  return Promise.race([
    operation,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

class FakeRetentionStore {
  constructor({ order = [], purgeResult, purgeError, purgeOperation } = {}) {
    this.order = order;
    this.purgeResult = purgeResult ?? {
      anonymousSessionsPurged: 2,
      voiceAssetsRevoked: 1,
      deletionJobsQueued: 1,
    };
    this.purgeError = purgeError;
    this.purgeOperation = purgeOperation;
    this.state = null;
    this.purgeInputs = [];
    this.successInputs = [];
    this.stoppedInputs = [];
    this.pendingMediaDeletions = false;
  }

  async recordRetentionHeartbeat(input) {
    this.order.push('heartbeat');
    this.state = {
      service: 'retention',
      workerId: input.workerId,
      runToken: input.runToken,
      heartbeatAt: new Date(input.heartbeatAt).toISOString(),
      lastSuccessAt: this.state?.lastSuccessAt ?? null,
      stoppedAt: null,
      policyVersion: input.policy.version,
    };
    return { ...this.state };
  }

  async purgeExpired(input) {
    this.order.push('purge');
    this.purgeInputs.push(input);
    if (this.purgeError) throw this.purgeError;
    if (this.purgeOperation) return this.purgeOperation(input);
    return this.purgeResult;
  }

  async recordRetentionSuccess(input) {
    this.order.push('success');
    if (this.state?.runToken !== input.runToken || this.state?.stoppedAt) {
      throw codedError('RETENTION_RUN_FENCED');
    }
    this.successInputs.push(input);
    this.state.lastSuccessAt = new Date(input.lastSuccessAt).toISOString();
    return { ...this.state };
  }

  async recordRetentionStopped(input) {
    this.order.push('stopped');
    this.stoppedInputs.push(input);
    if (this.state?.workerId === input.workerId) {
      this.state.stoppedAt = new Date(input.stoppedAt).toISOString();
    }
    return { ...this.state };
  }

  async getRetentionState() {
    return this.state ? { ...this.state } : null;
  }

  async hasPendingMediaDeletions() {
    return this.pendingMediaDeletions;
  }
}

function idleCleanup(order = []) {
  return {
    drainOnce: async () => {
      order.push('media');
      return { completed: false, idle: true };
    },
  };
}

test('retention defaults, cutoffs, and durable ordering are clock-injected', async () => {
  const order = [];
  const nowValues = [
    new Date('2026-08-31T12:00:00.000Z'),
    new Date('2026-08-31T12:00:02.000Z'),
    new Date('2026-08-31T12:00:03.000Z'),
  ];
  const store = new FakeRetentionStore({ order });
  let mediaCalls = 0;
  const mediaCleanup = {
    drainOnce: async () => {
      order.push('media');
      mediaCalls += 1;
      return mediaCalls === 1
        ? { completed: true, storageKey: 'voice/expired.wav' }
        : { completed: false, idle: true };
    },
  };

  const result = await runRetentionOnce({
    store,
    mediaCleanup,
    now: () => nowValues.shift(),
  });

  assert.deepEqual(order, ['heartbeat', 'purge', 'media', 'media', 'success', 'stopped']);
  assert.equal(retentionPolicyDefaults.anonymousTextEventMs, 30 * DAY_MS);
  assert.equal(retentionPolicyDefaults.voiceMediaMs, 7 * DAY_MS);
  assert.equal(store.purgeInputs[0].anonymousBefore.toISOString(), '2026-08-01T12:00:00.000Z');
  assert.equal(store.purgeInputs[0].voiceBefore.toISOString(), '2026-08-24T12:00:00.000Z');
  assert.equal(store.purgeInputs[0].now.toISOString(), '2026-08-31T12:00:00.000Z');
  assert.equal(store.successInputs.length, 1);
  assert.equal(store.successInputs[0].lastSuccessAt.toISOString(), '2026-08-31T12:00:02.000Z');
  assert.deepEqual(result, {
    ok: true,
    purged: store.purgeResult,
    media: { completed: 1, idle: true },
    heartbeatAt: '2026-08-31T12:00:00.000Z',
    lastSuccessAt: '2026-08-31T12:00:02.000Z',
  });
});

test('database failure leaves heartbeat durable and never records cleanup success', async () => {
  const order = [];
  const store = new FakeRetentionStore({ order, purgeError: codedError('DATABASE_UNAVAILABLE') });
  const service = createRetentionService({
    store,
    mediaCleanup: idleCleanup(order),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  await assert.rejects(service.runOnce(), { code: 'DATABASE_UNAVAILABLE' });
  assert.deepEqual(order, ['heartbeat', 'purge']);
  assert.equal(store.state.heartbeatAt, '2026-08-31T12:00:00.000Z');
  assert.equal(store.state.lastSuccessAt, null);
});

test('retryable media deletion prevents a false retention success', async () => {
  const order = [];
  const store = new FakeRetentionStore({ order });
  store.pendingMediaDeletions = true;
  let mediaCalls = 0;
  const service = createRetentionService({
    store,
    mediaCleanup: {
      drainOnce: async () => {
        order.push('media');
        mediaCalls += 1;
        return mediaCalls === 1
          ? { completed: false, retryable: true, storageKey: 'voice/retry.wav' }
          : { completed: false, idle: true };
      },
    },
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  await assert.rejects(service.runOnce(), (error) => (
    error.code === 'RETENTION_MEDIA_INCOMPLETE'
      && error.reason === 'retryable'
      && !('storageKey' in error)
  ));
  await assert.rejects(service.runOnce(), (error) => (
    error.code === 'RETENTION_MEDIA_INCOMPLETE' && error.reason === 'pending'
  ));
  assert.deepEqual(order, ['heartbeat', 'purge', 'media', 'heartbeat', 'purge', 'media']);
  assert.equal(store.successInputs.length, 0);
});

test('object-not-found is completed idempotently by the existing media cleanup service', async () => {
  const order = [];
  const store = new FakeRetentionStore({
    order,
    purgeResult: { anonymousSessionsPurged: 0, voiceAssetsRevoked: 1, deletionJobsQueued: 1 },
  });
  const job = {
    id: 'deletion-job-1',
    generation: 1,
    storageKey: 'voice/already-gone.wav',
  };
  let claimed = false;
  let completed = false;
  store.claimNextMediaDeletion = async () => {
    order.push('claim-media');
    if (claimed) return null;
    claimed = true;
    return job;
  };
  store.isStorageKeyLive = async () => false;
  store.completeMediaDeletion = async ({ jobId, generation }) => {
    order.push('complete-media');
    assert.equal(jobId, job.id);
    assert.equal(generation, job.generation);
    completed = true;
  };
  store.failMediaDeletion = async () => assert.fail('not-found must not be failed');
  const mediaStore = {
    delete: async ({ storageKey }) => {
      order.push('delete-media');
      assert.equal(storageKey, job.storageKey);
      return { deleted: false, notFound: true };
    },
  };
  const mediaCleanup = createMediaCleanupService({
    store,
    mediaStore,
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  const result = await runRetentionOnce({
    store,
    mediaCleanup,
    now: () => new Date('2026-08-31T12:00:00.000Z'),
  });

  assert.equal(result.ok, true);
  assert.equal(completed, true);
  assert.ok(order.indexOf('complete-media') < order.indexOf('success'));
  assert.deepEqual(order, [
    'heartbeat', 'purge', 'claim-media', 'delete-media', 'complete-media',
    'claim-media', 'success', 'stopped',
  ]);
});

test('worker runs immediately before installing its interval and then reuses runOnce', async () => {
  const order = [];
  const store = new FakeRetentionStore({ order });
  let scheduled;
  let cleared = false;
  const intervalToken = { unref: () => order.push('unref') };
  const worker = startRetentionWorker({
    store,
    mediaCleanup: idleCleanup(order),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    intervalMs: 60_000,
    setIntervalFn: (callback, intervalMs) => {
      order.push(`schedule:${intervalMs}`);
      scheduled = callback;
      return intervalToken;
    },
    clearIntervalFn: (token) => {
      assert.equal(token, intervalToken);
      cleared = true;
    },
  });

  assert.equal(order[0], 'heartbeat', 'startup run begins before interval installation');
  assert.equal(await worker.firstRun.then((value) => value.ok), true);
  await scheduled();
  assert.equal(store.purgeInputs.length, 2);
  const stopped = await worker.stop();
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.drained, true);
  assert.equal(cleared, true);
});

test('stop is bounded, reports an undrained run honestly, and fences late success', async () => {
  const order = [];
  const purge = deferred();
  const purgeStarted = deferred();
  const store = new FakeRetentionStore({
    order,
    purgeOperation: () => {
      purgeStarted.resolve();
      return purge.promise;
    },
  });
  const worker = startRetentionWorker({
    store,
    mediaCleanup: idleCleanup(order),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    intervalMs: 60_000,
    stopTimeoutMs: 10,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => undefined,
  });

  await settleWithin(purgeStarted.promise, 100, 'retention purge did not start');
  const stopped = await settleWithin(worker.stop(), 100, 'retention stop was not bounded');
  assert.deepEqual(stopped, { stopped: true, drained: false });
  assert.equal(store.stoppedInputs.length, 1);
  assert.equal(store.successInputs.length, 0);

  purge.resolve(store.purgeResult);
  const lateOutcome = await settleWithin(worker.firstRun, 100, 'late retention run did not settle');
  assert.deepEqual(lateOutcome, { ok: false, code: 'RETENTION_STOPPED' });
  assert.equal(store.successInputs.length, 0);
});

test('stop reasserts its durable fence when an in-flight heartbeat persists late', async () => {
  const order = [];
  const heartbeat = deferred();
  const store = new FakeRetentionStore({ order });
  const persistHeartbeat = store.recordRetentionHeartbeat.bind(store);
  store.recordRetentionHeartbeat = async (input) => {
    order.push('heartbeat-pending');
    await heartbeat.promise;
    return persistHeartbeat(input);
  };
  const worker = startRetentionWorker({
    store,
    mediaCleanup: idleCleanup(order),
    now: () => new Date('2026-08-31T12:00:00.000Z'),
    intervalMs: 60_000,
    stopTimeoutMs: 100,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn: () => undefined,
  });

  const stopping = worker.stop();
  await Promise.resolve();
  assert.equal(store.stoppedInputs.length, 1, 'stop fence is attempted immediately');
  heartbeat.resolve();
  assert.deepEqual(await worker.firstRun, { ok: false, code: 'RETENTION_STOPPED' });
  assert.deepEqual(await stopping, { stopped: true, drained: true });
  assert.equal(store.state.stoppedAt, '2026-08-31T12:00:00.000Z');
  assert.equal(store.stoppedInputs.length, 2, 'late heartbeat is fenced by a final durable stop write');
});

test('readiness uses a durable snapshot and rejects stale or stopped workers', () => {
  const now = new Date('2026-08-31T12:01:00.000Z');
  const healthyState = {
    heartbeatAt: '2026-08-31T12:00:30.000Z',
    lastSuccessAt: '2026-08-31T12:00:20.000Z',
    stoppedAt: null,
    policyVersion: 'retention-v1',
  };

  assert.deepEqual(retentionReadinessSnapshot({ state: healthyState, now, staleAfterMs: 60_000 }), {
    name: 'retention',
    status: 'ready',
    healthy: true,
    policyVersion: 'retention-v1',
    heartbeatAt: healthyState.heartbeatAt,
    lastSuccessAt: healthyState.lastSuccessAt,
  });
  assert.equal(retentionReadinessSnapshot({
    state: { ...healthyState, heartbeatAt: '2026-08-31T11:59:59.999Z' },
    now,
    staleAfterMs: 60_000,
  }).status, 'stale');
  assert.equal(retentionReadinessSnapshot({
    state: { ...healthyState, stoppedAt: '2026-08-31T12:00:40.000Z' },
    now,
    staleAfterMs: 60_000,
  }).status, 'stopped');
  assert.equal(retentionReadinessSnapshot({
    state: { ...healthyState, lastSuccessAt: null },
    now,
    staleAfterMs: 60_000,
  }).status, 'starting');
});

test('retention readiness forwards the supervisor cancellation signal to its durable state read', async () => {
  const store = new FakeRetentionStore();
  const controller = new AbortController();
  let observedSignal = null;
  store.getRetentionState = async ({ signal } = {}) => {
    observedSignal = signal;
    return {
      heartbeatAt: '2026-08-31T12:00:30.000Z',
      lastSuccessAt: '2026-08-31T12:00:20.000Z',
      stoppedAt: null,
      policyVersion: 'retention-v1',
    };
  };
  const service = createRetentionService({
    store,
    mediaCleanup: idleCleanup(),
    now: () => new Date('2026-08-31T12:01:00.000Z'),
  });

  assert.equal((await service.readiness({ signal: controller.signal })).healthy, true);
  assert.equal(observedSignal, controller.signal);
});

test('longer retention requires an explicit policy version', () => {
  const store = new FakeRetentionStore();
  const mediaCleanup = idleCleanup();
  assert.throws(() => createRetentionService({
    store,
    mediaCleanup,
    anonymousTextEventMs: 31 * DAY_MS,
  }), { code: 'RETENTION_POLICY_VERSION_REQUIRED' });
  assert.throws(() => createRetentionService({
    store,
    mediaCleanup,
    voiceMediaMs: 8 * DAY_MS,
  }), { code: 'RETENTION_POLICY_VERSION_REQUIRED' });
  assert.doesNotThrow(() => createRetentionService({
    store,
    mediaCleanup,
    anonymousTextEventMs: 31 * DAY_MS,
    voiceMediaMs: 8 * DAY_MS,
    policyVersion: 'approved-campus-policy-v2',
  }));
});

test('one-shot command invokes the same retention service and closes injected runtime resources', async () => {
  const order = [];
  const stdout = [];
  const stderr = [];
  const store = new FakeRetentionStore({ order });
  const exitCode = await runRetentionCleanupCommand({
    createRuntime: async () => ({
      store,
      mediaCleanup: idleCleanup(order),
      close: async () => order.push('close'),
    }),
    serviceOptions: { now: () => new Date('2026-08-31T12:00:00.000Z') },
    stdout: (line) => stdout.push(JSON.parse(line)),
    stderr: (line) => stderr.push(JSON.parse(line)),
  });

  assert.equal(exitCode, 0);
  assert.deepEqual(order, ['heartbeat', 'purge', 'media', 'success', 'stopped', 'close']);
  assert.equal(store.state.stoppedAt, '2026-08-31T12:00:00.000Z');
  assert.deepEqual(stdout, [{ status: 'ok', code: 'RETENTION_COMPLETED' }]);
  assert.deepEqual(stderr, []);
});

test('one-shot command is inert and fails closed without injected runtime wiring', async () => {
  const stderr = [];
  const exitCode = await runRetentionCleanupCommand({
    stderr: (line) => stderr.push(JSON.parse(line)),
  });
  assert.equal(exitCode, 2);
  assert.deepEqual(stderr, [{ status: 'blocked', code: 'RETENTION_RUNTIME_REQUIRED' }]);
});

test('one-shot command never prints an untrusted dependency error code', async () => {
  const stderr = [];
  const privateCode = 'postgres://private-user:secret@internal.example.test/db';
  const exitCode = await runRetentionCleanupCommand({
    createRuntime: async () => {
      const error = new Error('private dependency failure');
      error.code = privateCode;
      throw error;
    },
    stderr: (line) => stderr.push(line),
  });

  assert.equal(exitCode, 1);
  assert.deepEqual(stderr.map(JSON.parse), [{ status: 'failed', code: 'RETENTION_FAILED' }]);
  assert.equal(stderr.join('').includes(privateCode), false);
  assert.equal(stderr.join('').includes('secret'), false);
});

test('production retention runtime rejects preview mode before constructing storage', async () => {
  let storageCalls = 0;
  await assert.rejects(createRetentionCommandRuntime({
    environment: { NODE_ENV: 'test' },
    loadConfigImpl: () => ({ nodeEnv: 'test', retentionWorkerEnabled: false }),
    createStorageRuntimeImpl: async () => {
      storageCalls += 1;
      throw new Error('must not run');
    },
  }), { code: 'RETENTION_PRODUCTION_REQUIRED' });
  assert.equal(storageCalls, 0);
});

test('production retention runtime reuses storage and media cleanup with reverse idempotent close', async () => {
  const order = [];
  const config = { nodeEnv: 'production', retentionWorkerEnabled: true };
  const store = {
    acquireInstanceLock: async ({ name }) => {
      assert.equal(name, 'hong-kong-buddy-production-v1');
      order.push('lock:acquire');
      return {
        owned: true,
        release: async () => order.push('lock:release'),
      };
    },
  };
  const mediaStore = {};
  const mediaCleanup = {
    stop: async () => order.push('cleanup:stop'),
  };
  const runtime = await createRetentionCommandRuntime({
    config,
    createStorageRuntimeImpl: async ({ config: observed }) => {
      assert.equal(observed, config);
      order.push('storage:create');
      return {
        store,
        mediaStore,
        close: async () => order.push('storage:close'),
      };
    },
    createMediaCleanupServiceImpl: ({ store: observedStore, mediaStore: observedMedia }) => {
      assert.equal(observedStore, store);
      assert.equal(observedMedia, mediaStore);
      return mediaCleanup;
    },
  });
  assert.equal(runtime.store, store);
  assert.equal(runtime.mediaCleanup, mediaCleanup);
  await Promise.all([runtime.close(), runtime.close()]);
  assert.deepEqual(order, [
    'storage:create', 'lock:acquire', 'cleanup:stop', 'lock:release', 'storage:close',
  ]);
});

test('production retention runtime refuses to fence the live app when its singleton lock is owned', async () => {
  const order = [];
  let deniedReleaseCalls = 0;
  await assert.rejects(createRetentionCommandRuntime({
    config: { nodeEnv: 'production', retentionWorkerEnabled: true },
    createStorageRuntimeImpl: async () => ({
      store: {
        acquireInstanceLock: async ({ name }) => {
          assert.equal(name, 'hong-kong-buddy-production-v1');
          order.push('lock:denied');
          return { owned: false, release: async () => { deniedReleaseCalls += 1; } };
        },
      },
      mediaStore: {},
      close: async () => order.push('storage:close'),
    }),
    createMediaCleanupServiceImpl: () => assert.fail('cleanup must not start without the lock'),
  }), { code: 'RETENTION_INSTANCE_LOCK_UNAVAILABLE' });

  assert.deepEqual(order, ['lock:denied', 'storage:close']);
  assert.equal(deniedReleaseCalls, 0, 'an unowned advisory lock must not be released');
});

test('production retention runtime releases its singleton lock when cleanup construction fails', async () => {
  const order = [];
  const constructionError = codedError('CLEANUP_CONSTRUCTION_FAILED');
  await assert.rejects(createRetentionCommandRuntime({
    config: { nodeEnv: 'production', retentionWorkerEnabled: true },
    createStorageRuntimeImpl: async () => ({
      store: {
        acquireInstanceLock: async () => {
          order.push('lock:acquire');
          return { owned: true, release: async () => order.push('lock:release') };
        },
      },
      mediaStore: {},
      close: async () => order.push('storage:close'),
    }),
    createMediaCleanupServiceImpl: () => { throw constructionError; },
  }), constructionError);

  assert.deepEqual(order, ['lock:acquire', 'lock:release', 'storage:close']);
});
