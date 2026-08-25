import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { loadLlmSmokeConfiguration } from '../src/config.js';
import { createLlmProvider } from '../src/providers/llm.js';
import {
  finalizeReleaseEvidenceRecord,
  LLM_SMOKE_CONTRACT_VERSION,
  llmProviderConfigDigest,
  validateLlmSmokeEvidence,
} from '../src/services/release-evidence.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SAFE_PROVIDER_CODE = /^PROVIDER_[A-Z0-9_]+$/;
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const executeFile = promisify(execFile);

function render(write, value) {
  write(JSON.stringify(value));
}

function outputRecord({
  provider = null,
  httpClass = null,
  normalizedSuccess = false,
  latencyMs = 0,
  artifactSha256 = null,
  code,
}) {
  return { provider, httpClass, normalizedSuccess, latencyMs, artifactSha256, code };
}

function exactConfirmation(argv) {
  return Array.isArray(argv) && argv.length === 1 && argv[0] === '--confirm-real-provider';
}

function smokeError(code) {
  const error = new Error('Provider smoke failed');
  error.code = code;
  return error;
}

function safeErrorCode(error) {
  return SAFE_PROVIDER_CODE.test(String(error?.code ?? '')) ? error.code : 'PROVIDER_FAILED';
}

function safeHttpClass(error) {
  return /^[1-5]xx$/.test(String(error?.statusClass ?? '')) ? error.statusClass : null;
}

function normalizedUsage(usage) {
  const safeToken = (...names) => {
    for (const name of names) {
      if (Number.isSafeInteger(usage?.[name]) && usage[name] >= 0) return usage[name];
    }
    return null;
  };
  const inputTokens = safeToken('inputTokens', 'prompt_tokens', 'input_tokens');
  const outputTokens = safeToken('outputTokens', 'completion_tokens', 'output_tokens');
  let totalTokens = safeToken('totalTokens', 'total_tokens');
  if (totalTokens === null && inputTokens !== null && outputTokens !== null
    && Number.isSafeInteger(inputTokens + outputTokens)) {
    totalTokens = inputTokens + outputTokens;
  }
  return { inputTokens, outputTokens, totalTokens };
}

function exactNormalizedSuccess(result, provider) {
  if (result?.provider !== provider || typeof result.rawText !== 'string') return false;
  try {
    const parsed = JSON.parse(result.rawText);
    return Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      && Object.keys(parsed).length === 1 && Object.hasOwn(parsed, 'ok') && parsed.ok === true);
  } catch {
    return false;
  }
}

function elapsedLatency(startedAt, clockMs) {
  try {
    const elapsed = Number(clockMs()) - startedAt;
    return Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 60_000 ? elapsed : 0;
  } catch {
    return 0;
  }
}

function defaultLoadSmokeConfig(environment, now) {
  return loadLlmSmokeConfiguration(environment, { now });
}

async function defaultInspectGit() {
  const options = {
    cwd: productionRoot,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
    windowsHide: true,
  };
  const before = (await executeFile('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
  const status = (await executeFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], options)).stdout;
  const after = (await executeFile('git', ['rev-parse', '--verify', 'HEAD'], options)).stdout.trim();
  return { commitSha: after, clean: before === after && status.length === 0 };
}

function validFrozenGit(state, commitSha) {
  return state?.clean === true && state.commitSha === commitSha;
}

