import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable, Writable } from 'node:stream';
import test from 'node:test';

import {
  finalizeReleaseEvidenceRecord,
  gcsIdentitySha256,
  postgresIdentitySha256,
  validateDependencyAcceptanceEvidence,
  validateReleaseEvidenceBundle,
} from '../src/services/release-evidence.js';
import {
  attestGcpExecutionIdentity,
  createRealAcceptanceRuntime,
  runRealDependencyAcceptance,
} from '../scripts/real-dependencies-acceptance.js';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const COMMIT = '1'.repeat(40);
const SOURCE_ARCHIVE_SHA256 = '2'.repeat(64);
const BUILD_CONFIG_SHA256 = '3'.repeat(64);
const RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const SCHEMA = `v1_accept_${RUN_ID.replaceAll('-', '')}`;
const GCS_PREFIX = `v1-accept/${RUN_ID}/`;
const PROJECT_ID = 'motion-expert-hk-ltd-webpage';
const PROJECT_NUMBER = '582852715831';
const BUCKET_NAME = 'hkbuddy-v1-582852715831-media';
const GCS_RESOURCE_ID = `//storage.googleapis.com/projects/_/buckets/${BUCKET_NAME}`;
const POSTGRES_RESOURCE_ID = `//sqladmin.googleapis.com/projects/${PROJECT_ID}/instances/hkbuddy-v1-pg/databases/hkbuddy_v1`;
const DATABASE_URL = 'postgresql://hkbuddy_app:private-password@10.25.0.3:5432/hkbuddy_v1?sslmode=require';
const MIGRATOR_DATABASE_URL = 'postgresql://hkbuddy_migrator:private-migrator-password@10.25.0.3:5432/hkbuddy_v1?sslmode=require';
const INVENTORY_FILE = resolve('approved-legacy-inventory.json');
const RELEASE_MANIFEST_FILE = '/app/release-manifest.json';
const OUTPUT_OBJECT = `release-evidence/${COMMIT}/dependency-acceptance/${RUN_ID}.json`;
const ACCEPTANCE_SERVICE_ACCOUNT = `hkbuddy-v1-acceptance@${PROJECT_ID}.iam.gserviceaccount.com`;

const CORE_CHECKS = Object.freeze([
  'postgres-migration-health',
  'postgres-concurrency-recovery',
  'postgres-integrity-events',
  'postgres-rate-window-fencing',
  'gcs-private-full-range-head',
  'postgres-media-fencing',
]);

const REQUIRED_GCS_PERMISSIONS = Object.freeze([
  'storage.objects.create',
  'storage.objects.delete',
  'storage.objects.get',
  'storage.objects.list',
  'storage.objects.update',
]);

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

