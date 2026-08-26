import { execFile } from 'node:child_process';
import { createHash, randomUUID as systemRandomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDefaultGcloudExecutor } from './gcp-provision.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
import { finalizeReleaseEvidenceRecord } from '../src/services/release-evidence.js';
import { finalizeEvidenceRecord } from '../src/services/voice-evidence.js';
import {
  LATENCY_ACCEPTANCE_CONTRACT,
  finalizeLatencyAcceptanceRecord,
  normalizeControlPlaneTurnReceipts,
  runLatencyAcceptance,
} from './production-latency-workload.js';

const PROJECT = GCP_IDENTITY.projectId;
const REGION = GCP_IDENTITY.region;
const STABLE_SERVICE = GCP_IDENTITY.service;
const CANDIDATE_SERVICE = GCP_IDENTITY.candidateService;
const MIGRATION_JOB = GCP_IDENTITY.jobs.migration;
const DEPENDENCY_ACCEPTANCE_JOB = GCP_IDENTITY.jobs.dependencies;
const LLM_SMOKE_JOB = GCP_IDENTITY.jobs.llm;
const ASR_SMOKE_JOB = GCP_IDENTITY.jobs.asr;
const TTS_SMOKE_JOB = GCP_IDENTITY.jobs.tts;
const REPOSITORY = GCP_IDENTITY.repository;
const MEDIA_BUCKET = GCP_IDENTITY.bucket;
const BUILD_SERVICE_ACCOUNT = `projects/${PROJECT}/serviceAccounts/${GCP_IDENTITY.serviceAccounts.build}`;
const RUNTIME_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.runtime;
const MIGRATOR_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.migrator;
const ACCEPTANCE_SERVICE_ACCOUNT = GCP_IDENTITY.serviceAccounts.acceptance;
const PROMOTION_AUTHORITY = 'admin@motionexp.com';
const OCI_SOURCE = 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack';
const INVOKER_IAM_DISABLED_ANNOTATION = 'run.googleapis.com/invoker-iam-disabled';
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const NUMERIC_VERSION = /^[1-9]\d*$/;
const PROJECT_NUMBER = /^\d{6,20}$/;
const STABLE_REVISION = /^hkbuddy-v1-api-[0-9a-f]{12}$/;
const CANDIDATE_REVISION = /^hkbuddy-v1-api-candidate-[0-9a-f]{12}$/;
const BUILD_SOURCE_PREFIX = 'source/';
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCEPTANCE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FORBIDDEN_SECRET_KEY = /^(?:authorization|proxy-authorization|cookie|set-cookie|access[_-]?token|id[_-]?token|refresh[_-]?token|token|jwt)$/i;
const FORBIDDEN_SECRET_VALUE = /(?:\bBearer\s+[A-Za-z0-9._~+/=-]{20,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@)/i;
const PHASES = Object.freeze([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate',
  'readiness', 'workload', 'mobile', 'candidate-cleanup', 'promote', 'rollback',
]);
const RECEIPT_PHASES = Object.freeze([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate',
  'readiness', 'workload', 'mobile',
]);
const MOBILE_CHECK_IDS = Object.freeze([
  'first-visit',
  'response-language-mode-change',
  'text-send',
  'editable-voice-transcript',
  'assistant-audio-ready-no-autoplay',
  'verified-official-source',
  'unsupported-honest-handoff',
  'retry-reload-retention',
  'consent',
  'clear-conversation',
  'keyboard-focus',
  'bottom-safe-area',
  'no-horizontal-overflow',
]);
const MOBILE_SCREENSHOT_IDS = Object.freeze([
  'first-visit', 'text-source', 'voice-transcript', 'mobile-safe-area',
]);
const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLOUD_BUILD_CONFIG = resolve(APP_ROOT, 'cloudbuild.yaml');
const execFileAsync = promisify(execFile);

const EVIDENCE_DEFINITIONS = Object.freeze({
  legacyInventory: Object.freeze({
    secret: GCP_IDENTITY.secrets.legacy,
    mountPath: '/var/run/secrets/hkbuddy/legacy-inventory/legacy-inventory.json',
    fileEnv: 'V1_LEGACY_RESOURCE_INVENTORY_FILE',
    versionEnv: 'V1_LEGACY_RESOURCE_INVENTORY_VERSION',
  }),
  dependencyAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.dependencies,
    mountPath: '/var/run/secrets/hkbuddy/dependency-acceptance/dependency-acceptance.json',
    fileEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE',
    versionEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION',
  }),
  llmSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.llm,
    mountPath: '/var/run/secrets/hkbuddy/llm-smoke/llm-smoke.json',
    fileEnv: 'V1_LLM_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_LLM_SMOKE_EVIDENCE_VERSION',
  }),
  asrSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.asr,
    mountPath: '/var/run/secrets/hkbuddy/asr-smoke/asr-smoke.json',
    fileEnv: 'V1_ASR_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_ASR_SMOKE_EVIDENCE_VERSION',
  }),
  ttsSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.tts,
    mountPath: '/var/run/secrets/hkbuddy/tts-smoke/tts-smoke.json',
    fileEnv: 'V1_TTS_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_TTS_SMOKE_EVIDENCE_VERSION',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.ios,
    mountPath: '/var/run/secrets/hkbuddy/ios-voice-acceptance/ios-voice-acceptance.json',
    fileEnv: 'V1_IOS_VOICE_ACCEPTANCE_FILE',
    versionEnv: 'V1_IOS_VOICE_ACCEPTANCE_VERSION',
  }),
});

function releaseContractError() {
  return new Error('GCP release contract is invalid');
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === [...expected].sort().join('\0'));
}

export function containsForbiddenPersistedSecret(value) {
  if (typeof value === 'string') return FORBIDDEN_SECRET_VALUE.test(value);
  if (Array.isArray(value)) return value.some(containsForbiddenPersistedSecret);
  if (!value || typeof value !== 'object') return false;
  return Object.entries(value).some(([key, child]) => (
    FORBIDDEN_SECRET_KEY.test(key) || containsForbiddenPersistedSecret(child)
  ));
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function exact(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function trafficContractError() {
  return new Error('Cloud Run traffic readback is invalid');
}

function exactTrafficService(value) {
  if (![STABLE_SERVICE, CANDIDATE_SERVICE].includes(value)) throw trafficContractError();
  return value;
}

function exactTrafficRevision(value, service) {
  const pattern = service === CANDIDATE_SERVICE ? CANDIDATE_REVISION : STABLE_REVISION;
  if (!pattern.test(String(value ?? ''))) throw trafficContractError();
  return value;
}

function exactTrafficPercent(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 100) throw trafficContractError();
  return value;
}

function exactCandidateTag(value, revision, service) {
  const suffix = String(revision).slice(-12);
  if (service !== CANDIDATE_SERVICE || value !== `candidate-${suffix}`) {
    throw trafficContractError();
  }
  return value;
}

function finalizeTrafficRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1) throw trafficContractError();
  const revisions = new Set();
  const tags = new Set();
  let total = 0;
  for (const row of rows) {
    if (revisions.has(row.revision)) throw trafficContractError();
    revisions.add(row.revision);
    if (row.tag !== null) {
      if (tags.has(row.tag)) throw trafficContractError();
      tags.add(row.tag);
    }
    total += row.percent;
  }
  if (total !== 100) throw trafficContractError();
  return rows.map((row) => ({ ...row })).sort((left, right) => (
    right.percent - left.percent
      || left.revision.localeCompare(right.revision)
      || String(left.tag ?? '').localeCompare(String(right.tag ?? ''))
  ));
}

export function normalizeControlledTraffic(value, { service } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  const rows = value.map((row) => {
    const tagged = exactKeys(row, ['percent', 'revisionName', 'tag']);
    if (!tagged && !exactKeys(row, ['percent', 'revisionName'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revisionName, service);
    const tag = tagged ? exactCandidateTag(row.tag, revision, service) : null;
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function normalizeInternalTraffic(value, { service } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  const rows = value.map((row) => {
    if (!exactKeys(row, ['percent', 'revision', 'tag'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revision, service);
    const tag = row.tag === null ? null : exactCandidateTag(row.tag, revision, service);
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function normalizeCloudRunV1Traffic(value, { service } = {}) {
  exactTrafficService(service);
  if (!Array.isArray(value)) throw trafficContractError();
  const rows = value.map((row) => {
    const tagged = exactKeys(row, ['percent', 'revisionName', 'tag', 'url']);
    if (!tagged && !exactKeys(row, ['percent', 'revisionName'])) throw trafficContractError();
    const revision = exactTrafficRevision(row.revisionName, service);
    const tag = tagged ? exactCandidateTag(row.tag, revision, service) : null;
    if (tagged) {
      const expectedUrl = `https://${tag}---${service}-${GCP_IDENTITY.projectNumber}.${REGION}.run.app`;
      if (row.url !== expectedUrl) throw trafficContractError();
    }
    return { revision, tag, percent: exactTrafficPercent(row.percent) };
  });
  return finalizeTrafficRows(rows);
}

export function assertExactTraffic(value, { kind, service, expected } = {}) {
  const normalize = {
    controlled: normalizeControlledTraffic,
    internal: normalizeInternalTraffic,
    'raw-v1': normalizeCloudRunV1Traffic,
  }[kind];
  if (!normalize) throw trafficContractError();
  const actualRows = normalize(value, { service });
  const expectedRows = normalizeInternalTraffic(expected, { service });
  if (!exact(actualRows, expectedRows)) throw trafficContractError();
  return true;
}

export function validateTrafficTargetAcknowledgement(value, { revision, serviceUrl } = {}) {
  const expected = [{
    displayPercent: '100%',
    displayRevisionId: revision,
    displayTags: '',
    key: revision,
    latestRevision: false,
    revisionName: revision,
    serviceUrl,
    specPercent: '100',
    specTags: '-',
    statusPercent: '100',
    statusTags: '-',
    tags: [],
    urls: [],
  }];
  if (!STABLE_REVISION.test(String(revision ?? ''))
    || serviceUrl !== `https://${STABLE_SERVICE}-${GCP_IDENTITY.projectNumber}.${REGION}.run.app`
    || !exact(value, expected)) throw trafficContractError();
  return true;
}

function canonicalSha256(value) {
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function finalizeReleasePhaseReceipt(record) {
  const { receiptSha256: ignored, ...payload } = record ?? {};
  void ignored;
  return Object.freeze({ ...payload, receiptSha256: canonicalSha256(payload) });
}

function isAbsoluteFile(value) {
  return typeof value === 'string' && value.length > 3
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
    && !/[\u0000\r\n]/.test(value);
}

function assertTask8Evidence(value, { stableTrafficState } = {}) {
  if (!exactKeys(value, ['mobile', 'readiness', 'workload'])) throw releaseContractError();
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => {
    if (!exactKeys(entry, [
      'artifactSha256', 'candidateService', 'filePath', 'objectSha256', 'schemaVersion',
      'stableService', 'stableTrafficState', 'trafficState',
    ])
      || entry.schemaVersion !== 2
      || !isAbsoluteFile(entry.filePath)
      || !DIGEST.test(String(entry.artifactSha256 ?? ''))
      || !DIGEST.test(String(entry.objectSha256 ?? ''))
      || entry.candidateService !== CANDIDATE_SERVICE
      || entry.stableService !== STABLE_SERVICE
      || entry.trafficState !== 'candidate-service-private-100'
      || entry.stableTrafficState !== stableTrafficState) throw releaseContractError();
    return [key, Object.freeze({ ...entry })];
  })));
}

async function sha256File(filePath) {
  const digest = createHash('sha256');
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => digest.update(chunk));
    stream.on('end', resolveStream);
    stream.on('error', rejectStream);
  });
  return digest.digest('hex');
}

async function verifyReleaseArchiveBytes(filePath, expectedSha256) {
  const metadata = await lstat(filePath);
  return metadata.isFile() && !metadata.isSymbolicLink() && metadata.size > 0
    && await sha256File(filePath) === expectedSha256;
}

async function gitOutput(repositoryRoot, argv) {
  const result = await execFileAsync('git', [
    '--no-optional-locks', '-C', repositoryRoot, ...argv,
  ], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1024,
  });
  return result.stdout.trim();
}

function pathIsOutside(parent, child) {
  const member = relative(parent, child);
  return member === '..' || member.startsWith(`..${sep}`);
}

export async function prepareReleaseArchive({ repositoryRoot, releaseSha, destination } = {}) {
  if (!isAbsoluteFile(repositoryRoot) || !isAbsoluteFile(destination)
    || !RELEASE_SHA.test(String(releaseSha ?? ''))
    || !/\.(?:tar\.gz|tgz)$/i.test(destination)) {
    throw new Error('Release archive requires one clean commit');
  }
  let canonicalRepository;
  let canonicalDestination;
  let intermediateTar;
  let archiveStarted = false;
  try {
    canonicalRepository = await realpath(repositoryRoot);
    const canonicalParent = await realpath(dirname(destination));
    canonicalDestination = join(canonicalParent, basename(destination));
    intermediateTar = `${canonicalDestination}.partial.tar`;
    if (!pathIsOutside(canonicalRepository, canonicalDestination)) throw new Error('inside repository');
    try {
      await lstat(canonicalDestination);
      throw new Error('destination exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    try {
      await lstat(intermediateTar);
      throw new Error('intermediate exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }

    const [head, status, commitType, commitTimestamp, trackedFiles] = await Promise.all([
      gitOutput(canonicalRepository, ['rev-parse', '--verify', 'HEAD']),
      gitOutput(canonicalRepository, ['status', '--porcelain=v1', '--untracked-files=all']),
      gitOutput(canonicalRepository, ['cat-file', '-t', releaseSha]),
      gitOutput(canonicalRepository, ['show', '-s', '--format=%ct', releaseSha]),
      gitOutput(canonicalRepository, [
        'ls-tree', '-r', '--name-only', releaseSha, '--', 'production-v1',
      ]),
    ]);
    const members = trackedFiles.split(/\r?\n/u).filter(Boolean);
    if (head !== releaseSha || status !== '' || commitType !== 'commit'
      || !members.includes('production-v1/Dockerfile')
      || !members.includes('production-v1/cloudbuild.yaml')
      || !members.includes('production-v1/data/knowledge/hkbu-v1.json')
      || !/^[1-9][0-9]{8,11}$/u.test(commitTimestamp)) {
      throw new Error('release source is not one clean production commit');
    }

    archiveStarted = true;
    await gitOutput(canonicalRepository, [
      'archive', '--format=tar', `--mtime=@${commitTimestamp}`, `--output=${intermediateTar}`,
      `${releaseSha}:production-v1`,
    ]);
    await pipeline(
      createReadStream(intermediateTar),
      createGzip({ level: 9, mtime: 0 }),
      createWriteStream(canonicalDestination, { flags: 'wx' }),
    );
    await rm(intermediateTar, { force: true });
    const [headAfter, statusAfter] = await Promise.all([
      gitOutput(canonicalRepository, ['rev-parse', '--verify', 'HEAD']),
      gitOutput(canonicalRepository, ['status', '--porcelain=v1', '--untracked-files=all']),
    ]);
    if (headAfter !== releaseSha || statusAfter !== '') {
      throw new Error('release source changed while archiving');
    }
    return Object.freeze({
      releaseSha,
      sourceArchive: canonicalDestination,
      sourceArchiveSha256: await sha256File(canonicalDestination),
    });
  } catch {
    if (archiveStarted && canonicalDestination) {
      await rm(canonicalDestination, { force: true }).catch(() => undefined);
    }
    if (archiveStarted && intermediateTar) {
      await rm(intermediateTar, { force: true }).catch(() => undefined);
    }
    throw new Error('Release archive requires one clean commit');
  }
}

function archiveCommandSelection(argv) {
  if (!Array.isArray(argv)) return null;
  const selected = {};
  let prepare = false;
  let confirmed = false;
  for (const member of argv) {
    if (member === '--prepare-archive' && !prepare) prepare = true;
    else if (typeof member === 'string' && member.startsWith('--repository-root=')
      && selected.repositoryRoot === undefined) {
      selected.repositoryRoot = member.slice('--repository-root='.length);
    } else if (typeof member === 'string' && member.startsWith('--destination=')
      && selected.destination === undefined) {
      selected.destination = member.slice('--destination='.length);
    } else if (typeof member === 'string' && member.startsWith('--release-sha=')
      && selected.releaseSha === undefined) {
      selected.releaseSha = member.slice('--release-sha='.length);
    } else if (typeof member === 'string' && member.startsWith('--confirm-archive=') && !confirmed) {
      selected.confirmationSha = member.slice('--confirm-archive='.length);
      confirmed = true;
    } else return null;
  }
  if (!prepare || !isAbsoluteFile(selected.repositoryRoot) || !isAbsoluteFile(selected.destination)
    || !RELEASE_SHA.test(String(selected.releaseSha ?? ''))
    || (confirmed && selected.confirmationSha !== selected.releaseSha)) return null;
  return { ...selected, confirmed };
}

export async function runPrepareReleaseArchive({
  argv = process.argv.slice(2),
  prepare = prepareReleaseArchive,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const selection = archiveCommandSelection(argv);
  if (!selection || typeof prepare !== 'function') {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'EXACT_ARCHIVE_CONFIRMATION_REQUIRED', mutationPerformed: false,
    });
  }
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'RELEASE_ARCHIVE_DRY_RUN', mutationPerformed: false,
      releaseSha: selection.releaseSha,
      sourceArchive: selection.destination,
    });
  }
  try {
    const result = await prepare({
      repositoryRoot: selection.repositoryRoot,
      releaseSha: selection.releaseSha,
      destination: selection.destination,
    });
    return publish(writeOutput, 0, {
      status: 'archive-complete', code: 'RELEASE_ARCHIVE_COMPLETE', mutationPerformed: true,
      releaseSha: result.releaseSha,
      sourceArchive: result.sourceArchive,
      sourceArchiveSha256: result.sourceArchiveSha256,
    });
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_ARCHIVE_FAILED', mutationPerformed: false,
      releaseSha: selection.releaseSha,
    });
  }
}

function assertEvidenceEntry(key, value) {
  const expected = EVIDENCE_DEFINITIONS[key];
  if (!expected || !exactKeys(value, [
    'artifactSha256', 'filePath', 'objectSha256', 'secret', 'secretVersion',
  ])
    || value.secret !== expected.secret
    || !NUMERIC_VERSION.test(String(value.secretVersion ?? ''))
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !isAbsoluteFile(value.filePath)) throw releaseContractError();
  return Object.freeze({ ...value });
}

function assertEvidence(evidence) {
  const keys = Object.keys(EVIDENCE_DEFINITIONS);
  if (!exactKeys(evidence, keys)) throw releaseContractError();
  return Object.freeze(Object.fromEntries(keys.map((key) => [
    key, assertEvidenceEntry(key, evidence[key]),
  ])));
}

function expectedAcceptanceObjects(releaseSha, runId) {
  return Object.freeze({
    dependencyAcceptance: `release-evidence/${releaseSha}/dependency-acceptance/${runId}.json`,
    llmSmoke: `release-evidence/${releaseSha}/llm-smoke/llm-${runId}.json`,
    asrSmoke: `release-evidence/${releaseSha}/voice-smoke/asr-${runId}.json`,
    ttsSmoke: `release-evidence/${releaseSha}/voice-smoke/tts-${runId}.json`,
  });
}

function assertAcceptanceOutputs(value, { releaseSha, runId } = {}) {
  const expectedObjects = expectedAcceptanceObjects(releaseSha, runId);
  if (!exactKeys(value, Object.keys(expectedObjects))) throw releaseContractError();
  const normalized = {};
  const filePaths = new Set();
  for (const [key, object] of Object.entries(expectedObjects)) {
    const member = value[key];
    if (!exactKeys(member, ['bucket', 'filePath', 'generation', 'object'])
      || member.bucket !== MEDIA_BUCKET
      || member.object !== object
      || !NUMERIC_VERSION.test(String(member.generation ?? ''))
      || !isAbsoluteFile(member.filePath)
      || filePaths.has(member.filePath)) throw releaseContractError();
    filePaths.add(member.filePath);
    normalized[key] = Object.freeze({ ...member });
  }
  return Object.freeze(normalized);
}

function environmentFor({ releaseSha, serviceOrigin, candidateOrigin, evidence }) {
  const environment = {
    NODE_ENV: 'production',
    V1_PUBLIC_ORIGIN: serviceOrigin,
    V1_CANDIDATE_ORIGIN: candidateOrigin,
    V1_RUNTIME_SERVICE_ACCOUNT: RUNTIME_SERVICE_ACCOUNT,
    V1_TRUST_PROXY_HOPS: '1',
    V1_STORE_DRIVER: 'postgres',
    V1_POSTGRES_RESOURCE_ID: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}`,
    V1_MEDIA_DRIVER: 'gcs',
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_GCS_BUCKET: MEDIA_BUCKET,
    V1_GCS_RESOURCE_ID: `//storage.googleapis.com/projects/_/buckets/${MEDIA_BUCKET}`,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
    V1_INSTANCE_POLICY: 'single',
    V1_PRIVACY_NOTICE_VERSION: '2026-08-26-production-v1',
    V1_PRIVACY_NOTICE_APPROVED: 'true',
    V1_RETENTION_WORKER_ENABLED: 'true',
  };
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    environment[definition.fileEnv] = definition.mountPath;
    environment[definition.versionEnv] = evidence[key].artifactSha256;
  }
  return Object.freeze(environment);
}

function secretBindings(databaseSecretVersions, evidence) {
  const environment = Object.freeze({
    V1_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
    V1_SESSION_SECRET: Object.freeze({ secret: GCP_IDENTITY.secrets.session, version: databaseSecretVersions.session }),
  });
  const mounts = {};
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    mounts[key] = Object.freeze({
      path: definition.mountPath,
      secret: definition.secret,
      version: evidence[key].secretVersion,
      readOnly: true,
    });
  }
  return Object.freeze({ environment, mounts: Object.freeze(mounts) });
}

function envFlag(environment) {
  return `--set-env-vars=${Object.entries(environment).map(([key, value]) => `${key}=${value}`).join(',')}`;
}

function secretsFlag(bindings) {
  return `--set-secrets=${[
    ...Object.entries(bindings.environment).map(([key, value]) => (
      `${key}=${value.secret}:${value.version}`
    )),
    ...Object.values(bindings.mounts).map((value) => (
      `${value.path}=${value.secret}:${value.version}`
    )),
  ].join(',')}`;
}

function operation(phase, id, argv) {
  if (!PHASES.includes(phase) || typeof id !== 'string' || !Array.isArray(argv)
    || argv.some((value) => typeof value !== 'string' || /[\u0000\r\n]/.test(value))) {
    throw releaseContractError();
  }
  return Object.freeze({ phase, id, argv: Object.freeze([...argv]) });
}

