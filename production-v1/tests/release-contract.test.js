import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { GCP_IDENTITY } from '../src/gcp-identity.js';
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
  LATENCY_ACCEPTANCE_CONTRACT,
  finalizeLatencyAcceptanceRecord,
} from '../scripts/production-latency-workload.js';
import {
  buildReleasePlan,
  containsForbiddenPersistedSecret,
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
  validateMigrationExecutionReceipt,
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
const QA_SUBJECT_SHA256 = createHash('sha256').update('admin@motionexp.com').digest('hex');
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

function validWorkloadAcceptanceRecord() {
  const queryDigests = Array.from({ length: 20 }, (_, index) => (
    createHash('sha256').update(`query-${index}`).digest('hex')
  )).sort();
  const uuid = (group, ordinal) => (
    `00000000-0000-4000-8${group.toString(16).padStart(3, '0')}-${String(ordinal).padStart(12, '0')}`
  );
  const textTurns = Array.from({ length: 200 }, (_, index) => {
    const sessionIndex = Math.floor(index / 10);
    const turnIndex = index % 10;
    const promptClass = turnIndex < 4 ? 'grounded' : (turnIndex < 7 ? 'abstention' : 'casual');
    const correlationId = uuid(1, index + 1);
    return {
      sequence: index + 1,
      sessionIndex,
      turnIndex,
      sessionIdSha256: createHash('sha256').update(`session-${sessionIndex}`).digest('hex'),
      clientMessageId: uuid(2, index + 1),
      correlationId,
      traceId: createHash('sha256').update(`trace-${index + 1}`).digest('hex').slice(0, 32),
      controlledTtsFailure: turnIndex === 1 && sessionIndex === 10,
      promptClass,
      replyLanguage: ['en', 'yue-Hant-HK', 'cmn-Hans-CN'][index % 3],
      replyMode: turnIndex === 0 || (turnIndex === 1 && sessionIndex < 11) ? 'voice' : 'text',
      acknowledged: true,
      ackMs: 200,
      processingVisible: true,
      processingVisibleMs: 400,
      delivered: true,
      finalAnswerMs: 2_400,
      messageLost: false,
      duplicateAssistantReplyCount: 0,
      unsupportedVerifiedClaimCount: 0,
      assistantMessageId: `assistant-${sessionIndex}-${turnIndex}`,
      requestStatus: 202,
      requestId: uuid(3, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(4, index + 1),
      groundingSatisfied: true,
      groundingVerified: promptClass === 'grounded',
      groundingEvidenceSha256: createHash('sha256').update(`grounding-${index + 1}`).digest('hex'),
    };
  });
  const asrRequests = Array.from({ length: 30 }, (_, index) => {
    const durationBucketSeconds = [10, 30, 55][Math.floor(index / 10)];
    const language = ['cantonese', 'english', 'mandarin'][index % 3];
    const bindingId = uuid(5, index + 1);
    return {
      sequence: index + 1,
      sessionIndex: index % 20,
      sampleIndex: index,
      fixtureId: `${language}-${durationBucketSeconds}-${index + 1}`,
      fixtureSha256: createHash('sha256').update(`fixture-${index + 1}`).digest('hex'),
      language,
      wireLanguage: { cantonese: 'yue-Hant-HK', english: 'en', mandarin: 'cmn-Hans-CN' }[language],
      clientUploadId: bindingId,
      ready: true,
      correlationId: uuid(6, index + 1),
      bindingId,
      durationMs: durationBucketSeconds * 1_000,
      durationBucketSeconds,
      requestStatus: 202,
      requestId: uuid(7, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(8, index + 1),
    };
  });
  const voiceSources = [
    ...Array.from({ length: 20 }, (_, sessionIndex) => textTurns[sessionIndex * 10]),
    ...Array.from({ length: 11 }, (_, sessionIndex) => textTurns[sessionIndex * 10 + 1]),
  ];
  const ttsRequests = voiceSources.map((source, index) => {
    const failure = index === 30;
    return {
      sequence: index + 1,
      requestIndex: index,
      sessionIndex: source.sessionIndex,
      sourceTurnIndex: source.turnIndex,
      ready: !failure,
      correlationId: source.correlationId,
      bindingId: source.assistantMessageId,
      durationMs: null,
      expectedProviderFailure: failure,
      providerFailureObserved: failure,
      failureCode: failure ? 'VOICE_SYNTHESIS_REJECTED' : null,
      textAvailable: true,
      mediaValidated: !failure,
      messageIdMatches: true,
      requestStatus: 200,
      requestId: uuid(9, index + 1),
      responseStatus: 200,
      responseRequestId: uuid(10, index + 1),
    };
  });
  const samplesBySession = Array.from({ length: 20 }, () => []);
  for (const item of textTurns) {
    samplesBySession[item.sessionIndex].push({
      correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null,
      operation: 'text', layer: 'server', latencyMs: 2_300, outcome: 'success', failureCode: null,
    });
    if (item.promptClass === 'grounded') samplesBySession[item.sessionIndex].push({
      correlationId: item.correlationId, bindingId: item.assistantMessageId, durationMs: null,
      operation: 'text', layer: 'provider', latencyMs: 1_800, outcome: 'success', failureCode: null,
    });
  }
  for (const item of asrRequests) {
    for (const [layer, latencyMs] of [['provider', 1_800], ['server', item.durationBucketSeconds === 10 ? 2_000 : 5_000]]) {
      samplesBySession[item.sessionIndex].push({
        correlationId: item.correlationId, bindingId: item.bindingId, durationMs: item.durationMs,
        operation: 'asr', layer, latencyMs, outcome: 'success', failureCode: null,
      });
    }
  }
  for (const item of ttsRequests) {
    for (const [layer, latencyMs] of [['provider', 1_700], ['server', 1_900]]) {
      samplesBySession[item.sessionIndex].push({
        correlationId: item.correlationId, bindingId: item.bindingId, durationMs: null,
        operation: 'tts', layer, latencyMs,
        outcome: item.expectedProviderFailure ? 'failure' : 'success',
        failureCode: item.expectedProviderFailure ? 'VOICE_SYNTHESIS_REJECTED' : null,
      });
    }
  }
  const timingQueries = Array.from({ length: 20 }, (_, index) => ({
    sequence: index + 1, sessionIndex: index, queryDigest: queryDigests[index], samples: samplesBySession[index],
  }));
  const controlPlaneRequests = textTurns.map((item, index) => ({
    sequence: index + 1,
    insertId: `request-${String(index + 1).padStart(3, '0')}`,
    latencyMs: 200,
    status: 202,
    timestamp: new Date(Date.parse('2026-08-26T08:00:00.000Z') + index).toISOString(),
    trace: `projects/${PROJECT}/traces/${item.traceId}`,
  }));
  const rawPayload = {
    schemaVersion: 1,
    acceptanceWindowId: createHash('sha256').update('acceptance-window').digest('hex'),
    textTurns,
    asrRequests,
    ttsRequests,
    timingQueries,
    controlPlaneRequests,
  };
  const rawReceipts = {
    ...rawPayload,
    receiptsSha256: createHash('sha256').update(JSON.stringify(canonicalFixture(rawPayload))).digest('hex'),
  };
  return finalizeLatencyAcceptanceRecord({
    schemaVersion: 4,
    commitSha: RELEASE_SHA,
    candidateOrigin: CANDIDATE_ORIGIN,
    access: {
      authenticated: true,
      audience: STABLE_ORIGIN,
      issuer: 'https://accounts.google.com',
      subjectSha256: QA_SUBJECT_SHA256,
      taggedUrl: CANDIDATE_ORIGIN,
    },
    releaseBinding: {
      project: PROJECT,
      region: REGION,
      service: 'hkbuddy-api',
      releaseSha: RELEASE_SHA,
      sourceArchiveSha256: SOURCE_SHA,
      imageDigest: IMAGE_DIGEST,
      candidateRevision: REVISION,
      candidateTag: CANDIDATE_TAG,
      serviceOrigin: STABLE_ORIGIN,
      candidateOrigin: CANDIDATE_ORIGIN,
      trafficPercent: 0,
    },
    fixtureSetSha256: 'd'.repeat(64),
    workload: LATENCY_ACCEPTANCE_CONTRACT,
    counts: {
      sessionsCreated: 20,
      textTurnsAttempted: 200,
      textTurnsAcknowledged: 200,
      textTurnsDelivered: 200,
      asrRequestsAttempted: 30,
      asrReady: 30,
      ttsRequestsAttempted: 31,
      ttsReady: 30,
      ttsControlledProviderFailures: 1,
    },
    metrics: {
      sendAck: { sampleCount: 200, p95Ms: 200, p95ThresholdMs: 300, pass: true },
      processingVisible: { sampleCount: 200, p95Ms: 400, p95ThresholdMs: 500, pass: true },
      groundedResponse: {
        sampleCount: 80, p50Ms: 2_400, p50ThresholdMs: 2_500,
        p95Ms: 2_400, p95ThresholdMs: 6_000, pass: true,
      },
      asr10: {
        sampleCount: 10, p50Ms: 2_000, p50ThresholdMs: 2_500,
        p95Ms: 2_000, p95ThresholdMs: 4_000, pass: true,
      },
      asr30: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
      asr55: { sampleCount: 10, p95Ms: 5_000, p95ThresholdMs: 6_000, pass: true },
      ttsReady: {
        sampleCount: 30, p50Ms: 1_900, p50ThresholdMs: 2_500,
        p95Ms: 1_900, p95ThresholdMs: 5_000, pass: true,
      },
    },
    invariants: {
      acknowledgedMessageLossCount: 0,
      duplicateAssistantReplyCount: 0,
      unsupportedVerifiedClaimCount: 0,
      ttsFailureTextLossCount: 0,
      ttsMediaValidationFailureCount: 0,
      ttsMessageBindingMismatchCount: 0,
      controlledTtsProviderFailureMismatchCount: 0,
    },
    observations: {
      releaseCommitSha: RELEASE_SHA,
      queryDigests: { sampleCount: 20, values: queryDigests, pass: true },
      provider: {
        text: { available: true, sampleCount: 80, p50Ms: 1_800, p95Ms: 1_800 },
        asr: { available: true, sampleCount: 30, p50Ms: 1_800, p95Ms: 1_800 },
        tts: { available: true, sampleCount: 30, p50Ms: 1_700, p95Ms: 1_700 },
      },
      server: {
        text: { available: true, sampleCount: 200, p50Ms: 2_300, p95Ms: 2_300 },
        asr: { available: true, sampleCount: 30, p50Ms: 5_000, p95Ms: 5_000 },
        tts: { available: true, sampleCount: 30, p50Ms: 1_900, p95Ms: 1_900 },
      },
      pairs: {
        text: {
          available: true, expectedServerCount: 200, serverBoundCount: 200,
          expectedProviderCount: 80, providerPairedCount: 80,
        },
        asr: { available: true, expectedCount: 30, pairedCount: 30 },
        tts: {
          available: true, expectedSuccessCount: 30, successPairedCount: 30,
          expectedFailureCount: 1, failurePairedCount: 1,
        },
      },
    },
    rawReceipts,
    occurredAt: '2026-08-26T08:00:00.000Z',
    result: true,
  });
}

function controlPlaneLogEntries(record) {
  return record.rawReceipts.controlPlaneRequests.map((entry) => ({
    insertId: entry.insertId,
    timestamp: entry.timestamp,
    trace: entry.trace,
    resource: {
      type: 'cloud_run_revision',
      labels: {
        project_id: PROJECT, location: REGION, service_name: 'hkbuddy-api',
        revision_name: REVISION,
      },
    },
    httpRequest: {
      requestMethod: 'POST', requestUrl: `${CANDIDATE_ORIGIN}/api/v1/messages`,
      status: 202, latency: `${entry.latencyMs / 1_000}s`,
      userAgent: `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`,
    },
  }));
}

async function exerciseControlledWorkloadNetwork(fetchImpl, record) {
  const invoke = (path, method = 'GET', headers = {}) => fetchImpl(
    new URL(path, CANDIDATE_ORIGIN), { method, headers: {
      ...headers,
      Authorization: `Bearer ${'a'.repeat(80)}`,
      'User-Agent': `hkbuddy-v1-acceptance/${record.rawReceipts.acceptanceWindowId}`,
    } },
  );
  for (let index = 0; index < 21; index += 1) await invoke('/api/v1/session', 'POST');
  for (let index = 0; index < 200; index += 1) {
    await invoke('/api/v1/messages', 'POST', {
      'X-Acceptance-Correlation-Id': record.rawReceipts.textTurns[index].correlationId,
    });
  }
  for (let index = 0; index < 231; index += 1) await invoke('/api/v1/messages?after=0');
  for (let index = 0; index < 30; index += 1) {
    await invoke('/api/v1/voice/transcriptions', 'POST', {
      'X-Client-Upload-Id': record.rawReceipts.asrRequests[index].bindingId,
    });
  }
  for (let index = 0; index < 20; index += 1) {
    await invoke(`/api/v1/acceptance/timings?windowId=${record.rawReceipts.acceptanceWindowId}`);
  }
  for (const item of record.rawReceipts.ttsRequests) {
    await invoke(`/api/v1/messages/${item.bindingId}/audio/status`);
  }
  for (let index = 0; index < 30; index += 1) {
    const path = `/api/v1/media/media-${String(index).padStart(2, '0')}`;
    await invoke(path, 'HEAD');
    await invoke(path, 'GET', { Range: 'bytes=0-3' });
    await invoke(path);
  }
}

function realV1JobReadback(expected) {
  const environment = Object.entries(expected.environment).map(([name, value]) => ({ name, value }));
  const secretEnvironment = Object.entries(expected.secretEnvironment).map(([name, value]) => ({
    name,
    valueFrom: { secretKeyRef: { name: value.secret, key: value.version } },
  }));
  const secretMounts = Object.entries(expected.secretMounts);
  return {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Job',
    metadata: { name: expected.job, labels: structuredClone(expected.labels) },
    spec: {
      template: {
        metadata: {
          annotations: {
            'run.googleapis.com/network-interfaces': JSON.stringify([{
              network: expected.network, subnetwork: expected.subnet,
            }]),
            'run.googleapis.com/vpc-access-egress': expected.vpcEgress,
          },
        },
        spec: {
          taskCount: expected.taskCount,
          parallelism: expected.parallelism,
          template: {
            spec: {
              serviceAccountName: expected.serviceAccount,
              maxRetries: expected.maxRetries,
              timeoutSeconds: `${expected.timeoutSeconds}s`,
              containers: [{
                image: expected.image,
                command: structuredClone(expected.command),
                args: structuredClone(expected.args),
                env: [...environment, ...secretEnvironment],
                volumeMounts: secretMounts.map(([name, mount]) => ({
                  name,
                  mountPath: mount.path.slice(0, mount.path.lastIndexOf('/')),
                  readOnly: true,
                })),
              }],
              volumes: secretMounts.map(([name, mount]) => ({
                name,
                secret: {
                  secretName: mount.secret,
                  items: [{
                    key: mount.version,
                    path: mount.path.slice(mount.path.lastIndexOf('/') + 1),
                  }],
                },
              })),
            },
          },
        },
      },
    },
  };
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
    executionName: 'hkbuddy-migrate-release-001',
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
    access: structuredClone(plan.candidateAccess),
    candidateContractSha256: createHash('sha256')
      .update(JSON.stringify(canonicalFixture(plan.expectedCandidate))).digest('hex'),
    imageDigest: plan.imageDigest,
    origin: plan.candidateOrigin,
    publicInvoker: false,
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
  assert.equal(ids.filter((id) => id.startsWith('candidate-')).every((id) => (
    !plan.operations.find((operation) => operation.id === id).argv.includes('--member=allUsers')
  )), true);
  assert.equal(ids.includes('promote-authority-readback'), true);
  assert.equal(ids.indexOf('promote-public-service') < ids.indexOf('promote-traffic'), true);
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
  assert.equal(typeof serviceSpec.spec.template.spec.timeoutSeconds, 'number');
  assert.equal(serviceSpec.spec.template.spec.timeoutSeconds, 60);
  const mountPaths = serviceSpec.spec.template.spec.containers[0].volumeMounts
    .map(({ mountPath }) => mountPath);
  assert.equal(new Set(mountPaths).size, mountPaths.length,
    'Cloud Run v1 rejects multiple secret volumes mounted at one directory');
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

  assert.deepEqual(plan.candidateAccess, {
    authenticated: true,
    audience: STABLE_ORIGIN,
    issuer: 'https://accounts.google.com',
    subjectSha256: QA_SUBJECT_SHA256,
    taggedUrl: CANDIDATE_ORIGIN,
  });
  const publicAuth = plan.operations.find(({ id }) => id === 'promote-public-service');
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

test('candidate deploy is fenced by the canonical gcloud Service v1 dry-run result', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`],
    input,
    writeCandidateSpec: async () => true,
    execute: async (argv) => {
      calls.push(argv);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return {
          service: 'hkbuddy-api',
          traffic: [{ revision: input.previousRevision, percent: 100 }],
        };
      }
      if (argv.includes('--dry-run')) {
        const drift = structuredClone(plan.candidateServiceSpec);
        drift.spec.template.spec.timeoutSeconds = 61;
        return drift;
      }
      throw new Error('candidate deploy must remain inert after dry-run drift');
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(calls.some((argv) => (
    argv[0] === 'run' && argv[1] === 'services' && argv[2] === 'replace'
    && !argv.includes('--dry-run')
  )), false);
});

test('candidate phase feeds raw Service JSON through gcloud 553-compatible secret-mount semantics', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-candidate-service-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const input = releaseInput({ sourceArchive: join(directory, 'source.tar.gz') });
  const plan = buildReleasePlan(input);
  let describeCount = 0;
  const dryRun = (service) => {
    const revisionSpec = service?.spec?.template?.spec;
    const container = revisionSpec?.containers?.[0];
    if (!Number.isInteger(revisionSpec?.timeoutSeconds)) throw new Error('invalid v1 timeout');
    const paths = container?.volumeMounts?.map(({ mountPath }) => mountPath) ?? [];
    if (paths.length !== new Set(paths).size) throw new Error('duplicate v1 mount path');
    const envValues = new Set((container?.env ?? []).map(({ value }) => value).filter(Boolean));
    for (const mount of container?.volumeMounts ?? []) {
      const volume = revisionSpec.volumes.find(({ name }) => name === mount.name);
      const itemPath = volume?.secret?.items?.[0]?.path;
      if (!itemPath || !envValues.has(`${mount.mountPath}/${itemPath}`)) {
        throw new Error('secret file environment path is not volume-bound');
      }
    }
    return service;
  };
  const result = await runGcpRelease({
    argv: ['--phase=candidate', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      if (argv[1] === 'services' && argv[2] === 'replace') {
        const raw = JSON.parse(await readFile(argv[3], 'utf8'));
        return dryRun(raw);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        describeCount += 1;
        return describeCount === 1 ? {
          service: 'hkbuddy-api', traffic: [{ revision: input.previousRevision, percent: 100 }],
        } : {
          service: 'hkbuddy-api', traffic: [
            { revision: input.previousRevision, percent: 100 },
            { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
          ],
        };
      }
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv.includes('get-iam-policy')) return {
        bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
      };
      if (argv[0] === 'artifacts') return { image: plan.expectedCandidate.image };
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  const invalid = structuredClone(plan.candidateServiceSpec);
  invalid.spec.template.spec.containers[0].volumeMounts[1].mountPath
    = invalid.spec.template.spec.containers[0].volumeMounts[0].mountPath;
  assert.throws(() => dryRun(invalid), /duplicate v1 mount path/);
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
  assert.match(dependencySecrets, /\/var\/run\/secrets\/hkbuddy\/legacy-inventory\/legacy-inventory\.json=hkbuddy-legacy-inventory:11/);

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

test('dependency acceptance accepts the real v1 directory mount plus secret item filename', () => {
  const plan = buildReleasePlan(
    releaseInput({ acceptanceOutputs: null, evidence: null, previousRevision: null }),
    { phase: 'acceptance' },
  );
  const expected = plan.expectedJobs['dependency-acceptance'];
  const readback = realV1JobReadback(expected);
  assert.equal(validateReleaseJobReadback(readback, expected), true);

  for (const mutate of [
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.secretName = 'wrong-secret'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items[0].key = 'latest'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items[0].path = 'wrong.json'; },
    (value) => { value.spec.template.spec.template.spec.volumes[0].secret.items.push({ key: '11', path: 'extra.json' }); },
  ]) {
    const drift = structuredClone(readback);
    mutate(drift);
    assert.throws(() => validateReleaseJobReadback(drift, expected), /Job readback/i);
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

test('candidate readback requires private authenticated tagged QA and the exact immutable revision', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.expectedCandidate;
  assert.equal(validateCandidateReadback(structuredClone(candidate), plan), true);
  for (const mutate of [
    (value) => { value.image = value.image.replace('@sha256:', ':latest'); },
    (value) => { value.probes.startup.path = '/api/health/live'; },
    (value) => { value.traffic[0].percent = 100; },
    (value) => { value.iam.publicInvoker = true; },
    (value) => { value.access.audience = value.access.taggedUrl; },
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
    iam: {
      bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
      etag: 'Bw-candidate=',
      version: 1,
    },
    artifact: { image: plan.expectedCandidate.image },
  };
  assert.equal(validateCandidateControlPlaneReadbacks(structuredClone(readbacks), plan), true);
  const publicDrift = structuredClone(readbacks);
  publicDrift.iam.bindings[0].members.push('allUsers');
  assert.throws(() => validateCandidateControlPlaneReadbacks(publicDrift, plan), /IAM readback/i);
  const drift = structuredClone(readbacks);
  drift.revision.probes.startup.path = '/api/health/live';
  assert.throws(() => validateCandidateControlPlaneReadbacks(drift, plan), /revision readback/i);

  const createExecutor = ({ artifact = readbacks.artifact } = {}) => {
    let serviceDescribeCount = 0;
    return async (argv) => {
    if (argv[0] === 'artifacts') return structuredClone(artifact);
    if (argv.includes('--dry-run')) return structuredClone(plan.candidateServiceSpec);
    if (argv.includes('get-iam-policy')) return structuredClone(readbacks.iam);
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
      return { service: 'hkbuddy-api', traffic: [{ revision: input.previousRevision, percent: 100 }] };
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

test('rollback removes the candidate tag before restoring the prior revision', () => {
  const plan = buildReleasePlan(releaseInput());
  const rollback = plan.operations.find(({ id }) => id === 'rollback-traffic');
  assert.equal(rollback.argv.includes(`--remove-tags=${CANDIDATE_TAG}`), true);
  assert.equal(rollback.argv.includes('--to-revisions=hkbuddy-api-stable123456=100'), true);
});

test('rollback rejects a zero-percent candidate tag that remains reachable', async () => {
  const input = releaseInput();
  const staleTaggedService = {
    service: 'hkbuddy-api',
    traffic: [
      { revision: input.previousRevision, percent: 100 },
      { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
    ],
  };
  const result = await runGcpRelease({
    argv: ['--phase=rollback', `--confirm-release=${RELEASE_SHA}`],
    input,
    execute: async () => structuredClone(staleTaggedService),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
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
    iam: {
      bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
      etag: 'Bw-private=',
      version: 1,
    },
    artifact: { image: plan.expectedCandidate.image },
  };
  let promoted = false;
  let promotedReadbackCount = 0;
  let publicGranted = false;
  const accepted = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return structuredClone(candidateReadbacks.artifact);
      if (argv.includes('get-iam-policy')) return publicGranted ? {
        bindings: [{
          role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
        }],
        etag: 'Bw-public=',
        version: 1,
      } : structuredClone(candidateReadbacks.iam);
      if (argv.includes('add-iam-policy-binding')) {
        publicGranted = true;
        return {
          bindings: [{
            role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
          }],
          etag: 'Bw-public=',
          version: 1,
        };
      }
      if (argv[1] === 'revisions') return structuredClone(candidateReadbacks.revision);
      if (argv.includes('update-traffic')) promoted = true;
      if (argv[1] === 'services' && argv[2] === 'describe' && !promoted) {
        return structuredClone(candidateReadbacks.service);
      }
      if (argv[1] === 'services' && argv[2] === 'describe' && promoted) promotedReadbackCount += 1;
      return { service: 'hkbuddy-api', traffic: [{ revision: REVISION, percent: 100 }] };
    },
    writeOutput: () => undefined,
  });
  assert.equal(accepted.exitCode, 0);
  assert.equal(promotedReadbackCount, 1, 'promotion requires one fresh tag-free service readback');

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
    bindings: [{ role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'] }],
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

test('promotion restores the exact private IAM snapshot when the public grant lands but its call fails', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const privatePolicy = {
    bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
    etag: 'Bw-private=',
    version: 1,
  };
  const publicPolicy = {
    bindings: [{
      role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
    }],
    etag: 'Bw-public=',
    version: 1,
  };
  let currentPolicy = structuredClone(privatePolicy);
  let restorePolicy = null;
  let restorePolicyPath = null;
  let restorePolicyRemoved = false;
  const attemptId = '11111111-1111-4111-8111-111111111111';
  const calls = [];
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
    input,
    randomUUID: () => attemptId,
    writeIamRestorePolicy: async (releasePlan, policy, options) => {
      assert.equal(options.attemptId, attemptId);
      restorePolicy = structuredClone(policy);
      restorePolicyPath = join(
        dirname(releasePlan.sourceArchive),
        `${releasePlan.candidateRevision}.iam-restore.${attemptId}.json`,
      );
      return restorePolicyPath;
    },
    removeIamRestorePolicy: async (releasePlan, filePath) => {
      assert.equal(releasePlan.candidateRevision, plan.candidateRevision);
      assert.equal(filePath, restorePolicyPath);
      restorePolicyRemoved = true;
      return true;
    },
    execute: async (argv) => {
      calls.push(argv);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return { image: plan.expectedCandidate.image };
      if (argv.includes('get-iam-policy')) return structuredClone(currentPolicy);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[1] === 'services' && argv[2] === 'describe') {
        return {
          service: 'hkbuddy-api',
          traffic: [{ revision: REVISION, tag: CANDIDATE_TAG, percent: 0 }],
        };
      }
      if (argv.includes('add-iam-policy-binding')) {
        currentPolicy = structuredClone(publicPolicy);
        throw new Error('response lost after server-side IAM mutation');
      }
      if (argv.includes('set-iam-policy')) {
        assert.equal(restorePolicy.etag, publicPolicy.etag);
        assert.deepEqual(restorePolicy.bindings, privatePolicy.bindings);
        currentPolicy = { ...structuredClone(privatePolicy), etag: 'Bw-restored=' };
        return structuredClone(currentPolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.equal(result.publicReport.promotionIamRestored, true);
  assert.equal(restorePolicyRemoved, true);
  assert.deepEqual(currentPolicy.bindings, privatePolicy.bindings);
  const addIndex = calls.findIndex((argv) => argv.includes('add-iam-policy-binding'));
  const setIndex = calls.findIndex((argv) => argv.includes('set-iam-policy'));
  const finalReadIndex = calls.findLastIndex((argv) => argv.includes('get-iam-policy'));
  assert.equal(addIndex >= 0 && addIndex < setIndex && setIndex < finalReadIndex, true);
});

test('ambiguous promotion traffic is compensated before IAM and repeated retries leave no restore artifact', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const restorePaths = new Set();
  const attemptedIds = [
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
  ];

  for (const [attemptIndex, mutationLands] of [false, true].entries()) {
    const calls = [];
    const privatePolicy = {
      bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
      etag: `Bw-private-${attemptIndex}=`,
      version: 1,
    };
    let currentPolicy = structuredClone(privatePolicy);
    let currentService = {
      service: 'hkbuddy-api',
      traffic: [
        { revision: input.previousRevision, percent: 100 },
        { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
      ],
    };
    let restorePolicy = null;
    let restorePath = null;
    let residue = false;
    const result = await runGcpRelease({
      argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`],
      input,
      randomUUID: () => attemptedIds[attemptIndex],
      writeIamRestorePolicy: async (releasePlan, policy, { attemptId }) => {
        restorePolicy = structuredClone(policy);
        restorePath = join(
          dirname(releasePlan.sourceArchive),
          `${releasePlan.candidateRevision}.iam-restore.${attemptId}.json`,
        );
        assert.equal(restorePaths.has(restorePath), false);
        restorePaths.add(restorePath);
        residue = true;
        return restorePath;
      },
      removeIamRestorePolicy: async (_releasePlan, filePath) => {
        assert.equal(filePath, restorePath);
        residue = false;
        return true;
      },
      execute: async (argv) => {
        calls.push(argv);
        if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
        if (argv[0] === 'artifacts') return { image: plan.expectedCandidate.image };
        if (argv.includes('get-iam-policy')) return structuredClone(currentPolicy);
        if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
        if (argv[1] === 'services' && argv[2] === 'describe') return structuredClone(currentService);
        if (argv.includes('add-iam-policy-binding')) {
          currentPolicy = {
            bindings: [{
              role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
            }],
            etag: `Bw-public-${attemptIndex}=`,
            version: 1,
          };
          return structuredClone(currentPolicy);
        }
        if (argv.includes('update-traffic') && argv.includes(`--to-revisions=${REVISION}=100`)) {
          if (mutationLands) currentService = {
            service: 'hkbuddy-api', traffic: [{ revision: REVISION, percent: 100 }],
          };
          throw new Error('promotion traffic response was lost');
        }
        if (argv.includes('update-traffic')
          && argv.includes(`--to-revisions=${input.previousRevision}=100`)) {
          currentService = {
            service: 'hkbuddy-api', traffic: [{ revision: input.previousRevision, percent: 100 }],
          };
          return structuredClone(currentService);
        }
        if (argv.includes('set-iam-policy')) {
          assert.equal(argv.includes(restorePath), true);
          assert.equal(restorePolicy.etag, currentPolicy.etag);
          currentPolicy = { ...structuredClone(privatePolicy), etag: `Bw-restored-${attemptIndex}=` };
          return structuredClone(currentPolicy);
        }
        throw new Error(`unexpected operation: ${argv.join(' ')}`);
      },
      writeOutput: () => undefined,
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'RELEASE_PHASE_FAILED', JSON.stringify(result.publicReport));
    assert.equal(result.publicReport.promotionTrafficRestored, true);
    assert.equal(result.publicReport.promotionIamRestored, true);
    assert.equal(residue, false);
    assert.deepEqual(currentService.traffic, [{ revision: input.previousRevision, percent: 100 }]);
    assert.deepEqual(currentPolicy.bindings, privatePolicy.bindings);
    const trafficRestore = calls.findIndex((argv) => (
      argv.includes('update-traffic') && argv.includes(`--to-revisions=${input.previousRevision}=100`)
    ));
    const iamRestore = calls.findIndex((argv) => argv.includes('set-iam-policy'));
    assert.equal(trafficRestore >= 0 && trafficRestore < iamRestore, true);
  }
  assert.equal(restorePaths.size, 2);
});

