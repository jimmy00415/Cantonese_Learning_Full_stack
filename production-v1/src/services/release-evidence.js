import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
} from 'node:fs';

const DAY_MS = 24 * 60 * 60 * 1_000;
const FUTURE_SKEW_MS = 5 * 60 * 1_000;
const LLM_SMOKE_MAX_BYTES = 64 * 1_024;
const RELEASE_EVIDENCE_MAX_BYTES = 1_024 * 1_024;
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const APPLICATION_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const KNOWN_LEGACY_APPLICATION_ID = 'hkbuddy-pilot-0630';
const KNOWN_LEGACY_ORIGIN = 'https://hkbuddy-pilot-0630.azurewebsites.net';
const INVENTORY_KEYS = [
  'artifactSha256',
  'blobResources',
  'commitSha',
  'declaresNoLegacyBlob',
  'declaresNoLegacyPostgres',
  'legacyApplicationIds',
  'legacyOrigins',
  'postgresResources',
  'result',
  'reviewedAt',
  'schemaVersion',
];
const RESOURCE_KEYS = ['identitySha256', 'resourceId'];
const DEPENDENCY_KEYS = [
  'artifactSha256',
  'blobIdentitySha256',
  'blobPrefix',
  'blobPrefixObjectCount',
  'blobResourceId',
  'checks',
  'commitSha',
  'legacyInventoryDigest',
  'occurredAt',
  'postgresIdentitySha256',
  'postgresResourceId',
  'result',
  'schema',
  'schemaAbsent',
  'schemaVersion',
];
const GCS_DEPENDENCY_KEYS = [
  'artifactSha256',
  'checks',
  'commitSha',
  'gcsIdentitySha256',
  'gcsPrefix',
  'gcsPrefixObjectCount',
  'gcsResourceId',
  'legacyInventoryDigest',
  'occurredAt',
  'postgresIdentitySha256',
  'postgresResourceId',
  'result',
  'schema',
  'schemaAbsent',
  'schemaVersion',
];
const LLM_SMOKE_KEYS = [
  'artifactSha256',
  'capability',
  'commitSha',
  'contractVersion',
  'httpClass',
  'latencyMs',
  'normalizedSuccess',
  'occurredAt',
  'provider',
  'providerConfigDigest',
  'requestCount',
  'result',
  'schemaVersion',
  'usage',
];
const LLM_USAGE_KEYS = ['inputTokens', 'outputTokens', 'totalTokens'];
const LLM_PROVIDERS = new Set(['hkbu', 'azure-openai', 'minimax', 'vertex-ai']);
export const DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES = Object.freeze([
  'postgres-migration-health',
  'postgres-concurrency-recovery',
  'postgres-integrity-events',
  'postgres-rate-window-fencing',
  'blob-private-full-range-head',
  'postgres-media-fencing',
]);
const GCS_DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES = Object.freeze([
  'postgres-migration-health',
  'postgres-concurrency-recovery',
  'postgres-integrity-events',
  'postgres-rate-window-fencing',
  'gcs-private-full-range-head',
  'postgres-media-fencing',
]);
const ACCEPTANCE_SCHEMA = /^v1_accept_([0-9a-f]{32})$/;
const ACCEPTANCE_PREFIX = /^v1-accept\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const SAFE_VERSION = /^[a-z0-9][a-z0-9._-]{0,79}$/i;
const CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const POSTGRES_QUERY_ALLOWLIST = new Map([
  ['sslmode', new Set(['require', 'verify-ca', 'verify-full'])],
]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export const LLM_SMOKE_CONTRACT_VERSION = 'llm-connectivity-json-v1';

function llmConfigurationError() {
  return new Error('LLM evidence configuration is invalid');
}

function safeConfigurationText(value) {
  if (typeof value !== 'string' || value !== value.trim() || value.length < 1
    || value.length > 1_024 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw llmConfigurationError();
  }
  return value;
}

function normalizedHttpsBase(value) {
  let parsed;
  try { parsed = new URL(String(value ?? '')); } catch { throw llmConfigurationError(); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw llmConfigurationError();
  }
  return parsed.href.replace(/\/+$/, '');
}

function llmProviderConfigDescriptor(config) {
  const provider = config?.provider;
  const settings = config?.settings ?? {};
  const credentialVersion = safeConfigurationText(config?.credentialVersion);
  const timeoutMs = config?.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 12_000) {
    throw llmConfigurationError();
  }
  let transport;
  if (provider === 'hkbu') {
    transport = {
      apiVersion: safeConfigurationText(settings.apiVersion),
      baseUrl: normalizedHttpsBase(settings.baseUrl),
      model: safeConfigurationText(settings.model),
    };
  } else if (provider === 'azure-openai') {
    if (!['standard', 'reasoning'].includes(settings.requestProfile)
      || !Number.isSafeInteger(settings.minCompletionTokens)
      || settings.minCompletionTokens < 800 || settings.minCompletionTokens > 6_000) {
      throw llmConfigurationError();
    }
    transport = {
      apiVersion: safeConfigurationText(settings.apiVersion),
      deployment: safeConfigurationText(settings.deployment),
      endpoint: normalizedHttpsBase(settings.endpoint),
      minCompletionTokens: settings.minCompletionTokens,
      requestProfile: settings.requestProfile,
    };
  } else if (provider === 'minimax') {
    transport = {
      anthropicBaseUrl: normalizedHttpsBase(settings.anthropicBaseUrl),
      baseUrl: normalizedHttpsBase(settings.baseUrl),
      model: safeConfigurationText(settings.model),
    };
  } else if (provider === 'vertex-ai') {
    const projectId = safeConfigurationText(settings.projectId);
    const location = safeConfigurationText(settings.location);
    const model = safeConfigurationText(settings.model);
    if (projectId !== 'hkbuddy-prod-v1-20260826'
      || location !== 'global' || model !== 'gemini-2.5-flash') {
      throw llmConfigurationError();
    }
    transport = {
      endpoint: `https://aiplatform.googleapis.com/v1/projects/${projectId}/locations/${location}/publishers/google/models/${model}:generateContent`,
      location,
      model,
      projectId,
      authentication: 'adc-attached-service-account',
    };
  } else {
    throw llmConfigurationError();
  }
  return {
    capability: 'llm',
    contractVersion: LLM_SMOKE_CONTRACT_VERSION,
    credentialVersion,
    provider,
    timeoutMs,
    transport,
  };
}

