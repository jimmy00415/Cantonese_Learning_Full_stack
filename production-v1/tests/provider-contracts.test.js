import assert from 'node:assert/strict';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { createLlmProvider, ProviderError } from '../src/providers/llm.js';
import { runProviderSmoke } from '../scripts/provider-smoke.js';

const TURN_INPUT = Object.freeze({
  turnId: 'turn-123',
  systemPrompt: 'Return one strict JSON object.',
  messages: [{ role: 'user', content: 'Where is the Duo guide?' }],
  evidenceSnapshot: [{ id: 'evidence.ito.duo.new-phone', text: 'Use the official Duo self-service path.' }],
  maxOutputTokens: 180,
});

function openAiSuccess(rawText = '{"replyText":"ok"}', finishReason = 'stop') {
  return new Response(JSON.stringify({
    id: 'request-1',
    choices: [{ message: { content: rawText }, finish_reason: finishReason }],
    usage: { prompt_tokens: 10, completion_tokens: 4 },
  }), { status: 200, headers: { 'content-type': 'application/json', 'x-request-id': 'header-request-1' } });
}

function miniMaxSuccess(rawText = '{"replyText":"ok"}', stopReason = 'end_turn') {
  return new Response(JSON.stringify({
    id: 'minimax-request-1',
    content: [{ type: 'thinking', thinking: 'not transport output' }, { type: 'text', text: rawText }],
    stop_reason: stopReason,
    usage: { input_tokens: 11, output_tokens: 5 },
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

test('provider contract builds HKBU compatibility and Azure OpenAI deployment requests without key leakage', async () => {
  const cases = [
    {
      name: 'hkbu',
      settings: { apiKey: 'hkbu-secret-key', baseUrl: 'https://genai.test/api/v0/rest/', model: 'gpt-4o-mini', apiVersion: '2024-10-21' },
      expectedUrl: 'https://genai.test/api/v0/rest/deployments/gpt-4o-mini/chat/completions?api-version=2024-10-21',
      expectedHeader: ['api-key', 'hkbu-secret-key'],
      bodyCheck(body) { assert.equal(body.max_tokens, 180); assert.equal(body.temperature, 1); },
    },
    {
      name: 'azure-openai',
      settings: { apiKey: 'azure-secret-key', endpoint: 'https://azure.test/', deployment: 'gpt-5-mini', apiVersion: '2024-10-21' },
      expectedUrl: 'https://azure.test/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-21',
      expectedHeader: ['api-key', 'azure-secret-key'],
      bodyCheck(body) { assert.equal(body.max_completion_tokens, 1600); assert.equal('temperature' in body, false); },
    },
  ];

  for (const item of cases) {
    let request;
    const provider = createLlmProvider({
      config: { provider: item.name, settings: item.settings },
      fetchImpl: async (url, init) => { request = { url, init }; return openAiSuccess(); },
    });
    const result = await provider.generate(TURN_INPUT);
    const body = JSON.parse(request.init.body);
    assert.equal(request.url, item.expectedUrl);
    assert.equal(request.init.headers[item.expectedHeader[0]], item.expectedHeader[1]);
    assert.equal(request.init.headers['Content-Type'], 'application/json');
    assert.equal(body.stream, false);
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.match(JSON.stringify(body), /untrusted_reference_data/);
    assert.equal(JSON.stringify(body).includes(item.expectedHeader[1]), false);
    item.bodyCheck(body);
    assert.deepEqual(Object.keys(result).sort(), ['finishReason', 'latencyMs', 'provider', 'providerRequestId', 'rawText', 'usage'].sort());
    assert.equal(result.provider, item.name);
    assert.equal(result.rawText, '{"replyText":"ok"}');
  }
});

test('provider contract uses the selected MiniMax Anthropic X-Api-Key contract and text blocks only', async () => {
  let request;
  const provider = createLlmProvider({
    config: {
      provider: 'minimax',
      settings: { apiKey: 'minimax-secret-key', anthropicBaseUrl: 'https://minimax.test/anthropic/', model: 'MiniMax-M2.1' },
    },
    fetchImpl: async (url, init) => { request = { url, init }; return miniMaxSuccess(); },
  });
  const result = await provider.generate(TURN_INPUT);
  const body = JSON.parse(request.init.body);
  assert.equal(request.url, 'https://minimax.test/anthropic/v1/messages');
  assert.equal(request.init.headers['X-Api-Key'], 'minimax-secret-key');
  assert.equal(request.init.headers.Authorization, undefined);
  assert.equal(body.system, TURN_INPUT.systemPrompt);
  assert.equal(body.messages.some((message) => message.role === 'system'), false);
  assert.match(body.messages.at(-1).content, /untrusted_reference_data/);
  assert.equal(result.rawText, '{"replyText":"ok"}');
  assert.equal(result.finishReason, 'end_turn');
});

test('provider contract retries one transient failure inside one deadline with byte-identical body', async () => {
  const calls = [];
  const delays = [];
  let now = 1_000;
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    now: () => now,
    sleep: async (milliseconds) => { delays.push(milliseconds); now += milliseconds; },
    totalDeadlineMs: 12_000,
    fetchImpl: async (url, init) => {
      calls.push({ url, body: init.body, signal: init.signal });
      if (calls.length === 1) return new Response('busy', { status: 429, headers: { 'retry-after': '1' } });
      return openAiSuccess();
    },
  });
  const result = await provider.generate(TURN_INPUT);
  assert.equal(result.rawText, '{"replyText":"ok"}');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].body, calls[1].body);
  assert.deepEqual(delays, [1000]);
  assert.equal(calls.every((call) => call.signal instanceof AbortSignal), true);
});

