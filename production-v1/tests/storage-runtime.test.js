import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStorageRuntime } from '../src/services/storage-runtime.js';
import { AtomicFileStore } from '../src/stores/atomic-file-store.js';
import { AzureBlobMediaStore } from '../src/stores/azure-blob-media-store.js';
import { GcsMediaStore } from '../src/stores/gcs-media-store.js';
import { LocalMediaStore } from '../src/stores/local-media-store.js';
import { PostgresStore } from '../src/stores/postgres-store.js';

function localConfig(directory, overrides = {}) {
  return {
    nodeEnv: 'development',
    storeDriver: 'atomic-file',
    atomicFilePath: join(directory, 'store.json'),
    databaseUrl: null,
    mediaDriver: 'local',
    localMediaPath: join(directory, 'media'),
    mediaContainer: null,
    mediaConnectionString: null,
    mediaAccountUrl: null,
    ...overrides,
  };
}

function productionConfig(overrides = {}) {
  return {
    nodeEnv: 'production',
    storeDriver: 'postgres',
    databaseUrl: 'postgresql://v1-db.example.test/campus?sslmode=require',
    mediaDriver: 'gcs',
    gcsProjectId: 'motion-expert-hk-ltd-webpage',
    gcsBucket: 'hkbuddy-v1-582852715831-media',
    gcsResourceId: '//storage.googleapis.com/projects/_/buckets/hkbuddy-v1-582852715831-media',
    dependencyInitTimeoutMs: 1_000,
    postgresConnectionTimeoutMs: 1_600,
    postgresQueryTimeoutMs: 2_600,
    postgresStatementTimeoutMs: 2_200,
    ...overrides,
  };
}

function lifecycleAdapter(log, name, { initError, closeError } = {}) {
  return {
    async init() {
      log.push(`${name}.init`);
      if (initError) throw initError;
    },
    async close() {
      log.push(`${name}.close`);
      if (closeError) throw closeError;
    },
  };
}

function settleWithin(promise, timeoutMs, message) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

test('atomic-file plus local creates and initializes only the local adapters', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'storage-runtime-local-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let poolFactoryCalls = 0;

  const runtime = await createStorageRuntime({
    config: localConfig(directory),
    poolFactory: () => { poolFactoryCalls += 1; throw new Error('must not create PostgreSQL'); },
  });

  assert.equal(runtime.store instanceof AtomicFileStore, true);
  assert.equal(runtime.mediaStore instanceof LocalMediaStore, true);
  assert.equal(await runtime.store.getSessionByTokenHash('missing-token'), null,
    'the atomic store must be initialized before return');
  assert.equal(poolFactoryCalls, 0);
  await runtime.close();
});

test('postgres plus GCS initializes the store first through the injected ADC storage seam', async (t) => {
  const log = [];
  const databaseUrl = 'postgresql://v1-db.example.test/campus?sslmode=require';
  const bucket = { name: 'hkbuddy-v1-582852715831-media' };
  const gcsStorage = {
    bucket(name) {
      assert.equal(name, 'hkbuddy-v1-582852715831-media');
      return bucket;
    },
  };
  const client = {
    async query(config) {
      log.push('store.init');
      assert.match(config.text, /schema_migrations/i);
      assert.deepEqual(config.values, [1]);
      assert.equal(config.signal instanceof AbortSignal, true);
      return { rowCount: 1, rows: [{ version: 1 }] };
    },
    release(error) { assert.equal(error, undefined); },
  };
  const pool = {
    async query() { throw new Error('cancellable initialization must own its pg client'); },
    async connect() { return client; },
    async end() { log.push('store.close'); },
  };
  const originalInit = GcsMediaStore.prototype.init;
  const originalClose = GcsMediaStore.prototype.close;
  GcsMediaStore.prototype.init = async function initWithoutNetwork() { log.push('media.init'); };
  GcsMediaStore.prototype.close = async function closeWithoutNetwork() { log.push('media.close'); };
  t.after(() => {
    GcsMediaStore.prototype.init = originalInit;
    GcsMediaStore.prototype.close = originalClose;
  });

  const runtime = await createStorageRuntime({
    config: productionConfig({ databaseUrl }),
    poolFactory: (options) => {
      log.push('pool.create');
      assert.deepEqual(options, {
        connectionString: databaseUrl,
        options: '-c search_path=public',
        connectionTimeoutMillis: 1_600,
        query_timeout: 2_600,
        statement_timeout: 2_200,
      });
      return pool;
    },
    gcsStorage,
  });

  assert.equal(runtime.store instanceof PostgresStore, true);
  assert.equal(runtime.mediaStore instanceof GcsMediaStore, true);
  assert.equal(runtime.mediaStore.projectId, 'motion-expert-hk-ltd-webpage');
  assert.equal(runtime.mediaStore.bucketName, 'hkbuddy-v1-582852715831-media');
  assert.equal(runtime.mediaStore.bucket, bucket);
  assert.deepEqual(log, ['pool.create', 'store.init', 'media.init']);
  await runtime.close();
  assert.deepEqual(log, [
    'pool.create', 'store.init', 'media.init', 'media.close', 'store.close',
  ]);
});

