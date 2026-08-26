import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { GCP_IDENTITY } from '../src/gcp-identity.js';
import {
  buildReleasePlan,
  validateServiceIamReceipt,
} from '../scripts/gcp-release.js';
import {
  GcpControlPlane,
  assertCidrAvailable,
  createGcloudExecutor,
  ensureExactResource,
} from '../scripts/gcp-provision.js';
import {
  LATENCY_ACCEPTANCE_CONTRACT,
  runLatencyAcceptance,
} from '../scripts/production-latency-workload.js';

const PROJECT = 'motion-expert-hk-ltd-webpage';
const PROJECT_NUMBER = '582852715831';
const REGION = 'asia-east2';
const STABLE_SERVICE = 'hkbuddy-v1-api';
const CANDIDATE_SERVICE = 'hkbuddy-v1-api-candidate';
const RELEASE_SHA = 'a'.repeat(40);
const SOURCE_SHA = 'b'.repeat(64);
const BUILD_CONFIG_SHA = 'e'.repeat(64);
const IMAGE_DIGEST = `sha256:${'c'.repeat(64)}`;
const PREVIOUS_IMAGE_DIGEST = `sha256:${'d'.repeat(64)}`;
const CANDIDATE_TAG = `candidate-${RELEASE_SHA.slice(0, 12)}`;
const CANDIDATE_REVISION = `${CANDIDATE_SERVICE}-${RELEASE_SHA.slice(0, 12)}`;
const STABLE_REVISION = `${STABLE_SERVICE}-${RELEASE_SHA.slice(0, 12)}`;
const PREVIOUS_REVISION = `${STABLE_SERVICE}-111111111111`;
const CANDIDATE_ROOT = `https://${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const CANDIDATE_ORIGIN = `https://${CANDIDATE_TAG}---${CANDIDATE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const STABLE_ORIGIN = `https://${STABLE_SERVICE}-${PROJECT_NUMBER}.${REGION}.run.app`;
const ACCEPTANCE_RUN_ID = '123e4567-e89b-42d3-a456-426614174000';

const EVIDENCE = Object.freeze({
  legacyInventory: Object.freeze({
    secret: 'hkbuddy-v1-legacy-inventory', secretVersion: '11',
    artifactSha256: '1'.repeat(64), objectSha256: 'a'.repeat(64),
    filePath: 'C:\\release\\legacy-inventory.json',
  }),
  dependencyAcceptance: Object.freeze({
    secret: 'hkbuddy-v1-dependency-acceptance', secretVersion: '12',
    artifactSha256: '2'.repeat(64), objectSha256: 'b'.repeat(64),
    filePath: 'C:\\release\\dependency-acceptance.json',
  }),
  llmSmoke: Object.freeze({
    secret: 'hkbuddy-v1-llm-smoke', secretVersion: '13',
    artifactSha256: '3'.repeat(64), objectSha256: 'c'.repeat(64),
    filePath: 'C:\\release\\llm-smoke.json',
  }),
  asrSmoke: Object.freeze({
    secret: 'hkbuddy-v1-asr-smoke', secretVersion: '14',
    artifactSha256: '4'.repeat(64), objectSha256: 'd'.repeat(64),
    filePath: 'C:\\release\\asr-smoke.json',
  }),
  ttsSmoke: Object.freeze({
    secret: 'hkbuddy-v1-tts-smoke', secretVersion: '15',
    artifactSha256: '5'.repeat(64), objectSha256: 'e'.repeat(64),
    filePath: 'C:\\release\\tts-smoke.json',
  }),
  iosVoiceAcceptance: Object.freeze({
    secret: 'hkbuddy-v1-ios-voice-acceptance', secretVersion: '16',
    artifactSha256: '6'.repeat(64), objectSha256: 'f'.repeat(64),
    filePath: 'C:\\release\\ios-voice-acceptance.json',
  }),
});

