import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const APP_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const RELEASE_SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

export async function writeImageReleaseManifest({
  appRoot = APP_ROOT,
  releaseSha,
  sourceArchiveSha256,
  buildConfigSha256,
} = {}) {
  if (typeof appRoot !== 'string' || !appRoot
    || !RELEASE_SHA.test(String(releaseSha ?? ''))
    || !DIGEST.test(String(sourceArchiveSha256 ?? ''))
    || !DIGEST.test(String(buildConfigSha256 ?? ''))) {
    throw new Error('Image release manifest input is invalid');
  }
  const manifest = Object.freeze({
    schemaVersion: 1,
    buildConfigSha256,
    releaseSha,
    sourceArchiveSha256,
    sourcePath: 'git-archive:production-v1',
  });
  await writeFile(
    join(resolve(appRoot), 'release-manifest.json'),
    `${JSON.stringify(manifest)}\n`,
    { encoding: 'utf8', flag: 'wx' },
  );
  return manifest;
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const manifest = await writeImageReleaseManifest({
      releaseSha: process.env.V1_RELEASE_COMMIT_SHA,
      sourceArchiveSha256: process.env.V1_SOURCE_ARCHIVE_SHA256,
      buildConfigSha256: process.env.V1_BUILD_CONFIG_SHA256,
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      releaseSha: manifest.releaseSha,
      sourceArchiveSha256: manifest.sourceArchiveSha256,
      buildConfigSha256: manifest.buildConfigSha256,
    })}\n`);
  } catch {
    process.stderr.write(`${JSON.stringify({
      ok: false, errorCode: 'IMAGE_RELEASE_MANIFEST_FAILED',
    })}\n`);
    process.exitCode = 1;
  }
}
