const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,79}$/i;

function result(name, ready, versionKey = 'version', version = null) {
  const output = {
    name,
    status: ready ? 'ready' : 'not-ready',
    healthy: ready,
  };
  if (ready && typeof version === 'string' && SAFE_VERSION.test(version)) output[versionKey] = version;
  return output;
}

async function safely(name, operation) {
  try { return await operation(); } catch { return result(name, false); }
}

export function createRuntimeReadinessChecks({
  config,
  store,
  mediaStore,
  corpus,
  retentionWorker,
  dispatcher,
  instanceLock,
  runtimeState,
} = {}) {
  return {
    database: ({ signal } = {}) => safely('database', async () => {
      if (typeof store?.healthCheck !== 'function') return result('database', false);
      if (signal?.aborted) return result('database', false);
      const health = await store.healthCheck({ signal });
      if (signal?.aborted) return result('database', false);
      return result('database', health?.ok === true && health?.driver === 'postgres', 'version', 'postgres-v1');
    }),
    media: ({ signal } = {}) => safely('media', async () => {
      if (typeof mediaStore?.healthCheck !== 'function') return result('media', false);
      if (signal?.aborted) return result('media', false);
      const health = await mediaStore.healthCheck({ signal });
      if (signal?.aborted) return result('media', false);
      return result(
        'media',
        health?.ok === true && health?.driver === 'azure-blob' && health?.private === true,
        'version',
        'azure-blob-v1',
      );
    }),
    corpus: () => safely('corpus', async () => {
      const snapshotAt = new Date(corpus?.snapshotAt).getTime();
      const ready = SAFE_VERSION.test(corpus?.schemaVersion ?? '')
        && Number.isFinite(snapshotAt)
        && Array.isArray(corpus?.sources)
        && corpus.sources.length > 0;
      return result('corpus', ready, 'version', corpus?.schemaVersion);
    }),
    retention: ({ signal } = {}) => safely('retention', async () => {
      if (typeof retentionWorker?.readiness !== 'function') return result('retention', false);
      if (signal?.aborted) return result('retention', false);
      const state = await retentionWorker.readiness({ signal });
      if (signal?.aborted) return result('retention', false);
      const ready = state?.status === 'ready' && state?.healthy === true;
      return result('retention', ready, 'policyVersion', state?.policyVersion);
    }),
    dispatcher: ({ signal } = {}) => safely('dispatcher', async () => {
      if (typeof dispatcher?.readiness !== 'function') return result('dispatcher', false);
      if (signal?.aborted) return result('dispatcher', false);
      if (typeof dispatcher.probe === 'function') await dispatcher.probe({ signal });
      if (signal?.aborted) return result('dispatcher', false);
      const state = await dispatcher.readiness();
      const ready = state?.status === 'ready' && state?.healthy === true;
      return result('dispatcher', ready, 'version', state?.version ?? 'dispatcher-v1');
    }),
    runtime: ({ allowPausedRuntime = false, signal } = {}) => safely('runtime', async () => {
      if (signal?.aborted
        || typeof instanceLock?.isOwned !== 'function'
        || typeof instanceLock?.healthCheck !== 'function') {
        return result('runtime', false);
      }
      const lockHealth = await instanceLock.healthCheck({ signal });
      if (signal?.aborted) return result('runtime', false);
      return result(
        'runtime',
        config?.nodeEnv === 'production'
        && config?.productionConfigurationReady === true
        && config?.storeDriver === 'postgres'
        && config?.mediaDriver === 'azure-blob'
        && (runtimeState?.accepting === true
          || (allowPausedRuntime === true && runtimeState?.recoverable === true))
        && runtimeState?.instancePolicy === 'single'
        && runtimeState?.instanceLockOwned === true
        && instanceLock.isOwned() === true
        && lockHealth?.owned === true,
        'version',
        'single-instance-v1',
      );
    }),
  };
}