test('a failed traffic compensation is explicit and blocks the promotion result', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const privatePolicy = {
    bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
    etag: 'Bw-private=', version: 1,
  };
  let currentPolicy = structuredClone(privatePolicy);
  const candidateService = {
    service: 'hkbuddy-api',
    traffic: [
      { revision: input.previousRevision, percent: 100 },
      { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
    ],
  };
  const attemptId = '44444444-4444-4444-8444-444444444444';
  const restorePath = join(
    dirname(plan.sourceArchive), `${REVISION}.iam-restore.${attemptId}.json`,
  );
  const result = await runGcpRelease({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    randomUUID: () => attemptId,
    writeIamRestorePolicy: async () => restorePath,
    removeIamRestorePolicy: async () => true,
    execute: async (argv) => {
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return { image: plan.expectedCandidate.image };
      if (argv.includes('get-iam-policy')) return structuredClone(currentPolicy);
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv[1] === 'services' && argv[2] === 'describe') return structuredClone(candidateService);
      if (argv.includes('add-iam-policy-binding')) {
        currentPolicy = {
          bindings: [{
            role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
          }],
          etag: 'Bw-public=', version: 1,
        };
        return structuredClone(currentPolicy);
      }
      if (argv.includes('update-traffic')) throw new Error('traffic control plane unavailable');
      if (argv.includes('set-iam-policy')) {
        currentPolicy = { ...structuredClone(privatePolicy), etag: 'Bw-restored=' };
        return structuredClone(currentPolicy);
      }
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'PROMOTION_COMPENSATION_FAILED');
  assert.equal(result.publicReport.promotionTrafficRestored, false);
  assert.equal(result.publicReport.promotionIamRestored, true);
  assert.deepEqual(currentPolicy.bindings, privatePolicy.bindings);
});

test('candidate deployment uses a controlled Service YAML and never the unsupported deploy readiness flag', () => {
  const plan = buildReleasePlan(releaseInput());
  const candidate = plan.operations.find(({ id }) => id === 'candidate-deploy');
  assert.deepEqual(candidate.argv.slice(0, 3), ['run', 'services', 'replace']);
  assert.equal(candidate.argv.some((value) => value.startsWith('--readiness-probe=')), false);
  assert.equal(candidate.argv.some((value) => value === 'deploy'), false);

  const publicPreview = plan.operations.find(({ id }) => id === 'candidate-public-service');
  assert.equal(publicPreview, undefined);
  assert.equal(plan.operations.some(({ phase, argv }) => (
    ['candidate', 'candidate-cleanup'].includes(phase) && argv.includes('--member=allUsers')
  )), false);
  assert.equal(plan.operations.some(({ id }) => id === 'promote-public-service'), true);
  assert.equal(plan.operations.some(({ id }) => id === 'candidate-cleanup-public-service'), false);
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

test('release evidence recursively rejects persisted authorization and token material', () => {
  for (const value of [
    { trace: { request: { headers: { Authorization: 'redacted' } } } },
    { screenshot: { metadata: { note: `Bearer ${'x'.repeat(40)}` } } },
    { events: [{ evidence: `eyJ${'a'.repeat(12)}.eyJ${'b'.repeat(12)}.${'c'.repeat(20)}` }] },
    { nested: [{ id_token: 'redacted' }] },
  ]) assert.equal(containsForbiddenPersistedSecret(value), true);

  assert.equal(containsForbiddenPersistedSecret({
    access: {
      authenticated: true,
      audience: STABLE_ORIGIN,
      issuer: 'https://accounts.google.com',
      subjectSha256: QA_SUBJECT_SHA256,
      taggedUrl: CANDIDATE_ORIGIN,
    },
    evidence: 'Authenticated request returned the expected candidate release binding.',
  }), false);
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

test('migration execution accepts the real Cloud Run Jobs v1 terminal success shape', () => {
  const execution = {
    apiVersion: 'run.googleapis.com/v1',
    kind: 'Execution',
    metadata: {
      name: 'hkbuddy-migrate-release-001',
      labels: { 'run.googleapis.com/job': 'hkbuddy-migrate' },
    },
    spec: { taskCount: 1, parallelism: 1 },
    status: {
      conditions: [{ type: 'Completed', status: 'True' }],
      completionTime: '2026-08-26T08:00:00.000Z',
      runningCount: 0,
      succeededCount: 1,
      failedCount: 0,
      cancelledCount: 0,
      retriedCount: 0,
    },
  };
  assert.deepEqual(validateMigrationExecutionReceipt(execution, { releaseSha: RELEASE_SHA }), {
    name: 'hkbuddy-migrate-release-001',
    job: 'hkbuddy-migrate',
    taskCount: 1,
    parallelism: 1,
    succeededCount: 1,
    completionTime: '2026-08-26T08:00:00.000Z',
  });
  const omittedZeroCounters = structuredClone(execution);
  for (const key of ['runningCount', 'failedCount', 'cancelledCount', 'retriedCount']) {
    delete omittedZeroCounters.status[key];
  }
  assert.deepEqual(
    validateMigrationExecutionReceipt(omittedZeroCounters, { releaseSha: RELEASE_SHA }),
    validateMigrationExecutionReceipt(execution, { releaseSha: RELEASE_SHA }),
  );
  for (const mutate of [
    (value) => { value.status.conditions[0].status = 'False'; },
    (value) => { value.status.succeededCount = 0; },
    (value) => { value.status.failedCount = 1; },
    (value) => { value.status.cancelledCount = 1; },
    (value) => { value.status.runningCount = 1; },
    (value) => { delete value.status.completionTime; },
  ]) {
    const drift = structuredClone(execution);
    mutate(drift);
    assert.throws(
      () => validateMigrationExecutionReceipt(drift, { releaseSha: RELEASE_SHA }),
      /migration execution receipt/i,
    );
  }
});

test('migration phase persists the canonical short v1 execution identity with omitted zero counters', async () => {
  const input = releaseInput({ evidence: null, acceptanceOutputs: null, previousRevision: null });
  const plan = buildReleasePlan(input, { phase: 'migration' });
  let persisted = null;
  const result = await runGcpRelease({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`],
    input,
    persistReceipt: async (_releasePlan, receipt) => {
      persisted = structuredClone(receipt);
      return true;
    },
    execute: async (argv) => {
      if (argv[2] === 'deploy') return { metadata: { name: 'hkbuddy-migrate' } };
      if (argv[2] === 'describe') return realV1JobReadback(plan.expectedMigrationJob);
      if (argv[2] === 'execute') return {
        apiVersion: 'run.googleapis.com/v1',
        kind: 'Execution',
        metadata: {
          name: 'hkbuddy-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-migrate' },
        },
        spec: { taskCount: 1, parallelism: 1 },
        status: {
          conditions: [{ type: 'Completed', status: 'True' }],
          completionTime: '2026-08-26T08:00:00.000Z',
          succeededCount: 1,
        },
      };
      throw new Error(`unexpected operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.migrationExecutionReceipt.name, 'hkbuddy-migrate-release-001');
  assert.equal(persisted.outputs.executionName, 'hkbuddy-migrate-release-001');
  assert.doesNotMatch(persisted.outputs.executionName, /\/executions\//);
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

test('workload phase rejects every pre-existing artifact even with a complete-looking record and 200 matching logs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-workload-gate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let artifactIndex = 0;
  const runRecord = async (record) => {
    artifactIndex += 1;
    const finalized = finalizeLatencyAcceptanceRecord(record);
    const contents = `${JSON.stringify(finalized, null, 2)}\n`;
    const filePath = join(directory, `${artifactIndex}.json`);
    await writeFile(filePath, contents);
    const workload = {
      filePath,
      artifactSha256: finalized.artifactSha256,
      objectSha256: createHash('sha256').update(contents).digest('hex'),
    };
    const input = releaseInput({
      task8Evidence: { ...releaseInput().task8Evidence, workload },
    });
    let controlledExecutions = 0;
    const result = await runGcpReleaseImpl({
      argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`],
      input,
      loadReceipts: async (plan, { through }) => fixtureReceiptChain(plan, through),
      persistReceipt: async () => true,
      executeWorkload: async () => { controlledExecutions += 1; throw new Error('must remain inert'); },
      execute: async (argv) => {
        assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
        return controlPlaneLogEntries(finalized);
      },
      now: () => new Date('2026-08-26T08:05:00.000Z'),
      writeOutput: () => undefined,
    });
    return { result, controlledExecutions };
  };

  const valid = validWorkloadAcceptanceRecord();
  const prebuilt = await runRecord(valid);
  assert.equal(prebuilt.result.exitCode, 1);
  assert.equal(prebuilt.result.publicReport.code, 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN');
  assert.equal(prebuilt.result.publicReport.mutationPerformed, false);
  assert.equal(prebuilt.controlledExecutions, 0);

  const syntheticSummary = structuredClone(valid);
  delete syntheticSummary.rawReceipts;
  syntheticSummary.artifactSha256 = finalizeLatencyAcceptanceRecord(syntheticSummary).artifactSha256;
  const syntheticRejected = (await runRecord(syntheticSummary)).result;
  assert.equal(syntheticRejected.exitCode, 1,
    'aggregate-only evidence must not certify a workload with zero HTTP turns');

  const forgedFiveField = finalizeLatencyAcceptanceRecord({
    schemaVersion: 3,
    commitSha: RELEASE_SHA,
    candidateOrigin: CANDIDATE_ORIGIN,
    occurredAt: '2026-08-26T08:00:00.000Z',
    result: true,
  });
  const missingCounts = structuredClone(valid);
  delete missingCounts.counts;
  const mutatedMetric = structuredClone(valid);
  mutatedMetric.metrics.sendAck.sampleCount = 199;
  const duplicateObservation = structuredClone(valid);
  duplicateObservation.observations.queryDigests.values[1]
    = duplicateObservation.observations.queryDigests.values[0];
  const staleReplay = structuredClone(valid);
  staleReplay.occurredAt = '2026-08-24T08:00:00.000Z';
  const refinalizeRaw = (record) => {
    const { receiptsSha256: ignored, ...payload } = record.rawReceipts;
    void ignored;
    record.rawReceipts.receiptsSha256 = createHash('sha256')
      .update(JSON.stringify(canonicalFixture(payload))).digest('hex');
    return record;
  };
  const mutatedRawStatus = structuredClone(valid);
  mutatedRawStatus.rawReceipts.textTurns[0].requestStatus = 500;
  refinalizeRaw(mutatedRawStatus);
  const duplicatedControlPlane = structuredClone(valid);
  duplicatedControlPlane.rawReceipts.controlPlaneRequests[1] = {
    ...structuredClone(duplicatedControlPlane.rawReceipts.controlPlaneRequests[0]), sequence: 2,
  };
  refinalizeRaw(duplicatedControlPlane);
  const reorderedTurns = structuredClone(valid);
  [reorderedTurns.rawReceipts.textTurns[0], reorderedTurns.rawReceipts.textTurns[1]] = [
    reorderedTurns.rawReceipts.textTurns[1], reorderedTurns.rawReceipts.textTurns[0],
  ];
  refinalizeRaw(reorderedTurns);

  for (const [name, record] of [
    ['forged five-field record', forgedFiveField],
    ['missing 200-turn counts', missingCounts],
    ['mutated metric sample count', mutatedMetric],
    ['duplicate timing query observation', duplicateObservation],
    ['stale replay', staleReplay],
    ['mutated raw request status with recomputed receipts digest', mutatedRawStatus],
    ['duplicate control-plane request with recomputed receipts digest', duplicatedControlPlane],
    ['reordered raw turns with recomputed receipts digest', reorderedTurns],
  ]) {
    const rejected = (await runRecord(record)).result;
    assert.equal(rejected.exitCode, 1, name);
    assert.equal(rejected.publicReport.code, 'WORKLOAD_PREBUILT_EVIDENCE_FORBIDDEN', name);
    assert.equal(rejected.publicReport.mutationPerformed, false, name);
  }
});

test('workload receipt is created only by one controlled immutable run with witnessed text ASR TTS and timing traffic', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-controlled-workload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workloadPath = join(directory, 'workload.json');
  const fixtureManifestPath = join(directory, 'asr-fixtures.json');
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        filePath: workloadPath,
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const record = validWorkloadAcceptanceRecord();
  assert.equal(new Set(record.rawReceipts.textTurns.map(({ correlationId }) => correlationId)).size, 200);
  assert.equal(new Set(record.rawReceipts.asrRequests.map(({ bindingId }) => bindingId)).size, 30);
  assert.equal(new Set(record.rawReceipts.ttsRequests.map(({ bindingId }) => bindingId)).size, 31);
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let persisted = null;
  let runnerCalls = 0;
  let publishedBeforeRunnerCompleted = false;
  let runnerCompleted = false;
  const result = await runGcpReleaseImpl({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: fixtureManifestPath },
    randomUUID: () => attemptId,
    loadReceipts: async (_releasePlan, { through }) => fixtureReceiptChain(plan, through),
    executeWorkload: async (options) => {
      runnerCalls += 1;
      assert.deepEqual(options.argv, [
        '--candidate-origin', CANDIDATE_ORIGIN,
        '--asr-manifest', fixtureManifestPath,
        '--confirm-approved-candidate',
      ]);
      assert.equal(options.environment.V1_LOAD_TEST_CONFIRM, 'true');
      assert.equal(options.environment.V1_RELEASE_COMMIT_SHA, RELEASE_SHA);
      assert.equal(options.environment.V1_SOURCE_ARCHIVE_SHA256, SOURCE_SHA);
      assert.equal(options.environment.V1_CANDIDATE_IMAGE_DIGEST, IMAGE_DIGEST);
      assert.equal(options.environment.V1_CANDIDATE_REVISION, REVISION);
      await exerciseControlledWorkloadNetwork(options.fetchImpl, record);
      await options.writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${record.artifactSha256}.json`), contents, record,
      });
      runnerCompleted = true;
      return {
        exitCode: 0,
        publicReport: { status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED', artifactSha256: record.artifactSha256 },
      };
    },
    workloadFetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const status = path === '/api/v1/messages' && options.method === 'POST' ? 202
        : path === '/api/v1/voice/transcriptions' && options.method === 'POST' ? 202
          : options.headers?.Range === 'bytes=0-3' ? 206 : 200;
      return { status };
    },
    execute: async (argv) => {
      assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
      return controlPlaneLogEntries(record);
    },
    persistReceipt: async (_releasePlan, receipt) => {
      publishedBeforeRunnerCompleted = !runnerCompleted;
      persisted = structuredClone(receipt);
      return true;
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 0, JSON.stringify(result.publicReport));
  assert.equal(runnerCalls, 1);
  assert.equal(publishedBeforeRunnerCompleted, false);
  assert.equal((await readFile(workloadPath, 'utf8')), contents);
  assert.equal(persisted.outputs.artifactSha256, record.artifactSha256);
  assert.equal(persisted.outputs.objectSha256,
    createHash('sha256').update(contents).digest('hex'));
  assert.equal(persisted.outputs.execution.attemptId, attemptId);
  assert.equal(persisted.outputs.execution.acceptanceWindowId,
    record.rawReceipts.acceptanceWindowId);
  assert.match(persisted.outputs.execution.networkWitnessSha256, /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(persisted).includes('Authorization'), false);
  assert.equal(JSON.stringify(persisted).includes('Bearer'), false);
});

test('valid-looking constants and 200 request logs cannot create a receipt without witnessed ASR TTS and semantic traffic', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-unwitnessed-workload-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        filePath: join(directory, 'workload.json'),
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const record = validWorkloadAcceptanceRecord();
  const contents = `${JSON.stringify(record, null, 2)}\n`;
  let persisted = false;
  const calls = [];
  const result = await runGcpReleaseImpl({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: join(directory, 'fixtures.json') },
    loadReceipts: async (_releasePlan, { through }) => fixtureReceiptChain(plan, through),
    executeWorkload: async ({ writeArtifact }) => {
      await writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${record.artifactSha256}.json`), contents, record,
      });
      return {
        exitCode: 0,
        publicReport: { status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED', artifactSha256: record.artifactSha256 },
      };
    },
    workloadFetch: async () => ({ status: 200 }),
    execute: async (argv) => { calls.push(argv); return controlPlaneLogEntries(record); },
    persistReceipt: async () => { persisted = true; return true; },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'WORKLOAD_CONTROLLED_NETWORK_INVALID');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(persisted, false);
  assert.deepEqual(calls, []);
});

test('promotion rejects a fresh workload execution-window mismatch before any control-plane mutation', async () => {
  const input = releaseInput();
  const plan = buildReleasePlan(input);
  const calls = [];
  const result = await runGcpReleaseImpl({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => fixtureReceiptChain(plan, 'mobile'),
    verifyTask8Evidence: async (_entry, phase) => phase === 'workload' ? {
      acceptanceWindowId: 'f'.repeat(64),
      candidateOrigin: CANDIDATE_ORIGIN,
      candidateRevision: REVISION,
      controlPlaneRequests: [],
      expectedTraceIds: [],
    } : true,
    execute: async (argv) => { calls.push(argv); return {}; },
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'TASK8_EVIDENCE_INVALID');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.deepEqual(calls, []);
});

test('real-shape migration, authenticated workload, and tag-free promotion share one receipt chain', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'hkbuddy-integrated-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const workloadRecord = validWorkloadAcceptanceRecord();
  const workloadBytes = `${JSON.stringify(workloadRecord, null, 2)}\n`;
  const workloadPath = join(directory, 'workload.json');
  const fixtureManifestPath = join(directory, 'asr-fixtures.json');
  const base = releaseInput();
  const input = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        filePath: workloadPath,
        artifactSha256: '0'.repeat(64),
        objectSha256: '0'.repeat(64),
      },
    },
  });
  const plan = buildReleasePlan(input);
  const receipts = fixtureReceiptChain(plan, 'build');
  const persistReceipt = async (_releasePlan, receipt) => {
    receipts.push(structuredClone(receipt));
    return true;
  };

  const migration = await runGcpReleaseImpl({
    argv: ['--phase=migration', `--confirm-release=${RELEASE_SHA}`], input,
    loadReceipts: async () => structuredClone(receipts),
    persistReceipt,
    execute: async (argv) => {
      if (argv[2] === 'deploy') return { metadata: { name: 'hkbuddy-migrate' } };
      if (argv[2] === 'describe') return realV1JobReadback(plan.expectedMigrationJob);
      if (argv[2] === 'execute') return {
        apiVersion: 'run.googleapis.com/v1', kind: 'Execution',
        metadata: {
          name: 'hkbuddy-migrate-release-001',
          labels: { 'run.googleapis.com/job': 'hkbuddy-migrate' },
        },
        spec: { taskCount: 1, parallelism: 1 },
        status: {
          conditions: [{ type: 'Completed', status: 'True' }],
          completionTime: '2026-08-26T08:00:00.000Z', succeededCount: 1,
        },
      };
      throw new Error(`unexpected migration operation: ${argv.join(' ')}`);
    },
    writeOutput: () => undefined,
  });
  assert.equal(migration.exitCode, 0);

  for (const phase of ['inventory', 'acceptance', 'collect', 'evidence', 'candidate', 'readiness']) {
    receipts.push(finalizeReleasePhaseReceipt({
      schemaVersion: 1,
      phase,
      sequence: receipts.length + 1,
      releaseSha: plan.releaseSha,
      releaseIdentitySha256: plan.releaseIdentitySha256,
      previousReceiptSha256: receipts.at(-1).receiptSha256,
      completed: plan.operations.filter((member) => member.phase === phase).map(({ id }) => id),
      outputs: fixtureReceiptOutputs(plan, phase),
    }));
  }

  const workload = await runGcpReleaseImpl({
    argv: ['--phase=workload', `--confirm-release=${RELEASE_SHA}`], input,
    environment: { V1_LATENCY_ASR_FIXTURE_MANIFEST: fixtureManifestPath },
    randomUUID: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    loadReceipts: async () => structuredClone(receipts),
    persistReceipt,
    executeWorkload: async (options) => {
      await exerciseControlledWorkloadNetwork(options.fetchImpl, workloadRecord);
      await options.writeArtifact({
        filePath: join(directory, `${RELEASE_SHA}-${workloadRecord.artifactSha256}.json`),
        contents: workloadBytes,
        record: workloadRecord,
      });
      return {
        exitCode: 0,
        publicReport: {
          status: 'recorded', code: 'LATENCY_ACCEPTANCE_PASSED',
          artifactSha256: workloadRecord.artifactSha256,
        },
      };
    },
    workloadFetch: async (url, options = {}) => {
      const path = new URL(url).pathname;
      const status = path === '/api/v1/messages' && options.method === 'POST' ? 202
        : path === '/api/v1/voice/transcriptions' && options.method === 'POST' ? 202
          : options.headers?.Range === 'bytes=0-3' ? 206 : 200;
      return { status };
    },
    execute: async (argv) => {
      assert.deepEqual(argv.slice(0, 2), ['logging', 'read']);
      return controlPlaneLogEntries(workloadRecord);
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(workload.exitCode, 0, JSON.stringify(workload.publicReport));

  const refreshedInput = releaseInput({
    task8Evidence: {
      ...base.task8Evidence,
      workload: {
        filePath: workloadPath,
        artifactSha256: workloadRecord.artifactSha256,
        objectSha256: createHash('sha256').update(workloadBytes).digest('hex'),
      },
    },
  });
  const refreshedPlan = buildReleasePlan(refreshedInput);

  receipts.push(finalizeReleasePhaseReceipt({
    schemaVersion: 1,
    phase: 'mobile',
    sequence: receipts.length + 1,
    releaseSha: refreshedPlan.releaseSha,
    releaseIdentitySha256: refreshedPlan.releaseIdentitySha256,
    previousReceiptSha256: receipts.at(-1).receiptSha256,
    completed: refreshedPlan.operations.filter((member) => member.phase === 'mobile').map(({ id }) => id),
    outputs: fixtureReceiptOutputs(refreshedPlan, 'mobile'),
  }));

  let currentService = {
    service: 'hkbuddy-api',
    traffic: [
      { revision: input.previousRevision, percent: 100 },
      { revision: REVISION, tag: CANDIDATE_TAG, percent: 0 },
    ],
  };
  let currentPolicy = {
    bindings: [{ role: 'roles/run.invoker', members: ['user:qa@motionexp.com'] }],
    etag: 'Bw-private=', version: 1,
  };
  let postPromotionReadbacks = 0;
  const promotion = await runGcpReleaseImpl({
    argv: ['--phase=promote', `--confirm-release=${RELEASE_SHA}`], input: refreshedInput,
    loadReceipts: async () => structuredClone(receipts),
    verifyTask8Evidence: async (_entry, phase) => phase === 'workload' ? {
      acceptanceWindowId: workloadRecord.rawReceipts.acceptanceWindowId,
      candidateOrigin: CANDIDATE_ORIGIN,
      candidateRevision: REVISION,
      controlPlaneRequests: workloadRecord.rawReceipts.controlPlaneRequests,
      expectedTraceIds: workloadRecord.rawReceipts.textTurns.map(({ traceId }) => traceId),
    } : true,
    execute: async (argv) => {
      if (argv[0] === 'logging') return controlPlaneLogEntries(workloadRecord);
      if (argv[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      if (argv[0] === 'artifacts') return { image: plan.expectedCandidate.image };
      if (argv[1] === 'revisions') return structuredClone(plan.expectedCandidate);
      if (argv.includes('get-iam-policy')) return structuredClone(currentPolicy);
      if (argv.includes('add-iam-policy-binding')) {
        currentPolicy = {
          bindings: [{
            role: 'roles/run.invoker', members: ['allUsers', 'user:qa@motionexp.com'],
          }],
          etag: 'Bw-public=', version: 1,
        };
        return structuredClone(currentPolicy);
      }
      if (argv.includes('update-traffic')) {
        currentService = { service: 'hkbuddy-api', traffic: [{ revision: REVISION, percent: 100 }] };
        return structuredClone(currentService);
      }
      if (argv[1] === 'services' && argv[2] === 'describe') {
        if (currentService.traffic[0].revision === REVISION) postPromotionReadbacks += 1;
        return structuredClone(currentService);
      }
      throw new Error(`unexpected promotion operation: ${argv.join(' ')}`);
    },
    now: () => new Date('2026-08-26T08:05:00.000Z'),
    writeOutput: () => undefined,
  });
  assert.equal(promotion.exitCode, 0);
  assert.equal(postPromotionReadbacks, 1);
  assert.deepEqual(currentService.traffic, [{ revision: REVISION, percent: 100 }]);
  assert.equal(JSON.stringify(currentService).includes(CANDIDATE_TAG), false);
  assert.equal(currentPolicy.bindings[0].members.includes('allUsers'), true);
});

test('promotion rereads the exact private zero-traffic candidate before granting public access and changing traffic', () => {
  const operations = buildReleasePlan(releaseInput()).operations;
  const ids = operations.map(({ id }) => id);
  for (const id of [
    'promote-candidate-service-readback', 'promote-candidate-revision-readback',
    'promote-candidate-iam-readback', 'promote-candidate-artifact-readback',
  ]) {
    assert.equal(ids.includes(id), true, id);
    assert.equal(ids.indexOf(id) < ids.indexOf('promote-traffic'), true, id);
  }
  assert.equal(ids.indexOf('promote-candidate-artifact-readback') < ids.indexOf('promote-public-service'), true);
  assert.equal(ids.indexOf('promote-public-service') < ids.indexOf('promote-public-iam-readback'), true);
  assert.equal(ids.indexOf('promote-public-iam-readback') < ids.indexOf('promote-traffic'), true);
  assert.equal(ids.indexOf('promote-traffic') < ids.indexOf('promote-readback'), true);
  const traffic = operations.find(({ id }) => id === 'promote-traffic');
  assert.equal(traffic.argv.includes(`--remove-tags=${CANDIDATE_TAG}`), true);
  const readback = operations.find(({ id }) => id === 'promote-readback');
  assert.deepEqual(readback.argv.slice(0, 4), ['run', 'services', 'describe', 'hkbuddy-api']);
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
  const deployer = `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`;
  const acceptance = `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`;
  assert.equal(contract.resources.serviceAccounts.some(({ id }) => id === 'hkbuddy-v1-acceptance'), true);
  assert.deepEqual(contract.iam.bindings.filter(({ member }) => member === acceptance), [
    { scope: `bucket:${GCP_IDENTITY.bucket}`, member: acceptance, role: 'roles/storage.objectUser' },
    {
      scope: `bucket:${GCP_IDENTITY.bucket}`, member: acceptance,
      role: `projects/${GCP_IDENTITY.projectId}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
    },
    { scope: `secret:${GCP_IDENTITY.secrets.dbAppUrl}`, member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, member: acceptance, role: 'roles/secretmanager.secretAccessor' },
    { scope: 'project', member: acceptance, role: 'roles/logging.logWriter' },
  ]);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-acceptance' && member === deployer
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
    const v1Secret = `hkbuddy-v1-${secret.slice('hkbuddy-'.length)}`;
    assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
      scope === `secret:${v1Secret}` && member === deployer
        && role === 'roles/secretmanager.secretVersionAdder'
    )), true, v1Secret);
  }
  assert.equal(JSON.stringify(contract).includes('roles/run.admin'), true);
  assert.equal(contract.iam.bindings.some(({ role }) => role === 'roles/run.admin'), false);
});
