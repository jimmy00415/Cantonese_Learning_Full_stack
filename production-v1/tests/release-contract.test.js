import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

import {
  assertImageReleaseFileList,
  assertImageReleaseScriptList,
  verifyImageReleaseRoot,
} from '../scripts/image-release-contract.js';
import { writeImageReleaseManifest } from '../scripts/create-image-release-manifest.js';
import { finalizeReleaseEvidenceRecord } from '../src/services/release-evidence.js';
import { finalizeEvidenceRecord } from '../src/services/voice-evidence.js';
import {
  buildReleasePlan,
  inspectCollectedEvidenceArtifact,
  prepareReleaseArchive,
  runPrepareReleaseArchive,
  runGcpRelease as runGcpReleaseImpl,
  finalizeReleasePhaseReceipt,
  validateBuildReceipt,
  validateCandidateReadback,
  validateCandidateControlPlaneReadbacks,
  validateAcceptanceObjectReceipt,
  validateEvidenceArtifactFile,
  validateEvidenceVersionReceipt,
  validateReleaseJobReadback,
  validateServiceIamReceipt,
  validateTrafficReceipt,
} from '../scripts/gcp-release.js';

const PROJECT = 'hkbuddy-prod-v1-20260826';
const REGION = 'asia-east2';
const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const PROJECT_NUMBER = '123456789012';
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SA = `projects/${PROJECT}/serviceAccounts/hkbuddy-build@${PROJECT}.iam.gserviceaccount.com`;
const RUNTIME_SA = `hkbuddy-runtime@${PROJECT}.iam.gserviceaccount.com`;
const ACCEPTANCE_SA = `hkbuddy-acceptance@${PROJECT}.iam.gserviceaccount.com`;
const ACCEPTANCE_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const CANDIDATE_TAG = `candidate-${RELEASE_SHA.slice(0, 12)}`;
const REVISION = `hkbuddy-api-${RELEASE_SHA.slice(0, 12)}`;
const STABLE_ORIGIN = `https://hkbuddy-api-${PROJECT_NUMBER}.${REGION}.run.app`;
const CANDIDATE_ORIGIN = `https://${CANDIDATE_TAG}---hkbuddy-api-${PROJECT_NUMBER}.${REGION}.run.app`;
const IMAGE_SCRIPTS = Object.freeze([
  'scripts/image-release-contract.js',
  'scripts/provider-smoke.js',
  'scripts/real-dependencies-acceptance.js',
  'scripts/run-migrations.js',
  'scripts/voice-provider-smoke.js',
]);

const EVIDENCE = Object.freeze({
  legacyInventory: Object.freeze({
    secret: 'hkbuddy-legacy-inventory', secretVersion: '11',
    artifactSha256: '1'.repeat(64), objectSha256: 'a'.repeat(64), filePath: 'C:\\release\\legacy-inventory.json',
  }),
  dependencyAcceptance: Object.freeze({
    secret: 'hkbuddy-dependency-acceptance', secretVersion: '12',
    artifactSha256: '2'.repeat(64), objectSha256: 'b'.repeat(64), filePath: 'C:\\release\\dependency-acceptance.json',
  }),
  llmSmoke: Object.freeze({
    secret: 'hkbuddy-llm-smoke', secretVersion: '13',
    artifactSha256: '3'.repeat(64), objectSha256: 'c'.repeat(64), filePath: 'C:\\release\\llm-smoke.json',
  }),
  asrSmoke: Object.freeze({
    secret: 'hkbuddy-asr-smoke', secretVersion: '14',
    artifactSha256: '4'.repeat(64), objectSha256: 'd'.repeat(64), filePath: 'C:\\release\\asr-smoke.json',
  }),
  ttsSmoke: Object.freeze({
    secret: 'hkbuddy-tts-smoke', secretVersion: '15',
    artifactSha256: '5'.repeat(64), objectSha256: 'e'.repeat(64), filePath: 'C:\\release\\tts-smoke.json',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: 'hkbuddy-ios-voice-acceptance', secretVersion: '16',
    artifactSha256: '6'.repeat(64), objectSha256: 'f'.repeat(64), filePath: 'C:\\release\\ios-voice-acceptance.json',
  }),
});

const ACCEPTANCE_OUTPUTS = Object.freeze({
  dependencyAcceptance: Object.freeze({
    bucket: `${PROJECT}-media`,
    object: `release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}.json`,
    generation: '101',
    filePath: EVIDENCE.dependencyAcceptance.filePath,
  }),
  llmSmoke: Object.freeze({
    bucket: `${PROJECT}-media`,
    object: `release-evidence/${RELEASE_SHA}/llm-smoke/llm-${ACCEPTANCE_RUN_ID}.json`,
    generation: '102',
    filePath: EVIDENCE.llmSmoke.filePath,
  }),
  asrSmoke: Object.freeze({
    bucket: `${PROJECT}-media`,
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/asr-${ACCEPTANCE_RUN_ID}.json`,
    generation: '103',
    filePath: EVIDENCE.asrSmoke.filePath,
  }),
  ttsSmoke: Object.freeze({
    bucket: `${PROJECT}-media`,
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/tts-${ACCEPTANCE_RUN_ID}.json`,
    generation: '104',
    filePath: EVIDENCE.ttsSmoke.filePath,
  }),
});

function releaseInput(overrides = {}) {
  return {
    releaseSha: RELEASE_SHA,
    sourceArchive: 'C:\\release\\source.tar.gz',
    sourceArchiveSha256: SOURCE_SHA,
    imageDigest: IMAGE_DIGEST,
    projectNumber: PROJECT_NUMBER,
    databaseSecretVersions: { app: '7', migrator: '8', session: '9' },
    acceptanceRunId: ACCEPTANCE_RUN_ID,
    acceptanceOutputs: ACCEPTANCE_OUTPUTS,
    task8Evidence: {
      readiness: {
        filePath: 'C:\\release\\readiness.json', artifactSha256: '7'.repeat(64), objectSha256: '7'.repeat(64),
      },
      workload: {
        filePath: 'C:\\release\\workload.json', artifactSha256: '8'.repeat(64), objectSha256: '8'.repeat(64),
      },
      mobile: {
        filePath: 'C:\\release\\mobile.json', artifactSha256: '9'.repeat(64), objectSha256: '9'.repeat(64),
      },
    },
    legacyInventory: EVIDENCE.legacyInventory,
    evidence: EVIDENCE,
    previousRevision: 'hkbuddy-api-stable123456',
    ...overrides,
  };
}

function canonicalFixture(value) {
  if (Array.isArray(value)) return value.map(canonicalFixture);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFixture(value[key])]));
  }
  return value;
}

