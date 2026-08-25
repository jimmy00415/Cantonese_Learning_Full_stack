export const VOICE_OPERATION_TTL_MS = 60 * 60 * 1_000;
export const VOICE_LEASE_MS = 15_000;

const DATABASE_NAME = 'hk-buddy-production-v1';
const DATABASE_VERSION = 2;
const STORE_NAME = 'voice_upload_operations';
const METADATA_STORE_NAME = 'voice_upload_metadata';
const ACTIVE_SCOPE_KEY = 'active_scope';
const SCOPE_INDEX = 'clientSessionScope';
const EXPIRES_INDEX = 'expiresAt';
const REPLY_LANGUAGES = new Set(['en', 'yue-Hant-HK', 'cmn-Hans-CN']);
const REPLY_MODES = new Set(['text', 'voice']);

const TRANSITION_FIELDS = new Set([
  'state',
  'postAuthorized',
  'serverState',
  'nextActionAt',
  'retryAfterAt',
  'networkFailureCount',
  'failureCode',
  'retryable',
]);

const RESULT_FIELDS = new Set([
  ...TRANSITION_FIELDS,
  'transcript',
  'voiceDraftId',
]);

function requireString(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function requireTime(value, name = 'nowMs') {
  if (!Number.isFinite(value)) throw new TypeError(`${name} must be a finite timestamp`);
  return value;
}

function scopeFencedError() {
  const error = new Error('This tab no longer owns the active voice-message scope.');
  error.code = 'VOICE_SCOPE_FENCED';
  return error;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => {
      // A request error normally aborts the transaction; onabort owns rejection.
    };
  });
}

function bytesToLowerHex(buffer) {
  return [...new Uint8Array(buffer)]
    .map((value) => value.toString(16).padStart(2, '0'))
    .join('');
}

function clearLease(operation, { bumpGeneration = false } = {}) {
  return {
    ...operation,
    leaseOwnerId: null,
    leaseToken: null,
    leaseGeneration: operation.leaseGeneration + (bumpGeneration ? 1 : 0),
    leaseExpiresAt: 0,
  };
}

function clearSensitive(operation) {
  return {
    ...operation,
    blob: null,
    transcript: null,
    voiceDraftId: null,
    messageBinding: null,
  };
}

function supersede(operation, at) {
  return {
    ...clearSensitive(clearLease(operation, { bumpGeneration: true })),
    state: 'cancel_pending',
    postAuthorized: false,
    serverState: null,
    nextActionAt: at,
    retryAfterAt: null,
    failureCode: null,
    retryable: false,
    updatedAt: at,
    revision: operation.revision + 1,
  };
}

function isUnfinished(operation) {
  if (operation.state === 'terminal' || operation.state === 'cancel_pending') return false;
  return operation.state !== 'ready' || operation.messageBinding === null;
}

function applyAllowedPatch(operation, patch, allowedFields) {
  const next = { ...operation };
  for (const [key, value] of Object.entries(patch ?? {})) {
    if (!allowedFields.has(key)) throw new TypeError(`Voice operation field cannot be changed: ${key}`);
    next[key] = value;
  }
  return next;
}

function validLease(operation, {
  clientSessionScope,
  scopeGeneration,
  workerId,
  leaseToken,
  leaseGeneration,
  nowMs,
}) {
  return operation
    && operation.clientSessionScope === clientSessionScope
    && operation.scopeGeneration === scopeGeneration
    && operation.leaseOwnerId === workerId
    && operation.leaseToken === leaseToken
    && operation.leaseGeneration === leaseGeneration
    && operation.leaseExpiresAt > nowMs
    && (operation.expiresAt > nowMs || operation.state === 'cancel_pending');
}

function claimable(operation, binding, at) {
  if (!operation
    || operation.clientSessionScope !== binding.clientSessionScope
    || operation.scopeGeneration !== binding.scopeGeneration) return false;
  const cleanupOnly = operation.state === 'cancel_pending';
  return !(!cleanupOnly && operation.expiresAt <= at)
    && operation.state !== 'terminal'
    && operation.state !== 'ready'
    && !(operation.state === 'retryable' && operation.postAuthorized !== true)
    && operation.nextActionAt <= at
    && operation.leaseExpiresAt <= at;
}

