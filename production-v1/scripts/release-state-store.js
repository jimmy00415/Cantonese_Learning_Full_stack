import { createHash, randomUUID } from 'node:crypto';
import {
  link, lstat, mkdir, open, readFile, readdir, realpath, rename, unlink,
} from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';

import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';

const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const OPERATION_ATTEMPT_ID = /^[0-9a-f]{32}$/;
const OPERATION_ID = /^[a-z][A-Za-z0-9:-]{0,127}$/;
const HOST = /^[^\u0000-\u001f\u007f/\\]{1,255}$/u;
const PHASES = new Set([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence',
  'candidate', 'readiness', 'workload', 'mobile', 'candidate-cleanup',
  'promote', 'rollback',
]);
const RECONCILE_KINDS = new Set([
  'cloud-build-submit',
  'cloud-run-job-replace',
  'cloud-run-job-execute',
  'cloud-run-service-replace',
  'cloud-run-service-iam',
  'cloud-run-traffic',
  'cloud-run-service-delete',
  'secret-version-add',
  'gcs-object-write',
  'gcs-object-delete',
]);
const CHECKPOINT_OUTCOMES = new Set([
  'applied', 'adopted-response-loss', 'adopted-restart', 'verified-noop',
]);
const TERMINAL_STATUSES = new Set(['phase-complete', 'phase-blocked']);
const RECORD_TYPES = new Set(['intent', 'checkpoint', 'terminal']);
const JOURNAL_NAME = /^(\d{8})-(intent|checkpoint|terminal)\.json$/;
const TEMP_NAME = /^(\d{8}-(?:intent|checkpoint|terminal)\.json)\.tmp-([0-9a-f]{32})$/;
const COMMON_KEYS = [
  'attemptId', 'createdAt', 'generation', 'operationId', 'payload', 'phase',
  'phasePlanSha256', 'previousRecordSha256', 'receiptHeadSha256', 'recordSha256',
  'recordType', 'releaseIdentitySha256', 'releaseSha', 'schemaVersion',
];