export async function writeLlmSmokeEvidence(record, {
  rootDirectory = productionRoot,
  makeDirectory = mkdir,
  writeArtifact = writeFile,
} = {}) {
  if (!RELEASE_SHA.test(String(record?.commitSha ?? ''))
    || !DIGEST.test(String(record?.artifactSha256 ?? ''))
    || typeof makeDirectory !== 'function' || typeof writeArtifact !== 'function') {
    throw smokeError('LLM_SMOKE_ARTIFACT_WRITE_FAILED');
  }
  const directory = join(rootDirectory, 'reports', 'llm');
  await makeDirectory(directory, { recursive: true });
  const filePath = join(directory, `${record.commitSha}-llm-${record.artifactSha256}.json`);
  await writeArtifact(filePath, `${JSON.stringify(record)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return filePath;
}

export async function runProviderSmoke({
  argv = process.argv.slice(2),
  env = process.env,
  fetchImpl = globalThis.fetch,
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
  loadSmokeConfig = defaultLoadSmokeConfig,
  inspectGit = defaultInspectGit,
  createProvider = createLlmProvider,
  writeEvidence = writeLlmSmokeEvidence,
  now = () => new Date(),
  clockMs = Date.now,
} = {}) {
  if (!exactConfirmation(argv)) {
    render(stderr, outputRecord({ code: 'CONFIRMATION_REQUIRED' }));
    return 2;
  }

  let config;
  let configDigest;
  try {
    config = loadSmokeConfig(env, now);
    if (!RELEASE_SHA.test(String(config?.releaseCommitSha ?? ''))
      || !config?.llm?.available || config.llm.provider === 'deterministic') {
      throw smokeError('CONFIG_INVALID');
    }
    configDigest = llmProviderConfigDigest(config.llm);
  } catch {
    render(stderr, outputRecord({ code: 'CONFIG_INVALID' }));
    return 2;
  }

  let initialGit;
  try { initialGit = await inspectGit(); } catch { initialGit = null; }
  if (!validFrozenGit(initialGit, config.releaseCommitSha)) {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      code: 'RELEASE_GIT_STATE_INVALID',
    }));
    return 2;
  }

  let requestCount = 0;
  const singleRequestFetch = async (...args) => {
    if (requestCount >= 1) throw smokeError('PROVIDER_SMOKE_REQUEST_LIMIT');
    requestCount += 1;
    return fetchImpl(...args);
  };
  let startedAt;
  try { startedAt = Number(clockMs()); } catch { startedAt = 0; }
  let providerResult;
  let providerFailure;
  try {
    const provider = createProvider({
      config: config.llm,
      fetchImpl: singleRequestFetch,
      totalDeadlineMs: config.llm.timeoutMs,
      maxRetries: 0,
    });
    providerResult = await provider.generate({
      turnId: 'provider-smoke',
      systemPrompt: 'Return exactly one JSON object matching {"ok":true}, with no other keys or text.',
      responseLanguage: 'en',
      messages: [{ role: 'user', content: 'Reply with exactly {"ok":true} and no other text.' }],
      evidenceSnapshot: [],
      actionSnapshot: [],
      maxOutputTokens: 16,
    }, { retryLimit: 0, totalDeadlineMs: config.llm.timeoutMs });
  } catch (error) {
    providerFailure = error;
  }
  const latencyMs = elapsedLatency(startedAt, clockMs);

  let finalGit;
  try { finalGit = await inspectGit(); } catch { finalGit = null; }
  if (!validFrozenGit(finalGit, config.releaseCommitSha)) {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      latencyMs,
      code: 'RELEASE_GIT_STATE_INVALID',
    }));
    return 1;
  }
  if (providerFailure) {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      httpClass: safeHttpClass(providerFailure),
      latencyMs,
      code: safeErrorCode(providerFailure),
    }));
    return 1;
  }
  if (requestCount !== 1 || !exactNormalizedSuccess(providerResult, config.llm.provider)) {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      latencyMs,
      code: requestCount === 1 ? 'PROVIDER_INVALID_RESPONSE' : 'PROVIDER_SMOKE_REQUEST_LIMIT',
    }));
    return 1;
  }

  let record;
  try {
    const occurredAt = new Date(now()).toISOString();
    record = finalizeReleaseEvidenceRecord({
      schemaVersion: 1,
      commitSha: config.releaseCommitSha,
      capability: 'llm',
      provider: config.llm.provider,
      contractVersion: LLM_SMOKE_CONTRACT_VERSION,
      providerConfigDigest: configDigest,
      occurredAt,
      result: 'pass',
      httpClass: '2xx',
      normalizedSuccess: true,
      requestCount,
      latencyMs,
      usage: normalizedUsage(providerResult.usage),
    });
    const selfCheck = validateLlmSmokeEvidence(record, {
      expectedVersion: record.artifactSha256,
      commitSha: config.releaseCommitSha,
      provider: config.llm.provider,
      configDigest,
      now: occurredAt,
    });
    if (!selfCheck.valid) throw smokeError('LLM_SMOKE_ARTIFACT_INVALID');
  } catch {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      latencyMs,
      code: 'LLM_SMOKE_ARTIFACT_INVALID',
    }));
    return 1;
  }

  try {
    await writeEvidence(record);
  } catch (error) {
    render(stderr, outputRecord({
      provider: config.llm.provider,
      latencyMs,
      code: error?.code === 'EEXIST'
        ? 'LLM_SMOKE_ARTIFACT_EXISTS'
        : 'LLM_SMOKE_ARTIFACT_WRITE_FAILED',
    }));
    return 1;
  }
  render(stdout, outputRecord({
    provider: config.llm.provider,
    httpClass: '2xx',
    normalizedSuccess: true,
    latencyMs,
    artifactSha256: record.artifactSha256,
    code: 'LLM_SMOKE_RECORDED',
  }));
  return 0;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) process.exitCode = await runProviderSmoke();
