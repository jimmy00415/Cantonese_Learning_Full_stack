import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import test from 'node:test';

import {
  blobIdentitySha256,
  finalizeReleaseEvidenceRecord,
  postgresIdentitySha256,
  validateDependencyAcceptanceEvidence,
} from '../src/services/release-evidence.js';
import {
  createRealAcceptanceRuntime,
  runRealDependencyAcceptance,
} from '../scripts/real-dependencies-acceptance.js';
import * as acceptanceCli from '../scripts/real-dependencies-acceptance.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const COMMIT = '1'.repeat(40);
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const SCHEMA = `v1_accept_${RUN_ID.replaceAll('-', '')}`;
const BLOB_PREFIX = `v1-accept/${RUN_ID}/`;
const INVENTORY_FILE = resolve('approved-legacy-inventory.json');
const CWD = resolve('..');
const DATABASE_URL = 'postgresql://v1-user:private-password@v1-db.postgres.database.azure.com:5432/hkbu_buddy?sslmode=require';
const BLOB_ACCOUNT_URL = 'https://v1buddyblob.blob.core.windows.net/';
const BLOB_CONTAINER = 'private-v1-media';
const POSTGRES_RESOURCE_ID = '/subscriptions/new-sub/resourceGroups/v1-rg/providers/Microsoft.DBforPostgreSQL/flexibleServers/v1-db';
const BLOB_RESOURCE_ID = '/subscriptions/new-sub/resourceGroups/v1-rg/providers/Microsoft.Storage/storageAccounts/v1buddyblob';

function legacyInventory(overrides = {}) {
  return finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: COMMIT,
    legacyApplicationIds: ['hkbuddy-pilot-0630'],
    legacyOrigins: ['https://hkbuddy-pilot-0630.azurewebsites.net'],
    postgresResources: [],
    blobResources: [],
    declaresNoLegacyPostgres: true,
    declaresNoLegacyBlob: true,
    reviewedAt: NOW.toISOString(),
    result: true,
    ...overrides,
  });
}

function validEnvironment(inventory = legacyInventory()) {
  return {
    V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'true',
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_ACCEPTANCE_DATABASE_URL: DATABASE_URL,
    V1_ACCEPTANCE_BLOB_ACCOUNT_URL: BLOB_ACCOUNT_URL,
    V1_ACCEPTANCE_BLOB_CONTAINER: BLOB_CONTAINER,
    V1_ACCEPTANCE_SCHEMA: SCHEMA,
    V1_ACCEPTANCE_BLOB_PREFIX: BLOB_PREFIX,
    V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    V1_ACCEPTANCE_BLOB_RESOURCE_ID: BLOB_RESOURCE_ID,
    V1_DATABASE_URL: DATABASE_URL,
    V1_POSTGRES_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    V1_BLOB_ACCOUNT_URL: BLOB_ACCOUNT_URL,
    V1_BLOB_CONTAINER: BLOB_CONTAINER,
    V1_BLOB_RESOURCE_ID: BLOB_RESOURCE_ID,
    V1_LEGACY_RESOURCE_INVENTORY_FILE: INVENTORY_FILE,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: inventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
  };
}

async function flushAsyncWork() {
  for (let index = 0; index < 4; index += 1) {
    await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
    await Promise.resolve();
  }
}

function observeSettlement(promise) {
  const observation = { settled: false, status: null, value: null, error: null };
  promise.then(
    (value) => Object.assign(observation, { settled: true, status: 'fulfilled', value }),
    (error) => Object.assign(observation, { settled: true, status: 'rejected', error }),
  );
  return observation;
}

function instrumentedRun(overrides = {}) {
  const inventory = overrides.inventory ?? legacyInventory();
  const calls = [];
  const output = [];
  const artifacts = [];
  const runtimeOverrides = overrides.runtime ?? {};
  const runtime = {
    async runChecks(...args) {
      calls.push(['run']);
      if (runtimeOverrides.runChecks) return runtimeOverrides.runChecks.call(runtime, ...args);
      return [
        { name: 'postgres-migration-health', status: 'pass', latencyMs: 1 },
        { name: 'postgres-concurrency-recovery', status: 'pass', latencyMs: 2 },
        { name: 'postgres-integrity-events', status: 'pass', latencyMs: 3 },
        { name: 'postgres-rate-window-fencing', status: 'pass', latencyMs: 4 },
        { name: 'blob-private-full-range-head', status: 'pass', latencyMs: 5 },
        { name: 'postgres-media-fencing', status: 'pass', latencyMs: 6 },
      ];
    },
    async cleanupBlobPrefix(prefix, ...args) {
      calls.push(['blob-cleanup', prefix]);
      if (runtimeOverrides.cleanupBlobPrefix) {
        return runtimeOverrides.cleanupBlobPrefix.call(runtime, prefix, ...args);
      }
      return 0;
    },
    async dropSchema(schema, ...args) {
      calls.push(['schema-cleanup', schema]);
      if (runtimeOverrides.dropSchema) return runtimeOverrides.dropSchema.call(runtime, schema, ...args);
      return true;
    },
    async close(...args) {
      calls.push(['close']);
      if (runtimeOverrides.close) return runtimeOverrides.close.call(runtime, ...args);
    },
  };
  const options = {
    argv: [],
    environment: validEnvironment(inventory),
    cwd: CWD,
    now: () => NOW,
    readTextFile: async (filePath) => {
      calls.push(['read', filePath]);
      return JSON.stringify(inventory);
    },
    inspectGit: async (cwd) => {
      calls.push(['git', cwd]);
      return { head: COMMIT, clean: true };
    },
    openDependencies: async (input) => {
      calls.push(['open', input]);
      return runtime;
    },
    writeArtifact: async (input) => {
      calls.push(['write', input.filePath]);
      artifacts.push(input);
    },
    writeOutput: (line) => output.push(line),
    ...overrides,
  };
  delete options.inventory;
  delete options.runtime;
  return {
    calls,
    output,
    artifacts,
    run: () => runRealDependencyAcceptance(options),
  };
}

test('command is inert without the exact ephemeral confirmation and no command arguments', async (t) => {
  const cases = [
    ['missing confirmation', { V1_ACCEPTANCE_CONFIRM_EPHEMERAL: undefined }, []],
    ['false confirmation', { V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'false' }, []],
    ['case-varied confirmation', { V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'TRUE' }, []],
    ['unexpected argument', {}, ['--force']],
  ];

  for (const [name, environmentPatch, argv] of cases) {
    await t.test(name, async () => {
      const environment = { ...validEnvironment(), ...environmentPatch };
      const fixture = instrumentedRun({ environment, argv });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.status, 'not-run');
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.artifacts.length, 0);
    });
  }
});