function releaseManifest(overrides = {}) {
  return {
    schemaVersion: 1,
    buildConfigSha256: BUILD_CONFIG_SHA256,
    releaseSha: COMMIT,
    sourceArchiveSha256: SOURCE_ARCHIVE_SHA256,
    sourcePath: 'git-archive:production-v1',
    ...overrides,
  };
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function validEnvironment(inventory = legacyInventory()) {
  return {
    V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'true',
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_RELEASE_MANIFEST_FILE: RELEASE_MANIFEST_FILE,
    V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: OUTPUT_OBJECT,
    V1_ACCEPTANCE_DATABASE_URL: DATABASE_URL,
    V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: MIGRATOR_DATABASE_URL,
    V1_ACCEPTANCE_SCHEMA: SCHEMA,
    V1_ACCEPTANCE_GCS_PREFIX: GCS_PREFIX,
    V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT: PROJECT_ID,
    V1_ACCEPTANCE_GCS_BUCKET: BUCKET_NAME,
    V1_ACCEPTANCE_GCS_RESOURCE_ID: GCS_RESOURCE_ID,
    V1_DATABASE_URL: DATABASE_URL,
    V1_POSTGRES_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    V1_GOOGLE_CLOUD_PROJECT: PROJECT_ID,
    V1_GCS_BUCKET: BUCKET_NAME,
    V1_GCS_RESOURCE_ID: GCS_RESOURCE_ID,
    V1_LEGACY_RESOURCE_INVENTORY_FILE: INVENTORY_FILE,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: inventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
  };
}

function passChecks() {
  return CORE_CHECKS.map((name, index) => ({ name, status: 'pass', latencyMs: index + 1 }));
}

function instrumentedRun(overrides = {}) {
  const inventory = overrides.inventory ?? legacyInventory();
  const manifest = overrides.manifest ?? releaseManifest();
  const calls = [];
  const output = [];
  const artifacts = [];
  const runtimeOverrides = overrides.runtime ?? {};
  const runtime = {
    async runChecks(...args) {
      calls.push(['run']);
      return runtimeOverrides.runChecks
        ? runtimeOverrides.runChecks.call(runtime, ...args)
        : passChecks();
    },
    async cleanupGcsPrefix(prefix, ...args) {
      calls.push(['gcs-cleanup', prefix]);
      return runtimeOverrides.cleanupGcsPrefix
        ? runtimeOverrides.cleanupGcsPrefix.call(runtime, prefix, ...args)
        : 0;
    },
    async dropSchema(schema, ...args) {
      calls.push(['schema-cleanup', schema]);
      return runtimeOverrides.dropSchema
        ? runtimeOverrides.dropSchema.call(runtime, schema, ...args)
        : true;
    },
    async close(...args) {
      calls.push(['close']);
      if (runtimeOverrides.close) return runtimeOverrides.close.call(runtime, ...args);
      return undefined;
    },
    async writeEvidenceObject(input, ...args) {
      calls.push(['evidence-write', input.objectName]);
      artifacts.push(input);
      if (runtimeOverrides.writeEvidenceObject) {
        return runtimeOverrides.writeEvidenceObject.call(runtime, input, ...args);
      }
      return {
        objectName: input.objectName,
        generation: '42',
        artifactSha256: input.artifactSha256,
        objectSha256: input.objectSha256,
      };
    },
  };
  const options = {
    argv: [`--release-sha=${COMMIT}`],
    environment: validEnvironment(inventory),
    now: () => NOW,
    readTextFile: async (filePath) => {
      calls.push(['read', filePath]);
      if (filePath === RELEASE_MANIFEST_FILE) return JSON.stringify(manifest);
      return JSON.stringify(inventory);
    },
    openDependencies: async (input) => {
      calls.push(['open', input]);
      return runtime;
    },
    writeOutput: (line) => output.push(line),
    ...overrides,
  };
  delete options.inventory;
  delete options.manifest;
  delete options.runtime;
  return { calls, output, artifacts, run: () => runRealDependencyAcceptance(options) };
}

function providerError(code, message = 'private provider detail') {
  const error = new Error(message);
  error.code = code;
  error.statusCode = code;
  return error;
}

function permissionMap(overrides = {}) {
  return {
    'storage.objects.create': true,
    'storage.objects.delete': true,
    'storage.objects.get': true,
    'storage.objects.list': true,
    'storage.objects.update': true,
    'storage.buckets.delete': false,
    'storage.buckets.getIamPolicy': false,
    'storage.buckets.setIamPolicy': false,
    'storage.buckets.update': false,
    'storage.objects.getIamPolicy': false,
    'storage.objects.setIamPolicy': false,
    'storage.objects.overrideUnlockedRetention': false,
    'storage.objects.setRetention': false,
    ...overrides,
  };
}

function createFakeBucket({
  initialObjects = [],
  permissions = permissionMap(),
  publicStatus = 403,
  publicStatuses = null,
  hangList = false,
  malformedListName = null,
  malformedListPrefix = null,
  malformedMetadata = null,
  commitWriteThenErrorName = null,
  storageClientEmail = ACCEPTANCE_SERVICE_ACCOUNT,
  storageCredentialType = 'Compute',
  bucketProjectNumber = PROJECT_NUMBER,
  concurrentConditionalWrite = null,
  ambiguousConditionalConflict = false,
} = {}) {
  const objects = new Map(initialObjects.map(([name, bytes, customMetadata = {}]) => [name, {
    bytes: Buffer.from(bytes),
    updated: NOW.toISOString(),
    generation: '1',
    contentType: 'application/octet-stream',
    customMetadata: { ...customMetadata },
  }]));
  const calls = {
    writes: [], reads: [], metadata: [], deletes: [], lists: [], permissions: [],
    publicFetches: [], storageOptions: [], storageCredentials: [], bucketMetadata: [], signedUrls: 0,
  };
  let generation = objects.size;
  let committedWriteErrorRaised = false;
  let concurrentConditionalWriteCommitted = false;
  let ambiguousConditionalConflictRaised = false;

  const bucket = {
    name: BUCKET_NAME,
    async getMetadata() {
      calls.bucketMetadata.push(BUCKET_NAME);
      return [{ name: BUCKET_NAME, projectNumber: bucketProjectNumber }];
    },
    iam: {
      async testPermissions(requested) {
        calls.permissions.push([...requested]);
        return [{ ...permissions }, { permissions: Object.entries(permissions)
          .filter(([, allowed]) => allowed).map(([name]) => name) }];
      },
    },
    file(name, fileOptions = {}) {
      return {
        name,
        getSignedUrl() {
          calls.signedUrls += 1;
          throw new Error('signed URLs are forbidden');
        },
        createWriteStream(options = {}) {
          const chunks = [];
          calls.writes.push({ name, options, chunks });
          return new Writable({
            write(chunk, _encoding, callback) {
              chunks.push(Buffer.from(chunk));
              callback();
            },
            final(callback) {
              if (options?.preconditionOpts?.ifGenerationMatch === 0
                && concurrentConditionalWrite?.name === name
                && !concurrentConditionalWriteCommitted) {
                concurrentConditionalWriteCommitted = true;
                generation += 1;
                objects.set(name, {
                  bytes: Buffer.from(concurrentConditionalWrite.bytes),
                  updated: NOW.toISOString(),
                  generation: String(generation),
                  contentType: concurrentConditionalWrite.contentType ?? 'application/octet-stream',
                  customMetadata: { ...(concurrentConditionalWrite.customMetadata ?? {}) },
                });
              }
              if (options?.preconditionOpts?.ifGenerationMatch === 0 && objects.has(name)) {
                if (ambiguousConditionalConflict && !ambiguousConditionalConflictRaised) {
                  ambiguousConditionalConflictRaised = true;
                  callback(new Error('transport hid the create-only precondition result'));
                  return;
                }
                callback(providerError(412));
                return;
              }
              generation += 1;
              objects.set(name, {
                bytes: Buffer.concat(chunks),
                updated: NOW.toISOString(),
                generation: String(generation),
                contentType: options?.metadata?.contentType ?? 'application/octet-stream',
                customMetadata: { ...(options?.metadata?.metadata ?? {}) },
              });
              if (name === commitWriteThenErrorName && !committedWriteErrorRaised) {
                committedWriteErrorRaised = true;
                callback(new Error('transport failed after committed write'));
                return;
              }
              callback();
            },
          });
        },
        async getMetadata(options) {
          calls.metadata.push({ name, options });
          const object = objects.get(name);
          if (!object) throw providerError(404);
          if (malformedMetadata?.name === name) return [malformedMetadata];
          return [{
            name,
            size: String(object.bytes.length),
            updated: object.updated,
            generation: object.generation,
            contentType: object.contentType,
            metadata: { ...object.customMetadata },
          }];
        },
        createReadStream(options = {}) {
          calls.reads.push({ name, options });
          const object = objects.get(name);
          if (!object) return Readable.from((async function* missing() { throw providerError(404); }()));
          const start = options.start ?? 0;
          const end = options.end ?? (object.bytes.length - 1);
          return Readable.from([object.bytes.subarray(start, end + 1)]);
        },
        async delete(options) {
          calls.deletes.push({ name, options, generation: fileOptions.generation });
          const object = objects.get(name);
          if (object && fileOptions.generation !== undefined
            && String(fileOptions.generation) !== object.generation) {
            throw providerError(412);
          }
          if (!objects.delete(name)) throw providerError(404);
          return [{}];
        },
      };
    },
    getFiles(options) {
      calls.lists.push({ ...options });
      if (hangList) return new Promise(() => {});
      const matches = [...objects.entries()]
        .filter(([name]) => name.startsWith(options.prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const offset = options.pageToken ? Number(options.pageToken.slice('page-'.length)) : 0;
      const selected = matches.slice(offset, offset + options.maxResults).map(([name, object]) => ({
        name,
        metadata: {
          name,
          size: String(object.bytes.length),
          updated: object.updated,
          generation: object.generation,
        },
      }));
      if (malformedListName && options.prefix === malformedListPrefix && selected.length > 0) {
        selected[0].name = malformedListName;
      }
      const nextOffset = offset + selected.length;
      const nextQuery = nextOffset < matches.length ? { pageToken: `page-${nextOffset}` } : null;
      return Promise.resolve([selected, nextQuery, { nextPageToken: nextQuery?.pageToken }]);
    },
  };

  let publicFetchIndex = 0;
  const fetchImpl = async (url, options = {}) => {
    calls.publicFetches.push({ url, options });
    const status = Array.isArray(publicStatuses)
      ? (publicStatuses[publicFetchIndex++] ?? publicStatuses.at(-1))
      : publicStatus;
    return new Response(status === 200 ? 'private-object-content' : 'not public', {
      status,
    });
  };

  class StorageClass {
    constructor(options) {
      calls.storageOptions.push(options);
      const Credential = storageCredentialType === 'Compute'
        ? class Compute {}
        : class JWT {};
      const credential = new Credential();
      this.authClient = {
        jsonContent: null,
        keyFilename: null,
        apiKey: null,
        async getClient() {
          calls.storageCredentials.push(['client', credential.constructor.name]);
          return credential;
        },
        async getCredentials() {
          calls.storageCredentials.push(['credentials', storageClientEmail]);
          return { client_email: storageClientEmail };
        },
      };
    }

    bucket(name) {
      assert.equal(name, BUCKET_NAME);
      return bucket;
    }
  }

  return { bucket, calls, fetchImpl, objects, StorageClass };
}

function createFakePoolClass({
  schemaInitiallyExists = false,
  schemaInitiallyOwnedBy = schemaInitiallyExists ? 'pre-existing-owner' : null,
  serverVersion = '160004',
  commitCreateThenError = false,
  concurrentCreateCollisionOwner = null,
  ambiguousCreateCollisionOwner = null,
} = {}) {
  const state = {
    schemaExists: schemaInitiallyExists,
    schemaOwnerToken: schemaInitiallyOwnedBy,
    ended: [],
    options: [],
    sql: [],
  };
  let poolIndex = 0;
  let committedCreateErrorRaised = false;
  let concurrentCreateCollisionRaised = false;
  class PoolClass {
    constructor(options) {
      this.index = poolIndex;
      poolIndex += 1;
      this.user = new URL(options.connectionString).username;
      state.options.push(options);
    }

    async query(text, values) {
      state.sql.push([this.index, text, values]);
      if (/SHOW server_version_num/i.test(text)) {
        return { rows: [{ server_version_num: serverVersion }], rowCount: 1 };
      }
      if (/current_user AS current_user/i.test(text)) {
        return {
          rows: [{
            current_user: this.user,
            can_create_schema: this.user === 'hkbuddy_migrator',
            can_create_database: this.user === 'hkbuddy_migrator',
          }],
          rowCount: 1,
        };
      }
      if (/obj_description\s*\(/i.test(text)) {
        return {
          rows: state.schemaExists ? [{ owner_token: state.schemaOwnerToken }] : [],
          rowCount: state.schemaExists ? 1 : 0,
        };
      }
      if (/pg_namespace/i.test(text)) {
        return { rows: [{ count: state.schemaExists ? 1 : 0 }], rowCount: 1 };
      }
      if (/CREATE SCHEMA/i.test(text)) {
        if (concurrentCreateCollisionOwner && !concurrentCreateCollisionRaised) {
          concurrentCreateCollisionRaised = true;
          state.schemaExists = true;
          state.schemaOwnerToken = concurrentCreateCollisionOwner;
          throw providerError('42P06', 'schema was concurrently created');
        }
        if (ambiguousCreateCollisionOwner && !concurrentCreateCollisionRaised) {
          concurrentCreateCollisionRaised = true;
          state.schemaExists = true;
          state.schemaOwnerToken = ambiguousCreateCollisionOwner;
          throw new Error('transport hid the concurrent schema create result');
        }
        if (state.schemaExists) throw providerError('42P06', 'schema already exists');
        const ownerMatch = /COMMENT ON SCHEMA\s+"[^"]+"\s+IS\s+'([^']+)'/i.exec(text);
        state.schemaExists = true;
        state.schemaOwnerToken = ownerMatch?.[1] ?? null;
        if (commitCreateThenError && !committedCreateErrorRaised) {
          committedCreateErrorRaised = true;
          throw new Error('transport failed after committed schema create');
        }
      }
      if (/DROP SCHEMA/i.test(text)) {
        state.schemaExists = false;
        state.schemaOwnerToken = null;
      }
      return { rows: [], rowCount: 0 };
    }

    async connect() {
      return { query: async () => ({ rows: [], rowCount: 0 }), release() {} };
    }

    async end() {
      state.ended.push(this.index);
    }
  }
  return { PoolClass, state };
}

function realRuntimeOptions({
  provider = createFakeBucket(),
  postgres = createFakePoolClass(),
  exerciseChecks = async () => [{ name: 'injected-contract', status: 'pass', latencyMs: 1 }],
  operationDeadlineMs = 30_000,
  attestExecutionIdentity = async () => ACCEPTANCE_SERVICE_ACCOUNT,
} = {}) {
  return {
    provider,
    postgres,
    options: {
      databaseUrl: DATABASE_URL,
      migratorDatabaseUrl: MIGRATOR_DATABASE_URL,
      projectId: PROJECT_ID,
      bucketName: BUCKET_NAME,
      releaseSha: COMMIT,
      evidenceOutputObject: OUTPUT_OBJECT,
      gcsPrefix: GCS_PREFIX,
      schema: SCHEMA,
      runId: RUN_ID,
      occurredAt: NOW.toISOString(),
      PoolClass: postgres.PoolClass,
      StorageClass: provider.StorageClass,
      fetchImpl: provider.fetchImpl,
      operationDeadlineMs,
      attestExecutionIdentity,
      readMigration: async () => 'BEGIN; COMMIT;',
      exerciseChecks,
    },
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

test('command is inert unless the exact ephemeral contract and frozen SHA are supplied', async (t) => {
  const cases = [
    ['missing confirmation', { V1_ACCEPTANCE_CONFIRM_EPHEMERAL: undefined }, 'EPHEMERAL_CONFIRMATION_REQUIRED'],
    ['case-varied confirmation', { V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'TRUE' }, 'EPHEMERAL_CONFIRMATION_REQUIRED'],
    ['malformed commit', { V1_RELEASE_COMMIT_SHA: 'A'.repeat(40) }, 'RELEASE_COMMIT_INVALID'],
  ];
  for (const [name, patch, code] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();
      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, code);
      assert.deepEqual(fixture.calls, []);
      assert.equal(fixture.artifacts.length, 0);
    });
  }

  for (const argv of [[], ['--force'], [`--release-sha=${COMMIT}`, '--extra']]) {
    const unexpectedArg = instrumentedRun({ argv });
    assert.equal((await unexpectedArg.run()).publicReport.code, 'EXACT_INVOCATION_REQUIRED');
    assert.deepEqual(unexpectedArg.calls, []);
  }
});

test('immutable image manifest and release-scoped GCS evidence output are mandatory', async (t) => {
  const configurationCases = [
    [{ V1_RELEASE_MANIFEST_FILE: undefined }, 'RELEASE_MANIFEST_INVALID'],
    [{ V1_RELEASE_MANIFEST_FILE: '/tmp/copied-manifest.json' }, 'RELEASE_MANIFEST_INVALID'],
    [{ V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: undefined }, 'EVIDENCE_OUTPUT_INVALID'],
    [{ V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: `release-evidence/${'2'.repeat(40)}/dependency-acceptance/${RUN_ID}.json` }, 'EVIDENCE_OUTPUT_INVALID'],
    [{ V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: `release-evidence/${COMMIT}/dependency-acceptance/123e4567-e89b-42d3-a456-426614174001.json` }, 'EVIDENCE_OUTPUT_INVALID'],
    [{ V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: OUTPUT_OBJECT.toUpperCase() }, 'EVIDENCE_OUTPUT_INVALID'],
  ];
  for (const [patch, code] of configurationCases) {
    await t.test(code, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();
      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, code);
      assert.deepEqual(fixture.calls, []);
    });
  }

  for (const manifest of [
    releaseManifest({ releaseSha: '2'.repeat(40) }),
    releaseManifest({ sourceArchiveSha256: 'A'.repeat(64) }),
    releaseManifest({ buildConfigSha256: 'A'.repeat(64) }),
    (() => { const missing = releaseManifest(); delete missing.buildConfigSha256; return missing; })(),
    releaseManifest({ sourcePath: 'working-tree' }),
    { ...releaseManifest(), extra: true },
  ]) {
    await t.test(JSON.stringify(manifest).slice(0, 40), async () => {
      const fixture = instrumentedRun({ manifest });
      const result = await fixture.run();
      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.code, 'RELEASE_MANIFEST_INVALID');
      assert.deepEqual(fixture.calls, [['read', RELEASE_MANIFEST_FILE]]);
      assert.equal(fixture.artifacts.length, 0);
    });
  }
});

