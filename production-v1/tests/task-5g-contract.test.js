import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import test from 'node:test';

import { createGcloudExecutor } from '../scripts/gcp-provision.js';
import * as provisionContract from '../scripts/gcp-provision.js';
import * as releaseContract from '../scripts/gcp-release.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';

const PROJECT = GCP_IDENTITY.projectId;
const REGION = GCP_IDENTITY.region;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const STABLE_REVISION = `${GCP_IDENTITY.service}-${'a'.repeat(12)}`;
const PRIOR_REVISION = `${GCP_IDENTITY.service}-${'b'.repeat(12)}`;
const CANDIDATE_REVISION = `${GCP_IDENTITY.candidateService}-${'c'.repeat(12)}`;
const CANDIDATE_TAG = `candidate-${'c'.repeat(12)}`;
const CANDIDATE_TAG_URL = `https://${CANDIDATE_TAG}---${GCP_IDENTITY.candidateService}-${PROJECT_NUMBER}.${REGION}.run.app`;
const STABLE_URL = `https://${GCP_IDENTITY.service}-${PROJECT_NUMBER}.${REGION}.run.app`;

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function rejectingGcloud(stderr) {
  return createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });
}

function rejectingGcloudWithCode(stderr, code) {
  return createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      error.code = code;
      throw error;
    },
  });
}