test('missing or malformed frozen commit fails before evidence, git, or dependency access', async (t) => {
  for (const commit of [undefined, '', 'A'.repeat(40), '1'.repeat(39), 'release-v1']) {
    await t.test(String(commit), async () => {
      const fixture = instrumentedRun({
        environment: { ...validEnvironment(), V1_RELEASE_COMMIT_SHA: commit },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'RELEASE_COMMIT_INVALID');
      assert.deepEqual(fixture.calls, []);
    });
  }
});

test('all isolated and intended V1 settings are mandatory and malformed input never opens dependencies', async (t) => {
  const cases = [
    ['acceptance database', 'V1_ACCEPTANCE_DATABASE_URL', undefined],
    ['acceptance blob auth', 'V1_ACCEPTANCE_BLOB_ACCOUNT_URL', undefined],
    ['acceptance container', 'V1_ACCEPTANCE_BLOB_CONTAINER', undefined],
    ['acceptance postgres resource', 'V1_ACCEPTANCE_POSTGRES_RESOURCE_ID', undefined],
    ['acceptance blob resource', 'V1_ACCEPTANCE_BLOB_RESOURCE_ID', undefined],
    ['intended database', 'V1_DATABASE_URL', undefined],
    ['intended postgres resource', 'V1_POSTGRES_RESOURCE_ID', undefined],
    ['intended blob auth', 'V1_BLOB_ACCOUNT_URL', undefined],
    ['intended container', 'V1_BLOB_CONTAINER', undefined],
    ['intended blob resource', 'V1_BLOB_RESOURCE_ID', undefined],
    ['inventory file', 'V1_LEGACY_RESOURCE_INVENTORY_FILE', 'relative.json'],
    ['inventory digest', 'V1_LEGACY_RESOURCE_INVENTORY_VERSION', 'A'.repeat(64)],
    ['inventory approval', 'V1_LEGACY_RESOURCE_INVENTORY_APPROVED', 'false'],
  ];

  for (const [name, key, value] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), [key]: value } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.status, 'not-run');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
      assert.equal(fixture.artifacts.length, 0);
    });
  }
});

test('acceptance and production identities must be exact matches on the intended physical resources', async (t) => {
  const cases = [
    ['database URL differs', { V1_ACCEPTANCE_DATABASE_URL: DATABASE_URL.replace('v1-user', 'other-user') }],
    ['postgres resource differs', { V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: `${POSTGRES_RESOURCE_ID}-other` }],
    ['blob host differs', { V1_ACCEPTANCE_BLOB_ACCOUNT_URL: 'https://otherblob.blob.core.windows.net/' }],
    ['blob container differs', { V1_ACCEPTANCE_BLOB_CONTAINER: 'other-private-media' }],
    ['blob resource differs', { V1_ACCEPTANCE_BLOB_RESOURCE_ID: `${BLOB_RESOURCE_ID}other` }],
    ['ambiguous acceptance blob auth', { V1_ACCEPTANCE_BLOB_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=v1buddyblob;EndpointSuffix=core.windows.net' }],
    ['ambiguous intended blob auth', { V1_BLOB_CONNECTION_STRING: 'DefaultEndpointsProtocol=https;AccountName=v1buddyblob;EndpointSuffix=core.windows.net' }],
    ['empty extra acceptance blob auth', { V1_ACCEPTANCE_BLOB_CONNECTION_STRING: '' }],
    ['empty extra intended blob auth', { V1_BLOB_CONNECTION_STRING: '' }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'RESOURCE_IDENTITY_MISMATCH');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
    });
  }
});

test('PostgreSQL URL overrides fail before evidence, git, or dependency construction', async (t) => {
  const hostOverride = `${DATABASE_URL}&host=legacy-db.example.test&port=6543`;
  const optionsOverride = `${DATABASE_URL}&options=-c%20search_path%3Dpublic`;
  const missingTlsMode = DATABASE_URL.replace('?sslmode=require', '');
  const cases = [
    ['V1 database override', {
      V1_DATABASE_URL: hostOverride,
      V1_ACCEPTANCE_DATABASE_URL: hostOverride,
    }],
    ['acceptance search_path override', {
      V1_ACCEPTANCE_DATABASE_URL: optionsOverride,
      V1_DATABASE_URL: optionsOverride,
    }],
    ['intended-only override', { V1_DATABASE_URL: hostOverride }],
    ['acceptance-only override', { V1_ACCEPTANCE_DATABASE_URL: optionsOverride }],
    ['both production URLs omit sslmode', {
      V1_DATABASE_URL: missingTlsMode,
      V1_ACCEPTANCE_DATABASE_URL: missingTlsMode,
    }],
    ['intended production URL omits sslmode', { V1_DATABASE_URL: missingTlsMode }],
    ['acceptance URL omits sslmode', { V1_ACCEPTANCE_DATABASE_URL: missingTlsMode }],
    ['legacy compatibility override', {
      DATABASE_URL: 'postgresql://legacy-user@legacy-db.example.test/legacy?host=v1-db.postgres.database.azure.com&port=5432&dbname=hkbu_buddy',
    }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.status, 'not-run');
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.artifacts.length, 0);
    });
  }
});

test('real runtime rejects PostgreSQL URL options or missing TLS mode before constructing dependencies', async () => {
  class ForbiddenPool {
    constructor() {
      throw new Error('pool must not be constructed');
    }
  }
  class ForbiddenBlobServiceClient {
    constructor() {
      throw new Error('Blob client must not be constructed');
    }
  }
  class FakeCredential {}

  for (const databaseUrl of [
    `${DATABASE_URL}&options=-c%20search_path%3Dpublic`,
    DATABASE_URL.replace('?sslmode=require', ''),
  ]) {
    let poolConstructions = 0;
    let blobConstructions = 0;
    class CountingForbiddenPool extends ForbiddenPool {
      constructor(options) {
        poolConstructions += 1;
        super(options);
      }
    }
    class CountingForbiddenBlobServiceClient extends ForbiddenBlobServiceClient {
      constructor(...args) {
        blobConstructions += 1;
        super(...args);
      }
    }

    await assert.rejects(createRealAcceptanceRuntime({
      databaseUrl,
      blob: { accountUrl: BLOB_ACCOUNT_URL },
      blobContainer: BLOB_CONTAINER,
      blobPrefix: BLOB_PREFIX,
      schema: SCHEMA,
      runId: RUN_ID,
      occurredAt: NOW.toISOString(),
      PoolClass: CountingForbiddenPool,
      BlobServiceClientClass: CountingForbiddenBlobServiceClient,
      DefaultAzureCredentialClass: FakeCredential,
    }), /configuration is invalid/i);
    assert.equal(poolConstructions, 0, databaseUrl);
    assert.equal(blobConstructions, 0, databaseUrl);
  }
});

