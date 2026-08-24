import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

import {
  providerConfigDigest,
  readEvidenceRecord,
  validateIosVoiceEvidence,
  validateSpeechEvidence,
  voiceEvidenceContracts,
} from './services/voice-evidence.js';

const TRUE = 'true';
const AZURE_REQUEST_PROFILES = new Set(['standard', 'reasoning']);
export const NORMALIZER_CONTRACT_VERSION = 'canonical-wav-v1';
const RELEASE_SHA = /^[0-9a-f]{40}$/i;
const AZURE_SPEECH_REGION = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function firstDefined(env, ...names) {
  for (const name of names) {
    const value = env[name];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function loadEnvironmentFile(env) {
  if (!env.ENV_FILE) return { ...env };
  const filePath = resolve(env.ENV_FILE);
  const fileValues = parse(readFileSync(filePath));
  return { ...fileValues, ...env };
}

function asBoolean(value) {
  return String(value).toLowerCase() === TRUE;
}

function asProvider(value, fallback = 'none') {
  return (value ?? fallback).trim().toLowerCase();
}

function normalizeMiniMaxKey(value) {
  return String(value ?? '').trim().replace(/^Minimax-/, '');
}

function selectedLlmSettings(env, provider) {
  if (provider === 'hkbu') {
    return {
      apiKey: firstDefined(env, 'V1_HKBU_API_KEY', 'HKBU_API_KEY'),
      baseUrl: firstDefined(env, 'V1_HKBU_BASE_URL', 'HKBU_BASE_URL'),
      model: firstDefined(env, 'V1_HKBU_MODEL', 'HKBU_MODEL'),
      apiVersion: firstDefined(env, 'V1_HKBU_API_VERSION', 'HKBU_API_VERSION'),
    };
  }
  if (provider === 'azure-openai') {
    return {
      apiKey: firstDefined(env, 'V1_AZURE_OPENAI_KEY', 'AZURE_OPENAI_KEY'),
      endpoint: firstDefined(env, 'V1_AZURE_OPENAI_ENDPOINT', 'AZURE_OPENAI_ENDPOINT'),
      deployment: firstDefined(env, 'V1_AZURE_OPENAI_DEPLOYMENT', 'AZURE_OPENAI_DEPLOYMENT'),
      apiVersion: firstDefined(env, 'V1_AZURE_OPENAI_API_VERSION', 'AZURE_OPENAI_API_VERSION'),
      requestProfile: firstDefined(env, 'V1_AZURE_OPENAI_REQUEST_PROFILE', 'AZURE_OPENAI_REQUEST_PROFILE')?.trim().toLowerCase(),
      minCompletionTokens: boundedInteger(firstDefined(env, 'V1_AZURE_OPENAI_MIN_COMPLETION_TOKENS', 'AZURE_OPENAI_MIN_COMPLETION_TOKENS'), 1600, 800, 6000),
    };
  }
  if (provider === 'minimax') {
    return {
      apiKey: normalizeMiniMaxKey(firstDefined(env, 'V1_MINIMAX_API_KEY', 'MINIMAX_API_KEY')),
      baseUrl: firstDefined(env, 'V1_MINIMAX_BASE_URL', 'MINIMAX_BASE_URL'),
      anthropicBaseUrl: firstDefined(env, 'V1_MINIMAX_ANTHROPIC_BASE_URL', 'MINIMAX_ANTHROPIC_BASE_URL'),
      model: firstDefined(env, 'V1_MINIMAX_LLM_MODEL', 'MINIMAX_LLM_MODEL'),
    };
  }
  return {};
}

function configuredLlm(provider, settings) {
  if (provider === 'hkbu') return Boolean(settings.apiKey && settings.baseUrl && settings.model && settings.apiVersion);
  if (provider === 'azure-openai') {
    return Boolean(settings.apiKey && settings.endpoint && settings.deployment && settings.apiVersion
      && AZURE_REQUEST_PROFILES.has(settings.requestProfile));
  }
  if (provider === 'minimax') return Boolean(settings.apiKey && settings.baseUrl && settings.anthropicBaseUrl && settings.model);
  return provider === 'deterministic';
}

function selectedAsrSettings(env, provider) {
  if (provider !== 'azure') return {};
  return {
    apiKey: firstDefined(env, 'V1_AZURE_SPEECH_KEY', 'AZURE_SPEECH_KEY'),
    region: firstDefined(env, 'V1_AZURE_SPEECH_REGION', 'AZURE_SPEECH_REGION'),
    credentialVersion: env.V1_AZURE_SPEECH_CREDENTIAL_VERSION,
  };
}

function selectedTtsSettings(env, provider) {
  if (provider === 'azure') return selectedAsrSettings(env, provider);
  if (provider === 'minimax') {
    return {
      apiKey: normalizeMiniMaxKey(firstDefined(env, 'V1_MINIMAX_API_KEY', 'MINIMAX_API_KEY')),
      baseUrl: firstDefined(env, 'V1_MINIMAX_BASE_URL', 'MINIMAX_BASE_URL'),
      model: firstDefined(env, 'V1_MINIMAX_TTS_MODEL', 'MINIMAX_TTS_MODEL'),
      voice: firstDefined(env, 'V1_MINIMAX_TTS_VOICE', 'MINIMAX_TTS_VOICE'),
      credentialVersion: env.V1_MINIMAX_CREDENTIAL_VERSION,
    };
  }
  return {};
}

function validateSpeechSettings(provider, settings) {
  if (provider === 'azure' && settings.region && !AZURE_SPEECH_REGION.test(settings.region)) {
    throw new Error('Azure Speech region is invalid');
  }
}

function configuredAsr(provider, settings) {
  return provider === 'azure' && Boolean(settings.apiKey && settings.region);
}

function configuredTts(provider, settings) {
  if (provider === 'azure') return Boolean(settings.apiKey && settings.region);
  if (provider === 'minimax') return Boolean(settings.apiKey && settings.baseUrl && settings.model && settings.voice);
  return false;
}

function parseTrustedProxyHops(value) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
}

function rateLimit(value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || Number(value) < 1) throw new Error('Rate limit overrides must be positive integers');
  return Math.min(Number(value), fallback);
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (value === undefined || value === '') return fallback;
  if (!/^\d+$/.test(String(value))) throw new Error('Numeric configuration must be an integer');
  const parsed = Number(value);
  if (parsed < minimum || parsed > maximum) throw new Error(`Numeric configuration must be between ${minimum} and ${maximum}`);
  return parsed;
}

