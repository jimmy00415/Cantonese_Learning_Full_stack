import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const AZURE_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

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
  throw new Error('Unsupported speech provider configuration');
}

export function providerConfigDigest(config, capability) {
  return createHash('sha256').update(canonicalJson(providerConfigDescriptor(config, capability))).digest('hex');
}

export function readEvidenceRecord(filePath) {
  if (!filePath) return null;
  try {
    const record = JSON.parse(readFileSync(filePath, 'utf8'));
    return record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    return null;
  }
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

export function validateSpeechEvidence(record, {
  expectedVersion, commitSha, capability, provider, contractVersion,
  configDigest, now,
}) {
  return Boolean(
    RELEASE_SHA.test(String(commitSha ?? ''))
    && artifactValid(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.capability === capability
    && record.provider === provider
    && record.contractVersion === contractVersion
    && record.providerConfigDigest === configDigest
    && record.result === 'pass'
    && Number.isFinite(record.latencyMs) && record.latencyMs >= 0
    && timeValid(record, now, 30 * DAY_MS),
  );
}

export function validateIosVoiceEvidence(record, {
  expectedVersion, commitSha, normalizerContractVersion, now,
}) {
  const assertions = record?.assertions ?? {};
  const requiredAssertions = [
    'normalizedCanonicalWav', 'autoStop55Seconds', 'permissionCleanup', 'cancelCleanup',
    'oneIdempotentUpload', 'editableTranscript', 'textFallback', 'noRawContainerUpload',
  ];
  return Boolean(
    RELEASE_SHA.test(String(commitSha ?? ''))
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
    && requiredAssertions.every((name) => assertions[name] === true)
    && timeValid(record, now, 90 * DAY_MS),
  );
}

export const voiceEvidenceContracts = Object.freeze({
  asr: 'azure-asr-v1',
  azureTts: 'azure-tts-v1',
  minimaxTts: 'minimax-tts-v1',
  speechMaximumAgeMs: 30 * DAY_MS,
  iosMaximumAgeMs: 90 * DAY_MS,
  futureSkewMs: FUTURE_SKEW_MS,
});