function candidateTrafficPercent() {
  return 100;
}

function candidateTrafficState() {
  return 'candidate-service-private-100';
}

function cloudRunServiceSpec({
  service, revision, releaseSha, image, environment, bindings, probes, traffic,
}) {
  const mountEntries = Object.entries(bindings.mounts).sort(([left], [right]) => left.localeCompare(right));
  const volumes = mountEntries.map(([key, value]) => {
    const separator = value.path.lastIndexOf('/');
    return {
      name: `evidence-${key.replace(/[A-Z]/g, (member) => `-${member.toLowerCase()}`)}`,
      secret: {
        secretName: value.secret,
        items: [{ key: value.version, path: value.path.slice(separator + 1) }],
      },
    };
  });
  const volumeMounts = mountEntries.map(([key, value]) => ({
    name: `evidence-${key.replace(/[A-Z]/g, (member) => `-${member.toLowerCase()}`)}`,
    mountPath: value.path.slice(0, value.path.lastIndexOf('/')),
    readOnly: true,
  }));
  const normalEnvironment = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({ name, value }));
  const secretEnvironment = Object.entries(bindings.environment).sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => ({
      name,
      valueFrom: { secretKeyRef: { name: value.secret, key: value.version } },
    }));
  const normalizeProbeForSpec = (value) => ({
    httpGet: { path: value.path, port: value.port },
    initialDelaySeconds: value.initialDelaySeconds,
    timeoutSeconds: value.timeoutSeconds,
    periodSeconds: value.periodSeconds,
    failureThreshold: value.failureThreshold,
  });
  return Object.freeze({
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: Object.freeze({
      name: service,
      annotations: Object.freeze({
        'run.googleapis.com/ingress': 'all',
        [INVOKER_IAM_DISABLED_ANNOTATION]: 'false',
      }),
    }),
    spec: Object.freeze({
      template: Object.freeze({
        metadata: Object.freeze({
          name: revision,
          labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
          annotations: Object.freeze({
            'autoscaling.knative.dev/minScale': '1',
            'autoscaling.knative.dev/maxScale': '1',
            'run.googleapis.com/cpu-throttling': 'false',
            'run.googleapis.com/startup-cpu-boost': 'true',
            'run.googleapis.com/execution-environment': 'gen2',
            'run.googleapis.com/network-interfaces': JSON.stringify([{
              network: GCP_IDENTITY.network, subnetwork: GCP_IDENTITY.subnet,
            }]),
            'run.googleapis.com/vpc-access-egress': 'private-ranges-only',
          }),
        }),
        spec: Object.freeze({
          serviceAccountName: RUNTIME_SERVICE_ACCOUNT,
          containerConcurrency: 40,
          timeoutSeconds: 60,
          containers: Object.freeze([Object.freeze({
            image,
            ports: Object.freeze([Object.freeze({ name: 'http1', containerPort: 8080 })]),
            env: Object.freeze([...normalEnvironment, ...secretEnvironment].map(Object.freeze)),
            resources: Object.freeze({ limits: Object.freeze({ cpu: '2', memory: '1Gi' }) }),
            startupProbe: Object.freeze(normalizeProbeForSpec(probes.startup)),
            livenessProbe: Object.freeze(normalizeProbeForSpec(probes.liveness)),
            readinessProbe: Object.freeze(normalizeProbeForSpec(probes.readiness)),
            volumeMounts: Object.freeze(volumeMounts.map(Object.freeze)),
          })]),
          volumes: Object.freeze(volumes.map(Object.freeze)),
        }),
      }),
      traffic: Object.freeze(traffic.map(({ revision: revisionName, tag, percent }) => Object.freeze({
        revisionName,
        ...(tag === null ? {} : { tag }),
        percent,
      }))),
    }),
  });
}

function candidateServiceSpec({
  candidateRevision, candidateTag, releaseSha, image, environment, bindings, probes,
}) {
  return cloudRunServiceSpec({
    service: CANDIDATE_SERVICE,
    revision: candidateRevision,
    releaseSha,
    image,
    environment,
    bindings,
    probes,
    traffic: [{ revision: candidateRevision, tag: candidateTag, percent: 100 }],
  });
}

function stableServiceSpec({
  stableRevision, previousRevision, releaseSha, image, environment, bindings, probes,
}) {
  return cloudRunServiceSpec({
    service: STABLE_SERVICE,
    revision: stableRevision,
    releaseSha,
    image,
    environment,
    bindings,
    probes,
    traffic: previousRevision === null
      ? [{ revision: stableRevision, tag: null, percent: 100 }]
      : [
        { revision: previousRevision, tag: null, percent: 100 },
        { revision: stableRevision, tag: null, percent: 0 },
      ],
  });
}

