import { contextLimits, retainRecentCompletePairs } from '../context-budget.js';

const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_DEADLINE_MS = 12_000;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

const TRANSIENT_STATUS = new Set([408, 429]);
const TRUNCATED_REASONS = new Set(['length', 'max_tokens', 'max_output_tokens']);
const FILTERED_REASONS = new Set(['content_filter', 'content_filtered', 'safety']);
const RESPONSE_LANGUAGE_LABELS = Object.freeze({
  en: 'English',
  zhHant: 'Traditional Chinese',
  zhHans: 'Simplified Chinese',
});

export class ProviderError extends Error {
  constructor(code, { status, retryAfterMs, transient = false } = {}) {
    super(code);
    this.name = 'ProviderError';
    this.code = code;
    this.statusClass = Number.isInteger(status) ? `${Math.floor(status / 100)}xx` : null;
    this.retryAfterMs = retryAfterMs ?? null;
    this.transient = transient;
  }
}

function providerError(code, details) {
  return new ProviderError(code, details);
}

function trimTrailingSlash(value) {
  return String(value ?? '').replace(/\/+$/, '');
}

function safeBaseUrl(value) {
  let url;
  try { url = new URL(String(value ?? '')); } catch { throw providerError('PROVIDER_NOT_CONFIGURED'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw providerError('PROVIDER_NOT_CONFIGURED');
  }
  return trimTrailingSlash(url.href);
}

function safeUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const output = {};
  for (const key of ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens']) {
    if (Number.isFinite(value[key]) && value[key] >= 0) output[key] = Number(value[key]);
  }
  return Object.keys(output).length > 0 ? output : null;
}

function requestIdFrom(response, payload) {
  if (typeof payload?.id === 'string' && payload.id.length <= 256) return payload.id;
  for (const name of ['x-request-id', 'apim-request-id', 'request-id']) {
    const value = response.headers?.get?.(name);
    if (value && value.length <= 256) return value;
  }
  return null;
}

function responseLanguageFor(input) {
  return Object.hasOwn(RESPONSE_LANGUAGE_LABELS, input?.responseLanguage)
    ? input.responseLanguage
    : 'en';
}

function trustedSystemPrompt(input) {
  const responseLanguage = responseLanguageFor(input);
  const instruction = [
    `Server-selected responseLanguage=${responseLanguage}.`,
    `Write replyText and suggestedReplies in ${RESPONSE_LANGUAGE_LABELS[responseLanguage]}.`,
    'Do not infer the response language from conversation history or untrusted reference data.',
  ].join(' ');
  const maximumBaseLength = Math.max(0, 12_000 - instruction.length - 1);
  const base = String(input?.systemPrompt ?? '').slice(0, maximumBaseLength);
  return base ? `${base}\n${instruction}` : instruction;
}

function evidenceMessage(turnId, evidenceSnapshot, actionSnapshot) {
  const serialized = JSON.stringify({
    turnId: String(turnId ?? '').slice(0, 128),
    evidence: Array.isArray(evidenceSnapshot) ? evidenceSnapshot : [],
    actions: Array.isArray(actionSnapshot) ? actionSnapshot : [],
  });
  return `<untrusted_reference_data>\n${serialized}\n</untrusted_reference_data>`;
}

function normalizedMessages(input) {
  const messages = Array.isArray(input.messages) ? input.messages : [];
  const normalized = messages
    .filter((message) => message && ['user', 'assistant'].includes(message.role) && typeof message.content === 'string' && message.content.trim())
    .map((message) => ({ role: message.role, content: message.content }));
  const bounded = retainRecentCompletePairs(normalized, {
    maxBytes: contextLimits.providerConversationBytes,
    contentKey: 'content',
  });
  bounded.push({ role: 'user', content: evidenceMessage(input.turnId, input.evidenceSnapshot, input.actionSnapshot) });
  return bounded;
}

