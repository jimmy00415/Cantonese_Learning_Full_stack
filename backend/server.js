import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// P2: Cultural Context Service
import { getCulturalContext } from './services/culturalContext.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 4000;
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
// Allow Azure frontend domain, GitHub Pages, and localhost for testing
const allowedOrigins = [
  clientOrigin,
  'https://hongkongtutor.azurewebsites.net',
  'https://hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net',
  'https://jimmy00415.github.io',
  'http://localhost:5173',
  'http://localhost:60480',
  'http://localhost:3000'
];
// Check if origin matches any allowed pattern (including localhost with any port)
const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  // Allow any localhost port for development
  if (origin.match(/^http:\/\/localhost:\d+$/)) return true;
  return false;
};
const appVersion = process.env.APP_VERSION || '0.1.0-prototype';
const ttsProvider = (process.env.TTS_PROVIDER || 'mock').toLowerCase();
const azureTtsKey = process.env.AZURE_SPEECH_KEY;
const azureTtsRegion = process.env.AZURE_SPEECH_REGION;
const azureAsrLanguage = process.env.AZURE_ASR_LANGUAGE || 'zh-HK';
const azureVoice = process.env.AZURE_TTS_VOICE || 'zh-HK-HiuMaanNeural';
const azureRate = process.env.AZURE_TTS_RATE || '0%';
const azurePitch = process.env.AZURE_TTS_PITCH || '0%';
const hkbuApiKey = process.env.HKBU_API_KEY;
const hkbuBaseUrl = process.env.HKBU_BASE_URL || 'https://genai.hkbu.edu.hk/api/v0/rest';
const hkbuModel = process.env.HKBU_MODEL || 'gpt-5';
const hkbuApiVersion = process.env.HKBU_API_VERSION || '2024-12-01-preview';
const azureOpenAIKey = process.env.AZURE_OPENAI_KEY;
const azureOpenAIEndpoint = process.env.AZURE_OPENAI_ENDPOINT;
const azureOpenAIDeployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
const azureOpenAIApiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
const llmProvider = (process.env.LLM_PROVIDER || 'hkbu').toLowerCase();
const asrProvider = (process.env.ASR_PROVIDER || process.env.SPEECH_PROVIDER || ttsProvider).toLowerCase();
const asrFallbackProvider = (process.env.ASR_FALLBACK_PROVIDER || '').toLowerCase();
function normalizeMiniMaxApiKey(apiKey) {
  return apiKey ? apiKey.trim().replace(/^Minimax-/, '') : '';
}

const minimaxApiKey = normalizeMiniMaxApiKey(process.env.MINIMAX_API_KEY || process.env.ANTHROPIC_API_KEY);
const minimaxBaseUrl = (process.env.MINIMAX_BASE_URL || 'https://api.minimax.io').replace(/\/+$/, '');
const minimaxAnthropicBaseUrl = (process.env.MINIMAX_ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || `${minimaxBaseUrl}/anthropic`).replace(/\/+$/, '');
const minimaxLlmModel = process.env.MINIMAX_LLM_MODEL || 'MiniMax-M2.7';
const minimaxMaxTokens = Number(process.env.MINIMAX_MAX_TOKENS || 300);
const minimaxTemperature = Number(process.env.MINIMAX_TEMPERATURE || 0.8);
const minimaxTtsModel = process.env.MINIMAX_TTS_MODEL || 'speech-2.8-hd';
const minimaxTtsVoice = process.env.MINIMAX_TTS_VOICE || 'Cantonese_GentleLady';
const minimaxTtsLanguageBoost = process.env.MINIMAX_TTS_LANGUAGE_BOOST || 'Chinese,Yue';
const minimaxTtsSpeed = Number(process.env.MINIMAX_TTS_SPEED || 1);
const minimaxTtsVolume = Number(process.env.MINIMAX_TTS_VOLUME || 1);
const minimaxTtsPitch = Number(process.env.MINIMAX_TTS_PITCH || 0);
const minimaxAsrModel = process.env.MINIMAX_ASR_MODEL || 'speech-01';
const minimaxAsrLanguage = process.env.MINIMAX_ASR_LANGUAGE || 'zh-HK';
const minimaxAsrEndpoint = process.env.MINIMAX_ASR_ENDPOINT || `${minimaxBaseUrl}/v1/audio/transcriptions`;

const defaultMiniMaxCantoneseVoices = [
  {
    voiceId: 'Cantonese_GentleLady',
    label: '溫柔女聲',
    description: 'Gentle Cantonese female voice'
  },
  {
    voiceId: 'Cantonese_podacast_host_1',
    label: 'Podcast 主持',
    description: 'Cantonese podcast host voice'
  }
];

let minimaxVoiceCache = { expiresAt: 0, voices: defaultMiniMaxCantoneseVoices };

app.disable('x-powered-by');
app.use(morgan(process.env.LOG_FORMAT || 'dev'));

