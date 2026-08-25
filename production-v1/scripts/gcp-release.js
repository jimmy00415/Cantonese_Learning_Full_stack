import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGzip } from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createDefaultGcloudExecutor } from './gcp-provision.js';

const PROJECT = 'hkbuddy-prod-v1-20260826';
const REGION = 'asia-east2';
const SERVICE = 'hkbuddy-api';
const MIGRATION_JOB = 'hkbuddy-migrate';
const DEPENDENCY_ACCEPTANCE_JOB = 'hkbuddy-dependency-acceptance';
const LLM_SMOKE_JOB = 'hkbuddy-llm-smoke';
const ASR_SMOKE_JOB = 'hkbuddy-asr-smoke';
const TTS_SMOKE_JOB = 'hkbuddy-tts-smoke';
const REPOSITORY = 'hkbuddy';
const BUILD_SERVICE_ACCOUNT = `projects/${PROJECT}/serviceAccounts/hkbuddy-build@${PROJECT}.iam.gserviceaccount.com`;
const RUNTIME_SERVICE_ACCOUNT = `hkbuddy-runtime@${PROJECT}.iam.gserviceaccount.com`;
const MIGRATOR_SERVICE_ACCOUNT = `hkbuddy-migrator@${PROJECT}.iam.gserviceaccount.com`;
const ACCEPTANCE_SERVICE_ACCOUNT = `hkbuddy-acceptance@${PROJECT}.iam.gserviceaccount.com`;
const PROMOTION_AUTHORITY = 'admin@motionexp.com';
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST = /^sha256:[0-9a-f]{64}$/;
const NUMERIC_VERSION = /^[1-9]\d*$/;
const PROJECT_NUMBER = /^\d{6,20}$/;
const REVISION = /^hkbuddy-api-[a-z0-9](?:[a-z0-9-]{0,47}[a-z0-9])?$/;
const BUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ACCEPTANCE_RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PHASES = Object.freeze([
  'build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence', 'candidate', 'promote', 'rollback',
]);
const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLOUD_BUILD_CONFIG = resolve(APP_ROOT, 'cloudbuild.yaml');
const execFileAsync = promisify(execFile);

