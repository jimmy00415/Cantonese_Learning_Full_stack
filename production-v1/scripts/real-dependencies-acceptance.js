import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

import {
  assertSecurePostgresRuntimeUrl,
  finalizeReleaseEvidenceRecord,
  gcsIdentitySha256,
  postgresIdentitySha256,
  validateLegacyResourceInventory,
} from '../src/services/release-evidence.js';
import { PostgresStore } from '../src/stores/postgres-store.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SCHEMA = /^v1_accept_([0-9a-f]{32})$/;
const GCS_PREFIX = /^v1-accept\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/$/;
const EVIDENCE_OUTPUT_OBJECT = /^release-evidence\/([0-9a-f]{40})\/dependency-acceptance\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const PROJECT_ID = 'hkbuddy-prod-v1-20260826';
const PROJECT_NUMBER = '93662314720';
const BUCKET_NAME = 'hkbuddy-prod-v1-20260826-media';
const APP_DATABASE_USER = 'hkbuddy_app';
const MIGRATOR_DATABASE_USER = 'hkbuddy_migrator';
const RELEASE_MANIFEST_FILE = '/app/release-manifest.json';
const ACCEPTANCE_SERVICE_ACCOUNT = `hkbuddy-acceptance@${PROJECT_ID}.iam.gserviceaccount.com`;
const SERVICE_ACCOUNT_METADATA_URL = 'http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/email';
const GCS_RESOURCE_ID = `//storage.googleapis.com/projects/_/buckets/${BUCKET_NAME}`;
const POSTGRES_RESOURCE_ID = `//sqladmin.googleapis.com/projects/${PROJECT_ID}/instances/hkbuddy-pg/databases/hkbuddy_v1`;
const GCS_REQUIRED_PERMISSIONS = Object.freeze([
  'storage.objects.create',
  'storage.objects.delete',
  'storage.objects.get',
  'storage.objects.list',
  'storage.objects.update',
]);
const GCS_FORBIDDEN_PERMISSIONS = Object.freeze([
  'storage.buckets.delete',
  'storage.buckets.getIamPolicy',
  'storage.buckets.setIamPolicy',
  'storage.buckets.update',
  'storage.objects.getIamPolicy',
  'storage.objects.setIamPolicy',
  'storage.objects.overrideUnlockedRetention',
  'storage.objects.setRetention',
]);
const GCS_TEST_PERMISSIONS = Object.freeze([
  ...GCS_REQUIRED_PERMISSIONS,
  ...GCS_FORBIDDEN_PERMISSIONS,
]);
const GCS_CORE_CHECK_NAMES = Object.freeze([
  'postgres-migration-health',
  'postgres-concurrency-recovery',
  'postgres-integrity-events',
  'postgres-rate-window-fencing',
  'gcs-private-full-range-head',
  'postgres-media-fencing',
]);
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;
const DEFAULT_COMMAND_DEADLINE_MS = 15 * 60_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 90_000;
const DEFAULT_CLEANUP_OPERATION_DEADLINE_MS = 20_000;
const MAX_DEADLINE_MS = 60 * 60_000;
const MAX_GCS_OBJECT_BYTES = 8 * 1024 * 1024;
const migrationFile = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url));

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function deadlineValue(value, fallback) {
  const selected = value === undefined ? fallback : value;
  return Number.isSafeInteger(selected) && selected > 0 && selected <= MAX_DEADLINE_MS
    ? selected
    : null;
}

function deadlineError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function deadlineReason(signal, fallbackCode) {
  return signal?.reason instanceof Error ? signal.reason : deadlineError(fallbackCode);
}

function createDeadlineSignal({ timeoutMs, code, parentSignal = null }) {
  const controller = new AbortController();
  const abortFromParent = () => controller.abort(deadlineReason(parentSignal, code));
  if (parentSignal?.aborted) abortFromParent();
  else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
  const timer = controller.signal.aborted ? null : setTimeout(() => {
    controller.abort(deadlineError(code));
  }, timeoutMs);
  return {
    signal: controller.signal,
    dispose() {
      if (timer !== null) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', abortFromParent);
    },
  };
}

async function withDeadline(operation, {
  timeoutMs,
  code,
  parentSignal = null,
} = {}) {
  const deadline = createDeadlineSignal({ timeoutMs, code, parentSignal });
  let rejectOnAbort;
  const aborted = new Promise((_, reject) => {
    rejectOnAbort = () => reject(deadlineReason(deadline.signal, code));
    if (deadline.signal.aborted) rejectOnAbort();
    else deadline.signal.addEventListener('abort', rejectOnAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(deadline.signal)),
      aborted,
    ]);
  } finally {
    deadline.signal.removeEventListener('abort', rejectOnAbort);
    deadline.dispose();
  }
}

function createBoundedPool(rawPool, { getParentSignal, operationDeadlineMs }) {
  const bounded = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: getParentSignal(),
  });
  const wrapClient = (client) => ({
    query: (...args) => bounded(() => client.query(...args)),
    release: (...args) => client.release(...args),
  });
  const destroyLateClient = (client) => {
    try {
      const released = client?.release?.(true);
      void Promise.resolve(released).catch(() => undefined);
    } catch {
      // The connection is already outside the accepted deadline; cleanup is best effort.
    }
  };
  return {
    query: (...args) => bounded(() => rawPool.query(...args)),
    connect: () => {
      const rawConnection = Promise.resolve().then(() => rawPool.connect());
      return bounded(() => rawConnection).then(wrapClient, (error) => {
        void rawConnection.then(destroyLateClient, () => undefined);
        throw error;
      });
    },
    end: () => bounded(() => rawPool.end()),
  };
}

function gcsError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isGcsNotFound(error) {
  return Number(error?.code) === 404 || Number(error?.statusCode) === 404
    || error?.errors?.some?.((entry) => entry?.reason === 'notFound');
}

function scopedGcsName(value, gcsPrefix, { allowPrefix = false } = {}) {
  return typeof value === 'string' && value.length > gcsPrefix.length
    && value.length <= 1_024 && value.startsWith(gcsPrefix)
    && !/[\u0000-\u001f\u007f]/.test(value)
    && !value.includes('..') && (allowPrefix || !value.endsWith('/'));
}

async function boundedStreamBuffer(source, maximumBytes, signal) {
  const chunks = [];
  let size = 0;
  const abort = () => source.destroy?.(
    deadlineReason(signal, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED'),
  );
  if (signal?.aborted) abort();
  else signal?.addEventListener('abort', abort, { once: true });
  try {
    for await (const value of source) {
      if (signal?.aborted) throw deadlineReason(signal, 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED');
      const chunk = Buffer.from(value);
      size += chunk.length;
      if (size > maximumBytes) throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } finally {
    signal?.removeEventListener('abort', abort);
  }
}

export async function attestGcpExecutionIdentity({
  fetchImpl = fetch,
  signal = null,
} = {}) {
  try {
    if (typeof fetchImpl !== 'function') throw new Error('invalid metadata client');
    const response = await fetchImpl(SERVICE_ACCOUNT_METADATA_URL, {
      method: 'GET',
      redirect: 'error',
      headers: { 'Metadata-Flavor': 'Google' },
      signal,
    });
    if (response?.status !== 200 || response.headers?.get?.('Metadata-Flavor') !== 'Google'
      || !response.body) throw new Error('invalid metadata response');
    const body = await boundedStreamBuffer(response.body, 512, signal);
    const value = body.toString('utf8');
    if (![ACCEPTANCE_SERVICE_ACCOUNT, `${ACCEPTANCE_SERVICE_ACCOUNT}\n`,
      `${ACCEPTANCE_SERVICE_ACCOUNT}\r\n`].includes(value)) {
      throw new Error('invalid execution identity');
    }
    return ACCEPTANCE_SERVICE_ACCOUNT;
  } catch {
    throw deadlineError('DEPENDENCY_GCP_IDENTITY_INVALID');
  }
}

async function attestStorageAdcIdentity(storage) {
  try {
    const auth = storage?.authClient;
    if (!auth || typeof auth.getClient !== 'function' || typeof auth.getCredentials !== 'function'
      || auth.keyFilename || auth.jsonContent || auth.apiKey) {
      throw new Error('invalid storage auth client');
    }
    const [client, credentials] = await Promise.all([
      auth.getClient(),
      auth.getCredentials(),
    ]);
    if (client?.constructor?.name !== 'Compute'
      || credentials?.client_email !== ACCEPTANCE_SERVICE_ACCOUNT) {
      throw new Error('invalid storage ADC identity');
    }
    return ACCEPTANCE_SERVICE_ACCOUNT;
  } catch {
    throw deadlineError('DEPENDENCY_GCS_IDENTITY_INVALID');
  }
}

function createBoundedGcsClient(rawBucket, {
  getParentSignal,
  operationDeadlineMs,
  gcsPrefix,
  fetchImpl,
  additionalExactNames = [],
}) {
  const exactNames = new Set(additionalExactNames);
  const bounded = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: getParentSignal(),
  });
  const normalize = async (operation, code = 'DEPENDENCY_GCS_RESPONSE_INVALID') => {
    try {
      return await bounded(operation);
    } catch (error) {
      if (['DEPENDENCY_OPERATION_DEADLINE_EXCEEDED', 'DEPENDENCY_OPERATION_CANCELLED']
        .includes(error?.code)) throw error;
      throw gcsError(code);
    }
  };
  const validateName = (name) => {
    if (!scopedGcsName(name, gcsPrefix) && !exactNames.has(name)) {
      throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
    }
  };
  return {
    async assertBucketIdentity() {
      const result = await normalize(() => rawBucket.getMetadata(),
        'DEPENDENCY_GCS_RESOURCE_INVALID');
      const metadata = result?.[0];
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)
        || metadata.name !== BUCKET_NAME || metadata.projectNumber !== PROJECT_NUMBER) {
        throw gcsError('DEPENDENCY_GCS_RESOURCE_INVALID');
      }
    },
    async assertIntendedAccess() {
      const result = await normalize(() => rawBucket.iam.testPermissions(GCS_TEST_PERMISSIONS),
        'DEPENDENCY_GCS_ACCESS_INVALID');
      const granted = result?.[0];
      if (!granted || typeof granted !== 'object' || Array.isArray(granted)
        || Object.keys(granted).sort().join('\0') !== [...GCS_TEST_PERMISSIONS].sort().join('\0')
        || GCS_REQUIRED_PERMISSIONS.some((permission) => granted[permission] !== true)
        || GCS_FORBIDDEN_PERMISSIONS.some((permission) => granted[permission] !== false)) {
        throw gcsError('DEPENDENCY_GCS_ACCESS_INVALID');
      }
    },
    async assertObjectPrivate(name) {
      validateName(name);
      const encodedName = name.split('/').map(encodeURIComponent).join('/');
      const response = await normalize((signal) => fetchImpl(
        `https://storage.googleapis.com/${BUCKET_NAME}/${encodedName}`,
        { method: 'GET', redirect: 'manual', signal },
      ), 'DEPENDENCY_GCS_ACCESS_INVALID');
      if (![401, 403, 404].includes(Number(response?.status))) {
        throw gcsError('DEPENDENCY_GCS_ACCESS_INVALID');
      }
    },
    async putObject({ name, bytes, contentType, ifAbsent = false } = {}) {
      validateName(name);
      const byteLength = Buffer.isBuffer(bytes) || bytes instanceof Uint8Array
        ? bytes.byteLength
        : -1;
      if (byteLength < 1 || byteLength > MAX_GCS_OBJECT_BYTES
        || typeof contentType !== 'string' || !contentType || contentType.length > 255) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      const body = Buffer.from(bytes);
      await normalize(async (signal) => {
        const options = {
          resumable: false,
          validation: 'crc32c',
          metadata: { contentType, cacheControl: 'private, no-store' },
        };
        if (ifAbsent) options.preconditionOpts = { ifGenerationMatch: 0 };
        await pipeline(Readable.from([body]), rawBucket.file(name).createWriteStream(options), { signal });
      });
    },
    async headObject({ name, allowMissing = false } = {}) {
      validateName(name);
      let result;
      try {
        result = await bounded(() => rawBucket.file(name).getMetadata());
      } catch (error) {
        if (allowMissing && isGcsNotFound(error)) return null;
        if (['DEPENDENCY_OPERATION_DEADLINE_EXCEEDED', 'DEPENDENCY_OPERATION_CANCELLED']
          .includes(error?.code)) throw error;
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      const metadata = result?.[0];
      const size = Number(metadata?.size);
      if (metadata?.name !== name || !Number.isSafeInteger(size) || size < 1
        || size > MAX_GCS_OBJECT_BYTES
        || String(size) !== String(metadata.size)) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      return { size, generation: metadata.generation ?? null, contentType: metadata.contentType ?? null };
    },
    async readObject({ name, start, end } = {}) {
      validateName(name);
      const { size } = await this.headObject({ name });
      const first = start === undefined ? 0 : Number(start);
      const last = end === undefined ? size - 1 : Number(end);
      if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last)
        || first < 0 || last < first || last >= size) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      const expected = last - first + 1;
      const body = await normalize((signal) => boundedStreamBuffer(
        rawBucket.file(name).createReadStream({ start: first, end: last, validation: false }),
        expected,
        signal,
      ));
      if (body.length !== expected) throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      return body;
    },
    async listObjectsPage({ prefix, limit = 100, cursor = null } = {}) {
      if (typeof prefix !== 'string' || !prefix.startsWith(gcsPrefix) || !prefix.endsWith('/')
        || prefix.length > 1_024 || prefix.includes('..')
        || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000
        || (cursor !== null && (!nonEmpty(cursor, 4_096)))) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      const options = { prefix, maxResults: limit, autoPaginate: false };
      if (cursor) options.pageToken = cursor;
      const result = await normalize(() => rawBucket.getFiles(options));
      const files = result?.[0];
      const next = result?.[1]?.pageToken ?? result?.[2]?.nextPageToken ?? null;
      if (!Array.isArray(files) || (next !== null && !nonEmpty(next, 4_096))) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      const names = files.map((file) => file?.name);
      if (new Set(names).size !== names.length
        || names.some((name) => !scopedGcsName(name, gcsPrefix) || !name.startsWith(prefix))) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      return { names, cursor: next };
    },
    async deleteObject({ name, generation = null } = {}) {
      validateName(name);
      if (generation !== null && !/^[1-9]\d*$/.test(String(generation))) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      try {
        const file = generation === null
          ? rawBucket.file(name)
          : rawBucket.file(name, { generation: String(generation) });
        await bounded(() => file.delete());
        return true;
      } catch (error) {
        if (isGcsNotFound(error)) return false;
        if (['DEPENDENCY_OPERATION_DEADLINE_EXCEEDED', 'DEPENDENCY_OPERATION_CANCELLED']
          .includes(error?.code)) throw error;
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
    },
  };
}

