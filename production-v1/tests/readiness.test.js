import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { loadConfig } from '../src/config.js';
import {
  blobIdentitySha256,
  finalizeReleaseEvidenceRecord,
  llmProviderConfigDigest,
  postgresIdentitySha256,
  readReleaseEvidenceRecord,
  validateDependencyAcceptanceEvidence,
  validateLegacyResourceInventory,
  validateReleaseEvidenceBundle,
} from '../src/services/release-evidence.js';
import {
  evaluateProductionReadiness,
  readinessCheckNames,
} from '../src/services/readiness.js';
import { runProductionReadiness } from '../scripts/production-readiness.js';

const NOW = new Date('2026-08-25T12:00:00.000Z');
const COMMIT = '1'.repeat(40);
const POSTGRES_RESOURCE_ID = '/subscriptions/new/resourceGroups/v1/providers/Microsoft.DBforPostgreSQL/flexibleServers/v1-db';
const BLOB_RESOURCE_ID = '/subscriptions/new/resourceGroups/v1/providers/Microsoft.Storage/storageAccounts/v1storage';
const POSTGRES_IDENTITY = '37e3ef0cd42741f428370ea8381fd9150406e460513d0bb3deeb61ac08ec8d18';
const BLOB_IDENTITY = 'fc85e13a0ac799694d2cfbead9dec319c5bc5130b6a991de6e0e193a20bbd454';

function inventoryPayload(overrides = {}) {
  return {
    schemaVersion: 1,
    commitSha: COMMIT,
    legacyApplicationIds: ['hkbuddy-pilot-0630'],
    legacyOrigins: ['https://hkbuddy-pilot-0630.azurewebsites.net'],
    postgresResources: [{
      resourceId: '/subscriptions/legacy/resourceGroups/legacy/providers/Microsoft.DBforPostgreSQL/flexibleServers/legacy-db',
      identitySha256: 'a'.repeat(64),
    }],
    blobResources: [{
      resourceId: '/subscriptions/legacy/resourceGroups/legacy/providers/Microsoft.Storage/storageAccounts/legacyblob',
      identitySha256: 'b'.repeat(64),
    }],
    declaresNoLegacyPostgres: false,
    declaresNoLegacyBlob: false,
    reviewedAt: NOW.toISOString(),
    result: true,
    ...overrides,
  };
}

function dependencyPayload(inventory, overrides = {}) {
  return {
    schemaVersion: 1,
    commitSha: COMMIT,
    legacyInventoryDigest: inventory.artifactSha256,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: POSTGRES_IDENTITY,
    blobResourceId: BLOB_RESOURCE_ID,
    blobIdentitySha256: BLOB_IDENTITY,
    schema: 'v1_accept_12345678123441238123123456789abc',
    blobPrefix: 'v1-accept/12345678-1234-4123-8123-123456789abc/',
    checks: [
      { name: 'postgres-migration-health', status: 'pass', latencyMs: 1 },
      { name: 'postgres-concurrency-recovery', status: 'pass', latencyMs: 2 },
      { name: 'postgres-integrity-events', status: 'pass', latencyMs: 3 },
      { name: 'postgres-rate-window-fencing', status: 'pass', latencyMs: 4 },
      { name: 'blob-private-full-range-head', status: 'pass', latencyMs: 5 },
      { name: 'postgres-media-fencing', status: 'pass', latencyMs: 6 },
    ],
    schemaAbsent: true,
    blobPrefixObjectCount: 0,
    result: true,
    occurredAt: NOW.toISOString(),
    ...overrides,
  };
}

