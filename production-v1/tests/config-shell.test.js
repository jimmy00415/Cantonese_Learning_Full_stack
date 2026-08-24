import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import { createApp } from '../src/app.js';
import { createLogger } from '../src/telemetry/logger.js';

function productionEnvironment(overrides = {}) {
  return {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: 'https://v1.example.test',
    V1_SESSION_SECRET: '12345678901234567890123456789012',
    V1_TRUST_PROXY_HOPS: '1',
    V1_STORE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://localhost/v1',
    V1_MEDIA_DRIVER: 'azure-blob',
    V1_AZURE_BLOB_CONTAINER: 'v1-media',
    V1_AZURE_STORAGE_CONNECTION_STRING: 'UseDevelopmentStorage=true',
    V1_LLM_PROVIDER: 'hkbu',
    HKBU_API_KEY: 'test-key',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
    V1_INSTANCE_POLICY: 'single',
    V1_PRIVACY_NOTICE_VERSION: '2026-08-25',
    V1_PRIVACY_NOTICE_APPROVED: 'true',
    V1_RETENTION_WORKER_ENABLED: 'true',
    ...overrides,
  };
}

test('config defaults to a local atomic-file runtime outside production', () => {
  const config = loadConfig({ NODE_ENV: 'test' });

  assert.equal(config.storeDriver, 'atomic-file');
  assert.equal(config.productionReady, false);
  assert.deepEqual(config.rateLimits, {
    bootstrap: 20,
    message5m: 30,
    messageDaily: 300,
    asr10m: 10,
    asrDaily: 60,
    tts10m: 5,
    ttsDaily: 20,
  });
});

test('config rejects production without a public origin', () => {
  assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /V1_PUBLIC_ORIGIN/);
});

test('config gives V1 provider selectors precedence over legacy selectors', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    LLM_PROVIDER: 'minimax',
    HKBU_API_KEY: 'test-key',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
  });

  assert.equal(config.llm.provider, 'hkbu');
  assert.equal(config.llm.available, true);
});

test('config requires every explicit selected LLM provider member', () => {
  const providers = [
    {
      name: 'HKBU',
      selector: 'hkbu',
      values: {
        HKBU_API_KEY: 'key', HKBU_BASE_URL: 'https://hkbu.example.test',
        HKBU_MODEL: 'hkbu-model', HKBU_API_VERSION: 'v1',
      },
    },
    {
      name: 'Azure OpenAI',
      selector: 'azure-openai',
      values: {
        AZURE_OPENAI_KEY: 'key', AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
        AZURE_OPENAI_DEPLOYMENT: 'chat', AZURE_OPENAI_API_VERSION: '2024-10-21',
        AZURE_OPENAI_REQUEST_PROFILE: 'standard',
      },
    },
    {
      name: 'MiniMax',
      selector: 'minimax',
      values: {
        MINIMAX_API_KEY: 'key', MINIMAX_BASE_URL: 'https://minimax.example.test',
        MINIMAX_ANTHROPIC_BASE_URL: 'https://anthropic.example.test', MINIMAX_LLM_MODEL: 'model',
      },
    },
  ];

  for (const provider of providers) {
    const complete = { NODE_ENV: 'test', V1_LLM_PROVIDER: provider.selector, ...provider.values };
    assert.equal(loadConfig(complete).llm.available, true, `${provider.name} complete pair is available`);

    for (const missingMember of Object.keys(provider.values)) {
      const incompleteValues = { ...provider.values };
      delete incompleteValues[missingMember];
      const incomplete = { NODE_ENV: 'test', V1_LLM_PROVIDER: provider.selector, ...incompleteValues };
      const incompleteProduction = productionEnvironment({ V1_LLM_PROVIDER: provider.selector, ...provider.values });
      delete incompleteProduction[missingMember];
      assert.equal(loadConfig(incomplete).llm.available, false, `${provider.name} requires ${missingMember} locally`);
      assert.throws(
        () => loadConfig(incompleteProduction),
        /configured real LLM provider/,
        `${provider.name} requires ${missingMember} in production`,
      );
    }
  }

  const azureVoice = loadConfig({
    NODE_ENV: 'test', V1_ASR_PROVIDER: 'azure', V1_TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastasia',
  });
  const minimaxVoice = loadConfig({
    NODE_ENV: 'test', V1_ASR_PROVIDER: 'minimax', V1_TTS_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'key', MINIMAX_ASR_ENABLED: 'true', MINIMAX_ASR_ENDPOINT: 'https://asr.example.test',
    MINIMAX_ASR_MODEL: 'asr-model', MINIMAX_BASE_URL: 'https://minimax.example.test',
    MINIMAX_TTS_MODEL: 'tts-model', MINIMAX_TTS_VOICE: 'voice',
  });

  assert.equal(azureVoice.asr.available, true);
  assert.equal(azureVoice.tts.available, true);
  assert.equal(minimaxVoice.asr.available, false);
  assert.equal(minimaxVoice.tts.available, true);
});