function nonEmpty(value, maximum = 8_192) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maximum
    && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function postgresUser(databaseUrl) {
  try {
    return decodeURIComponent(new URL(databaseUrl).username);
  } catch {
    return null;
  }
}

function postgresPassword(databaseUrl) {
  try {
    const password = decodeURIComponent(new URL(databaseUrl).password);
    return password.length > 0 && password.length <= 8_192
      && !/[\u0000-\u001f\u007f]/.test(password)
      ? password
      : null;
  } catch {
    return null;
  }
}

function validateReleaseManifest(value, releaseSha) {
  const expectedKeys = ['releaseSha', 'schemaVersion', 'sourceArchiveSha256', 'sourcePath'];
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === expectedKeys.sort().join('\0')
    && value.schemaVersion === 1
    && value.releaseSha === releaseSha
    && DIGEST.test(String(value.sourceArchiveSha256 ?? ''))
    && value.sourcePath === 'git-archive:production-v1');
}

function validateIsolation(schema, prefix) {
  const schemaMatch = SCHEMA.exec(String(schema ?? ''));
  const prefixMatch = GCS_PREFIX.exec(String(prefix ?? ''));
  if (!schemaMatch || !prefixMatch) return null;
  const runId = prefixMatch[1];
  return schemaMatch[1] === runId.replaceAll('-', '') ? { runId, schema, gcsPrefix: prefix } : null;
}

function inventoryContains(inventory, resourceId, identitySha256, field) {
  const normalizedResourceId = resourceId.toLowerCase();
  return inventory[field].some((resource) => (
    resource.resourceId.toLowerCase() === normalizedResourceId
      || resource.identitySha256 === identitySha256
  ));
}

function legacyCompatibilityCollides(environment, postgresIdentity) {
  if (environment?.DATABASE_URL !== undefined) {
    try {
      if (postgresIdentitySha256(environment.DATABASE_URL) === postgresIdentity) return true;
    } catch {
      return true;
    }
  }

  return false;
}

function safeChecks(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const names = new Set();
  const checks = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
      || !CHECK_NAME.test(String(raw.name ?? ''))
      || raw.status !== 'pass'
      || names.has(raw.name)) return null;
    const check = { name: raw.name, status: 'pass' };
    if (raw.latencyMs !== undefined) {
      if (!Number.isFinite(raw.latencyMs) || raw.latencyMs < 0) return null;
      check.latencyMs = Math.round(raw.latencyMs * 1_000) / 1_000;
    }
    names.add(raw.name);
    checks.push(check);
  }
  return checks;
}

function hasCoreChecks(checks) {
  const names = new Set((checks ?? []).map(({ name }) => name));
  return GCS_CORE_CHECK_NAMES.every((name) => names.has(name));
}

