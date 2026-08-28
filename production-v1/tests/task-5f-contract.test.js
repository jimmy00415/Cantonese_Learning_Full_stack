import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildReleasePlan,
  finalizeReleasePhaseReceipt,
  releasePhaseIdentitySha256,
  runGcpRelease,
  validateCandidateReadback,
  validateCandidateControlPlaneReadbacks,
} from '../scripts/gcp-release.js';
import { assertCidrAvailable } from '../scripts/gcp-provision.js';
import { candidatePrivacyBoundarySha256 } from '../scripts/candidate-privacy-proof.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';

const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const REGION = GCP_IDENTITY.region;
const STABLE_SERVICE = GCP_IDENTITY.service;
const CANDIDATE_SERVICE = GCP_IDENTITY.candidateService;
const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const BUILD_CONFIG_SHA = 'e'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const PREVIOUS_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const PREVIOUS_REVISION = `${STABLE_SERVICE}-111111111111`;
const ACCEPTANCE_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';
const INVOKER_IAM_DISABLED = 'run.googleapis.com/invoker-iam-disabled';

const EVIDENCE = Object.freeze({
  legacyInventory: Object.freeze({
    secret: GCP_IDENTITY.secrets.legacy, secretVersion: '11',
    artifactSha256: '1'.repeat(64), objectSha256: 'a'.repeat(64),
    filePath: 'C:\\release\\legacy-inventory.json',
  }),
  dependencyAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.dependencies, secretVersion: '12',
    artifactSha256: '2'.repeat(64), objectSha256: 'b'.repeat(64),
    filePath: 'C:\\release\\dependency-acceptance.json',
  }),
  llmSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.llm, secretVersion: '13',
    artifactSha256: '3'.repeat(64), objectSha256: 'c'.repeat(64),
    filePath: 'C:\\release\\llm-smoke.json',
  }),
  asrSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.asr, secretVersion: '14',
    artifactSha256: '4'.repeat(64), objectSha256: 'd'.repeat(64),
    filePath: 'C:\\release\\asr-smoke.json',
  }),
  ttsSmoke: Object.freeze({
    secret: GCP_IDENTITY.secrets.tts, secretVersion: '15',
    artifactSha256: '5'.repeat(64), objectSha256: 'e'.repeat(64),
    filePath: 'C:\\release\\tts-smoke.json',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: GCP_IDENTITY.secrets.ios, secretVersion: '16',
    artifactSha256: '6'.repeat(64), objectSha256: 'f'.repeat(64),
    filePath: 'C:\\release\\ios-voice-acceptance.json',
  }),
});

const ACCEPTANCE_OUTPUTS = Object.freeze({
  dependencyAcceptance: Object.freeze({
    bucket: GCP_IDENTITY.bucket,
    object: `release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}.json`,
    generation: '101', filePath: EVIDENCE.dependencyAcceptance.filePath,
  }),
  llmSmoke: Object.freeze({
    bucket: GCP_IDENTITY.bucket,
    object: `release-evidence/${RELEASE_SHA}/llm-smoke/llm-${ACCEPTANCE_RUN_ID}.json`,
    generation: '102', filePath: EVIDENCE.llmSmoke.filePath,
  }),
  asrSmoke: Object.freeze({
    bucket: GCP_IDENTITY.bucket,
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/asr-${ACCEPTANCE_RUN_ID}.json`,
    generation: '103', filePath: EVIDENCE.asrSmoke.filePath,
  }),
  ttsSmoke: Object.freeze({
    bucket: GCP_IDENTITY.bucket,
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/tts-${ACCEPTANCE_RUN_ID}.json`,
    generation: '104', filePath: EVIDENCE.ttsSmoke.filePath,
  }),
});

function task8Entry(phase, stableTrafficState) {
  const digit = { readiness: '7', workload: '8', mobile: '9' }[phase];
  return {
    schemaVersion: 3,
    filePath: `C:\\release\\${phase}.json`,
    artifactSha256: digit.repeat(64), objectSha256: digit.repeat(64),
    candidateService: CANDIDATE_SERVICE, stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100', stableTrafficState,
    privacyProofs: Object.fromEntries(['start', 'end'].map((boundary, index) => [boundary, {
      schemaVersion: 3,
      filePath: `C:\\release\\${phase}-${boundary}-privacy.json`,
      artifactSha256: String(index + 1).repeat(64),
      objectSha256: String(index + 3).repeat(64),
      boundarySha256: String(index + 5).repeat(64),
      observedAt: boundary === 'start'
        ? '2026-08-26T08:00:00.000Z' : '2026-08-26T08:10:00.000Z',
      expiresAt: boundary === 'start'
        ? '2026-08-26T08:05:00.000Z' : '2026-08-26T08:15:00.000Z',
    }])),
  };
}