const EVIDENCE_DEFINITIONS = Object.freeze({
  legacyInventory: Object.freeze({
    secret: 'hkbuddy-legacy-inventory',
    mountPath: '/var/run/secrets/hkbuddy/legacy-inventory.json',
    fileEnv: 'V1_LEGACY_RESOURCE_INVENTORY_FILE',
    versionEnv: 'V1_LEGACY_RESOURCE_INVENTORY_VERSION',
  }),
  dependencyAcceptance: Object.freeze({
    secret: 'hkbuddy-dependency-acceptance',
    mountPath: '/var/run/secrets/hkbuddy/dependency-acceptance.json',
    fileEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE',
    versionEnv: 'V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION',
  }),
  llmSmoke: Object.freeze({
    secret: 'hkbuddy-llm-smoke',
    mountPath: '/var/run/secrets/hkbuddy/llm-smoke.json',
    fileEnv: 'V1_LLM_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_LLM_SMOKE_EVIDENCE_VERSION',
  }),
  asrSmoke: Object.freeze({
    secret: 'hkbuddy-asr-smoke',
    mountPath: '/var/run/secrets/hkbuddy/asr-smoke.json',
    fileEnv: 'V1_ASR_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_ASR_SMOKE_EVIDENCE_VERSION',
  }),
  ttsSmoke: Object.freeze({
    secret: 'hkbuddy-tts-smoke',
    mountPath: '/var/run/secrets/hkbuddy/tts-smoke.json',
    fileEnv: 'V1_TTS_SMOKE_EVIDENCE_FILE',
    versionEnv: 'V1_TTS_SMOKE_EVIDENCE_VERSION',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: 'hkbuddy-ios-voice-acceptance',
    mountPath: '/var/run/secrets/hkbuddy/ios-voice-acceptance.json',
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

function isAbsoluteFile(value) {
  return typeof value === 'string' && value.length > 3
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value))
    && !/[\u0000\r\n]/.test(value);
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
      || member.bucket !== `${PROJECT}-media`
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
    V1_POSTGRES_RESOURCE_ID: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/hkbuddy-pg/databases/hkbuddy_v1`,
    V1_MEDIA_DRIVER: 'gcs',
    V1_GOOGLE_CLOUD_PROJECT: PROJECT,
    V1_GCS_BUCKET: `${PROJECT}-media`,
    V1_GCS_RESOURCE_ID: `//storage.googleapis.com/projects/_/buckets/${PROJECT}-media`,
    V1_LLM_PROVIDER: 'vertex-ai',
    V1_VERTEX_LOCATION: 'global',
    V1_VERTEX_MODEL: 'gemini-2.5-flash',
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-runtime-v1',
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
    V1_DATABASE_URL: Object.freeze({ secret: 'hkbuddy-db-app-url', version: databaseSecretVersions.app }),
    V1_SESSION_SECRET: Object.freeze({ secret: 'hkbuddy-session-secret', version: databaseSecretVersions.session }),
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

export function buildReleasePlan(input = {}, { phase = null } = {}) {
  if (phase !== null && !PHASES.includes(phase)) throw releaseContractError();
  const unresolvedImage = phase === 'build' && input.imageDigest === null;
  const unresolvedDatabase = ['build', 'inventory', 'collect', 'evidence', 'rollback'].includes(phase)
    && input.databaseSecretVersions === null;
  const unresolvedEvidence = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'rollback'].includes(phase)
    && input.evidence === null;
  const unresolvedAcceptanceOutputs = ['build', 'migration', 'inventory', 'acceptance', 'rollback'].includes(phase)
    && input.acceptanceOutputs === null;
  const unresolvedPrevious = phase !== null && phase !== 'rollback'
    && input.previousRevision === null;
  if (!exactKeys(input, [
    'acceptanceOutputs', 'acceptanceRunId', 'databaseSecretVersions', 'evidence', 'imageDigest', 'legacyInventory', 'previousRevision',
    'projectNumber', 'releaseSha', 'sourceArchive', 'sourceArchiveSha256',
  ])
    || !RELEASE_SHA.test(String(input.releaseSha ?? ''))
    || !ACCEPTANCE_RUN_ID.test(String(input.acceptanceRunId ?? ''))
    || !DIGEST.test(String(input.sourceArchiveSha256 ?? ''))
    || (!IMAGE_DIGEST.test(String(input.imageDigest ?? '')) && !unresolvedImage)
    || !PROJECT_NUMBER.test(String(input.projectNumber ?? ''))
    || !isAbsoluteFile(input.sourceArchive)
    || !/\.(?:tar\.gz|tgz)$/i.test(input.sourceArchive)
    || (!unresolvedDatabase && (
      !exactKeys(input.databaseSecretVersions, ['app', 'migrator', 'session'])
      || Object.values(input.databaseSecretVersions).some((value) => !NUMERIC_VERSION.test(String(value ?? '')))
    ))
    || (!unresolvedPrevious && !REVISION.test(String(input.previousRevision ?? '')))
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
  const previousRevision = unresolvedPrevious ? 'hkbuddy-api-unresolved' : input.previousRevision;
  const releaseSha = input.releaseSha;
  const acceptanceOutputs = unresolvedAcceptanceOutputs
    ? assertAcceptanceOutputs(Object.fromEntries(Object.entries(
      expectedAcceptanceObjects(releaseSha, input.acceptanceRunId),
    ).map(([key, object]) => [key, {
      bucket: `${PROJECT}-media`, object, generation: '1', filePath: `/unresolved/${key}.json`,
    }])), { releaseSha, runId: input.acceptanceRunId })
    : assertAcceptanceOutputs(input.acceptanceOutputs, {
      releaseSha, runId: input.acceptanceRunId,
    });
  if (!unresolvedEvidence && !unresolvedAcceptanceOutputs
    && Object.keys(acceptanceOutputs).some((key) => (
      evidence[key].filePath !== acceptanceOutputs[key].filePath
    ))) throw releaseContractError();
  const candidateSuffix = releaseSha.slice(0, 12);
  const candidateRevision = `${SERVICE}-${candidateSuffix}`;
  const candidateTag = `candidate-${candidateSuffix}`;
  const serviceOrigin = `https://${SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const candidateOrigin = `https://${candidateTag}---${SERVICE}-${input.projectNumber}.${REGION}.run.app`;
  const effectiveImageDigest = input.imageDigest ?? `sha256:${'0'.repeat(64)}`;
  const image = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${SERVICE}@${effectiveImageDigest}`;
  const environment = environmentFor({ releaseSha, serviceOrigin, candidateOrigin, evidence });
  const bindings = secretBindings(databaseSecretVersions, evidence);
  const acceptanceRunId = input.acceptanceRunId;
  const acceptanceSchema = `v1_accept_${acceptanceRunId.replaceAll('-', '')}`;
  const acceptanceGcsPrefix = `v1-accept/${acceptanceRunId}/`;
  const acceptanceOutputObjects = expectedAcceptanceObjects(releaseSha, acceptanceRunId);
  const dependencyEvidenceOutputObject = acceptanceOutputObjects.dependencyAcceptance;
  const postgresResourceId = `//sqladmin.googleapis.com/projects/${PROJECT}/instances/hkbuddy-pg/databases/hkbuddy_v1`;
  const gcsResourceId = `//storage.googleapis.com/projects/_/buckets/${PROJECT}-media`;
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
    V1_ACCEPTANCE_GCS_BUCKET: `${PROJECT}-media`,
    V1_GCS_BUCKET: `${PROJECT}-media`,
    V1_ACCEPTANCE_GCS_RESOURCE_ID: gcsResourceId,
    V1_GCS_RESOURCE_ID: gcsResourceId,
    V1_MEDIA_DRIVER: 'gcs',
    V1_LEGACY_RESOURCE_INVENTORY_FILE: EVIDENCE_DEFINITIONS.legacyInventory.mountPath,
    V1_LEGACY_RESOURCE_INVENTORY_VERSION: legacyInventory.artifactSha256,
    V1_LEGACY_RESOURCE_INVENTORY_APPROVED: 'true',
  });
  const dependencySecrets = Object.freeze({
    environment: Object.freeze({
      V1_DATABASE_URL: Object.freeze({ secret: 'hkbuddy-db-app-url', version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_DATABASE_URL: Object.freeze({ secret: 'hkbuddy-db-app-url', version: databaseSecretVersions.app }),
      V1_ACCEPTANCE_MIGRATOR_DATABASE_URL: Object.freeze({ secret: 'hkbuddy-db-migrator-url', version: databaseSecretVersions.migrator }),
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
    V1_LLM_CREDENTIAL_VERSION: 'hkbuddy-runtime-v1',
    V1_ASR_PROVIDER: 'google-stt-v2',
    V1_GOOGLE_STT_LOCATION: 'asia-southeast1',
    V1_GOOGLE_STT_MODEL: 'chirp_2',
    V1_GOOGLE_STT_RECOGNIZER: '_',
    V1_TTS_PROVIDER: 'google-tts',
    V1_GOOGLE_TTS_LOCATION: 'asia-southeast1',
    V1_GOOGLE_TTS_VOICE_EN: 'en-US-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_YUE: 'yue-HK-Chirp3-HD-Achernar',
    V1_GOOGLE_TTS_VOICE_CMN: 'cmn-CN-Chirp3-HD-Achernar',
    V1_GOOGLE_CREDENTIAL_VERSION: 'hkbuddy-runtime-v1',
  });
  const llmSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_LLM_SMOKE_OUTPUT_BUCKET: `${PROJECT}-media`,
    V1_LLM_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.llmSmoke,
  });
  const asrSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: `${PROJECT}-media`,
    V1_VOICE_SMOKE_OUTPUT_OBJECT: acceptanceOutputObjects.asrSmoke,
  });
  const ttsSmokeEnvironment = Object.freeze({
    ...smokeEnvironment,
    V1_VOICE_SMOKE_OUTPUT_BUCKET: `${PROJECT}-media`,
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
      network: 'hkbuddy-prod-vpc',
      subnet: 'hkbuddy-ae2-run',
      vpcEgress: 'private-ranges-only',
      environment: dependencyEnvironment,
      secretEnvironment: dependencySecrets.environment,
      secretMounts: dependencySecrets.mounts,
    }),
    'llm-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: LLM_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/provider-smoke.js', '--confirm-real-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 600,
      network: 'hkbuddy-prod-vpc', subnet: 'hkbuddy-ae2-run', vpcEgress: 'private-ranges-only',
      environment: llmSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
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
      network: 'hkbuddy-prod-vpc', subnet: 'hkbuddy-ae2-run', vpcEgress: 'private-ranges-only',
      environment: asrSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
    }),
    'tts-smoke': Object.freeze({
      project: PROJECT, region: REGION, job: TTS_SMOKE_JOB, image,
      serviceAccount: RUNTIME_SERVICE_ACCOUNT,
      command: Object.freeze(['node']),
      args: Object.freeze(['scripts/voice-provider-smoke.js', '--capability', 'tts', '--confirm-real-voice-provider']),
      taskCount: 1, parallelism: 1, maxRetries: 0, timeoutSeconds: 900,
      network: 'hkbuddy-prod-vpc', subnet: 'hkbuddy-ae2-run', vpcEgress: 'private-ranges-only',
      environment: ttsSmokeEnvironment, secretEnvironment: Object.freeze({}), secretMounts: Object.freeze({}),
    }),
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
  const probeFlag = (kind) => {
    const value = probes[kind];
    return `--${kind}-probe=httpGet.path=${value.path},httpGet.port=${value.port},initialDelaySeconds=${value.initialDelaySeconds},timeoutSeconds=${value.timeoutSeconds},periodSeconds=${value.periodSeconds},failureThreshold=${value.failureThreshold}`;
  };
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
      '--max-retries=0', '--task-timeout=600s', '--network=hkbuddy-prod-vpc',
      '--subnet=hkbuddy-ae2-run', '--vpc-egress=private-ranges-only',
      `--set-secrets=V1_DATABASE_URL=hkbuddy-db-migrator-url:${databaseSecretVersions.migrator}`,
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
    `gs://${PROJECT}-media/release-evidence/${releaseSha}/**`,
    `--project=${PROJECT}`, '--format=json',
  ]));
  operations.push(
    operation('candidate', 'candidate-deploy', [
      'run', 'deploy', SERVICE, `--project=${PROJECT}`, `--region=${REGION}`,
      `--image=${image}`, `--service-account=${RUNTIME_SERVICE_ACCOUNT}`,
      '--execution-environment=gen2', '--cpu=2', '--memory=1Gi', '--concurrency=40',
      '--min=1', '--max=1', '--no-cpu-throttling', '--cpu-boost', '--timeout=60s',
      '--network=hkbuddy-prod-vpc', '--subnet=hkbuddy-ae2-run',
      '--vpc-egress=private-ranges-only', '--ingress=all', '--no-traffic',
      `--tag=${candidateTag}`, `--revision-suffix=${candidateSuffix}`,
      probeFlag('startup'), probeFlag('liveness'), probeFlag('readiness'),
      envFlag(environment), secretsFlag(bindings), '--format=json',
    ]),
    operation('candidate', 'candidate-service-readback', [
      'run', 'services', 'describe', SERVICE, `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('candidate', 'candidate-revision-readback', [
      'run', 'revisions', 'describe', candidateRevision,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-iam-readback', [
      'run', 'services', 'get-iam-policy', SERVICE,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('candidate', 'candidate-readback', [
      'artifacts', 'docker', 'images', 'describe', image,
      `--project=${PROJECT}`, `--location=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-authority-readback', [
      'auth', 'list', '--filter=status:ACTIVE', '--format=json',
    ]),
    operation('promote', 'promote-public-service', [
      'run', 'services', 'add-iam-policy-binding', SERVICE, '--member=allUsers',
      '--role=roles/run.invoker', `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-traffic', [
      'run', 'services', 'update-traffic', SERVICE, `--to-revisions=${candidateRevision}=100`,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('promote', 'promote-readback', [
      'run', 'services', 'describe', SERVICE, `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
    operation('rollback', 'rollback-traffic', [
      'run', 'services', 'update-traffic', SERVICE, `--to-revisions=${previousRevision}=100`,
      `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
    ]),
    operation('rollback', 'rollback-readback', [
      'run', 'services', 'describe', SERVICE, `--project=${PROJECT}`, `--region=${REGION}`,
      '--format=json',
    ]),
  );

  const expectedCandidate = Object.freeze({
    project: PROJECT,
    region: REGION,
    service: SERVICE,
    revision: candidateRevision,
    tag: candidateTag,
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
    network: 'hkbuddy-prod-vpc',
    subnet: 'hkbuddy-ae2-run',
    vpcEgress: 'private-ranges-only',
    environment,
    secretEnvironment: bindings.environment,
    secretMounts: bindings.mounts,
    probes,
    traffic: Object.freeze([Object.freeze({ revision: candidateRevision, tag: candidateTag, percent: 0 })]),
    iam: Object.freeze([]),
  });
  return Object.freeze({
    project: PROJECT,
    region: REGION,
    releaseSha,
    sourceArchiveSha256: input.sourceArchiveSha256,
    imageDigest: input.imageDigest,
    previousRevision,
    candidateRevision,
    candidateTag,
    serviceOrigin,
    candidateOrigin,
    acceptanceRunId,
    acceptanceOutputs,
    acceptanceEvidenceOutput: Object.freeze({
      bucket: `${PROJECT}-media`,
      object: dependencyEvidenceOutputObject,
    }),
    evidence,
    operations: Object.freeze(operations),
    expectedJobs,
    expectedCandidate,
  });
}

export function validateBuildReceipt(value, { releaseSha, sourceArchiveSha256 } = {}) {
  const imageName = `asia-east2-docker.pkg.dev/${PROJECT}/${REPOSITORY}/${SERVICE}:${releaseSha}`;
  const image = value?.results?.images;
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
    && Array.isArray(value.steps)
    && exact(value.steps.map(({ id, status } = {}) => ({ id, status })), expectedSteps.map((id) => ({
      id, status: 'SUCCESS',
    })))
    && value.sourceProvenance && typeof value.sourceProvenance === 'object'
    && !Array.isArray(value.sourceProvenance)
    && Object.keys(value.sourceProvenance).length > 0
    && Array.isArray(image) && image.length === 1
    && image[0]?.name === imageName
    && IMAGE_DIGEST.test(String(image[0]?.digest ?? ''))
  );
  if (!valid) throw new Error('Cloud Build receipt is invalid');
  return Object.freeze({
    buildId: value.id,
    releaseSha,
    sourceArchiveSha256,
    imageDigest: image[0].digest,
    provenance: 'VERIFIED',
    ociLabels: Object.freeze({
      'com.simplify.source-archive-sha256': sourceArchiveSha256,
      'org.opencontainers.image.revision': releaseSha,
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
    timeoutSeconds: positiveOrZeroInteger(String(spec.timeoutSeconds ?? '').replace(/s$/u, '')),
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

function normalizeCandidateService(value) {
  if (value?.service && Array.isArray(value.traffic)) return value;
  const traffic = value?.status?.traffic ?? value?.spec?.traffic;
  if (!value?.metadata?.name || !Array.isArray(traffic)) return null;
  return {
    service: value.metadata.name,
    traffic: traffic.map((member) => ({
      revision: member.revision ?? member.revisionName,
      tag: member.tag ?? null,
      percent: Number(member.percent ?? 0),
    })),
  };
}

function validateCandidateService(value, expected) {
  const normalized = normalizeCandidateService(value);
  if (!normalized || normalized.service !== expected.service) {
    throw new Error('Cloud Run candidate service readback is invalid');
  }
  const candidate = normalized.traffic.filter(({ revision, tag }) => (
    revision === expected.revision || tag === expected.tag
  ));
  if (candidate.length !== 1 || candidate[0].revision !== expected.revision
    || candidate[0].tag !== expected.tag || candidate[0].percent !== 0) {
    throw new Error('Cloud Run candidate service readback is invalid');
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

export function validateCandidateControlPlaneReadbacks(value, plan) {
  if (!exactKeys(value, ['artifact', 'iam', 'revision', 'service']) || !plan?.expectedCandidate) {
    throw new Error('Cloud Run candidate control-plane readback is invalid');
  }
  const expected = plan.expectedCandidate;
  validateCandidateService(value.service, expected);
  if (!exact(normalizeCandidateRevision(value.revision, expected), candidateRevisionContract(expected))) {
    throw new Error('Cloud Run candidate revision readback is invalid');
  }
  validateServiceIamReceipt(value.iam, { publicInvoker: false });
  validateCandidateArtifact(value.artifact, expected.image);
  return true;
}

export function validateServiceIamReceipt(value, { publicInvoker } = {}) {
  const bindings = value?.bindings ?? [];
  if (!Array.isArray(bindings) || ![true, false].includes(publicInvoker)) {
    throw new Error('Cloud Run service IAM readback is invalid');
  }
  const normalized = bindings.map(({ condition, members, role } = {}) => {
    if (condition !== undefined || typeof role !== 'string' || !Array.isArray(members)
      || members.some((member) => typeof member !== 'string')) {
      throw new Error('Cloud Run service IAM readback is invalid');
    }
    return { role, members: [...members].sort() };
  }).sort((left, right) => left.role.localeCompare(right.role));
  const expected = publicInvoker
    ? [{ role: 'roles/run.invoker', members: ['allUsers'] }]
    : [];
  if (!exact(normalized, expected)) throw new Error('Cloud Run service IAM readback is invalid');
  return true;
}

export function validateTrafficReceipt(value, { revision } = {}) {
  const traffic = value?.status?.traffic ?? value?.traffic;
  if (!REVISION.test(String(revision ?? '')) || !Array.isArray(traffic)) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  const active = traffic.filter(({ percent } = {}) => Number(percent) > 0).map((member) => ({
    revision: member.revision ?? member.revisionName,
    percent: Number(member.percent),
  }));
  if (!exact(active, [{ revision, percent: 100 }])) {
    throw new Error('Cloud Run traffic readback is invalid');
  }
  return true;
}

function positiveOrZeroInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
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
    const item = volume?.secret?.items?.[0];
    if (!volume?.secret?.secretName || !item?.key || typeof mount?.mountPath !== 'string') return null;
    const key = mount.mountPath.endsWith('/legacy-inventory.json') ? 'legacyInventory' : mount.name;
    secretMounts[key] = {
      path: mount.mountPath,
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
  };
}

export function validateReleaseJobReadback(value, expected) {
  const normalized = exact(value, expected) ? value : normalizeV1JobReadback(value);
  if (!expected || !exact(normalized, expected)) {
    throw new Error('Cloud Run release Job readback is invalid');
  }
  return true;
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

export async function validateEvidenceArtifactFile(value, { releaseSha } = {}) {
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
  if (!record || typeof record !== 'object' || Array.isArray(record)
    || record.commitSha !== releaseSha
    || record.artifactSha256 !== value.artifactSha256) {
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
  }, { releaseSha });
  return Object.freeze({ filePath, artifactSha256, objectSha256, byteLength: contents.length });
}

async function validateEvidenceArtifactSet(evidence, { releaseSha } = {}) {
  for (const value of Object.values(evidence)) {
    await validateEvidenceArtifactFile({
      filePath: value.filePath,
      artifactSha256: value.artifactSha256,
      objectSha256: value.objectSha256,
    }, { releaseSha });
  }
  return true;
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
    || id === 'candidate-deploy'
    || id === 'promote-public-service' || id === 'promote-traffic'
    || id === 'rollback-traffic';
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
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'GCP_RELEASE_DRY_RUN', mutationPerformed: false,
      releaseSha: plan.releaseSha, phase: selection.phase,
      plannedOperations: selected.map(({ id }) => id),
    });
  }
  let executor;
  try { executor = execute ?? createDefaultGcloudExecutor({ environment }); } catch {
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
  let buildReceipt = null;
  let mutationAttempted = false;
  try {
    if (selection.phase === 'collect') {
      await assertCollectionDestinationsAbsent(plan.acceptanceOutputs);
    } else if (selection.phase === 'inventory') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence({ legacyInventory: plan.evidence.legacyInventory }, { releaseSha: plan.releaseSha });
    } else if (selection.phase === 'evidence') {
      if (typeof verifyEvidence !== 'function') throw new Error('Evidence verifier is unavailable');
      await verifyEvidence(plan.evidence, { releaseSha: plan.releaseSha });
    }
    for (const member of selected) {
      if (operationMayMutate(member.id)) mutationAttempted = true;
      const receipt = await executor(member.argv);
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
      } else if (member.id === 'promote-authority-readback') {
        if (!Array.isArray(receipt) || receipt.length !== 1
          || receipt[0]?.account !== PROMOTION_AUTHORITY
          || receipt[0]?.status !== 'ACTIVE') {
          throw new Error('Public promotion authority is not approved');
        }
      } else if (member.id === 'candidate-iam-readback') {
        candidateReadbacks.iam = receipt;
        validateServiceIamReceipt(receipt, { publicInvoker: false });
      } else if (member.id === 'candidate-service-readback') {
        candidateReadbacks.service = receipt;
      } else if (member.id === 'candidate-revision-readback') {
        candidateReadbacks.revision = receipt;
      } else if (member.id === 'candidate-readback') {
        candidateReadbacks.artifact = receipt;
      } else if (member.id === 'promote-public-service') {
        validateServiceIamReceipt(receipt, { publicInvoker: true });
      } else if (member.id === 'promote-traffic' || member.id === 'promote-readback') {
        validateTrafficReceipt(receipt, { revision: plan.candidateRevision });
      } else if (member.id === 'rollback-traffic' || member.id === 'rollback-readback') {
        validateTrafficReceipt(receipt, { revision: plan.previousRevision });
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
    }
    if (selection.phase === 'candidate') {
      validateCandidateControlPlaneReadbacks(candidateReadbacks, plan);
    }
  } catch {
    return publish(writeOutput, 1, {
      status: 'failed', code: 'RELEASE_PHASE_FAILED', mutationPerformed: mutationAttempted,
      releaseSha: plan.releaseSha, phase: selection.phase, completed,
      resumeBoundary: selected[completed.length]?.id ?? null,
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
