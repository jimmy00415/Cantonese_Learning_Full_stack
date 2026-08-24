import { createHash, randomUUID } from 'node:crypto';

import { validateCanonicalWav } from '../media/canonical-wav.js';
import { providerConfigDigest } from './voice-evidence.js';
import { rateLimitBucket } from './rate-limiter.js';

export const voiceLimits = Object.freeze({
  uploadBytes: 8 * 1024 * 1024,
  ingressIdleMs: 10_000,
  ingressAbsoluteMs: 30_000,
  providerDeadlineMs: 15_000,
  mediaDeadlineMs: 15_000,
  voiceAttemptMs: 60_000,
  ttsAttemptMs: 30_000,
  leaseMs: 15_000,
  cleanupGraceMs: 60_000,
});

function workError(code, status, retryable) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  error.httpStatus = status;
  error.retryable = Boolean(retryable);
  return error;
}

function currentDate(now) {
  return new Date(now());
}

function addMs(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds);
}

function retryAfter(blockingExpiresAt, now) {
  return Math.max(1, Math.ceil((new Date(blockingExpiresAt).getTime() - new Date(now).getTime()) / 1_000));
}

function normalizeWorkError(error, capability) {
  if (error?.code === 'VOICE_UPLOAD_TOO_LARGE') return workError('VOICE_UPLOAD_TOO_LARGE', 413, false);
  if (error?.code === 'VOICE_UPLOAD_TIMEOUT') return workError('VOICE_UPLOAD_TIMEOUT', 408, true);
  if (error?.code === 'VOICE_UPLOAD_ABORTED' || error?.code === 'MEDIA_OPERATION_ABORTED') return workError('VOICE_UPLOAD_ABORTED', 408, true);
  if (error?.code === 'VOICE_HASH_MISMATCH' || error?.code === 'VOICE_INVALID_WAV') return error;
  if (typeof error?.code === 'string' && /^VOICE_/.test(error.code)
    && Number.isInteger(error.httpStatus ?? error.status)) return error;
  if (['MEDIA_UNAVAILABLE', 'MEDIA_NOT_FOUND', 'MEDIA_DELETE_FAILED'].includes(error?.code)) {
    return workError('VOICE_MEDIA_UNAVAILABLE', 503, true);
  }
  return capability === 'asr'
    ? workError('VOICE_TRANSCRIPTION_FAILED', 502, true)
    : workError('VOICE_SYNTHESIS_FAILED', 502, true);
}

async function withOperationDeadline({ signal, deadlineMs, timeoutError, operation }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(
    signal?.reason ?? workError('VOICE_UPLOAD_ABORTED', 408, true),
  );
  if (signal?.aborted) abortFromParent();
  else signal?.addEventListener?.('abort', abortFromParent, { once: true });
  let removeAbortListener = () => undefined;
  const aborted = controller.signal.aborted
    ? Promise.reject(controller.signal.reason)
    : new Promise((resolve, reject) => {
      void resolve;
      const onAbort = () => reject(controller.signal.reason);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });
  const timer = setTimeout(() => controller.abort(timeoutError), Math.max(1, Number(deadlineMs)));
  timer.unref?.();
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      aborted,
    ]);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    signal?.removeEventListener?.('abort', abortFromParent);
  }
}