function fixtureReceiptOutputs(plan, phase) {
  if (phase === 'build') return {
    buildId: '12345678-1234-4234-8234-123456789abc',
    imageDigest: plan.imageDigest,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    sourceProvenance: { uri: 'gs://source/source.tgz#123', sha256: plan.sourceArchiveSha256 },
    ociLabels: {
      'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
      'org.opencontainers.image.revision': plan.releaseSha,
      'org.opencontainers.image.source': 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
    },
  };
  if (phase === 'migration') return {
    executionName: `projects/${PROJECT}/locations/${REGION}/jobs/hkbuddy-migrate/executions/migrate-123`,
    job: 'hkbuddy-migrate', imageDigest: plan.imageDigest,
  };
  if (phase === 'inventory') return {
    evidenceSecretVersions: { legacyInventory: plan.evidence.legacyInventory.secretVersion },
  };
  if (phase === 'acceptance') return {
    jobs: Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
      key, { image: value.image, serviceAccount: value.serviceAccount },
    ])),
  };
  if (phase === 'collect') return {
    evidence: Object.fromEntries(['dependencyAcceptance', 'llmSmoke', 'asrSmoke', 'ttsSmoke'].map((key) => [
      key, {
        artifactSha256: plan.evidence[key].artifactSha256,
        objectSha256: plan.evidence[key].objectSha256,
      },
    ])),
  };
  if (phase === 'evidence') return {
    evidenceSecretVersions: Object.fromEntries(Object.entries(plan.evidence).map(([key, value]) => [
      key, value.secretVersion,
    ])),
    outputResidueCount: 0,
  };
  if (phase === 'candidate') return {
    candidateContractSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(plan.expectedCandidate))).digest('hex'),
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    publicInvoker: true,
    revision: plan.candidateRevision,
    tag: plan.candidateTag,
    trafficPercent: 0,
  };
  const output = {
    artifactSha256: plan.task8Evidence[phase].artifactSha256,
    objectSha256: plan.task8Evidence[phase].objectSha256,
    candidateOrigin: plan.candidateOrigin,
    candidateRevision: plan.candidateRevision,
    imageDigest: plan.imageDigest,
  };
  if (phase === 'mobile') output.viewport = { width: 390, height: 844 };
  return output;
}

function fixtureReceiptChain(plan, through) {
  const phases = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence',
    'candidate', 'readiness', 'workload', 'mobile'];
  const receipts = [];
  for (const [index, phase] of phases.entries()) {
    const receipt = finalizeReleasePhaseReceipt({
      schemaVersion: 1,
      phase,
      sequence: index + 1,
      releaseSha: plan.releaseSha,
      releaseIdentitySha256: plan.releaseIdentitySha256,
      previousReceiptSha256: receipts.at(-1)?.receiptSha256 ?? null,
      completed: plan.operations.filter((member) => member.phase === phase).map(({ id }) => id),
      outputs: fixtureReceiptOutputs(plan, phase),
    });
    receipts.push(receipt);
    if (phase === through) return receipts;
  }
  throw new Error('unknown fixture receipt phase');
}

function runGcpRelease(options) {
  return runGcpReleaseImpl({
    loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
    persistReceipt: async () => true,
    verifyTask8Evidence: async () => true,
    ...options,
  });
}

test('built image contract loads the governed corpus and rejects every unrelated data or report file', async (t) => {
  const imageRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-image-contract-'));
  t.after(() => rm(imageRoot, { recursive: true, force: true }));
  await mkdir(join(imageRoot, 'data', 'knowledge'), { recursive: true });
  await copyFile(
    join(APP_ROOT, 'data', 'knowledge', 'hkbu-v1.json'),
    join(imageRoot, 'data', 'knowledge', 'hkbu-v1.json'),
  );
  await mkdir(join(imageRoot, 'scripts'), { recursive: true });
  for (const filePath of IMAGE_SCRIPTS) {
    await copyFile(join(APP_ROOT, filePath), join(imageRoot, filePath));
  }
  await writeImageReleaseManifest({
    appRoot: imageRoot,
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
  });
  const verified = await verifyImageReleaseRoot({ appRoot: imageRoot });
  assert.equal(verified.ok, true);
  assert.equal(verified.dataFiles.join(','), 'data/knowledge/hkbu-v1.json');
  assert.deepEqual(verified.scriptFiles, IMAGE_SCRIPTS);
  assert.deepEqual(verified.releaseManifest, {
    schemaVersion: 1,
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    sourcePath: 'git-archive:production-v1',
  });
  assert.equal(verified.sourceCount > 0, true);
  assert.equal(verified.claimCount > 0, true);

  assert.throws(
    () => assertImageReleaseFileList(['data/knowledge/hkbu-v1.json', 'data/store.json']),
    /image release/i,
  );
  assert.throws(
    () => assertImageReleaseFileList(['data/knowledge/hkbu-v1.json', 'reports/release.json']),
    /image release/i,
  );
  assert.throws(() => assertImageReleaseFileList([]), /image release/i);
  assert.throws(
    () => assertImageReleaseScriptList([...IMAGE_SCRIPTS, 'scripts/debug-release.js']),
    /image release/i,
  );
});

test('release source archive is deterministic, commit-bound, and refuses a dirty worktree', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-release-archive-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = join(fixtureRoot, 'repository');
  await mkdir(join(repositoryRoot, 'production-v1', 'data', 'knowledge'), { recursive: true });
  await writeFile(join(repositoryRoot, 'production-v1', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'), 'steps: []\n');
  await writeFile(
    join(repositoryRoot, 'production-v1', 'data', 'knowledge', 'hkbu-v1.json'),
    '{"sources":[],"claims":[]}\n',
  );
  const git = (...argv) => execFileSync('git', argv, {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Release Contract');
  git('config', 'user.email', 'release-contract@example.invalid');
  git('add', 'production-v1');
  execFileSync('git', ['commit', '--quiet', '-m', 'fixture'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: '1704067200 +0000',
      GIT_COMMITTER_DATE: '1704067200 +0000',
    },
  });
  const releaseSha = git('rev-parse', 'HEAD');

  const first = await prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'source-one.tar.gz'),
  });
  const second = await prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'source-two.tar.gz'),
  });
  assert.equal(first.releaseSha, releaseSha);
  assert.match(first.sourceArchiveSha256, /^[0-9a-f]{64}$/);
  const firstArchive = await readFile(first.sourceArchive);
  const secondArchive = await readFile(second.sourceArchive);
  const firstTar = gunzipSync(firstArchive);
  const firstHeaderMtime = Number.parseInt(
    firstTar.subarray(136, 148).toString('ascii').replaceAll('\0', '').trim(),
    8,
  );
  assert.equal(
    firstHeaderMtime,
    1704067200,
    'git archive members must inherit the immutable release commit timestamp',
  );
  assert.equal(
    createHash('sha256').update(firstTar).digest('hex'),
    createHash('sha256').update(gunzipSync(secondArchive)).digest('hex'),
    'git archive tar bytes must be deterministic',
  );
  assert.deepEqual(firstArchive.subarray(0, 10), secondArchive.subarray(0, 10));
  assert.equal(second.sourceArchiveSha256, first.sourceArchiveSha256);
  assert.equal(firstArchive.length > 0, true);

  await writeFile(join(repositoryRoot, 'production-v1', 'dirty.txt'), 'not committed\n');
  await assert.rejects(() => prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'dirty.tar.gz'),
  }), /clean commit/i);
});

