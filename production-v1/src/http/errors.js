export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function sendError(response, error) {
  const normalized = normalizeError(error);
  response.status(normalized.status).json({ data: null, error: { code: normalized.code, message: safeMessage(normalized.code) }, requestId: response.locals.requestId });
}

function normalizeError(error = {}) {
  if (error.type === 'entity.parse.failed' || error.code === 'INVALID_REQUEST') return { status: 400, code: 'INVALID_REQUEST' };
  if (error.type === 'entity.too.large' || error.status === 413) return { status: 413, code: 'PAYLOAD_TOO_LARGE' };
  const known = {
    SESSION_NOT_FOUND: 401, NOT_FOUND: 404, IDEMPOTENCY_CONFLICT: 409,
    INVALID_VOICE_DRAFT: 400, RATE_LIMITED: 429, ORIGIN_NOT_ALLOWED: 403,
  };
  return error.code in known ? { status: known[error.code], code: error.code } : { status: 500, code: 'INTERNAL_ERROR' };
}

function safeMessage(code) {
  const messages = {
    SESSION_NOT_FOUND: 'A valid session is required.',
    INVALID_REQUEST: 'The request is invalid.',
    INVALID_VOICE_DRAFT: 'The voice draft is unavailable.',
    PAYLOAD_TOO_LARGE: 'The request body is too large.',
    IDEMPOTENCY_CONFLICT: 'This client message ID was already used with different content.',
    RATE_LIMITED: 'Too many requests. Please try again later.',
    NOT_FOUND: 'The requested resource was not found.',
  };
  return messages[code] ?? 'The service could not process this request.';
}
