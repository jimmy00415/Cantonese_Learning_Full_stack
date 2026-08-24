import { createHmac } from 'node:crypto';

export function hashRateLimitSubject(secret, subject) {
  return createHmac('sha256', secret).update(subject).digest('hex');
}

export function rateLimitBucket({ secret, subject, quota, limit, durationMs, now = Date.now() }) {
  const start = Math.floor(now / durationMs) * durationMs;
  return {
    subjectHash: hashRateLimitSubject(secret, subject), quota, limit,
    windowStart: new Date(start).toISOString(), expiresAt: new Date(start + durationMs).toISOString(),
  };
}

export function createRateLimiter({ store, secret, now = () => Date.now() }) {
  if (!store || !secret) throw new Error('Rate limiter requires a store and secret');
  return {
    async consume({ subject, quota, limit, durationMs }) {
      const current = now();
      const bucket = rateLimitBucket({ secret, subject, quota, limit, durationMs, now: current });
      const result = await store.consumeRateLimit(bucket);
      return { ...result, retryAfter: Math.max(1, Math.ceil((new Date(result.expiresAt).getTime() - current) / 1000)) };
    },
  };
}
