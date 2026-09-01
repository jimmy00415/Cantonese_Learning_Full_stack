import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import {
  link, lstat, mkdir, open, opendir, realpath, rename, unlink,
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
  'local-artifact-create',
]);
const CHECKPOINT_OUTCOMES = new Set([
  'applied', 'adopted-response-loss', 'adopted-restart', 'verified-noop',
]);
const TERMINAL_STATUSES = new Set(['phase-complete', 'phase-blocked']);
const RECORD_TYPES = new Set(['abort', 'intent', 'checkpoint', 'terminal']);
const JOURNAL_NAME = /^(\d{8})-(abort|intent|checkpoint|terminal)\.json$/;
const TEMP_NAME = /^(\d{8}-(?:abort|intent|checkpoint|terminal)\.json)\.tmp-([0-9a-f]{32})$/;
const STALE_LOCK_NAME = /^\.release-state\.lock\.stale-([0-9a-f]{32})$/;
const ACTIVE_LOCK_NAME = '.release-state.lock';
const JOURNAL_MAX_BYTES = 1024 * 1024;
const LOCK_MAX_BYTES = 16 * 1024;
const STATE_ENTRY_LIMIT = 1024;
const STATE_ENTRY_NAME_MAX_BYTES = 255;
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
    if (!exactKeys(value, [
      'artifactSha256', 'kind', 'name', 'objectSha256', 'version',
    ])
      || typeof value.name !== 'string' || value.name.length < 1 || value.name.length > 255
      || !DIGEST.test(String(value.artifactSha256 ?? ''))
      || !DIGEST.test(String(value.objectSha256 ?? ''))
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
  if (value.kind === 'artifact-bundle') {
    if (!exactKeys(value, ['artifactCount', 'bundleSha256', 'kind'])
      || !Number.isSafeInteger(value.artifactCount) || value.artifactCount < 1
      || value.artifactCount > 8
      || !DIGEST.test(String(value.bundleSha256 ?? ''))) fail();
    return;
  }
  fail();
}

function assertPublication(value) {
  const hasReceipt = isPlainObject(value) && Object.hasOwn(value, 'receipt');
  if (!exactKeys(value, hasReceipt ? ['artifacts', 'bundleSha256', 'receipt']
    : ['artifacts', 'bundleSha256'])
    || !Array.isArray(value.artifacts) || value.artifacts.length < 1
    || value.artifacts.length > 8
    || !DIGEST.test(String(value.bundleSha256 ?? ''))) fail();
  const paths = new Set();
  let totalBytes = 0;
  for (const artifact of value.artifacts) {
    if (!exactKeys(artifact, [
      'byteLength', 'contentsBase64', 'filePath', 'objectSha256', 'role',
    ])
      || !isAbsolute(artifact.filePath) || artifact.filePath.length > 1024
      || !['evidence', 'privacy-end', 'privacy-start', 'privacy-proof', 'screenshot'].includes(artifact.role)
      || paths.has(resolve(artifact.filePath))
      || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 1
      || artifact.byteLength > 4 * 1024 * 1024
      || typeof artifact.contentsBase64 !== 'string'
      || artifact.contentsBase64.length > 6 * 1024 * 1024
      || !DIGEST.test(String(artifact.objectSha256 ?? ''))) fail();
    const bytes = Buffer.from(artifact.contentsBase64, 'base64');
    if (bytes.length !== artifact.byteLength
      || bytes.toString('base64') !== artifact.contentsBase64
      || sha256(bytes) !== artifact.objectSha256) fail();
    paths.add(resolve(artifact.filePath));
    totalBytes += bytes.length;
  }
  if (hasReceipt && (!isPlainObject(value.receipt)
    || Buffer.byteLength(canonicalJson(value.receipt)) > 512 * 1024
    || containsForbiddenPersistedSecret(value.receipt))) fail();
  if (totalBytes > 12 * 1024 * 1024
    || sha256(canonicalJson(value.artifacts)) !== value.bundleSha256) fail();
}

