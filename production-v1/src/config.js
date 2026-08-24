import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';

const TRUE = 'true';

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

function configuredLlm(env, provider) {
  if (provider === 'hkbu') {
    return Boolean(env.HKBU_API_KEY) && Boolean(env.HKBU_BASE_URL ?? 'https://api.hkbu.edu.hk')
      && Boolean(env.HKBU_MODEL ?? 'hkbu-chat') && Boolean(env.HKBU_API_VERSION ?? 'v1');
  }
  if (provider === 'azure-openai') {
    return Boolean(env.AZURE_OPENAI_KEY) && Boolean(env.AZURE_OPENAI_ENDPOINT)
      && Boolean(env.AZURE_OPENAI_DEPLOYMENT ?? env.AZURE_OPENAI_MODEL)
      && Boolean(env.AZURE_OPENAI_API_VERSION ?? '2024-10-21');
  }
  if (provider === 'minimax') {
    return Boolean(env.MINIMAX_API_KEY) && Boolean(env.MINIMAX_BASE_URL)
      && Boolean(env.MINIMAX_ANTHROPIC_BASE_URL) && Boolean(env.MINIMAX_LLM_MODEL);
  }
  return provider === 'deterministic';
}

function configuredAsr(env, provider) {
  if (provider === 'azure') return Boolean(env.AZURE_SPEECH_KEY) && Boolean(env.AZURE_SPEECH_REGION);
  if (provider === 'minimax') {
    return asBoolean(env.MINIMAX_ASR_ENABLED) && Boolean(env.MINIMAX_API_KEY)
      && Boolean(env.MINIMAX_ASR_ENDPOINT) && Boolean(env.MINIMAX_ASR_MODEL);
  }
  return false;
}

function configuredTts(env, provider) {
  if (provider === 'azure') return Boolean(env.AZURE_SPEECH_KEY) && Boolean(env.AZURE_SPEECH_REGION);
  if (provider === 'minimax') {
    return Boolean(env.MINIMAX_API_KEY) && Boolean(env.MINIMAX_BASE_URL)
      && Boolean(env.MINIMAX_TTS_MODEL) && Boolean(env.MINIMAX_TTS_VOICE);
  }
  return false;
}

function parseTrustedProxyHops(value) {
  if (value === undefined) return 0;
  if (!/^\d+$/.test(value)) return null;
  return Number(value);
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
  if (config.instancePolicy !== 'single') throw new Error('V1_INSTANCE_POLICY=single is required in production');
  if (!config.privacyNoticeVersion || !config.privacyNoticeApproved) {
    throw new Error('An approved V1_PRIVACY_NOTICE_VERSION is required in production');
  }
  if (!config.retentionWorkerEnabled) throw new Error('V1_RETENTION_WORKER_ENABLED=true is required in production');
}

export function loadConfig(environment = process.env) {
  const env = loadEnvironmentFile(environment);
  const nodeEnv = env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const llmProvider = asProvider(firstDefined(env, 'V1_LLM_PROVIDER', 'LLM_PROVIDER'), 'deterministic');
  const asrProvider = asProvider(firstDefined(env, 'V1_ASR_PROVIDER', 'ASR_PROVIDER'));
  const ttsProvider = asProvider(firstDefined(env, 'V1_TTS_PROVIDER', 'TTS_PROVIDER'));
  const trustedProxyValue = firstDefined(env, 'V1_TRUST_PROXY_HOPS', 'TRUST_PROXY_HOPS');
  const mediaCredential = firstDefined(
    env,
    'V1_AZURE_STORAGE_CONNECTION_STRING',
    'AZURE_STORAGE_CONNECTION_STRING',
    'V1_AZURE_BLOB_ACCOUNT_URL',
    'AZURE_BLOB_ACCOUNT_URL',
  );

  const config = {
    nodeEnv,
    publicOrigin: firstDefined(env, 'V1_PUBLIC_ORIGIN', 'PUBLIC_ORIGIN'),
    sessionSecret: firstDefined(env, 'V1_SESSION_SECRET', 'SESSION_SECRET'),
    trustedProxyHops: parseTrustedProxyHops(trustedProxyValue),
    trustedProxyHopsExplicit: trustedProxyValue !== undefined,
    storeDriver: firstDefined(env, 'V1_STORE_DRIVER', 'STORE_DRIVER') ?? 'atomic-file',
    databaseUrl: env.DATABASE_URL,
    mediaDriver: firstDefined(env, 'V1_MEDIA_DRIVER', 'MEDIA_DRIVER') ?? 'local',
    mediaContainer: firstDefined(env, 'V1_AZURE_BLOB_CONTAINER', 'AZURE_BLOB_CONTAINER', 'AZURE_STORAGE_CONTAINER'),
    mediaCredential,
    instancePolicy: env.V1_INSTANCE_POLICY,
    privacyNoticeVersion: env.V1_PRIVACY_NOTICE_VERSION,
    privacyNoticeApproved: asBoolean(env.V1_PRIVACY_NOTICE_APPROVED),
    retentionWorkerEnabled: asBoolean(env.V1_RETENTION_WORKER_ENABLED),
    llm: { provider: llmProvider, available: configuredLlm(env, llmProvider) },
    asr: { provider: asrProvider, available: configuredAsr(env, asrProvider) },
    tts: { provider: ttsProvider, available: configuredTts(env, ttsProvider) },
  };

  if (!isProduction && config.trustedProxyHops === null) {
    throw new Error('V1_TRUST_PROXY_HOPS must be a non-negative integer');
  }
  if (isProduction) assertProductionReady(config);

  return {
    ...config,
    productionReady: isProduction && config.storeDriver === 'postgres' && config.mediaDriver === 'azure-blob'
      && config.llm.available && config.llm.provider !== 'deterministic',
    publicStatus: {
      productionReady: isProduction && config.storeDriver === 'postgres' && config.mediaDriver === 'azure-blob'
        && config.llm.available && config.llm.provider !== 'deterministic',
      llmAvailable: config.llm.available,
      asrAvailable: config.asr.available,
      ttsAvailable: config.tts.available,
    },
  };
}