function claimPriority(left, right) {
  const leftCleanup = left.state === 'cancel_pending' ? 0 : 1;
  const rightCleanup = right.state === 'cancel_pending' ? 0 : 1;
  return leftCleanup - rightCleanup
    || left.nextActionAt - right.nextActionAt
    || left.createdAt - right.createdAt
    || left.clientUploadId.localeCompare(right.clientUploadId);
}

export function createVoiceUploadStore({
  databaseName = DATABASE_NAME,
  indexedDBImpl = globalThis.indexedDB,
  cryptoImpl = globalThis.crypto,
  uuid = () => cryptoImpl.randomUUID(),
  now = () => Date.now(),
} = {}) {
  if (!indexedDBImpl?.open) throw new Error('IndexedDB is required for durable voice messages.');
  if (!cryptoImpl?.subtle?.digest) throw new Error('WebCrypto is required for durable voice messages.');
  if (typeof uuid !== 'function') throw new TypeError('uuid must be a function');
  if (typeof now !== 'function') throw new TypeError('now must be a function');

  let databasePromise = null;
  let boundScope = null;
  let boundScopeGeneration = null;
  let instanceEpoch = 0;
  const activeTransactions = new Set();

  function localBinding(clientSessionScope) {
    if (boundScope !== clientSessionScope || !Number.isSafeInteger(boundScopeGeneration)) return null;
    return {
      clientSessionScope: boundScope,
      scopeGeneration: boundScopeGeneration,
      instanceEpoch,
    };
  }

  function requireLocalBinding(clientSessionScope) {
    const binding = localBinding(clientSessionScope);
    if (!binding) throw scopeFencedError();
    return binding;
  }

  function metadataMatches(metadata, binding) {
    return binding != null
      && metadata?.key === ACTIVE_SCOPE_KEY
      && metadata.clientSessionScope === binding.clientSessionScope
      && metadata.scopeGeneration === binding.scopeGeneration;
  }

  function bindingStillCurrent(binding) {
    return binding?.instanceEpoch === instanceEpoch
      && binding.clientSessionScope === boundScope
      && binding.scopeGeneration === boundScopeGeneration;
  }

  function expectedMetadata(value) {
    if (value == null) return null;
    if (!Number.isSafeInteger(value.scopeGeneration) || value.scopeGeneration < 1) {
      throw new TypeError('expectedActiveScope.scopeGeneration must be a positive integer');
    }
    return {
      key: ACTIVE_SCOPE_KEY,
      clientSessionScope: requireString(value.clientSessionScope, 'expectedActiveScope.clientSessionScope'),
      scopeGeneration: value.scopeGeneration,
    };
  }

  function openDatabase() {
    if (databasePromise) return databasePromise;
    databasePromise = new Promise((resolve, reject) => {
      const request = indexedDBImpl.open(databaseName, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: 'clientUploadId' });
        if (!store.indexNames.contains(SCOPE_INDEX)) {
          store.createIndex(SCOPE_INDEX, 'clientSessionScope', { unique: false });
        }
        if (!store.indexNames.contains(EXPIRES_INDEX)) {
          store.createIndex(EXPIRES_INDEX, 'expiresAt', { unique: false });
        }
        if (!database.objectStoreNames.contains(METADATA_STORE_NAME)) {
          database.createObjectStore(METADATA_STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          instanceEpoch += 1;
          for (const transaction of activeTransactions) {
            try { transaction.abort(); } catch { /* transaction already settled */ }
          }
          database.close();
          databasePromise = null;
          boundScope = null;
          boundScopeGeneration = null;
        };
        resolve(database);
      };
      request.onerror = () => {
        databasePromise = null;
        reject(request.error ?? new Error('Could not open the voice message store.'));
      };
      request.onblocked = () => {
        databasePromise = null;
        reject(new Error('The voice message store upgrade is blocked.'));
      };
    });
    return databasePromise;
  }

  async function transact(mode, callback, { metadata = false } = {}) {
    const database = await openDatabase();
    const transaction = database.transaction(
      metadata ? [STORE_NAME, METADATA_STORE_NAME] : STORE_NAME,
      mode,
    );
    const complete = transactionComplete(transaction);
    activeTransactions.add(transaction);
    const store = transaction.objectStore(STORE_NAME);
    const metadataStore = metadata ? transaction.objectStore(METADATA_STORE_NAME) : null;
    try {
      let result;
      try {
        result = await callback(store, transaction, metadataStore);
      } catch (error) {
        try { transaction.abort(); } catch { /* transaction already settled */ }
        await complete.catch(() => undefined);
        throw error;
      }
      await complete;
      return result;
    } finally {
      activeTransactions.delete(transaction);
    }
  }

  async function commitRecording({ clientSessionScope, audio, durationMs, asrLanguage }) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const binding = requireLocalBinding(scope);
    if (!(audio instanceof Blob) || audio.type !== 'audio/wav') {
      throw new TypeError('audio must be a canonical audio/wav Blob');
    }
    if (!Number.isFinite(durationMs) || durationMs < 0) throw new TypeError('durationMs must be non-negative');
    if (asrLanguage !== undefined && !['en', 'zhHant', 'zhHans'].includes(asrLanguage)) {
      throw new TypeError('asrLanguage must be en, zhHant, or zhHans');
    }

    const createdAt = requireTime(now(), 'createdAt');
    const clientUploadId = requireString(uuid(), 'clientUploadId');
    const audioBytes = await audio.arrayBuffer();
    const requestSha256 = bytesToLowerHex(await cryptoImpl.subtle.digest('SHA-256', audioBytes));
    if (!bindingStillCurrent(binding)) throw scopeFencedError();
    const operation = {
      schemaVersion: asrLanguage === undefined ? 1 : 2,
      clientUploadId,
      clientSessionScope: scope,
      scopeGeneration: binding.scopeGeneration,
      requestSha256,
      mimeType: 'audio/wav',
      byteLength: audio.size,
      durationMs,
      ...(asrLanguage === undefined ? {} : { asrLanguage }),
      blob: audio,
      state: 'queued',
      postAuthorized: true,
      serverState: null,
      nextActionAt: createdAt,
      retryAfterAt: null,
      networkFailureCount: 0,
      transcript: null,
      voiceDraftId: null,
      failureCode: null,
      retryable: false,
      messageBinding: null,
      createdAt,
      updatedAt: createdAt,
      expiresAt: createdAt + VOICE_OPERATION_TTL_MS,
      revision: 1,
      leaseOwnerId: null,
      leaseToken: null,
      leaseGeneration: 0,
      leaseExpiresAt: 0,
    };

    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) throw scopeFencedError();
      const existing = await requestResult(store.index(SCOPE_INDEX).getAll(scope));
      for (const previous of existing) {
        if (previous.scopeGeneration !== binding.scopeGeneration) {
          store.delete(previous.clientUploadId);
        } else if (isUnfinished(previous)) {
          store.put(supersede(previous, createdAt));
        }
      }
      store.add(operation);
      return operation;
    }, { metadata: true });
  }

  function get(clientUploadId) {
    const id = requireString(clientUploadId, 'clientUploadId');
    return transact('readonly', (store) => requestResult(store.get(id)));
  }

  async function listByScope(clientSessionScope) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const operations = await transact('readonly', (store) => requestResult(store.index(SCOPE_INDEX).getAll(scope)));
    return operations.sort((left, right) => left.createdAt - right.createdAt
      || left.clientUploadId.localeCompare(right.clientUploadId));
  }

  async function claimById({
    clientUploadId,
    clientSessionScope,
    workerId,
    nowMs = now(),
  }) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const owner = requireString(workerId, 'workerId');
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return null;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return null;
      const operation = await requestResult(store.get(id));
      if (!claimable(operation, binding, at)) return null;

      const leaseGeneration = operation.leaseGeneration + 1;
      const leaseToken = requireString(uuid(), 'leaseToken');
      const cleanupOnly = operation.state === 'cancel_pending';
      const leaseExpiresAt = cleanupOnly && operation.expiresAt <= at
        ? at + VOICE_LEASE_MS
        : Math.min(at + VOICE_LEASE_MS, operation.expiresAt);
      const claimed = {
        ...operation,
        leaseOwnerId: owner,
        leaseToken,
        leaseGeneration,
        leaseExpiresAt,
        updatedAt: at,
        revision: operation.revision + 1,
      };
      store.put(claimed);
      return claimed;
    }, { metadata: true });
  }

  async function claimNext({ clientSessionScope, workerId, nowMs = now() }) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const owner = requireString(workerId, 'workerId');
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return null;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return null;
      const operations = await requestResult(store.index(SCOPE_INDEX).getAll(scope));
      const operation = operations.filter((candidate) => claimable(candidate, binding, at)).sort(claimPriority)[0];
      if (!operation) return null;
      const cleanupOnly = operation.state === 'cancel_pending';
      const claimed = {
        ...operation,
        leaseOwnerId: owner,
        leaseToken: requireString(uuid(), 'leaseToken'),
        leaseGeneration: operation.leaseGeneration + 1,
        leaseExpiresAt: cleanupOnly && operation.expiresAt <= at
          ? at + VOICE_LEASE_MS
          : Math.min(at + VOICE_LEASE_MS, operation.expiresAt),
        updatedAt: at,
        revision: operation.revision + 1,
      };
      store.put(claimed);
      return claimed;
    }, { metadata: true });
  }

  async function writeWithLease({
    clientUploadId,
    clientSessionScope,
    workerId,
    leaseToken,
    leaseGeneration,
    nowMs = now(),
    patch,
  }, allowedFields) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const owner = requireString(workerId, 'workerId');
    const token = requireString(leaseToken, 'leaseToken');
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return false;
    if (!Number.isSafeInteger(leaseGeneration) || leaseGeneration < 1) {
      throw new TypeError('leaseGeneration must be a positive integer');
    }
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!validLease(operation, {
        clientSessionScope: scope,
        scopeGeneration: binding.scopeGeneration,
        workerId: owner,
        leaseToken: token,
        leaseGeneration,
        nowMs: at,
      })) return false;

      let updated = applyAllowedPatch(operation, patch, allowedFields);
      updated.updatedAt = at;
      updated.revision = operation.revision + 1;
      if (updated.state === 'ready') {
        updated = clearLease({ ...updated, blob: null });
      } else if (updated.state === 'terminal') {
        updated = clearSensitive(clearLease(updated));
      }
      store.put(updated);
      return updated;
    }, { metadata: true });
  }

  function transition(options) {
    return writeWithLease(options, TRANSITION_FIELDS);
  }

  function writeResult(options) {
    return writeWithLease(options, RESULT_FIELDS);
  }

  async function renewLease({
    clientUploadId,
    clientSessionScope,
    workerId,
    leaseToken,
    leaseGeneration,
    nowMs = now(),
  }) {
    const at = requireTime(nowMs);
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const owner = requireString(workerId, 'workerId');
    const token = requireString(leaseToken, 'leaseToken');
    const binding = localBinding(scope);
    if (!binding) return false;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!validLease(operation, {
        clientSessionScope: scope,
        scopeGeneration: binding.scopeGeneration,
        workerId: owner,
        leaseToken: token,
        leaseGeneration,
        nowMs: at,
      })) return false;
      const cleanupOnly = operation.state === 'cancel_pending' && operation.expiresAt <= at;
      const renewed = {
        ...operation,
        leaseExpiresAt: cleanupOnly ? at + VOICE_LEASE_MS : Math.min(at + VOICE_LEASE_MS, operation.expiresAt),
        updatedAt: at,
        revision: operation.revision + 1,
      };
      store.put(renewed);
      return renewed;
    }, { metadata: true });
  }

  async function cancel({ clientUploadId, clientSessionScope, nowMs = now() }) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return false;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!operation
        || operation.clientSessionScope !== scope
        || operation.scopeGeneration !== binding.scopeGeneration
        || operation.messageBinding !== null) return false;
      const cancelled = supersede(operation, at);
      store.put(cancelled);
      return cancelled;
    }, { metadata: true });
  }

  async function clearScope(clientSessionScope) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const binding = requireLocalBinding(scope);
    const count = await transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) throw scopeFencedError();
      const operations = await requestResult(store.index(SCOPE_INDEX).getAll(scope));
      for (const operation of operations) store.delete(operation.clientUploadId);
      metadataStore.put({
        ...metadata,
        scopeGeneration: metadata.scopeGeneration + 1,
        updatedAt: requireTime(now(), 'updatedAt'),
      });
      return operations.length;
    }, { metadata: true });
    if (boundScope === scope && boundScopeGeneration === binding.scopeGeneration) {
      boundScope = null;
      boundScopeGeneration = null;
    }
    return count;
  }

  async function bindScope(clientSessionScope, { nowMs = now(), expectedActiveScope = null } = {}) {
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const at = requireTime(nowMs);
    const callerBinding = boundScope ? localBinding(boundScope) : null;
    const expected = expectedMetadata(expectedActiveScope);
    const bindEpoch = instanceEpoch;
    const outcome = await transact('readwrite', async (store, _transaction, metadataStore) => {
      if (instanceEpoch !== bindEpoch) throw scopeFencedError();
      const previousMetadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (instanceEpoch !== bindEpoch) throw scopeFencedError();
      if (callerBinding
        && (!bindingStillCurrent(callerBinding) || !metadataMatches(previousMetadata, callerBinding))) {
        throw scopeFencedError();
      }
      if (previousMetadata
        && !callerBinding
        && !metadataMatches(previousMetadata, expected)) {
        throw scopeFencedError();
      }
      const scopeGeneration = previousMetadata?.clientSessionScope === scope
        ? previousMetadata.scopeGeneration
        : (Number.isSafeInteger(previousMetadata?.scopeGeneration) ? previousMetadata.scopeGeneration + 1 : 1);
      const activeMetadata = {
        key: ACTIVE_SCOPE_KEY,
        clientSessionScope: scope,
        scopeGeneration,
        updatedAt: at,
      };
      metadataStore.put(activeMetadata);
      const operations = await requestResult(store.getAll());
      let purged = 0;
      let expired = 0;
      for (const operation of operations) {
        if (operation.clientSessionScope !== scope || operation.scopeGeneration !== scopeGeneration) {
          store.delete(operation.clientUploadId);
          purged += 1;
        } else if (operation.expiresAt <= at) {
          if (operation.state === 'terminal') {
            store.delete(operation.clientUploadId);
            purged += 1;
          } else if (operation.state !== 'cancel_pending') {
            store.put(supersede(operation, at));
            expired += 1;
          }
        }
      }
      return { purged, expired, scopeGeneration };
    }, { metadata: true });
    if (instanceEpoch !== bindEpoch) throw scopeFencedError();
    boundScope = scope;
    boundScopeGeneration = outcome.scopeGeneration;
    return { purged: outcome.purged, expired: outcome.expired };
  }

  async function readActiveScope() {
    const metadata = await transact(
      'readonly',
      (_store, _transaction, metadataStore) => requestResult(metadataStore.get(ACTIVE_SCOPE_KEY)),
      { metadata: true },
    );
    return metadata
      ? {
          clientSessionScope: metadata.clientSessionScope,
          scopeGeneration: metadata.scopeGeneration,
        }
      : null;
  }

  async function consume({ clientUploadId, clientSessionScope }) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const binding = localBinding(scope);
    if (!binding) return false;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!operation
        || operation.clientSessionScope !== scope
        || operation.scopeGeneration !== binding.scopeGeneration) return false;
      store.delete(id);
      return true;
    }, { metadata: true });
  }

  async function bindMessage({
    clientUploadId,
    clientSessionScope,
    voiceDraftId,
    clientMessageId,
    text,
    replyLanguage = 'en',
    replyMode = 'text',
    nowMs = now(),
  }) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const draftId = requireString(voiceDraftId, 'voiceDraftId');
    const messageId = requireString(clientMessageId, 'clientMessageId');
    if (typeof text !== 'string' || !text.trim() || text.length > 4_000) {
      throw new TypeError('text must contain between 1 and 4000 characters');
    }
    if (!REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) {
      throw new TypeError('reply preferences are invalid');
    }
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return false;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!operation
        || operation.clientSessionScope !== scope
        || operation.scopeGeneration !== binding.scopeGeneration
        || operation.state !== 'ready'
        || operation.voiceDraftId !== draftId
        || operation.expiresAt <= at) return false;
      const messageBinding = { clientMessageId: messageId, text, replyLanguage, replyMode };
      if (operation.messageBinding) {
        return operation.messageBinding.clientMessageId === messageId
          && operation.messageBinding.text === text
          && (operation.messageBinding.replyLanguage ?? 'en') === replyLanguage
          && (operation.messageBinding.replyMode ?? 'text') === replyMode
          ? operation
          : false;
      }
      const bound = {
        ...operation,
        messageBinding,
        updatedAt: at,
        revision: operation.revision + 1,
      };
      store.put(bound);
      return bound;
    }, { metadata: true });
  }

  async function releaseMessageBinding({
    clientUploadId,
    clientSessionScope,
    voiceDraftId,
    clientMessageId,
    text,
    replyLanguage = 'en',
    replyMode = 'text',
    nowMs = now(),
  }) {
    const id = requireString(clientUploadId, 'clientUploadId');
    const scope = requireString(clientSessionScope, 'clientSessionScope');
    const draftId = requireString(voiceDraftId, 'voiceDraftId');
    const messageId = requireString(clientMessageId, 'clientMessageId');
    if (typeof text !== 'string' || !text.trim() || text.length > 4_000) {
      throw new TypeError('text must contain between 1 and 4000 characters');
    }
    if (!REPLY_LANGUAGES.has(replyLanguage) || !REPLY_MODES.has(replyMode)) {
      throw new TypeError('reply preferences are invalid');
    }
    const at = requireTime(nowMs);
    const binding = localBinding(scope);
    if (!binding) return false;
    return transact('readwrite', async (store, _transaction, metadataStore) => {
      const metadata = await requestResult(metadataStore.get(ACTIVE_SCOPE_KEY));
      if (!bindingStillCurrent(binding) || !metadataMatches(metadata, binding)) return false;
      const operation = await requestResult(store.get(id));
      if (!operation
        || operation.clientSessionScope !== scope
        || operation.scopeGeneration !== binding.scopeGeneration
        || operation.state !== 'ready'
        || operation.voiceDraftId !== draftId
        || operation.messageBinding?.clientMessageId !== messageId
        || operation.messageBinding?.text !== text
        || (operation.messageBinding?.replyLanguage ?? 'en') !== replyLanguage
        || (operation.messageBinding?.replyMode ?? 'text') !== replyMode) return false;
      const released = {
        ...operation,
        messageBinding: null,
        updatedAt: at,
        revision: operation.revision + 1,
      };
      store.put(released);
      return released;
    }, { metadata: true });
  }

  async function dispose() {
    instanceEpoch += 1;
    boundScope = null;
    boundScopeGeneration = null;
    for (const transaction of activeTransactions) {
      try { transaction.abort(); } catch { /* transaction already settled */ }
    }
    const database = await databasePromise?.catch(() => null);
    database?.close();
    databasePromise = null;
  }

  return {
    bindMessage,
    bindScope,
    cancel,
    claimById,
    claimNext,
    clearScope,
    commitRecording,
    consume,
    dispose,
    get,
    listByScope,
    readActiveScope,
    releaseMessageBinding,
    renewLease,
    transition,
    writeResult,
  };
}
