const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;
const SAFE_ERROR_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const PROCESSING_STATES = new Set(['uploading', 'transcribing']);
const ASR_LANGUAGES = new Set(['en', 'yue-Hant-HK', 'cmn-Hans-CN']);

function requireIdentity(clientUploadId, requestSha256) {
  if (typeof clientUploadId !== 'string' || !UUID.test(clientUploadId)) {
    throw new TypeError('clientUploadId must be a UUID');
  }
  if (typeof requestSha256 !== 'string' || !LOWERCASE_SHA256.test(requestSha256)) {
    throw new TypeError('requestSha256 must be a lowercase SHA-256 digest');
  }
  return { clientUploadId, requestSha256 };
}

function uploadPath(clientUploadId) {
  return `/api/v1/voice/uploads/${clientUploadId}`;
}

function normalizedFailure(code, { status = null, location = null, retryAfter = null, retryAfterMs = null } = {}) {
  return {
    ok: false,
    status,
    data: null,
    error: {
      code,
      message: code === 'REQUEST_ABORTED'
        ? 'The voice request was cancelled.'
        : 'The voice request could not be completed.',
    },
    location,
    retryAfter,
    retryAfterMs,
  };
}

function parseRetryAfter(value, nowMs) {
  if (value === null) return null;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) return null;
    return seconds * 1_000;
  }
  const retryAt = Date.parse(value);
  if (!Number.isFinite(retryAt)) return null;
  return Math.max(0, retryAt - nowMs);
}

function normalizeLocation(value, expectedPath, origin) {
  if (value === null) return null;
  try {
    const parsed = new URL(value, `${origin}/`);
    if (parsed.origin !== origin
      || parsed.pathname !== expectedPath
      || parsed.search !== ''
      || parsed.hash !== '') return null;
    return expectedPath;
  } catch {
    return null;
  }
}

