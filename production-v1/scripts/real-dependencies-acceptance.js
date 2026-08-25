import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  assertSecurePostgresRuntimeUrl,
  blobIdentitySha256,
  DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES,
  finalizeReleaseEvidenceRecord,
  postgresIdentitySha256,
  validateLegacyResourceInventory,
} from '../src/services/release-evidence.js';
import { PostgresStore } from '../src/stores/postgres-store.js';

const execFileAsync = promisify(execFile);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SCHEMA = /^v1_accept_([0-9a-f]{32})$/;
const BLOB_PREFIX = /^v1-accept\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/$/;
const CHECK_NAME = /^[a-z0-9][a-z0-9-]{0,79}$/;
const CONTAINER = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const DEFAULT_OPERATION_DEADLINE_MS = 30_000;
const DEFAULT_COMMAND_DEADLINE_MS = 15 * 60_000;
const DEFAULT_CLEANUP_DEADLINE_MS = 90_000;
const DEFAULT_CLEANUP_OPERATION_DEADLINE_MS = 20_000;
const MAX_DEADLINE_MS = 60 * 60_000;
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const migrationFile = fileURLToPath(new URL('../migrations/001_initial.sql', import.meta.url));
const defaultArtifactDirectory = join(productionRoot, 'reports', 'acceptance');

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

function createBoundedListIterable(
  rawContainerClient,
  options,
  { getParentSignal, operationDeadlineMs },
  pageSettings = null,
) {
  const createIterator = () => {
    const parentSignal = getParentSignal();
    const iteratorController = new AbortController();
    const abortFromParent = () => iteratorController.abort(deadlineReason(
      parentSignal,
      'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    ));
    if (parentSignal?.aborted) abortFromParent();
    else parentSignal?.addEventListener('abort', abortFromParent, { once: true });
    const listed = rawContainerClient.listBlobsFlat({
      ...options,
      abortSignal: iteratorController.signal,
    });
    const iterable = pageSettings === null ? listed : listed.byPage(pageSettings);
    const source = iterable[Symbol.asyncIterator]();
    const dispose = () => parentSignal?.removeEventListener('abort', abortFromParent);
    const invoke = async (method, args) => {
      try {
        const result = await withDeadline(async (signal) => {
          const abortIterator = () => iteratorController.abort(deadlineReason(
            signal,
            'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
          ));
          if (signal.aborted) abortIterator();
          else signal.addEventListener('abort', abortIterator, { once: true });
          try {
            return await source[method](...args);
          } finally {
            signal.removeEventListener('abort', abortIterator);
          }
        }, {
          timeoutMs: operationDeadlineMs,
          code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
          parentSignal,
        });
        if (result?.done) dispose();
        return result;
      } catch (error) {
        dispose();
        throw error;
      }
    };
    return {
      next: (...args) => invoke('next', args),
      async return(...args) {
        iteratorController.abort(deadlineError('DEPENDENCY_ITERATOR_CLOSED'));
        if (typeof source.return !== 'function') {
          dispose();
          return { done: true };
        }
        return invoke('return', args);
      },
      async throw(...args) {
        if (typeof source.throw !== 'function') {
          dispose();
          throw args[0];
        }
        return invoke('throw', args);
      },
      [Symbol.asyncIterator]() { return this; },
    };
  };
  return {
    [Symbol.asyncIterator]: createIterator,
    byPage(settings) {
      return createBoundedListIterable(
        rawContainerClient,
        options,
        { getParentSignal, operationDeadlineMs },
        settings,
      );
    },
  };
}

function createBoundedBlobClient(rawBlobClient, { getParentSignal, operationDeadlineMs }) {
  const bounded = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: getParentSignal(),
  });
  return {
    uploadData(data, options = {}) {
      return bounded((signal) => rawBlobClient.uploadData(data, { ...options, abortSignal: signal }));
    },
    deleteIfExists(options = {}) {
      return bounded((signal) => rawBlobClient.deleteIfExists({ ...options, abortSignal: signal }));
    },
    getProperties(options = {}) {
      return bounded((signal) => rawBlobClient.getProperties({ ...options, abortSignal: signal }));
    },
    downloadToBuffer(offset, count, options = {}) {
      return bounded((signal) => rawBlobClient.downloadToBuffer(
        offset,
        count,
        { ...options, abortSignal: signal },
      ));
    },
  };
}