async function productionFixture(t, {
  inventoryOverrides = {},
  dependencyOverrides = {},
  environmentOverrides = {},
} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hk-buddy-readiness-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inventory = finalizeReleaseEvidenceRecord(inventoryPayload(inventoryOverrides));
  const dependency = finalizeReleaseEvidenceRecord(dependencyPayload(inventory, dependencyOverrides));
  const llmConfig = {
    provider: 'hkbu',
    credentialVersion: 'llm-credential-v1',
    timeoutMs: 12_000,
    settings: {
      apiKey: 'private-provider-key',
      baseUrl: 'https://llm.example.test',
      model: 'hkbu-model',
      apiVersion: 'v1',
    },
  };
  const llmSmoke = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: COMMIT,
    capability: 'llm',
    provider: 'hkbu',
    contractVersion: 'llm-connectivity-json-v1',
    providerConfigDigest: llmProviderConfigDigest(llmConfig),
    occurredAt: NOW.toISOString(),
    result: 'pass',
    httpClass: '2xx',
    normalizedSuccess: true,
    requestCount: 1,
    latencyMs: 1,
    usage: { inputTokens: null, outputTokens: null, totalTokens: null },
  });
  const inventoryFile = join(directory, 'legacy-inventory.json');
  const dependencyFile = join(directory, 'dependency-acceptance.json');
  const llmSmokeFile = join(directory, 'llm-smoke.json');
  await writeFile(inventoryFile, JSON.stringify(inventory));
  await writeFile(dependencyFile, JSON.stringify(dependency));
  await writeFile(llmSmokeFile, JSON.stringify(llmSmoke));
  const environment = {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: 'https://v1.example.test',
    V1_SESSION_SECRET: 'private-session-secret-private-session-secret',
    V1_TRUST_PROXY_HOPS: '1',
    V1_STORE_DRIVER: 'postgres',
    V1_DATABASE_URL: 'postgres://private-user:private-password@v1-db.example.test/campus%20v1?sslmode=require',
    V1_POSTGRES_RESOURCE_ID: POSTGRES_RESOURCE_ID,
    V1_MEDIA_DRIVER: 'azure-blob',
    V1_AZURE_BLOB_ACCOUNT_URL: 'https://v1storage.blob.core.windows.net/',
    V1_AZURE_BLOB_CONTAINER: 'v1-private',
    V1_BLOB_RESOURCE_ID: BLOB_RESOURCE_ID,
    V1_LLM_PROVIDER: 'hkbu',
    V1_HKBU_API_KEY: 'private-provider-key',
    V1_HKBU_BASE_URL: 'https://llm.example.test',
    V1_HKBU_MODEL: 'hkbu-model',
    V1_HKBU_API_VERSION: 'v1',
    V1_LLM_CREDENTIAL_VERSION: llmConfig.credentialVersion,
    V1_LLM_SMOKE_EVIDENCE_FILE: llmSmokeFile,
    V1_LLM_SMOKE_EVIDENCE_VERSION: llmSmoke.artifactSha256,
    V1_INSTANCE_POLICY: 'single',
    V1_PRIVACY_NOTICE_VERSION: 'privacy-v1',
    V1_PRIVACY_NOTICE_APPROVED: 'true',
    V1_RETENTION_WORKER_ENABLED: 'true',
    V1_RELEASE_COMMIT_SHA: COMMIT,
    V1_LEGACY_RESOURCE_INVENTORY_FILE: inventoryFile,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: inventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE: dependencyFile,
    V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION: dependency.artifactSha256,
    ...environmentOverrides,
  };
  return {
    dependency, dependencyFile, directory, environment, inventory, inventoryFile,
    llmSmoke, llmSmokeFile,
  };
}

test('legacy inventory accepts only the artifact-bound owner-reviewed known legacy inventory', () => {
  const record = finalizeReleaseEvidenceRecord(inventoryPayload());

  const result = validateLegacyResourceInventory(record, {
    expectedVersion: record.artifactSha256,
    commitSha: COMMIT,
    now: NOW,
  });

  assert.equal(result.valid, true);
  assert.equal(result.code, null);
  assert.equal(result.record, record);
});

test('legacy inventory rejects unknown fields, incomplete one-of declarations, identity drift, and stale review', async (t) => {
  const cases = [
    ['unknown top-level field', (value) => { value.privatePath = 'must-not-be-accepted'; }],
    ['wrong schema', (value) => { value.schemaVersion = 2; }],
    ['missing known app', (value) => { value.legacyApplicationIds = ['some-other-app']; }],
    ['missing known origin', (value) => { value.legacyOrigins = ['https://other.example.test']; }],
    ['unknown resource field', (value) => { value.postgresResources[0].host = 'private.example.test'; }],
    ['duplicate resource id', (value) => { value.postgresResources.push({ ...value.postgresResources[0], identitySha256: 'c'.repeat(64) }); }],
    ['case-variant duplicate resource id', (value) => {
      value.postgresResources.push({
        resourceId: value.postgresResources[0].resourceId.toUpperCase(),
        identitySha256: 'c'.repeat(64),
      });
    }],
    ['duplicate identity', (value) => { value.postgresResources.push({ resourceId: '/subscriptions/other', identitySha256: value.postgresResources[0].identitySha256 }); }],
    ['postgres list with none flag', (value) => { value.declaresNoLegacyPostgres = true; }],
    ['empty postgres without none flag', (value) => { value.postgresResources = []; }],
    ['blob list with none flag', (value) => { value.declaresNoLegacyBlob = true; }],
    ['empty blob without none flag', (value) => { value.blobResources = []; }],
    ['uppercase identity digest', (value) => { value.blobResources[0].identitySha256 = 'A'.repeat(64); }],
    ['failed owner result', (value) => { value.result = false; }],
    ['wrong commit', (value) => { value.commitSha = '2'.repeat(40); }],
    ['stale review', (value) => { value.reviewedAt = '2026-08-18T11:59:59.999Z'; }],
    ['future review beyond skew', (value) => { value.reviewedAt = '2026-08-25T12:05:00.001Z'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const payload = structuredClone(inventoryPayload());
      mutate(payload);
      const record = finalizeReleaseEvidenceRecord(payload);
      assert.equal(validateLegacyResourceInventory(record, {
        expectedVersion: record.artifactSha256,
        commitSha: COMMIT,
        now: NOW,
      }).valid, false);
    });
  }

  await t.test('artifact tampering', () => {
    const record = finalizeReleaseEvidenceRecord(inventoryPayload());
    record.reviewedAt = '2026-08-25T11:59:59.000Z';
    assert.equal(validateLegacyResourceInventory(record, {
      expectedVersion: record.artifactSha256,
      commitSha: COMMIT,
      now: NOW,
    }).valid, false);
  });

  await t.test('version mismatch', () => {
    const record = finalizeReleaseEvidenceRecord(inventoryPayload());
    assert.equal(validateLegacyResourceInventory(record, {
      expectedVersion: 'f'.repeat(64),
      commitSha: COMMIT,
      now: NOW,
    }).valid, false);
  });
});