test('resource IDs must identify the exact PostgreSQL and Storage Azure resource types', async (t) => {
  const cases = [
    ['storage account cannot stand in for PostgreSQL', {
      V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: BLOB_RESOURCE_ID,
      V1_POSTGRES_RESOURCE_ID: BLOB_RESOURCE_ID,
    }],
    ['PostgreSQL server cannot stand in for Blob Storage', {
      V1_ACCEPTANCE_BLOB_RESOURCE_ID: POSTGRES_RESOURCE_ID,
      V1_BLOB_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'CONFIGURATION_INVALID');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
    });
  }
});

test('schema and Blob prefix require the same isolated UUIDv4 run identity', async (t) => {
  const cases = [
    ['schema has uppercase', { V1_ACCEPTANCE_SCHEMA: SCHEMA.toUpperCase() }],
    ['schema is not isolated', { V1_ACCEPTANCE_SCHEMA: 'public' }],
    ['prefix is broad', { V1_ACCEPTANCE_BLOB_PREFIX: 'v1-accept/' }],
    ['prefix uses non-v4 UUID', { V1_ACCEPTANCE_BLOB_PREFIX: 'v1-accept/123e4567-e89b-12d3-a456-426614174000/' }],
    ['run identities differ', { V1_ACCEPTANCE_BLOB_PREFIX: 'v1-accept/123e4567-e89b-42d3-a456-426614174001/' }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'ISOLATION_SCOPE_INVALID');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
    });
  }
});

test('invalid, stale, unbound, or colliding owner inventory fails before git and dependency access', async (t) => {
  const postgresIdentity = postgresIdentitySha256(DATABASE_URL);
  const blobIdentity = blobIdentitySha256({ accountUrl: BLOB_ACCOUNT_URL, container: BLOB_CONTAINER });
  const cases = [
    ['malformed JSON', legacyInventory(), '{'],
    ['wrong commit', legacyInventory({ commitSha: '2'.repeat(40) })],
    ['stale review', legacyInventory({ reviewedAt: '2026-08-01T00:00:00.000Z' })],
    ['postgres id collision', legacyInventory({
      postgresResources: [{ resourceId: POSTGRES_RESOURCE_ID, identitySha256: 'a'.repeat(64) }],
      declaresNoLegacyPostgres: false,
    })],
    ['postgres id case-variant collision with different identity', legacyInventory({
      postgresResources: [{
        resourceId: POSTGRES_RESOURCE_ID.toUpperCase(),
        identitySha256: 'c'.repeat(64),
      }],
      declaresNoLegacyPostgres: false,
    })],
    ['postgres identity collision', legacyInventory({
      postgresResources: [{ resourceId: `${POSTGRES_RESOURCE_ID}-legacy`, identitySha256: postgresIdentity }],
      declaresNoLegacyPostgres: false,
    })],
    ['blob id collision', legacyInventory({
      blobResources: [{ resourceId: BLOB_RESOURCE_ID, identitySha256: 'b'.repeat(64) }],
      declaresNoLegacyBlob: false,
    })],
    ['blob id case-variant collision with different identity', legacyInventory({
      blobResources: [{
        resourceId: BLOB_RESOURCE_ID.toUpperCase(),
        identitySha256: 'd'.repeat(64),
      }],
      declaresNoLegacyBlob: false,
    })],
    ['blob identity collision', legacyInventory({
      blobResources: [{ resourceId: `${BLOB_RESOURCE_ID}legacy`, identitySha256: blobIdentity }],
      declaresNoLegacyBlob: false,
    })],
  ];

  for (const [name, inventory, raw] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({
        inventory,
        environment: validEnvironment(inventory),
        readTextFile: async (filePath) => {
          fixture.calls.push(['read', filePath]);
          return raw ?? JSON.stringify(inventory);
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.status, 'not-run');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read']);
    });
  }
});

test('legacy compatibility values are only defense-in-depth and matching or ambiguous values fail closed', async (t) => {
  const cases = [
    ['same legacy database', { DATABASE_URL }],
    ['malformed legacy database', { DATABASE_URL: 'private-not-a-url' }],
    ['same legacy blob', { AZURE_BLOB_ACCOUNT_URL: BLOB_ACCOUNT_URL, AZURE_BLOB_CONTAINER: BLOB_CONTAINER }],
    ['partial legacy blob', { AZURE_BLOB_CONTAINER: BLOB_CONTAINER }],
    ['empty extra legacy auth', {
      AZURE_STORAGE_CONNECTION_STRING: '',
      AZURE_BLOB_ACCOUNT_URL: 'https://legacy.blob.core.windows.net/',
      AZURE_BLOB_CONTAINER: 'legacy-media',
    }],
    ['ambiguous legacy blob container', {
      AZURE_BLOB_ACCOUNT_URL: 'https://legacy.blob.core.windows.net/',
      AZURE_BLOB_CONTAINER: 'legacy-one',
      AZURE_STORAGE_CONTAINER: 'legacy-two',
    }],
  ];

  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'LEGACY_COMPATIBILITY_COLLISION');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
    });
  }
});

test('clean HEAD must exactly equal the frozen commit before dependency access', async (t) => {
  for (const gitState of [
    { head: COMMIT, clean: false },
    { head: '2'.repeat(40), clean: true },
    { head: `${COMMIT}\n`, clean: true },
  ]) {
    await t.test(JSON.stringify(gitState), async () => {
      const fixture = instrumentedRun({
        inspectGit: async (cwd) => {
          fixture.calls.push(['git', cwd]);
          return gitState;
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'RELEASE_GIT_STATE_INVALID');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read', 'git']);
    });
  }
});

test('valid run opens only after evidence and git checks, cleans both scopes in finally, and writes safe evidence', async () => {
  const fixture = instrumentedRun();
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.calls.map(([kind]) => kind), [
    'read', 'git', 'open', 'run', 'blob-cleanup', 'schema-cleanup', 'close', 'git', 'write',
  ]);
  assert.equal(fixture.artifacts.length, 1);
  const { record, contents } = fixture.artifacts[0];
  assert.deepEqual(Object.keys(record).sort(), [
    'artifactSha256', 'blobIdentitySha256', 'blobPrefix', 'blobPrefixObjectCount',
    'blobResourceId', 'checks', 'commitSha', 'legacyInventoryDigest', 'occurredAt',
    'postgresIdentitySha256', 'postgresResourceId', 'result', 'schema',
    'schemaAbsent', 'schemaVersion',
  ]);
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.schema, SCHEMA);
  assert.equal(record.blobPrefix, BLOB_PREFIX);
  assert.equal(record.postgresResourceId, POSTGRES_RESOURCE_ID);
  assert.equal(record.postgresIdentitySha256, postgresIdentitySha256(DATABASE_URL));
  assert.equal(record.blobResourceId, BLOB_RESOURCE_ID);
  assert.equal(record.blobIdentitySha256, blobIdentitySha256({ accountUrl: BLOB_ACCOUNT_URL, container: BLOB_CONTAINER }));
  assert.equal(record.schemaAbsent, true);
  assert.equal(record.blobPrefixObjectCount, 0);
  assert.equal(record.result, true);
  assert.match(record.artifactSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.parse(contents).artifactSha256, record.artifactSha256);
  assert.equal(validateDependencyAcceptanceEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha: COMMIT,
    inventory: legacyInventory(),
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: postgresIdentitySha256(DATABASE_URL),
    blobResourceId: BLOB_RESOURCE_ID,
    blobIdentitySha256: blobIdentitySha256({ accountUrl: BLOB_ACCOUNT_URL, container: BLOB_CONTAINER }),
    now: NOW,
  }).valid, true);

  const serialized = `${fixture.output.join('')}\n${contents}`;
  for (const secret of [DATABASE_URL, 'private-password', BLOB_ACCOUNT_URL, INVENTORY_FILE]) {
    assert.equal(serialized.includes(secret), false);
  }
  assert.deepEqual(result.publicReport, {
    status: 'recorded',
    code: 'DEPENDENCY_ACCEPTANCE_RECORDED',
    artifactSha256: record.artifactSha256,
    checks: record.checks,
    cleanup: {
      schemaAbsent: true,
      blobPrefixObjectCount: 0,
    },
  });

  const opened = fixture.calls.find(([kind]) => kind === 'open')[1];
  assert.equal(opened.schema, SCHEMA);
  assert.equal(opened.blobPrefix, BLOB_PREFIX);
  assert.equal(opened.databaseUrl, DATABASE_URL);
  assert.equal(opened.blob.accountUrl, BLOB_ACCOUNT_URL);
});

