import { createHash, randomBytes } from 'node:crypto';
import express from 'express';

import { httpError, sendError } from './errors.js';
import { createRateLimiter, rateLimitBucket } from '../services/rate-limiter.js';
import { createEventStreamHandler } from '../services/events.js';

const COOKIE_NAME = 'hb_v1_session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function tokenHash(token) { return createHash('sha256').update(token).digest('hex'); }
function parseCookies(header = '') { return Object.fromEntries(header.split(';').map((part) => part.trim().split(/=(.*)/s)).filter(([key]) => key)); }
function requestHash({ text, voiceDraftId }) { return createHash('sha256').update(JSON.stringify({ text, voiceDraftId: voiceDraftId ?? null })).digest('hex'); }
function rateLimited(response, result) { response.set('Retry-After', String(result.retryAfter)); throw httpError(429, 'RATE_LIMITED'); }

function cookieOptions(config) { return { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/', maxAge: 30 * 24 * 60 * 60 * 1000 }; }

function publicTurn(turn) {
  if (!turn) return null;
  return {
    id: turn.id,
    state: turn.state,
    failureCode: turn.failureCode ?? null,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
  };
}

function publicMessage(message) {
  return {
    id: message.id,
    conversationId: message.conversationId,
    turnId: message.turnId,
    clientMessageId: message.clientMessageId ?? null,
    sequence: message.sequence,
    role: message.role,
    kind: message.kind ?? 'text',
    status: message.status ?? (message.role === 'assistant' ? 'delivered' : 'accepted'),
    failureCode: message.failureCode ?? null,
    text: message.text,
    voiceDraftId: message.voiceDraftId ?? null,
    citations: message.citations ?? [],
    cards: message.cards ?? [],
    suggestedReplies: message.suggestedReplies ?? [],
    needsClarification: Boolean(message.needsClarification),
    groundingStatus: message.groundingStatus ?? null,
    createdAt: message.createdAt,
  };
}

export function createSessionResolver({ store }) {
  return async function sessionFromRequest(request) {
    const token = parseCookies(request.get('cookie'))[COOKIE_NAME];
    if (!token) throw httpError(401, 'SESSION_NOT_FOUND');
    const session = await store.getSessionByTokenHash(tokenHash(token));
    if (!session) throw httpError(401, 'SESSION_NOT_FOUND');
    const conversation = await store.getConversationForSession({ sessionId: session.id });
    if (!conversation) throw httpError(401, 'SESSION_NOT_FOUND');
    return { session, conversation };
  };
}

export function createSessionRouter({ config, store, eventHub, dispatcher }) {
  const router = express.Router();
  const limiter = createRateLimiter({ store, secret: config.sessionSecret ?? 'local-development-session-secret' });
  const limits = config.rateLimits ?? { bootstrap: 20, message5m: 30, messageDaily: 300 };

  const sessionFromRequest = createSessionResolver({ store });

  router.post('/session', async (request, response) => {
    try {
      const cookies = parseCookies(request.get('cookie'));
      const existing = cookies[COOKIE_NAME];
      if (existing) {
        const resumed = await store.getSessionByTokenHash(tokenHash(existing));
        if (resumed) {
          const conversation = await store.getConversationForSession({ sessionId: resumed.id });
          if (!conversation) throw httpError(401, 'SESSION_NOT_FOUND');
          const messages = await store.listMessages({ sessionId: resumed.id, conversationId: conversation.id, after: 0 });
          return response.json({ data: { session: { id: resumed.id }, conversation, messages: messages.map(publicMessage), capabilities: config.publicStatus, knowledgeSnapshotDate: config.knowledgeSnapshotDate ?? null }, error: null, requestId: response.locals.requestId });
        }
      }
      const bootstrap = await limiter.consume({ subject: request.ip, quota: 'session-bootstrap', limit: limits.bootstrap, durationMs: 10 * 60 * 1000 });
      if (!bootstrap.allowed) return rateLimited(response, bootstrap);
      const token = randomBytes(32).toString('base64url');
      const sessionData = await store.createOrResumeSession({ tokenHash: tokenHash(token) });
      response.cookie(COOKIE_NAME, token, cookieOptions(config));
      return response.status(201).json({ data: { session: { id: sessionData.session.id }, conversation: sessionData.conversation, messages: [], capabilities: config.publicStatus, knowledgeSnapshotDate: config.knowledgeSnapshotDate ?? null }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  router.get('/messages', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      const after = Number(request.query.after ?? 0);
      if (!Number.isInteger(after) || after < 0) throw httpError(400, 'INVALID_REQUEST');
      const messages = await store.listMessages({ sessionId: sessionData.session.id, conversationId: sessionData.conversation.id, after });
      const activeTurn = await store.getActiveTurn({ sessionId: sessionData.session.id, conversationId: sessionData.conversation.id });
      return response.json({ data: { conversation: sessionData.conversation, messages: messages.map(publicMessage), activeTurn: publicTurn(activeTurn) }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  router.post('/messages', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      const clientMessageId = request.body?.clientMessageId;
      const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
      const voiceDraftId = request.body?.voiceDraftId ?? null;
      if (!UUID.test(clientMessageId ?? '') || text.length < 1 || text.length > 4000 || (voiceDraftId !== null && typeof voiceDraftId !== 'string')) throw httpError(400, 'INVALID_REQUEST');
      const payloadHash = requestHash({ text, voiceDraftId });
      const subject = sessionData.session.id;
      const now = Date.now();
      const accepted = await store.acceptMessageWithRateLimits({
        sessionId: sessionData.session.id, conversationId: sessionData.conversation.id, clientMessageId, requestHash: payloadHash, text, voiceDraftId,
        rateLimits: [
          rateLimitBucket({ secret: config.sessionSecret ?? 'local-development-session-secret', subject, quota: 'messages-5m', limit: limits.message5m, durationMs: 5 * 60 * 1000, now }),
          rateLimitBucket({ secret: config.sessionSecret ?? 'local-development-session-secret', subject, quota: 'messages-day', limit: limits.messageDaily, durationMs: 24 * 60 * 60 * 1000, now }),
        ],
      });
      response.status(202).json({ data: { idempotent: accepted.idempotent, message: publicMessage(accepted.message), turn: publicTurn(accepted.turn) }, error: null, requestId: response.locals.requestId });
      queueMicrotask(() => {
        eventHub?.publish({ sessionId: accepted.event.sessionId, conversationId: accepted.event.conversationId, cursor: accepted.event.cursor });
        dispatcher?.wake?.();
      });
      return undefined;
    } catch (error) {
      if (error.code === 'RATE_LIMITED' && error.expiresAt) response.set('Retry-After', String(Math.max(1, Math.ceil((new Date(error.expiresAt).getTime() - Date.now()) / 1000))));
      return sendError(response, error);
    }
  });

  router.delete('/session', async (request, response) => {
    try {
      const sessionData = await sessionFromRequest(request);
      await store.deleteSession({ sessionId: sessionData.session.id });
      eventHub?.closeConversation(sessionData.conversation.id);
      response.clearCookie(COOKIE_NAME, { httpOnly: true, sameSite: 'lax', secure: config.nodeEnv === 'production', path: '/' });
      return response.json({ data: { deleted: true }, error: null, requestId: response.locals.requestId });
    } catch (error) { return sendError(response, error); }
  });

  if (eventHub) {
    router.get('/events', createEventStreamHandler({
      store,
      eventHub,
      resolveSession: sessionFromRequest,
      pageSize: config.sse?.pageSize,
      bufferSize: config.sse?.bufferSize,
      heartbeatMs: config.sse?.heartbeatMs,
    }));
  }

  return router;
}