test('release archive command is inert until its exact SHA confirmation', async () => {
  const calls = [];
  const base = [
    '--prepare-archive',
    '--repository-root=C:\\reviewed\\repository',
    '--destination=C:\\release\\source.tar.gz',
    `--release-sha=${RELEASE_SHA}`,
  ];
  const prepare = async (input) => {
    calls.push(input);
    return { ...input, sourceArchive: input.destination, sourceArchiveSha256: SOURCE_SHA };
  };
  const dryRun = await runPrepareReleaseArchive({
    argv: base, prepare, writeOutput: () => undefined,
  });
  assert.equal(dryRun.exitCode, 0);
  assert.equal(dryRun.publicReport.status, 'dry-run');
  assert.equal(calls.length, 0);

  const confirmed = await runPrepareReleaseArchive({
    argv: [...base, `--confirm-archive=${RELEASE_SHA}`], prepare,
    writeOutput: () => undefined,
  });
  assert.equal(confirmed.exitCode, 0);
  assert.equal(confirmed.publicReport.sourceArchiveSha256, SOURCE_SHA);
  assert.equal(calls.length, 1);

  const invalid = await runPrepareReleaseArchive({
    argv: [...base, `--confirm-archive=${RELEASE_SHA}`, '--extra'], prepare,
    writeOutput: () => undefined,
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(calls.length, 1);
});

test('release plan is archive-bound, digest-pinned, evidence-first, probe-exact, and reversible', () => {
  const plan = buildReleasePlan(releaseInput());
  assert.equal(plan.releaseSha, RELEASE_SHA);
  assert.equal(plan.serviceOrigin, STABLE_ORIGIN);
  assert.equal(plan.candidateOrigin, CANDIDATE_ORIGIN);
  assert.equal(plan.candidateRevision, REVISION);
  assert.equal(plan.candidateTag, CANDIDATE_TAG);

  const ids = plan.operations.map(({ id }) => id);
  assert.equal(ids[0], 'build-submit');
  assert.equal(ids.indexOf('migration-execute') < ids.indexOf('inventory-publish:legacyInventory'), true);
  assert.equal(ids.indexOf('inventory-readback:legacyInventory') < ids.indexOf('dependency-acceptance-deploy'), true);
  assert.equal(ids.indexOf('dependency-acceptance-execute') < ids.indexOf('llm-smoke-deploy'), true);
  assert.equal(ids.indexOf('tts-smoke-execute') < ids.indexOf('evidence-collect-describe:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-collect-copy:ttsSmoke') < ids.indexOf('evidence-publish:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-readback:ttsSmoke') < ids.indexOf('evidence-output-delete:dependencyAcceptance'), true);
  assert.equal(ids.indexOf('evidence-output-zero-readback') < ids.indexOf('candidate-deploy'), true);
  assert.equal(ids.indexOf('evidence-readback:iosVoiceAcceptance') < ids.indexOf('candidate-deploy'), true);
  assert.equal(ids.indexOf('candidate-readback') < ids.indexOf('candidate-public-service'), true);
  assert.equal(ids.includes('promote-authority-readback'), true);
  assert.equal(ids.indexOf('candidate-public-service') < ids.indexOf('promote-authority-readback'), true);
  assert.equal(ids.indexOf('promote-traffic') < ids.indexOf('rollback-traffic'), true);

  const build = plan.operations.find(({ id }) => id === 'build-submit');
  assert.equal(build.argv.at(-1), 'C:\\release\\source.tar.gz');
  assert.equal(build.argv.includes(`--service-account=${BUILD_SA}`), true);
  assert.equal(build.argv.includes(`--substitutions=_RELEASE_SHA=${RELEASE_SHA},_SOURCE_SHA256=${SOURCE_SHA}`), true);

  const candidate = plan.operations.find(({ id }) => id === 'candidate-deploy');
  assert.deepEqual(candidate.argv.slice(0, 3), ['run', 'services', 'replace']);
  assert.equal(candidate.argv[3], plan.candidateServiceSpecPath);
  const serviceSpec = plan.candidateServiceSpec;
  assert.equal(serviceSpec.apiVersion, 'serving.knative.dev/v1');
  assert.equal(serviceSpec.spec.template.metadata.name, REVISION);
  assert.equal(serviceSpec.spec.template.spec.containers[0].image,
    `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy/hkbuddy-api@${IMAGE_DIGEST}`);
  assert.equal(serviceSpec.spec.template.spec.containers[0].startupProbe.httpGet.path, '/api/health/ready');
  assert.equal(serviceSpec.spec.template.spec.containers[0].livenessProbe.httpGet.path, '/api/health/live');
  assert.equal(serviceSpec.spec.template.spec.containers[0].readinessProbe.httpGet.path, '/api/health/ready');
  assert.deepEqual(serviceSpec.spec.traffic, [
    { revisionName: 'hkbuddy-api-stable123456', percent: 100 },
    { revisionName: REVISION, tag: CANDIDATE_TAG, percent: 0 },
  ]);
  const specEnv = Object.fromEntries(serviceSpec.spec.template.spec.containers[0].env
    .filter(({ value }) => value !== undefined).map(({ name, value }) => [name, value]));
  assert.equal(specEnv.V1_PUBLIC_ORIGIN, STABLE_ORIGIN);
  assert.equal(specEnv.V1_CANDIDATE_ORIGIN, CANDIDATE_ORIGIN);
  assert.equal(specEnv.V1_RUNTIME_SERVICE_ACCOUNT, RUNTIME_SA);
  assert.equal(specEnv.V1_RELEASE_COMMIT_SHA, RELEASE_SHA);
  for (const { artifactSha256 } of Object.values(EVIDENCE)) {
    assert.equal(Object.values(specEnv).includes(artifactSha256), true);
  }

  const publicAuth = plan.operations.find(({ id }) => id === 'candidate-public-service');
  assert.deepEqual(publicAuth.argv.slice(0, 5), [
    'run', 'services', 'add-iam-policy-binding', 'hkbuddy-api', '--member=allUsers',
  ]);
  assert.equal(publicAuth.argv.includes('--role=roles/run.invoker'), true);
  const rollback = plan.operations.find(({ id }) => id === 'rollback-traffic');
  assert.equal(rollback.argv.includes('--to-revisions=hkbuddy-api-stable123456=100'), true);

  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(':latest'), false);
  assert.equal(serialized.includes('roles/run.admin'), false);
  assert.equal(serialized.toLowerCase().includes('private_key'), false);
  assert.equal(serialized.includes('add-cloudsql-instances'), false);
});

test('preboot acceptance jobs are digest-pinned, identity-exact, and produce evidence before candidate boot', () => {
  const plan = buildReleasePlan(releaseInput());
  const dependency = plan.operations.find(({ id }) => id === 'dependency-acceptance-deploy');
  assert.equal(dependency.phase, 'acceptance');
  assert.equal(dependency.argv.includes(`--image=asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy/hkbuddy-api@${IMAGE_DIGEST}`), true);
  assert.equal(dependency.argv.includes(`--service-account=${ACCEPTANCE_SA}`), true);
  assert.equal(dependency.argv.includes('--command=node'), true);
  assert.equal(dependency.argv.includes(`--args=scripts/real-dependencies-acceptance.js,--release-sha=${RELEASE_SHA}`), true);
  assert.equal(dependency.argv.includes('--max-retries=0'), true);
  const dependencyEnv = dependency.argv.find((value) => value.startsWith('--set-env-vars='));
  assert.match(dependencyEnv, new RegExp(`V1_RELEASE_MANIFEST_FILE=/app/release-manifest\\.json`));
  assert.match(dependencyEnv, new RegExp(`V1_ACCEPTANCE_SCHEMA=v1_accept_${ACCEPTANCE_RUN_ID.replaceAll('-', '')}`));
  assert.match(dependencyEnv, new RegExp(`V1_ACCEPTANCE_GCS_PREFIX=v1-accept/${ACCEPTANCE_RUN_ID}/`));
  assert.match(dependencyEnv, new RegExp(`V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT=release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}\\.json`));
  const dependencySecrets = dependency.argv.find((value) => value.startsWith('--set-secrets='));
  assert.match(dependencySecrets, /V1_DATABASE_URL=hkbuddy-db-app-url:7/);
  assert.match(dependencySecrets, /V1_ACCEPTANCE_DATABASE_URL=hkbuddy-db-app-url:7/);
  assert.match(dependencySecrets, /V1_ACCEPTANCE_MIGRATOR_DATABASE_URL=hkbuddy-db-migrator-url:8/);
  assert.match(dependencySecrets, /\/var\/run\/secrets\/hkbuddy\/legacy-inventory\.json=hkbuddy-legacy-inventory:11/);

  const expected = {
    'dependency-acceptance': { serviceAccount: ACCEPTANCE_SA, script: 'scripts/real-dependencies-acceptance.js' },
    'llm-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/provider-smoke.js' },
    'asr-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/voice-provider-smoke.js' },
    'tts-smoke': { serviceAccount: RUNTIME_SA, script: 'scripts/voice-provider-smoke.js' },
  };
  for (const [key, contract] of Object.entries(expected)) {
    const deploy = plan.operations.find(({ id }) => id === `${key}-deploy`);
    assert.equal(deploy.argv.includes(`--service-account=${contract.serviceAccount}`), true, key);
    assert.equal(deploy.argv.includes(`--image=asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy/hkbuddy-api@${IMAGE_DIGEST}`), true, key);
    assert.equal(deploy.argv.some((value) => value.includes(contract.script)), true, key);
    assert.equal(plan.operations.some(({ id }) => id === `${key}-readback`), true, key);
    assert.equal(plan.operations.some(({ id }) => id === `${key}-execute`), true, key);
    assert.equal(plan.expectedJobs[key].serviceAccount, contract.serviceAccount, key);
    assert.equal(plan.expectedJobs[key].image.endsWith(`@${IMAGE_DIGEST}`), true, key);
  }
  const asr = plan.operations.find(({ id }) => id === 'asr-smoke-deploy');
  assert.equal(asr.argv.includes('--args=scripts/voice-provider-smoke.js,--capability,asr,--generate-asr-fixtures-with-pinned-tts,--confirm-real-voice-provider,--confirm-asr-audio-nonsensitive'), true);
  const tts = plan.operations.find(({ id }) => id === 'tts-smoke-deploy');
  assert.equal(tts.argv.includes('--args=scripts/voice-provider-smoke.js,--capability,tts,--confirm-real-voice-provider'), true);
  assert.equal(JSON.stringify(plan.expectedJobs).includes('ios-voice-evidence'), false);
  assert.equal(plan.expectedJobs['llm-smoke'].environment.V1_LLM_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.llmSmoke.object);
  assert.equal(plan.expectedJobs['asr-smoke'].environment.V1_VOICE_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.asrSmoke.object);
  assert.equal(plan.expectedJobs['tts-smoke'].environment.V1_VOICE_SMOKE_OUTPUT_OBJECT, ACCEPTANCE_OUTPUTS.ttsSmoke.object);

  for (const [key, output] of Object.entries(ACCEPTANCE_OUTPUTS)) {
    const source = `gs://${output.bucket}/${output.object}#${output.generation}`;
    const describe = plan.operations.find(({ id }) => id === `evidence-collect-describe:${key}`);
    const copy = plan.operations.find(({ id }) => id === `evidence-collect-copy:${key}`);
    const remove = plan.operations.find(({ id }) => id === `evidence-output-delete:${key}`);
    assert.equal(describe.argv.includes(source), true, key);
    assert.equal(copy.argv.includes(source), true, key);
    assert.equal(copy.argv.includes(output.filePath), true, key);
    assert.equal(remove.argv.includes(source), true, key);
  }
});

