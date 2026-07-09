import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(String(address.port)));
    });
  });
}

const appPort = await getFreePort();
const minimaxPort = await getFreePort();
const baseUrl = `http://127.0.0.1:${appPort}`;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth() {
  for (let attempt = 0; attempt < 80; attempt += 1) {
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

let llmCallCount = 0;
const fakeMiniMax = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/v1/messages') {
    res.writeHead(404);
    res.end();
    return;
  }

  llmCallCount += 1;
  const body = JSON.parse(await readRequestBody(req));
  const system = String(body.system || '');
  const userContent = body.messages?.map((message) => message.content).join('\n') || '';
  if (/餐廳|買嘢|買野/.test(userContent)) {
    await wait(650);
  }

  const text = system.includes('語言守門員')
    ? '正啊！ 你啱啱講：「我想同你聽下呢，香港嘅羅馬洲有咩嘢好玩？」  不如講下你嘅日常？'
    : system.includes('嚴謹但友善')
      ? 'Great, the student is asking about places to visit in Hong Kong.'
      : `Template repair for: ${userContent}`;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ content: [{ type: 'text', text }] }));
});

await new Promise((resolve) => fakeMiniMax.listen(Number(minimaxPort), '127.0.0.1', resolve));

function stopChild(childProcess) {
  return new Promise((resolve) => {
    if (childProcess.exitCode !== null || childProcess.signalCode) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      childProcess.kill('SIGTERM');
      resolve();
    }, 2000);
    childProcess.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    childProcess.kill('SIGTERM');
  });
}

const child = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url),
  env: {
    ...process.env,
    PORT: appPort,
    APP_VERSION: 'test-tutor-reply-quality',
    LLM_PROVIDER: 'minimax',
    LLM_PROVIDER_TIMEOUT_MS: '40',
    MINIMAX_API_KEY: 'Minimax-test-minimax-key',
    MINIMAX_ANTHROPIC_BASE_URL: `http://127.0.0.1:${minimaxPort}`,
    TTS_PROVIDER: 'mock',
    ASR_PROVIDER: 'mock',
    AZURE_SPEECH_KEY: '',
    AZURE_SPEECH_REGION: '',
    HKBU_API_KEY: '',
    AZURE_OPENAI_KEY: '',
    AZURE_OPENAI_ENDPOINT: ''
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
  assert.equal(health.capabilities.minimax, true);

  const sessionResponse = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      mode: 'teaching',
      userMode: 'cantonese_learning',
      uiLanguage: 'zh-TW',
      responseLanguage: 'auto'
    })
  });
  assert.equal(sessionResponse.status, 200);
  const session = await sessionResponse.json();

  async function sendTeachingLine(userText) {
    return fetch(`${baseUrl}/api/recognize-and-respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        userText,
        scenario: '自由對話 (Free Conversation)',
        mode: 'teaching',
        userMode: 'cantonese_learning',
        uiLanguage: 'zh-TW',
        responseLanguage: 'auto'
      })
    });
  }

  const response = await sendTeachingLine('我想同你聽下呢，香港嘅羅馬洲有咩嘢好玩？');

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(llmCallCount >= 2, true, 'expected server to attempt LLM generation and rewrite');
  assert.equal(payload.aiFallback, true, 'low-quality LLM output should be marked as fallback');
  assert.equal(payload.uncertaintyReason, 'local_quality_fallback');
  assert.equal(payload.needsConfirmation, false, 'safe local tutor coaching fallback should not trigger the mock/lower-confidence warning');
  assert.equal(payload.confidence >= 0.7, true, 'safe local tutor coaching fallback should clear the low-confidence warning threshold');
  assert.doesNotMatch(payload.aiText, /正啊！\s*你啱啱講.*不如講下你嘅日常/, 'template tutor reply should not be accepted');
  assert.match(payload.aiText, /可以試下講|可以咁講|應該講/, 'fallback should still give a useful Cantonese learning action');

  const restaurantResponse = await sendTeachingLine('哦，那都幾好呀。你可唔可以同我講緊講？該點在餐廳度等買嘢？');

  assert.equal(restaurantResponse.status, 200);
  const restaurantPayload = await restaurantResponse.json();
  assert.equal(restaurantPayload.aiFallback, true, 'low-quality topic-learning output should still be locally recoverable');
  assert.equal(restaurantPayload.needsConfirmation, false, 'safe topic-learning fallback should not show a warning');
  assert.doesNotMatch(
    restaurantPayload.aiText,
    /我明你想練呢句|講得短啲|先講重點/,
    'topic-learning request must not be handled as generic sentence correction'
  );
  assert.match(
    restaurantPayload.aiText,
    /點餐|落單|侍應|唔該|我想要/,
    'restaurant learning request should teach restaurant ordering language'
  );
  assert.match(
    restaurantPayload.aiText,
    /試下|你可以|而家/,
    'restaurant learning reply should include a next practice step'
  );
} finally {
  await stopChild(child);
  await new Promise((resolve) => fakeMiniMax.close(resolve));
}

assert.doesNotMatch(stderr, /TypeError|ReferenceError|SyntaxError|Unhandled|uncaught/i);
console.log('tutor reply quality regression passed');