test('GCP identities, attached ADC, and matching UUID scopes are mandatory before any dependency opens', async (t) => {
  const cases = [
    ['wrong acceptance project', { V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT: 'other-project-12345' }],
    ['wrong production project', { V1_GOOGLE_CLOUD_PROJECT: 'other-project-12345' }],
    ['wrong bucket', { V1_ACCEPTANCE_GCS_BUCKET: 'other-private-bucket' }],
    ['wrong GCS resource', { V1_GCS_RESOURCE_ID: `gs://${BUCKET_NAME}` }],
    ['wrong database resource', { V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: `${POSTGRES_RESOURCE_ID}-other` }],
    ['different database URL', { V1_ACCEPTANCE_DATABASE_URL: DATABASE_URL.replace('hkbuddy_app', 'other_user') }],
    ['same app and migrator identity', { V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: DATABASE_URL }],
    ['same decoded app and migrator password', {
      V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: MIGRATOR_DATABASE_URL.replace(
        'private-migrator-password',
        'private%2Dpassword',
      ),
    }],
    ['wrong migrator identity', { V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: MIGRATOR_DATABASE_URL.replace('hkbuddy_migrator', 'postgres') }],
    ['wrong migrator resource', { V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: MIGRATOR_DATABASE_URL.replace('10.25.0.3', '10.25.0.4') }],
    ['broad prefix', { V1_ACCEPTANCE_GCS_PREFIX: 'v1-accept/' }],
    ['different UUID', { V1_ACCEPTANCE_GCS_PREFIX: 'v1-accept/123e4567-e89b-42d3-a456-426614174001/' }],
    ['key file ADC', { GOOGLE_APPLICATION_CREDENTIALS: 'C:\\private\\service-account.json' }],
    ['credential JSON', { V1_ACCEPTANCE_GCS_CREDENTIALS_JSON: '{"private_key":"secret"}' }],
    ['API key', { GOOGLE_API_KEY: 'private-api-key' }],
  ];
  for (const [name, patch] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ environment: { ...validEnvironment(), ...patch } });
      const result = await fixture.run();
      assert.equal(result.exitCode, 2);
      assert.equal(result.publicReport.status, 'not-run');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
      assert.equal(fixture.artifacts.length, 0);
    });
  }
});

