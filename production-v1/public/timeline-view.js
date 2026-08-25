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
