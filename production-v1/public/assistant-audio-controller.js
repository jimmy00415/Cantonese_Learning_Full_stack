export function createAssistantAudioController({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  AudioClass = globalThis.Audio,
  audioMount = globalThis.document?.body,
  origin = globalThis.location?.origin,
  onChange = () => {},
  now = () => Date.now(),
  maxRetryAfterMs = 30_000,
  maxPollMs = 35_000,
  sleep = (milliseconds, { signal } = {}) => new Promise((resolve, reject) => {
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
    function done() { cleanup(); resolve(); }
    function aborted() { cleanup(); reject(signal.reason); }
  }),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (typeof AudioClass !== 'function') throw new TypeError('Audio is required');
  if (typeof onChange !== 'function') throw new TypeError('onChange must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  if (typeof sleep !== 'function') throw new TypeError('sleep must be a function');
  if (!Number.isFinite(maxRetryAfterMs) || maxRetryAfterMs <= 0) {
    throw new TypeError('maxRetryAfterMs must be positive');
  }
  if (!Number.isFinite(maxPollMs) || maxPollMs <= 0) throw new TypeError('maxPollMs must be positive');
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); } catch { throw new TypeError('origin must be an HTTP origin'); }
  if (!['http:', 'https:'].includes(parsedOrigin.protocol) || parsedOrigin.origin === 'null') {
    throw new TypeError('origin must be an HTTP origin');
  }
  const trustedOrigin = parsedOrigin.origin;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const safeCode = /^[A-Z][A-Z0-9_]{0,79}$/;
  const retryableCodes = new Set([
    'RATE_LIMITED',
    'VOICE_SYNTHESIS_FAILED',
    'VOICE_PROVIDER_TIMEOUT',
    'VOICE_MEDIA_UNAVAILABLE',
    'VOICE_ATTEMPT_EXPIRED',
  ]);
  const entries = new Map();
  const activeRuns = new Map();
  const cancelledResponses = new WeakSet();
  let disposed = false;
  let playback = null;
  let currentAudio = null;

  function frozenEntry(entry) {
    return Object.freeze({ ...entry });
  }

  function snapshot() {
    const publicEntries = {};
    for (const [messageId, entry] of entries) publicEntries[messageId] = frozenEntry(entry);
    return Object.freeze({
      disposed,
      entries: Object.freeze(publicEntries),
      playback: playback ? Object.freeze({ ...playback }) : null,
    });
  }

  function notify() {
    try { onChange(snapshot()); } catch { /* UI callbacks cannot break protocol state */ }
  }

  function setEntry(messageId, patch) {
    const next = {
      messageId,
      state: 'idle',
      mediaId: null,
      failureCode: null,
      retryable: false,
      retryAfterMs: null,
      retryNotBefore: null,
      statusText: '',
      ...(entries.get(messageId) ?? {}),
      ...patch,
    };
    entries.set(messageId, next);
    notify();
    return frozenEntry(next);
  }

  function requireMessageId(messageId) {
    if (typeof messageId !== 'string' || !uuid.test(messageId)) {
      throw new TypeError('messageId must be a UUID');
    }
    return messageId;
  }

  function requireMediaId(mediaId) {
    if (typeof mediaId !== 'string' || !uuid.test(mediaId)) {
      throw new TypeError('mediaId must be a UUID');
    }
    return mediaId;
  }

  function statusPath(messageId) {
    return `/api/v1/messages/${messageId}/audio/status`;
  }

  function parseRetryAfter(value) {
    if (typeof value !== 'string' || !value) return null;
    let milliseconds;
    if (/^\d+$/.test(value)) {
      const seconds = Number(value);
      milliseconds = Number.isSafeInteger(seconds) && seconds <= Math.floor(Number.MAX_SAFE_INTEGER / 1_000)
        ? seconds * 1_000
        : null;
    } else {
      const retryAt = Date.parse(value);
      milliseconds = Number.isFinite(retryAt) ? Math.max(0, retryAt - Number(now())) : null;
    }
    return Number.isFinite(milliseconds) && milliseconds <= maxRetryAfterMs ? milliseconds : null;
  }

  function trustedLocation(value, messageId) {
    if (typeof value !== 'string' || !value) return null;
    try {
      const parsed = new URL(value, `${trustedOrigin}/`);
      const expected = statusPath(messageId);
      return parsed.origin === trustedOrigin
        && parsed.pathname === expected
        && parsed.search === ''
        && parsed.hash === ''
        ? expected
        : null;
    } catch {
      return null;
    }
  }

  async function cancelBody(response) {
    if (!response || (typeof response !== 'object' && typeof response !== 'function')) return;
    if (cancelledResponses.has(response)) return;
    cancelledResponses.add(response);
    try { await response?.body?.cancel?.(); } catch { /* connection cleanup is best effort */ }
  }

  function abortedError(signal) {
    const error = signal?.reason instanceof Error
      ? signal.reason
      : new DOMException('The request was aborted.', 'AbortError');
    if (!error.name) error.name = 'AbortError';
    return error;
  }

  function raceAbort(promise, signal, onAbort = () => {}) {
    if (signal?.aborted) {
      void onAbort();
      return Promise.reject(abortedError(signal));
    }
    let listener;
    const aborted = new Promise((_, reject) => {
      listener = () => {
        void onAbort();
        reject(abortedError(signal));
      };
      signal?.addEventListener?.('abort', listener, { once: true });
    });
    return Promise.race([promise, aborted]).finally(() => {
      signal?.removeEventListener?.('abort', listener);
    });
  }

  function responseUrlTrusted(response, path) {
    if (response?.redirected === true) return false;
    if (response?.url === undefined || response?.url === null || response.url === '') return true;
    try {
      const parsed = new URL(response.url, `${trustedOrigin}/`);
      return parsed.origin === trustedOrigin
        && parsed.pathname === path
        && parsed.search === ''
        && parsed.hash === '';
    } catch {
      return false;
    }
  }

  function parseEnvelope(text) {
    try {
      const value = JSON.parse(text);
      return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
    } catch {
      return null;
    }
  }

  async function request(path, method, signal) {
    let response;
    const fetchPromise = Promise.resolve().then(() => fetchImpl(path, {
      method,
      credentials: 'same-origin',
      redirect: 'error',
      signal,
      body: undefined,
    }));
    void fetchPromise.then((lateResponse) => {
      if (signal.aborted) void cancelBody(lateResponse);
    }, () => undefined);
    try {
      response = await raceAbort(fetchPromise, signal);
    } catch (error) {
      return {
        status: null,
        ok: false,
        data: null,
        errorCode: signal.aborted || error?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'NETWORK_UNAVAILABLE',
        retryAfterMs: null,
        location: null,
      };
    }
    if (!responseUrlTrusted(response, path)) {
      await cancelBody(response);
      return {
        status: null,
        ok: false,
        data: null,
        errorCode: 'AUDIO_INVALID_RESPONSE',
        retryAfterMs: null,
        location: null,
      };
    }
    const status = Number.isInteger(response?.status) ? response.status : null;
    const retryAfterMs = parseRetryAfter(response?.headers?.get?.('Retry-After') ?? null);
    const location = response?.headers?.get?.('Location') ?? null;
    let envelopeValue = null;
    try {
      const textPromise = Promise.resolve().then(() => response.text());
      envelopeValue = parseEnvelope(await raceAbort(
        textPromise,
        signal,
        () => cancelBody(response),
      ));
    } catch {
      if (signal.aborted) {
        return {
          status: null,
          ok: false,
          data: null,
          errorCode: 'REQUEST_ABORTED',
          retryAfterMs: null,
          location: null,
        };
      }
      // Other parsing failures are normalized below.
    }
    const responseOk = response?.ok === true;
    const envelopeError = envelopeValue?.error?.code;
    const errorCode = typeof envelopeError === 'string' && safeCode.test(envelopeError)
      ? envelopeError
      : 'AUDIO_INVALID_RESPONSE';
    return {
      status,
      ok: responseOk && envelopeValue?.error === null,
      data: envelopeValue?.data ?? null,
      errorCode,
      retryAfterMs,
      location,
    };
  }

  function statusText(code, retryable) {
    if (code === 'SESSION_NOT_FOUND') {
      return 'This chat expired. The text answer is still available.';
    }
    if (code === 'RATE_LIMITED') {
      return 'Too many audio requests. Wait before trying again. The text answer is still available.';
    }
    if (code === 'NETWORK_UNAVAILABLE' || retryable) {
      return 'Audio could not be generated yet. Try again; the text answer is still available.';
    }
    return 'Audio is not available. The text answer is still available.';
  }

  function failureEntry(messageId, code, { retryable, retryAfterMs = null } = {}) {
    const normalizedCode = typeof code === 'string' && safeCode.test(code) ? code : 'AUDIO_INVALID_RESPONSE';
    const canRetry = Boolean(retryable);
    const clock = Number(now());
    const retryNotBefore = canRetry && Number.isFinite(retryAfterMs) && retryAfterMs > 0 && Number.isFinite(clock)
      ? clock + retryAfterMs
      : null;
    return setEntry(messageId, {
      state: canRetry ? 'retryable' : 'failed',
      mediaId: null,
      failureCode: normalizedCode,
      retryable: canRetry,
      retryAfterMs,
      retryNotBefore,
      statusText: statusText(normalizedCode, canRetry),
    });
  }

  function ready(messageId, data) {
    return setEntry(messageId, {
      state: 'ready',
      mediaId: data.mediaId,
      failureCode: null,
      retryable: false,
      retryAfterMs: null,
      retryNotBefore: null,
      statusText: 'Audio ready. Tap Play to listen.',
    });
  }

  function terminalEntry(messageId, result, method) {
    if (!result.ok) {
      if (method === 'GET' && result.status === 404 && result.errorCode === 'NOT_FOUND') {
        return setEntry(messageId, {
          state: 'missing',
          mediaId: null,
          failureCode: null,
          retryable: false,
          retryAfterMs: null,
          retryNotBefore: null,
          statusText: 'No generated audio was found. You can create it now.',
        });
      }
      const code = result.errorCode;
      const retryable = code === 'NETWORK_UNAVAILABLE'
        || code === 'AUDIO_INVALID_RESPONSE'
        || retryableCodes.has(code)
        || result.status === 408
        || result.status === 425
        || result.status === 429
        || (Number.isInteger(result.status) && result.status >= 500
          && !['VOICE_PROVIDER_MISCONFIGURED', 'VOICE_SYNTHESIS_REJECTED', 'VOICE_PROVIDER_INVALID_RESPONSE', 'VOICE_NOT_RELEASE_VERIFIED'].includes(code));
      return failureEntry(messageId, code, {
        retryable,
        retryAfterMs: result.status === 429 ? Math.max(250, result.retryAfterMs ?? 0) : null,
      });
    }
    const allowedStatus = method === 'POST'
      ? result.status === 200 || result.status === 201
      : result.status === 200;
    if (!allowedStatus) {
      return failureEntry(messageId, 'AUDIO_INVALID_RESPONSE', { retryable: true });
    }
    const data = result.data;
    if (!data || data.messageId !== messageId) {
      return failureEntry(messageId, 'AUDIO_INVALID_RESPONSE', { retryable: true });
    }
    if (data.state === 'attached'
      && uuid.test(data.mediaId ?? '')
      && data.failureCode === null
      && data.retryable === false) return ready(messageId, data);
    if (data.state === 'failed'
      && (data.mediaId === null || data.mediaId === undefined)
      && typeof data.failureCode === 'string'
      && safeCode.test(data.failureCode)
      && typeof data.retryable === 'boolean') {
      return failureEntry(messageId, data.failureCode, { retryable: data.retryable });
    }
    return failureEntry(messageId, 'AUDIO_INVALID_RESPONSE', { retryable: true });
  }

  async function executeRun(id, method, controller) {
    setEntry(id, {
      state: 'generating',
      mediaId: null,
      failureCode: null,
      retryable: false,
      retryAfterMs: null,
      retryNotBefore: null,
      statusText: 'Generating audio…',
    });
    let path = method === 'POST' ? `/api/v1/messages/${id}/audio` : statusPath(id);
    let nextMethod = method;
    const pollStartedAt = Number(now());
    while (!disposed && !controller.signal.aborted) {
      const result = await request(path, nextMethod, controller.signal);
      if (disposed || controller.signal.aborted) return Object.freeze({ state: 'disposed' });
      if (result.status === 202 && result.ok) {
        if (result.data?.messageId !== id
          || result.data?.state !== 'generating'
          || result.data?.mediaId !== null
          || result.data?.failureCode !== null
          || result.data?.retryable !== false) {
          return failureEntry(id, 'AUDIO_INVALID_RESPONSE', { retryable: true });
        }
        const location = trustedLocation(result.location, id);
        const delay = result.retryAfterMs;
        const elapsed = Number(now()) - pollStartedAt;
        if (!location
          || !Number.isFinite(delay)
          || delay <= 0
          || !Number.isFinite(elapsed)
          || elapsed < 0
          || elapsed + delay > maxPollMs) {
          return failureEntry(id, 'AUDIO_INVALID_RESPONSE', { retryable: true });
        }
        await raceAbort(
          Promise.resolve().then(() => sleep(delay, { signal: controller.signal })),
          controller.signal,
        );
        if (disposed || controller.signal.aborted) return Object.freeze({ state: 'disposed' });
        path = location;
        nextMethod = 'GET';
        continue;
      }
      return terminalEntry(id, result, nextMethod);
    }
    return Object.freeze({ state: 'disposed' });
  }

  function run(messageId, method) {
    const id = requireMessageId(messageId);
    if (disposed) return Promise.resolve(Object.freeze({ state: 'disposed' }));
    const existing = activeRuns.get(id);
    if (existing) return existing.promise;
    const current = entries.get(id);
    if (method === 'POST'
      && current?.state === 'retryable'
      && Number.isFinite(current.retryNotBefore)
      && Number(now()) < current.retryNotBefore) {
      return Promise.resolve(frozenEntry(current));
    }
    const controller = new AbortController();
    const token = Object.freeze({});
    const promise = executeRun(id, method, controller)
      .catch(() => (
        disposed || controller.signal.aborted
          ? Object.freeze({ state: 'disposed' })
          : failureEntry(id, 'NETWORK_UNAVAILABLE', { retryable: true })
      ))
      .finally(() => {
        if (activeRuns.get(id)?.token === token) activeRuns.delete(id);
      });
    activeRuns.set(id, { controller, promise, token });
    return promise;
  }

  function prepare(message) {
    if (!message || message.role !== 'assistant' || message.replyMode !== 'voice') return Promise.resolve(null);
    const messageId = requireMessageId(message.id);
    if (message.mediaId) return Promise.resolve(ready(messageId, { mediaId: requireMediaId(message.mediaId) }));
    setEntry(messageId, {
      state: 'pending',
      mediaId: null,
      failureCode: null,
      retryable: false,
      retryAfterMs: null,
      retryNotBefore: null,
      statusText: 'Preparing audio. The text answer is ready.',
    });
    return run(messageId, 'GET');
  }

  function setPlayback(next) {
    playback = next;
    notify();
    return next ? Object.freeze({ ...next }) : null;
  }

  function removeAudioListeners(target) {
    if (!target) return;
    for (const [type, listener] of target.listeners) {
      target.audio.removeEventListener?.(type, listener);
    }
    target.listeners.length = 0;
  }

  function discardCurrentAudio({ pauseAudio = true } = {}) {
    const target = currentAudio;
    if (!target) return;
    if (pauseAudio) {
      try { target.audio.pause?.(); } catch { /* pause is best effort */ }
    }
    removeAudioListeners(target);
    try { target.audio.remove?.(); } catch { /* DOM release is best effort */ }
    currentAudio = null;
  }

  function playbackError(messageId, mediaId) {
    return setPlayback({
      messageId,
      mediaId,
      state: 'error',
      failureCode: 'AUDIO_PLAYBACK_FAILED',
      statusText: 'Audio could not be played. The text answer is still available.',
    });
  }

  async function play({ messageId, mediaId } = {}) {
    const id = requireMessageId(messageId);
    const assetId = requireMediaId(mediaId);
    if (disposed) return Object.freeze({ state: 'disposed' });
    const entry = entries.get(id);
    if (entry?.mediaId && entry.mediaId !== assetId) {
      throw new TypeError('mediaId does not match the ready message audio');
    }
    if (!entry || entry.state !== 'ready' || entry.mediaId !== assetId) {
      setEntry(id, {
        state: 'ready',
        mediaId: assetId,
        failureCode: null,
        retryable: false,
        retryAfterMs: null,
        retryNotBefore: null,
        statusText: 'Audio ready. Tap Play to listen.',
      });
    }

    let target = currentAudio;
    if (!target || target.messageId !== id || target.mediaId !== assetId) {
      discardCurrentAudio();
      let audio;
      try {
        audio = new AudioClass();
        audio.autoplay = false;
        audio.preload = 'none';
        audio.src = `/api/v1/media/${assetId}`;
        audio.hidden = true;
        audio.setAttribute?.('data-assistant-audio-message-id', id);
        audio.setAttribute?.('data-assistant-audio-media-id', assetId);
        audioMount?.append?.(audio);
      } catch {
        return playbackError(id, assetId);
      }
      const token = Object.freeze({});
      target = { audio, messageId: id, mediaId: assetId, token, listeners: [] };
      const ended = () => {
        if (currentAudio?.token !== token || disposed) return;
        setPlayback(null);
      };
      const failed = () => {
        if (currentAudio?.token !== token || disposed) return;
        playbackError(id, assetId);
      };
      for (const [type, listener] of [['ended', ended], ['error', failed]]) {
        audio.addEventListener?.(type, listener);
        target.listeners.push([type, listener]);
      }
      currentAudio = target;
    }

    const token = target.token;
    setPlayback({
      messageId: id,
      mediaId: assetId,
      state: 'playing',
      failureCode: null,
      statusText: 'Playing audio.',
    });
    try {
      await Promise.resolve(target.audio.play());
    } catch {
      if (currentAudio?.token !== token || disposed) return Object.freeze({ state: 'superseded' });
      try { target.audio.pause?.(); } catch { /* pause is best effort */ }
      return playbackError(id, assetId);
    }
    if (currentAudio?.token !== token || disposed) return Object.freeze({ state: 'superseded' });
    return Object.freeze({ ...playback });
  }

  function pause() {
    if (!currentAudio || disposed) return playback ? Object.freeze({ ...playback }) : null;
    try { currentAudio.audio.pause?.(); } catch { /* pause is best effort */ }
    return setPlayback({
      messageId: currentAudio.messageId,
      mediaId: currentAudio.mediaId,
      state: 'paused',
      failureCode: null,
      statusText: 'Audio paused.',
    });
  }

  function handleHidden() {
    return pause();
  }

  function dispose() {
    if (disposed) return snapshot();
    if (currentAudio) {
      try { currentAudio.audio.pause?.(); } catch { /* pause is best effort */ }
      playback = {
        messageId: currentAudio.messageId,
        mediaId: currentAudio.mediaId,
        state: 'paused',
        failureCode: null,
        statusText: 'Audio paused.',
      };
      discardCurrentAudio({ pauseAudio: false });
    }
    disposed = true;
    for (const runState of activeRuns.values()) runState.controller.abort();
    activeRuns.clear();
    notify();
    return snapshot();
  }

  return Object.freeze({
    snapshot,
    generate: async (messageId) => run(messageId, 'POST'),
    refresh: async (messageId) => run(messageId, 'GET'),
    prepare,
    play,
    pause,
    handleHidden,
    dispose,
  });
}
