import { createHash, randomUUID } from 'node:crypto';

export const mediaCleanupLimits = Object.freeze({
  sweepLimit: 100,
  sweepMinimumAgeMs: 120_000,
  sweepDeadlineMs: 15_000,
});

function addMilliseconds(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds);
}

function sweepObservation(entry) {
  const lastModified = new Date(entry?.lastModified);
  const byteLength = Number(entry?.byteLength);
  const version = entry?.version ?? entry?.etag ?? null;
  if (!Number.isFinite(lastModified.getTime()) || !Number.isSafeInteger(byteLength) || byteLength < 0
    || (version !== null && (typeof version !== 'string' || version.length > 1_024))) {
    throw new Error('Media listing returned invalid write evidence');
  }
  return createHash('sha256').update(JSON.stringify({
    lastModified: lastModified.toISOString(),
    byteLength,
    version,
  })).digest('hex');
}

function sweepAbortError(signal) {
  if (signal?.reason?.code === 'MEDIA_OPERATION_ABORTED') return signal.reason;
  const error = new Error('Media cleanup sweep aborted', signal?.reason ? { cause: signal.reason } : undefined);
  error.code = 'MEDIA_OPERATION_ABORTED';
  return error;
}

function throwIfSweepAborted(signal) {
  if (signal?.aborted) throw sweepAbortError(signal);
}

function deleteLeaseError(signal) {
  const error = new Error('Media cleanup delete lease expired', signal?.reason ? { cause: signal.reason } : undefined);
  error.code = 'MEDIA_DELETE_LEASE_EXPIRED';
  return error;
}