async function writeCandidateServiceSpecFile(plan) {
  const contents = `${JSON.stringify(plan.candidateServiceSpec, null, 2)}\n`;
  try {
    const metadata = await lstat(plan.candidateServiceSpecPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || !Buffer.from(await readFile(plan.candidateServiceSpecPath)).equals(Buffer.from(contents))) {
      throw new Error('candidate service specification drift');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(plan.candidateServiceSpecPath, contents, { encoding: 'utf8', flag: 'wx' });
  }
  return true;
}

async function writeStableServiceSpecFile(plan) {
  const contents = `${JSON.stringify(plan.stableServiceSpec, null, 2)}\n`;
  try {
    const metadata = await lstat(plan.stableServiceSpecPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || !Buffer.from(await readFile(plan.stableServiceSpecPath)).equals(Buffer.from(contents))) {
      throw new Error('stable service specification drift');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFile(plan.stableServiceSpecPath, contents, { encoding: 'utf8', flag: 'wx' });
  }
  return true;
}

function promotionIamRestorePolicyPath(plan, attemptId) {
  if (!UUID.test(String(attemptId ?? ''))) throw new Error('promotion IAM restore attempt is invalid');
  return join(dirname(plan.sourceArchive), `${plan.stableRevision}.iam-restore.${attemptId}.json`);
}

async function writePromotionIamRestorePolicyFile(plan, policy, { attemptId } = {}) {
  const filePath = promotionIamRestorePolicyPath(plan, attemptId);
  const contents = `${JSON.stringify(policy, null, 2)}\n`;
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}

async function removePromotionIamRestorePolicyFile(plan, filePath) {
  if (filePath !== promotionIamRestorePolicyPath(
    plan,
    basename(filePath).slice(`${plan.stableRevision}.iam-restore.`.length, -'.json'.length),
  )) throw new Error('promotion IAM restore policy path is invalid');
  await rm(filePath);
  try {
    await lstat(filePath);
    throw new Error('promotion IAM restore policy residue remains');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

export function buildReleasePlan(input = {}, { phase = null } = {}) {
  if (phase !== null && !PHASES.includes(phase)) throw releaseContractError();
  const unresolvedImage = phase === 'build' && input.imageDigest === null;
  const unresolvedDatabase = ['build', 'inventory', 'collect', 'evidence', 'rollback'].includes(phase)
    && input.databaseSecretVersions === null;
  const unresolvedEvidence = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'rollback'].includes(phase)
    && input.evidence === null;
  const unresolvedAcceptanceOutputs = ['build', 'migration', 'inventory', 'acceptance', 'rollback'].includes(phase)
    && input.acceptanceOutputs === null;
  if (!exactKeys(input, [
    'acceptanceOutputs', 'acceptanceRunId', 'databaseSecretVersions', 'evidence', 'imageDigest', 'legacyInventory', 'previousRevision',
    'previousImageDigest', 'projectNumber', 'releaseSha', 'sourceArchive', 'sourceArchiveSha256', 'task8Evidence',
  ])
    || !RELEASE_SHA.test(String(input.releaseSha ?? ''))
    || !ACCEPTANCE_RUN_ID.test(String(input.acceptanceRunId ?? ''))
    || !DIGEST.test(String(input.sourceArchiveSha256 ?? ''))
    || (!IMAGE_DIGEST.test(String(input.imageDigest ?? '')) && !unresolvedImage)
    || !PROJECT_NUMBER.test(String(input.projectNumber ?? ''))
    || input.projectNumber !== GCP_IDENTITY.projectNumber
    || !isAbsoluteFile(input.sourceArchive)
    || !/\.(?:tar\.gz|tgz)$/i.test(input.sourceArchive)
    || (!unresolvedDatabase && (
      !exactKeys(input.databaseSecretVersions, ['app', 'migrator', 'session'])
      || Object.values(input.databaseSecretVersions).some((value) => !NUMERIC_VERSION.test(String(value ?? '')))
    ))
    || !((input.previousRevision === null && input.previousImageDigest === null)
      || (STABLE_REVISION.test(String(input.previousRevision ?? ''))
        && IMAGE_DIGEST.test(String(input.previousImageDigest ?? ''))))
    || (!unresolvedEvidence && (input.evidence === null || input.evidence === undefined))) {
    throw releaseContractError();
  }

  const legacyInventory = assertEvidenceEntry('legacyInventory', input.legacyInventory);
  const evidence = unresolvedEvidence
    ? Object.freeze(Object.fromEntries(Object.entries(EVIDENCE_DEFINITIONS).map(([key, value]) => [
      key,
      key === 'legacyInventory' ? legacyInventory : Object.freeze({
        secret: value.secret,
        secretVersion: '1',
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
        filePath: `/unresolved/${value.secret}.json`,
      }),
    ])))
    : assertEvidence(input.evidence);
  if (!exact(evidence.legacyInventory, legacyInventory)) throw releaseContractError();
  const databaseSecretVersions = unresolvedDatabase
    ? Object.freeze({ app: '1', migrator: '1', session: '1' })
    : input.databaseSecretVersions;
  const previousRevision = input.previousRevision;
  const previousImageDigest = input.previousImageDigest;
  const releaseSha = input.releaseSha;
  const stableTrafficState = previousRevision === null ? 'stable-absent' : 'stable-prior-100';
  const task8Evidence = assertTask8Evidence(input.task8Evidence, { stableTrafficState });
  const acceptanceOutputs = unresolvedAcceptanceOutputs
    ? assertAcceptanceOutputs(Object.fromEntries(Object.entries(
      expectedAcceptanceObjects(releaseSha, input.acceptanceRunId),
    ).map(([key, object]) => [key, {
      bucket: MEDIA_BUCKET, object, generation: '1', filePath: `/unresolved/${key}.json`,
    }])), { releaseSha, runId: input.acceptanceRunId })
    : assertAcceptanceOutputs(input.acceptanceOutputs, {
      releaseSha, runId: input.acceptanceRunId,
    });
  if (!unresolvedEvidence && !unresolvedAcceptanceOutputs
    && Object.keys(acceptanceOutputs).some((key) => (
      evidence[key].filePath !== acceptanceOutputs[key].filePath
    ))) throw releaseContractError();
  const candidateSuffix = releaseSha.slice(0, 12);
  const candidateRevision = `${CANDIDATE_SERVICE}-${candidateSuffix}`;
  const stableRevision = `${STABLE_SERVICE}-${candidateSuffix}`;
  const candidateTag = `candidate-${candidateSuffix}`;
  const serviceOrigin = `https://${STABLE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateServiceOrigin = `https://${CANDIDATE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateOrigin = `https://${candidateTag}---${CANDIDATE_SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateAccess = Object.freeze({
    authenticated: true,
    audience: candidateServiceOrigin,
    issuer: 'https://accounts.google.com',
    subjectSha256: createHash('sha256').update(PROMOTION_AUTHORITY).digest('hex'),
    taggedUrl: candidateOrigin,
  });
  const effectiveImageDigest = input.imageDigest ?? `sha256:${'0'.repeat(64)}`;
  const image = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}@${effectiveImageDigest}`;
  const previousImage = previousImageDigest === null ? null
    : `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}@${previousImageDigest}`;
  const environment = environmentFor({ releaseSha, serviceOrigin, candidateOrigin, evidence });
  const bindings = secretBindings(databaseSecretVersions, evidence);
  const acceptanceRunId = input.acceptanceRunId;
  const acceptanceSchema = `v1_accept_${acceptanceRunId.replaceAll('-', '')}`;
  const acceptanceGcsPrefix = `v1-accept/${acceptanceRunId}/`;
  const acceptanceOutputObjects = expectedAcceptanceObjects(releaseSha, acceptanceRunId);
  const dependencyEvidenceOutputObject = acceptanceOutputObjects.dependencyAcceptance;
  const postgresResourceId = `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}`;
  const gcsResourceId = `//storage.googleapis.com/projects/_/buckets/${MEDIA_BUCKET}`;
  const dependencyEnvironment = Object.freeze({
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_ACCEPTANCE_CONFIRM_EPHEMERAL: 'true',
    V1_ACCEPTANCE_SCHEMA: acceptanceSchema,
    V1_ACCEPTANCE_GCS_PREFIX: acceptanceGcsPrefix,
    V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT: dependencyEvidenceOutputObject,
    V1_ACCEPTANCE_POSTGRES_RESOURCE_ID: postgresResourceId,
    V1_POSTGRES_RESOURCE_ID: postgresResourceId,
    V1_ACCEPTANCE_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_ACCEPTANCE_GCS_BUCKET: MEDIA_BUCKET,
    V1_GCS_BUCKET: MEDIA_BUCKET,
    V1_ACCEPTANCE_GCS_RESOURCE_ID: gcsResourceId,
    V1_GCS_RESOURCE_ID: gcsResourceId,
    V1_MEDIA_DRIVER: 'gcs',
    V1_LEGACY_RESOURCE_INVENTORY_FILE: EVIDENCE_DEFINITIONS.legacyInventory.mountPath,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: legacyInventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
  });
  const dependencySecrets = Object.freeze({
    environment: Object.freeze({
      V1_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbAppUrl, version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: Object.freeze({ secret: GCP_IDENTITY.secrets.dbMigratorUrl, version: databaseSecretVersions.migrator }),
    }),
    mounts: Object.freeze({
      legacyInventory: Object.freeze({
        path: EVIDENCE_DEFINITIONS.legacyInventory.mountPath,
        secret: EVIDENCE_DEFINITIONS.legacyInventory.secret,
        version: legacyInventory.secretVersion,
        readOnly: true,
      }),
    }),
  });
  const smokeEnvironment = Object.freeze({
    NODE_ENV: 'production',
    V1_RELEASE_COMMIT_SHA: releaseSha,
    V1_RELEASE_MANIFEST_FILE: '/app/release-manifest.json',
    V1_RUNTIME_SERVICE_ACCOUNT: RUNTIME_SERVICE_ACCOUNT,
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-v1-runtime-v1',
  });
  const llmSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_LLM_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_LLM_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.llmSmoke,
  });
  const asrSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_VOICE_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.asrSmoke,
  });
  const ttsSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: MEDIA_BUCKET,
    V1_VOICE_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.ttsSmoke,
  });
  const expectedJobs = Object.freeze({
    'dependency-acceptance': Object.freeze({
      project: PROJECT,
      region: REGION,
      job: DEPENDENCY_ACCEPTANCE_JOB,
      image,
      serviceAccount: ACCEPTANCE_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/real-dependencies-acceptance.js', `--release-sha=${releaseSha}`]),
      taskCount: 1,
      parallelism: 1,
      maxRetries: 0,
      timeoutSeconds: 3600,
      network: GCP_IDENTITY.network,
      subnet: GCP_IDENTITY.subnet,
      vpcEgress: 'private-ranges-only',
      environment: dependencyEnvironment,
      secretEnvironment: dependencySecrets.environment,
      secretMounts: dependencySecrets.mounts,
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'llm-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: LLM_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/provider-smoke.js', '--confirm-real-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 600,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: llmSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'asr-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: ASR_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze([
        'scripts/voice-provider-smoke.js', '--capability', 'asr',
        '--generate-asr-fixtures-with-pinned-tts', '--confirm-real-voice-provider',
        '--confirm-asr-audio-nonsensitive',
      ]),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 900,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: asrSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
    'tts-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: TTS_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/voice-provider-smoke.js', '--capability', 'tts', '--confirm-real-voice-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 900,
      network: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, vpcEgress: 'private-ranges-only',
      environment: ttsSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
      labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
    }),
  });
  const expectedMigrationJob = Object.freeze({
    project: PROJECT,
    region: REGION,
    job: MIGRATION_JOB,
    image,
    serviceAccount: MIGRATOR_SERVICE_ACCOUNT,
    command: Object.freeze(['node']),
    args: Object.freeze(['scripts/run-migrations.js']),
    taskCount: 1,
    parallelism: 1,
    maxRetries: 0,
    timeoutSeconds: 600,
    network: GCP_IDENTITY.network,
    subnet: GCP_IDENTITY.subnet,
    vpcEgress: 'private-ranges-only',
    environment: Object.freeze({}),
    secretEnvironment: Object.freeze({
      V1_DATABASE_URL: Object.freeze({
        secret: GCP_IDENTITY.secrets.dbMigratorUrl, version: databaseSecretVersions.migrator,
      }),
    }),
    secretMounts: Object.freeze({}),
    labels: Object.freeze({ 'simplify-release-sha': releaseSha }),
  });
  const probes = Object.freeze({
    startup: Object.freeze({
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 12,
    }),
    liveness: Object.freeze({
      path: '/api/health/live', port: 8080, initialDelaySeconds: 30,
      timeoutSeconds: 5, periodSeconds: 30, failureThreshold: 3,
    }),
    readiness: Object.freeze({
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 5, failureThreshold: 3,
    }),
  });
  const candidateServiceSpecPath = join(dirname(input.sourceArchive), `${candidateRevision}.service.yaml`);
  const stableServiceSpecPath = join(dirname(input.sourceArchive), `${stableRevision}.service.yaml`);
  const controlledCandidateServiceSpec = candidateServiceSpec({
    candidateRevision, candidateTag, releaseSha,
    image, environment, bindings, probes,
  });
  const controlledStableServiceSpec = stableServiceSpec({
    stableRevision, previousRevision, releaseSha,
    image, environment, bindings, probes,
  });
  const releaseIdentitySha256 = canonicalSha256({
    project: PROJECT,
    region: REGION,
    releaseSha,
    sourceArchiveSha256: input.sourceArchiveSha256,
    projectNumber: input.projectNumber,
    acceptanceRunId,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(),
    stableTrafficState,
  });
  const releaseReceiptDirectory = join(dirname(input.sourceArchive), `${releaseSha}-receipts`);
  const releaseReceiptPaths = Object.freeze(Object.fromEntries(RECEIPT_PHASES.map((receiptPhase, index) => [
    receiptPhase,
    join(releaseReceiptDirectory, `${String(index + 1).padStart(2, '0')}-${receiptPhase}.json`),
  ])));
  const jobDeployArgv = (contract) => [
    'run', 'jobs', 'deploy', contract.job, `--project=${PROJECT}`, `--region=${REGION}`,
    `--image=${contract.image}`, `--service-account=${contract.serviceAccount}`,
    `--command=${contract.command.join(',')}`, `--args=${contract.args.join(',')}`,
    `--tasks=${contract.taskCount}`, `--parallelism=${contract.parallelism}`,
    `--max-retries=${contract.maxRetries}`, `--task-timeout=${contract.timeoutSeconds}s`,
    `--network=${contract.network}`, `--subnet=${contract.subnet}`,
    `--vpc-egress=${contract.vpcEgress}`, `--labels=simplify-release-sha=${releaseSha}`,
    envFlag(contract.environment),
    Object.keys(contract.secretEnvironment).length + Object.keys(contract.secretMounts).length > 0
      ? secretsFlag({ environment: contract.secretEnvironment, mounts: contract.secretMounts })
      : '--clear-secrets',
    '--format=json',
  ];

  const operations = [
    operation('build', 'build-submit', [
      'builds', 'submit', `--config=${CLOUD_BUILD_CONFIG}`,
      `--project=${PROJECT}`, `--region=${REGION}`,
      `--service-account=${BUILD_SERVICE_ACCOUNT}`,
      `--gcs-source-staging-dir=gs://${GCP_IDENTITY.buildSourceBucket}/source`,
      `--substitutions=_RELEASE_SHA=${releaseSha},_SOURCE_SHA256=${input.sourceArchiveSha256}`,
      '--format=json', input.sourceArchive,
    ]),
    operation('build', 'build-readback', [
      'builds', 'list', `--project=${PROJECT}`, `--region=${REGION}`,
      `--filter=substitutions._RELEASE_SHA=${releaseSha} AND substitutions._SOURCE_SHA256=${input.sourceArchiveSha256}`,
      '--sort-by=~createTime', '--limit=2', '--format=json',
    ]),
    operation('migration', 'migration-deploy', [
      'run', 'jobs', 'deploy', MIGRATION_JOB, `--project=${PROJECT}`, `--region=${REGION}`,
      `--image=${image}`, `--service-account=${MIGRATOR_SERVICE_ACCOUNT}`,
      '--command=node', '--args=scripts/run-migrations.js', '--tasks=1', '--parallelism=1',
      '--max-retries=0', '--task-timeout=600s', `--network=${GCP_IDENTITY.network}`,
      `--subnet=${GCP_IDENTITY.subnet}`, '--vpc-egress=private-ranges-only',
      `--labels=simplify-release-sha=${releaseSha}`,
      `--set-secrets=V1_DATABASE_URL=${GCP_IDENTITY.secrets.dbMigratorUrl}:${databaseSecretVersions.migrator}`,
      '--format=json',
    ]),
    operation('migration', 'migration-readback', [
      'run', 'jobs', 'describe', MIGRATION_JOB, `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('migration', 'migration-execute', [
      'run', 'jobs', 'execute', MIGRATION_JOB, '--wait', `--project=${PROJECT}`,
      `--region=${REGION}`, '--format=json',
    ]),
  ];
  operations.push(
    operation('inventory', 'inventory-publish:legacyInventory', [
      'secrets', 'versions', 'add', EVIDENCE_DEFINITIONS.legacyInventory.secret,
      `--data-file=${legacyInventory.filePath}`, `--project=${PROJECT}`, '--format=json',
    ]),
    operation('inventory', 'inventory-readback:legacyInventory', [
      'secrets', 'versions', 'describe', legacyInventory.secretVersion,
      `--secret=${EVIDENCE_DEFINITIONS.legacyInventory.secret}`, `--project=${PROJECT}`, '--format=json',
    ]),
  );
  for (const [key, contract] of Object.entries(expectedJobs)) {
    operations.push(
      operation('acceptance', `${key}-deploy`, jobDeployArgv(contract)),
      operation('acceptance', `${key}-readback`, [
        'run', 'jobs', 'describe', contract.job,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('acceptance', `${key}-execute`, [
        'run', 'jobs', 'execute', contract.job, '--wait',
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    );
  }
  for (const [key, output] of Object.entries(acceptanceOutputs)) {
    const generationBoundObject = `gs://${output.bucket}/${output.object}#${output.generation}`;
    operations.push(
      operation('collect', `evidence-collect-describe:${key}`, [
        'storage', 'objects', 'describe', generationBoundObject,
        `--project=${PROJECT}`, '--format=json',
      ]),
      operation('collect', `evidence-collect-copy:${key}`, [
        'storage', 'cp', generationBoundObject, output.filePath,
        '--no-clobber', `--project=${PROJECT}`, '--format=json',
      ]),
    );
  }
  for (const [key, definition] of Object.entries(EVIDENCE_DEFINITIONS)) {
    if (key === 'legacyInventory') continue;
    operations.push(operation('evidence', `evidence-publish:${key}`, [
      'secrets', 'versions', 'add', definition.secret,
      `--data-file=${evidence[key].filePath}`, `--project=${PROJECT}`, '--format=json',
    ]));
    operations.push(operation('evidence', `evidence-readback:${key}`, [
      'secrets', 'versions', 'describe', evidence[key].secretVersion,
      `--secret=${definition.secret}`, `--project=${PROJECT}`, '--format=json',
    ]));
  }
  for (const [key, output] of Object.entries(acceptanceOutputs)) {
    operations.push(operation('evidence', `evidence-output-delete:${key}`, [
      'storage', 'rm', `gs://${output.bucket}/${output.object}#${output.generation}`,
      `--project=${PROJECT}`, '--format=json',
    ]));
  }
  operations.push(operation('evidence', 'evidence-output-zero-readback', [
    'storage', 'objects', 'list',
    `gs://${MEDIA_BUCKET}/release-evidence/${releaseSha}/**`,
    `--project=${PROJECT}`, '--format=json',
  ]));
  operations.push(
    operation('candidate', 'candidate-service-precheck', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate', 'candidate-spec-dry-run', [
      'run', 'services', 'replace', candidateServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--dry-run', '--format=json',
    ]),
    operation('candidate', 'candidate-deploy', [
      'run', 'services', 'replace', candidateServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-service-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate', 'candidate-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-private-iam-baseline-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-private-iam-grant', [
      'run', 'services', 'add-iam-policy-binding', CANDIDATE_SERVICE,
      `--member=user:${PROMOTION_AUTHORITY}`, '--role=roles/run.invoker',
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-private-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-service-precheck', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-private-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-delete', [
      'run', 'services', 'delete', CANDIDATE_SERVICE, '--quiet',
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate-cleanup', 'candidate-cleanup-absence-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-authority-readback', [
      'auth', 'list', '--filter=status:ACTIVE', '--format=json',
    ]),
    operation('promote', 'promote-candidate-service-readback', [
      'run', 'services', 'describe', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-candidate-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-candidate-iam-readback', [
      'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-candidate-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-stable-service-precheck', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    ...(previousRevision === null ? [] : [
      operation('promote', 'promote-stable-public-iam-precheck', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-prior-revision-readback', [
        'run', 'revisions', 'describe', previousRevision,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-prior-artifact-readback', [
        'artifacts', 'docker', 'images', 'describe', previousImage,
        `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
      ]),
    ]),
    operation('promote', 'promote-stable-spec-dry-run', [
      'run', 'services', 'replace', stableServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--dry-run', '--format=json',
    ]),
    operation('promote', 'promote-stable-deploy', [
      'run', 'services', 'replace', stableServiceSpecPath,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-stable-staged-readback', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('promote', 'promote-stable-revision-readback', [
      'run', 'revisions', 'describe', stableRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-stable-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    ...(previousRevision === null ? [
      operation('promote', 'promote-stable-private-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-public-service', [
        'run', 'services', 'add-iam-policy-binding', STABLE_SERVICE, '--member=allUsers',
        '--role=roles/run.invoker', `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-public-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    ] : [
      operation('promote', 'promote-traffic', [
        'run', 'services', 'update-traffic', STABLE_SERVICE,
        `--to-revisions=${stableRevision}=100`,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-readback', [
        'run', 'services', 'describe', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
      operation('promote', 'promote-public-iam-readback', [
        'run', 'services', 'get-iam-policy', STABLE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]),
    ]),
    ...(previousRevision === null ? [] : [
    operation('rollback', 'rollback-service-precheck', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('rollback', 'rollback-current-revision-readback', [
      'run', 'revisions', 'describe', stableRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-current-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-prior-revision-readback', [
      'run', 'revisions', 'describe', previousRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-prior-artifact-readback', [
      'artifacts', 'docker', 'images', 'describe', previousImage,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-public-iam-precheck', [
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-traffic', [
      'run', 'services', 'update-traffic', STABLE_SERVICE,
      `--to-revisions=${previousRevision}=100`,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-readback', [
      'run', 'services', 'describe', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('rollback', 'rollback-public-iam-readback', [
      'run', 'services', 'get-iam-policy', STABLE_SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    ]),
  );

  const revisionContract = Object.freeze({
    image,
    serviceAccount: RUNTIME_SERVICE_ACCOUNT,
    executionEnvironment: 'gen2',
    cpu: 2,
    memory: '1Gi',
    concurrency: 40,
    minInstances: 1,
    maxInstances: 1,
    cpuThrottling: false,
    startupCpuBoost: true,
    timeoutSeconds: 60,
    network: GCP_IDENTITY.network,
    subnet: GCP_IDENTITY.subnet,
    vpcEgress: 'private-ranges-only',
    environment,
    secretEnvironment: bindings.environment,
    secretMounts: bindings.mounts,
    probes,
  });
  const expectedCandidate = Object.freeze({
    project: PROJECT,
    region: REGION,
    service: CANDIDATE_SERVICE,
    invokerIamDisabled: false,
    revision: candidateRevision,
    tag: candidateTag,
    ...revisionContract,
    traffic: Object.freeze([Object.freeze({
      revision: candidateRevision, tag: candidateTag, percent: 100,
    })]),
    trafficState: candidateTrafficState(),
    access: candidateAccess,
    iam: Object.freeze({ policy: 'candidate-private' }),
  });
  const expectedStable = Object.freeze({
    project: PROJECT,
    region: REGION,
    service: STABLE_SERVICE,
    invokerIamDisabled: false,
    revision: stableRevision,
    tag: null,
    ...revisionContract,
    stagedTraffic: Object.freeze((previousRevision === null ? [
      { revision: stableRevision, tag: null, percent: 100 },
    ] : [
      { revision: previousRevision, tag: null, percent: 100 },
      { revision: stableRevision, tag: null, percent: 0 },
    ]).map(Object.freeze)),
    traffic: Object.freeze([Object.freeze({
      revision: stableRevision, tag: null, percent: 100,
    })]),
    initialTrafficState: stableTrafficState,
  });
  return Object.freeze({
    project: PROJECT,
    region: REGION,
    releaseSha,
    sourceArchive: input.sourceArchive,
    sourceArchiveSha256: input.sourceArchiveSha256,
    imageDigest: input.imageDigest,
    image,
    previousRevision,
    previousImageDigest,
    previousImage,
    candidateRevision,
    stableRevision,
    candidateTag,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    serviceOrigin,
    candidateServiceOrigin,
    candidateOrigin,
    candidateAccess,
    candidateServiceSpecPath,
    candidateServiceSpec: controlledCandidateServiceSpec,
    stableServiceSpecPath,
    stableServiceSpec: controlledStableServiceSpec,
    acceptanceRunId,
    releaseIdentitySha256,
    releaseReceiptDirectory,
    releaseReceiptPaths,
    task8Evidence,
    acceptanceOutputs,
    acceptanceEvidenceOutput: Object.freeze({
      bucket: MEDIA_BUCKET,
      object: dependencyEvidenceOutputObject,
    }),
    evidence,
    operations: Object.freeze(operations),
    expectedJobs,
    expectedMigrationJob,
    expectedCandidate,
    expectedStable,
  });
}

export function validateBuildReceipt(value, { releaseSha, sourceArchiveSha256 } = {}) {
  const imageName = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${STABLE_SERVICE}:${releaseSha}`;
  const image = value?.results?.images;
  const source = value?.sourceProvenance?.resolvedStorageSource;
  const sourceUri = exactKeys(source, ['bucket', 'generation', 'object'])
    && source.bucket === GCP_IDENTITY.buildSourceBucket
    && typeof source.object === 'string' && source.object.startsWith(BUILD_SOURCE_PREFIX)
    && source.object.length > BUILD_SOURCE_PREFIX.length
    && NUMERIC_VERSION.test(String(source.generation ?? ''))
    ? `gs://${source.bucket}/${source.object}#${source.generation}`
    : null;
  const fileHashes = value?.sourceProvenance?.fileHashes;
  const provenanceKeys = fileHashes && typeof fileHashes === 'object' && !Array.isArray(fileHashes)
    ? Object.keys(fileHashes) : [];
  const hashes = sourceUri && provenanceKeys.length === 1 && provenanceKeys[0] === sourceUri
    ? fileHashes[sourceUri]?.fileHash : null;
  let sourceHashMatches = false;
  if (Array.isArray(hashes) && hashes.length === 1
    && exactKeys(hashes[0], ['type', 'value']) && hashes[0].type === 'SHA256'
    && typeof hashes[0].value === 'string') {
    try {
      const decoded = Buffer.from(hashes[0].value, 'base64');
      sourceHashMatches = decoded.length === 32
        && decoded.toString('base64') === hashes[0].value
        && decoded.toString('hex') === sourceArchiveSha256;
    } catch { sourceHashMatches = false; }
  }
  const expectedSteps = [
    'validate-release-sha', 'dependency-security-gate', 'build',
    'verify-image-contract', 'verify-oci-labels',
  ];
  const valid = Boolean(
    RELEASE_SHA.test(String(releaseSha ?? ''))
    && DIGEST.test(String(sourceArchiveSha256 ?? ''))
    && BUILD_ID.test(String(value?.id ?? ''))
    && value.status === 'SUCCESS'
    && value.serviceAccount === BUILD_SERVICE_ACCOUNT
    && value.substitutions?._RELEASE_SHA === releaseSha
    && value.substitutions?._SOURCE_SHA256 === sourceArchiveSha256
    && value.options?.requestedVerifyOption === 'VERIFIED'
    && exact(value.options?.sourceProvenanceHash, ['SHA256'])
    && Array.isArray(value.steps)
    && exact(value.steps.map(({ id, status } = {}) => ({ id, status })), expectedSteps.map((id) => ({
      id, status: 'SUCCESS',
    })))
    && exactKeys(value.sourceProvenance, ['fileHashes', 'resolvedStorageSource'])
    && sourceHashMatches
    && Array.isArray(image) && image.length === 1
    && image[0]?.name === imageName
    && IMAGE_DIGEST.test(String(image[0]?.digest ?? ''))
  );
  if (!valid) throw new Error('Cloud Build receipt is invalid');
  return Object.freeze({
    buildId: value.id,
    releaseSha,
    sourceArchiveSha256,
    sourceProvenance: Object.freeze({ uri: sourceUri, sha256: sourceArchiveSha256 }),
    imageDigest: image[0].digest,
    provenance: 'VERIFIED',
    ociLabels: Object.freeze({
      'com.simplify.source-archive-sha256': sourceArchiveSha256,
      'org.opencontainers.image.revision': releaseSha,
      'org.opencontainers.image.source': OCI_SOURCE,
    }),
  });
}

export function validateCandidateReadback(value, plan) {
  if (!plan || !exact(value, plan.expectedCandidate)) {
    throw new Error('Cloud Run candidate readback is invalid');
  }
  return true;
}

function candidateRevisionContract(value) {
  if (!value) return null;
  return {
    revision: value.revision,
    image: value.image,
    serviceAccount: value.serviceAccount,
    executionEnvironment: value.executionEnvironment,
    cpu: value.cpu,
    memory: value.memory,
    concurrency: value.concurrency,
    minInstances: value.minInstances,
    maxInstances: value.maxInstances,
    cpuThrottling: value.cpuThrottling,
    startupCpuBoost: value.startupCpuBoost,
    timeoutSeconds: value.timeoutSeconds,
    network: value.network,
    subnet: value.subnet,
    vpcEgress: value.vpcEgress,
    environment: value.environment,
    secretEnvironment: value.secretEnvironment,
    secretMounts: value.secretMounts,
    probes: value.probes,
  };
}

function normalizeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return {
    path: value.httpGet?.path,
    port: positiveOrZeroInteger(value.httpGet?.port),
    initialDelaySeconds: positiveOrZeroInteger(value.initialDelaySeconds ?? 0),
    timeoutSeconds: positiveOrZeroInteger(value.timeoutSeconds),
    periodSeconds: positiveOrZeroInteger(value.periodSeconds),
    failureThreshold: positiveOrZeroInteger(value.failureThreshold),
  };
}

function normalizeCandidateRevision(value, expected) {
  if (exact(candidateRevisionContract(value), candidateRevisionContract(expected))) {
    return candidateRevisionContract(value);
  }
  const spec = value?.spec;
  const containers = spec?.containers;
  if (!value?.metadata || !spec || !Array.isArray(containers) || containers.length !== 1) return null;
  const container = containers[0];
  const environment = {};
  const secretEnvironment = {};
  for (const member of container.env ?? []) {
    if (typeof member?.name !== 'string') return null;
    if (typeof member.value === 'string') environment[member.name] = member.value;
    else if (member.valueFrom?.secretKeyRef?.name && member.valueFrom.secretKeyRef.key) {
      secretEnvironment[member.name] = {
        secret: member.valueFrom.secretKeyRef.name,
        version: String(member.valueFrom.secretKeyRef.key),
      };
    } else return null;
  }
  const secretMounts = {};
  const expectedMounts = Object.entries(expected.secretMounts);
  for (const mount of container.volumeMounts ?? []) {
    const volume = (spec.volumes ?? []).find(({ name } = {}) => name === mount?.name);
    const items = volume?.secret?.items;
    if (!volume?.secret?.secretName || !Array.isArray(items) || items.length !== 1
      || typeof mount?.mountPath !== 'string') return null;
    const item = items[0];
    const path = join(mount.mountPath, String(item.path ?? '')).replaceAll('\\', '/');
    const match = expectedMounts.find(([, expectedMount]) => expectedMount.path === path);
    if (!match || !item.key) return null;
    secretMounts[match[0]] = {
      path,
      secret: volume.secret.secretName,
      version: String(item.key),
      readOnly: mount.readOnly !== false,
    };
  }
  const annotations = value.metadata.annotations ?? {};
  let networkInterfaces;
  try { networkInterfaces = JSON.parse(annotations['run.googleapis.com/network-interfaces']); } catch { return null; }
  const network = Array.isArray(networkInterfaces) && networkInterfaces.length === 1
    ? networkInterfaces[0] : null;
  return {
    revision: value.metadata.name,
    image: container.image,
    serviceAccount: spec.serviceAccountName,
    executionEnvironment: annotations['run.googleapis.com/execution-environment'],
    cpu: positiveOrZeroInteger(container.resources?.limits?.cpu),
    memory: container.resources?.limits?.memory,
    concurrency: positiveOrZeroInteger(spec.containerConcurrency),
    minInstances: positiveOrZeroInteger(annotations['autoscaling.knative.dev/minScale']),
    maxInstances: positiveOrZeroInteger(annotations['autoscaling.knative.dev/maxScale']),
    cpuThrottling: annotations['run.googleapis.com/cpu-throttling'] === 'true',
    startupCpuBoost: annotations['run.googleapis.com/startup-cpu-boost'] === 'true',
    timeoutSeconds: nonnegativeInteger(spec.timeoutSeconds),
    network: network?.network,
    subnet: network?.subnetwork,
    vpcEgress: annotations['run.googleapis.com/vpc-access-egress'],
    environment,
    secretEnvironment,
    secretMounts,
    probes: {
      startup: normalizeProbe(container.startupProbe),
      liveness: normalizeProbe(container.livenessProbe),
      readiness: normalizeProbe(container.readinessProbe),
    },
  };
}

function validateCandidateServiceSpecDryRun(value, plan) {
  const template = value?.spec?.template;
  const normalizedService = normalizeControlledServiceSpec(value);
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || !template || normalizedService?.service !== CANDIDATE_SERVICE
    || value?.metadata?.annotations?.[INVOKER_IAM_DISABLED_ANNOTATION] !== 'false'
    || !exact(normalizedService.traffic, [{
      revision: plan.candidateRevision,
      tag: plan.candidateTag,
      percent: 100,
    }])
    || !exact(
      normalizeCandidateRevision({ metadata: template.metadata, spec: template.spec }, plan.expectedCandidate),
      candidateRevisionContract(plan.expectedCandidate),
    )) {
    throw new Error('Cloud Run candidate Service dry-run is invalid');
  }
  return true;
}

function validateStableServiceSpecDryRun(value, plan) {
  const template = value?.spec?.template;
  const normalizedService = normalizeControlledServiceSpec(value);
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || !template || normalizedService?.service !== STABLE_SERVICE
    || value?.metadata?.annotations?.[INVOKER_IAM_DISABLED_ANNOTATION] !== 'false'
    || !exact(normalizedService.traffic, plan.expectedStable.stagedTraffic)
    || !exact(
      normalizeCandidateRevision({ metadata: template.metadata, spec: template.spec }, plan.expectedStable),
      candidateRevisionContract(plan.expectedStable),
    )) {
    throw new Error('Cloud Run stable Service dry-run is invalid');
  }
  return true;
}

function normalizeControlledServiceSpec(value) {
  if (value?.apiVersion !== 'serving.knative.dev/v1' || value?.kind !== 'Service'
    || typeof value?.metadata?.name !== 'string' || !Array.isArray(value?.spec?.traffic)
    || value.metadata.annotations?.[INVOKER_IAM_DISABLED_ANNOTATION] !== 'false') return null;
  try {
    return {
      service: value.metadata.name,
      invokerIamDisabled: false,
      traffic: normalizeControlledTraffic(value.spec.traffic, { service: value.metadata.name }),
    };
  } catch { return null; }
}

function normalizeCandidateService(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const direct = typeof value.service === 'string' && Array.isArray(value.traffic);
  const rawTraffic = value?.status?.traffic;
  const raw = value?.apiVersion === 'serving.knative.dev/v1' && value?.kind === 'Service'
    && typeof value?.metadata?.name === 'string' && Array.isArray(rawTraffic);
  if (direct === raw) return null;
  const service = direct ? value.service : value.metadata.name;
  const metadata = value?.metadata;
  const annotationsDefined = metadata && Object.hasOwn(metadata, 'annotations');
  const serviceAnnotations = metadata?.annotations;
  const annotationsPrototype = serviceAnnotations !== null
    && typeof serviceAnnotations === 'object'
    ? Object.getPrototypeOf(serviceAnnotations)
    : undefined;
  const annotationsValid = !annotationsDefined || (serviceAnnotations !== null
    && typeof serviceAnnotations === 'object' && !Array.isArray(serviceAnnotations)
    && (annotationsPrototype === Object.prototype || annotationsPrototype === null));
  if (!direct && !annotationsValid) return null;
  const rawAnnotationPresent = annotationsValid && annotationsDefined
    && Object.hasOwn(serviceAnnotations, INVOKER_IAM_DISABLED_ANNOTATION);
  let invokerIamDisabled;
  if (direct) {
    if (rawAnnotationPresent || !Object.hasOwn(value, 'invokerIamDisabled')
      || value.invokerIamDisabled !== false) return null;
    invokerIamDisabled = false;
  } else {
    if (rawAnnotationPresent) {
      const annotation = serviceAnnotations[INVOKER_IAM_DISABLED_ANNOTATION];
      if (typeof annotation !== 'string' || annotation !== annotation.trim()
        || annotation.toLowerCase() !== 'false') return null;
    }
    invokerIamDisabled = false;
  }
  try {
    return {
      service,
      invokerIamDisabled,
      traffic: direct
        ? normalizeInternalTraffic(value.traffic, { service })
        : normalizeCloudRunV1Traffic(rawTraffic, { service }),
    };
  } catch { return null; }
}

function validateCandidateService(value, expected) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== expected.service
    || normalized.invokerIamDisabled !== false) {
    throw new Error('Cloud Run candidate service readback is invalid');
  }
  if (!exact(normalized.traffic, expected.traffic)) {
    throw new Error('Cloud Run candidate service readback is invalid');
  }
  return true;
}

function validateStableStagedService(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false
    || !exact(normalized.traffic, plan.expectedStable.stagedTraffic)
    || normalized.traffic.some(({ tag }) => tag !== null)) {
    throw new Error('Cloud Run staged stable service readback is invalid');
  }
  return true;
}

function validateStableRevisionReadback(value, plan) {
  if (!exact(normalizeCandidateRevision(value, plan.expectedStable),
    candidateRevisionContract(plan.expectedStable))) {
    throw new Error('Cloud Run stable revision readback is invalid');
  }
  return true;
}

function validateStableService(value, { previousRevision } = {}) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false) {
    throw new Error('Cloud Run stable service readback is invalid');
  }
  if (!exact(normalized.traffic, [{ revision: previousRevision, tag: null, percent: 100 }])) {
    throw new Error('Cloud Run stable service readback is invalid');
  }
  return true;
}

function validateCandidateCleanupService(value, plan) {
  validateStableService(value, plan);
  return true;
}

function validatePromotedService(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE
    || normalized.invokerIamDisabled !== false) {
    throw new Error('Cloud Run promotion service readback is invalid');
  }
  validateTrafficReceipt(value, { revision: plan.stableRevision });
  if (normalized.traffic.some(({ tag }) => tag !== null)) {
    throw new Error('Cloud Run promotion tag cleanup readback is invalid');
  }
  return true;
}

function validatePromotionCompensationSource(value, plan) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== STABLE_SERVICE || normalized.traffic.length < 1
    || normalized.traffic.length > 2 || normalized.invokerIamDisabled !== false) {
    throw new Error('Cloud Run promotion compensation source is invalid');
  }
  if (plan.previousRevision === null) {
    if (!exact(normalized.traffic, [{
      revision: plan.stableRevision,
      tag: null,
      percent: 100,
    }])) {
      throw new Error('Cloud Run promotion compensation source is invalid');
    }
    return true;
  }
  const seenRevisions = new Set();
  let routedRevision = null;
  for (const member of normalized.traffic) {
    if (![plan.previousRevision, plan.stableRevision].includes(member.revision)
      || member.tag !== null
      || ![0, 100].includes(member.percent) || seenRevisions.has(member.revision)) {
      throw new Error('Cloud Run promotion compensation source is invalid');
    }
    seenRevisions.add(member.revision);
    if (member.percent === 100) {
      if (routedRevision !== null) throw new Error('Cloud Run promotion compensation source is invalid');
      routedRevision = member.revision;
    }
  }
  if (![plan.previousRevision, plan.stableRevision].includes(routedRevision)) {
    throw new Error('Cloud Run promotion compensation source is invalid');
  }
  return true;
}