function assertProductionReady(config) {
  if (!config.publicOrigin) throw new Error('V1_PUBLIC_ORIGIN is required in production');
  if (Buffer.byteLength(config.sessionSecret ?? '') < 32) {
    throw new Error('V1_SESSION_SECRET must be at least 32 bytes in production');
  }
  if (!config.trustedProxyHopsExplicit || config.trustedProxyHops === null) {
    throw new Error('V1_TRUST_PROXY_HOPS must be explicitly set in production');
  }
  if (config.storeDriver !== 'postgres' || !config.databaseUrl) {
    throw new Error('Production requires V1_STORE_DRIVER=postgres and DATABASE_URL');
  }
  if (config.mediaDriver !== 'azure-blob' || !config.mediaContainer || !config.mediaCredential) {
    throw new Error('Production requires Azure Blob media configuration');
  }
  if (!config.llm.available || config.llm.provider === 'deterministic') {
    throw new Error('Production requires a configured real LLM provider');
  }
  const providerUrls = config.llm.provider === 'hkbu'
    ? [config.llm.settings.baseUrl]
    : config.llm.provider === 'azure-openai'
      ? [config.llm.settings.endpoint]
      : [config.llm.settings.baseUrl, config.llm.settings.anthropicBaseUrl];
  for (const value of providerUrls) {
    let url;
    try { url = new URL(value); } catch { throw new Error('Production LLM provider URLs must be valid HTTPS URLs'); }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('Production LLM provider URLs must be valid HTTPS URLs');
    }
  }
  if (config.instancePolicy !== 'single') throw new Error('V1_INSTANCE_POLICY=single is required in production');
  if (!config.privacyNoticeVersion || !config.privacyNoticeApproved) {
    throw new Error('An approved V1_PRIVACY_NOTICE_VERSION is required in production');
  }
  if (!config.retentionWorkerEnabled) throw new Error('V1_RETENTION_WORKER_ENABLED=true is required in production');
}