function safeFailureChecks(checks, cleanup) {
  const completed = safeChecks(checks) ?? [];
  const names = new Set(completed.map(({ name }) => name));
  const append = (name, status) => {
    if (!names.has(name)) completed.push({ name, status });
  };
  append('acceptance-execution', 'fail');
  append('gcs-prefix-cleanup', cleanup.gcsPrefixObjectCount === 0 ? 'pass' : 'fail');
  append('postgres-schema-cleanup', cleanup.schemaAbsent === true ? 'pass' : 'fail');
  append('dependency-close', cleanup.closed === true ? 'pass' : 'fail');
  return completed;
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

function addMs(value, milliseconds) {
  return new Date(new Date(value).getTime() + milliseconds).toISOString();
}

function requireInvariant(value) {
  if (!value) {
    const error = new Error('Acceptance invariant failed');
    error.code = 'ACCEPTANCE_INVARIANT_FAILED';
    throw error;
  }
}

async function measure(checks, name, operation) {
  const startedAt = performance.now();
  await operation();
  checks.push({
    name,
    status: 'pass',
    latencyMs: Math.round((performance.now() - startedAt) * 1_000) / 1_000,
  });
}

function assistantMessage(text) {
  return {
    text,
    citations: [],
    cards: [],
    suggestedReplies: [],
    needsClarification: false,
    groundingStatus: 'verified',
    provider: 'dependency-acceptance',
    providerLatencyMs: 0,
  };
}

async function deliverClaimedTurn(store, claim, baseTime, text) {
  await store.setTurnState({
    turnId: claim.id,
    leaseToken: claim.leaseToken,
    state: 'retrieving',
    now: addMs(baseTime, 1),
  });
  await store.setTurnState({
    turnId: claim.id,
    leaseToken: claim.leaseToken,
    state: 'generating',
    now: addMs(baseTime, 2),
  });
  return store.deliverAssistant({
    turnId: claim.id,
    leaseToken: claim.leaseToken,
    message: assistantMessage(text),
    now: addMs(baseTime, 3),
  });
}

export async function drainRestartedMediaDeletionOutbox({
  pool,
  gcsClient,
  gcsPrefix,
  cleanupNow,
  StoreClass = PostgresStore,
} = {}) {
  if (!pool || !gcsClient || typeof gcsClient.deleteObject !== 'function'
    || !GCS_PREFIX.test(String(gcsPrefix ?? ''))
    || !Number.isFinite(Date.parse(cleanupNow)) || typeof StoreClass !== 'function') {
    throw new Error('Restarted outbox configuration is invalid');
  }
  const restartedStore = new StoreClass({ pool, ownsPool: false });
  if (!restartedStore || typeof restartedStore.init !== 'function'
    || typeof restartedStore.claimNextMediaDeletion !== 'function'
    || typeof restartedStore.completeMediaDeletion !== 'function') {
    throw new Error('Restarted outbox store is invalid');
  }
  await restartedStore.init();
  let processed = 0;
  while (true) {
    const leaseToken = randomUUID();
    const job = await restartedStore.claimNextMediaDeletion({
      workerId: 'acceptance-restarted-outbox',
      leaseToken,
      leaseExpiresAt: addMs(cleanupNow, 30_000),
      now: cleanupNow,
    });
    if (!job) break;
    requireInvariant(typeof job.storageKey === 'string' && job.storageKey.startsWith(gcsPrefix));
    await gcsClient.deleteObject({ name: job.storageKey });
    await restartedStore.completeMediaDeletion({
      jobId: job.id,
      generation: job.generation,
      leaseToken,
      now: addMs(cleanupNow, 1),
    });
    processed += 1;
    requireInvariant(processed < 100);
  }
  return processed;
}

async function runPostgresAndGcsChecks({
  stores,
  pools,
  gcsClient,
  gcsPrefix,
  runId,
  occurredAt,
}) {
  const checks = [];
  const [storeOne, storeTwo] = stores;
  let owner;
  let deliveredAssistant;

  await measure(checks, 'postgres-migration-health', async () => {
    await Promise.all([storeOne.init(), storeTwo.init()]);
    const health = await Promise.all([storeOne.healthCheck(), storeTwo.healthCheck()]);
    requireInvariant(health.every((entry) => entry.ok === true && entry.driver === 'postgres'));
  });

  await measure(checks, 'postgres-concurrency-recovery', async () => {
    owner = await storeOne.createOrResumeSession({
      tokenHash: sha256(`owner:${runId}`),
      now: occurredAt,
    });
    const messages = [
      {
        sessionId: owner.session.id,
        conversationId: owner.conversation.id,
        clientMessageId: randomUUID(),
        requestHash: sha256(`first:${runId}`),
        text: 'acceptance first turn',
        replyLanguage: 'yue-Hant-HK',
        replyMode: 'voice',
        now: addMs(occurredAt, 10),
      },
      {
        sessionId: owner.session.id,
        conversationId: owner.conversation.id,
        clientMessageId: randomUUID(),
        requestHash: sha256(`second:${runId}`),
        text: 'acceptance second turn',
        replyLanguage: 'en',
        replyMode: 'text',
        now: addMs(occurredAt, 11),
      },
    ];
    const accepted = await Promise.all([
      storeOne.acceptMessage(messages[0]),
      storeTwo.acceptMessage(messages[1]),
    ]);
    requireInvariant(new Set(accepted.map(({ message }) => message.sequence)).size === 2);
    requireInvariant(accepted[0].message.replyLanguage === 'yue-Hant-HK'
      && accepted[0].turn.replyMode === 'voice'
      && accepted[1].message.replyLanguage === 'en'
      && accepted[1].turn.replyMode === 'text');
    const replay = await storeTwo.acceptMessage(messages[0]);
    requireInvariant(replay.idempotent === true && replay.message.id === accepted[0].message.id
      && replay.message.replyLanguage === 'yue-Hant-HK' && replay.turn.replyMode === 'voice');
    let conflictRejected = false;
    try {
      await storeTwo.acceptMessage({
        ...messages[0],
        requestHash: sha256(`first-conflict:${runId}`),
        replyLanguage: 'cmn-Hans-CN',
        replyMode: 'text',
      });
    } catch (error) {
      conflictRejected = error?.code === 'IDEMPOTENCY_CONFLICT';
    }
    requireInvariant(conflictRejected);

    const firstNow = addMs(occurredAt, 100);
    const first = await storeOne.claimNextTurn({
      workerId: 'acceptance-one',
      leaseToken: randomUUID(),
      leaseUntil: addMs(firstNow, 30_000),
      now: firstNow,
    });
    requireInvariant(first);
    deliveredAssistant = (await deliverClaimedTurn(storeOne, first, firstNow, 'First accepted answer.')).message;

    const crashNow = addMs(occurredAt, 200);
    const crashed = await storeTwo.claimNextTurn({
      workerId: 'acceptance-crashed',
      leaseToken: randomUUID(),
      leaseUntil: addMs(crashNow, 5),
      now: crashNow,
    });
    requireInvariant(crashed);
    const recoveryNow = addMs(crashNow, 6);
    const recovered = await storeOne.claimNextTurn({
      workerId: 'acceptance-recovery',
      leaseToken: randomUUID(),
      leaseUntil: addMs(recoveryNow, 30_000),
      now: recoveryNow,
    });
    requireInvariant(recovered?.id === crashed.id && recovered.attempt === crashed.attempt + 1);
    await deliverClaimedTurn(storeOne, recovered, recoveryNow, 'Recovered accepted answer.');
  });

  await measure(checks, 'postgres-integrity-events', async () => {
    const events = await storeTwo.listEvents({
      sessionId: owner.session.id,
      conversationId: owner.conversation.id,
      afterCursor: 0,
    });
    const messages = await storeOne.listMessages({
      sessionId: owner.session.id,
      conversationId: owner.conversation.id,
      after: 0,
    });
    requireInvariant(events.length >= 8 && messages.length === 4);

    const disposable = await storeTwo.createOrResumeSession({
      tokenHash: sha256(`cascade:${runId}`),
      now: addMs(occurredAt, 300),
    });
    await storeTwo.acceptMessage({
      sessionId: disposable.session.id,
      conversationId: disposable.conversation.id,
      clientMessageId: randomUUID(),
      requestHash: sha256(`cascade-message:${runId}`),
      text: 'cascade probe',
      now: addMs(occurredAt, 301),
    });
    await pools[0].query('DELETE FROM sessions WHERE id = $1', [disposable.session.id]);
    const remnants = await pools[1].query(`
      SELECT
        (SELECT count(*) FROM conversations WHERE session_id = $1)::int AS conversations,
        (SELECT count(*) FROM messages WHERE session_id = $1)::int AS messages,
        (SELECT count(*) FROM turns WHERE session_id = $1)::int AS turns,
        (SELECT count(*) FROM events WHERE session_id = $1)::int AS events
    `, [disposable.session.id]);
    const row = remnants.rows[0];
    requireInvariant(Object.values(row).every((count) => Number(count) === 0));
  });

  await measure(checks, 'postgres-rate-window-fencing', async () => {
    const rateOwner = await storeOne.createOrResumeSession({
      tokenHash: sha256(`rate-owner:${runId}`),
      now: addMs(occurredAt, 400),
    });
    const shortExpiry = addMs(occurredAt, 60_000);
    const dailyExpiry = addMs(occurredAt, 86_400_000);
    const windows = (category) => [
      {
        subjectHash: sha256(`${category}:${runId}`),
        quota: `${category}-short`,
        windowStart: occurredAt,
        limit: 1,
        expiresAt: shortExpiry,
      },
      {
        subjectHash: sha256(`${category}:${runId}`),
        quota: `${category}-daily`,
        windowStart: occurredAt,
        limit: 1,
        expiresAt: dailyExpiry,
      },
    ];
    const chatWindows = windows('chat');
    const firstChat = await storeOne.acceptMessageWithRateLimits({
      sessionId: rateOwner.session.id,
      conversationId: rateOwner.conversation.id,
      clientMessageId: randomUUID(),
      requestHash: sha256(`rate-chat-first:${runId}`),
      text: 'rate acceptance first',
      now: addMs(occurredAt, 401),
      rateLimits: [chatWindows[1], chatWindows[0]],
    });
    requireInvariant(firstChat.idempotent === false);
    for (const rateLimits of [chatWindows, [...chatWindows].reverse()]) {
      let blockedExpiry = null;
      try {
        await storeTwo.acceptMessageWithRateLimits({
          sessionId: rateOwner.session.id,
          conversationId: rateOwner.conversation.id,
          clientMessageId: randomUUID(),
          requestHash: sha256(`rate-chat-blocked:${randomUUID()}`),
          text: 'must be rate limited',
          now: addMs(occurredAt, 402),
          rateLimits,
        });
      } catch (error) {
        if (error?.code === 'RATE_LIMITED') blockedExpiry = error.expiresAt;
      }
      requireInvariant(blockedExpiry === dailyExpiry);
    }

    const assistantMessages = [];
    const deliverNext = async (index) => {
      const claimNow = addMs(occurredAt, 500 + (index * 100));
      const claim = await storeOne.claimNextTurn({
        workerId: `acceptance-rate-${index}`,
        leaseToken: randomUUID(),
        leaseUntil: addMs(claimNow, 30_000),
        now: claimNow,
      });
      requireInvariant(claim);
      const delivered = await deliverClaimedTurn(
        storeOne,
        claim,
        claimNow,
        `Rate acceptance answer ${index}.`,
      );
      assistantMessages.push(delivered.message);
    };
    await deliverNext(0);
    for (let index = 1; index < 3; index += 1) {
      await storeTwo.acceptMessage({
        sessionId: rateOwner.session.id,
        conversationId: rateOwner.conversation.id,
        clientMessageId: randomUUID(),
        requestHash: sha256(`rate-extra-turn:${index}:${runId}`),
        text: `rate acceptance extra ${index}`,
        now: addMs(occurredAt, 550 + (index * 10)),
      });
      await deliverNext(index);
    }

    const asrWindows = windows('asr');
    const asrBase = {
      sessionId: rateOwner.session.id,
      requestSha256: sha256(`rate-asr:${runId}`),
      mimeType: 'audio/wav',
      leaseExpiresAt: addMs(occurredAt, 40_000),
      attemptDeadlineAt: addMs(occurredAt, 50_000),
      now: addMs(occurredAt, 800),
    };
    const firstAsr = await storeOne.claimVoiceUploadWithRateLimits({
      ...asrBase,
      clientUploadId: randomUUID(),
      rateLimits: [asrWindows[1], asrWindows[0]],
      leaseToken: randomUUID(),
      attemptStorageKey: `${gcsPrefix}rate/asr/${randomUUID()}`,
    });
    requireInvariant(firstAsr.status === 'claimed');
    for (const rateLimits of [asrWindows, [...asrWindows].reverse()]) {
      const blocked = await storeTwo.claimVoiceUploadWithRateLimits({
        ...asrBase,
        clientUploadId: randomUUID(),
        rateLimits,
        leaseToken: randomUUID(),
        attemptStorageKey: `${gcsPrefix}rate/asr/${randomUUID()}`,
      });
      requireInvariant(blocked.status === 'rate_limited'
        && blocked.blockingExpiresAt === dailyExpiry);
    }

    const ttsWindows = windows('tts');
    const firstTts = await storeOne.claimAssistantAudioWithRateLimits({
      sessionId: rateOwner.session.id,
      messageId: assistantMessages[0].id,
      kind: 'assistant_voice',
      rateLimits: [ttsWindows[1], ttsWindows[0]],
      leaseToken: randomUUID(),
      attemptStorageKey: `${gcsPrefix}rate/tts/${randomUUID()}`,
      configVersion: 'acceptance-rate-v1',
      leaseExpiresAt: addMs(occurredAt, 40_000),
      attemptDeadlineAt: addMs(occurredAt, 50_000),
      now: addMs(occurredAt, 900),
    });
    requireInvariant(firstTts.status === 'claimed');
    const ttsOrders = [ttsWindows, [...ttsWindows].reverse()];
    for (let index = 0; index < ttsOrders.length; index += 1) {
      const blocked = await storeTwo.claimAssistantAudioWithRateLimits({
        sessionId: rateOwner.session.id,
        messageId: assistantMessages[index + 1].id,
        kind: 'assistant_voice',
        rateLimits: ttsOrders[index],
        leaseToken: randomUUID(),
        attemptStorageKey: `${gcsPrefix}rate/tts/${randomUUID()}`,
        configVersion: 'acceptance-rate-v1',
        leaseExpiresAt: addMs(occurredAt, 40_000),
        attemptDeadlineAt: addMs(occurredAt, 50_000),
        now: addMs(occurredAt, 901 + index),
      });
      requireInvariant(blocked.status === 'rate_limited'
        && blocked.blockingExpiresAt === dailyExpiry);
    }
  });

  await measure(checks, 'gcs-private-full-range-head', async () => {
    await gcsClient.assertIntendedAccess();
    const key = `${gcsPrefix}probe/full-range.bin`;
    const pageKey = `${gcsPrefix}probe/pagination.bin`;
    const body = Buffer.from(`acceptance:${runId}`, 'utf8');
    await gcsClient.putObject({
      name: key, bytes: body, contentType: 'application/octet-stream', ifAbsent: true,
    });
    await gcsClient.putObject({
      name: pageKey, bytes: Buffer.from('page'), contentType: 'application/octet-stream', ifAbsent: true,
    });
    const properties = await gcsClient.headObject({ name: key });
    const full = await gcsClient.readObject({ name: key });
    const last = Math.min(4, body.length - 1);
    const range = await gcsClient.readObject({ name: key, start: 1, end: last });
    requireInvariant(Number(properties.size) === body.length);
    requireInvariant(Buffer.compare(full, body) === 0);
    requireInvariant(Buffer.compare(range, body.subarray(1, last + 1)) === 0);
    const firstPage = await gcsClient.listObjectsPage({ prefix: `${gcsPrefix}probe/`, limit: 1 });
    const secondPage = await gcsClient.listObjectsPage({
      prefix: `${gcsPrefix}probe/`, limit: 1, cursor: firstPage.cursor,
    });
    requireInvariant(firstPage.names.length === 1 && firstPage.cursor
      && secondPage.names.length === 1 && secondPage.cursor === null
      && new Set([...firstPage.names, ...secondPage.names]).size === 2);
    await gcsClient.assertObjectPrivate(key);
    requireInvariant(await gcsClient.deleteObject({ name: pageKey }) === true);
    requireInvariant(await gcsClient.deleteObject({ name: pageKey }) === false);
  });

  await measure(checks, 'postgres-media-fencing', async () => {
    const voiceId = randomUUID();
    const firstVoiceKey = `${gcsPrefix}attempts/voice/${randomUUID()}`;
    const secondVoiceKey = `${gcsPrefix}attempts/voice/${randomUUID()}`;
    const firstNow = addMs(occurredAt, 1_000);
    const firstToken = randomUUID();
    const claimDeleteSubject = sha256(`claim-delete:${runId}`);
    const claimDeleteQuota = {
      subjectHash: claimDeleteSubject,
      quota: 'acceptance-claim-delete',
      windowStart: occurredAt,
      limit: 2,
      expiresAt: addMs(occurredAt, 86_400_000),
    };
    const first = await storeOne.claimVoiceUploadWithRateLimits({
      sessionId: owner.session.id,
      clientUploadId: voiceId,
      requestSha256: sha256(`voice:${runId}`),
      mimeType: 'audio/wav',
      rateLimits: [claimDeleteQuota],
      leaseToken: firstToken,
      attemptStorageKey: firstVoiceKey,
      leaseExpiresAt: addMs(firstNow, 5),
      attemptDeadlineAt: addMs(firstNow, 60_000),
      now: firstNow,
    });
    const live = await storeTwo.claimVoiceUploadWithRateLimits({
      sessionId: owner.session.id,
      clientUploadId: voiceId,
      requestSha256: sha256(`voice:${runId}`),
      mimeType: 'audio/wav',
      rateLimits: [],
      leaseToken: randomUUID(),
      attemptStorageKey: secondVoiceKey,
      leaseExpiresAt: addMs(firstNow, 10),
      attemptDeadlineAt: addMs(firstNow, 60_000),
      now: addMs(firstNow, 1),
    });
    requireInvariant(first.status === 'claimed' && live.status === 'live');
    const recoveryNow = addMs(firstNow, 6);
    const recoveryToken = randomUUID();
    const recovered = await storeTwo.claimVoiceUploadWithRateLimits({
      sessionId: owner.session.id,
      clientUploadId: voiceId,
      requestSha256: sha256(`voice:${runId}`),
      mimeType: 'audio/wav',
      rateLimits: [],
      leaseToken: recoveryToken,
      attemptStorageKey: secondVoiceKey,
      leaseExpiresAt: addMs(recoveryNow, 30_000),
      attemptDeadlineAt: addMs(recoveryNow, 60_000),
      now: recoveryNow,
    });
    requireInvariant(recovered.status === 'claimed' && recovered.upload.attempt === 2);
    const restartedStore = new PostgresStore({ pool: pools[0], ownsPool: false });
    await restartedStore.init();
    const restartedUpload = await restartedStore.getVoiceUploadStatus({
      sessionId: owner.session.id,
      clientUploadId: voiceId,
    });
    const displacedAttempt = await pools[1].query(`
      SELECT storage_key, state, generation FROM media_deletion_jobs
      WHERE storage_key = $1
    `, [firstVoiceKey]);
    requireInvariant(restartedUpload.attemptStorageKey === secondVoiceKey
      && displacedAttempt.rowCount === 1
      && displacedAttempt.rows[0].storage_key === firstVoiceKey
      && displacedAttempt.rows[0].state === 'pending'
      && Number(displacedAttempt.rows[0].generation) >= 1);
    let staleRejected = false;
    try {
      await storeOne.setVoiceUploadTranscribing({
        uploadId: first.upload.id,
        leaseToken: firstToken,
        now: addMs(recoveryNow, 1),
      });
    } catch (error) {
      staleRejected = error?.code === 'LEASE_LOST';
    }
    requireInvariant(staleRejected);
    let rollbackRejected = false;
    try {
      await storeTwo.completeVoiceUpload({
        uploadId: recovered.upload.id,
        leaseToken: recoveryToken,
        mediaAsset: {
          storageKey: secondVoiceKey,
          mimeType: 'audio/wav',
          byteLength: 1,
          durationMs: 1,
          sha256: sha256('rollback-probe'),
        },
        transcript: ' ',
        now: addMs(recoveryNow, 1),
      });
    } catch (error) {
      rollbackRejected = error?.code === 'LEASE_LOST';
    }
    const afterRollback = await storeOne.getVoiceUploadStatus({
      sessionId: owner.session.id,
      clientUploadId: voiceId,
    });
    requireInvariant(rollbackRejected
      && afterRollback.state === 'uploading'
      && afterRollback.attemptStorageKey === secondVoiceKey);
    await storeTwo.setVoiceUploadTranscribing({
      uploadId: recovered.upload.id,
      leaseToken: recoveryToken,
      now: addMs(recoveryNow, 2),
    });
    const voiceBody = Buffer.from('RIFF-acceptance-voice', 'utf8');
    await gcsClient.putObject({
      name: secondVoiceKey, bytes: voiceBody, contentType: 'audio/wav', ifAbsent: true,
    });
    const completedVoice = await storeTwo.completeVoiceUpload({
      uploadId: recovered.upload.id,
      leaseToken: recoveryToken,
      mediaAsset: {
        storageKey: secondVoiceKey,
        mimeType: 'audio/wav',
        byteLength: voiceBody.length,
        durationMs: 1_000,
        sha256: sha256(voiceBody),
      },
      transcript: 'voice acceptance transcript',
      now: addMs(recoveryNow, 3),
    });
    await storeOne.acceptMessage({
      sessionId: owner.session.id,
      conversationId: owner.conversation.id,
      clientMessageId: randomUUID(),
      requestHash: sha256(`voice-send:${runId}`),
      text: 'voice acceptance transcript',
      voiceDraftId: completedVoice.mediaAsset.id,
      now: addMs(recoveryNow, 4),
    });

    const ttsKeyOne = `${gcsPrefix}attempts/tts/${randomUUID()}`;
    const ttsKeyTwo = `${gcsPrefix}attempts/tts/${randomUUID()}`;
    const ttsNow = addMs(occurredAt, 2_000);
    const claims = await Promise.all([
      storeOne.claimAssistantAudioWithRateLimits({
        sessionId: owner.session.id,
        messageId: deliveredAssistant.id,
        kind: 'assistant_voice',
        rateLimits: [],
        leaseToken: randomUUID(),
        attemptStorageKey: ttsKeyOne,
        configVersion: 'acceptance-v1',
        leaseExpiresAt: addMs(ttsNow, 5),
        attemptDeadlineAt: addMs(ttsNow, 60_000),
        now: ttsNow,
      }),
      storeTwo.claimAssistantAudioWithRateLimits({
        sessionId: owner.session.id,
        messageId: deliveredAssistant.id,
        kind: 'assistant_voice',
        rateLimits: [],
        leaseToken: randomUUID(),
        attemptStorageKey: ttsKeyTwo,
        configVersion: 'acceptance-v1',
        leaseExpiresAt: addMs(ttsNow, 5),
        attemptDeadlineAt: addMs(ttsNow, 60_000),
        now: ttsNow,
      }),
    ]);
    const winner = claims.find(({ status }) => status === 'claimed');
    requireInvariant(winner && claims.filter(({ status }) => status === 'live').length === 1);
    const recoveredTtsKey = `${gcsPrefix}attempts/tts/${randomUUID()}`;
    const recoveredTtsToken = randomUUID();
    const recoveredTts = await storeTwo.claimAssistantAudioWithRateLimits({
      sessionId: owner.session.id,
      messageId: deliveredAssistant.id,
      kind: 'assistant_voice',
      rateLimits: [],
      leaseToken: recoveredTtsToken,
      attemptStorageKey: recoveredTtsKey,
      configVersion: 'acceptance-v1',
      leaseExpiresAt: addMs(ttsNow, 30_000),
      attemptDeadlineAt: addMs(ttsNow, 60_000),
      now: addMs(ttsNow, 6),
    });
    requireInvariant(recoveredTts.status === 'claimed'
      && recoveredTts.generation.id === winner.generation.id
      && recoveredTts.generation.attempt === winner.generation.attempt + 1);
    const ttsBody = Buffer.from('acceptance-tts', 'utf8');
    await gcsClient.putObject({
      name: recoveredTtsKey, bytes: ttsBody, contentType: 'audio/mpeg', ifAbsent: true,
    });
    let staleTtsRejected = false;
    try {
      await storeTwo.completeMediaGeneration({
        generationId: winner.generation.id,
        leaseToken: winner.generation.leaseToken,
        mediaAsset: {
          storageKey: winner.generation.attemptStorageKey,
          mimeType: 'audio/mpeg',
          byteLength: ttsBody.length,
          sha256: sha256(ttsBody),
        },
        now: addMs(ttsNow, 7),
      });
    } catch (error) {
      staleTtsRejected = error?.code === 'LEASE_LOST';
    }
    requireInvariant(staleTtsRejected);
    await storeOne.completeMediaGeneration({
      generationId: recoveredTts.generation.id,
      leaseToken: recoveredTtsToken,
      mediaAsset: {
        storageKey: recoveredTtsKey,
        mimeType: 'audio/mpeg',
        byteLength: ttsBody.length,
        sha256: sha256(ttsBody),
      },
      now: addMs(ttsNow, 8),
    });

    const lifecycleKey = `${gcsPrefix}lifecycle/${randomUUID()}`;
    const queued = await storeOne.enqueueMediaDeletion({
      storageKey: lifecycleKey,
      reason: 'acceptance',
      notBefore: ttsNow,
      now: ttsNow,
    });
    requireInvariant(queued.generation === 1);
    const cleanupTokenOne = randomUUID();
    const claimed = await storeTwo.claimNextMediaDeletion({
      workerId: 'acceptance-cleanup-one',
      leaseToken: cleanupTokenOne,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      now: ttsNow,
    });
    const rearmed = await storeOne.rearmMediaDeletionAfterWrite({
      storageKey: lifecycleKey,
      reason: 'acceptance-late-write',
      notBefore: ttsNow,
      now: addMs(ttsNow, 1),
    });
    requireInvariant(claimed.id === queued.id && rearmed.generation === 2 && rearmed.state === 'pending');
    let staleCleanupRejected = false;
    try {
      await storeTwo.completeMediaDeletion({
        jobId: claimed.id,
        generation: claimed.generation,
        leaseToken: cleanupTokenOne,
        now: addMs(ttsNow, 2),
      });
    } catch (error) {
      staleCleanupRejected = error?.code === 'LEASE_LOST';
    }
    requireInvariant(staleCleanupRejected);
    const cleanupTokenTwo = randomUUID();
    const claimedAgain = await storeOne.claimNextMediaDeletion({
      workerId: 'acceptance-cleanup-two',
      leaseToken: cleanupTokenTwo,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      now: addMs(ttsNow, 3),
    });
    requireInvariant(claimedAgain?.id === queued.id && claimedAgain.generation === 2);
    const completed = await storeOne.completeMediaDeletion({
      jobId: claimedAgain.id,
      generation: claimedAgain.generation,
      leaseToken: cleanupTokenTwo,
      now: addMs(ttsNow, 4),
    });
    requireInvariant(completed.state === 'completed');
    const rearmedAfterCompletion = await storeTwo.rearmMediaDeletionAfterWrite({
      storageKey: lifecycleKey,
      reason: 'acceptance-write-after-complete',
      notBefore: addMs(ttsNow, 5),
      now: addMs(ttsNow, 5),
    });
    requireInvariant(rearmedAfterCompletion.state === 'pending'
      && rearmedAfterCompletion.generation === 3);
    const cleanupTokenThree = randomUUID();
    const claimedFinal = await storeTwo.claimNextMediaDeletion({
      workerId: 'acceptance-cleanup-three',
      leaseToken: cleanupTokenThree,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      now: addMs(ttsNow, 6),
    });
    requireInvariant(claimedFinal?.id === queued.id && claimedFinal.generation === 3);
    const completedFinal = await storeTwo.completeMediaDeletion({
      jobId: claimedFinal.id,
      generation: claimedFinal.generation,
      leaseToken: cleanupTokenThree,
      now: addMs(ttsNow, 7),
    });
    requireInvariant(completedFinal.state === 'completed');
    const pendingLifecycleKey = `${gcsPrefix}lifecycle/${randomUUID()}`;
    const pendingLifecycle = await storeOne.enqueueMediaDeletion({
      storageKey: pendingLifecycleKey,
      reason: 'acceptance-pending',
      notBefore: addMs(ttsNow, 20),
      now: addMs(ttsNow, 20),
    });
    const rearmedPending = await storeTwo.rearmMediaDeletionAfterWrite({
      storageKey: pendingLifecycleKey,
      reason: 'acceptance-write-while-pending',
      notBefore: addMs(ttsNow, 20),
      now: addMs(ttsNow, 21),
    });
    requireInvariant(rearmedPending.id === pendingLifecycle.id
      && rearmedPending.state === 'pending'
      && rearmedPending.generation === pendingLifecycle.generation + 1);
    const pendingToken = randomUUID();
    const claimedPending = await storeOne.claimNextMediaDeletion({
      workerId: 'acceptance-cleanup-pending',
      leaseToken: pendingToken,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      now: addMs(ttsNow, 22),
    });
    requireInvariant(claimedPending?.id === pendingLifecycle.id);
    await storeOne.completeMediaDeletion({
      jobId: claimedPending.id,
      generation: claimedPending.generation,
      leaseToken: pendingToken,
      now: addMs(ttsNow, 23),
    });
    const dedupKey = `${gcsPrefix}lifecycle/${randomUUID()}`;
    const deduplicated = await Promise.all([
      storeOne.enqueueMediaDeletion({
        storageKey: dedupKey,
        reason: 'acceptance-dedup-one',
        notBefore: addMs(ttsNow, 30),
        now: addMs(ttsNow, 30),
      }),
      storeTwo.enqueueMediaDeletion({
        storageKey: dedupKey,
        reason: 'acceptance-dedup-two',
        notBefore: addMs(ttsNow, 30),
        now: addMs(ttsNow, 30),
      }),
    ]);
    requireInvariant(deduplicated[0].id === deduplicated[1].id
      && deduplicated[0].generation === deduplicated[1].generation);
    const dedupToken = randomUUID();
    const claimedDedup = await storeTwo.claimNextMediaDeletion({
      workerId: 'acceptance-cleanup-dedup',
      leaseToken: dedupToken,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      now: addMs(ttsNow, 31),
    });
    requireInvariant(claimedDedup?.id === deduplicated[0].id);
    await storeTwo.completeMediaDeletion({
      jobId: claimedDedup.id,
      generation: claimedDedup.generation,
      leaseToken: dedupToken,
      now: addMs(ttsNow, 32),
    });

    const beforeWriteOwner = await storeOne.createOrResumeSession({
      tokenHash: sha256(`provider-before-write:${runId}`),
      now: addMs(ttsNow, 40),
    });
    const beforeWriteKey = `${gcsPrefix}provider-before-write/${randomUUID()}`;
    await storeOne.claimVoiceUploadWithRateLimits({
      sessionId: beforeWriteOwner.session.id,
      clientUploadId: randomUUID(),
      requestSha256: sha256(`provider-before-write:${runId}`),
      mimeType: 'audio/wav',
      rateLimits: [],
      leaseToken: randomUUID(),
      attemptStorageKey: beforeWriteKey,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      attemptDeadlineAt: addMs(ttsNow, 60_000),
      now: addMs(ttsNow, 41),
    });
    await storeTwo.revokeSessionAndEnqueueMedia({
      sessionId: beforeWriteOwner.session.id,
      now: addMs(ttsNow, 42),
      cleanupNotBefore: addMs(ttsNow, 42),
    });

    const beforeAttachOwner = await storeTwo.createOrResumeSession({
      tokenHash: sha256(`provider-before-attach:${runId}`),
      now: addMs(ttsNow, 50),
    });
    const beforeAttachKey = `${gcsPrefix}provider-before-attach/${randomUUID()}`;
    const beforeAttachToken = randomUUID();
    const beforeAttach = await storeTwo.claimVoiceUploadWithRateLimits({
      sessionId: beforeAttachOwner.session.id,
      clientUploadId: randomUUID(),
      requestSha256: sha256(`provider-before-attach:${runId}`),
      mimeType: 'audio/wav',
      rateLimits: [],
      leaseToken: beforeAttachToken,
      attemptStorageKey: beforeAttachKey,
      leaseExpiresAt: addMs(ttsNow, 30_000),
      attemptDeadlineAt: addMs(ttsNow, 60_000),
      now: addMs(ttsNow, 51),
    });
    await storeTwo.setVoiceUploadTranscribing({
      uploadId: beforeAttach.upload.id,
      leaseToken: beforeAttachToken,
      now: addMs(ttsNow, 52),
    });
    const beforeAttachBody = Buffer.from('provider-before-attach', 'utf8');
    await gcsClient.putObject({
      name: beforeAttachKey, bytes: beforeAttachBody, contentType: 'audio/wav', ifAbsent: true,
    });
    await storeOne.revokeSessionAndEnqueueMedia({
      sessionId: beforeAttachOwner.session.id,
      now: addMs(ttsNow, 53),
      cleanupNotBefore: addMs(ttsNow, 53),
    });
    let beforeAttachFenced = false;
    try {
      await storeTwo.completeVoiceUpload({
        uploadId: beforeAttach.upload.id,
        leaseToken: beforeAttachToken,
        mediaAsset: {
          storageKey: beforeAttachKey,
          mimeType: 'audio/wav',
          byteLength: beforeAttachBody.length,
          durationMs: 1_000,
          sha256: sha256(beforeAttachBody),
        },
        transcript: 'must remain fenced',
        now: addMs(ttsNow, 54),
      });
    } catch (error) {
      beforeAttachFenced = error?.code === 'LEASE_LOST';
    }
    requireInvariant(beforeAttachFenced);

    const deleteFirstOwner = await storeTwo.createOrResumeSession({
      tokenHash: sha256(`delete-first:${runId}`),
      now: addMs(ttsNow, 70),
    });
    await storeTwo.revokeSessionAndEnqueueMedia({
      sessionId: deleteFirstOwner.session.id,
      now: addMs(ttsNow, 71),
      cleanupNotBefore: addMs(ttsNow, 71),
    });
    const deleteFirstUploadId = randomUUID();
    const deleteFirstSubject = sha256(`delete-first-quota:${runId}`);
    let deleteFirstRejected = false;
    try {
      await storeOne.claimVoiceUploadWithRateLimits({
        sessionId: deleteFirstOwner.session.id,
        clientUploadId: deleteFirstUploadId,
        requestSha256: sha256(`delete-first-upload:${runId}`),
        mimeType: 'audio/wav',
        rateLimits: [{
          subjectHash: deleteFirstSubject,
          quota: 'acceptance-delete-first',
          windowStart: occurredAt,
          limit: 1,
          expiresAt: addMs(occurredAt, 86_400_000),
        }],
        leaseToken: randomUUID(),
        attemptStorageKey: `${gcsPrefix}delete-first/${randomUUID()}`,
        leaseExpiresAt: addMs(ttsNow, 30_000),
        attemptDeadlineAt: addMs(ttsNow, 60_000),
        now: addMs(ttsNow, 72),
      });
    } catch (error) {
      deleteFirstRejected = error?.code === 'SESSION_NOT_FOUND';
    }
    requireInvariant(deleteFirstRejected);
    const deleteFirstState = await pools[0].query(`
      SELECT
        (SELECT count(*) FROM voice_uploads WHERE client_upload_id = $1)::int AS uploads,
        (SELECT count(*) FROM rate_limit_buckets WHERE subject_hash = $2)::int AS buckets
    `, [deleteFirstUploadId, deleteFirstSubject]);
    requireInvariant(Number(deleteFirstState.rows[0]?.uploads) === 0
      && Number(deleteFirstState.rows[0]?.buckets) === 0);

    const revoked = await storeOne.revokeSessionAndEnqueueMedia({
      sessionId: owner.session.id,
      now: addMs(ttsNow, 80),
      cleanupNotBefore: addMs(ttsNow, 80),
    });
    requireInvariant(revoked.deleted === true && revoked.queuedKeys >= 2);
    const claimFirstQuota = await pools[0].query(`
      SELECT count FROM rate_limit_buckets
      WHERE subject_hash = $1 AND quota = $2
    `, [claimDeleteSubject, claimDeleteQuota.quota]);
    requireInvariant(claimFirstQuota.rowCount === 1
      && Number(claimFirstQuota.rows[0].count) === 1);
    const lateBody = Buffer.from('late-provider-write', 'utf8');
    await gcsClient.putObject({
      name: firstVoiceKey, bytes: lateBody, contentType: 'audio/wav', ifAbsent: true,
    });
    await gcsClient.putObject({
      name: winner.generation.attemptStorageKey,
      bytes: lateBody,
      contentType: 'audio/mpeg',
      ifAbsent: true,
    });
    const cleanupNow = addMs(occurredAt, 180_000);
    await storeTwo.rearmMediaDeletionAfterWrite({
      storageKey: firstVoiceKey,
      reason: 'acceptance-provider-write-after-delete',
      notBefore: cleanupNow,
      now: cleanupNow,
    });
    await storeOne.rearmMediaDeletionAfterWrite({
      storageKey: winner.generation.attemptStorageKey,
      reason: 'acceptance-tts-write-after-delete',
      notBefore: cleanupNow,
      now: cleanupNow,
    });
    const processed = await drainRestartedMediaDeletionOutbox({
      pool: pools[0],
      gcsClient,
      gcsPrefix,
      cleanupNow,
    });
    requireInvariant(processed >= 3);
    const pending = await pools[0].query(`
      SELECT count(*)::int AS count FROM media_deletion_jobs
      WHERE state IN ('pending', 'deleting')
    `);
    requireInvariant(Number(pending.rows[0]?.count) === 0);
    const accessible = new Set();
    let cursor = null;
    do {
      const page = await gcsClient.listObjectsPage({ prefix: gcsPrefix, limit: 100, cursor });
      page.names.forEach((name) => accessible.add(name));
      cursor = page.cursor;
    } while (cursor);
    requireInvariant(!accessible.has(firstVoiceKey)
      && !accessible.has(secondVoiceKey)
      && !accessible.has(winner.generation.attemptStorageKey)
      && !accessible.has(recoveredTtsKey)
      && !accessible.has(beforeWriteKey)
      && !accessible.has(beforeAttachKey));
  });

  requireInvariant(hasCoreChecks(checks));
  return checks;
}

export async function createRealAcceptanceRuntime({
  databaseUrl,
  migratorDatabaseUrl,
  projectId,
  bucketName,
  releaseSha,
  evidenceOutputObject,
  gcsPrefix,
  schema,
  runId,
  occurredAt,
  PoolClass,
  StorageClass,
  fetchImpl = fetch,
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  readMigration = ({ signal } = {}) => readFile(migrationFile, { encoding: 'utf8', signal }),
  exerciseChecks = runPostgresAndGcsChecks,
  attestExecutionIdentity = attestGcpExecutionIdentity,
} = {}) {
  let databaseIdentitiesValid = false;
  try {
    assertSecurePostgresRuntimeUrl(databaseUrl);
    assertSecurePostgresRuntimeUrl(migratorDatabaseUrl);
    databaseIdentitiesValid = postgresIdentitySha256(databaseUrl)
      === postgresIdentitySha256(migratorDatabaseUrl);
  } catch {
    databaseIdentitiesValid = false;
  }
  const isolation = validateIsolation(schema, gcsPrefix);
  const outputMatch = EVIDENCE_OUTPUT_OBJECT.exec(String(evidenceOutputObject ?? ''));
  if (!isolation || isolation.runId !== runId
    || projectId !== PROJECT_ID || bucketName !== BUCKET_NAME
    || !RELEASE_SHA.test(String(releaseSha ?? ''))
    || !outputMatch || outputMatch[1] !== releaseSha || outputMatch[2] !== runId
    || !nonEmpty(databaseUrl, 32_768) || !nonEmpty(migratorDatabaseUrl, 32_768)
    || databaseUrl === migratorDatabaseUrl || !databaseIdentitiesValid
    || postgresUser(databaseUrl) !== APP_DATABASE_USER
    || postgresUser(migratorDatabaseUrl) !== MIGRATOR_DATABASE_USER
    || postgresPassword(databaseUrl) === null
    || postgresPassword(migratorDatabaseUrl) === null
    || postgresPassword(databaseUrl) === postgresPassword(migratorDatabaseUrl)
    || typeof PoolClass !== 'function' || typeof StorageClass !== 'function'
    || typeof fetchImpl !== 'function'
    || deadlineValue(operationDeadlineMs, null) === null
    || typeof readMigration !== 'function' || typeof exerciseChecks !== 'function'
    || typeof attestExecutionIdentity !== 'function') {
    throw new Error('Real acceptance runtime configuration is invalid');
  }
  const postgresDeadlineOptions = {
    connectionTimeoutMillis: operationDeadlineMs,
    query_timeout: operationDeadlineMs,
    statement_timeout: operationDeadlineMs,
  };
  const appPoolOptions = {
    connectionString: databaseUrl,
    options: `-c search_path=${schema} -c statement_timeout=${operationDeadlineMs}`,
    ...postgresDeadlineOptions,
  };
  const migratorPoolOptions = {
    connectionString: migratorDatabaseUrl,
    options: `-c search_path=${schema} -c statement_timeout=${operationDeadlineMs}`,
    ...postgresDeadlineOptions,
  };
  const rawAdminPool = new PoolClass({
    connectionString: migratorDatabaseUrl,
    options: `-c statement_timeout=${operationDeadlineMs}`,
    ...postgresDeadlineOptions,
  });
  const rawMigratorPool = new PoolClass(migratorPoolOptions);
  const rawPoolOne = new PoolClass(appPoolOptions);
  const rawPoolTwo = new PoolClass(appPoolOptions);
  let activeSignal = null;
  const getParentSignal = () => activeSignal;
  const adminPool = createBoundedPool(rawAdminPool, { getParentSignal, operationDeadlineMs });
  const migratorPool = createBoundedPool(rawMigratorPool, { getParentSignal, operationDeadlineMs });
  const poolOne = createBoundedPool(rawPoolOne, { getParentSignal, operationDeadlineMs });
  const poolTwo = createBoundedPool(rawPoolTwo, { getParentSignal, operationDeadlineMs });
  const storeOne = new PostgresStore({ pool: poolOne, ownsPool: false });
  const storeTwo = new PostgresStore({ pool: poolTwo, ownsPool: false });
  const storage = new StorageClass({ projectId });
  const rawBucket = storage.bucket(bucketName);
  if (!rawBucket || (rawBucket.name !== undefined && rawBucket.name !== bucketName)
    || typeof storage?.authClient?.getClient !== 'function'
    || typeof storage?.authClient?.getCredentials !== 'function'
    || typeof rawBucket.getMetadata !== 'function'
    || !rawBucket.iam || typeof rawBucket.iam.testPermissions !== 'function'
    || typeof rawBucket.file !== 'function' || typeof rawBucket.getFiles !== 'function') {
    throw new Error('Real acceptance runtime configuration is invalid');
  }
  const gcsClient = createBoundedGcsClient(rawBucket, {
    getParentSignal,
    operationDeadlineMs,
    gcsPrefix,
    fetchImpl,
  });
  const evidenceGcsClient = createBoundedGcsClient(rawBucket, {
    getParentSignal,
    operationDeadlineMs,
    gcsPrefix,
    fetchImpl,
    additionalExactNames: [evidenceOutputObject],
  });
  let schemaOwned = false;
  let gcsPrefixOwned = false;
  let schemaAcquisitionAttempted = false;
  let gcsPrefixAcquisitionAttempted = false;
  let gcsCleanupVerified = false;
  let schemaCleanupVerified = false;
  let closed = false;

  const prefixObjectCount = async ({ stopAfterFirst = false } = {}) => {
    let count = 0;
    let cursor = null;
    const seen = new Set();
    do {
      const page = await gcsClient.listObjectsPage({ prefix: gcsPrefix, limit: 100, cursor });
      count += page.names.length;
      if (stopAfterFirst && count > 0) return count;
      if (count > 10_000 || (page.cursor && seen.has(page.cursor))) {
        throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
      }
      if (page.cursor) seen.add(page.cursor);
      cursor = page.cursor;
    } while (cursor);
    return count;
  };

  return {
    async runChecks({ signal = null } = {}) {
      activeSignal = signal;
      try {
        const identityStartedAt = performance.now();
        let executionIdentity;
        try {
          executionIdentity = await withDeadline(
            (identitySignal) => attestExecutionIdentity({ signal: identitySignal }),
            {
              timeoutMs: operationDeadlineMs,
              code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
              parentSignal: activeSignal,
            },
          );
        } catch {
          throw deadlineError('DEPENDENCY_GCP_IDENTITY_INVALID');
        }
        if (executionIdentity !== ACCEPTANCE_SERVICE_ACCOUNT) {
          throw deadlineError('DEPENDENCY_GCP_IDENTITY_INVALID');
        }
        const storageIdentityStartedAt = performance.now();
        const storageIdentity = await withDeadline(
          () => attestStorageAdcIdentity(storage),
          {
            timeoutMs: operationDeadlineMs,
            code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
            parentSignal: activeSignal,
          },
        );
        if (storageIdentity !== ACCEPTANCE_SERVICE_ACCOUNT) {
          throw deadlineError('DEPENDENCY_GCS_IDENTITY_INVALID');
        }
        await gcsClient.assertBucketIdentity();
        const identityLatencyMs = Math.max(0, performance.now() - identityStartedAt);
        const storageIdentityLatencyMs = Math.max(0, performance.now() - storageIdentityStartedAt);
        const identityChecks = [
          { name: 'gcp-execution-identity', status: 'pass', latencyMs: identityLatencyMs },
          {
            name: `gcp-identity-${sha256(ACCEPTANCE_SERVICE_ACCOUNT)}`,
            status: 'pass',
            latencyMs: identityLatencyMs,
          },
          { name: 'gcs-adc-identity', status: 'pass', latencyMs: storageIdentityLatencyMs },
          { name: 'gcs-bucket-project', status: 'pass', latencyMs: storageIdentityLatencyMs },
        ];
        const version = await adminPool.query('SHOW server_version_num');
        const versionNumber = Number(version.rows[0]?.server_version_num);
        if (!Number.isSafeInteger(versionNumber) || versionNumber < 160_000 || versionNumber >= 170_000) {
          throw deadlineError('DEPENDENCY_POSTGRES_VERSION_INVALID');
        }
        const migratorIdentity = await adminPool.query(`
          SELECT current_user AS current_user,
            has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_schema,
            has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database
        `);
        if (migratorIdentity.rows[0]?.current_user !== MIGRATOR_DATABASE_USER) {
          throw deadlineError('DEPENDENCY_POSTGRES_IDENTITY_INVALID');
        }
        const existingSchema = await adminPool.query(
          'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1',
          [schema],
        );
        if (Number(existingSchema.rows[0]?.count) !== 0) {
          throw new Error('Acceptance schema is not fresh');
        }
        if (await prefixObjectCount({ stopAfterFirst: true }) !== 0) {
          throw new Error('Acceptance GCS prefix is not fresh');
        }
        gcsPrefixAcquisitionAttempted = true;
        await gcsClient.putObject({
          name: `${gcsPrefix}.acceptance-owner`,
          bytes: Buffer.from(runId, 'utf8'),
          contentType: 'application/octet-stream',
          ifAbsent: true,
        });
        gcsPrefixOwned = true;
        schemaAcquisitionAttempted = true;
        await adminPool.query(`CREATE SCHEMA "${schema}"`);
        schemaOwned = true;
        const migration = await withDeadline((operationSignal) => readMigration({ signal: operationSignal }), {
          timeoutMs: operationDeadlineMs,
          code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
          parentSignal: activeSignal,
        });
        if (typeof migration !== 'string' || migration.length < 1 || migration.length > 4 * 1024 * 1024) {
          throw new Error('Migration is unavailable');
        }
        await migratorPool.query(migration);
        await migratorPool.query(`GRANT USAGE ON SCHEMA "${schema}" TO "${APP_DATABASE_USER}"`);
        await migratorPool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${schema}" TO "${APP_DATABASE_USER}"`);
        await migratorPool.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA "${schema}" TO "${APP_DATABASE_USER}"`);
        const appIdentity = await poolOne.query(`
          SELECT current_user AS current_user,
            has_schema_privilege(current_user, $1, 'CREATE') AS can_create_schema,
            has_database_privilege(current_user, current_database(), 'CREATE') AS can_create_database
        `, [schema]);
        if (appIdentity.rows[0]?.current_user !== APP_DATABASE_USER
          || appIdentity.rows[0]?.can_create_schema !== false
          || appIdentity.rows[0]?.can_create_database !== false) {
          throw deadlineError('DEPENDENCY_POSTGRES_IDENTITY_INVALID');
        }
        const dependencyChecks = await exerciseChecks({
          stores: [storeOne, storeTwo],
          pools: [poolOne, poolTwo],
          gcsClient,
          gcsPrefix,
          runId,
          occurredAt,
          signal: activeSignal,
        });
        return [...identityChecks, ...dependencyChecks];
      } finally {
        activeSignal = null;
      }
    },
    async cleanupGcsPrefix(prefix, { signal = null } = {}) {
      activeSignal = signal;
      try {
        if (prefix !== gcsPrefix || !GCS_PREFIX.test(prefix)) {
          throw new Error('GCS cleanup scope is invalid');
        }
        if (!gcsPrefixOwned && !gcsPrefixAcquisitionAttempted) {
          const remaining = await prefixObjectCount({ stopAfterFirst: true });
          gcsCleanupVerified = remaining === 0;
          return remaining;
        }
        let deleted = 0;
        while (true) {
          const page = await gcsClient.listObjectsPage({ prefix, limit: 100 });
          if (page.names.length === 0) break;
          for (const name of page.names) {
            await gcsClient.deleteObject({ name });
            deleted += 1;
            if (deleted > 10_000) throw gcsError('DEPENDENCY_GCS_RESPONSE_INVALID');
          }
        }
        const remaining = await prefixObjectCount();
        gcsCleanupVerified = remaining === 0;
        if (gcsCleanupVerified) {
          gcsPrefixOwned = false;
          gcsPrefixAcquisitionAttempted = false;
        }
        return remaining;
      } finally {
        activeSignal = null;
      }
    },
    async dropSchema(scope, { signal = null } = {}) {
      activeSignal = signal;
      try {
        if (scope !== schema || !SCHEMA.test(scope)) throw new Error('Schema cleanup scope is invalid');
        if (!schemaOwned && !schemaAcquisitionAttempted) {
          const existing = await adminPool.query(
            'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1',
            [schema],
          );
          schemaCleanupVerified = Number(existing.rows[0]?.count) === 0;
          return schemaCleanupVerified;
        }
        await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
        const result = await adminPool.query(
          'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1',
          [schema],
        );
        const absent = Number(result.rows[0]?.count) === 0;
        schemaCleanupVerified = absent;
        if (absent) {
          schemaOwned = false;
          schemaAcquisitionAttempted = false;
        }
        return absent;
      } finally {
        activeSignal = null;
      }
    },
    async close({ signal = null } = {}) {
      activeSignal = signal;
      const results = await Promise.allSettled([
        poolOne.end(), poolTwo.end(), migratorPool.end(), adminPool.end(),
      ]);
      activeSignal = null;
      if (results.some(({ status }) => status === 'rejected')) throw new Error('Dependency close failed');
      closed = true;
    },
    async writeEvidenceObject({
      objectName,
      contents,
      artifactSha256,
      objectSha256,
    } = {}, { signal = null } = {}) {
      activeSignal = signal;
      try {
        if (!gcsCleanupVerified || !schemaCleanupVerified || !closed) {
          throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_NOT_READY');
        }
        const body = Buffer.from(contents ?? '', 'utf8');
        let parsedRecord = null;
        try {
          parsedRecord = JSON.parse(contents);
        } catch {
          parsedRecord = null;
        }
        if (objectName !== evidenceOutputObject || typeof contents !== 'string'
          || contents.length < 1 || contents.length > 1024 * 1024
          || !contents.endsWith('\n')
          || body.length !== Buffer.byteLength(contents, 'utf8')
          || !DIGEST.test(String(artifactSha256 ?? ''))
          || !DIGEST.test(String(objectSha256 ?? ''))
          || sha256(body) !== objectSha256
          || parsedRecord?.artifactSha256 !== artifactSha256
          || finalizeReleaseEvidenceRecord(parsedRecord ?? {}).artifactSha256 !== artifactSha256) {
          throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_INVALID');
        }
        let writeCompleted = false;
        try {
          await evidenceGcsClient.putObject({
            name: objectName,
            bytes: body,
            contentType: 'application/json',
            ifAbsent: true,
          });
          writeCompleted = true;
          const metadata = await evidenceGcsClient.headObject({ name: objectName });
          const readback = await evidenceGcsClient.readObject({ name: objectName });
          await evidenceGcsClient.assertObjectPrivate(objectName);
          if (!/^[1-9]\d*$/.test(String(metadata.generation ?? ''))
            || metadata.size !== body.length
            || Buffer.compare(readback, body) !== 0
            || sha256(readback) !== objectSha256) {
            throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_INVALID');
          }
          return {
            objectName,
            generation: String(metadata.generation),
            artifactSha256,
            objectSha256,
          };
        } catch (error) {
          try {
            const discovered = await evidenceGcsClient.headObject({
              name: objectName,
              allowMissing: true,
            });
            if (discovered) {
              if (!writeCompleted) {
                const discoveredBody = await evidenceGcsClient.readObject({ name: objectName });
                if (Buffer.compare(discoveredBody, body) !== 0
                  || sha256(discoveredBody) !== objectSha256) {
                  throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_CLEANUP_FAILED');
                }
              }
              if (!/^[1-9]\d*$/.test(String(discovered.generation ?? ''))) {
                throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_CLEANUP_FAILED');
              }
              await evidenceGcsClient.deleteObject({
                name: objectName,
                generation: String(discovered.generation),
              });
              if (await evidenceGcsClient.headObject({
                name: objectName,
                allowMissing: true,
              }) !== null) {
                throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_CLEANUP_FAILED');
              }
            }
          } catch {
            throw deadlineError('DEPENDENCY_EVIDENCE_OUTPUT_CLEANUP_FAILED');
          }
          throw error;
        }
      } finally {
        activeSignal = null;
      }
    },
  };
}

async function defaultOpenDependencies(input) {
  const [{ Pool }, { Storage }] = await Promise.all([
    import('pg'),
    import('@google-cloud/storage'),
  ]);
  return createRealAcceptanceRuntime({
    ...input,
    PoolClass: Pool,
    StorageClass: Storage,
  });
}

function validateConfiguration(environment) {
  const commitSha = environment?.V1_RELEASE_COMMIT_SHA;
  if (!RELEASE_SHA.test(String(commitSha ?? ''))) {
    return { error: 'RELEASE_COMMIT_INVALID' };
  }
  if (environment?.V1_RELEASE_MANIFEST_FILE !== RELEASE_MANIFEST_FILE) {
    return { error: 'RELEASE_MANIFEST_INVALID' };
  }
  const outputObject = environment?.V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT;
  const outputMatch = EVIDENCE_OUTPUT_OBJECT.exec(String(outputObject ?? ''));
  const isolation = validateIsolation(
    environment?.V1_ACCEPTANCE_SCHEMA,
    environment?.V1_ACCEPTANCE_GCS_PREFIX,
  );
  if (!isolation) return { error: 'ISOLATION_SCOPE_INVALID' };
  if (!outputMatch || outputMatch[1] !== commitSha || outputMatch[2] !== isolation.runId) {
    return { error: 'EVIDENCE_OUTPUT_INVALID' };
  }
  const azureKeys = [
    'V1_ACCEPTANCE_BLOB_CONNECTION_STRING',
    'V1_ACCEPTANCE_BLOB_ACCOUNT_URL',
    'V1_ACCEPTANCE_BLOB_CONTAINER',
    'V1_ACCEPTANCE_BLOB_RESOURCE_ID',
    'V1_ACCEPTANCE_BLOB_PREFIX',
    'V1_BLOB_CONNECTION_STRING',
    'V1_BLOB_ACCOUNT_URL',
    'V1_BLOB_CONTAINER',
    'V1_BLOB_RESOURCE_ID',
    'AZURE_STORAGE_CONNECTION_STRING',
    'AZURE_BLOB_ACCOUNT_URL',
    'AZURE_BLOB_CONTAINER',
    'AZURE_STORAGE_CONTAINER',
  ];
  if (azureKeys.some((key) => environment?.[key] !== undefined)
    || environment?.V1_MEDIA_DRIVER === 'azure') {
    return { error: 'ACCIDENTAL_AZURE_CONFIGURATION' };
  }
  const credentialKeys = [
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_API_KEY',
    'GCP_API_KEY',
    'V1_GCS_API_KEY',
    'V1_GCS_CREDENTIALS_JSON',
    'V1_ACCEPTANCE_GCS_CREDENTIALS_JSON',
    'V1_ACCEPTANCE_GOOGLE_APPLICATION_CREDENTIALS',
  ];
  if (credentialKeys.some((key) => environment?.[key] !== undefined)) {
    return { error: 'ADC_CONFIGURATION_INVALID' };
  }
  const required = [
    environment?.V1_ACCEPTANCE_DATABASE_URL,
    environment?.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL,
    environment?.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID,
    environment?.V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT,
    environment?.V1_ACCEPTANCE_GCS_BUCKET,
    environment?.V1_ACCEPTANCE_GCS_RESOURCE_ID,
    environment?.V1_DATABASE_URL,
    environment?.V1_POSTGRES_RESOURCE_ID,
    environment?.V1_GOOGLE_CLOUD_PROJECT,
    environment?.V1_GCS_BUCKET,
    environment?.V1_GCS_RESOURCE_ID,
  ];
  const inventoryFile = environment?.V1_LEGACY_RESOURCE_INVENTORY_FILE;
  const inventoryVersion = environment?.V1_LEGACY_RESOURCE_INVENTORY_VERSION;
  if (required.some((value) => !nonEmpty(value, 32_768))
    || environment.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID !== POSTGRES_RESOURCE_ID
    || environment.V1_POSTGRES_RESOURCE_ID !== POSTGRES_RESOURCE_ID
    || environment.V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT !== PROJECT_ID
    || environment.V1_GOOGLE_CLOUD_PROJECT !== PROJECT_ID
    || environment.V1_ACCEPTANCE_GCS_BUCKET !== BUCKET_NAME
    || environment.V1_GCS_BUCKET !== BUCKET_NAME
    || environment.V1_ACCEPTANCE_GCS_RESOURCE_ID !== GCS_RESOURCE_ID
    || environment.V1_GCS_RESOURCE_ID !== GCS_RESOURCE_ID) {
    return { error: 'CONFIGURATION_INVALID' };
  }
  if (!isAbsolute(String(inventoryFile ?? ''))
    || !String(inventoryFile).toLowerCase().endsWith('.json')
    || !DIGEST.test(String(inventoryVersion ?? ''))
    || environment?.V1_LEGACY_RESOURCE_INVENTORY_APPROVED !== 'true') {
    return { error: 'LEGACY_INVENTORY_REQUIRED' };
  }

  let acceptancePostgresIdentity;
  let migratorPostgresIdentity;
  let intendedPostgresIdentity;
  let acceptanceGcsIdentity;
  let intendedGcsIdentity;
  try {
    assertSecurePostgresRuntimeUrl(environment.V1_ACCEPTANCE_DATABASE_URL);
    assertSecurePostgresRuntimeUrl(environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL);
    assertSecurePostgresRuntimeUrl(environment.V1_DATABASE_URL);
    acceptancePostgresIdentity = postgresIdentitySha256(environment.V1_ACCEPTANCE_DATABASE_URL);
    migratorPostgresIdentity = postgresIdentitySha256(
      environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL,
    );
    intendedPostgresIdentity = postgresIdentitySha256(environment.V1_DATABASE_URL);
    acceptanceGcsIdentity = gcsIdentitySha256({
      projectId: environment.V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT,
      bucket: environment.V1_ACCEPTANCE_GCS_BUCKET,
    });
    intendedGcsIdentity = gcsIdentitySha256({
      projectId: environment.V1_GOOGLE_CLOUD_PROJECT,
      bucket: environment.V1_GCS_BUCKET,
    });
  } catch {
    return { error: 'RESOURCE_IDENTITY_MISMATCH' };
  }
  if (environment.V1_ACCEPTANCE_DATABASE_URL !== environment.V1_DATABASE_URL
    || environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL === environment.V1_ACCEPTANCE_DATABASE_URL
    || postgresUser(environment.V1_ACCEPTANCE_DATABASE_URL) !== APP_DATABASE_USER
    || postgresUser(environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL) !== MIGRATOR_DATABASE_USER
    || postgresPassword(environment.V1_ACCEPTANCE_DATABASE_URL) === null
    || postgresPassword(environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL) === null
    || postgresPassword(environment.V1_ACCEPTANCE_DATABASE_URL)
      === postgresPassword(environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL)
    || environment.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID !== environment.V1_POSTGRES_RESOURCE_ID
    || environment.V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT !== environment.V1_GOOGLE_CLOUD_PROJECT
    || environment.V1_ACCEPTANCE_GCS_BUCKET !== environment.V1_GCS_BUCKET
    || environment.V1_ACCEPTANCE_GCS_RESOURCE_ID !== environment.V1_GCS_RESOURCE_ID
    || acceptancePostgresIdentity !== intendedPostgresIdentity
    || migratorPostgresIdentity !== intendedPostgresIdentity
    || acceptanceGcsIdentity !== intendedGcsIdentity) {
    return { error: 'RESOURCE_IDENTITY_MISMATCH' };
  }
  if (legacyCompatibilityCollides(environment, intendedPostgresIdentity)) {
    return { error: 'LEGACY_COMPATIBILITY_COLLISION' };
  }
  return {
    commitSha,
    ...isolation,
    databaseUrl: environment.V1_ACCEPTANCE_DATABASE_URL,
    migratorDatabaseUrl: environment.V1_ACCEPTANCE_MIGRATOR_DATABASE_URL,
    releaseManifestFile: RELEASE_MANIFEST_FILE,
    evidenceOutputObject: outputObject,
    projectId: PROJECT_ID,
    bucketName: BUCKET_NAME,
    postgresResourceId: environment.V1_POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: intendedPostgresIdentity,
    gcsResourceId: environment.V1_GCS_RESOURCE_ID,
    gcsIdentitySha256: intendedGcsIdentity,
    inventoryFile,
    inventoryVersion,
  };
}

export async function runRealDependencyAcceptance({
  argv = process.argv.slice(2),
  environment = process.env,
  now = () => new Date(),
  readTextFile = (filePath, { signal } = {}) => readFile(filePath, { encoding: 'utf8', signal }),
  openDependencies = defaultOpenDependencies,
  writeOutput = (line) => process.stdout.write(line),
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  commandDeadlineMs = DEFAULT_COMMAND_DEADLINE_MS,
  cleanupDeadlineMs = DEFAULT_CLEANUP_DEADLINE_MS,
  cleanupOperationDeadlineMs = DEFAULT_CLEANUP_OPERATION_DEADLINE_MS,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 1
    || typeof argv[0] !== 'string' || !argv[0].startsWith('--release-sha=')) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'EXACT_INVOCATION_REQUIRED' });
  }
  if (environment?.V1_ACCEPTANCE_CONFIRM_EPHEMERAL !== 'true') {
    return publish(writeOutput, 2, { status: 'not-run', code: 'EPHEMERAL_CONFIRMATION_REQUIRED' });
  }
  const config = validateConfiguration(environment);
  if (config.error) {
    return publish(writeOutput, 2, { status: 'not-run', code: config.error });
  }
  const requestedReleaseSha = argv[0].slice('--release-sha='.length);
  if (!RELEASE_SHA.test(requestedReleaseSha) || requestedReleaseSha !== config.commitSha) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_SHA_MISMATCH' });
  }
  operationDeadlineMs = deadlineValue(operationDeadlineMs, DEFAULT_OPERATION_DEADLINE_MS);
  commandDeadlineMs = deadlineValue(commandDeadlineMs, DEFAULT_COMMAND_DEADLINE_MS);
  cleanupDeadlineMs = deadlineValue(cleanupDeadlineMs, DEFAULT_CLEANUP_DEADLINE_MS);
  cleanupOperationDeadlineMs = deadlineValue(
    cleanupOperationDeadlineMs,
    DEFAULT_CLEANUP_OPERATION_DEADLINE_MS,
  );
  if (typeof readTextFile !== 'function' || typeof openDependencies !== 'function'
    || operationDeadlineMs === null || commandDeadlineMs === null
    || cleanupDeadlineMs === null || cleanupOperationDeadlineMs === null) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'COMMAND_CONTEXT_INVALID' });
  }
  let currentTime;
  try {
    currentTime = new Date(now());
    if (!Number.isFinite(currentTime.getTime())) throw new Error('invalid clock');
  } catch {
    return publish(writeOutput, 2, { status: 'not-run', code: 'ACCEPTANCE_TIME_INVALID' });
  }

  const commandBudget = createDeadlineSignal({
    timeoutMs: commandDeadlineMs,
    code: 'DEPENDENCY_COMMAND_DEADLINE_EXCEEDED',
  });
  const mainOperation = (operation, timeoutMs = operationDeadlineMs) => withDeadline(operation, {
    timeoutMs,
    code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: commandBudget.signal,
  });

  let releaseManifest;
  try {
    const text = await mainOperation((signal) => readTextFile(config.releaseManifestFile, { signal }));
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > 1_024) {
      throw new Error('invalid release manifest');
    }
    releaseManifest = JSON.parse(text);
  } catch {
    const timedOut = commandBudget.signal.aborted;
    commandBudget.dispose();
    return publish(writeOutput, timedOut ? 1 : 2, {
      status: timedOut ? 'failed' : 'not-run',
      code: timedOut ? 'DEPENDENCY_COMMAND_DEADLINE_EXCEEDED' : 'RELEASE_MANIFEST_INVALID',
    });
  }
  if (!validateReleaseManifest(releaseManifest, config.commitSha)) {
    commandBudget.dispose();
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_MANIFEST_INVALID' });
  }

  let inventory;
  try {
    const text = await mainOperation((signal) => readTextFile(config.inventoryFile, { signal }));
    if (typeof text !== 'string' || text.length > 1024 * 1024) throw new Error('invalid inventory');
    inventory = JSON.parse(text);
  } catch {
    const timedOut = commandBudget.signal.aborted;
    commandBudget.dispose();
    return publish(writeOutput, timedOut ? 1 : 2, {
      status: timedOut ? 'failed' : 'not-run',
      code: timedOut ? 'DEPENDENCY_COMMAND_DEADLINE_EXCEEDED' : 'LEGACY_INVENTORY_INVALID',
    });
  }
  const inventoryResult = validateLegacyResourceInventory(inventory, {
    expectedVersion: config.inventoryVersion,
    commitSha: config.commitSha,
    now: currentTime,
  });
  if (!inventoryResult.valid
    || inventoryContains(inventory, config.postgresResourceId, config.postgresIdentitySha256, 'postgresResources')
    || inventoryContains(inventory, config.gcsResourceId, config.gcsIdentitySha256, 'blobResources')) {
    commandBudget.dispose();
    return publish(writeOutput, 2, { status: 'not-run', code: 'LEGACY_INVENTORY_INVALID' });
  }

  let runtime = null;
  let checks = [];
  let functionalSuccess = false;
  const cleanup = {
    gcsPrefixObjectCount: null,
    schemaAbsent: false,
    closed: false,
  };
  try {
    runtime = await mainOperation((signal) => openDependencies({
      databaseUrl: config.databaseUrl,
      migratorDatabaseUrl: config.migratorDatabaseUrl,
      projectId: config.projectId,
      bucketName: config.bucketName,
      releaseSha: config.commitSha,
      evidenceOutputObject: config.evidenceOutputObject,
      gcsPrefix: config.gcsPrefix,
      schema: config.schema,
      runId: config.runId,
      occurredAt: currentTime.toISOString(),
      operationDeadlineMs,
      signal,
    }));
    if (!runtime || typeof runtime.runChecks !== 'function'
      || typeof runtime.cleanupGcsPrefix !== 'function'
      || typeof runtime.dropSchema !== 'function'
      || typeof runtime.close !== 'function'
      || typeof runtime.writeEvidenceObject !== 'function') {
      throw new Error('Invalid acceptance runtime');
    }
    checks = await mainOperation(
      (signal) => runtime.runChecks({ signal }),
      commandDeadlineMs,
    );
    functionalSuccess = Boolean(safeChecks(checks) && hasCoreChecks(checks));
  } catch {
    functionalSuccess = false;
  } finally {
    commandBudget.dispose();
    if (runtime) {
      const cleanupBudget = createDeadlineSignal({
        timeoutMs: cleanupDeadlineMs,
        code: 'DEPENDENCY_CLEANUP_TOTAL_DEADLINE_EXCEEDED',
      });
      const branchDeadlineMs = Math.min(
        cleanupOperationDeadlineMs,
        Math.max(1, Math.floor(cleanupDeadlineMs / 3)),
      );
      const cleanupOperation = (operation) => withDeadline(operation, {
        timeoutMs: branchDeadlineMs,
        code: 'DEPENDENCY_CLEANUP_OPERATION_DEADLINE_EXCEEDED',
        parentSignal: cleanupBudget.signal,
      });
      try {
        cleanup.gcsPrefixObjectCount = await cleanupOperation(
          (signal) => runtime.cleanupGcsPrefix(config.gcsPrefix, { signal }),
        );
        if (!Number.isSafeInteger(cleanup.gcsPrefixObjectCount) || cleanup.gcsPrefixObjectCount < 0) {
          cleanup.gcsPrefixObjectCount = null;
        }
      } catch {
        cleanup.gcsPrefixObjectCount = null;
      }
      try {
        cleanup.schemaAbsent = await cleanupOperation(
          (signal) => runtime.dropSchema(config.schema, { signal }),
        ) === true;
      } catch {
        cleanup.schemaAbsent = false;
      }
      try {
        await cleanupOperation((signal) => runtime.close({ signal }));
        cleanup.closed = true;
      } catch {
        cleanup.closed = false;
      }
      cleanupBudget.dispose();
    }
  }

  const cleanupSuccess = cleanup.gcsPrefixObjectCount === 0
    && cleanup.schemaAbsent === true
    && cleanup.closed === true;
  const result = functionalSuccess && cleanupSuccess;
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: config.commitSha,
    legacyInventoryDigest: inventory.artifactSha256,
    postgresResourceId: config.postgresResourceId,
    postgresIdentitySha256: config.postgresIdentitySha256,
    gcsResourceId: config.gcsResourceId,
    gcsIdentitySha256: config.gcsIdentitySha256,
    schema: config.schema,
    gcsPrefix: config.gcsPrefix,
    checks: result ? safeChecks(checks) : safeFailureChecks(checks, cleanup),
    schemaAbsent: cleanup.schemaAbsent,
    gcsPrefixObjectCount: cleanup.gcsPrefixObjectCount,
    result,
    occurredAt: currentTime.toISOString(),
  });
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const objectSha256 = sha256(Buffer.from(contents, 'utf8'));
  let output = null;
  if (cleanupSuccess && runtime) {
    try {
      output = await withDeadline(
        (signal) => runtime.writeEvidenceObject({
          objectName: config.evidenceOutputObject,
          contents,
          record,
          artifactSha256: record.artifactSha256,
          objectSha256,
        }, { signal }),
        { timeoutMs: operationDeadlineMs, code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED' },
      );
      if (!output || output.objectName !== config.evidenceOutputObject
        || !/^[1-9]\d*$/.test(String(output.generation ?? ''))
        || output.artifactSha256 !== record.artifactSha256
        || output.objectSha256 !== objectSha256) {
        throw new Error('invalid evidence output receipt');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed',
        code: 'ACCEPTANCE_ARTIFACT_WRITE_FAILED',
        outputObject: config.evidenceOutputObject,
      });
    }
  }
  if (!result) {
    return publish(writeOutput, 1, {
      status: 'failed',
      code: 'DEPENDENCY_ACCEPTANCE_FAILED',
      artifactSha256: record.artifactSha256,
      ...(output ? { output } : {}),
      checks: record.checks,
      cleanup: {
        schemaAbsent: record.schemaAbsent,
        gcsPrefixObjectCount: record.gcsPrefixObjectCount,
      },
    });
  }
  return publish(writeOutput, 0, {
    status: 'recorded',
    code: 'DEPENDENCY_ACCEPTANCE_RECORDED',
    artifactSha256: record.artifactSha256,
    output,
    checks: record.checks,
    cleanup: {
      schemaAbsent: record.schemaAbsent,
      gcsPrefixObjectCount: record.gcsPrefixObjectCount,
    },
  });
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const result = await runRealDependencyAcceptance();
  process.exitCode = result.exitCode;
}
