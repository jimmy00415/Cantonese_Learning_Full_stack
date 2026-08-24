export const STORE_SCHEMA_VERSION = 1;

export const TURN_TERMINAL_STATES = new Set(['delivered', 'failed']);

export function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
