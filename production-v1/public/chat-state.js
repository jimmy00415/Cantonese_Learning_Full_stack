const EVENT_TYPES = new Set([
  'message.accepted',
  'turn.state',
  'message.delivered',
  'turn.failed',
  'audio.ready',
]);

function validDate(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

export function createOptimisticMessage({ clientMessageId, text, createdAt = new Date().toISOString() }) {
  if (typeof clientMessageId !== 'string' || !clientMessageId) throw new Error('clientMessageId is required');
  if (typeof text !== 'string' || !text.trim()) throw new Error('message text is required');
  return {
    id: `optimistic:${clientMessageId}`,
    clientMessageId,
    sequence: null,
    role: 'user',
    kind: 'text',
    status: 'sending',
    failureCode: null,
    text: text.trim(),
    citations: [],
    cards: [],
    suggestedReplies: [],
    createdAt,
    optimistic: true,
  };
}

export function markOptimisticFailed(message, failureCode = 'MESSAGE_SEND_FAILED') {
  return { ...message, status: 'failed', failureCode };
}

export function retryPayload(message) {
  return { clientMessageId: message.clientMessageId, text: message.text };
}

export function reconcileTimeline(canonicalMessages = [], optimisticMessages = []) {
  const canonicalById = new Map();
  for (const message of canonicalMessages) {
    if (!message || typeof message.id !== 'string' || canonicalById.has(message.id)) continue;
    canonicalById.set(message.id, message);
  }
  const canonical = [...canonicalById.values()].sort((left, right) => {
    const leftSequence = Number.isSafeInteger(left.sequence) ? left.sequence : Number.MAX_SAFE_INTEGER;
    const rightSequence = Number.isSafeInteger(right.sequence) ? right.sequence : Number.MAX_SAFE_INTEGER;
    return leftSequence - rightSequence;
  });
  const acceptedClientIds = new Set(canonical.map((message) => message.clientMessageId).filter(Boolean));
  const pendingByClientId = new Map();
  for (const message of optimisticMessages) {
    if (!message?.clientMessageId || acceptedClientIds.has(message.clientMessageId)) continue;
    pendingByClientId.set(message.clientMessageId, message);
  }
  const pending = [...pendingByClientId.values()].sort((left, right) => {
    return (validDate(left.createdAt)?.getTime() ?? 0) - (validDate(right.createdAt)?.getTime() ?? 0);
  });
  return [...canonical, ...pending];
}

export function eventHint(event, currentCursor = 0) {
  if (event?.type === 'resync_required') {
    return { cursor: 0, shouldBackfill: true, shouldReconnect: true };
  }
  const parsed = /^\d+$/.test(String(event?.lastEventId ?? '')) ? Number(event.lastEventId) : null;
  const cursor = Number.isSafeInteger(parsed) && parsed >= currentCursor ? parsed : currentCursor;
  return {
    cursor,
    shouldBackfill: EVENT_TYPES.has(event?.type),
    shouldReconnect: false,
  };
}

export function turnStatusMessage(turn) {
  const messages = {
    accepted: 'Message received.',
    retrieving: 'Checking official HKBU information…',
    generating: 'Preparing a grounded reply…',
  };
  return messages[turn?.state] ?? '';
}

export function safeOfficialUrl(value) {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || (host !== 'hkbu.edu.hk' && !host.endsWith('.hkbu.edu.hk'))
    ) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function formatFreshness(value) {
  const date = validDate(value);
  if (!date) return 'Date unavailable';
  const formatted = new Intl.DateTimeFormat('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Hong_Kong',
  }).format(date);
  return `Verified ${formatted}`;
}

export function shouldSubmitOnEnter(event, hasFinePointer) {
  return Boolean(
    hasFinePointer
    && event?.key === 'Enter'
    && !event.shiftKey
    && !event.isComposing,
  );
}

export function shouldSyncDraft(currentValue, canonicalDraft) {
  return String(currentValue ?? '') !== String(canonicalDraft ?? '');
}
