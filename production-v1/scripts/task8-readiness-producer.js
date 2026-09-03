import { createHash } from 'node:crypto';

import { GCP_IDENTITY } from '../src/gcp-identity.js';
import {
  CANDIDATE_PRIVACY_SCHEMA_VERSION,
  candidatePrivacyBoundarySha256,
  readCandidateControlPlaneSnapshot,
  runCandidateAuthenticatedHealthProbe,
  runCandidatePrivacyProof,
  validateCandidatePrivacyProof,
} from './candidate-privacy-proof.js';
import { containsForbiddenPersistedSecret } from './persisted-secret-contract.js';

const SCHEMA_VERSION = 3;
const MAXIMUM_AGE_MS = 5 * 60_000;
const ZERO_DIGEST = '0'.repeat(64);
const DIGEST = /^[0-9a-f]{64}$/u;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const RELEASE_SHA = /^[0-9a-f]{40}$/u;
const READINESS_COMPONENTS = Object.freeze([
  'configuration', 'release-evidence', 'llm-smoke', 'database', 'media',
  'corpus', 'retention', 'dispatcher', 'runtime',
]);
const SAFE_READINESS_TOKEN = /^[a-z0-9][a-z0-9._-]{0,79}$/iu;

function fail() {
  throw new Error('Task 8 readiness production failed');
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exact(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function exactKeys(value, keys) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0'));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const member of Object.values(value)) deepFreeze(member);
  return Object.freeze(value);
}

function isAbsoluteFile(value) {
  return typeof value === 'string' && value.length > 3
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value))
    && !/[\u0000\r\n]/u.test(value);
}

function normalizedPrivacyLocator(value, { unresolved = false } = {}) {
  const observedAt = Date.parse(value?.observedAt);
  const expiresAt = Date.parse(value?.expiresAt);
  const unresolvedDigests = [
    value?.artifactSha256, value?.objectSha256, value?.boundarySha256,
  ].every((member) => member === ZERO_DIGEST);
  const validSchema = value?.schemaVersion === CANDIDATE_PRIVACY_SCHEMA_VERSION
    || (unresolved && unresolvedDigests && value?.schemaVersion === SCHEMA_VERSION);
  if (!exactKeys(value, [
    'artifactSha256', 'boundarySha256', 'expiresAt', 'filePath', 'objectSha256',
    'observedAt', 'schemaVersion',
  ]) || !validSchema || !isAbsoluteFile(value.filePath)
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !DIGEST.test(String(value.boundarySha256 ?? ''))
    || !Number.isFinite(observedAt) || !Number.isFinite(expiresAt)
    || expiresAt - observedAt !== MAXIMUM_AGE_MS
    || (unresolved && !unresolvedDigests)) fail();
  return deepFreeze({ ...value });
}

function normalizedEvidenceContract(value, binding) {
  if (!exactKeys(value, [
    'artifactSha256', 'candidateService', 'filePath', 'objectSha256', 'privacyProofs',
    'schemaVersion', 'stableService', 'stableTrafficState', 'trafficState',
  ]) || value.schemaVersion !== SCHEMA_VERSION || !isAbsoluteFile(value.filePath)
    || value.artifactSha256 !== ZERO_DIGEST || value.objectSha256 !== ZERO_DIGEST
    || value.candidateService !== binding.candidateService
    || value.stableService !== GCP_IDENTITY.service
    || value.trafficState !== 'candidate-service-private-100'
    || !['stable-absent', 'stable-prior-100'].includes(value.stableTrafficState)
    || !exactKeys(value.privacyProofs, ['end', 'start'])) fail();
  const start = normalizedPrivacyLocator(value.privacyProofs.start, { unresolved: true });
  const end = normalizedPrivacyLocator(value.privacyProofs.end, { unresolved: true });
  if (new Set([value.filePath, start.filePath, end.filePath]).size !== 3) fail();
  return deepFreeze({ ...value, privacyProofs: { start, end } });
}