async function withAbortSignal(operation, signal, createAbortError) {
  if (signal?.aborted) throw createAbortError(signal);
  if (!signal) return operation();
  let removeAbortListener = () => undefined;
  const aborted = new Promise((resolve, reject) => {
    void resolve;
    const onAbort = () => reject(createAbortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    removeAbortListener = () => signal.removeEventListener('abort', onAbort);
  });
  const operationPromise = Promise.resolve().then(operation);
  try {
    const outcome = await Promise.race([
      operationPromise.then(
        (value) => ({ source: 'operation', value }),
        (error) => ({ source: 'operation', error }),
      ),
      aborted.then(
        (value) => ({ source: 'abort', value }),
        (error) => ({ source: 'abort', error }),
      ),
    ]);
    if (outcome.error) throw outcome.error;
    return outcome.value;
  } finally {
    removeAbortListener();
  }
}

function withSweepAbort(operation, signal) {
  return withAbortSignal(operation, signal, sweepAbortError);
}

export function createMediaCleanupService({
  store,
  mediaStore,
  now = () => new Date(),
  workerId = `media-cleanup-${randomUUID()}`,
  leaseMs = 15_000,
  retryDelayMs = 30_000,
  pollMs = 5_000,
  sweepLimit = mediaCleanupLimits.sweepLimit,
  sweepMinimumAgeMs = mediaCleanupLimits.sweepMinimumAgeMs,
  sweepDeadlineMs = mediaCleanupLimits.sweepDeadlineMs,
} = {}) {
  if (!store || !mediaStore) throw new Error('Media cleanup requires store and mediaStore');
  let timer = null;
  let stopped = false;
  let scheduledCycle = null;
  let scheduledCycleController = null;
  const sweepCursors = new Map([
    ['attempts/voice/', null],
    ['attempts/tts/', null],
  ]);
  const boundedSweepLimit = Math.max(1, Math.min(Number(sweepLimit) || mediaCleanupLimits.sweepLimit, mediaCleanupLimits.sweepLimit));
  const safeSweepAgeMs = Math.max(Number(sweepMinimumAgeMs) || 0, mediaCleanupLimits.sweepMinimumAgeMs);
  const safeSweepDeadlineMs = Math.max(1, Math.min(
    Number(sweepDeadlineMs) || mediaCleanupLimits.sweepDeadlineMs,
    60_000,
  ));

  const drainOnce = async () => {
    const current = new Date(now());
    const leaseToken = randomUUID();
    const job = await store.claimNextMediaDeletion({
      workerId,
      leaseToken,
      leaseExpiresAt: addMilliseconds(current, leaseMs),
      now: current,
    });
    if (!job) return { completed: false, idle: true };
    try {
      if (await store.isStorageKeyLive({ storageKey: job.storageKey, now: current })) {
        const liveFailureNow = new Date(now());
        await store.failMediaDeletion({
          jobId: job.id, generation: job.generation, leaseToken,
          failureCode: 'MEDIA_KEY_STILL_LIVE',
          retryAt: addMilliseconds(liveFailureNow, retryDelayMs),
          now: liveFailureNow,
        });
        return { completed: false, live: true, storageKey: job.storageKey };
      }
      const deleteSignal = AbortSignal.timeout(leaseMs);
      try {
        await withAbortSignal(
          () => mediaStore.delete({ storageKey: job.storageKey, signal: deleteSignal }),
          deleteSignal,
          deleteLeaseError,
        );
      } catch (error) {
        if (error?.code === 'MEDIA_DELETE_LEASE_EXPIRED') {
          return { completed: false, leaseExpired: true, storageKey: job.storageKey };
        }
        throw error;
      }
      await store.completeMediaDeletion({
        jobId: job.id,
        generation: job.generation,
        leaseToken,
        now: new Date(now()),
      });
      return { completed: true, storageKey: job.storageKey };
    } catch (error) {
      if (error?.code === 'LEASE_LOST') return { completed: false, fenced: true, storageKey: job.storageKey };
      const failureNow = new Date(now());
      try {
        await store.failMediaDeletion({
          jobId: job.id, generation: job.generation, leaseToken,
          failureCode: error?.code === 'MEDIA_DELETE_FAILED' ? 'MEDIA_DELETE_FAILED' : 'MEDIA_UNAVAILABLE',
          retryAt: addMilliseconds(failureNow, retryDelayMs),
          now: failureNow,
        });
      } catch (failureError) {
        if (failureError?.code === 'LEASE_LOST') {
          return { completed: false, fenced: true, storageKey: job.storageKey };
        }
      }
      return { completed: false, retryable: true, storageKey: job.storageKey };
    }
  };

  const sweepAttemptPrefix = async ({ prefix, before, limit = mediaCleanupLimits.sweepLimit, cursor, signal }) => {
    const current = new Date(now());
    const listed = await withSweepAbort(
      () => mediaStore.listAttemptKeys({ prefix, before, limit, cursor, signal }),
      signal,
    );
    throwIfSweepAborted(signal);
    let enqueued = 0;
    for (const entry of listed.keys) {
      throwIfSweepAborted(signal);
      const live = await withSweepAbort(
        () => store.isStorageKeyLive({ storageKey: entry.storageKey, now: current }),
        signal,
      );
      throwIfSweepAborted(signal);
      if (live) continue;
      throwIfSweepAborted(signal);
      await store.rearmMediaDeletionFromSweep({
        storageKey: entry.storageKey,
        sweepObservation: sweepObservation(entry),
        reason: 'orphan-attempt-sweep',
        notBefore: current,
        now: current,
      });
      enqueued += 1;
    }
    return { scanned: listed.keys.length, enqueued, cursor: listed.cursor };
  };

  const runScheduledCycle = () => {
    if (scheduledCycle) return scheduledCycle;
    const controller = new AbortController();
    scheduledCycleController = controller;
    const deadlineTimer = setTimeout(() => {
      const error = new Error('Media cleanup sweep deadline exceeded');
      error.code = 'MEDIA_OPERATION_ABORTED';
      controller.abort(error);
    }, safeSweepDeadlineMs);
    deadlineTimer.unref?.();
    scheduledCycle = (async () => {
      await drainOnce();
      if (controller.signal.aborted) return { sweeps: [], aborted: true };
      const before = addMilliseconds(new Date(now()), -safeSweepAgeMs);
      const sweeps = [];
      for (const prefix of sweepCursors.keys()) {
        try {
          const result = await sweepAttemptPrefix({
            prefix,
            before,
            limit: boundedSweepLimit,
            cursor: sweepCursors.get(prefix),
            signal: controller.signal,
          });
          sweepCursors.set(prefix, result.cursor ?? null);
          sweeps.push({ prefix, ...result });
        } catch {
          sweeps.push({ prefix, scanned: 0, enqueued: 0, cursor: sweepCursors.get(prefix), failed: true });
        }
        if (controller.signal.aborted) break;
      }
      if (!controller.signal.aborted) await drainOnce();
      return { sweeps, aborted: controller.signal.aborted };
    })().finally(() => {
      clearTimeout(deadlineTimer);
      if (scheduledCycleController === controller) scheduledCycleController = null;
      scheduledCycle = null;
    });
    return scheduledCycle;
  };

  const schedule = () => {
    if (stopped || timer) return;
    void runScheduledCycle().catch(() => undefined);
    timer = setInterval(() => { void runScheduledCycle().catch(() => undefined); }, pollMs);
    timer.unref?.();
  };

  const stop = async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    timer = null;
    if (scheduledCycleController && !scheduledCycleController.signal.aborted) {
      const error = new Error('Media cleanup is stopping');
      error.code = 'MEDIA_OPERATION_ABORTED';
      scheduledCycleController.abort(error);
    }
    await scheduledCycle?.catch(() => undefined);
  };

  return { drainOnce, sweepAttemptPrefix, runScheduledCycle, start: schedule, stop };
}