function createBoundedContainerClient(rawContainerClient, { getParentSignal, operationDeadlineMs }) {
  const bounded = (operation) => withDeadline(operation, {
    timeoutMs: operationDeadlineMs,
    code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
    parentSignal: getParentSignal(),
  });
  return {
    getProperties(options = {}) {
      return bounded((signal) => rawContainerClient.getProperties({ ...options, abortSignal: signal }));
    },
    getAccessPolicy(options = {}) {
      return bounded((signal) => rawContainerClient.getAccessPolicy({ ...options, abortSignal: signal }));
    },
    getBlockBlobClient(name) {
      return createBoundedBlobClient(rawContainerClient.getBlockBlobClient(name), {
        getParentSignal,
        operationDeadlineMs,
      });
    },
    listBlobsFlat(options = {}) {
      return createBoundedListIterable(
        rawContainerClient,
        options,
        { getParentSignal, operationDeadlineMs },
      );
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

function validResourceId(value, provider, resourceType) {
  if (!nonEmpty(value, 1_024)) return false;
  const segments = value.split('/');
  return segments.length === 9
    && segments[0] === ''
    && segments[1].toLowerCase() === 'subscriptions'
    && segments[2].length > 0
    && segments[3].toLowerCase() === 'resourcegroups'
    && segments[4].length > 0
    && segments[5].toLowerCase() === 'providers'
    && segments[6].toLowerCase() === provider.toLowerCase()
    && segments[7].toLowerCase() === resourceType.toLowerCase()
    && segments.slice(6).every((segment) => /^[a-z0-9._()-]+$/i.test(segment));
}

function selectBlob(environment, prefix) {
  const connectionString = environment?.[`${prefix}_CONNECTION_STRING`];
  const accountUrl = environment?.[`${prefix}_ACCOUNT_URL`];
  const hasConnectionString = connectionString !== undefined;
  const hasAccountUrl = accountUrl !== undefined;
  if (hasConnectionString === hasAccountUrl) return null;
  if (hasConnectionString && !nonEmpty(connectionString, 32_768)) return null;
  if (hasAccountUrl && !nonEmpty(accountUrl, 4_096)) return null;
  return hasConnectionString
    ? { mode: 'connection-string', connectionString, accountUrl: null }
    : { mode: 'account-url', connectionString: null, accountUrl };
}

function validateIsolation(schema, prefix) {
  const schemaMatch = SCHEMA.exec(String(schema ?? ''));
  const prefixMatch = BLOB_PREFIX.exec(String(prefix ?? ''));
  if (!schemaMatch || !prefixMatch) return null;
  const runId = prefixMatch[1];
  return schemaMatch[1] === runId.replaceAll('-', '') ? { runId, schema, blobPrefix: prefix } : null;
}

function inventoryContains(inventory, resourceId, identitySha256, field) {
  const normalizedResourceId = resourceId.toLowerCase();
  return inventory[field].some((resource) => (
    resource.resourceId.toLowerCase() === normalizedResourceId
      || resource.identitySha256 === identitySha256
  ));
}

function legacyCompatibilityCollides(environment, postgresIdentity, blobIdentity) {
  if (environment?.DATABASE_URL !== undefined) {
    try {
      if (postgresIdentitySha256(environment.DATABASE_URL) === postgresIdentity) return true;
    } catch {
      return true;
    }
  }

  const connectionString = environment?.AZURE_STORAGE_CONNECTION_STRING;
  const accountUrl = environment?.AZURE_BLOB_ACCOUNT_URL;
  const hasConnectionString = connectionString !== undefined;
  const hasAccountUrl = accountUrl !== undefined;
  const suppliedContainers = [
    environment?.AZURE_BLOB_CONTAINER,
    environment?.AZURE_STORAGE_CONTAINER,
  ].filter((value) => value !== undefined);
  const hasLegacyBlobValue = connectionString !== undefined
    || accountUrl !== undefined
    || suppliedContainers.length > 0;
  if (!hasLegacyBlobValue) return false;
  if (hasConnectionString === hasAccountUrl) return true;
  if ((hasConnectionString && !nonEmpty(connectionString, 32_768))
    || (hasAccountUrl && !nonEmpty(accountUrl, 4_096))) return true;
  if (suppliedContainers.length === 0 || suppliedContainers.some((value) => !nonEmpty(value))) return true;
  if (new Set(suppliedContainers).size !== 1) return true;
  try {
    const identity = blobIdentitySha256({
      connectionString: hasConnectionString ? connectionString : undefined,
      accountUrl: hasAccountUrl ? accountUrl : undefined,
      container: suppliedContainers[0],
    });
    return identity === blobIdentity;
  } catch {
    return true;
  }
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
  return DEPENDENCY_ACCEPTANCE_CORE_CHECK_NAMES.every((name) => names.has(name));
}

function safeFailureChecks(checks, cleanup) {
  const completed = safeChecks(checks) ?? [];
  const names = new Set(completed.map(({ name }) => name));
  const append = (name, status) => {
    if (!names.has(name)) completed.push({ name, status });
  };
  append('acceptance-execution', 'fail');
  append('blob-prefix-cleanup', cleanup.blobPrefixObjectCount === 0 ? 'pass' : 'fail');
  append('postgres-schema-cleanup', cleanup.schemaAbsent === true ? 'pass' : 'fail');
  append('dependency-close', cleanup.closed === true ? 'pass' : 'fail');
  return completed;
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

async function defaultInspectGit(cwd, { signal } = {}) {
  const headResult = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1_024,
    signal,
  });
  const statusResult = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1_024,
    signal,
  });
  return {
    head: headResult.stdout.replace(/[\r\n]+$/, ''),
    clean: statusResult.stdout.length === 0,
  };
}

