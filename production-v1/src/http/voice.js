import express from 'express';

import { sendError } from './errors.js';
import { createSessionResolver } from './session.js';
import { createVoiceService, voiceLimits } from '../services/voice.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;

function voiceError(status, code) {
  const error = new Error(code);
  error.status = status;
  error.code = code;
  return error;
}

function envelope(response, data) {
  return { data, error: null, requestId: response.locals.requestId };
}

function currentCapabilities(config, now) {
  return config.getPublicStatus?.(now()) ?? config.publicStatus ?? {};
}

function assertCapability(config, capability, now) {
  const status = currentCapabilities(config, now);
  const available = config.nodeEnv === 'production'
    ? status[capability]
    : status[capability === 'voiceInput' ? 'voiceInputPreview' : 'voiceOutputPreview'];
  if (!available) throw voiceError(503, 'VOICE_NOT_RELEASE_VERIFIED');
}

function operationResponse(response, result) {
  if (result.location) response.set('Location', result.location);
  if (result.retryAfter) response.set('Retry-After', String(result.retryAfter));
  return response.status(result.httpStatus).json(envelope(response, result.data));
}

function parseRange(header, size) {
  if (!header) return null;
  if (header.includes(',')) return false;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return false;
  const left = match[1] ? Number(match[1]) : null;
  const right = match[2] ? Number(match[2]) : null;
  if ((left !== null && !Number.isSafeInteger(left)) || (right !== null && !Number.isSafeInteger(right))) return false;
  if (left === null) {
    if (right <= 0 || right > size) return false;
    return { start: size - right, end: size - 1 };
  }
  if (left < 0 || left >= size) return false;
  const end = right === null ? size - 1 : right;
  if (end < left || end >= size) return false;
  return { start: left, end };
}

function setGenericPrivateHeaders(response) {
  response.set('Cache-Control', 'no-store');
  response.set('X-Content-Type-Options', 'nosniff');
}

function setAuthorizedMediaHeaders(response, asset) {
  response.set('Cache-Control', 'private, no-store');
  response.set('X-Content-Type-Options', 'nosniff');
  response.set('Accept-Ranges', 'bytes');
  response.set('Content-Type', asset.mimeType);
}

