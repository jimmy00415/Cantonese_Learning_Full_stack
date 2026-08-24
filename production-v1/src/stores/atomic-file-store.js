import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

import { STORE_SCHEMA_VERSION, TURN_TERMINAL_STATES, storeError } from './store-contract.js';

const COLLECTIONS = ['sessions', 'conversations', 'messages', 'turns', 'events', 'mediaAssets', 'rateLimitBuckets', 'serviceState'];

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
    || snapshot.turns.some((turn) => !turn?.id || !turn.sessionId || !turn.conversationId || !turn.userMessageId || !turn.requestHash)
    || snapshot.events.some((event) => !event?.id || !event.sessionId || !event.conversationId || !Number.isInteger(event.cursor))) {
    throw new Error('Atomic store state is corrupt');
  }
  return snapshot;
}

function clone(value) { return structuredClone(value); }
function nowIso(now) { return new Date(now ?? Date.now()).toISOString(); }

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
      const conversation = { id: randomUUID(), sessionId: session.id, createdAt: timestamp, updatedAt: timestamp };
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
    const sequence = snapshot.messages.filter((message) => message.conversationId === conversationId).length + 1;
    const message = { id: randomUUID(), sessionId, conversationId, clientMessageId, sequence, role: 'user', text, voiceDraftId, createdAt: timestamp };
    const turn = { id: randomUUID(), sessionId, conversationId, userMessageId: message.id, requestHash, state: 'accepted', failureCode: null, attempt: 0, leaseExpiresAt: null, leaseToken: null, createdAt: timestamp, updatedAt: timestamp };
    const cursor = snapshot.events.filter((event) => event.conversationId === conversationId).length + 1;
    const event = { id: randomUUID(), sessionId, conversationId, cursor, type: 'message.accepted', messageId: message.id, turnId: turn.id, payloadJson: { messageId: message.id, turnId: turn.id }, createdAt: timestamp };
    snapshot.messages.push(message);
    snapshot.turns.push(turn);
    snapshot.events.push(event);
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
      return clone(turns.at(-1) ?? null);
    });
  }

  async setTurnState({ turnId, state, failureCode = null, now }) {
    return this.#mutate((snapshot) => {
      const turn = snapshot.turns.find((item) => item.id === turnId);
      if (!turn) throw storeError('NOT_FOUND', 'The requested turn was not found.');
      turn.state = state;
      turn.failureCode = failureCode;
      turn.updatedAt = nowIso(now);
      return turn;
    });
  }

  async deliverAssistant({ turnId, message, now }) {
    return this.#mutate((snapshot) => {
      const turn = snapshot.turns.find((item) => item.id === turnId);
      if (!turn) throw storeError('NOT_FOUND', 'The requested turn was not found.');
      const existing = snapshot.messages.find((item) => item.turnId === turnId && item.role === 'assistant');
      if (existing) return existing;
      const timestamp = nowIso(now);
      const sequence = snapshot.messages.filter((item) => item.conversationId === turn.conversationId).length + 1;
      const assistant = { id: randomUUID(), sessionId: turn.sessionId, conversationId: turn.conversationId, turnId, sequence, role: 'assistant', text: message, createdAt: timestamp };
      turn.state = 'delivered';
      turn.updatedAt = timestamp;
      snapshot.messages.push(assistant);
      snapshot.events.push({ id: randomUUID(), sessionId: turn.sessionId, conversationId: turn.conversationId, cursor: snapshot.events.filter((event) => event.conversationId === turn.conversationId).length + 1, type: 'message.delivered', messageId: assistant.id, turnId, payloadJson: { messageId: assistant.id, turnId }, createdAt: timestamp });
      return assistant;
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

  async listRecoverableTurns() { return this.#read((snapshot) => clone(snapshot.turns.filter((turn) => !TURN_TERMINAL_STATES.has(turn.state)))); }

  async listEvents({ sessionId, conversationId, afterCursor = 0 }) {
    return this.#read((snapshot) => {
      this.#ownedConversation(snapshot, sessionId, conversationId);
      return clone(snapshot.events.filter((event) => event.conversationId === conversationId && event.cursor > Number(afterCursor)).sort((a, b) => a.cursor - b.cursor));
    });
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
