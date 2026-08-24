export const STORE_SCHEMA_VERSION = 2;
export { contextLimits } from '../context-budget.js';

export const TURN_TERMINAL_STATES = new Set(['delivered', 'failed']);
export const TURN_STATES = new Set(['accepted', 'retrieving', 'generating', ...TURN_TERMINAL_STATES]);

export const SAFE_TURN_FAILURE_CODES = new Set([
  'ANSWER_FAILED',
  'PROVIDER_AUTH_FAILED',
  'PROVIDER_CONTENT_FILTERED',
  'PROVIDER_INVALID_RESPONSE',
  'PROVIDER_OUTPUT_TRUNCATED',
  'PROVIDER_REQUEST_TOO_LARGE',
  'PROVIDER_RESPONSE_TOO_LARGE',
  'PROVIDER_TIMEOUT',
  'PROVIDER_UNAVAILABLE',
]);

export function storeError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