function validateCandidateRevisionReadback(value, plan) {
  if (!exact(normalizeCandidateRevision(value, plan.expectedCandidate),
    candidateRevisionContract(plan.expectedCandidate))) {
    throw new Error('Cloud Run candidate revision readback is invalid');
  }
  return true;
}

function validateCandidateArtifact(value, expectedImage) {
  const image = value?.image ?? value?.image_summary?.fully_qualified_digest
    ?? value?.imageSummary?.fullyQualifiedDigest;
  const digest = value?.digest ?? value?.image_summary?.digest ?? value?.imageSummary?.digest;
  if (image !== expectedImage && !(digest && expectedImage.endsWith(`@${digest}`))) {
    throw new Error('Artifact Registry image readback is invalid');
  }
  return true;
}

function validatePriorRevisionReadback(value, plan) {
  const revision = value?.revision ?? value?.metadata?.name;
  const image = value?.image ?? value?.spec?.containers?.[0]?.image;
  if (plan.previousRevision === null || plan.previousImage === null
    || !STABLE_REVISION.test(String(revision ?? ''))
    || revision !== plan.previousRevision || image !== plan.previousImage) {
    throw new Error('Cloud Run prior revision readback is invalid');
  }
  return true;
}

function validateRecoveryPrecheck(value, plan, phase) {
  if (phase === 'candidate-cleanup') {
    return validateCandidateService(value, plan.expectedCandidate);
  }
  if (phase === 'rollback') return validatePromotedService(value, plan);
  throw new Error('Cloud Run recovery precheck is invalid');
}

export function validateCandidateControlPlaneReadbacks(value, plan) {
  if (!exactKeys(value, ['artifact', 'iam', 'revision', 'service']) || !plan?.expectedCandidate) {
    throw new Error('Cloud Run candidate control-plane readback is invalid');
  }
  const expected = plan.expectedCandidate;
  validateCandidateService(value.service, expected);
  if (!exact(normalizeCandidateRevision(value.revision, expected), candidateRevisionContract(expected))) {
    throw new Error('Cloud Run candidate revision readback is invalid');
  }
  validateServiceIamReceipt(value.iam, { policy: 'candidate-private' });
  validateCandidateArtifact(value.artifact, expected.image);
  return true;
}

function normalizeServiceIamPolicy(value, { requireEtag = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['bindings', 'etag', 'version'].includes(key))) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const bindings = value?.bindings ?? [];
  if (!Array.isArray(bindings)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const normalizedBindings = bindings.map((binding = {}) => {
    const allowedKeys = binding.condition === undefined
      ? ['members', 'role'] : ['condition', 'members', 'role'];
    const { condition, members, role } = binding;
    const conditionValid = condition === undefined || (
      condition && typeof condition === 'object' && !Array.isArray(condition)
      && Object.keys(condition).length > 0
      && Object.keys(condition).every((key) => ['description', 'expression', 'title'].includes(key))
      && Object.values(condition).every((member) => typeof member === 'string' && member.length > 0)
    );
    if (!exactKeys(binding, allowedKeys) || typeof role !== 'string' || role.length === 0
      || !Array.isArray(members) || members.length === 0
      || members.some((member) => typeof member !== 'string' || member.length === 0)
      || new Set(members).size !== members.length || !conditionValid) {
      throw new Error('Cloud Run service IAM readback is invalid');
    }
    return {
      role,
      members: [...members].sort(),
      ...(condition === undefined ? {} : { condition: canonical(condition) }),
    };
  }).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  if (new Set(normalizedBindings.map((binding) => JSON.stringify(binding))).size !== normalizedBindings.length) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const etag = value.etag ?? null;
  const version = value.version ?? null;
  if ((etag !== null && (typeof etag !== 'string' || etag.length === 0 || etag.length > 512))
    || (requireEtag && etag === null)
    || (version !== null && (!Number.isSafeInteger(version) || version < 0 || version > 3))) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  return Object.freeze({ bindings: Object.freeze(normalizedBindings), etag, version });
}

function iamPolicyState(value) {
  const normalized = value?.bindings ? value : normalizeServiceIamPolicy(value);
  return { bindings: normalized.bindings, version: normalized.version };
}

function publicIamPolicyState(privatePolicy) {
  const state = structuredClone(iamPolicyState(privatePolicy));
  let invoker = state.bindings.find((binding) => (
    binding.role === 'roles/run.invoker' && binding.condition === undefined
  ));
  if (!invoker) {
    invoker = { role: 'roles/run.invoker', members: [] };
    state.bindings.push(invoker);
  }
  invoker.members = [...invoker.members, 'allUsers'].sort();
  state.bindings.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return state;
}

function validateIamPolicyState(value, expected, { requireEtag = true } = {}) {
  const normalized = normalizeServiceIamPolicy(value, { requireEtag });
  if (!exact(iamPolicyState(normalized), expected)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  return normalized;
}

export function validateServiceIamReceipt(value, {
  policy = null, publicInvoker = null, requireEtag = false,
} = {}) {
  if (policy !== null && ![
    'candidate-private', 'stable-private', 'stable-public',
  ].includes(policy)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const normalized = normalizeServiceIamPolicy(value, { requireEtag });
  if (policy !== null) {
    const expectedBindings = {
      'candidate-private': [{
        role: 'roles/run.invoker', members: [`user:${PROMOTION_AUTHORITY}`],
      }],
      'stable-private': [],
      'stable-public': [{ role: 'roles/run.invoker', members: ['allUsers'] }],
    }[policy];
    if (!exact(normalized.bindings, expectedBindings)) {
      throw new Error('Cloud Run service IAM readback is invalid');
    }
    return true;
  }
  if (![true, false].includes(publicInvoker)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const publicMembers = normalized.bindings.flatMap((binding) => binding.members.map((member) => ({
    member, role: binding.role, conditioned: binding.condition !== undefined,
  }))).filter(({ member }) => member === 'allUsers' || member === 'allAuthenticatedUsers');
  const valid = publicInvoker
    ? publicMembers.length === 1 && publicMembers[0].member === 'allUsers'
      && publicMembers[0].role === 'roles/run.invoker' && publicMembers[0].conditioned === false
    : publicMembers.length === 0;
  if (!valid) throw new Error('Cloud Run service IAM readback is invalid');
  return true;
}

export function validateTrafficReceipt(value, { revision } = {}) {
  if (!(STABLE_REVISION.test(String(revision ?? ''))
    || CANDIDATE_REVISION.test(String(revision ?? '')))) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  const normalized = normalizeCandidateService(value);
  const service = CANDIDATE_REVISION.test(revision) ? CANDIDATE_SERVICE : STABLE_SERVICE;
  const tag = service === CANDIDATE_SERVICE ? `candidate-${revision.slice(-12)}` : null;
  if (!normalized || normalized.service !== service
    || !exact(normalized.traffic, [{ revision, tag, percent: 100 }])) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  return true;
}

function positiveOrZeroInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function nonnegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeV1JobReadback(value) {
  const jobSpec = value?.spec?.template?.spec;
  const taskSpec = jobSpec?.template?.spec;
  const containers = taskSpec?.containers;
  if (!value?.metadata || !jobSpec || !taskSpec || !Array.isArray(containers)
    || containers.length !== 1) return null;
  const container = containers[0];
  const environment = {};
  const secretEnvironment = {};
  for (const member of container.env ?? []) {
    if (typeof member?.name !== 'string') return null;
    if (typeof member.value === 'string') environment[member.name] = member.value;
    else if (member.valueFrom?.secretKeyRef?.name && member.valueFrom.secretKeyRef.key) {
      secretEnvironment[member.name] = {
        secret: member.valueFrom.secretKeyRef.name,
        version: String(member.valueFrom.secretKeyRef.key),
      };
    } else return null;
  }
  const secretMounts = {};
  for (const mount of container.volumeMounts ?? []) {
    const volume = (taskSpec.volumes ?? []).find(({ name } = {}) => name === mount?.name);
    const items = volume?.secret?.items;
    if (!volume?.secret?.secretName || !Array.isArray(items) || items.length !== 1
      || !items[0]?.key || typeof items[0]?.path !== 'string'
      || typeof mount?.mountPath !== 'string') return null;
    const item = items[0];
    const path = join(mount.mountPath, item.path).replaceAll('\\', '/');
    const key = path.endsWith('/legacy-inventory.json') ? 'legacyInventory' : mount.name;
    secretMounts[key] = {
      path,
      secret: volume.secret.secretName,
      version: String(item.key),
      readOnly: mount.readOnly !== false,
    };
  }
  const annotations = value.spec?.template?.metadata?.annotations ?? value.metadata.annotations ?? {};
  let networkInterfaces;
  try { networkInterfaces = JSON.parse(annotations['run.googleapis.com/network-interfaces']); } catch { return null; }
  const network = Array.isArray(networkInterfaces) && networkInterfaces.length === 1
    ? networkInterfaces[0] : null;
  const timeoutSeconds = positiveOrZeroInteger(String(taskSpec.timeoutSeconds ?? '').replace(/s$/u, ''));
  return {
    project: PROJECT,
    region: REGION,
    job: value.metadata.name,
    image: container.image,
    serviceAccount: taskSpec.serviceAccountName,
    command: container.command ?? [],
    args: container.args ?? [],
    taskCount: positiveOrZeroInteger(jobSpec.taskCount),
    parallelism: positiveOrZeroInteger(jobSpec.parallelism),
    maxRetries: positiveOrZeroInteger(taskSpec.maxRetries),
    timeoutSeconds,
    network: network?.network,
    subnet: network?.subnetwork,
    vpcEgress: annotations['run.googleapis.com/vpc-access-egress'],
    environment,
    secretEnvironment,
    secretMounts,
    labels: { 'simplify-release-sha': value.metadata.labels?.['simplify-release-sha'] },
  };
}

export function validateReleaseJobReadback(value, expected) {
  const normalized = exact(value, expected) ? value : normalizeV1JobReadback(value);
  if (!expected || !exact(normalized, expected)) {
    throw new Error('Cloud Run release Job readback is invalid');
  }
  return true;
}

export function validateMigrationExecutionReceipt(value, { releaseSha } = {}) {
  const name = value?.metadata?.name;
  const job = value?.metadata?.labels?.['run.googleapis.com/job'];
  const status = value?.status;
  const taskCount = nonnegativeInteger(value?.spec?.taskCount);
  const parallelism = nonnegativeInteger(value?.spec?.parallelism);
  const completed = Array.isArray(status?.conditions)
    ? status.conditions.filter(({ type } = {}) => type === 'Completed') : [];
  const completionTime = status?.completionTime;
  const validName = job === MIGRATION_JOB && typeof name === 'string'
    && new RegExp(`^${MIGRATION_JOB}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`).test(name);
  if (!RELEASE_SHA.test(String(releaseSha ?? ''))
    || value?.apiVersion !== 'run.googleapis.com/v1' || value?.kind !== 'Execution'
    || !validName || taskCount !== 1 || parallelism !== 1
    || nonnegativeInteger(status?.succeededCount) !== 1
    || nonnegativeInteger(status?.failedCount ?? 0) !== 0
    || nonnegativeInteger(status?.cancelledCount ?? 0) !== 0
    || nonnegativeInteger(status?.retriedCount ?? 0) !== 0
    || nonnegativeInteger(status?.runningCount ?? 0) !== 0
    || completed.length !== 1 || completed[0]?.status !== 'True'
    || typeof completionTime !== 'string' || !Number.isFinite(Date.parse(completionTime))) {
    throw new Error('Cloud Run migration execution receipt is invalid');
  }
  return Object.freeze({
    name, job: MIGRATION_JOB, taskCount: 1, parallelism: 1,
    succeededCount: 1, completionTime,
  });
}

export function validateEvidenceVersionReceipt(value, { secret, secretVersion } = {}) {
  const expectedName = `projects/${PROJECT}/secrets/${secret}/versions/${secretVersion}`;
  if (typeof secret !== 'string' || !NUMERIC_VERSION.test(String(secretVersion ?? ''))
    || !value || typeof value !== 'object' || Array.isArray(value)
    || value.name !== expectedName || value.state !== 'ENABLED') {
    throw new Error('Evidence version receipt is invalid');
  }
  return true;
}

function semanticEvidenceFinalizer(kind) {
  return ['asrSmoke', 'ttsSmoke', 'iosVoiceAcceptance'].includes(kind)
    ? finalizeEvidenceRecord : finalizeReleaseEvidenceRecord;
}

export async function validateEvidenceArtifactFile(value, { releaseSha, kind = null } = {}) {
  if (!exactKeys(value, ['artifactSha256', 'filePath', 'objectSha256'])
    || !isAbsoluteFile(value.filePath)
    || !DIGEST.test(String(value.artifactSha256 ?? ''))
    || !DIGEST.test(String(value.objectSha256 ?? ''))
    || !RELEASE_SHA.test(String(releaseSha ?? ''))) {
    throw new Error('Evidence artifact file is invalid');
  }
  let metadata;
  let contents;
  try {
    metadata = await lstat(value.filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > 1024 * 1024) throw new Error('invalid size');
    contents = await readFile(value.filePath);
  } catch { throw new Error('Evidence artifact file is invalid'); }
  const textValue = contents.toString('utf8');
  if (!Buffer.from(textValue, 'utf8').equals(contents)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(textValue)
    || createHash('sha256').update(contents).digest('hex') !== value.objectSha256) {
    throw new Error('Evidence artifact file is invalid');
  }
  let record;
  try { record = JSON.parse(textValue); } catch { throw new Error('Evidence artifact file is invalid'); }
  if (containsForbiddenPersistedSecret(record)) throw new Error('Evidence artifact file is invalid');
  let semanticDigest;
  try { semanticDigest = semanticEvidenceFinalizer(kind)(record).artifactSha256; } catch {
    throw new Error('Evidence artifact file is invalid');
  }
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.commitSha !== releaseSha
    || record.artifactSha256 !== value.artifactSha256
    || semanticDigest !== value.artifactSha256) {
    throw new Error('Evidence artifact file is invalid');
  }
  return Object.freeze({
    artifactSha256: value.artifactSha256,
    objectSha256: value.objectSha256,
    byteLength: contents.length,
  });
}

export function validateAcceptanceObjectReceipt(value, output) {
  const size = Number(value?.size);
  if (!exactKeys(output, ['bucket', 'filePath', 'generation', 'object'])
    || value?.bucket !== output.bucket
    || value?.name !== output.object
    || String(value?.generation ?? '') !== output.generation
    || !Number.isSafeInteger(size) || size < 2 || size > 1024 * 1024
    || (value?.contentType !== undefined && value.contentType !== 'application/json')
    || (Array.isArray(value?.acl) && value.acl.some(({ entity } = {}) => (
      entity === 'allUsers' || entity === 'allAuthenticatedUsers'
    )))) {
    throw new Error('Acceptance evidence object receipt is invalid');
  }
  return Object.freeze({
    bucket: output.bucket,
    object: output.object,
    generation: output.generation,
    size,
  });
}

export async function inspectCollectedEvidenceArtifact(filePath, { releaseSha, kind = null } = {}) {
  if (!isAbsoluteFile(filePath) || !RELEASE_SHA.test(String(releaseSha ?? ''))) {
    throw new Error('Collected evidence artifact is invalid');
  }
  let contents;
  let metadata;
  try {
    metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()
      || metadata.size < 2 || metadata.size > 1024 * 1024) throw new Error('invalid file');
    contents = await readFile(filePath);
  } catch { throw new Error('Collected evidence artifact is invalid'); }
  const textValue = contents.toString('utf8');
  if (!Buffer.from(textValue, 'utf8').equals(contents)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(textValue)) {
    throw new Error('Collected evidence artifact is invalid');
  }
  let record;
  try { record = JSON.parse(textValue); } catch { throw new Error('Collected evidence artifact is invalid'); }
  if (containsForbiddenPersistedSecret(record)) throw new Error('Collected evidence artifact is invalid');
  const artifactSha256 = record?.artifactSha256;
  const objectSha256 = createHash('sha256').update(contents).digest('hex');
  const expectedCapabilities = {
    llmSmoke: 'llm', asrSmoke: 'asr', ttsSmoke: 'tts',
  };
  const validKind = kind === null
    || (kind === 'dependencyAcceptance' && record?.result === true)
    || (Object.hasOwn(expectedCapabilities, kind)
      && record?.result === 'pass' && record?.capability === expectedCapabilities[kind]);
  if (!DIGEST.test(String(artifactSha256 ?? '')) || record?.commitSha !== releaseSha
    || ![1, 2].includes(record?.schemaVersion) || !validKind) {
    throw new Error('Collected evidence artifact is invalid');
  }
  await validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256,
  }, { releaseSha, kind });
  return Object.freeze({ filePath, artifactSha256, objectSha256, byteLength: contents.length });
}

async function validateEvidenceArtifactSet(evidence, { releaseSha } = {}) {
  for (const [kind, value] of Object.entries(evidence)) {
    await validateEvidenceArtifactFile({
      filePath: value.filePath,
      artifactSha256: value.artifactSha256,
      objectSha256: value.objectSha256,
    }, { releaseSha, kind });
  }
  return true;
}

function recentEvidenceTime(value, now, maximumAgeMs = 24 * 60 * 60_000) {
  const observed = Date.parse(value);
  const current = new Date(now).getTime();
  return Number.isFinite(observed) && Number.isFinite(current)
    && observed <= current + 5 * 60_000 && current - observed <= maximumAgeMs;
}

function validateLatencyMetric(value, expected) {
  const hasP50 = expected.p50ThresholdMs !== undefined;
  const keys = hasP50
    ? ['p50Ms', 'p50ThresholdMs', 'p95Ms', 'p95ThresholdMs', 'pass', 'sampleCount']
    : ['p95Ms', 'p95ThresholdMs', 'pass', 'sampleCount'];
  return exactKeys(value, keys)
    && value.sampleCount === expected.sampleCount
    && value.p95ThresholdMs === expected.p95ThresholdMs
    && Number.isFinite(value.p95Ms) && value.p95Ms >= 0
    && value.p95Ms <= value.p95ThresholdMs
    && value.pass === true
    && (!hasP50 || (
      value.p50ThresholdMs === expected.p50ThresholdMs
      && Number.isFinite(value.p50Ms) && value.p50Ms >= 0
      && value.p50Ms <= value.p95Ms && value.p50Ms <= value.p50ThresholdMs
    ));
}

function validateLatencyObservation(value, expectedSampleCount) {
  return exactKeys(value, ['available', 'p50Ms', 'p95Ms', 'sampleCount'])
    && value.available === true && value.sampleCount === expectedSampleCount
    && Number.isFinite(value.p50Ms) && value.p50Ms >= 0
    && Number.isFinite(value.p95Ms) && value.p95Ms >= value.p50Ms;
}

function rawNearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(percentile * sorted.length) - 1)];
}

function rawLatencyMetric(values, expectedCount, { p50 = null, p95 }) {
  const safe = values.filter((value) => Number.isFinite(value) && value >= 0);
  const p50Ms = rawNearestRank(safe, 0.5);
  const p95Ms = rawNearestRank(safe, 0.95);
  return {
    sampleCount: safe.length,
    ...(p50 === null ? {} : { p50Ms, p50ThresholdMs: p50 }),
    p95Ms,
    p95ThresholdMs: p95,
    pass: safe.length === expectedCount && p95Ms !== null && p95Ms <= p95
      && (p50 === null || (p50Ms !== null && p50Ms <= p50)),
  };
}

function rawTimingObservation(samples, operation, layer, expectedCount) {
  const values = samples.filter((sample) => (
    sample.operation === operation && sample.layer === layer && sample.outcome === 'success'
  )).map(({ latencyMs }) => latencyMs);
  return {
    available: values.length === expectedCount,
    sampleCount: values.length,
    p50Ms: rawNearestRank(values, 0.5),
    p95Ms: rawNearestRank(values, 0.95),
  };
}