function normalizedReadiness(value) {
  if (!exactKeys(value, ['boundary', 'checks', 'productionReady', 'status'])
    || value.status !== 'ready' || value.productionReady !== true
    || value.boundary !== 'production-v1' || !Array.isArray(value.checks)
    || value.checks.length !== READINESS_COMPONENTS.length) fail();
  const checks = value.checks.map((check, index) => {
    const keys = check?.version === undefined ? ['name', 'status'] : ['name', 'status', 'version'];
    if (!exactKeys(check, keys) || check.name !== READINESS_COMPONENTS[index]
      || check.status !== 'ready' || (check.version !== undefined
        && (!SAFE_READINESS_TOKEN.test(check.version) || DIGEST.test(check.version)))) fail();
    return deepFreeze({ name: check.name, status: 'ready', ...(check.version === undefined
      ? {} : { version: check.version }) });
  });
  return deepFreeze({
    status: 'ready', productionReady: true, boundary: 'production-v1', checks,
  });
}

function normalizedProbe(value, { ready = false } = {}) {
  const keys = ready
    ? ['logSha256', 'readiness', 'responseSha256', 'status', 'traceSha256', 'userAgentSha256']
    : ['logSha256', 'responseSha256', 'status', 'traceSha256', 'userAgentSha256'];
  if (!exactKeys(value, keys) || value.status !== 200
    || !['logSha256', 'responseSha256', 'traceSha256', 'userAgentSha256']
      .every((key) => DIGEST.test(String(value[key] ?? '')))) fail();
  return deepFreeze({
    status: 200,
    responseSha256: value.responseSha256,
    logSha256: value.logSha256,
    traceSha256: value.traceSha256,
    userAgentSha256: value.userAgentSha256,
    ...(ready ? { readiness: normalizedReadiness(value.readiness) } : {}),
  });
}

function privacyArtifact(proof, locator, binding, observedNow) {
  validateCandidatePrivacyProof(proof, { binding, now: observedNow });
  const contents = `${JSON.stringify(proof, null, 2)}\n`;
  const reference = normalizedPrivacyLocator({
    schemaVersion: CANDIDATE_PRIVACY_SCHEMA_VERSION,
    filePath: locator.filePath,
    artifactSha256: proof.artifactSha256,
    objectSha256: sha256Bytes(contents),
    boundarySha256: proof.binding.boundarySha256,
    observedAt: proof.occurredAt,
    expiresAt: proof.expiresAt,
  });
  if (reference.boundarySha256 !== candidatePrivacyBoundarySha256(binding)
    || containsForbiddenPersistedSecret(proof)) fail();
  return deepFreeze({ filePath: locator.filePath, contents, reference });
}

export function finalizeTask8ReadinessRecord(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) fail();
  const { artifactSha256: ignored, ...payload } = record;
  void ignored;
  return deepFreeze({ ...payload, artifactSha256: canonicalSha256(payload) });
}

