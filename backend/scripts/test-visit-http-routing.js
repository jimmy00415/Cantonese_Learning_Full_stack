import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';

const port = String(52000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${port}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
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

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: port,
    APP_VERSION: 'test-health-contract',
    LLM_PROVIDER: 'minimax',
    TTS_PROVIDER: 'minimax',
    ASR_PROVIDER: 'azure',
    AZURE_SPEECH_KEY: 'test-azure-speech-key',
    AZURE_SPEECH_REGION: 'eastasia',
    MINIMAX_API_KEY: 'Minimax-test-minimax-key',
    MINIMAX_ASR_ENABLED: 'false'
  },
  stdio: ['ignore', 'pipe', 'pipe']
});

let stderr = '';
child.stderr.on('data', (chunk) => {
  stderr += chunk.toString();
});

try {
  const health = await waitForHealth();
  assert.equal(health.status, 'ok');
  assert.equal(health.appVersion, 'test-health-contract');
  assert.equal(health.readyForPilot, true);
  assert.equal(health.asrProvider, 'azure');
  assert.equal(health.asrInputReady, true);
  assert.equal(health.asrStatus, 'ready');
  assert.equal(health.capabilities.minimax, true);
  assert.equal(health.capabilities.minimaxAsr, false);
  assert.equal(health.capabilities.azureSpeech, true);

  const response = await fetch(`${baseUrl}/api/visit-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText: 'Could you speak some English for me ?',
      direction: 'yue_to_en',
      inputType: 'text',
      userMode: 'visit_translation'
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.direction, 'en_to_yue');
  assert.equal(payload.requestedDirection, 'yue_to_en');
  assert.equal(payload.autoRouted, true);
  assert.equal(payload.translatedText, '可唔可以同我講少少英文呀？');
  assert.equal(payload.provider, 'rule_based');
  assert.equal(payload.needsConfirmation, false);
  assert.equal(payload.ttsTextUsed, '可唔可以同我講少少英文呀？');

  const cantoneseResponse = await fetch(`${baseUrl}/api/visit-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText: '咁我可以同我講講廣東話啦。咁啊佢同我講講廣東話啦，同我聽嘛啲啦好唔好？破天下夜啦，好唔好？',
      direction: 'yue_to_en',
      inputType: 'text',
      userMode: 'visit_translation'
    })
  });

  assert.equal(cantoneseResponse.status, 200);
  const cantonesePayload = await cantoneseResponse.json();
  assert.equal(cantonesePayload.direction, 'yue_to_en');
  assert.equal(cantonesePayload.autoRouted, false);
  assert.equal(cantonesePayload.translatedText, 'Could you speak Cantonese with me and listen to me for a bit?');
  assert.equal(cantonesePayload.provider, 'rule_based');
  assert.equal(cantonesePayload.needsConfirmation, false);
  assert.equal(cantonesePayload.ttsProvider, 'none');
} finally {
  child.kill('SIGTERM');
}

console.log('visit HTTP routing regression passed');
