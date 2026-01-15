import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import morgan from 'morgan';
import fetch from 'node-fetch';
import { v4 as uuidv4 } from 'uuid';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from backend directory
dotenv.config({ path: join(__dirname, '.env') });

const app = express();
const port = process.env.PORT || 4000;
const clientOrigin = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
// Allow Azure frontend domain and GitHub Pages
const allowedOrigins = [
  clientOrigin,
  'https://hongkongtutor-f4b5gzd3fbfdhxdw.eastasia-01.azurewebsites.net',
  'https://jimmy00415.github.io'
];
const appVersion = process.env.APP_VERSION || '0.1.0-prototype';
const ttsProvider = (process.env.TTS_PROVIDER || 'mock').toLowerCase();
const azureTtsKey = process.env.AZURE_SPEECH_KEY;
const azureTtsRegion = process.env.AZURE_SPEECH_REGION;
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

app.disable('x-powered-by');
app.use(morgan(process.env.LOG_FORMAT || 'dev'));

app.use(cors({ 
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true 
}));
app.use(express.json({ limit: '2mb' }));
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

async function generateAIResponse(userText, scenario, history) {
  console.log('🤖 generateAIResponse called with:', { userText: userText.substring(0, 20), scenario, provider: llmProvider });
  
  // Check if any LLM provider is configured
  const hasAzureOpenAI = azureOpenAIKey && azureOpenAIEndpoint;
  const hasHKBU = hkbuApiKey;
  
  if (!hasAzureOpenAI && !hasHKBU) {
    console.warn('⚠️ No LLM API key configured, using mock');
    return mockAiReply(userText, scenario);
  }
  
  try {
    const systemMessage = `你係一個友善嘅廣東話老師。你嘅工作係幫學生練習廣東話對話。
場景：${scenario || '日常對話'}

指引：
1. 用地道廣東話回應
2. 語氣自然親切
3. 如果學生有文法或用詞錯誤，溫柔地糾正
4. 鼓勵學生繼續練習
5. 回應長度保持 1-3 句，唔好太長
6. 用繁體中文書寫`;

    const messages = [
      { role: 'system', content: systemMessage },
      ...history.slice(-6).map(h => ({ 
        role: h.role === 'user' ? 'user' : 'assistant', 
        content: h.text 
      })),
      { role: 'user', content: userText }
    ];

    let url, headers, body;
    
    // Use Azure OpenAI if configured and selected
    if (llmProvider === 'azure-openai' && hasAzureOpenAI) {
      url = `${azureOpenAIEndpoint}/openai/deployments/${azureOpenAIDeployment}/chat/completions?api-version=${azureOpenAIApiVersion}`;
      headers = {
        'api-key': azureOpenAIKey,
        'Content-Type': 'application/json'
      };
      body = {
        messages: messages,
        temperature: 0.7,
        max_tokens: 150
      };
      console.log('📡 Calling Azure OpenAI:', url);
    } else if (hasHKBU) {
      // Fallback to HKBU if Azure OpenAI not available
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
      throw new Error('No valid LLM provider configured');
    }
    
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    console.log('📥 LLM API response status:', response.status, response.statusText);
    
    if (!response.ok) {
      const errorText = await response.text();
      console.error('❌ LLM API error response:', errorText);
      throw new Error(`LLM API failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    console.log('📦 LLM API response data:', JSON.stringify(data).substring(0, 200));
    
    const aiResponse = data.choices?.[0]?.message?.content || '';
    
    if (aiResponse) {
      console.log('✅ LLM Response generated:', aiResponse.substring(0, 50));
      return aiResponse.trim();
    }
    
    throw new Error('No content in LLM response');
  } catch (err) {
    console.error('❌ LLM API error:', err.message);
    console.log('⚠️ Falling back to mock response');
    return mockAiReply(userText, scenario);
  }
}

function mockAiReply(userText, scenario) {
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
    res.json({ token, region: speechRegion });
  } catch (err) {
    console.error('Speech token error:', err.message);
    res.status(500).json({ error: 'Failed to get speech token' });
  }
});


// Speech-to-Text endpoint (Azure ASR for Cantonese)
app.post('/api/speech-to-text', async (req, res) => {
  const { audioData } = req.body;
  
  if (!audioData) {
    return res.status(400).json({ error: 'Missing audioData' });
  }

  const ttsProvider = process.env.TTS_PROVIDER || 'mock';
  
  if (ttsProvider === 'azure') {
    try {
      const speechKey = process.env.AZURE_SPEECH_KEY;
      const speechRegion = process.env.AZURE_SPEECH_REGION || 'eastasia';
      
      if (!speechKey) {
        throw new Error('AZURE_SPEECH_KEY not configured');
      }

      // Convert base64 to buffer
      const match = audioData.match(/^data:audio\/(\w+);base64,(.+)$/);
      const audioFormat = match ? match[1] : 'unknown';
      const base64Data = match ? match[2] : audioData.replace(/^data:audio\/\w+;base64,/, '');
      const audioBuffer = Buffer.from(base64Data, 'base64');
      
      console.log(`Received audio: format=${audioFormat}, size=${audioBuffer.length} bytes`);

      // Azure ASR best supports OGG and WAV formats
      let contentType = 'audio/wav; codec=audio/pcm; samplerate=16000';
      if (audioFormat === 'ogg') {
        contentType = 'audio/ogg; codecs=opus';
      } else if (audioFormat === 'webm') {
        // WebM is less reliable, but try it
        contentType = 'audio/webm; codecs=opus';
      }

      console.log(`Sending to Azure ASR with Content-Type: ${contentType}`);

      const response = await fetch(
        `https://${speechRegion}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK`,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': speechKey,
            'Content-Type': contentType,
          },
          body: audioBuffer,
        }
      );

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('Azure ASR error response:', response.status, errorBody);
        throw new Error(`Azure ASR failed: ${response.status} ${response.statusText} - ${errorBody}`);
      }

      const result = await response.json();
      console.log('Azure ASR result:', JSON.stringify(result));
      
      // Check if recognition was successful
      if (result.RecognitionStatus !== 'Success') {
        console.error('Azure ASR recognition failed:', result.RecognitionStatus);
        throw new Error(`Recognition failed: ${result.RecognitionStatus}`);
      }
      
      const transcript = result.DisplayText || result.Text || '';
      if (!transcript) {
        console.error('Azure ASR returned no transcript');
        throw new Error('No transcript in successful recognition');
      }
      
      return res.json({
        transcript,
        confidence: 0.9,
        provider: 'azure',
        recognitionStatus: result.RecognitionStatus
      });
    } catch (err) {
      console.error('Azure ASR error:', err.message);
      // Fallback to mock
      return res.json({
        transcript: '(模擬) 你好，我想練習廣東話',
        confidence: 0.8,
        provider: 'mock',
        error: err.message,
      });
    }
  }

  // Mock ASR fallback
  res.json({
    transcript: '(模擬) 你好，我想練習廣東話',
    confidence: 0.8,
    provider: 'mock',
  });
});