test('legacy inventory accepts explicit reviewed-none declarations independently for each resource class', () => {
  for (const overrides of [
    { postgresResources: [], declaresNoLegacyPostgres: true },
    { blobResources: [], declaresNoLegacyBlob: true },
    {
      postgresResources: [], declaresNoLegacyPostgres: true,
      blobResources: [], declaresNoLegacyBlob: true,
    },
  ]) {
    const record = finalizeReleaseEvidenceRecord(inventoryPayload(overrides));
    assert.equal(validateLegacyResourceInventory(record, {
      expectedVersion: record.artifactSha256,
      commitSha: COMMIT,
      now: NOW,
    }).valid, true);
  }
});

test('resource identities are credential-free canonical hashes and reject ambiguous production values', () => {
  assert.equal(postgresIdentitySha256(
    'postgres://private-user:private-password@V1-DB.EXAMPLE.TEST/campus%20v1?sslmode=require',
  ), POSTGRES_IDENTITY);
  assert.equal(postgresIdentitySha256(
    'postgresql://other-user:other-secret@v1-db.example.test:5432/campus%20v1',
  ), POSTGRES_IDENTITY);
  assert.equal(blobIdentitySha256({
    accountUrl: 'https://V1Storage.blob.core.windows.net/',
    container: 'v1-private',
  }), BLOB_IDENTITY);
  assert.equal(blobIdentitySha256({
    connectionString: 'DefaultEndpointsProtocol=https;AccountName=V1Storage;AccountKey=private-key;EndpointSuffix=core.windows.net',
    container: 'v1-private',
  }), BLOB_IDENTITY);

  assert.throws(() => postgresIdentitySha256('https://v1-db.example.test/campus'), /identity/i);
  assert.throws(() => postgresIdentitySha256('postgres://db-a,db-b/campus'), /identity/i);
  for (const query of [
    'host=legacy-db.example.test',
    'hostaddr=127.0.0.1',
    'port=6543',
    'dbname=legacy',
    'database=legacy',
    'user=legacy-user',
    'password=legacy-secret',
    'options=-c%20search_path%3Dpublic',
    'service=legacy-service',
    'passfile=C%3A%5Cprivate%5Cpgpass',
    'target_session_attrs=read-write',
    'sslmode=require&sslmode=disable',
    'sslmode=disable',
    'sslmode=no-verify',
    'sslmode=prefer',
  ]) {
    assert.throws(
      () => postgresIdentitySha256(`postgresql://v1-db.example.test/campus?${query}`),
      /identity/i,
      query,
    );
  }
  assert.equal(postgresIdentitySha256(
    'postgresql://v1-db.example.test/campus%20v1?sslmode=verify-full',
  ), POSTGRES_IDENTITY);
  assert.throws(() => blobIdentitySha256({ accountUrl: 'http://v1storage.blob.core.windows.net', container: 'v1-private' }), /identity/i);
  assert.throws(() => blobIdentitySha256({
    accountUrl: 'https://v1storage.blob.core.windows.net:8443/',
    container: 'v1-private',
  }), /identity/i);
  assert.throws(() => blobIdentitySha256({
    connectionString: 'BlobEndpoint=https://v1storage.blob.core.windows.net:8443/;AccountName=V1Storage;AccountKey=private-key',
    container: 'v1-private',
  }), /identity/i);
  assert.throws(() => blobIdentitySha256({ connectionString: 'UseDevelopmentStorage=true', container: 'v1-private' }), /identity/i);
});

test('dependency acceptance binds the exact commit, inventory, current resources, cleanup, and isolated run', () => {
  const inventory = finalizeReleaseEvidenceRecord(inventoryPayload());
  const evidence = finalizeReleaseEvidenceRecord(dependencyPayload(inventory));

  const result = validateDependencyAcceptanceEvidence(evidence, {
    expectedVersion: evidence.artifactSha256,
    commitSha: COMMIT,
    inventory,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: POSTGRES_IDENTITY,
    blobResourceId: BLOB_RESOURCE_ID,
    blobIdentitySha256: BLOB_IDENTITY,
    now: NOW,
  });

  assert.equal(result.valid, true);
  assert.equal(result.code, null);
  assert.equal(result.record, evidence);
});