const ACCEPTANCE_OUTPUTS = Object.freeze({
  dependencyAcceptance: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/dependency-acceptance/${ACCEPTANCE_RUN_ID}.json`,
    generation: '101', filePath: EVIDENCE.dependencyAcceptance.filePath,
  }),
  llmSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/llm-smoke/llm-${ACCEPTANCE_RUN_ID}.json`,
    generation: '102', filePath: EVIDENCE.llmSmoke.filePath,
  }),
  asrSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/asr-${ACCEPTANCE_RUN_ID}.json`,
    generation: '103', filePath: EVIDENCE.asrSmoke.filePath,
  }),
  ttsSmoke: Object.freeze({
    bucket: 'hkbuddy-v1-582852715831-media',
    object: `release-evidence/${RELEASE_SHA}/voice-smoke/tts-${ACCEPTANCE_RUN_ID}.json`,
    generation: '104', filePath: EVIDENCE.ttsSmoke.filePath,
  }),
});

function task8Entry(phase, stableTrafficState = 'stable-prior-100') {
  const digit = { readiness: '7', workload: '8', mobile: '9' }[phase];
  return {
    schemaVersion: 2,
    filePath: `C:\\release\\${phase}.json`,
    artifactSha256: digit.repeat(64),
    objectSha256: digit.repeat(64),
    candidateService: CANDIDATE_SERVICE,
    stableService: STABLE_SERVICE,
    trafficState: 'candidate-service-private-100',
    stableTrafficState,
  };
}

function releaseInput({ first = false, task8Evidence = null } = {}) {
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
    task8Evidence: task8Evidence ?? {
      readiness: task8Entry('readiness', stableTrafficState),
      workload: task8Entry('workload', stableTrafficState),
      mobile: task8Entry('mobile', stableTrafficState),
    },
    legacyInventory: EVIDENCE.legacyInventory,
    evidence: EVIDENCE,
    previousRevision: first ? null : PREVIOUS_REVISION,
    previousImageDigest: first ? null : PREVIOUS_IMAGE_DIGEST,
  };
}

function phaseOperations(plan, phase) {
  return plan.operations.filter((operation) => operation.phase === phase);
}

function mutatingOperation(operation) {
  const text = operation.argv.join('\0');
  return !operation.argv.includes('--dry-run')
    && /\0(?:replace|delete|update-traffic|add-iam-policy-binding)\0/.test(`\0${text}\0`);
}

test('central identity names a separate managed candidate service', () => {
  assert.equal(GCP_IDENTITY.service, STABLE_SERVICE);
  assert.equal(GCP_IDENTITY.candidateService, CANDIDATE_SERVICE);
});

test('every release candidate is private 100 percent on only the candidate service', () => {
  const plan = buildReleasePlan(releaseInput());
  assert.equal(plan.candidateRevision, CANDIDATE_REVISION);
  assert.equal(plan.stableRevision, STABLE_REVISION);
  assert.equal(plan.candidateOrigin, CANDIDATE_ORIGIN);
  assert.equal(plan.candidateAccess.audience, CANDIDATE_ROOT);
  assert.equal(plan.candidateAccess.taggedUrl, CANDIDATE_ORIGIN);
  assert.equal(plan.expectedCandidate.service, CANDIDATE_SERVICE);
  assert.equal(plan.expectedCandidate.trafficState, 'candidate-service-private-100');
  assert.deepEqual(plan.expectedCandidate.traffic, [{
    revision: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100,
  }]);

  const operations = phaseOperations(plan, 'candidate');
  assert.deepEqual(operations.map(({ id }) => id), [
    'candidate-service-precheck',
    'candidate-spec-dry-run',
    'candidate-deploy',
    'candidate-service-readback',
    'candidate-revision-readback',
    'candidate-artifact-readback',
    'candidate-private-iam-baseline-readback',
    'candidate-private-iam-grant',
    'candidate-private-iam-readback',
  ]);
  assert.equal(operations.some(({ argv }) => (
    argv[0] === 'run' && argv[1] === 'services' && argv[3] === STABLE_SERVICE
  )), false);
  assert.equal(operations.some(({ argv }) => argv.includes('--member=allUsers')), false);
  assert.equal(JSON.stringify(plan.expectedStable.traffic).includes(CANDIDATE_TAG), false);
  assert.equal(JSON.stringify(plan.expectedStable.stagedTraffic).includes(CANDIDATE_TAG), false);
});

test('first promotion creates stable privately and public IAM is its final mutation', () => {
  const plan = buildReleasePlan(releaseInput({ first: true }));
  const operations = phaseOperations(plan, 'promote');
  const mutationIds = operations.filter(mutatingOperation).map(({ id }) => id);
  assert.deepEqual(mutationIds, ['promote-stable-deploy', 'promote-public-service']);
  assert.equal(operations.at(-2).id, 'promote-public-service');
  assert.equal(operations.at(-1).id, 'promote-public-iam-readback');
  assert.equal(operations.at(-1).argv.includes(STABLE_SERVICE), true);
  assert.deepEqual(plan.expectedStable.traffic, [{
    revision: STABLE_REVISION, tag: null, percent: 100,
  }]);
});

test('later promotion stages untagged stable zero then atomically switches stable to 100', () => {
  const plan = buildReleasePlan(releaseInput());
  const operations = phaseOperations(plan, 'promote');
  const ids = operations.map(({ id }) => id);
  assert.equal(ids.indexOf('promote-stable-staged-readback') < ids.indexOf('promote-traffic'), true);
  assert.deepEqual(operations.filter(mutatingOperation).map(({ id }) => id), [
    'promote-stable-deploy', 'promote-traffic',
  ]);
  assert.equal(operations.some(({ argv }) => argv.includes('--member=allUsers')), false);
  assert.deepEqual(plan.expectedStable.stagedTraffic, [
    { revision: PREVIOUS_REVISION, tag: null, percent: 100 },
    { revision: STABLE_REVISION, tag: null, percent: 0 },
  ]);
  assert.equal(operations.filter(({ argv }) => (
    argv[0] === 'run' && argv[1] === 'services' && argv[3] === STABLE_SERVICE
  )).some(({ argv }) => argv.some((value) => value.includes(CANDIDATE_TAG))), false);
});

test('candidate cleanup is first-release capable, receipt-bound, and deletes only candidate service', () => {
  for (const first of [true, false]) {
    const plan = buildReleasePlan(releaseInput({ first }));
    const operations = phaseOperations(plan, 'candidate-cleanup');
    assert.deepEqual(operations.map(({ id }) => id), [
      'candidate-cleanup-service-precheck',
      'candidate-cleanup-revision-readback',
      'candidate-cleanup-artifact-readback',
      'candidate-cleanup-private-iam-readback',
      'candidate-cleanup-delete',
      'candidate-cleanup-absence-readback',
    ]);
    assert.equal(operations.some(({ argv }) => argv.includes(STABLE_SERVICE)), false);
    assert.equal(operations.some(({ argv }) => argv.includes('update-traffic')), false);
    assert.equal(operations.some(({ argv }) => argv.includes('set-iam-policy')), false);
  }
});

test('later rollback is stable-only and never depends on or mutates candidate service', () => {
  const plan = buildReleasePlan(releaseInput());
  const operations = phaseOperations(plan, 'rollback');
  assert.equal(operations.length > 0, true);
  assert.equal(JSON.stringify(operations).includes(CANDIDATE_SERVICE), false);
  assert.equal(JSON.stringify(operations).includes(CANDIDATE_TAG), false);
  assert.equal(operations.filter(mutatingOperation).map(({ id }) => id).join(','), 'rollback-traffic');
  assert.equal(operations.every(({ argv }) => (
    argv[0] !== 'run' || argv[1] !== 'services' || argv.includes(STABLE_SERVICE)
  )), true);
});

test('candidate IAM is one exact private invoker contract, not arbitrary non-public IAM', () => {
  const exactCandidatePolicy = {
    bindings: [{ role: 'roles/run.invoker', members: ['user:admin@motionexp.com'] }],
    etag: 'candidate-etag', version: 1,
  };
  assert.doesNotThrow(() => validateServiceIamReceipt(exactCandidatePolicy, {
    policy: 'candidate-private', requireEtag: true,
  }));
  for (const policy of [
    { bindings: [], etag: 'candidate-etag', version: 1 },
    {
      bindings: [{ role: 'roles/run.invoker', members: ['user:foreign@example.test'] }],
      etag: 'candidate-etag', version: 1,
    },
    {
      bindings: [{ role: 'roles/viewer', members: ['user:admin@motionexp.com'] }],
      etag: 'candidate-etag', version: 1,
    },
    {
      bindings: [{ role: 'roles/run.invoker', members: ['allUsers'] }],
      etag: 'candidate-etag', version: 1,
    },
  ]) {
    assert.throws(() => validateServiceIamReceipt(policy, {
      policy: 'candidate-private', requireEtag: true,
    }), /IAM readback is invalid/);
  }
});

test('Task 8 locators require schema and exact named two-service traffic binding', () => {
  const plan = buildReleasePlan(releaseInput());
  for (const phase of ['readiness', 'workload', 'mobile']) {
    assert.deepEqual(plan.task8Evidence[phase], task8Entry(phase));
  }
  const percentOnly = Object.fromEntries(['readiness', 'workload', 'mobile'].map((phase) => [
    phase,
    {
      filePath: `C:\\release\\${phase}.json`,
      artifactSha256: '7'.repeat(64), objectSha256: '7'.repeat(64),
      trafficPercent: 100,
    },
  ]));
  assert.throws(() => buildReleasePlan(releaseInput({ task8Evidence: percentOnly })), /release contract/i);
});

test('Task 8 workload rejects percent-only binding and requires the named two-service state', async () => {
  const oldPercentOnly = {
    V1_LOAD_TEST_CONFIRM: 'true',
    V1_RELEASE_COMMIT_SHA: RELEASE_SHA,
    V1_PUBLIC_ORIGIN: STABLE_ORIGIN,
    V1_CANDIDATE_ORIGIN: CANDIDATE_ORIGIN,
    V1_SOURCE_ARCHIVE_SHA256: SOURCE_SHA,
    V1_CANDIDATE_IMAGE_DIGEST: IMAGE_DIGEST,
    V1_CANDIDATE_REVISION: CANDIDATE_REVISION,
    V1_CANDIDATE_TRAFFIC_PERCENT: '100',
  };
  const run = (environment) => runLatencyAcceptance({
    argv: [
      '--candidate-origin', CANDIDATE_ORIGIN,
      '--asr-manifest', 'C:\\release\\fixtures.json',
      '--confirm-approved-candidate',
    ],
    environment,
    inspectGit: async () => ({ head: '0'.repeat(40), clean: true }),
    writeOutput: () => undefined,
  });
  assert.equal((await run(oldPercentOnly)).publicReport.code, 'RELEASE_BINDING_INVALID');
  assert.equal((await run({
    ...oldPercentOnly,
    V1_CANDIDATE_AUDIENCE: CANDIDATE_ROOT,
    V1_CANDIDATE_SERVICE: CANDIDATE_SERVICE,
    V1_STABLE_SERVICE: STABLE_SERVICE,
    V1_CANDIDATE_TRAFFIC_STATE: 'candidate-service-private-100',
    V1_STABLE_TRAFFIC_STATE: 'stable-prior-100',
  })).publicReport.code, 'RELEASE_GIT_STATE_INVALID');
  assert.equal(LATENCY_ACCEPTANCE_CONTRACT.schemaVersion, 5);
});

function executorRejectingWith(stderr) {
  return createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('bundled Python wrapper failed');
      error.stderr = stderr;
      throw error;
    },
  });
}

test('bundled-Python wrapper normalizes only CRLF for canonical Compute absence', async (t) => {
  const fixtures = [
    {
      name: 'network',
      argv: ['compute', 'networks', 'describe', GCP_IDENTITY.network, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`,
    },
    {
      name: 'subnet',
      argv: ['compute', 'networks', 'subnets', 'describe', GCP_IDENTITY.subnet, '--region=asia-east2', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`,
    },
    {
      name: 'address',
      argv: ['compute', 'addresses', 'describe', GCP_IDENTITY.psaRange, '--global', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`,
    },
  ];
  for (const fixture of fixtures) {
    await t.test(fixture.name, async () => {
      const crlf = `${fixture.stderr.replaceAll('\n', '\r\n')}\r\n`;
      await assert.rejects(
        () => executorRejectingWith(crlf)(fixture.argv),
        (error) => error.code === 'NOT_FOUND',
      );
      await assert.rejects(
        () => executorRejectingWith(`${crlf}extra line\r\n`)(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }
});

function comparePlane(gcloud = async () => ({})) {
  return new GcpControlPlane({
    contract: {}, notificationChannel: null, gcloud,
    request: async () => { throw new Error('HTTPS must remain inert'); },
  });
}

const NETWORK = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
const REGION_LINK = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/${REGION}`;
const SUBNETWORK = `${REGION_LINK}/subnetworks/${GCP_IDENTITY.subnet}`;

const FOREIGN_PARENT_CASES = Object.freeze([
  ['artifact-registry', {
    format: 'DOCKER', mode: 'STANDARD_REPOSITORY', location: REGION,
    name: `projects/foreign-project/locations/${REGION}/repositories/${GCP_IDENTITY.repository}`,
    description: 'Hong Kong Buddy production containers',
  }],
  ['vpc', {
    name: GCP_IDENTITY.network,
    selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/global/networks/${GCP_IDENTITY.network}`,
    autoCreateSubnetworks: false, routingConfig: { routingMode: 'REGIONAL' },
  }],
  ['subnet', {
    name: GCP_IDENTITY.subnet,
    selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/regions/${REGION}/subnetworks/${GCP_IDENTITY.subnet}`,
    region: `https://www.googleapis.com/compute/v1/projects/foreign-project/regions/${REGION}`,
    network: `https://www.googleapis.com/compute/v1/projects/foreign-project/global/networks/${GCP_IDENTITY.network}`,
    ipCidrRange: '10.24.0.0/26', privateIpGoogleAccess: true,
  }],
  ['psa-range', {
    name: GCP_IDENTITY.psaRange,
    selfLink: `https://www.googleapis.com/compute/v1/projects/foreign-project/global/addresses/${GCP_IDENTITY.psaRange}`,
    address: '10.25.0.0', prefixLength: 16, purpose: 'VPC_PEERING',
    addressType: 'INTERNAL', status: 'RESERVED',
    network: `https://www.googleapis.com/compute/v1/projects/foreign-project/global/networks/${GCP_IDENTITY.network}`,
  }],
]);