function assertIntentPayload(payload) {
  const expectedKeys = [
    'afterSha256', 'beforeSha256', 'commandSha256', 'mutationOrdinal',
    'operationAttemptId', 'reconcileKind',
  ];
  const localPublication = payload?.reconcileKind === 'local-artifact-create';
  if (!exactKeys(payload, localPublication ? [...expectedKeys, 'publication'] : expectedKeys)
    || !Number.isSafeInteger(payload.mutationOrdinal) || payload.mutationOrdinal < 1
    || !OPERATION_ATTEMPT_ID.test(String(payload.operationAttemptId ?? ''))
    || !DIGEST.test(String(payload.commandSha256 ?? ''))
    || !RECONCILE_KINDS.has(payload.reconcileKind)
    || !DIGEST.test(String(payload.beforeSha256 ?? ''))
    || !DIGEST.test(String(payload.afterSha256 ?? ''))) fail();
  if (localPublication) assertPublication(payload.publication);
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

function assertAbortPayload(payload) {
  if (!isPlainObject(payload) || !DIGEST.test(String(payload.intentRecordSha256 ?? ''))) fail();
  if (payload.reason === 'expired-before-final-mutation') {
    if (!exactKeys(payload, ['intentRecordSha256', 'reason'])) fail();
    return;
  }
  if (payload.reason !== 'authoritative-cloud-run-failed-precondition'
    || !exactKeys(payload, ['evidence', 'intentRecordSha256', 'reason'])) fail();
  const evidence = payload.evidence;
  if (!exactKeys(evidence, [
    'commandSha256', 'executionListSha256', 'httpStatus', 'job', 'jobGeneration',
    'jobReadbackSha256', 'jobUid', 'logSha256', 'operationAttemptId', 'project',
    'region', 'rejectionMessageSha256', 'requestObservedAt', 'rpcStatus',
  ])
    || !DIGEST.test(String(evidence.commandSha256 ?? ''))
    || !DIGEST.test(String(evidence.executionListSha256 ?? ''))
    || evidence.httpStatus !== 400
    || !/^[a-z][a-z0-9-]{0,62}$/.test(String(evidence.job ?? ''))
    || !Number.isSafeInteger(evidence.jobGeneration) || evidence.jobGeneration < 1
    || !DIGEST.test(String(evidence.jobReadbackSha256 ?? ''))
    || !UUID_V4.test(String(evidence.jobUid ?? ''))
    || !DIGEST.test(String(evidence.logSha256 ?? ''))
    || !OPERATION_ATTEMPT_ID.test(String(evidence.operationAttemptId ?? ''))
    || !/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(String(evidence.project ?? ''))
    || !/^[a-z]+-[a-z]+[0-9]$/.test(String(evidence.region ?? ''))
    || !DIGEST.test(String(evidence.rejectionMessageSha256 ?? ''))
    || !canonicalIso(evidence.requestObservedAt)
    || evidence.rpcStatus !== 'FAILED_PRECONDITION') fail();
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
  if (record.recordType === 'abort') assertAbortPayload(record.payload);
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
      } else if (record.recordType === 'abort') {
        if (openIntent === null || record.operationId !== openIntent.operationId
          || record.payload.intentRecordSha256 !== openIntent.recordSha256) fail();
        if (record.payload.reason === 'authoritative-cloud-run-failed-precondition'
          && (record.phase !== 'acceptance'
            || openIntent.payload.reconcileKind !== 'cloud-run-job-execute'
            || !openIntent.operationId.endsWith('-execute')
            || record.payload.evidence.commandSha256 !== openIntent.payload.commandSha256
            || record.payload.evidence.operationAttemptId
              !== openIntent.payload.operationAttemptId)) fail();
        openIntent = null;
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

function statIdentityMatches(left, right) {
  const comparable = (value) => typeof value === 'bigint'
    || (typeof value === 'number' && Number.isFinite(value));
  return comparable(left?.dev) && comparable(left?.ino)
    && comparable(right?.dev) && comparable(right?.ino)
    && left.dev === right.dev && left.ino === right.ino;
}

function ordinaryFile(metadata) {
  return metadata?.isFile?.() === true && metadata?.isSymbolicLink?.() !== true
    && metadataSize(metadata) !== null;
}

function uniquelyLinkedOrdinaryFile(metadata) {
  const links = metadata?.nlink;
  const oneLink = links === 1n || links === 1;
  return ordinaryFile(metadata) && oneLink;
}

function twiceLinkedOrdinaryFile(metadata) {
  const links = metadata?.nlink;
  const twoLinks = links === 2n || links === 2;
  return ordinaryFile(metadata) && twoLinks;
}

function metadataSize(metadata) {
  if (typeof metadata?.size === 'bigint') {
    if (metadata.size < 0n || metadata.size > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(metadata.size);
  }
  return Number.isSafeInteger(metadata?.size) && metadata.size >= 0 ? metadata.size : null;
}

function exactMetadataSize(metadata, expected) {
  return metadataSize(metadata) === expected;
}

function canonicalPathMatches(actual, expected) {
  const normalize = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  return normalize(resolve(actual)) === normalize(resolve(expected));
}

export async function readBoundedOrdinaryFile(filePath, {
  expectedByteLength = null,
  maximumBytes = 4 * 1024 * 1024,
  afterOpen = null,
} = {}) {
  if (!isAbsolute(filePath) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1
    || (expectedByteLength !== null
      && (!Number.isSafeInteger(expectedByteLength) || expectedByteLength < 1
        || expectedByteLength > maximumBytes))
    || (afterOpen !== null && typeof afterOpen !== 'function')) {
    throw new Error('Bounded ordinary file read input is invalid');
  }
  const parent = dirname(filePath);
  const parentBefore = await lstat(parent, { bigint: true });
  const parentRealBefore = await realpath(parent);
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()
    || !canonicalPathMatches(parentRealBefore, parent)) {
    throw new Error('Bounded ordinary file parent is invalid');
  }
  // An initial ENOENT is intentionally preserved so a create-only publisher can
  // distinguish absence from any identity drift after the path was observed.
  const pathBefore = await lstat(filePath, { bigint: true });
  if (!uniquelyLinkedOrdinaryFile(pathBefore)) throw new Error('Bounded ordinary file is invalid');
  const byteLength = expectedByteLength ?? metadataSize(pathBefore);
  if (byteLength < 1 || byteLength > maximumBytes || !exactMetadataSize(pathBefore, byteLength)) {
    throw new Error('Bounded ordinary file length is invalid');
  }
  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | noFollow);
    const opened = await handle.stat({ bigint: true });
    const pathOpened = await lstat(filePath, { bigint: true });
    if (!uniquelyLinkedOrdinaryFile(opened) || !exactMetadataSize(opened, byteLength)
      || !uniquelyLinkedOrdinaryFile(pathOpened)
      || !exactMetadataSize(pathOpened, byteLength) || !statIdentityMatches(pathBefore, opened)
      || !statIdentityMatches(pathOpened, opened)) {
      throw new Error('Bounded ordinary file identity changed');
    }
    await afterOpen?.();
    const bytes = Buffer.allocUnsafe(byteLength + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 0
        || result.bytesRead > bytes.length - offset) {
        throw new Error('Bounded ordinary file read is invalid');
      }
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset !== byteLength) throw new Error('Bounded ordinary file size changed');
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    const parentAfter = await lstat(parent, { bigint: true });
    const parentRealAfter = await realpath(parent);
    if (!uniquelyLinkedOrdinaryFile(descriptorAfter) || !exactMetadataSize(descriptorAfter, byteLength)
      || !uniquelyLinkedOrdinaryFile(pathAfter) || !exactMetadataSize(pathAfter, byteLength)
      || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || !statIdentityMatches(opened, descriptorAfter)
      || !statIdentityMatches(pathAfter, descriptorAfter)
      || !statIdentityMatches(parentBefore, parentAfter)
      || !canonicalPathMatches(parentRealAfter, parent)
      || !canonicalPathMatches(parentRealBefore, parentRealAfter)) {
      throw new Error('Bounded ordinary file identity changed');
    }
    return Buffer.from(bytes.subarray(0, byteLength));
  } catch (error) {
    throw new Error('Bounded ordinary file changed or could not be read', { cause: error });
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readExactDescriptorBytes(handle, byteLength) {
  const bytes = Buffer.allocUnsafe(byteLength + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, offset);
    if (!Number.isSafeInteger(result?.bytesRead) || result.bytesRead < 0
      || result.bytesRead > bytes.length - offset) {
      throw new Error('Release journal publication read is invalid');
    }
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset !== byteLength) throw new Error('Release journal publication size changed');
  return Buffer.from(bytes.subarray(0, byteLength));
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

export function classifyDirectorySyncError(error, { platform = process.platform } = {}) {
  if (platform === 'win32' && error?.code === 'EPERM') {
    return 'windows-process-crash-boundary';
  }
  throw error;
}

async function syncDirectory(directory) {
  let handle;
  try {
    handle = await open(directory, 'r');
    await handle.sync();
    return 'synced';
  } catch (error) {
    return classifyDirectorySyncError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function writeAtomicCreateOnly(filePath, bytes, {
  tempId = randomUUID().replaceAll('-', ''),
  afterTempSync = null,
} = {}) {
  if (!isAbsolute(filePath) || !OPERATION_ATTEMPT_ID.test(String(tempId ?? ''))
    || !Buffer.isBuffer(bytes) || bytes.length < 1
    || (afterTempSync !== null && typeof afterTempSync !== 'function')) {
    throw new Error('Atomic create-only write input is invalid');
  }
  const parent = dirname(filePath);
  const parentRealBefore = await assertNoSymlinkPath(parent);
  const parentBefore = await lstat(parent, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()) {
    throw new Error('Atomic create-only parent is invalid');
  }
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
    const temporaryDescriptor = await handle.stat({ bigint: true });
    const temporaryBefore = await lstat(temporaryPath, { bigint: true });
    if (!ordinaryFile(temporaryDescriptor) || !exactMetadataSize(temporaryDescriptor, bytes.length)
      || !ordinaryFile(temporaryBefore) || !exactMetadataSize(temporaryBefore, bytes.length)
      || !statIdentityMatches(temporaryDescriptor, temporaryBefore)) {
      throw new Error('Atomic create-only temporary identity changed');
    }
    await handle.close();
    handle = null;
    await afterTempSync?.();
    let parentBeforePublish;
    let parentRealBeforePublish;
    let temporaryBeforePublish;
    try {
      parentBeforePublish = await lstat(parent, { bigint: true });
      parentRealBeforePublish = await realpath(parent);
      temporaryBeforePublish = await lstat(temporaryPath, { bigint: true });
    } catch (error) {
      throw new Error('Atomic create-only parent or temporary identity changed', { cause: error });
    }
    if (!parentBeforePublish.isDirectory() || parentBeforePublish.isSymbolicLink()
      || !statIdentityMatches(parentBefore, parentBeforePublish)
      || !canonicalPathMatches(parentRealBefore, parentRealBeforePublish)
      || !canonicalPathMatches(parentRealBeforePublish, parent)
      || !ordinaryFile(temporaryBeforePublish)
      || !exactMetadataSize(temporaryBeforePublish, bytes.length)
      || !statIdentityMatches(temporaryDescriptor, temporaryBeforePublish)) {
      throw new Error('Atomic create-only parent or temporary identity changed');
    }
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
    try {
      const finalDescriptor = await finalHandle.stat({ bigint: true });
      const finalPathMetadata = await lstat(filePath, { bigint: true });
      const parentAfter = await lstat(parent, { bigint: true });
      const parentRealAfter = await realpath(parent);
      if (!ordinaryFile(finalDescriptor) || !exactMetadataSize(finalDescriptor, bytes.length)
        || !ordinaryFile(finalPathMetadata) || !exactMetadataSize(finalPathMetadata, bytes.length)
        || !statIdentityMatches(temporaryDescriptor, finalDescriptor)
        || !statIdentityMatches(finalPathMetadata, finalDescriptor)
        || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
        || !statIdentityMatches(parentBefore, parentAfter)
        || !canonicalPathMatches(parentRealBefore, parentRealAfter)
        || !canonicalPathMatches(parentRealAfter, parent)) {
        throw new Error('Atomic create-only publication identity changed');
      }
      await finalHandle.sync();
    } finally { await finalHandle.close(); }
    await unlink(temporaryPath);
    return Object.freeze({ directorySync: await syncDirectory(parent) });
  } finally {
    await handle?.close().catch(() => undefined);
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

function reservedStateName(name) {
  return name === ACTIVE_LOCK_NAME || JOURNAL_NAME.test(name)
    || TEMP_NAME.test(name) || STALE_LOCK_NAME.test(name);
}

async function readStateEntries(stateDirectory) {
  const directoryBefore = await lstat(stateDirectory, { bigint: true });
  const directoryRealBefore = await realpath(stateDirectory);
  if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()
    || !canonicalPathMatches(directoryRealBefore, stateDirectory)) {
    throw new Error('Release-state directory is invalid');
  }
  let handle;
  const entries = [];
  try {
    handle = await opendir(stateDirectory);
    while (true) {
      const entry = await handle.read();
      if (entry === null) break;
      if (entries.length >= STATE_ENTRY_LIMIT) {
        throw new Error('Release-state directory entry count exceeds the safe limit');
      }
      const nameBytes = typeof entry?.name === 'string'
        ? Buffer.byteLength(entry.name, 'utf8') : 0;
      if (nameBytes < 1 || nameBytes > STATE_ENTRY_NAME_MAX_BYTES
        || /[\u0000-\u001f\u007f/\\]/u.test(entry.name)
        || !reservedStateName(entry.name)) {
        throw new Error('Release journal directory entry is invalid');
      }
      if (entry.isFile() !== true || entry.isSymbolicLink() === true) {
        throw new Error('Reserved state entry is not an ordinary file');
      }
      entries.push(entry);
    }
  } finally {
    await handle?.close().catch((error) => {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  const directoryAfter = await lstat(stateDirectory, { bigint: true });
  const directoryRealAfter = await realpath(stateDirectory);
  if (!directoryAfter.isDirectory() || directoryAfter.isSymbolicLink()
    || !statIdentityMatches(directoryBefore, directoryAfter)
    || !canonicalPathMatches(directoryRealBefore, directoryRealAfter)
    || !canonicalPathMatches(directoryRealAfter, stateDirectory)) {
    throw new Error('Release-state directory identity changed');
  }
  return entries;
}

function parseCanonicalJournalBytes(bytes, name, message = 'Release journal is invalid') {
  if (!Buffer.isBuffer(bytes) || bytes.length < 3) throw new Error(message);
  const raw = bytes.toString('utf8');
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error(message); }
  if (!Buffer.from(raw).equals(bytes)
    || raw !== `${JSON.stringify(record, null, 2)}\n`
    || journalFileName(record) !== name) {
    throw new Error(message);
  }
  return record;
}

async function readJournalRecordsFromEntries(stateDirectory, entries, {
  excludeName = null,
  fileReader = readBoundedOrdinaryFile,
} = {}) {
  if (typeof fileReader !== 'function') fail('Release journal reader is invalid');
  const recordNames = entries
    .filter((entry) => JOURNAL_NAME.test(entry.name) && entry.name !== excludeName)
    .map((entry) => entry.name).sort();
  const records = [];
  for (const name of recordNames) {
    const bytes = await fileReader(join(stateDirectory, name), {
      maximumBytes: JOURNAL_MAX_BYTES,
    });
    records.push(parseCanonicalJournalBytes(bytes, name));
  }
  if (records.length > 0) validateJournalRecords(records);
  return records;
}

async function readJournalFiles(stateDirectory, {
  fileReader = readBoundedOrdinaryFile,
} = {}) {
  const entries = await readStateEntries(stateDirectory);
  const records = await readJournalRecordsFromEntries(stateDirectory, entries, { fileReader });
  return { entries, records };
}

export async function readReleaseJournalRecords(receiptDirectory, {
  fileReader = readBoundedOrdinaryFile,
} = {}) {
  if (!isAbsolute(receiptDirectory)) fail();
  const stateDirectory = join(receiptDirectory, 'state');
  await assertNoSymlinkPath(stateDirectory);
  const metadata = await lstat(stateDirectory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail();
  const { records } = await readJournalFiles(stateDirectory, { fileReader });
  validateJournalRecords(records);
  return Object.freeze(records.map((record) => Object.freeze(structuredClone(record))));
}

async function readLinkedPublicationCrashPair(stateDirectory, temporaryPath, finalPath, finalName) {
  if (!isAbsolute(stateDirectory) || !isAbsolute(temporaryPath) || !isAbsolute(finalPath)
    || !canonicalPathMatches(dirname(temporaryPath), stateDirectory)
    || !canonicalPathMatches(dirname(finalPath), stateDirectory)
    || basename(finalPath) !== finalName || !JOURNAL_NAME.test(finalName)) {
    throw new Error('Release journal linked publication paths are invalid');
  }
  const parentBefore = await lstat(stateDirectory, { bigint: true });
  const parentRealBefore = await realpath(stateDirectory);
  const temporaryBefore = await lstat(temporaryPath, { bigint: true });
  const finalBefore = await lstat(finalPath, { bigint: true });
  if (!parentBefore.isDirectory() || parentBefore.isSymbolicLink()
    || !canonicalPathMatches(parentRealBefore, stateDirectory)) {
    throw new Error('Release journal linked publication parent is invalid');
  }
  if (uniquelyLinkedOrdinaryFile(temporaryBefore) && uniquelyLinkedOrdinaryFile(finalBefore)) {
    return null;
  }
  const byteLength = metadataSize(temporaryBefore);
  if (!twiceLinkedOrdinaryFile(temporaryBefore) || !twiceLinkedOrdinaryFile(finalBefore)
    || !statIdentityMatches(temporaryBefore, finalBefore)
    || byteLength < 1 || byteLength > JOURNAL_MAX_BYTES
    || !exactMetadataSize(finalBefore, byteLength)) {
    throw new Error('Release journal linked publication topology is invalid');
  }

  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  let temporaryHandle;
  let finalHandle;
  let bytes;
  try {
    temporaryHandle = await open(temporaryPath, fsConstants.O_RDONLY | noFollow);
    finalHandle = await open(finalPath, fsConstants.O_RDONLY | noFollow);
    const temporaryOpened = await temporaryHandle.stat({ bigint: true });
    const finalOpened = await finalHandle.stat({ bigint: true });
    const temporaryPathOpened = await lstat(temporaryPath, { bigint: true });
    const finalPathOpened = await lstat(finalPath, { bigint: true });
    if (!twiceLinkedOrdinaryFile(temporaryOpened) || !twiceLinkedOrdinaryFile(finalOpened)
      || !twiceLinkedOrdinaryFile(temporaryPathOpened) || !twiceLinkedOrdinaryFile(finalPathOpened)
      || !exactMetadataSize(temporaryOpened, byteLength)
      || !exactMetadataSize(finalOpened, byteLength)
      || !exactMetadataSize(temporaryPathOpened, byteLength)
      || !exactMetadataSize(finalPathOpened, byteLength)
      || !statIdentityMatches(temporaryBefore, temporaryOpened)
      || !statIdentityMatches(finalBefore, finalOpened)
      || !statIdentityMatches(temporaryOpened, finalOpened)
      || !statIdentityMatches(temporaryPathOpened, temporaryOpened)
      || !statIdentityMatches(finalPathOpened, finalOpened)) {
      throw new Error('Release journal linked publication identity changed');
    }
    const temporaryBytes = await readExactDescriptorBytes(temporaryHandle, byteLength);
    const finalBytes = await readExactDescriptorBytes(finalHandle, byteLength);
    if (!temporaryBytes.equals(finalBytes)) {
      throw new Error('Release journal linked publication bytes differ');
    }
    const temporaryAfter = await temporaryHandle.stat({ bigint: true });
    const finalAfter = await finalHandle.stat({ bigint: true });
    const temporaryPathAfter = await lstat(temporaryPath, { bigint: true });
    const finalPathAfter = await lstat(finalPath, { bigint: true });
    const parentAfter = await lstat(stateDirectory, { bigint: true });
    const parentRealAfter = await realpath(stateDirectory);
    if (!twiceLinkedOrdinaryFile(temporaryAfter) || !twiceLinkedOrdinaryFile(finalAfter)
      || !twiceLinkedOrdinaryFile(temporaryPathAfter) || !twiceLinkedOrdinaryFile(finalPathAfter)
      || !exactMetadataSize(temporaryAfter, byteLength)
      || !exactMetadataSize(finalAfter, byteLength)
      || !exactMetadataSize(temporaryPathAfter, byteLength)
      || !exactMetadataSize(finalPathAfter, byteLength)
      || !statIdentityMatches(temporaryOpened, temporaryAfter)
      || !statIdentityMatches(finalOpened, finalAfter)
      || !statIdentityMatches(temporaryAfter, finalAfter)
      || !statIdentityMatches(temporaryPathAfter, temporaryAfter)
      || !statIdentityMatches(finalPathAfter, finalAfter)
      || !parentAfter.isDirectory() || parentAfter.isSymbolicLink()
      || !statIdentityMatches(parentBefore, parentAfter)
      || !canonicalPathMatches(parentRealBefore, parentRealAfter)
      || !canonicalPathMatches(parentRealAfter, stateDirectory)) {
      throw new Error('Release journal linked publication identity changed');
    }
    bytes = temporaryBytes;
  } catch (error) {
    throw new Error('Release journal linked publication changed or could not be read', { cause: error });
  } finally {
    await temporaryHandle?.close().catch(() => undefined);
    await finalHandle?.close().catch(() => undefined);
  }
  const record = parseCanonicalJournalBytes(
    bytes, finalName, 'Release journal linked publication record is invalid',
  );
  return { bytes, record, byteLength, parentBefore, parentRealBefore, temporaryBefore, finalBefore };
}

async function assertLinkedPublicationStillOwned(
  stateDirectory, temporaryPath, finalPath, snapshot, expectedEntryNames,
) {
  try {
    const currentEntryNames = (await readStateEntries(stateDirectory))
      .map((entry) => entry.name).sort();
    if (currentEntryNames.length !== expectedEntryNames.length
      || currentEntryNames.some((name, index) => name !== expectedEntryNames[index])) {
      throw new Error('Release journal linked publication entry set changed');
    }
    const parent = await lstat(stateDirectory, { bigint: true });
    const parentReal = await realpath(stateDirectory);
    const temporary = await lstat(temporaryPath, { bigint: true });
    const final = await lstat(finalPath, { bigint: true });
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || !statIdentityMatches(snapshot.parentBefore, parent)
      || !canonicalPathMatches(snapshot.parentRealBefore, parentReal)
      || !canonicalPathMatches(parentReal, stateDirectory)
      || !twiceLinkedOrdinaryFile(temporary) || !twiceLinkedOrdinaryFile(final)
      || !exactMetadataSize(temporary, snapshot.byteLength)
      || !exactMetadataSize(final, snapshot.byteLength)
      || !statIdentityMatches(snapshot.temporaryBefore, temporary)
      || !statIdentityMatches(snapshot.finalBefore, final)
      || !statIdentityMatches(temporary, final)) {
      throw new Error('Release journal linked publication identity changed');
    }
  } catch (error) {
    throw new Error('Release journal linked publication identity changed', { cause: error });
  }
}

async function assertPathAbsent(filePath) {
  try {
    await lstat(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error('Release journal temporary unlink was not durable');
}

export async function recoverJournalTemp(stateDirectory, {
  fileReader = readBoundedOrdinaryFile,
} = {}) {
  if (typeof fileReader !== 'function') fail('Release journal reader is invalid');
  await assertNoSymlinkPath(stateDirectory);
  const entries = await readStateEntries(stateDirectory);
  const tempEntries = entries.filter((entry) => TEMP_NAME.test(entry.name));
  if (tempEntries.length === 0) {
    await readJournalRecordsFromEntries(stateDirectory, entries, { fileReader });
    return null;
  }
  if (tempEntries.length !== 1) throw new Error('Release journal temporary files are ambiguous');
  const entry = tempEntries[0];
  const match = TEMP_NAME.exec(entry.name);
  const finalName = match[1];
  const temporaryPath = join(stateDirectory, entry.name);
  const finalPath = join(stateDirectory, finalName);
  const finalEntry = entries.find((candidate) => candidate.name === finalName);
  if (finalEntry) {
    const linkedPublication = await readLinkedPublicationCrashPair(
      stateDirectory, temporaryPath, finalPath, finalName,
    );
    if (linkedPublication) {
      const authoritativeReader = fileReader === readBoundedOrdinaryFile
        ? readBoundedOrdinaryFile
        : async (filePath, options) => {
          await fileReader(filePath, options);
          return readBoundedOrdinaryFile(filePath, options);
        };
      const records = await readJournalRecordsFromEntries(stateDirectory, entries, {
        excludeName: finalName,
        fileReader: authoritativeReader,
      });
      if (linkedPublication.record.generation !== records.length + 1) {
        throw new Error('Release journal linked publication record is invalid');
      }
      validateJournalRecords([...records, linkedPublication.record]);
      await assertLinkedPublicationStillOwned(
        stateDirectory, temporaryPath, finalPath, linkedPublication,
        entries.map((candidate) => candidate.name).sort(),
      );
      await unlink(temporaryPath);
      await syncDirectory(stateDirectory);
      await assertPathAbsent(temporaryPath);
      const finalBytes = await readBoundedOrdinaryFile(finalPath, {
        expectedByteLength: linkedPublication.byteLength,
        maximumBytes: JOURNAL_MAX_BYTES,
      });
      const finalRecord = parseCanonicalJournalBytes(
        finalBytes, finalName, 'Release journal recovery target is invalid',
      );
      if (!finalBytes.equals(linkedPublication.bytes)
        || finalRecord.recordSha256 !== linkedPublication.record.recordSha256) {
        throw new Error('Release journal recovery target differs from temporary bytes');
      }
      return finalName;
    }
  }
  const records = await readJournalRecordsFromEntries(stateDirectory, entries, { fileReader });
  const bytes = await fileReader(temporaryPath, { maximumBytes: JOURNAL_MAX_BYTES });
  const record = parseCanonicalJournalBytes(
    bytes, finalName, 'Release journal temporary file is invalid',
  );
  const published = records.find((candidate) => journalFileName(candidate) === finalName);
  if (published) {
    const finalBytes = await fileReader(finalPath, { maximumBytes: JOURNAL_MAX_BYTES });
    if (!finalBytes.equals(bytes) || published.recordSha256 !== record.recordSha256) {
      throw new Error('Release journal recovery target differs from temporary bytes');
    }
    await unlink(temporaryPath);
    await syncDirectory(stateDirectory);
    return finalName;
  }
  if (record.generation !== records.length + 1) {
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
  const finalBytes = await fileReader(finalPath, { maximumBytes: JOURNAL_MAX_BYTES });
  if (!finalBytes.equals(bytes)) {
    throw new Error('Release journal recovery target differs from temporary bytes');
  }
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
  fileReader = readBoundedOrdinaryFile,
} = {}) {
  await assertNoSymlinkPath(stateDirectory);
  const record = {
    schemaVersion: 1, attemptId, host, pid, createdAt: now().toISOString(),
  };
  assertLockRecord(record);
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 60_000) {
    throw new Error('Release-state lock threshold is invalid');
  }
  if (typeof fileReader !== 'function') throw new Error('Release-state lock reader is invalid');
  const lockPath = join(stateDirectory, ACTIVE_LOCK_NAME);
  const bytes = Buffer.from(`${JSON.stringify(record, null, 2)}\n`);

  const entries = await readStateEntries(stateDirectory);
  const staleArtifacts = entries.filter((entry) => STALE_LOCK_NAME.test(entry.name));
  if (staleArtifacts.length > 1) throw new Error('Release-state lock recovery is ambiguous');
  if (staleArtifacts.length === 1) {
    const artifact = staleArtifacts[0];
    const artifactPath = join(stateDirectory, artifact.name);
    let staleRecord;
    let staleBytes;
    try {
      staleBytes = await fileReader(artifactPath, { maximumBytes: LOCK_MAX_BYTES });
      staleRecord = JSON.parse(staleBytes.toString('utf8'));
      assertLockRecord(staleRecord);
      if (!staleBytes.equals(Buffer.from(`${JSON.stringify(staleRecord, null, 2)}\n`))) {
        throw new Error('noncanonical stale lock');
      }
    } catch {
      throw new Error('Release-state lock recovery is invalid');
    }
    const staleAge = now().getTime() - Date.parse(staleRecord.createdAt);
    if (staleRecord.host !== host || staleAge < staleAfterMs || isPidAlive(staleRecord.pid)) {
      throw new Error('Release-state stale lock is active or belongs to another host');
    }
    await unlink(artifactPath);
    await syncDirectory(stateDirectory);
  }

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
      existingBytes = await fileReader(lockPath, { maximumBytes: LOCK_MAX_BYTES });
      existing = JSON.parse(existingBytes.toString('utf8'));
      assertLockRecord(existing);
      if (!existingBytes.equals(Buffer.from(`${JSON.stringify(existing, null, 2)}\n`))) {
        throw new Error('noncanonical active lock');
      }
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
      const moved = await fileReader(stalePath, { maximumBytes: LOCK_MAX_BYTES });
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
      let current;
      try {
        current = await fileReader(lockPath, { maximumBytes: LOCK_MAX_BYTES });
      } catch (error) {
        throw new Error('Release-state lock ownership changed', { cause: error });
      }
      if (!current.equals(bytes)) throw new Error('Release-state lock ownership changed');
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
      async appendAbort(payload) {
        const intent = records.at(-1);
        if (intent?.recordType !== 'intent') fail();
        return append(envelope('abort', intent.operationId, payload));
      },
      async appendTerminal(payload) {
        const previous = records.at(-1);
        if (!['abort', 'checkpoint'].includes(previous?.recordType)
          || !records.some((record) => record.recordType === 'checkpoint'
            && record.attemptId === effectiveAttemptId)) fail();
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