function fail(message = 'Release journal is invalid') {
  throw new Error(message);
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('Canonical journal value is invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) fail('Canonical journal value is invalid');
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    if (value[key] === undefined) fail('Canonical journal value is invalid');
    return [key, canonicalize(value[key])];
  }));
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactKeys(value, expected) {
  return isPlainObject(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0');
}

function canonicalIso(value) {
  if (typeof value !== 'string') return false;
  try { return new Date(value).toISOString() === value; } catch { return false; }
}

function assertSafeResult(value) {
  if (!isPlainObject(value) || typeof value.kind !== 'string') fail();
  if (value.kind === 'none') {
    if (!exactKeys(value, ['kind'])) fail();
    return;
  }
  if (value.kind === 'resource') {
    if (!exactKeys(value, ['identitySha256', 'kind', 'state', 'valueSha256'])
      || !['present', 'absent'].includes(value.state)
      || !DIGEST.test(String(value.identitySha256 ?? ''))
      || !DIGEST.test(String(value.valueSha256 ?? ''))) fail();
    return;
  }
  if (value.kind === 'build') {
    if (!exactKeys(value, ['buildId', 'kind', 'receiptSha256'])
      || !UUID_V4.test(String(value.buildId ?? ''))
      || !DIGEST.test(String(value.receiptSha256 ?? ''))) fail();
    return;
  }
  if (value.kind === 'execution') {
    if (!exactKeys(value, ['kind', 'name', 'status'])
      || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 512
      || !['SUCCEEDED', 'FAILED', 'RUNNING'].includes(value.status)) fail();
    return;
  }
  if (value.kind === 'secret-version') {
    if (!exactKeys(value, ['kind', 'name', 'version'])
      || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255
      || !/^[1-9][0-9]*$/.test(String(value.version ?? ''))) fail();
    return;
  }
  if (value.kind === 'object') {
    if (!exactKeys(value, [
      'bucketSha256', 'generation', 'kind', 'objectSha256', 'valueSha256',
    ])
      || !DIGEST.test(String(value.bucketSha256 ?? ''))
      || !DIGEST.test(String(value.objectSha256 ?? ''))
      || !DIGEST.test(String(value.valueSha256 ?? ''))
      || !/^[1-9][0-9]*$/.test(String(value.generation ?? ''))) fail();
    return;
  }
  fail();
}

function assertIntentPayload(payload) {
  if (!exactKeys(payload, [
    'afterSha256', 'beforeSha256', 'commandSha256', 'mutationOrdinal',
    'operationAttemptId', 'reconcileKind',
  ])
    || !Number.isSafeInteger(payload.mutationOrdinal) || payload.mutationOrdinal < 1
    || !OPERATION_ATTEMPT_ID.test(String(payload.operationAttemptId ?? ''))
    || !DIGEST.test(String(payload.commandSha256 ?? ''))
    || !RECONCILE_KINDS.has(payload.reconcileKind)
    || !DIGEST.test(String(payload.beforeSha256 ?? ''))
    || !DIGEST.test(String(payload.afterSha256 ?? ''))) fail();
}

function assertCheckpointPayload(payload) {
  if (!exactKeys(payload, [
    'classification', 'intentRecordSha256', 'observationSha256', 'outcome', 'safeResult',
  ])
    || !DIGEST.test(String(payload.intentRecordSha256 ?? ''))
    || payload.classification !== 'after'
    || !CHECKPOINT_OUTCOMES.has(payload.outcome)
    || !DIGEST.test(String(payload.observationSha256 ?? ''))) fail();
  assertSafeResult(payload.safeResult);
}

function assertTerminalState(value) {
  if (!isPlainObject(value) || Object.keys(value).length < 1
    || Buffer.byteLength(canonicalJson(value)) > 32 * 1024
    || containsForbiddenPersistedSecret(value)) fail();
}

function assertTerminalPayload(payload) {
  if (!exactKeys(payload, [
    'checkpointRecordSha256', 'mutationCount', 'receiptSha256',
    'responseLossOperationIds', 'status', 'terminalState', 'terminalStateSha256',
  ])
    || !TERMINAL_STATUSES.has(payload.status)
    || !DIGEST.test(String(payload.checkpointRecordSha256 ?? ''))
    || !DIGEST.test(String(payload.receiptSha256 ?? ''))
    || !DIGEST.test(String(payload.terminalStateSha256 ?? ''))
    || !Number.isSafeInteger(payload.mutationCount) || payload.mutationCount < 0
    || !Array.isArray(payload.responseLossOperationIds)
    || payload.responseLossOperationIds.some((value) => !OPERATION_ID.test(String(value ?? '')))
    || new Set(payload.responseLossOperationIds).size !== payload.responseLossOperationIds.length) fail();
  assertTerminalState(payload.terminalState);
  if (sha256(canonicalJson(payload.terminalState)) !== payload.terminalStateSha256) fail();
}

function recordHash(record) {
  const unsigned = { ...record };
  delete unsigned.recordSha256;
  return sha256(canonicalJson(unsigned));
}

function assertRecordShape(record) {
  if (!exactKeys(record, COMMON_KEYS)
    || record.schemaVersion !== 1
    || !RECORD_TYPES.has(record.recordType)
    || !Number.isSafeInteger(record.generation) || record.generation < 1 || record.generation > 99_999_999
    || !RELEASE_SHA.test(String(record.releaseSha ?? ''))
    || !DIGEST.test(String(record.releaseIdentitySha256 ?? ''))
    || !PHASES.has(record.phase)
    || !DIGEST.test(String(record.phasePlanSha256 ?? ''))
    || !UUID_V4.test(String(record.attemptId ?? ''))
    || ![null, true].includes(record.operationId === null ? null : OPERATION_ID.test(String(record.operationId ?? '')))
    || ![null, true].includes(record.receiptHeadSha256 === null ? null : DIGEST.test(String(record.receiptHeadSha256 ?? '')))
    || ![null, true].includes(record.previousRecordSha256 === null ? null : DIGEST.test(String(record.previousRecordSha256 ?? '')))
    || !canonicalIso(record.createdAt)
    || !DIGEST.test(String(record.recordSha256 ?? ''))
    || containsForbiddenPersistedSecret(record)) fail();
  if (record.recordType === 'intent') assertIntentPayload(record.payload);
  if (record.recordType === 'checkpoint') assertCheckpointPayload(record.payload);
  if (record.recordType === 'terminal') assertTerminalPayload(record.payload);
  if ((record.recordType === 'terminal') !== (record.operationId === null)) fail();
  if (recordHash(record) !== record.recordSha256) fail();
}

export function finalizeJournalRecord(record, { terminalState } = {}) {
  const prepared = structuredClone(record);
  delete prepared.recordSha256;
  if (prepared.recordType === 'terminal') {
    const state = terminalState === undefined ? prepared.payload?.terminalState : terminalState;
    prepared.payload = {
      ...prepared.payload,
      terminalState: canonicalize(state),
      terminalStateSha256: sha256(canonicalJson(state)),
    };
  }
  prepared.recordSha256 = recordHash(prepared);
  assertRecordShape(prepared);
  return Object.freeze(canonicalize(prepared));
}

export function journalFileName(record) {
  assertRecordShape(record);
  return `${String(record.generation).padStart(8, '0')}-${record.recordType}.json`;
}

export function validateJournalRecords(records, { allowOpenIntent = true } = {}) {
  try {
    if (!Array.isArray(records) || records.length < 1) fail();
    let previous = null;
    let releaseSha = null;
    let releaseIdentitySha256 = null;
    let attempt = null;
    let openIntent = null;
    let checkpointCount = 0;
    let mutationOrdinal = 0;
    let lastCheckpoint = null;
    for (const record of records) {
      assertRecordShape(record);
      if (record.generation !== (previous?.generation ?? 0) + 1
        || record.previousRecordSha256 !== (previous?.recordSha256 ?? null)) fail();
      releaseSha ??= record.releaseSha;
      releaseIdentitySha256 ??= record.releaseIdentitySha256;
      if (record.releaseSha !== releaseSha
        || record.releaseIdentitySha256 !== releaseIdentitySha256) fail();

      if (attempt === null) {
        if (record.recordType !== 'intent') fail();
        attempt = {
          attemptId: record.attemptId,
          phase: record.phase,
          phasePlanSha256: record.phasePlanSha256,
          receiptHeadSha256: record.receiptHeadSha256,
        };
        checkpointCount = 0;
        mutationOrdinal = 0;
        lastCheckpoint = null;
      }
      if (record.attemptId !== attempt.attemptId || record.phase !== attempt.phase
        || record.phasePlanSha256 !== attempt.phasePlanSha256
        || record.receiptHeadSha256 !== attempt.receiptHeadSha256) fail();

      if (record.recordType === 'intent') {
        if (openIntent !== null || record.payload.mutationOrdinal !== mutationOrdinal + 1) fail();
        openIntent = record;
        mutationOrdinal = record.payload.mutationOrdinal;
      } else if (record.recordType === 'checkpoint') {
        if (openIntent === null
          || record.operationId !== openIntent.operationId
          || record.payload.intentRecordSha256 !== openIntent.recordSha256) fail();
        if (record.payload.observationSha256 !== openIntent.payload.afterSha256) fail();
        openIntent = null;
        checkpointCount += 1;
        lastCheckpoint = record;
      } else {
        if (openIntent !== null || lastCheckpoint === null
          || record.payload.checkpointRecordSha256 !== lastCheckpoint.recordSha256
          || record.payload.mutationCount !== checkpointCount) fail();
        const responseLossIds = records
          .filter((candidate) => candidate.attemptId === record.attemptId
            && candidate.recordType === 'checkpoint'
            && ['adopted-response-loss', 'adopted-restart'].includes(candidate.payload.outcome))
          .map((candidate) => candidate.operationId);
        if (canonicalJson(record.payload.responseLossOperationIds) !== canonicalJson(responseLossIds)) fail();
        if (Object.hasOwn(record.payload.terminalState, 'mutationCount')
          && record.payload.terminalState.mutationCount !== checkpointCount) fail();
        attempt = null;
        lastCheckpoint = null;
      }
      if (previous && Date.parse(record.createdAt) < Date.parse(previous.createdAt)) fail();
      previous = record;
    }
    if (!allowOpenIntent && attempt !== null) fail();
    return true;
  } catch {
    throw new Error('Release journal is invalid');
  }
}

function pathWithin(parent, child) {
  const member = relative(resolve(parent), resolve(child));
  return member === '' || (!member.startsWith('..') && !isAbsolute(member));
}

async function assertNoSymlinkPath(target) {
  const absolute = resolve(target);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(/[\\/]+/).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error('Release-state parent symlink is forbidden');
  }
  const canonical = await realpath(absolute);
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  if (normalize(resolve(canonical)) !== normalize(absolute)) {
    throw new Error('Release-state parent is not canonical');
  }
  return canonical;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return 'synced';
  } catch (error) {
    if (process.platform === 'win32'
      && ['EACCES', 'EBADF', 'EINVAL', 'EPERM'].includes(error?.code)) {
      return 'windows-process-crash-boundary';
    }
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAtomicCreateOnly(filePath, bytes, { tempId = randomUUID().replaceAll('-', '') } = {}) {
  if (!isAbsolute(filePath) || !OPERATION_ATTEMPT_ID.test(String(tempId ?? ''))
    || !Buffer.isBuffer(bytes) || bytes.length < 1) {
    throw new Error('Atomic create-only write input is invalid');
  }
  const parent = dirname(filePath);
  await assertNoSymlinkPath(parent);
  try {
    await lstat(filePath);
    throw new Error('Atomic create-only target exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporaryPath = join(parent, `${basename(filePath)}.tmp-${tempId}`);
  let handle;
  let published = false;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    try {
      // Node has no portable rename-no-replace primitive. A same-directory hard link
      // is the atomic, create-only publication operation; unlinking the temp leaves
      // the published inode intact.
      await link(temporaryPath, filePath);
    } catch (error) {
      if (error?.code === 'EEXIST') throw new Error('Atomic create-only target exists');
      throw error;
    }
    published = true;
    const finalHandle = await open(filePath, 'r+');
    try { await finalHandle.sync(); } finally { await finalHandle.close(); }
    await unlink(temporaryPath);
    return Object.freeze({ directorySync: await syncDirectory(parent) });
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function readJournalFiles(stateDirectory) {
  const entries = await readdir(stateDirectory, { withFileTypes: true });
  const recordNames = entries
    .filter((entry) => entry.isFile() && JOURNAL_NAME.test(entry.name))
    .map((entry) => entry.name).sort();
  const unexpected = entries.filter((entry) => (
    entry.name !== '.release-state.lock'
      && !JOURNAL_NAME.test(entry.name)
      && !TEMP_NAME.test(entry.name)
  ));
  if (unexpected.length > 0) fail('Release journal directory is invalid');
  const records = [];
  for (const name of recordNames) {
    const bytes = await readFile(join(stateDirectory, name));
    if (bytes.length < 3 || bytes.length > 1024 * 1024) fail();
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) fail();
    const record = JSON.parse(raw);
    if (raw !== `${JSON.stringify(record, null, 2)}\n` || journalFileName(record) !== name) fail();
    records.push(record);
  }
  if (records.length > 0) validateJournalRecords(records);
  return { entries, records };
}

export async function recoverJournalTemp(stateDirectory) {
  await assertNoSymlinkPath(stateDirectory);
  const { entries, records } = await readJournalFiles(stateDirectory);
  const tempEntries = entries.filter((entry) => TEMP_NAME.test(entry.name));
  if (tempEntries.length === 0) return null;
  if (tempEntries.length !== 1) throw new Error('Release journal temporary files are ambiguous');
  const entry = tempEntries[0];
  if (!entry.isFile()) throw new Error('Release journal temporary file is invalid');
  const match = TEMP_NAME.exec(entry.name);
  const finalName = match[1];
  const temporaryPath = join(stateDirectory, entry.name);
  const finalPath = join(stateDirectory, finalName);
  const bytes = await readFile(temporaryPath);
  const raw = bytes.toString('utf8');
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error('Release journal temporary file is invalid'); }
  if (!Buffer.from(raw).equals(bytes)
    || raw !== `${JSON.stringify(record, null, 2)}\n`
    || journalFileName(record) !== finalName
    || record.generation !== records.length + 1) {
    throw new Error('Release journal temporary file is invalid');
  }
  validateJournalRecords([...records, record]);
  try { await link(temporaryPath, finalPath); } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Release journal recovery target exists');
    throw error;
  }
  const finalHandle = await open(finalPath, 'r+');
  try { await finalHandle.sync(); } finally { await finalHandle.close(); }
  await unlink(temporaryPath);
  await syncDirectory(stateDirectory);
  return finalName;
}

function assertLockRecord(value) {
  if (!exactKeys(value, ['attemptId', 'createdAt', 'host', 'pid', 'schemaVersion'])
    || value.schemaVersion !== 1
    || !UUID_V4.test(String(value.attemptId ?? ''))
    || !HOST.test(String(value.host ?? ''))
    || !Number.isSafeInteger(value.pid) || value.pid < 1
    || !canonicalIso(value.createdAt)) throw new Error('Release-state lock is invalid');
}

function defaultIsPidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (error?.code === 'ESRCH') return false;
    return true;
  }
}