function validateRawLatencyReceipts(record, plan) {
  const raw = record?.rawReceipts;
  if (!exactKeys(raw, [
    'acceptanceWindowId', 'asrRequests', 'controlPlaneRequests', 'receiptsSha256',
    'candidateService', 'schemaVersion', 'stableService', 'stableTrafficState',
    'textTurns', 'timingQueries', 'trafficState', 'ttsRequests',
  ]) || raw.schemaVersion !== 2 || !DIGEST.test(String(raw.acceptanceWindowId ?? ''))
    || raw.candidateService !== CANDIDATE_SERVICE || raw.stableService !== STABLE_SERVICE
    || raw.trafficState !== candidateTrafficState(plan)
    || raw.stableTrafficState !== plan.expectedStable.initialTrafficState
    || !DIGEST.test(String(raw.receiptsSha256 ?? ''))) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const { receiptsSha256: ignored, ...rawPayload } = raw;
  void ignored;
  if (canonicalSha256(rawPayload) !== raw.receiptsSha256
    || !Array.isArray(raw.textTurns) || raw.textTurns.length !== 200
    || !Array.isArray(raw.asrRequests) || raw.asrRequests.length !== 30
    || !Array.isArray(raw.ttsRequests) || raw.ttsRequests.length !== 31
    || !Array.isArray(raw.timingQueries) || raw.timingQueries.length !== 20
    || !Array.isArray(raw.controlPlaneRequests) || raw.controlPlaneRequests.length !== 200) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const textKeys = [
    'ackMs', 'acknowledged', 'assistantMessageId', 'clientMessageId', 'controlledTtsFailure',
    'correlationId', 'delivered', 'duplicateAssistantReplyCount', 'finalAnswerMs',
    'groundingEvidenceSha256', 'groundingSatisfied', 'groundingVerified', 'messageLost',
    'processingVisible', 'processingVisibleMs', 'promptClass', 'replyLanguage', 'replyMode',
    'requestId', 'requestStatus', 'responseRequestId', 'responseStatus', 'sequence',
    'sessionIdSha256', 'sessionIndex', 'traceId', 'turnIndex', 'unsupportedVerifiedClaimCount',
  ];
  const uuids = new Set();
  const traceIds = new Set();
  const assistantIds = new Set();
  const sessionHashes = new Map();
  for (const [index, turn] of raw.textTurns.entries()) {
    const sessionIndex = Math.floor(index / 10);
    const turnIndex = index % 10;
    const expectedClass = turnIndex < 4 ? 'grounded' : (turnIndex < 7 ? 'abstention' : 'casual');
    const expectedMode = turnIndex === 0 || (turnIndex === 1 && sessionIndex < 11) ? 'voice' : 'text';
    const expectedControlledFailure = turnIndex === 1 && sessionIndex === 10;
    if (!exactKeys(turn, textKeys) || turn.sequence !== index + 1
      || turn.sessionIndex !== sessionIndex || turn.turnIndex !== turnIndex
      || turn.promptClass !== expectedClass || turn.replyMode !== expectedMode
      || turn.controlledTtsFailure !== expectedControlledFailure
      || !['en', 'yue-Hant-HK', 'cmn-Hans-CN'].includes(turn.replyLanguage)
      || turn.replyLanguage !== ['en', 'yue-Hant-HK', 'cmn-Hans-CN'][index % 3]
      || !DIGEST.test(String(turn.sessionIdSha256 ?? ''))
      || !UUID.test(String(turn.clientMessageId ?? '')) || !UUID.test(String(turn.correlationId ?? ''))
      || !UUID.test(String(turn.requestId ?? '')) || !UUID.test(String(turn.responseRequestId ?? ''))
      || !/^[0-9a-f]{32}$/.test(String(turn.traceId ?? ''))
      || typeof turn.assistantMessageId !== 'string' || turn.assistantMessageId.length < 1
      || turn.assistantMessageId.length > 128 || !DIGEST.test(String(turn.groundingEvidenceSha256 ?? ''))
      || turn.requestStatus !== 202 || turn.responseStatus !== 200
      || turn.acknowledged !== true || turn.processingVisible !== true || turn.delivered !== true
      || !Number.isFinite(turn.ackMs) || turn.ackMs < 0
      || !Number.isFinite(turn.processingVisibleMs) || turn.processingVisibleMs < 0
      || !Number.isFinite(turn.finalAnswerMs) || turn.finalAnswerMs < 0
      || turn.messageLost !== false || turn.duplicateAssistantReplyCount !== 0
      || turn.unsupportedVerifiedClaimCount !== 0 || turn.groundingSatisfied !== true
      || turn.groundingVerified !== (expectedClass === 'grounded')) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    const identifiers = [turn.clientMessageId, turn.correlationId, turn.requestId, turn.responseRequestId];
    if (identifiers.some((value) => uuids.has(value))) throw new Error('Task 8 raw workload receipts are invalid');
    identifiers.forEach((value) => uuids.add(value));
    if (traceIds.has(turn.traceId) || assistantIds.has(turn.assistantMessageId)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    traceIds.add(turn.traceId);
    assistantIds.add(turn.assistantMessageId);
    if (sessionHashes.has(sessionIndex) && sessionHashes.get(sessionIndex) !== turn.sessionIdSha256) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    sessionHashes.set(sessionIndex, turn.sessionIdSha256);
  }
  if (sessionHashes.size !== 20) throw new Error('Task 8 raw workload receipts are invalid');

  const asrKeys = [
    'bindingId', 'clientUploadId', 'correlationId', 'durationBucketSeconds', 'durationMs',
    'fixtureId', 'fixtureSha256', 'language', 'ready', 'requestId', 'requestStatus',
    'responseRequestId', 'responseStatus', 'sampleIndex', 'sequence', 'sessionIndex', 'wireLanguage',
  ];
  const languageWire = { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' };
  for (const [index, item] of raw.asrRequests.entries()) {
    if (!exactKeys(item, asrKeys) || item.sequence !== index + 1 || item.sampleIndex !== index
      || item.sessionIndex !== index % 20 || item.ready !== true
      || item.bindingId !== item.clientUploadId || !UUID.test(String(item.clientUploadId ?? ''))
      || !UUID.test(String(item.correlationId ?? '')) || !UUID.test(String(item.requestId ?? ''))
      || !UUID.test(String(item.responseRequestId ?? '')) || item.requestStatus !== 202
      || item.responseStatus !== 200 || !DIGEST.test(String(item.fixtureSha256 ?? ''))
      || typeof item.fixtureId !== 'string' || item.fixtureId.length < 1
      || !Object.hasOwn(languageWire, item.language) || item.wireLanguage !== languageWire[item.language]
      || ![10, 30, 55].includes(item.durationBucketSeconds)
      || !Number.isFinite(item.durationMs) || Math.abs(item.durationMs - item.durationBucketSeconds * 1_000) > 1_000) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
  }
  const ttsKeys = [
    'bindingId', 'correlationId', 'durationMs', 'expectedProviderFailure', 'failureCode',
    'mediaValidated', 'messageIdMatches', 'providerFailureObserved', 'ready', 'requestId',
    'requestIndex', 'requestStatus', 'responseRequestId', 'responseStatus', 'sequence',
    'sessionIndex', 'sourceTurnIndex', 'textAvailable',
  ];
  for (const [index, item] of raw.ttsRequests.entries()) {
    const failure = index === 30;
    if (!exactKeys(item, ttsKeys) || item.sequence !== index + 1 || item.requestIndex !== index
      || !Number.isSafeInteger(item.sessionIndex) || item.sessionIndex < 0 || item.sessionIndex > 19
      || !Number.isSafeInteger(item.sourceTurnIndex) || item.sourceTurnIndex < 0 || item.sourceTurnIndex > 9
      || typeof item.bindingId !== 'string' || !assistantIds.has(item.bindingId)
      || !UUID.test(String(item.correlationId ?? '')) || !UUID.test(String(item.requestId ?? ''))
      || !UUID.test(String(item.responseRequestId ?? '')) || item.requestStatus !== 200
      || item.responseStatus !== 200 || item.durationMs !== null || item.expectedProviderFailure !== failure
      || item.ready !== !failure || item.providerFailureObserved !== failure
      || item.failureCode !== (failure ? 'VOICE_SYNTHESIS_REJECTED' : null)
      || item.textAvailable !== true || item.messageIdMatches !== true || item.mediaValidated !== !failure) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
  }

  const samples = [];
  const queryDigests = [];
  for (const [index, query] of raw.timingQueries.entries()) {
    if (!exactKeys(query, ['queryDigest', 'samples', 'sequence', 'sessionIndex'])
      || query.sequence !== index + 1 || query.sessionIndex !== index
      || !DIGEST.test(String(query.queryDigest ?? '')) || !Array.isArray(query.samples)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    queryDigests.push(query.queryDigest);
    for (const sample of query.samples) {
      if (!exactKeys(sample, [
        'bindingId', 'correlationId', 'durationMs', 'failureCode', 'latencyMs', 'layer',
        'operation', 'outcome',
      ]) || !UUID.test(String(sample.correlationId ?? ''))
        || typeof sample.bindingId !== 'string' || sample.bindingId.length < 1
        || !['text', 'asr', 'tts'].includes(sample.operation)
        || !['provider', 'server'].includes(sample.layer)
        || !['success', 'failure'].includes(sample.outcome)
        || !Number.isFinite(sample.latencyMs) || sample.latencyMs < 0
        || (sample.operation === 'asr' ? !Number.isFinite(sample.durationMs) : sample.durationMs !== null)
        || (sample.outcome === 'success' ? sample.failureCode !== null
          : sample.failureCode !== 'VOICE_SYNTHESIS_REJECTED')) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
      samples.push(sample);
    }
  }
  if (samples.length !== 402 || new Set(queryDigests).size !== 20) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  const sampleKeys = new Set();
  for (const sample of samples) {
    const key = `${sample.operation}\0${sample.layer}\0${sample.correlationId}\0${sample.bindingId}`;
    if (sampleKeys.has(key)) throw new Error('Task 8 raw workload receipts are invalid');
    sampleKeys.add(key);
  }
  const match = (item, operation, layer) => samples.filter((sample) => (
    sample.operation === operation && sample.layer === layer
    && sample.correlationId === item.correlationId && sample.bindingId === item.bindingId
  ));
  const textWithBinding = raw.textTurns.map((item) => ({ ...item, bindingId: item.assistantMessageId }));
  if (textWithBinding.some((item) => match(item, 'text', 'server').length !== 1
      || match(item, 'text', 'provider').length !== (item.promptClass === 'grounded' ? 1 : 0))
    || raw.asrRequests.some((item) => match(item, 'asr', 'server').length !== 1
      || match(item, 'asr', 'provider').length !== 1)
    || raw.ttsRequests.some((item) => match(item, 'tts', 'server').length !== 1
      || match(item, 'tts', 'provider').length !== 1)) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }
  for (const item of raw.asrRequests) {
    for (const sample of [...match(item, 'asr', 'server'), ...match(item, 'asr', 'provider')]) {
      if (sample.durationMs !== item.durationMs || sample.outcome !== 'success' || sample.failureCode !== null) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
    }
  }
  for (const item of raw.ttsRequests) {
    const outcome = item.expectedProviderFailure ? 'failure' : 'success';
    for (const sample of [...match(item, 'tts', 'server'), ...match(item, 'tts', 'provider')]) {
      if (sample.outcome !== outcome
        || sample.failureCode !== (item.expectedProviderFailure ? 'VOICE_SYNTHESIS_REJECTED' : null)) {
        throw new Error('Task 8 raw workload receipts are invalid');
      }
    }
  }

  const controlKeys = ['insertId', 'latencyMs', 'sequence', 'status', 'timestamp', 'trace'];
  const controlInsertIds = new Set();
  const controlTraces = new Set();
  for (const [index, entry] of raw.controlPlaneRequests.entries()) {
    if (!exactKeys(entry, controlKeys) || entry.sequence !== index + 1 || entry.status !== 202
      || typeof entry.insertId !== 'string' || entry.insertId.length < 1
      || typeof entry.trace !== 'string'
      || !new RegExp(`^projects/${PROJECT}/traces/[0-9a-f]{32}$`).test(entry.trace)
      || !Number.isFinite(Date.parse(entry.timestamp))
      || !Number.isFinite(entry.latencyMs) || entry.latencyMs < 0 || entry.latencyMs > 60_000
      || controlInsertIds.has(entry.insertId) || controlTraces.has(entry.trace)) {
      throw new Error('Task 8 raw workload receipts are invalid');
    }
    controlInsertIds.add(entry.insertId);
    controlTraces.add(entry.trace);
  }
  if (![...traceIds].every((traceId) => controlTraces.has(`projects/${PROJECT}/traces/${traceId}`))) {
    throw new Error('Task 8 raw workload receipts are invalid');
  }

  const asrServerLatency = (item) => match(item, 'asr', 'server')[0].latencyMs;
  const successfulTts = raw.ttsRequests.filter(({ expectedProviderFailure }) => !expectedProviderFailure);
  const metrics = {
    sendAck: rawLatencyMetric(raw.textTurns.map(({ ackMs }) => ackMs), 200, { p95: 300 }),
    processingVisible: rawLatencyMetric(raw.textTurns.map(({ processingVisibleMs }) => processingVisibleMs), 200, { p95: 500 }),
    groundedResponse: rawLatencyMetric(raw.textTurns.filter(({ promptClass }) => promptClass === 'grounded')
      .map(({ finalAnswerMs }) => finalAnswerMs), 80, { p50: 2_500, p95: 6_000 }),
    asr10: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 10)
      .map(asrServerLatency), 10, { p50: 2_500, p95: 4_000 }),
    asr30: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 30)
      .map(asrServerLatency), 10, { p95: 6_000 }),
    asr55: rawLatencyMetric(raw.asrRequests.filter(({ durationBucketSeconds }) => durationBucketSeconds === 55)
      .map(asrServerLatency), 10, { p95: 6_000 }),
    ttsReady: rawLatencyMetric(successfulTts.map((item) => match(item, 'tts', 'server')[0].latencyMs), 30,
      { p50: 2_500, p95: 5_000 }),
  };
  const counts = {
    sessionsCreated: sessionHashes.size,
    textTurnsAttempted: raw.textTurns.length,
    textTurnsAcknowledged: raw.textTurns.filter(({ acknowledged }) => acknowledged).length,
    textTurnsDelivered: raw.textTurns.filter(({ delivered }) => delivered).length,
    asrRequestsAttempted: raw.asrRequests.length,
    asrReady: raw.asrRequests.filter(({ ready }) => ready).length,
    ttsRequestsAttempted: raw.ttsRequests.length,
    ttsReady: raw.ttsRequests.filter(({ ready }) => ready).length,
    ttsControlledProviderFailures: raw.ttsRequests.filter((item) => (
      item.expectedProviderFailure && item.providerFailureObserved
      && item.failureCode === 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const invariants = {
    acknowledgedMessageLossCount: raw.textTurns.filter(({ acknowledged, messageLost }) => acknowledged && messageLost).length,
    duplicateAssistantReplyCount: raw.textTurns.reduce((sum, item) => sum + item.duplicateAssistantReplyCount, 0),
    unsupportedVerifiedClaimCount: raw.textTurns.reduce((sum, item) => sum + item.unsupportedVerifiedClaimCount, 0),
    ttsFailureTextLossCount: raw.ttsRequests.filter(({ textAvailable }) => !textAvailable).length,
    ttsMediaValidationFailureCount: raw.ttsRequests.filter((item) => !item.expectedProviderFailure && !item.mediaValidated).length,
    ttsMessageBindingMismatchCount: raw.ttsRequests.filter(({ messageIdMatches }) => !messageIdMatches).length,
    controlledTtsProviderFailureMismatchCount: raw.ttsRequests.filter((item) => item.expectedProviderFailure && (
      item.ready || !item.providerFailureObserved || item.failureCode !== 'VOICE_SYNTHESIS_REJECTED'
    )).length,
  };
  const observations = {
    releaseCommitSha: plan.releaseSha,
    queryDigests: { sampleCount: 20, values: [...queryDigests].sort(), pass: true },
    provider: {
      text: rawTimingObservation(samples, 'text', 'provider', 80),
      asr: rawTimingObservation(samples, 'asr', 'provider', 30),
      tts: rawTimingObservation(samples, 'tts', 'provider', 30),
    },
    server: {
      text: rawTimingObservation(samples, 'text', 'server', 200),
      asr: rawTimingObservation(samples, 'asr', 'server', 30),
      tts: rawTimingObservation(samples, 'tts', 'server', 30),
    },
    pairs: {
      text: { available: true, expectedServerCount: 200, serverBoundCount: 200, expectedProviderCount: 80, providerPairedCount: 80 },
      asr: { available: true, expectedCount: 30, pairedCount: 30 },
      tts: { available: true, expectedSuccessCount: 30, successPairedCount: 30, expectedFailureCount: 1, failurePairedCount: 1 },
    },
  };
  const result = Object.values(metrics).every(({ pass }) => pass)
    && Object.values(invariants).every((value) => value === 0)
    && Object.values(counts).every((value, index) => value === [20, 200, 200, 200, 30, 30, 31, 30, 1][index])
    && ['provider', 'server'].every((layer) => Object.values(observations[layer]).every(({ available }) => available));
  return { counts, invariants, metrics, observations, result };
}

function validateLatencyAcceptanceRecord(record, plan, now) {
  const expectedMetrics = {
    sendAck: { sampleCount: 200, p95ThresholdMs: 300 },
    processingVisible: { sampleCount: 200, p95ThresholdMs: 500 },
    groundedResponse: { sampleCount: 80, p50ThresholdMs: 2_500, p95ThresholdMs: 6_000 },
    asr10: { sampleCount: 10, p50ThresholdMs: 2_500, p95ThresholdMs: 4_000 },
    asr30: { sampleCount: 10, p95ThresholdMs: 6_000 },
    asr55: { sampleCount: 10, p95ThresholdMs: 6_000 },
    ttsReady: { sampleCount: 30, p50ThresholdMs: 2_500, p95ThresholdMs: 5_000 },
  };
  const expectedCounts = {
    sessionsCreated: 20,
    textTurnsAttempted: 200,
    textTurnsAcknowledged: 200,
    textTurnsDelivered: 200,
    asrRequestsAttempted: 30,
    asrReady: 30,
    ttsRequestsAttempted: 31,
    ttsReady: 30,
    ttsControlledProviderFailures: 1,
  };
  const expectedInvariants = {
    acknowledgedMessageLossCount: 0,
    duplicateAssistantReplyCount: 0,
    unsupportedVerifiedClaimCount: 0,
    ttsFailureTextLossCount: 0,
    ttsMediaValidationFailureCount: 0,
    ttsMessageBindingMismatchCount: 0,
    controlledTtsProviderFailureMismatchCount: 0,
  };
  const expectedPairs = {
    text: {
      available: true,
      expectedServerCount: 200,
      serverBoundCount: 200,
      expectedProviderCount: 80,
      providerPairedCount: 80,
    },
    asr: { available: true, expectedCount: 30, pairedCount: 30 },
    tts: {
      available: true,
      expectedSuccessCount: 30,
      successPairedCount: 30,
      expectedFailureCount: 1,
      failurePairedCount: 1,
    },
  };
  const observations = record?.observations;
  const queryDigests = observations?.queryDigests;
  const digestValues = queryDigests?.values;
  const exactQueryDigests = Array.isArray(digestValues) && digestValues.length === 20
    && digestValues.every((value) => DIGEST.test(String(value ?? '')))
    && new Set(digestValues).size === 20
    && exact(digestValues, [...digestValues].sort());
  const exactObservationLayers = ['provider', 'server'].every((layer) => (
    exactKeys(observations?.[layer], ['asr', 'text', 'tts'])
    && validateLatencyObservation(observations[layer].text, layer === 'provider' ? 80 : 200)
    && validateLatencyObservation(observations[layer].asr, 30)
    && validateLatencyObservation(observations[layer].tts, 30)
  ));
  const expectedRevision = `${CANDIDATE_SERVICE}-${plan.releaseSha.slice(0, 12)}`;
  const expectedOrigin = plan.candidateOrigin;
  const expectedReleaseBinding = {
    project: PROJECT,
    region: REGION,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    releaseSha: plan.releaseSha,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    imageDigest: plan.imageDigest,
    candidateRevision: plan.candidateRevision,
    candidateTag: plan.candidateTag,
    serviceOrigin: plan.serviceOrigin,
    candidateOrigin: plan.candidateOrigin,
    candidateAudience: plan.candidateServiceOrigin,
    trafficPercent: candidateTrafficPercent(plan),
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
  };
  let derived;
  try { derived = validateRawLatencyReceipts(record, plan); } catch {
    throw new Error('Task 8 workload evidence is invalid');
  }
  if (!exactKeys(record, [
    'access', 'artifactSha256', 'candidateOrigin', 'candidateService', 'commitSha', 'counts',
    'fixtureSetSha256', 'invariants', 'metrics', 'observations', 'occurredAt', 'rawReceipts',
    'releaseBinding', 'result', 'schemaVersion', 'stableService', 'stableTrafficState',
    'trafficState', 'workload',
  ]) || record.schemaVersion !== 5 || record.commitSha !== plan.releaseSha
    || record.candidateOrigin !== plan.candidateOrigin || plan.candidateOrigin !== expectedOrigin
    || record.candidateService !== CANDIDATE_SERVICE || record.stableService !== STABLE_SERVICE
    || record.trafficState !== candidateTrafficState(plan)
    || record.stableTrafficState !== plan.expectedStable.initialTrafficState
    || plan.candidateRevision !== expectedRevision || !IMAGE_DIGEST.test(String(plan.imageDigest ?? ''))
    || !exact(record.access, plan.candidateAccess)
    || !exact(record.releaseBinding, expectedReleaseBinding)
    || !DIGEST.test(String(record.fixtureSetSha256 ?? ''))
    || !exact(record.workload, LATENCY_ACCEPTANCE_CONTRACT)
    || !exact(record.counts, expectedCounts) || !exact(record.invariants, expectedInvariants)
    || !exact(record.counts, derived.counts) || !exact(record.invariants, derived.invariants)
    || !exactKeys(record.metrics, Object.keys(expectedMetrics))
    || !Object.entries(expectedMetrics).every(([key, expected]) => (
      validateLatencyMetric(record.metrics[key], expected)
    ))
    || !exactKeys(observations, ['pairs', 'provider', 'queryDigests', 'releaseCommitSha', 'server'])
    || observations.releaseCommitSha !== plan.releaseSha
    || !exactKeys(queryDigests, ['pass', 'sampleCount', 'values'])
    || queryDigests.sampleCount !== 20 || queryDigests.pass !== true || !exactQueryDigests
    || !exactObservationLayers || !exact(observations.pairs, expectedPairs)
    || !exact(record.metrics, derived.metrics) || !exact(record.observations, derived.observations)
    || record.result !== true || record.result !== derived.result || !recentEvidenceTime(record.occurredAt, now)
    || finalizeLatencyAcceptanceRecord(record).artifactSha256 !== record.artifactSha256) {
    throw new Error('Task 8 workload evidence is invalid');
  }
  return Object.freeze({
    acceptanceWindowId: record.rawReceipts.acceptanceWindowId,
    candidateOrigin: plan.candidateOrigin,
    candidateRevision: plan.candidateRevision,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
    controlPlaneRequests: record.rawReceipts.controlPlaneRequests,
    expectedTraceIds: record.rawReceipts.textTurns.map(({ traceId }) => traceId),
  });
}

async function readExactJsonArtifact(entry, errorMessage) {
  let metadata;
  let bytes;
  try {
    metadata = await lstat(entry.filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 4 * 1024 * 1024) {
      throw new Error('invalid artifact');
    }
    bytes = await readFile(entry.filePath);
  } catch { throw new Error(errorMessage); }
  if (createHash('sha256').update(bytes).digest('hex') !== entry.objectSha256) {
    throw new Error(errorMessage);
  }
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|postgres(?:ql)?:\/\/[^/@\s:]+:[^/@\s]+@|"(?:accessToken|access_token|private_key)"\s*:/i.test(raw)) {
    throw new Error(errorMessage);
  }
  let record;
  try { record = JSON.parse(raw); } catch { throw new Error(errorMessage); }
  if (containsForbiddenPersistedSecret(record)) throw new Error(errorMessage);
  if (raw !== `${JSON.stringify(record, null, 2)}\n`) throw new Error(errorMessage);
  return { record, bytes };
}

async function validateBoundFile(value, { json = false, png = false } = {}) {
  if (!exactKeys(value, ['byteLength', 'filePath', 'sha256'])
    || !isAbsoluteFile(value.filePath) || !DIGEST.test(String(value.sha256 ?? ''))
    || !Number.isSafeInteger(value.byteLength) || value.byteLength < 8 || value.byteLength > 10 * 1024 * 1024) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  const metadata = await lstat(value.filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size !== value.byteLength) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  const bytes = await readFile(value.filePath);
  if (createHash('sha256').update(bytes).digest('hex') !== value.sha256
    || (png && !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))) {
    throw new Error('Mobile evidence bound file is invalid');
  }
  if (!json) return null;
  const raw = bytes.toString('utf8');
  if (!Buffer.from(raw).equals(bytes)) throw new Error('Mobile evidence trace is invalid');
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error('Mobile evidence trace is invalid'); }
  if (containsForbiddenPersistedSecret(parsed)) throw new Error('Mobile evidence trace is invalid');
  if (raw !== `${JSON.stringify(parsed, null, 2)}\n`) throw new Error('Mobile evidence trace is invalid');
  return parsed;
}

