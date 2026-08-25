import { createHash } from 'node:crypto';

import { readBoundedJsonObjectFile } from './release-evidence.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GOOGLE_PROJECT = 'hkbuddy-prod-v1-20260826';
const GOOGLE_SPEECH_LOCATION = 'asia-southeast1';
const GOOGLE_RESPONSE_LANGUAGE_CODES = Object.freeze({
  en: 'en-US',
  yueHant: 'yue-Hant-HK',
  zhHans: 'cmn-Hans-CN',
});
const VOICE_EVIDENCE_MAX_BYTES = 64 * 1_024;
const SPEECH_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'provider', 'contractVersion',
  'providerConfigDigest', 'occurredAt', 'result', 'latencyMs', 'artifactSha256',
]);
const ASR_FIXTURE_KEYS = Object.freeze(['fixtureSha256', 'fixtureDurationMs']);
const SPEECH_V2_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'provider', 'contractVersion',
  'providerConfigDigest', 'runtimeIdentity', 'occurredAt', 'result', 'samples',
  'artifactSha256',
]);
const ASR_V2_SAMPLE_KEYS = Object.freeze([
  'responseLanguage', 'locale', 'referenceId', 'fixtureOrigin', 'fixtureVoiceName',
  'fixtureGeneratorContractVersion', 'fixtureGeneratorConfigDigest', 'fixtureTtsLatencyMs',
  'fixtureSha256', 'fixtureDurationMs', 'fixtureByteLength', 'transcriptUtf8Bytes',
  'transcriptCodePointCount', 'normalizedReferenceCodePointCount',
  'normalizedEditDistance', 'normalizedErrorRate', 'asrLatencyMs',
]);
const TTS_V2_SAMPLE_KEYS = Object.freeze([
  'responseLanguage', 'locale', 'voiceName', 'latencyMs', 'audioSha256',
  'audioByteLength', 'decodable',
]);
const SPEECH_V2_DEFINITIONS = Object.freeze({
  yueHant: Object.freeze({
    locale: 'yue-Hant-HK', referenceId: 'voice-smoke-yue-v1', voiceName: 'yue-HK-Chirp3-HD-Achernar',
  }),
  en: Object.freeze({
    locale: 'en-US', referenceId: 'voice-smoke-en-v1', voiceName: 'en-US-Chirp3-HD-Achernar',
  }),
  zhHans: Object.freeze({
    locale: 'cmn-Hans-CN', referenceId: 'voice-smoke-cmn-v1', voiceName: 'cmn-CN-Chirp3-HD-Achernar',
  }),
});
const SPEECH_V2_LANGUAGES = Object.freeze(Object.keys(SPEECH_V2_DEFINITIONS));
const IOS_ASSERTION_KEYS = Object.freeze([
  'normalizedCanonicalWav', 'autoStop55Seconds', 'permissionCleanup', 'cancelCleanup',
  'oneIdempotentUpload', 'editableTranscript', 'textFallback', 'noRawContainerUpload',
]);
const IOS_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'normalizerContractVersion',
  'deviceModelClass', 'iosVersion', 'safariVersion', 'captureMimeType',
  'fixtureSha256', 'fixtureDurationMs', 'assertions', 'occurredAt', 'result',
  'artifactSha256',
]);
const IOS_V2_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion', 'commitSha', 'capability', 'normalizerContractVersion',
  'reportSource', 'deviceReportSha256', 'deviceRunId', 'deviceModelClass',
  'iosVersion', 'safariVersion', 'captureMimeType', 'fixtureSha256',
  'fixtureDurationMs', 'fixtureByteLength', 'assertions', 'occurredAt', 'result',
  'artifactSha256',
]);