test('success is rebound to the frozen clean Git state after cleanup and before artifact write', async (t) => {
  const finalStates = [
    { head: COMMIT, clean: false },
    { head: '2'.repeat(40), clean: true },
    new Error('private final Git failure'),
  ];
  for (const finalState of finalStates) {
    await t.test(finalState instanceof Error ? 'inspection failure' : JSON.stringify(finalState), async () => {
      let inspections = 0;
      const fixture = instrumentedRun({
        inspectGit: async (cwd) => {
          fixture.calls.push(['git', cwd]);
          inspections += 1;
          if (inspections === 1) return { head: COMMIT, clean: true };
          if (finalState instanceof Error) throw finalState;
          return finalState;
        },
      });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
      assert.deepEqual(fixture.calls.map(([kind]) => kind), [
        'read', 'git', 'open', 'run', 'blob-cleanup', 'schema-cleanup', 'close', 'git', 'write',
      ]);
      assert.equal(fixture.artifacts[0].record.result, false);
      assert.equal(fixture.output.join('').includes('private final Git failure'), false);
    });
  }
});

test('outbox recovery constructs a fresh store and drains only durable post-restart jobs', async () => {
  assert.equal(typeof acceptanceCli.drainRestartedMediaDeletionOutbox, 'function');
  const events = [];
  const pool = { durableJobs: [
    { id: 'job-one', generation: 2, storageKey: `${BLOB_PREFIX}restart/one` },
    { id: 'job-two', generation: 4, storageKey: `${BLOB_PREFIX}restart/two` },
  ] };
  class RestartedStore {
    constructor(options) {
      events.push(['construct', options]);
      this.pool = options.pool;
    }

    async init() {
      events.push(['init']);
    }

    async claimNextMediaDeletion(input) {
      events.push(['claim', input.workerId]);
      const job = this.pool.durableJobs.shift() ?? null;
      return job ? { ...job, leaseToken: input.leaseToken } : null;
    }

    async completeMediaDeletion(input) {
      events.push(['complete', input.jobId, input.generation, input.leaseToken]);
    }
  }
  const deleted = [];
  const processed = await acceptanceCli.drainRestartedMediaDeletionOutbox({
    pool,
    containerClient: {
      getBlockBlobClient(storageKey) {
        return { async deleteIfExists() { deleted.push(storageKey); } };
      },
    },
    blobPrefix: BLOB_PREFIX,
    cleanupNow: NOW.toISOString(),
    StoreClass: RestartedStore,
  });

  assert.equal(processed, 2);
  assert.deepEqual(deleted, [`${BLOB_PREFIX}restart/one`, `${BLOB_PREFIX}restart/two`]);
  assert.deepEqual(events[0], ['construct', { pool, ownsPool: false }]);
  assert.deepEqual(events.filter(([kind]) => kind === 'complete').map((event) => event.slice(1, 3)), [
    ['job-one', 2], ['job-two', 4],
  ]);
});

test('connection-string auth is identity-matched without persisting or printing credentials', async () => {
  const connectionString = [
    'DefaultEndpointsProtocol=https',
    'AccountName=v1buddyblob',
    'AccountKey=not-a-real-secret-key',
    'EndpointSuffix=core.windows.net',
  ].join(';');
  const environment = {
    ...validEnvironment(),
    V1_ACCEPTANCE_BLOB_ACCOUNT_URL: undefined,
    V1_ACCEPTANCE_BLOB_CONNECTION_STRING: connectionString,
    V1_BLOB_ACCOUNT_URL: undefined,
    V1_BLOB_CONNECTION_STRING: connectionString,
  };
  const fixture = instrumentedRun({ environment });
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  const opened = fixture.calls.find(([kind]) => kind === 'open')[1];
  assert.equal(opened.blob.connectionString, connectionString);
  assert.equal(opened.blob.accountUrl, null);
  assert.equal(fixture.output.join('').includes('not-a-real-secret-key'), false);
  assert.equal(fixture.artifacts[0].contents.includes('not-a-real-secret-key'), false);
  assert.equal(
    fixture.artifacts[0].record.blobIdentitySha256,
    blobIdentitySha256({ connectionString, container: BLOB_CONTAINER }),
  );
});

test('development-storage directives cannot be hidden beside a production Blob endpoint', async () => {
  const mixedConnectionString = [
    'UseDevelopmentStorage=true',
    'DevelopmentStorageProxyUri=http://127.0.0.1',
    'BlobEndpoint=https://v1buddyblob.blob.core.windows.net/',
    'AccountName=v1buddyblob',
    'AccountKey=not-a-real-secret-key',
  ].join(';');
  const fixture = instrumentedRun({
    environment: {
      ...validEnvironment(),
      V1_ACCEPTANCE_BLOB_ACCOUNT_URL: undefined,
      V1_ACCEPTANCE_BLOB_CONNECTION_STRING: mixedConnectionString,
      V1_BLOB_ACCOUNT_URL: undefined,
      V1_BLOB_CONNECTION_STRING: mixedConnectionString,
    },
  });

  const result = await fixture.run();
  assert.equal(result.exitCode, 2);
  assert.equal(result.publicReport.status, 'not-run');
  assert.deepEqual(fixture.calls, []);
  assert.equal(fixture.artifacts.length, 0);
  assert.equal(fixture.output.join('').includes('127.0.0.1'), false);
  assert.equal(fixture.output.join('').includes('not-a-real-secret-key'), false);
});