function releaseInput({ first = false } = {}) {
  const stableTrafficState = first ? 'stable-absent' : 'stable-prior-100';
  return {
    releaseSha: RELEASE_SHA,
    sourceArchive: 'C:\\release\\source.tar.gz',
    sourceArchiveSha256: SOURCE_SHA,
    buildConfig: `C:\\release\\${RELEASE_SHA}.${BUILD_CONFIG_SHA}.cloudbuild.yaml`,
    buildConfigSha256: BUILD_CONFIG_SHA,
    imageDigest: IMAGE_DIGEST,
    projectNumber: PROJECT_NUMBER,
    databaseSecretVersions: { app: '7', migrator: '8', session: '9' },
    acceptanceRunId: ACCEPTANCE_RUN_ID,
    acceptanceOutputs: ACCEPTANCE_OUTPUTS,
    task8Evidence: Object.fromEntries(['readiness', 'workload', 'mobile'].map((phase) => [
      phase, task8Entry(phase, stableTrafficState),
    ])),
    legacyInventory: EVIDENCE.legacyInventory,
    evidence: EVIDENCE,
    previousRevision: first ? null : PREVIOUS_REVISION,
    previousImageDigest: first ? null : PREVIOUS_IMAGE_DIGEST,
  };
}

function canonicalFixture(value) {
  if (Array.isArray(value)) return value.map(canonicalFixture);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalFixture(value[key])]));
  }
  return value;
}

function candidatePrivacyReference(plan) {
  return {
    schemaVersion: 3,
    filePath: plan.candidatePrivacyProofPath,
    artifactSha256: '1'.repeat(64),
    objectSha256: '2'.repeat(64),
    boundarySha256: candidatePrivacyBoundarySha256({
      projectId: PROJECT,
      projectNumber: PROJECT_NUMBER,
      organizationId: GCP_IDENTITY.organizationId,
      region: REGION,
      releaseSha: plan.releaseSha,
      imageDigest: plan.imageDigest,
      image: plan.expectedCandidate.image,
      candidateService: plan.candidateService,
      candidateRevision: plan.candidateRevision,
      candidateTag: plan.candidateTag,
      candidateOrigin: plan.candidateOrigin,
      candidateAudience: plan.candidateServiceOrigin,
      acceptanceServiceAccount: GCP_IDENTITY.serviceAccounts.acceptance,
      operator: 'admin@motionexp.com',
      expectedCandidate: plan.expectedCandidate,
    }),
    observedAt: '2026-08-26T08:00:00.000Z',
    expiresAt: '2026-08-26T08:05:00.000Z',
  };
}

function receiptOutputs(plan, phase) {
  if (phase === 'build') return {
    buildConfigSha256: plan.buildConfigSha256,
    buildId: '12345678-1234-4234-8234-123456789abc',
    buildReceiptSha256: 'f'.repeat(64),
    imageDigest: plan.imageDigest,
    sourceArchiveSha256: plan.sourceArchiveSha256,
    sourceProvenance: {
      uri: `gs://${GCP_IDENTITY.buildSourceBucket}/source/source.tgz#123`,
      sha256: plan.sourceArchiveSha256,
    },
    ociLabels: {
      'com.simplify.build-config-sha256': plan.buildConfigSha256,
      'com.simplify.source-archive-sha256': plan.sourceArchiveSha256,
      'org.opencontainers.image.revision': plan.releaseSha,
      'org.opencontainers.image.source': 'https://github.com/jimmy00415/Cantonese_Learning_Full_stack',
    },
  };
  if (phase === 'migration') return {
    executionName: `${GCP_IDENTITY.jobs.migration}-release-001`,
    job: GCP_IDENTITY.jobs.migration, imageDigest: plan.imageDigest,
  };
  if (phase === 'inventory') return {
    evidenceSecretVersions: { legacyInventory: plan.evidence.legacyInventory.secretVersion },
  };
  if (phase === 'acceptance') return {
    jobs: Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
      key, { image: value.image, serviceAccount: value.serviceAccount },
    ])),
    executions: Object.fromEntries(Object.entries(plan.expectedJobs).map(([key, value]) => [
      key, {
        name: `${value.job}-release-001`,
        job: value.job,
        taskCount: value.taskCount,
        parallelism: value.parallelism,
        succeededCount: value.taskCount,
        completionTime: '2026-08-26T08:00:00.000Z',
      },
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
    access: structuredClone(plan.candidateAccess),
    privacyProofReferenceSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(candidatePrivacyReference(plan)))).digest('hex'),
    candidateContractSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(plan.expectedCandidate))).digest('hex'),
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    privacyProof: candidatePrivacyReference(plan),
    publicInvoker: false,
    priorRelease: plan.previousRevision === null ? null : {
      image: plan.previousImage,
      imageDigest: plan.previousImageDigest,
      revision: plan.previousRevision,
    },
    revision: plan.candidateRevision,
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    tag: plan.candidateTag,
    trafficPercent: 100,
    trafficState: 'candidate-service-private-100',
  };
  const output = {
    artifactSha256: plan.task8Evidence[phase].artifactSha256,
    objectSha256: plan.task8Evidence[phase].objectSha256,
    candidateOrigin: plan.candidateOrigin,
    candidateRevision: plan.candidateRevision,
    candidateService: CANDIDATE_SERVICE,
    imageDigest: plan.imageDigest,
    privacyProofs: structuredClone(plan.task8Evidence[phase].privacyProofs),
    stableService: STABLE_SERVICE,
    stableTrafficState: plan.expectedStable.initialTrafficState,
    trafficState: 'candidate-service-private-100',
  };
  if (phase === 'workload') {
    output.execution = {
      acceptanceWindowId: createHash('sha256').update('acceptance-window').digest('hex'),
      attemptId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      networkWitnessSha256: createHash('sha256').update('network-witness').digest('hex'),
      observedRequestCount: 592,
    };
  }
  if (phase === 'mobile') {
    output.access = structuredClone(plan.candidateAccess);
    output.viewport = { width: 390, height: 844 };
  }
  return output;
}