export function validateTask8ReadinessRecord(record, {
  binding,
  sourceArchiveSha256,
  now = new Date(),
} = {}) {
  try {
    const current = new Date(now).getTime();
    const occurredAt = Date.parse(record?.occurredAt);
    const expiresAt = Date.parse(record?.expiresAt);
    const boundarySha256 = candidatePrivacyBoundarySha256(binding);
    if (!RELEASE_SHA.test(String(binding?.releaseSha ?? ''))
      || !IMAGE_DIGEST.test(String(binding?.imageDigest ?? ''))
      || !DIGEST.test(String(sourceArchiveSha256 ?? ''))
      || !Number.isFinite(current) || !exactKeys(record, [
        'artifactSha256', 'candidateOrigin', 'candidateRevision', 'candidateService',
        'candidateTag', 'commitSha', 'controlPlane', 'expiresAt', 'gate', 'imageDigest',
        'occurredAt', 'privacyProofs', 'probes', 'readiness', 'result', 'schemaVersion',
        'sourceArchiveSha256', 'stableService', 'stableTrafficState', 'trafficPercent',
        'trafficState',
      ]) || record.schemaVersion !== SCHEMA_VERSION || record.gate !== 'readiness'
      || record.result !== 'pass' || record.commitSha !== binding.releaseSha
      || record.sourceArchiveSha256 !== sourceArchiveSha256
      || record.imageDigest !== binding.imageDigest
      || record.candidateService !== binding.candidateService
      || record.candidateRevision !== binding.candidateRevision
      || record.candidateTag !== binding.candidateTag
      || record.candidateOrigin !== binding.candidateOrigin
      || record.stableService !== GCP_IDENTITY.service
      || record.trafficState !== 'candidate-service-private-100'
      || !['stable-absent', 'stable-prior-100'].includes(record.stableTrafficState)
      || record.trafficPercent !== 100 || !Number.isFinite(occurredAt)
      || !Number.isFinite(expiresAt) || current < occurredAt - 30_000 || current >= expiresAt
      || !exactKeys(record.privacyProofs, ['end', 'start'])) fail();
    const start = normalizedPrivacyLocator(record.privacyProofs.start);
    const end = normalizedPrivacyLocator(record.privacyProofs.end);
    if (start.boundarySha256 !== boundarySha256 || end.boundarySha256 !== boundarySha256
      || start.artifactSha256 === end.artifactSha256
      || start.objectSha256 === end.objectSha256
      || Date.parse(end.observedAt) <= Date.parse(start.observedAt)
      || Date.parse(end.observedAt) - Date.parse(start.observedAt) > MAXIMUM_AGE_MS
      || record.occurredAt !== start.observedAt
      || record.expiresAt !== (Date.parse(start.expiresAt) <= Date.parse(end.expiresAt)
        ? start.expiresAt : end.expiresAt)) fail();
    if (!exactKeys(record.controlPlane, ['afterSha256', 'beforeSha256', 'stable'])
      || record.controlPlane.stable !== true
      || !DIGEST.test(String(record.controlPlane.beforeSha256 ?? ''))
      || record.controlPlane.beforeSha256 !== record.controlPlane.afterSha256
      || !exactKeys(record.probes, ['live', 'ready'])) fail();
    const live = normalizedProbe(record.probes.live);
    const ready = normalizedProbe({ ...record.probes.ready, readiness: record.readiness }, { ready: true });
    if (live.traceSha256 === ready.traceSha256
      || !exact(record.readiness, ready.readiness)
      || containsForbiddenPersistedSecret(record)
      || !exact(finalizeTask8ReadinessRecord(record), record)) fail();
    return true;
  } catch {
    fail();
  }
}