app.use(cors({
  origin: (origin, callback) => {
    if (isOriginAllowed(origin)) {
      callback(null, true);
    } else {
      console.log('CORS blocked origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '10mb' }));
app.use((req, res, next) => {
  req.startTime = Date.now();
  next();
});

// Serve frontend static files
app.use(express.static(join(__dirname, 'public')));

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

function normalizeMiniMaxVoiceId(voiceId) {
  const normalized = typeof voiceId === 'string' ? voiceId.trim() : '';
  if (!normalized || normalized.length > 120) return '';
  return /^[\w\s().,-]+$/.test(normalized) ? normalized : '';
}

function labelMiniMaxVoice(voiceId, fallbackLabel = '') {
  if (fallbackLabel) return fallbackLabel;
  const labels = {
    Cantonese_GentleLady: '溫柔女聲',
    Cantonese_podacast_host_1: 'Podcast 主持'
  };
  return labels[voiceId] || voiceId.replace(/^Cantonese_/, '').replace(/_/g, ' ');
}

function mergeVoices(primary, fallback) {
  const byId = new Map();
  [...fallback, ...primary].forEach((voice) => {
    const voiceId = normalizeMiniMaxVoiceId(voice.voiceId || voice.voice_id);
    if (!voiceId) return;
    byId.set(voiceId, {
      voiceId,
      label: voice.label || voice.voice_name || labelMiniMaxVoice(voiceId),
      description: Array.isArray(voice.description) ? voice.description.join(' ') : voice.description || ''
    });
  });
  return [...byId.values()];
}

function buildEnglishCoachCorrection(utterance, culturalContext = null) {
  const trimmedUtterance = String(utterance || '').trim();
  const colloquialSwaps = culturalContext?.colloquialSuggestions?.length
    ? culturalContext.colloquialSuggestions
        .slice(0, 3)
        .map(({ formal, colloquial }) => `"${formal}" -> "${colloquial}"`)
        .join(', ')
    : '';
  const coachNote = colloquialSwaps
    ? `Your meaning is clear, but some words sound formal or Mandarin-style. For spoken Cantonese, try these local swaps: ${colloquialSwaps}.`
    : 'Your meaning is understandable. Make it more useful by naming the situation first, then asking for one specific thing.';
  const nextTry = colloquialSwaps
    ? 'Rewrite the line with one spoken Cantonese swap, then say it slowly once.'
    : 'Try one short campus sentence, such as asking how to order, where to go, or what to say next.';

  return `Your line: ${trimmedUtterance}

Coach note: ${coachNote}

Why it helps: International students sound more natural in Hong Kong when the sentence is short, specific, and closer to everyday spoken Cantonese.

Next try: ${nextTry}`;
}

async function getMiniMaxCantoneseVoices({ refresh = false } = {}) {
  if (!refresh && minimaxVoiceCache.voices && Date.now() < minimaxVoiceCache.expiresAt) {
    return minimaxVoiceCache.voices;
  }

  if (!minimaxApiKey) return defaultMiniMaxCantoneseVoices;

  try {
    const response = await fetch(`${minimaxBaseUrl}/v1/get_voice`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${minimaxApiKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ voice_type: 'system' })
    });

    if (!response.ok) throw new Error(`MiniMax voice list failed: ${response.status}`);

    const data = await response.json();
    const statusCode = data.base_resp?.status_code;
    if (statusCode !== undefined && statusCode !== 0) {
      throw new Error(`MiniMax voice list failed ${statusCode}: ${data.base_resp?.status_msg || 'unknown error'}`);
    }

    const cantoneseVoices = (data.system_voice || [])
      .filter((voice) => {
        const description = Array.isArray(voice.description) ? voice.description.join(' ') : voice.description || '';
        return /cantonese/i.test(`${voice.voice_id || ''} ${voice.voice_name || ''} ${description}`)
          || defaultMiniMaxCantoneseVoices.some(defaultVoice => defaultVoice.voiceId === voice.voice_id);
      })
      .map((voice) => ({
        voiceId: voice.voice_id,
        label: labelMiniMaxVoice(voice.voice_id, voice.voice_name),
        description: Array.isArray(voice.description) ? voice.description.join(' ') : voice.description || ''
      }));

    minimaxVoiceCache = {
      expiresAt: Date.now() + 10 * 60 * 1000,
      voices: mergeVoices(cantoneseVoices, defaultMiniMaxCantoneseVoices)
    };
  } catch (err) {
    console.warn('MiniMax voice list unavailable, using built-in Cantonese voices:', err.message);
    minimaxVoiceCache = {
      expiresAt: Date.now() + 60 * 1000,
      voices: defaultMiniMaxCantoneseVoices
    };
  }

  return minimaxVoiceCache.voices;
}

async function resolveMiniMaxVoice(voiceId) {
  const requestedVoiceId = normalizeMiniMaxVoiceId(voiceId);
  const voices = await getMiniMaxCantoneseVoices();
  const defaultVoiceId = normalizeMiniMaxVoiceId(minimaxTtsVoice) || defaultMiniMaxCantoneseVoices[0].voiceId;
  return voices.some(voice => voice.voiceId === requestedVoiceId) ? requestedVoiceId : defaultVoiceId;
}

function normalizeUiLanguage(language) {
  return ['en', 'zh-TW', 'zh-CN'].includes(language) ? language : 'zh-TW';
}

function resolveLanguagePolicy({ userMode = 'international_student', uiLanguage = 'zh-TW', responseLanguage = 'auto' } = {}) {
  const normalizedUiLanguage = normalizeUiLanguage(uiLanguage);
  const requestedLanguage = normalizeUiLanguage(responseLanguage);
  const explicitLanguage = responseLanguage && responseLanguage !== 'auto';

  if (explicitLanguage) {
    return {
      responseLanguage: requestedLanguage,
      languagePolicyApplied: `explicit_${requestedLanguage}`,
      needsConfirmation: false
    };
  }

  if (userMode === 'international_student' || normalizedUiLanguage === 'en') {
    return {
      responseLanguage: 'en',
      languagePolicyApplied: 'international_english_first',
      needsConfirmation: false
    };
  }

  if (userMode === 'mainland_learner') {
    return {
      responseLanguage: normalizedUiLanguage === 'zh-TW' ? 'zh-TW' : 'zh-CN',
      languagePolicyApplied: 'mainland_chinese_explanation',
      needsConfirmation: false
    };
  }

  return {
    responseLanguage: normalizedUiLanguage,
    languagePolicyApplied: 'ui_language_default',
    needsConfirmation: false
  };
}

// P1: Mode-specific system prompts with P2 cultural context enhancement
function getSystemPrompt(mode, scenario, culturalContext = null, languagePolicy = resolveLanguagePolicy()) {
  let culturalNote = '';
  if (culturalContext && culturalContext.hasContent) {
    culturalNote = `\n\n## 文化背景（學生用咗以下元素）\n${culturalContext.summary}`;
  }
  const englishCulturalNote = culturalContext && culturalContext.hasContent
    ? `\n\n## Cultural context detected\n${culturalContext.summary}`
    : '';

  if (mode === 'coachNotes') {
    return `You are a friendly Cantonese learning coach for international students living or studying in Hong Kong.

## Instructions:
1. Reply only in clear, natural English.
2. Keep Cantonese examples short and useful; Cantonese words may stay in Traditional Chinese or Jyutping when needed.
3. Explain what the learner did well, what to improve, and how to try again in real student-life situations.
4. Be encouraging, practical, and easy to understand for non-local students.
5. Avoid long grammar lectures. Use concise coaching notes.

## Format:
Your line: [brief reference]
Coach note: [one practical English note]
Why it helps: [short reason]
Next try: [one short action]

## Scenario: ${scenario || 'Hong Kong student life'}${culturalNote}`;
  }

  if (languagePolicy.responseLanguage === 'en') {
    return `You are Hong Kong Buddy, an English-first Cantonese helper for international students in HKBU activities.

## Language contract:
1. Reply in clear English first.
2. Do not answer with Chinese-only text.
3. Cantonese may appear only as useful examples, Traditional Chinese phrase targets, Jyutping, or short labels.
4. If the learner asks what to do next, give step-by-step guidance.
5. Keep the response practical for Hong Kong student life or community visits.
6. If the input is unclear, ask one simple English clarification question.

## Response shape:
Start with one direct English answer.
Then, if useful, add:
- Cantonese: [short phrase]
- Jyutping: [romanisation if known]
- When to use it: [one short note]

## Scenario: ${scenario || 'Hong Kong student life'}${englishCulturalNote}`;
  }

  if (mode === 'teaching') {
    return `你係一個嚴謹但友善嘅廣東話老師。你嘅工作係幫學生改善廣東話。

## 指引：
1. **必須糾正錯誤**：每當學生有發音、文法、用詞錯誤，一定要指出並解釋
2. **提供正確示範**：講出正確嘅講法
3. **語氣專業但鼓勵**：像老師咁教導，但要有耐心
4. **使用繁體中文**書寫
5. **保持簡潔**：糾正後繼續對話，回應1-3句
6. **認識文化背景**：如果學生用咗俚語或潮語，解釋佢哋嘅適當用法

## 糾正格式：
「[學生講嘅話]」→ 應該講「[正確講法]」
[簡短解釋原因]
[繼續對話]

## 場景：${scenario || '日常對話'}${culturalNote}`;
  } else {
    // Free Talk mode (default)
    return `你係一個好傾得嘅香港朋友，鍾意同人聊天。

## 指引：
1. **唔好過份糾正**：除非聽唔明，否則唔使指出小錯誤
2. **講地道廣東話**：用俗語、潮語，講嘢自然啲
3. **保持輕鬆**：像朋友咁傾計，可以講笑
4. **推動對話**：問問題，分享睇法
5. **用繁體中文**書寫
6. **回應長度保持 1-3 句**

## 場景：${scenario || '自由傾計'}${culturalNote}`;
  }
}

async function callLLMProvider(provider, messages) {
  const hasAzureOpenAI = azureOpenAIKey && azureOpenAIEndpoint;
  const hasHKBU = hkbuApiKey;
  const hasMiniMax = !!minimaxApiKey;

  let url, headers, body;

  if (provider === 'minimax' && hasMiniMax) {
    url = `${minimaxAnthropicBaseUrl}/v1/messages`;
    const systemMessage = messages
      .filter(message => message.role === 'system')
      .map(message => message.content)
      .join('\n\n');
    const chatMessages = messages
      .filter(message => message.role !== 'system')
      .map(message => ({
        role: message.role === 'assistant' ? 'assistant' : 'user',
        content: String(message.content || '')
      }))
      .filter(message => message.content.trim());
    headers = {
      'X-Api-Key': minimaxApiKey,
      'Content-Type': 'application/json'
    };
    body = {
      model: minimaxLlmModel,
      system: systemMessage || undefined,
      messages: chatMessages,
      max_tokens: minimaxMaxTokens,
      temperature: minimaxTemperature,
      stream: false
    };
    console.log('📡 Calling MiniMax Anthropic API:', url);
  } else if (provider === 'azure-openai' && hasAzureOpenAI) {
    const baseEndpoint = azureOpenAIEndpoint.replace(/\/+$/, '');
    url = `${baseEndpoint}/openai/deployments/${azureOpenAIDeployment}/chat/completions?api-version=${azureOpenAIApiVersion}`;
    headers = {
      'api-key': azureOpenAIKey,
      'Content-Type': 'application/json'
    };
    body = {
      messages: messages,
      temperature: 0.7,
      max_completion_tokens: 150
    };
    console.log('📡 Calling Azure OpenAI:', url);
  } else if (provider === 'hkbu' && hasHKBU) {
    url = `${hkbuBaseUrl}/deployments/${hkbuModel}/chat/completions?api-version=${hkbuApiVersion}`;
    headers = {
      'accept': 'application/json',
      'Content-Type': 'application/json',
      'api-key': hkbuApiKey,
    };
    body = {
      messages: messages,
      temperature: 1.0,
      max_tokens: 150,
      stream: false
    };
    console.log('📡 Calling HKBU API:', url);
  } else {
    throw new Error(`Provider ${provider} not configured`);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: headers,
    body: JSON.stringify(body)
  });

  console.log(`📥 ${provider} API response status:`, response.status, response.statusText);

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`❌ ${provider} API error response:`, errorText);
    throw new Error(`${provider} API failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  console.log(`📦 ${provider} API response received`);

  const aiResponse = provider === 'minimax'
    ? (data.content || [])
      .filter(part => part.type === 'text' && part.text)
      .map(part => part.text)
      .join('')
    : data.choices?.[0]?.message?.content || '';
  if (!aiResponse) {
    throw new Error(`No content in ${provider} response`);
  }

  console.log(`✅ ${provider} Response generated:`, aiResponse.substring(0, 50));
  return aiResponse.trim();
}

async function generateAIResponse(userText, scenario, history, mode = 'freeChat', culturalContext = null, languagePolicy = resolveLanguagePolicy()) {
  console.log('🤖 generateAIResponse called with:', { userText: userText.substring(0, 20), scenario, mode, provider: llmProvider, responseLanguage: languagePolicy.responseLanguage, hasCulturalContext: !!culturalContext });

  // Check if any LLM provider is configured
  const hasAzureOpenAI = azureOpenAIKey && azureOpenAIEndpoint;
  const hasHKBU = hkbuApiKey;
  const hasMiniMax = !!minimaxApiKey;

  if (!hasAzureOpenAI && !hasHKBU && !hasMiniMax) {
    console.warn('⚠️ No LLM API key configured, using mock');
    return mockAiReply(userText, scenario, languagePolicy);
  }

  // P1: Use mode-specific system prompt with P2 cultural context
  const systemMessage = getSystemPrompt(mode, scenario, culturalContext, languagePolicy);

  const messages = [
    { role: 'system', content: systemMessage },
    ...history.slice(-6).map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.text
    })),
    { role: 'user', content: userText }
  ];

  // Build provider ordering: primary first, then fallback
  const providers = [];
  if (llmProvider === 'minimax' && hasMiniMax) {
    providers.push('minimax');
    if (hasAzureOpenAI) providers.push('azure-openai');
    if (hasHKBU) providers.push('hkbu');
  } else if (llmProvider === 'azure-openai' && hasAzureOpenAI) {
    providers.push('azure-openai');
    if (hasMiniMax) providers.push('minimax');
    if (hasHKBU) providers.push('hkbu');
  } else if (llmProvider === 'hkbu' && hasHKBU) {
    providers.push('hkbu');
    if (hasMiniMax) providers.push('minimax');
    if (hasAzureOpenAI) providers.push('azure-openai');
  } else if (hasMiniMax) {
    providers.push('minimax');
  } else if (hasAzureOpenAI) {
    providers.push('azure-openai');
  } else if (hasHKBU) {
    providers.push('hkbu');
  }

  // Try each provider in order, fall back on failure
  for (const provider of providers) {
    try {
      return await callLLMProvider(provider, messages);
    } catch (err) {
      console.error(`❌ ${provider} error:`, err.message);
      if (provider !== providers[providers.length - 1]) {
        console.log(`🔄 Falling back to next provider...`);
      }
    }
  }

  console.log('⚠️ All LLM providers failed, falling back to mock response');
  if (mode === 'coachNotes') return buildEnglishCoachCorrection(userText, culturalContext);
  return mockAiReply(userText, scenario, languagePolicy);
}

function mockAiReply(userText, scenario, languagePolicy = resolveLanguagePolicy()) {
  if (languagePolicy.responseLanguage === 'en') {
    const scenarioHint = scenario ? `Scenario: ${scenario}.` : 'Scenario: Hong Kong student life.';
    const echo = userText ? `You asked: "${userText}"` : 'Tell me what you want to practise first.';
    return `${echo}\n\n${scenarioHint}\n\nStart with one simple phrase and I will help you improve it. For an elderly visit, try: Cantonese: 「你好，好高興見到你。」 Jyutping: nei5 hou2, hou2 gou1 hing3 gin3 dou3 nei5. When to use it: a polite first greeting.`;
  }

  const opener = politeOpeners[Math.floor(Math.random() * politeOpeners.length)];
  const seed = promptSeeds[Math.floor(Math.random() * promptSeeds.length)];
  const scenarioHint = scenario ? `（情景：${scenario}）` : '';
  const echo = userText ? `你啱啱講：「${userText}」` : '你可以先講講你想練習嘅內容。';
  return `${opener} ${echo} ${scenarioHint} ${seed}`.trim();
}

function generateMockTtsDataUri() {
  // Minimal valid WAV file (silent audio)
  return 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';
}

app.get('/api/health', (_req, res) => {
  const activeAsrProvider = asrProvider === 'azure' && azureTtsKey
    ? 'azure'
    : asrProvider === 'minimax' && minimaxApiKey
      ? 'minimax'
      : 'mock';

  res.json({
    status: 'ok',
    timestamp: Date.now(),
    version: appVersion,
    llmProvider: minimaxApiKey && llmProvider === 'minimax' ? 'minimax' : llmProvider,
    asrProvider: activeAsrProvider,
    asrLanguage: activeAsrProvider === 'azure' ? azureAsrLanguage : minimaxAsrLanguage,
    ttsProvider: ttsProvider === 'minimax' && minimaxApiKey ? 'minimax' : ttsProvider === 'azure' && azureTtsKey ? 'azure' : 'mock',
    ttsVoice: ttsProvider === 'minimax' ? minimaxTtsVoice : azureVoice
  });
});

app.get('/api/scenarios', (_req, res) => {
  res.json({ scenarios });
});

app.get('/api/tts-voices', async (_req, res) => {
  if (ttsProvider !== 'minimax') {
    return res.json({
      provider: ttsProvider,
      currentVoice: azureVoice,
      voices: [{ voiceId: azureVoice, label: 'Azure Cantonese Voice', description: 'Configured Azure voice' }]
    });
  }

  const voices = await getMiniMaxCantoneseVoices();
  res.json({
    provider: 'minimax',
    currentVoice: await resolveMiniMaxVoice(minimaxTtsVoice),
    voices
  });
});

// P1: Session now includes mode
app.post('/api/session', (req, res) => {
  const { mode = 'freeChat', userMode = 'international_student', uiLanguage = 'zh-TW', responseLanguage = 'auto', ttsVoice } = req.body || {};
  const languagePolicy = resolveLanguagePolicy({ userMode, uiLanguage, responseLanguage });
  const sessionId = uuidv4();
  conversations.set(sessionId, {
    history: [],
    mode,
    userMode,
    settings: { language: normalizeUiLanguage(uiLanguage), responseLanguage: languagePolicy.responseLanguage, ttsSpeed: 1.0, ttsVoice: normalizeMiniMaxVoiceId(ttsVoice) || minimaxTtsVoice },
    createdAt: Date.now()
  });
  console.log(`📝 New session created: ${sessionId}, mode: ${mode}, userMode: ${userMode}`);
  res.json({ sessionId, mode, userMode, responseLanguage: languagePolicy.responseLanguage, languagePolicyApplied: languagePolicy.languagePolicyApplied, ttsVoice: normalizeMiniMaxVoiceId(ttsVoice) || minimaxTtsVoice });
});

// P1: Switch mode mid-session
app.post('/api/mode', (req, res) => {
  const { sessionId, mode } = req.body;

  if (!sessionId || !mode) {
    return res.status(400).json({ error: 'sessionId and mode are required' });
  }

  if (!['teaching', 'freeChat'].includes(mode)) {
    return res.status(400).json({ error: 'mode must be "teaching" or "freeChat"' });
  }

  const session = conversations.get(sessionId);
  if (!session) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const oldMode = session.mode;
  session.mode = mode;
  console.log(`🔄 Mode switched for session ${sessionId}: ${oldMode} → ${mode}`);
  res.json({ success: true, mode, previousMode: oldMode });
});

// P2: "Correct Me" on-demand feedback endpoint
app.post('/api/correct', async (req, res) => {
  const { sessionId, utterance } = req.body;

  if (!utterance) {
    return res.status(400).json({ error: 'utterance is required' });
  }

  const trimmedUtterance = typeof utterance === 'string' ? utterance.slice(0, 500).trim() : '';

  if (!trimmedUtterance) {
    return res.status(400).json({ error: 'utterance cannot be empty' });
  }

  console.log(`✏️ Correction requested for: "${trimmedUtterance.substring(0, 30)}..."`);

  try {
    // Get cultural context for enhanced correction
    const culturalContext = getCulturalContext(trimmedUtterance);

    const correction = buildEnglishCoachCorrection(trimmedUtterance, culturalContext);

    // Extract any cultural insights
    const culturalInsights = culturalContext.hasContent ? {
      summary: culturalContext.summary,
      slangUsed: culturalContext.slang.map(s => ({ term: s.term, meaning: s.meaning })),
      suggestions: culturalContext.colloquialSuggestions
    } : null;

    res.json({
      success: true,
      originalUtterance: trimmedUtterance,
      correction,
      culturalInsights,
      timestamp: Date.now()
    });
  } catch (err) {
    console.error('Correction error:', err.message);
    res.status(500).json({
      error: 'Failed to generate correction',
      fallbackCorrection: `Your line: ${trimmedUtterance}\n\nCoach note: Keep going. Use one short sentence, name the situation, and ask for one clear thing you need.`
    });
  }
});

// Token endpoint for Azure Speech SDK (secure - doesn't expose API key)
app.get('/api/speech-token', async (_req, res) => {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || 'eastasia';

  if (!speechKey) {
    return res.status(500).json({ error: 'AZURE_SPEECH_KEY not configured' });
  }

  try {
    const response = await fetch(
      `https://${speechRegion}.api.cognitive.microsoft.com/sts/v1.0/issueToken`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      }
    );

    if (!response.ok) {
      throw new Error(`Token request failed: ${response.status}`);
    }

    const token = await response.text();
    res.json({ token, region: speechRegion, language: azureAsrLanguage, expiresIn: 540 });
  } catch (err) {
    console.error('Speech token error:', err.message);
    res.status(500).json({ error: 'Failed to get speech token' });
  }
});