export async function acquireReleaseStateLock(stateDirectory, {
  attemptId,
  host = hostname(),
  pid = process.pid,
  now = () => new Date(),
  isPidAlive = defaultIsPidAlive,
  staleAfterMs = 15 * 60 * 1000,
} = {}) {
  await assertNoSymlinkPath(stateDirectory);
  const record = {
    schemaVersion: 1, attemptId, host, pid, createdAt: now().toISOString(),
  };
  assertLockRecord(record);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
    throw new Error('Release-state lock threshold is invalid');
  }
  const lockPath = join(stateDirectory, '.release-state.lock');
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

  async function createLock() {
    const handle = await open(lockPath, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await syncDirectory(stateDirectory);
  }

  try {
    await createLock();
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing;
    let existingBytes;
    try {
      existingBytes = await readFile(lockPath);
      existing = JSON.parse(existingBytes.toString('utf8'));
      assertLockRecord(existing);
    } catch {
      throw new Error('Release-state lock is invalid');
    }
    const age = now().getTime() - Date.parse(existing.createdAt);
    if (existing.host !== host || age < staleAfterMs || isPidAlive(existing.pid)) {
      throw new Error('Release-state lock is active or belongs to another host');
    }
    const stalePath = join(stateDirectory, `.release-state.lock.stale-${randomUUID().replaceAll('-', '')}`);
    try {
      await rename(lockPath, stalePath);
      const moved = await readFile(stalePath);
      if (!moved.equals(existingBytes)) throw new Error('Release-state lock changed during takeover');
      await createLock();
      await unlink(stalePath);
    } catch {
      await unlink(stalePath).catch(() => undefined);
      throw new Error('Release-state lock takeover failed');
    }
  }

  let released = false;
  return Object.freeze({
    record: Object.freeze(record),
    async release() {
      if (released) return;
      const current = await readFile(lockPath).catch(() => null);
      if (!current?.equals(bytes)) throw new Error('Release-state lock ownership changed');
      await unlink(lockPath);
      await syncDirectory(stateDirectory);
      released = true;
    },
  });
}

