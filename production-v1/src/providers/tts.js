import {
  SPEECH_LIMITS,
  SpeechProviderError,
  isMp3,
  logSpeech,
  readBoundedResponse,
  responseContentType,
  safeHttpsBase,
  speechError,
  withSpeechDeadline,
} from './speech-common.js';
import { createGoogleAccessTokenProvider } from './google-auth.js';
import { validateCanonicalWav } from '../media/canonical-wav.js';

const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const AZURE_VOICE = 'zh-HK-HiuMaanNeural';
const AZURE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const GOOGLE_VOICE_KEYS = Object.freeze({
  en: 'en',
  'yue-Hant-HK': 'yueHant',
  'cmn-Hans-CN': 'zhHans',
});

export function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function azureUrl(region) {
  if (!AZURE_REGION.test(String(region ?? ''))) throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  return `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`;
}

function transportStatusError(status) {
  if (status === 401 || status === 403) return speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
  if (status === 408 || status === 429 || status >= 500) return speechError('VOICE_SYNTHESIS_FAILED', 502, true, 'transient');
  return speechError('VOICE_SYNTHESIS_REJECTED', 502, false, 'rejected');
}

function parseMiniMax(buffer) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch { throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response'); }
  const hex = payload?.data?.audio;
  if (payload?.base_resp?.status_code !== 0 || payload?.data?.status !== 2
    || typeof hex !== 'string' || hex.length < 2
    || hex.length > SPEECH_LIMITS.minimaxHexCharacters
    || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  const audio = Buffer.from(hex, 'hex');
  if (audio.length > SPEECH_LIMITS.audioBytes
    || (payload.extra_info?.audio_size !== undefined && payload.extra_info.audio_size !== audio.length)
    || !isMp3(audio)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  return audio;
}

function googleTtsUrl(settings) {
  const expected = {
    en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
    yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
    zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
  };
  if (settings?.projectId !== 'hkbuddy-prod-v1-20260826'
    || settings.location !== 'asia-southeast1'
    || JSON.stringify(settings.voices) !== JSON.stringify(expected)) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  return `https://${settings.location}-texttospeech.googleapis.com/v1/text:synthesize`;
}

function parseGoogleTts(buffer, audioEncoding) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  const value = payload?.audioContent;
  if (typeof value !== 'string' || value.length < 4 || value.length % 4 !== 0
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  const audio = Buffer.from(value, 'base64');
  if (audio.length > SPEECH_LIMITS.audioBytes || audio.toString('base64') !== value) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (audioEncoding === 'MP3' && !isMp3(audio)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (audioEncoding === 'LINEAR16') {
    try { validateCanonicalWav(audio); } catch {
      throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
    }
  }
  return audio;
}

export function createTtsProvider({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger,
  totalDeadlineMs = SPEECH_LIMITS.deadlineMs,
  googleAuthProvider: suppliedGoogleAuthProvider,
} = {}) {
  if (!['azure', 'minimax', 'google-tts'].includes(config?.provider) || typeof fetchImpl !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const settings = config.settings ?? {};
  let url;
  if (config.provider === 'azure') {
    if (!settings.apiKey || !settings.region) throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
    url = azureUrl(settings.region);
  } else if (config.provider === 'minimax') {
    if (!settings.apiKey || !settings.baseUrl || !settings.model || !settings.voice) {
      throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
    }
    url = `${safeHttpsBase(settings.baseUrl)}/v1/t2a_v2`;
  } else {
    url = googleTtsUrl(settings);
  }
  const google = config.provider === 'google-tts';
  const googleAuthProvider = google
    ? suppliedGoogleAuthProvider ?? createGoogleAccessTokenProvider({ fetchImpl })
    : null;
  if (google && typeof googleAuthProvider?.fetch !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }

  const synthesizeWithEncoding = async (text, {
    signal, responseLanguage = 'yue-Hant-HK', audioEncoding = 'MP3',
  } = {}) => {
    const serverText = String(text ?? '');
    if (!serverText.trim()) throw speechError('VOICE_SYNTHESIS_REJECTED', 502, false, 'rejected');
    const startedAt = now();
    const azure = config.provider === 'azure';
    if (!['MP3', 'LINEAR16'].includes(audioEncoding) || (!google && audioEncoding !== 'MP3')) {
      throw speechError('VOICE_SYNTHESIS_REJECTED', 502, false, 'rejected');
    }
    const googleVoiceKey = GOOGLE_VOICE_KEYS[responseLanguage];
    if (!googleVoiceKey) {
      throw speechError('VOICE_SYNTHESIS_REJECTED', 502, false, 'rejected');
    }
    if (!google && responseLanguage !== 'yue-Hant-HK') {
      throw speechError('VOICE_SYNTHESIS_REJECTED', 502, false, 'rejected');
    }
    const body = google
      ? JSON.stringify({
        input: { text: serverText },
        voice: settings.voices[googleVoiceKey],
        audioConfig: audioEncoding === 'LINEAR16'
          ? { audioEncoding: 'LINEAR16', sampleRateHertz: 16_000 }
          : { audioEncoding: 'MP3' },
      })
      : azure
      ? `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-HK"><voice name="${AZURE_VOICE}">${escapeXml(serverText)}</voice></speak>`
      : JSON.stringify({
        model: settings.model,
        text: serverText,
        stream: false,
        output_format: 'hex',
        language_boost: 'Chinese,Yue',
        voice_setting: { voice_id: settings.voice, speed: 1, vol: 1, pitch: 0 },
        audio_setting: { sample_rate: 32_000, bitrate: 128_000, format: 'mp3', channel: 1 },
      });
    try {
      const audio = await withSpeechDeadline({
        signal,
        deadlineMs: totalDeadlineMs,
        operation: async (deadlineSignal) => {
          let response;
          try {
            const providerFetch = googleAuthProvider?.fetch ?? fetchImpl;
            response = await providerFetch(url, {
              method: 'POST',
              headers: google ? {
                Accept: 'application/json',
                'Content-Type': 'application/json',
              } : azure ? {
                'Ocp-Apim-Subscription-Key': settings.apiKey,
                'Content-Type': 'application/ssml+xml',
                'X-Microsoft-OutputFormat': AZURE_FORMAT,
                'User-Agent': 'HongKongBuddy-ProductionV1/0.1',
              } : {
                Authorization: `Bearer ${settings.apiKey}`,
                'Content-Type': 'application/json',
              },
              body,
              signal: deadlineSignal,
              redirect: 'error',
            });
          } catch (error) {
            if (deadlineSignal.aborted) throw error;
            if (error?.code === 'GOOGLE_AUTHENTICATION_FAILED') {
              throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
            }
            throw speechError('VOICE_SYNTHESIS_FAILED', 502, true, 'network');
          }
          const maximum = azure ? SPEECH_LIMITS.audioBytes : SPEECH_LIMITS.minimaxJsonBytes;
          const responseBody = await readBoundedResponse(response, maximum, deadlineSignal);
          if (!response.ok) throw transportStatusError(response.status);
          if (azure) {
            if (responseContentType(response) !== 'audio/mpeg' || !isMp3(responseBody)) {
              throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
            }
            return responseBody;
          }
          if (responseContentType(response) !== 'application/json') {
            throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
          }
          return google ? parseGoogleTts(responseBody, audioEncoding) : parseMiniMax(responseBody);
        },
      });
      const result = {
        buffer: audio,
        mimeType: audioEncoding === 'LINEAR16' ? 'audio/wav' : 'audio/mpeg',
        provider: config.provider,
        latencyMs: Math.max(0, now() - startedAt),
      };
      logSpeech(logger, { stage: 'tts', provider: config.provider, statusClass: '2xx', latencyMs: result.latencyMs, byteCount: audio.length });
      return result;
    } catch (error) {
      const normalized = error instanceof SpeechProviderError
        ? error
        : speechError('VOICE_SYNTHESIS_FAILED', 502, true, 'network');
      logSpeech(logger, { stage: 'tts', provider: config.provider, statusClass: normalized.httpStatus ? `${Math.floor(normalized.httpStatus / 100)}xx` : null, latencyMs: Math.max(0, now() - startedAt), errorCode: normalized.code });
      throw normalized;
    }
  };
  const synthesize = (text, options = {}) => synthesizeWithEncoding(text, { ...options, audioEncoding: 'MP3' });
  const synthesizeLinear16 = (text, options = {}) => synthesizeWithEncoding(text, { ...options, audioEncoding: 'LINEAR16' });
  return { provider: config.provider, synthesize, synthesizeLinear16 };
}