test('config gives V1 voice selectors precedence over legacy selectors', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_ASR_PROVIDER: 'none', ASR_PROVIDER: 'azure',
    V1_TTS_PROVIDER: 'none', TTS_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'key', AZURE_SPEECH_REGION: 'eastasia',
  });

  assert.equal(config.asr.provider, 'none');
  assert.equal(config.tts.provider, 'none');
  assert.equal(config.asr.available, false);
  assert.equal(config.tts.available, false);
});

test('config requires the Azure deployment setting rather than a model alias', () => {
  const azureModelOnly = {
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'azure-openai',
    AZURE_OPENAI_KEY: 'key',
    AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
    AZURE_OPENAI_MODEL: 'not-a-deployment',
    AZURE_OPENAI_API_VERSION: '2024-10-21',
    AZURE_OPENAI_REQUEST_PROFILE: 'standard',
  };

  assert.equal(loadConfig(azureModelOnly).llm.available, false);
  assert.throws(
    () => loadConfig(productionEnvironment({
      V1_LLM_PROVIDER: 'azure-openai',
      AZURE_OPENAI_KEY: 'key',
      AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
      AZURE_OPENAI_MODEL: 'not-a-deployment',
      AZURE_OPENAI_API_VERSION: '2024-10-21',
      AZURE_OPENAI_REQUEST_PROFILE: 'standard',
    })),
    /configured real LLM provider/,
  );
});

test('config fails closed when selected Azure lacks an explicit allowed request profile', () => {
  const base = {
    NODE_ENV: 'test', V1_LLM_PROVIDER: 'azure-openai',
    V1_AZURE_OPENAI_KEY: 'key', V1_AZURE_OPENAI_ENDPOINT: 'https://azure.example.test',
    V1_AZURE_OPENAI_DEPLOYMENT: 'neutral-slot', V1_AZURE_OPENAI_API_VERSION: '2024-10-21',
  };
  assert.equal(loadConfig(base).llm.available, false);
  assert.equal(loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'standard' }).llm.available, true);
  assert.equal(loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'reasoning' }).llm.available, true);
  assert.throws(() => loadConfig({ ...base, V1_AZURE_OPENAI_REQUEST_PROFILE: 'auto' }), /REQUEST_PROFILE/);
});

test('config disables incomplete voice providers without disabling text', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    HKBU_API_KEY: 'test-key',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
    V1_ASR_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'speech-key',
    V1_TTS_PROVIDER: 'minimax',
    MINIMAX_API_KEY: 'minimax-key',
    MINIMAX_BASE_URL: 'https://api.example.test',
    MINIMAX_TTS_MODEL: 'speech-model',
  });

  assert.equal(config.llm.available, true);
  assert.equal(config.asr.available, false);
  assert.equal(config.tts.available, false);
});