test('direct runtime rejects equal decoded database passwords before provider construction', async () => {
  const fixture = realRuntimeOptions();
  fixture.options.migratorDatabaseUrl = MIGRATOR_DATABASE_URL.replace(
    'private-migrator-password',
    'private%2Dpassword',
  );

  await assert.rejects(
    createRealAcceptanceRuntime(fixture.options),
    /Real acceptance runtime configuration is invalid/,
  );
  assert.equal(fixture.postgres.state.options.length, 0);
  assert.equal(fixture.provider.calls.storageOptions.length, 0);
});

test('Azure-only or mixed Azure acceptance configuration fails closed instead of selecting legacy storage', async () => {
  const azure = {
    V1_ACCEPTANCE_BLOB_ACCOUNT_URL: 'https://legacy.blob.core.windows.net/',
    V1_ACCEPTANCE_BLOB_CONTAINER: 'legacy-media',
    V1_BLOB_ACCOUNT_URL: 'https://legacy.blob.core.windows.net/',
    V1_BLOB_CONTAINER: 'legacy-media',
  };
  for (const environment of [
    {
      ...validEnvironment(),
      V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT: undefined,
      V1_ACCEPTANCE_GCS_BUCKET: undefined,
      V1_ACCEPTANCE_GCS_RESOURCE_ID: undefined,
      ...azure,
    },
    { ...validEnvironment(), ...azure },
  ]) {
    const fixture = instrumentedRun({ environment });
    const result = await fixture.run();
    assert.equal(result.exitCode, 2);
    assert.equal(result.publicReport.code, 'ACCIDENTAL_AZURE_CONFIGURATION');
    assert.deepEqual(fixture.calls, []);
  }
});

test('approved legacy inventory remains the read-only collision boundary for Cloud SQL and GCS', async (t) => {
  const postgresIdentity = postgresIdentitySha256(DATABASE_URL);
  const gcsIdentity = gcsIdentitySha256({ projectId: PROJECT_ID, bucket: BUCKET_NAME });
  const cases = [
    legacyInventory({
      postgresResources: [{ resourceId: POSTGRES_RESOURCE_ID, identitySha256: 'a'.repeat(64) }],
      declaresNoLegacyPostgres: false,
    }),
    legacyInventory({
      postgresResources: [{ resourceId: 'legacy-postgres', identitySha256: postgresIdentity }],
      declaresNoLegacyPostgres: false,
    }),
    legacyInventory({
      blobResources: [{ resourceId: GCS_RESOURCE_ID, identitySha256: 'b'.repeat(64) }],
      declaresNoLegacyBlob: false,
    }),
    legacyInventory({
      blobResources: [{ resourceId: 'legacy-object-store', identitySha256: gcsIdentity }],
      declaresNoLegacyBlob: false,
    }),
  ];
  for (const inventory of cases) {
    await t.test(inventory.artifactSha256.slice(0, 8), async () => {
      const fixture = instrumentedRun({ inventory, environment: validEnvironment(inventory) });
      const result = await fixture.run();
      assert.equal(result.publicReport.code, 'LEGACY_INVENTORY_INVALID');
      assert.equal(fixture.calls.some(([kind]) => ['git', 'open'].includes(kind)), false);
    });
  }
});

test('explicit image release SHA must exactly equal the immutable configured release SHA', async (t) => {
  for (const argv of [
    [`--release-sha=${'2'.repeat(40)}`],
    [`--release-sha=${'A'.repeat(40)}`],
    ['--release-sha=release-v1'],
  ]) {
    await t.test(argv[0], async () => {
      const fixture = instrumentedRun({ argv });
      const result = await fixture.run();
      assert.equal(result.publicReport.code, 'RELEASE_SHA_MISMATCH');
      assert.equal(fixture.calls.some(([kind]) => kind === 'open'), false);
    });
  }
});

test('successful acceptance writes a validator-compatible immutable GCS evidence record without secrets', async () => {
  const inventory = legacyInventory();
  const fixture = instrumentedRun({ inventory, environment: validEnvironment(inventory) });
  const result = await fixture.run();

  assert.equal(result.exitCode, 0);
  assert.deepEqual(fixture.calls.map(([kind]) => kind), [
    'read', 'read', 'open', 'run', 'gcs-cleanup', 'schema-cleanup', 'close', 'evidence-write',
  ]);
  const [{ record, contents, objectName, artifactSha256, objectSha256 }] = fixture.artifacts;
  assert.deepEqual(Object.keys(record).sort(), [
    'artifactSha256', 'checks', 'commitSha', 'gcsIdentitySha256', 'gcsPrefix',
    'gcsPrefixObjectCount', 'gcsResourceId', 'legacyInventoryDigest', 'occurredAt',
    'postgresIdentitySha256', 'postgresResourceId', 'result', 'schema', 'schemaAbsent',
    'schemaVersion',
  ]);
  assert.equal(record.schemaVersion, 1);
  assert.equal(record.commitSha, COMMIT);
  assert.equal(record.postgresResourceId, POSTGRES_RESOURCE_ID);
  assert.equal(record.postgresIdentitySha256, postgresIdentitySha256(DATABASE_URL));
  assert.equal(record.gcsResourceId, GCS_RESOURCE_ID);
  assert.equal(record.gcsIdentitySha256, gcsIdentitySha256({ projectId: PROJECT_ID, bucket: BUCKET_NAME }));
  assert.equal(record.gcsPrefix, GCS_PREFIX);
  assert.equal(record.schemaAbsent, true);
  assert.equal(record.gcsPrefixObjectCount, 0);
  assert.equal(record.result, true);
  assert.equal(objectName, OUTPUT_OBJECT);
  assert.equal(artifactSha256, record.artifactSha256);
  assert.equal(objectSha256, sha256(contents));
  assert.notEqual(objectSha256, artifactSha256);
  assert.equal(validateDependencyAcceptanceEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha: COMMIT,
    inventory,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: postgresIdentitySha256(DATABASE_URL),
    gcsResourceId: GCS_RESOURCE_ID,
    gcsIdentitySha256: gcsIdentitySha256({ projectId: PROJECT_ID, bucket: BUCKET_NAME }),
    now: NOW,
  }).valid, true);
  assert.equal(validateReleaseEvidenceBundle({
    inventoryFile: 'inventory',
    inventoryVersion: inventory.artifactSha256,
    inventoryApproved: true,
    dependencyFile: 'dependency',
    dependencyVersion: record.artifactSha256,
    commitSha: COMMIT,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: postgresIdentitySha256(DATABASE_URL),
    gcsResourceId: GCS_RESOURCE_ID,
    gcsIdentitySha256: gcsIdentitySha256({ projectId: PROJECT_ID, bucket: BUCKET_NAME }),
    now: NOW,
    readRecord: (file) => (file === 'inventory' ? inventory : record),
  }).valid, true);

  const openInput = fixture.calls.find(([kind]) => kind === 'open')[1];
  assert.deepEqual({
    projectId: openInput.projectId,
    bucketName: openInput.bucketName,
    migratorDatabaseUrl: openInput.migratorDatabaseUrl,
    releaseSha: openInput.releaseSha,
    evidenceOutputObject: openInput.evidenceOutputObject,
    gcsPrefix: openInput.gcsPrefix,
    schema: openInput.schema,
  }, {
    projectId: PROJECT_ID,
    bucketName: BUCKET_NAME,
    migratorDatabaseUrl: MIGRATOR_DATABASE_URL,
    releaseSha: COMMIT,
    evidenceOutputObject: OUTPUT_OBJECT,
    gcsPrefix: GCS_PREFIX,
    schema: SCHEMA,
  });
  assert.equal(result.publicReport.output.objectName, OUTPUT_OBJECT);
  assert.equal(result.publicReport.output.generation, '42');
  assert.equal(result.publicReport.output.objectSha256, objectSha256);
  const serialized = `${contents}\n${JSON.stringify(result.publicReport)}`;
  for (const forbidden of [
    'private-password', 'private-migrator-password', DATABASE_URL, MIGRATOR_DATABASE_URL,
    'private-object-content', 'Authorization', 'Bearer',
  ]) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
  assert.equal(fixture.output.join('').includes('"schemaVersion"'), false);
  assert.equal(fixture.output.join('').includes('"commitSha"'), false);
});