test('PostgreSQL URL overrides and insecure transport fail before pool construction', async () => {
  for (const query of [
    'options=-c%20search_path%3Dlegacy',
    'host=legacy-db.example.test',
    'port=6543',
    'sslmode=disable',
    'sslmode=no-verify',
    'sslmode=prefer',
  ]) {
    let poolFactoryCalls = 0;
    await assert.rejects(createStorageRuntime({
      config: productionConfig({
        databaseUrl: `postgresql://v1-db.example.test/campus?${query}`,
      }),
      poolFactory: () => {
        poolFactoryCalls += 1;
        throw new Error('pool must not be constructed');
      },
    }), /PostgreSQL.+databaseUrl|identity/i, query);
    assert.equal(poolFactoryCalls, 0, query);
  }
});

test('production PostgreSQL requires an explicit secure TLS mode before pool construction', async () => {
  let poolFactoryCalls = 0;

  await assert.rejects(createStorageRuntime({
    config: productionConfig({
      databaseUrl: 'postgresql://v1-db.example.test/campus',
    }),
    poolFactory: () => {
      poolFactoryCalls += 1;
      throw new Error('pool must not be constructed');
    },
  }), /PostgreSQL.+databaseUrl|secure.+sslmode|TLS/i);

  assert.equal(poolFactoryCalls, 0);
});

test('wrong GCS project, bucket, or full resource identity fails before PostgreSQL or GCS construction', async () => {
  const cases = [
    productionConfig({ gcsProjectId: 'hkbuddy-prod-v1-20260826' }),
    productionConfig({ gcsBucket: 'hkbuddy-prod-v1-20260826-media' }),
    productionConfig({ gcsResourceId: 'projects/_/buckets/hkbuddy-v1-582852715831-media' }),
  ];
  for (const config of cases) {
    let poolFactoryCalls = 0;
    await assert.rejects(createStorageRuntime({
      config,
      poolFactory: () => {
        poolFactoryCalls += 1;
        throw new Error('pool must not be constructed');
      },
    }), /GCS.+identity|project|bucket|resource/i);
    assert.equal(poolFactoryCalls, 0);
  }
});

test('supplied adapters keep existing test seams and close once in reverse order', async () => {
  const log = [];
  const store = lifecycleAdapter(log, 'store');
  const mediaStore = lifecycleAdapter(log, 'media');
  const runtime = await createStorageRuntime({
    config: localConfig('C:/injected-runtime'),
    store,
    mediaStore,
    poolFactory: () => { throw new Error('injected store must bypass PostgreSQL'); },
  });

  assert.equal(runtime.store, store);
  assert.equal(runtime.mediaStore, mediaStore);
  assert.deepEqual(log, ['store.init', 'media.init']);
  await Promise.all([runtime.close(), runtime.close(), runtime.close()]);
  assert.deepEqual(log, ['store.init', 'media.init', 'media.close', 'store.close']);
});