test('SDK 553 canonical Cloud Run service and job absence is exact', async (t) => {
  const serviceArgv = (service) => [
    'run', 'services', 'describe', service,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ];
  const jobArgv = (job) => [
    'run', 'jobs', 'describe', job,
    `--project=${PROJECT}`, `--region=${REGION}`, '--format=json',
  ];

  for (const [name, argv, stderr, expectedCode] of [
    ...[GCP_IDENTITY.service, GCP_IDENTITY.candidateService].map((service) => [
      `service ${service}`,
      serviceArgv(service),
      `ERROR: (gcloud.run.services.describe) Cannot find service [${service}]\r\n`,
      'CLOUD_RUN_SERVICE_NOT_FOUND',
    ]),
    ...Object.values(GCP_IDENTITY.jobs).map((job) => [
      `job ${job}`,
      jobArgv(job),
      `ERROR: (gcloud.run.jobs.describe) Cannot find job [${job}].\n`,
      'NOT_FOUND',
    ]),
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rejectingGcloud(stderr)(argv),
        (error) => error.code === expectedCode,
      );
    });
  }

  const stableArgv = serviceArgv(GCP_IDENTITY.service);
  const canonical = `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]`;
  for (const [name, argv, stderr] of [
    ['obsolete message', stableArgv, `ERROR: (gcloud.run.services.describe) Service [${GCP_IDENTITY.service}] could not be found.`],
    ['generic NOT_FOUND', stableArgv, `NOT_FOUND: ${GCP_IDENTITY.service}`],
    ['generic 404', stableArgv, `404: ${GCP_IDENTITY.service}`],
    ['extra prefix', stableArgv, `proxy: ${canonical}`],
    ['extra suffix', stableArgv, `${canonical} retry`],
    ['two trailing newlines', stableArgv, `${canonical}\n\n`],
    ['wrong project', stableArgv.with(4, '--project=foreign-project'), `${canonical}\n`],
    ['wrong region', stableArgv.with(5, '--region=us-central1'), `${canonical}\n`],
    ['wrong resource', stableArgv.with(3, GCP_IDENTITY.candidateService), `${canonical}\n`],
    ['wrong format', stableArgv.with(6, '--format=yaml'), `${canonical}\n`],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => rejectingGcloud(stderr)(argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }

  await assert.rejects(
    () => rejectingGcloudWithCode('generic NOT_FOUND from an unrelated transport', 'NOT_FOUND')(
      stableArgv,
    ),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
});

test('traffic row representations validate before exact phase comparison', async (t) => {
  const {
    normalizeControlledTraffic,
    normalizeInternalTraffic,
    normalizeCloudRunV1Traffic,
    assertExactTraffic,
  } = releaseContract;
  for (const [name, value] of Object.entries({
    normalizeControlledTraffic,
    normalizeInternalTraffic,
    normalizeCloudRunV1Traffic,
    assertExactTraffic,
  })) assert.equal(typeof value, 'function', `${name} must be exported`);

  const candidate = [{ revision: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }];
  const staged = [
    { revision: PRIOR_REVISION, tag: null, percent: 100 },
    { revision: STABLE_REVISION, tag: null, percent: 0 },
  ];
  const promoted = [{ revision: STABLE_REVISION, tag: null, percent: 100 }];

  assert.deepEqual(normalizeControlledTraffic([
    { revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 },
  ], { service: GCP_IDENTITY.candidateService }), candidate);
  assert.deepEqual(normalizeInternalTraffic(candidate, {
    service: GCP_IDENTITY.candidateService,
  }), candidate);
  assert.deepEqual(normalizeCloudRunV1Traffic([
    {
      revisionName: CANDIDATE_REVISION,
      tag: CANDIDATE_TAG,
      url: CANDIDATE_TAG_URL,
      percent: 100,
    },
  ], { service: GCP_IDENTITY.candidateService }), candidate);
  assert.deepEqual(normalizeCloudRunV1Traffic([
    { revisionName: PRIOR_REVISION, percent: 100 },
    { revisionName: STABLE_REVISION, percent: 0 },
  ], { service: GCP_IDENTITY.service }), staged);
  assert.equal(assertExactTraffic(promoted, {
    kind: 'internal', service: GCP_IDENTITY.service, expected: promoted,
  }), true);

  const malformedPercent = [
    undefined, '100', Number.NaN, Number.POSITIVE_INFINITY, 99.5, -1, 101,
  ];
  for (const percent of malformedPercent) {
    await t.test(`controlled percent ${String(percent)}`, () => {
      assert.throws(() => normalizeControlledTraffic([
        { revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent },
      ], { service: GCP_IDENTITY.candidateService }));
    });
    await t.test(`internal percent ${String(percent)}`, () => {
      assert.throws(() => normalizeInternalTraffic([
        { revision: STABLE_REVISION, tag: null, percent },
      ], { service: GCP_IDENTITY.service }));
    });
    await t.test(`raw percent ${String(percent)}`, () => {
      assert.throws(() => normalizeCloudRunV1Traffic([
        { revisionName: STABLE_REVISION, percent },
      ], { service: GCP_IDENTITY.service }));
    });
  }

  for (const [name, rows, kind, service] of [
    ['controlled unknown key', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, url: CANDIDATE_TAG_URL }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled revision alias', [{ revision: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled latestRevision', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, latestRevision: true }], 'controlled', GCP_IDENTITY.candidateService],
    ['controlled configurationName', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100, configurationName: 'foreign' }], 'controlled', GCP_IDENTITY.candidateService],
    ['internal missing explicit tag', [{ revision: STABLE_REVISION, percent: 100 }], 'internal', GCP_IDENTITY.service],
    ['internal revisionName alias', [{ revisionName: STABLE_REVISION, tag: null, percent: 100 }], 'internal', GCP_IDENTITY.service],
    ['raw revision alias', [{ revision: STABLE_REVISION, percent: 100 }], 'raw-v1', GCP_IDENTITY.service],
    ['raw tag without URL', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['raw URL without tag', [{ revisionName: CANDIDATE_REVISION, url: CANDIDATE_TAG_URL, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['raw malformed tag URL', [{ revisionName: CANDIDATE_REVISION, tag: CANDIDATE_TAG, url: `${CANDIDATE_TAG_URL}/extra`, percent: 100 }], 'raw-v1', GCP_IDENTITY.candidateService],
    ['duplicate revision', [{ revision: PRIOR_REVISION, tag: null, percent: 50 }, { revision: PRIOR_REVISION, tag: null, percent: 50 }], 'internal', GCP_IDENTITY.service],
    ['sum not 100', [{ revision: PRIOR_REVISION, tag: null, percent: 99 }], 'internal', GCP_IDENTITY.service],
  ]) {
    await t.test(name, () => {
      const normalizer = {
        controlled: normalizeControlledTraffic,
        internal: normalizeInternalTraffic,
        'raw-v1': normalizeCloudRunV1Traffic,
      }[kind];
      assert.throws(() => normalizer(rows, { service }));
    });
  }

  await t.test('hidden foreign zero-percent row is not discarded', () => {
    assert.throws(() => assertExactTraffic([
      ...promoted,
      { revision: `${GCP_IDENTITY.service}-${'d'.repeat(12)}`, tag: null, percent: 0 },
    ], {
      kind: 'internal', service: GCP_IDENTITY.service, expected: promoted,
    }));
  });
});

