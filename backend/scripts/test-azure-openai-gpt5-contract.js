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
const azurePort = await getFreePort();
const minimaxPort = await getFreePort();
const baseUrl = `http://127.0.0.1:${appPort}`;
const azureBaseUrl = `http://127.0.0.1:${azurePort}`;
const minimaxBaseUrl = `http://127.0.0.1:${minimaxPort}`;

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

let azureRequestBody = null;
let azureCallCount = 0;
const azureRequestBodies = [];
let correctCoachAttempts = 0;
const fakeAzureOpenAI = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/openai/deployments/hkbuddy-gpt-5-mini/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }

  azureCallCount += 1;
  azureRequestBody = JSON.parse(await readRequestBody(req));
  azureRequestBodies.push(azureRequestBody);

  const userMessage = [...(azureRequestBody.messages || [])]
    .reverse()
    .find((message) => message.role === 'user')?.content || '';
  const systemMessage = (azureRequestBody.messages || [])
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  if (/觸發 Azure 失敗/.test(userMessage)) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'simulated Azure OpenAI outage',
        code: 'service_unavailable'
      }
    }));
    return;
  }

  if (/Translate a Cantonese learning conversation/i.test(systemMessage)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              summary: 'The learner orders an iced milk tea and the tutor suggests asking for less ice.',
              turns: [
                { role: 'learner', englishText: 'I would like an iced milk tea, please.' },
                { role: 'tutor', englishText: 'That sounds natural. You can also say: less ice, please.' }
              ],
              confidence: 0,
              needsConfirmation: false
            })
          }
        }
      ]
    }));
    return;
  }

  if (/friendly Cantonese learning coach/i.test(systemMessage)) {
    if (/Scenario:\s*Correct Me feedback/i.test(systemMessage)) {
      correctCoachAttempts += 1;
      if (correctCoachAttempts === 1) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          choices: [
            {
              finish_reason: 'length',
              message: { content: '' }
            }
          ],
          usage: {
            completion_tokens: 1600,
            completion_tokens_details: { reasoning_tokens: 1500 }
          }
        }));
        return;
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: [
              'Your line: 我想學喺茶餐廳點樣叫凍奶茶。',
              'Coach note: LLM Coach marker - this feedback came from Azure OpenAI, not a local template.',
              'Why it helps: The advice is tailored to the learner sentence.',
              'Next try: Say one short cafe sentence again.'
            ].join('\n')
          }
        }
      ]
    }));
    return;
  }

  if (/質量門過嚴/.test(userMessage)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: '「嗰個阿媽想同我講咩呀？」用「嗰個」代替「該」，再用「講」代替「聽」，講法會自然啲。'
          }
        }
      ]
    }));
    return;
  }

  if (/該阿媽真是你想同我聽乜嘢/.test(userMessage)) {
    if (/final quality repair/i.test(systemMessage)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [
          {
            message: {
              content: '呢句有啲唔清楚，可以咁講：「你可唔可以講清楚啲？」因為咁樣直接問對方解釋，日常對話會自然好多。你而家試下講一次。'
            }
          }
        ]
      }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      choices: [
        {
          message: {
            content: 'This draft is intentionally unusable so the server must ask Azure OpenAI for a final quality repair.'
          }
        }
      ]
    }));
    return;
  }

  if (
    Object.prototype.hasOwnProperty.call(azureRequestBody, 'max_tokens') ||
    Number(azureRequestBody.max_completion_tokens || 0) < 1600 ||
    (
      Object.prototype.hasOwnProperty.call(azureRequestBody, 'temperature') &&
      azureRequestBody.temperature !== 1
    )
  ) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'Unsupported parameter for GPT-5 style deployment',
        code: 'unsupported_parameter'
      }
    }));
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    choices: [
      {
        message: {
          content: '可以講：「唔該，我想要一杯凍奶茶。」呢句喺茶餐廳好自然，你可以跟住試講一次。'
        }
      }
    ]
  }));
});

await new Promise((resolve) => fakeAzureOpenAI.listen(Number(azurePort), '127.0.0.1', resolve));