export async function* withIngressDeadlines(source, {
  idleMs = voiceLimits.ingressIdleMs,
  absoluteMs = voiceLimits.ingressAbsoluteMs,
  now = Date.now,
} = {}) {
  const iterator = source?.[Symbol.asyncIterator]?.();
  if (!iterator) throw new Error('Voice body must be an async iterable');
  const deadlineAt = now() + absoluteMs;
  try {
    while (true) {
      const remaining = deadlineAt - now();
      if (remaining <= 0) throw workError('VOICE_UPLOAD_TIMEOUT', 408, true);
      const waitMs = Math.min(idleMs, remaining);
      let timer;
      const timed = new Promise((resolve, reject) => {
        void resolve;
        timer = setTimeout(() => reject(workError('VOICE_UPLOAD_TIMEOUT', 408, true)), waitMs);
        timer.unref?.();
      });
      let result;
      try { result = await Promise.race([iterator.next(), timed]); } finally { clearTimeout(timer); }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    await iterator.return?.().catch?.(() => undefined);
  }
}

async function readMediaBuffer(mediaStore, storageKey, byteLength, signal) {
  if (!Number.isSafeInteger(byteLength) || byteLength < 1 || byteLength > voiceLimits.uploadBytes) {
    throw workError('VOICE_INVALID_WAV', 422, false);
  }
  const opened = await mediaStore.open({ storageKey, start: 0, end: byteLength - 1, signal });
  const chunks = [];
  let total = 0;
  for await (const value of opened.readable) {
    const chunk = Buffer.from(value);
    total += chunk.length;
    if (total > voiceLimits.uploadBytes) throw workError('VOICE_INVALID_WAV', 422, false);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

function uploadPublic(upload) {
  const asset = upload.mediaAsset ?? null;
  if (upload.state === 'ready') {
    return {
      clientUploadId: upload.clientUploadId,
      state: 'ready',
      transcript: upload.transcript,
      voiceDraftId: upload.mediaAssetId,
      mediaId: upload.mediaAssetId,
      durationMs: asset?.durationMs ?? null,
      retryable: false,
    };
  }
  return {
    clientUploadId: upload.clientUploadId,
    state: upload.state,
    failureCode: upload.failureCode ?? null,
    retryable: Boolean(upload.retryable),
  };
}

function generationPublic(generation) {
  return {
    messageId: generation.ownerMessageId,
    state: generation.state,
    mediaId: generation.mediaAssetId ?? null,
    failureCode: generation.failureCode ?? null,
    retryable: Boolean(generation.retryable),
  };
}

function createHeartbeat({ renew, hardDeadline, now, externalSignal }) {
  const controller = new AbortController();
  const abortExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener?.('abort', abortExternal, { once: true });
  let renewing = false;
  const timer = setInterval(async () => {
    if (renewing || controller.signal.aborted) return;
    renewing = true;
    try {
      const current = currentDate(now);
      const requested = new Date(Math.min(addMs(current, voiceLimits.leaseMs).getTime(), new Date(hardDeadline).getTime()));
      await renew(requested, current);
    } catch (error) {
      controller.abort(error);
    } finally {
      renewing = false;
    }
  }, 5_000);
  timer.unref?.();
  return {
    signal: controller.signal,
    stop() {
      clearInterval(timer);
      externalSignal?.removeEventListener?.('abort', abortExternal);
    },
  };
}

export function createVoiceService({
  config,
  store,
  mediaStore,
  asrProvider,
  ttsProvider,
  cleanupService,
  eventHub,
  now = () => new Date(),
  mediaDeadlineMs = voiceLimits.mediaDeadlineMs,
} = {}) {
  if (!config || !store || !mediaStore) throw new Error('Voice service requires config, store, and mediaStore');
  const secret = config.sessionSecret ?? 'local-development-session-secret';

  const asrBuckets = (sessionId, current) => [
    rateLimitBucket({ secret, subject: sessionId, quota: 'asr-10m', limit: config.rateLimits.asr10m, durationMs: 10 * 60 * 1_000, now: current.getTime() }),
    rateLimitBucket({ secret, subject: sessionId, quota: 'asr-day', limit: config.rateLimits.asrDaily, durationMs: 24 * 60 * 60 * 1_000, now: current.getTime() }),
  ];
  const ttsBuckets = (sessionId, current) => [
    rateLimitBucket({ secret, subject: sessionId, quota: 'tts-10m', limit: config.rateLimits.tts10m, durationMs: 10 * 60 * 1_000, now: current.getTime() }),
    rateLimitBucket({ secret, subject: sessionId, quota: 'tts-day', limit: config.rateLimits.ttsDaily, durationMs: 24 * 60 * 60 * 1_000, now: current.getTime() }),
  ];

  const drainCleanup = async () => cleanupService?.drainOnce?.().catch(() => undefined);

  const transcribe = async ({
    sessionId, clientUploadId, requestSha256, mimeType, readable, signal,
    idleMs = voiceLimits.ingressIdleMs, absoluteMs = voiceLimits.ingressAbsoluteMs,
  }) => {
    const startedAt = currentDate(now);
    const hardDeadline = addMs(startedAt, voiceLimits.voiceAttemptMs);
    const leaseToken = randomUUID();
    const attemptStorageKey = mediaStore.createAttemptKey({ kind: 'voice' });
    const claim = await store.claimVoiceUploadWithRateLimits({
      sessionId, clientUploadId, requestSha256, mimeType,
      rateLimits: asrBuckets(sessionId, startedAt), leaseToken, attemptStorageKey,
      leaseExpiresAt: addMs(startedAt, voiceLimits.leaseMs),
      attemptDeadlineAt: hardDeadline,
      now: startedAt,
    });
    if (claim.status === 'ready') return { httpStatus: 200, data: uploadPublic({ ...claim.upload, mediaAsset: claim.mediaAsset }) };
    if (claim.status === 'live') {
      return { httpStatus: 202, data: uploadPublic(claim.upload), retryAfter: 1, location: `/api/v1/voice/uploads/${clientUploadId}` };
    }
    if (claim.status === 'conflict') throw workError('IDEMPOTENCY_CONFLICT', 409, false);
    if (claim.status === 'permanent_failure') throw workError(claim.failureCode, claim.failureHttpStatus, false);
    if (claim.status === 'rate_limited') {
      const error = workError('RATE_LIMITED', 429, true);
      error.retryAfter = retryAfter(claim.blockingExpiresAt, startedAt);
      throw error;
    }
    if (!asrProvider?.transcribe) throw workError('VOICE_PROVIDER_MISCONFIGURED', 503, false);

    const heartbeat = createHeartbeat({
      hardDeadline,
      now,
      externalSignal: signal,
      renew: (leaseExpiresAt, current) => store.renewVoiceUploadLease({
        uploadId: claim.upload.id, leaseToken, leaseExpiresAt, now: current,
      }),
    });
    let objectWritten = false;
    try {
      const stored = await withOperationDeadline({
        signal: heartbeat.signal,
        deadlineMs: mediaDeadlineMs,
        timeoutError: workError('VOICE_MEDIA_UNAVAILABLE', 503, true),
        operation: (mediaSignal) => mediaStore.putAttempt({
          storageKey: attemptStorageKey,
          readable: withIngressDeadlines(readable, { idleMs, absoluteMs }),
          maxBytes: voiceLimits.uploadBytes,
          signal: mediaSignal,
          contentType: 'audio/wav',
        }),
      });
      objectWritten = true;
      const buffer = await withOperationDeadline({
        signal: heartbeat.signal,
        deadlineMs: mediaDeadlineMs,
        timeoutError: workError('VOICE_MEDIA_UNAVAILABLE', 503, true),
        operation: (mediaSignal) => readMediaBuffer(mediaStore, attemptStorageKey, stored.byteLength, mediaSignal),
      });
      const wav = validateCanonicalWav(buffer, { expectedSha256: requestSha256 });
      await store.setVoiceUploadTranscribing({ uploadId: claim.upload.id, leaseToken, now: currentDate(now) });
      const transcript = await asrProvider.transcribe(buffer, { signal: heartbeat.signal });
      const completed = await store.completeVoiceUpload({
        uploadId: claim.upload.id,
        leaseToken,
        mediaAsset: {
          storageKey: attemptStorageKey, mimeType: 'audio/wav', byteLength: wav.byteLength,
          durationMs: wav.durationMs, sha256: wav.sha256,
        },
        transcript: transcript.transcript,
        now: currentDate(now),
      });
      return { httpStatus: 201, data: uploadPublic({ ...completed.upload, mediaAsset: completed.mediaAsset }) };
    } catch (rawError) {
      const error = normalizeWorkError(rawError, 'asr');
      try {
        await store.failVoiceUpload({
          uploadId: claim.upload.id, leaseToken,
          failureCode: error.code, failureHttpStatus: error.httpStatus ?? error.status,
          retryable: error.retryable,
          cleanupNotBefore: currentDate(now),
          now: currentDate(now),
        });
      } catch (fenceError) {
        if (objectWritten) {
          await store.rearmMediaDeletionAfterWrite({
            storageKey: attemptStorageKey,
            reason: 'voice-late-write-after-fence-loss',
            notBefore: currentDate(now),
            now: currentDate(now),
          });
        }
        if (fenceError?.code !== 'LEASE_LOST') throw fenceError;
      }
      await drainCleanup();
      throw error;
    } finally {
      heartbeat.stop();
    }
  };

  const getUploadStatus = async ({ sessionId, clientUploadId }) => {
    const upload = await store.getVoiceUploadStatus({ sessionId, clientUploadId });
    const current = currentDate(now);
    if (['uploading', 'transcribing'].includes(upload.state)) {
      const live = upload.leaseExpiresAt && upload.attemptDeadlineAt
        && new Date(upload.leaseExpiresAt) > current && new Date(upload.attemptDeadlineAt) > current;
      if (live) return { httpStatus: 202, data: uploadPublic(upload), retryAfter: 1 };
      return { httpStatus: 200, data: { clientUploadId, state: 'failed', failureCode: 'VOICE_ATTEMPT_EXPIRED', retryable: true } };
    }
    return { httpStatus: 200, data: uploadPublic(upload) };
  };

  const generateAssistantAudio = async ({ sessionId, messageId, signal }) => {
    const current = currentDate(now);
    const hardDeadline = addMs(current, voiceLimits.ttsAttemptMs);
    const leaseToken = randomUUID();
    const attemptStorageKey = mediaStore.createAttemptKey({ kind: 'tts' });
    const claim = await store.claimAssistantAudioWithRateLimits({
      sessionId, messageId, kind: 'assistant_voice', rateLimits: ttsBuckets(sessionId, current),
      leaseToken, attemptStorageKey,
      configVersion: providerConfigDigest(config.tts, 'tts'),
      leaseExpiresAt: addMs(current, voiceLimits.leaseMs), attemptDeadlineAt: hardDeadline, now: current,
    });
    if (claim.status === 'ready') return { httpStatus: 200, data: generationPublic(claim.generation) };
    if (claim.status === 'live') return { httpStatus: 202, data: generationPublic(claim.generation), retryAfter: 1, location: `/api/v1/messages/${messageId}/audio/status` };
    if (claim.status === 'conflict') throw workError('NOT_FOUND', 404, false);
    if (claim.status === 'permanent_failure') throw workError(claim.failureCode, claim.failureHttpStatus, false);
    if (claim.status === 'rate_limited') {
      const error = workError('RATE_LIMITED', 429, true);
      error.retryAfter = retryAfter(claim.blockingExpiresAt, current);
      throw error;
    }
    if (!ttsProvider?.synthesize) throw workError('VOICE_PROVIDER_MISCONFIGURED', 503, false);
    const heartbeat = createHeartbeat({
      hardDeadline, now, externalSignal: signal,
      renew: (leaseExpiresAt, at) => store.renewMediaGenerationLease({ generationId: claim.generation.id, leaseToken, leaseExpiresAt, now: at }),
    });
    let objectWritten = false;
    try {
      const synthesized = await ttsProvider.synthesize(claim.message.text, { signal: heartbeat.signal });
      const stored = await withOperationDeadline({
        signal: heartbeat.signal,
        deadlineMs: mediaDeadlineMs,
        timeoutError: workError('VOICE_MEDIA_UNAVAILABLE', 503, true),
        operation: (mediaSignal) => mediaStore.putAttempt({
          storageKey: attemptStorageKey,
          readable: [synthesized.buffer],
          maxBytes: 4 * 1024 * 1024,
          signal: mediaSignal,
          contentType: 'audio/mpeg',
        }),
      });
      objectWritten = true;
      const completed = await store.completeMediaGeneration({
        generationId: claim.generation.id, leaseToken,
        mediaAsset: {
          storageKey: attemptStorageKey, mimeType: 'audio/mpeg', byteLength: stored.byteLength,
          sha256: stored.sha256,
        },
        now: currentDate(now),
      });
      eventHub?.publish?.({ sessionId, conversationId: completed.message.conversationId, cursor: completed.event.cursor });
      return { httpStatus: 201, data: generationPublic(completed.generation) };
    } catch (rawError) {
      const error = normalizeWorkError(rawError, 'tts');
      try {
        await store.failMediaGeneration({
          generationId: claim.generation.id, leaseToken,
          failureCode: error.code, failureHttpStatus: error.httpStatus ?? error.status,
          retryable: error.retryable, cleanupNotBefore: currentDate(now), now: currentDate(now),
        });
      } catch (fenceError) {
        if (objectWritten) {
          await store.rearmMediaDeletionAfterWrite({
            storageKey: attemptStorageKey,
            reason: 'tts-late-write-after-fence-loss',
            notBefore: currentDate(now), now: currentDate(now),
          });
        }
        if (fenceError?.code !== 'LEASE_LOST') throw fenceError;
      }
      await drainCleanup();
      throw error;
    } finally {
      heartbeat.stop();
    }
  };

  const getAssistantAudioStatus = async ({ sessionId, messageId }) => {
    const generation = await store.getAssistantAudioStatus({ sessionId, messageId, kind: 'assistant_voice' });
    const current = currentDate(now);
    if (generation.state === 'generating') {
      const live = generation.leaseExpiresAt && generation.attemptDeadlineAt
        && new Date(generation.leaseExpiresAt) > current && new Date(generation.attemptDeadlineAt) > current;
      if (live) return { httpStatus: 202, data: generationPublic(generation), retryAfter: 1 };
      return { httpStatus: 200, data: { messageId, state: 'failed', failureCode: 'VOICE_ATTEMPT_EXPIRED', retryable: true } };
    }
    return { httpStatus: 200, data: generationPublic(generation) };
  };

  return {
    transcribe,
    getUploadStatus,
    generateAssistantAudio,
    getAssistantAudioStatus,
    revokeVoiceDraft: (input) => store.revokeVoiceDraft({ ...input, now: currentDate(now), cleanupNotBefore: currentDate(now) }),
  };
}