function buildRequest(config, input) {
  const settings = config.settings ?? {};
  const maxOutputTokens = Math.max(1, Math.min(Number(input.maxOutputTokens) || 800, 4_000));
  const system = trustedSystemPrompt(input);
  const messages = normalizedMessages(input);

  if (config.provider === 'hkbu') {
    // Compatibility contract verified against the existing HKBU OpenAI-style deployment client.
    const url = `${safeBaseUrl(settings.baseUrl)}/deployments/${encodeURIComponent(settings.model)}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion)}`;
    return {
      url,
      headers: { accept: 'application/json', 'Content-Type': 'application/json', 'api-key': settings.apiKey },
      body: {
        messages: [{ role: 'system', content: system }, ...messages],
        temperature: 1,
        max_tokens: maxOutputTokens,
        response_format: { type: 'json_object' },
        stream: false,
      },
    };
  }

  if (config.provider === 'azure-openai') {
    const requestProfile = settings.requestProfile;
    if (!['standard', 'reasoning'].includes(requestProfile)) throw providerError('PROVIDER_NOT_CONFIGURED');
    const url = `${safeBaseUrl(settings.endpoint)}/openai/deployments/${encodeURIComponent(settings.deployment)}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion)}`;
    const body = {
      messages: [{ role: 'system', content: system }, ...messages],
      max_completion_tokens: requestProfile === 'reasoning'
        ? Math.max(maxOutputTokens, Number(settings.minCompletionTokens) || 1_600)
        : maxOutputTokens,
      response_format: { type: 'json_object' },
      stream: false,
    };
    if (requestProfile === 'standard') body.temperature = 0.2;
    return {
      url,
      headers: { 'api-key': settings.apiKey, 'Content-Type': 'application/json' },
      body,
    };
  }

  if (config.provider === 'minimax') {
    return {
      url: `${safeBaseUrl(settings.anthropicBaseUrl)}/v1/messages`,
      headers: { 'X-Api-Key': settings.apiKey, 'Content-Type': 'application/json' },
      body: {
        model: settings.model,
        system,
        messages,
        max_tokens: maxOutputTokens,
        temperature: 0.2,
        stream: false,
      },
    };
  }

  throw providerError('PROVIDER_NOT_CONFIGURED');
}

function parseRetryAfter(response, now) {
  const millisecondsHeader = response.headers?.get?.('x-ms-retry-after-ms');
  const milliseconds = millisecondsHeader === null || millisecondsHeader === undefined ? null : Number(millisecondsHeader);
  if (milliseconds !== null && Number.isFinite(milliseconds) && milliseconds >= 0) return Math.min(milliseconds, MAX_RETRY_DELAY_MS);
  const value = response.headers?.get?.('retry-after');
  if (!value) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  const instant = Date.parse(value);
  if (Number.isFinite(instant)) return Math.min(Math.max(0, instant - now), MAX_RETRY_DELAY_MS);
  return DEFAULT_RETRY_DELAY_MS;
}

async function readBoundedBody(response, signal) {
  if (!response.body?.getReader) {
    const value = Buffer.from(await response.arrayBuffer());
    if (value.byteLength > MAX_RESPONSE_BYTES) throw providerError('PROVIDER_RESPONSE_TOO_LARGE');
    return value.toString('utf8');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw providerError('PROVIDER_TIMEOUT');
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw providerError('PROVIDER_RESPONSE_TOO_LARGE');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (signal.aborted && error?.code !== 'PROVIDER_RESPONSE_TOO_LARGE') throw providerError('PROVIDER_TIMEOUT');
    throw error;
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size).toString('utf8');
}

function parseJsonBody(text) {
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw providerError('PROVIDER_INVALID_RESPONSE');
  }
}

function parseProviderSuccess(provider, response, payload, latencyMs) {
  if (provider === 'minimax') {
    const finishReason = typeof payload.stop_reason === 'string' ? payload.stop_reason : null;
    if (TRUNCATED_REASONS.has(finishReason)) throw providerError('PROVIDER_OUTPUT_TRUNCATED');
    if (FILTERED_REASONS.has(finishReason)) throw providerError('PROVIDER_CONTENT_FILTERED');
    if (finishReason === 'refusal') throw providerError('PROVIDER_REFUSED');
    const rawText = Array.isArray(payload.content)
      ? payload.content.filter((part) => part?.type === 'text' && typeof part.text === 'string').map((part) => part.text).join('')
      : '';
    if (!rawText.trim()) throw providerError(finishReason === 'refusal' ? 'PROVIDER_REFUSED' : 'PROVIDER_INVALID_RESPONSE');
    return { rawText: rawText.trim(), provider, latencyMs, usage: safeUsage(payload.usage), finishReason, providerRequestId: requestIdFrom(response, payload) };
  }

  const choice = payload.choices?.[0];
  const finishReason = typeof choice?.finish_reason === 'string' ? choice.finish_reason : null;
  if (TRUNCATED_REASONS.has(finishReason)) throw providerError('PROVIDER_OUTPUT_TRUNCATED');
  if (FILTERED_REASONS.has(finishReason)) throw providerError('PROVIDER_CONTENT_FILTERED');
  if (choice?.message?.refusal) throw providerError('PROVIDER_REFUSED');
  const rawText = choice?.message?.content;
  if (typeof rawText !== 'string' || !rawText.trim()) throw providerError('PROVIDER_INVALID_RESPONSE');
  return { rawText: rawText.trim(), provider, latencyMs, usage: safeUsage(payload.usage), finishReason, providerRequestId: requestIdFrom(response, payload) };
}

function defaultSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(providerError('PROVIDER_TIMEOUT'));
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(providerError('PROVIDER_TIMEOUT'));
    }, { once: true });
  });
}