async function validateTask8EvidenceArtifact(entry, phase, plan, { now }) {
  const errorMessage = `Task 8 ${phase} evidence is invalid`;
  const { record } = await readExactJsonArtifact(entry, errorMessage);
  if (record?.artifactSha256 !== entry.artifactSha256) throw new Error(errorMessage);
  if (phase === 'workload') {
    try { return validateLatencyAcceptanceRecord(record, plan, now); } catch { throw new Error(errorMessage); }
  }
  if (finalizeReleaseEvidenceRecord(record).artifactSha256 !== record.artifactSha256
    || record.commitSha !== plan.releaseSha || record.sourceArchiveSha256 !== plan.sourceArchiveSha256
    || record.imageDigest !== plan.imageDigest || record.candidateRevision !== plan.candidateRevision
    || record.candidateTag !== plan.candidateTag || record.candidateOrigin !== plan.candidateOrigin
    || record.trafficPercent !== candidateTrafficPercent(plan)
    || record.candidateService !== CANDIDATE_SERVICE || record.stableService !== STABLE_SERVICE
    || record.trafficState !== candidateTrafficState(plan)
    || record.stableTrafficState !== plan.expectedStable.initialTrafficState
    || record.result !== 'pass'
    || !recentEvidenceTime(record.occurredAt, now)) throw new Error(errorMessage);
  if (phase === 'readiness') {
    if (!exactKeys(record, [
      'artifactSha256', 'candidateOrigin', 'candidateRevision', 'candidateService', 'candidateTag',
      'checks', 'commitSha', 'gate', 'imageDigest', 'occurredAt', 'result', 'schemaVersion',
      'sourceArchiveSha256', 'stableService', 'stableTrafficState', 'trafficPercent', 'trafficState',
    ]) || record.schemaVersion !== 2 || record.gate !== 'readiness'
      || !exact(record.checks, {
        evidenceMounted: true,
        liveStatus: 200,
        observedReleaseSha: plan.releaseSha,
        readyStatus: 200,
        resourceContinuity: true,
      })) throw new Error(errorMessage);
    return true;
  }
  if (phase !== 'mobile' || !exactKeys(record, [
    'access', 'artifactSha256', 'candidateOrigin', 'candidateRevision', 'candidateService',
    'candidateTag', 'commitSha', 'finalNavigationUrl', 'gate', 'imageDigest', 'occurredAt',
    'result', 'schemaVersion', 'screenshots', 'sourceArchiveSha256', 'stableService',
    'stableTrafficState', 'trace', 'trafficPercent', 'trafficState', 'viewport',
  ]) || record.schemaVersion !== 2 || record.gate !== 'mobile'
    || !exact(record.access, plan.candidateAccess)
    || record.finalNavigationUrl !== plan.candidateOrigin
    || !exact(record.viewport, { width: 390, height: 844 })
    || !Array.isArray(record.screenshots) || record.screenshots.length !== MOBILE_SCREENSHOT_IDS.length) {
    throw new Error(errorMessage);
  }
  const trace = await validateBoundFile(record.trace, { json: true });
  if (!exactKeys(trace, [
    'access', 'candidateOrigin', 'candidateService', 'events', 'finalNavigationUrl',
    'observedReleaseSha', 'schemaVersion', 'source', 'stableService', 'stableTrafficState',
    'trafficPercent', 'trafficState', 'viewport',
  ]) || trace.schemaVersion !== 2 || trace.source !== 'codex-in-app-browser'
    || !exact(trace.access, plan.candidateAccess)
    || trace.candidateOrigin !== plan.candidateOrigin || trace.finalNavigationUrl !== plan.candidateOrigin
    || trace.candidateService !== CANDIDATE_SERVICE || trace.stableService !== STABLE_SERVICE
    || trace.trafficState !== candidateTrafficState(plan)
    || trace.stableTrafficState !== plan.expectedStable.initialTrafficState
    || trace.observedReleaseSha !== plan.releaseSha
    || trace.trafficPercent !== candidateTrafficPercent(plan)
    || !exact(trace.viewport, { width: 390, height: 844 })
    || !Array.isArray(trace.events) || trace.events.length !== MOBILE_CHECK_IDS.length
    || !trace.events.every((event, index) => exactKeys(event, ['evidence', 'id', 'status'])
      && event.id === MOBILE_CHECK_IDS[index] && event.status === 'passed'
      && typeof event.evidence === 'string' && event.evidence.length >= 3 && event.evidence.length <= 240)) {
    throw new Error(errorMessage);
  }
  for (const [index, screenshot] of record.screenshots.entries()) {
    if (!exactKeys(screenshot, ['byteLength', 'filePath', 'id', 'sha256'])
      || screenshot.id !== MOBILE_SCREENSHOT_IDS[index]) throw new Error(errorMessage);
    const { id: ignored, ...binding } = screenshot;
    void ignored;
    await validateBoundFile(binding, { png: true });
  }
  return true;
}

function expectedReceiptCompleted(plan, phase) {
  return plan.operations.filter((member) => member.phase === phase).map(({ id }) => id);
}

function expectedEvidenceVersions(plan) {
  return Object.freeze(Object.fromEntries(Object.entries(plan.evidence).map(([key, value]) => [
    key, value.secretVersion,
  ])));
}

function expectedCollectedEvidence(plan) {
  return Object.freeze(Object.fromEntries([
    'dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke',
  ].map((key) => [key, Object.freeze({
    artifactSha256: plan.evidence[key].artifactSha256,
    objectSha256: plan.evidence[key].objectSha256,
  })])));
}

function expectedAcceptanceJobs(plan) {
  return Object.freeze(Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
    key, Object.freeze({ image: value.image, serviceAccount: value.serviceAccount }),
  ])));
}

function validateReceiptOutputs(phase, outputs, plan) {
  const expectedLabels = {
    'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
    'org.opencontainers.image.revision': plan.releaseSha,
    'org.opencontainers.image.source': OCI_SOURCE,
  };
  if (phase === 'build') {
    if (!exactKeys(outputs, ['buildId', 'imageDigest', 'ociLabels', 'sourceArchiveSha256', 'sourceProvenance'])
      || !BUILD_ID.test(String(outputs.buildId ?? ''))
      || !IMAGE_DIGEST.test(String(outputs.imageDigest ?? ''))
      || (plan.imageDigest !== null && outputs.imageDigest !== plan.imageDigest)
      || outputs.sourceArchiveSha256 !== plan.sourceArchiveSha256
      || !exact(outputs.ociLabels, expectedLabels)
      || !exactKeys(outputs.sourceProvenance, ['sha256', 'uri'])
      || outputs.sourceProvenance.sha256 !== plan.sourceArchiveSha256
      || !new RegExp(`^gs://${GCP_IDENTITY.buildSourceBucket}/${BUILD_SOURCE_PREFIX}[^#]+#[1-9]\\d*$`)
        .test(String(outputs.sourceProvenance.uri ?? ''))) {
      throw new Error('Release build receipt outputs are invalid');
    }
  } else if (phase === 'migration') {
    if (!exactKeys(outputs, ['executionName', 'imageDigest', 'job'])
      || outputs.imageDigest !== plan.imageDigest || outputs.job !== MIGRATION_JOB
      || typeof outputs.executionName !== 'string'
      || !new RegExp(`^${MIGRATION_JOB}-[a-z0-9](?:[a-z0-9-]{0,48}[a-z0-9])?$`).test(outputs.executionName)) {
      throw new Error('Release migration receipt outputs are invalid');
    }
  } else if (phase === 'inventory') {
    if (!exact(outputs, { evidenceSecretVersions: { legacyInventory: plan.evidence.legacyInventory.secretVersion } })) {
      throw new Error('Release inventory receipt outputs are invalid');
    }
  } else if (phase === 'acceptance') {
    if (!exact(outputs, { jobs: expectedAcceptanceJobs(plan) })) {
      throw new Error('Release acceptance receipt outputs are invalid');
    }
  } else if (phase === 'collect') {
    const unresolved = ['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke']
      .every((key) => plan.evidence[key].artifactSha256 === '0'.repeat(64)
        && plan.evidence[key].objectSha256 === '0'.repeat(64));
    const validUnresolved = unresolved
      && exactKeys(outputs, ['evidence'])
      && exactKeys(outputs.evidence, ['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke'])
      && Object.values(outputs.evidence).every((entry) => (
        exactKeys(entry, ['artifactSha256', 'objectSha256'])
        && DIGEST.test(String(entry.artifactSha256 ?? ''))
        && DIGEST.test(String(entry.objectSha256 ?? ''))
      ));
    if (!validUnresolved && !exact(outputs, { evidence: expectedCollectedEvidence(plan) })) {
      throw new Error('Release collect receipt outputs are invalid');
    }
  } else if (phase === 'evidence') {
    if (!exact(outputs, { evidenceSecretVersions: expectedEvidenceVersions(plan), outputResidueCount: 0 })) {
      throw new Error('Release evidence receipt outputs are invalid');
    }
  } else if (phase === 'candidate') {
    if (!exactKeys(outputs, [
      'access', 'candidateContractSha256', 'candidateService', 'imageDigest', 'origin',
      'publicInvoker', 'priorRelease', 'revision', 'stableService', 'stableTrafficState',
      'tag', 'trafficPercent', 'trafficState',
    ])
      || !exact(outputs.access, plan.candidateAccess)
      || outputs.candidateContractSha256 !== canonicalSha256(plan.expectedCandidate)
      || outputs.candidateService !== CANDIDATE_SERVICE || outputs.stableService !== STABLE_SERVICE
      || outputs.stableTrafficState !== plan.expectedStable.initialTrafficState
      || outputs.imageDigest !== plan.imageDigest || outputs.origin !== plan.candidateOrigin
      || outputs.revision !== plan.candidateRevision || outputs.tag !== plan.candidateTag
      || outputs.trafficPercent !== candidateTrafficPercent(plan)
      || outputs.trafficState !== candidateTrafficState(plan)
      || outputs.publicInvoker !== false
      || !exact(outputs.priorRelease, plan.previousRevision === null ? null : {
        image: plan.previousImage,
        imageDigest: plan.previousImageDigest,
        revision: plan.previousRevision,
      })) {
      throw new Error('Release candidate receipt outputs are invalid');
    }
  } else if (['readiness', 'workload', 'mobile'].includes(phase)) {
    const expected = plan.task8Evidence[phase];
    const baseKeys = [
      'artifactSha256', 'candidateOrigin', 'candidateRevision', 'candidateService', 'imageDigest',
      'objectSha256', 'stableService', 'stableTrafficState', 'trafficState',
    ];
    const expectedKeys = phase === 'mobile' ? [...baseKeys, 'access', 'viewport']
      : phase === 'workload' ? [...baseKeys, 'execution'] : baseKeys;
    const unresolvedWorkload = phase === 'workload'
      && expected.artifactSha256 === '0'.repeat(64)
      && expected.objectSha256 === '0'.repeat(64);
    if (!exactKeys(outputs, expectedKeys)
      || (!unresolvedWorkload && outputs.artifactSha256 !== expected.artifactSha256)
      || (!unresolvedWorkload && outputs.objectSha256 !== expected.objectSha256)
      || !DIGEST.test(String(outputs.artifactSha256 ?? ''))
      || !DIGEST.test(String(outputs.objectSha256 ?? ''))
      || (unresolvedWorkload && (outputs.artifactSha256 === '0'.repeat(64)
        || outputs.objectSha256 === '0'.repeat(64)))
      || outputs.candidateOrigin !== plan.candidateOrigin
      || outputs.candidateRevision !== plan.candidateRevision
      || outputs.candidateService !== CANDIDATE_SERVICE || outputs.stableService !== STABLE_SERVICE
      || outputs.trafficState !== candidateTrafficState(plan)
      || outputs.stableTrafficState !== plan.expectedStable.initialTrafficState
      || outputs.imageDigest !== plan.imageDigest
      || (phase === 'workload' && (!exactKeys(outputs.execution, [
        'acceptanceWindowId', 'attemptId', 'networkWitnessSha256', 'observedRequestCount',
      ])
        || !DIGEST.test(String(outputs.execution.acceptanceWindowId ?? ''))
        || !UUID.test(String(outputs.execution.attemptId ?? ''))
        || !DIGEST.test(String(outputs.execution.networkWitnessSha256 ?? ''))
        || !Number.isSafeInteger(outputs.execution.observedRequestCount)
        || outputs.execution.observedRequestCount < 500
        || outputs.execution.observedRequestCount > 5_000))
      || (phase === 'mobile' && !exact(outputs.access, plan.candidateAccess))
      || (phase === 'mobile' && !exact(outputs.viewport, { width: 390, height: 844 }))) {
      throw new Error('Task 8 release receipt outputs are invalid');
    }
  } else throw new Error('Release receipt phase is invalid');
  return true;
}

export function validateReleaseReceiptChain(value, plan, { through = 'mobile' } = {}) {
  const lastIndex = RECEIPT_PHASES.indexOf(through);
  if (!plan || lastIndex < 0 || !Array.isArray(value) || value.length !== lastIndex + 1) {
    throw new Error('Release receipt chain is invalid');
  }
  let previousReceiptSha256 = null;
  for (let index = 0; index <= lastIndex; index += 1) {
    const receipt = value[index];
    const phase = RECEIPT_PHASES[index];
    if (!exactKeys(receipt, [
      'candidateService', 'completed', 'outputs', 'phase', 'previousReceiptSha256',
      'receiptSha256', 'releaseIdentitySha256', 'releaseSha', 'schemaVersion', 'sequence',
      'stableService', 'stableTrafficState', 'trafficState',
    ])
      || receipt.schemaVersion !== 2 || receipt.phase !== phase || receipt.sequence !== index + 1
      || receipt.releaseSha !== plan.releaseSha
      || receipt.candidateService !== CANDIDATE_SERVICE || receipt.stableService !== STABLE_SERVICE
      || receipt.trafficState !== candidateTrafficState(plan)
      || receipt.stableTrafficState !== plan.expectedStable.initialTrafficState
      || receipt.releaseIdentitySha256 !== plan.releaseIdentitySha256
      || receipt.previousReceiptSha256 !== previousReceiptSha256
      || !exact(receipt.completed, expectedReceiptCompleted(plan, phase))
      || finalizeReleasePhaseReceipt(receipt).receiptSha256 !== receipt.receiptSha256) {
      throw new Error('Release receipt chain is invalid');
    }
    validateReceiptOutputs(phase, receipt.outputs, plan);
    previousReceiptSha256 = receipt.receiptSha256;
  }
  return true;
}

async function loadReleaseReceiptFiles(plan, { through }) {
  const lastIndex = RECEIPT_PHASES.indexOf(through);
  if (lastIndex < 0) throw new Error('Release receipt chain is invalid');
  const receipts = [];
  for (let index = 0; index <= lastIndex; index += 1) {
    const phase = RECEIPT_PHASES[index];
    const filePath = plan.releaseReceiptPaths[phase];
    const metadata = await lstat(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 2 || metadata.size > 1024 * 1024) {
      throw new Error('Release receipt chain is invalid');
    }
    const bytes = await readFile(filePath);
    const raw = bytes.toString('utf8');
    if (!Buffer.from(raw).equals(bytes)) throw new Error('Release receipt chain is invalid');
    const receipt = JSON.parse(raw);
    if (raw !== `${JSON.stringify(receipt, null, 2)}\n`) throw new Error('Release receipt chain is invalid');
    receipts.push(receipt);
  }
  validateReleaseReceiptChain(receipts, plan, { through });
  return receipts;
}

async function persistReleaseReceipt(plan, receipt) {
  const filePath = plan.releaseReceiptPaths[receipt.phase];
  if (!filePath) throw new Error('Release receipt path is invalid');
  try { await mkdir(plan.releaseReceiptDirectory); } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  try {
    await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = await readFile(filePath);
    if (!existing.equals(Buffer.from(contents))) throw new Error('Release receipt already exists with different bytes');
  }
  return true;
}

function releasePhaseReceiptOutputs(phase, plan, context) {
  if (phase === 'build') {
    const value = context.buildReceipt;
    return Object.freeze({
      buildId: value.buildId,
      imageDigest: value.imageDigest,
      sourceArchiveSha256: value.sourceArchiveSha256,
      sourceProvenance: value.sourceProvenance,
      ociLabels: value.ociLabels,
    });
  }
  if (phase === 'migration') return Object.freeze({
    executionName: context.migrationExecutionReceipt.name,
    job: MIGRATION_JOB,
    imageDigest: plan.imageDigest,
  });
  if (phase === 'inventory') return Object.freeze({
    evidenceSecretVersions: Object.freeze({
      legacyInventory: plan.evidence.legacyInventory.secretVersion,
    }),
  });
  if (phase === 'acceptance') return Object.freeze({ jobs: expectedAcceptanceJobs(plan) });
  if (phase === 'collect') return Object.freeze({
    evidence: Object.freeze(Object.fromEntries(Object.entries(context.collectedEvidence).map(([key, value]) => [
      key, Object.freeze({ artifactSha256: value.artifactSha256, objectSha256: value.objectSha256 }),
    ]))),
  });
  if (phase === 'evidence') return Object.freeze({
    evidenceSecretVersions: expectedEvidenceVersions(plan), outputResidueCount: 0,
  });
  if (phase === 'candidate') return Object.freeze({
    access: plan.candidateAccess,
    candidateContractSha256: canonicalSha256(plan.expectedCandidate),
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    publicInvoker: false,
    priorRelease: plan.previousRevision === null ? null : Object.freeze({
      image: plan.previousImage,
      imageDigest: plan.previousImageDigest,
      revision: plan.previousRevision,
    }),
    revision: plan.candidateRevision,
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    tag: plan.candidateTag,
    trafficPercent: candidateTrafficPercent(plan),
    trafficState: candidateTrafficState(plan),
  });
  if (['readiness', 'workload', 'mobile'].includes(phase)) {
    const evidence = phase === 'workload' && context.workloadExecution
      ? context.workloadExecution.evidence : plan.task8Evidence[phase];
    return Object.freeze({
      artifactSha256: evidence.artifactSha256,
      objectSha256: evidence.objectSha256,
      candidateOrigin: plan.candidateOrigin,
      candidateRevision: plan.candidateRevision,
      candidateService: CANDIDATE_SERVICE,
      imageDigest: plan.imageDigest,
      stableService: STABLE_SERVICE,
      stableTrafficState: plan.expectedStable.initialTrafficState,
      trafficState: candidateTrafficState(plan),
      ...(phase === 'workload' ? { execution: context.workloadExecution?.execution } : {}),
      ...(phase === 'mobile' ? {
        access: plan.candidateAccess,
        viewport: Object.freeze({ width: 390, height: 844 }),
      } : {}),
    });
  }
  throw new Error('Release receipt phase is invalid');
}

function createReleasePhaseReceipt(phase, plan, completed, context, priorReceipts) {
  const sequence = RECEIPT_PHASES.indexOf(phase) + 1;
  if (sequence < 1 || priorReceipts.length !== sequence - 1) {
    throw new Error('Release receipt predecessor chain is invalid');
  }
  const receipt = finalizeReleasePhaseReceipt({
    schemaVersion: 2,
    phase,
    sequence,
    releaseSha: plan.releaseSha,
    releaseIdentitySha256: plan.releaseIdentitySha256,
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: candidateTrafficState(plan),
    stableTrafficState: plan.expectedStable.initialTrafficState,
    previousReceiptSha256: priorReceipts.at(-1)?.receiptSha256 ?? null,
    completed: Object.freeze([...completed]),
    outputs: releasePhaseReceiptOutputs(phase, plan, context),
  });
  validateReleaseReceiptChain([...priorReceipts, receipt], plan, { through: phase });
  return receipt;
}

async function assertCollectionDestinationsAbsent(outputs) {
  for (const { filePath } of Object.values(outputs)) {
    try {
      await lstat(filePath);
      throw new Error('destination exists');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Evidence collection destination is not empty');
    }
  }
  return true;
}

function operationMayMutate(id) {
  return id === 'build-submit' || id === 'migration-deploy' || id === 'migration-execute'
    || id.startsWith('inventory-publish:') || id.startsWith('evidence-publish:')
    || id.endsWith('-deploy') || id.endsWith('-execute')
    || id.startsWith('evidence-collect-copy:') || id.startsWith('evidence-output-delete:')
    || id === 'candidate-deploy' || id === 'candidate-private-iam-grant'
    || id === 'candidate-cleanup-delete' || id === 'promote-stable-deploy'
    || id === 'promote-public-service'
    || id === 'promote-traffic' || id === 'rollback-traffic';
}

function parseArguments(argv, releaseSha) {
  if (!Array.isArray(argv) || !RELEASE_SHA.test(String(releaseSha ?? ''))) return null;
  let phase = null;
  let confirmed = false;
  for (const member of argv) {
    if (typeof member !== 'string') return null;
    if (member.startsWith('--phase=') && phase === null) {
      phase = member.slice('--phase='.length);
    } else if (member === `--confirm-release=${releaseSha}` && !confirmed) {
      confirmed = true;
    } else return null;
  }
  if (!PHASES.includes(phase)) return null;
  return { phase, confirmed };
}

function workloadLoggingReadArgv(attestation) {
  const userAgent = `hkbuddy-v1-acceptance/${attestation.acceptanceWindowId}`;
  const filter = [
    `logName="projects/${PROJECT}/logs/run.googleapis.com%2Frequests"`,
    'resource.type="cloud_run_revision"',
    `resource.labels.project_id="${PROJECT}"`,
    `resource.labels.location="${REGION}"`,
    `resource.labels.service_name="${CANDIDATE_SERVICE}"`,
    `resource.labels.revision_name="${attestation.candidateRevision}"`,
    'httpRequest.requestMethod="POST"',
    `httpRequest.requestUrl="${attestation.candidateOrigin}/api/v1/messages"`,
    'httpRequest.status=202',
    `httpRequest.userAgent="${userAgent}"`,
  ].join(' AND ');
  return [
    'logging', 'read', filter, `--project=${PROJECT}`, '--order=asc', '--limit=201', '--format=json',
  ];
}

function requestHeader(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (Array.isArray(headers)) {
    const matches = headers.filter(([key]) => String(key).toLowerCase() === name.toLowerCase());
    return matches.length === 1 ? String(matches[0][1]) : null;
  }
  const matches = Object.entries(headers)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase());
  return matches.length === 1 ? String(matches[0][1]) : null;
}