export function createVoiceRouter({
  config,
  store,
  mediaStore,
  asrProvider,
  ttsProvider,
  cleanupService,
  eventHub,
  now = () => new Date(),
  voiceService,
} = {}) {
  const router = express.Router();
  const resolveSession = createSessionResolver({ store });
  const service = voiceService ?? createVoiceService({
    config, store, mediaStore, asrProvider, ttsProvider, cleanupService, eventHub, now,
  });

  router.post('/voice/transcriptions', async (request, response) => {
    try {
      const { session } = await resolveSession(request);
      assertCapability(config, 'voiceInput', now);
      const clientUploadId = request.get('x-client-upload-id');
      const requestSha256 = request.get('x-content-sha256');
      if (!UUID.test(clientUploadId ?? '') || !SHA256.test(requestSha256 ?? '')) throw voiceError(400, 'INVALID_REQUEST');
      const declared = request.get('content-length');
      if (declared !== undefined && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) throw voiceError(400, 'INVALID_REQUEST');
      if (declared !== undefined && Number(declared) > voiceLimits.uploadBytes) throw voiceError(413, 'VOICE_UPLOAD_TOO_LARGE');
      if (request.get('content-type') !== 'audio/wav') throw voiceError(415, 'VOICE_UNSUPPORTED_MEDIA_TYPE');
      const controller = new AbortController();
      const abort = () => controller.abort(voiceError(408, 'VOICE_UPLOAD_ABORTED'));
      request.once('aborted', abort);
      try {
        const result = await service.transcribe({
          sessionId: session.id, clientUploadId, requestSha256, mimeType: 'audio/wav',
          readable: request, signal: controller.signal,
        });
        return operationResponse(response, result);
      } finally {
        request.off('aborted', abort);
      }
    } catch (error) {
      if (error.retryAfter) response.set('Retry-After', String(error.retryAfter));
      return sendError(response, error);
    }
  });

  router.get('/voice/uploads/:clientUploadId', async (request, response) => {
    try {
      const { session } = await resolveSession(request);
      if (!UUID.test(request.params.clientUploadId ?? '')) throw voiceError(404, 'NOT_FOUND');
      const result = await service.getUploadStatus({ sessionId: session.id, clientUploadId: request.params.clientUploadId });
      if (result.httpStatus === 202) {
        result.location = request.originalUrl;
        result.retryAfter = 1;
      }
      return operationResponse(response, result);
    } catch (error) { return sendError(response, error); }
  });

  router.delete('/voice/drafts/:draftId', async (request, response) => {
    try {
      const { session } = await resolveSession(request);
      if (!UUID.test(request.params.draftId ?? '')) throw voiceError(404, 'NOT_FOUND');
      const result = await service.revokeVoiceDraft({ sessionId: session.id, draftId: request.params.draftId });
      await cleanupService?.drainOnce?.().catch(() => undefined);
      return response.json(envelope(response, result));
    } catch (error) { return sendError(response, error); }
  });

  router.post('/messages/:messageId/audio', async (request, response) => {
    try {
      const { session } = await resolveSession(request);
      if (!UUID.test(request.params.messageId ?? '')) throw voiceError(404, 'NOT_FOUND');
      await store.getOwnedAssistantMessage({ sessionId: session.id, messageId: request.params.messageId });
      assertCapability(config, 'voiceOutput', now);
      const controller = new AbortController();
      const abort = () => controller.abort(voiceError(408, 'VOICE_UPLOAD_ABORTED'));
      request.once('aborted', abort);
      try {
        const result = await service.generateAssistantAudio({
          sessionId: session.id, messageId: request.params.messageId, signal: controller.signal,
        });
        return operationResponse(response, result);
      } finally {
        request.off('aborted', abort);
      }
    } catch (error) {
      if (error.retryAfter) response.set('Retry-After', String(error.retryAfter));
      return sendError(response, error);
    }
  });

  router.get('/messages/:messageId/audio/status', async (request, response) => {
    try {
      const { session } = await resolveSession(request);
      if (!UUID.test(request.params.messageId ?? '')) throw voiceError(404, 'NOT_FOUND');
      const result = await service.getAssistantAudioStatus({ sessionId: session.id, messageId: request.params.messageId });
      if (result.httpStatus === 202) {
        result.location = request.originalUrl;
        result.retryAfter = 1;
      }
      return operationResponse(response, result);
    } catch (error) { return sendError(response, error); }
  });

  router.all('/media/:mediaId', async (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method)) return next();
    setGenericPrivateHeaders(response);
    try {
      const { session } = await resolveSession(request);
      if (!UUID.test(request.params.mediaId ?? '')) throw voiceError(404, 'NOT_FOUND');
      const asset = await store.getMediaAsset({ sessionId: session.id, mediaId: request.params.mediaId });
      setAuthorizedMediaHeaders(response, asset);
      if (request.method === 'HEAD') {
        response.set('Content-Length', String(asset.byteLength));
        return response.status(200).end();
      }
      const selected = parseRange(request.get('range'), asset.byteLength);
      if (selected === false) {
        const body = JSON.stringify({ data: null, error: { code: 'RANGE_NOT_SATISFIABLE', message: 'The requested byte range is not satisfiable.' }, requestId: response.locals.requestId });
        response.set('Content-Range', `bytes */${asset.byteLength}`);
        response.set('Content-Length', String(Buffer.byteLength(body)));
        response.set('Content-Type', 'application/json; charset=utf-8');
        return response.status(416).send(body);
      }
      const range = selected ?? { start: 0, end: asset.byteLength - 1 };
      const opened = await mediaStore.open({ storageKey: asset.storageKey, start: range.start, end: range.end });
      const partial = selected !== null;
      response.set('Content-Length', String(range.end - range.start + 1));
      if (partial) response.set('Content-Range', `bytes ${range.start}-${range.end}/${asset.byteLength}`);
      response.status(partial ? 206 : 200);
      opened.readable.on('error', () => response.destroy());
      opened.readable.pipe(response);
      return undefined;
    } catch (error) { return sendError(response, error); }
  });

  return router;
}