let minimaxCallCount = 0;
const fakeMiniMax = http.createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.includes('/v1/messages')) {
    res.writeHead(404);
    res.end();
    return;
  }

  minimaxCallCount += 1;
  await readRequestBody(req);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    content: [
      {
        type: 'text',
        text: '呢個係 MiniMax LLM fallback，Azure OpenAI 模式唔應該用到。'
      }
    ]
  }));
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
    APP_VERSION: 'test-azure-openai-gpt5',
    LLM_PROVIDER: 'azure-openai',
    LLM_PROVIDER_TIMEOUT_MS: '2000',
    AZURE_OPENAI_KEY: 'test-azure-openai-key',
    AZURE_OPENAI_ENDPOINT: azureBaseUrl,
    AZURE_OPENAI_DEPLOYMENT: 'hkbuddy-gpt-5-mini',
    AZURE_OPENAI_API_VERSION: '2024-08-01-preview',
    MINIMAX_API_KEY: 'test-minimax-key',
    MINIMAX_ANTHROPIC_BASE_URL: minimaxBaseUrl,
    HKBU_API_KEY: '',
    TTS_PROVIDER: 'mock',
    ASR_PROVIDER: 'mock'
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
  assert.equal(health.llmProvider, 'azure-openai');
  assert.equal(health.capabilities.azureOpenAI, true);
  assert.equal(health.ttsProvider, 'mock');

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

  const response = await fetch(`${baseUrl}/api/recognize-and-respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      userText: '我想學喺茶餐廳點樣叫凍奶茶。',
      scenario: '茶餐廳點餐',
      mode: 'teaching',
      userMode: 'cantonese_learning',
      uiLanguage: 'zh-TW',
      responseLanguage: 'auto'
    })
  });

  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.equal(azureCallCount >= 2, true, 'expected Azure OpenAI calls for tutor generation and LLM feedback');
  assert.equal(payload.aiProvider, 'azure-openai');
  assert.equal(payload.aiFallback, false);
  assert.equal(payload.needsConfirmation, false);
  assert.match(payload.aiText, /凍奶茶/);
  assert.match(
    payload.feedback || '',
    /LLM Coach marker/,
    'teaching feedback should be generated by the configured LLM'
  );
  assert.equal(payload.feedbackProvider, 'azure-openai');
  assert.equal(payload.feedbackFallback, false);
  assert.doesNotMatch(
    payload.feedback || '',
    /Your meaning is understandable|Your meaning is clear/,
    'teaching feedback should not come from the local template when Azure OpenAI is configured'
  );
  const tutorRequestBody = azureRequestBodies.find((body) => /嚴謹但友善/.test(body.messages?.[0]?.content || ''));
  assert.ok(tutorRequestBody, 'expected a tutor-generation Azure request');
  assert.equal(
    Object.prototype.hasOwnProperty.call(tutorRequestBody, 'max_tokens'),
    false,
    'Azure GPT-5 request must not use max_tokens'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(tutorRequestBody, 'max_completion_tokens'),
    true,
    'Azure GPT-5 request should use max_completion_tokens'
  );
  assert.equal(
    tutorRequestBody.max_completion_tokens >= 1600,
    true,
    'Azure GPT-5 request should leave enough completion budget for reasoning tokens'
  );
  assert.equal(
    Object.prototype.hasOwnProperty.call(tutorRequestBody, 'temperature'),
    false,
    'Azure GPT-5 request should omit non-default temperature'
  );
  assert.doesNotMatch(
    tutorRequestBody.messages?.[0]?.content || '',
    /如果提供粵拼/,
    'Tutor prompt should not invite Jyutping because the tutor quality gate rejects romanized text'
  );
  assert.match(
    tutorRequestBody.messages?.[0]?.content || '',
    /唔好輸出粵拼|唔好.*羅馬字母/,
    'Tutor prompt should explicitly forbid romanized tutor replies'
  );

  const correctResponse = await fetch(`${baseUrl}/api/correct`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      utterance: '我想學喺茶餐廳點樣叫凍奶茶。'
    })
  });

  assert.equal(correctResponse.status, 200);
  const correctPayload = await correctResponse.json();
  assert.match(
    correctPayload.correction || '',
    /LLM Coach marker/,
    'Correct Me feedback should be generated by the configured LLM'
  );
  assert.equal(correctPayload.correctionProvider, 'azure-openai');
  assert.equal(correctPayload.correctionFallback, false);
  const correctCoachBodies = azureRequestBodies.filter((body) => /Scenario:\s*Correct Me feedback/i.test(body.messages?.[0]?.content || ''));
  assert.equal(
    correctCoachBodies.length >= 2,
    true,
    'Correct Me feedback should retry an empty Azure OpenAI coach response before using any local fallback'
  );
  assert.equal(
    correctCoachBodies.at(-1).max_completion_tokens >= 2400,
    true,
    'Correct Me feedback retry should leave enough completion budget for GPT-5 reasoning tokens'
  );
  assert.doesNotMatch(
    correctPayload.correction || '',
    /Your meaning is understandable|Your meaning is clear/,
    'Correct Me should not use the local correction template when Azure OpenAI is configured'
  );

  const trickyResponse = await fetch(`${baseUrl}/api/recognize-and-respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      userText: '喂冇，該阿媽真是你想同我聽乜嘢呀？',
      scenario: '自由對話 (Free Conversation)',
      mode: 'teaching',
      userMode: 'cantonese_learning',
      uiLanguage: 'zh-TW',
      responseLanguage: 'auto'
    })
  });

  assert.equal(trickyResponse.status, 200);
  const trickyPayload = await trickyResponse.json();
  assert.equal(trickyPayload.aiProvider, 'azure-openai');
  assert.equal(trickyPayload.aiFallback, false);
  assert.match(trickyPayload.aiText, /你可唔可以講清楚啲/);
  assert.doesNotMatch(
    trickyPayload.aiText,
    /我明你想練呢句/,
    'tricky learner utterances should use LLM final repair instead of the local generic template'
  );

  const strictGateResponse = await fetch(`${baseUrl}/api/recognize-and-respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      userText: '質量門過嚴：該阿媽想同我聽乜嘢呀？',
      scenario: '自由對話 (Free Conversation)',
      mode: 'teaching',
      userMode: 'cantonese_learning',
      uiLanguage: 'zh-TW',
      responseLanguage: 'auto'
    })
  });

  assert.equal(strictGateResponse.status, 200);
  const strictGatePayload = await strictGateResponse.json();
  assert.equal(strictGatePayload.aiProvider, 'azure-openai');
  assert.equal(strictGatePayload.aiFallback, false);
  assert.match(strictGatePayload.aiText, /嗰個阿媽想同我講咩呀/);
  assert.doesNotMatch(
    strictGatePayload.aiText,
    /我明你想練呢句/,
    'usable Azure OpenAI Cantonese corrections should not be rejected by an over-strict local quality gate'
  );

  const failedAzureResponse = await fetch(`${baseUrl}/api/recognize-and-respond`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: session.sessionId,
      userText: '請你故意觸發 Azure 失敗，測試 LLM fallback 邊界。',
      scenario: '茶餐廳點餐',
      mode: 'teaching',
      userMode: 'cantonese_learning',
      uiLanguage: 'zh-TW',
      responseLanguage: 'auto'
    })
  });

  assert.equal(failedAzureResponse.status, 200);
  const failedPayload = await failedAzureResponse.json();
  assert.equal(
    minimaxCallCount,
    0,
    'Azure OpenAI LLM mode must not fall back to MiniMax LLM; MiniMax is TTS-only in pilot config'
  );
  assert.notEqual(failedPayload.aiProvider, 'minimax');
  assert.equal(failedPayload.aiFallback, true);

  const conversationResponse = await fetch(`${baseUrl}/api/conversation-translation`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      turns: [
        { role: 'learner', text: '我想要一杯凍奶茶，唔該。' },
        { role: 'tutor', text: '好自然呀，你可以再講：「少冰，唔該。」' }
      ]
    })
  });

  assert.equal(conversationResponse.status, 200);
  const conversationPayload = await conversationResponse.json();
  assert.equal(conversationPayload.provider, 'azure-openai');
  assert.equal(conversationPayload.needsConfirmation, false);
  assert.equal(
    conversationPayload.confidence >= 0.7,
    true,
    'successful Azure conversation translations should not inherit a 0.0 example confidence'
  );
  assert.match(conversationPayload.summary, /iced milk tea/i);
} finally {
  await stopChild(child);
  await new Promise((resolve) => fakeAzureOpenAI.close(resolve));
  await new Promise((resolve) => fakeMiniMax.close(resolve));
}

assert.doesNotMatch(stderr, /TypeError|ReferenceError|SyntaxError|Unhandled|uncaught/i);
console.log('Azure OpenAI GPT-5 contract passed');
