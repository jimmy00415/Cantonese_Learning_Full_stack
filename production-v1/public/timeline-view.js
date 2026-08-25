function timelineKey(message, index) {
  if (typeof message?.clientMessageId === 'string' && message.clientMessageId) {
    return `client:${message.clientMessageId}`;
  }
  if (typeof message?.id === 'string' && message.id) return `message:${message.id}`;
  return `position:${index}`;
}

function renderSignature(message, isLatestAssistant) {
  return JSON.stringify([message, isLatestAssistant]);
}

const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function assistantVoiceMessagesToPrepare(messages = [], entries = {}) {
  return messages.filter((message) => (
    message?.role === 'assistant'
      && message?.status === 'delivered'
      && message?.replyMode === 'voice'
      && !message?.mediaId
      && PUBLIC_UUID.test(String(message?.id ?? ''))
      && !Object.prototype.hasOwnProperty.call(entries ?? {}, message.id)
  ));
}

export function currentReplyTupleIsFixed({ voiceSnapshot = null, messages = [] } = {}) {
  return Boolean(
    voiceSnapshot?.phase === 'binding'
      || voiceSnapshot?.binding
      || messages.some((message) => (
        message?.optimistic
          && ['sending', 'unconfirmed', 'retryable-rejection'].includes(message.sendState)
      )),
  );
}

export function reconcileMessageFeed(container, messages = [], createMessage) {
  if (!container?.children || typeof createMessage !== 'function') {
    throw new Error('A message-feed container and renderer are required');
  }
  const latestAssistant = [...messages].reverse().find((message) => message?.role === 'assistant');
  const existingByKey = new Map(Array.from(container.children).map((node) => (
    [node.dataset?.timelineKey, node]
  )).filter(([key]) => key));
  const desiredKeys = new Set();

  messages.forEach((message, index) => {
    const key = timelineKey(message, index);
    const isLatestAssistant = message?.id === latestAssistant?.id;
    const signature = renderSignature(message, isLatestAssistant);
    desiredKeys.add(key);
    let node = existingByKey.get(key);
    if (!node || node.dataset.timelineSignature !== signature) {
      const replacement = createMessage(message, { isLatestAssistant });
      replacement.dataset.timelineKey = key;
      replacement.dataset.timelineSignature = signature;
      if (node) container.replaceChild(replacement, node);
      node = replacement;
    }
    const nodeAtIndex = container.children[index] ?? null;
    if (nodeAtIndex !== node) container.insertBefore(node, nodeAtIndex);
  });

  for (const node of Array.from(container.children)) {
    if (!desiredKeys.has(node.dataset?.timelineKey)) container.removeChild(node);
  }
}