test('same-suffix foreign parents fail every direct comparator', async (t) => {
  const plane = comparePlane();
  for (const [id, value] of FOREIGN_PARENT_CASES) {
    await t.test(id, () => assert.equal(plane.compare(id, value), false));
  }
});

test('read plus ensureExactResource never adopts same-suffix foreign parents', async (t) => {
  for (const [id, value] of FOREIGN_PARENT_CASES) {
    await t.test(id, async () => {
      let mutations = 0;
      const plane = comparePlane(async () => structuredClone(value));
      await assert.rejects(
        () => ensureExactResource({
          id, mutate: true,
          read: () => plane.read(id),
          create: async () => { mutations += 1; return {}; },
          compare: (readback) => plane.compare(id, readback),
        }),
        (error) => error.code === 'RESOURCE_DRIFT',
      );
      assert.equal(mutations, 0);
    });
  }
});

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
    }],
    routes: [], addresses,
  });
}

function regionalAddressLink(name) {
  return `${REGION_LINK}/addresses/${name}`;
}

function globalAddressLink(name) {
  return `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${name}`;
}

const LEGAL_INTERNAL_ADDRESSES = Object.freeze([
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

test('all seven installed Compute v1 INTERNAL address shapes are accepted', async (t) => {
  for (const [purpose, address] of LEGAL_INTERNAL_ADDRESSES) {
    await t.test(purpose, () => assert.doesNotThrow(() => addressAudit([address])));
  }
});

test('IN_USE ranges participate in overlap while external NAT_AUTO is excluded', () => {
  const inUse = LEGAL_INTERNAL_ADDRESSES.find(([purpose]) => purpose === 'IPSEC_INTERCONNECT')[1];
  assert.throws(
    () => addressAudit([inUse], '192.168.20.0/24'),
    (error) => error.code === 'CIDR_OVERLAP',
  );
  assert.doesNotThrow(() => addressAudit([{
    name: 'external-nat-auto', purpose: 'NAT_AUTO', address: '10.250.0.1',
    ipVersion: 'IPV4', networkTier: 'STANDARD', addressType: 'EXTERNAL',
    status: 'IN_USE', region: REGION_LINK,
    selfLink: regionalAddressLink('external-nat-auto'),
  }]));
});

test('INTERNAL address validation rejects purpose, prefix, scope, selector, and status ambiguity', async (t) => {
  const invalid = [
    ['internal NAT_AUTO', {
      name: 'nat-auto', purpose: 'NAT_AUTO', address: '192.168.60.0', prefixLength: 24,
      addressType: 'INTERNAL', status: 'RESERVED', region: REGION_LINK, network: NETWORK,
    }],
    ['internal CROSS_SITE_NETWORK', {
      name: 'cross-site', purpose: 'CROSS_SITE_NETWORK', address: '192.168.60.0', prefixLength: 24,
      addressType: 'INTERNAL', status: 'RESERVED', region: REGION_LINK, network: NETWORK,
    }],
    ['internal PRIVATE_NAT', {
      name: 'private-nat', purpose: 'PRIVATE_NAT', address: '192.168.60.0', prefixLength: 24,
      addressType: 'INTERNAL', status: 'RESERVED', region: REGION_LINK, network: NETWORK,
    }],
    ['unknown purpose', {
      name: 'unknown-purpose', purpose: 'UNKNOWN', address: '192.168.60.0', prefixLength: 24,
      addressType: 'INTERNAL', status: 'IN_USE', region: REGION_LINK, network: NETWORK,
    }],
    ['single with prefix', {
      ...LEGAL_INTERNAL_ADDRESSES[0][1], name: 'single-prefix', prefixLength: 32,
      selfLink: regionalAddressLink('single-prefix'),
    }],
    ['range prefix 31', {
      ...LEGAL_INTERNAL_ADDRESSES[3][1], name: 'range-prefix-31', address: '192.168.60.0', prefixLength: 31,
      selfLink: regionalAddressLink('range-prefix-31'),
    }],
    ['range non-base address', {
      ...LEGAL_INTERNAL_ADDRESSES[3][1], name: 'range-non-base', address: '192.168.60.1', prefixLength: 24,
      selfLink: regionalAddressLink('range-non-base'),
    }],
    ['DNS network selector', {
      ...LEGAL_INTERNAL_ADDRESSES[0][1], name: 'dns-network', subnetwork: undefined, network: NETWORK,
      selfLink: regionalAddressLink('dns-network'),
    }],
    ['IPSEC subnetwork selector', {
      ...LEGAL_INTERNAL_ADDRESSES[3][1], name: 'ipsec-subnetwork', network: undefined, subnetwork: SUBNETWORK,
      selfLink: regionalAddressLink('ipsec-subnetwork'),
    }],
    ['PSC regional scope', {
      ...LEGAL_INTERNAL_ADDRESSES[4][1], name: 'psc-regional', region: REGION_LINK,
      selfLink: globalAddressLink('psc-regional'),
    }],
    ['SERVERLESS network selector', {
      ...LEGAL_INTERNAL_ADDRESSES[5][1], name: 'serverless-network', network: NETWORK,
      selfLink: regionalAddressLink('serverless-network'),
    }],
    ['RESERVING status', {
      ...LEGAL_INTERNAL_ADDRESSES[6][1], name: 'reserving', status: 'RESERVING',
      selfLink: globalAddressLink('reserving'),
    }],
    ['unknown status', {
      ...LEGAL_INTERNAL_ADDRESSES[6][1], name: 'unknown-status', status: 'UNKNOWN',
      selfLink: globalAddressLink('unknown-status'),
    }],
  ];
  for (const [name, raw] of invalid) {
    const address = Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined));
    await t.test(name, () => assert.throws(
      () => addressAudit([address]),
      (error) => error.code === 'CIDR_AUDIT_INVALID',
    ));
  }
});

