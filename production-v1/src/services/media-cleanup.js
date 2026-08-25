import { randomUUID } from 'node:crypto';

export const mediaCleanupLimits = Object.freeze({
  sweepLimit: 100,
  sweepMinimumAgeMs: 120_000,
});

function addMilliseconds(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds);
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
} = {}) {
  if (!store || !mediaStore) throw new Error('Media cleanup requires store and mediaStore');
  let timer = null;
  let stopped = false;
  let scheduledCycle = null;
  const sweepCursors = new Map([
    ['attempts/voice/', null],
    ['attempts/tts/', null],
  ]);
  const boundedSweepLimit = Math.max(1, Math.min(Number(sweepLimit) || mediaCleanupLimits.sweepLimit, mediaCleanupLimits.sweepLimit));
  const safeSweepAgeMs = Math.max(Number(sweepMinimumAgeMs) || 0, mediaCleanupLimits.sweepMinimumAgeMs);

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
        await store.failMediaDeletion({
          jobId: job.id, generation: job.generation, leaseToken,
          failureCode: 'MEDIA_KEY_STILL_LIVE',
          retryAt: addMilliseconds(current, retryDelayMs),
          now: current,
        });
        return { completed: false, live: true, storageKey: job.storageKey };
      }
      await mediaStore.delete({ storageKey: job.storageKey, signal: AbortSignal.timeout(leaseMs) });
      await store.completeMediaDeletion({ jobId: job.id, generation: job.generation, leaseToken, now: current });
      return { completed: true, storageKey: job.storageKey };
    } catch (error) {
      if (error?.code === 'LEASE_LOST') return { completed: false, fenced: true, storageKey: job.storageKey };
      await store.failMediaDeletion({
        jobId: job.id, generation: job.generation, leaseToken,
        failureCode: error?.code === 'MEDIA_DELETE_FAILED' ? 'MEDIA_DELETE_FAILED' : 'MEDIA_UNAVAILABLE',
        retryAt: addMilliseconds(current, retryDelayMs),
        now: current,
      }).catch(() => undefined);
      return { completed: false, retryable: true, storageKey: job.storageKey };
    }
  };

  const sweepAttemptPrefix = async ({ prefix, before, limit = mediaCleanupLimits.sweepLimit, cursor }) => {
    const current = new Date(now());
    const listed = await mediaStore.listAttemptKeys({ prefix, before, limit, cursor });
    let enqueued = 0;
    for (const entry of listed.keys) {
      if (await store.isStorageKeyLive({ storageKey: entry.storageKey, now: current })) continue;
      await store.enqueueMediaDeletion({
        storageKey: entry.storageKey,
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
    scheduledCycle = (async () => {
      await drainOnce();
      const before = addMilliseconds(new Date(now()), -safeSweepAgeMs);
      const sweeps = [];
      for (const prefix of sweepCursors.keys()) {
        try {
          const result = await sweepAttemptPrefix({
            prefix,
            before,
            limit: boundedSweepLimit,
            cursor: sweepCursors.get(prefix),
          });
          sweepCursors.set(prefix, result.cursor ?? null);
          sweeps.push({ prefix, ...result });
        } catch {
          sweeps.push({ prefix, scanned: 0, enqueued: 0, cursor: sweepCursors.get(prefix), failed: true });
        }
      }
      await drainOnce();
      return { sweeps };
    })().finally(() => { scheduledCycle = null; });
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
    await scheduledCycle?.catch(() => undefined);
  };

  return { drainOnce, sweepAttemptPrefix, runScheduledCycle, start: schedule, stop };
}