function createControlledWorkloadFetch(fetchImpl, plan, ledger) {
  if (typeof fetchImpl !== 'function' || !Array.isArray(ledger)) {
    throw new Error('Controlled workload fetch is unavailable');
  }
  return async (input, init = {}) => {
    const rawUrl = input instanceof URL ? input.href
      : typeof input === 'string' ? input : input?.url;
    const url = new URL(rawUrl);
    if (url.origin !== plan.candidateOrigin || url.username || url.password || ledger.length >= 5_000) {
      throw new Error('Controlled workload request is outside the candidate boundary');
    }
    const method = String(init?.method ?? input?.method ?? 'GET').toUpperCase();
    if (!/^(?:GET|HEAD|POST)$/.test(method)) throw new Error('Controlled workload method is invalid');
    const response = await fetchImpl(input, init);
    const status = Number(response?.status);
    if (!Number.isSafeInteger(status) || status < 100 || status > 599) {
      throw new Error('Controlled workload response is invalid');
    }
    const path = `${url.pathname}${url.search}`;
    const authorization = requestHeader(init?.headers, 'Authorization');
    const entry = {
      sequence: ledger.length + 1,
      method,
      path,
      status,
      authenticated: typeof authorization === 'string'
        && /^Bearer [^\s]{40,16384}$/.test(authorization),
      acceptanceUserAgent: requestHeader(init?.headers, 'User-Agent'),
      ...(method === 'POST' && url.pathname === '/api/v1/messages' ? {
        correlationId: requestHeader(init?.headers, 'X-Acceptance-Correlation-Id'),
      } : {}),
      ...(method === 'POST' && url.pathname === '/api/v1/voice/transcriptions' ? {
        uploadId: requestHeader(init?.headers, 'X-Client-Upload-Id'),
      } : {}),
      ...(url.pathname.startsWith('/api/v1/media/') ? {
        range: requestHeader(init?.headers, 'Range') === 'bytes=0-3',
      } : {}),
    };
    ledger.push(Object.freeze(entry));
    return response;
  };
}

function exactStringSet(values, expected) {
  return Array.isArray(values) && Array.isArray(expected)
    && values.length === expected.length
    && new Set(values).size === values.length
    && exact([...values].sort(), [...expected].sort());
}

function validateControlledWorkloadNetwork(ledger, record) {
  if (!Array.isArray(ledger) || ledger.length < 500 || ledger.length > 5_000
    || ledger.some((entry, index) => entry.sequence !== index + 1)
    || containsForbiddenPersistedSecret(ledger)) {
    throw new Error('Controlled workload network witness is invalid');
  }
  const matches = (method, path) => ledger.filter((entry) => (
    entry.method === method && entry.path === path
  ));
  const sessions = matches('POST', '/api/v1/session');
  const textPosts = matches('POST', '/api/v1/messages');
  const messageReads = matches('GET', '/api/v1/messages?after=0');
  const asrPosts = matches('POST', '/api/v1/voice/transcriptions');
  const timingPath = `/api/v1/acceptance/timings?windowId=${record.rawReceipts.acceptanceWindowId}`;
  const timingReads = matches('GET', timingPath);
  const expectedCorrelations = record.rawReceipts.textTurns.map(({ correlationId }) => correlationId);
  const expectedUploads = record.rawReceipts.asrRequests.map(({ bindingId }) => bindingId);
  const expectedTtsIds = record.rawReceipts.ttsRequests.map(({ bindingId }) => bindingId);
  const expectedUserAgent = `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`;
  const ttsStatus = ledger.filter(({ method, path }) => (
    method === 'GET' && /^\/api\/v1\/messages\/[^/?]{1,128}\/audio\/status$/.test(path)
  ));
  const observedTtsIds = [...new Set(ttsStatus.map(({ path }) => path.split('/')[4]))];
  const media = ledger.filter(({ path }) => path.startsWith('/api/v1/media/'));
  const mediaPaths = [...new Set(media.map(({ path }) => path))];
  const mediaComplete = mediaPaths.length === 30 && mediaPaths.every((path) => {
    const values = media.filter((entry) => entry.path === path);
    return values.length === 3
      && values.some(({ method, status }) => method === 'HEAD' && status === 200)
      && values.some(({ method, status, range }) => method === 'GET' && status === 206 && range === true)
      && values.some(({ method, status, range }) => method === 'GET' && status === 200 && range === false);
  });
  const checks = [
    ['AUTHENTICATION', ledger.every(({ authenticated, acceptanceUserAgent }) => (
      authenticated === true && acceptanceUserAgent === expectedUserAgent
    ))],
    ['SESSION', sessions.length === 21 && sessions.every(({ status }) => [200, 201].includes(status))],
    ['TEXT', textPosts.length === 200 && textPosts.every(({ status }) => status === 202)
      && exactStringSet(textPosts.map(({ correlationId }) => correlationId), expectedCorrelations)],
    ['DELIVERY', messageReads.length >= 231 && messageReads.every(({ status }) => status === 200)],
    ['ASR', asrPosts.length === 30 && asrPosts.every(({ status }) => [200, 201, 202].includes(status))
      && exactStringSet(asrPosts.map(({ uploadId }) => uploadId), expectedUploads)],
    ['TIMING', timingReads.length === 20 && timingReads.every(({ status }) => status === 200)],
    ['TTS_BINDING', exactStringSet(observedTtsIds, expectedTtsIds)],
    ['TTS_READY', expectedTtsIds.every((id) => ttsStatus.some(({ path, status }) => (
      path === `/api/v1/messages/${id}/audio/status` && status === 200
    )))],
    ['MEDIA', mediaComplete],
  ];
  const failed = checks.find(([, pass]) => !pass);
  if (failed) {
    const error = new Error('Controlled workload network witness is invalid');
    error.code = `WORKLOAD_CONTROLLED_NETWORK_${failed[0]}_INVALID`;
    throw error;
  }
  return Object.freeze({
    observedRequestCount: ledger.length,
    networkWitnessSha256: canonicalSha256(ledger),
  });
}