function publicStatusFor(config, speechEvidence, at) {
  const isProduction = config.nodeEnv === 'production';
  let asrValid = false;
  let ttsValid = false;
  let iosValid = false;
  if (isProduction && config.releaseCommitSha) {
    if (config.asr.available && config.asr.settings.credentialVersion) {
      asrValid = validateSpeechEvidence(speechEvidence.asr.record, {
        expectedVersion: speechEvidence.asr.version,
        commitSha: config.releaseCommitSha,
        capability: 'asr',
        provider: config.asr.provider,
        contractVersion: voiceEvidenceContracts.asr,
        configDigest: providerConfigDigest(config.asr, 'asr'),
        now: at,
      });
    }
    if (config.tts.available && config.tts.settings.credentialVersion) {
      const contractVersion = config.tts.provider === 'azure'
        ? voiceEvidenceContracts.azureTts
        : voiceEvidenceContracts.minimaxTts;
      ttsValid = validateSpeechEvidence(speechEvidence.tts.record, {
        expectedVersion: speechEvidence.tts.version,
        commitSha: config.releaseCommitSha,
        capability: 'tts',
        provider: config.tts.provider,
        contractVersion,
        configDigest: providerConfigDigest(config.tts, 'tts'),
        now: at,
      });
    }
    iosValid = validateIosVoiceEvidence(speechEvidence.ios.record, {
      expectedVersion: speechEvidence.ios.version,
      commitSha: config.releaseCommitSha,
      normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
      now: at,
    });
  }
  return {
    productionReady: config.productionReady,
    llmAvailable: config.llm.available,
    asrConfigured: config.asr.available,
    ttsConfigured: config.tts.available,
    voiceInputPreview: !isProduction && config.asr.available,
    voiceOutputPreview: !isProduction && config.tts.available,
    voiceInput: isProduction && asrValid && iosValid,
    voiceOutput: isProduction && ttsValid,
    asrEvidenceVersion: asrValid ? speechEvidence.asr.version : null,
    ttsEvidenceVersion: ttsValid ? speechEvidence.tts.version : null,
    iosVoiceAcceptanceVersion: iosValid ? speechEvidence.ios.version : null,
    privacyNoticeVersion: config.privacyNoticeVersion ?? null,
    releaseCommitSha: config.releaseCommitSha,
    normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
  };
}

