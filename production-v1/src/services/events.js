import { httpError, sendError } from '../http/errors.js';

const RESYNC_EVENT = 'event: resync_required\ndata: {"code":"RESYNC_REQUIRED"}\n\n';

export class EventHub {
  constructor() {
    this.listeners = new Map();
    this.closed = false;
  }

  subscribe(conversationId, listener) {
    if (this.closed) throw new Error('EventHub is closed');
    let group = this.listeners.get(conversationId);
    if (!group) {
      group = new Set();
      this.listeners.set(conversationId, group);
    }
    group.add(listener);
    return () => {
      group.delete(listener);
      if (group.size === 0) this.listeners.delete(conversationId);
    };
  }

  publish(notification) {
    if (this.closed || !notification?.conversationId) return;
    for (const listener of [...(this.listeners.get(notification.conversationId) ?? [])]) {
      listener(notification);
    }
  }

  closeConversation(conversationId) {
    const group = this.listeners.get(conversationId);
    if (!group) return;
    for (const listener of [...group]) listener({ conversationId, kind: 'conversation.closed' });
    this.listeners.delete(conversationId);
  }

  listenerCount(conversationId) {
    return this.listeners.get(conversationId)?.size ?? 0;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const conversationId of [...this.listeners.keys()]) this.closeConversation(conversationId);
    this.listeners.clear();
  }
}

function parseCursor(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw httpError(400, 'INVALID_EVENT_CURSOR');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw httpError(400, 'INVALID_EVENT_CURSOR');
  return parsed;
}

function eventFrame(event) {
  return `id: ${event.cursor}\nevent: ${event.type}\ndata: ${JSON.stringify(event.payloadJson ?? {})}\n\n`;
}

export function createEventStreamHandler({ store, eventHub, resolveSession, pageSize = 100, bufferSize = 256, heartbeatMs = 20_000 }) {
  if (!store || !eventHub || typeof resolveSession !== 'function') throw new Error('event stream dependencies are required');

  return async function eventStream(request, response) {
    let owner;
    let queryCursor;
    let resumeCursor;
    try {
      owner = await resolveSession(request);
      queryCursor = parseCursor(request.query.afterCursor, 0);
      const headerValue = request.get('Last-Event-ID');
      const headerCursor = headerValue === undefined ? null : parseCursor(headerValue, null);
      if (headerCursor !== null && headerCursor < queryCursor) throw httpError(400, 'INVALID_EVENT_CURSOR');
      resumeCursor = headerCursor ?? queryCursor;
    } catch (error) {
      return sendError(response, error);
    }

    response.status(200);
    response.set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders?.();

    let closed = false;
    let live = false;
    let lastDelivered = resumeCursor;
    let drainPromise = null;
    let notificationCounter = 0;
    const pendingHints = new Set();
    let heartbeat = null;
    let unsubscribe = () => {};

    const cleanup = () => {
      if (closed) return;
      closed = true;
      if (heartbeat) clearInterval(heartbeat);
      unsubscribe();
    };
    const close = () => {
      cleanup();
      if (!response.writableEnded && !response.destroyed) response.end();
    };
    const resyncAndClose = () => {
      if (closed) return;
      try { response.write(RESYNC_EVENT); } catch { /* socket already gone */ }
      close();
    };
    const write = (value) => {
      if (closed || response.writableEnded || response.destroyed) return false;
      try {
        if (!response.write(value)) {
          resyncAndClose();
          return false;
        }
        return true;
      } catch {
        close();
        return false;
      }
    };

    const drainThrough = async (throughCursor) => {
      while (!closed && lastDelivered < throughCursor) {
        const page = await store.listEventsPage({
          sessionId: owner.session.id,
          conversationId: owner.conversation.id,
          afterCursor: lastDelivered,
          throughCursor,
          limit: pageSize,
        });
        if (closed || page.length === 0) break;
        for (const event of page) {
          if (closed) return;
          if (event.cursor <= lastDelivered) continue;
          if (!write(eventFrame(event))) return;
          lastDelivered = event.cursor;
        }
      }
    };

    const drainCurrent = async () => {
      if (closed) return;
      const highWater = await store.getEventHighWater({ sessionId: owner.session.id, conversationId: owner.conversation.id });
      await drainThrough(highWater);
    };

    const scheduleDrain = () => {
      if (drainPromise) return drainPromise;
      drainPromise = (async () => {
        do {
          pendingHints.clear();
          await drainCurrent();
        } while (!closed && pendingHints.size > 0);
      })().catch((error) => {
        if (error?.code === 'NOT_FOUND' || error?.code === 'SESSION_NOT_FOUND') close();
        else resyncAndClose();
      }).finally(() => {
        drainPromise = null;
        if (!closed && live && pendingHints.size > 0) scheduleDrain();
      });
      return drainPromise;
    };

    const onNotification = (notification) => {
      if (closed) return;
      if (notification?.kind === 'conversation.closed') {
        close();
        return;
      }
      const cursor = Number(notification?.cursor);
      const hint = Number.isSafeInteger(cursor) && cursor >= 0 ? `cursor:${cursor}` : `unknown:${notificationCounter += 1}`;
      pendingHints.add(hint);
      if (pendingHints.size > bufferSize) {
        resyncAndClose();
        return;
      }
      if (live) scheduleDrain();
    };

    unsubscribe = eventHub.subscribe(owner.conversation.id, onNotification);
    request.once('aborted', close);
    request.once('close', close);
    response.once('close', cleanup);
    response.once('error', close);

    if (!write('retry: 3000\n\n')) return;

    void (async () => {
      try {
        const capturedHighWater = await store.getEventHighWater({ sessionId: owner.session.id, conversationId: owner.conversation.id });
        await drainThrough(capturedHighWater);
        while (!closed && pendingHints.size > 0) {
          pendingHints.clear();
          await drainCurrent();
        }
        if (closed) return;
        live = true;
        heartbeat = setInterval(() => {
          void scheduleDrain().then(() => {
            if (!closed) write(': heartbeat\n\n');
          });
        }, heartbeatMs);
        heartbeat.unref?.();
      } catch (error) {
        if (error?.code === 'NOT_FOUND' || error?.code === 'SESSION_NOT_FOUND') close();
        else resyncAndClose();
      }
    })();
  };
}