test('dependency acceptance rejects drift, unsafe shapes, failed cleanup, and stale evidence', async (t) => {
  const inventory = finalizeReleaseEvidenceRecord(inventoryPayload());
  const validate = (record, overrides = {}) => validateDependencyAcceptanceEvidence(record, {
    expectedVersion: record.artifactSha256,
    commitSha: COMMIT,
    inventory,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: POSTGRES_IDENTITY,
    blobResourceId: BLOB_RESOURCE_ID,
    blobIdentitySha256: BLOB_IDENTITY,
    now: NOW,
    ...overrides,
  });
  const cases = [
    ['unknown field', (value) => { value.databaseUrl = 'postgres://private'; }],
    ['wrong schema version', (value) => { value.schemaVersion = 2; }],
    ['wrong commit', (value) => { value.commitSha = '2'.repeat(40); }],
    ['wrong inventory digest', (value) => { value.legacyInventoryDigest = 'c'.repeat(64); }],
    ['wrong postgres resource', (value) => { value.postgresResourceId = '/subscriptions/other'; }],
    ['wrong postgres identity', (value) => { value.postgresIdentitySha256 = 'c'.repeat(64); }],
    ['wrong blob resource', (value) => { value.blobResourceId = '/subscriptions/other'; }],
    ['wrong blob identity', (value) => { value.blobIdentitySha256 = 'd'.repeat(64); }],
    ['schema remains', (value) => { value.schemaAbsent = false; }],
    ['blob remains', (value) => { value.blobPrefixObjectCount = 1; }],
    ['failed result', (value) => { value.result = false; }],
    ['stale evidence', (value) => { value.occurredAt = '2026-08-18T11:59:59.999Z'; }],
    ['future evidence', (value) => { value.occurredAt = '2026-08-25T12:05:00.001Z'; }],
    ['schema and prefix UUID differ', (value) => { value.schema = 'v1_accept_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; }],
    ['unisolated schema', (value) => { value.schema = 'public'; }],
    ['unisolated blob prefix', (value) => { value.blobPrefix = 'legacy/'; }],
    ['unknown check field', (value) => { value.checks[0].detail = 'private'; }],
    ['failed named check', (value) => { value.checks[0].status = 'fail'; }],
    ['duplicate named check', (value) => { value.checks.push({ ...value.checks[0] }); }],
    ['missing core check', (value) => { value.checks = value.checks.slice(1); }],
    ['renamed core check', (value) => { value.checks[0].name = 'invented-migration-check'; }],
  ];

  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const payload = structuredClone(dependencyPayload(inventory));
      mutate(payload);
      const record = finalizeReleaseEvidenceRecord(payload);
      assert.equal(validate(record).valid, false);
    });
  }

  await t.test('artifact tampering', () => {
    const record = finalizeReleaseEvidenceRecord(dependencyPayload(inventory));
    record.result = false;
    assert.equal(validate(record).valid, false);
  });

  await t.test('current resource found in legacy inventory', () => {
    const overlappingInventory = finalizeReleaseEvidenceRecord(inventoryPayload({
      postgresResources: [{ resourceId: POSTGRES_RESOURCE_ID, identitySha256: POSTGRES_IDENTITY }],
    }));
    const record = finalizeReleaseEvidenceRecord(dependencyPayload(overlappingInventory));
    assert.equal(validateDependencyAcceptanceEvidence(record, {
      expectedVersion: record.artifactSha256,
      commitSha: COMMIT,
      inventory: overlappingInventory,
      postgresResourceId: POSTGRES_RESOURCE_ID,
      postgresIdentitySha256: POSTGRES_IDENTITY,
      blobResourceId: BLOB_RESOURCE_ID,
      blobIdentitySha256: BLOB_IDENTITY,
      now: NOW,
    }).valid, false);
  });

  await t.test('case-variant current resource id found with a different identity digest', () => {
    const overlappingInventory = finalizeReleaseEvidenceRecord(inventoryPayload({
      postgresResources: [{
        resourceId: POSTGRES_RESOURCE_ID.toUpperCase(),
        identitySha256: 'c'.repeat(64),
      }],
    }));
    const record = finalizeReleaseEvidenceRecord(dependencyPayload(overlappingInventory));
    assert.equal(validateDependencyAcceptanceEvidence(record, {
      expectedVersion: record.artifactSha256,
      commitSha: COMMIT,
      inventory: overlappingInventory,
      postgresResourceId: POSTGRES_RESOURCE_ID,
      postgresIdentitySha256: POSTGRES_IDENTITY,
      blobResourceId: BLOB_RESOURCE_ID,
      blobIdentitySha256: BLOB_IDENTITY,
      now: NOW,
    }).valid, false);
  });
});

test('release evidence bundle requires both approved exact file/version pairs', async (t) => {
  const fixture = await productionFixture(t);
  const options = {
    inventoryFile: fixture.inventoryFile,
    inventoryVersion: fixture.inventory.artifactSha256,
    inventoryApproved: true,
    dependencyFile: fixture.dependencyFile,
    dependencyVersion: fixture.dependency.artifactSha256,
    commitSha: COMMIT,
    postgresResourceId: POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: POSTGRES_IDENTITY,
    blobResourceId: BLOB_RESOURCE_ID,
    blobIdentitySha256: BLOB_IDENTITY,
    now: NOW,
  };

  assert.equal(validateReleaseEvidenceBundle(options).valid, true);
  for (const overrides of [
    { inventoryFile: null },
    { inventoryVersion: null },
    { inventoryApproved: false },
    { dependencyFile: null },
    { dependencyVersion: null },
    { inventoryVersion: 'f'.repeat(64) },
    { dependencyVersion: 'e'.repeat(64) },
  ]) {
    assert.equal(validateReleaseEvidenceBundle({ ...options, ...overrides }).valid, false);
  }
});