async function defaultWriteArtifact({ filePath, contents }, { signal } = {}) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', signal });
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
  containerClient,
  blobPrefix,
  cleanupNow,
  StoreClass = PostgresStore,
} = {}) {
  if (!pool || !containerClient || typeof containerClient.getBlockBlobClient !== 'function'
    || !BLOB_PREFIX.test(String(blobPrefix ?? ''))
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
    requireInvariant(typeof job.storageKey === 'string' && job.storageKey.startsWith(blobPrefix));
    await containerClient.getBlockBlobClient(job.storageKey).deleteIfExists();
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

async function runPostgresAndBlobChecks({
  stores,
  pools,
  containerClient,
  blobPrefix,
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
        now: addMs(occurredAt, 10),
      },
      {
        sessionId: owner.session.id,
        conversationId: owner.conversation.id,
        clientMessageId: randomUUID(),
        requestHash: sha256(`second:${runId}`),
        text: 'acceptance second turn',
        now: addMs(occurredAt, 11),
      },
    ];
    const accepted = await Promise.all([
      storeOne.acceptMessage(messages[0]),
      storeTwo.acceptMessage(messages[1]),
    ]);
    requireInvariant(new Set(accepted.map(({ message }) => message.sequence)).size === 2);
    const replay = await storeTwo.acceptMessage(messages[0]);
    requireInvariant(replay.idempotent === true && replay.message.id === accepted[0].message.id);

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
      attemptStorageKey: `${blobPrefix}rate/asr/${randomUUID()}`,
    });
    requireInvariant(firstAsr.status === 'claimed');
    for (const rateLimits of [asrWindows, [...asrWindows].reverse()]) {
      const blocked = await storeTwo.claimVoiceUploadWithRateLimits({
        ...asrBase,
        clientUploadId: randomUUID(),
        rateLimits,
        leaseToken: randomUUID(),
        attemptStorageKey: `${blobPrefix}rate/asr/${randomUUID()}`,
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
      attemptStorageKey: `${blobPrefix}rate/tts/${randomUUID()}`,
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
        attemptStorageKey: `${blobPrefix}rate/tts/${randomUUID()}`,
        configVersion: 'acceptance-rate-v1',
        leaseExpiresAt: addMs(occurredAt, 40_000),
        attemptDeadlineAt: addMs(occurredAt, 50_000),
        now: addMs(occurredAt, 901 + index),
      });
      requireInvariant(blocked.status === 'rate_limited'
        && blocked.blockingExpiresAt === dailyExpiry);
    }
  });

  await measure(checks, 'blob-private-full-range-head', async () => {
    await containerClient.getProperties();
    const access = await containerClient.getAccessPolicy();
    requireInvariant(!access?.blobPublicAccess && !access?.publicAccess);
    const key = `${blobPrefix}probe.bin`;
    const body = Buffer.from(`acceptance:${runId}`, 'utf8');
    const blob = containerClient.getBlockBlobClient(key);
    await blob.uploadData(body, { blobHTTPHeaders: { blobContentType: 'application/octet-stream' } });
    const properties = await blob.getProperties();
    const full = await blob.downloadToBuffer();
    const range = await blob.downloadToBuffer(1, Math.min(4, body.length - 1));
    requireInvariant(Number(properties.contentLength) === body.length);
    requireInvariant(Buffer.compare(full, body) === 0);
    requireInvariant(Buffer.compare(range, body.subarray(1, 1 + range.length)) === 0);
  });

  await measure(checks, 'postgres-media-fencing', async () => {
    const voiceId = randomUUID();
    const firstVoiceKey = `${blobPrefix}attempts/voice/${randomUUID()}`;
    const secondVoiceKey = `${blobPrefix}attempts/voice/${randomUUID()}`;
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
    await containerClient.getBlockBlobClient(secondVoiceKey).uploadData(voiceBody, {
      blobHTTPHeaders: { blobContentType: 'audio/wav' },
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

    const ttsKeyOne = `${blobPrefix}attempts/tts/${randomUUID()}`;
    const ttsKeyTwo = `${blobPrefix}attempts/tts/${randomUUID()}`;
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
    const recoveredTtsKey = `${blobPrefix}attempts/tts/${randomUUID()}`;
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
    await containerClient.getBlockBlobClient(recoveredTtsKey).uploadData(ttsBody, {
      blobHTTPHeaders: { blobContentType: 'audio/mpeg' },
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

    const lifecycleKey = `${blobPrefix}lifecycle/${randomUUID()}`;
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
    const pendingLifecycleKey = `${blobPrefix}lifecycle/${randomUUID()}`;
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
    const dedupKey = `${blobPrefix}lifecycle/${randomUUID()}`;
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
    const beforeWriteKey = `${blobPrefix}provider-before-write/${randomUUID()}`;
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
    const beforeAttachKey = `${blobPrefix}provider-before-attach/${randomUUID()}`;
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
    await containerClient.getBlockBlobClient(beforeAttachKey).uploadData(beforeAttachBody, {
      blobHTTPHeaders: { blobContentType: 'audio/wav' },
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
        attemptStorageKey: `${blobPrefix}delete-first/${randomUUID()}`,
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
    await containerClient.getBlockBlobClient(firstVoiceKey).uploadData(lateBody, {
      blobHTTPHeaders: { blobContentType: 'audio/wav' },
    });
    await containerClient.getBlockBlobClient(winner.generation.attemptStorageKey).uploadData(lateBody, {
      blobHTTPHeaders: { blobContentType: 'audio/mpeg' },
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
      containerClient,
      blobPrefix,
      cleanupNow,
    });
    requireInvariant(processed >= 3);
    const pending = await pools[0].query(`
      SELECT count(*)::int AS count FROM media_deletion_jobs
      WHERE state IN ('pending', 'deleting')
    `);
    requireInvariant(Number(pending.rows[0]?.count) === 0);
    const accessible = new Set();
    for await (const item of containerClient.listBlobsFlat({ prefix: blobPrefix })) {
      accessible.add(item.name);
    }
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
  blob,
  blobContainer,
  blobPrefix,
  schema,
  runId,
  occurredAt,
  PoolClass,
  BlobServiceClientClass,
  DefaultAzureCredentialClass,
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  readMigration = ({ signal } = {}) => readFile(migrationFile, { encoding: 'utf8', signal }),
  exerciseChecks = runPostgresAndBlobChecks,
} = {}) {
  let databaseIdentityValid = false;
  try {
    assertSecurePostgresRuntimeUrl(databaseUrl);
    databaseIdentityValid = true;
  } catch {
    databaseIdentityValid = false;
  }
  if (!SCHEMA.test(String(schema ?? '')) || !BLOB_PREFIX.test(String(blobPrefix ?? ''))
    || !nonEmpty(databaseUrl, 32_768) || !CONTAINER.test(String(blobContainer ?? ''))
    || !databaseIdentityValid
    || !PoolClass || !BlobServiceClientClass || !DefaultAzureCredentialClass
    || deadlineValue(operationDeadlineMs, null) === null
    || typeof readMigration !== 'function' || typeof exerciseChecks !== 'function') {
    throw new Error('Real acceptance runtime configuration is invalid');
  }
  const postgresDeadlineOptions = {
    connectionTimeoutMillis: operationDeadlineMs,
    query_timeout: operationDeadlineMs,
    statement_timeout: operationDeadlineMs,
  };
  const poolOptions = {
    connectionString: databaseUrl,
    options: `-c search_path=${schema} -c statement_timeout=${operationDeadlineMs}`,
    ...postgresDeadlineOptions,
  };
  const rawAdminPool = new PoolClass({
    connectionString: databaseUrl,
    options: `-c statement_timeout=${operationDeadlineMs}`,
    ...postgresDeadlineOptions,
  });
  const rawPoolOne = new PoolClass(poolOptions);
  const rawPoolTwo = new PoolClass(poolOptions);
  let activeSignal = null;
  const getParentSignal = () => activeSignal;
  const adminPool = createBoundedPool(rawAdminPool, { getParentSignal, operationDeadlineMs });
  const poolOne = createBoundedPool(rawPoolOne, { getParentSignal, operationDeadlineMs });
  const poolTwo = createBoundedPool(rawPoolTwo, { getParentSignal, operationDeadlineMs });
  const storeOne = new PostgresStore({ pool: poolOne, ownsPool: false });
  const storeTwo = new PostgresStore({ pool: poolTwo, ownsPool: false });
  const serviceClient = blob.connectionString
    ? BlobServiceClientClass.fromConnectionString(blob.connectionString)
    : new BlobServiceClientClass(blob.accountUrl, new DefaultAzureCredentialClass());
  const containerClient = createBoundedContainerClient(
    serviceClient.getContainerClient(blobContainer),
    { getParentSignal, operationDeadlineMs },
  );
  let schemaOwned = false;
  let blobPrefixOwned = false;

  const prefixObjectCount = async ({ stopAfterFirst = false } = {}) => {
    let count = 0;
    for await (const item of containerClient.listBlobsFlat({ prefix: blobPrefix })) {
      if (typeof item.name !== 'string' || !item.name.startsWith(blobPrefix)) {
        throw new Error('Blob verification escaped its prefix');
      }
      count += 1;
      if (stopAfterFirst) break;
    }
    return count;
  };

  return {
    async runChecks({ signal = null } = {}) {
      activeSignal = signal;
      try {
        const existingSchema = await adminPool.query(
          'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1',
          [schema],
        );
        if (Number(existingSchema.rows[0]?.count) !== 0) {
          throw new Error('Acceptance schema is not fresh');
        }
        if (await prefixObjectCount({ stopAfterFirst: true }) !== 0) {
          throw new Error('Acceptance Blob prefix is not fresh');
        }
        const ownerMarker = containerClient.getBlockBlobClient(`${blobPrefix}.acceptance-owner`);
        await ownerMarker.uploadData(Buffer.from(runId, 'utf8'), {
          blobHTTPHeaders: { blobContentType: 'application/octet-stream' },
          conditions: { ifNoneMatch: '*' },
        });
        blobPrefixOwned = true;
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
        await poolOne.query(migration);
        return await exerciseChecks({
          stores: [storeOne, storeTwo],
          pools: [poolOne, poolTwo],
          containerClient,
          blobPrefix,
          runId,
          occurredAt,
          signal: activeSignal,
        });
      } finally {
        activeSignal = null;
      }
    },
    async cleanupBlobPrefix(prefix, { signal = null } = {}) {
      activeSignal = signal;
      try {
      if (prefix !== blobPrefix || !BLOB_PREFIX.test(prefix)) throw new Error('Blob cleanup scope is invalid');
      if (!blobPrefixOwned) return prefixObjectCount({ stopAfterFirst: true });
      for await (const page of containerClient.listBlobsFlat({ prefix }).byPage({ maxPageSize: 100 })) {
        for (const item of page.segment?.blobItems ?? []) {
          if (typeof item.name !== 'string' || !item.name.startsWith(prefix)) {
            throw new Error('Blob cleanup escaped its prefix');
          }
          await containerClient.getBlockBlobClient(item.name).deleteIfExists();
        }
      }
      const remaining = await prefixObjectCount();
      if (remaining === 0) blobPrefixOwned = false;
      return remaining;
      } finally {
        activeSignal = null;
      }
    },
    async dropSchema(scope, { signal = null } = {}) {
      activeSignal = signal;
      try {
      if (scope !== schema || !SCHEMA.test(scope)) throw new Error('Schema cleanup scope is invalid');
      if (!schemaOwned) {
        const existing = await adminPool.query(
          'SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1',
          [schema],
        );
        return Number(existing.rows[0]?.count) === 0;
      }
      await adminPool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      const result = await adminPool.query('SELECT count(*)::int AS count FROM pg_namespace WHERE nspname = $1', [schema]);
      const absent = Number(result.rows[0]?.count) === 0;
      if (absent) schemaOwned = false;
      return absent;
      } finally {
        activeSignal = null;
      }
    },
    async close({ signal = null } = {}) {
      activeSignal = signal;
      const results = await Promise.allSettled([
        poolOne.end(), poolTwo.end(), adminPool.end(),
      ]);
      activeSignal = null;
      if (results.some(({ status }) => status === 'rejected')) throw new Error('Dependency close failed');
    },
  };
}

async function defaultOpenDependencies(input) {
  const [{ Pool }, { BlobServiceClient }, { DefaultAzureCredential }] = await Promise.all([
    import('pg'),
    import('@azure/storage-blob'),
    import('@azure/identity'),
  ]);
  return createRealAcceptanceRuntime({
    ...input,
    PoolClass: Pool,
    BlobServiceClientClass: BlobServiceClient,
    DefaultAzureCredentialClass: DefaultAzureCredential,
  });
}

function validateConfiguration(environment) {
  const commitSha = environment?.V1_RELEASE_COMMIT_SHA;
  if (!RELEASE_SHA.test(String(commitSha ?? ''))) {
    return { error: 'RELEASE_COMMIT_INVALID' };
  }
  const isolation = validateIsolation(
    environment?.V1_ACCEPTANCE_SCHEMA,
    environment?.V1_ACCEPTANCE_BLOB_PREFIX,
  );
  if (!isolation) return { error: 'ISOLATION_SCOPE_INVALID' };

  const acceptanceBlob = selectBlob(environment, 'V1_ACCEPTANCE_BLOB');
  const intendedBlob = selectBlob(environment, 'V1_BLOB');
  if (!acceptanceBlob || !intendedBlob) {
    return { error: 'RESOURCE_IDENTITY_MISMATCH' };
  }
  const required = [
    environment?.V1_ACCEPTANCE_DATABASE_URL,
    environment?.V1_ACCEPTANCE_BLOB_CONTAINER,
    environment?.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID,
    environment?.V1_ACCEPTANCE_BLOB_RESOURCE_ID,
    environment?.V1_DATABASE_URL,
    environment?.V1_POSTGRES_RESOURCE_ID,
    environment?.V1_BLOB_CONTAINER,
    environment?.V1_BLOB_RESOURCE_ID,
  ];
  const inventoryFile = environment?.V1_LEGACY_RESOURCE_INVENTORY_FILE;
  const inventoryVersion = environment?.V1_LEGACY_RESOURCE_INVENTORY_VERSION;
  if (required.some((value) => !nonEmpty(value, 32_768))
    || !CONTAINER.test(String(environment.V1_ACCEPTANCE_BLOB_CONTAINER ?? ''))
    || !CONTAINER.test(String(environment.V1_BLOB_CONTAINER ?? ''))
    || !validResourceId(
      environment.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID,
      'Microsoft.DBforPostgreSQL',
      'flexibleServers',
    )
    || !validResourceId(
      environment.V1_ACCEPTANCE_BLOB_RESOURCE_ID,
      'Microsoft.Storage',
      'storageAccounts',
    )
    || !validResourceId(
      environment.V1_POSTGRES_RESOURCE_ID,
      'Microsoft.DBforPostgreSQL',
      'flexibleServers',
    )
    || !validResourceId(
      environment.V1_BLOB_RESOURCE_ID,
      'Microsoft.Storage',
      'storageAccounts',
    )) {
    return { error: 'CONFIGURATION_INVALID' };
  }
  if (!isAbsolute(String(inventoryFile ?? ''))
    || !String(inventoryFile).toLowerCase().endsWith('.json')
    || !DIGEST.test(String(inventoryVersion ?? ''))
    || environment?.V1_LEGACY_RESOURCE_INVENTORY_APPROVED !== 'true') {
    return { error: 'LEGACY_INVENTORY_REQUIRED' };
  }

  let acceptancePostgresIdentity;
  let intendedPostgresIdentity;
  let acceptanceBlobIdentity;
  let intendedBlobIdentity;
  try {
    assertSecurePostgresRuntimeUrl(environment.V1_ACCEPTANCE_DATABASE_URL);
    assertSecurePostgresRuntimeUrl(environment.V1_DATABASE_URL);
    acceptancePostgresIdentity = postgresIdentitySha256(environment.V1_ACCEPTANCE_DATABASE_URL);
    intendedPostgresIdentity = postgresIdentitySha256(environment.V1_DATABASE_URL);
    acceptanceBlobIdentity = blobIdentitySha256({
      accountUrl: acceptanceBlob.accountUrl || undefined,
      connectionString: acceptanceBlob.connectionString || undefined,
      container: environment.V1_ACCEPTANCE_BLOB_CONTAINER,
    });
    intendedBlobIdentity = blobIdentitySha256({
      accountUrl: intendedBlob.accountUrl || undefined,
      connectionString: intendedBlob.connectionString || undefined,
      container: environment.V1_BLOB_CONTAINER,
    });
  } catch {
    return { error: 'RESOURCE_IDENTITY_MISMATCH' };
  }
  const exactAccountUrl = acceptanceBlob.mode !== 'account-url'
    || intendedBlob.mode !== 'account-url'
    || acceptanceBlob.accountUrl === intendedBlob.accountUrl;
  if (environment.V1_ACCEPTANCE_DATABASE_URL !== environment.V1_DATABASE_URL
    || environment.V1_ACCEPTANCE_POSTGRES_RESOURCE_ID !== environment.V1_POSTGRES_RESOURCE_ID
    || environment.V1_ACCEPTANCE_BLOB_RESOURCE_ID !== environment.V1_BLOB_RESOURCE_ID
    || environment.V1_ACCEPTANCE_BLOB_CONTAINER !== environment.V1_BLOB_CONTAINER
    || acceptancePostgresIdentity !== intendedPostgresIdentity
    || acceptanceBlobIdentity !== intendedBlobIdentity
    || !exactAccountUrl) {
    return { error: 'RESOURCE_IDENTITY_MISMATCH' };
  }
  if (legacyCompatibilityCollides(environment, intendedPostgresIdentity, intendedBlobIdentity)) {
    return { error: 'LEGACY_COMPATIBILITY_COLLISION' };
  }
  return {
    commitSha,
    ...isolation,
    databaseUrl: environment.V1_ACCEPTANCE_DATABASE_URL,
    blob: acceptanceBlob,
    blobContainer: environment.V1_ACCEPTANCE_BLOB_CONTAINER,
    postgresResourceId: environment.V1_POSTGRES_RESOURCE_ID,
    postgresIdentitySha256: intendedPostgresIdentity,
    blobResourceId: environment.V1_BLOB_RESOURCE_ID,
    blobIdentitySha256: intendedBlobIdentity,
    inventoryFile,
    inventoryVersion,
  };
}

export async function runRealDependencyAcceptance({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = productionRoot,
  artifactDirectory = defaultArtifactDirectory,
  now = () => new Date(),
  readTextFile = (filePath, { signal } = {}) => readFile(filePath, { encoding: 'utf8', signal }),
  inspectGit = defaultInspectGit,
  openDependencies = defaultOpenDependencies,
  writeArtifact = defaultWriteArtifact,
  writeOutput = (line) => process.stdout.write(line),
  operationDeadlineMs = DEFAULT_OPERATION_DEADLINE_MS,
  commandDeadlineMs = DEFAULT_COMMAND_DEADLINE_MS,
  cleanupDeadlineMs = DEFAULT_CLEANUP_DEADLINE_MS,
  cleanupOperationDeadlineMs = DEFAULT_CLEANUP_OPERATION_DEADLINE_MS,
} = {}) {
  if (!Array.isArray(argv) || argv.length !== 0) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'EXACT_INVOCATION_REQUIRED' });
  }
  if (environment?.V1_ACCEPTANCE_CONFIRM_EPHEMERAL !== 'true') {
    return publish(writeOutput, 2, { status: 'not-run', code: 'EPHEMERAL_CONFIRMATION_REQUIRED' });
  }
  const config = validateConfiguration(environment);
  if (config.error) {
    return publish(writeOutput, 2, { status: 'not-run', code: config.error });
  }
  operationDeadlineMs = deadlineValue(operationDeadlineMs, DEFAULT_OPERATION_DEADLINE_MS);
  commandDeadlineMs = deadlineValue(commandDeadlineMs, DEFAULT_COMMAND_DEADLINE_MS);
  cleanupDeadlineMs = deadlineValue(cleanupDeadlineMs, DEFAULT_CLEANUP_DEADLINE_MS);
  cleanupOperationDeadlineMs = deadlineValue(
    cleanupOperationDeadlineMs,
    DEFAULT_CLEANUP_OPERATION_DEADLINE_MS,
  );
  if (!isAbsolute(String(cwd ?? '')) || !isAbsolute(String(artifactDirectory ?? ''))
    || typeof readTextFile !== 'function' || typeof inspectGit !== 'function'
    || typeof openDependencies !== 'function' || typeof writeArtifact !== 'function'
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
    || inventoryContains(inventory, config.blobResourceId, config.blobIdentitySha256, 'blobResources')) {
    commandBudget.dispose();
    return publish(writeOutput, 2, { status: 'not-run', code: 'LEGACY_INVENTORY_INVALID' });
  }

  let gitState;
  try {
    gitState = await mainOperation((signal) => inspectGit(cwd, { signal }));
  } catch {
    gitState = null;
  }
  if (!gitState || gitState.head !== config.commitSha || gitState.clean !== true) {
    const timedOut = commandBudget.signal.aborted;
    commandBudget.dispose();
    return publish(writeOutput, timedOut ? 1 : 2, {
      status: timedOut ? 'failed' : 'not-run',
      code: timedOut ? 'DEPENDENCY_COMMAND_DEADLINE_EXCEEDED' : 'RELEASE_GIT_STATE_INVALID',
    });
  }

  let runtime = null;
  let checks = [];
  let functionalSuccess = false;
  const cleanup = {
    blobPrefixObjectCount: null,
    schemaAbsent: false,
    closed: false,
  };
  try {
    runtime = await mainOperation((signal) => openDependencies({
      databaseUrl: config.databaseUrl,
      blob: config.blob,
      blobContainer: config.blobContainer,
      blobPrefix: config.blobPrefix,
      schema: config.schema,
      runId: config.runId,
      occurredAt: currentTime.toISOString(),
      operationDeadlineMs,
      signal,
    }));
    if (!runtime || typeof runtime.runChecks !== 'function'
      || typeof runtime.cleanupBlobPrefix !== 'function'
      || typeof runtime.dropSchema !== 'function'
      || typeof runtime.close !== 'function') throw new Error('Invalid acceptance runtime');
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
        cleanup.blobPrefixObjectCount = await cleanupOperation(
          (signal) => runtime.cleanupBlobPrefix(config.blobPrefix, { signal }),
        );
        if (!Number.isSafeInteger(cleanup.blobPrefixObjectCount) || cleanup.blobPrefixObjectCount < 0) {
          cleanup.blobPrefixObjectCount = null;
        }
      } catch {
        cleanup.blobPrefixObjectCount = null;
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

  const cleanupSuccess = functionalSuccess
    && cleanup.blobPrefixObjectCount === 0
    && cleanup.schemaAbsent === true
    && cleanup.closed === true;
  let finalGitValid = false;
  if (cleanupSuccess) {
    let finalGitState;
    try {
      finalGitState = await withDeadline((signal) => inspectGit(cwd, { signal }), {
        timeoutMs: operationDeadlineMs,
        code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED',
      });
    } catch {
      finalGitState = null;
    }
    finalGitValid = Boolean(finalGitState
      && finalGitState.head === config.commitSha
      && finalGitState.clean === true);
  }
  const result = cleanupSuccess && finalGitValid;
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: config.commitSha,
    legacyInventoryDigest: inventory.artifactSha256,
    postgresResourceId: config.postgresResourceId,
    postgresIdentitySha256: config.postgresIdentitySha256,
    blobResourceId: config.blobResourceId,
    blobIdentitySha256: config.blobIdentitySha256,
    schema: config.schema,
    blobPrefix: config.blobPrefix,
    checks: result ? safeChecks(checks) : safeFailureChecks(checks, cleanup),
    schemaAbsent: cleanup.schemaAbsent,
    blobPrefixObjectCount: cleanup.blobPrefixObjectCount,
    result,
    occurredAt: currentTime.toISOString(),
  });
  const filePath = join(artifactDirectory, `${config.runId}.json`);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await withDeadline(
      (signal) => writeArtifact({ filePath, contents, record }, { signal }),
      { timeoutMs: operationDeadlineMs, code: 'DEPENDENCY_OPERATION_DEADLINE_EXCEEDED' },
    );
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'ACCEPTANCE_ARTIFACT_WRITE_FAILED' });
  }
  if (!result) {
    return publish(writeOutput, 1, {
      status: 'failed',
      code: 'DEPENDENCY_ACCEPTANCE_FAILED',
      artifactSha256: record.artifactSha256,
      checks: record.checks,
      cleanup: {
        schemaAbsent: record.schemaAbsent,
        blobPrefixObjectCount: record.blobPrefixObjectCount,
      },
    });
  }
  return publish(writeOutput, 0, {
    status: 'recorded',
    code: 'DEPENDENCY_ACCEPTANCE_RECORDED',
    artifactSha256: record.artifactSha256,
    checks: record.checks,
    cleanup: {
      schemaAbsent: record.schemaAbsent,
      blobPrefixObjectCount: record.blobPrefixObjectCount,
    },
  });
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const result = await runRealDependencyAcceptance();
  process.exitCode = result.exitCode;
}
