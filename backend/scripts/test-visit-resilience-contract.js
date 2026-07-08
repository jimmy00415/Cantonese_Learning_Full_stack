import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const backendPort = String(53100 + Math.floor(Math.random() * 800));
const fakeProviderPort = String(54100 + Math.floor(Math.random() * 800));
const baseUrl = `http://127.0.0.1:${backendPort}`;
const fakeProviderBaseUrl = `http://127.0.0.1:${fakeProviderPort}`;
const providerDelayMs = 2400;
const maxAllowedLatencyMs = 1800;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function listen(server, port) {
  await new Promise((resolve) => server.listen(Number(port), '127.0.0.1', resolve));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return response.json();
    } catch {
      // Server is still starting.
    }
    await wait(250);
  }
  throw new Error('server did not become healthy');
}

const fakeProvider = createServer((req, res) => {
  if (req.url?.includes('/anthropic/v1/messages')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              sourceLanguage: 'yue-Hant-HK',
              targetLanguage: 'en',
              translatedText: 'This slow provider response should not reach the user.',
              displayText: 'This slow provider response should not reach the user.',
              speakableText: '',
              romanization: null,
              confidence: 0.91,
              needsConfirmation: false
            })
          }
        ]
      }));
    }, providerDelayMs);
    return;
  }

  if (req.url?.includes('/deployments/gpt-5/chat/completions')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: JSON.stringify({
                sourceLanguage: 'yue-Hant-HK',
                targetLanguage: 'en',
                translatedText: 'Are there any activities planned this week?',
                displayText: 'Are there any activities planned this week?',
                speakableText: '',
                romanization: null,
                confidence: 0.89,
                needsConfirmation: false
              })
            }
          }
        ]
      }));
    }, 50);
    return;
  }

  if (req.url?.includes('/v1/t2a_v2')) {
    setTimeout(() => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: { audio: '' }, base_resp: { status_code: 0 } }));
    }, providerDelayMs);
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
});

await listen(fakeProvider, fakeProviderPort);

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: backendPort,
    APP_VERSION: 'test-visit-resilience',
    LLM_PROVIDER: 'minimax',
    TTS_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'Minimax-test-minimax-key',
    MINIMAX_ANTHROPIC_BASE_URL: `${fakeProviderBaseUrl}/anthropic`,
    MINIMAX_BASE_URL: fakeProviderBaseUrl,
    HKBU_API_KEY: 'test-hkbu-key',
    HKBU_BASE_URL: fakeProviderBaseUrl,
    HKBU_MODEL: 'gpt-5',
    VISIT_TRANSLATION_PROVIDER_TIMEOUT_MS: '650',
    VISIT_TTS_TIMEOUT_MS: '650',
    ASR_PROVIDER: 'mock',
    MINIMAX_ASR_ENABLED: 'false'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  await waitForHealth();

  const translationStart = Date.now();
  const slowTranslationResponse = await fetch(`${baseUrl}/api/visit-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText: '婆婆話下星期想見朋友。',
      direction: 'yue_to_en',
      inputType: 'text',
      userMode: 'visit_translation'
    })
  });
  const translationElapsed = Date.now() - translationStart;

  assert.equal(slowTranslationResponse.status, 200);
  assert.ok(
    translationElapsed < maxAllowedLatencyMs,
    `slow LLM provider should time out and fall back quickly; elapsed=${translationElapsed}ms`
  );
  const slowTranslationPayload = await slowTranslationResponse.json();
  assert.equal(slowTranslationPayload.provider, 'hkbu');
  assert.equal(slowTranslationPayload.needsConfirmation, false);
  assert.equal(slowTranslationPayload.translatedText, 'Are there any activities planned this week?');
  assert.equal(slowTranslationPayload.ttsProvider, 'none');

  const ttsStart = Date.now();
  const slowTtsResponse = await fetch(`${baseUrl}/api/visit-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText: 'Where are you from?',
      direction: 'en_to_yue',
      inputType: 'text',
      userMode: 'visit_translation'
    })
  });
  const ttsElapsed = Date.now() - ttsStart;

  assert.equal(slowTtsResponse.status, 200);
  assert.ok(
    ttsElapsed < maxAllowedLatencyMs,
    `slow TTS provider should time out and return mock audio quickly; elapsed=${ttsElapsed}ms`
  );
  const slowTtsPayload = await slowTtsResponse.json();
  assert.equal(slowTtsPayload.provider, 'rule_based');
  assert.equal(slowTtsPayload.translatedText, '你喺邊度嚟㗎？');
  assert.equal(slowTtsPayload.ttsProvider, 'mock');
  assert.match(slowTtsPayload.ttsError, /timeout|aborted/i);
  assert.ok(slowTtsPayload.ttsAudio?.startsWith('data:audio/wav;base64,'));
} finally {
  child.kill('SIGTERM');
  fakeProvider.close();
}

if (stderr.includes('UnhandledPromiseRejection')) {
  throw new Error(stderr);
}

console.log('visit resilience contract passed');