test('GCS evidence handoff is fail closed and reports no canonical JSON on write failure', async () => {
  const fixture = instrumentedRun({
    runtime: {
      writeEvidenceObject: async () => { throw new Error(`private output ${DATABASE_URL}`); },
    },
  });
  const result = await fixture.run();
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'ACCEPTANCE_ARTIFACT_WRITE_FAILED');
  assert.equal(result.publicReport.outputObject, OUTPUT_OBJECT);
  const output = fixture.output.join('');
  assert.equal(output.includes('"schemaVersion"'), false);
  assert.equal(output.includes('private output'), false);
  assert.equal(output.includes(DATABASE_URL), false);
});

test('cleanup is exhaustive and any partial GCS, schema, or close failure invalidates evidence', async (t) => {
  const cases = [
    ['objects remain', { cleanupGcsPrefix: async () => 1 }],
    ['object cleanup throws', { cleanupGcsPrefix: async () => { throw new Error('private cleanup error'); } }],
    ['schema remains', { dropSchema: async () => false }],
    ['schema cleanup throws', { dropSchema: async () => { throw new Error('private schema error'); } }],
    ['close fails', { close: async () => { throw new Error('private close error'); } }],
  ];
  for (const [name, runtime] of cases) {
    await t.test(name, async () => {
      const fixture = instrumentedRun({ runtime });
      const result = await fixture.run();
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
      assert.deepEqual(fixture.calls.filter(([kind]) => (
        ['gcs-cleanup', 'schema-cleanup', 'close'].includes(kind)
      )).map(([kind]) => kind), ['gcs-cleanup', 'schema-cleanup', 'close']);
      assert.equal(fixture.artifacts.length, 0);
      assert.equal(JSON.stringify(result).includes('private cleanup error'), false);
      assert.equal(JSON.stringify(result).includes('private schema error'), false);
      assert.equal(JSON.stringify(result).includes('private close error'), false);
    });
  }
});

test('provider opening and functional failures still produce only safe failed evidence', async (t) => {
  await t.test('opening failure has no cleanup proof and cannot publish evidence', async () => {
    const fixture = instrumentedRun({
      openDependencies: async () => { throw new Error(`token=private-token ${DATABASE_URL}`); },
    });
    const result = await fixture.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
    assert.equal(fixture.artifacts.length, 0);
    assert.equal(JSON.stringify(result).includes('private-token'), false);
    assert.equal(JSON.stringify(result).includes(DATABASE_URL), false);
  });

  await t.test('functional failure is recorded only after complete cleanup', async () => {
    const fixture = instrumentedRun({
      runtime: { runChecks: async () => { throw new Error('private object content'); } },
    });
    const result = await fixture.run();
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'DEPENDENCY_ACCEPTANCE_FAILED');
    assert.equal(fixture.artifacts.length, 1);
    assert.equal(fixture.artifacts[0].record.result, false);
    const serialized = JSON.stringify({ result, record: fixture.artifacts[0].record });
    assert.equal(serialized.includes('private object content'), false);
    assert.equal(serialized.includes(DATABASE_URL), false);
  });
});

test('metadata attestation requires the exact dedicated acceptance service account', async (t) => {
  const calls = [];
  const email = await attestGcpExecutionIdentity({
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(`${ACCEPTANCE_SERVICE_ACCOUNT}\n`, {
        status: 200,
        headers: { 'Metadata-Flavor': 'Google' },
      });
    },
  });
  assert.equal(email, ACCEPTANCE_SERVICE_ACCOUNT);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers['Metadata-Flavor'], 'Google');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Authorization'), false);

  for (const response of [
    new Response('wrong@example.invalid', { status: 200, headers: { 'Metadata-Flavor': 'Google' } }),
    new Response(ACCEPTANCE_SERVICE_ACCOUNT, { status: 403 }),
    new Response('x'.repeat(513), { status: 200, headers: { 'Metadata-Flavor': 'Google' } }),
  ]) {
    await t.test(String(response.status), async () => {
      await assert.rejects(
        attestGcpExecutionIdentity({ fetchImpl: async () => response }),
        (error) => error?.code === 'DEPENDENCY_GCP_IDENTITY_INVALID'
          && !String(error).includes('wrong@example.invalid'),
      );
    });
  }
});

test('real acceptance rejects unavailable or wrong execution identity before touching either scope', async (t) => {
  for (const attestExecutionIdentity of [
    async () => 'hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com',
    async () => { throw new Error('private metadata failure'); },
  ]) {
    await t.test(String(attestExecutionIdentity).slice(0, 30), async () => {
      const fixture = realRuntimeOptions({ attestExecutionIdentity });
      const runtime = await createRealAcceptanceRuntime(fixture.options);
      await assert.rejects(
        runtime.runChecks(),
        (error) => error?.code === 'DEPENDENCY_GCP_IDENTITY_INVALID'
          && !String(error).includes('private metadata failure'),
      );
      assert.equal(fixture.postgres.state.sql.length, 0);
      assert.equal(fixture.provider.calls.writes.length, 0);
      await runtime.close();
    });
  }
});

test('storage ADC and bucket project ownership must match the dedicated production identity', async (t) => {
  const cases = [
    ['well-known-file credential', { storageCredentialType: 'JWT' }, 'DEPENDENCY_GCS_IDENTITY_INVALID'],
    ['cross-account credential', {
      storageClientEmail: `hkbuddy-runtime@${PROJECT_ID}.iam.gserviceaccount.com`,
    }, 'DEPENDENCY_GCS_IDENTITY_INVALID'],
    ['cross-project bucket', { bucketProjectNumber: '1234567890' }, 'DEPENDENCY_GCS_RESOURCE_INVALID'],
  ];
  for (const [name, providerOptions, code] of cases) {
    await t.test(name, async () => {
      const fixture = realRuntimeOptions({ provider: createFakeBucket(providerOptions) });
      const runtime = await createRealAcceptanceRuntime(fixture.options);
      await assert.rejects(runtime.runChecks(), (error) => (
        error?.code === code && error.message === code
      ));
      assert.equal(fixture.postgres.state.sql.length, 0);
      assert.equal(fixture.provider.calls.writes.length, 0);
      await runtime.close();
    });
  }
});

