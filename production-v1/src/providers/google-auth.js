import { GoogleAuth } from 'google-auth-library';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';
const MAX_CACHE_MS = 5 * 60 * 1_000;
const EXPIRY_SKEW_MS = 30 * 1_000;

function authenticationError() {
  const error = new Error('GOOGLE_AUTHENTICATION_FAILED');
  error.name = 'GoogleAuthenticationError';
  error.code = 'GOOGLE_AUTHENTICATION_FAILED';
  return error;
}

function tokenResult(value) {
  if (typeof value === 'string') return { token: value, expiresAt: null };
  const token = value?.token;
  const expiresAt = value?.res?.data?.expiry_date ?? value?.expiry_date ?? null;
  return { token, expiresAt: Number.isFinite(expiresAt) ? Number(expiresAt) : null };
}

export function createGoogleAccessTokenProvider({
  auth = new GoogleAuth({ scopes: [CLOUD_PLATFORM_SCOPE] }),
  fetchImpl = globalThis.fetch,
  now = Date.now,
  maximumCacheMs = MAX_CACHE_MS,
} = {}) {
  if (typeof auth?.getAccessToken !== 'function' || typeof fetchImpl !== 'function'
    || typeof now !== 'function' || !Number.isSafeInteger(maximumCacheMs)
    || maximumCacheMs < 1_000 || maximumCacheMs > MAX_CACHE_MS) {
    throw authenticationError();
  }
  let cachedToken = null;
  let refreshAt = 0;

  const accessToken = async () => {
    const current = now();
    if (cachedToken && current < refreshAt) return cachedToken;
    try {
      const result = tokenResult(await auth.getAccessToken());
      if (typeof result.token !== 'string' || !result.token || /[\u0000-\u001f\u007f]/.test(result.token)) {
        throw authenticationError();
      }
      cachedToken = result.token;
      const boundedExpiry = result.expiresAt === null
        ? current + maximumCacheMs
        : Math.min(current + maximumCacheMs, result.expiresAt - EXPIRY_SKEW_MS);
      refreshAt = Math.max(current, boundedExpiry);
      return cachedToken;
    } catch {
      cachedToken = null;
      refreshAt = 0;
      throw authenticationError();
    }
  };

  const authenticatedFetch = async (url, init = {}) => {
    let parsed;
    try { parsed = new URL(String(url)); } catch { throw authenticationError(); }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) throw authenticationError();
    const normalizedHeaders = new Headers(init.headers ?? {});
    if (normalizedHeaders.has('authorization')) throw authenticationError();
    const headers = Object.fromEntries(normalizedHeaders);
    headers.Authorization = `Bearer ${await accessToken()}`;
    return fetchImpl(parsed.href, { ...init, headers, redirect: 'error' });
  };

  return Object.freeze({ fetch: authenticatedFetch });
}

export const googleAuthContract = Object.freeze({
  scope: CLOUD_PLATFORM_SCOPE,
  maximumCacheMs: MAX_CACHE_MS,
  expirySkewMs: EXPIRY_SKEW_MS,
});