test('acceptance execution reads back each exact Job identity before running it', async () => {
  const input = releaseInput({ acceptanceOutputs: null, evidence: null, previousRevision: null });
  const plan = buildReleasePlan(input, { phase: 'acceptance' });
  const expectedByJob = Object.fromEntries(Object.values(plan.expectedJobs).map((value) => (
    [value.job, value]
  )));
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=acceptance', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'describe') return structuredClone(expectedByJob[argv[3]]);
      return { done: true };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 12);
  for (const expected of Object.values(plan.expectedJobs)) {
    assert.equal(validateReleaseJobReadback(structuredClone(expected), expected), true);
    const mismatched = structuredClone(expected);
    mismatched.serviceAccount = 'hkbuddy-deployer@example.invalid';
    assert.throws(() => validateReleaseJobReadback(mismatched, expected), /Job readback/i);
  }
});

test('release contract separates numeric Secret versions from immutable evidence artifact digests', () => {
  for (const input of [
    releaseInput({ databaseSecretVersions: { app: 'latest', migrator: '8', session: '9' } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, secretVersion: 'latest' } } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, artifactSha256: '13' } } }),
    releaseInput({ evidence: { ...EVIDENCE, llmSmoke: { ...EVIDENCE.llmSmoke, objectSha256: '13' } } }),
    releaseInput({ imageDigest: `sha256:${'A'.repeat(64)}` }),
    releaseInput({ sourceArchive: '.' }),
    releaseInput({ previousRevision: 'other-service-revision' }),
    releaseInput({
      acceptanceOutputs: {
        ...ACCEPTANCE_OUTPUTS,
        llmSmoke: { ...ACCEPTANCE_OUTPUTS.llmSmoke, generation: 'latest' },
      },
    }),
    releaseInput({
      acceptanceOutputs: {
        ...ACCEPTANCE_OUTPUTS,
        asrSmoke: { ...ACCEPTANCE_OUTPUTS.asrSmoke, object: 'release-evidence/wrong.json' },
      },
    }),
  ]) assert.throws(() => buildReleasePlan(input), /release contract/i);
});