function hasExactOwnKeys(value, expectedKeys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actualKeys = Object.keys(value);
  if (actualKeys.length !== expectedKeys.length) return false;
  const expected = new Set(expectedKeys);
  return actualKeys.every((key) => expected.has(key));
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function finalizeEvidenceRecord(record) {
  const { artifactSha256: ignored, ...withoutDigest } = record;
  void ignored;
  return {
    ...withoutDigest,
    artifactSha256: createHash('sha256').update(canonicalJson(withoutDigest)).digest('hex'),
  };
}

function azureRegion(settings) {
  const region = String(settings?.region ?? '');
  if (!AZURE_REGION.test(region)) throw new Error('Invalid Azure Speech region');
  return region;
}

export function providerConfigDescriptor(config, capability) {
  const provider = config?.provider;
  const settings = config?.settings ?? {};
  if (provider === 'azure' && capability === 'asr') {
    const region = azureRegion(settings);
    return {
      provider, capability,
      endpoint: `https://${region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`,
      region, language: 'zh-HK', format: 'simple',
      contentType: 'audio/wav; codecs=audio/pcm; samplerate=16000',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'azure' && capability === 'tts') {
    const region = azureRegion(settings);
    return {
      provider, capability,
      endpoint: `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
      region, language: 'zh-HK', voice: 'zh-HK-HiuMaanNeural',
      outputFormat: 'audio-24khz-48kbitrate-mono-mp3',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'minimax' && capability === 'tts') {
    let url;
    try { url = new URL(String(settings.baseUrl ?? '')); } catch { throw new Error('Invalid MiniMax base URL'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('Invalid MiniMax base URL');
    return {
      provider, capability,
      endpoint: `${url.href.replace(/\/+$/, '')}/v1/t2a_v2`,
      model: settings.model, voice: settings.voice,
      languageBoost: 'Chinese,Yue', sampleRate: 32_000, bitrate: 128_000,
      format: 'mp3', channel: 1,
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'google-stt-v2' && capability === 'asr') {
    if (settings.projectId !== GOOGLE_PROJECT || settings.location !== GOOGLE_SPEECH_LOCATION
      || settings.model !== 'chirp_2' || settings.recognizer !== '_'
      || JSON.stringify(settings.languageCodes) !== JSON.stringify(['yue-Hant-HK', 'en-US', 'cmn-Hans-CN'])) {
      throw new Error('Invalid Google STT V2 configuration');
    }
    return {
      provider, capability,
      endpoint: `https://${settings.location}-speech.googleapis.com/v2/projects/${settings.projectId}/locations/${settings.location}/recognizers/${settings.recognizer}:recognize`,
      projectId: settings.projectId,
      location: settings.location,
      recognizer: settings.recognizer,
      model: settings.model,
      languageCodes: [...settings.languageCodes],
      allowedResponseLanguages: Object.keys(GOOGLE_RESPONSE_LANGUAGE_CODES),
      responseLanguageCodes: { ...GOOGLE_RESPONSE_LANGUAGE_CODES },
      languageOrderPolicy: 'selected-first-then-configured-order-v1',
      contentType: 'application/json',
      inputEncoding: 'canonical-wav-v1',
      credentialVersion: settings.credentialVersion ?? null,
    };
  }
  if (provider === 'google-tts' && capability === 'tts') {
    const expectedVoices = {
      en: { languageCode: 'en-US', name: 'en-US-Chirp3-HD-Achernar' },
      yueHant: { languageCode: 'yue-HK', name: 'yue-HK-Chirp3-HD-Achernar' },
      zhHans: { languageCode: 'cmn-CN', name: 'cmn-CN-Chirp3-HD-Achernar' },
    };
    if (settings.projectId !== GOOGLE_PROJECT || settings.location !== GOOGLE_SPEECH_LOCATION
      || JSON.stringify(settings.voices) !== JSON.stringify(expectedVoices)) {
      throw new Error('Invalid Google TTS configuration');
    }
    return {
      provider, capability,
      endpoint: `https://${settings.location}-texttospeech.googleapis.com/v1/text:synthesize`,
      projectId: settings.projectId,
      location: settings.location,
      voices: expectedVoices,
      audioEncoding: 'MP3',
      outputChannels: 1,
      credentialVersion: settings.credentialVersion ?? null,
      fallbackPolicy: 'none',
    };
  }
  throw new Error('Unsupported speech provider configuration');
}

export function providerConfigDigest(config, capability) {
  return createHash('sha256').update(canonicalJson(providerConfigDescriptor(config, capability))).digest('hex');
}

export function readEvidenceRecord(filePath, dependencies = {}) {
  return readBoundedJsonObjectFile(filePath, {
    ...dependencies,
    maximumBytes: VOICE_EVIDENCE_MAX_BYTES,
  });
}

function artifactValid(record, expectedVersion) {
  if (!record || !DIGEST.test(String(record.artifactSha256 ?? ''))
    || record.artifactSha256 !== expectedVersion) return false;
  return finalizeEvidenceRecord(record).artifactSha256 === record.artifactSha256;
}

function timeValid(record, now, maximumAgeMs) {
  const occurredAt = Date.parse(record?.occurredAt);
  const nowMs = new Date(now).getTime();
  return Number.isFinite(occurredAt) && Number.isFinite(nowMs)
    && occurredAt <= nowMs + FUTURE_SKEW_MS
    && nowMs - occurredAt <= maximumAgeMs;
}

function speechFixtureValid(record, capability) {
  if (capability === 'asr') {
    return DIGEST.test(String(record?.fixtureSha256 ?? ''))
      && Number.isFinite(record?.fixtureDurationMs)
      && record.fixtureDurationMs > 0;
  }
  return capability === 'tts'
    && record?.fixtureSha256 === undefined
    && record?.fixtureDurationMs === undefined;
}

function finiteNonNegative(value) {
  return Number.isFinite(value) && value >= 0;
}

function speechV2SamplesValid(record, capability, fixtureGeneratorConfigDigest) {
  if (!Array.isArray(record.samples) || record.samples.length !== SPEECH_V2_LANGUAGES.length) return false;
  const observed = new Set();
  for (const sample of record.samples) {
    const definition = SPEECH_V2_DEFINITIONS[sample?.responseLanguage];
    if (!definition || observed.has(sample.responseLanguage)) return false;
    observed.add(sample.responseLanguage);
    if (sample.locale !== definition.locale) return false;
    if (capability === 'tts') {
      if (!hasExactOwnKeys(sample, TTS_V2_SAMPLE_KEYS)
        || sample.voiceName !== definition.voiceName
        || !finiteNonNegative(sample.latencyMs)
        || !DIGEST.test(String(sample.audioSha256 ?? ''))
        || !Number.isSafeInteger(sample.audioByteLength) || sample.audioByteLength <= 4
        || sample.decodable !== true) return false;
      continue;
    }
    if (!hasExactOwnKeys(sample, ASR_V2_SAMPLE_KEYS)
      || sample.referenceId !== definition.referenceId
      || sample.fixtureOrigin !== 'google-tts-linear16-v1'
      || sample.fixtureVoiceName !== definition.voiceName
      || sample.fixtureGeneratorContractVersion !== 'google-tts-linear16-v1'
      || sample.fixtureGeneratorConfigDigest !== fixtureGeneratorConfigDigest
      || !DIGEST.test(String(sample.fixtureGeneratorConfigDigest ?? ''))
      || !finiteNonNegative(sample.fixtureTtsLatencyMs)
      || !DIGEST.test(String(sample.fixtureSha256 ?? ''))
      || !Number.isFinite(sample.fixtureDurationMs) || sample.fixtureDurationMs <= 0 || sample.fixtureDurationMs > 60_000
      || !Number.isSafeInteger(sample.fixtureByteLength) || sample.fixtureByteLength <= 44
      || !Number.isSafeInteger(sample.transcriptUtf8Bytes) || sample.transcriptUtf8Bytes <= 0
      || !Number.isSafeInteger(sample.transcriptCodePointCount) || sample.transcriptCodePointCount <= 0
      || !Number.isSafeInteger(sample.normalizedReferenceCodePointCount) || sample.normalizedReferenceCodePointCount <= 0
      || !Number.isSafeInteger(sample.normalizedEditDistance) || sample.normalizedEditDistance < 0
      || !finiteNonNegative(sample.normalizedErrorRate) || sample.normalizedErrorRate > 0.35
      || Math.abs(sample.normalizedErrorRate
        - Number((sample.normalizedEditDistance / sample.normalizedReferenceCodePointCount).toFixed(6))) > 1e-6
      || !finiteNonNegative(sample.asrLatencyMs)) return false;
  }
  return SPEECH_V2_LANGUAGES.every((language) => observed.has(language));
}

export function validateSpeechEvidence(record, {
  expectedVersion, commitSha, capability, provider, contractVersion,
  configDigest, runtimeIdentity, fixtureGeneratorConfigDigest, now,
}) {
  if (record?.schemaVersion === 2) {
    const expectedProvider = capability === 'asr' ? 'google-stt-v2' : 'google-tts';
    return Boolean(
      hasExactOwnKeys(record, SPEECH_V2_KEYS)
      && provider === expectedProvider
      && record.provider === expectedProvider
      && /^[0-9a-f]{40}$/.test(String(commitSha ?? ''))
      && artifactValid(record, expectedVersion)
      && record.commitSha === commitSha
      && record.capability === capability
      && record.contractVersion === contractVersion
      && record.providerConfigDigest === configDigest
      && DIGEST.test(String(configDigest ?? ''))
      && typeof runtimeIdentity === 'string' && runtimeIdentity.length > 0
      && record.runtimeIdentity === runtimeIdentity
      && record.result === 'pass'
      && speechV2SamplesValid(record, capability, fixtureGeneratorConfigDigest)
      && timeValid(record, now, 30 * DAY_MS)
    );
  }
  const allowedProviders = capability === 'asr'
    ? new Set(['azure', 'google-stt-v2'])
    : new Set(['azure', 'minimax', 'google-tts']);
  const expectedKeys = capability === 'asr'
    ? [...SPEECH_EVIDENCE_KEYS, ...ASR_FIXTURE_KEYS]
    : SPEECH_EVIDENCE_KEYS;
  return Boolean(
    hasExactOwnKeys(record, expectedKeys)
    && allowedProviders.has(provider)
    && RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.capability === capability
    && record.provider === provider
    && record.contractVersion === contractVersion
    && record.providerConfigDigest === configDigest
    && record.result === 'pass'
    && Number.isFinite(record.latencyMs) && record.latencyMs >= 0
    && speechFixtureValid(record, capability)
    && timeValid(record, now, 30 * DAY_MS),
  );
}

export function validateIosVoiceEvidence(record, {
  expectedVersion, commitSha, normalizerContractVersion, now,
}) {
  const assertions = record?.assertions ?? {};
  if (record?.schemaVersion === 2) {
    return Boolean(
      hasExactOwnKeys(record, IOS_V2_EVIDENCE_KEYS)
      && hasExactOwnKeys(assertions, IOS_ASSERTION_KEYS)
      && /^[0-9a-f]{40}$/.test(String(commitSha ?? ''))
      && artifactValid(record, expectedVersion)
      && record.commitSha === commitSha
      && record.capability === 'ios-voice'
      && record.normalizerContractVersion === normalizerContractVersion
      && record.reportSource === 'real-iphone-safari-manual-v1'
      && DIGEST.test(String(record.deviceReportSha256 ?? ''))
      && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(record.deviceRunId ?? ''))
      && /^iPhone(?:\s+[A-Za-z0-9.+-]+){1,4}$/.test(String(record.deviceModelClass ?? ''))
      && /^\d+(?:\.\d+){1,2}$/.test(String(record.iosVersion ?? ''))
      && /^\d+(?:\.\d+){1,2}$/.test(String(record.safariVersion ?? ''))
      && record.captureMimeType === 'audio/mp4'
      && DIGEST.test(String(record.fixtureSha256 ?? ''))
      && Number.isFinite(record.fixtureDurationMs) && record.fixtureDurationMs > 0
      && Number.isSafeInteger(record.fixtureByteLength) && record.fixtureByteLength > 44
      && IOS_ASSERTION_KEYS.every((name) => assertions[name] === true)
      && record.result === 'pass'
      && timeValid(record, now, 90 * DAY_MS)
    );
  }
  return Boolean(
    hasExactOwnKeys(record, IOS_EVIDENCE_KEYS)
    && hasExactOwnKeys(assertions, IOS_ASSERTION_KEYS)
    && RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.capability === 'ios-voice'
    && record.normalizerContractVersion === normalizerContractVersion
    && record.result === 'pass'
    && typeof record.deviceModelClass === 'string' && record.deviceModelClass
    && typeof record.iosVersion === 'string' && record.iosVersion
    && typeof record.safariVersion === 'string' && record.safariVersion
    && typeof record.captureMimeType === 'string' && record.captureMimeType
    && DIGEST.test(String(record.fixtureSha256 ?? ''))
    && Number.isFinite(record.fixtureDurationMs) && record.fixtureDurationMs > 0
    && IOS_ASSERTION_KEYS.every((name) => assertions[name] === true)
    && timeValid(record, now, 90 * DAY_MS),
  );
}

export const voiceEvidenceContracts = Object.freeze({
  asr: 'azure-asr-v1',
  googleAsr: 'google-stt-v2-v2',
  azureTts: 'azure-tts-v1',
  minimaxTts: 'minimax-tts-v1',
  googleTts: 'google-tts-v2',
  googleFixtureGenerator: 'google-tts-linear16-v1',
  speechMaximumAgeMs: 30 * DAY_MS,
  iosMaximumAgeMs: 90 * DAY_MS,
  futureSkewMs: FUTURE_SKEW_MS,
});