test('real acceptance rejects every PostgreSQL major other than 16 before acquiring either scope', async () => {
  const fixture = realRuntimeOptions({
    postgres: createFakePoolClass({ serverVersion: '150012' }),
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  await assert.rejects(runtime.runChecks(), (error) => (
    error?.code === 'DEPENDENCY_POSTGRES_VERSION_INVALID'
      && error.message === 'DEPENDENCY_POSTGRES_VERSION_INVALID'
  ));
  assert.equal(fixture.provider.calls.writes.length, 0);
  assert.equal(fixture.postgres.state.sql.some(([, sql]) => /CREATE SCHEMA/i.test(sql)), false);
  await runtime.close();
});

test('real runtime uses project-scoped attached ADC and proves intended GCS lifecycle and access', async () => {
  const fixture = realRuntimeOptions({
    exerciseChecks: async ({ gcsClient, gcsPrefix }) => {
      assert.equal(gcsPrefix, GCS_PREFIX);
      await gcsClient.assertIntendedAccess();
      const first = `${gcsPrefix}probe/one.bin`;
      const second = `${gcsPrefix}probe/two.bin`;
      const firstBytes = Buffer.from('acceptance-one', 'utf8');
      await gcsClient.putObject({
        name: first, bytes: firstBytes, contentType: 'application/octet-stream', ifAbsent: true,
      });
      await gcsClient.putObject({
        name: second, bytes: Buffer.from('acceptance-two'), contentType: 'application/octet-stream', ifAbsent: true,
      });
      const metadata = await gcsClient.headObject({ name: first });
      assert.equal(metadata.size, firstBytes.length);
      assert.deepEqual(await gcsClient.readObject({ name: first }), firstBytes);
      assert.deepEqual(await gcsClient.readObject({ name: first, start: 1, end: 4 }), firstBytes.subarray(1, 5));
      const firstPage = await gcsClient.listObjectsPage({ prefix: `${gcsPrefix}probe/`, limit: 1 });
      assert.deepEqual(firstPage.names, [first]);
      assert.ok(firstPage.cursor);
      const secondPage = await gcsClient.listObjectsPage({
        prefix: `${gcsPrefix}probe/`, limit: 1, cursor: firstPage.cursor,
      });
      assert.deepEqual(secondPage.names, [second]);
      assert.equal(secondPage.cursor, null);
      await gcsClient.assertObjectPrivate(first);
      assert.equal(await gcsClient.deleteObject({ name: first }), true);
      assert.equal(await gcsClient.deleteObject({ name: first }), false);
      return passChecks();
    },
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  const checks = await runtime.runChecks();
  assert.deepEqual(checks.slice(-passChecks().length), passChecks());
  assert.equal(checks.some(({ name, status }) => (
    name === 'gcp-execution-identity' && status === 'pass'
  )), true);
  assert.equal(checks.some(({ name, status }) => (
    name === `gcp-identity-${sha256(ACCEPTANCE_SERVICE_ACCOUNT)}` && status === 'pass'
  )), true);
  assert.equal(checks.some(({ name, status }) => (
    name === 'gcs-adc-identity' && status === 'pass'
  )), true);
  assert.equal(checks.some(({ name, status }) => (
    name === 'gcs-bucket-project' && status === 'pass'
  )), true);
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.deepEqual(fixture.provider.calls.storageOptions, [{ projectId: PROJECT_ID }]);
  assert.deepEqual(fixture.provider.calls.storageCredentials, [
    ['client', 'Compute'],
    ['credentials', ACCEPTANCE_SERVICE_ACCOUNT],
  ]);
  assert.deepEqual(fixture.provider.calls.bucketMetadata, [BUCKET_NAME]);
  assert.deepEqual(
    fixture.provider.calls.permissions[0].filter((name) => REQUIRED_GCS_PERMISSIONS.includes(name)),
    REQUIRED_GCS_PERMISSIONS,
  );
  assert.equal(fixture.provider.calls.signedUrls, 0);
  assert.equal(fixture.provider.calls.publicFetches.length, 1);
  assert.equal(Object.hasOwn(fixture.provider.calls.publicFetches[0].options.headers ?? {}, 'Authorization'), false);
  assert.deepEqual([...fixture.provider.objects], []);
  assert.equal(fixture.postgres.state.schemaExists, false);
  assert.deepEqual(fixture.postgres.state.ended.sort(), [0, 1, 2, 3]);
});

test('real runtime uses migrator only for isolated DDL and a duplicate publish preserves the first evidence object', async () => {
  const fixture = realRuntimeOptions();
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  const record = legacyInventory();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const artifactSha256 = record.artifactSha256;
  const objectSha256 = sha256(contents);
  assert.notEqual(artifactSha256, objectSha256);

  await runtime.runChecks();
  await assert.rejects(
    runtime.writeEvidenceObject({
      objectName: OUTPUT_OBJECT, contents, artifactSha256, objectSha256,
    }),
    (error) => error?.code === 'DEPENDENCY_EVIDENCE_OUTPUT_NOT_READY',
  );
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();
  const published = await runtime.writeEvidenceObject({
    objectName: OUTPUT_OBJECT, contents, artifactSha256, objectSha256,
  });
  assert.deepEqual(published, {
    objectName: OUTPUT_OBJECT,
    generation: '2',
    artifactSha256,
    objectSha256,
  });
  assert.deepEqual(fixture.provider.objects.get(OUTPUT_OBJECT).bytes, Buffer.from(contents));
  const firstGeneration = fixture.provider.objects.get(OUTPUT_OBJECT).generation;
  assert.equal([...fixture.provider.objects.keys()].some((name) => name.startsWith(GCS_PREFIX)), false);
  assert.equal(fixture.provider.calls.publicFetches.length, 1);
  assert.equal(fixture.provider.calls.publicFetches[0].options.headers?.Authorization, undefined);
  await assert.rejects(
    runtime.writeEvidenceObject({
      objectName: OUTPUT_OBJECT, contents, artifactSha256, objectSha256,
    }),
    (error) => error?.code === 'DEPENDENCY_EVIDENCE_OUTPUT_EXISTS',
  );
  assert.equal(fixture.provider.objects.get(OUTPUT_OBJECT).generation, firstGeneration);
  assert.deepEqual(fixture.provider.objects.get(OUTPUT_OBJECT).bytes, Buffer.from(contents));
  assert.equal(fixture.provider.calls.deletes.some(({ name }) => name === OUTPUT_OBJECT), false);

  const migratorSql = fixture.postgres.state.sql
    .filter(([index]) => [0, 1].includes(index)).map(([, sql]) => sql).join('\n');
  const appSql = fixture.postgres.state.sql
    .filter(([index]) => [2, 3].includes(index)).map(([, sql]) => sql).join('\n');
  assert.match(migratorSql, /CREATE SCHEMA/);
  assert.match(migratorSql, /GRANT USAGE ON SCHEMA/);
  assert.match(migratorSql, /DROP SCHEMA/);
  assert.equal(/CREATE SCHEMA|DROP SCHEMA|GRANT USAGE ON SCHEMA/.test(appSql), false);
});

test('pre-existing identical immutable evidence is never deleted after a known create-only conflict', async () => {
  const record = legacyInventory();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const provider = createFakeBucket({
    initialObjects: [[OUTPUT_OBJECT, Buffer.from(contents)]],
  });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await runtime.runChecks();
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  await assert.rejects(
    runtime.writeEvidenceObject({
      objectName: OUTPUT_OBJECT,
      contents,
      artifactSha256: record.artifactSha256,
      objectSha256: sha256(contents),
    }),
    (error) => error?.code === 'DEPENDENCY_EVIDENCE_OUTPUT_EXISTS',
  );
  assert.equal(provider.objects.get(OUTPUT_OBJECT).generation, '1');
  assert.deepEqual(provider.objects.get(OUTPUT_OBJECT).bytes, Buffer.from(contents));
  assert.equal(provider.calls.deletes.some(({ name }) => name === OUTPUT_OBJECT), false);
});

test('ambiguous evidence commit is deleted only when its per-attempt nonce proves ownership', async () => {
  const record = legacyInventory();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const provider = createFakeBucket({ commitWriteThenErrorName: OUTPUT_OBJECT });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  const input = {
    objectName: OUTPUT_OBJECT,
    contents,
    artifactSha256: record.artifactSha256,
    objectSha256: sha256(contents),
  };

  await runtime.runChecks();
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  await assert.rejects(runtime.writeEvidenceObject(input), (error) => (
    error?.code === 'DEPENDENCY_GCS_RESPONSE_INVALID'
  ));
  assert.equal(provider.objects.has(OUTPUT_OBJECT), false);
  const compensatingDelete = provider.calls.deletes.find(({ name }) => name === OUTPUT_OBJECT);
  assert.equal(compensatingDelete?.generation, '2');

  const receipt = await runtime.writeEvidenceObject(input);
  assert.equal(receipt.generation, '3');
});

test('ambiguous evidence conflict preserves identical bytes that lack the current attempt nonce', async () => {
  const record = legacyInventory();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const provider = createFakeBucket({
    initialObjects: [[OUTPUT_OBJECT, Buffer.from(contents)]],
    ambiguousConditionalConflict: true,
  });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await runtime.runChecks();
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  await assert.rejects(runtime.writeEvidenceObject({
    objectName: OUTPUT_OBJECT,
    contents,
    artifactSha256: record.artifactSha256,
    objectSha256: sha256(contents),
  }));
  assert.equal(provider.objects.get(OUTPUT_OBJECT).generation, '1');
  assert.deepEqual(provider.objects.get(OUTPUT_OBJECT).bytes, Buffer.from(contents));
  assert.equal(provider.calls.deletes.some(({ name }) => name === OUTPUT_OBJECT), false);
});

test('failed evidence verification deletes the exact committed generation and permits a clean rerun', async () => {
  const provider = createFakeBucket({ publicStatuses: [200, 403] });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  const record = legacyInventory();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const input = {
    objectName: OUTPUT_OBJECT,
    contents,
    artifactSha256: record.artifactSha256,
    objectSha256: sha256(contents),
  };

  await runtime.runChecks();
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  await assert.rejects(runtime.writeEvidenceObject(input), (error) => (
    error?.code === 'DEPENDENCY_GCS_ACCESS_INVALID'
  ));
  assert.equal(provider.objects.has(OUTPUT_OBJECT), false);
  const compensatingDelete = provider.calls.deletes.find(({ name }) => name === OUTPUT_OBJECT);
  assert.equal(compensatingDelete?.generation, '2');

  const receipt = await runtime.writeEvidenceObject(input);
  assert.equal(receipt.generation, '3');
  assert.equal(provider.objects.has(OUTPUT_OBJECT), true);
});

test('hostile GCS permissions, public access, metadata, and list responses fail closed without provider detail', async (t) => {
  const cases = [
    ['forbidden permission', createFakeBucket({ permissions: permissionMap({ 'storage.buckets.setIamPolicy': true }) }),
      async (client) => client.assertIntendedAccess()],
    ['missing object permission', createFakeBucket({ permissions: permissionMap({ 'storage.objects.delete': false }) }),
      async (client) => client.assertIntendedAccess()],
    ['public object', createFakeBucket({ publicStatus: 200 }), async (client, prefix) => {
      const name = `${prefix}public.bin`;
      await client.putObject({ name, bytes: Buffer.from('secret'), contentType: 'application/octet-stream' });
      return client.assertObjectPrivate(name);
    }],
    ['malformed metadata', createFakeBucket({ malformedMetadata: { name: `${GCS_PREFIX}bad.bin`, size: 'NaN' } }),
      async (client, prefix) => {
        const name = `${prefix}bad.bin`;
        await client.putObject({ name, bytes: Buffer.from('x'), contentType: 'application/octet-stream' });
        return client.headObject({ name });
      }],
    ['escaped list', createFakeBucket({
      malformedListName: 'outside/private-object',
      malformedListPrefix: `${GCS_PREFIX}probe/`,
    }), async (client, prefix) => {
      await client.putObject({
        name: `${prefix}probe/item.bin`,
        bytes: Buffer.from('x'),
        contentType: 'application/octet-stream',
      });
      return client.listObjectsPage({ prefix: `${prefix}probe/`, limit: 1 });
    }],
  ];
  for (const [name, provider, operation] of cases) {
    await t.test(name, async () => {
      const fixture = realRuntimeOptions({ provider, exerciseChecks: async ({ gcsClient, gcsPrefix }) => {
        await operation(gcsClient, gcsPrefix);
        return passChecks();
      } });
      const runtime = await createRealAcceptanceRuntime(fixture.options);
      await assert.rejects(runtime.runChecks(), (error) => (
        ['DEPENDENCY_GCS_ACCESS_INVALID', 'DEPENDENCY_GCS_RESPONSE_INVALID'].includes(error?.code)
          && error.message === error.code
          && !String(error.stack).includes('private-object-content')
      ));
      await runtime.cleanupGcsPrefix(GCS_PREFIX);
      await runtime.dropSchema(SCHEMA);
      await runtime.close();
    });
  }
});

test('oversized object metadata is rejected before any range stream opens', async () => {
  const name = `${GCS_PREFIX}oversized.bin`;
  const provider = createFakeBucket({
    malformedMetadata: {
      name,
      size: String((8 * 1024 * 1024) + 1),
      generation: '1',
      contentType: 'application/octet-stream',
    },
  });
  const fixture = realRuntimeOptions({
    provider,
    exerciseChecks: async ({ gcsClient }) => {
      await gcsClient.putObject({
        name,
        bytes: Buffer.from('x'),
        contentType: 'application/octet-stream',
        ifAbsent: true,
      });
      const readsBeforeOversizedObject = provider.calls.reads.length;
      await assert.rejects(
        gcsClient.readObject({ name, start: 0, end: 0 }),
        (error) => error?.code === 'DEPENDENCY_GCS_RESPONSE_INVALID',
      );
      assert.equal(provider.calls.reads.length, readsBeforeOversizedObject);
      return passChecks();
    },
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await runtime.runChecks();
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();
});

test('hung GCS provider work is bounded by both operation deadline and parent cancellation', async (t) => {
  for (const trigger of ['deadline', 'parent']) {
    await t.test(trigger, async (child) => {
      child.mock.timers.enable({ apis: ['setTimeout'] });
      const provider = createFakeBucket({ hangList: true });
      const fixture = realRuntimeOptions({ provider, operationDeadlineMs: 25 });
      const runtime = await createRealAcceptanceRuntime(fixture.options);
      const parent = new AbortController();
      const observation = observeSettlement(runtime.runChecks({ signal: parent.signal }));
      await flushAsyncWork();
      if (trigger === 'deadline') child.mock.timers.tick(25);
      else parent.abort(Object.assign(new Error('DEPENDENCY_OPERATION_CANCELLED'), {
        code: 'DEPENDENCY_OPERATION_CANCELLED',
      }));
      await flushAsyncWork();
      assert.equal(observation.settled, true);
      assert.equal(observation.status, 'rejected');
      assert.ok(['DEPENDENCY_OPERATION_DEADLINE_EXCEEDED', 'DEPENDENCY_OPERATION_CANCELLED']
        .includes(observation.error?.code));
    });
  }
});

test('pre-existing PostgreSQL schema or GCS prefix is never acquired, swept, or dropped', async (t) => {
  await t.test('schema', async () => {
    const fixture = realRuntimeOptions({ postgres: createFakePoolClass({ schemaInitiallyExists: true }) });
    const runtime = await createRealAcceptanceRuntime(fixture.options);
    await assert.rejects(runtime.runChecks());
    assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
    assert.equal(await runtime.dropSchema(SCHEMA), false);
    await runtime.close();
    assert.equal(fixture.provider.calls.deletes.length, 0);
    assert.equal(fixture.postgres.state.sql.some(([, sql]) => /DROP SCHEMA/i.test(sql)), false);
  });

  await t.test('prefix', async () => {
    const existing = `${GCS_PREFIX}existing-object`;
    const fixture = realRuntimeOptions({ provider: createFakeBucket({
      initialObjects: [[existing, Buffer.from('legacy')]],
    }) });
    const runtime = await createRealAcceptanceRuntime(fixture.options);
    await assert.rejects(runtime.runChecks());
    assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 1);
    assert.equal(await runtime.dropSchema(SCHEMA), true);
    await runtime.close();
    assert.equal(fixture.provider.objects.has(existing), true);
    assert.equal(fixture.provider.calls.deletes.length, 0);
    assert.equal(fixture.postgres.state.sql.some(([, sql]) => /CREATE SCHEMA/i.test(sql)), false);
  });
});

test('GCS cleanup recovers a create that committed before the transport failed', async () => {
  const owner = `${GCS_PREFIX}.acceptance-owner`;
  const fixture = realRuntimeOptions({
    provider: createFakeBucket({ commitWriteThenErrorName: owner }),
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks(), (error) => (
    error?.code === 'DEPENDENCY_GCS_RESPONSE_INVALID'
  ));
  assert.equal(fixture.provider.objects.has(owner), true, 'the simulated provider committed first');
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.equal(fixture.provider.objects.size, 0);
  assert.equal(fixture.provider.calls.deletes.some(({ name }) => name === owner), true);
});

test('GCS conditional-create collision loser preserves the concurrent winner prefix', async () => {
  const owner = `${GCS_PREFIX}.acceptance-owner`;
  const winnerBytes = Buffer.from('winner-owned-prefix');
  const provider = createFakeBucket({
    concurrentConditionalWrite: {
      name: owner,
      bytes: winnerBytes,
      customMetadata: { hkbuddyAcceptanceNonce: 'winner-attempt-nonce' },
    },
  });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks(), (error) => (
    error?.code === 'DEPENDENCY_GCS_SCOPE_CONFLICT'
  ));
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 1);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.deepEqual(provider.objects.get(owner).bytes, winnerBytes);
  assert.equal(provider.calls.deletes.some(({ name }) => name === owner), false);
});

test('GCS ambiguous create result preserves a winner whose nonce does not match this attempt', async () => {
  const owner = `${GCS_PREFIX}.acceptance-owner`;
  const winnerBytes = Buffer.from('ambiguous-winner-owned-prefix');
  const provider = createFakeBucket({
    concurrentConditionalWrite: {
      name: owner,
      bytes: winnerBytes,
      customMetadata: { hkbuddyAcceptanceNonce: 'ambiguous-winner-nonce' },
    },
    ambiguousConditionalConflict: true,
  });
  const fixture = realRuntimeOptions({ provider });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks(), (error) => (
    error?.code === 'DEPENDENCY_GCS_RESPONSE_INVALID'
  ));
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 1);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.deepEqual(provider.objects.get(owner).bytes, winnerBytes);
  assert.equal(provider.calls.deletes.some(({ name }) => name === owner), false);
});

test('PostgreSQL cleanup recovers a schema create that committed before the transport failed', async () => {
  const fixture = realRuntimeOptions({
    postgres: createFakePoolClass({ commitCreateThenError: true }),
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks());
  assert.equal(fixture.postgres.state.schemaExists, true, 'the simulated server committed first');
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();

  assert.equal(fixture.postgres.state.schemaExists, false);
  assert.equal(fixture.postgres.state.sql.some(([, sql]) => /DROP SCHEMA/i.test(sql)), true);
});

test('PostgreSQL duplicate-schema collision loser preserves the concurrent winner schema', async () => {
  const winnerOwner = 'winner-postgres-attempt-nonce';
  const postgres = createFakePoolClass({ concurrentCreateCollisionOwner: winnerOwner });
  const fixture = realRuntimeOptions({ postgres });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks(), (error) => (
    error?.code === 'DEPENDENCY_POSTGRES_SCOPE_CONFLICT'
  ));
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), false);
  await runtime.close();

  assert.equal(postgres.state.schemaExists, true);
  assert.equal(postgres.state.schemaOwnerToken, winnerOwner);
  assert.equal(postgres.state.sql.some(([, sql]) => /DROP SCHEMA/i.test(sql)), false);
});