test('config rejects an incomplete selected production LLM after earlier gates pass', () => {
  assert.throws(
    () => loadConfig(productionEnvironment({ HKBU_API_KEY: undefined })),
    /configured real LLM provider/,
  );
});

test('config rejects legacy-only trusted proxy hops in production', () => {
  assert.throws(
    () => loadConfig(productionEnvironment({ V1_TRUST_PROXY_HOPS: undefined, TRUST_PROXY_HOPS: '1' })),
    /V1_TRUST_PROXY_HOPS/,
  );
});

test('config marks a fully configured production environment ready', () => {
  const config = loadConfig(productionEnvironment());

  assert.equal(config.productionReady, true);
  assert.equal(config.publicStatus.productionReady, true);
});

test('config public status contains capability booleans rather than secret values', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    V1_LLM_PROVIDER: 'hkbu',
    HKBU_API_KEY: 'very-secret-value',
    HKBU_BASE_URL: 'https://hkbu.example.test',
    HKBU_MODEL: 'hkbu-model',
    HKBU_API_VERSION: 'v1',
  });

  assert.deepEqual(config.publicStatus, {
    productionReady: false,
    llmAvailable: true,
    asrConfigured: false,
    ttsConfigured: false,
    voiceInputPreview: false,
    voiceOutputPreview: false,
    voiceInput: false,
    voiceOutput: false,
    asrEvidenceVersion: null,
    ttsEvidenceVersion: null,
    iosVoiceAcceptanceVersion: null,
    privacyNoticeVersion: null,
    releaseCommitSha: null,
    normalizerContractVersion: 'canonical-wav-v1',
  });
  assert.equal(JSON.stringify(config.publicStatus).includes('very-secret-value'), false);
});

test('config logger retains operational fields and drops user content and secrets', () => {
  const entries = [];
  const logger = createLogger((entry) => entries.push(entry));

  logger.info({
    requestId: 'req-1',
    conversationHash: 'hashed-conversation',
    stage: 'generating',
    provider: 'hkbu',
    statusClass: 200,
    latencyMs: 18,
    tokenCount: 42,
    message: 'private message',
    transcript: 'private transcript',
    prompt: 'private prompt',
    cookie: 'private cookie',
    authorization: 'Bearer private',
    providerBody: 'private body',
    apiKey: 'private key',
  });

  assert.deepEqual(entries, [{
    requestId: 'req-1',
    conversationHash: 'hashed-conversation',
    stage: 'generating',
    provider: 'hkbu',
    statusClass: 200,
    latencyMs: 18,
    tokenCount: 42,
  }]);
});

test('shell presents one AI assistant conversation without legacy modes', async () => {
  const html = await readFile(new URL('../public/index.html', import.meta.url), 'utf8');

  assert.match(html, /Campus AI Senior/);
  assert.match(html, /AI assistant/);
  assert.doesNotMatch(html, /MODE|SCENARIO|START MISSION/i);
});

test('shell app serves a safe liveness envelope with a request ID', async (t) => {
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test' }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/health/live`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.deepEqual(body.error, null);
  assert.equal(body.data.status, 'ok');
  assert.equal(typeof body.data.version, 'string');
  assert.equal(body.requestId, response.headers.get('x-request-id'));
});

test('shell app rejects cross-origin state-changing requests with a safe error', async (t) => {
  const app = createApp({ config: loadConfig({ NODE_ENV: 'test', V1_PUBLIC_ORIGIN: 'https://v1.example.test' }) });
  const server = app.listen(0, '127.0.0.1');
  t.after(() => server.close());
  await new Promise((resolve) => server.once('listening', resolve));

  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/session`, {
    method: 'POST',
    headers: { Origin: 'https://other.example.test' },
  });
  const body = await response.json();

  assert.equal(response.status, 403);
  assert.deepEqual(body.data, null);
  assert.equal(body.error.code, 'ORIGIN_NOT_ALLOWED');
  assert.equal(typeof body.requestId, 'string');
});
