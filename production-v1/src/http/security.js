const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function requireSameOrigin(publicOrigins) {
  const allowed = new Set(Array.isArray(publicOrigins) ? publicOrigins : [publicOrigins].filter(Boolean));
  return (request, response, next) => {
    if (!WRITE_METHODS.has(request.method)) return next();

    if (allowed.has(request.get('origin'))) return next();

    return response.status(403).json({
      data: null,
      error: { code: 'ORIGIN_NOT_ALLOWED', message: 'This request origin is not allowed.' },
      requestId: response.locals.requestId,
    });
  };
}