test('SDK 553 update-traffic acknowledgement is exact and remains non-authoritative', () => {
  const { validateTrafficTargetAcknowledgement } = releaseContract;
  assert.equal(typeof validateTrafficTargetAcknowledgement, 'function');
  const valid = [{
    displayPercent: '100%',
    displayRevisionId: STABLE_REVISION,
    displayTags: '',
    key: STABLE_REVISION,
    latestRevision: false,
    revisionName: STABLE_REVISION,
    serviceUrl: STABLE_URL,
    specPercent: '100',
    specTags: '-',
    statusPercent: '100',
    statusTags: '-',
    tags: [],
    urls: [],
  }];
  assert.equal(validateTrafficTargetAcknowledgement(valid, {
    revision: STABLE_REVISION,
    serviceUrl: STABLE_URL,
  }), true);
  for (const drift of [
    [],
    [...valid, structuredClone(valid[0])],
    [{ ...valid[0], extra: true }],
    [{ ...valid[0], revisionName: PRIOR_REVISION }],
    [{ ...valid[0], latestRevision: true }],
    [{ ...valid[0], statusPercent: 0 }],
    [{ ...valid[0], serviceUrl: `${STABLE_URL}/extra` }],
  ]) assert.throws(() => validateTrafficTargetAcknowledgement(drift, {
    revision: STABLE_REVISION,
    serviceUrl: STABLE_URL,
  }));
});

test('authoritative traffic receipt rejects coercion and hidden zero-percent revisions', () => {
  const { validateTrafficReceipt } = releaseContract;
  assert.equal(validateTrafficReceipt({
    service: GCP_IDENTITY.service,
    invokerIamDisabled: false,
    traffic: [{ revision: STABLE_REVISION, tag: null, percent: 100 }],
  }, { revision: STABLE_REVISION }), true);

  for (const traffic of [
    [{ revision: STABLE_REVISION, tag: null, percent: '100' }],
    [
      { revision: STABLE_REVISION, tag: null, percent: 100 },
      { revision: PRIOR_REVISION, tag: null, percent: 0 },
    ],
    [{ revision: STABLE_REVISION, percent: 100 }],
    [{ revisionName: STABLE_REVISION, tag: null, percent: 100 }],
  ]) assert.throws(() => validateTrafficReceipt({
    service: GCP_IDENTITY.service,
    invokerIamDisabled: false,
    traffic,
  }, { revision: STABLE_REVISION }));
});

