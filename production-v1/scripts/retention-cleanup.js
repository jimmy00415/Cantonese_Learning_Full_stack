import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.js';
import { createMediaCleanupService } from '../src/services/media-cleanup.js';
import { runRetentionOnce } from '../src/services/retention.js';
import { createStorageRuntime } from '../src/services/storage-runtime.js';
import { productionInstanceLockName } from '../src/stores/postgres-store.js';

function render(write, value) {
  write(JSON.stringify(value));
}

function safeFailureCode(error) {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(error?.code ?? '')
    ? error.code
    : 'RETENTION_FAILED';
}

function commandError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export async function createRetentionCommandRuntime({
  environment = process.env,
  config: suppliedConfig,
  loadConfigImpl = loadConfig,
  createStorageRuntimeImpl = createStorageRuntime,
  createMediaCleanupServiceImpl = createMediaCleanupService,
  poolFactory,
  azureCredential,
  now = () => new Date(),
} = {}) {
  const config = suppliedConfig ?? loadConfigImpl(environment, { now });
  if (config?.nodeEnv !== 'production' || config?.retentionWorkerEnabled !== true) {
    throw commandError('RETENTION_PRODUCTION_REQUIRED');
  }
  const storage = await createStorageRuntimeImpl({
    config,
    poolFactory,
    azureCredential,
  });
  let instanceLock = null;
  let mediaCleanup;
  try {
    if (typeof storage.store?.acquireInstanceLock !== 'function') {
      throw commandError('RETENTION_INSTANCE_LOCK_UNAVAILABLE');
    }
    instanceLock = await storage.store.acquireInstanceLock({ name: productionInstanceLockName });
    if (instanceLock?.owned !== true || typeof instanceLock.release !== 'function') {
      throw commandError('RETENTION_INSTANCE_LOCK_UNAVAILABLE');
    }
    mediaCleanup = createMediaCleanupServiceImpl({
      store: storage.store,
      mediaStore: storage.mediaStore,
      now,
    });
  } catch (error) {
    if (instanceLock?.owned === true && typeof instanceLock.release === 'function') {
      await instanceLock.release().catch(() => undefined);
    }
    await storage.close().catch(() => undefined);
    throw error;
  }
  let closePromise = null;
  const close = () => {
    closePromise ??= (async () => {
      let firstError = null;
      try { await mediaCleanup.stop?.(); } catch (error) { firstError = error; }
      try { await instanceLock.release(); } catch (error) { firstError ??= error; }
      try { await storage.close(); } catch (error) { firstError ??= error; }
      if (firstError) throw firstError;
    })();
    return closePromise;
  };
  return {
    config,
    store: storage.store,
    mediaCleanup,
    close,
  };
}

export async function runRetentionCleanupCommand({
  createRuntime,
  serviceOptions = {},
  stdout = (line) => process.stdout.write(`${line}\n`),
  stderr = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  if (typeof createRuntime !== 'function') {
    render(stderr, { status: 'blocked', code: 'RETENTION_RUNTIME_REQUIRED' });
    return 2;
  }

  let runtime;
  let closeAttempted = false;
  try {
    runtime = await createRuntime();
    await runRetentionOnce({
      ...serviceOptions,
      store: runtime?.store,
      mediaCleanup: runtime?.mediaCleanup,
    });
    if (typeof runtime?.close === 'function') {
      closeAttempted = true;
      await runtime.close();
    }
    render(stdout, { status: 'ok', code: 'RETENTION_COMPLETED' });
    return 0;
  } catch (error) {
    if (!closeAttempted && typeof runtime?.close === 'function') {
      try { await runtime.close(); } catch { /* preserve the primary safe failure */ }
    }
    render(stderr, { status: 'failed', code: safeFailureCode(error) });
    return 1;
  }
}

const isMain = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  process.exitCode = await runRetentionCleanupCommand({
    createRuntime: () => createRetentionCommandRuntime(),
  });
}