test('production rejects either wrong driver before any adapter initialization or connection', async () => {
  for (const config of [
    productionConfig({ storeDriver: 'atomic-file' }),
    productionConfig({ mediaDriver: 'local' }),
  ]) {
    const log = [];
    let poolFactoryCalls = 0;
    await assert.rejects(createStorageRuntime({
      config,
      store: lifecycleAdapter(log, 'store'),
      mediaStore: lifecycleAdapter(log, 'media'),
      poolFactory: () => { poolFactoryCalls += 1; throw new Error('must not connect'); },
    }), /production.+postgres.+gcs/i);
    assert.deepEqual(log, []);
    assert.equal(poolFactoryCalls, 0);
  }
});

test('unknown drivers fail closed instead of falling back to a local adapter', async () => {
  const directory = 'C:/invalid-runtime';
  for (const config of [
    localConfig(directory, { storeDriver: 'sqlite' }),
    localConfig(directory, { mediaDriver: 's3' }),
  ]) {
    const log = [];
    await assert.rejects(createStorageRuntime({
      config,
      store: lifecycleAdapter(log, 'store'),
      mediaStore: lifecycleAdapter(log, 'media'),
    }), /driver.+not available/i);
    assert.deepEqual(log, []);
  }
});

test('a failed media initialization closes attempted resources in reverse order and preserves the cause', async () => {
  const log = [];
  const failure = new Error('media initialization failed');
  const cleanupFailure = new Error('media cleanup failed');

  await assert.rejects(createStorageRuntime({
    config: localConfig('C:/failed-runtime'),
    store: lifecycleAdapter(log, 'store'),
    mediaStore: lifecycleAdapter(log, 'media', { initError: failure, closeError: cleanupFailure }),
  }), (error) => error === failure);

  assert.deepEqual(log, ['store.init', 'media.init', 'media.close', 'store.close']);
});

test('a failed store initialization closes only that attempted store', async () => {
  const log = [];
  const failure = new Error('store initialization failed');

  await assert.rejects(createStorageRuntime({
    config: localConfig('C:/failed-runtime'),
    store: lifecycleAdapter(log, 'store', { initError: failure }),
    mediaStore: lifecycleAdapter(log, 'media'),
  }), (error) => error === failure);

  assert.deepEqual(log, ['store.init', 'store.close']);
});

test('a never-settling store initialization times out and closes the attempted store', async () => {
  const log = [];
  const store = lifecycleAdapter(log, 'store');
  store.init = () => {
    log.push('store.init');
    return new Promise(() => undefined);
  };

  await assert.rejects(settleWithin(createStorageRuntime({
    config: localConfig('C:/stalled-store-runtime', { dependencyInitTimeoutMs: 10 }),
    store,
    mediaStore: lifecycleAdapter(log, 'media'),
  }), 200, 'store initialization was not bounded'), (error) => error?.code === 'DEPENDENCY_INIT_TIMEOUT');

  assert.deepEqual(log, ['store.init', 'store.close']);
});

test('a never-settling media initialization times out and closes both attempted adapters in reverse order', async () => {
  const log = [];
  const mediaStore = lifecycleAdapter(log, 'media');
  mediaStore.init = () => {
    log.push('media.init');
    return new Promise(() => undefined);
  };

  await assert.rejects(settleWithin(createStorageRuntime({
    config: localConfig('C:/stalled-media-runtime', { dependencyInitTimeoutMs: 10 }),
    store: lifecycleAdapter(log, 'store'),
    mediaStore,
  }), 200, 'media initialization was not bounded'), (error) => error?.code === 'DEPENDENCY_INIT_TIMEOUT');

  assert.deepEqual(log, ['store.init', 'media.init', 'media.close', 'store.close']);
});