export function llmProviderConfigDigest(config) {
  return sha256(canonicalJson(llmProviderConfigDescriptor(config)));
}

export function finalizeReleaseEvidenceRecord(record) {
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return {
    ...payload,
    artifactSha256: sha256(canonicalJson(payload)),
  };
}

function postgresIdentity(databaseUrl, { requireSecureTransport = false } = {}) {
  let parsed;
  try { parsed = new URL(String(databaseUrl ?? '')); } catch { throw new Error('PostgreSQL identity is invalid'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)
    || !parsed.hostname || parsed.hostname.includes(',')
    || parsed.pathname.length < 2 || parsed.pathname.indexOf('/', 1) !== -1
    || parsed.hash) throw new Error('PostgreSQL identity is invalid');
  const queryKeys = new Set();
  for (const [key, value] of parsed.searchParams) {
    const allowedValues = POSTGRES_QUERY_ALLOWLIST.get(key);
    if (!allowedValues?.has(value) || queryKeys.has(key)) {
      throw new Error('PostgreSQL identity is invalid');
    }
    queryKeys.add(key);
  }
  if (requireSecureTransport && !queryKeys.has('sslmode')) {
    throw new Error('PostgreSQL runtime URL requires an explicit secure sslmode');
  }
  let database;
  try { database = decodeURIComponent(parsed.pathname.slice(1)); } catch { throw new Error('PostgreSQL identity is invalid'); }
  if (!database || database.includes('/') || /[\u0000-\u001f\u007f]/.test(database)) {
    throw new Error('PostgreSQL identity is invalid');
  }
  const port = parsed.port ? Number(parsed.port) : 5432;
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error('PostgreSQL identity is invalid');
  return ['postgres', parsed.hostname.toLowerCase(), port, database];
}

export function postgresIdentitySha256(databaseUrl) {
  return sha256(canonicalJson(postgresIdentity(databaseUrl)));
}

export function assertSecurePostgresRuntimeUrl(databaseUrl) {
  postgresIdentity(databaseUrl, { requireSecureTransport: true });
}

function parseConnectionString(value) {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Azure Blob identity is invalid');
  const parts = new Map();
  for (const segment of value.split(';').filter(Boolean)) {
    const separator = segment.indexOf('=');
    if (separator <= 0) throw new Error('Azure Blob identity is invalid');
    const key = segment.slice(0, separator).trim().toLowerCase();
    const member = segment.slice(separator + 1).trim();
    if (!key || !member || parts.has(key)) throw new Error('Azure Blob identity is invalid');
    parts.set(key, member);
  }
  return parts;
}