test('evidence artifact verification separates semantic digest from exact object bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-evidence-file-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'dependency-acceptance.json');
  const record = finalizeReleaseEvidenceRecord({
    schemaVersion: 1,
    commitSha: RELEASE_SHA,
    result: true,
  });
  const artifactSha256 = record.artifactSha256;
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  await writeFile(filePath, contents);
  const objectSha256 = createHash('sha256').update(contents).digest('hex');
  const verified = await validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256,
  }, { releaseSha: RELEASE_SHA });
  assert.equal(verified.artifactSha256, artifactSha256);
  assert.equal(verified.objectSha256, objectSha256);
  assert.equal(verified.byteLength, Buffer.byteLength(contents));

  await assert.rejects(() => validateEvidenceArtifactFile({
    filePath, artifactSha256, objectSha256: '8'.repeat(64),
  }, { releaseSha: RELEASE_SHA }), /evidence artifact/i);
});

test('generation-bound private evidence collection derives exact safe digests from downloaded bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-collected-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputs = Object.fromEntries(Object.entries(ACCEPTANCE_OUTPUTS).map(([key, value]) => [
    key, { ...value, filePath: join(directory, `${key}.json`) },
  ]));
  const fixtureByPath = {};
  for (const [index, [key, output]] of Object.entries(outputs).entries()) {
    const capability = key === 'llmSmoke' ? 'llm' : key === 'asrSmoke' ? 'asr' : 'tts';
    const payload = {
      schemaVersion: 1,
      commitSha: RELEASE_SHA,
      ...(key === 'dependencyAcceptance' ? { result: true } : { capability, result: 'pass' }),
    };
    const record = ['asrSmoke', 'ttsSmoke'].includes(key)
      ? finalizeEvidenceRecord(payload) : finalizeReleaseEvidenceRecord(payload);
    const contents = `${JSON.stringify(record)}\n`;
    fixtureByPath[output.filePath] = contents;
  }
  const described = [];
  const copied = [];
  const result = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      acceptanceOutputs: outputs,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
    }),
    execute: async (argv) => {
      if (argv[1] === 'objects') {
        const source = argv[3];
        const output = Object.values(outputs).find((value) => (
          source === `gs://${value.bucket}/${value.object}#${value.generation}`
        ));
        described.push(source);
        return {
          bucket: output.bucket,
          name: output.object,
          generation: output.generation,
          size: String(Buffer.byteLength(fixtureByPath[output.filePath])),
          contentType: 'application/json',
        };
      }
      const output = Object.values(outputs).find(({ filePath }) => filePath === argv[3]);
      copied.push(argv[2]);
      await writeFile(output.filePath, fixtureByPath[output.filePath], { flag: 'wx' });
      return null;
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(described.length, 4);
  assert.equal(copied.length, 4);
  assert.deepEqual(Object.keys(result.publicReport.collectedEvidence), Object.keys(outputs));
  for (const [key, receipt] of Object.entries(result.publicReport.collectedEvidence)) {
    assert.equal(Object.hasOwn(receipt, 'filePath'), false);
    assert.match(receipt.artifactSha256, /^[0-9a-f]{64}$/);
    assert.match(receipt.objectSha256, /^[0-9a-f]{64}$/);
    assert.notEqual(receipt.artifactSha256, receipt.objectSha256);
    assert.equal((await inspectCollectedEvidenceArtifact(outputs[key].filePath, {
      releaseSha: RELEASE_SHA, kind: key,
    })).objectSha256, receipt.objectSha256);
  }

  assert.equal(validateAcceptanceObjectReceipt({
    bucket: outputs.llmSmoke.bucket,
    name: outputs.llmSmoke.object,
    generation: outputs.llmSmoke.generation,
    size: '100',
    contentType: 'application/json',
  }, outputs.llmSmoke).generation, outputs.llmSmoke.generation);
  assert.throws(() => validateAcceptanceObjectReceipt({
    bucket: outputs.llmSmoke.bucket,
    name: outputs.llmSmoke.object,
    generation: '999',
    size: '100',
  }, outputs.llmSmoke), /object receipt/i);

  const preexisting = await runGcpRelease({
    argv: ['--phase=collect', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      acceptanceOutputs: outputs,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
    }),
    execute: async () => { throw new Error('must stop before GCP readback'); },
    writeOutput: () => undefined,
  });
  assert.equal(preexisting.exitCode, 1);
  assert.equal(preexisting.publicReport.mutationPerformed, false);
  assert.deepEqual(preexisting.publicReport.completed, []);
});

test('evidence publication accepts and reads back only the planned numeric versions', async () => {
  assert.equal(validateEvidenceVersionReceipt({
    name: `projects/${PROJECT}/secrets/hkbuddy-llm-smoke/versions/13`,
    state: 'ENABLED',
  }, { secret: 'hkbuddy-llm-smoke', secretVersion: '13' }), true);
  assert.throws(() => validateEvidenceVersionReceipt({
    name: `projects/${PROJECT}/secrets/hkbuddy-llm-smoke/versions/14`,
    state: 'ENABLED',
  }, { secret: 'hkbuddy-llm-smoke', secretVersion: '13' }), /evidence version/i);

  const versionsBySecret = Object.fromEntries(Object.values(EVIDENCE).map((value) => (
    [value.secret, value.secretVersion]
  )));
  const executor = async (argv) => {
    if (argv[0] === 'storage') {
      return argv[1] === 'objects' && argv[2] === 'list' ? [] : { done: true };
    }
    const isPublish = argv[0] === 'secrets' && argv[1] === 'versions' && argv[2] === 'add';
    const secret = isPublish
      ? argv[3]
      : argv.find((value) => value.startsWith('--secret=')).slice('--secret='.length);
    const version = isPublish ? versionsBySecret[secret] : argv[3];
    return { name: `projects/${PROJECT}/secrets/${secret}/versions/${version}`, state: 'ENABLED' };
  };
  let inventoryVerified = null;
  const inventory = await runGcpRelease({
    argv: ['--phase=inventory', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      imageDigest: IMAGE_DIGEST,
      databaseSecretVersions: null,
      evidence: null,
      acceptanceOutputs: null,
      previousRevision: null,
    }),
    execute: executor,
    verifyEvidence: async (value) => { inventoryVerified = value; },
    writeOutput: () => undefined,
  });
  assert.equal(inventory.exitCode, 0);
  assert.deepEqual(Object.keys(inventoryVerified), ['legacyInventory']);
  assert.deepEqual(inventory.publicReport.evidenceSecretVersions, { legacyInventory: '11' });

  const accepted = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(), executor,
    execute: executor,
    verifyEvidence: async () => true,
    writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);
  assert.deepEqual(accepted.publicReport.evidenceSecretVersions, Object.fromEntries(
    Object.entries(EVIDENCE).filter(([key]) => key !== 'legacyInventory')
      .map(([key, value]) => [key, value.secretVersion]),
  ));

  const mismatched = await runGcpRelease({
    argv: ['--phase=evidence', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    verifyEvidence: async () => true,
    execute: async (argv) => {
      if (argv[2] === 'add') return {
        name: `projects/${PROJECT}/secrets/${argv[3]}/versions/99`, state: 'ENABLED',
      };
      throw new Error('must stop before readback');
    },
    writeOutput: () => undefined,
  });
  assert.equal(mismatched.exitCode, 1);
  assert.equal(mismatched.publicReport.mutationPerformed, true);
});