function parseEnvelope(text) {
  if (typeof text !== 'string' || text === '') return null;
  try {
    const body = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

function normalizeServerError(envelope) {
  const code = envelope?.error?.code;
  return typeof code === 'string' && SAFE_ERROR_CODE.test(code) ? code : 'INVALID_RESPONSE';
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value) throw new TypeError('origin is required');
  let parsed;
  try { parsed = new URL(value); } catch { throw new TypeError('origin must be an HTTP origin'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
    throw new TypeError('origin must be an HTTP origin');
  }
  return parsed.origin;
}

function cancelResponseBody(response) {
  try {
    const pending = response?.body?.cancel?.();
    void Promise.resolve(pending).catch(() => undefined);
  } catch { /* best-effort connection cleanup */ }
}

function responseUrlIsTrusted(response, requestPath, origin) {
  if (response?.redirected === true) return false;
  const value = response?.url;
  if (value === undefined || value === null || value === '') return true;
  try {
    const parsed = new URL(value, `${origin}/`);
    return parsed.origin === origin
      && parsed.pathname === requestPath
      && parsed.search === ''
      && parsed.hash === '';
  } catch {
    return false;
  }
}

async function responseTextWithAbort(response, signal) {
  if (signal?.aborted) {
    cancelResponseBody(response);
    throw new DOMException('The request was aborted.', 'AbortError');
  }
  if (!signal?.addEventListener) return response.text();

  let abortListener;
  const aborted = new Promise((_, reject) => {
    abortListener = () => {
      cancelResponseBody(response);
      reject(new DOMException('The request was aborted.', 'AbortError'));
    };
    signal.addEventListener('abort', abortListener, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => response.text()),
      aborted,
    ]);
  } finally {
    signal.removeEventListener?.('abort', abortListener);
  }
}

export function createVoiceTransport({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  origin = globalThis.location?.origin,
  csrfHeaders = {},
  getCsrfHeaders,
  now = () => Date.now(),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch is required');
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const trustedOrigin = normalizeOrigin(origin);
  if (getCsrfHeaders !== undefined && typeof getCsrfHeaders !== 'function') {
    throw new TypeError('getCsrfHeaders must be a function');
  }

  async function mutationHeaders(context) {
    const injected = getCsrfHeaders ? await getCsrfHeaders(context) : csrfHeaders;
    return new Headers(injected ?? {});
  }

  async function request({ path, method, clientUploadId, requestSha256, headers, body, signal }) {
    let response;
    try {
      response = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        redirect: 'error',
        signal,
        headers,
        body,
      });
    } catch (error) {
      return normalizedFailure(
        signal?.aborted || error?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'NETWORK_UNAVAILABLE',
      );
    }

    if (!responseUrlIsTrusted(response, path, trustedOrigin)) {
      await cancelResponseBody(response);
      return normalizedFailure('INVALID_RESPONSE');
    }

    const status = Number.isInteger(response?.status) ? response.status : null;
    const expectedLocation = uploadPath(clientUploadId);
    const locationHeader = response?.headers?.get?.('Location') ?? null;
    const retryAfter = response?.headers?.get?.('Retry-After') ?? null;
    const retryAfterMs = parseRetryAfter(retryAfter, Number(now()));
    const location = normalizeLocation(locationHeader, expectedLocation, trustedOrigin);
    const metadata = { status, location, retryAfter, retryAfterMs };

    if (locationHeader !== null && location === null) {
      await cancelResponseBody(response);
      return normalizedFailure('INVALID_RESPONSE', { ...metadata, location: null });
    }

    let envelope;
    try {
      envelope = parseEnvelope(await responseTextWithAbort(response, signal));
    } catch (error) {
      return normalizedFailure(
        signal?.aborted || error?.name === 'AbortError' ? 'REQUEST_ABORTED' : 'INVALID_RESPONSE',
        metadata,
      );
    }

    if (response.ok !== true) {
      return normalizedFailure(normalizeServerError(envelope), metadata);
    }

    if (!envelope
      || envelope.error !== null
      || !Object.prototype.hasOwnProperty.call(envelope, 'data')
      || !envelope.data
      || typeof envelope.data !== 'object'
      || envelope.data.clientUploadId !== clientUploadId
      || envelope.data.requestSha256 !== requestSha256
      || !LOWERCASE_SHA256.test(envelope.data.requestSha256)) {
      return normalizedFailure('INVALID_RESPONSE', metadata);
    }

    if (status === 202 && (
      location === null
      || retryAfterMs === null
      || retryAfterMs <= 0
      || !PROCESSING_STATES.has(envelope.data.state)
    )) {
      return normalizedFailure('INVALID_RESPONSE', metadata);
    }

    return {
      ok: true,
      status,
      data: envelope.data,
      error: null,
      location,
      retryAfter,
      retryAfterMs,
    };
  }

  async function getUploadStatus({ clientUploadId, requestSha256, signal } = {}) {
    const identity = requireIdentity(clientUploadId, requestSha256);
    const path = uploadPath(identity.clientUploadId);
    return request({
      path,
      method: 'GET',
      ...identity,
      headers: new Headers(),
      signal,
    });
  }

  async function postUpload({ clientUploadId, requestSha256, asrLanguage, audio, signal } = {}) {
    const identity = requireIdentity(clientUploadId, requestSha256);
    if (!(audio instanceof Blob) || audio.type !== 'audio/wav') {
      throw new TypeError('audio must be an audio/wav Blob');
    }
    if (!ASR_LANGUAGES.has(asrLanguage)) {
      throw new TypeError('ASR language must be en, yue-Hant-HK, or cmn-Hans-CN');
    }
    const path = '/api/v1/voice/transcriptions';
    let headers;
    try {
      headers = await mutationHeaders({ method: 'POST', path });
    } catch {
      return normalizedFailure(signal?.aborted ? 'REQUEST_ABORTED' : 'REQUEST_SETUP_FAILED');
    }
    headers.set('Content-Type', 'audio/wav');
    headers.set('X-Client-Upload-Id', identity.clientUploadId);
    headers.set('X-Content-SHA256', identity.requestSha256);
    headers.set('X-ASR-Language', asrLanguage);
    return request({
      path,
      method: 'POST',
      ...identity,
      headers,
      body: audio,
      signal,
    });
  }

  async function deleteUpload({ clientUploadId, requestSha256, signal } = {}) {
    const identity = requireIdentity(clientUploadId, requestSha256);
    const path = uploadPath(identity.clientUploadId);
    let headers;
    try {
      headers = await mutationHeaders({ method: 'DELETE', path });
    } catch {
      return normalizedFailure(signal?.aborted ? 'REQUEST_ABORTED' : 'REQUEST_SETUP_FAILED');
    }
    return request({
      path,
      method: 'DELETE',
      ...identity,
      headers,
      signal,
    });
  }

  return { getUploadStatus, postUpload, deleteUpload };
}