test('release evidence reader uses one fixed-cap regular-file descriptor', () => {
  const record = finalizeReleaseEvidenceRecord(inventoryPayload());
  const source = Buffer.from(JSON.stringify(record));
  const state = { closes: 0, cursor: 0, firstReadLength: null, opens: 0 };
  const regularStat = (size = source.length) => ({
    dev: 5,
    ino: 17,
    size,
    isFile: () => true,
    isSymbolicLink: () => false,
  });
  const dependencies = {
    fileConstants: { O_RDONLY: 0, O_NOFOLLOW: 0x100, O_NONBLOCK: 0x200 },
    lstatFile: () => regularStat(),
    openFile(filePath, flags) {
      assert.equal(filePath, 'release-evidence.json');
      assert.equal(flags, 0x300);
      state.opens += 1;
      return 51;
    },
    fstatFile: () => regularStat(),
    readBytes(fd, target, offset, length, position) {
      assert.equal(fd, 51);
      assert.equal(position, null);
      state.firstReadLength ??= length;
      const count = Math.min(length, source.length - state.cursor);
      if (count <= 0) return 0;
      source.copy(target, offset, state.cursor, state.cursor + count);
      state.cursor += count;
      return count;
    },
    closeFile(fd) {
      assert.equal(fd, 51);
      state.closes += 1;
    },
  };

  assert.deepEqual(readReleaseEvidenceRecord('release-evidence.json', dependencies), record);
  assert.deepEqual(state, {
    closes: 1,
    cursor: source.length,
    firstReadLength: 1_048_577,
    opens: 1,
  });

  const prefix = JSON.stringify(record);
  const oversized = Buffer.from(`${prefix}${' '.repeat(1_048_576 - Buffer.byteLength(prefix))}X`);
  let oversizedCursor = 0;
  let oversizedCloses = 0;
  const oversizedResult = readReleaseEvidenceRecord('release-evidence.json', {
    ...dependencies,
    lstatFile: () => regularStat(1),
    fstatFile: () => regularStat(1),
    readBytes(fd, target, offset, length) {
      const count = Math.min(length, oversized.length - oversizedCursor);
      if (count <= 0) return 0;
      oversized.copy(target, offset, oversizedCursor, oversizedCursor + count);
      oversizedCursor += count;
      return count;
    },
    closeFile: () => { oversizedCloses += 1; },
  });
  assert.equal(oversizedResult, null);
  assert.equal(oversizedCursor, 1_048_577);
  assert.equal(oversizedCloses, 1);
});

test('production storage selects only V1-prefixed database, Blob, and resource identities', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });

  assert.equal(config.databaseUrl, fixture.environment.V1_DATABASE_URL);
  assert.equal(config.mediaAccountUrl, fixture.environment.V1_AZURE_BLOB_ACCOUNT_URL);
  assert.equal(config.mediaContainer, fixture.environment.V1_AZURE_BLOB_CONTAINER);
  assert.equal(config.postgresResourceId, POSTGRES_RESOURCE_ID);
  assert.equal(config.blobResourceId, BLOB_RESOURCE_ID);
  assert.equal(config.productionConfigurationReady, true);
  assert.equal(config.productionReady, false, 'runtime checks are still required');

  const cases = [
    ['V1_DATABASE_URL', { DATABASE_URL: fixture.environment.V1_DATABASE_URL }],
    ['V1_AZURE_BLOB_ACCOUNT_URL', { AZURE_BLOB_ACCOUNT_URL: fixture.environment.V1_AZURE_BLOB_ACCOUNT_URL }],
    ['V1_AZURE_BLOB_CONTAINER', { AZURE_BLOB_CONTAINER: fixture.environment.V1_AZURE_BLOB_CONTAINER }],
    ['V1_POSTGRES_RESOURCE_ID', { POSTGRES_RESOURCE_ID }],
    ['V1_BLOB_RESOURCE_ID', { BLOB_RESOURCE_ID }],
  ];
  for (const [missing, legacy] of cases) {
    const environment = { ...fixture.environment, ...legacy };
    delete environment[missing];
    assert.throws(() => loadConfig(environment, { now: () => NOW }), new RegExp(missing));
  }
  assert.throws(
    () => loadConfig({ ...fixture.environment, V1_POSTGRES_RESOURCE_ID: '   ' }, { now: () => NOW }),
    /V1_POSTGRES_RESOURCE_ID/,
  );
  assert.throws(
    () => loadConfig({ ...fixture.environment, V1_BLOB_RESOURCE_ID: '\t' }, { now: () => NOW }),
    /V1_BLOB_RESOURCE_ID/,
  );
});