export function loadConfig(environment = process.env, { now = () => new Date() } = {}) {
  const env = loadEnvironmentFile(environment);
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const llmProvider = asProvider(firstDefined(env, 'V1_LLM_PROVIDER', 'LLM_PROVIDER'), 'deterministic');
  const llmSettings = selectedLlmSettings(env, llmProvider);
  if (llmProvider === 'azure-openai' && llmSettings.requestProfile
    && !AZURE_REQUEST_PROFILES.has(llmSettings.requestProfile)) {
    throw new Error('V1_AZURE_OPENAI_REQUEST_PROFILE must be standard or reasoning');
  }
  const asrProvider = asProvider(firstDefined(env, 'V1_ASR_PROVIDER', 'ASR_PROVIDER'));
  const ttsProvider = asProvider(firstDefined(env, 'V1_TTS_PROVIDER', 'TTS_PROVIDER'));
  const asrSettings = selectedAsrSettings(env, asrProvider);
  const ttsSettings = selectedTtsSettings(env, ttsProvider);
  validateSpeechSettings(asrProvider, asrSettings);
  validateSpeechSettings(ttsProvider, ttsSettings);
  const trustedProxyValue = isProduction
    ? env.V1_TRUST_PROXY_HOPS
    : firstDefined(env, 'V1_TRUST_PROXY_HOPS', 'TRUST_PROXY_HOPS');
  const mediaConnectionString = isProduction
    ? env.V1_AZURE_STORAGE_CONNECTION_STRING
    : firstDefined(env, 'V1_AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_CONNECTION_STRING');
  const mediaAccountUrl = isProduction
    ? env.V1_AZURE_BLOB_ACCOUNT_URL
    : firstDefined(env, 'V1_AZURE_BLOB_ACCOUNT_URL', 'AZURE_BLOB_ACCOUNT_URL');
  if (mediaConnectionString && mediaAccountUrl) {
    throw new Error('Configure exactly one Azure Blob authentication mode');
  }
  const mediaCredential = mediaConnectionString ?? mediaAccountUrl;
  const releaseCommitSha = env.V1_RELEASE_COMMIT_SHA?.trim() || null;
  if (releaseCommitSha && !RELEASE_SHA.test(releaseCommitSha)) {
    throw new Error('V1_RELEASE_COMMIT_SHA must be a 40-hex commit SHA');
  }

  const config = {
    nodeEnv,
    publicOrigin: firstDefined(env, 'V1_PUBLIC_ORIGIN', 'PUBLIC_ORIGIN'),
    sessionSecret: firstDefined(env, 'V1_SESSION_SECRET', 'SESSION_SECRET'),
    trustedProxyHops: parseTrustedProxyHops(trustedProxyValue),
    trustedProxyHopsExplicit: env.V1_TRUST_PROXY_HOPS !== undefined,
    storeDriver: firstDefined(env, 'V1_STORE_DRIVER', 'STORE_DRIVER') ?? 'atomic-file',
    atomicFilePath: resolve(firstDefined(env, 'V1_ATOMIC_FILE_PATH', 'ATOMIC_FILE_PATH') ?? 'data/store.json'),
    databaseUrl: env.DATABASE_URL,
    mediaDriver: firstDefined(env, 'V1_MEDIA_DRIVER', 'MEDIA_DRIVER') ?? 'local',
    localMediaPath: resolve(firstDefined(env, 'V1_LOCAL_MEDIA_PATH', 'LOCAL_MEDIA_PATH') ?? 'media'),
    mediaContainer: firstDefined(env, 'V1_AZURE_BLOB_CONTAINER', 'AZURE_BLOB_CONTAINER', 'AZURE_STORAGE_CONTAINER'),
    mediaConnectionString,
    mediaAccountUrl,
    mediaAuthMode: mediaConnectionString ? 'connection-string' : mediaAccountUrl ? 'managed-identity' : null,
    mediaCredential,
    instancePolicy: env.V1_INSTANCE_POLICY,
    privacyNoticeVersion: env.V1_PRIVACY_NOTICE_VERSION,
    privacyNoticeApproved: asBoolean(env.V1_PRIVACY_NOTICE_APPROVED),
    retentionWorkerEnabled: asBoolean(env.V1_RETENTION_WORKER_ENABLED),
    releaseCommitSha,
    normalizerContractVersion: NORMALIZER_CONTRACT_VERSION,
    rateLimits: {
      bootstrap: rateLimit(env.V1_SESSION_BOOTSTRAP_LIMIT_10M, 20),
      message5m: rateLimit(env.V1_MESSAGE_LIMIT_5M, 30),
      messageDaily: rateLimit(env.V1_MESSAGE_LIMIT_DAY, 300),
      asr10m: rateLimit(env.V1_ASR_LIMIT_10M, 10),
      asrDaily: rateLimit(env.V1_ASR_LIMIT_DAY, 60),
      tts10m: rateLimit(env.V1_TTS_LIMIT_10M, 5),
      ttsDaily: rateLimit(env.V1_TTS_LIMIT_DAY, 20),
    },
    llm: {
      provider: llmProvider,
      available: configuredLlm(llmProvider, llmSettings),
      settings: llmSettings,
      timeoutMs: boundedInteger(firstDefined(env, 'V1_LLM_PROVIDER_TIMEOUT_MS', 'LLM_PROVIDER_TIMEOUT_MS'), 12_000, 1_000, 12_000),
    },
    asr: { provider: asrProvider, available: configuredAsr(asrProvider, asrSettings), settings: asrSettings },
    tts: { provider: ttsProvider, available: configuredTts(ttsProvider, ttsSettings), settings: ttsSettings },
    sse: {
      pageSize: boundedInteger(env.V1_SSE_PAGE_SIZE, 100, 1, 100),
      bufferSize: boundedInteger(env.V1_SSE_BUFFER_SIZE, 256, 1, 1024),
      heartbeatMs: boundedInteger(env.V1_SSE_HEARTBEAT_MS, 20_000, 10, 60_000),
    },
  };

  if (!isProduction && config.trustedProxyHops === null) {
    throw new Error('V1_TRUST_PROXY_HOPS must be a non-negative integer');
  }
  if (isProduction) assertProductionReady(config);

  const runtime = {
    ...config,
    productionReady: isProduction && config.storeDriver === 'postgres' && config.mediaDriver === 'azure-blob'
      && config.llm.available && config.llm.provider !== 'deterministic',
  };
  const speechEvidence = {
    asr: { record: readEvidenceRecord(env.V1_ASR_SMOKE_EVIDENCE_FILE), version: env.V1_ASR_SMOKE_EVIDENCE_VERSION ?? null },
    tts: { record: readEvidenceRecord(env.V1_TTS_SMOKE_EVIDENCE_FILE), version: env.V1_TTS_SMOKE_EVIDENCE_VERSION ?? null },
    ios: { record: readEvidenceRecord(env.V1_IOS_VOICE_ACCEPTANCE_FILE), version: env.V1_IOS_VOICE_ACCEPTANCE_VERSION ?? null },
  };
  runtime.getPublicStatus = (at = now()) => publicStatusFor(runtime, speechEvidence, at);
  runtime.publicStatus = runtime.getPublicStatus(now());
  return runtime;
}
