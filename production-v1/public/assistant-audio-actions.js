const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AMBIGUOUS_GENERATION_FAILURES = new Set(['AUDIO_INVALID_RESPONSE', 'NETWORK_UNAVAILABLE']);
const SAFE_STATUS = 'Audio could not continue safely. The text answer is still available.';

function result(action, value = null) {
  return Object.freeze({
    action,
    ...(value && typeof value === 'object' ? value : {}),
  });
}

function safeFailure(state = 'error') {
  return Object.freeze({ state, action: 'none', statusText: SAFE_STATUS });
}

function validMessage(message) {
  return message?.role === 'assistant'
    && message?.status === 'delivered'
    && typeof message.id === 'string'
    && UUID.test(message.id);
}

export async function performAssistantAudioAction({
  controller,
  message,
  snapshot,
  now = () => Date.now(),
} = {}) {
  if (!controller
    || typeof controller.generate !== 'function'
    || typeof controller.refresh !== 'function'
    || typeof controller.play !== 'function'
    || typeof controller.pause !== 'function'
    || typeof now !== 'function'
    || !validMessage(message)) return safeFailure('invalid');

  const entry = snapshot?.entries?.[message.id] ?? null;
  const playback = snapshot?.playback?.messageId === message.id ? snapshot.playback : null;
  const canonicalMediaId = message.mediaId || null;
  const entryMediaId = entry?.mediaId || null;
  if ((canonicalMediaId && !UUID.test(canonicalMediaId))
    || (entryMediaId && !UUID.test(entryMediaId))
    || (canonicalMediaId && entryMediaId && canonicalMediaId !== entryMediaId)) {
    return safeFailure('invalid');
  }

  try {
    if (playback?.state === 'playing') return result('pause', controller.pause());
    const mediaId = canonicalMediaId || entryMediaId;
    if (mediaId) {
      return result('play', await controller.play({ messageId: message.id, mediaId }));
    }
    if (entry?.state === 'generating' || entry?.state === 'failed') return result('none', entry);
    if (entry?.state === 'retryable') {
      const clock = Number(now());
      if (Number.isFinite(entry.retryNotBefore)
        && Number.isFinite(clock)
        && clock < entry.retryNotBefore) return result('wait', entry);
      if (AMBIGUOUS_GENERATION_FAILURES.has(entry.failureCode)) {
        const recovered = await controller.refresh(message.id);
        if (recovered?.state === 'missing') {
          return result('generate-after-missing', await controller.generate(message.id));
        }
        return result('refresh', recovered);
      }
    }
    return result('generate', await controller.generate(message.id));
  } catch {
    return safeFailure();
  }
}

export function assistantAudioMediaIdentity(message, entry) {
  const canonicalMediaId = message?.mediaId || null;
  const entryMediaId = entry?.mediaId || null;
  if ((canonicalMediaId && !UUID.test(canonicalMediaId))
    || (entryMediaId && !UUID.test(entryMediaId))
    || (canonicalMediaId && entryMediaId && canonicalMediaId !== entryMediaId)) return null;
  return canonicalMediaId || entryMediaId || null;
}
