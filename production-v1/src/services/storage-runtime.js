import { DefaultAzureCredential } from '@azure/identity';
import { Pool } from 'pg';

import { AtomicFileStore } from '../stores/atomic-file-store.js';
import { AzureBlobMediaStore } from '../stores/azure-blob-media-store.js';
import { LocalMediaStore } from '../stores/local-media-store.js';
import { PostgresStore } from '../stores/postgres-store.js';
import {
  assertSecurePostgresRuntimeUrl,
  blobIdentitySha256,
  postgresIdentitySha256,
} from './release-evidence.js';

const STORE_DRIVERS = new Set(['atomic-file', 'postgres']);
const MEDIA_DRIVERS = new Set(['local', 'azure-blob']);
const CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])?$/;

function boundedRuntimeTimeout(value, fallback, maximum) {
  const timeoutMs = value ?? fallback;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum) {
    throw new Error('Storage runtime timeout configuration is invalid');
  }
  return timeoutMs;
}

function dependencyInitTimeoutError() {
  const error = new Error('Storage dependency initialization timed out');
  error.code = 'DEPENDENCY_INIT_TIMEOUT';
  return error;
}

async function withDependencyInitDeadline(operation, timeoutMs) {
  let timer;
  const controller = new AbortController();
  const timeout = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => {
      const error = dependencyInitTimeoutError();
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function nonempty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validAccountUrl(value) {
  if (!nonempty(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && !url.username && !url.password && !url.port && !url.search && !url.hash
      && url.pathname === '/';
  } catch {
    return false;
  }
}

function requireAdapter(adapter, name) {
  if (!adapter || typeof adapter.init !== 'function' || typeof adapter.close !== 'function') {
    throw new Error(`${name} must implement init() and close()`);
  }
}

function validateConfig({ config, suppliedStore, suppliedMediaStore, poolFactory }) {
  if (!config || typeof config !== 'object') throw new Error('Storage runtime requires config');
  if (config.nodeEnv === 'production'
    && (config.storeDriver !== 'postgres' || config.mediaDriver !== 'azure-blob')) {
    throw new Error('Production storage requires postgres and azure-blob drivers');
  }
  if (!STORE_DRIVERS.has(config.storeDriver)) {
    throw new Error(`Store driver ${String(config.storeDriver)} is not available`);
  }
  if (!MEDIA_DRIVERS.has(config.mediaDriver)) {
    throw new Error(`Media driver ${String(config.mediaDriver)} is not available`);
  }
  if (suppliedStore) requireAdapter(suppliedStore, 'Supplied store');
  if (suppliedMediaStore) requireAdapter(suppliedMediaStore, 'Supplied media store');

  if (!suppliedStore) {
    if (config.storeDriver === 'atomic-file' && !nonempty(config.atomicFilePath)) {
      throw new Error('Atomic-file storage requires atomicFilePath');
    }
    if (config.storeDriver === 'postgres') {
      if (!nonempty(config.databaseUrl)) throw new Error('PostgreSQL storage requires databaseUrl');
      try {
        if (config.nodeEnv === 'production') assertSecurePostgresRuntimeUrl(config.databaseUrl);
        else postgresIdentitySha256(config.databaseUrl);
      } catch {
        throw new Error('PostgreSQL storage requires a valid databaseUrl identity');
      }
      if (typeof poolFactory !== 'function') throw new Error('PostgreSQL storage requires poolFactory');
    }
  }

  if (!suppliedMediaStore) {
    if (config.mediaDriver === 'local' && !nonempty(config.localMediaPath)) {
      throw new Error('Local media storage requires localMediaPath');
    }
    if (config.mediaDriver === 'azure-blob') {
      if (!CONTAINER.test(config.mediaContainer ?? '')) {
        throw new Error('Azure Blob storage requires a valid private container name');
      }
      const connectionMode = nonempty(config.mediaConnectionString);
      const identityMode = validAccountUrl(config.mediaAccountUrl);
      if (connectionMode === identityMode) {
        throw new Error('Azure Blob storage requires exactly one explicit auth mode');
      }
      try {
        blobIdentitySha256({
          connectionString: connectionMode ? config.mediaConnectionString : undefined,
          accountUrl: identityMode ? config.mediaAccountUrl : undefined,
          container: config.mediaContainer,
        });
      } catch {
        throw new Error('Azure Blob storage requires a valid identity');
      }
    }
  }
}

function defaultPoolFactory(options) {
  return new Pool(options);
}

async function closeReverse(resources, { suppress = false, timeoutMs } = {}) {
  let firstError = null;
  const deadlineAt = timeoutMs === undefined ? null : Date.now() + timeoutMs;
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    let work;
    try {
      work = Promise.resolve(resources[index].close());
    } catch (error) {
      firstError ??= error;
      continue;
    }
    if (deadlineAt === null) {
      try { await work; } catch (error) { firstError ??= error; }
      continue;
    }
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    if (remainingMs === 0) {
      void work.catch(() => undefined);
      continue;
    }
    let timer;
    const outcome = await Promise.race([
      work.then(
        () => ({ settled: true }),
        (error) => ({ settled: true, error }),
      ),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ settled: false }), remainingMs);
      }),
    ]);
    clearTimeout(timer);
    if (outcome.error) {
      firstError ??= outcome.error;
    }
  }
  if (firstError && !suppress) throw firstError;
}