function deterministicResult(input, now) {
  const evidence = Array.isArray(input.evidenceSnapshot) ? input.evidenceSnapshot : [];
  const first = evidence[0];
  const responseLanguage = responseLanguageFor(input);
  const text = first?.text?.[responseLanguage]
    ?? first?.text?.en
    ?? first?.text?.zhHant
    ?? first?.text
    ?? 'I could not confirm that from the reviewed HKBU information.';
  return {
    rawText: JSON.stringify({
      replyText: String(text).slice(0, 4_000),
      evidenceIds: evidence.slice(0, 8).map((claim) => claim.id).filter(Boolean),
      actionIds: [],
      suggestedReplies: [],
      needsClarification: evidence.length === 0,
      groundingStatus: evidence.length > 0 ? 'verified' : 'unverified',
    }),
    provider: 'deterministic',
    latencyMs: Math.max(0, now() - now()),
    usage: null,
    finishReason: 'stop',
    providerRequestId: null,
  };
}

export function createLlmProvider({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  sleep = defaultSleep,
  totalDeadlineMs = DEFAULT_DEADLINE_MS,
  maxRetries = 1,
} = {}) {
  if (!config?.provider) throw new Error('createLlmProvider requires selected provider config');
  if (config.provider === 'deterministic') {
    return { provider: 'deterministic', generate: async (input) => deterministicResult(input, now) };
  }
  if (typeof fetchImpl !== 'function') throw new Error('createLlmProvider requires fetch');

  const generate = async (input, options = {}) => {
    const request = buildRequest(config, input);
    const serializedBody = JSON.stringify(request.body);
    if (Buffer.byteLength(serializedBody) > contextLimits.providerRequestBytes) {
      throw providerError('PROVIDER_REQUEST_TOO_LARGE');
    }
    const startedAt = now();
    const deadlineMs = Math.max(1, Number(options.totalDeadlineMs ?? totalDeadlineMs));
    const deadlineAt = startedAt + deadlineMs;
    const retryLimit = Math.max(0, Math.min(Number(options.retryLimit ?? maxRetries) || 0, 1));
    const controller = new AbortController();
    const externalSignal = input.signal;
    const abortFromExternal = () => controller.abort(externalSignal?.reason);
    if (externalSignal?.aborted) abortFromExternal();
    else externalSignal?.addEventListener('abort', abortFromExternal, { once: true });
    const timer = setTimeout(() => controller.abort(), deadlineMs);

    try {
      for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
        if (controller.signal.aborted || now() >= deadlineAt) throw providerError('PROVIDER_TIMEOUT');
        try {
          const response = await fetchImpl(request.url, {
            method: 'POST',
            headers: request.headers,
            body: serializedBody,
            signal: controller.signal,
            redirect: 'error',
          });
          if (controller.signal.aborted || now() >= deadlineAt) throw providerError('PROVIDER_TIMEOUT');
          const responseText = await readBoundedBody(response, controller.signal);
          if (controller.signal.aborted || now() >= deadlineAt) throw providerError('PROVIDER_TIMEOUT');
          if (!response.ok) {
            const status = response.status;
            const transient = TRANSIENT_STATUS.has(status) || status >= 500;
            const code = status === 401 || status === 403 ? 'PROVIDER_AUTH_FAILED' : (transient ? 'PROVIDER_TRANSIENT' : 'PROVIDER_UNAVAILABLE');
            throw providerError(code, { status, transient, retryAfterMs: transient ? parseRetryAfter(response, now()) : null });
          }
          const payload = parseJsonBody(responseText);
          return parseProviderSuccess(config.provider, response, payload, Math.max(0, now() - startedAt));
        } catch (error) {
          if (controller.signal.aborted || now() >= deadlineAt) throw providerError('PROVIDER_TIMEOUT');
          const normalized = error instanceof ProviderError
            ? error
            : providerError('PROVIDER_TRANSIENT', { transient: true });
          if (!normalized.transient || attempt >= retryLimit) throw normalized;
          const remaining = deadlineAt - now();
          const delay = Math.min(normalized.retryAfterMs ?? DEFAULT_RETRY_DELAY_MS, remaining);
          if (delay <= 0) throw providerError('PROVIDER_TIMEOUT');
          await sleep(delay, controller.signal);
        }
      }
      throw providerError('PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener?.('abort', abortFromExternal);
    }
  };

  return { provider: config.provider, generate };
}

export const providerLimits = Object.freeze({
  responseBytes: MAX_RESPONSE_BYTES,
  deadlineMs: DEFAULT_DEADLINE_MS,
  retries: 1,
  requestBytes: contextLimits.providerRequestBytes,
  conversationBytes: contextLimits.providerConversationBytes,
});