test('functional failure still cleans both isolated scopes and records only a safe failed artifact', async () => {
  const fixture = instrumentedRun({
    runtime: {
      async runChecks() {
        throw new Error(`private runtime failure ${DATABASE_URL}`);
      },
    },
  });
  const result = await fixture.run();

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
  assert.deepEqual(fixture.calls.map(([kind]) => kind), [
    'read', 'git', 'open', 'run', 'blob-cleanup', 'schema-cleanup', 'close', 'write',
  ]);
  assert.equal(fixture.artifacts[0].record.result, false);
  assert.equal(fixture.output.join('').includes(DATABASE_URL), false);
  assert.equal(fixture.artifacts[0].contents.includes(DATABASE_URL), false);
});

test('every cleanup branch is attempted and any cleanup or close failure forces result false', async (t) => {
  const cases = [
    ['blob cleanup residual', {
      async cleanupBlobPrefix(prefix) { this.calls?.push?.(prefix); return 1; },
    }],
    ['blob cleanup throws', {
      async cleanupBlobPrefix() { throw new Error(`private Blob failure ${BLOB_ACCOUNT_URL}`); },
    }],
    ['schema cleanup false', {
      async dropSchema() { return false; },
    }],
    ['schema cleanup throws', {
      async dropSchema() { throw new Error(`private SQL failure ${DATABASE_URL}`); },
    }],
    ['close throws', {
      async close() { throw new Error('private close failure'); },
    }],
  ];

  for (const [name, runtime] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ runtime });
      const result = await fixture.run();

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
      assert.equal(fixture.calls.some(([kind]) => kind === 'blob-cleanup'), true);
      assert.equal(fixture.calls.some(([kind]) => kind === 'schema-cleanup'), true);
      assert.equal(fixture.calls.some(([kind]) => kind === 'close'), true);
      assert.equal(fixture.calls.at(-1)[0], 'write');
      assert.equal(fixture.artifacts[0].record.result, false);
      const serialized = fixture.output.join('');
      for (const secret of [
        DATABASE_URL,
        BLOB_ACCOUNT_URL,
        'private Blob failure',
        'private SQL failure',
        'private close failure',
      ]) assert.equal(serialized.includes(secret), false);
    });
  }
});

test('dependency opening failure never skips safe failure evidence and never leaks the provider error', async () => {
  const fixture = instrumentedRun({
    openDependencies: async (input) => {
      fixture.calls.push(['open', input]);
      throw new Error(`cannot connect ${DATABASE_URL}`);
    },
  });
  const result = await fixture.run();

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
  assert.deepEqual(fixture.calls.map(([kind]) => kind), ['read', 'git', 'open', 'write']);
  assert.equal(fixture.artifacts[0].record.schemaAbsent, false);
  assert.equal(fixture.artifacts[0].record.blobPrefixObjectCount, null);
  assert.equal(fixture.output.join('').includes(DATABASE_URL), false);
  assert.equal(fixture.artifacts[0].contents.includes(DATABASE_URL), false);
});

test('main command expiry aborts hung checks while cleanup runs on an independent budget and remains secret-safe', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let mainSignal = null;
  const cleanupSignals = [];
  const fixture = instrumentedRun({
    commandDeadlineMs: 50,
    operationDeadlineMs: 1_000,
    cleanupDeadlineMs: 100,
    cleanupOperationDeadlineMs: 20,
    runtime: {
      async runChecks(context) {
        mainSignal = context?.signal ?? null;
        return new Promise(() => {});
      },
      async cleanupBlobPrefix(_prefix, context) {
        cleanupSignals.push(['blob', context?.signal, context?.signal?.aborted]);
        return 0;
      },
      async dropSchema(_schema, context) {
        cleanupSignals.push(['schema', context?.signal, context?.signal?.aborted]);
        return true;
      },
      async close(context) {
        cleanupSignals.push(['close', context?.signal, context?.signal?.aborted]);
      },
    },
  });
  const pending = fixture.run();
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(mainSignal instanceof AbortSignal);
  t.mock.timers.tick(50);
  await flushAsyncWork();

  assert.equal(mainSignal.aborted, true, 'the main signal must be aborted before cleanup starts');
  assert.equal(observation.settled, true, JSON.stringify(fixture.calls.map(([kind]) => kind)));
  assert.equal(observation.status, 'fulfilled');
  assert.equal(observation.value.exitCode, 1);
  assert.equal(observation.value.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
  assert.deepEqual(cleanupSignals.map(([name]) => name), ['blob', 'schema', 'close']);
  for (const [, signal, wasAbortedAtCall] of cleanupSignals) {
    assert.ok(signal instanceof AbortSignal);
    assert.notEqual(signal, mainSignal);
    assert.equal(wasAbortedAtCall, false);
  }
  assert.equal(fixture.artifacts.length, 1);
  const serialized = `${fixture.output.join('')}\n${fixture.artifacts[0].contents}`;
  for (const secret of [DATABASE_URL, BLOB_ACCOUNT_URL, INVENTORY_FILE, 'private-password']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('a hung cleanup operation times out without preventing the remaining cleanup branches', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let blobCleanupSignal = null;
  const fixture = instrumentedRun({
    commandDeadlineMs: 1_000,
    operationDeadlineMs: 100,
    cleanupDeadlineMs: 100,
    cleanupOperationDeadlineMs: 20,
    runtime: {
      async runChecks() {
        throw new Error(`private main failure ${DATABASE_URL}`);
      },
      async cleanupBlobPrefix(_prefix, context) {
        blobCleanupSignal = context?.signal ?? null;
        return new Promise(() => {});
      },
    },
  });
  const pending = fixture.run();
  const observation = observeSettlement(pending);

  await flushAsyncWork();
  assert.ok(blobCleanupSignal instanceof AbortSignal);
  t.mock.timers.tick(20);
  await flushAsyncWork();

  assert.equal(blobCleanupSignal.aborted, true, 'the hung cleanup branch must be aborted');
  assert.equal(observation.settled, true, JSON.stringify(fixture.calls.map(([kind]) => kind)));
  assert.equal(observation.value.exitCode, 1);
  assert.equal(fixture.calls.some(([kind]) => kind === 'schema-cleanup'), true);
  assert.equal(fixture.calls.some(([kind]) => kind === 'close'), true);
  const serialized = `${fixture.output.join('')}\n${fixture.artifacts[0].contents}`;
  assert.equal(serialized.includes(DATABASE_URL), false);
  assert.equal(serialized.includes(BLOB_ACCOUNT_URL), false);
  assert.equal(serialized.includes('private main failure'), false);
});

test('cleanup branches share one hard total budget instead of extending it serially', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cleanupSignals = [];
  const hang = (name, context) => {
    cleanupSignals.push([name, context?.signal ?? null]);
    return new Promise(() => {});
  };
  const fixture = instrumentedRun({
    commandDeadlineMs: 1_000,
    operationDeadlineMs: 100,
    cleanupDeadlineMs: 30,
    cleanupOperationDeadlineMs: 100,
    runtime: {
      async runChecks() { throw new Error('private functional failure'); },
      cleanupBlobPrefix(_prefix, context) { return hang('blob', context); },
      dropSchema(_schema, context) { return hang('schema', context); },
      close(context) { return hang('close', context); },
    },
  });
  const observation = observeSettlement(fixture.run());

  await flushAsyncWork();
  assert.deepEqual(cleanupSignals.map(([name]) => name), ['blob']);
  t.mock.timers.tick(10);
  await flushAsyncWork();
  assert.deepEqual(cleanupSignals.map(([name]) => name), ['blob', 'schema']);
  t.mock.timers.tick(10);
  await flushAsyncWork();
  assert.deepEqual(cleanupSignals.map(([name]) => name), ['blob', 'schema', 'close']);
  t.mock.timers.tick(10);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.value.exitCode, 1);
  assert.equal(cleanupSignals.every(([, signal]) => signal instanceof AbortSignal && signal.aborted), true);
  assert.equal(fixture.artifacts.length, 1);
  assert.equal(fixture.output.join('').includes('private functional failure'), false);
});