test('local preview retains legacy storage compatibility without becoming production ready', () => {
  const config = loadConfig({
    NODE_ENV: 'test',
    STORE_DRIVER: 'postgres',
    DATABASE_URL: 'postgres://local-user:local-secret@localhost/local',
    POSTGRES_RESOURCE_ID: 'local-postgres',
    MEDIA_DRIVER: 'azure-blob',
    AZURE_BLOB_ACCOUNT_URL: 'https://localblob.blob.core.windows.net/',
    AZURE_BLOB_CONTAINER: 'local-preview',
    BLOB_RESOURCE_ID: 'local-blob',
  });

  assert.equal(config.databaseUrl, 'postgres://local-user:local-secret@localhost/local');
  assert.equal(config.mediaAccountUrl, 'https://localblob.blob.core.windows.net/');
  assert.equal(config.mediaContainer, 'local-preview');
  assert.equal(config.postgresResourceId, 'local-postgres');
  assert.equal(config.blobResourceId, 'local-blob');
  assert.equal(config.productionReady, false);
});

test('production config rejects missing, unapproved, tampered, and stale release evidence at load time', async (t) => {
  const fixture = await productionFixture(t);
  for (const [name, overrides] of [
    ['missing inventory file', { V1_LEGACY_RESOURCE_INVENTORY_FILE: undefined }],
    ['missing inventory version', { V1_LEGACY_RESOURCE_INVENTORY_VERSION: undefined }],
    ['unapproved inventory', { V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'false' }],
    ['missing dependency file', { V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE: undefined }],
    ['missing dependency version', { V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION: undefined }],
  ]) {
    assert.throws(
      () => loadConfig({ ...fixture.environment, ...overrides }, { now: () => NOW }),
      /release evidence|inventory|dependency/i,
      name,
    );
  }

  const tampered = JSON.parse(JSON.stringify(fixture.dependency));
  tampered.schemaAbsent = false;
  await writeFile(fixture.dependencyFile, JSON.stringify(tampered));
  assert.throws(() => loadConfig(fixture.environment, { now: () => NOW }), /release evidence|dependency/i);
});

test('config public status never exposes evidence paths, resource identities, digests, URLs, or secrets', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const serialized = JSON.stringify(config.publicStatus);

  for (const privateValue of [
    fixture.inventoryFile,
    fixture.dependencyFile,
    fixture.inventory.artifactSha256,
    fixture.dependency.artifactSha256,
    POSTGRES_RESOURCE_ID,
    BLOB_RESOURCE_ID,
    POSTGRES_IDENTITY,
    BLOB_IDENTITY,
    fixture.environment.V1_DATABASE_URL,
    fixture.environment.V1_AZURE_BLOB_ACCOUNT_URL,
    fixture.environment.V1_SESSION_SECRET,
    fixture.environment.V1_HKBU_API_KEY,
  ]) assert.equal(serialized.includes(privateValue), false);
});

function healthyReadinessChecks(counter = { calls: [] }) {
  return Object.fromEntries(readinessCheckNames.map((name) => [name, async () => {
    counter.calls.push(name);
    if (name === 'retention') {
      return {
        name,
        status: 'ready',
        healthy: true,
        policyVersion: 'retention-v1',
        heartbeatAt: '2026-08-25T11:59:59.000Z',
        privateUrl: 'https://private-retention.example.test',
      };
    }
    return {
      name,
      status: 'ready',
      healthy: true,
      version: `${name}-v1`,
      privateDigest: 'f'.repeat(64),
      privatePath: `C:\\private\\${name}`,
    };
  }]));
}

