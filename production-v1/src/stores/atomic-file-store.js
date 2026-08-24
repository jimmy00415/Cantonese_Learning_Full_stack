import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { contextLimits, retainRecentCompletePairs } from '../context-budget.js';
import {
  SAFE_TURN_FAILURE_CODES,
  STORE_SCHEMA_VERSION,
  TURN_STATES,
  TURN_TERMINAL_STATES,
  storeError,
} from './store-contract.js';

const COLLECTIONS = ['sessions', 'conversations', 'messages', 'turns', 'events', 'mediaAssets', 'rateLimitBuckets', 'serviceState'];
const NO_CHANGE = Symbol('atomic-store-no-change');
const NONTERMINAL_TRANSITIONS = Object.freeze({ accepted: 'retrieving', retrieving: 'generating' });

function noChange(value) { return { [NO_CHANGE]: true, value }; }

function emptySnapshot() {
  return { schemaVersion: STORE_SCHEMA_VERSION, sessions: [], conversations: [], messages: [], turns: [], events: [], mediaAssets: [], rateLimitBuckets: [], serviceState: {} };
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.schemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
  }
  for (const collection of COLLECTIONS) {
    if (!(collection in snapshot) || (collection !== 'serviceState' && !Array.isArray(snapshot[collection]))) {
      throw new Error('Atomic store state is corrupt');
    }
  }
  if (snapshot.sessions.some((session) => !session?.id || !session.tokenHash)
    || snapshot.conversations.some((conversation) => !conversation?.id || !conversation.sessionId)
    || snapshot.messages.some((message) => !message?.id || !message.sessionId || !message.conversationId || !Number.isInteger(message.sequence))
    || snapshot.turns.some((turn) => !turn?.id || !turn.sessionId || !turn.conversationId || !turn.userMessageId || !turn.requestHash || !TURN_STATES.has(turn.state))
    || snapshot.events.some((event) => !event?.id || !event.sessionId || !event.conversationId || !Number.isInteger(event.cursor))) {
    throw new Error('Atomic store state is corrupt');
  }
  return snapshot;
}

function clone(value) { return structuredClone(value); }
function nowIso(now) { return new Date(now ?? Date.now()).toISOString(); }
function instant(now) {
  const value = new Date(now ?? Date.now()).getTime();
  if (!Number.isFinite(value)) throw new Error('now must be a valid instant');
  return value;
}

function messageSequence(snapshot, conversationId) {
  return snapshot.messages.reduce((highest, message) => (
    message.conversationId === conversationId ? Math.max(highest, message.sequence) : highest
  ), 0) + 1;
}

function appendEvent(snapshot, { sessionId, conversationId, type, messageId = null, turnId = null, payloadJson = {}, now }) {
  const conversation = snapshot.conversations.find((item) => item.id === conversationId && item.sessionId === sessionId);
  if (!conversation) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
  const existingHighWater = snapshot.events.reduce((highest, event) => (
    event.conversationId === conversationId ? Math.max(highest, event.cursor) : highest
  ), 0);
  const cursor = Math.max(Number(conversation.eventHighWater) || 0, existingHighWater) + 1;
  conversation.eventHighWater = cursor;
  conversation.updatedAt = nowIso(now);
  const event = {
    id: randomUUID(), sessionId, conversationId, cursor, type, messageId, turnId,
    payloadJson: clone(payloadJson), createdAt: nowIso(now),
  };
  snapshot.events.push(event);
  return event;
}

function inboundSequence(snapshot, turn) {
  return snapshot.messages.find((message) => message.id === turn.userMessageId)?.sequence ?? Number.MAX_SAFE_INTEGER;
}

export class AtomicFileStore {
  constructor({ filePath }) {
    if (!filePath) throw new Error('AtomicFileStore requires filePath');
    this.filePath = filePath;
    this.snapshot = null;
    this.mutations = Promise.resolve();
  }