function blobHost({ accountUrl, connectionString }) {
  let endpoint = accountUrl;
  if (connectionString) {
    if (accountUrl) throw new Error('Azure Blob identity is invalid');
    const parts = parseConnectionString(connectionString);
    if (parts.has('usedevelopmentstorage') || parts.has('developmentstorageproxyuri')) {
      throw new Error('Azure Blob identity is invalid');
    }
    endpoint = parts.get('blobendpoint');
    if (!endpoint) {
      const protocol = parts.get('defaultendpointsprotocol');
      const account = parts.get('accountname');
      const suffix = parts.get('endpointsuffix');
      if (protocol?.toLowerCase() !== 'https' || !account || !suffix) {
        throw new Error('Azure Blob identity is invalid');
      }
      endpoint = `https://${account}.blob.${suffix}/`;
    }
  }
  let parsed;
  try { parsed = new URL(String(endpoint ?? '')); } catch { throw new Error('Azure Blob identity is invalid'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
    || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('Azure Blob identity is invalid');
  }
  return parsed.hostname.toLowerCase();
}

export function blobIdentitySha256({ accountUrl, connectionString, container } = {}) {
  if (typeof container !== 'string' || !CONTAINER.test(container)) throw new Error('Azure Blob identity is invalid');
  return sha256(canonicalJson(['azure-blob', blobHost({ accountUrl, connectionString }), container]));
}

export function gcsIdentitySha256(value = {}) {
  if (!exactKeys(value, ['bucket', 'projectId'])
    || value.projectId !== 'hkbuddy-prod-v1-20260826'
    || value.bucket !== 'hkbuddy-prod-v1-20260826-media') {
    throw new Error('GCS identity is invalid');
  }
  return sha256(canonicalJson(['gcs', value.projectId, value.bucket]));
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === expected.join('\0'));
}

function validInstant(value, now, maximumAgeMs) {
  const occurredAt = Date.parse(value);
  const current = new Date(now).getTime();
  return Number.isFinite(occurredAt) && Number.isFinite(current)
    && occurredAt <= current + FUTURE_SKEW_MS
    && current - occurredAt <= maximumAgeMs;
}

function validOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && !parsed.username && !parsed.password
      && parsed.pathname === '/' && !parsed.search && !parsed.hash
      && value === parsed.origin;
  } catch {
    return false;
  }
}

function validStringList(values, predicate) {
  return Array.isArray(values) && values.length > 0
    && values.every(predicate)
    && new Set(values).size === values.length;
}

function normalizedResourceId(value) {
  return value.toLowerCase();
}

function validResourceList(resources, declaresNone) {
  if (!Array.isArray(resources) || typeof declaresNone !== 'boolean') return false;
  if ((resources.length === 0) !== declaresNone) return false;
  const ids = new Set();
  const identities = new Set();
  for (const resource of resources) {
    const normalizedId = typeof resource?.resourceId === 'string'
      ? normalizedResourceId(resource.resourceId)
      : null;
    if (!exactKeys(resource, RESOURCE_KEYS)
      || typeof resource.resourceId !== 'string'
      || resource.resourceId !== resource.resourceId.trim()
      || resource.resourceId.length < 1 || resource.resourceId.length > 1_024
      || /[\u0000-\u001f\u007f]/.test(resource.resourceId)
      || !DIGEST.test(String(resource.identitySha256 ?? ''))
      || ids.has(normalizedId)
      || identities.has(resource.identitySha256)) return false;
    ids.add(normalizedId);
    identities.add(resource.identitySha256);
  }
  return true;
}

function validArtifact(record, expectedVersion) {
  return DIGEST.test(String(expectedVersion ?? ''))
    && record?.artifactSha256 === expectedVersion
    && finalizeReleaseEvidenceRecord(record).artifactSha256 === record.artifactSha256;
}

function validLlmInstant(value, now) {
  if (typeof value !== 'string') return false;
  const occurredAt = Date.parse(value);
  const current = new Date(now).getTime();
  return Number.isFinite(occurredAt) && Number.isFinite(current)
    && new Date(occurredAt).toISOString() === value
    && occurredAt <= current + FUTURE_SKEW_MS
    && current - occurredAt <= 7 * DAY_MS;
}