test('Compute Address inventory accepts only the complete project-bound matrix', async (t) => {
  const { validateComputeAddressInventory } = provisionContract;
  assert.equal(typeof validateComputeAddressInventory, 'function');
  const host = `https://www.googleapis.com/compute/v1/projects/${PROJECT}`;
  const network = `${host}/global/networks/default`;
  const region = `${host}/regions/${REGION}`;
  const subnet = (name, overrides = {}) => ({
    name,
    selfLink: `${region}/subnetworks/${name}`,
    network,
    region,
    ipCidrRange: '10.2.0.0/24',
    ...overrides,
  });
  const subnets = [
    subnet('default'),
    subnet('external-vm', {
      ipCidrRange: '10.7.0.0/24',
      ipv6AccessType: 'EXTERNAL',
      stackType: 'IPV4_IPV6',
      purpose: 'PRIVATE',
      ipv6GceEndpoint: 'VM_ONLY',
      externalIpv6Prefix: '2001:db8:1::/64',
    }),
    subnet('external-netlb', {
      ipCidrRange: '10.8.0.0/24',
      ipv6AccessType: 'EXTERNAL',
      stackType: 'IPV4_IPV6',
      purpose: 'PRIVATE',
      ipv6GceEndpoint: 'VM_AND_FR',
      externalIpv6Prefix: '2001:db8:2::/64',
    }),
  ];
  const address = (name, fields) => ({
    name,
    address: fields.address,
    selfLink: fields.region === undefined
      ? `${host}/global/addresses/${name}`
      : `${fields.region}/addresses/${name}`,
    addressType: fields.addressType,
    ipVersion: fields.ipVersion,
    networkTier: fields.networkTier,
    status: fields.status,
    kind: 'compute#address',
    ...fields,
  });
  const internal = (name, fields) => address(name, {
    addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
    status: 'RESERVED', ...fields,
  });
  const external = (name, fields) => address(name, {
    addressType: 'EXTERNAL', status: 'IN_USE', ...fields,
  });
  const addresses = [
    internal('dns', { purpose: 'DNS_RESOLVER', address: '10.2.0.5', region, subnetwork: subnets[0].selfLink }),
    internal('gce', { purpose: 'GCE_ENDPOINT', address: '10.2.0.6', region, subnetwork: subnets[0].selfLink }),
    internal('shared-vip', { purpose: 'SHARED_LOADBALANCER_VIP', address: '10.2.0.7', region, subnetwork: subnets[0].selfLink, status: 'IN_USE' }),
    internal('ipsec', { purpose: 'IPSEC_INTERCONNECT', address: '10.3.0.0', prefixLength: 24, region, network }),
    internal('psc', { purpose: 'PRIVATE_SERVICE_CONNECT', address: '10.4.0.1', network }),
    internal('serverless', { purpose: 'SERVERLESS', address: '10.5.0.0', prefixLength: 24, region }),
    internal('peering', { purpose: 'VPC_PEERING', address: '10.6.0.0', prefixLength: 16, network }),
    external('external-v4-regional', { address: '203.0.113.1', ipVersion: 'IPV4', networkTier: 'PREMIUM', region }),
    external('external-v4-pdp', {
      address: '203.0.113.2', ipVersion: 'IPV4', networkTier: 'STANDARD', region,
      ipCollection: `${region}/publicDelegatedPrefixes/hkbuddy-pdp`,
    }),
    external('external-v4-global', { address: '203.0.113.3', ipVersion: 'IPV4', networkTier: 'PREMIUM' }),
    external('external-nat', { address: '203.0.113.4', ipVersion: 'IPV4', networkTier: 'STANDARD', region, purpose: 'NAT_AUTO' }),
    external('external-v6-global', { address: '2001:db8:ffff::1', ipVersion: 'IPV6', networkTier: 'PREMIUM' }),
    external('external-v6-vm', {
      address: '2001:db8:1:0:1::', ipVersion: 'IPV6', networkTier: 'PREMIUM',
      region, prefixLength: 96, ipv6EndpointType: 'VM', subnetwork: subnets[1].selfLink,
    }),
    external('external-v6-netlb', {
      address: '2001:db8:2:0:1::', ipVersion: 'IPV6', networkTier: 'STANDARD',
      region, prefixLength: 96, ipv6EndpointType: 'NETLB', subnetwork: subnets[2].selfLink,
    }),
  ];
  assert.equal(validateComputeAddressInventory({
    addresses, networks: [{ name: 'default', selfLink: network }], subnets,
  }), true);

  const reject = (name, mutate) => t.test(name, () => {
    const candidate = structuredClone(addresses);
    mutate(candidate);
    assert.throws(() => validateComputeAddressInventory({
      addresses: candidate, networks: [{ name: 'default', selfLink: network }], subnets,
    }), (error) => error.code === 'CIDR_AUDIT_INVALID');
  });
  await reject('duplicate name', (rows) => { rows[1].name = rows[0].name; });
  await reject('duplicate selfLink', (rows) => { rows[1].selfLink = rows[0].selfLink; });
  await reject('foreign selfLink', (rows) => { rows[0].selfLink = rows[0].selfLink.replace(PROJECT, 'foreign-project'); });
  await reject('missing ipVersion', (rows) => { delete rows[0].ipVersion; });
  await reject('internal STANDARD tier', (rows) => { rows[0].networkTier = 'STANDARD'; });
  await reject('inapplicable null field', (rows) => { rows[0].network = null; });
  await reject('subnet single outside primary CIDR', (rows) => { rows[0].address = '10.9.0.1'; });
  await reject('network range missing network', (rows) => { delete rows[3].network; });
  await reject('selector-free range gains a selector', (rows) => { rows[5].network = network; });
  await reject('global IPv4 STANDARD tier', (rows) => { rows[9].networkTier = 'STANDARD'; });
  await reject('foreign PDP project', (rows) => { rows[8].ipCollection = rows[8].ipCollection.replace(PROJECT, 'foreign-project'); });
  await reject('NAT_AUTO gains ipCollection', (rows) => { rows[10].ipCollection = `${region}/publicDelegatedPrefixes/hkbuddy-pdp`; });
  await reject('global IPv6 gains prefix', (rows) => { rows[11].prefixLength = 96; });
  await reject('regional IPv6 selector-free', (rows) => { delete rows[12].subnetwork; });
  await reject('regional IPv6 wrong prefix', (rows) => { rows[12].prefixLength = 64; });
  await reject('regional IPv6 non-base address', (rows) => { rows[12].address = '2001:db8:1:0:1::1'; });
  await reject('regional IPv6 outside subnet prefix', (rows) => { rows[12].address = '2001:db8:9:0:1::'; });
  await reject('NETLB on VM_ONLY subnet', (rows) => { rows[13].subnetwork = subnets[1].selfLink; });
  await t.test('legacy impossible purpose is not an IPv6 endpoint mode', () => {
    const legacySubnets = structuredClone(subnets);
    legacySubnets[1].purpose = 'VM_ONLY';
    delete legacySubnets[1].ipv6GceEndpoint;
    assert.throws(() => validateComputeAddressInventory({
      addresses, networks: [{ name: 'default', selfLink: network }], subnets: legacySubnets,
    }), (error) => error.code === 'CIDR_AUDIT_INVALID');
  });
});

