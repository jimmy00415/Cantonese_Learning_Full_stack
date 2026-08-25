const PROCESSING_STATES = new Set(['uploading', 'transcribing', 'processing']);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const RENEW_INTERVAL_MS = 5_000;
const DEFAULT_RETRY_MS = 1_000;
const MIN_RETRY_MS = 250;
const MAX_RETRY_MS = 5 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function requireOperationIdentity(clientUploadId, clientSessionScope) {
  const id = requireString(clientUploadId, 'clientUploadId');
  if (!UUID.test(id)) throw new TypeError('clientUploadId must be a UUID');
  return { clientUploadId: id, clientSessionScope: requireString(clientSessionScope, 'clientSessionScope') };
}

function defaultSleep(milliseconds, { signal } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(done, milliseconds);
    signal?.addEventListener?.('abort', aborted, { once: true });

    function cleanup() {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', aborted);
    }

    function done() {
      cleanup();
      resolve();
    }

    function aborted() {
      cleanup();
      reject(signal.reason);
    }
  });
}

function defaultClock() {
  return { now: () => Date.now(), sleep: defaultSleep };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseCode(response, fallback = 'INVALID_RESPONSE') {
  const value = response?.error?.code ?? response?.data?.failureCode;
  return typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(value) ? value : fallback;
}

function responseStatus(response) {
  return Number.isInteger(response?.status) && response.status >= 100 && response.status <= 599
    ? response.status
    : null;
}

function responseIdentityMatches(response, operation) {
  return isObject(response?.data)
    && response.data.clientUploadId === operation.clientUploadId
    && response.data.requestSha256 === operation.requestSha256
    && LOWERCASE_SHA256.test(response.data.requestSha256);
}

function retryDelayMs(response) {
  if (response?.retryAfterMs !== null && response?.retryAfterMs !== undefined) {
    const milliseconds = Number(response.retryAfterMs);
    if (Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_RETRY_MS) {
      return Math.max(MIN_RETRY_MS, milliseconds);
    }
    return null;
  }
  if (response?.retryAfter !== null && response?.retryAfter !== undefined) {
    const seconds = typeof response.retryAfter === 'string' && /^\d+(?:\.\d+)?$/.test(response.retryAfter)
      ? Number(response.retryAfter)
      : response.retryAfter;
    const milliseconds = Number(seconds) * 1_000;
    if (Number.isFinite(milliseconds) && milliseconds >= 0 && milliseconds <= MAX_RETRY_MS) {
      return Math.max(MIN_RETRY_MS, milliseconds);
    }
  }
  return null;
}

function disposedResult() {
  return { state: 'disposed' };
}

function leaseLostResult() {
  return { state: 'lease_lost' };
}

function abortReason() {
  const error = new Error('Voice upload coordinator disposed.');
  error.name = 'AbortError';
  error.code = 'VOICE_COORDINATOR_DISPOSED';
  return error;
}

export function createVoiceUploadCoordinator({
  store,
  transport,
  clock = defaultClock(),
  random = () => globalThis.crypto.randomUUID(),
} = {}) {
  const requiredStoreMethods = [
    'cancel',
    'claimById',
    'claimNext',
    'consume',
    'get',
    'renewLease',
    'transition',
    'writeResult',
  ];
  for (const method of requiredStoreMethods) {
    if (typeof store?.[method] !== 'function') throw new TypeError(`store.${method} is required`);
  }
  for (const method of ['getUploadStatus', 'postUpload', 'deleteUpload']) {
    if (typeof transport?.[method] !== 'function') throw new TypeError(`transport.${method} is required`);
  }
  if (typeof clock?.now !== 'function' || typeof clock?.sleep !== 'function') {
    throw new TypeError('clock.now and clock.sleep are required');
  }
  if (typeof random !== 'function') throw new TypeError('random must be a function');

  const workerId = requireString(random(), 'workerId');
  const activeControllers = new Set();
  let disposed = false;
  let coordinatorEpoch = 0;

  function nowMs() {
    const value = Number(clock.now());
    if (!Number.isFinite(value)) throw new TypeError('clock.now must return a finite timestamp');
    return value;
  }

  function beginRun() {
    if (disposed) return null;
    const controller = new AbortController();
    const run = { controller, epoch: coordinatorEpoch };
    activeControllers.add(controller);
    return run;
  }

  function runIsCurrent(run) {
    return !disposed
      && run.epoch === coordinatorEpoch
      && !run.controller.signal.aborted;
  }

  function finishRun(run) {
    activeControllers.delete(run.controller);
  }

  function leaseIdentity(context) {
    return {
      clientUploadId: context.operation.clientUploadId,
      clientSessionScope: context.operation.clientSessionScope,
      workerId: context.operation.leaseOwnerId,
      leaseToken: context.operation.leaseToken,
      leaseGeneration: context.operation.leaseGeneration,
    };
  }

  async function durableWrite(context, method, patch) {
    if (!runIsCurrent(context.run)) return disposedResult();
    const written = await store[method]({
      ...leaseIdentity(context),
      nowMs: nowMs(),
      patch,
    });
    if (!runIsCurrent(context.run)) return disposedResult();
    return written || leaseLostResult();
  }

  async function markReady(context, data) {
    if (typeof data.transcript !== 'string' || !data.transcript.trim() || data.transcript.length > 4_000
      || typeof data.voiceDraftId !== 'string' || !UUID.test(data.voiceDraftId)) {
      return markTerminal(context, 'VOICE_INVALID_SERVER_RESPONSE');
    }
    const written = await durableWrite(context, 'writeResult', {
      state: 'ready',
      serverState: 'ready',
      transcript: data.transcript,
      voiceDraftId: data.voiceDraftId,
      failureCode: null,
      retryable: false,
    });
    if (written.state === 'disposed' || written.state === 'lease_lost') return written;
    return {
      state: 'ready',
      clientUploadId: context.operation.clientUploadId,
      transcript: data.transcript,
      voiceDraftId: data.voiceDraftId,
    };
  }

  async function markTerminal(context, failureCode) {
    const written = await durableWrite(context, 'writeResult', {
      state: 'terminal',
      postAuthorized: false,
      serverState: 'failed',
      failureCode,
      retryable: false,
    });
    if (written.state === 'disposed' || written.state === 'lease_lost') return written;
    return { state: 'terminal', failureCode };
  }

  async function markRetryable(context, failureCode, delay = DEFAULT_RETRY_MS) {
    const at = nowMs();
    const safeDelay = Number.isFinite(delay) && delay >= 0 ? Math.min(delay, MAX_RETRY_MS) : DEFAULT_RETRY_MS;
    const written = await durableWrite(context, 'writeResult', {
      state: 'retryable',
      postAuthorized: context.operation.postAuthorized === true,
      serverState: 'failed',
      nextActionAt: at + safeDelay,
      retryAfterAt: at + safeDelay,
      networkFailureCount: (context.operation.networkFailureCount ?? 0) + 1,
      failureCode,
      retryable: true,
    });
    if (written.state === 'disposed' || written.state === 'lease_lost') return written;
    return { state: 'retryable', failureCode };
  }

  async function markPolling(context, data, delay) {
    const at = nowMs();
    return durableWrite(context, 'transition', {
      state: 'polling',
      serverState: data.state,
      nextActionAt: at + delay,
      retryAfterAt: at + delay,
      failureCode: null,
      retryable: false,
    });
  }

  async function markCancelPending(context, failureCode, delay = DEFAULT_RETRY_MS) {
    const at = nowMs();
    const written = await durableWrite(context, 'transition', {
      state: 'cancel_pending',
      postAuthorized: false,
      serverState: 'failed',
      nextActionAt: at + delay,
      retryAfterAt: at + delay,
      failureCode,
      retryable: true,
    });
    if (written.state === 'disposed' || written.state === 'lease_lost') return written;
    return { state: 'cancel_pending', failureCode };
  }

  async function markCancelled(context) {
    const written = await durableWrite(context, 'transition', {
      state: 'terminal',
      postAuthorized: false,
      serverState: 'failed',
      failureCode: 'VOICE_UPLOAD_CANCELLED',
      retryable: false,
    });
    if (written.state === 'disposed' || written.state === 'lease_lost') return written;
    return { state: 'terminal', failureCode: 'VOICE_UPLOAD_CANCELLED' };
  }

  async function waitWithRenewal(context, delay) {
    const ttlRemaining = context.operation.expiresAt - nowMs();
    const expiresDuringWait = delay >= ttlRemaining;
    let remaining = expiresDuringWait ? Math.max(0, ttlRemaining - 1) : delay;
    do {
      const step = Math.min(RENEW_INTERVAL_MS, remaining);
      if (step > 0) await clock.sleep(step, { signal: context.run.controller.signal });
      if (!runIsCurrent(context.run)) return disposedResult();
      const renewed = await store.renewLease({
        ...leaseIdentity(context),
        nowMs: nowMs(),
      });
      if (!runIsCurrent(context.run)) return disposedResult();
      if (!renewed) return leaseLostResult();
      remaining -= step;
    } while (remaining > 0);
    return expiresDuringWait ? markTerminal(context, 'VOICE_OPERATION_EXPIRED') : null;
  }

  async function getStatus(context) {
    const response = await transport.getUploadStatus({
      clientUploadId: context.operation.clientUploadId,
      requestSha256: context.operation.requestSha256,
      signal: context.run.controller.signal,
    });
    return runIsCurrent(context.run) ? response : null;
  }

  async function postOnce(context) {
    const { operation } = context;
    if (operation.postAuthorized !== true
      || !(operation.blob instanceof Blob)
      || operation.blob.type !== 'audio/wav'
      || !LOWERCASE_SHA256.test(operation.requestSha256)) {
      return { localFailure: 'VOICE_LOCAL_AUDIO_UNAVAILABLE' };
    }
    const response = await transport.postUpload({
      clientUploadId: operation.clientUploadId,
      requestSha256: operation.requestSha256,
      audio: operation.blob,
      mimeType: 'audio/wav',
      signal: context.run.controller.signal,
    });
    return runIsCurrent(context.run) ? { response } : { disposed: true };
  }

  async function prepareCanonicalGetAfterPost(context, response) {
    const status = responseStatus(response);
    if (status === null) {
      return markRetryable(context, responseCode(response, 'NETWORK_UNAVAILABLE'));
    }
    if (status < 200 || status >= 300) {
      if (RETRYABLE_HTTP_STATUSES.has(status)) {
        return markRetryable(context, responseCode(response), retryDelayMs(response) ?? DEFAULT_RETRY_MS);
      }
      if (status === 410) return markTerminal(context, 'VOICE_UPLOAD_CANCELLED');
      return markTerminal(context, responseCode(response));
    }
    if (!responseIdentityMatches(response, context.operation)) {
      return markTerminal(context, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
    }
    if (PROCESSING_STATES.has(response.data.state)) {
      const delay = retryDelayMs(response);
      if (delay === null) return markTerminal(context, 'VOICE_INVALID_SERVER_RESPONSE');
      const polling = await markPolling(context, response.data, delay);
      if (polling.state === 'disposed' || polling.state === 'lease_lost') return polling;
      return waitWithRenewal(context, delay);
    }
    if (response.data.state === 'ready' || response.data.state === 'failed') return null;
    return markTerminal(context, 'VOICE_INVALID_SERVER_RESPONSE');
  }

  async function processNormal(context, { allowRetryPost = false } = {}) {
    let posts = 0;
    let response;
    try {
      response = await getStatus(context);
    } catch {
      if (!runIsCurrent(context.run)) return disposedResult();
      return markRetryable(context, 'NETWORK_UNAVAILABLE');
    }
    if (response === null) return disposedResult();

    while (runIsCurrent(context.run)) {
      const status = responseStatus(response);

      if (status === 404) {
        if (posts > 0) return markRetryable(context, 'VOICE_UPLOAD_NOT_CONFIRMED');
        let posted;
        try {
          posted = await postOnce(context);
        } catch {
          if (!runIsCurrent(context.run)) return disposedResult();
          return markRetryable(context, 'NETWORK_UNAVAILABLE');
        }
        if (posted.disposed) return disposedResult();
        if (posted.localFailure) return markTerminal(context, posted.localFailure);
        posts += 1;
        const prepared = await prepareCanonicalGetAfterPost(context, posted.response);
        if (prepared) return prepared;
        try {
          response = await getStatus(context);
        } catch {
          if (!runIsCurrent(context.run)) return disposedResult();
          return markRetryable(context, 'NETWORK_UNAVAILABLE');
        }
        if (response === null) return disposedResult();
        continue;
      }

      if (status === null) {
        const code = responseCode(response, 'NETWORK_UNAVAILABLE');
        return markRetryable(context, code === 'REQUEST_ABORTED' ? 'NETWORK_UNAVAILABLE' : code);
      }
      if (status < 200 || status >= 300) {
        if (status === 410) return markTerminal(context, 'VOICE_UPLOAD_CANCELLED');
        if (RETRYABLE_HTTP_STATUSES.has(status)) {
          return markRetryable(context, responseCode(response), retryDelayMs(response) ?? DEFAULT_RETRY_MS);
        }
        return markTerminal(context, responseCode(response));
      }
      if (!responseIdentityMatches(response, context.operation)) {
        return markTerminal(context, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
      }

      const { data } = response;
      if (data.state === 'ready') return markReady(context, data);
      if (PROCESSING_STATES.has(data.state)) {
        const delay = retryDelayMs(response);
        if (delay === null) return markTerminal(context, 'VOICE_INVALID_SERVER_RESPONSE');
        const polling = await markPolling(context, data, delay);
        if (polling.state === 'disposed' || polling.state === 'lease_lost') return polling;
        const waited = await waitWithRenewal(context, delay);
        if (waited) return waited;
        try {
          response = await getStatus(context);
        } catch {
          if (!runIsCurrent(context.run)) return disposedResult();
          return markRetryable(context, 'NETWORK_UNAVAILABLE');
        }
        if (response === null) return disposedResult();
        continue;
      }
      if (data.state === 'failed') {
        if (data.retryable === true && posts === 0 && allowRetryPost) {
          let posted;
          try {
            posted = await postOnce(context);
          } catch {
            if (!runIsCurrent(context.run)) return disposedResult();
            return markRetryable(context, 'NETWORK_UNAVAILABLE');
          }
          if (posted.disposed) return disposedResult();
          if (posted.localFailure) return markRetryable(context, data.failureCode ?? posted.localFailure);
          posts += 1;
          const prepared = await prepareCanonicalGetAfterPost(context, posted.response);
          if (prepared) return prepared;
          try {
            response = await getStatus(context);
          } catch {
            if (!runIsCurrent(context.run)) return disposedResult();
            return markRetryable(context, 'NETWORK_UNAVAILABLE');
          }
          if (response === null) return disposedResult();
          continue;
        }
        return data.retryable === true
          ? markRetryable(context, responseCode(response, 'VOICE_TRANSCRIPTION_FAILED'), retryDelayMs(response) ?? DEFAULT_RETRY_MS)
          : markTerminal(context, responseCode(response, 'VOICE_TRANSCRIPTION_FAILED'));
      }
      return markTerminal(context, 'VOICE_INVALID_SERVER_RESPONSE');
    }
    return disposedResult();
  }

  async function consumeAttached(context) {
    if (!runIsCurrent(context.run)) return disposedResult();
    const consumed = await store.consume({
      clientUploadId: context.operation.clientUploadId,
      clientSessionScope: context.operation.clientSessionScope,
    });
    if (!runIsCurrent(context.run)) return disposedResult();
    return consumed
      ? { state: 'consumed', failureCode: 'VOICE_DRAFT_ALREADY_ATTACHED' }
      : leaseLostResult();
  }

  async function processCancel(context) {
    let statusResponse;
    try {
      statusResponse = await getStatus(context);
    } catch {
      if (!runIsCurrent(context.run)) return disposedResult();
      return markCancelPending(context, 'NETWORK_UNAVAILABLE');
    }
    if (statusResponse === null) return disposedResult();
    const status = responseStatus(statusResponse);
    const code = responseCode(statusResponse);
    if (status === 409 && code === 'VOICE_DRAFT_ALREADY_ATTACHED') return consumeAttached(context);
    if (status === 404 || status === 410 || code === 'VOICE_UPLOAD_CANCELLED') return markCancelled(context);
    if (status === null || RETRYABLE_HTTP_STATUSES.has(status)) {
      return markCancelPending(context, code, retryDelayMs(statusResponse) ?? DEFAULT_RETRY_MS);
    }
    if (status < 200 || status >= 300) return markCancelPending(context, code);
    if (!responseIdentityMatches(statusResponse, context.operation)) {
      return markCancelPending(context, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
    }

    let deleted;
    try {
      deleted = await transport.deleteUpload({
        clientUploadId: context.operation.clientUploadId,
        requestSha256: context.operation.requestSha256,
        signal: context.run.controller.signal,
      });
    } catch {
      if (!runIsCurrent(context.run)) return disposedResult();
      return markCancelPending(context, 'NETWORK_UNAVAILABLE');
    }
    if (!runIsCurrent(context.run)) return disposedResult();
    const deleteStatus = responseStatus(deleted);
    const deleteCode = responseCode(deleted);
    if (deleteStatus === 409 && deleteCode === 'VOICE_DRAFT_ALREADY_ATTACHED') return consumeAttached(context);
    if (deleteStatus === 404 || deleteStatus === 410 || deleteCode === 'VOICE_UPLOAD_CANCELLED') {
      return markCancelled(context);
    }
    if (deleteStatus !== null && deleteStatus >= 200 && deleteStatus < 300) {
      if (!responseIdentityMatches(deleted, context.operation)) {
        return markCancelPending(context, 'VOICE_RESPONSE_IDENTITY_MISMATCH');
      }
      return markCancelPending(context, 'VOICE_INVALID_SERVER_RESPONSE');
    }
    return markCancelPending(
      context,
      deleteCode,
      retryDelayMs(deleted) ?? DEFAULT_RETRY_MS,
    );
  }

  async function executeClaimed(claim, run, { allowRetryPost = false } = {}) {
    if (!runIsCurrent(run)) return disposedResult();
    if (!claim) return { state: 'idle' };
    const context = { operation: claim, run };
    try {
      return claim.state === 'cancel_pending'
        ? await processCancel(context)
        : await processNormal(context, { allowRetryPost });
    } catch {
      if (!runIsCurrent(run)) return disposedResult();
      return claim.state === 'cancel_pending'
        ? markCancelPending(context, 'NETWORK_UNAVAILABLE')
        : markRetryable(context, 'NETWORK_UNAVAILABLE');
    }
  }

  async function withRun(callback) {
    const run = beginRun();
    if (!run) return disposedResult();
    try {
      return await callback(run);
    } finally {
      finishRun(run);
    }
  }

  function runByIdWithOptions({ clientUploadId, clientSessionScope } = {}, { allowRetryPost = false } = {}) {
    const identity = requireOperationIdentity(clientUploadId, clientSessionScope);
    return withRun(async (run) => {
      const claim = await store.claimById({
        ...identity,
        workerId,
        nowMs: nowMs(),
      });
      return executeClaimed(claim, run, { allowRetryPost });
    });
  }

  function runById(input) {
    return runByIdWithOptions(input);
  }

  function runNext({ clientSessionScope } = {}) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    return withRun(async (run) => {
      const claim = await store.claimNext({
        clientSessionScope: scope,
        workerId,
        nowMs: nowMs(),
      });
      return executeClaimed(claim, run);
    });
  }

  function retry(input) {
    return runByIdWithOptions(input, { allowRetryPost: true });
  }

  function cancel({ clientUploadId, clientSessionScope } = {}) {
    const identity = requireOperationIdentity(clientUploadId, clientSessionScope);
    return withRun(async (run) => {
      const current = await store.get(identity.clientUploadId);
      if (!runIsCurrent(run)) return disposedResult();
      const tombstone = current?.state === 'cancel_pending'
        ? current
        : await store.cancel({ ...identity, nowMs: nowMs() });
      if (!runIsCurrent(run)) return disposedResult();
      if (!tombstone) return { state: 'idle' };
      const claim = await store.claimById({
        ...identity,
        workerId,
        nowMs: nowMs(),
      });
      return executeClaimed(claim, run);
    });
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    coordinatorEpoch += 1;
    const reason = abortReason();
    for (const controller of activeControllers) controller.abort(reason);
    activeControllers.clear();
  }

  return {
    cancel,
    dispose,
    retry,
    runById,
    runNext,
  };
}