test('real runtime bounds hung PostgreSQL query and connect operations', async (t) => {
  await t.test('query', async (queryTest) => {
    queryTest.mock.timers.enable({ apis: ['setTimeout'] });
    class HungQueryPool {
      query() { return new Promise(() => {}); }
      connect() { return Promise.resolve({ query: async () => ({ rows: [] }), release() {} }); }
      end() { return Promise.resolve(); }
    }
    class FakeBlobServiceClient {
      getContainerClient() {
        return {
          listBlobsFlat() {
            return {
              async *[Symbol.asyncIterator]() {
                throw new Error('Blob iteration must not be reached after a hung PostgreSQL query');
              },
              byPage() { return { async *[Symbol.asyncIterator]() {} }; },
            };
          },
          getBlockBlobClient() {
            throw new Error('Blob client must not be reached after a hung PostgreSQL query');
          },
        };
      }
    }
    class FakeCredential {}
    const runtime = await createRealAcceptanceRuntime({
      databaseUrl: DATABASE_URL,
      blob: { accountUrl: BLOB_ACCOUNT_URL },
      blobContainer: BLOB_CONTAINER,
      blobPrefix: BLOB_PREFIX,
      schema: SCHEMA,
      runId: RUN_ID,
      occurredAt: NOW.toISOString(),
      PoolClass: HungQueryPool,
      BlobServiceClientClass: FakeBlobServiceClient,
      DefaultAzureCredentialClass: FakeCredential,
      operationDeadlineMs: 25,
    });
    const observation = observeSettlement(runtime.runChecks());

    await flushAsyncWork();
    queryTest.mock.timers.tick(25);
    await flushAsyncWork();

    assert.equal(observation.settled, true);
    assert.equal(observation.status, 'rejected');
    assert.equal(observation.error?.code, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED');
    assert.equal(String(observation.error).includes(DATABASE_URL), false);
  });

  await t.test('connect', async (connectTest) => {
    connectTest.mock.timers.enable({ apis: ['setTimeout'] });
    let schemaExists = false;
    class HungConnectPool {
      async query(text) {
        if (/pg_namespace/i.test(text)) return { rows: [{ count: schemaExists ? 1 : 0 }], rowCount: 1 };
        if (/CREATE SCHEMA/i.test(text)) schemaExists = true;
        return { rows: [], rowCount: 0 };
      }
      connect() { return new Promise(() => {}); }
      end() { return Promise.resolve(); }
    }
    const containerClient = {
      listBlobsFlat() {
        return {
          async *[Symbol.asyncIterator]() {},
          byPage() { return { async *[Symbol.asyncIterator]() {} }; },
        };
      },
      getBlockBlobClient() {
        return { async uploadData() {}, async deleteIfExists() {} };
      },
    };
    class FakeBlobServiceClient { getContainerClient() { return containerClient; } }
    class FakeCredential {}
    const runtime = await createRealAcceptanceRuntime({
      databaseUrl: DATABASE_URL,
      blob: { accountUrl: BLOB_ACCOUNT_URL },
      blobContainer: BLOB_CONTAINER,
      blobPrefix: BLOB_PREFIX,
      schema: SCHEMA,
      runId: RUN_ID,
      occurredAt: NOW.toISOString(),
      PoolClass: HungConnectPool,
      BlobServiceClientClass: FakeBlobServiceClient,
      DefaultAzureCredentialClass: FakeCredential,
      operationDeadlineMs: 25,
      readMigration: async () => 'BEGIN; COMMIT;',
      exerciseChecks: async ({ pools }) => pools[0].connect(),
    });
    const observation = observeSettlement(runtime.runChecks());

    await flushAsyncWork();
    connectTest.mock.timers.tick(25);
    await flushAsyncWork();

    assert.equal(observation.settled, true);
    assert.equal(observation.status, 'rejected');
    assert.equal(observation.error?.code, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED');
  });

  for (const trigger of ['deadline', 'parent abort']) {
    await t.test(`late connect is destroyed after ${trigger}`, async (lateTest) => {
      lateTest.mock.timers.enable({ apis: ['setTimeout'] });
      let schemaExists = false;
      let resolveConnect = null;
      const releaseArguments = [];
      class LateConnectPool {
        async query(text) {
          if (/pg_namespace/i.test(text)) return { rows: [{ count: schemaExists ? 1 : 0 }], rowCount: 1 };
          if (/CREATE SCHEMA/i.test(text)) schemaExists = true;
          return { rows: [], rowCount: 0 };
        }
        connect() {
          return new Promise((resolveConnection) => {
            resolveConnect = () => resolveConnection({
              query: async () => ({ rows: [], rowCount: 0 }),
              release: (argument) => releaseArguments.push(argument),
            });
          });
        }
        end() { return Promise.resolve(); }
      }
      const containerClient = {
        listBlobsFlat() {
          return {
            async *[Symbol.asyncIterator]() {},
            byPage() { return { async *[Symbol.asyncIterator]() {} }; },
          };
        },
        getBlockBlobClient() {
          return { async uploadData() {}, async deleteIfExists() {} };
        },
      };
      class FakeBlobServiceClient { getContainerClient() { return containerClient; } }
      class FakeCredential {}
      const runtime = await createRealAcceptanceRuntime({
        databaseUrl: DATABASE_URL,
        blob: { accountUrl: BLOB_ACCOUNT_URL },
        blobContainer: BLOB_CONTAINER,
        blobPrefix: BLOB_PREFIX,
        schema: SCHEMA,
        runId: RUN_ID,
        occurredAt: NOW.toISOString(),
        PoolClass: LateConnectPool,
        BlobServiceClientClass: FakeBlobServiceClient,
        DefaultAzureCredentialClass: FakeCredential,
        operationDeadlineMs: 25,
        readMigration: async () => 'BEGIN; COMMIT;',
        exerciseChecks: async ({ pools }) => pools[0].connect(),
      });
      const parent = new AbortController();
      const pending = runtime.runChecks({ signal: parent.signal });
      const observation = observeSettlement(pending);

      await flushAsyncWork();
      assert.equal(typeof resolveConnect, 'function');
      if (trigger === 'deadline') lateTest.mock.timers.tick(25);
      else parent.abort(new Error('safe parent stop'));
      await flushAsyncWork();
      assert.equal(observation.settled, true);
      assert.equal(observation.status, 'rejected');
      assert.equal(releaseArguments.length, 0);

      resolveConnect();
      await flushAsyncWork();
      assert.deepEqual(releaseArguments, [true]);
    });
  }
});

test('real runtime aborts a hung Blob operation through the Azure AbortSignal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let uploadSignal = null;
  let schemaExists = false;
  class FakePool {
    async query(text) {
      if (/pg_namespace/i.test(text)) return { rows: [{ count: schemaExists ? 1 : 0 }], rowCount: 1 };
      if (/CREATE SCHEMA/i.test(text)) schemaExists = true;
      return { rows: [], rowCount: 0 };
    }
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; }
    async end() {}
  }
  const containerClient = {
    listBlobsFlat() {
      return {
        async *[Symbol.asyncIterator]() {},
        byPage() { return { async *[Symbol.asyncIterator]() {} }; },
      };
    },
    getBlockBlobClient() {
      return {
        uploadData(_body, options) {
          uploadSignal = options?.abortSignal ?? null;
          return new Promise(() => {});
        },
        async deleteIfExists() {},
      };
    },
  };
  class FakeBlobServiceClient { getContainerClient() { return containerClient; } }
  class FakeCredential {}
  const runtime = await createRealAcceptanceRuntime({
    databaseUrl: DATABASE_URL,
    blob: { accountUrl: BLOB_ACCOUNT_URL },
    blobContainer: BLOB_CONTAINER,
    blobPrefix: BLOB_PREFIX,
    schema: SCHEMA,
    runId: RUN_ID,
    occurredAt: NOW.toISOString(),
    PoolClass: FakePool,
    BlobServiceClientClass: FakeBlobServiceClient,
    DefaultAzureCredentialClass: FakeCredential,
    operationDeadlineMs: 25,
    readMigration: async () => 'BEGIN; COMMIT;',
    exerciseChecks: async () => [],
  });
  const observation = observeSettlement(runtime.runChecks());

  await flushAsyncWork();
  assert.ok(uploadSignal instanceof AbortSignal);
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.status, 'rejected');
  assert.equal(observation.error?.code, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED');
  assert.equal(uploadSignal.aborted, true);
  assert.equal(String(observation.error).includes(BLOB_ACCOUNT_URL), false);
});