function settleWithin(promise, timeoutMs, message) {
  let timer;
  const guard = new Promise((resolve, reject) => {
    void resolve;
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

test('aggregate readiness revalidates evidence before all injected production checks', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const counter = { calls: [] };
  const checks = healthyReadinessChecks(counter);

  const result = await evaluateProductionReadiness({
    config,
    checks,
    now: () => NOW,
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'ready');
  assert.equal(result.publicReport.productionReady, true);
  assert.equal(result.publicReport.boundary, 'production-v1');
  assert.deepEqual(counter.calls, readinessCheckNames);
  assert.deepEqual(result.publicReport.checks.map(({ name, status }) => ({ name, status })), [
    { name: 'configuration', status: 'ready' },
    { name: 'release-evidence', status: 'ready' },
    { name: 'llm-smoke', status: 'ready' },
    ...readinessCheckNames.map((name) => ({ name, status: 'ready' })),
  ]);

  const serialized = JSON.stringify(result.publicReport);
  for (const privateValue of [
    fixture.inventoryFile,
    fixture.dependencyFile,
    fixture.inventory.artifactSha256,
    fixture.dependency.artifactSha256,
    fixture.llmSmokeFile,
    fixture.llmSmoke.artifactSha256,
    POSTGRES_RESOURCE_ID,
    BLOB_RESOURCE_ID,
    POSTGRES_IDENTITY,
    BLOB_IDENTITY,
    fixture.environment.V1_DATABASE_URL,
    fixture.environment.V1_AZURE_BLOB_ACCOUNT_URL,
    'private-retention.example.test',
    'C:\\private',
    'f'.repeat(64),
  ]) assert.equal(serialized.includes(privateValue), false);
});

test('tampered evidence blocks readiness before any dependency or runtime check connects', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const counter = { calls: [] };
  const checks = healthyReadinessChecks(counter);
  const tampered = structuredClone(fixture.dependency);
  tampered.schemaAbsent = false;
  await writeFile(fixture.dependencyFile, JSON.stringify(tampered));

  const result = await evaluateProductionReadiness({ config, checks, now: () => NOW });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.productionReady, false);
  assert.equal(result.publicReport.status, 'not-ready');
  assert.deepEqual(counter.calls, []);
  assert.deepEqual(result.publicReport.checks, [
    { name: 'configuration', status: 'ready', version: 'production-config-v1' },
    { name: 'release-evidence', status: 'not-ready', version: 'release-evidence-v1' },
  ]);
});

test('readiness re-reads LLM smoke evidence, fails redacted, and performs zero provider generation', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const counter = { calls: [] };
  const checks = healthyReadinessChecks(counter);
  const tampered = structuredClone(fixture.llmSmoke);
  tampered.normalizedSuccess = false;
  await writeFile(fixture.llmSmokeFile, JSON.stringify(tampered));
  let providerGenerateCalls = 0;

  const result = await evaluateProductionReadiness({
    config,
    checks,
    now: () => NOW,
    llmProvider: { generate: async () => { providerGenerateCalls += 1; } },
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.productionReady, false);
  assert.equal(providerGenerateCalls, 0);
  assert.deepEqual(counter.calls, []);
  assert.deepEqual(result.publicReport.checks.at(-1), {
    name: 'llm-smoke', status: 'not-ready', version: 'llm-smoke-v1',
  });
  const serialized = JSON.stringify(result.publicReport);
  assert.equal(serialized.includes(fixture.llmSmokeFile), false);
  assert.equal(serialized.includes(fixture.llmSmoke.artifactSha256), false);
  assert.equal(serialized.includes('private-provider-key'), false);
});

test('retention, dispatcher, and runtime checks independently keep aggregate readiness red', async (t) => {
  for (const failedName of ['retention', 'dispatcher', 'runtime']) {
    await t.test(failedName, async (inner) => {
      const fixture = await productionFixture(inner);
      const config = loadConfig(fixture.environment, { now: () => NOW });
      const checks = healthyReadinessChecks();
      checks[failedName] = async () => ({
        name: failedName,
        status: failedName === 'retention' ? 'stale' : 'not-ready',
        healthy: false,
        privateError: 'secret dependency detail',
      });

      const result = await evaluateProductionReadiness({ config, checks, now: () => NOW });

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.productionReady, false);
      assert.equal(result.publicReport.checks.find((check) => check.name === failedName).status, 'not-ready');
      assert.equal(JSON.stringify(result.publicReport).includes('secret dependency detail'), false);
    });
  }
});

test('ready dependency checks require healthy to be exactly true', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const cases = [
    ['missing', { name: 'database', status: 'ready', version: 'database-v1' }],
    ['null', { name: 'database', status: 'ready', healthy: null, version: 'database-v1' }],
    ['wrong type', { name: 'database', status: 'ready', healthy: 'true', version: 'database-v1' }],
  ];

  for (const [name, outcome] of cases) {
    await t.test(name, async () => {
      const checks = healthyReadinessChecks();
      checks.database = async () => outcome;

      const result = await evaluateProductionReadiness({ config, checks, now: () => NOW });

      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.productionReady, false);
      assert.equal(result.publicReport.checks.find((check) => check.name === 'database').status, 'not-ready');
    });
  }
});

test('a never-settling dependency check is deadline-bounded and reported only as redacted not-ready', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  config.readinessCheckTimeoutMs = 10;
  const counter = { calls: [] };
  const checks = healthyReadinessChecks(counter);
  let rejectDatabase;
  let databaseSignal = null;
  let abortEvents = 0;
  checks.database = async ({ signal } = {}) => new Promise((resolve, reject) => {
    void resolve;
    databaseSignal = signal;
    rejectDatabase = reject;
    signal?.addEventListener('abort', () => {
      abortEvents += 1;
      reject(new Error('private aborted database query'));
    }, { once: true });
  });

  const evaluating = evaluateProductionReadiness({ config, checks, now: () => NOW });
  const result = await settleWithin(
    evaluating,
    200,
    'readiness waited indefinitely for a dependency check',
  ).finally(() => rejectDatabase?.(new Error('private late database failure')));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.productionReady, false);
  assert.deepEqual(result.publicReport.checks.find((check) => check.name === 'database'), {
    name: 'database', status: 'not-ready',
  });
  assert.equal(result.publicReport.checks.find((check) => check.name === 'media').status, 'ready');
  assert.deepEqual(counter.calls, readinessCheckNames.filter((name) => name !== 'database'));
  assert.equal(databaseSignal instanceof AbortSignal, true);
  assert.equal(databaseSignal.aborted, true);
  assert.equal(abortEvents, 1);
  assert.equal(JSON.stringify(result.publicReport).includes('private late database failure'), false);
});

