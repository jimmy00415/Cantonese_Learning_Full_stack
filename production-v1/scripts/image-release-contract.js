import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadDefaultCorpus } from '../src/knowledge/corpus.js';

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REQUIRED_IMAGE_FILES = Object.freeze(['data/knowledge/hkbu-v1.json']);
const REQUIRED_IMAGE_SCRIPTS = Object.freeze([
  'scripts/image-release-contract.js',
  'scripts/provider-smoke.js',
  'scripts/real-dependencies-acceptance.js',
  'scripts/run-migrations.js',
  'scripts/voice-provider-smoke.js',
]);
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

function imageReleaseError() {
  return new Error('Image release contract is invalid');
}

function canonicalPath(value) {
  return String(value).split(sep).join('/').replace(/^\.\//, '');
}

async function walkFiles(root, directory, output) {
  let entries;
  try {
    entries = await readdir(join(root, directory), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw imageReleaseError();
  }
  for (const entry of entries) {
    if (!entry || typeof entry.name !== 'string' || !entry.name
      || entry.name.includes('/') || entry.name.includes('\\')
      || entry.isSymbolicLink()) throw imageReleaseError();
    const child = join(directory, entry.name);
    if (entry.isDirectory()) await walkFiles(root, child, output);
    else if (entry.isFile()) output.push(canonicalPath(child));
    else throw imageReleaseError();
  }
}

export function assertImageReleaseFileList(fileNames) {
  if (!Array.isArray(fileNames)
    || fileNames.some((value) => typeof value !== 'string' || !value)) {
    throw imageReleaseError();
  }
  const canonical = fileNames.map(canonicalPath).sort();
  if (new Set(canonical).size !== canonical.length
    || canonical.length !== REQUIRED_IMAGE_FILES.length
    || canonical.some((value, index) => value !== REQUIRED_IMAGE_FILES[index])) {
    throw imageReleaseError();
  }
  return Object.freeze([...canonical]);
}

export function assertImageReleaseScriptList(fileNames) {
  if (!Array.isArray(fileNames)
    || fileNames.some((value) => typeof value !== 'string' || !value)) {
    throw imageReleaseError();
  }
  const canonical = fileNames.map(canonicalPath).sort();
  if (new Set(canonical).size !== canonical.length
    || canonical.length !== REQUIRED_IMAGE_SCRIPTS.length
    || canonical.some((value, index) => value !== REQUIRED_IMAGE_SCRIPTS[index])) {
    throw imageReleaseError();
  }
  return Object.freeze([...canonical]);
}

function assertReleaseManifest(value) {
  const expectedKeys = ['releaseSha', 'schemaVersion', 'sourceArchiveSha256', 'sourcePath'];
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join('\0') !== expectedKeys.sort().join('\0')
    || value.schemaVersion !== 1
    || !RELEASE_SHA.test(String(value.releaseSha ?? ''))
    || !DIGEST.test(String(value.sourceArchiveSha256 ?? ''))
    || value.sourcePath !== 'git-archive:production-v1') throw imageReleaseError();
  return Object.freeze({ ...value });
}

export async function verifyImageReleaseRoot({
  appRoot = APP_ROOT,
  loadCorpus = loadDefaultCorpus,
} = {}) {
  if (typeof appRoot !== 'string' || !appRoot || typeof loadCorpus !== 'function') {
    throw imageReleaseError();
  }
  const root = resolve(appRoot);
  const files = [];
  const scripts = [];
  await walkFiles(root, 'data', files);
  await walkFiles(root, 'reports', files);
  await walkFiles(root, 'scripts', scripts);
  const dataFiles = assertImageReleaseFileList(files.map((value) => (
    canonicalPath(relative(root, join(root, value)))
  )));
  const scriptFiles = assertImageReleaseScriptList(scripts.map((value) => (
    canonicalPath(relative(root, join(root, value)))
  )));
  let releaseManifest;
  try {
    const raw = await readFile(join(root, 'release-manifest.json'), 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > 1024) throw imageReleaseError();
    releaseManifest = assertReleaseManifest(JSON.parse(raw));
  } catch { throw imageReleaseError(); }
  if ((process.env.V1_RELEASE_COMMIT_SHA
      && process.env.V1_RELEASE_COMMIT_SHA !== releaseManifest.releaseSha)
    || (process.env.V1_SOURCE_ARCHIVE_SHA256
      && process.env.V1_SOURCE_ARCHIVE_SHA256 !== releaseManifest.sourceArchiveSha256)) {
    throw imageReleaseError();
  }
  let corpus;
  try { corpus = await loadCorpus(); } catch { throw imageReleaseError(); }
  if (!corpus || typeof corpus !== 'object' || !Array.isArray(corpus.sources)
    || corpus.sources.length < 1) throw imageReleaseError();
  const claimCount = corpus.sources.reduce((total, source) => (
    total + (Array.isArray(source?.claims) ? source.claims.length : 0)
  ), 0);
  if (claimCount < 1) throw imageReleaseError();
  return Object.freeze({
    ok: true,
    dataFiles,
    scriptFiles,
    releaseManifest,
    sourceCount: corpus.sources.length,
    claimCount,
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const result = await verifyImageReleaseRoot();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, errorCode: 'IMAGE_RELEASE_CONTRACT_FAILED' })}\n`);
    process.exitCode = 1;
  }
}
