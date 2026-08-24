import { createHmac } from 'node:crypto';

export function hashRateLimitSubject(secret, subject) {
  return createHmac('sha256', secret).update(subject).digest('hex');
}

function windowFor(now, durationMs) {
  const start = Math.floor(now / durationMs) * durationMs;
  return { start: new Date(start).toISOString(), expiresAt: new Date(start + durationMs).toISOString() };
}

export function createRateLimiter({ store, secret, now = () => Date.now() }) {
  if (!store || !secret) throw new Error('Rate limiter requires a store and secret');
  return {
    async consume({ subject, quota, limit, durationMs }) {
      const current = now();
      const window = windowFor(current, durationMs);
      const result = await store.consumeRateLimit({ subjectHash: hashRateLimitSubject(secret, subject), quota, windowStart: window.start, limit, expiresAt: window.expiresAt });
      return { ...result, retryAfter: Math.max(1, Math.ceil((new Date(result.expiresAt).getTime() - current) / 1000)) };
    },
  };
}
