import { randomUUID } from 'node:crypto';

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_POLICY_VERSION = 'retention-v1';

export const retentionPolicyDefaults = Object.freeze({
  anonymousTextEventMs: 30 * DAY_MS,
  voiceMediaMs: 7 * DAY_MS,
  intervalMs: 60 * 60 * 1_000,
  staleAfterMs: 2 * 60 * 60 * 1_000,
  maxMediaDeletionJobs: 100,
  stopTimeoutMs: 5_000,
});

function retentionError(code, extra = {}) {
  const error = new Error(code);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

function positiveInteger(value, fallback, name) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0) {
    throw retentionError('RETENTION_CONFIGURATION_INVALID', { field: name });
  }
  return resolved;
}

function dateFromClock(now) {
  const value = new Date(now());
  if (!Number.isFinite(value.getTime())) throw retentionError('RETENTION_CLOCK_INVALID');
  return value;
}

function subtractMilliseconds(value, milliseconds) {
  return new Date(value.getTime() - milliseconds);
}

function requiredMethod(target, method, dependency) {
  if (typeof target?.[method] !== 'function') {
    throw retentionError('RETENTION_DEPENDENCY_INVALID', { dependency, method });
  }
}

function safeWorkerOutcome(error) {
  return {
    ok: false,
    code: typeof error?.code === 'string' ? error.code : 'RETENTION_FAILED',
  };
}

function incompleteMediaError(result) {
  const reason = ['retryable', 'live', 'leaseExpired', 'fenced']
    .find((candidate) => result?.[candidate]) ?? 'unknown';
  return retentionError('RETENTION_MEDIA_INCOMPLETE', { reason });
}

function finiteTimestamp(value) {
  if (!value) return null;
  const timestamp = new Date(value);
  return Number.isFinite(timestamp.getTime()) ? timestamp : null;
}

export function retentionReadinessSnapshot({
  state,
  now = new Date(),
  staleAfterMs = retentionPolicyDefaults.staleAfterMs,
} = {}) {
  const current = dateFromClock(() => now);
  const safeStaleAfterMs = positiveInteger(
    staleAfterMs,
    retentionPolicyDefaults.staleAfterMs,
    'staleAfterMs',
  );
  const heartbeat = finiteTimestamp(state?.heartbeatAt);
  const success = finiteTimestamp(state?.lastSuccessAt);
  const stopped = finiteTimestamp(state?.stoppedAt);
  let status = 'starting';
  let healthy = false;

  if (stopped) {
    status = 'stopped';
  } else if (heartbeat && success) {
    const heartbeatAge = current.getTime() - heartbeat.getTime();
    const successAge = current.getTime() - success.getTime();
    if (heartbeatAge < 0 || successAge < 0
      || heartbeatAge > safeStaleAfterMs || successAge > safeStaleAfterMs) {
      status = 'stale';
    } else {
      status = 'ready';
      healthy = true;
    }
  }

  return {
    name: 'retention',
    status,
    healthy,
    policyVersion: typeof state?.policyVersion === 'string' ? state.policyVersion : null,
    heartbeatAt: heartbeat?.toISOString() ?? null,
    lastSuccessAt: success?.toISOString() ?? null,
  };
}