function parseAudioData(audioData) {
  const dataUriMatch = String(audioData).match(/^data:(audio\/[^;,]+)(?:;[^,]*)?;base64,(.+)$/);
  const mimeType = dataUriMatch?.[1] || 'audio/wav';
  const base64Data = dataUriMatch?.[2] || String(audioData).replace(/^data:audio\/[^,]+,/, '');
  const audioBuffer = Buffer.from(base64Data, 'base64');
  const audioFormat = mimeType.split('/')[1]?.replace('mpeg', 'mp3') || 'wav';

  return { audioBuffer, audioFormat, mimeType };
}

function azureAudioContentType(audioFormat) {
  if (audioFormat === 'ogg' || audioFormat === 'opus') return 'audio/ogg; codecs=opus';
  if (audioFormat === 'webm') return 'audio/webm; codecs=opus';
  if (audioFormat === 'mp3') return 'audio/mpeg';
  return 'audio/wav; codec=audio/pcm; samplerate=16000';
}

async function transcribeMiniMax(audioBuffer, audioFormat, mimeType) {
  if (!minimaxApiKey) throw new Error('MINIMAX_API_KEY not configured');

  const fileExtension = audioFormat === 'mp3' ? 'mp3' : audioFormat || 'wav';
  const formData = new FormData();
  formData.append('file', new Blob([audioBuffer], { type: mimeType }), `speech.${fileExtension}`);
  formData.append('model', minimaxAsrModel);
  formData.append('language', minimaxAsrLanguage);

  const response = await fetch(minimaxAsrEndpoint, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${minimaxApiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`MiniMax ASR failed: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const result = await response.json();
  const transcript = result.text || result.transcript || result.data?.text || result.data?.transcript || result.result?.text || '';
  if (!transcript) {
    throw new Error(`No transcript in MiniMax ASR response: ${JSON.stringify(result).substring(0, 300)}`);
  }

  return { transcript, result };
}

async function transcribeAzure(audioBuffer, audioFormat) {
  const speechKey = process.env.AZURE_SPEECH_KEY;
  const speechRegion = process.env.AZURE_SPEECH_REGION || 'eastasia';

  if (!speechKey) {
    throw new Error('AZURE_SPEECH_KEY not configured');
  }

  const contentType = azureAudioContentType(audioFormat);
  console.log(`Sending to Azure ASR with Content-Type: ${contentType}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  let response;
  try {
    response = await fetch(
      `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(azureAsrLanguage)}`,
      {
        method: 'POST',
        headers: {
          'Ocp-Apim-Subscription-Key': speechKey,
          'Content-Type': contentType,
        },
        body: audioBuffer,
        signal: controller.signal,
      }
    );
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Azure ASR failed: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const result = await response.json();
  if (result.RecognitionStatus !== 'Success') {
    throw new Error(`Recognition failed: ${result.RecognitionStatus}`);
  }

  const transcript = result.DisplayText || result.Text || '';
  if (!transcript) {
    throw new Error('No transcript in successful recognition');
  }

  return { transcript, result };
}

// Speech-to-Text endpoint for browser-recorded audio.
app.post('/api/speech-to-text', async (req, res) => {
  const { audioData } = req.body;

  if (!audioData) {
    return res.status(400).json({ error: 'Missing audioData' });
  }

  try {
    const { audioBuffer, audioFormat, mimeType } = parseAudioData(audioData);
    console.log(`Received audio: format=${audioFormat}, mime=${mimeType}, size=${audioBuffer.length} bytes`);

    const providerOrder = asrProvider === 'azure'
      ? ['azure']
      : asrProvider === 'minimax'
        ? ['minimax']
        : ['azure', 'minimax'];
    if (asrFallbackProvider && asrFallbackProvider !== asrProvider) {
      providerOrder.push(asrFallbackProvider);
    }
    const providers = providerOrder.filter((provider) => {
      if (provider === 'azure') return Boolean(azureTtsKey);
      if (provider === 'minimax') return Boolean(minimaxApiKey);
      return false;
    });

    if (!providers.length) {
      throw new Error(`${asrProvider.toUpperCase()} ASR is not configured`);
    }

    let lastError = null;
    for (const provider of [...new Set(providers)]) {
      try {
        if (provider === 'minimax') {
          const { transcript } = await transcribeMiniMax(audioBuffer, audioFormat, mimeType);
          return res.json({
            transcript,
            confidence: 0.9,
            provider: 'minimax',
            language: minimaxAsrLanguage
          });
        }

        if (provider === 'azure') {
          const { transcript, result } = await transcribeAzure(audioBuffer, audioFormat);
          return res.json({
            transcript,
            confidence: 0.9,
            provider: 'azure',
            language: azureAsrLanguage,
            recognitionStatus: result.RecognitionStatus
          });
        }
      } catch (err) {
        lastError = err;
        console.error(`${provider} ASR error:`, err.message);
      }
    }

    if (lastError) throw lastError;
  } catch (err) {
    console.error(`${asrProvider} ASR error:`, err.message);
    if (asrProvider !== 'mock') {
      return res.status(502).json({
        error: 'Speech recognition failed',
        provider: asrProvider,
        details: err.message
      });
    }

    return res.json({
      transcript: '(模擬) 你好，我想練習廣東話',
      confidence: 0.8,
      provider: 'mock',
      error: err.message,
    });
  }

  res.json({
    transcript: '(模擬) 你好，我想練習廣東話',
    confidence: 0.8,
    provider: 'mock',
  });
});

app.post('/api/recognize-and-respond', async (req, res) => {
  const { sessionId, userText = '', scenario = '', mode: requestMode, userMode: requestUserMode, uiLanguage: requestUiLanguage, responseLanguage: requestResponseLanguage = 'auto', ttsVoice: requestTtsVoice } = req.body || {};
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId is required' });
  }

  // Basic payload hygiene
  const trimmedUserText = typeof userText === 'string' ? userText.slice(0, 400).trim() : '';
  const scenarioText = typeof scenario === 'string' ? scenario.slice(0, 120) : '';

  // P1: Get session with mode (support both old array format and new object format)
  let session = conversations.get(sessionId);
  if (!session) {
    // Create new session if not exists
    session = { history: [], mode: 'freeChat', userMode: requestUserMode || 'international_student', settings: {} };
    conversations.set(sessionId, session);
  }

  // Handle legacy sessions (array format)
  if (Array.isArray(session)) {
    session = { history: session, mode: 'freeChat', userMode: requestUserMode || 'international_student', settings: {} };
    conversations.set(sessionId, session);
  }

  // P1: Use mode from request body if provided (frontend sends it with each message)
  const mode = requestMode || session.mode || 'freeChat';
  if (requestMode && requestMode !== session.mode) {
    session.mode = requestMode;
    console.log(`🔄 Mode updated from request: ${session.mode} → ${requestMode}`);
  }
  if (requestUserMode && requestUserMode !== session.userMode) {
    session.userMode = requestUserMode;
  }

  if (!session.settings) session.settings = {};
  const uiLanguage = normalizeUiLanguage(requestUiLanguage || session.settings.language || 'zh-TW');
  const languagePolicy = resolveLanguagePolicy({
    userMode: session.userMode || requestUserMode || 'international_student',
    uiLanguage,
    responseLanguage: requestResponseLanguage
  });
  session.settings.language = uiLanguage;
  session.settings.responseLanguage = languagePolicy.responseLanguage;
  const selectedTtsVoice = ttsProvider === 'minimax'
    ? await resolveMiniMaxVoice(requestTtsVoice || session.settings.ttsVoice || minimaxTtsVoice)
    : azureVoice;
  session.settings.ttsVoice = selectedTtsVoice;

  const { history } = session;

  // P2: Get cultural context for the user's text
  const culturalContext = getCulturalContext(trimmedUserText);
  if (culturalContext.hasContent) {
    console.log('🎭 Cultural context detected:', culturalContext.summary);
  }

  // Generate AI response using real LLM with mode and cultural context
  const aiText = await generateAIResponse(trimmedUserText, scenarioText, history, mode, culturalContext, languagePolicy);

  // Generate intelligent feedback using LLM (only in teaching mode)
  let feedback = '';
  if (mode === 'teaching' && trimmedUserText) {
    try {
      feedback = buildEnglishCoachCorrection(trimmedUserText, culturalContext);
    } catch (err) {
      feedback = 'Coach note: Keep going. Make the sentence short, clear, and connected to one real Hong Kong student-life situation.';
    }
  } else if (mode === 'freeChat') {
    feedback = ''; // No feedback in free chat mode
  } else {
    feedback = trimmedUserText
      ? 'Coach note: Keep going. Make the sentence short, clear, and connected to one real Hong Kong student-life situation.'
      : 'Try one Cantonese sentence you might actually use on campus.';
  }

  session.history.push({ role: 'user', text: trimmedUserText, timestamp: Date.now() });
  session.history.push({ role: 'ai', text: aiText, timestamp: Date.now() });
  if (session.history.length > 20) session.history = session.history.slice(-20);
  conversations.set(sessionId, session);

  // TTS Synthesis
  let ttsAudio = null;
  let ttsError = null;
  let ttsFallback = false;
  const ttsStartTime = Date.now();

  if ((ttsProvider === 'azure' && azureTtsKey) || (ttsProvider === 'minimax' && minimaxApiKey)) {
    try {
      const cacheKey = `${ttsProvider}:${ttsProvider === 'minimax' ? selectedTtsVoice : azureVoice}:${aiText.trim().toLowerCase()}`;
      if (ttsCache.has(cacheKey)) {
        ttsAudio = ttsCache.get(cacheKey);
        console.log('✓ TTS cache hit');
      } else {
        console.log(`Synthesizing ${ttsProvider} TTS with ${selectedTtsVoice} for:`, aiText.substring(0, 30) + '...');
        ttsAudio = ttsProvider === 'minimax'
          ? await synthesizeMiniMax(aiText, selectedTtsVoice)
          : await synthesizeAzure(aiText);
        if (ttsAudio) {
          console.log('✓ TTS synthesized, length:', ttsAudio.length);
          ttsCache.set(cacheKey, ttsAudio);
          if (ttsCache.size > MAX_TTS_CACHE) {
            const firstKey = ttsCache.keys().next().value;
            ttsCache.delete(firstKey);
          }
        } else {
          console.warn('⚠ TTS synthesis returned null');
        }
      }
    } catch (err) {
      console.error(`✗ ${ttsProvider} TTS failed:`, err.message);
      ttsError = err.message;
      ttsFallback = true;
    }
  } else {
    console.log('TTS provider not configured, using mock');
  }

  if (!ttsAudio) {
    console.log('Generating mock TTS audio');
    ttsAudio = generateMockTtsDataUri();
    if (!ttsFallback) ttsFallback = true;
  }

  const ttsLatency = Date.now() - ttsStartTime;
  const totalLatency = Date.now() - (req.startTime || Date.now());

  console.log('Sending response:', {
    aiTextLength: aiText.length,
    ttsAudioLength: ttsAudio ? ttsAudio.length : 0,
    ttsProvider: ttsAudio && !ttsFallback ? ttsProvider : 'mock',
    latencyMs: totalLatency
  });

  res.json({
    aiText,
    feedback,
    ttsAudio,
    history,
    latencyMs: totalLatency,
    ttsProvider: ttsAudio && !ttsFallback ? ttsProvider : 'mock',
    ttsVoice: ttsAudio && !ttsFallback ? selectedTtsVoice : null,
    ttsLatency,
    ttsError,
    ttsFallback,
    responseLanguage: languagePolicy.responseLanguage,
    languagePolicyApplied: languagePolicy.languagePolicyApplied,
    needsConfirmation: languagePolicy.needsConfirmation
  });
});

// Centralized error guard
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Server error, please try again.' });
});

