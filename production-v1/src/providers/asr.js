import {
  SPEECH_LIMITS,
  SpeechProviderError,
  logSpeech,
  readBoundedResponse,
  responseContentType,
  speechError,
  withSpeechDeadline,
} from './speech-common.js';
import { createGoogleAccessTokenProvider } from './google-auth.js';

const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_MATCH = new Set(['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout']);
const GOOGLE_RESPONSE_LANGUAGES = Object.freeze({
  en: 'en-US',
  yueHant: 'yue-Hant-HK',
  zhHans: 'cmn-Hans-CN',
});

function azureAsrUrl(region) {
  if (!AZURE_REGION.test(String(region ?? ''))) throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  return `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`;
}

function statusError(status) {
  if (status === 401 || status === 403) return speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
  if (status === 408 || status === 429 || status >= 500) return speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'transient');
  return speechError('VOICE_TRANSCRIPTION_REJECTED', 502, false, 'rejected');
}

function parseAzurePayload(buffer) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch { throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response'); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (payload.RecognitionStatus !== 'Success') {
    if (NO_MATCH.has(payload.RecognitionStatus)) {
      throw speechError('VOICE_SPEECH_NOT_RECOGNIZED', 422, false, 'not_recognized');
    }
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (typeof payload.DisplayText !== 'string' || !payload.DisplayText.trim()) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  return {
    transcript: payload.DisplayText.trim(),
    confidence: Number.isFinite(payload.Confidence) ? Number(payload.Confidence) : null,
  };
}

function googleAsrUrl(settings) {
  if (settings?.projectId !== 'hkbuddy-prod-v1-20260826'
    || settings.location !== 'asia-southeast1' || settings.model !== 'chirp_2'
    || settings.recognizer !== '_'
    || JSON.stringify(settings.languageCodes) !== JSON.stringify(['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'])) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  return `https://${settings.location}-speech.googleapis.com/v2/projects/${settings.projectId}/locations/${settings.location}/recognizers/${settings.recognizer}:recognize`;
}

function googleLanguageCodes(settings, responseLanguage) {
  const selected = GOOGLE_RESPONSE_LANGUAGES[responseLanguage];
  if (!selected) throw speechError('VOICE_TRANSCRIPTION_REJECTED', 502, false, 'rejected');
  return [selected, ...settings.languageCodes.filter((language) => language !== selected)];
}

function parseGooglePayload(buffer) {
  let payload;
  try { payload = JSON.parse(buffer.toString('utf8')); } catch {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !Array.isArray(payload.results)) {
    throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
  }
  const alternatives = payload.results
    .map((result) => result?.alternatives?.[0])
    .filter((alternative) => typeof alternative?.transcript === 'string' && alternative.transcript.trim());
  const transcript = alternatives.map((alternative) => alternative.transcript.trim()).join(' ').trim();
  if (!transcript) throw speechError('VOICE_SPEECH_NOT_RECOGNIZED', 422, false, 'not_recognized');
  return {
    transcript,
    confidence: Number.isFinite(alternatives[0]?.confidence) ? Number(alternatives[0].confidence) : null,
  };
}

export function createAsrProvider({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger,
  totalDeadlineMs = SPEECH_LIMITS.deadlineMs,
  googleAuthProvider: suppliedGoogleAuthProvider,
} = {}) {
  if (!['azure', 'google-stt-v2'].includes(config?.provider) || typeof fetchImpl !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const google = config.provider === 'google-stt-v2';
  if (!google && (!config.settings?.apiKey || !config.settings?.region)) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const url = google ? googleAsrUrl(config.settings) : azureAsrUrl(config.settings.region);
  const googleAuthProvider = google
    ? suppliedGoogleAuthProvider ?? createGoogleAccessTokenProvider({ fetchImpl })
    : null;
  if (google && typeof googleAuthProvider?.fetch !== 'function') {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const transcribe = async (audio, { signal, responseLanguage = 'yueHant' } = {}) => {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio ?? []);
    const googleLanguages = google ? googleLanguageCodes(config.settings, responseLanguage) : null;
    const startedAt = now();
    try {
      const result = await withSpeechDeadline({
        signal,
        deadlineMs: totalDeadlineMs,
        operation: async (deadlineSignal) => {
          let response;
          try {
            const requestBody = google ? JSON.stringify({
              config: {
                autoDecodingConfig: {},
                model: config.settings.model,
                languageCodes: googleLanguages,
              },
              content: buffer.toString('base64'),
            }) : buffer;
            const providerFetch = googleAuthProvider?.fetch ?? fetchImpl;
            response = await providerFetch(url, {
              method: 'POST',
              headers: google ? {
                'Content-Type': 'application/json',
                Accept: 'application/json',
              } : {
                'Ocp-Apim-Subscription-Key': config.settings.apiKey,
                'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
                Accept: 'application/json',
              },
              body: requestBody,
              signal: deadlineSignal,
              redirect: 'error',
            });
          } catch (error) {
            if (deadlineSignal.aborted) throw error;
            if (error?.code === 'GOOGLE_AUTHENTICATION_FAILED') {
              throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'authentication');
            }
            throw speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
          }
          const body = await readBoundedResponse(response, SPEECH_LIMITS.asrResponseBytes, deadlineSignal);
          if (!response.ok) throw statusError(response.status);
          if (responseContentType(response) !== 'application/json') {
            throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
          }
          return google ? parseGooglePayload(body) : parseAzurePayload(body);
        },
      });
      const normalized = { ...result, provider: config.provider, latencyMs: Math.max(0, now() - startedAt) };
      logSpeech(logger, { stage: 'asr', provider: config.provider, statusClass: '2xx', latencyMs: normalized.latencyMs, byteCount: buffer.length });
      return normalized;
    } catch (error) {
      const normalized = error instanceof SpeechProviderError
        ? error
        : speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
      logSpeech(logger, { stage: 'asr', provider: config.provider, statusClass: normalized.httpStatus ? `${Math.floor(normalized.httpStatus / 100)}xx` : null, latencyMs: Math.max(0, now() - startedAt), byteCount: buffer.length, errorCode: normalized.code });
      throw normalized;
    }
  };
  return { provider: config.provider, transcribe };
}

export const speechProviderLimits = SPEECH_LIMITS;