test('real runtime aborts a hung Blob listing request at the iterator operation deadline', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let listSignal = null;
  class FakePool {
    async query(text) {
      if (/pg_namespace/i.test(text)) return { rows: [{ count: 0 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }
    async connect() { return { query: async () => ({ rows: [] }), release() {} }; }
    async end() {}
  }
  const containerClient = {
    listBlobsFlat(options) {
      listSignal = options?.abortSignal ?? null;
      return {
        [Symbol.asyncIterator]() {
          return {
            next() { return new Promise(() => {}); },
          };
        },
        byPage() { return { async *[Symbol.asyncIterator]() {} }; },
      };
    },
    getBlockBlobClient() {
      throw new Error('owner marker must not be reached after a hung listing request');
    },
  };
  class FakeBlobServiceClient { getContainerClient() { return containerClient; } }
  class FakeCredential {}
  const runtime = await createRealAcceptanceRuntime({
    databaseUrl: DATABASE_URL,
    blob: { accountUrl: BLOB_ACCOUNT_URL },
    blobContainer: BLOB_CONTAINER,
    blobPrefix: BLOB_PREFIX,
    schema: SCHEMA,
    runId: RUN_ID,
    occurredAt: NOW.toISOString(),
    PoolClass: FakePool,
    BlobServiceClientClass: FakeBlobServiceClient,
    DefaultAzureCredentialClass: FakeCredential,
    operationDeadlineMs: 25,
  });
  const observation = observeSettlement(runtime.runChecks());

  await flushAsyncWork();
  assert.ok(listSignal instanceof AbortSignal);
  t.mock.timers.tick(25);
  await flushAsyncWork();

  assert.equal(observation.settled, true);
  assert.equal(observation.error?.code, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED');
  assert.equal(listSignal.aborted, true);
});

test('a reused schema is never acquired or dropped by this run', async () => {
  const sql = [];
  const deletedBlobs = [];
  let poolIndex = 0;
  class FakePool {
    constructor() {
      this.index = poolIndex;
      poolIndex += 1;
    }

    async query(text, values) {
      sql.push([this.index, text, values]);
      if (/CREATE SCHEMA/i.test(text)) throw new Error('schema already exists');
      if (/pg_namespace/i.test(text)) return { rows: [{ count: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    }

    async connect() {
      throw new Error('store connection should not be reached');
    }

    async end() {}
  }
  const existingName = `${BLOB_PREFIX}existing-object`;
  const containerClient = {
    listBlobsFlat({ prefix }) {
      assert.equal(prefix, BLOB_PREFIX);
      return {
        async *[Symbol.asyncIterator]() {
          yield { name: existingName };
        },
        byPage() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { segment: { blobItems: [{ name: existingName }] } };
            },
          };
        },
      };
    },
    getBlockBlobClient(name) {
      return {
        async deleteIfExists() {
          deletedBlobs.push(name);
        },
      };
    },
  };
  class FakeBlobServiceClient {
    getContainerClient(container) {
      assert.equal(container, BLOB_CONTAINER);
      return containerClient;
    }
  }
  class FakeCredential {}

  const runtime = await createRealAcceptanceRuntime({
    databaseUrl: DATABASE_URL,
    blob: { accountUrl: BLOB_ACCOUNT_URL },
    blobContainer: BLOB_CONTAINER,
    blobPrefix: BLOB_PREFIX,
    schema: SCHEMA,
    runId: RUN_ID,
    occurredAt: NOW.toISOString(),
    PoolClass: FakePool,
    BlobServiceClientClass: FakeBlobServiceClient,
    DefaultAzureCredentialClass: FakeCredential,
    readMigration: async () => 'BEGIN; COMMIT;',
    exerciseChecks: async () => [{ name: 'should-not-run', status: 'pass' }],
  });

  await assert.rejects(runtime.runChecks());
  assert.equal(await runtime.cleanupBlobPrefix(BLOB_PREFIX), 1);
  assert.equal(await runtime.dropSchema(SCHEMA), false);
  await runtime.close();

  assert.deepEqual(deletedBlobs, []);
  assert.equal(sql.some(([, text]) => /DROP SCHEMA/i.test(text)), false);
});

test('a reused Blob prefix is never acquired or swept by this run', async () => {
  let createdSchema = false;
  const deleted = [];
  class FakePool {
    async query(text) {
      if (/pg_namespace/i.test(text)) return { rows: [{ count: 0 }], rowCount: 1 };
      if (/CREATE SCHEMA/i.test(text)) createdSchema = true;
      return { rows: [], rowCount: 0 };
    }

    async connect() {
      throw new Error('store connection should not be reached');
    }

    async end() {}
  }
  const existingName = `${BLOB_PREFIX}existing-object`;
  const containerClient = {
    listBlobsFlat() {
      return {
        async *[Symbol.asyncIterator]() {
          yield { name: existingName };
        },
        byPage() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { segment: { blobItems: [{ name: existingName }] } };
            },
          };
        },
      };
    },
    getBlockBlobClient(name) {
      return {
        async deleteIfExists() {
          deleted.push(name);
        },
      };
    },
  };
  class FakeBlobServiceClient {
    getContainerClient() {
      return containerClient;
    }
  }
  class FakeCredential {}
  const runtime = await createRealAcceptanceRuntime({
    databaseUrl: DATABASE_URL,
    blob: { accountUrl: BLOB_ACCOUNT_URL },
    blobContainer: BLOB_CONTAINER,
    blobPrefix: BLOB_PREFIX,
    schema: SCHEMA,
    runId: RUN_ID,
    occurredAt: NOW.toISOString(),
    PoolClass: FakePool,
    BlobServiceClientClass: FakeBlobServiceClient,
    DefaultAzureCredentialClass: FakeCredential,
    readMigration: async () => 'BEGIN; COMMIT;',
    exerciseChecks: async () => [{ name: 'should-not-run', status: 'pass' }],
  });

  await assert.rejects(runtime.runChecks());
  assert.equal(await runtime.cleanupBlobPrefix(BLOB_PREFIX), 1);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();
  assert.equal(createdSchema, false);
  assert.deepEqual(deleted, []);
});

