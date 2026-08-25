import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import {
  finalizeReleaseEvidenceRecord,
  validateLegacyResourceInventory,
} from '../src/services/release-evidence.js';

const execFileAsync = promisify(execFile);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const productionRoot = fileURLToPath(new URL('../', import.meta.url));
const defaultArtifactDirectory = join(productionRoot, 'reports', 'legacy-inventory');
const OWNER_MANIFEST_KEYS = [
  'blobResources',
  'declaresNoLegacyBlob',
  'declaresNoLegacyPostgres',
  'legacyApplicationIds',
  'legacyOrigins',
  'postgresResources',
  'schemaVersion',
];

function exactArguments(argv) {
  if (!Array.isArray(argv)
    || argv.length !== 3
    || argv[0] !== '--manifest'
    || typeof argv[1] !== 'string'
    || !isAbsolute(argv[1])
    || extname(argv[1]).toLowerCase() !== '.json'
    || argv[2] !== '--confirm-owner-reviewed-legacy-resources') return null;
  return { manifestPath: argv[1] };
}

function exactKeys(value, expected) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join('\0') === expected.join('\0'));
}

function validAzureResourceId(value, provider, resourceType) {
  if (typeof value !== 'string' || value.length > 1_024 || value !== value.trim()) return false;
  const segments = value.split('/');
  if (segments.length !== 9 || segments[0] !== '') return false;
  const safeSegment = (segment) => (
    segment.length > 0
    && segment.length <= 260
    && /^[a-z0-9._()-]+$/i.test(segment)
  );
  return segments[1].toLowerCase() === 'subscriptions'
    && safeSegment(segments[2])
    && segments[3].toLowerCase() === 'resourcegroups'
    && safeSegment(segments[4])
    && segments[5].toLowerCase() === 'providers'
    && segments[6].toLowerCase() === provider.toLowerCase()
    && segments[7].toLowerCase() === resourceType.toLowerCase()
    && safeSegment(segments[8]);
}

function ownerResourceShapesAreSafe(manifest) {
  if (!Array.isArray(manifest.postgresResources) || !Array.isArray(manifest.blobResources)) return false;
  for (const resource of manifest.postgresResources) {
    if (!exactKeys(resource, ['identitySha256', 'resourceId'])
      || !validAzureResourceId(resource.resourceId, 'Microsoft.DBforPostgreSQL', 'flexibleServers')) return false;
  }
  for (const resource of manifest.blobResources) {
    if (!exactKeys(resource, ['identitySha256', 'resourceId'])
      || !validAzureResourceId(resource.resourceId, 'Microsoft.Storage', 'storageAccounts')) return false;
  }
  const resources = [...manifest.postgresResources, ...manifest.blobResources];
  const ids = resources.map(({ resourceId }) => resourceId.toLowerCase());
  const digests = resources.map(({ identitySha256 }) => identitySha256);
  return new Set(ids).size === ids.length && new Set(digests).size === digests.length;
}

function buildFinalRecord(manifest, commitSha, reviewedAt, now) {
  if (!exactKeys(manifest, OWNER_MANIFEST_KEYS) || !ownerResourceShapesAreSafe(manifest)) return null;
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: manifest.schemaVersion,
    commitSha,
    legacyApplicationIds: manifest.legacyApplicationIds,
    legacyOrigins: manifest.legacyOrigins,
    postgresResources: manifest.postgresResources,
    blobResources: manifest.blobResources,
    declaresNoLegacyPostgres: manifest.declaresNoLegacyPostgres,
    declaresNoLegacyBlob: manifest.declaresNoLegacyBlob,
    reviewedAt,
    result: true,
  });
  return validateLegacyResourceInventory(record, {
    expectedVersion: record.artifactSha256,
    commitSha,
    now,
  }).valid ? record : null;
}

async function defaultInspectGit(cwd) {
  const headResult = await execFileAsync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 64 * 1_024,
  });
  const statusResult = await execFileAsync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1024 * 1_024,
  });
  return {
    head: headResult.stdout.replace(/[\r\n]+$/, ''),
    clean: statusResult.stdout.length === 0,
  };
}

async function defaultWriteArtifact({ filePath, contents }) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, contents, { encoding: 'utf8', flag: 'wx' });
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

export async function runLegacyResourceInventory({
  argv = process.argv.slice(2),
  environment = process.env,
  cwd = productionRoot,
  artifactDirectory = defaultArtifactDirectory,
  now = () => new Date(),
  readTextFile = (filePath) => readFile(filePath, 'utf8'),
  inspectGit = defaultInspectGit,
  writeArtifact = defaultWriteArtifact,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  const selection = exactArguments(argv);
  if (!selection) {
    return publish(writeOutput, 2, {
      status: 'not-run',
      code: 'OWNER_REVIEW_CONFIRMATION_REQUIRED',
    });
  }

  const commitSha = environment?.V1_RELEASE_COMMIT_SHA;
  if (!RELEASE_SHA.test(String(commitSha ?? ''))) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'RELEASE_COMMIT_INVALID' });
  }
  if (typeof cwd !== 'string' || !isAbsolute(cwd)
    || typeof artifactDirectory !== 'string' || !isAbsolute(artifactDirectory)) {
    return publish(writeOutput, 2, { status: 'not-run', code: 'COMMAND_CONTEXT_INVALID' });
  }

  let reviewedAt;
  let currentTime;
  try {
    currentTime = new Date(now());
    if (!Number.isFinite(currentTime.getTime())) throw new Error('invalid clock');
    reviewedAt = currentTime.toISOString();
  } catch {
    return publish(writeOutput, 2, { status: 'not-run', code: 'REVIEW_TIME_INVALID' });
  }

  let manifestText;
  try {
    manifestText = await readTextFile(selection.manifestPath);
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'OWNER_MANIFEST_UNREADABLE' });
  }

  let manifest;
  try {
    if (typeof manifestText !== 'string' || manifestText.length > 1024 * 1024) throw new Error('invalid manifest');
    manifest = JSON.parse(manifestText);
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'OWNER_MANIFEST_INVALID' });
  }

  const record = buildFinalRecord(manifest, commitSha, reviewedAt, currentTime);
  if (!record) {
    return publish(writeOutput, 1, { status: 'failed', code: 'OWNER_MANIFEST_INVALID' });
  }

  let gitState;
  try {
    gitState = await inspectGit(cwd);
  } catch {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_INVALID' });
  }
  if (!gitState || gitState.head !== commitSha || gitState.clean !== true) {
    return publish(writeOutput, 1, { status: 'failed', code: 'RELEASE_GIT_STATE_INVALID' });
  }

  const filePath = join(artifactDirectory, `${commitSha}-${record.artifactSha256}.json`);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  try {
    await writeArtifact({ filePath, contents, record });
  } catch (error) {
    const code = error?.code === 'EEXIST'
      ? 'LEGACY_INVENTORY_ARTIFACT_EXISTS'
      : 'LEGACY_INVENTORY_WRITE_FAILED';
    return publish(writeOutput, 1, { status: 'failed', code });
  }

  return publish(writeOutput, 0, {
    status: 'recorded',
    code: 'LEGACY_INVENTORY_RECORDED',
    artifactSha256: record.artifactSha256,
  });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = await runLegacyResourceInventory();
  process.exitCode = result.exitCode;
}