export async function openReleaseStateStore({
  receiptDirectory,
  releaseSha,
  releaseIdentitySha256,
  phase,
  phasePlanSha256,
  attemptId,
  receiptHeadSha256,
  now = () => new Date(),
  allowTemporaryState = false,
  workspaceRoot = null,
} = {}) {
  if (!isAbsolute(receiptDirectory) || !RELEASE_SHA.test(String(releaseSha ?? ''))
    || !DIGEST.test(String(releaseIdentitySha256 ?? '')) || !PHASES.has(phase)
    || !DIGEST.test(String(phasePlanSha256 ?? '')) || !UUID_V4.test(String(attemptId ?? ''))
    || ![null, true].includes(receiptHeadSha256 === null
      ? null : DIGEST.test(String(receiptHeadSha256 ?? '')))) fail();
  await assertNoSymlinkPath(dirname(receiptDirectory));
  if (!allowTemporaryState && pathWithin(tmpdir(), receiptDirectory)) {
    throw new Error('Release state must use persistent storage outside TEMP');
  }
  if (workspaceRoot && pathWithin(workspaceRoot, receiptDirectory)) {
    throw new Error('Release state must be outside the workspace');
  }
  try { await mkdir(receiptDirectory, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const receiptMetadata = await lstat(receiptDirectory);
  if (!receiptMetadata.isDirectory() || receiptMetadata.isSymbolicLink()) fail();
  await assertNoSymlinkPath(receiptDirectory);
  const stateDirectory = join(receiptDirectory, 'state');
  try { await mkdir(stateDirectory, { mode: 0o700 }); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const metadata = await lstat(stateDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  await assertNoSymlinkPath(stateDirectory);
  const lock = await acquireReleaseStateLock(stateDirectory, { attemptId, now });
  try {
    await recoverJournalTemp(stateDirectory);
    const { records } = await readJournalFiles(stateDirectory);
    let effectiveAttemptId = attemptId;
    if (records.length > 0) {
      const last = records.at(-1);
      if (last.releaseSha !== releaseSha || last.releaseIdentitySha256 !== releaseIdentitySha256) fail();
      if (last.recordType !== 'terminal') {
        if (last.phase !== phase || last.phasePlanSha256 !== phasePlanSha256
          || last.receiptHeadSha256 !== receiptHeadSha256) {
          throw new Error('Release journal open-attempt plan drift');
        }
        effectiveAttemptId = last.attemptId;
      }
    }

    async function append(record) {
      const finalized = finalizeJournalRecord(record);
      const prospective = [...records, finalized];
      validateJournalRecords(prospective);
      const bytes = Buffer.from(`${JSON.stringify(finalized, null, 2)}\n`);
      await writeAtomicCreateOnly(join(stateDirectory, journalFileName(finalized)), bytes);
      records.push(finalized);
      return finalized;
    }

    function envelope(recordType, operationId, payload) {
      const previous = records.at(-1) ?? null;
      return {
        schemaVersion: 1,
        recordType,
        generation: (previous?.generation ?? 0) + 1,
        releaseSha,
        releaseIdentitySha256,
        phase,
        phasePlanSha256,
        attemptId: effectiveAttemptId,
        operationId,
        receiptHeadSha256,
        previousRecordSha256: previous?.recordSha256 ?? null,
        createdAt: now().toISOString(),
        payload,
      };
    }

    return {
      attemptId: effectiveAttemptId,
      stateDirectory,
      records,
      async appendIntent(payload, { operationId } = {}) {
        if (!OPERATION_ID.test(String(operationId ?? ''))) fail();
        return append(envelope('intent', operationId, payload));
      },
      async appendCheckpoint(payload) {
        const intent = records.at(-1);
        if (intent?.recordType !== 'intent') fail();
        return append(envelope('checkpoint', intent.operationId, payload));
      },
      async appendTerminal(payload) {
        const checkpoint = records.at(-1);
        if (checkpoint?.recordType !== 'checkpoint') fail();
        return append(finalizeJournalRecord(envelope('terminal', null, payload), {
          terminalState: payload.terminalState,
        }));
      },
      async close() { await lock.release(); },
    };
  } catch (error) {
    await lock.release().catch(() => undefined);
    throw error;
  }
}