function idempotentClose(resources) {
  let closePromise = null;
  return () => {
    closePromise ??= closeReverse(resources);
    return closePromise;
  };
}

async function createStore({ config, poolFactory }) {
  if (config.storeDriver === 'atomic-file') {
    return new AtomicFileStore({ filePath: config.atomicFilePath });
  }
  const pool = await poolFactory({
    connectionString: config.databaseUrl,
    options: '-c search_path=public',
    connectionTimeoutMillis: boundedRuntimeTimeout(config.postgresConnectionTimeoutMs, 5_000, 30_000),
    query_timeout: boundedRuntimeTimeout(config.postgresQueryTimeoutMs, 10_000, 30_000),
    statement_timeout: boundedRuntimeTimeout(config.postgresStatementTimeoutMs, 10_000, 30_000),
  });
  try {
    return new PostgresStore({ pool, ownsPool: true });
  } catch (error) {
    try { await pool?.end?.(); } catch { /* preserve the wrapper construction failure */ }
    throw error;
  }
}

function createMediaStore({ config, azureCredential }) {
  if (config.mediaDriver === 'local') {
    return new LocalMediaStore({ rootDirectory: config.localMediaPath });
  }
  return new AzureBlobMediaStore({
    containerName: config.mediaContainer,
    connectionString: config.mediaConnectionString,
    accountUrl: config.mediaAccountUrl,
    credential: config.mediaAccountUrl
      ? (azureCredential ?? new DefaultAzureCredential())
      : undefined,
  });
}

export async function createStorageRuntime({
  config,
  store: suppliedStore,
  mediaStore: suppliedMediaStore,
  poolFactory = defaultPoolFactory,
  azureCredential,
} = {}) {
  validateConfig({ config, suppliedStore, suppliedMediaStore, poolFactory });
  const initTimeoutMs = boundedRuntimeTimeout(config.dependencyInitTimeoutMs, 10_000, 30_000);
  const initialized = [];
  try {
    const store = suppliedStore ?? await createStore({ config, poolFactory });
    requireAdapter(store, 'Store');
    initialized.push(store);
    await withDependencyInitDeadline((signal) => store.init({ signal }), initTimeoutMs);

    const mediaStore = suppliedMediaStore ?? createMediaStore({ config, azureCredential });
    requireAdapter(mediaStore, 'Media store');
    initialized.push(mediaStore);
    await withDependencyInitDeadline((signal) => mediaStore.init({ signal }), initTimeoutMs);

    return {
      store,
      mediaStore,
      close: idempotentClose(initialized),
    };
  } catch (error) {
    await closeReverse(initialized, { suppress: true, timeoutMs: initTimeoutMs });
    throw error;
  }
}
