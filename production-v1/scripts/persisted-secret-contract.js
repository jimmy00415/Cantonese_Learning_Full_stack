const FORBIDDEN_SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt|password|passphrase|api[_-]?key|client[_-]?secret|private[_-]?key)$/i;
const FORBIDDEN_SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@)/i;

export function containsForbiddenPersistedSecret(value) {
  if (typeof value === 'string') return FORBIDDEN_SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenPersistedSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_SECRET_KEY.test(key) || containsForbiddenPersistedSecret(child)
  ));
}