test('build receipt captures one successful verified build, source hash, and final image digest', () => {
  const build = {
    id: '12345678-1234-4234-8234-123456789abc',
    status: 'SUCCESS',
    serviceAccount: BUILD_SA,
    substitutions: { _RELEASE_SHA: RELEASE_SHA, _SOURCE_SHA256: SOURCE_SHA },
    options: { requestedVerifyOption: 'VERIFIED', sourceProvenanceHash: ['SHA256'] },
    steps: [
      { id: 'validate-release-sha', status: 'SUCCESS' },
      { id: 'dependency-security-gate', status: 'SUCCESS' },
      { id: 'build', status: 'SUCCESS' },
      { id: 'verify-image-contract', status: 'SUCCESS' },
      { id: 'verify-oci-labels', status: 'SUCCESS' },
    ],
    sourceProvenance: {
      resolvedStorageSource: { bucket: 'source', object: 'source.tgz', generation: '123' },
      fileHashes: {
        'gs://source/source.tgz#123': {
          fileHash: [{ type: 'SHA256', value: Buffer.from(SOURCE_SHA, 'hex').toString('base64') }],
        },
      },
    },
    results: {
      images: [{
        name: `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy/hkbuddy-api:${RELEASE_SHA}`,
        digest: IMAGE_DIGEST,
      }],
    },
  };
  const receipt = validateBuildReceipt(build, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
  });

  assert.throws(() => validateBuildReceipt({
    ...build,
    steps: build.steps.map((step) => (step.id === 'dependency-security-gate'
      ? { ...step, status: 'FAILURE' }
      : step)),
  }, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
  }), /Cloud Build receipt/i);
  assert.throws(() => validateBuildReceipt({
    ...build,
    steps: build.steps.filter(({ id }) => id !== 'dependency-security-gate'),
  }, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
  }), /Cloud Build receipt/i);

  assert.deepEqual(receipt, {
    buildId: '12345678-1234-4234-8234-123456789abc',
    releaseSha: RELEASE_SHA,
    sourceArchiveSha256: SOURCE_SHA,
    sourceProvenance: { uri: 'gs://source/source.tgz#123', sha256: SOURCE_SHA },
    imageDigest: IMAGE_DIGEST,
    provenance: 'VERIFIED',
    ociLabels: {
      'com.simplify.source-archive-sha256': SOURCE_SHA,
      'org.opencontainers.image.revision': RELEASE_SHA,
      'org.opencontainers.image.source': 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
    },
  });
  assert.throws(() => validateBuildReceipt({ ...receipt, status: 'SUCCESS' }, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
  }), /build receipt/i);

  return runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
    }),
    execute: async (argv) => (argv[1] === 'submit' ? build : [build]),
    verifySourceArchive: async () => true,
    writeOutput: () => undefined,
  }).then((result) => {
    assert.equal(result.exitCode, 0);
    assert.deepEqual(result.publicReport.buildReceipt, receipt);
    return runGcpRelease({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input: releaseInput({ imageDigest: null }),
      execute: async () => { throw new Error('candidate must remain inert'); },
      writeOutput: () => undefined,
    });
  }).then((result) => {
    assert.equal(result.exitCode, 2);
    assert.equal(result.publicReport.code, 'RELEASE_CONTRACT_INVALID');
  });
});

test('candidate readback requires the exact digest, probes, numeric mounts, zero traffic, and public tagged preview IAM', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.expectedCandidate;
  assert.equal(validateCandidateReadback(structuredClone(candidate), plan), true);
  for (const mutate of [
    (value) => { value.image = value.image.replace('@sha256:', ':latest'); },
    (value) => { value.probes.startup.path = '/api/health/live'; },
    (value) => { value.traffic[0].percent = 100; },
    (value) => { value.iam[0].members = ['allAuthenticatedUsers']; },
    (value) => { value.secretMounts.legacyInventory.version = 'latest'; },
  ]) {
    const changed = structuredClone(candidate);
    mutate(changed);
    assert.throws(() => validateCandidateReadback(changed, plan), /candidate readback/i);
  }
});

test('confirmed candidate fails closed unless every control-plane readback matches the exact revision contract', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const readbacks = {
    service: {
      service: 'hkbuddy-api',
      traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 0 }],
    },
    revision: structuredClone(plan.expectedCandidate),
    iam: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
    artifact: { image: plan.expectedCandidate.image },
  };
  assert.equal(validateCandidateControlPlaneReadbacks(structuredClone(readbacks), plan), true);
  const drift = structuredClone(readbacks);
  drift.revision.probes.startup.path = '/api/health/live';
  assert.throws(() => validateCandidateControlPlaneReadbacks(drift, plan), /revision readback/i);

  const createExecutor = ({ artifact = readbacks.artifact } = {}) => {
    let iamPublic = false;
    let serviceDescribeCount = 0;
    return async (argv) => {
    if (argv[0] === 'artifacts') return structuredClone(artifact);
    if (argv.includes('get-iam-policy')) return iamPublic
      ? structuredClone(readbacks.iam) : { bindings: [] };
    if (argv.includes('add-iam-policy-binding')) {
      iamPublic = true;
      return structuredClone(readbacks.iam);
    }
    if (argv[1] === 'revisions') return structuredClone(readbacks.revision);
    if (argv[1] === 'services' && argv[2] === 'describe') {
      serviceDescribeCount += 1;
      return serviceDescribeCount === 1
        ? { service: 'hkbuddy-api', traffic: [{ revision: 'hkbuddy-api-stable123456', percent: 100 }] }
        : structuredClone(readbacks.service);
    }
    return { deployed: true };
    };
  };
  const execute = createExecutor();
  const accepted = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input, execute, writeCandidateSpec: async () => true, writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);

  const rejected = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: createExecutor({ artifact: {} }),
    writeCandidateSpec: async () => true,
    writeOutput: () => undefined,
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.mutationPerformed, true);
});

