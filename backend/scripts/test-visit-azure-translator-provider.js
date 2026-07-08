import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

const appPort = String(53000 + Math.floor(Math.random() * 1000));
const translatorPort = String(54000 + Math.floor(Math.random() * 1000));
const baseUrl = `http://127.0.0.1:${appPort}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 24; attempt += 1) {
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

async function readRequestBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

let capturedTranslatorRequest = null;
const translator = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.startsWith('/translate')) {
    res.writeHead(404);
    res.end();
    return;
  }

  const bodyText = await readRequestBody(req);
  capturedTranslatorRequest = {
    url: req.url,
    headers: req.headers,
    body: JSON.parse(bodyText)
  };

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify([
    {
      translations: [
        {
          text: '你想唔想坐近窗邊？',
          to: 'yue'
        }
      ]
    }
  ]));
});

await new Promise((resolve) => translator.listen(Number(translatorPort), '127.0.0.1', resolve));

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: appPort,
    APP_VERSION: 'test-azure-translator-provider',
    LLM_PROVIDER: 'hkbu',
    TTS_PROVIDER: 'mock',
    ASR_PROVIDER: 'mock',
    HKBU_API_KEY: '',
    MINIMAX_API_KEY: '',
    AZURE_OPENAI_KEY: '',
    AZURE_OPENAI_ENDPOINT: '',
    AZURE_TRANSLATOR_KEY: 'test-translator-key',
    AZURE_TRANSLATOR_ENDPOINT: `http://127.0.0.1:${translatorPort}`,
    AZURE_TRANSLATOR_REGION: 'eastasia'
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
  assert.equal(health.capabilities.azureTranslator, true);

  const response = await fetch(`${baseUrl}/api/visit-translate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sourceText: 'Would you like to sit near the window?',
      direction: 'en_to_yue',
      inputType: 'text',
      userMode: 'visit_translation'
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(payload.provider, 'azure-translator');
  assert.equal(payload.translatedText, '你想唔想坐近窗邊？');
  assert.equal(payload.displayText, '你想唔想坐近窗邊？');
  assert.equal(payload.speakableText, '你想唔想坐近窗邊？');
  assert.equal(payload.needsConfirmation, false);
  assert.equal(payload.confidence, 0.86);

  assert.ok(capturedTranslatorRequest, 'expected Azure Translator to receive a request');
  assert.match(capturedTranslatorRequest.url, /api-version=3\.0/);
  assert.match(capturedTranslatorRequest.url, /from=en/);
  assert.match(capturedTranslatorRequest.url, /to=yue/);
  assert.equal(capturedTranslatorRequest.headers['ocp-apim-subscription-key'], 'test-translator-key');
  assert.equal(capturedTranslatorRequest.headers['ocp-apim-subscription-region'], 'eastasia');
  assert.deepEqual(capturedTranslatorRequest.body, [{ Text: 'Would you like to sit near the window?' }]);
} finally {
  child.kill('SIGTERM');
  await new Promise((resolve) => translator.close(resolve));
}

assert.equal(stderr, '');
console.log('visit Azure Translator provider regression passed');
