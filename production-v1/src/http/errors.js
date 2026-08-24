export function httpError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

export function sendError(response, error) {
  const status = error.status ?? (error.code === 'IDEMPOTENCY_CONFLICT' ? 409 : error.code === 'NOT_FOUND' ? 404 : 500);
  response.status(status).json({ data: null, error: { code: error.code ?? 'INTERNAL_ERROR', message: error.expose ? error.message : safeMessage(error.code) }, requestId: response.locals.requestId });
}

function safeMessage(code) {
  const messages = {
    SESSION_NOT_FOUND: 'A valid session is required.',
    INVALID_REQUEST: 'The request is invalid.',
    IDEMPOTENCY_CONFLICT: 'This client message ID was already used with different content.',
    RATE_LIMITED: 'Too many requests. Please try again later.',
    NOT_FOUND: 'The requested resource was not found.',
  };
  return messages[code] ?? 'The service could not process this request.';
}
