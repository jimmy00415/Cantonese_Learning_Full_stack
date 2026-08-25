const ALLOWED_FIELDS = new Set([
  'requestId',
  'conversationHash',
  'stage',
  'provider',
  'statusClass',
  'latencyMs',
  'byteCount',
  'errorCode',
]);

function safeEntry(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([key, value]) => ALLOWED_FIELDS.has(key) && value !== undefined),
  );
}

export function createLogger(write = console.info) {
  return {
    info(fields) {
      write(safeEntry(fields));
    },
  };
}