async function assertControlledWorkloadTargetAbsent(entry) {
  try {
    await lstat(entry.filePath);
    throw new Error('Controlled workload target already exists');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  return true;
}

async function executeControlledWorkload(plan, {
  environment, executeWorkload, workloadFetch, randomUUID, now,
}) {
  const entry = plan.task8Evidence.workload;
  if (entry.artifactSha256 !== '0'.repeat(64) || entry.objectSha256 !== '0'.repeat(64)) {
    const error = new Error('Pre-existing workload evidence is forbidden');
    error.code = 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN';
    throw error;
  }
  await assertControlledWorkloadTargetAbsent(entry);
  const fixtureManifest = environment?.V1_LATENCY_ASR_FIXTURE_MANIFEST;
  const attemptId = typeof randomUUID === 'function' ? randomUUID() : null;
  if (!UUID.test(String(attemptId ?? '')) || !isAbsoluteFile(fixtureManifest)
    || !fixtureManifest.toLowerCase().endsWith('.json')
    || typeof executeWorkload !== 'function' || typeof workloadFetch !== 'function') {
    throw new Error('Controlled workload execution input is invalid');
  }
  let capture = null;
  const ledger = [];
  const fetchImpl = createControlledWorkloadFetch(workloadFetch, plan, ledger);
  const result = await executeWorkload({
    argv: [
      '--candidate-origin', plan.candidateOrigin,
      '--asr-manifest', fixtureManifest,
      '--confirm-approved-candidate',
    ],
    environment: {
      ...environment,
      V1_LOAD_TEST_CONFIRM: 'true',
      V1_RELEASE_COMMIT_SHA: plan.releaseSha,
      V1_PUBLIC_ORIGIN: plan.serviceOrigin,
      V1_CANDIDATE_ORIGIN: plan.candidateOrigin,
      V1_SOURCE_ARCHIVE_SHA256: plan.sourceArchiveSha256,
      V1_CANDIDATE_IMAGE_DIGEST: plan.imageDigest,
      V1_CANDIDATE_REVISION: plan.candidateRevision,
      V1_CANDIDATE_TRAFFIC_PERCENT: String(candidateTrafficPercent(plan)),
      V1_CANDIDATE_AUDIENCE: plan.candidateServiceOrigin,
      V1_CANDIDATE_SERVICE: CANDIDATE_SERVICE,
      V1_STABLE_SERVICE: STABLE_SERVICE,
      V1_CANDIDATE_TRAFFIC_STATE: candidateTrafficState(plan),
      V1_STABLE_TRAFFIC_STATE: plan.expectedStable.initialTrafficState,
    },
    cwd: APP_ROOT,
    artifactDirectory: dirname(entry.filePath),
    now,
    fetchImpl,
    writeArtifact: async (value) => {
      if (capture !== null || !value || typeof value.contents !== 'string'
        || !value.record || typeof value.filePath !== 'string') {
        throw new Error('Controlled workload artifact capture is invalid');
      }
      capture = Object.freeze({ ...value });
    },
    writeOutput: () => undefined,
  });
  if (result?.exitCode !== 0 || result?.publicReport?.code !== 'LATENCY_ACCEPTANCE_PASSED'
    || !capture || result.publicReport.artifactSha256 !== capture.record.artifactSha256
    || capture.filePath !== join(dirname(entry.filePath), `${plan.releaseSha}-${capture.record.artifactSha256}.json`)
    || capture.contents !== `${JSON.stringify(capture.record, null, 2)}\n`
    || containsForbiddenPersistedSecret(capture.record)) {
    throw new Error('Controlled workload did not produce exact passing evidence');
  }
  let attestation;
  try { attestation = validateLatencyAcceptanceRecord(capture.record, plan, now()); } catch (error) {
    error.code = 'WORKLOAD_CONTROLLED_ARTIFACT_INVALID';
    throw error;
  }
  let witness;
  try { witness = validateControlledWorkloadNetwork(ledger, capture.record); } catch (error) {
    error.code ??= 'WORKLOAD_CONTROLLED_NETWORK_INVALID';
    throw error;
  }
  const contents = Buffer.from(capture.contents);
  const evidence = Object.freeze({
    filePath: entry.filePath,
    artifactSha256: capture.record.artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
  });
  return Object.freeze({
    attestation,
    contents,
    evidence,
    execution: Object.freeze({
      acceptanceWindowId: attestation.acceptanceWindowId,
      attemptId: attemptId.toLowerCase(),
      networkWitnessSha256: witness.networkWitnessSha256,
      observedRequestCount: witness.observedRequestCount,
    }),
  });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

export async function runGcpRelease({
  argv = process.argv.slice(2),
  input,
  execute,
  verifyEvidence = validateEvidenceArtifactSet,
  inspectCollected = inspectCollectedEvidenceArtifact,
  verifySourceArchive = verifyReleaseArchiveBytes,
  verifyTask8Evidence = validateTask8EvidenceArtifact,
  writeCandidateSpec = writeCandidateServiceSpecFile,
  writeStableSpec = writeStableServiceSpecFile,
  writeIamRestorePolicy = writePromotionIamRestorePolicyFile,
  removeIamRestorePolicy = removePromotionIamRestorePolicyFile,
  executeWorkload = runLatencyAcceptance,
  workloadFetch = globalThis.fetch,
  randomUUID = systemRandomUUID,
  loadReceipts = loadReleaseReceiptFiles,
  persistReceipt = persistReleaseReceipt,
  now = () => new Date(),
  environment = process.env,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const selection = parseArguments(argv, input?.releaseSha);
  if (!RELEASE_SHA.test(String(input?.releaseSha ?? ''))) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RELEASE_CONTRACT_INVALID', mutationPerformed: false,
    });
  }
  if (!selection) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'EXACT_RELEASE_CONFIRMATION_REQUIRED', mutationPerformed: false,
    });
  }
  let plan;
  try {
    plan = buildReleasePlan(input, { phase: selection.phase });
  } catch {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RELEASE_CONTRACT_INVALID', mutationPerformed: false,
    });
  }
  const selected = plan.operations.filter(({ phase }) => phase === selection.phase);
  if (selection.phase === 'rollback'
    && (plan.previousRevision === null || plan.previousImageDigest === null)) {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'ROLLBACK_UNAVAILABLE_NO_PRIOR_RELEASE', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'GCP_RELEASE_DRY_RUN', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase,
      plannedOperations: selected.map(({ id }) => id),
    });
  }
  if (selection.phase === 'build') {
    try {
      if (typeof verifySourceArchive !== 'function'
        || await verifySourceArchive(plan.sourceArchive, plan.sourceArchiveSha256) !== true) {
        throw new Error('release archive drift');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed', code: 'RELEASE_SOURCE_ARCHIVE_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  let priorReceipts = [];
  const receiptPhaseIndex = RECEIPT_PHASES.indexOf(selection.phase);
  const task8Attestations = {};
  let workloadExecution = null;
  try {
    if (selection.phase === 'promote') {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      priorReceipts = await loadReceipts(plan, { through: 'mobile' });
      validateReleaseReceiptChain(priorReceipts, plan, { through: 'mobile' });
    } else if (['candidate-cleanup', 'rollback'].includes(selection.phase)) {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      const through = selection.phase === 'rollback' ? 'mobile' : 'candidate';
      priorReceipts = await loadReceipts(plan, { through });
      validateReleaseReceiptChain(priorReceipts, plan, { through });
    } else if (receiptPhaseIndex > 0) {
      if (typeof loadReceipts !== 'function') throw new Error('receipt loader unavailable');
      const through = RECEIPT_PHASES[receiptPhaseIndex - 1];
      priorReceipts = await loadReceipts(plan, { through });
      validateReleaseReceiptChain(priorReceipts, plan, { through });
    }
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_RECEIPT_CHAIN_INVALID', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  if (selection.phase === 'workload') {
    try {
      workloadExecution = await executeControlledWorkload(plan, {
        environment, executeWorkload, workloadFetch, randomUUID, now,
      });
      task8Attestations.workload = workloadExecution.attestation;
    } catch (error) {
      return publish(writeOutput, 1, {
        status: 'failed',
        code: [
          'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN',
          'WORKLOAD_CONTROLLED_ARTIFACT_INVALID',
          'WORKLOAD_CONTROLLED_NETWORK_INVALID',
        ].includes(error?.code) || String(error?.code ?? '').startsWith('WORKLOAD_CONTROLLED_NETWORK_')
          ? error.code : 'WORKLOAD_CONTROLLED_EXECUTION_INVALID',
        mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  try {
    const task8Phases = ['promote', 'rollback'].includes(selection.phase)
      ? ['readiness', 'workload', 'mobile']
      : (['readiness', 'mobile'].includes(selection.phase) ? [selection.phase] : []);
    for (const phase of task8Phases) {
      if (typeof verifyTask8Evidence !== 'function') {
        throw new Error('Task 8 evidence verification failed');
      }
      const verified = await verifyTask8Evidence(plan.task8Evidence[phase], phase, plan, { now: now() });
      if (verified !== true && !(phase === 'workload' && verified
        && typeof verified === 'object' && !Array.isArray(verified))) {
        throw new Error('Task 8 evidence verification failed');
      }
      task8Attestations[phase] = verified;
      if (selection.phase === 'promote' && phase === 'workload' && verified !== true) {
        const receipt = priorReceipts.find((value) => value.phase === 'workload');
        if (receipt?.outputs?.execution?.acceptanceWindowId !== verified.acceptanceWindowId) {
          throw new Error('Workload execution receipt differs from fresh evidence');
        }
      }
    }
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'TASK8_EVIDENCE_INVALID', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
    });
  }
  let executor;
  try {
    executor = execute ?? (selected.length > 0 || task8Attestations.workload !== undefined
      ? createDefaultGcloudExecutor({ environment })
      : async () => { throw new Error('No control-plane operation is planned'); });
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'CONTROL_PLANE_UNAVAILABLE', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase,
    });
  }
  const completed = [];
  const evidenceSecretVersions = {};
  const collectedEvidence = {};
  const collectedObjectReceipts = new Map();
  const candidateReadbacks = {};
  const promotionReadbacks = {};
  let buildReceipt = null;
  let migrationExecutionReceipt = null;
  let mutationAttempted = false;
  let promotionIamBaseline = null;
  let stablePublicIamBaseline = null;
  let stablePriorRevisionBaseline = null;
  let stablePriorArtifactBaseline = null;
  let candidateDeployMutationAttempted = false;
  let candidateIamMutationAttempted = false;
  let promotionStableMutationAttempted = false;
  let promotionIamMutationAttempted = false;
  let promotionTrafficMutationAttempted = false;
  let workloadArtifactPublished = false;
  let candidateCleanupState = null;
  let activeOperationId = null;
  const responseLossRecoveries = [];
  if (task8Attestations.workload && task8Attestations.workload !== true) {
    try {
      const attestation = task8Attestations.workload;
      const rawLogs = await executor(workloadLoggingReadArgv(attestation));
      const normalized = normalizeControlPlaneTurnReceipts(rawLogs, {
        acceptanceWindowId: attestation.acceptanceWindowId,
        candidateOrigin: attestation.candidateOrigin,
        candidateRevision: attestation.candidateRevision,
        expectedTraceIds: attestation.expectedTraceIds,
      });
      if (!normalized || !exact(normalized, attestation.controlPlaneRequests)) {
        throw new Error('workload request logs differ from the evidence artifact');
      }
    } catch {
      return publish(writeOutput, 1, {
        status: 'failed', code: 'WORKLOAD_CONTROL_PLANE_INVALID', mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  if (selection.phase === 'workload') {
    try {
      await assertControlledWorkloadTargetAbsent(workloadExecution.evidence);
      await writeFile(workloadExecution.evidence.filePath, workloadExecution.contents, { flag: 'wx' });
      workloadArtifactPublished = true;
      const verified = await validateTask8EvidenceArtifact(
        workloadExecution.evidence, 'workload', plan, { now: now() },
      );
      if (!exact(verified, workloadExecution.attestation)) {
        throw new Error('Published workload evidence differs from controlled execution');
      }
    } catch {
      let cleanupFailed = false;
      if (workloadArtifactPublished) {
        try {
          await rm(workloadExecution.evidence.filePath);
          await assertControlledWorkloadTargetAbsent(workloadExecution.evidence);
        } catch { cleanupFailed = true; }
      }
      return publish(writeOutput, 1, {
        status: 'failed',
        code: cleanupFailed ? 'WORKLOAD_EVIDENCE_CLEANUP_FAILED' : 'WORKLOAD_EVIDENCE_PUBLISH_FAILED',
        mutationPerformed: false,
        releaseSha: plan.releaseSha, phase: selection.phase, completed: [],
      });
    }
  }
  try {
    if (selection.phase === 'collect') {
      await assertCollectionDestinationsAbsent(plan.acceptanceOutputs);
    } else if (selection.phase === 'inventory') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence({ legacyInventory: plan.evidence.legacyInventory }, { releaseSha: plan.releaseSha });
    } else if (selection.phase === 'evidence') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence(plan.evidence, { releaseSha: plan.releaseSha });
    } else if (['candidate-cleanup', 'rollback'].includes(selection.phase)) {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence(plan.evidence, { releaseSha: plan.releaseSha });
    }
    for (const member of selected) {
      if (candidateCleanupState === 'already-absent'
        && member.id !== 'candidate-cleanup-absence-readback') continue;
      activeOperationId = member.id;
      if (operationMayMutate(member.id)) mutationAttempted = true;
      if (member.id === 'candidate-deploy') candidateDeployMutationAttempted = true;
      if (member.id === 'candidate-private-iam-grant') candidateIamMutationAttempted = true;
      if (member.id === 'promote-stable-deploy') promotionStableMutationAttempted = true;
      if (member.id === 'promote-public-service') promotionIamMutationAttempted = true;
      if (member.id === 'promote-traffic') promotionTrafficMutationAttempted = true;
      let receipt;
      let canonicalServiceAbsence = false;
      try {
        receipt = await executor(member.argv);
      } catch (error) {
        if (member.id === 'candidate-deploy') {
          const current = await executor([
            'run', 'services', 'describe', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateService(current, plan.expectedCandidate);
          const revision = await executor([
            'run', 'revisions', 'describe', plan.candidateRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateRevisionReadback(revision, plan);
          const artifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.image,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(artifact, plan.image);
          const iam = await executor([
            'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(iam, { policy: 'stable-private', requireEtag: true });
          receipt = current;
          responseLossRecoveries.push('candidate-deploy');
        } else if (member.id === 'candidate-private-iam-grant') {
          receipt = await executor([
            'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
          responseLossRecoveries.push('candidate-private-iam-grant');
        } else if (member.id === 'promote-stable-deploy') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateStableStagedService(receipt, plan);
          responseLossRecoveries.push('promote-stable-deploy');
        } else if (member.id === 'promote-public-service') {
          receipt = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
          responseLossRecoveries.push('promote-public-service');
        } else if (member.id === 'promote-traffic') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePromotedService(receipt, plan);
          responseLossRecoveries.push('promote-traffic');
        } else if (member.id === 'rollback-traffic') {
          receipt = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateCleanupService(receipt, plan);
          responseLossRecoveries.push('rollback-traffic');
        } else if (member.id === 'candidate-cleanup-delete') {
          try {
            await executor([
              'run', 'services', 'describe', CANDIDATE_SERVICE,
              `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
            ]);
            throw error;
          } catch (readbackError) {
            if (readbackError?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
          }
          receipt = { responseLossRecovered: true };
          responseLossRecoveries.push('candidate-cleanup-delete');
        } else {
          canonicalServiceAbsence = error?.code === 'CLOUD_RUN_SERVICE_NOT_FOUND';
          const absenceRead = member.id === 'candidate-service-precheck'
            || member.id === 'candidate-cleanup-service-precheck'
            || member.id === 'candidate-cleanup-absence-readback'
            || (member.id === 'promote-stable-service-precheck' && plan.previousRevision === null);
          if (!canonicalServiceAbsence || !absenceRead) throw error;
          receipt = null;
        }
      }
      if (member.id === 'build-submit') {
        buildReceipt = validateBuildReceipt(receipt, {
          releaseSha: plan.releaseSha,
          sourceArchiveSha256: plan.sourceArchiveSha256,
        });
        if (plan.imageDigest && buildReceipt.imageDigest !== plan.imageDigest) {
          throw new Error('Build digest does not match the release manifest');
        }
      } else if (member.id === 'build-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 1) {
          throw new Error('Build readback is ambiguous');
        }
        const readback = validateBuildReceipt(receipt[0], {
          releaseSha: plan.releaseSha,
          sourceArchiveSha256: plan.sourceArchiveSha256,
        });
        if (!buildReceipt || !exact(readback, buildReceipt)) {
          throw new Error('Build readback differs from submission');
        }
      } else if (member.id === 'migration-readback') {
        validateReleaseJobReadback(receipt, plan.expectedMigrationJob);
      } else if (member.id === 'migration-execute') {
        migrationExecutionReceipt = validateMigrationExecutionReceipt(receipt, {
          releaseSha: plan.releaseSha,
        });
      } else if (member.id === 'promote-authority-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 1
          || receipt[0]?.account !== PROMOTION_AUTHORITY
          || receipt[0]?.status !== 'ACTIVE') {
          throw new Error('Public promotion authority is not approved');
        }
      } else if (member.id === 'promote-candidate-service-readback') {
        promotionReadbacks.service = receipt;
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'promote-candidate-revision-readback') {
        promotionReadbacks.revision = receipt;
      } else if (member.id === 'promote-candidate-iam-readback') {
        promotionReadbacks.iam = receipt;
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'promote-candidate-artifact-readback') {
        promotionReadbacks.artifact = receipt;
        validateCandidateControlPlaneReadbacks(promotionReadbacks, plan);
      } else if (member.id === 'promote-stable-service-precheck') {
        if (plan.previousRevision === null) {
          if (receipt !== null || !canonicalServiceAbsence) {
            throw new Error('First stable service already exists or absence is unproven');
          }
        } else {
          if (receipt === null) throw new Error('Prior stable service is absent');
          validateStableService(receipt, plan);
        }
        if (typeof writeStableSpec !== 'function' || await writeStableSpec(plan) !== true) {
          throw new Error('Stable Service YAML is unavailable');
        }
      } else if (member.id === 'promote-stable-public-iam-precheck') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        stablePublicIamBaseline = normalizeServiceIamPolicy(receipt, { requireEtag: true });
      } else if (member.id === 'promote-prior-revision-readback') {
        validatePriorRevisionReadback(receipt, plan);
        stablePriorRevisionBaseline = structuredClone(receipt);
      } else if (member.id === 'promote-prior-artifact-readback') {
        validateCandidateArtifact(receipt, plan.previousImage);
        stablePriorArtifactBaseline = structuredClone(receipt);
      } else if (member.id === 'promote-stable-spec-dry-run') {
        validateStableServiceSpecDryRun(receipt, plan);
      } else if (member.id === 'promote-stable-deploy'
        || member.id === 'promote-stable-staged-readback') {
        validateStableStagedService(receipt, plan);
      } else if (member.id === 'promote-stable-revision-readback') {
        validateStableRevisionReadback(receipt, plan);
      } else if (member.id === 'promote-stable-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'promote-stable-private-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-private', requireEtag: true });
        promotionIamBaseline = normalizeServiceIamPolicy(receipt, { requireEtag: true });
      } else if (member.id === 'promote-public-service') {
        if (!promotionIamBaseline) throw new Error('Promotion IAM baseline is unavailable');
        const normalized = validateIamPolicyState(
          receipt, publicIamPolicyState(promotionIamBaseline), { requireEtag: true },
        );
        if (normalized.etag === promotionIamBaseline.etag) {
          throw new Error('Promotion IAM mutation has no new etag');
        }
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
      } else if (member.id === 'promote-public-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
        if (plan.previousRevision === null) {
          if (!promotionIamBaseline) throw new Error('Promotion IAM baseline is unavailable');
          validateIamPolicyState(
            receipt, publicIamPolicyState(promotionIamBaseline), { requireEtag: true },
          );
        } else if (!stablePublicIamBaseline
          || !exact(iamPolicyState(normalizeServiceIamPolicy(receipt, { requireEtag: true })),
            iamPolicyState(stablePublicIamBaseline))) {
          throw new Error('Stable public IAM changed during promotion');
        }
      } else if (member.id === 'candidate-service-precheck') {
        if (receipt !== null || !canonicalServiceAbsence) {
          throw new Error('Candidate service already exists or absence is unproven; cleanup is required');
        }
        if (typeof writeCandidateSpec !== 'function'
          || await writeCandidateSpec(plan) !== true) {
          throw new Error('Candidate Service YAML is unavailable');
        }
      } else if (member.id === 'candidate-spec-dry-run') {
        validateCandidateServiceSpecDryRun(receipt, plan);
      } else if (member.id === 'candidate-deploy') {
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'candidate-private-iam-baseline-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-private', requireEtag: true });
      } else if (member.id === 'candidate-private-iam-grant') {
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-private-iam-readback') {
        candidateReadbacks.iam = receipt;
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-service-readback') {
        candidateReadbacks.service = receipt;
        validateCandidateService(receipt, plan.expectedCandidate);
      } else if (member.id === 'candidate-revision-readback') {
        candidateReadbacks.revision = receipt;
      } else if (member.id === 'candidate-artifact-readback') {
        candidateReadbacks.artifact = receipt;
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'candidate-cleanup-service-precheck') {
        if (receipt === null && canonicalServiceAbsence) candidateCleanupState = 'already-absent';
        else if (receipt === null) throw new Error('Candidate service absence is unproven');
        else validateRecoveryPrecheck(receipt, plan, 'candidate-cleanup');
      } else if (member.id === 'candidate-cleanup-revision-readback') {
        validateCandidateRevisionReadback(receipt, plan);
      } else if (member.id === 'candidate-cleanup-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'candidate-cleanup-private-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'candidate-private', requireEtag: true });
      } else if (member.id === 'candidate-cleanup-delete') {
        // gcloud 553 synchronous service deletion returns empty stdout/null.
        // The following exact service-specific absence readback is the receipt.
      } else if (member.id === 'candidate-cleanup-absence-readback') {
        if (receipt !== null || !canonicalServiceAbsence) {
          throw new Error('Candidate service remains or absence is unproven after cleanup');
        }
        if (candidateCleanupState === null) candidateCleanupState = 'deleted';
      } else if (member.id === 'promote-traffic') {
        if (responseLossRecoveries.includes(member.id)) validatePromotedService(receipt, plan);
        else validateTrafficTargetAcknowledgement(receipt, {
          revision: plan.stableRevision, serviceUrl: plan.serviceOrigin,
        });
      } else if (member.id === 'promote-readback') {
        validatePromotedService(receipt, plan);
      } else if (member.id === 'rollback-service-precheck') {
        validateRecoveryPrecheck(receipt, plan, 'rollback');
      } else if (member.id === 'rollback-current-revision-readback') {
        validateStableRevisionReadback(receipt, plan);
      } else if (member.id === 'rollback-current-artifact-readback') {
        validateCandidateArtifact(receipt, plan.image);
      } else if (member.id === 'rollback-prior-revision-readback') {
        validatePriorRevisionReadback(receipt, plan);
      } else if (member.id === 'rollback-prior-artifact-readback') {
        validateCandidateArtifact(receipt, plan.previousImage);
      } else if (member.id === 'rollback-public-iam-precheck'
        || member.id === 'rollback-public-iam-readback') {
        validateServiceIamReceipt(receipt, { policy: 'stable-public', requireEtag: true });
      } else if (member.id === 'rollback-traffic') {
        if (responseLossRecoveries.includes(member.id)) validateCandidateCleanupService(receipt, plan);
        else validateTrafficTargetAcknowledgement(receipt, {
          revision: plan.previousRevision, serviceUrl: plan.serviceOrigin,
        });
      } else if (member.id === 'rollback-readback') {
        validateCandidateCleanupService(receipt, plan);
      } else if (selection.phase === 'acceptance' && member.id.endsWith('-readback')) {
        const key = member.id.slice(0, -'-readback'.length);
        validateReleaseJobReadback(receipt, plan.expectedJobs[key]);
      } else if (member.id.startsWith('evidence-collect-describe:')) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        collectedObjectReceipts.set(
          key,
          validateAcceptanceObjectReceipt(receipt, plan.acceptanceOutputs[key]),
        );
      } else if (member.id.startsWith('evidence-collect-copy:')) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        if (!collectedObjectReceipts.has(key) || typeof inspectCollected !== 'function') {
          throw new Error('Evidence collection is not generation-bound');
        }
        const inspected = await inspectCollected(
          plan.acceptanceOutputs[key].filePath,
          { releaseSha: plan.releaseSha, kind: key },
        );
        if (inspected.byteLength !== collectedObjectReceipts.get(key).size) {
          throw new Error('Collected evidence bytes differ from object receipt');
        }
        collectedEvidence[key] = Object.freeze({
          artifactSha256: inspected.artifactSha256,
          objectSha256: inspected.objectSha256,
          byteLength: inspected.byteLength,
        });
      } else if (member.id === 'evidence-output-zero-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 0) {
          throw new Error('Acceptance evidence output residue remains');
        }
      }
      if (/^(?:inventory|evidence)-(?:publish|readback):/.test(member.id)) {
        const key = member.id.slice(member.id.indexOf(':') + 1);
        const expected = plan.evidence[key];
        validateEvidenceVersionReceipt(receipt, expected);
        if (member.id.includes('-publish:')) {
          evidenceSecretVersions[key] = expected.secretVersion;
        } else if (evidenceSecretVersions[key] !== expected.secretVersion) {
          throw new Error('Evidence version readback is not publication-bound');
        }
      }
      completed.push(member.id);
      activeOperationId = null;
    }
    if (selection.phase === 'candidate') {
      validateCandidateControlPlaneReadbacks(candidateReadbacks, plan);
    }
  } catch {
    let compensationFailed = false;
    let candidateServiceRestored = null;
    let promotionServiceRestored = null;
    let promotionIamRestored = null;

    const readCandidateState = async () => {
      const service = await executor([
        'run', 'services', 'describe', CANDIDATE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      validateCandidateService(service, plan.expectedCandidate);
      const revision = await executor([
        'run', 'revisions', 'describe', plan.candidateRevision,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      validateCandidateRevisionReadback(revision, plan);
      const artifact = await executor([
        'artifacts', 'docker', 'images', 'describe', plan.image,
        `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
      ]);
      validateCandidateArtifact(artifact, plan.image);
      const iam = await executor([
        'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
        `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
      ]);
      validateServiceIamReceipt(iam, { policy: 'candidate-private', requireEtag: true });
      return { artifact, iam, revision, service };
    };

    if (selection.phase === 'candidate'
      && (candidateDeployMutationAttempted || candidateIamMutationAttempted)) {
      try {
        let candidate = null;
        try {
          candidate = await executor([
            'run', 'services', 'describe', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
        } catch (error) {
          if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
        }
        if (candidate !== null) {
          validateCandidateService(candidate, plan.expectedCandidate);
          const revision = await executor([
            'run', 'revisions', 'describe', plan.candidateRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateCandidateRevisionReadback(revision, plan);
          const artifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.image,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(artifact, plan.image);
          const iam = await executor([
            'run', 'services', 'get-iam-policy', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          try {
            validateServiceIamReceipt(iam, { policy: 'stable-private', requireEtag: true });
          } catch {
            validateServiceIamReceipt(iam, { policy: 'candidate-private', requireEtag: true });
          }
          try {
            await executor([
              'run', 'services', 'delete', CANDIDATE_SERVICE, '--quiet',
              `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
            ]);
          } catch (deleteError) {
            try {
              await executor([
                'run', 'services', 'describe', CANDIDATE_SERVICE,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              throw deleteError;
            } catch (readbackError) {
              if (readbackError?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw deleteError;
            }
          }
        }
        try {
          await executor([
            'run', 'services', 'describe', CANDIDATE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          throw new Error('Candidate compensation did not remove the candidate service');
        } catch (error) {
          if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
        }
        candidateServiceRestored = true;
      } catch {
        compensationFailed = true;
        candidateServiceRestored = false;
      }
    }

    const promotionMutationAttempted = selection.phase === 'promote'
      && (promotionStableMutationAttempted
        || promotionTrafficMutationAttempted || promotionIamMutationAttempted);
    if (promotionMutationAttempted) {
      let restorePath = null;
      try {
        if (typeof verifyEvidence !== 'function'
          || await verifyEvidence(plan.evidence, { releaseSha: plan.releaseSha }) !== true) {
          throw new Error('Promotion compensation evidence is invalid');
        }
        await readCandidateState();
        if (plan.previousRevision === null) {
          let stable = null;
          try {
            stable = await executor([
              'run', 'services', 'describe', STABLE_SERVICE,
              `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
            ]);
          } catch (error) {
            if (error?.code !== 'CLOUD_RUN_SERVICE_NOT_FOUND') throw error;
          }
          if (stable === null) {
            if (typeof writeStableSpec !== 'function' || await writeStableSpec(plan) !== true) {
              throw new Error('Stable Service YAML is unavailable');
            }
            const dryRun = await executor([
              'run', 'services', 'replace', plan.stableServiceSpecPath,
              `--project=${PROJECT}`, `--region=${REGION}`, '--dry-run', '--format=json',
            ]);
            validateStableServiceSpecDryRun(dryRun, plan);
            try {
              stable = await executor([
                'run', 'services', 'replace', plan.stableServiceSpecPath,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateStableStagedService(stable, plan);
            } catch {
              stable = await executor([
                'run', 'services', 'describe', STABLE_SERVICE,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateStableStagedService(stable, plan);
              responseLossRecoveries.push('first-promotion-stable-compensation');
            }
          } else {
            validatePromotionCompensationSource(stable, plan);
          }
          const stableRevision = await executor([
            'run', 'revisions', 'describe', plan.stableRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateStableRevisionReadback(stableRevision, plan);
          const stableArtifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.image,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(stableArtifact, plan.image);
          const currentIamReceipt = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          const currentIam = normalizeServiceIamPolicy(currentIamReceipt, { requireEtag: true });
          let stableIsPrivate = true;
          try {
            validateServiceIamReceipt(currentIamReceipt, {
              policy: 'stable-private', requireEtag: true,
            });
          } catch {
            stableIsPrivate = false;
            validateServiceIamReceipt(currentIamReceipt, {
              policy: 'stable-public', requireEtag: true,
            });
          }
          if (!stableIsPrivate) {
            const privateState = promotionIamBaseline
              ? iamPolicyState(promotionIamBaseline)
              : { bindings: [], version: currentIam.version };
            if (!exact(privateState.bindings, [])) {
              throw new Error('First promotion private IAM baseline is invalid');
            }
            const restorePolicy = {
              bindings: [],
              etag: currentIam.etag,
              ...(privateState.version === null ? {} : { version: privateState.version }),
            };
            const attemptId = typeof randomUUID === 'function' ? randomUUID() : null;
            const expectedRestorePath = promotionIamRestorePolicyPath(plan, attemptId);
            restorePath = typeof writeIamRestorePolicy === 'function'
              ? await writeIamRestorePolicy(plan, restorePolicy, { attemptId }) : null;
            if (restorePath !== expectedRestorePath) {
              throw new Error('Promotion IAM restore policy is unavailable');
            }
            try {
              const restored = await executor([
                'run', 'services', 'set-iam-policy', STABLE_SERVICE, restorePath,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateServiceIamReceipt(restored, {
                policy: 'stable-private', requireEtag: true,
              });
            } catch {
              const restored = await executor([
                'run', 'services', 'get-iam-policy', STABLE_SERVICE,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateServiceIamReceipt(restored, {
                policy: 'stable-private', requireEtag: true,
              });
              responseLossRecoveries.push('first-promotion-iam-compensation');
            }
          }
          const freshStable = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePromotionCompensationSource(freshStable, plan);
          const freshRevision = await executor([
            'run', 'revisions', 'describe', plan.stableRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateStableRevisionReadback(freshRevision, plan);
          const freshArtifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.image,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(freshArtifact, plan.image);
          const freshIam = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(freshIam, { policy: 'stable-private', requireEtag: true });
        } else {
          if (!stablePublicIamBaseline || !stablePriorRevisionBaseline
            || !stablePriorArtifactBaseline) {
            throw new Error('Prior stable compensation baseline is unavailable');
          }
          const currentStable = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePromotionCompensationSource(currentStable, plan);
          const currentIam = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(currentIam, { policy: 'stable-public', requireEtag: true });
          if (!exact(iamPolicyState(normalizeServiceIamPolicy(currentIam, { requireEtag: true })),
            iamPolicyState(stablePublicIamBaseline))) {
            throw new Error('Stable public IAM changed during promotion');
          }
          const currentPriorRevision = await executor([
            'run', 'revisions', 'describe', plan.previousRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePriorRevisionReadback(currentPriorRevision, plan);
          if (!exact(currentPriorRevision, stablePriorRevisionBaseline)) {
            throw new Error('Prior stable revision configuration changed during promotion');
          }
          const currentPriorArtifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.previousImage,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(currentPriorArtifact, plan.previousImage);
          if (!exact(currentPriorArtifact, stablePriorArtifactBaseline)) {
            throw new Error('Prior stable artifact changed during promotion');
          }
          let alreadyRestored = true;
          try {
            validateStableService(currentStable, plan);
          } catch {
            alreadyRestored = false;
          }
          if (!alreadyRestored) {
            try {
              const restored = await executor([
                'run', 'services', 'update-traffic', STABLE_SERVICE,
                `--to-revisions=${plan.previousRevision}=100`,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateStableService(restored, plan);
            } catch {
              const restored = await executor([
                'run', 'services', 'describe', STABLE_SERVICE,
                `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
              ]);
              validateStableService(restored, plan);
              responseLossRecoveries.push('later-promotion-stable-compensation');
            }
          }
          const freshStable = await executor([
            'run', 'services', 'describe', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateStableService(freshStable, plan);
          const freshPriorRevision = await executor([
            'run', 'revisions', 'describe', plan.previousRevision,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validatePriorRevisionReadback(freshPriorRevision, plan);
          if (!exact(freshPriorRevision, stablePriorRevisionBaseline)) {
            throw new Error('Prior stable revision compensation is not exact');
          }
          const freshPriorArtifact = await executor([
            'artifacts', 'docker', 'images', 'describe', plan.previousImage,
            `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
          ]);
          validateCandidateArtifact(freshPriorArtifact, plan.previousImage);
          if (!exact(freshPriorArtifact, stablePriorArtifactBaseline)) {
            throw new Error('Prior stable artifact compensation is not exact');
          }
          const freshIam = await executor([
            'run', 'services', 'get-iam-policy', STABLE_SERVICE,
            `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
          ]);
          validateServiceIamReceipt(freshIam, { policy: 'stable-public', requireEtag: true });
          if (!exact(iamPolicyState(normalizeServiceIamPolicy(freshIam, { requireEtag: true })),
            iamPolicyState(stablePublicIamBaseline))) {
            throw new Error('Stable public IAM compensation is not exact');
          }
        }
        await readCandidateState();
        promotionServiceRestored = true;
        promotionIamRestored = true;
      } catch {
        compensationFailed = true;
        promotionServiceRestored = false;
        promotionIamRestored = false;
      } finally {
        if (restorePath !== null) {
          try {
            if (typeof removeIamRestorePolicy !== 'function'
              || await removeIamRestorePolicy(plan, restorePath) !== true) {
              throw new Error('Promotion IAM restore policy cleanup failed');
            }
          } catch {
            compensationFailed = true;
            promotionIamRestored = false;
          }
        }
      }
    }
    const compensationCode = selection.phase === 'candidate'
      ? 'CANDIDATE_COMPENSATION_FAILED' : 'PROMOTION_COMPENSATION_FAILED';
    return publish(writeOutput, 1, {
      status: 'failed', code: compensationFailed ? compensationCode : 'RELEASE_PHASE_FAILED',
      mutationPerformed: mutationAttempted,
      releaseSha: plan.releaseSha, phase: selection.phase, completed,
      resumeBoundary: activeOperationId ?? selected.find(({ id }) => !completed.includes(id))?.id ?? null,
      ...(candidateServiceRestored === null ? {} : { candidateServiceRestored }),
      ...(promotionServiceRestored === null ? {} : { promotionServiceRestored }),
      ...(promotionIamRestored === null ? {} : { promotionIamRestored }),
      ...(responseLossRecoveries.length === 0 ? {} : { responseLossRecoveries }),
    });
  }
  const publicReport = {
    status: 'phase-complete', code: 'GCP_RELEASE_PHASE_COMPLETE', mutationPerformed: true,
    releaseSha: plan.releaseSha, phase: selection.phase, completed,
  };
  if (selection.phase === 'inventory' || selection.phase === 'evidence') {
    publicReport.evidenceSecretVersions = evidenceSecretVersions;
  }
  if (selection.phase === 'collect') publicReport.collectedEvidence = collectedEvidence;
  if (selection.phase === 'build') publicReport.buildReceipt = buildReceipt;
  if (selection.phase === 'migration') publicReport.migrationExecutionReceipt = migrationExecutionReceipt;
  if (responseLossRecoveries.length > 0) {
    publicReport.responseLossRecoveries = responseLossRecoveries;
  }
  if (candidateCleanupState !== null) {
    publicReport.candidateCleanupState = candidateCleanupState;
  }
  if (receiptPhaseIndex >= 0) {
    try {
      const phaseReceipt = createReleasePhaseReceipt(
        selection.phase,
        plan,
        completed,
        { buildReceipt, migrationExecutionReceipt, collectedEvidence, workloadExecution },
        priorReceipts,
      );
      if (typeof persistReceipt !== 'function' || await persistReceipt(plan, phaseReceipt) !== true) {
        throw new Error('Release receipt persistence failed');
      }
      publicReport.phaseReceipt = phaseReceipt;
    } catch {
      let cleanupFailed = false;
      if (selection.phase === 'workload' && workloadArtifactPublished) {
        try {
          await rm(workloadExecution.evidence.filePath);
          await assertControlledWorkloadTargetAbsent(workloadExecution.evidence);
        } catch { cleanupFailed = true; }
      }
      return publish(writeOutput, 1, {
        status: 'failed', code: cleanupFailed
          ? 'WORKLOAD_EVIDENCE_CLEANUP_FAILED' : 'RELEASE_RECEIPT_WRITE_FAILED',
        mutationPerformed: mutationAttempted,
        releaseSha: plan.releaseSha, phase: selection.phase, completed,
      });
    }
  }
  publicReport.mutationPerformed = mutationAttempted;
  return publish(writeOutput, 0, publicReport);
}

async function readManifest(filePath) {
  if (!isAbsoluteFile(filePath)) throw releaseContractError();
  const metadata = await lstat(filePath);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 128 * 1024) {
    throw releaseContractError();
  }
  const raw = await readFile(filePath, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > 128 * 1024) throw releaseContractError();
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----|"(?:accessToken|access_token|client_secret|private_key)"\s*:|postgres(?:ql)?:\/\/[^/@:]+:[^/@]+@/i.test(raw)) {
    throw releaseContractError();
  }
  return parsed;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const raw = process.argv.slice(2);
  let result;
  if (raw.includes('--prepare-archive')) {
    result = await runPrepareReleaseArchive({ argv: raw });
  } else {
    const manifestArgs = raw.filter((value) => value.startsWith('--manifest='));
    if (manifestArgs.length !== 1) {
      result = { exitCode: 2, publicReport: { status: 'not-run', code: 'RELEASE_MANIFEST_REQUIRED', mutationPerformed: false } };
      process.stdout.write(`${JSON.stringify(result.publicReport)}\n`);
    } else {
      try {
        const input = await readManifest(manifestArgs[0].slice('--manifest='.length));
        result = await runGcpRelease({ argv: raw.filter((value) => !value.startsWith('--manifest=')), input });
      } catch {
        result = { exitCode: 2, publicReport: { status: 'not-run', code: 'RELEASE_MANIFEST_INVALID', mutationPerformed: false } };
        process.stdout.write(`${JSON.stringify(result.publicReport)}\n`);
      }
    }
  }
  process.exitCode = result.exitCode;
}