async function synthesizeAzure(text) {
  if (!azureTtsKey || !azureTtsRegion) throw new Error('Azure TTS key/region missing');

  // Escape XML special characters
  const escapedText = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

  const ssml = `<?xml version="1.0" encoding="utf-8"?>
<speak version="1.0" xml:lang="zh-HK">
  <voice name="${azureVoice}">
    <prosody rate="${azureRate}" pitch="${azurePitch}">${escapedText}</prosody>
  </voice>
</speak>`;
  const ttsEndpoint = `https://${azureTtsRegion}.tts.speech.microsoft.com/cognitiveservices/v1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const ttsRes = await fetch(ttsEndpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-16khz-128kbitrate-mono-mp3',
        'Ocp-Apim-Subscription-Key': azureTtsKey
      },
      body: ssml,
      signal: controller.signal
    });
    clearTimeout(timeout);

    if (!ttsRes.ok) {
      const errorBody = await ttsRes.text();
      console.error('Azure TTS error response:', errorBody);
      throw new Error(`Azure TTS error ${ttsRes.status}: ${errorBody}`);
    }

    const buffer = Buffer.from(await ttsRes.arrayBuffer());
    return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
  } catch (err) {
    clearTimeout(timeout);
    throw err;
  }
}

async function synthesizeMiniMax(text, voiceId = minimaxTtsVoice) {
  if (!minimaxApiKey) throw new Error('MiniMax API key missing');

  const response = await fetch(`${minimaxBaseUrl}/v1/t2a_v2`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${minimaxApiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: minimaxTtsModel,
      text: text.slice(0, 10000),
      stream: false,
      language_boost: minimaxTtsLanguageBoost,
      output_format: 'hex',
      voice_setting: {
        voice_id: voiceId,
        speed: minimaxTtsSpeed,
        vol: minimaxTtsVolume,
        pitch: minimaxTtsPitch
      },
      audio_setting: {
        sample_rate: 32000,
        bitrate: 128000,
        format: 'mp3',
        channel: 1
      }
    })
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`MiniMax TTS error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const statusCode = data.base_resp?.status_code;
  if (statusCode !== undefined && statusCode !== 0) {
    throw new Error(`MiniMax TTS failed ${statusCode}: ${data.base_resp?.status_msg || 'unknown error'}`);
  }

  const audioHex = data.data?.audio;
  if (!audioHex) throw new Error('MiniMax TTS returned no audio');

  const buffer = Buffer.from(audioHex, 'hex');
  return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
}

export async function handler(req, res) {
  // not used in this runtime
}

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
  console.log(`Allowing origin: ${clientOrigin}`);
  console.log(`ASR Provider: ${asrProvider}`);
  console.log(`TTS Provider: ${ttsProvider}`);
  console.log(`LLM Provider: ${llmProvider}`);
  console.log(`MiniMax configured: ${minimaxApiKey ? 'YES ✓' : 'NO ✗'}`);
  if (minimaxApiKey) {
    console.log(`MiniMax LLM Model: ${minimaxLlmModel}`);
    console.log(`MiniMax TTS Voice: ${minimaxTtsVoice}`);
  }
  console.log(`Azure OpenAI configured: ${azureOpenAIKey && azureOpenAIEndpoint ? 'YES ✓' : 'NO ✗'}`);
  if (azureOpenAIKey && azureOpenAIEndpoint) {
    console.log(`Azure OpenAI Deployment: ${azureOpenAIDeployment}`);
  }
  console.log(`HKBU API configured: ${hkbuApiKey ? 'YES ✓' : 'NO ✗'}`);
  if (hkbuApiKey) {
    console.log(`HKBU Model: ${hkbuModel}`);
  }
});
