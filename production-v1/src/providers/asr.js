import {
  SPEECH_LIMITS,
  SpeechProviderError,
  logSpeech,
  readBoundedResponse,
  responseContentType,
  speechError,
  withSpeechDeadline,
} from './speech-common.js';

const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const NO_MATCH = new Set(['NoMatch', 'InitialSilenceTimeout', 'BabbleTimeout']);

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

export function createAsrProvider({
  config,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  logger,
  totalDeadlineMs = SPEECH_LIMITS.deadlineMs,
} = {}) {
  if (config?.provider !== 'azure' || typeof fetchImpl !== 'function'
    || !config.settings?.apiKey || !config.settings?.region) {
    throw speechError('VOICE_PROVIDER_MISCONFIGURED', 503, false, 'configuration');
  }
  const url = azureAsrUrl(config.settings.region);
  const transcribe = async (audio, { signal } = {}) => {
    const buffer = Buffer.isBuffer(audio) ? audio : Buffer.from(audio ?? []);
    const startedAt = now();
    try {
      const result = await withSpeechDeadline({
        signal,
        deadlineMs: totalDeadlineMs,
        operation: async (deadlineSignal) => {
          let response;
          try {
            response = await fetchImpl(url, {
              method: 'POST',
              headers: {
                'Ocp-Apim-Subscription-Key': config.settings.apiKey,
                'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000',
                Accept: 'application/json',
              },
              body: buffer,
              signal: deadlineSignal,
              redirect: 'error',
            });
          } catch (error) {
            if (deadlineSignal.aborted) throw error;
            throw speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
          }
          const body = await readBoundedResponse(response, SPEECH_LIMITS.asrResponseBytes, deadlineSignal);
          if (!response.ok) throw statusError(response.status);
          if (responseContentType(response) !== 'application/json') {
            throw speechError('VOICE_PROVIDER_INVALID_RESPONSE', 502, false, 'invalid_response');
          }
          return parseAzurePayload(body);
        },
      });
      const normalized = { ...result, provider: 'azure', latencyMs: Math.max(0, now() - startedAt) };
      logSpeech(logger, { stage: 'asr', provider: 'azure', statusClass: '2xx', latencyMs: normalized.latencyMs, byteCount: buffer.length });
      return normalized;
    } catch (error) {
      const normalized = error instanceof SpeechProviderError
        ? error
        : speechError('VOICE_TRANSCRIPTION_FAILED', 502, true, 'network');
      logSpeech(logger, { stage: 'asr', provider: 'azure', statusClass: normalized.httpStatus ? `${Math.floor(normalized.httpStatus / 100)}xx` : null, latencyMs: Math.max(0, now() - startedAt), byteCount: buffer.length, errorCode: normalized.code });
      throw normalized;
    }
  };
  return { provider: 'azure', transcribe };
}

export const speechProviderLimits = SPEECH_LIMITS;