  async init() {
    try {
      this.snapshot = validateSnapshot(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.snapshot = emptySnapshot();
        await this.#persist(this.snapshot);
      } else if (error instanceof SyntaxError || /corrupt|schema version/i.test(error?.message ?? '')) {
        throw new Error('Atomic store state is corrupt or uses an unsupported schema version');
      } else {
        throw error;
      }
    }
  }

  async close() { await this.mutations; }

  async #persist(snapshot) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, 'w');
    try {
      await handle.writeFile(JSON.stringify(snapshot));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, this.filePath);
  }

  #read(callback) {
    if (!this.snapshot) throw new Error('AtomicFileStore.init() must finish before use');
    return callback(this.snapshot);
  }

  #mutate(callback) {
    const operation = async () => {
      if (!this.snapshot) throw new Error('AtomicFileStore.init() must finish before use');
      const draft = clone(this.snapshot);
      const result = await callback(draft);
      if (result?.[NO_CHANGE]) return clone(result.value);
      validateSnapshot(draft);
      await this.#persist(draft);
      this.snapshot = draft;
      return clone(result);
    };
    const result = this.mutations.then(operation, operation);
    this.mutations = result.catch(() => undefined);
    return result;
  }

  #ownedConversation(snapshot, sessionId, conversationId) {
    const conversation = snapshot.conversations.find((item) => item.id === conversationId && item.sessionId === sessionId);
    if (!conversation) throw storeError('NOT_FOUND', 'The requested conversation was not found.');
    return conversation;
  }

  #turn(snapshot, turnId) {
    const turn = snapshot.turns.find((item) => item.id === turnId);
    if (!turn) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    return turn;
  }

  #liveLease(snapshot, { turnId, leaseToken, now }) {
    const turn = this.#turn(snapshot, turnId);
    const nowMs = instant(now);
    if (TURN_TERMINAL_STATES.has(turn.state)
      || typeof leaseToken !== 'string'
      || !leaseToken
      || turn.leaseToken !== leaseToken
      || !turn.leaseExpiresAt
      || new Date(turn.leaseExpiresAt).getTime() <= nowMs) {
      throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
    }
    return turn;
  }

  async createOrResumeSession({ tokenHash, now }) {
    return this.#mutate((snapshot) => {
      const timestamp = nowIso(now);
      const existing = snapshot.sessions.reduce((matched, session) => (
        session.tokenHash === tokenHash ? session : matched
      ), null);
      if (existing) {
        const conversation = snapshot.conversations.find((item) => item.sessionId === existing.id);
        if (!conversation) throw new Error('Atomic store state is corrupt');
        return { created: false, session: existing, conversation };
      }
      const session = { id: randomUUID(), tokenHash, createdAt: timestamp, updatedAt: timestamp };
      const conversation = { id: randomUUID(), sessionId: session.id, eventHighWater: 0, createdAt: timestamp, updatedAt: timestamp };
      snapshot.sessions.push(session);
      snapshot.conversations.push(conversation);
      return { created: true, session, conversation };
    });
  }

  async getSessionByTokenHash(tokenHash) {
    return this.#read((snapshot) => clone(snapshot.sessions.reduce((matched, session) => (
      session.tokenHash === tokenHash ? session : matched
    ), null)));
  }

  async getConversationForSession({ sessionId }) {
    return this.#read((snapshot) => clone(snapshot.conversations.find((conversation) => conversation.sessionId === sessionId) ?? null));
  }

  async getAcceptedMessage({ sessionId, conversationId, clientMessageId }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const message = snapshot.messages.find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId);
      if (!message) return null;
      const turn = snapshot.turns.find((item) => item.userMessageId === message.id);
      const event = snapshot.events.find((item) => item.type === 'message.accepted' && item.messageId === message.id);
      if (!turn || !event) throw new Error('Atomic store state is corrupt');
      return clone({ message, turn, event });
    });
  }

  async acceptMessage({ sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId = null, now }) {
    return this.#mutate((snapshot) => {
      return this.#acceptMessage(snapshot, { sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId, now });
    });
  }

  async acceptMessageWithRateLimits({ rateLimits, ...messageInput }) {
    return this.#mutate((snapshot) => {
      const duplicate = this.#findAcceptedMessage(snapshot, messageInput);
      if (duplicate) {
        if (duplicate.turn.requestHash !== messageInput.requestHash) throw storeError('IDEMPOTENCY_CONFLICT', 'This client message ID was already used with different content.');
        return { idempotent: true, ...duplicate };
      }
      const exhausted = rateLimits.map((request) => ({ request, bucket: snapshot.rateLimitBuckets.find((bucket) => bucket.subjectHash === request.subjectHash && bucket.quota === request.quota && bucket.windowStart === request.windowStart) }))
        .find(({ request, bucket }) => bucket && bucket.count >= request.limit);
      if (exhausted) {
        const error = storeError('RATE_LIMITED', 'Rate limit exceeded.');
        error.expiresAt = exhausted.bucket.expiresAt;
        throw error;
      }
      for (const request of rateLimits) {
        let bucket = snapshot.rateLimitBuckets.find((item) => item.subjectHash === request.subjectHash && item.quota === request.quota && item.windowStart === request.windowStart);
        if (!bucket) {
          bucket = { id: randomUUID(), subjectHash: request.subjectHash, quota: request.quota, windowStart: request.windowStart, count: 0, expiresAt: request.expiresAt };
          snapshot.rateLimitBuckets.push(bucket);
        }
        bucket.count += 1;
      }
      return this.#acceptMessage(snapshot, messageInput);
    });
  }

  #findAcceptedMessage(snapshot, { sessionId, conversationId, clientMessageId }) {
    this.#ownedConversation(snapshot, sessionId, conversationId);
    const message = snapshot.messages.find((item) => item.conversationId === conversationId && item.clientMessageId === clientMessageId);
    if (!message) return null;
    const turn = snapshot.turns.find((item) => item.userMessageId === message.id);
    const event = snapshot.events.find((item) => item.type === 'message.accepted' && item.messageId === message.id);
    if (!turn || !event) throw new Error('Atomic store state is corrupt');
    return { message, turn, event };
  }

  #acceptMessage(snapshot, { sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId = null, now }) {
    const duplicate = this.#findAcceptedMessage(snapshot, { sessionId, conversationId, clientMessageId });
    if (duplicate) {
      if (duplicate.turn.requestHash !== requestHash) throw storeError('IDEMPOTENCY_CONFLICT', 'This client message ID was already used with different content.');
      return { idempotent: true, ...duplicate };
    }
    if (voiceDraftId) {
      const voiceDraft = snapshot.mediaAssets.find((asset) => asset.id === voiceDraftId && asset.sessionId === sessionId && asset.kind === 'user_voice' && asset.status === 'draft');
      if (!voiceDraft) throw storeError('INVALID_VOICE_DRAFT', 'The voice draft is unavailable.');
    }
    const timestamp = nowIso(now);
    const sequence = messageSequence(snapshot, conversationId);
    const turnId = randomUUID();
    const message = {
      id: randomUUID(), sessionId, conversationId, turnId, clientMessageId, sequence,
      role: 'user', kind: voiceDraftId ? 'voice' : 'text', status: 'accepted',
      failureCode: null, text, voiceDraftId, createdAt: timestamp,
    };
    const turn = {
      id: turnId, sessionId, conversationId, userMessageId: message.id, requestHash,
      state: 'accepted', failureCode: null, attempt: 0, leaseExpiresAt: null,
      leaseToken: null, workerId: null, createdAt: timestamp, updatedAt: timestamp,
    };
    const event = appendEvent(snapshot, {
      sessionId, conversationId, type: 'message.accepted', messageId: message.id,
      turnId: turn.id, payloadJson: { messageId: message.id, turnId: turn.id }, now: timestamp,
    });
    snapshot.messages.push(message);
    snapshot.turns.push(turn);
    return { idempotent: false, message, turn, event };
  }

  async listMessages({ sessionId, conversationId, after = 0 }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      return clone(snapshot.messages.filter((message) => message.conversationId === conversationId && message.sequence > Number(after)).sort((a, b) => a.sequence - b.sequence));
    });
  }

  async getActiveTurn({ sessionId, conversationId }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const turns = snapshot.turns.filter((turn) => turn.conversationId === conversationId && !TURN_TERMINAL_STATES.has(turn.state));
      turns.sort((left, right) => inboundSequence(snapshot, left) - inboundSequence(snapshot, right) || left.id.localeCompare(right.id));
      return clone(turns[0] ?? null);
    });
  }

  async claimNextTurn({ workerId, leaseToken, leaseUntil, now }) {
    return this.#mutate((snapshot) => {
      if (typeof workerId !== 'string' || !workerId || typeof leaseToken !== 'string' || !leaseToken) {
        throw new Error('workerId and leaseToken are required');
      }
      const nowMs = instant(now);
      const leaseUntilMs = instant(leaseUntil);
      if (leaseUntilMs <= nowMs) throw new Error('leaseUntil must be in the future');
      const earliestByConversation = new Map();
      for (const turn of snapshot.turns) {
        if (TURN_TERMINAL_STATES.has(turn.state)) continue;
        const current = earliestByConversation.get(turn.conversationId);
        if (!current || inboundSequence(snapshot, turn) < inboundSequence(snapshot, current)
          || (inboundSequence(snapshot, turn) === inboundSequence(snapshot, current) && turn.id.localeCompare(current.id) < 0)) {
          earliestByConversation.set(turn.conversationId, turn);
        }
      }
      const claimable = [...earliestByConversation.values()].filter((turn) => (
        !turn.leaseToken || !turn.leaseExpiresAt || new Date(turn.leaseExpiresAt).getTime() <= nowMs
      ));
      claimable.sort((left, right) => {
        const leftCreated = new Date(left.createdAt).getTime();
        const rightCreated = new Date(right.createdAt).getTime();
        return leftCreated - rightCreated || inboundSequence(snapshot, left) - inboundSequence(snapshot, right) || left.id.localeCompare(right.id);
      });
      const turn = claimable[0];
      if (!turn) return noChange(null);
      turn.workerId = workerId;
      turn.leaseToken = leaseToken;
      turn.leaseExpiresAt = new Date(leaseUntilMs).toISOString();
      turn.attempt = Number(turn.attempt || 0) + 1;
      turn.updatedAt = nowIso(nowMs);
      return turn;
    });
  }

  async renewTurnLease({ turnId, leaseToken, leaseUntil, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      const leaseUntilMs = instant(leaseUntil);
      if (leaseUntilMs <= instant(now)) throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      turn.leaseExpiresAt = new Date(leaseUntilMs).toISOString();
      turn.updatedAt = nowIso(now);
      return turn;
    });
  }

  async setTurnState({ turnId, leaseToken, state, now }) {
    return this.#mutate((snapshot) => {
      if (!TURN_STATES.has(state) || TURN_TERMINAL_STATES.has(state)) throw new Error('setTurnState requires a nonterminal state');
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      if (turn.state === state) return noChange({ turn, event: null, changed: false });
      if (NONTERMINAL_TRANSITIONS[turn.state] !== state) {
        throw storeError('INVALID_TURN_TRANSITION', 'The requested turn transition is not allowed.');
      }
      turn.state = state;
      turn.failureCode = null;
      turn.updatedAt = nowIso(now);
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'turn.state',
        turnId, payloadJson: { turnId, state }, now,
      });
      return { turn, event, changed: true };
    });
  }

  async getTurnContext({ turnId }) {
    return this.#read((snapshot) => {
      const turn = snapshot.turns.find((item) => item.id === turnId);
      if (!turn) throw storeError('NOT_FOUND', 'The requested turn was not found.');
      const targetSequence = inboundSequence(snapshot, turn);
      const earlier = snapshot.turns.filter((item) => (
        item.conversationId === turn.conversationId
        && item.state === 'delivered'
        && inboundSequence(snapshot, item) < targetSequence
      )).sort((left, right) => inboundSequence(snapshot, left) - inboundSequence(snapshot, right));
      const messages = [];
      for (const completed of earlier) {
        const inbound = snapshot.messages.find((message) => message.id === completed.userMessageId);
        const assistant = snapshot.messages.find((message) => message.turnId === completed.id && message.role === 'assistant');
        if (inbound && assistant) messages.push(inbound, assistant);
      }
      const current = snapshot.messages.find((message) => message.id === turn.userMessageId);
      if (!current) throw new Error('Atomic store state is corrupt');
      messages.push(current);
      const bounded = retainRecentCompletePairs(messages, { maxBytes: contextLimits.turnBytes, contentKey: 'text' });
      return clone({ turn, messages: bounded });
    });
  }

  async failTurn({ turnId, leaseToken, failureCode, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      const safeFailureCode = SAFE_TURN_FAILURE_CODES.has(failureCode) ? failureCode : 'ANSWER_FAILED';
      const inbound = snapshot.messages.find((message) => message.id === turn.userMessageId);
      if (!inbound) throw new Error('Atomic store state is corrupt');
      turn.state = 'failed';
      turn.failureCode = safeFailureCode;
      turn.updatedAt = nowIso(now);
      turn.leaseToken = null;
      turn.leaseExpiresAt = null;
      turn.workerId = null;
      inbound.status = 'failed';
      inbound.failureCode = safeFailureCode;
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'turn.failed',
        messageId: inbound.id, turnId, payloadJson: { messageId: inbound.id, turnId, failureCode: safeFailureCode }, now,
      });
      return { turn, event };
    });
  }

  async deliverAssistant({ turnId, leaseToken, message, now }) {
    return this.#mutate((snapshot) => {
      const turn = this.#liveLease(snapshot, { turnId, leaseToken, now });
      if (turn.state !== 'generating') {
        throw storeError('INVALID_TURN_TRANSITION', 'Assistant delivery requires a generating turn.');
      }
      if (snapshot.messages.some((item) => item.turnId === turnId && item.role === 'assistant')) {
        throw storeError('LEASE_LOST', 'The worker no longer owns this turn.');
      }
      if (!message || typeof message.text !== 'string' || !message.text.trim()) throw new Error('Assistant message text is required');
      const timestamp = nowIso(now);
      const assistant = {
        id: randomUUID(), sessionId: turn.sessionId, conversationId: turn.conversationId,
        turnId, sequence: messageSequence(snapshot, turn.conversationId), role: 'assistant',
        kind: 'text', status: 'delivered', text: message.text.trim(),
        citations: clone(message.citations ?? []), cards: clone(message.cards ?? []),
        suggestedReplies: clone(message.suggestedReplies ?? []),
        needsClarification: Boolean(message.needsClarification),
        groundingStatus: message.groundingStatus === 'verified' ? 'verified' : 'unverified',
        provider: typeof message.provider === 'string' ? message.provider : null,
        providerLatencyMs: Number.isFinite(message.providerLatencyMs) ? message.providerLatencyMs : null,
        createdAt: timestamp,
      };
      const inbound = snapshot.messages.find((item) => item.id === turn.userMessageId);
      if (!inbound) throw new Error('Atomic store state is corrupt');
      inbound.status = 'delivered';
      turn.state = 'delivered';
      turn.failureCode = null;
      turn.updatedAt = timestamp;
      turn.leaseToken = null;
      turn.leaseExpiresAt = null;
      turn.workerId = null;
      snapshot.messages.push(assistant);
      const event = appendEvent(snapshot, {
        sessionId: turn.sessionId, conversationId: turn.conversationId, type: 'message.delivered',
        messageId: assistant.id, turnId, payloadJson: { messageId: assistant.id, turnId }, now,
      });
      return { turn, message: assistant, event };
    });
  }

  async deleteSession({ sessionId }) {
    return this.#mutate((snapshot) => {
      const session = snapshot.sessions.find((item) => item.id === sessionId);
      if (!session) throw storeError('NOT_FOUND', 'The requested session was not found.');
      const conversationIds = new Set(snapshot.conversations.filter((item) => item.sessionId === sessionId).map((item) => item.id));
      snapshot.sessions = snapshot.sessions.filter((item) => item.id !== sessionId);
      snapshot.conversations = snapshot.conversations.filter((item) => item.sessionId !== sessionId);
      snapshot.messages = snapshot.messages.filter((item) => item.sessionId !== sessionId);
      snapshot.turns = snapshot.turns.filter((item) => item.sessionId !== sessionId);
      snapshot.events = snapshot.events.filter((item) => !conversationIds.has(item.conversationId));
      snapshot.mediaAssets = snapshot.mediaAssets.filter((item) => item.sessionId !== sessionId);
      return { deleted: true };
    });
  }

  async listRecoverableTurns() {
    return this.#read((snapshot) => clone(snapshot.turns
      .filter((turn) => !TURN_TERMINAL_STATES.has(turn.state))
      .sort((left, right) => new Date(left.createdAt) - new Date(right.createdAt) || left.id.localeCompare(right.id))));
  }

  async getEventHighWater({ sessionId, conversationId }) {
    return this.#read((snapshot) => {
      const conversation = this.#ownedConversation(snapshot, sessionId, conversationId);
      return Math.max(Number(conversation.eventHighWater) || 0, snapshot.events.reduce((highest, event) => (
        event.conversationId === conversationId ? Math.max(highest, event.cursor) : highest
      ), 0));
    });
  }

  async listEventsPage({ sessionId, conversationId, afterCursor = 0, throughCursor = Number.MAX_SAFE_INTEGER, limit = 100 }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      const after = Number(afterCursor);
      const through = Number(throughCursor);
      const pageLimit = Number(limit);
      if (!Number.isInteger(after) || after < 0 || !Number.isInteger(through) || through < after
        || !Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 100) {
        throw new Error('Invalid event page');
      }
      return clone(snapshot.events
        .filter((event) => event.conversationId === conversationId && event.cursor > after && event.cursor <= through)
        .sort((left, right) => left.cursor - right.cursor)
        .slice(0, pageLimit));
    });
  }

  async listEvents({ sessionId, conversationId, afterCursor = 0 }) {
    const highWater = await this.getEventHighWater({ sessionId, conversationId });
    const events = [];
    let cursor = Number(afterCursor);
    while (cursor < highWater) {
      const page = await this.listEventsPage({ sessionId, conversationId, afterCursor: cursor, throughCursor: highWater, limit: 100 });
      if (page.length === 0) break;
      events.push(...page);
      cursor = page.at(-1).cursor;
    }
    return events;
  }

  async consumeRateLimit({ subjectHash, quota, windowStart, limit, expiresAt }) {
    return this.#mutate((snapshot) => {
      let bucket = snapshot.rateLimitBuckets.find((item) => item.subjectHash === subjectHash && item.quota === quota && item.windowStart === windowStart);
      if (!bucket) {
        bucket = { id: randomUUID(), subjectHash, quota, windowStart, count: 0, expiresAt };
        snapshot.rateLimitBuckets.push(bucket);
      }
      if (bucket.count >= limit) return { allowed: false, count: bucket.count, expiresAt: bucket.expiresAt };
      bucket.count += 1;
      return { allowed: true, count: bucket.count, expiresAt: bucket.expiresAt };
    });
  }
}
