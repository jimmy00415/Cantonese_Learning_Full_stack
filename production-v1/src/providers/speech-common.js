export const SPEECH_LIMITS = Object.freeze({
  deadlineMs: 15_000,
  asrResponseBytes: 256 * 1024,
  audioBytes: 4 * 1024 * 1024,
  minimaxHexCharacters: 8 * 1024 * 1024,
  minimaxJsonBytes: 9 * 1024 * 1024,
  retries: 0,
});

export class SpeechProviderError extends Error {
  constructor(code, { httpStatus, retryable, category = null } = {}) {
    super(code);
    this.name = 'SpeechProviderError';
    this.code = code;
    this.httpStatus = httpStatus;
    this.status = httpStatus;
    this.retryable = Boolean(retryable);
    this.category = category;
  }
}

export function speechError(code, httpStatus, retryable, category) {
  return new SpeechProviderError(code, { httpStatus, retryable, category });
}

export function safeHttpsBase(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  return url.href.replace(/\/+$/, '');
}

export async function readBoundedResponse(response, maximumBytes, signal) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maximumBytes) throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
    return buffer;
  }
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      if (signal.aborted) throw signal.reason ?? new Error('aborted');
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, total);
}

export async function withSpeechDeadline({ signal, deadlineMs, operation }) {
  const controller = new AbortController();
  let deadlineFired = false;
  let externalFired = false;
  const abortFromExternal = () => {
    externalFired = true;
    controller.abort(signal?.reason);
  };
  if (signal?.aborted) abortFromExternal();
  else signal?.addEventListener?.('abort', abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    deadlineFired = true;
    controller.abort(speechError('VOICE_PROVIDER_TIMEOUT', 504, true, 'deadline'));
  }, Math.max(1, Number(deadlineMs) || SPEECH_LIMITS.deadlineMs));
  timer.unref?.();
  try {
    return await operation(controller.signal);
  } catch (error) {
    if (deadlineFired) throw speechError('VOICE_PROVIDER_TIMEOUT', 504, true, 'deadline');
    if (externalFired) throw speechError('VOICE_UPLOAD_ABORTED', 408, true, 'client_abort');
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortFromExternal);
  }
}

export function responseContentType(response) {
  return String(response.headers?.get?.('content-type') ?? '').split(';', 1)[0].trim().toLowerCase();
}

export function isMp3(buffer) {
  return buffer.length >= 3 && buffer.subarray(0, 3).toString('ascii') === 'ID3'
    || buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

export function logSpeech(logger, fields) {
  logger?.info?.({
    stage: fields.stage,
    provider: fields.provider,
    statusClass: fields.statusClass,
    latencyMs: fields.latencyMs,
    byteCount: fields.byteCount,
    errorCode: fields.errorCode,
  });
}