export function createRetentionService({
  store,
  mediaCleanup,
  now = () => new Date(),
  workerId = `retention-${randomUUID()}`,
  runTokenFactory = randomUUID,
  anonymousTextEventMs = retentionPolicyDefaults.anonymousTextEventMs,
  voiceMediaMs = retentionPolicyDefaults.voiceMediaMs,
  policyVersion,
  maxMediaDeletionJobs = retentionPolicyDefaults.maxMediaDeletionJobs,
  stopTimeoutMs = retentionPolicyDefaults.stopTimeoutMs,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
} = {}) {
  for (const method of [
    'recordRetentionHeartbeat',
    'purgeExpired',
    'hasPendingMediaDeletions',
    'recordRetentionSuccess',
    'recordRetentionStopped',
    'getRetentionState',
  ]) requiredMethod(store, method, 'store');
  requiredMethod(mediaCleanup, 'drainOnce', 'mediaCleanup');
  if (typeof now !== 'function' || typeof runTokenFactory !== 'function') {
    throw retentionError('RETENTION_CONFIGURATION_INVALID');
  }

  const anonymousMs = positiveInteger(
    anonymousTextEventMs,
    retentionPolicyDefaults.anonymousTextEventMs,
    'anonymousTextEventMs',
  );
  const voiceMs = positiveInteger(
    voiceMediaMs,
    retentionPolicyDefaults.voiceMediaMs,
    'voiceMediaMs',
  );
  const mediaLimit = positiveInteger(
    maxMediaDeletionJobs,
    retentionPolicyDefaults.maxMediaDeletionJobs,
    'maxMediaDeletionJobs',
  );
  const boundedStopTimeoutMs = positiveInteger(
    stopTimeoutMs,
    retentionPolicyDefaults.stopTimeoutMs,
    'stopTimeoutMs',
  );
  const explicitPolicyVersion = typeof policyVersion === 'string' && policyVersion.trim()
    ? policyVersion.trim()
    : null;
  if ((anonymousMs > retentionPolicyDefaults.anonymousTextEventMs
      || voiceMs > retentionPolicyDefaults.voiceMediaMs)
    && !explicitPolicyVersion) {
    throw retentionError('RETENTION_POLICY_VERSION_REQUIRED');
  }
  const policy = Object.freeze({
    version: explicitPolicyVersion ?? DEFAULT_POLICY_VERSION,
    anonymousTextEventMs: anonymousMs,
    voiceMediaMs: voiceMs,
  });

  let stopped = false;
  let activeRun = null;
  let activeController = null;
  let lastRunToken = null;
  let stopPromise = null;

  const assertRunning = () => {
    if (stopped) throw retentionError('RETENTION_STOPPED');
  };

  const drainMedia = async () => {
    let completed = 0;
    while (completed < mediaLimit) {
      assertRunning();
      const result = await mediaCleanup.drainOnce();
      assertRunning();
      if (result?.idle) return { completed, idle: true };
      if (result?.completed) {
        completed += 1;
        continue;
      }
      throw incompleteMediaError(result);
    }
    throw retentionError('RETENTION_MEDIA_INCOMPLETE', { reason: 'bounded' });
  };

  const execute = async () => {
    const heartbeatAt = dateFromClock(now);
    const runToken = String(runTokenFactory());
    if (!runToken) throw retentionError('RETENTION_RUN_TOKEN_INVALID');
    lastRunToken = runToken;
    const controller = new AbortController();
    activeController = controller;
    await store.recordRetentionHeartbeat({
      workerId,
      runToken,
      heartbeatAt,
      policy,
      signal: controller.signal,
    });
    assertRunning();

    const purged = await store.purgeExpired({
      anonymousBefore: subtractMilliseconds(heartbeatAt, policy.anonymousTextEventMs),
      voiceBefore: subtractMilliseconds(heartbeatAt, policy.voiceMediaMs),
      now: heartbeatAt,
      workerId,
      runToken,
      policyVersion: policy.version,
      signal: controller.signal,
    });
    assertRunning();
    const media = await drainMedia();
    assertRunning();
    const pendingMedia = await store.hasPendingMediaDeletions({
      workerId,
      runToken,
      signal: controller.signal,
    });
    if (typeof pendingMedia !== 'boolean') {
      throw retentionError('RETENTION_DEPENDENCY_INVALID', {
        dependency: 'store',
        method: 'hasPendingMediaDeletions',
      });
    }
    assertRunning();
    if (pendingMedia) {
      throw retentionError('RETENTION_MEDIA_INCOMPLETE', { reason: 'pending' });
    }

    const lastSuccessAt = dateFromClock(now);
    await store.recordRetentionSuccess({
      workerId,
      runToken,
      heartbeatAt,
      lastSuccessAt,
      policy,
      result: { purged, media },
      signal: controller.signal,
    });
    assertRunning();
    return {
      ok: true,
      purged,
      media,
      heartbeatAt: heartbeatAt.toISOString(),
      lastSuccessAt: lastSuccessAt.toISOString(),
    };
  };

  const runOnce = () => {
    if (stopped) return Promise.reject(retentionError('RETENTION_STOPPED'));
    if (activeRun) return activeRun;
    let operation;
    operation = execute().finally(() => {
      if (activeRun === operation) {
        activeRun = null;
        activeController = null;
      }
    });
    activeRun = operation;
    return operation;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    if (activeController && !activeController.signal.aborted) {
      activeController.abort(retentionError('RETENTION_STOPPED'));
    }
    const stoppedAt = dateFromClock(now);
    const running = activeRun;
    const writeStopped = () => store.recordRetentionStopped({
      workerId, runToken: lastRunToken, stoppedAt, policy,
    });
    const durableStop = (async () => {
      let firstWriteSucceeded = false;
      try {
        await writeStopped();
        firstWriteSucceeded = true;
      } catch {
        if (!running) return false;
      }
      if (!running) return firstWriteSucceeded;
      await running.then(() => undefined, () => undefined);
      await writeStopped();
      return true;
    })();
    const settled = durableStop.catch(() => false);

    stopPromise = new Promise((resolve) => {
      const timeout = setTimeoutFn(
        () => resolve({ stopped: true, drained: false }),
        boundedStopTimeoutMs,
      );
      settled.then((drained) => {
        clearTimeoutFn(timeout);
        resolve({ stopped: true, drained });
      });
    });
    return stopPromise;
  };

  const readiness = async (options = {}) => retentionReadinessSnapshot({
    state: await store.getRetentionState?.({ signal: options.signal }),
    now: options.now ?? now(),
    staleAfterMs: options.staleAfterMs,
  });

  return {
    workerId,
    policy,
    runOnce,
    stop,
    readiness,
  };
}

export function startRetentionWorker({
  intervalMs = retentionPolicyDefaults.intervalMs,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  ...serviceOptions
} = {}) {
  const safeIntervalMs = positiveInteger(
    intervalMs,
    retentionPolicyDefaults.intervalMs,
    'intervalMs',
  );
  const service = createRetentionService(serviceOptions);
  const runInBackground = () => service.runOnce().catch(safeWorkerOutcome);
  const firstRun = runInBackground();
  const interval = setIntervalFn(() => runInBackground(), safeIntervalMs);
  interval?.unref?.();
  let stopPromise = null;

  const stop = () => {
    if (stopPromise) return stopPromise;
    clearIntervalFn(interval);
    stopPromise = service.stop();
    return stopPromise;
  };

  return {
    ...service,
    firstRun,
    stop,
  };
}

export async function runRetentionOnce(options = {}) {
  const service = createRetentionService(options);
  let result;
  let primaryError = null;
  try {
    result = await service.runOnce();
  } catch (error) {
    primaryError = error;
  }
  let stopped;
  try {
    stopped = await service.stop();
  } catch (error) {
    if (!primaryError) throw error;
  }
  if (primaryError) throw primaryError;
  if (stopped?.stopped !== true || stopped?.drained !== true) {
    throw retentionError('RETENTION_STOP_INCOMPLETE');
  }
  return result;
}