app.post('/api/recognize-and-respond', async (req, res) => {
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

  let history = conversations.get(sessionId);
  
  // Generate AI response using real LLM
  const aiText = await generateAIResponse(trimmedUserText, scenarioText, history);
  
  // Generate intelligent feedback using LLM
  let feedback = '';
  if (trimmedUserText && hkbuApiKey) {
    try {
      const feedbackPrompt = `分析以下廣東話句子嘅發音同文法，提供簡短建議（1句話）：「${trimmedUserText}」`;
      feedback = await generateAIResponse(feedbackPrompt, '發音分析', []);
      feedback = `（分析）${feedback}`;
    } catch (err) {
      feedback = '（分析）繼續練習，你做得好好！';
    }
  } else {
    feedback = trimmedUserText ? '（分析）繼續練習，你做得好好！' : '請試下講一句你想練習嘅句子。';
  }

  history.push({ role: 'user', text: trimmedUserText, timestamp: Date.now() });
  history.push({ role: 'ai', text: aiText, timestamp: Date.now() });
  if (history.length > 20) history = history.slice(-20);
  conversations.set(sessionId, history);

  // TTS Synthesis
  let ttsAudio = null;
  let ttsError = null;
  let ttsFallback = false;
  const ttsStartTime = Date.now();
  
  if (ttsProvider === 'azure' && azureTtsKey) {
    try {
      const cacheKey = aiText.trim().toLowerCase();
      if (ttsCache.has(cacheKey)) {
        ttsAudio = ttsCache.get(cacheKey);
        console.log('✓ TTS cache hit');
      } else {
        console.log('Synthesizing Azure TTS for:', aiText.substring(0, 30) + '...');
        ttsAudio = await synthesizeAzure(aiText);
        if (ttsAudio) {
          console.log('✓ TTS synthesized, length:', ttsAudio.length);
          ttsCache.set(cacheKey, ttsAudio);
          if (ttsCache.size > 50) {
            const firstKey = ttsCache.keys().next().value;
            ttsCache.delete(firstKey);
          }
        } else {
          console.warn('⚠ TTS synthesis returned null');
        }
      }
    } catch (err) {
      console.error('✗ Azure TTS failed:', err.message);
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
    ttsProvider: ttsAudio && !ttsFallback ? 'azure' : 'mock',
    latencyMs: totalLatency
  });

  res.json({ 
    aiText, 
    feedback, 
    ttsAudio, 
    history,
    latencyMs: totalLatency,
    ttsProvider: ttsAudio && !ttsFallback ? 'azure' : 'mock',
    ttsLatency,
    ttsError,
    ttsFallback
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

export async function handler(req, res) {
  // not used in this runtime
}

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
  console.log(`Allowing origin: ${clientOrigin}`);
  console.log(`TTS Provider: ${ttsProvider}`);
  console.log(`LLM Provider: ${llmProvider}`);
  console.log(`Azure OpenAI configured: ${azureOpenAIKey && azureOpenAIEndpoint ? 'YES ✓' : 'NO ✗'}`);
  if (azureOpenAIKey && azureOpenAIEndpoint) {
    console.log(`Azure OpenAI Deployment: ${azureOpenAIDeployment}`);
  }
  console.log(`HKBU API configured: ${hkbuApiKey ? 'YES ✓' : 'NO ✗'}`);
  if (hkbuApiKey) {
    console.log(`HKBU Model: ${hkbuModel}`);
  }
});