test('candidate service principal hash remains bound to the reviewed private invoker', () => {
  const plan = buildReleasePlan(releaseInput());
  assert.equal(
    plan.candidateAccess.subjectSha256,
    createHash('sha256').update('admin@motionexp.com').digest('hex'),
  );
  assert.equal(plan.serviceOrigin, STABLE_ORIGIN);
});

test('active operator design and plan documents describe only the separate private candidate contract', async () => {
  const documents = await Promise.all([
    readFile(new URL('../README.md', import.meta.url), 'utf8'),
    readFile(new URL('../infra/gcp/README.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/specs/2026-08-26-production-v1-shared-project-isolation-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/plans/2026-08-26-production-v1-gcp-launch.md', import.meta.url), 'utf8'),
    readFile(new URL('../../docs/superpowers/plans/2026-08-26-production-v1-shared-project-isolation.md', import.meta.url), 'utf8'),
  ]);
  const obsoleteStates = [
    ['private', 'bootstrap', '100'].join('-'),
    ['prior-stable-100', 'candidate-0'].join('/'),
  ];
  const obsoleteSameServicePatterns = [
    /Candidate deploys at zero stable traffic/i,
    /candidate(?: revision)? at 0%/i,
    /assign the candidate 0%/i,
    /route (?:the )?candidate to stable 100%/i,
    /remov(?:e|es|ed|ing) (?:the |its )?candidate tag/i,
    /tagged (?:bootstrap traffic|100% candidate)/i,
    /https:\/\/candidate-[^\s`]+---hkbuddy-v1-api-(?!candidate-)[^\s`]+\.asia-east2\.run\.app/i,
  ];
  for (const document of documents) {
    assert.match(document, /hkbuddy-v1-api-candidate/);
    assert.match(document, /candidate-service-private-100/);
    assert.match(document, /untagged at\s+0%/);
    assert.match(document, /final mutation/);
    for (const obsolete of obsoleteStates) assert.equal(document.includes(obsolete), false);
    for (const obsolete of obsoleteSameServicePatterns) assert.doesNotMatch(document, obsolete);
  }
});
