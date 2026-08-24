const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireSameOrigin(publicOrigin) {
  return (request, response, next) => {
    if (!WRITE_METHODS.has(request.method)) return next();

    if (request.get('origin') === publicOrigin) return next();

    return response.status(403).json({
      data: null,
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This request origin is not allowed.' },
      requestId: response.locals.requestId,
    });
  };
}