function receiptChain(plan, through) {
  const phases = ['build', 'migration', 'inventory', 'acceptance', 'collect', 'evidence',
    'candidate', 'readiness', 'workload', 'mobile'];
  const receipts = [];
  for (const [index, phase] of phases.entries()) {
    const receipt = finalizeReleasePhaseReceipt({
      schemaVersion: 2,
      phase,
      sequence: index + 1,
      releaseSha: plan.releaseSha,
      releaseIdentitySha256: plan.releaseIdentitySha256,
      phaseIdentitySha256: releasePhaseIdentitySha256(plan, phase),
      candidateService: CANDIDATE_SERVICE,
      stableService: STABLE_SERVICE,
      trafficState: 'candidate-service-private-100',
      stableTrafficState: plan.expectedStable.initialTrafficState,
      previousReceiptSha256: receipts.at(-1)?.receiptSha256 ?? null,
      completed: plan.operations.filter((member) => member.phase === phase).map(({ id }) => id),
      outputs: receiptOutputs(plan, phase),
    });
    receipts.push(receipt);
    if (phase === through) return receipts;
  }
  throw new Error('unknown receipt phase');
}

function privateCandidateIam() {
  return {
    bindings: [{
      role: 'roles/run.servicesInvoker',
      members: [`serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`],
    }],
    etag: 'candidate-private', version: 1,
  };
}

function publicStableIam() {
  return {
    bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
    etag: 'stable-public', version: 1,
  };
}

function canonicalAbsence(message = 'not found') {
  return Object.assign(new Error(message), { code: 'CLOUD_RUN_SERVICE_NOT_FOUND' });
}

function rawService({ service, traffic, annotation = 'false' }) {
  return {
    apiVersion: 'serving.knative.dev/v1',
    kind: 'Service',
    metadata: {
      name: service,
      annotations: {
        'run.googleapis.com/ingress': 'all',
        ...(annotation === undefined ? {} : { [INVOKER_IAM_DISABLED]: annotation }),
      },
    },
    status: {
      traffic: traffic.map(({ revision, tag = null, percent }) => ({
        revisionName: revision,
        ...(tag === null ? {} : {
          tag,
          url: `https://${tag}---${service}-${PROJECT_NUMBER}.${REGION}.run.app`,
        }),
        percent,
      })),
    },
  };
}

function candidateService(plan, annotation = 'false') {
  return rawService({
    service: CANDIDATE_SERVICE,
    traffic: plan.expectedCandidate.traffic,
    annotation,
  });
}

function stableService(plan, traffic = plan.expectedStable.traffic, annotation = 'false') {
  return rawService({ service: STABLE_SERVICE, traffic, annotation });
}

function createTestStateStore({ attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } = {}) {
  const records = [];
  const append = (record) => {
    const stored = {
      ...structuredClone(record),
      attemptId,
      recordSha256: createHash('sha256')
        .update(JSON.stringify({ sequence: records.length + 1, record }))
        .digest('hex'),
    };
    records.push(stored);
    return stored;
  };
  return {
    attemptId,
    records,
    appendIntent: async (payload, { operationId } = {}) => append({
      recordType: 'intent', operationId, payload,
    }),
    appendCheckpoint: async (payload) => append({
      recordType: 'checkpoint',
      operationId: records.findLast((record) => record.recordType === 'intent')?.operationId,
      payload,
    }),
    appendTerminal: async (payload) => append({
      recordType: 'terminal', operationId: null, payload,
    }),
    close: async () => undefined,
  };
}

function releaseRunner(options) {
  return runGcpRelease({
    openStateStore: async () => createTestStateStore(),
    persistReceipt: async () => true,
    verifyEvidence: async () => true,
    verifyTask8Evidence: async () => true,
    ...options,
  });
}

