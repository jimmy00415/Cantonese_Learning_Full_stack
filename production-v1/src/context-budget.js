export const contextLimits = Object.freeze({
  turnBytes: 48 * 1024,
  providerConversationBytes: 48 * 1024,
  providerRequestBytes: 96 * 1024,
});

function project(message, contentKey) {
  return { role: message.role, [contentKey]: String(message[contentKey] ?? '') };
}

export function conversationBytes(messages, { contentKey = 'text' } = {}) {
  return Buffer.byteLength(JSON.stringify(messages.map((message) => project(message, contentKey))));
}

export function retainRecentCompletePairs(messages, { maxBytes, contentKey = 'text' } = {}) {
  const limit = Number(maxBytes);
  if (!Number.isInteger(limit) || limit < 1) throw new Error('context byte budget must be a positive integer');
  const usable = (Array.isArray(messages) ? messages : []).filter((message) => (
    message
    && ['user', 'assistant'].includes(message.role)
    && typeof message[contentKey] === 'string'
    && message[contentKey].trim()
  ));
  let currentIndex = -1;
  for (let index = usable.length - 1; index >= 0; index -= 1) {
    if (usable[index].role === 'user') { currentIndex = index; break; }
  }
  if (currentIndex < 0) return [];

  const current = usable[currentIndex];
  let selected = [current];
  const history = usable.slice(0, currentIndex);
  for (let index = history.length - 2; index >= 0; index -= 2) {
    const pair = [history[index], history[index + 1]];
    if (pair[0]?.role !== 'user' || pair[1]?.role !== 'assistant') break;
    const candidate = [...pair, ...selected];
    if (conversationBytes(candidate, { contentKey }) > limit) break;
    selected = candidate;
  }
  return selected;
}