export async function runTask8Readiness({
  binding,
  evidenceContract: rawEvidenceContract,
  sourceArchiveSha256,
  executor,
  tokenExecutor,
  fetch,
  now = () => new Date(),
  nonce,
  sleep,
  privacyProofRunner = runCandidatePrivacyProof,
  controlPlaneReader = readCandidateControlPlaneSnapshot,
  healthProbeRunner = runCandidateAuthenticatedHealthProbe,
} = {}) {
  try {
    if (!DIGEST.test(String(sourceArchiveSha256 ?? '')) || typeof now !== 'function'
      || typeof privacyProofRunner !== 'function' || typeof controlPlaneReader !== 'function'
      || typeof healthProbeRunner !== 'function') fail();
    const evidenceContract = normalizedEvidenceContract(rawEvidenceContract, binding);
    const privacyArguments = { binding, executor, tokenExecutor, fetch, now, nonce, sleep };
    const startProof = await privacyProofRunner(privacyArguments);
    const startNow = now();
    if (!(startNow instanceof Date) || !Number.isFinite(startNow.getTime())) fail();
    const privacyStart = privacyArtifact(
      startProof, evidenceContract.privacyProofs.start, binding, startNow,
    );
    const before = await controlPlaneReader({ binding, executor });
    if (!exactKeys(before, ['state', 'stateSha256'])
      || !DIGEST.test(String(before.stateSha256 ?? ''))
      || canonicalSha256(before.state) !== before.stateSha256) fail();
    const live = normalizedProbe(await healthProbeRunner({
      ...privacyArguments, path: '/api/health/live',
    }));
    const readyResponse = normalizedProbe(await healthProbeRunner({
      ...privacyArguments, path: '/api/health/ready',
    }), { ready: true });
    const after = await controlPlaneReader({ binding, executor });
    if (!exactKeys(after, ['state', 'stateSha256']) || !exact(before, after)) fail();
    const endProof = await privacyProofRunner(privacyArguments);
    const endNow = now();
    if (!(endNow instanceof Date) || !Number.isFinite(endNow.getTime())) fail();
    const privacyEnd = privacyArtifact(
      endProof, evidenceContract.privacyProofs.end, binding, endNow,
    );
    if (startProof.controlPlane.beforeSha256 !== before.stateSha256
      || startProof.controlPlane.afterSha256 !== before.stateSha256
      || endProof.controlPlane.beforeSha256 !== after.stateSha256
      || endProof.controlPlane.afterSha256 !== after.stateSha256) fail();
    const privacyProofs = deepFreeze({
      start: privacyStart.reference,
      end: privacyEnd.reference,
    });
    const record = finalizeTask8ReadinessRecord({
      schemaVersion: SCHEMA_VERSION,
      gate: 'readiness',
      result: 'pass',
      occurredAt: privacyProofs.start.observedAt,
      expiresAt: Date.parse(privacyProofs.start.expiresAt) <= Date.parse(privacyProofs.end.expiresAt)
        ? privacyProofs.start.expiresAt : privacyProofs.end.expiresAt,
      commitSha: binding.releaseSha,
      sourceArchiveSha256,
      imageDigest: binding.imageDigest,
      candidateService: binding.candidateService,
      candidateRevision: binding.candidateRevision,
      candidateTag: binding.candidateTag,
      candidateOrigin: binding.candidateOrigin,
      stableService: GCP_IDENTITY.service,
      trafficState: evidenceContract.trafficState,
      stableTrafficState: evidenceContract.stableTrafficState,
      trafficPercent: 100,
      privacyProofs,
      controlPlane: {
        stable: true, beforeSha256: before.stateSha256, afterSha256: after.stateSha256,
      },
      probes: {
        live,
        ready: {
          status: readyResponse.status,
          responseSha256: readyResponse.responseSha256,
          logSha256: readyResponse.logSha256,
          traceSha256: readyResponse.traceSha256,
          userAgentSha256: readyResponse.userAgentSha256,
        },
      },
      readiness: readyResponse.readiness,
    });
    validateTask8ReadinessRecord(record, { binding, sourceArchiveSha256, now: endNow });
    const readinessContents = `${JSON.stringify(record, null, 2)}\n`;
    const evidence = deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      filePath: evidenceContract.filePath,
      artifactSha256: record.artifactSha256,
      objectSha256: sha256Bytes(readinessContents),
      candidateService: evidenceContract.candidateService,
      stableService: evidenceContract.stableService,
      trafficState: evidenceContract.trafficState,
      stableTrafficState: evidenceContract.stableTrafficState,
      privacyProofs,
    });
    return deepFreeze({
      record,
      evidence,
      artifacts: {
        privacyStart,
        privacyEnd,
        readiness: {
          filePath: evidence.filePath,
          contents: readinessContents,
          artifactSha256: evidence.artifactSha256,
          objectSha256: evidence.objectSha256,
        },
      },
    });
  } catch {
    fail();
  }
}

export const TASK8_READINESS_SCHEMA_VERSION = SCHEMA_VERSION;
export const TASK8_READINESS_COMPONENTS = READINESS_COMPONENTS;