test('PostgreSQL ambiguous create result preserves a schema with another attempt nonce', async () => {
  const winnerOwner = 'ambiguous-winner-postgres-nonce';
  const postgres = createFakePoolClass({ ambiguousCreateCollisionOwner: winnerOwner });
  const fixture = realRuntimeOptions({ postgres });
  const runtime = await createRealAcceptanceRuntime(fixture.options);

  await assert.rejects(runtime.runChecks(), (error) => (
    error?.message === 'transport hid the concurrent schema create result'
  ));
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), false);
  await runtime.close();

  assert.equal(postgres.state.schemaExists, true);
  assert.equal(postgres.state.schemaOwnerToken, winnerOwner);
  assert.equal(postgres.state.sql.some(([, sql]) => /DROP SCHEMA/i.test(sql)), false);
});

test('owned cleanup deletes every paginated object and proves zero schema objects and zero prefix objects', async () => {
  const fixture = realRuntimeOptions({
    exerciseChecks: async ({ gcsClient, gcsPrefix }) => {
      for (let index = 0; index < 205; index += 1) {
        await gcsClient.putObject({
          name: `${gcsPrefix}cleanup/${String(index).padStart(3, '0')}.bin`,
          bytes: Buffer.from([index % 251]),
          contentType: 'application/octet-stream',
          ifAbsent: true,
        });
      }
      return [{ name: 'injected-cleanup-contract', status: 'pass', latencyMs: 1 }];
    },
  });
  const runtime = await createRealAcceptanceRuntime(fixture.options);
  await runtime.runChecks();
  assert.equal(fixture.provider.objects.size, 206, '205 probes plus the owner marker');
  assert.equal(await runtime.cleanupGcsPrefix(GCS_PREFIX), 0);
  assert.equal(await runtime.dropSchema(SCHEMA), true);
  await runtime.close();
  assert.equal(fixture.provider.objects.size, 0);
  assert.equal(fixture.postgres.state.schemaExists, false);
  assert.ok(fixture.provider.calls.lists.some(({ maxResults }) => maxResults === 100));
  assert.equal(fixture.provider.calls.deletes.length, 206);
});
