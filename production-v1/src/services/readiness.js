import {
  validateLlmSmokeEvidenceFile,
  validateReleaseEvidenceBundle,
} from './release-evidence.js';

export const readinessCheckNames = Object.freeze([
  'database',
  'media',
  'corpus',
  'retention',
  'dispatcher',
  'runtime',
]);

const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
const DEFAULT_READINESS_CHECK_TIMEOUT_MS = 3_000;

function readinessCheckTimeout(config) {
  const timeoutMs = config?.readinessCheckTimeoutMs;
  return Number.isInteger(timeoutMs) && timeoutMs >= 1 && timeoutMs <= 10_000
    ? timeoutMs
    : DEFAULT_READINESS_CHECK_TIMEOUT_MS;
}

async function runBoundedDependencyCheck(operation, timeoutMs, parentSignal) {
  const controller = new AbortController();
  let timer;
  let removeParentAbort = () => undefined;
  let finishBoundary;
  const work = Promise.resolve().then(() => operation(controller.signal)).catch(() => null);
  const timeout = new Promise((resolve) => {
    finishBoundary = () => {
      if (!controller.signal.aborted) controller.abort(parentSignal?.reason);
      resolve(null);
    };
    timer = setTimeout(finishBoundary, timeoutMs);
    timer.unref?.();
  });
  if (parentSignal?.aborted) finishBoundary();
  else if (typeof parentSignal?.addEventListener === 'function') {
    const abort = () => finishBoundary();
    parentSignal.addEventListener('abort', abort, { once: true });
    removeParentAbort = () => parentSignal.removeEventListener('abort', abort);
  }
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    removeParentAbort();
  }
}

function publicCheck(name, status, version) {
  const report = { name, status };
  if (typeof version === 'string' && SAFE_VERSION.test(version) && !DIGEST.test(version)) {
    report.version = version;
  }
  return report;
}

function productionConfigurationValid(config) {
  return Boolean(
    config?.nodeEnv === 'production'
    && config.productionConfigurationReady === true
    && config.storeDriver === 'postgres'
    && config.mediaDriver === 'azure-blob'
    && config.llm?.available === true
    && config.llm?.provider !== 'deterministic'
    && config.instancePolicy === 'single'
    && config.privacyNoticeApproved === true
    && config.retentionWorkerEnabled === true
    && config.releaseEvidence
    && config.llmEvidence,
  );
}

function normalizedDependencyCheck(name, value) {
  const ready = value?.status === 'ready' && value?.healthy === true;
  const version = value?.version ?? value?.policyVersion;
  return publicCheck(name, ready ? 'ready' : 'not-ready', version);
}

export async function evaluateProductionReadiness({
  config,
  checks = {},
  now = () => new Date(),
  validateEvidence = validateReleaseEvidenceBundle,
  validateLlmEvidence = validateLlmSmokeEvidenceFile,
  signal,
  allowPausedRuntime = false,
} = {}) {
  if (config?.nodeEnv !== 'production') {
    return {
      exitCode: 2,
      publicReport: {
        status: 'preview',
        productionReady: false,
        boundary: 'local-preview-only',
        checks: [publicCheck('configuration', 'preview', 'local-preview-v1')],
      },
    };
  }

  const configurationReady = productionConfigurationValid(config);
  const publicChecks = [publicCheck(
    'configuration',
    configurationReady ? 'ready' : 'not-ready',
    'production-config-v1',
  )];
  if (!configurationReady) {
    return {
      exitCode: 1,
      publicReport: {
        status: 'not-ready',
        productionReady: false,
        boundary: 'production-v1',
        checks: publicChecks,
      },
    };
  }

  let evidence;
  try {
    evidence = validateEvidence({ ...config.releaseEvidence, now: now() });
  } catch {
    evidence = { valid: false };
  }
  publicChecks.push(publicCheck(
    'release-evidence',
    evidence?.valid === true ? 'ready' : 'not-ready',
    'release-evidence-v1',
  ));
  if (evidence?.valid !== true) {
    return {
      exitCode: 1,
      publicReport: {
        status: 'not-ready',
        productionReady: false,
        boundary: 'production-v1',
        checks: publicChecks,
      },
    };
  }

  let llmEvidence;
  try {
    llmEvidence = validateLlmEvidence({ ...config.llmEvidence, now: now() });
  } catch {
    llmEvidence = { valid: false };
  }
  publicChecks.push(publicCheck(
    'llm-smoke',
    llmEvidence?.valid === true ? 'ready' : 'not-ready',
    'llm-smoke-v1',
  ));
  if (llmEvidence?.valid !== true) {
    return {
      exitCode: 1,
      publicReport: {
        status: 'not-ready',
        productionReady: false,
        boundary: 'production-v1',
        checks: publicChecks,
      },
    };
  }

  const checkTimeoutMs = readinessCheckTimeout(config);
  for (const name of readinessCheckNames) {
    if (signal?.aborted) break;
    let outcome = null;
    if (typeof checks[name] === 'function') {
      outcome = await runBoundedDependencyCheck(
        (checkSignal) => checks[name]({
          config,
          now: now(),
          signal: checkSignal,
          allowPausedRuntime,
        }),
        checkTimeoutMs,
        signal,
      );
    }
    publicChecks.push(normalizedDependencyCheck(name, outcome));
  }
  const productionReady = publicChecks.every((check) => check.status === 'ready');
  return {
    exitCode: productionReady ? 0 : 1,
    publicReport: {
      status: productionReady ? 'ready' : 'not-ready',
      productionReady,
      boundary: 'production-v1',
      checks: publicChecks,
    },
  };
}