test('Cloud Run private truth binds the explicit Invoker IAM annotation before dependent mutation', async (t) => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);

  await t.test('controlled candidate and stable Service specs pin lowercase semantic false', () => {
    assert.equal(plan.candidateServiceSpec.metadata.annotations[INVOKER_IAM_DISABLED], 'false');
    assert.equal(plan.stableServiceSpec.metadata.annotations[INVOKER_IAM_DISABLED], 'false');
    assert.equal(plan.expectedCandidate.invokerIamDisabled, false);
    assert.equal(plan.expectedStable.invokerIamDisabled, false);
    assert.throws(() => validateCandidateReadback({
      ...structuredClone(plan.expectedCandidate), invokerIamDisabled: true,
    }, plan), /readback/i);
  });

  await t.test('real v1 readbacks accept proven string false forms and reject every ambiguous source', () => {
    const base = {
      revision: structuredClone(plan.expectedCandidate),
      iam: privateCandidateIam(),
      artifact: { image: plan.image },
    };
    for (const annotation of [undefined, 'false', 'False']) {
      assert.doesNotThrow(() => validateCandidateControlPlaneReadbacks({
        ...base, service: candidateService(plan, annotation),
      }, plan));
    }
    const noAnnotations = candidateService(plan);
    delete noAnnotations.metadata.annotations;
    assert.doesNotThrow(() => validateCandidateControlPlaneReadbacks({
      ...base, service: noAnnotations,
    }, plan));
    assert.doesNotThrow(() => validateCandidateControlPlaneReadbacks({
      ...base,
      service: {
        service: CANDIDATE_SERVICE,
        traffic: structuredClone(plan.expectedCandidate.traffic),
        invokerIamDisabled: false,
      },
    }, plan));

    const missingApiVersion = candidateService(plan);
    delete missingApiVersion.apiVersion;
    const missingKind = candidateService(plan);
    delete missingKind.kind;
    const malformedAnnotations = candidateService(plan);
    malformedAnnotations.metadata.annotations = [];
    const nonPlainAnnotations = candidateService(plan);
    nonPlainAnnotations.metadata.annotations = new Date(0);
    const specOnlyTraffic = candidateService(plan);
    specOnlyTraffic.spec = { traffic: specOnlyTraffic.status.traffic };
    delete specOnlyTraffic.status;
    for (const service of [
      candidateService(plan, 'true'),
      candidateService(plan, ' false'),
      candidateService(plan, false),
      candidateService(plan, 'unknown'),
      { ...candidateService(plan), apiVersion: 'serving.knative.dev/v2' },
      missingApiVersion,
      { ...candidateService(plan), kind: 'Revision' },
      missingKind,
      malformedAnnotations,
      nonPlainAnnotations,
      specOnlyTraffic,
      {
        service: CANDIDATE_SERVICE,
        traffic: structuredClone(plan.expectedCandidate.traffic),
      },
      {
        ...candidateService(plan, 'false'),
        service: CANDIDATE_SERVICE,
        traffic: structuredClone(plan.expectedCandidate.traffic),
        invokerIamDisabled: false,
      },
    ]) {
      assert.throws(() => validateCandidateControlPlaneReadbacks({ ...base, service }, plan), /readback/i);
    }
  });

  await t.test('candidate public bypass cannot reach the private IAM grant', async () => {
    let serviceDescribeCount = 0;
    let iamGrantMutations = 0;
    const result = await releaseRunner({
      argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
      input,
      loadReceipts: async (releasePlan) => receiptChain(releasePlan, 'evidence'),
      writeCandidateSpec: async () => true,
      execute: async (argv) => {
        if (argv[1] === 'services' && argv[2] === 'describe') {
          serviceDescribeCount += 1;
          if (serviceDescribeCount === 1) throw canonicalAbsence();
          return candidateService(plan, 'true');
        }
        if (argv[1] === 'services' && argv[2] === 'replace') {
          return argv.includes('--dry-run')
            ? structuredClone(plan.candidateServiceSpec) : candidateService(plan, 'true');
        }
        if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
        if (argv[0] === 'artifacts') return { image: plan.image };
        if (argv.includes('get-iam-policy')) return { bindings: [], etag: 'private', version: 1 };
        if (argv.includes('add-iam-policy-binding')) {
          iamGrantMutations += 1;
          return privateCandidateIam();
        }
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(iamGrantMutations, 0);
  });

  await t.test('candidate public bypass cannot reach stable promotion', async () => {
    let stableMutations = 0;
    const result = await releaseRunner({
      argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
      input,
      loadReceipts: async (releasePlan) => receiptChain(releasePlan, 'mobile'),
      writeStableSpec: async () => true,
      execute: async (argv) => {
        if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
        if (argv[0] === 'artifacts') return { image: argv.includes(plan.previousImage) ? plan.previousImage : plan.image };
        if (argv.includes('get-iam-policy')) return argv[3] === CANDIDATE_SERVICE
          ? privateCandidateIam() : publicStableIam();
        if (argv[1] === 'revisions') {
          if (argv[3] === plan.candidateRevision) return structuredClone(plan.expectedCandidate);
          if (argv[3] === plan.previousRevision) return { revision: plan.previousRevision, image: plan.previousImage };
          return structuredClone(plan.expectedStable);
        }
        if (argv[1] === 'services' && argv[2] === 'describe') {
          return argv[3] === CANDIDATE_SERVICE
            ? candidateService(plan, 'true')
            : stableService(plan, [{ revision: plan.previousRevision, tag: null, percent: 100 }]);
        }
        if (argv[1] === 'services' && argv[2] === 'replace') {
          if (argv.includes('--dry-run')) return structuredClone(plan.stableServiceSpec);
          stableMutations += 1;
          throw new Error('stable mutation must remain unreachable');
        }
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(stableMutations, 0);
  });
});

function cleanupCommandId(argv) {
  if (argv[1] === 'services' && argv[2] === 'describe') return 'service-describe';
  if (argv[1] === 'services' && argv[2] === 'delete') return 'service-delete';
  if (argv[1] === 'revisions') return 'revision-describe';
  if (argv[0] === 'artifacts') return 'artifact-describe';
  if (argv.includes('get-iam-policy')) return 'iam-readback';
  return argv.join(' ');
}

async function runCleanup({
  initiallyAbsent = false,
  deleteBehavior = 'null-absent',
  initialError = null,
  precheckNull = false,
  finalDescribeNull = false,
} = {}) {
  const input = releaseInput({ first: true });
  const plan = buildReleasePlan(input);
  let candidateExists = !initiallyAbsent;
  let describeCount = 0;
  const history = [];
  const result = await releaseRunner({
    argv: ['--phase=candidate-cleanup', `--confirm-release=${RELEASE_SHA}`],
    input,
    loadReceipts: async (releasePlan) => receiptChain(releasePlan, 'candidate'),
    execute: async (argv) => {
      history.push(cleanupCommandId(argv));
      if (argv[1] === 'services' && argv[2] === 'describe') {
        describeCount += 1;
        if (precheckNull && describeCount === 1) return null;
        if (finalDescribeNull && !candidateExists && describeCount > 1) return null;
        if (!candidateExists) throw initialError ?? canonicalAbsence();
        return candidateService(plan);
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[0] === 'artifacts') return { image: plan.image };
      if (argv.includes('get-iam-policy')) return privateCandidateIam();
      if (argv[1] === 'services' && argv[2] === 'delete') {
        if (deleteBehavior === 'null-present') return null;
        candidateExists = false;
        if (deleteBehavior === 'throw-absent') throw new Error('delete response lost');
        return null;
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  return { history, result };
}

test('candidate cleanup treats deletion as canonical absence and is receipt-bound idempotent', async (t) => {
  await t.test('normal null delete succeeds only after final exact absence', async () => {
    const { history, result } = await runCleanup();
    assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
    assert.deepEqual(history, [
      'service-describe', 'revision-describe', 'artifact-describe', 'iam-readback',
      'service-delete', 'service-describe',
    ]);
    assert.equal(result.publicReport.mutationPerformed, true);
  });

  await t.test('lost delete response requires immediate and final exact absence', async () => {
    const { history, result } = await runCleanup({ deleteBehavior: 'throw-absent' });
    assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
    assert.deepEqual(result.publicReport.responseLossRecoveries, ['candidate-cleanup-delete']);
    assert.deepEqual(history, [
      'service-describe', 'revision-describe', 'artifact-describe', 'iam-readback',
      'service-delete', 'service-describe', 'service-describe',
    ]);
  });

  await t.test('already absent rerun performs only initial and final exact absence reads', async () => {
    const { history, result } = await runCleanup({ initiallyAbsent: true });
    assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
    assert.deepEqual(history, ['service-describe', 'service-describe']);
    assert.deepEqual(result.publicReport.completed, [
      'candidate-cleanup-service-precheck', 'candidate-cleanup-absence-readback',
    ]);
    assert.equal(result.publicReport.candidateCleanupState, 'already-absent');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(result.publicReport.phaseReceipt.receiptType, 'action-outcome');
    assert.equal(result.publicReport.phaseReceipt.mutationCount, 1);
    assert.deepEqual(result.publicReport.phaseReceipt.operationOutcomes.map((outcome) => ({
      operationId: outcome.operationId,
      outcome: outcome.outcome,
      kind: outcome.safeResult.kind,
      state: outcome.safeResult.state,
    })), [{
      operationId: 'candidate-cleanup-delete',
      outcome: 'verified-noop',
      kind: 'resource',
      state: 'absent',
    }]);
  });

  await t.test('null delete with a still-present service fails closed', async () => {
    const { history, result } = await runCleanup({ deleteBehavior: 'null-present' });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.mutationPerformed, true);
    assert.equal(history.at(-1), 'service-describe');
  });

  await t.test('generic or ambiguous initial absence never becomes idempotent success', async () => {
    for (const code of ['NOT_FOUND', 'TRANSPORT_AMBIGUOUS']) {
      const { history, result } = await runCleanup({
        initiallyAbsent: true,
        initialError: Object.assign(new Error('ambiguous absence'), { code }),
      });
      assert.equal(result.exitCode, 1);
      assert.deepEqual(history, ['service-describe']);
      assert.equal(result.publicReport.mutationPerformed, false);
    }
  });

  await t.test('raw null precheck is not an absence witness', async () => {
    const { history, result } = await runCleanup({ precheckNull: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(history, ['service-describe']);
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(result.publicReport.resumeBoundary, 'candidate-cleanup-service-precheck');
  });

  await t.test('raw null final describe is not an absence witness after delete', async () => {
    const { history, result } = await runCleanup({ finalDescribeNull: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(history, [
      'service-describe', 'revision-describe', 'artifact-describe', 'iam-readback',
      'service-delete', 'service-describe',
    ]);
    assert.equal(result.publicReport.mutationPerformed, true);
    assert.equal(result.publicReport.resumeBoundary, 'candidate-cleanup-absence-readback');
  });

  await t.test('already-absent null final read points resume to the actual executed operation', async () => {
    const { history, result } = await runCleanup({ initiallyAbsent: true, finalDescribeNull: true });
    assert.equal(result.exitCode, 1);
    assert.deepEqual(history, ['service-describe', 'service-describe']);
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(result.publicReport.resumeBoundary, 'candidate-cleanup-absence-readback');
  });
});

const NETWORK = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
const REGION_LINK = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/${REGION}`;
const OTHER_REGION_LINK = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/us-central1`;
const SUBNETWORK = `${REGION_LINK}/subnetworks/${GCP_IDENTITY.subnet}`;
const OTHER_SUBNETWORK = `${OTHER_REGION_LINK}/subnetworks/foreign-subnet`;

function regionalAddressLink(name, region = REGION) {
  return `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/${region}/addresses/${name}`;
}

function globalAddressLink(name) {
  return `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${name}`;
}

function addressAudit(addresses, desired = '10.250.0.0/24') {
  return assertCidrAvailable({
    desired,
    network: NETWORK,
    networks: [{ name: GCP_IDENTITY.network, selfLink: NETWORK }],
    subnets: [{
      name: GCP_IDENTITY.subnet,
      selfLink: SUBNETWORK,
      network: NETWORK,
      region: REGION_LINK,
      ipCidrRange: '192.168.10.0/24',
      externalIpv6Prefix: '2001:db8:2::/64',
      ipv6AccessType: 'EXTERNAL',
      stackType: 'IPV4_IPV6',
      purpose: 'PRIVATE',
      ipv6GceEndpoint: 'VM_AND_FR',
    }],
    routes: [], addresses,
  });
}

const INTERNAL_ADDRESSES = Object.freeze([
  ['DNS_RESOLVER', {
    name: 'dns-resolver', purpose: 'DNS_RESOLVER', address: '192.168.10.1',
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', region: REGION_LINK, subnetwork: SUBNETWORK,
    selfLink: regionalAddressLink('dns-resolver'),
  }],
  ['GCE_ENDPOINT', {
    name: 'gce-endpoint', purpose: 'GCE_ENDPOINT', address: '192.168.10.2',
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'IN_USE', region: REGION_LINK, subnetwork: SUBNETWORK,
    selfLink: regionalAddressLink('gce-endpoint'),
  }],
  ['SHARED_LOADBALANCER_VIP', {
    name: 'shared-vip', purpose: 'SHARED_LOADBALANCER_VIP', address: '192.168.10.3',
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', region: REGION_LINK, subnetwork: SUBNETWORK,
    selfLink: regionalAddressLink('shared-vip'),
  }],
  ['IPSEC_INTERCONNECT', {
    name: 'ipsec-range', purpose: 'IPSEC_INTERCONNECT', address: '192.168.20.0', prefixLength: 24,
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'IN_USE', region: REGION_LINK, network: NETWORK,
    selfLink: regionalAddressLink('ipsec-range'),
  }],
  ['PRIVATE_SERVICE_CONNECT', {
    name: 'psc-endpoint', purpose: 'PRIVATE_SERVICE_CONNECT', address: '192.168.30.1',
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', network: NETWORK,
    selfLink: globalAddressLink('psc-endpoint'),
  }],
  ['SERVERLESS', {
    name: 'serverless-range', purpose: 'SERVERLESS', address: '192.168.40.0', prefixLength: 24,
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', region: REGION_LINK,
    selfLink: regionalAddressLink('serverless-range'),
  }],
  ['VPC_PEERING', {
    name: 'peering-range', purpose: 'VPC_PEERING', address: '192.168.50.0', prefixLength: 24,
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'IN_USE', network: NETWORK,
    selfLink: globalAddressLink('peering-range'),
  }],
]);

test('all seven INTERNAL Address purposes bind exact host project identity and scope', async (t) => {
  for (const [purpose, address] of INTERNAL_ADDRESSES) {
    await t.test(`accepts exact ${purpose}`, () => assert.doesNotThrow(() => addressAudit([address])));
  }

  const dns = INTERNAL_ADDRESSES[0][1];
  const serverless = INTERNAL_ADDRESSES[5][1];
  const psc = INTERNAL_ADDRESSES[4][1];
  const invalid = [
    ['missing selfLink', { ...dns, selfLink: undefined }],
    ['foreign project selfLink', {
      ...dns,
      selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/regions/${REGION}/addresses/${dns.name}`,
    }],
    ['wrong selfLink name', { ...dns, selfLink: regionalAddressLink('other-name') }],
    ['regional item with global selfLink', { ...dns, selfLink: globalAddressLink(dns.name) }],
    ['regional selfLink disagrees with item region', {
      ...dns, region: OTHER_REGION_LINK, selfLink: regionalAddressLink(dns.name),
      subnetwork: OTHER_SUBNETWORK,
    }],
    ['subnetwork region disagrees with address region', { ...dns, subnetwork: OTHER_SUBNETWORK }],
    ['SERVERLESS missing selfLink', { ...serverless, selfLink: undefined }],
    ['SERVERLESS foreign regional selfLink', {
      ...serverless,
      selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/regions/${REGION}/addresses/${serverless.name}`,
    }],
    ['global item with regional selfLink', { ...psc, selfLink: regionalAddressLink(psc.name) }],
    ['global item with contradictory region', { ...psc, region: REGION_LINK }],
  ];
  for (const [name, raw] of invalid) {
    const address = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    await t.test(`rejects ${name}`, () => assert.throws(
      () => addressAudit([address]),
      (error) => error.code === 'CIDR_AUDIT_INVALID',
    ));
  }
});

const EXTERNAL_ADDRESSES = Object.freeze([
  ['ordinary regional IPv4', {
    name: 'external-v4-regional', address: '198.51.100.10', ipVersion: 'IPV4',
    addressType: 'EXTERNAL', networkTier: 'STANDARD', status: 'RESERVED', region: REGION_LINK,
    selfLink: regionalAddressLink('external-v4-regional'),
  }],
  ['ordinary global IPv4', {
    name: 'external-v4-global', address: '203.0.113.9', ipVersion: 'IPV4',
    addressType: 'EXTERNAL', networkTier: 'PREMIUM', status: 'IN_USE',
    selfLink: globalAddressLink('external-v4-global'),
  }],
  ['ordinary global IPv6', {
    name: 'external-v6-global', address: '2001:db8:1::', ipVersion: 'IPV6',
    addressType: 'EXTERNAL', networkTier: 'PREMIUM', status: 'IN_USE',
    selfLink: globalAddressLink('external-v6-global'),
  }],
  ['regional IPv6 endpoint range', {
    name: 'external-v6-endpoint', address: '2001:db8:2::', prefixLength: 96,
    ipVersion: 'IPV6', ipv6EndpointType: 'VM', subnetwork: SUBNETWORK,
    addressType: 'EXTERNAL', networkTier: 'STANDARD', status: 'RESERVED', region: REGION_LINK,
    selfLink: regionalAddressLink('external-v6-endpoint'),
  }],
  ['regional Cloud NAT output', {
    name: 'external-nat-auto', purpose: 'NAT_AUTO', address: '192.0.2.20', ipVersion: 'IPV4',
    addressType: 'EXTERNAL', networkTier: 'STANDARD', status: 'IN_USE', region: REGION_LINK,
    selfLink: regionalAddressLink('external-nat-auto'),
  }],
]);

test('complete legal EXTERNAL inventory is validated before exclusion from IPv4 overlap math', async (t) => {
  for (const [name, address] of EXTERNAL_ADDRESSES) {
    await t.test(`accepts ${name}`, () => assert.doesNotThrow(() => addressAudit([address], '198.51.100.0/24')));
  }

  const regionalV4 = EXTERNAL_ADDRESSES[0][1];
  const globalV4 = EXTERNAL_ADDRESSES[1][1];
  const globalV6 = EXTERNAL_ADDRESSES[2][1];
  const endpointV6 = EXTERNAL_ADDRESSES[3][1];
  const natAuto = EXTERNAL_ADDRESSES[4][1];
  const invalid = [
    ['RESERVING status', { ...regionalV4, status: 'RESERVING' }],
    ['unknown status', { ...regionalV4, status: 'UNKNOWN' }],
    ['missing address', { ...regionalV4, address: undefined }],
    ['missing selfLink', { ...regionalV4, selfLink: undefined }],
    ['missing IP version', { ...regionalV4, ipVersion: undefined }],
    ['unknown purpose', { ...regionalV4, purpose: 'UNKNOWN' }],
    ['explicit null purpose', { ...regionalV4, purpose: null }],
    ['global NAT_AUTO', { ...natAuto, region: undefined, selfLink: globalAddressLink(natAuto.name) }],
    ['IPv4 reported as IPv6', { ...regionalV4, ipVersion: 'IPV6' }],
    ['IPv6 reported as IPv4', { ...globalV6, ipVersion: 'IPV4' }],
    ['noncanonical IPv4', { ...regionalV4, address: '198.051.100.10' }],
    ['noncanonical IPv6', { ...globalV6, address: '2001:0db8:0:0:0:0:0:1' }],
    ['selector-free regional IPv6', {
      ...globalV6,
      name: 'external-v6-regional',
      address: '2001:db8::1',
      region: REGION_LINK,
      selfLink: regionalAddressLink('external-v6-regional'),
    }],
    ['IPv6 endpoint subnetwork region mismatch', { ...endpointV6, subnetwork: OTHER_SUBNETWORK }],
    ['unknown IPv6 endpoint type', { ...endpointV6, ipv6EndpointType: 'UNKNOWN' }],
    ['IPv4 with IPv6 prefix length', { ...regionalV4, prefixLength: 96 }],
    ['IPv4 with IPv6 endpoint type', { ...regionalV4, ipv6EndpointType: 'VM' }],
    ['IPv4 with subnetwork selector', { ...regionalV4, subnetwork: SUBNETWORK }],
    ['global IPv6 with regional endpoint fields', {
      ...globalV4,
      address: '2001:db8:3::', ipVersion: 'IPV6', prefixLength: 96, ipv6EndpointType: 'NETLB',
    }],
    ['foreign project selfLink', {
      ...regionalV4,
      selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/regions/${REGION}/addresses/${regionalV4.name}`,
    }],
    ['regional mismatch', {
      ...regionalV4, region: OTHER_REGION_LINK, selfLink: regionalAddressLink(regionalV4.name),
    }],
    ['global row with region', { ...globalV4, region: REGION_LINK }],
  ];
  for (const [name, raw] of invalid) {
    const address = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    await t.test(`rejects ${name}`, () => assert.throws(
      () => addressAudit([address]),
      (error) => error.code === 'CIDR_AUDIT_INVALID',
    ));
  }
});

function section(document, start, end) {
  const startIndex = document.indexOf(start);
  assert.notEqual(startIndex, -1, `missing section start: ${start}`);
  const endIndex = end === null ? document.length : document.indexOf(end, startIndex + start.length);
  assert.notEqual(endIndex, -1, `missing section end: ${end}`);
  return document.slice(startIndex, endIndex);
}

test('authoritative identity, privacy, and Compute inventory blocks state the complete contract', async () => {
  const [readme, operator, sharedDesign, launchDesign, launchPlan, sharedPlan] = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../infra/gcp/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/specs/2026-08-26-production-v1-shared-project-isolation-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/plans/2026-08-26-production-v1-gcp-launch.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/plans/2026-08-26-production-v1-shared-project-isolation.md', import.meta.url), 'utf8'),
  ]);

  const identityBlocks = [
    section(readme, 'The production resource island is fixed', 'The default VPC'),
    section(operator, '### Exact provisioned identities', '## Commands'),
    section(sharedDesign, '## Exact resource island', '## Shared-project safety contract'),
    section(launchDesign, 'Binding resource identities:', '## IAM, secrets, and cost guard'),
    section(launchPlan, '**Step 5: Create the exact production resource island.**', '**Step 6: Read back every control'),
    section(sharedPlan, '**Interfaces:**', '- [ ] **Step 1: Write failing identity'),
    section(sharedPlan, 'export const GCP_IDENTITY = Object.freeze({', '});'),
  ];
  for (const block of identityBlocks) {
    assert.match(block, /hkbuddy-v1-api(?:`|'|\b)/);
    assert.match(block, /hkbuddy-v1-api-candidate/);
  }

  const computeBlock = section(operator, 'The project-wide CIDR', 'The billing account must report');
  assert.match(computeBlock, /Address `selfLink`/);
  assert.match(computeBlock, /ordinary.*EXTERNAL/i);
  assert.match(computeBlock, /IPv4.*IPv6|IPv6.*IPv4/);
  assert.match(computeBlock, /NAT_AUTO.*regional|regional.*NAT_AUTO/);
  assert.doesNotMatch(computeBlock, /regional rows bind the\s+exact `asia-east2` region/i);

  for (const document of [readme, operator, sharedDesign, launchDesign, launchPlan, sharedPlan]) {
    assert.match(document, /invoker-iam-disabled/);
    assert.match(document, /already-absent/);
  }
});