test('an outer readiness cancellation aborts the current adapter and starts no later dependency check', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  config.readinessCheckTimeoutMs = 1_000;
  const controller = new AbortController();
  let databaseSignal = null;
  let mediaCalls = 0;
  const checks = healthyReadinessChecks();
  checks.database = ({ signal } = {}) => new Promise((resolve) => {
    databaseSignal = signal;
    signal?.addEventListener('abort', () => resolve({ status: 'not-ready', healthy: false }), { once: true });
  });
  checks.media = async () => {
    mediaCalls += 1;
    return { status: 'ready', healthy: true };
  };

  const evaluating = evaluateProductionReadiness({
    config,
    checks,
    now: () => NOW,
    signal: controller.signal,
  });
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  const result = await settleWithin(evaluating, 200, 'outer readiness cancellation was not propagated');

  assert.equal(result.exitCode, 1);
  assert.equal(databaseSignal?.aborted, true);
  assert.equal(mediaCalls, 0);
});

test('missing and throwing injected checks fail safely without exposing exception detail', async (t) => {
  const fixture = await productionFixture(t);
  const config = loadConfig(fixture.environment, { now: () => NOW });
  const checks = healthyReadinessChecks();
  delete checks.database;
  checks.media = async () => { throw new Error('private media endpoint failure'); };

  const result = await evaluateProductionReadiness({ config, checks, now: () => NOW });

  assert.equal(result.publicReport.productionReady, false);
  assert.equal(result.publicReport.checks.find((check) => check.name === 'database').status, 'not-ready');
  assert.equal(result.publicReport.checks.find((check) => check.name === 'media').status, 'not-ready');
  assert.equal(JSON.stringify(result.publicReport).includes('private media endpoint failure'), false);
});

test('local readiness is an explicit nonzero preview boundary and never invokes production checks', async () => {
  const counter = { calls: [] };
  const result = await evaluateProductionReadiness({
    config: loadConfig({ NODE_ENV: 'test' }),
    checks: healthyReadinessChecks(counter),
    now: () => NOW,
  });

  assert.equal(result.exitCode, 2);
  assert.deepEqual(result.publicReport, {
    status: 'preview',
    productionReady: false,
    boundary: 'local-preview-only',
    checks: [{ name: 'configuration', status: 'preview', version: 'local-preview-v1' }],
  });
  assert.deepEqual(counter.calls, []);
});

test('readiness command reports local preview nonzero without constructing production dependencies', async () => {
  const output = [];
  let dependencyCalls = 0;
  const checks = Object.fromEntries(readinessCheckNames.map((name) => [name, async () => {
    dependencyCalls += 1;
    throw new Error('must never connect');
  }]));

  const result = await runProductionReadiness({
    environment: { NODE_ENV: 'test' },
    checks,
    now: () => NOW,
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 2);
  assert.equal(result.publicReport.boundary, 'local-preview-only');
  assert.equal(result.publicReport.productionReady, false);
  assert.equal(dependencyCalls, 0);
  assert.deepEqual(output, [`${JSON.stringify(result.publicReport)}\n`]);
});

test('readiness command is fail-closed and redacted when configuration cannot load', async () => {
  const output = [];
  const result = await runProductionReadiness({
    environment: {
      NODE_ENV: 'production',
      V1_SESSION_SECRET: 'private-command-secret',
      V1_DATABASE_URL: 'postgres://private-command-db',
    },
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.productionReady, false);
  assert.equal(result.publicReport.status, 'not-ready');
  assert.equal(JSON.stringify({ result, output }).includes('private-command'), false);
});

test('production readiness command evaluates and closes the live server runtime', async () => {
  const order = [];
  const output = [];
  const config = { nodeEnv: 'production' };
  const expected = {
    exitCode: 0,
    publicReport: {
      status: 'ready', productionReady: true, boundary: 'production-v1',
      checks: [{ name: 'runtime', status: 'ready', version: 'single-instance-v1' }],
    },
  };
  const result = await runProductionReadiness({
    environment: { NODE_ENV: 'production' },
    loadConfigImpl: () => config,
    evaluateReadinessImpl: async () => assert.fail('the live runtime owns production evaluation'),
    createRuntime: async ({ config: observed }) => {
      assert.equal(observed, config);
      order.push('runtime:create');
      return {
        readiness: async () => {
          order.push('runtime:readiness');
          return expected;
        },
        close: async () => order.push('runtime:close'),
      };
    },
    writeOutput: (line) => output.push(line),
  });

  assert.deepEqual(result, expected);
  assert.deepEqual(order, ['runtime:create', 'runtime:readiness', 'runtime:close']);
  assert.deepEqual(output, [`${JSON.stringify(expected.publicReport)}\n`]);
});

test('production readiness command fails closed when live runtime cleanup cannot complete', async () => {
  const output = [];
  const result = await runProductionReadiness({
    environment: { NODE_ENV: 'production' },
    loadConfigImpl: () => ({ nodeEnv: 'production' }),
    createRuntime: async () => ({
      readiness: async () => ({
        exitCode: 0,
        publicReport: {
          status: 'ready', productionReady: true, boundary: 'production-v1', checks: [],
        },
      }),
      close: async () => { throw new Error('private shutdown detail'); },
    }),
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.productionReady, false);
  assert.equal(JSON.stringify({ result, output }).includes('private shutdown detail'), false);
});