test('release orchestrator is dry-run first and executes only one exactly confirmed phase', async () => {
  const calls = [];
  const input = releaseInput();
  const dryRun = await runGcpRelease({
    argv: ['--phase=candidate'], input,
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(dryRun.exitCode, 0);
  assert.equal(dryRun.publicReport.status, 'dry-run');
  assert.equal(calls.length, 0);

  const result = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      calls.push(argv);
      return { traffic: [{ revision: input.previousRevision, percent: 100 }] };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls, planPhase(buildReleasePlan(input), 'rollback').map(({ argv }) => argv));

  const invalid = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`, '--extra'], input,
    execute: async () => { throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(invalid.exitCode, 2);
  assert.equal(invalid.publicReport.mutationPerformed, false);
});

test('public promotion requires the reviewed owner identity before its first mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const candidateReadbacks = {
    service: {
      service: 'hkbuddy-api',
      traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 0 }],
    },
    revision: structuredClone(plan.expectedCandidate),
    iam: { bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }] },
    artifact: { image: plan.expectedCandidate.image },
  };
  let promoted = false;
  const accepted = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return structuredClone(candidateReadbacks.artifact);
      if (argv.includes('get-iam-policy')) return structuredClone(candidateReadbacks.iam);
      if (argv[1] === 'revisions') return structuredClone(candidateReadbacks.revision);
      if (argv.includes('update-traffic')) promoted = true;
      if (argv[1] === 'services' && argv[2] === 'describe' && !promoted) {
        return structuredClone(candidateReadbacks.service);
      }
      return { traffic: [{ revision: REVISION, percent: 100 }] };
    },
    writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);

  const rejected = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => (argv[0] === 'auth'
      ? [{ account: 'hkbuddy-deployer@example.invalid', status: 'ACTIVE' }]
      : (() => { throw new Error('promotion must remain inert'); })()),
    writeOutput: () => undefined,
  });
  assert.equal(rejected.exitCode, 1);
  assert.equal(rejected.publicReport.mutationPerformed, false);
  assert.deepEqual(rejected.publicReport.completed, []);
  assert.equal(validateServiceIamReceipt({
    bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
  }, { publicInvoker: true }), true);
  assert.throws(() => validateServiceIamReceipt({
    bindings: [{ role: 'roles/run.invoker', members: ['allAuthenticatedUsers'] }],
  }, { publicInvoker: true }), /IAM readback/i);
  assert.equal(validateTrafficReceipt({
    status: { traffic: [{ revisionName: REVISION, percent: 100 }] },
  }, { revision: REVISION }), true);
  assert.throws(() => validateTrafficReceipt({
    traffic: [{ revision: REVISION, percent: 99 }],
  }, { revision: REVISION }), /traffic readback/i);
});

test('candidate deployment uses a controlled Service YAML and never the unsupported deploy readiness flag', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.operations.find(({ id }) => id === 'candidate-deploy');
  assert.deepEqual(candidate.argv.slice(0, 3), ['run', 'services', 'replace']);
  assert.equal(candidate.argv.some((value) => value.startsWith('--readiness-probe=')), false);
  assert.equal(candidate.argv.some((value) => value === 'deploy'), false);

  const publicPreview = plan.operations.find(({ id }) => id === 'candidate-public-service');
  assert.equal(publicPreview.phase, 'candidate');
  assert.equal(publicPreview.argv.includes('--member=allUsers'), true);
  assert.equal(publicPreview.argv.includes('--role=roles/run.invoker'), true);
  assert.equal(plan.operations.some(({ id }) => id === 'promote-public-service'), false);
  assert.equal(plan.operations.some(({ id }) => id === 'candidate-cleanup-public-service'), true);
});

test('changed release archive bytes are rejected before the first Cloud Build mutation', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-release-build-input-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceArchive = join(directory, 'source.tar.gz');
  await writeFile(sourceArchive, 'original archive bytes');
  const claimed = createHash('sha256').update('original archive bytes').digest('hex');
  await writeFile(sourceArchive, 'changed after manifest freeze');
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=build', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({
      sourceArchive,
      sourceArchiveSha256: claimed,
      imageDigest: null,
      databaseSecretVersions: null,
      evidence: null,
      previousRevision: null,
    }),
    execute: async (argv) => { calls.push(argv); throw new Error('must remain inert'); },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('Cloud Build receipt requires the exact generation-bound SHA256 source provenance', () => {
  const sourceHash = Buffer.from(SOURCE_SHA, 'hex').toString('base64');
  const build = {
    id: '12345678-1234-4234-8234-123456789abc',
    status: 'SUCCESS',
    serviceAccount: BUILD_SA,
    substitutions: { _RELEASE_SHA: RELEASE_SHA, _SOURCE_SHA256: SOURCE_SHA },
    options: { requestedVerifyOption: 'VERIFIED', sourceProvenanceHash: ['SHA256'] },
    steps: [
      'validate-release-sha', 'dependency-security-gate', 'build',
      'verify-image-contract', 'verify-oci-labels',
    ].map((id) => ({ id, status: 'SUCCESS' })),
    sourceProvenance: {
      resolvedStorageSource: { bucket: 'hkbuddy-build-source', object: 'source.tar.gz', generation: '123' },
      fileHashes: {
        'gs://hkbuddy-build-source/source.tar.gz#123': {
          fileHash: [{ type: 'SHA256', value: sourceHash }],
        },
      },
    },
    results: {
      images: [{
        name: `asia-east2-docker.pkg.dev/${PROJECT}/hkbuddy/hkbuddy-api:${RELEASE_SHA}`,
        digest: IMAGE_DIGEST,
      }],
    },
  };
  assert.doesNotThrow(() => validateBuildReceipt(build, {
    releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
  }));
  for (const sourceProvenance of [
    {},
    { ...build.sourceProvenance, fileHashes: {} },
    {
      ...build.sourceProvenance,
      fileHashes: {
        'gs://hkbuddy-build-source/source.tar.gz#123': {
          fileHash: [{ type: 'SHA256', value: Buffer.from('f'.repeat(64), 'hex').toString('base64') }],
        },
      },
    },
    {
      ...build.sourceProvenance,
      fileHashes: {
        'gs://hkbuddy-build-source/source.tar.gz': {
          fileHash: [{ type: 'SHA256', value: sourceHash }],
        },
      },
    },
  ]) {
    assert.throws(() => validateBuildReceipt({ ...build, sourceProvenance }, {
      releaseSha: RELEASE_SHA, sourceArchiveSha256: SOURCE_SHA,
    }), /Cloud Build receipt/i);
  }
});

test('evidence validation rejects a forged self-reported semantic digest even when object bytes match', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-forged-evidence-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, 'forged.json');
  const artifactSha256 = '7'.repeat(64);
  const contents = `${JSON.stringify({
    schemaVersion: 1, commitSha: RELEASE_SHA, result: true, artifactSha256,
  })}\n`;
  await writeFile(filePath, contents);
  await assert.rejects(() => validateEvidenceArtifactFile({
    filePath,
    artifactSha256,
    objectSha256: createHash('sha256').update(contents).digest('hex'),
  }, { releaseSha: RELEASE_SHA }), /evidence artifact/i);
});

test('migration refuses execution when the exact deployed Job readback drifts', async () => {
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput({ evidence: null, acceptanceOutputs: null, previousRevision: null }),
    execute: async (argv) => {
      calls.push(argv);
      if (argv[2] === 'describe') return { serviceAccount: 'unexpected@example.invalid' };
      return { done: true };
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((argv) => argv[2] === 'execute'), false);
});

test('promotion without the complete predecessor receipt chain remains inert', async () => {
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    loadReceipts: async () => [],
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.notEqual(result.exitCode, 0);
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('promotion revalidates every Task 8 artifact before any control-plane call', async () => {
  const calls = [];
  const verified = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input: releaseInput(),
    verifyTask8Evidence: async (_entry, phase) => {
      verified.push(phase);
      if (phase === 'mobile') throw new Error('mobile bytes drifted');
      return true;
    },
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(verified, ['readiness', 'workload', 'mobile']);
  assert.deepEqual(calls, []);
  assert.equal(result.publicReport.mutationPerformed, false);
});

test('promotion rereads the exact public zero-traffic candidate before changing traffic', () => {
  const operations = buildReleasePlan(releaseInput()).operations;
  const ids = operations.map(({ id }) => id);
  for (const id of [
    'promote-candidate-service-readback', 'promote-candidate-revision-readback',
    'promote-candidate-iam-readback', 'promote-candidate-artifact-readback',
  ]) {
    assert.equal(ids.includes(id), true, id);
    assert.equal(ids.indexOf(id) < ids.indexOf('promote-traffic'), true, id);
  }
});

function planPhase(plan, phase) {
  return plan.operations.filter((operation) => operation.phase === phase);
}

test('Cloud Build and infrastructure contracts pin the reviewed build identity and dependency-safe startup', async () => {
  const cloudbuild = await readFile(new URL('../cloudbuild.yaml', import.meta.url), 'utf8');
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8');
  const dockerignore = await readFile(new URL('../.dockerignore', import.meta.url), 'utf8');
  assert.match(cloudbuild, new RegExp(`serviceAccount: projects/${PROJECT}/serviceAccounts/hkbuddy-build@${PROJECT.replaceAll('.', '\\.')}`));
  assert.match(cloudbuild, /requestedVerifyOption: VERIFIED/);
  assert.match(cloudbuild, /sourceProvenanceHash:\s*\n\s*- SHA256/);
  assert.match(cloudbuild, /gcr\.io\/cloud-builders\/docker@sha256:[0-9a-f]{64}/);
  assert.match(cloudbuild, /--build-arg=V1_RELEASE_COMMIT_SHA=\$_RELEASE_SHA/);
  assert.match(cloudbuild, /--build-arg=V1_SOURCE_ARCHIVE_SHA256=\$_SOURCE_SHA256/);
  assert.match(cloudbuild, /--label=org\.opencontainers\.image\.source=https:\/\/github\.com\/jimmy00415\/Cantonese_Learning_Full_stack/);
  assert.match(cloudbuild, /index \.Config\.Labels "org\.opencontainers\.image\.source"/);
  const dependencyGate = cloudbuild.indexOf('- id: dependency-security-gate');
  const dependencyInstall = cloudbuild.indexOf(
    'npm ci --omit=dev --ignore-scripts --no-audit', dependencyGate,
  );
  const dependencyAudit = cloudbuild.indexOf(
    'npm run --silent security:dependencies', dependencyInstall,
  );
  const imageBuild = cloudbuild.indexOf('- id: build');
  assert.notEqual(dependencyGate, -1);
  assert.equal(dependencyInstall > dependencyGate, true);
  assert.equal(dependencyAudit > dependencyInstall, true);
  assert.equal(imageBuild > dependencyAudit, true);
  assert.match(cloudbuild, /DEPENDENCY_SECURITY_RECEIPT/);
  assert.match(cloudbuild, /DEPENDENCY_SECURITY_EXCEPTION_REVIEWED/);
  assert.match(cloudbuild, /dependency_security_receipt="\$\$\(npm run --silent security:dependencies\)"/);
  assert.match(cloudbuild, /waitFor:\s*\n\s*- dependency-security-gate/);
  assert.match(dockerfile, /ARG V1_RELEASE_COMMIT_SHA/);
  assert.match(dockerfile, /ARG V1_SOURCE_ARCHIVE_SHA256/);
  assert.match(dockerfile, /COPY --chown=node:node scripts\/create-image-release-manifest\.js \.\/scripts\/create-image-release-manifest\.js/);
  assert.match(dockerfile, /RUN node scripts\/create-image-release-manifest\.js/);
  assert.equal(dockerignore.includes('!scripts/create-image-release-manifest.js'), true);
  for (const filePath of IMAGE_SCRIPTS) {
    assert.equal(dockerfile.includes(`COPY --chown=node:node ${filePath} ./${filePath}`), true, filePath);
    assert.equal(dockerignore.includes(`!${filePath}`), true, filePath);
  }

  const contract = JSON.parse(await readFile(new URL('../infra/gcp/resource-contract.json', import.meta.url), 'utf8'));
  assert.equal(contract.resources.cloudRun.startupProbe.path, '/api/health/ready');
  const deployer = `serviceAccount:hkbuddy-deployer@${PROJECT}.iam.gserviceaccount.com`;
  const acceptance = `serviceAccount:hkbuddy-acceptance@${PROJECT}.iam.gserviceaccount.com`;
  assert.equal(contract.resources.serviceAccounts.some(({ id }) => id === 'hkbuddy-acceptance'), true);
  assert.deepEqual(contract.iam.bindings.filter(({ member }) => member === acceptance), [
    { scope: `bucket:${PROJECT}-media`, member: acceptance, role: 'roles/storage.objectUser' },
    {
      scope: `bucket:${PROJECT}-media`, member: acceptance,
      role: `projects/${PROJECT}/roles/hkbuddyAcceptanceBucketMetadataReader`,
    },
    { scope: 'secret:hkbuddy-db-app-url', member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: 'secret:hkbuddy-db-migrator-url', member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: 'project', member: acceptance, role: 'roles/logging.logWriter' },
  ]);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-acceptance' && member === deployer
      && role === 'roles/iam.serviceAccountUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ member, role }) => (
    member === acceptance && role === 'roles/secretmanager.secretVersionAdder'
  )), false);
  assert.equal(contract.iam.bindings.some(({ member, role }) => (
    member === acceptance && ['roles/aiplatform.user', 'roles/speech.client',
      'roles/serviceusage.serviceUsageConsumer'].includes(role)
  )), false);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'project' && member === deployer && role === 'roles/cloudbuild.builds.editor'
  )), true);
  for (const { secret } of Object.values(EVIDENCE)) {
    assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
      scope === `secret:${secret}` && member === deployer
        && role === 'roles/secretmanager.secretVersionAdder'
    )), true, secret);
  }
  assert.equal(JSON.stringify(contract).includes('roles/run.admin'), true);
  assert.equal(contract.iam.bindings.some(({ role }) => role === 'roles/run.admin'), false);
});