test('real runtime reserves only its fresh marker and proves both owned scopes absent after cleanup', async () => {
  const sql = [];
  const ended = [];
  const poolOptions = [];
  let poolIndex = 0;
  let schemaExists = false;
  class FakePool {
    constructor(options) {
      this.index = poolIndex;
      poolIndex += 1;
      poolOptions.push(options);
    }

    async query(text, values) {
      sql.push([this.index, text, values]);
      if (/SELECT count\(\*\)::int AS count FROM pg_namespace/i.test(text)) {
        return { rows: [{ count: schemaExists ? 1 : 0 }], rowCount: 1 };
      }
      if (/CREATE SCHEMA/i.test(text)) {
        assert.equal(schemaExists, false);
        schemaExists = true;
      }
      if (/DROP SCHEMA/i.test(text)) schemaExists = false;
      return { rows: [], rowCount: 0 };
    }

    async connect() {
      throw new Error('injected exercise does not use store connections');
    }

    async end() {
      ended.push(this.index);
    }
  }
  const blobs = new Set();
  const uploads = [];
  const containerClient = {
    listBlobsFlat({ prefix }) {
      const names = () => [...blobs].filter((name) => name.startsWith(prefix));
      return {
        async *[Symbol.asyncIterator]() {
          for (const name of names()) yield { name };
        },
        byPage() {
          return {
            async *[Symbol.asyncIterator]() {
              yield { segment: { blobItems: names().map((name) => ({ name })) } };
            },
          };
        },
      };
    },
    getBlockBlobClient(name) {
      return {
        async uploadData(body, options) {
          uploads.push({ name, body: Buffer.from(body).toString('utf8'), options });
          if (options?.conditions?.ifNoneMatch === '*' && blobs.has(name)) throw new Error('condition failed');
          blobs.add(name);
        },
        async deleteIfExists() {
          blobs.delete(name);
        },
      };
    },
  };
  class FakeBlobServiceClient {
    getContainerClient() {
      return containerClient;
    }
  }
  class FakeCredential {}
  let exercised = 0;
  const runtime = await createRealAcceptanceRuntime({
    databaseUrl: DATABASE_URL,
    blob: { accountUrl: BLOB_ACCOUNT_URL },
    blobContainer: BLOB_CONTAINER,
    blobPrefix: BLOB_PREFIX,
    schema: SCHEMA,
    runId: RUN_ID,
    occurredAt: NOW.toISOString(),
    PoolClass: FakePool,
    BlobServiceClientClass: FakeBlobServiceClient,
    DefaultAzureCredentialClass: FakeCredential,
    readMigration: async () => 'BEGIN; COMMIT;',
    exerciseChecks: async () => {
      exercised += 1;
      return [{ name: 'injected-real-contract', status: 'pass', latencyMs: 1 }];
    },
  });

  assert.deepEqual(await runtime.runChecks(), [
    { name: 'injected-real-contract', status: 'pass', latencyMs: 1 },
  ]);
  assert.equal(exercised, 1);
  assert.equal(uploads.length, 1);
  const [{ options: { abortSignal, ...uploadOptions }, ...upload }] = uploads;
  assert.ok(abortSignal instanceof AbortSignal);
  assert.deepEqual({ ...upload, options: uploadOptions }, {
    name: `${BLOB_PREFIX}.acceptance-owner`,
    body: RUN_ID,
    options: {
      blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
      conditions: { ifNoneMatch: '*' },
    },
  });
  assert.equal(await runtime.cleanupBlobPrefix(BLOB_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.deepEqual([...blobs], []);
  assert.equal(schemaExists, false);
  assert.deepEqual(ended.sort(), [0, 1, 2]);
  assert.deepEqual(poolOptions, [
    {
      connectionString: DATABASE_URL,
      options: '-c statement_timeout=30000',
      connectionTimeoutMillis: 30_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    },
    {
      connectionString: DATABASE_URL,
      options: `-c search_path=${SCHEMA} -c statement_timeout=30000`,
      connectionTimeoutMillis: 30_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    },
    {
      connectionString: DATABASE_URL,
      options: `-c search_path=${SCHEMA} -c statement_timeout=30000`,
      connectionTimeoutMillis: 30_000,
      query_timeout: 30_000,
      statement_timeout: 30_000,
    },
  ]);
  assert.equal(sql.some(([, text]) => text === `CREATE SCHEMA "${SCHEMA}"`), true);
  assert.equal(sql.some(([, text]) => text === `DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`), true);
});