function validLlmUsage(usage) {
  return exactKeys(usage, LLM_USAGE_KEYS)
    && LLM_USAGE_KEYS.every((name) => (
      usage[name] === null
      || (Number.isSafeInteger(usage[name]) && usage[name] >= 0)
    ));
}

export function validateLlmSmokeEvidence(record, {
  expectedVersion,
  commitSha,
  provider,
  configDigest,
  now = new Date(),
} = {}) {
  const valid = Boolean(
    RELEASE_SHA.test(String(commitSha ?? ''))
    && LLM_PROVIDERS.has(provider)
    && DIGEST.test(String(configDigest ?? ''))
    && exactKeys(record, LLM_SMOKE_KEYS)
    && validArtifact(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.capability === 'llm'
    && record.provider === provider
    && record.contractVersion === LLM_SMOKE_CONTRACT_VERSION
    && record.providerConfigDigest === configDigest
    && record.result === 'pass'
    && record.httpClass === '2xx'
    && record.normalizedSuccess === true
    && record.requestCount === 1
    && Number.isSafeInteger(record.latencyMs)
    && record.latencyMs >= 0 && record.latencyMs <= 60_000
    && validLlmUsage(record.usage)
    && validLlmInstant(record.occurredAt, now),
  );
  return {
    valid,
    code: valid ? null : 'LLM_SMOKE_EVIDENCE_INVALID',
    record: valid ? record : null,
  };
}

export function validateLegacyResourceInventory(record, {
  expectedVersion,
  commitSha,
  now = new Date(),
} = {}) {
  const valid = Boolean(
    RELEASE_SHA.test(String(commitSha ?? ''))
    && exactKeys(record, INVENTORY_KEYS)
    && validArtifact(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && validStringList(record.legacyApplicationIds, (value) => (
      typeof value === 'string' && APPLICATION_ID.test(value)
    ))
    && record.legacyApplicationIds.includes(KNOWN_LEGACY_APPLICATION_ID)
    && validStringList(record.legacyOrigins, validOrigin)
    && record.legacyOrigins.includes(KNOWN_LEGACY_ORIGIN)
    && validResourceList(record.postgresResources, record.declaresNoLegacyPostgres)
    && validResourceList(record.blobResources, record.declaresNoLegacyBlob)
    && record.result === true
    && validInstant(record.reviewedAt, now, 7 * DAY_MS)
  );
  return { valid, code: valid ? null : 'LEGACY_INVENTORY_INVALID', record: valid ? record : null };
}

function validCheckList(checks, requiredNames = DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES) {
  if (!Array.isArray(checks) || checks.length === 0) return false;
  const names = new Set();
  for (const check of checks) {
    const keys = Object.keys(check ?? {}).sort().join('\0');
    if (!['name\0status', 'latencyMs\0name\0status'].includes(keys)
      || typeof check.name !== 'string' || !CHECK_NAME.test(check.name)
      || check.status !== 'pass'
      || (check.latencyMs !== undefined && (!Number.isFinite(check.latencyMs) || check.latencyMs < 0))
      || names.has(check.name)) return false;
    names.add(check.name);
  }
  return requiredNames.every((name) => names.has(name));
}

function legacyContains(inventory, resourceId, identitySha256, field) {
  const normalizedId = normalizedResourceId(resourceId);
  return inventory[field].some((resource) => (
    normalizedResourceId(resource.resourceId) === normalizedId
      || resource.identitySha256 === identitySha256
  ));
}

export function validateDependencyAcceptanceEvidence(record, {
  expectedVersion,
  commitSha,
  inventory,
  postgresResourceId,
  postgresIdentitySha256: expectedPostgresIdentity,
  blobResourceId,
  blobIdentitySha256: expectedBlobIdentity,
  gcsResourceId,
  gcsIdentitySha256: expectedGcsIdentity,
  now = new Date(),
} = {}) {
  const inventoryValid = validateLegacyResourceInventory(inventory, {
    expectedVersion: inventory?.artifactSha256,
    commitSha,
    now,
  }).valid;
  const schemaMatch = ACCEPTANCE_SCHEMA.exec(String(record?.schema ?? ''));
  const gcsMode = DIGEST.test(String(expectedGcsIdentity ?? ''));
  const prefixMatch = ACCEPTANCE_PREFIX.exec(String(
    gcsMode ? record?.gcsPrefix : record?.blobPrefix,
  ));
  const sameRun = Boolean(schemaMatch && prefixMatch
    && schemaMatch[1] === prefixMatch[1].replaceAll('-', ''));
  const valid = Boolean(
    inventoryValid
    && exactKeys(record, gcsMode ? GCS_DEPENDENCY_KEYS : DEPENDENCY_KEYS)
    && validArtifact(record, expectedVersion)
    && record.schemaVersion === 1
    && record.commitSha === commitSha
    && record.legacyInventoryDigest === inventory.artifactSha256
    && typeof postgresResourceId === 'string' && record.postgresResourceId === postgresResourceId
    && DIGEST.test(String(expectedPostgresIdentity ?? ''))
    && record.postgresIdentitySha256 === expectedPostgresIdentity
    && (gcsMode
      ? typeof gcsResourceId === 'string' && record.gcsResourceId === gcsResourceId
        && gcsResourceId === '//storage.googleapis.com/projects/_/buckets/hkbuddy-prod-v1-20260826-media'
        && record.gcsIdentitySha256 === expectedGcsIdentity
      : typeof blobResourceId === 'string' && record.blobResourceId === blobResourceId
        && DIGEST.test(String(expectedBlobIdentity ?? ''))
        && record.blobIdentitySha256 === expectedBlobIdentity)
    && !legacyContains(inventory, postgresResourceId, expectedPostgresIdentity, 'postgresResources')
    && !legacyContains(
      inventory,
      gcsMode ? gcsResourceId : blobResourceId,
      gcsMode ? expectedGcsIdentity : expectedBlobIdentity,
      'blobResources',
    )
    && sameRun
    && validCheckList(record.checks, gcsMode
      ? GCS_DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES
      : DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES)
    && record.schemaAbsent === true
    && (gcsMode ? record.gcsPrefixObjectCount : record.blobPrefixObjectCount) === 0
    && record.result === true
    && validInstant(record.occurredAt, now, 7 * DAY_MS)
  );
  return { valid, code: valid ? null : 'DEPENDENCY_ACCEPTANCE_INVALID', record: valid ? record : null };
}

export function readReleaseEvidenceRecord(filePath, dependencies = {}) {
  return readBoundedJsonObjectFile(filePath, {
    ...dependencies,
    maximumBytes: RELEASE_EVIDENCE_MAX_BYTES,
  });
}

function isRegularPathStat(value) {
  return typeof value?.isFile === 'function' && value.isFile()
    && typeof value?.isSymbolicLink === 'function' && !value.isSymbolicLink();
}

function isRegularDescriptorStat(value) {
  return typeof value?.isFile === 'function' && value.isFile()
    && Number.isSafeInteger(value.size) && value.size >= 0;
}

function sameFileIdentity(left, right) {
  const comparable = (value) => typeof value === 'bigint'
    || (typeof value === 'number' && Number.isFinite(value));
  return comparable(left?.dev) && comparable(left?.ino)
    && comparable(right?.dev) && comparable(right?.ino)
    && left.dev === right.dev && left.ino === right.ino;
}

function readOnlyNonBlockingNoFollowFlags(constants) {
  if (!constants || !Number.isInteger(constants.O_RDONLY)) throw new Error('Invalid file constants');
  let flags = constants.O_RDONLY;
  for (const name of ['O_NOFOLLOW', 'O_NONBLOCK']) {
    if (Number.isInteger(constants[name])) flags |= constants[name];
  }
  return flags;
}

export function readBoundedJsonObjectFile(filePath, {
  maximumBytes,
  fileConstants = fsConstants,
  lstatFile = lstatSync,
  openFile = openSync,
  fstatFile = fstatSync,
  readBytes = readSync,
  closeFile = closeSync,
} = {}) {
  if (typeof filePath !== 'string' || !filePath
    || !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1 || maximumBytes > RELEASE_EVIDENCE_MAX_BYTES
    || typeof lstatFile !== 'function' || typeof openFile !== 'function'
    || typeof fstatFile !== 'function' || typeof readBytes !== 'function'
    || typeof closeFile !== 'function') return null;

  let descriptor = null;
  let result = null;
  try {
    const initialPath = lstatFile(filePath);
    if (!isRegularPathStat(initialPath)) return null;

    descriptor = openFile(filePath, readOnlyNonBlockingNoFollowFlags(fileConstants));
    if (!Number.isSafeInteger(descriptor) || descriptor < 0) throw new Error('Invalid file descriptor');

    const openedFile = fstatFile(descriptor);
    const openedPath = lstatFile(filePath);
    if (!isRegularDescriptorStat(openedFile)
      || openedFile.size < 1 || openedFile.size > maximumBytes
      || !isRegularPathStat(openedPath)
      || !sameFileIdentity(initialPath, openedFile)
      || !sameFileIdentity(openedPath, openedFile)) throw new Error('Invalid evidence file');

    const buffer = Buffer.allocUnsafe(maximumBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = readBytes(
        descriptor,
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        null,
      );
      if (!Number.isSafeInteger(count) || count < 0 || count > buffer.length - bytesRead) {
        throw new Error('Invalid evidence read');
      }
      if (count === 0) break;
      bytesRead += count;
    }
    if (bytesRead < 1 || bytesRead > maximumBytes) throw new Error('Invalid evidence size');

    const finalFile = fstatFile(descriptor);
    const finalPath = lstatFile(filePath);
    if (!isRegularDescriptorStat(finalFile)
      || finalFile.size !== bytesRead
      || !isRegularPathStat(finalPath)
      || !sameFileIdentity(openedFile, finalFile)
      || !sameFileIdentity(finalPath, finalFile)) throw new Error('Evidence file changed');

    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    const record = JSON.parse(raw);
    result = record && typeof record === 'object' && !Array.isArray(record) ? record : null;
  } catch {
    result = null;
  } finally {
    if (descriptor !== null) {
      try { closeFile(descriptor); } catch { result = null; }
    }
  }
  return result;
}

export function readLlmSmokeEvidenceRecord(filePath, dependencies = {}) {
  return readBoundedJsonObjectFile(filePath, {
    ...dependencies,
    maximumBytes: LLM_SMOKE_MAX_BYTES,
  });
}

export function validateLlmSmokeEvidenceFile({
  evidenceFile,
  evidenceVersion,
  commitSha,
  provider,
  configDigest,
  now = new Date(),
  readRecord = readLlmSmokeEvidenceRecord,
} = {}) {
  if (typeof readRecord !== 'function') {
    return { valid: false, code: 'LLM_SMOKE_EVIDENCE_UNREADABLE', record: null };
  }
  let record;
  try {
    record = readRecord(evidenceFile);
  } catch {
    return { valid: false, code: 'LLM_SMOKE_EVIDENCE_UNREADABLE', record: null };
  }
  if (record === null || record === undefined) {
    return { valid: false, code: 'LLM_SMOKE_EVIDENCE_UNREADABLE', record: null };
  }
  return validateLlmSmokeEvidence(record, {
    expectedVersion: evidenceVersion,
    commitSha,
    provider,
    configDigest,
    now,
  });
}

export function validateReleaseEvidenceBundle({
  inventoryFile,
  inventoryVersion,
  inventoryApproved,
  dependencyFile,
  dependencyVersion,
  commitSha,
  postgresResourceId,
  postgresIdentitySha256: expectedPostgresIdentity,
  blobResourceId,
  blobIdentitySha256: expectedBlobIdentity,
  gcsResourceId,
  gcsIdentitySha256: expectedGcsIdentity,
  now = new Date(),
  readRecord = readReleaseEvidenceRecord,
} = {}) {
  if (inventoryApproved !== true || typeof readRecord !== 'function') {
    return { valid: false, code: 'LEGACY_INVENTORY_NOT_APPROVED', inventory: null, dependency: null };
  }
  let inventory;
  let dependency;
  try {
    inventory = readRecord(inventoryFile);
    dependency = readRecord(dependencyFile);
  } catch {
    return { valid: false, code: 'RELEASE_EVIDENCE_UNREADABLE', inventory: null, dependency: null };
  }
  const inventoryResult = validateLegacyResourceInventory(inventory, {
    expectedVersion: inventoryVersion,
    commitSha,
    now,
  });
  if (!inventoryResult.valid) {
    return { valid: false, code: inventoryResult.code, inventory: null, dependency: null };
  }
  const dependencyResult = validateDependencyAcceptanceEvidence(dependency, {
    expectedVersion: dependencyVersion,
    commitSha,
    inventory,
    postgresResourceId,
    postgresIdentitySha256: expectedPostgresIdentity,
    blobResourceId,
    blobIdentitySha256: expectedBlobIdentity,
    gcsResourceId,
    gcsIdentitySha256: expectedGcsIdentity,
    now,
  });
  if (!dependencyResult.valid) {
    return { valid: false, code: dependencyResult.code, inventory, dependency: null };
  }
  return { valid: true, code: null, inventory, dependency };
}
