import { createHash } from 'node:crypto';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const WINDOW_ID = /^[0-9a-f]{64}$/;
const CORRELATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_SESSION_ID = /^[0-9a-z][0-9a-z._-]{0,127}$/i;
const SAFE_BINDING_ID = /^[0-9a-z][0-9a-z._-]{0,127}$/i;
const SAFE_FAILURE_CODE = /^[A-Z][A-Z0-9_]{0,79}$/;
const OPERATIONS = new Set(['text', 'asr', 'tts']);
const LAYERS = new Set(['provider', 'server']);
const OUTCOMES = new Set(['success', 'failure']);
const MAX_RECORDS = 5_000;
const MAX_AGE_MS = 30 * 60_000;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function queryDigest(query) {
  return createHash('sha256').update(canonicalJson(query)).digest('hex');
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isFinite(value)) throw new Error('acceptance timing clock is invalid');
  return value;
}

export function acceptanceTimingContext({ windowId, correlationId } = {}) {
  if (!WINDOW_ID.test(String(windowId ?? '')) || !CORRELATION_ID.test(String(correlationId ?? ''))) return null;
  return { windowId, correlationId: correlationId.toLowerCase() };
}

export function createAcceptanceTimingRecorder({ releaseCommitSha, now = Date.now } = {}) {
  if (!RELEASE_SHA.test(String(releaseCommitSha ?? ''))) {
    throw new Error('acceptance timing revision is invalid');
  }
  let records = [];
  const turns = new Map();
  const messages = new Map();
  const prune = (current) => {
    records = records.filter((record) => current - record.observedAtMs <= MAX_AGE_MS);
    if (records.length > MAX_RECORDS) records = records.slice(records.length - MAX_RECORDS);
  };

  const record = ({
    windowId, sessionId, correlationId, bindingId, durationMs = null,
    operation, layer, latencyMs, outcome, failureCode = null,
  } = {}) => {
    const context = acceptanceTimingContext({ windowId, correlationId });
    const observedAtMs = safeNow(now);
    if (!context || !SAFE_SESSION_ID.test(String(sessionId ?? ''))
      || !SAFE_BINDING_ID.test(String(bindingId ?? ''))
      || !OPERATIONS.has(operation) || !LAYERS.has(layer)
      || !OUTCOMES.has(outcome)
      || !Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 60 * 60_000
      || (operation === 'asr'
        ? !Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 60_000
        : durationMs !== null)
      || (outcome === 'success' ? failureCode !== null : !SAFE_FAILURE_CODE.test(String(failureCode ?? '')))) return false;
    prune(observedAtMs);
    records.push({
      ...context,
      sessionId,
      bindingId,
      durationMs,
      operation,
      layer,
      latencyMs,
      outcome,
      failureCode,
      observedAtMs,
    });
    if (records.length > MAX_RECORDS) records.shift();
    return true;
  };

  const query = ({ windowId, sessionId } = {}) => {
    const observedAtMs = safeNow(now);
    prune(observedAtMs);
    const valid = WINDOW_ID.test(String(windowId ?? '')) && SAFE_SESSION_ID.test(String(sessionId ?? ''));
    const descriptor = {
      schemaVersion: 2,
      releaseCommitSha,
      windowId: valid ? windowId : null,
      sessionId: valid ? sessionId : null,
    };
    const samples = valid ? records
      .filter((item) => item.windowId === windowId && item.sessionId === sessionId)
      .map(({ correlationId, bindingId, durationMs, operation, layer, latencyMs, outcome, failureCode }) => ({
        correlationId, bindingId, durationMs, operation, layer, latencyMs, outcome, failureCode,
      })) : [];
    return {
      schemaVersion: 2,
      releaseCommitSha,
      windowId: descriptor.windowId,
      queryDigest: queryDigest(descriptor),
      samples,
    };
  };

  const bindTurn = ({ turnId, windowId, sessionId, correlationId, controlledTtsFailure = false } = {}) => {
    const context = acceptanceTimingContext({ windowId, correlationId });
    if (!context || !SAFE_BINDING_ID.test(String(turnId ?? '')) || !SAFE_SESSION_ID.test(String(sessionId ?? ''))) return false;
    if (turns.size >= MAX_RECORDS && !turns.has(turnId)) turns.delete(turns.keys().next().value);
    turns.set(turnId, {
      ...context, sessionId, startedAtMs: safeNow(now),
      ...(controlledTtsFailure === true ? { controlledTtsFailure: true } : {}),
    });
    return true;
  };

  const completeText = ({ turnId, messageId, providerLatencyMs } = {}) => {
    const binding = turns.get(turnId);
    if (!binding || !SAFE_BINDING_ID.test(String(messageId ?? ''))) return false;
    turns.delete(turnId);
    const completedAtMs = safeNow(now);
    const context = {
      windowId: binding.windowId,
      sessionId: binding.sessionId,
      correlationId: binding.correlationId,
      ...(binding.controlledTtsFailure === true ? { controlledTtsFailure: true } : {}),
    };
    const timing = { ...context, bindingId: messageId, durationMs: null, outcome: 'success', failureCode: null };
    record({ ...timing, operation: 'text', layer: 'server', latencyMs: Math.max(0, completedAtMs - binding.startedAtMs) });
    if (Number.isFinite(providerLatencyMs) && providerLatencyMs >= 0) {
      record({ ...timing, operation: 'text', layer: 'provider', latencyMs: providerLatencyMs });
    }
    if (messages.size >= MAX_RECORDS && !messages.has(messageId)) messages.delete(messages.keys().next().value);
    messages.set(messageId, context);
    return true;
  };

  const contextForMessage = (messageId) => {
    const context = messages.get(messageId);
    if (!context) return null;
    const { requestedAtMs: ignored, ...publicContext } = context;
    void ignored;
    return { ...publicContext };
  };

  const beginTts = (messageId) => {
    const context = messages.get(messageId);
    if (!context) return null;
    if (!Number.isFinite(context.requestedAtMs)) context.requestedAtMs = safeNow(now);
    return { ...context };
  };

  return Object.freeze({ beginTts, bindTurn, completeText, contextForMessage, record, query });
}

export function acceptanceTimingQueryDigest({ releaseCommitSha, windowId, sessionId }) {
  return queryDigest({ schemaVersion: 2, releaseCommitSha, windowId, sessionId });
}