test('provider contract does not retry auth, schema, refusal, content-filter, or successful truncation failures', async () => {
  const cases = [
    ['auth', () => new Response('denied', { status: 401 }), 'PROVIDER_AUTH_FAILED'],
    ['invalid schema', () => new Response('{bad json', { status: 200 }), 'PROVIDER_INVALID_RESPONSE'],
    ['refusal', () => new Response(JSON.stringify({ choices: [{ message: { refusal: 'no', content: '' }, finish_reason: 'stop' }] }), { status: 200 }), 'PROVIDER_REFUSED'],
    ['content filter', () => openAiSuccess('', 'content_filter'), 'PROVIDER_CONTENT_FILTERED'],
    ['truncation', () => openAiSuccess('{"partial":', 'length'), 'PROVIDER_OUTPUT_TRUNCATED'],
  ];
  for (const [name, responseFactory, code] of cases) {
    let calls = 0;
    const provider = createLlmProvider({
      config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
      fetchImpl: async () => { calls += 1; return responseFactory(); },
      sleep: async () => {},
    });
    await assert.rejects(provider.generate(TURN_INPUT), (error) => error instanceof ProviderError && error.code === code, name);
    assert.equal(calls, 1, name);
  }
});

test('provider contract caps the complete response body at 256 KiB', async () => {
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    fetchImpl: async () => new Response('x'.repeat((256 * 1024) + 1), { status: 200 }),
  });
  await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_RESPONSE_TOO_LARGE');
});

test('provider contract enforces one shared total deadline across retry delay and response reading', async () => {
  const provider = createLlmProvider({
    config: { provider: 'hkbu', settings: { apiKey: 'key', baseUrl: 'https://hkbu.test', model: 'model', apiVersion: 'v1' } },
    totalDeadlineMs: 20,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 40));
      return openAiSuccess();
    },
  });
  await assert.rejects(provider.generate(TURN_INPUT), (error) => error.code === 'PROVIDER_TIMEOUT');
});

test('provider config exposes selected private settings only and keeps publicStatus secret-free', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'minimax',
    V1_MINIMAX_API_KEY: 'selected-secret',
    V1_MINIMAX_BASE_URL: 'https://minimax.test',
    V1_MINIMAX_ANTHROPIC_BASE_URL: 'https://minimax.test/anthropic',
    V1_MINIMAX_LLM_MODEL: 'MiniMax-M2.1',
    HKBU_API_KEY: 'unselected-hkbu-secret', HKBU_BASE_URL: 'https://hkbu.test', HKBU_MODEL: 'hkbu', HKBU_API_VERSION: 'v1',
  });
  assert.deepEqual(config.llm.settings, {
    apiKey: 'selected-secret',
    baseUrl: 'https://minimax.test',
    anthropicBaseUrl: 'https://minimax.test/anthropic',
    model: 'MiniMax-M2.1',
  });
  assert.equal(JSON.stringify(config.publicStatus).includes('selected-secret'), false);
  assert.equal(JSON.stringify(config.llm.settings).includes('unselected-hkbu-secret'), false);
});

test('provider smoke is inert without confirmation and makes one secret-safe selected-provider request when confirmed', async () => {
  const output = [];
  const errors = [];
  let calls = 0;
  const env = {
    NODE_ENV: 'test', V1_LLM_PROVIDER: 'hkbu', V1_HKBU_API_KEY: 'never-print-this-key',
    V1_HKBU_BASE_URL: 'https://hkbu.test', V1_HKBU_MODEL: 'model', V1_HKBU_API_VERSION: 'v1',
  };
  const inert = await runProviderSmoke({ argv: [], env, fetchImpl: async () => { calls += 1; return openAiSuccess('{}'); }, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  assert.notEqual(inert, 0);
  assert.equal(calls, 0);

  const confirmed = await runProviderSmoke({ argv: ['--confirm-real-provider'], env, fetchImpl: async () => { calls += 1; return openAiSuccess('{}'); }, stdout: (line) => output.push(line), stderr: (line) => errors.push(line) });
  assert.equal(confirmed, 0);
  assert.equal(calls, 1);
  const rendered = [...output, ...errors].join('\n');
  assert.equal(rendered.includes('never-print-this-key'), false);
  assert.equal(rendered.includes('https://hkbu.test'), false);
  assert.equal(rendered.includes('smoke'), false);
  assert.match(rendered, /"provider":"hkbu"/);
  assert.match(rendered, /"normalizedSuccess":true/);

  const failedOutput = [];
  const failedErrors = [];
  const failed = await runProviderSmoke({
    argv: ['--confirm-real-provider'], env,
    fetchImpl: async () => new Response('never-print-this-key and private provider body', { status: 401 }),
    stdout: (line) => failedOutput.push(line), stderr: (line) => failedErrors.push(line),
  });
  assert.equal(failed, 1);
  const failureRendered = [...failedOutput, ...failedErrors].join('\n');
  assert.equal(failureRendered.includes('never-print-this-key'), false);
  assert.equal(failureRendered.includes('private provider body'), false);
  assert.equal(failureRendered.includes('https://hkbu.test'), false);
  assert.match(failureRendered, /"httpClass":"4xx"/);
  assert.match(failureRendered, /"code":"PROVIDER_AUTH_FAILED"/);
});