test('managed PSA Address describe requires the same explicit matrix fields', () => {
  const plane = new provisionContract.GcpControlPlane({
    contract: { resources: { serviceAccounts: [] } },
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const exact = {
    name: GCP_IDENTITY.psaRange,
    selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`,
    address: '10.25.0.0',
    prefixLength: 16,
    addressType: 'INTERNAL',
    ipVersion: 'IPV4',
    networkTier: 'PREMIUM',
    status: 'RESERVED',
    purpose: 'VPC_PEERING',
    network: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
  };
  assert.equal(plane.compare('psa-range', exact), true);
  for (const candidate of [
    { ...exact, ipVersion: undefined },
    { ...exact, networkTier: undefined },
    { ...exact, prefixLength: '16' },
    { ...exact, kind: 'compute#forwardingRule' },
  ]) assert.equal(plane.compare('psa-range', candidate), false);
});

test('Service Account list and describe identities bind email, resource name, and project exactly', async (t) => {
  const email = GCP_IDENTITY.serviceAccounts.runtime;
  const displayName = 'Hong Kong Buddy Cloud Run runtime';
  const exactIdentity = {
    email,
    name: `projects/${PROJECT}/serviceAccounts/${email}`,
    projectId: PROJECT,
    displayName,
    disabled: false,
    oauth2ClientId: '123456789012345678901',
    uniqueId: '123456789012345678901',
  };

  assert.equal(provisionContract.validateServiceAccountIdentity(exactIdentity, {
    email, displayName,
  }), true);

  const plane = new provisionContract.GcpControlPlane({
    contract: { resources: { serviceAccounts: [{
      id: 'hkbuddy-v1-runtime', email, displayName,
    }] } },
    gcloud: async () => structuredClone(exactIdentity),
    request: async () => { throw new Error('REST must not run'); },
  });
  assert.deepEqual(await plane.read('service-account:hkbuddy-v1-runtime'), {
    status: 'present', value: exactIdentity,
  });
  assert.equal(plane.compare('service-account:hkbuddy-v1-runtime', exactIdentity), true);

  for (const [name, mutate] of [
    ['missing name', (value) => { delete value.name; }],
    ['foreign parent', (value) => { value.name = value.name.replace(PROJECT, 'foreign-project'); }],
    ['wildcard parent', (value) => { value.name = `projects/-/serviceAccounts/${email}`; }],
    ['uniqueId parent', (value) => { value.name = `projects/${PROJECT}/serviceAccounts/${value.uniqueId}`; }],
    ['case drift', (value) => { value.name = value.name.replace('/serviceAccounts/', '/serviceaccounts/'); }],
    ['path drift', (value) => { value.name = value.name.replace('/serviceAccounts/', '/serviceAccounts//'); }],
    ['email mismatch', (value) => { value.email = GCP_IDENTITY.serviceAccounts.build; }],
    ['missing projectId', (value) => { delete value.projectId; }],
    ['wrong projectId', (value) => { value.projectId = 'foreign-project'; }],
    ['disabled', (value) => { value.disabled = true; }],
    ['malformed disabled', (value) => { value.disabled = 'false'; }],
    ['displayName drift', (value) => { value.displayName = `${displayName} drift`; }],
    ['OAuth drift', (value) => { value.oauth2ClientId = 'not-numeric'; }],
    ['key drift', (value) => { value.oauth2ClientId = 'key:123'; }],
  ]) {
    await t.test(name, () => {
      const candidate = structuredClone(exactIdentity);
      mutate(candidate);
      assert.throws(
        () => provisionContract.validateServiceAccountIdentity(candidate, { email, displayName }),
        (error) => error.code === 'SERVICE_ACCOUNT_IDENTITY_INVALID',
      );
    });
  }
});

test('managed Service Account inventory binds each managed id to its exact expected email', () => {
  const { validateManagedServiceAccountInventory } = provisionContract;
  assert.equal(typeof validateManagedServiceAccountInventory, 'function');
  const expected = Object.values(GCP_IDENTITY.serviceAccounts).map((email) => ({
    id: email.split('@')[0], email,
  }));
  const rows = expected.map(({ email }) => ({
    email,
    name: `projects/${PROJECT}/serviceAccounts/${email}`,
    projectId: PROJECT,
  }));
  assert.equal(validateManagedServiceAccountInventory(rows, expected), true);
  const drift = structuredClone(rows);
  drift[0].email = `${expected[0].id}@foreign-project.iam.gserviceaccount.com`;
  drift[0].name = `projects/${PROJECT}/serviceAccounts/${drift[0].email}`;
  assert.throws(
    () => validateManagedServiceAccountInventory(drift, expected),
    (error) => ['LIST_RESPONSE_AMBIGUOUS', 'SERVICE_ACCOUNT_IDENTITY_INVALID'].includes(error.code),
  );
});

test('release archive freezes the exact raw Cloud Build Git blob beside the archive', async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), 'hkbuddy-task-5g-frozen-config-'));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const repositoryRoot = join(fixtureRoot, 'repository');
  await mkdir(join(repositoryRoot, 'production-v1', 'data', 'knowledge'), { recursive: true });
  const rawBuildConfig = Buffer.from('steps:\r\n  - id: exact-git-blob\r\n\r\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'Dockerfile'), 'FROM scratch\n');
  await writeFile(join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'), rawBuildConfig);
  await writeFile(
    join(repositoryRoot, 'production-v1', 'data', 'knowledge', 'hkbu-v1.json'),
    '{"sources":[],"claims":[]}\n',
  );
  const git = (...argv) => execFileSync('git', argv, {
    cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--quiet');
  git('config', 'user.name', 'Task 5G Contract');
  git('config', 'user.email', 'task-5g@example.invalid');
  git('config', 'core.autocrlf', 'false');
  git('add', 'production-v1');
  git('commit', '--quiet', '-m', 'fixture');
  const releaseSha = git('rev-parse', 'HEAD');

  await writeFile(
    join(repositoryRoot, 'production-v1', 'cloudbuild.yaml'),
    'steps:\n  - id: mutable-worktree-drift\n',
  );
  git('update-index', '--assume-unchanged', 'production-v1/cloudbuild.yaml');

  const result = await releaseContract.prepareReleaseArchive({
    repositoryRoot,
    releaseSha,
    destination: join(fixtureRoot, 'source.tar.gz'),
  });
  const expectedHash = sha256(rawBuildConfig);
  assert.equal(result.buildConfigSha256, expectedHash);
  assert.equal(
    basename(result.buildConfig),
    `${releaseSha}.${expectedHash}.cloudbuild.yaml`,
  );
  assert.deepEqual(await readFile(result.buildConfig), rawBuildConfig);
  assert.equal(result.buildConfig.startsWith(repositoryRoot), false);
});
