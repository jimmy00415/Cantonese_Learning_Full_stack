import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const appVersion = process.env.APP_VERSION || '0.1.0-prototype';
const ttsProvider = (process.env.TTS_PROVIDER || 'mock').toLowerCase();
const azureTtsKey = process.env.AZURE_SPEECH_KEY;
const azureTtsRegion = process.env.AZURE_SPEECH_REGION;
const azureVoice = process.env.AZURE_TTS_VOICE || 'zh-HK-HiuMaanNeural';
const azureRate = process.env.AZURE_TTS_RATE || '0%';
const azurePitch = process.env.AZURE_TTS_PITCH || '0%';

app.disable('x-powered-by');
app.use(morgan(process.env.LOG_FORMAT || 'dev'));

app.use(cors({ origin: clientOrigin, credentials: true }));
app.use(express.json({ limit: '2mb' }));

// In-memory conversation store; in production use a DB or cache.
const conversations = new Map();

const scenarios = [
  '自由對話 (Free Conversation)',
  '餐廳點餐 (At the Restaurant)',
  '認識新朋友 (Meeting New People)',
  '去香港旅行 (Traveling in Hong Kong)',
  '購物閒聊 (Shopping Small Talk)',
  '工作寒暄 (Workplace Small Talk)'
];

// Very small Cantonese prompt seeds for mock responses.
const promptSeeds = [
  '你講得好流利，繼續分享多啲！',
  '可以再講詳細啲嗎？',
  '明白，你仲有咩想法？',
  '不如講下你嘅日常？',
  '好啊，我哋可以轉去另一個話題。'
];

const politeOpeners = [
  '多謝分享！',
  '明白喇！',
  '好嘢！',
  '正啊！'
];

// Cache synthesized TTS by text to avoid repeat calls; keep it small.
const ttsCache = new Map();
const MAX_TTS_CACHE = 50;

function mockAiReply(userText, scenario) {
  const opener = politeOpeners[Math.floor(Math.random() * politeOpeners.length)];
  const seed = promptSeeds[Math.floor(Math.random() * promptSeeds.length)];
  const scenarioHint = scenario ? `（情景：${scenario}）` : '';
  const echo = userText ? `你啱啱講：「${userText}」` : '你可以先講講你想練習嘅內容。';
  return `${opener} ${echo} ${scenarioHint} ${seed}`.trim();
}

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: appVersion,
    ttsProvider: ttsProvider === 'azure' ? 'azure' : 'mock'
  });
});

app.get('/api/scenarios', (_req, res) => {
  res.json({ scenarios });
});

app.post('/api/session', (_req, res) => {
  const sessionId = uuidv4();
  conversations.set(sessionId, []);
  res.json({ sessionId });
});

app.post('/api/recognize-and-respond', (req, res) => {
  const { sessionId, userText = '', scenario = '' } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Basic payload hygiene
  const trimmedUserText = typeof userText === 'string' ? userText.slice(0, 400).trim() : '';
  const scenarioText = typeof scenario === 'string' ? scenario.slice(0, 120) : '';

  if (!conversations.has(sessionId)) {
    conversations.set(sessionId, []);
  }

  const history = conversations.get(sessionId);
  const aiText = mockAiReply(trimmedUserText, scenarioText);
  const feedback = trimmedUserText
    ? '（模擬）聲調不錯，試下放慢少少再講一次。'
    : '請試下講一句你想練習嘅句子。';

  history.push({ userText: trimmedUserText, aiText, scenario: scenarioText, timestamp: Date.now() });
  if (history.length > 10) history.shift();
  conversations.set(sessionId, history);

  res.json({ aiText, feedback, ttsAudio: null, history });
});

// Centralized error guard
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Server error, please try again.' });
});

async function synthesizeAzure(text) {
  if (!azureTtsKey || !azureTtsRegion) throw new Error('Azure TTS key/region missing');
  const ssml = `<?xml version="1.0" encoding="utf-8"?>
<speak version="1.0" xml:lang="zh-HK">
  <voice name="${azureVoice}">
    <prosody rate="${azureRate}" pitch="${azurePitch}">${text}</prosody>
  </voice>
</speak>`;
  const tokenEndpoint = `https://${azureTtsRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`;
  const ttsEndpoint = `https://${azureTtsRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6000);

  const tokenRes = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Ocp-Apim-Subscription-Key': azureTtsKey },
    signal: controller.signal
  });
  if (!tokenRes.ok) throw new Error(`Azure token error ${tokenRes.status}`);
  const token = await tokenRes.text();

  const ttsRes = await fetch(ttsEndpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/ssml+xml',
      'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
      Authorization: `Bearer ${token}`
    },
    body: ssml,
    signal: controller.signal
  });
  clearTimeout(timeout);
  if (!ttsRes.ok) throw new Error(`Azure TTS error ${ttsRes.status}`);
  const buffer = Buffer.from(await ttsRes.arrayBuffer());
  return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
}

export async function handler(req, res) {
  // not used in this runtime
}

// Patch recognize-and-respond to include TTS
const originalHandler = app._router.stack.find((layer) => layer.route && layer.route.path === '/api/recognize-and-respond').route.stack[0].handle;
app._router.stack.find((layer) => layer.route && layer.route.path === '/api/recognize-and-respond').route.stack[0].handle = async (req, res, next) => {
  try {
    const started = Date.now();
    const { sessionId, userText = '', scenario = '' } = req.body || {};
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });

    const trimmedUserText = typeof userText === 'string' ? userText.slice(0, 400).trim() : '';
    const scenarioText = typeof scenario === 'string' ? scenario.slice(0, 120) : '';

    if (!conversations.has(sessionId)) conversations.set(sessionId, []);
    const history = conversations.get(sessionId);
    const aiText = mockAiReply(trimmedUserText, scenarioText);
    const feedback = trimmedUserText
      ? '（模擬）聲調不錯，試下放慢少少再講一次。'
      : '請試下講一句你想練習嘅句子。';

    history.push({ userText: trimmedUserText, aiText, scenario: scenarioText, timestamp: Date.now() });
    if (history.length > 10) history.shift();
    conversations.set(sessionId, history);

    let ttsAudio = null;
    let ttsProviderUsed = 'mock';
    let ttsError = null;

    const cacheKey = aiText;
    if (ttsCache.has(cacheKey)) {
      ttsAudio = ttsCache.get(cacheKey);
    }

    if (ttsProvider === 'azure') {
      try {
        ttsAudio = ttsAudio || (await synthesizeAzure(aiText));
        ttsProviderUsed = 'azure';
        // Maintain small cache
        if (!ttsCache.has(cacheKey)) {
          ttsCache.set(cacheKey, ttsAudio);
          if (ttsCache.size > MAX_TTS_CACHE) {
            const firstKey = ttsCache.keys().next().value;
            ttsCache.delete(firstKey);
          }
        }
      } catch (err) {
        ttsError = err.message || 'Azure TTS failed';
        console.warn('Azure TTS failed, falling back to mock:', err.message);
      }
    }
    if (!ttsAudio) {
      ttsAudio = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
    }

    const latencyMs = Date.now() - started;

    res.json({
      aiText,
      feedback,
      ttsAudio,
      history,
      latencyMs,
      ttsProvider: ttsProviderUsed,
      ttsError,
      ttsFallback: ttsProviderUsed === 'mock' && ttsProvider === 'azure'
    });
  } catch (err) {
    next(err);
  }
};

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
  console.log(`Allowing origin: ${clientOrigin}`);
});