test('a timed-out Azure initialization is aborted and cannot begin its second SDK request after a late resolution', async () => {
  let resolveProperties;
  let observedSignal = null;
  let accessPolicyCalls = 0;
  const mediaStore = new AzureBlobMediaStore({
    containerName: 'private-v1-media',
    containerClient: {
      getProperties(options) {
        observedSignal = options?.abortSignal ?? null;
        return new Promise((resolve) => { resolveProperties = resolve; });
      },
      async getAccessPolicy() {
        accessPolicyCalls += 1;
        return { blobPublicAccess: undefined };
      },
    },
  });

  await assert.rejects(settleWithin(createStorageRuntime({
    config: localConfig('C:/aborted-azure-init', { dependencyInitTimeoutMs: 10 }),
    store: lifecycleAdapter([], 'store'),
    mediaStore,
  }), 200, 'Azure initialization was not deadline-bounded'), (error) => error?.code === 'DEPENDENCY_INIT_TIMEOUT');

  assert.equal(observedSignal?.aborted, true, 'the in-flight SDK request receives an aborted signal');
  resolveProperties({ etag: 'late-success' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(accessPolicyCalls, 0, 'late completion cannot begin another SDK request');
});

test('Azure healthCheck forwards cancellation and cannot start its second SDK request after abort', async () => {
  let observedSignal = null;
  let accessPolicyCalls = 0;
  const mediaStore = new AzureBlobMediaStore({
    containerName: 'private-v1-media',
    containerClient: {
      getProperties({ abortSignal } = {}) {
        observedSignal = abortSignal;
        return new Promise((resolve, reject) => {
          void resolve;
          abortSignal?.addEventListener('abort', () => reject(new Error('private aborted SDK request')), { once: true });
        });
      },
      async getAccessPolicy() {
        accessPolicyCalls += 1;
        return { blobPublicAccess: undefined };
      },
    },
  });
  const controller = new AbortController();

  const checking = mediaStore.healthCheck({ signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(settleWithin(checking, 200, 'Azure health check ignored cancellation'), (error) => (
    error?.code === 'MEDIA_OPERATION_ABORTED'
  ));

  assert.equal(observedSignal, controller.signal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(accessPolicyCalls, 0);
});

test('initialization timeout cleanup is bounded and still attempts older resources after a stalled close', async () => {
  const log = [];
  const mediaStore = lifecycleAdapter(log, 'media');
  mediaStore.init = () => {
    log.push('media.init');
    return new Promise(() => undefined);
  };
  mediaStore.close = () => {
    log.push('media.close:pending');
    return new Promise(() => undefined);
  };

  await assert.rejects(settleWithin(createStorageRuntime({
    config: localConfig('C:/stalled-init-cleanup', { dependencyInitTimeoutMs: 10 }),
    store: lifecycleAdapter(log, 'store'),
    mediaStore,
  }), 200, 'initialization cleanup was not deadline-bounded'), (error) => error?.code === 'DEPENDENCY_INIT_TIMEOUT');

  assert.deepEqual(log, [
    'store.init', 'media.init', 'media.close:pending', 'store.close',
  ]);
});

test('normal close still attempts the store when media close fails and remains idempotent', async () => {
  const log = [];
  const failure = new Error('media close failed');
  const runtime = await createStorageRuntime({
    config: localConfig('C:/failed-close-runtime'),
    store: lifecycleAdapter(log, 'store'),
    mediaStore: lifecycleAdapter(log, 'media', { closeError: failure }),
  });

  await assert.rejects(runtime.close(), (error) => error === failure);
  await assert.rejects(runtime.close(), (error) => error === failure);
  assert.deepEqual(log, ['store.init', 'media.init', 'media.close', 'store.close']);
});

test('a malformed injected PostgreSQL pool is closed before the wrapper error escapes', async () => {
  const log = [];
  const pool = { async end() { log.push('pool.close'); } };

  await assert.rejects(createStorageRuntime({
    config: localConfig('C:/invalid-pool-runtime', {
      storeDriver: 'postgres', databaseUrl: 'postgresql://localhost/v1',
    }),
    poolFactory: () => pool,
    mediaStore: lifecycleAdapter(log, 'media'),
  }), /requires a PostgreSQL pool/i);

  assert.deepEqual(log, ['pool.close']);
});
