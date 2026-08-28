import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  EXPECTED_PROVISION_STEPS,
  GcpControlPlane,
  assertExactCustomRoleDefinitions,
  assertExactManagedIamPolicies,
  assertNoUserManagedServiceAccountKeys,
  assertCidrAvailable,
  assertResourceContract,
  createAuthenticatedRequest,
  createDefaultGcloudTextExecutor,
  createGcloudExecutor,
  createGcloudAuthenticatedRequest,
  ensureExactResource,
  loadResourceContract,
  monitoringGroupByField,
  runGcpProvision,
} from '../scripts/gcp-provision.js';
import { runGcpPreflight } from '../scripts/gcp-preflight.js';
import {
  GCP_IDENTITY,
  GCP_OBSOLETE_EXECUTABLE_IDENTITIES,
} from '../src/gcp-identity.js';

const CONTRACT_URL = new URL('../infra/gcp/resource-contract.json', import.meta.url);
const OPERATOR_README_URL = new URL('../infra/gcp/README.md', import.meta.url);
const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const CHANNEL = `projects/${PROJECT_NUMBER}/notificationChannels/123456789`;
const NUMERIC_CHANNEL = CHANNEL;
const ASSET_PROJECT = `projects/${PROJECT_NUMBER}`;
const ASSET_PROJECT_PARENT = `//cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}`;
const ASSET_PROJECT_TYPE = 'cloudresourcemanager.googleapis.com/Project';
const ASSET_READ_MASK = 'name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state';
const ACCEPTANCE_BUCKET_METADATA_ROLE = Object.freeze({
  id: 'hkbuddyV1AcceptanceBucketMetadataReader',
  name: `projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
  title: 'HK Buddy acceptance bucket metadata reader',
  description: 'Read fixed media bucket metadata for dependency acceptance',
  includedPermissions: ['storage.buckets.get'],
  stage: 'GA',
});

const AUTOMATIC_PROJECT_BINDINGS = Object.freeze([
  { member: 'user:admin@motionexp.com', role: 'roles/owner', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloudbuild.iam.gserviceaccount.com', role: 'roles/cloudbuild.serviceAgent', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-artifactregistry.iam.gserviceaccount.com', role: 'roles/artifactregistry.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@compute-system.iam.gserviceaccount.com', role: 'roles/compute.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@service-networking.iam.gserviceaccount.com', role: 'roles/servicenetworking.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloud-sql.iam.gserviceaccount.com', role: 'roles/cloudsql.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@serverless-robot-prod.iam.gserviceaccount.com', role: 'roles/run.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-aiplatform.iam.gserviceaccount.com', role: 'roles/aiplatform.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-speech.iam.gserviceaccount.com', role: 'roles/speech.serviceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-monitoring-notification.iam.gserviceaccount.com', role: 'roles/monitoring.notificationServiceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-logging.iam.gserviceaccount.com', role: 'roles/logging.serviceAgent', required: false },
  { member: 'serviceAccount:__PROJECT_NUMBER__@cloudbuild.gserviceaccount.com', role: 'roles/cloudbuild.builds.builder', required: false },
  { member: 'serviceAccount:__PROJECT_NUMBER__@cloudservices.gserviceaccount.com', role: 'roles/compute.instanceGroupManagerServiceAgent', required: false },
]);

const OFFICIAL_LOG_FILTERS = Object.freeze({
  'sql-backup-failure': `logName="projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event" AND protoPayload.methodName="cloudsql.instances.automatedBackup" AND resource.type="cloudsql_database" AND protoPayload.metadata.windowStatus=("STATUS_FAILED" OR "STATUS_ATTEMPT_FAILED")`,
  'sql-failover': 'resource.type="cloudsql_database" AND ((log_id("cloudaudit.googleapis.com/activity") AND protoPayload.methodName="cloudsql.instances.failover" AND operation.last=true) OR (log_id("cloudaudit.googleapis.com/system_event") AND protoPayload.methodName="cloudsql.instances.autoFailover"))',
  'sql-restart': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloudsql_database" AND protoPayload.methodName="cloudsql.instances.restart" AND operation.last=true',
  'cloud-build-failure': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="build" AND protoPayload.methodName="google.devtools.cloudbuild.v1.CloudBuild.CreateBuild" AND operation.last=true AND protoPayload.response.status=("FAILURE" OR "INTERNAL_ERROR" OR "TIMEOUT" OR "EXPIRED")',
  'run-deployment-failure': 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloud_run_revision" AND protoPayload.methodName=("google.cloud.run.v2.Services.CreateService" OR "google.cloud.run.v2.Services.UpdateService") AND protoPayload.status.code!=0',
});

function clone(value) {
  return structuredClone(value);
}

async function contractFixture() {
  return JSON.parse(await readFile(CONTRACT_URL, 'utf8'));
}

function cloudAsset(overrides = {}) {
  return {
    name: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`,
    assetType: 'run.googleapis.com/Service',
    project: ASSET_PROJECT,
    displayName: GCP_IDENTITY.service,
    description: '',
    location: 'asia-east2',
    labels: {},
    parentFullResourceName: ASSET_PROJECT_PARENT,
    parentAssetType: ASSET_PROJECT_TYPE,
    state: 'ACTIVE',
    ...overrides,
  };
}

function protectedProjectPolicy(contract) {
  return {
    bindings: contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
  };
}

function notFound() {
  return Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
}

function assetAuditControlPlane({
  contract, assets, enabledApis = ['iam.googleapis.com', 'serviceusage.googleapis.com'],
  gcloudRows = {}, restRows = {}, organizationResponse, billingAccountResponse,
  projectResponse, billingLinkResponse,
}) {
  const gcloudCalls = [];
  const restCalls = [];
  const plane = new GcpControlPlane({
    contract,
    notificationChannel: NUMERIC_CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'projects' && args[1] === 'describe') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
        ...projectResponse,
      };
      if (args[0] === 'organizations' && args[1] === 'describe') {
        if (organizationResponse === null || Array.isArray(organizationResponse)) {
          return organizationResponse;
        }
        return {
          name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
          ...organizationResponse,
        };
      }
      if (args[0] === 'billing' && args[1] === 'accounts') {
        if (billingAccountResponse === null || Array.isArray(billingAccountResponse)) {
          return billingAccountResponse;
        }
        return {
          name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
          ...billingAccountResponse,
        };
      }
      if (args[0] === 'billing' && args[1] === 'projects') return {
        billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
        ...billingLinkResponse,
      };
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return protectedProjectPolicy(contract);
      if (args[0] === 'asset') {
        if (assets instanceof Error) throw assets;
        return assets;
      }
      if (args[0] === 'services' && args[1] === 'list') return enabledApis.map((name) => ({ config: { name } }));
      const key = args.slice(0, 3).join(' ');
      if (Object.hasOwn(gcloudRows, key)) return gcloudRows[key];
      if (args[0] === 'iam' && args.includes('list')) return [];
      throw notFound();
    },
    request: async (input) => {
      restCalls.push(input);
      for (const [needle, value] of Object.entries(restRows)) {
        if (input.url.includes(needle)) return typeof value === 'function' ? value(input) : value;
      }
      throw notFound();
    },
  });
  return { plane, gcloudCalls, restCalls };
}

test('central identity fixes the shared billed project resource island without legacy cloud identities', async () => {
  const contract = await contractFixture();

  assert.equal(Object.isFrozen(GCP_IDENTITY), true);
  assert.equal(GCP_IDENTITY.projectId, 'motion-expert-hk-ltd-webpage');
  assert.equal(GCP_IDENTITY.projectNumber, '582852715831');
  assert.equal(GCP_IDENTITY.assetInventoryConsumerProjectId, 'tech-demo-433408');
  assert.equal(GCP_IDENTITY.service, 'hkbuddy-v1-api');
  assert.equal(GCP_IDENTITY.bucket, 'hkbuddy-v1-582852715831-media');
  assert.equal(GCP_IDENTITY.buildSourceBucket, 'hkbuddy-v1-582852715831-build-source');
  assert.equal(GCP_IDENTITY.network, 'hkbuddy-v1-vpc');
  assert.equal(contract.project.mode, 'existing-billed-shared');
  assert.deepEqual(contract.project.protectedBindings, [
    { member: 'user:admin@motionexp.com', role: 'roles/owner' },
    { member: 'serviceAccount:service-582852715831@compute-system.iam.gserviceaccount.com', role: 'roles/compute.serviceAgent' },
    { member: 'serviceAccount:582852715831@cloudservices.gserviceaccount.com', role: 'roles/editor' },
  ]);
  assert.deepEqual(contract.project.assetInventory, {
    consumerProjectId: 'tech-demo-433408',
    mode: 'read-only-cloud-asset-quota-consumer',
    scope: 'projects/motion-expert-hk-ltd-webpage',
    pageSize: 500,
    readMask: ASSET_READ_MASK,
    orderBy: 'assetType,name',
  });
  assert.equal(contract.project.projectNumber, PROJECT_NUMBER);
  assert.deepEqual(GCP_OBSOLETE_EXECUTABLE_IDENTITIES, [
    'hkbuddy-prod-v1-20260826', '93662314720', 'hkbuddy', 'hkbuddy-api',
    'hkbuddy-pg', 'hkbuddy-prod-vpc', 'hkbuddy-ae2-run',
    'hkbuddy-google-managed-services', 'hkbuddy-runtime', 'hkbuddy-build',
    'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance',
    'hkbuddy-migrate', 'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url',
    'hkbuddy-session-secret', 'hkbuddy-db-bootstrap-state',
    'hkbuddy-legacy-inventory', 'hkbuddy-dependency-acceptance',
    'hkbuddy-llm-smoke', 'hkbuddy-asr-smoke', 'hkbuddy-tts-smoke',
    'hkbuddy-ios-voice-acceptance', 'hkbuddy-prod-v1-20260826-media',
  ]);

  const serialized = JSON.stringify({ identity: GCP_IDENTITY, contract });
  for (const legacyIdentity of [
    'hkbuddy-prod-v1-20260826', '123456789012', 'hkbuddy-api', '"repository":"hkbuddy"',
    'hkbuddy-prod-v1-20260826-media', 'hkbuddy-pg', 'hkbuddy-prod-vpc',
    'hkbuddy-ae2-run', 'hkbuddy-google-managed-services', 'hkbuddy-runtime',
    'hkbuddy-build', 'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance',
    'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url', 'hkbuddy-session-secret',
    'hkbuddy-db-bootstrap-state', 'hkbuddy-legacy-inventory',
    'hkbuddy-dependency-acceptance', 'hkbuddy-llm-smoke', 'hkbuddy-asr-smoke',
    'hkbuddy-tts-smoke', 'hkbuddy-ios-voice-acceptance', 'hkbuddy-migrate',
  ]) assert.equal(serialized.includes(legacyIdentity), false, legacyIdentity);
});

test('executable provisioner contains no legacy Artifact Registry or secret discriminator', async () => {
  const source = await readFile(new URL('../scripts/gcp-provision.js', import.meta.url), 'utf8');
  for (const legacy of [
    "'hkbuddy'", 'hkbuddy-session-secret', 'hkbuddy-db-app-url',
    'hkbuddy-db-migrator-url', 'hkbuddy-db-bootstrap-state',
  ]) assert.equal(source.includes(legacy), false, legacy);
});

test('Tasks 1-2 operator documentation uses every executable V1 identity and no obsolete unversioned identity', async () => {
  const readme = await readFile(OPERATOR_README_URL, 'utf8');
  const requiredIdentities = [
    GCP_IDENTITY.service, GCP_IDENTITY.repository, GCP_IDENTITY.bucket,
    GCP_IDENTITY.buildSourceBucket,
    GCP_IDENTITY.cloudSqlInstance, GCP_IDENTITY.database, GCP_IDENTITY.network,
    GCP_IDENTITY.subnet, GCP_IDENTITY.psaRange,
    ...Object.values(GCP_IDENTITY.serviceAccounts),
    ...Object.values(GCP_IDENTITY.secrets),
    ...Object.values(GCP_IDENTITY.jobs),
  ];
  for (const identity of requiredIdentities) {
    assert.equal(readme.includes(identity), true, `missing operator identity: ${identity}`);
  }

  const obsoleteIdentities = [
    'hkbuddy', 'hkbuddy-api', 'hkbuddy-pg', 'hkbuddy-prod-vpc', 'hkbuddy-ae2-run',
    'hkbuddy-google-managed-services', 'hkbuddy-runtime', 'hkbuddy-build',
    'hkbuddy-migrator', 'hkbuddy-deployer', 'hkbuddy-acceptance', 'hkbuddy-migrate',
    'hkbuddy-db-app-url', 'hkbuddy-db-migrator-url', 'hkbuddy-session-secret',
    'hkbuddy-db-bootstrap-state',
    'hkbuddy-legacy-inventory', 'hkbuddy-dependency-acceptance', 'hkbuddy-llm-smoke',
    'hkbuddy-asr-smoke', 'hkbuddy-tts-smoke', 'hkbuddy-ios-voice-acceptance',
  ];
  for (const identity of obsoleteIdentities) {
    const escaped = identity.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.doesNotMatch(readme, new RegExp(`(?<![a-z0-9_-])${escaped}(?![a-z0-9_-])`, 'i'), identity);
  }
  assert.match(readme, /earlier `USD 300` draft/, 'the explicit historical budget context remains allowed');
});

test('operator IAM prose protects the observed Google APIs Service Agent Editor baseline and forbids additions', async () => {
  const readme = await readFile(OPERATOR_README_URL, 'utf8');
  assert.match(readme, /serviceAccount:582852715831@cloudservices\.gserviceaccount\.com/);
  assert.match(readme, /`roles\/editor`/);
  assert.match(readme, /protected and immutable/i);
  assert.match(readme, /additional[^.]*Editor grants?[^.]*forbidden/i);
  assert.doesNotMatch(readme, /legacy project-level `roles\/editor` is not allowed/i);
  assert.match(readme, /optional[^.]*service-agent bindings?/i);
});

test('shared-project control plane forbids project and billing mutations', async () => {
  const controlPlane = new GcpControlPlane({
    contract: await contractFixture(),
    notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('must not reach gcloud'); },
    request: async () => { throw new Error('must not reach HTTPS'); },
  });

  await assert.rejects(
    () => controlPlane.create('project'),
    (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
  );
  await assert.rejects(
    () => controlPlane.create('billing'),
    (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
  );
});

test('the executable contract fixes the isolated GCP topology and least-privilege boundary', async () => {
  const contract = await contractFixture();

  assert.doesNotThrow(() => assertResourceContract(contract));
  assert.deepEqual(contract.project, {
    id: PROJECT,
    displayName: 'Motion Expert HK LTD Webpage',
    organizationId: GCP_IDENTITY.organizationId,
    billingAccountId: GCP_IDENTITY.billingAccountId,
    projectNumber: PROJECT_NUMBER,
    mode: 'existing-billed-shared',
    assetInventory: {
      consumerProjectId: GCP_IDENTITY.assetInventoryConsumerProjectId,
      mode: 'read-only-cloud-asset-quota-consumer',
      scope: `projects/${PROJECT}`,
      pageSize: 500,
      readMask: ASSET_READ_MASK,
      orderBy: 'assetType,name',
    },
    protectedBindings: [
      { member: 'user:admin@motionexp.com', role: 'roles/owner' },
      { member: `serviceAccount:service-${PROJECT_NUMBER}@compute-system.iam.gserviceaccount.com`, role: 'roles/compute.serviceAgent' },
      { member: `serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`, role: 'roles/editor' },
    ],
    labels: {},
  });
  assert.deepEqual(contract.locations, {
    runtime: 'asia-east2', storage: 'asia-east2', database: 'asia-east2',
    speech: 'asia-southeast1', vertex: 'global',
  });
  assert.deepEqual(contract.resources.artifactRegistry, {
    repository: GCP_IDENTITY.repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
    location: 'asia-east2', description: 'Hong Kong Buddy production containers',
  });
  assert.deepEqual(contract.resources.monitoring.notificationChannel, {
    required: true,
    displayName: 'HK Buddy V1 operations',
    ownershipLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
    mustBeEnabled: true,
    requiredType: 'email',
    requiredVerificationStatus: 'VERIFIED',
  });
  assert.equal(contract.resources.budget.projectFilter, `projects/${PROJECT_NUMBER}`);
  assert.deepEqual(contract.resources.customRoles, [ACCEPTANCE_BUCKET_METADATA_ROLE]);
  assert.equal(
    EXPECTED_PROVISION_STEPS.includes('custom-role:hkbuddyV1AcceptanceBucketMetadataReader'),
    true,
  );
  assert.equal(
    EXPECTED_PROVISION_STEPS.indexOf('custom-role:hkbuddyV1AcceptanceBucketMetadataReader')
      < EXPECTED_PROVISION_STEPS.indexOf('vpc'),
    true,
  );
  assert.deepEqual(contract.apis, [
    'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com',
    'cloudbilling.googleapis.com', 'billingbudgets.googleapis.com',
    'iam.googleapis.com', 'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com', 'run.googleapis.com', 'compute.googleapis.com',
    'servicenetworking.googleapis.com', 'sqladmin.googleapis.com',
    'storage.googleapis.com', 'secretmanager.googleapis.com',
    'aiplatform.googleapis.com', 'speech.googleapis.com',
    'texttospeech.googleapis.com', 'monitoring.googleapis.com',
    'logging.googleapis.com',
  ]);

  assert.deepEqual(contract.resources.network, {
    vpc: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, subnetCidr: '10.24.0.0/26',
    privateGoogleAccess: true, psaRange: GCP_IDENTITY.psaRange,
    psaCidr: '10.25.0.0/16', egress: 'private-ranges-only',
  });
  assert.deepEqual(contract.resources.cloudSql, {
    instance: GCP_IDENTITY.cloudSqlInstance, database: GCP_IDENTITY.database, databaseVersion: 'POSTGRES_16',
    availabilityType: 'REGIONAL', tier: 'db-custom-1-3840', diskType: 'PD_SSD',
    diskSizeGb: 20, storageAutoIncrease: true, privateIpOnly: true,
    sslMode: 'ENCRYPTED_ONLY', backupEnabled: true, backupStartTime: '18:00',
    pointInTimeRecovery: true, transactionLogRetentionDays: 7,
    retainedBackups: 7, retainBackupsOnDelete: true, finalBackup: true,
    finalBackupRetentionDays: 30, deletionProtection: true,
    users: [
      { name: 'hkbuddy_app', databaseRoles: ['pg_read_all_data', 'pg_write_all_data'], secret: GCP_IDENTITY.secrets.dbAppUrl },
      { name: 'hkbuddy_migrator', databaseRoles: ['cloudsqlsuperuser'], secret: GCP_IDENTITY.secrets.dbMigratorUrl },
    ],
  });
  assert.deepEqual(contract.resources.bucket, {
    name: GCP_IDENTITY.bucket, location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 7,
    retentionPolicy: null,
  });
  assert.deepEqual(contract.resources.cloudRun, {
    stableService: GCP_IDENTITY.service, candidateService: GCP_IDENTITY.candidateService,
    executionEnvironment: 'gen2', cpu: 2, memory: '1Gi',
    concurrency: 40, minInstances: 1, maxInstances: 1, cpuThrottling: false,
    startupCpuBoost: true, timeoutSeconds: 60,
    candidateTrafficState: 'candidate-service-private-100', candidateTrafficPercent: 100,
    firstPromotionInitialStableState: 'stable-absent',
    firstPromotionPrivateTrafficState: 'accepted-stable-private-100',
    laterPromotionInitialStableState: 'stable-prior-100',
    laterPromotionStagedTrafficState: 'stable-prior-100/accepted-stable-0',
    directVpc: true, egress: 'private-ranges-only',
    startupProbe: { path: '/api/health/ready', port: 8080, initialDelaySeconds: 0, timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 12 },
    livenessProbe: { path: '/api/health/live', port: 8080, initialDelaySeconds: 30, timeoutSeconds: 5, periodSeconds: 30, failureThreshold: 3 },
    readinessProbe: { path: '/api/health/ready', port: 8080, initialDelaySeconds: 0, timeoutSeconds: 5, periodSeconds: 5, failureThreshold: 3 },
    secretVersionPolicy: 'numeric-only',
  });
  assert.deepEqual(contract.resources.budget, {
    displayName: 'Hong Kong Buddy Production V1 monthly guard', currency: 'HKD',
    amount: 2300, calendarPeriod: 'MONTH', projectFilter: `projects/${PROJECT_NUMBER}`,
    thresholds: [
      { percent: 0.5, basis: 'CURRENT_SPEND' },
      { percent: 0.8, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'FORECASTED_SPEND' },
    ],
  });
  assert.deepEqual(
    contract.resources.monitoring.policies.filter(({ kind }) => kind === 'log-match')
      .map(({ id, filter }) => [id, filter]),
    Object.entries(OFFICIAL_LOG_FILTERS),
  );
  assert.equal(contract.safety.unresolvedProjectIdPolicy, 'existing-project-required');
  assert.equal(contract.safety.noUserManagedServiceAccountKeys, true);
  assert.equal(contract.iam.forbiddenWorkloadRoles.includes('roles/iam.serviceAccountTokenCreator'), true);
  assert.deepEqual(contract.iam.automaticProjectBindings, AUTOMATIC_PROJECT_BINDINGS);

  const evidenceSecretIds = [
    GCP_IDENTITY.secrets.legacy, GCP_IDENTITY.secrets.dependencies, GCP_IDENTITY.secrets.llm,
    GCP_IDENTITY.secrets.asr, GCP_IDENTITY.secrets.tts, GCP_IDENTITY.secrets.ios,
  ];
  assert.deepEqual(
    contract.resources.secrets.filter(({ baseProvisioningVersion }) => baseProvisioningVersion === false)
      .map(({ id }) => id),
    evidenceSecretIds,
  );
  for (const id of evidenceSecretIds) {
    assert.equal(EXPECTED_PROVISION_STEPS.includes(`secret-container:${id}`), true);
    assert.equal(EXPECTED_PROVISION_STEPS.includes(`secret-version:${id}`), false);
    assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
      scope === `secret:${id}` && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`
        && role === 'roles/secretmanager.secretAccessor'
    )), true);
  }

  const runtime = `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`;
  const runtimeProjectRoles = contract.iam.bindings
    .filter(({ scope, member }) => scope === 'project' && member === runtime)
    .map(({ role }) => role).sort();
  assert.deepEqual(runtimeProjectRoles, [
    'roles/aiplatform.user', 'roles/serviceusage.serviceUsageConsumer', 'roles/speech.client',
  ]);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}` && member === runtime
      && role === 'roles/storage.objectUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}`
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`
      && role === ACCEPTANCE_BUCKET_METADATA_ROLE.name
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}` && member === runtime
      && role === 'roles/secretmanager.secretAccessor'
  )), false);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === 'service-account:hkbuddy-v1-build'
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`
      && role === 'roles/iam.serviceAccountUser'
  )), true);
  assert.equal(contract.iam.bindings.some(({ scope, role }) => (
    scope === 'project' && contract.iam.forbiddenWorkloadRoles.includes(role)
  )), false);
});

test('contract validation rejects identity drift, public access, broad workload roles, or mutable secret pins', async (t) => {
  const base = await contractFixture();
  const cases = [
    ['legacy project', (value) => { value.project.id = 'hkbuddy-pilot-0630'; }],
    ['wrong organization', (value) => { value.project.organizationId = '1'; }],
    ['public bucket', (value) => { value.resources.bucket.publicAccessPrevention = 'inherited'; }],
    ['broad runtime role', (value) => { value.iam.bindings.push({ scope: 'project', member: `serviceAccount:hkbuddy-runtime@${PROJECT}.iam.gserviceaccount.com`, role: 'roles/editor' }); }],
    ['connector drift', (value) => { value.resources.cloudRun.directVpc = false; }],
    ['extra public Cloud Run control', (value) => { value.resources.cloudRun.allowUnauthenticated = true; }],
    ['extra resource surface', (value) => { value.resources.unreviewed = {}; }],
    ['extra top-level surface', (value) => { value.unreviewed = true; }],
    ['public SQL', (value) => { value.resources.cloudSql.privateIpOnly = false; }],
    ['unencrypted SQL', (value) => { value.resources.cloudSql.sslMode = 'ALLOW_UNENCRYPTED_AND_ENCRYPTED'; }],
    ['latest secret', (value) => { value.resources.cloudRun.secretVersionPolicy = 'latest'; }],
    ['missing readback', (value) => { value.safety.completePostCreateReadback = false; }],
    ['budget currency drift', (value) => { value.resources.budget.currency = 'USD'; }],
    ['alert threshold replacement', (value) => { value.resources.monitoring.policies[0].threshold = 0.5; }],
    ['alert filter replacement', (value) => { value.resources.monitoring.policies[6].filter = 'severity>=ERROR'; }],
    ['IAM same-length external replacement', (value) => { value.iam.bindings[0].member = 'user:external@example.test'; }],
    ['automatic binding replacement', (value) => { value.iam.automaticProjectBindings[1].role = 'roles/editor'; }],
    ['forbidden-role list replacement', (value) => { value.iam.forbiddenWorkloadRoles[0] = 'roles/viewer'; }],
    ['custom role extra permission', (value) => { value.resources.customRoles[0].includedPermissions.push('storage.buckets.list'); }],
    ['custom role stage drift', (value) => { value.resources.customRoles[0].stage = 'BETA'; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const candidate = clone(base);
      mutate(candidate);
      assert.throws(() => assertResourceContract(candidate), /GCP resource contract is invalid/);
    });
  }
});

test('acceptance bucket metadata custom role is definition-exact and rejects permission or stage drift', async (t) => {
  const contract = await contractFixture();
  const exactRole = { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
  assert.doesNotThrow(() => assertExactCustomRoleDefinitions({
    contract, roles: [exactRole],
  }));

  for (const [name, mutate] of [
    ['extra permission', (role) => { role.includedPermissions.push('storage.buckets.list'); }],
    ['stage drift', (role) => { role.stage = 'BETA'; }],
    ['deleted role', (role) => { role.deleted = true; }],
    ['unexpected role', (_role, roles) => { roles.push({ ...exactRole, name: `projects/${PROJECT}/roles/unexpected` }); }],
  ]) {
    await t.test(name, () => {
      const role = clone(exactRole);
      const roles = [role];
      mutate(role, roles);
      assert.throws(
        () => assertExactCustomRoleDefinitions({ contract, roles }),
        (error) => error.code === 'CUSTOM_ROLE_ALLOWLIST_MISMATCH',
      );
    });
  }
});

test('gcloud execution is argv-only and rejects values that could disclose a secret', async () => {
  const calls = [];
  const executor = createGcloudExecutor({
    executable: 'python.exe',
    prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: '{"ok":true}\n', stderr: '' };
    },
  });

  const result = await executor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json']);
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls, [{
    executable: 'python.exe',
    args: [
      'C:/gcloud/lib/gcloud.py', 'projects', 'describe', PROJECT,
      `--project=${PROJECT}`, '--format=json', '--quiet',
    ],
    options: { encoding: 'utf8', maxBuffer: 1048576, windowsHide: true },
  }]);
  assert.equal(calls[0].args.filter((value) => value === '--quiet').length, 1);
  await executor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json', '--quiet']);
  assert.equal(calls[1].args.filter((value) => value === '--quiet').length, 1);
  await assert.rejects(
    () => executor(['projects', 'describe', PROJECT, '--quiet', '--quiet']),
    /non-interactive|quiet|argv/i,
  );
  await assert.rejects(() => executor(`projects describe ${PROJECT}`), /argv array/);
  await assert.rejects(() => executor(['sql', 'users', 'create', '--password=hunter2']), /secret-bearing argv/);
  await assert.rejects(() => executor(['run', 'deploy', 'postgres://user:pass@example.test/db']), /secret-bearing argv/);
  await assert.rejects(() => executor(['projects', 'describe', `${PROJECT}\nwhoami`]), /unsafe argv/);

  const permissionExecutor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('command failed');
      error.stderr = 'The caller does not have permission.';
      throw error;
    },
  });
  await assert.rejects(
    () => permissionExecutor(['projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json']),
    (error) => error.code === 'FORBIDDEN',
  );
});

test('gcloud text execution is explicitly non-interactive exactly once', async () => {
  const calls = [];
  const executor = createDefaultGcloudTextExecutor({
    environment: {
      V1_GCP_PYTHON_EXECUTABLE: 'C:\\runtime\\python.exe',
      V1_GCLOUD_PY_PATH: 'C:\\sdk\\gcloud.py',
    },
    execFile: async (executable, args, options) => {
      calls.push({ executable, args, options });
      return { stdout: 'admin@motionexp.com\n', stderr: '' };
    },
  });

  assert.equal(await executor(['config', 'get-value', 'account', `--project=${PROJECT}`]),
    'admin@motionexp.com\n');
  await executor([
    'auth', 'print-identity-token', '--audiences=https://candidate.example.test', '--quiet',
  ]);
  assert.deepEqual(calls.map((call) => call.args.filter((value) => value === '--quiet').length), [1, 1]);
  await assert.rejects(
    () => executor(['config', 'get-value', 'account', '--quiet', '--quiet']),
    /non-interactive|quiet|argv/i,
  );
});

test('gcloud classifies absence only for the exact canonical Cloud Run service describe operation', async (t) => {
  const serviceDescribe = [
    'run', 'services', 'describe', GCP_IDENTITY.service,
    `--project=${PROJECT}`, `--region=${GCP_IDENTITY.region}`, '--format=json',
  ];
  const executorFor = (stderr) => createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => {
      const error = new Error('gcloud failed');
      error.stderr = stderr;
      throw error;
    },
  });

  await assert.rejects(
    () => executorFor(
      `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`,
    )(serviceDescribe),
    (error) => error.code === 'CLOUD_RUN_SERVICE_NOT_FOUND',
  );

  for (const [name, argv, stderr] of [
    ['proxy 404', serviceDescribe, 'proxy returned 404 while discovering the endpoint'],
    ['auth NOT_FOUND', serviceDescribe, 'NOT_FOUND: credential discovery document was not found'],
    ['API path was not found', serviceDescribe, 'The requested API path was not found'],
    ['wrong service', serviceDescribe.with(3, 'hkbuddy-v1-foreign'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
    ['wrong project', serviceDescribe.with(4, '--project=foreign-project'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
    ['wrong region', serviceDescribe.with(5, '--region=us-central1'), `ERROR: (gcloud.run.services.describe) Cannot find service [${GCP_IDENTITY.service}]\n`],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(
        () => executorFor(stderr)(argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }
});

test('gcloud classifies canonical absence only when describe argv and resource identity both match', async (t) => {
  const role = 'hkbuddyV1AcceptanceBucketMetadataReader';
  const cases = [
    {
      name: 'Artifact Registry repository',
      argv: ['artifacts', 'repositories', 'describe', GCP_IDENTITY.repository, '--location=asia-east2', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.`,
    },
    {
      name: 'service account',
      argv: ['iam', 'service-accounts', 'describe', GCP_IDENTITY.serviceAccounts.runtime, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Service account [${GCP_IDENTITY.serviceAccounts.runtime}] was not found in project [${PROJECT}].`,
    },
    {
      name: 'custom role',
      argv: ['iam', 'roles', 'describe', role, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/${role}] was not found.`,
    },
    {
      name: 'Compute network',
      argv: ['compute', 'networks', 'describe', GCP_IDENTITY.network, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`,
    },
    {
      name: 'Compute subnet',
      argv: ['compute', 'networks', 'subnets', 'describe', GCP_IDENTITY.subnet, '--region=asia-east2', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`,
    },
    {
      name: 'Compute global address',
      argv: ['compute', 'addresses', 'describe', GCP_IDENTITY.psaRange, '--global', `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`,
    },
    {
      name: 'Cloud SQL instance',
      argv: ['sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The resource [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}] was not found.`,
    },
    {
      name: 'Cloud SQL database',
      argv: ['sql', 'databases', 'describe', GCP_IDENTITY.database, `--instance=${GCP_IDENTITY.cloudSqlInstance}`, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.sql.databases.describe) HTTPError 404: Database [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}] was not found.`,
    },
    {
      name: 'Storage bucket',
      argv: ['storage', 'buckets', 'describe', `gs://${GCP_IDENTITY.bucket}`, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.bucket}] does not exist.`,
    },
    {
      name: 'Secret Manager secret',
      argv: ['secrets', 'describe', GCP_IDENTITY.secrets.session, `--project=${PROJECT}`, '--format=json'],
      stderr: `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}] not found.`,
    },
    {
      name: 'Cloud Run job',
      argv: ['run', 'jobs', 'describe', GCP_IDENTITY.jobs.migration, `--project=${PROJECT}`, '--region=asia-east2', '--format=json'],
      stderr: `ERROR: (gcloud.run.jobs.describe) Cannot find job [${GCP_IDENTITY.jobs.migration}].`,
    },
  ];

  const executorFor = (stderr) => createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async () => { const error = new Error('gcloud failed'); error.stderr = stderr; throw error; },
  });
  for (const fixture of cases) {
    await t.test(fixture.name, async () => {
      await assert.rejects(
        () => executorFor(fixture.stderr)(fixture.argv),
        (error) => error.code === 'NOT_FOUND',
      );
      for (const argv of [
        fixture.argv.with(fixture.argv.indexOf(`--project=${PROJECT}`), '--project=foreign-project'),
        fixture.argv.with(fixture.argv.length - 1, '--format=yaml'),
      ]) {
        await assert.rejects(
          () => executorFor(fixture.stderr)(argv),
          (error) => error.code === 'TRANSPORT_AMBIGUOUS',
        );
      }
      const wrongResourceStderr = fixture.stderr.includes(role)
        ? fixture.stderr.replaceAll(role, `${role}Foreign`)
        : fixture.stderr.replaceAll('hkbuddy-v1', 'hkbuddy-v1-foreign');
      await assert.rejects(
        () => executorFor(wrongResourceStderr)(fixture.argv),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
    });
  }
});

test('real control-plane create-or-readback families receive canonical absence and perform zero mutation', async (t) => {
  const contract = await contractFixture();
  const fixtures = [
    ['artifact-registry', `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.`],
    ['service-account:hkbuddy-v1-runtime', `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Service account [${GCP_IDENTITY.serviceAccounts.runtime}] was not found in project [${PROJECT}].`],
    ['custom-role:hkbuddyV1AcceptanceBucketMetadataReader', `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader] was not found.`],
    ['vpc', `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`],
    ['subnet', `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`],
    ['psa-range', `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`],
    ['cloud-sql-instance', `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The resource [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}] was not found.`],
    ['database', `ERROR: (gcloud.sql.databases.describe) HTTPError 404: Database [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}] was not found.`],
    ['bucket', `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.bucket}] does not exist.`],
    ['build-source-bucket', `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${GCP_IDENTITY.buildSourceBucket}] does not exist.`],
    [`secret-container:${GCP_IDENTITY.secrets.session}`, `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}] not found.`],
    [`job:${GCP_IDENTITY.jobs.migration}`, `ERROR: (gcloud.run.jobs.describe) Cannot find job [${GCP_IDENTITY.jobs.migration}].`],
  ];
  for (const [id, stderr] of fixtures) {
    await t.test(id, async () => {
      const calls = [];
      const executor = createGcloudExecutor({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        execFile: async (_executable, args) => {
          calls.push(args.slice(1));
          const error = new Error('gcloud failed'); error.stderr = stderr; throw error;
        },
      });
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL, gcloud: executor,
        request: async () => { throw new Error('HTTPS must not be used for gcloud describe families'); },
      });
      assert.deepEqual(await plane.read(id), { status: 'absent' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].some((value) => ['create', 'enable', 'add-iam-policy-binding'].includes(value)), false);

      const ambiguousCalls = [];
      const ambiguousPlane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: createGcloudExecutor({
          executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
          execFile: async (_executable, args) => {
            ambiguousCalls.push(args.slice(1));
            const error = new Error('gcloud failed');
            error.stderr = `${stderr} foreign-resource`;
            throw error;
          },
        }),
        request: async () => { throw new Error('HTTPS must remain inert'); },
      });
      await assert.rejects(
        () => ambiguousPlane.read(id),
        (error) => error.code === 'TRANSPORT_AMBIGUOUS',
      );
      assert.equal(ambiguousCalls.length, 1);
      assert.equal(ambiguousCalls[0].some((value) => (
        ['create', 'enable', 'add-iam-policy-binding'].includes(value)
      )), false);
    });
  }
});

test('exhaustive inventory gets a bounded invocation-specific output capacity and overflow fails closed', async () => {
  const calls = [];
  const executor = createGcloudExecutor({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    execFile: async (_executable, _args, options) => {
      calls.push(options);
      const error = new Error('stdout maxBuffer length exceeded');
      error.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
      throw error;
    },
  });
  await assert.rejects(
    () => executor(['asset', 'search-all-resources', `--project=${PROJECT}`], { maxBuffer: 16 * 1024 * 1024 }),
    (error) => error.code === 'TRANSPORT_AMBIGUOUS',
  );
  assert.deepEqual(calls, [{
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true,
  }]);
  await assert.rejects(
    () => executor(['asset', 'search-all-resources', `--project=${PROJECT}`], { maxBuffer: 64 * 1024 * 1024 }),
    /output limit is invalid/,
  );
});

test('authenticated HTTPS control-plane identity is resolved without exposing its token', async () => {
  const seen = [];
  const request = createAuthenticatedRequest({
    auth: {
      getClient: async () => ({
        getAccessToken: async () => ({ token: 'sensitive-access-token' }),
        getTokenInfo: async (token) => {
          seen.push(['token-info', token]);
          return { email: 'admin@motionexp.com' };
        },
        request: async (input) => { seen.push(['request', input]); return { data: { ok: true } }; },
      }),
    },
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  assert.deepEqual(await request({ method: 'GET', url: 'https://example.googleapis.com/v1/read' }), { ok: true });
  assert.equal(JSON.stringify(seen.filter(([kind]) => kind !== 'token-info')).includes('sensitive-access-token'), false);
});

test('default-style HTTPS authentication reuses the exact gcloud account without putting bearer data in argv', async () => {
  const execCalls = [];
  const fetchCalls = [];
  const tokenInfoCalls = [];
  const request = createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com',
    execFile: async (executable, args, options) => {
      execCalls.push({ executable, args, options });
      if (args.includes('config')) return {
        stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '',
      };
      return { stdout: 'sensitive-bearer-token\n', stderr: '' };
    },
    getTokenInfo: async (token) => {
      tokenInfoCalls.push(token);
      return { email: 'admin@motionexp.com' };
    },
    environment: {},
    fetchImpl: async (url, options) => {
      fetchCalls.push({ url, options });
      const body = Buffer.from('{"ok":true}');
      return {
        ok: true, status: 200, redirected: false, url,
        headers: { get: (name) => name === 'content-length' ? String(body.length) : null },
        body: new ReadableStream({
          start(controller) { controller.enqueue(body); controller.close(); },
        }),
        text: async () => '{"ok":true}',
      };
    },
    now: () => 1_000,
  });
  assert.equal(await request.getPrincipal(), 'admin@motionexp.com');
  assert.deepEqual(await request({
    method: 'POST', url: 'https://example.googleapis.com/v1/write', body: { secret: 'body-only' },
  }), { ok: true });
  assert.equal(execCalls.length, 2);
  assert.deepEqual(execCalls[0].args, [
    'C:/gcloud/lib/gcloud.py', 'config', 'list',
    '--format=json', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(execCalls[1].args, [
    'C:/gcloud/lib/gcloud.py', 'auth', 'print-access-token',
    '--account=admin@motionexp.com', `--project=${PROJECT}`, '--quiet',
  ]);
  assert.deepEqual(
    execCalls.map((call) => call.args.filter((value) => value === '--quiet').length),
    [1, 1],
  );
  assert.deepEqual(tokenInfoCalls, ['sensitive-bearer-token']);
  assert.equal(JSON.stringify(execCalls).includes('sensitive-bearer-token'), false);
  assert.equal(JSON.stringify(execCalls).includes('body-only'), false);
  assert.equal(fetchCalls[0].options.headers.authorization, 'Bearer sensitive-bearer-token');
  assert.equal(fetchCalls[0].options.body, '{"secret":"body-only"}');
  assert.equal(fetchCalls[0].options.redirect, 'error');
});

function authenticatedResponse(url, {
  chunks = [Buffer.from('{"ok":true}')],
  contentLength,
  redirected = false,
  finalUrl = url,
  status = 200,
} = {}) {
  let index = 0;
  const observations = { cancelled: false, reads: 0, textCalls: 0 };
  const body = chunks === null ? null : new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) return controller.close();
      observations.reads += 1;
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() { observations.cancelled = true; },
  }, { highWaterMark: 0 });
  return {
    observations,
    response: {
      ok: status >= 200 && status < 300,
      status,
      redirected,
      url: finalUrl,
      headers: {
        get(name) {
          if (name !== 'content-length') return null;
          return contentLength === undefined ? null : String(contentLength);
        },
      },
      body,
      async text() {
        observations.textCalls += 1;
        return chunks === null ? '' : Buffer.concat(chunks).toString('utf8');
      },
    },
  };
}

function authenticatedRequestFixture(fetchImpl) {
  return createGcloudAuthenticatedRequest({
    executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
    account: 'admin@motionexp.com', environment: {},
    execFile: async (_executable, args) => args.includes('config')
      ? { stdout: '{"core":{"account":"admin@motionexp.com"},"auth":{}}\n', stderr: '' }
      : { stdout: 'sensitive-bearer-token\n', stderr: '' },
    getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
    fetchImpl,
    now: () => 1_000,
  });
}

test('authenticated REST rejects redirected or drifted final URLs before consuming response bytes', async (t) => {
  const target = 'https://example.googleapis.com/v1/write';
  for (const [name, responseOverrides] of [
    ['redirected response', { redirected: true }],
    ['missing final URL', { finalUrl: null }],
    ['drifted final URL', { finalUrl: 'https://other.googleapis.com/v1/write' }],
  ]) {
    await t.test(name, async () => {
      const fixture = authenticatedResponse(target, responseOverrides);
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'POST', url: target, body: { value: 'private-body' } }),
        (error) => !String(error).includes('private-body'),
      );
      assert.equal(fixture.observations.textCalls, 0);
      assert.equal(fixture.observations.reads, 0);
      assert.equal(fixture.observations.cancelled, true);
    });
  }
});

test('authenticated REST redirect policy prevents 307/308 replay of secret and SQL password bodies', async (t) => {
  const target = 'https://example.googleapis.com/v1/write';
  for (const [status, body, privateValue] of [
    [307, { payload: { data: 'secret-version-private-value' } }, 'secret-version-private-value'],
    [308, { name: 'hkbuddy_app', password: 'cloud-sql-private-password' }, 'cloud-sql-private-password'],
  ]) {
    await t.test(String(status), async () => {
      const replayedBodies = [];
      const request = authenticatedRequestFixture(async (url, options) => {
        if (options.redirect === 'error') throw new TypeError(`redirect ${status} refused`);
        replayedBodies.push(options.body);
        return authenticatedResponse(url).response;
      });
      await assert.rejects(
        () => request({ method: 'POST', url: target, body }),
        (error) => !String(error).includes(privateValue),
      );
      assert.deepEqual(replayedBodies, []);
    });
  }
});

test('authenticated REST incrementally bounds chunked responses and never calls whole-body text', async () => {
  const target = 'https://example.googleapis.com/v1/read';
  const fixture = authenticatedResponse(target, {
    chunks: [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024), Buffer.from('x')],
  });
  const request = authenticatedRequestFixture(async () => fixture.response);
  await assert.rejects(
    () => request({ method: 'GET', url: target }),
    (error) => error.code === 'CONTROL_PLANE_RESPONSE_TOO_LARGE',
  );
  assert.equal(fixture.observations.cancelled, true);
  assert.equal(fixture.observations.textCalls, 0);
});

test('authenticated REST accepts exact-URL JSON and coherently empty null bodies through the bounded reader', async () => {
  const jsonUrl = 'https://example.googleapis.com/v1/read';
  const jsonBytes = Buffer.from('{"ok":true}');
  const jsonFixture = authenticatedResponse(jsonUrl, {
    chunks: [jsonBytes], contentLength: jsonBytes.length,
  });
  const jsonRequest = authenticatedRequestFixture(async () => jsonFixture.response);
  assert.deepEqual(await jsonRequest({ method: 'GET', url: jsonUrl }), { ok: true });
  assert.equal(jsonFixture.observations.textCalls, 0);

  const emptyUrl = 'https://example.googleapis.com/v1/empty';
  const emptyFixture = authenticatedResponse(emptyUrl, { chunks: null, contentLength: 0 });
  const emptyRequest = authenticatedRequestFixture(async () => emptyFixture.response);
  assert.equal(await emptyRequest({ method: 'GET', url: emptyUrl }), null);
  assert.equal(emptyFixture.observations.textCalls, 0);
});

test('authenticated REST validates declared length, stream chunks, UTF-8, and empty-body coherence', async (t) => {
  const target = 'https://example.googleapis.com/v1/read';
  const cases = [
    ['oversized declared length', {
      fixture: authenticatedResponse(target, { contentLength: 2 * 1024 * 1024 + 1 }),
      code: 'CONTROL_PLANE_RESPONSE_TOO_LARGE', cancelled: true,
    }],
    ['noncanonical declared length', {
      fixture: authenticatedResponse(target, { contentLength: '01' }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: true,
    }],
    ['declared length mismatch', {
      fixture: authenticatedResponse(target, {
        chunks: [Buffer.from('{"ok":true}')], contentLength: 12,
      }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: false,
    }],
    ['invalid stream chunk', {
      fixture: authenticatedResponse(target, { chunks: ['not-bytes'] }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: true,
    }],
    ['invalid UTF-8', {
      fixture: authenticatedResponse(target, { chunks: [Buffer.from([0xc3, 0x28])] }),
      code: 'CONTROL_PLANE_OUTPUT_INVALID', cancelled: false,
    }],
    ['unexplained null body', {
      fixture: authenticatedResponse(target, { chunks: null }),
      code: 'TRANSPORT_AMBIGUOUS', cancelled: false,
    }],
  ];
  for (const [name, { fixture, code, cancelled }] of cases) {
    await t.test(name, async () => {
      const request = authenticatedRequestFixture(async () => fixture.response);
      await assert.rejects(
        () => request({ method: 'GET', url: target }),
        (error) => error.code === code && !String(error).includes('sensitive-bearer-token'),
      );
      assert.equal(fixture.observations.cancelled, cancelled);
      assert.equal(fixture.observations.textCalls, 0);
    });
  }

  const forbidden = authenticatedResponse(target, {
    status: 403, chunks: [Buffer.from('{"error":"redacted"}')],
  });
  const request = authenticatedRequestFixture(async () => forbidden.response);
  await assert.rejects(() => request({ method: 'GET', url: target }), { code: 'FORBIDDEN' });
});

test('gcloud HTTPS authentication rejects every effective credential override before token use', async (t) => {
  for (const [name, environment] of [
    ['impersonation env', { CLOUDSDK_AUTH_IMPERSONATE_SERVICE_ACCOUNT: 'foreign@example.test' }],
    ['access-token env', { CLOUDSDK_AUTH_ACCESS_TOKEN: 'do-not-use' }],
    ['access-token-file env', { CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: 'C:/foreign-token' }],
    ['credential-file env', { CLOUDSDK_AUTH_CREDENTIAL_FILE_OVERRIDE: 'C:/foreign-credential' }],
  ]) {
    await t.test(name, async () => {
      let execCalls = 0;
      const request = createGcloudAuthenticatedRequest({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        account: 'admin@motionexp.com', environment,
        execFile: async () => { execCalls += 1; return { stdout: 'must-not-run' }; },
        getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
      });
      await assert.rejects(() => request.getPrincipal(), (error) => error.code === 'GCLOUD_AUTH_OVERRIDE');
      assert.equal(execCalls, 0);
    });
  }

  for (const [name, auth] of [
    ['impersonation property', { impersonate_service_account: 'foreign@example.test' }],
    ['access-token-file property', { access_token_file: 'C:/foreign-token' }],
    ['credential-file property', { credential_file_override: 'C:/foreign-credential' }],
  ]) {
    await t.test(name, async () => {
      const calls = [];
      const request = createGcloudAuthenticatedRequest({
        executable: 'python.exe', prefixArgs: ['C:/gcloud/lib/gcloud.py'],
        account: 'admin@motionexp.com', environment: {},
        execFile: async (_executable, args) => {
          calls.push(args);
          return { stdout: `${JSON.stringify({ auth })}\n`, stderr: '' };
        },
        getTokenInfo: async () => ({ email: 'admin@motionexp.com' }),
      });
      await assert.rejects(() => request.getPrincipal(), (error) => error.code === 'GCLOUD_AUTH_OVERRIDE');
      assert.equal(calls.length, 1);
      assert.equal(calls.some((args) => args.includes('print-access-token')), false);
    });
  }
});

test('CIDR audit ignores only the target VPC system default route and blocks real overlap', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/hkbuddy-prod-vpc`;
  assert.doesNotThrow(() => assertCidrAvailable({
    desired: '10.24.0.0/26', network,
    subnets: [], addresses: [],
    routes: [{
      network, destRange: '0.0.0.0/0',
      nextHopGateway: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/gateways/default-internet-gateway`,
    }],
  }));
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, subnets: [], addresses: [],
    kind: 'psa',
    routes: [{ network, destRange: '10.0.0.0/8', nextHopVpnTunnel: 'vpn-1' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, subnets: [], addresses: [],
    kind: 'psa',
    routes: [{ network, destRange: '10.25.8.0/24', nextHopVpnTunnel: 'vpn-1' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.throws(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, routes: [], addresses: [],
    subnets: [{ network, ipCidrRange: '10.25.1.0/24' }],
  }), (error) => error.code === 'CIDR_OVERLAP');
  assert.doesNotThrow(() => assertCidrAvailable({
    desired: '10.25.0.0/16', network, routes: [], subnets: [],
    kind: 'psa',
    addresses: [{ purpose: 'VPC_PEERING', network: `${network}-other`, address: '10.25.0.0', prefixLength: 16 }],
  }));
});

test('CIDR audit validates complete Compute rows before filtering and requires project network authority', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const networks = [{ name: GCP_IDENTITY.network, selfLink: network }];
  const exact = {
    desired: '10.25.0.0/16', kind: 'psa', network, networks,
    subnets: [], routes: [], addresses: [],
  };
  const malformed = [
    { ...exact, networks: [{ name: GCP_IDENTITY.network }] },
    { ...exact, subnets: [{ name: 'foreign-subnet', network: null, ipCidrRange: '10.25.1.0/24', region: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2` }] },
    { ...exact, routes: [{ name: 'foreign-route', network: null, destRange: '10.25.1.0/24', nextHopVpnTunnel: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2/vpnTunnels/foreign` }] },
    { ...exact, addresses: [{ name: 'foreign-psa', purpose: 'VPC_PEERING', address: '10.25.0.0', prefixLength: 16 }] },
    { ...exact, addresses: [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '10.25.0.1', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] },
    { ...exact, subnets: [{ name: 'foreign-subnet', network: `${network}-missing`, ipCidrRange: '10.25.1.0/24', region: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2` }] },
  ];
  for (const input of malformed) {
    assert.throws(() => assertCidrAvailable(input), (error) => error.code === 'CIDR_AUDIT_INVALID');
  }
  assert.throws(() => assertCidrAvailable({
    ...exact,
    routes: [{
      name: 'foreign-default', network, destRange: '0.0.0.0/0',
      nextHopGateway: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/gateways/custom-gateway`,
    }],
  }), (error) => error.code === 'CIDR_OVERLAP');
});

test('monitoring aggregation groups Cloud Run and Cloud SQL metrics by their real resource label', () => {
  assert.equal(monitoringGroupByField('run.googleapis.com/request_count'), 'resource.label.service_name');
  assert.equal(monitoringGroupByField('cloudsql.googleapis.com/database/cpu/utilization'), 'resource.label.database_id');
  assert.throws(() => monitoringGroupByField('unknown.googleapis.com/metric'), /unsupported monitoring metric/);
});

test('log alert policies use official event contracts and validate each filter read-only before policy creation', async (t) => {
  const contract = await contractFixture();
  for (const [policyId, filter] of Object.entries(OFFICIAL_LOG_FILTERS)) {
    await t.test(policyId, async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => {
          requests.push(input);
          if (input.url === 'https://logging.googleapis.com/v2/entries:list') return {};
          if (input.url === `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`) {
            return { name: `projects/${PROJECT}/alertPolicies/1` };
          }
          throw new Error('unexpected request');
        },
      });
      await plane.create(`monitoring-policy:${policyId}`, { notificationChannel: CHANNEL });
      assert.deepEqual(requests, [
        {
          method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list',
          body: {
            resourceNames: [`projects/${PROJECT}`], filter, pageSize: 1,
            orderBy: 'timestamp desc',
          },
        },
        {
          method: 'POST', url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`,
          body: requests[1].body,
        },
      ]);
      assert.equal(requests[1].body.conditions[0].conditionMatchedLog.filter, filter);
    });
  }

  await t.test('unverifiable Logging filter stops before Monitoring mutation', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        const error = new Error('invalid logging filter');
        error.code = 'BAD_REQUEST';
        throw error;
      },
    });
    await assert.rejects(
      () => plane.create('monitoring-policy:sql-backup-failure', { notificationChannel: CHANNEL }),
      (error) => error.code === 'MONITORING_LOG_FILTER_UNVERIFIED',
    );
    assert.deepEqual(requests.map(({ url }) => url), ['https://logging.googleapis.com/v2/entries:list']);
  });

  await t.test('metric descriptor identity mismatch stops before Monitoring mutation', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        return { type: 'run.googleapis.com/not-the-requested-metric' };
      },
    });
    await assert.rejects(
      () => plane.create('monitoring-policy:run-5xx-ratio', { notificationChannel: CHANNEL }),
      (error) => error.code === 'MONITORING_METRIC_DESCRIPTOR_UNVERIFIED',
    );
    assert.equal(requests.some(({ url }) => url.endsWith('/alertPolicies')), false);
  });
});

test('monitoring policy identity matches the marker-or-display-name union before create', async (t) => {
  const contract = await contractFixture();
  const definition = contract.resources.monitoring.policies.find(({ id }) => id === 'sql-backup-failure');

  await t.test('an unlabelled fixed-name policy is drift, never absence', async () => {
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({ alertPolicies: [{ displayName: definition.displayName }] }),
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
  });

  await t.test('one exact labelled policy plus an unlabelled fixed-name duplicate is drift', async () => {
    const exactPolicy = {
      displayName: definition.displayName,
      combiner: 'OR', enabled: true, notificationChannels: [CHANNEL],
      userLabels: {
        application: 'hong_kong_buddy', environment: 'production_v1',
        hkbuddy_contract: 'sql_backup_failure',
      },
      conditions: [{
        displayName: definition.displayName,
        conditionMatchedLog: { filter: definition.filter },
      }],
      alertStrategy: {
        notificationRateLimit: { period: '300s' }, autoClose: '604800s',
      },
    };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({ alertPolicies: [
        exactPolicy, { displayName: definition.displayName },
      ] }),
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
  });
});

test('Monitoring and Billing readbacks bind generated IDs to exact numeric parents and ownership markers', async (t) => {
  const contract = await contractFixture();
  const definition = contract.resources.monitoring.policies.find(({ id }) => id === 'sql-backup-failure');
  const exactPolicy = {
    name: `projects/${PROJECT_NUMBER}/alertPolicies/123456789`,
    displayName: definition.displayName,
    combiner: 'OR', enabled: true, notificationChannels: [NUMERIC_CHANNEL],
    userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'sql_backup_failure' },
    conditions: [{ displayName: definition.displayName, conditionMatchedLog: { filter: definition.filter } }],
    alertStrategy: { notificationRateLimit: { period: '300s' }, autoClose: '604800s' },
  };
  const channel = {
    name: NUMERIC_CHANNEL, displayName: 'HK Buddy V1 operations', type: 'email', enabled: true,
    verificationStatus: 'VERIFIED', labels: { email_address: 'operations@example.test' },
    userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
  };
  const exactBudget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123456789`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: { projects: [ASSET_PROJECT], calendarPeriod: 'MONTH' },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [NUMERIC_CHANNEL] },
  };

  await t.test('alert policy', async () => {
    for (const [name, expected] of [
      [exactPolicy.name, true],
      [`projects/999999999999/alertPolicies/123456789`, false],
    ]) {
      const plane = new GcpControlPlane({
        contract, notificationChannel: NUMERIC_CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => ({ alertPolicies: [{ ...exactPolicy, name }] }),
      });
      assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
        status: 'present', value: { exact: expected },
      });
    }
  });

  await t.test('notification channel', async () => {
    for (const [value, expected] of [
      [channel, true],
      [{ ...channel, displayName: 'HK Buddy V1 foreign operations' }, false],
      [{ ...channel, userLabels: { ...channel.userLabels, hkbuddy_contract: 'foreign' } }, false],
    ]) {
      const plane = new GcpControlPlane({
        contract, notificationChannel: NUMERIC_CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async () => value,
      });
      const readback = await plane.read('notification-channel', { notificationChannel: NUMERIC_CHANNEL });
      assert.equal(readback.status, 'present');
      assert.equal(plane.compare('notification-channel', readback.value, { notificationChannel: NUMERIC_CHANNEL }), expected);
    }
  });

  await t.test('budget', async () => {
    const plane = new GcpControlPlane({
      contract, notificationChannel: NUMERIC_CHANNEL,
      gcloud: async (args) => {
        if (args[0] === 'projects') return { projectId: PROJECT, projectNumber: PROJECT_NUMBER };
        throw new Error('unexpected gcloud');
      },
      request: async () => ({ budgets: [{ ...exactBudget, name: `billingAccounts/FOREIGN/budgets/123456789` }] }),
    });
    await plane.read('project');
    assert.deepEqual(await plane.read('budget'), { status: 'present', value: { exact: false } });
  });
});

test('ensureExactResource is dry-run safe, reads after create, and fails closed on collision, drift, 403, or ambiguity', async (t) => {
  await t.test('dry run never creates', async () => {
    let creates = 0;
    const result = await ensureExactResource({
      id: 'vpc', mutate: false,
      read: async () => ({ status: 'absent' }),
      create: async () => { creates += 1; },
      compare: () => true,
    });
    assert.deepEqual(result, { id: 'vpc', status: 'planned' });
    assert.equal(creates, 0);
  });

  await t.test('confirmed create is followed by exact readback', async () => {
    let reads = 0;
    let creates = 0;
    const result = await ensureExactResource({
      id: 'vpc', mutate: true,
      read: async () => (++reads === 1 ? { status: 'absent' } : { status: 'present', value: { name: 'vpc' } }),
      create: async () => { creates += 1; },
      compare: (value) => value.name === 'vpc',
    });
    assert.deepEqual(result, { id: 'vpc', status: 'created' });
    assert.equal(reads, 2);
    assert.equal(creates, 1);
  });

  const failures = [
    ['403 is unknown', async () => ({ status: 'unknown', code: 'FORBIDDEN' }), async () => undefined, 'RESOURCE_STATE_UNKNOWN'],
    ['present drift', async () => ({ status: 'present', value: { name: 'other' } }), async () => undefined, 'RESOURCE_DRIFT'],
    ['collision', async () => ({ status: 'absent' }), async () => { const error = new Error('collision'); error.code = 'ALREADY_EXISTS'; throw error; }, 'RESOURCE_COLLISION'],
    ['ambiguous missing', (() => { let reads = 0; return async () => (++reads === 1 ? { status: 'absent' } : { status: 'absent' }); })(), async () => { throw new Error('transport lost'); }, 'CREATE_RESULT_AMBIGUOUS'],
  ];
  for (const [name, read, create, code] of failures) {
    await t.test(name, async () => {
      await assert.rejects(
        () => ensureExactResource({ id: 'resource', mutate: true, read, create, compare: () => false }),
        (error) => error.code === code,
      );
    });
  }

  await t.test('ambiguous transport result is accepted only after exact readback', async () => {
    let reads = 0;
    const result = await ensureExactResource({
      id: 'resource', mutate: true,
      read: async () => (++reads === 1
        ? { status: 'absent' }
        : { status: 'present', value: { exact: true } }),
      create: async () => { throw new Error('response lost'); },
      compare: (value) => value.exact === true,
    });
    assert.deepEqual(result, { id: 'resource', status: 'created-readback-recovered' });
  });
});

test('final key audit uses project-explicit argv and rejects every user-managed service-account key', async () => {
  const contract = await contractFixture();
  const calls = [];
  await assertNoUserManagedServiceAccountKeys({
    contract,
    gcloud: async (args) => { calls.push(args); return []; },
  });
  assert.equal(calls.length, 5);
  assert.equal(calls.every((args) => args.includes('--managed-by=user')
    && args.includes(`--project=${PROJECT}`)), true);

  await assert.rejects(() => assertNoUserManagedServiceAccountKeys({
    contract,
    gcloud: async () => [{ name: 'projects/example/serviceAccounts/example/keys/1' }],
  }), (error) => error.code === 'USER_MANAGED_SERVICE_ACCOUNT_KEY');
});

test('custom role provisioning reads, creates, and compares the one-permission GA definition exactly', async () => {
  const calls = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'describe') {
        return { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
      }
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'create') {
        return { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
      }
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });

  const id = 'custom-role:hkbuddyV1AcceptanceBucketMetadataReader';
  const readback = await plane.read(id);
  assert.deepEqual(readback, {
    status: 'present', value: { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false },
  });
  assert.equal(plane.compare(id, readback.value), true);
  assert.equal(plane.compare(id, {
    ...readback.value, includedPermissions: ['storage.buckets.get', 'storage.buckets.list'],
  }), false);
  assert.equal(plane.compare(id, { ...readback.value, stage: 'BETA' }), false);

  await plane.create(id);
  assert.deepEqual(calls[0], [
    'iam', 'roles', 'describe', ACCEPTANCE_BUCKET_METADATA_ROLE.id,
    `--project=${PROJECT}`, '--format=json',
  ]);
  assert.deepEqual(calls[1], [
    'iam', 'roles', 'create', ACCEPTANCE_BUCKET_METADATA_ROLE.id,
    `--project=${PROJECT}`,
    `--title=${ACCEPTANCE_BUCKET_METADATA_ROLE.title}`,
    `--description=${ACCEPTANCE_BUCKET_METADATA_ROLE.description}`,
    '--permissions=storage.buckets.get', '--stage=GA', '--format=json',
  ]);
});

function exactManagedIamPolicies(contract) {
  const scopes = [
    'project', `bucket:${GCP_IDENTITY.bucket}`, `bucket:${GCP_IDENTITY.buildSourceBucket}`,
    `repository:${GCP_IDENTITY.repository}`,
    ...contract.resources.secrets.map(({ id }) => `secret:${id}`),
    ...contract.resources.serviceAccounts.map(({ id }) => `service-account:${id}`),
  ];
  const policies = Object.fromEntries(scopes.map((scope) => [scope, { bindings: [] }]));
  for (const binding of contract.iam.bindings) {
    policies[binding.scope].bindings.push({
      role: binding.role,
      members: [binding.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER)],
    });
  }
  for (const binding of contract.project.protectedBindings) {
    policies.project.bindings.push({ role: binding.role, members: [binding.member] });
  }
  for (const binding of contract.iam.automaticProjectBindings) {
    policies.project.bindings.push({
      role: binding.role,
      members: [binding.member.replace('__PROJECT_NUMBER__', PROJECT_NUMBER)],
    });
  }
  for (const policy of Object.values(policies)) {
    policy.bindings = policy.bindings.filter((binding, index, bindings) => (
      bindings.findIndex((candidate) => candidate.role === binding.role
        && JSON.stringify(candidate.members) === JSON.stringify(binding.members)) === index
    ));
  }
  return policies;
}

test('managed IAM final readback is an exact per-scope allowlist and forbids workload token creation', async (t) => {
  const contract = await contractFixture();
  const exactPolicies = exactManagedIamPolicies(contract);
  assert.doesNotThrow(() => assertExactManagedIamPolicies({
    contract, projectNumber: PROJECT_NUMBER, policiesByScope: exactPolicies,
  }));
  const realEmptyPolicyShape = clone(exactPolicies);
  delete realEmptyPolicyShape[`secret:${GCP_IDENTITY.secrets.bootstrap}`].bindings;
  assert.doesNotThrow(() => assertExactManagedIamPolicies({
    contract, projectNumber: PROJECT_NUMBER, policiesByScope: realEmptyPolicyShape,
  }));

  const runtime = `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`;
  const deployer = `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`;
  const cases = [
    ['project TokenCreator', 'project', { role: 'roles/iam.serviceAccountTokenCreator', members: [runtime] }],
    ['project Cloud SQL client', 'project', { role: 'roles/cloudsql.client', members: [runtime] }],
    ['bucket storage admin', `bucket:${GCP_IDENTITY.bucket}`, { role: 'roles/storage.admin', members: [runtime] }],
    ['wrong secret access', `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, { role: 'roles/secretmanager.secretAccessor', members: [runtime] }],
    ['repository writer', `repository:${GCP_IDENTITY.repository}`, { role: 'roles/artifactregistry.writer', members: [runtime] }],
    ['SA TokenCreator', 'service-account:hkbuddy-v1-runtime', { role: 'roles/iam.serviceAccountTokenCreator', members: [deployer] }],
    ['public secret access', `secret:${GCP_IDENTITY.secrets.session}`, { role: 'roles/secretmanager.secretAccessor', members: ['allUsers'] }],
    ['external secret access', `secret:${GCP_IDENTITY.secrets.session}`, { role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:foreign@example.test'] }],
    ['external bucket access', `bucket:${GCP_IDENTITY.bucket}`, { role: 'roles/storage.objectViewer', members: ['user:foreign@example.test'] }],
    ['external repository access', `repository:${GCP_IDENTITY.repository}`, { role: 'roles/artifactregistry.reader', members: ['serviceAccount:foreign@example.test'] }],
    ['external SA impersonation', 'service-account:hkbuddy-v1-runtime', { role: 'roles/iam.serviceAccountUser', members: ['user:foreign@example.test'] }],
    ['external project access', 'project', { role: 'roles/viewer', members: ['user:foreign@example.test'] }],
    ['unexpected Google agent role', 'project', { role: 'roles/editor', members: [`serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-cloudbuild.iam.gserviceaccount.com`] }],
    ['legacy Google APIs agent Editor', 'project', { role: 'roles/editor', members: [`serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`] }],
  ];
  for (const [name, scope, unexpected] of cases) {
    await t.test(name, () => {
      const policies = clone(exactPolicies);
      policies[scope].bindings.push(unexpected);
      assert.throws(
        () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
    });
  }

  await t.test('missing service-agent impersonation binding is rejected', () => {
    const policies = clone(exactPolicies);
    policies['service-account:hkbuddy-v1-build'].bindings = [];
    assert.throws(
      () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('missing automatic Cloud Build project grant is rejected', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings = policies.project.bindings.filter(({ role }) => (
      role !== 'roles/cloudbuild.serviceAgent'
    ));
    assert.throws(
      () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('required creator owner binding is exact', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings = policies.project.bindings.filter(({ role }) => role !== 'roles/owner');
    assert.throws(
      () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('all immutable shared-project baseline bindings are exact and allowed', () => {
    for (const { member, role } of contract.project.protectedBindings) {
      const policies = clone(exactPolicies);
      policies.project.bindings = policies.project.bindings.filter((binding) => (
        binding.role !== role || !binding.members.includes(member)
      ));
      assert.throws(
        () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
    }
  });

  await t.test('optional service-agent bindings are rejected before their owning API is enabled', () => {
    assert.throws(
      () => assertExactManagedIamPolicies({
        contract, projectNumber: PROJECT_NUMBER, policiesByScope: exactPolicies,
        enabledApis: new Set(['cloudbuild.googleapis.com']),
      }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });

  await t.test('conditional managed binding is not exact', () => {
    const policies = clone(exactPolicies);
    policies.project.bindings[0].condition = { title: 'temporary', expression: 'request.time < timestamp("2030-01-01T00:00:00Z")' };
    assert.throws(
      () => assertExactManagedIamPolicies({ contract, projectNumber: PROJECT_NUMBER, policiesByScope: policies }),
      (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
    );
  });
});

test('pre-sensitive IAM subset audits reject foreign project owners and secret accessors', async (t) => {
  const contract = await contractFixture();
  for (const [name, projectOnly, policyFor] of [
    ['foreign project owner', true, (scope) => (scope === 'project' ? {
      bindings: [{ role: 'roles/owner', members: ['user:foreign@example.test'] }],
    } : { bindings: [] })],
    ['foreign secret accessor', false, (scope) => (scope === `secret:${GCP_IDENTITY.secrets.dbAppUrl}` ? {
      bindings: [{ role: 'roles/secretmanager.secretAccessor', members: ['serviceAccount:foreign@example.test'] }],
    } : { bindings: [] })],
  ]) {
    await t.test(name, async () => {
      const gcloudCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => {
          gcloudCalls.push(args);
          let scope;
          if (args[0] === 'projects') scope = 'project';
          else if (args[0] === 'storage') scope = `bucket:${GCP_IDENTITY.bucket}`;
          else if (args[0] === 'artifacts') scope = `repository:${GCP_IDENTITY.repository}`;
          else if (args[0] === 'secrets') scope = `secret:${args[2]}`;
          else if (args[0] === 'iam') scope = `service-account:${args[3].split('@')[0]}`;
          else throw new Error('unexpected gcloud operation');
          return policyFor(scope);
        },
        request: async () => { throw new Error('REST must not run'); },
      });
      plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
      await assert.rejects(
        () => plane.auditManagedIamPolicies({ projectOnly }),
        (error) => error.code === 'IAM_ALLOWLIST_MISMATCH',
      );
      assert.equal(gcloudCalls.some((args) => args.some((arg) => /add-iam-policy-binding/.test(arg))), false);
    });
  }
});

test('pre-sensitive managed IAM audit reads the exact custom role definition before secrets', async () => {
  const contract = await contractFixture();
  const gcloudCalls = [];
  let customRole = { ...ACCEPTANCE_BUCKET_METADATA_ROLE, deleted: false };
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
      if (args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list') return [customRole];
      if (args.includes('get-iam-policy')) return { bindings: [] };
      throw new Error('unexpected gcloud operation');
    },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });

  await plane.auditManagedIamPolicies({ projectOnly: false });
  assert.equal(gcloudCalls.some((args) => (
    args[0] === 'iam' && args[1] === 'roles' && args[2] === 'list'
      && args.includes(`--project=${PROJECT}`) && args.includes('--format=json')
  )), true);

  customRole = {
    ...customRole, includedPermissions: ['storage.buckets.get', 'storage.buckets.list'],
  };
  await assert.rejects(
    () => plane.auditManagedIamPolicies({ projectOnly: false }),
    (error) => error.code === 'CUSTOM_ROLE_ALLOWLIST_MISMATCH',
  );
});

function exactBucket({
  name = GCP_IDENTITY.bucket, projectNumber = GCP_IDENTITY.projectNumber,
  lifecycleDeleteAfterDays = 7,
} = {}) {
  return {
    name, projectNumber, location: 'ASIA-EAST2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false },
    softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: lifecycleDeleteAfterDays } }] },
  };
}

function exactBuildSourceBucket(overrides = {}) {
  return exactBucket({
    name: GCP_IDENTITY.buildSourceBucket,
    lifecycleDeleteAfterDays: 1,
    ...overrides,
  });
}

test('readback compares project display name and labels, repository description, and unconditional bucket lifecycle exactly', async () => {
  const contract = await contractFixture();
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const project = {
    projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
    parent: { type: 'organization', id: GCP_IDENTITY.organizationId }, name: 'Motion Expert HK LTD Webpage',
    labels: {},
  };
  assert.equal(plane.compare('project', project), true);
  assert.equal(plane.compare('project', { ...project, name: 'Wrong name' }), false);
  assert.equal(plane.compare('project', {
    ...project, labels: { ...project.labels, unexpected: 'extra' },
  }), false);

  const repository = {
    name: `projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`,
    location: 'asia-east2', format: 'DOCKER', mode: 'STANDARD_REPOSITORY',
    description: 'Hong Kong Buddy production containers',
  };
  assert.equal(plane.compare('artifact-registry', repository), true);
  assert.equal(plane.compare('artifact-registry', { ...repository, description: 'drifted' }), false);
  assert.equal(plane.compare('artifact-registry', { ...repository, mode: 'REMOTE_REPOSITORY' }), false);
  assert.equal(plane.compare('artifact-registry', { ...repository, mode: 'VIRTUAL_REPOSITORY' }), false);

  plane.cache.set('project', project);
  const bucket = exactBucket();
  assert.equal(plane.compare('bucket', bucket), true);
  const conditionalLifecycle = clone(bucket);
  conditionalLifecycle.lifecycle.rule[0].condition.matchesPrefix = ['temporary/'];
  assert.equal(plane.compare('bucket', conditionalLifecycle), false);
});

test('Artifact Registry creation and readback require an exact writable standard repository', async () => {
  const calls = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => { calls.push(args); return {}; },
    request: async () => { throw new Error('REST must not run'); },
  });
  await plane.create('artifact-registry');
  assert.deepEqual(calls, [[
    'artifacts', 'repositories', 'create', GCP_IDENTITY.repository, '--repository-format=docker',
    '--mode=standard-repository', '--location=asia-east2',
    '--description=Hong Kong Buddy production containers', `--project=${PROJECT}`, '--format=json',
  ]]);
});

test('secret container readback rejects expiry, rotation, topics, CMEK, and label drift', async () => {
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  const secret = {
    name: `projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}`,
    replication: { automatic: {} },
    labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
  };
  assert.equal(plane.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, secret), true);
  for (const drifted of [
    { ...secret, expireTime: '2026-09-01T00:00:00Z' },
    { ...secret, ttl: '86400s' },
    { ...secret, rotation: { nextRotationTime: '2026-09-01T00:00:00Z', rotationPeriod: '86400s' } },
    { ...secret, topics: [{ name: `projects/${PROJECT}/topics/rotation` }] },
    { ...secret, replication: { automatic: { customerManagedEncryption: { kmsKeyName: 'projects/foreign/locations/global/keyRings/x/cryptoKeys/y' } } } },
    { ...secret, labels: { ...secret.labels, unexpected: 'extra' } },
  ]) {
    assert.equal(plane.compare(`secret-container:${GCP_IDENTITY.secrets.session}`, drifted), false);
  }
});

test('existing generated secret values must be canonical base64url encodings of exactly 32 bytes', async () => {
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('gcloud must not run'); },
    request: async () => { throw new Error('REST must not run'); },
  });
  plane.cache.set('cloud-sql-instance', { privateIp: '10.25.0.3' });
  const canonical = Buffer.alloc(32, 0x41).toString('base64url');
  const url = (user, password) => `postgresql://${user}:${encodeURIComponent(password)}@10.25.0.3:5432/hkbuddy_v1?sslmode=require`;

  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.session}`, {
    version: '1', secretValue: canonical,
  }), true);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.session}`, {
    version: '1', secretValue: 'A'.repeat(32),
  }), false);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`, {
    version: '1', secretValue: url('hkbuddy_app', canonical),
  }), true);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`, {
    version: '1', secretValue: url('hkbuddy_app', 'x'),
  }), false);
  assert.equal(plane.compare(`secret-version:${GCP_IDENTITY.secrets.dbMigratorUrl}`, {
    version: '1', secretValue: url('hkbuddy_migrator', `${canonical}=`),
  }), false);
});

test('Cloud SQL creation uses the supported v1 REST insert with the named PSA range and exact retention controls', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('Cloud SQL create must not use gcloud argv'); },
    request: async (input) => {
      requests.push(input);
      return { name: 'operation-1', status: 'DONE' };
    },
  });
  await plane.create('cloud-sql-instance');
  assert.deepEqual(requests, [{
    method: 'POST', url: `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`,
    body: {
      name: GCP_IDENTITY.cloudSqlInstance, region: 'asia-east2', databaseVersion: 'POSTGRES_16',
      settings: {
        tier: 'db-custom-1-3840', availabilityType: 'REGIONAL',
        dataDiskType: 'PD_SSD', dataDiskSizeGb: '20', storageAutoResize: true,
        ipConfiguration: {
          ipv4Enabled: false,
          privateNetwork: `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
          allocatedIpRange: GCP_IDENTITY.psaRange, sslMode: 'ENCRYPTED_ONLY',
        },
        backupConfiguration: {
          enabled: true, startTime: '18:00', pointInTimeRecoveryEnabled: true,
          transactionLogRetentionDays: 7,
          backupRetentionSettings: { retentionUnit: 'COUNT', retainedBackups: 7 },
        },
        deletionProtectionEnabled: true, retainBackupsOnDelete: true,
        finalBackupConfig: { enabled: true, retentionDays: 30 },
      },
    },
  }]);
});

test('global bucket ownership is target-project exact and a foreign collision cannot trigger storage or IAM mutation', async () => {
  const gcloudCalls = [];
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      gcloudCalls.push(args);
       if (args[0] === 'projects' && args[1] === 'describe') {
        return {
          projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
          parent: { type: 'organization', id: GCP_IDENTITY.organizationId }, name: 'Motion Expert HK LTD Webpage',
          labels: {},
         };
       }
       if (args[0] === 'storage' && args[1] === 'buckets' && args[2] === 'describe') {
         return exactBucket({ projectNumber: '999999999999' });
       }
       throw new Error('unexpected gcloud operation');
    },
    request: async (input) => {
      requests.push(input);
      if (input.method === 'GET') return exactBucket({ projectNumber: '999999999999' });
      throw new Error('mutation must not run');
    },
  });
  assert.equal((await plane.read('project')).status, 'present');
  await assert.rejects(() => plane.read('bucket'), (error) => error.code === 'BUCKET_ID_COLLISION');
  assert.equal(requests.length, 0);
  assert.equal(gcloudCalls.some((args) => args.includes('add-iam-policy-binding')), false);
});

test('bucket insert request contains only writable exact controls and readback includes target projectNumber', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects' && args[1] === 'describe') {
        return {
          projectId: PROJECT, projectNumber: '123456789012', lifecycleState: 'ACTIVE',
          parent: { type: 'organization', id: '797368190621' },
          labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
        };
      }
      throw new Error('unexpected gcloud operation');
    },
    request: async (input) => { requests.push(input); return exactBucket(); },
  });
  await plane.read('project');
  plane.cache.set('project', { projectNumber: GCP_IDENTITY.projectNumber });
  assert.equal(plane.compare('bucket', exactBucket()), true);
  assert.equal(plane.compare('bucket', exactBucket({ projectNumber: '999999999999' })), false);
  await plane.create('bucket');
  const insert = requests.find(({ method }) => method === 'POST');
  assert.equal(insert.body.locationType, undefined);
  assert.deepEqual(insert.body, {
    name: GCP_IDENTITY.bucket, location: 'asia-east2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false },
    softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 7 } }] },
  });
});

test('build source bucket is regional private lifecycle-bounded non-adopted and idempotent', async () => {
  const contract = await contractFixture();
  assert.deepEqual(contract.resources.buildSourceBucket, {
    name: 'hkbuddy-v1-582852715831-build-source', location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 1,
    retentionPolicy: null,
  });
  assert.equal(EXPECTED_PROVISION_STEPS.includes('build-source-bucket'), true);
  assert.equal(contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.buildSourceBucket}`
      && member === `serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`
      && role === 'roles/storage.objectViewer'
  )), true);

  const requests = [];
  const plane = new GcpControlPlane({
    contract, notificationChannel: CHANNEL,
    gcloud: async () => { throw new Error('source bucket must use Storage JSON API'); },
    request: async (input) => { requests.push(input); return exactBuildSourceBucket(); },
  });
  plane.cache.set('project', { projectNumber: PROJECT_NUMBER });
  assert.equal(plane.compare('build-source-bucket', exactBuildSourceBucket()), true);
  assert.equal(plane.compare('build-source-bucket', exactBuildSourceBucket({ projectNumber: '999999999999' })), false);
  assert.equal(plane.compare('build-source-bucket', exactBucket({
    name: GCP_IDENTITY.buildSourceBucket, lifecycleDeleteAfterDays: 7,
  })), false);
  await plane.create('build-source-bucket');
  assert.deepEqual(requests.find(({ method }) => method === 'POST')?.body, {
    name: GCP_IDENTITY.buildSourceBucket, location: 'asia-east2',
    iamConfiguration: {
      uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
    },
    versioning: { enabled: false }, softDeletePolicy: { retentionDurationSeconds: '0' },
    lifecycle: { rule: [{ action: { type: 'Delete' }, condition: { age: 1 } }] },
  });
});

test('budget readback normalizes an omitted default-false notification field', async () => {
  const budget = {
    name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/123`,
    displayName: 'Hong Kong Buddy Production V1 monthly guard',
    budgetFilter: { projects: ['projects/123456789012'], calendarPeriod: 'MONTH' },
    amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
    thresholdRules: [
      { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
      { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
    ],
    notificationsRule: { monitoringNotificationChannels: [CHANNEL] },
  };
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return {
        projectId: PROJECT, projectNumber: '123456789012', lifecycleState: 'ACTIVE',
        parent: { type: 'organization', id: '797368190621' },
        labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
      };
      throw new Error('unexpected gcloud operation');
    },
    request: async ({ method, url }) => {
      assert.equal(method, 'GET');
      assert.match(url, /billingbudgets\.googleapis\.com/);
      return { budgets: [budget] };
    },
  });
  await plane.read('project');
  const readback = await plane.read('budget');
  assert.deepEqual(readback, { status: 'present', value: { exact: true } });
});

test('budget authority never infers a project number from project name fields', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: NUMERIC_CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return { projectId: PROJECT, name: `projects/${PROJECT_NUMBER}` };
      throw new Error('unexpected gcloud');
    },
    request: async (input) => { requests.push(input); return {}; },
  });
  await plane.read('project');
  await assert.rejects(
    () => plane.create('budget', { notificationChannel: NUMERIC_CHANNEL }),
    (error) => error.code === 'PROJECT_NUMBER_UNAVAILABLE',
  );
  assert.deepEqual(requests, []);
});

test('budget pagination respects the Billing Budgets API maximum page size', async () => {
  const requests = [];
  const plane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: CHANNEL,
    gcloud: async (args) => {
      if (args[0] === 'projects') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
        parent: { type: 'organization', id: '797368190621' }, name: 'Hong Kong Buddy Production V1',
        labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
      };
      throw new Error('unexpected gcloud operation');
    },
    request: async (input) => {
      requests.push(input);
      return { budgets: [] };
    },
  });
  await plane.read('project');
  await plane.read('budget');
  assert.match(requests[0].url, /[?&]pageSize=100(?:&|$)/);
  assert.doesNotMatch(requests[0].url, /pageSize=1000/);
});

test('paginated secret-version, alert-policy, and budget readbacks cannot hide duplicate matches', async (t) => {
  const contract = await contractFixture();

  await t.test('enabled secret versions', async () => {
    const requests = [];
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        if (input.url.includes(':access')) throw new Error('ambiguous versions must stop before access');
        if (input.url.includes('pageToken=second')) return {
          versions: [{ name: `projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}/versions/2`, state: 'ENABLED' }],
        };
        return {
          versions: [{ name: `projects/${PROJECT}/secrets/${GCP_IDENTITY.secrets.session}/versions/1`, state: 'ENABLED' }],
          nextPageToken: 'second',
        };
      },
    });
    assert.deepEqual(await plane.read(`secret-version:${GCP_IDENTITY.secrets.session}`), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });

  await t.test('alert policies', async () => {
    const requests = [];
    const duplicate = { userLabels: { hkbuddy_contract: 'sql_backup_failure' } };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async (input) => {
        requests.push(input);
        return input.url.includes('pageToken=second')
          ? { alertPolicies: [duplicate] }
          : { alertPolicies: [duplicate], nextPageToken: 'second' };
      },
    });
    assert.deepEqual(await plane.read('monitoring-policy:sql-backup-failure'), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });

  await t.test('budgets', async () => {
    const requests = [];
    const duplicate = { displayName: 'Hong Kong Buddy Production V1 monthly guard' };
    const plane = new GcpControlPlane({
      contract, notificationChannel: CHANNEL,
      gcloud: async (args) => {
        if (args[0] === 'projects') return {
          projectId: PROJECT, projectNumber: PROJECT_NUMBER, lifecycleState: 'ACTIVE',
          parent: { type: 'organization', id: '797368190621' }, name: 'Hong Kong Buddy Production V1',
          labels: { application: 'hong-kong-buddy', environment: 'production-v1' },
        };
        throw new Error('unexpected gcloud operation');
      },
      request: async (input) => {
        requests.push(input);
        return input.url.includes('pageToken=second')
          ? { budgets: [duplicate] }
          : { budgets: [duplicate], nextPageToken: 'second' };
      },
    });
    await plane.read('project');
    assert.deepEqual(await plane.read('budget'), {
      status: 'present', value: { exact: false },
    });
    assert.equal(requests.length, 2);
  });
});

test('malformed successful list responses are ambiguous and can never trigger duplicate creation', async (t) => {
  for (const body of [null, 'not-an-object', []]) {
    await t.test(JSON.stringify(body), async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { requests.push(input); return body; },
      });
      await assert.rejects(
        () => plane.read(`secret-version:${GCP_IDENTITY.secrets.session}`),
        (error) => error.code === 'PAGINATION_AMBIGUOUS',
      );
      assert.equal(requests.every(({ method }) => method === 'GET'), true);
    });
  }
});

test('every non-paginated list readback rejects malformed shapes before any create', async (t) => {
  for (const body of [null, 'not-an-array', {}]) {
    await t.test(`gcloud arrays ${JSON.stringify(body)}`, async () => {
      for (const id of ['apis', 'psa-connection']) {
        const calls = [];
        const plane = new GcpControlPlane({
          contract: await contractFixture(), notificationChannel: CHANNEL,
          gcloud: async (args) => { calls.push(args); return body; },
          request: async () => { throw new Error('REST must not run'); },
        });
        await assert.rejects(() => plane.read(id), (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS');
        assert.equal(calls.some((args) => args.includes('enable') || args.includes('connect')), false);
      }
    });
  }

  for (const body of [null, 'not-an-object', [], { items: null }]) {
    await t.test(`SQL users ${JSON.stringify(body)}`, async () => {
      const requests = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async () => { throw new Error('gcloud must not run'); },
        request: async (input) => { requests.push(input); return body; },
      });
      await assert.rejects(
        () => plane.read('db-user:hkbuddy_app'),
        (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
      );
      assert.equal(requests.every(({ method }) => method === 'GET'), true);
    });
  }

  await t.test('SQL users may omit items to express an exact empty list', async () => {
    const plane = new GcpControlPlane({
      contract: await contractFixture(), notificationChannel: CHANNEL,
      gcloud: async () => { throw new Error('gcloud must not run'); },
      request: async () => ({}),
    });
    assert.deepEqual(await plane.read('db-user:hkbuddy_app'), { status: 'absent' });
  });

  for (const body of [null, 'not-an-array', {}]) {
    await t.test(`CIDR sources ${JSON.stringify(body)}`, async () => {
      const calls = [];
      const plane = new GcpControlPlane({
        contract: await contractFixture(), notificationChannel: CHANNEL,
        gcloud: async (args) => { calls.push(args); return body; },
        request: async () => { throw new Error('REST must not run'); },
      });
      await assert.rejects(() => plane.create('subnet'), (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS');
      assert.equal(calls.some((args) => args[0] === 'compute' && args[3] === 'create'), false);
    });
  }
});

test('PSA connection readback selects only the exact service network and range and rejects duplicates', async () => {
  const targetNetwork = `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
  const exactConnection = {
    service: 'servicenetworking.googleapis.com', network: targetNetwork,
    reservedPeeringRanges: [GCP_IDENTITY.psaRange],
  };
  for (const [listing, expected] of [
    [[
      { service: 'other.googleapis.com', network: targetNetwork, reservedPeeringRanges: ['foreign'] },
      exactConnection,
    ], { status: 'present', value: exactConnection }],
    [[{ service: 'other.googleapis.com', network: targetNetwork, reservedPeeringRanges: ['foreign'] }], { status: 'absent' }],
  ]) {
    const plane = new GcpControlPlane({
      contract: await contractFixture(), notificationChannel: NUMERIC_CHANNEL,
      gcloud: async () => listing,
      request: async () => { throw new Error('REST must not run'); },
    });
    assert.deepEqual(await plane.read('psa-connection'), expected);
  }
  const duplicatePlane = new GcpControlPlane({
    contract: await contractFixture(), notificationChannel: NUMERIC_CHANNEL,
    gcloud: async () => [exactConnection, { ...exactConnection }],
    request: async () => { throw new Error('REST must not run'); },
  });
  await assert.rejects(
    () => duplicatePlane.read('psa-connection'),
    (error) => error.code === 'LIST_RESPONSE_AMBIGUOUS',
  );
});

function preflightGcloud({
  projectPresent = true, forbidden = false, billingCurrency = 'HKD',
  activeAccount = 'admin@motionexp.com', organizationResponse, billingAccountResponse,
  projectResponse, billingLinkResponse,
} = {}) {
  const calls = [];
  const gcloud = async (args) => {
    calls.push(args);
    if (forbidden && args[0] === 'projects') {
      const error = new Error('forbidden');
      error.code = 'FORBIDDEN';
      throw error;
    }
    if (args[0] === 'auth') return [{ account: activeAccount, status: 'ACTIVE' }];
    if (args[0] === 'organizations') return organizationResponse ?? {
      name: 'organizations/797368190621', displayName: 'motionexp.com', lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'billing' && args[1] === 'accounts') return {
      name: 'billingAccounts/01F9FD-24EA9B-A9232C', open: true, currencyCode: billingCurrency,
      ...billingAccountResponse,
    };
    if (args[0] === 'billing' && args[1] === 'projects') return {
      billingEnabled: true, billingAccountName: 'billingAccounts/01F9FD-24EA9B-A9232C',
      ...billingLinkResponse,
    };
    if (args[0] === 'services' && args[1] === 'list') return [
      { config: { name: 'iam.googleapis.com' } }, { config: { name: 'serviceusage.googleapis.com' } },
    ];
    if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
    if (args[0] === 'compute' && args[1] === 'networks' && args.includes('list')) return [{
      name: 'default', selfLink: `projects/${PROJECT}/global/networks/default`,
    }];
    if (args[0] === 'compute' && args[1] === 'networks' && args[2] === 'subnets') return [];
    if (args[0] === 'compute' && ['routes', 'addresses'].includes(args[1])) return [];
    if (args[0] === 'services' && args[1] === 'vpc-peerings') return [];
    if (args[0] === 'iam' && ['service-accounts', 'roles'].includes(args[1]) && args.includes('list')) return [];
    if (args[0] === 'compute' && args[1] === 'networks') return {
      name: 'default', autoCreateSubnetworks: true,
    };
    if (args[0] === 'projects') {
      if (args[1] === 'get-iam-policy') return {
        bindings: [
          { role: 'roles/owner', members: ['user:admin@motionexp.com'] },
          { role: 'roles/compute.serviceAgent', members: [`serviceAccount:service-${PROJECT_NUMBER}@compute-system.iam.gserviceaccount.com`] },
          { role: 'roles/editor', members: [`serviceAccount:${PROJECT_NUMBER}@cloudservices.gserviceaccount.com`] },
        ],
      };
      if (projectPresent) return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
        ...projectResponse,
      };
      const error = new Error('not found');
      error.code = 'NOT_FOUND';
      throw error;
    }
    const error = new Error(`not found ${args.join(' ')}`);
    error.code = 'NOT_FOUND';
    throw error;
  };
  return { calls, gcloud };
}

test('preflight is read-only, project-explicit, and requires the existing shared project', async () => {
  const fixture = preflightGcloud();
  const output = [];
  const result = await runGcpPreflight({
    contract: await contractFixture(),
    gcloud: fixture.gcloud,
    getRestPrincipal: async () => 'admin@motionexp.com',
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(result.publicReport, {
    status: 'dry-run', code: 'GCP_PREFLIGHT_COMPLETE', projectId: PROJECT,
    projectNumber: PROJECT_NUMBER, projectState: 'present',
    alertChannel: 'not-supplied', mutationPerformed: false,
  });
  assert.equal(fixture.calls.some((args) => args[0] === 'services' && args[1] === 'list'), true);
  assert.equal(fixture.calls.every((args) => args.includes(`--project=${PROJECT}`)), true);
  assert.equal(fixture.calls.some((args) => args.includes('create') || args.includes('enable') || args.includes('link')), false);
  assert.deepEqual(output, [`${JSON.stringify(result.publicReport)}\n`]);
});

test('preflight and real control plane reject every noncanonical authority shape before inventory or mutation', async (t) => {
  const cases = [
    ['organization suffix', { organizationResponse: { name: `organizations/${GCP_IDENTITY.organizationId}/extra` } }],
    ['organization case', { organizationResponse: { name: `Organizations/${GCP_IDENTITY.organizationId}` } }],
    ['billing suffix', { billingAccountResponse: { name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/extra` } }],
    ['billing delimiter', { billingAccountResponse: { name: `billingAccounts:${GCP_IDENTITY.billingAccountId}` } }],
    ['project parent missing type', { projectResponse: { parent: { id: GCP_IDENTITY.organizationId } } }],
    ['project parent extra segment', { projectResponse: { parent: `organizations/${GCP_IDENTITY.organizationId}/extra` } }],
    ['billing link suffix', { billingLinkResponse: { billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}/extra` } }],
    ['billing link missing field', { billingLinkResponse: { billingAccountName: undefined } }],
  ];
  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fixture = preflightGcloud(overrides);
      const result = await runGcpPreflight({
        contract: await contractFixture(), gcloud: fixture.gcloud,
        getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(fixture.calls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')), false);
    });
  }

  for (const [name, overrides] of cases.filter(([label]) => label.startsWith('project parent')
    || label.startsWith('billing link'))) {
    await t.test(`GcpControlPlane ${name}`, async () => {
      const contract = await contractFixture();
      const fixture = assetAuditControlPlane({
        contract, assets: [], projectResponse: overrides.projectResponse,
        billingLinkResponse: overrides.billingLinkResponse,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'SHARED_PROJECT_BASELINE_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('real control plane independently validates canonical organization and billing account before Cloud Asset', async (t) => {
  const contract = await contractFixture();
  const unavailable = Object.assign(new Error('authority unavailable'), { code: 'TRANSPORT_AMBIGUOUS' });
  const cases = [
    ['organization malformed', { organizationResponse: { name: 'organizations/not-canonical' } }],
    ['organization inactive', { organizationResponse: { lifecycleState: 'DELETE_REQUESTED' } }],
    ['organization ambiguous', { organizationResponse: [] }],
    ['organization unavailable', { organizationResponse: unavailable }],
    ['billing malformed', { billingAccountResponse: { name: 'billingAccounts/not-canonical' } }],
    ['billing closed', { billingAccountResponse: { open: false } }],
    ['billing wrong currency', { billingAccountResponse: { currencyCode: 'USD' } }],
    ['billing ambiguous', { billingAccountResponse: [] }],
    ['billing unavailable', { billingAccountResponse: unavailable }],
  ];

  for (const [name, overrides] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [], ...overrides });
      const originalGcloud = fixture.plane.gcloud;
      fixture.plane.gcloud = async (args, options) => {
        if (args[0] === 'organizations' && overrides.organizationResponse instanceof Error) {
          throw overrides.organizationResponse;
        }
        if (args[0] === 'billing' && args[1] === 'accounts'
          && overrides.billingAccountResponse instanceof Error) {
          throw overrides.billingAccountResponse;
        }
        return originalGcloud(args, options);
      };
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'SHARED_PROJECT_BASELINE_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args[0] === 'asset'
        || args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  const exact = assetAuditControlPlane({ contract, assets: [] });
  await exact.plane.auditPreMutationState();
  assert.deepEqual(exact.gcloudCalls.slice(0, 4).map((args) => args.slice(0, 3)), [
    ['projects', 'describe', PROJECT],
    ['billing', 'projects', 'describe'],
    ['organizations', 'describe', GCP_IDENTITY.organizationId],
    ['billing', 'accounts', 'describe'],
  ]);
  const assetIndex = exact.gcloudCalls.findIndex((args) => args[0] === 'asset');
  assert.equal(assetIndex > 3, true);
});

test('real control plane rejects each missing protected baseline binding before any mutation', async (t) => {
  const contract = await contractFixture();
  for (const missing of contract.project.protectedBindings) {
    await t.test(`${missing.role} ${missing.member}`, async () => {
      const gcloudCalls = [];
      const restCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => {
          gcloudCalls.push(args);
          if (args[0] === 'projects' && args[1] === 'describe') return {
            projectId: PROJECT, projectNumber: PROJECT_NUMBER,
            parent: { type: 'organization', id: GCP_IDENTITY.organizationId }, name: 'Motion Expert HK LTD Webpage',
            labels: {}, lifecycleState: 'ACTIVE',
          };
          if (args[0] === 'organizations' && args[1] === 'describe') return {
            name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
          };
          if (args[0] === 'billing' && args[1] === 'accounts') return {
            name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
          };
          if (args[0] === 'billing' && args[1] === 'projects') return {
            billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
          };
          if (args[0] === 'services' && args[1] === 'list') return [
            { config: { name: 'iam.googleapis.com' } }, { config: { name: 'serviceusage.googleapis.com' } },
          ];
          if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
          if (args[0] === 'projects' && args[1] === 'get-iam-policy') return {
            bindings: contract.project.protectedBindings.filter((binding) => binding !== missing).map(({ role, member }) => ({ role, members: [member] })),
          };
          throw new Error(`unexpected gcloud ${args.join(' ')}`);
        },
        request: async (input) => { restCalls.push(input); throw new Error('REST must not run'); },
      });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract, controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(gcloudCalls.some((args) => args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding') || args.includes('set-iam-policy')
        || args.includes('remove-iam-policy-binding')), false);
      assert.deepEqual(restCalls, []);
    });
  }
});

test('real control plane completes the no-channel discovery stage with only API enablement', async () => {
  const contract = await contractFixture();
  const calls = [];
  const enabledBefore = ['iam.googleapis.com', 'serviceusage.googleapis.com'];
  const allApis = [
    'cloudresourcemanager.googleapis.com', 'serviceusage.googleapis.com', 'cloudbilling.googleapis.com',
    'billingbudgets.googleapis.com', 'iam.googleapis.com', 'artifactregistry.googleapis.com',
    'cloudbuild.googleapis.com', 'run.googleapis.com', 'compute.googleapis.com', 'servicenetworking.googleapis.com',
    'sqladmin.googleapis.com', 'storage.googleapis.com', 'secretmanager.googleapis.com', 'aiplatform.googleapis.com',
    'speech.googleapis.com', 'texttospeech.googleapis.com', 'monitoring.googleapis.com', 'logging.googleapis.com',
  ];
  let apisEnabled = false;
  const notFound = () => Object.assign(new Error('not found'), { code: 'NOT_FOUND' });
  const plane = new GcpControlPlane({
    contract, notificationChannel: null,
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'projects' && args[1] === 'describe') return {
        projectId: PROJECT, projectNumber: PROJECT_NUMBER,
        parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
        name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
      };
      if (args[0] === 'organizations' && args[1] === 'describe') return {
        name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
      };
      if (args[0] === 'billing' && args[1] === 'accounts') return {
        name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
      };
      if (args[0] === 'billing' && args[1] === 'projects') return {
        billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
      };
      if (args[0] === 'projects' && args[1] === 'get-iam-policy') return {
        bindings: contract.project.protectedBindings.map(({ role, member }) => ({ role, members: [member] })),
      };
      if (args[0] === 'asset' && args[1] === 'search-all-resources') return [];
      if (args[0] === 'iam' && args.includes('list')) return [];
      if (args[0] === 'services' && args[1] === 'list') return (apisEnabled ? allApis : enabledBefore).map((name) => ({ config: { name } }));
      if (args[0] === 'services' && args[1] === 'enable') { apisEnabled = true; return {}; }
      throw notFound();
    },
    request: async () => { throw new Error('REST must not run before channel'); },
  });
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`], contract, controlPlane: plane, writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'ALERT_CHANNEL_REQUIRED');
  assert.deepEqual(calls.find((args) => args[0] === 'asset' && args[1] === 'search-all-resources'), [
    'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
    `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
    `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
    '--order-by=assetType,name', '--format=json',
  ]);
  assert.equal(calls.some((args) => args.includes(`--project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`)), false);
  assert.deepEqual(calls.filter((args) => args.includes('enable')).map((args) => args.slice(0, 2)), [['services', 'enable']]);
  assert.equal(calls.some((args) => args.includes('create') || args.includes('add-iam-policy-binding')), false);
});

test('real Cloud Asset audit fails closed before host mutation for disabled-service inventory ambiguity and foreign aliases', async (t) => {
  const contract = await contractFixture();
  const baseline = async (args, assets) => {
    if (args[0] === 'projects' && args[1] === 'describe') return {
      projectId: PROJECT, projectNumber: PROJECT_NUMBER,
      parent: { type: 'organization', id: GCP_IDENTITY.organizationId },
      name: 'Motion Expert HK LTD Webpage', labels: {}, lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'organizations' && args[1] === 'describe') return {
      name: `organizations/${GCP_IDENTITY.organizationId}`, lifecycleState: 'ACTIVE',
    };
    if (args[0] === 'billing' && args[1] === 'accounts') return {
      name: `billingAccounts/${GCP_IDENTITY.billingAccountId}`, open: true, currencyCode: 'HKD',
    };
    if (args[0] === 'billing' && args[1] === 'projects') return {
      billingEnabled: true, billingAccountName: `billingAccounts/${GCP_IDENTITY.billingAccountId}`,
    };
    if (args[0] === 'asset' && args[1] === 'search-all-resources') {
      if (assets instanceof Error) throw assets;
      return assets;
    }
    throw new Error(`unexpected gcloud ${args.join(' ')}`);
  };
  const targetProject = `projects/${PROJECT}`;
  const unavailable = Object.assign(new Error('Cloud Asset API is disabled'), { code: 'FORBIDDEN' });
  const overflow = Object.assign(new Error('stdout maxBuffer length exceeded'), {
    code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
  });
  const cases = [
    ...[
      ['Cloud Run service', 'run.googleapis.com/Service', `//run.googleapis.com/${targetProject}/locations/asia-east2/services/hkbuddy-v1-foreign`],
      ['VPC', 'compute.googleapis.com/Network', `//compute.googleapis.com/${targetProject}/global/networks/hkbuddy-v1-foreign`],
      ['Artifact Registry repository', 'artifactregistry.googleapis.com/Repository', `//artifactregistry.googleapis.com/${targetProject}/locations/asia-east2/repositories/hkbuddy-v1-foreign`],
      ['Cloud SQL instance', 'sqladmin.googleapis.com/Instance', `//sqladmin.googleapis.com/${targetProject}/instances/hkbuddy-v1-foreign`],
      ['bucket', 'storage.googleapis.com/Bucket', '//storage.googleapis.com/hkbuddy-v1-foreign'],
      ['secret', 'secretmanager.googleapis.com/Secret', `//secretmanager.googleapis.com/${targetProject}/secrets/hkbuddy-v1-foreign`],
      ['custom role', 'iam.googleapis.com/Role', `//iam.googleapis.com/${targetProject}/roles/hkbuddyV1Foreign`],
    ].map(([family, assetType, name]) => [`disabled-service foreign ${family} alias`, [cloudAsset({
      name, assetType, project: ASSET_PROJECT,
      displayName: family === 'custom role' ? 'hkbuddyV1Foreign' : 'hkbuddy-v1-foreign',
      location: family === 'custom role' ? 'global' : 'asia-east2',
    })], 'RESOURCE_COLLISION']),
    ['ambiguous asset payload', [{ name: 'missing-asset-type', project: targetProject }], 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'],
    ['wrong project asset', [{
      name: '//run.googleapis.com/projects/foreign/locations/asia-east2/services/hkbuddy-v1-foreign',
      assetType: 'run.googleapis.com/Service', project: 'projects/999999999999', displayName: 'hkbuddy-v1-foreign',
      parentFullResourceName: '//cloudresourcemanager.googleapis.com/projects/999999999999',
      parentAssetType: ASSET_PROJECT_TYPE, location: 'asia-east2', labels: {}, state: 'ACTIVE',
    }], 'CLOUD_ASSET_INVENTORY_WRONG_PROJECT'],
    ['Cloud Asset unavailable', unavailable, 'CLOUD_ASSET_INVENTORY_UNAVAILABLE'],
    ['Cloud Asset output overflow', overflow, 'CLOUD_ASSET_INVENTORY_UNAVAILABLE'],
  ];
  for (const [name, assets, code] of cases) {
    await t.test(name, async () => {
      const calls = [];
      const restCalls = [];
      const plane = new GcpControlPlane({
        contract, notificationChannel: CHANNEL,
        gcloud: async (args) => { calls.push(args); return baseline(args, assets); },
        request: async (input) => { restCalls.push(input); throw new Error('REST must not run'); },
      });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract, controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.deepEqual(calls.find((args) => args[0] === 'asset'), [
        'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
        `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
        `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
        '--order-by=assetType,name', '--format=json',
      ]);
      assert.equal(calls.some((args) => args.includes('enable') || args.includes('create')
        || args.includes('add-iam-policy-binding') || args.includes('set-iam-policy')
        || args.includes('remove-iam-policy-binding')), false);
      assert.deepEqual(restCalls, []);
    });
  }
});

test('Cloud Asset retrieval is exhaustive and exactly 1000 valid rows cannot imply truncation', async () => {
  const contract = await contractFixture();
  const assets = Array.from({ length: 1_000 }, (_unused, index) => cloudAsset({
    name: `//compute.googleapis.com/projects/${PROJECT}/zones/asia-east2-a/disks/unrelated-${index}`,
    assetType: 'compute.googleapis.com/Disk',
    displayName: `unrelated-${index}`,
    location: 'asia-east2-a',
  }));
  const fixture = assetAuditControlPlane({ contract, assets });
  await fixture.plane.auditPreMutationState();
  const argv = fixture.gcloudCalls.find((args) => args[0] === 'asset');
  assert.equal(argv.includes('--limit=1000'), false);
  assert.deepEqual(argv, [
    'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
    `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
    `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
    '--order-by=assetType,name', '--format=json',
  ]);
  assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
  assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
});

test('Cloud Asset managed identities require exact type name numeric project parent location and metadata shapes', async (t) => {
  const contract = await contractFixture();
  const exactService = cloudAsset();
  const cases = [
    ['expected service token on Secret type', cloudAsset({
      name: `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${GCP_IDENTITY.service}`,
      assetType: 'secretmanager.googleapis.com/Secret',
    })],
    ['malformed full name', cloudAsset({ name: `projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['wrong service prefix', cloudAsset({ name: `//evil.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['wrong project segment', cloudAsset({ name: `//run.googleapis.com/projects/foreign/locations/asia-east2/services/${GCP_IDENTITY.service}` })],
    ['missing parent', { ...exactService, parentFullResourceName: undefined }],
    ['wrong parent', cloudAsset({ parentFullResourceName: '//cloudresourcemanager.googleapis.com/projects/999999999999' })],
    ['wrong parent type', cloudAsset({ parentAssetType: 'run.googleapis.com/Service' })],
    ['wrong location', cloudAsset({ location: 'us-central1' })],
    ['case variant custom role', cloudAsset({
      name: `//iam.googleapis.com/projects/${PROJECT}/roles/HkbuddyV1AcceptanceBucketMetadataReader`,
      assetType: 'iam.googleapis.com/Role', displayName: 'HkbuddyV1AcceptanceBucketMetadataReader',
      location: 'global',
    })],
  ];
  for (const [name, asset] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => ['RESOURCE_COLLISION', 'CLOUD_ASSET_INVENTORY_AMBIGUOUS'].includes(error.code),
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }

  for (const [field, value] of [
    ['displayName', 1], ['description', []], ['location', {}], ['labels', []], ['state', false],
  ]) {
    await t.test(`malformed optional ${field}`, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [cloudAsset({ [field]: value })] });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CLOUD_ASSET_INVENTORY_AMBIGUOUS',
      );
    });
  }
});

test('every exact managed top-level Cloud Asset identity is rejected on every wrong asset type', async (t) => {
  const contract = await contractFixture();
  const identities = [
    ['service', `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`, GCP_IDENTITY.service, 'asia-east2'],
    ['repository', `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`, GCP_IDENTITY.repository, 'asia-east2'],
    ['bucket', `//storage.googleapis.com/${GCP_IDENTITY.bucket}`, GCP_IDENTITY.bucket, 'asia-east2'],
    ['build source bucket', `//storage.googleapis.com/${GCP_IDENTITY.buildSourceBucket}`, GCP_IDENTITY.buildSourceBucket, 'asia-east2'],
    ['sql', `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}`, GCP_IDENTITY.cloudSqlInstance, 'asia-east2'],
    ['network', `//compute.googleapis.com/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`, GCP_IDENTITY.network, 'global'],
    ['subnet', `//compute.googleapis.com/projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}`, GCP_IDENTITY.subnet, 'asia-east2'],
    ['psa range', `//compute.googleapis.com/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`, GCP_IDENTITY.psaRange, 'global'],
    ['psa connection', `//servicenetworking.googleapis.com/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`, GCP_IDENTITY.network, 'global'],
    ...Object.values(GCP_IDENTITY.serviceAccounts).map((email) => [
      `service account ${email}`, `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/${email}`,
      email.split('@')[0], 'global',
    ]),
    ...Object.values(GCP_IDENTITY.secrets).map((id) => [
      `secret ${id}`, `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${id}`, id, 'global',
    ]),
    ...Object.values(GCP_IDENTITY.jobs).map((id) => [
      `job ${id}`, `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/jobs/${id}`, id, 'asia-east2',
    ]),
    ...contract.resources.customRoles.map(({ id }) => [
      `role ${id}`, `//iam.googleapis.com/projects/${PROJECT}/roles/${id}`, id, 'global',
    ]),
  ];
  for (const [label, name, displayName, location] of identities) {
    await t.test(label, async () => {
      const fixture = assetAuditControlPlane({
        contract,
        assets: [cloudAsset({
          name, displayName, location, assetType: 'pubsub.googleapis.com/Topic',
        })],
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'RESOURCE_COLLISION',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Cloud Asset rejects the complete obsolete executable identity set in every metadata surface before mutation', async (t) => {
  const contract = await contractFixture();
  const obsolete = ['hkbuddy', 'hkbuddy-api', 'hkbuddy-pg', 'hkbuddy-prod-vpc'];
  const surfaces = [
    ['name', (value) => ({ name: `//pubsub.googleapis.com/projects/${PROJECT}/topics/${value}` })],
    ['displayName', (value) => ({ displayName: value })],
    ['description', (value) => ({ description: `obsolete ${value} resource` })],
    ['parent name', (value) => ({ parentFullResourceName: `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${value}` })],
    ['parent type', (value) => ({ parentAssetType: `legacy.googleapis.com/${value}` })],
    ['label key', (value) => ({ labels: { [value]: 'legacy' } })],
    ['label value', (value) => ({ labels: { owner: value } })],
  ];
  for (const identity of obsolete) {
    for (const [surface, overrides] of surfaces) {
      await t.test(`${identity} in ${surface}`, async () => {
        const fixture = assetAuditControlPlane({
          contract,
          assets: [cloudAsset({
            name: `//pubsub.googleapis.com/projects/${PROJECT}/topics/unrelated`,
            assetType: 'pubsub.googleapis.com/Topic', displayName: 'unrelated',
            ...overrides(identity),
          })],
        });
        await assert.rejects(
          () => fixture.plane.auditPreMutationState(),
          (error) => error.code === 'RESOURCE_COLLISION',
        );
        assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
        assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
      });
    }
  }
});

test('post-deployment Cloud Run revision and Docker image descendants remain preflight-idempotent only under exact ancestors', async (t) => {
  const contract = await contractFixture();
  const serviceName = `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${GCP_IDENTITY.service}`;
  const repositoryName = `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`;
  const revision = cloudAsset({
    name: `${serviceName}/revisions/${GCP_IDENTITY.service}-abcdef123456`,
    assetType: 'run.googleapis.com/Revision',
    displayName: `${GCP_IDENTITY.service}-abcdef123456`,
    parentFullResourceName: serviceName,
    parentAssetType: 'run.googleapis.com/Service',
  });
  const image = cloudAsset({
    name: `${repositoryName}/dockerImages/${GCP_IDENTITY.service}@sha256:${'a'.repeat(64)}`,
    assetType: 'artifactregistry.googleapis.com/DockerImage',
    displayName: `${GCP_IDENTITY.service}@sha256:${'a'.repeat(64)}`,
    parentFullResourceName: repositoryName,
    parentAssetType: 'artifactregistry.googleapis.com/Repository',
  });
  const exact = [
    cloudAsset(),
    cloudAsset({
      name: repositoryName, assetType: 'artifactregistry.googleapis.com/Repository',
      displayName: GCP_IDENTITY.repository,
    }),
    cloudAsset({
      name: `//storage.googleapis.com/${GCP_IDENTITY.buildSourceBucket}`,
      assetType: 'storage.googleapis.com/Bucket',
      displayName: GCP_IDENTITY.buildSourceBucket,
    }),
    revision, image,
  ];
  const accepted = assetAuditControlPlane({ contract, assets: exact });
  await accepted.plane.auditPreMutationState();

  for (const [name, asset] of [
    ['revision foreign parent', { ...revision, parentFullResourceName: `${serviceName}-foreign` }],
    ['revision wrong type', { ...revision, assetType: 'run.googleapis.com/Job' }],
    ['revision wrong region', { ...revision, name: revision.name.replace('asia-east2', 'us-central1'), location: 'us-central1' }],
    ['revision wrong project', { ...revision, name: revision.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/') }],
    ['revision incompatible name', { ...revision, name: `${serviceName}/revisions/${GCP_IDENTITY.service}-latest`, displayName: `${GCP_IDENTITY.service}-latest` }],
    ['image foreign parent', { ...image, parentFullResourceName: `${repositoryName}-foreign` }],
    ['image wrong type', { ...image, assetType: 'artifactregistry.googleapis.com/Repository' }],
    ['image wrong region', { ...image, name: image.name.replace('asia-east2', 'us-central1'), location: 'us-central1' }],
    ['image wrong project', { ...image, name: image.name.replace(`/projects/${PROJECT}/`, '/projects/foreign/') }],
    ['image incompatible package', { ...image, name: image.name.replace(GCP_IDENTITY.service, 'foreign-image'), displayName: 'foreign-image' }],
  ]) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({ contract, assets: [asset] });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === 'RESOURCE_COLLISION');
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('enabled inventory rejects foreign managed display markers and malformed KRM identities before mutation', async (t) => {
  const contract = await contractFixture();
  const cases = [
    {
      name: 'alert policy foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'monitoring.googleapis.com'],
      restRows: { '/alertPolicies': { alertPolicies: [{ name: `projects/${PROJECT_NUMBER}/alertPolicies/1`, displayName: 'HK Buddy V1 foreign policy', userLabels: {} }] }, '/notificationChannels': { notificationChannels: [] } },
    },
    {
      name: 'notification channel foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'monitoring.googleapis.com'],
      restRows: { '/alertPolicies': { alertPolicies: [] }, '/notificationChannels': { notificationChannels: [{ name: `projects/${PROJECT_NUMBER}/notificationChannels/1`, displayName: 'HK Buddy V1 foreign operations', type: 'email', enabled: true, verificationStatus: 'VERIFIED', userLabels: {} }] } },
    },
    {
      name: 'budget foreign display with generated ID', enabledApis: ['iam.googleapis.com', 'billingbudgets.googleapis.com'],
      restRows: { '/budgets': { budgets: [{ name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/1`, displayName: 'Hong Kong Buddy Production V1 foreign guard', budgetFilter: { projects: [ASSET_PROJECT] } }] } },
    },
    {
      name: 'malformed KRM Cloud Run identity', enabledApis: ['iam.googleapis.com', 'run.googleapis.com'],
      gcloudRows: { 'run services list': [{ metadata: {} }], 'run jobs list': [] },
    },
    {
      name: 'foreign KRM Cloud Run identity', enabledApis: ['iam.googleapis.com', 'run.googleapis.com'],
      gcloudRows: { 'run services list': [{ metadata: { name: 'hkbuddy-v1-foreign' } }], 'run jobs list': [] },
    },
  ];
  for (const fixtureCase of cases) {
    await t.test(fixtureCase.name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: fixtureCase.enabledApis,
        gcloudRows: fixtureCase.gcloudRows, restRows: fixtureCase.restRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => ['RESOURCE_COLLISION', 'LIST_RESPONSE_AMBIGUOUS'].includes(error.code),
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.every(({ method }) => method === 'GET'), true);
    });
  }
});

test('Monitoring policies channels and budgets reject the complete managed-name union before mutation', async (t) => {
  const contract = await contractFixture();
  const managedNames = [
    'hkbuddy-v1-foreign',
    'HK Buddy V1 foreign',
    'Hong Kong Buddy Production V1 foreign',
  ];
  for (const resource of ['policy', 'channel', 'budget']) {
    for (const displayName of managedNames) {
      await t.test(`${resource}: ${displayName}`, async () => {
        const monitoring = resource !== 'budget';
        const restRows = resource === 'policy' ? {
          '/alertPolicies': { alertPolicies: [{ name: `projects/${PROJECT_NUMBER}/alertPolicies/1`, displayName, userLabels: {} }] },
          '/notificationChannels': { notificationChannels: [] },
        } : resource === 'channel' ? {
          '/alertPolicies': { alertPolicies: [] },
          '/notificationChannels': { notificationChannels: [{
            name: `projects/${PROJECT_NUMBER}/notificationChannels/1`, displayName,
            type: 'email', enabled: true, verificationStatus: 'VERIFIED', userLabels: {},
          }] },
        } : {
          '/budgets': { budgets: [{
            name: `billingAccounts/${GCP_IDENTITY.billingAccountId}/budgets/1`, displayName,
            budgetFilter: { projects: [ASSET_PROJECT] },
          }] },
        };
        const fixture = assetAuditControlPlane({
          contract, assets: [],
          enabledApis: ['iam.googleapis.com', monitoring ? 'monitoring.googleapis.com' : 'billingbudgets.googleapis.com'],
          restRows,
        });
        await assert.rejects(
          () => fixture.plane.auditPreMutationState(),
          (error) => error.code === 'RESOURCE_COLLISION',
        );
        assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
        assert.equal(fixture.restCalls.every(({ method }) => method === 'GET'), true);
      });
    }
  }
});

test('real Compute inventory validates malformed rows and includes regional addresses before every mutation', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const networkRow = { name: 'default', selfLink: network, autoCreateSubnetworks: true };
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const cases = [
    ['subnet missing network', {
      'compute networks list': [networkRow],
      'compute networks subnets': [{ name: 'foreign-subnet', ipCidrRange: '10.25.1.0/24', region }],
      'compute routes list': [], 'compute addresses list': [],
    }, 'CIDR_AUDIT_INVALID'],
    ['route missing network', {
      'compute networks list': [networkRow], 'compute networks subnets': [],
      'compute routes list': [{ name: 'foreign-route', destRange: '10.25.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }],
      'compute addresses list': [],
    }, 'CIDR_AUDIT_INVALID'],
    ['PSA address missing network', {
      'compute networks list': [networkRow], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', address: '10.25.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }],
    }, 'CIDR_AUDIT_INVALID'],
    ['regional PSA overlap remains visible', {
      'compute networks list': [networkRow], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{
        name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '10.25.0.0', prefixLength: 16,
        addressType: 'INTERNAL', status: 'RESERVED', region,
      }],
    }, 'CIDR_AUDIT_INVALID'],
  ];
  for (const [name, gcloudRows, code] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === code);
      const addressCalls = fixture.gcloudCalls.filter((args) => args[0] === 'compute' && args[1] === 'addresses' && args.includes('list'));
      assert.equal(addressCalls.length > 0, true);
      assert.equal(addressCalls.some((args) => args.includes('--global')), false);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('every internal RESERVED address family is canonical and participates in project-wide overlap checks', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const subnet = `${region}/subnetworks/default`;
  const base = {
    'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
    'compute networks subnets': [{
      name: 'default', selfLink: subnet, network, region, ipCidrRange: '10.24.0.0/26',
    }],
    'compute routes list': [],
  };
  const cases = [
    ['GCE_ENDPOINT single address overlap', {
      name: 'foreign-endpoint', purpose: 'GCE_ENDPOINT', address: '10.24.0.1',
      addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
      status: 'RESERVED', region, subnetwork: subnet,
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2/addresses/foreign-endpoint`,
    }, 'CIDR_OVERLAP'],
    ['PRIVATE_SERVICE_CONNECT global single address overlap', {
      name: 'foreign-psc', purpose: 'PRIVATE_SERVICE_CONNECT', address: '10.25.0.1',
      addressType: 'INTERNAL', ipVersion: 'IPV4', networkTier: 'PREMIUM',
      status: 'RESERVED', network,
      selfLink: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/foreign-psc`,
    }, 'CIDR_OVERLAP'],
    ['unsupported internal purpose', {
      name: 'foreign-unknown', purpose: 'UNSUPPORTED_FAMILY', address: '192.168.0.1',
      addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
    ['ambiguous single address without purpose', {
      name: 'foreign-incomplete', address: '192.168.0.1',
      addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
    ['noncanonical internal prefix', {
      name: 'foreign-prefix', purpose: 'PRIVATE_NAT', address: '192.168.001.0',
      prefixLength: 24, addressType: 'INTERNAL', status: 'RESERVED', region, network,
    }, 'CIDR_AUDIT_INVALID'],
  ];
  for (const [name, address, code] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'],
        gcloudRows: { ...base, 'compute addresses list': [address] },
      });
      await assert.rejects(() => fixture.plane.auditPreMutationState(), (error) => error.code === code);
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Compute validates malformed referenced rows even when the project network inventory is empty', async (t) => {
  const contract = await contractFixture();
  const missingNetwork = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/missing`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const cases = [
    ['subnet', {
      'compute networks list': [],
      'compute networks subnets': [{ name: 'foreign-subnet', network: missingNetwork, ipCidrRange: '192.168.1.0/24', region }],
      'compute routes list': [], 'compute addresses list': [],
    }],
    ['route', {
      'compute networks list': [], 'compute networks subnets': [],
      'compute routes list': [{ name: 'foreign-route', network: missingNetwork, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }],
      'compute addresses list': [],
    }],
    ['PSA address', {
      'compute networks list': [], 'compute networks subnets': [], 'compute routes list': [],
      'compute addresses list': [{
        name: 'foreign-psa', purpose: 'VPC_PEERING', network: missingNetwork,
        address: '192.168.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED',
      }],
    }],
  ];
  for (const [name, gcloudRows] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('Compute rejects noncanonical resource names URIs regions IPv4 and prefix serialization', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const region = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`;
  const base = {
    'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
    'compute networks subnets': [], 'compute routes list': [], 'compute addresses list': [],
  };
  const cases = [
    ['network name', { ...base, 'compute networks list': [{ name: 'Default', selfLink: `${network.slice(0, -7)}Default` }] }],
    ['network URI', { ...base, 'compute networks list': [{ name: 'default', selfLink: `${network}/extra` }] }],
    ['subnet name', { ...base, 'compute networks subnets': [{ name: 'foreign_subnet', network, ipCidrRange: '192.168.1.0/24', region }] }],
    ['subnet region prefix', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.1.0/24', region: `${region}/extra` }] }],
    ['subnet leading-zero IPv4', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.001.0/24', region }] }],
    ['subnet leading-zero prefix', { ...base, 'compute networks subnets': [{ name: 'foreign-subnet', network, ipCidrRange: '192.168.1.0/024', region }] }],
    ['route name', { ...base, 'compute routes list': [{ name: 'foreign_route', network, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }] }],
    ['route next-hop URI', { ...base, 'compute routes list': [{ name: 'foreign-route', network, destRange: '192.168.1.0/24', nextHopVpnTunnel: `${region}/vpnTunnels/foreign/extra` }] }],
    ['route leading-zero prefix', { ...base, 'compute routes list': [{ name: 'foreign-route', network, destRange: '192.168.1.0/024', nextHopVpnTunnel: `${region}/vpnTunnels/foreign` }] }],
    ['address name', { ...base, 'compute addresses list': [{ name: 'foreign_psa', purpose: 'VPC_PEERING', network, address: '192.168.0.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] }],
    ['address leading-zero IPv4', { ...base, 'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '192.168.000.0', prefixLength: 16, addressType: 'INTERNAL', status: 'RESERVED' }] }],
    ['address string prefix', { ...base, 'compute addresses list': [{ name: 'foreign-psa', purpose: 'VPC_PEERING', network, address: '192.168.0.0', prefixLength: '016', addressType: 'INTERNAL', status: 'RESERVED' }] }],
  ];
  for (const [name, gcloudRows] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'], gcloudRows,
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('project-qualified Compute route next hops reject every foreign project before mutation', async (t) => {
  const contract = await contractFixture();
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const foreign = 'https://www.googleapis.com/compute/v1/projects/foreign-project';
  const cases = [
    ['gateway', { nextHopGateway: `${foreign}/global/gateways/default-internet-gateway` }],
    ['instance', { nextHopInstance: `${foreign}/zones/asia-east2-a/instances/foreign-instance` }],
    ['VPN tunnel', { nextHopVpnTunnel: `${foreign}/regions/asia-east2/vpnTunnels/foreign-tunnel` }],
    ['ILB forwarding rule', { nextHopIlb: `${foreign}/regions/asia-east2/forwardingRules/foreign-ilb` }],
    ['network', { nextHopNetwork: `${foreign}/global/networks/foreign-network` }],
  ];
  for (const [name, nextHop] of cases) {
    await t.test(name, async () => {
      const fixture = assetAuditControlPlane({
        contract, assets: [], enabledApis: ['iam.googleapis.com', 'compute.googleapis.com'],
        gcloudRows: {
          'compute networks list': [{ name: 'default', selfLink: network, autoCreateSubnetworks: true }],
          'compute networks subnets': [],
          'compute routes list': [{
            name: `foreign-${name.toLowerCase().replaceAll(' ', '-')}`, network,
            destRange: '192.168.1.0/24', ...nextHop,
          }],
          'compute addresses list': [],
        },
      });
      await assert.rejects(
        () => fixture.plane.auditPreMutationState(),
        (error) => error.code === 'CIDR_AUDIT_INVALID',
      );
      assert.equal(fixture.gcloudCalls.some((args) => args.includes('enable') || args.includes('create')), false);
      assert.equal(fixture.restCalls.some(({ method }) => method !== 'GET'), false);
    });
  }
});

test('every exact-host Compute route next-hop family remains valid', () => {
  const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/default`;
  const host = `https://www.googleapis.com/compute/v1/projects/${PROJECT}`;
  const cases = [
    { nextHopGateway: `${host}/global/gateways/default-internet-gateway` },
    { nextHopInstance: `${host}/zones/asia-east2-a/instances/host-instance` },
    { nextHopVpnTunnel: `${host}/regions/asia-east2/vpnTunnels/host-tunnel` },
    { nextHopIlb: `${host}/regions/asia-east2/forwardingRules/host-ilb` },
    { nextHopNetwork: network },
    { nextHopIp: '192.168.100.1' },
    { nextHopPeering: 'host-peering' },
  ];
  for (const [index, nextHop] of cases.entries()) {
    assert.doesNotThrow(() => assertCidrAvailable({
      desired: '10.24.0.0/26', network,
      networks: [{ name: 'default', selfLink: network }], subnets: [], addresses: [],
      routes: [{ name: `host-route-${index}`, network, destRange: `192.168.${index}.0/24`, ...nextHop }],
    }));
  }
});

test('preflight verifies an enabled target-project Monitoring channel and fails closed on 403 or unverified status', async (t) => {
  await t.test('billing-account currency must match the exact HKD 2300 budget contract', async () => {
    const fixture = preflightGcloud({ billingCurrency: 'USD' });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'BUDGET_CURRENCY_MISMATCH');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(fixture.calls.some((args) => args.includes('create')), false);
  });

  await t.test('verified channel', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const requests = [];
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: async (input) => {
        requests.push(input);
        return {
          name: CHANNEL, displayName: 'HK Buddy V1 operations',
          userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
          type: 'email', enabled: true, verificationStatus: 'VERIFIED',
        };
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(result.publicReport.alertChannel, 'verified');
    assert.deepEqual(requests, [{ method: 'GET', url: `https://monitoring.googleapis.com/v3/${CHANNEL}` }]);
  });

  await t.test('unverified channel', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com',
      request: async () => ({
        name: CHANNEL, displayName: 'HK Buddy V1 operations',
        userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
        type: 'email', enabled: true, verificationStatus: 'UNVERIFIED',
      }),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
  });

  await t.test('verified non-email channel is rejected before alert or budget work', async () => {
    const fixture = preflightGcloud({ projectPresent: true });
    const result = await runGcpPreflight({
      argv: [`--notification-channel=${CHANNEL}`], contract: await contractFixture(),
      gcloud: fixture.gcloud, getRestPrincipal: async () => 'admin@motionexp.com',
      request: async () => ({
        name: CHANNEL, displayName: 'HK Buddy V1 operations',
        userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations' },
        type: 'sms', enabled: true, verificationStatus: 'VERIFIED',
      }),
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
  });

  await t.test('403 project lookup is a shared-project baseline failure', async () => {
    const fixture = preflightGcloud({ forbidden: true });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'admin@motionexp.com', writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(result.publicReport.projectState, 'unresolved');
    assert.equal(fixture.calls.some((args) => args.includes('create')), false);
  });

  await t.test('gcloud and HTTPS identities must be the same approved principal', async () => {
    const fixture = preflightGcloud();
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'different@example.test', writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('a matching but non-contract operator is rejected before organization checks', async () => {
    const fixture = preflightGcloud({ activeAccount: 'foreign@example.test' });
    const result = await runGcpPreflight({
      contract: await contractFixture(), gcloud: fixture.gcloud,
      getRestPrincipal: async () => 'foreign@example.test', writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'GCP_AUTH_INVALID');
    assert.equal(fixture.calls.length, 1);
    assert.equal(result.publicReport.mutationPerformed, false);
  });
});

test('confirmed provisioning requires the existing shared baseline while other 403s remain fatal', async (t) => {
  await t.test('unresolved project stops before every resource mutation', async () => {
    const plane = new MemoryControlPlane();
    let projectReads = 0;
    const baseRead = plane.read.bind(plane);
    plane.read = async (id, context) => {
      if (id === 'project' && projectReads++ === 0) {
        plane.calls.push(['read', id]);
        return { status: 'unknown', code: 'FORBIDDEN' };
      }
      return baseRead(id, context);
    };
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
  });

  await t.test('a non-project 403 remains a hard stop', async () => {
    const plane = new MemoryControlPlane({ existing: ['project'] });
    const baseRead = plane.read.bind(plane);
    plane.read = async (id, context) => (
      id === 'billing' ? { status: 'unknown', code: 'FORBIDDEN' } : baseRead(id, context)
    );
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'SHARED_PROJECT_BASELINE_INVALID');
    assert.equal(result.publicReport.resumeBoundary, 'billing');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'billing'), false);
  });
});

class MemoryControlPlane {
  constructor({
    existing = [], unverifiedChannel = false, userManagedKey = false,
    finalReadbackFailure = null, iamSubsetFailure = null,
    preMutationFailure = null,
  } = {}) {
    this.resources = new Map([...new Set(['project', 'billing', ...existing])].map((id) => {
      const value = { id, exact: true };
      if (id === 'project') value.projectNumber = PROJECT_NUMBER;
      if (id === 'cloud-sql-instance') value.privateIp = '10.25.0.3';
      if (id.startsWith('secret-version:')) value.version = '1';
      return [id, value];
    }));
    this.calls = [];
    this.unverifiedChannel = unverifiedChannel;
    this.userManagedKey = userManagedKey;
    this.finalReadbackFailure = finalReadbackFailure;
    this.iamSubsetFailure = iamSubsetFailure;
    this.preMutationFailure = preMutationFailure;
    this.secrets = [];
  }

  async read(id) {
    this.calls.push(['read', id]);
    if (id === 'notification-channel') {
      return { status: 'present', value: { id, exact: !this.unverifiedChannel } };
    }
    return this.resources.has(id)
      ? { status: 'present', value: this.resources.get(id) }
      : { status: 'absent' };
  }

  async create(id, context) {
    this.calls.push(['create', id]);
    if (context?.sensitive) this.secrets.push(context.sensitive);
    const value = { id, exact: true };
    if (id === 'project') value.projectNumber = PROJECT_NUMBER;
    if (id === 'cloud-sql-instance') value.privateIp = '10.25.0.3';
    if (id.startsWith('secret-version:')) value.version = '1';
    this.resources.set(id, value);
    return value;
  }

  compare(_id, value) {
    return value?.exact === true;
  }

  value(id) {
    return this.resources.get(id);
  }

  async auditUserManagedServiceAccountKeys() {
    this.calls.push(['audit', 'service-account-keys']);
    if (this.userManagedKey) {
      const error = new Error('user-managed key');
      error.code = 'USER_MANAGED_SERVICE_ACCOUNT_KEY';
      throw error;
    }
  }

  async auditManagedIamPolicies({ projectOnly }) {
    const stage = projectOnly ? 'project' : 'managed';
    this.calls.push(['iam-subset-audit', stage]);
    if (this.iamSubsetFailure === stage) {
      const error = new Error('unexpected IAM entitlement');
      error.code = 'IAM_ALLOWLIST_MISMATCH';
      throw error;
    }
  }

  async auditPreMutationState() {
    this.calls.push(['audit', 'pre-mutation-state']);
    if (this.preMutationFailure) {
      const error = new Error(this.preMutationFailure);
      error.code = this.preMutationFailure;
      throw error;
    }
  }

  async finalReadback() {
    this.calls.push(['final-readback', 'all']);
    if (this.finalReadbackFailure) {
      const error = new Error(this.finalReadbackFailure);
      error.code = this.finalReadbackFailure;
      throw error;
    }
  }
}

test('provisioning is inert by default and requires the one exact confirmation flag', async (t) => {
  for (const argv of [
    [], ['--confirm-project=other-project'],
    [`--confirm-project=${PROJECT}`, '--extra'],
  ]) {
    await t.test(argv.join(' ') || 'no args', async () => {
      const plane = new MemoryControlPlane();
      const result = await runGcpProvision({
        argv, contract: await contractFixture(), controlPlane: plane,
        writeOutput: () => undefined,
      });
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
      if (argv.length > 0) assert.equal(result.publicReport.code, 'EXACT_PROJECT_CONFIRMATION_REQUIRED');
    });
  }
});

test('live provisioning rejects a gcloud/HTTPS identity mismatch before its first mutation', async () => {
  const calls = [];
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(),
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return [{ account: 'admin@motionexp.com', status: 'ACTIVE' }];
      throw new Error('unexpected control-plane call');
    },
    request: async () => { throw new Error('request must not run'); },
    getRestPrincipal: async () => 'different@example.test',
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((args) => args.includes('create')), false);
});

test('live provisioning rejects a non-contract operator even when its CLI and HTTPS identities match', async () => {
  const calls = [];
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(),
    gcloud: async (args) => {
      calls.push(args);
      if (args[0] === 'auth') return [{ account: 'foreign@example.test', status: 'ACTIVE' }];
      throw new Error('unexpected control-plane call');
    },
    request: async () => { throw new Error('request must not run'); },
    getRestPrincipal: async () => 'foreign@example.test',
    writeOutput: () => undefined,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.publicReport.code, 'CONTROL_PLANE_IDENTITY_MISMATCH');
  assert.equal(result.publicReport.mutationPerformed, false);
  assert.equal(calls.some((args) => args.includes('create')), false);
});

test('confirmed provisioning creates every fixed step, performs post-create readback, keeps secrets out of logs, and returns numeric versions', async () => {
  const plane = new MemoryControlPlane();
  const output = [];
  const secretValues = [Buffer.alloc(32, 0x41), Buffer.alloc(32, 0x42), Buffer.alloc(32, 0x43)];
  let randomIndex = 0;
  const result = await runGcpProvision({
    argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
    contract: await contractFixture(), controlPlane: plane,
    randomBytes: () => secretValues[randomIndex++],
    writeOutput: (line) => output.push(line),
  });

  assert.equal(result.exitCode, 0);
  assert.equal(result.publicReport.status, 'provisioned');
  assert.equal(result.publicReport.mutationPerformed, true);
  assert.deepEqual(result.publicReport.secretVersions, {
    [GCP_IDENTITY.secrets.dbAppUrl]: '1', [GCP_IDENTITY.secrets.dbMigratorUrl]: '1',
    [GCP_IDENTITY.secrets.session]: '1', [GCP_IDENTITY.secrets.bootstrap]: '1',
  });
  assert.equal(Object.values(result.publicReport.secretVersions).every((value) => /^\d+$/.test(value)), true);
  assert.equal(JSON.stringify(result).includes('latest'), false);

  const created = plane.calls.filter(([kind]) => kind === 'create').map(([, id]) => id);
  assert.deepEqual(created, EXPECTED_PROVISION_STEPS.filter((id) => (
    !['project', 'billing', 'notification-channel'].includes(id)
  )));
  for (const id of created) {
    const sequence = plane.calls.filter(([kind, candidate]) => (
      ['read', 'create'].includes(kind) && candidate === id
    )).map(([kind]) => kind);
    assert.deepEqual(sequence, ['read', 'create', 'read'], id);
  }
  assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'notification-channel'), false);

  const serializedCommands = JSON.stringify(plane.calls);
  const serializedOutput = output.join('');
  for (const secret of secretValues.map((value) => value.toString('base64url'))) {
    assert.equal(serializedCommands.includes(secret), false);
    assert.equal(serializedOutput.includes(secret), false);
  }
  assert.equal(plane.secrets.length >= 4, true);
  assert.equal(plane.calls.some(([kind]) => kind === 'final-readback'), true);
});

test('exhaustive pre-mutation audit rejects managed collisions and network overlap before every write', async (t) => {
  for (const code of ['RESOURCE_COLLISION', 'CIDR_OVERLAP', 'IAM_ALLOWLIST_MISMATCH']) {
    await t.test(code, async () => {
      const plane = new MemoryControlPlane({ preMutationFailure: code });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, code);
      assert.equal(result.publicReport.mutationPerformed, false);
      assert.deepEqual(plane.calls.filter(([kind]) => kind === 'create'), []);
      assert.deepEqual(plane.calls.filter(([kind]) => kind === 'audit'), [['audit', 'pre-mutation-state']]);
    });
  }
});

test('service-account key and mandatory final-readback gates prevent a false provisioning success', async (t) => {
  await t.test('channel verification and budget precede every costly topology, secret, or IAM mutation', async () => {
    for (const { argv, plane, expectedCode } of [
      {
        argv: [`--confirm-project=${PROJECT}`],
        plane: new MemoryControlPlane(), expectedCode: 'ALERT_CHANNEL_REQUIRED',
      },
      {
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        plane: new MemoryControlPlane({ unverifiedChannel: true }), expectedCode: 'ALERT_CHANNEL_UNVERIFIED',
      },
    ]) {
      const result = await runGcpProvision({
        argv, contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, expectedCode);
      assert.deepEqual(
        plane.calls.filter(([kind]) => kind === 'create').map(([, id]) => id),
        ['apis'],
      );
      assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
        ['vpc', 'subnet', 'psa-range', 'psa-connection', 'cloud-sql-instance', 'database', 'bucket'].includes(id)
          || id.startsWith('secret-') || id.startsWith('iam:')
      )), false);
    }
    assert.equal(EXPECTED_PROVISION_STEPS.indexOf('notification-channel') < EXPECTED_PROVISION_STEPS.indexOf('budget'), true);
    assert.equal(EXPECTED_PROVISION_STEPS.indexOf('budget') < EXPECTED_PROVISION_STEPS.indexOf('vpc'), true);
  });

  await t.test('foreign project or managed-resource IAM stops before every sensitive write', async () => {
    for (const iamSubsetFailure of ['project', 'managed']) {
      const plane = new MemoryControlPlane({ iamSubsetFailure });
      const result = await runGcpProvision({
        argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
        contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
      });
      assert.equal(result.exitCode, 1);
      assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
      assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
        id.startsWith('secret-version:') || id.startsWith('db-user:')
      )), false);
    }
  });

  await t.test('user-managed key stops immediately after service accounts and before resource or secret grants', async () => {
    const plane = new MemoryControlPlane({ userManagedKey: true });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'USER_MANAGED_SERVICE_ACCOUNT_KEY');
    assert.equal(result.publicReport.resumeBoundary, 'service-account-key-audit');
    const auditIndex = plane.calls.findIndex(([, id]) => id === 'service-account-keys');
    assert.equal(auditIndex > 0, true);
    assert.equal(plane.calls.slice(auditIndex + 1).some(([kind]) => kind === 'create'), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && (
      id.startsWith('secret-') || id.startsWith('iam:') || id === 'vpc'
    )), false);
  });

  await t.test('control plane without finalReadback is invalid before mutation', async () => {
    let creates = 0;
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(),
      controlPlane: {
        read: async () => ({ status: 'absent' }),
        create: async () => { creates += 1; },
        compare: () => true,
        auditUserManagedServiceAccountKeys: async () => undefined,
      },
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'CONTROL_PLANE_INVALID');
    assert.equal(result.publicReport.mutationPerformed, false);
    assert.equal(creates, 0);
  });

  await t.test('final readback failure prevents GCP_PROVISION_COMPLETE', async () => {
    const plane = new MemoryControlPlane({ finalReadbackFailure: 'IAM_ALLOWLIST_MISMATCH' });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane, writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
    assert.equal(result.publicReport.resumeBoundary, 'final-readback');
    assert.equal(result.publicReport.status, 'failed');
  });
});

test('safe partial rerun skips exact resources, stops on drift, and preserves a precise resume boundary', async (t) => {
  await t.test('exact rerun does not recreate resources', async () => {
    const plane = new MemoryControlPlane({ existing: EXPECTED_PROVISION_STEPS });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('post-audit failure before an idempotent run attempts any create remains non-mutating', async () => {
    const plane = new MemoryControlPlane({
      existing: EXPECTED_PROVISION_STEPS,
      iamSubsetFailure: 'project',
    });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'IAM_ALLOWLIST_MISMATCH');
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), false);
    assert.equal(result.publicReport.mutationPerformed, false);
  });

  await t.test('ambiguous create failure remains conservatively mutation-performed', async () => {
    const plane = new MemoryControlPlane();
    plane.create = async (id) => {
      plane.calls.push(['create', id]);
      throw Object.assign(new Error('response lost'), { code: 'CREATE_RESULT_AMBIGUOUS' });
    };
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(plane.calls.some(([kind]) => kind === 'create'), true);
    assert.equal(result.publicReport.mutationPerformed, true);
  });

  await t.test('drift stops before later mutation', async () => {
    const plane = new MemoryControlPlane();
    plane.resources.set('vpc', { id: 'vpc', exact: false });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'RESOURCE_DRIFT');
    assert.equal(result.publicReport.resumeBoundary, 'vpc');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'subnet'), false);
  });

  await t.test('unverified alert channel blocks policies and budget', async () => {
    const plane = new MemoryControlPlane({ unverifiedChannel: true });
    const result = await runGcpProvision({
      argv: [`--confirm-project=${PROJECT}`, `--notification-channel=${CHANNEL}`],
      contract: await contractFixture(), controlPlane: plane,
      writeOutput: () => undefined,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.publicReport.code, 'ALERT_CHANNEL_UNVERIFIED');
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id.startsWith('monitoring-policy:')), false);
    assert.equal(plane.calls.some(([kind, id]) => kind === 'create' && id === 'budget'), false);
  });
});

test('package scripts expose guarded preflight/provision commands and syntax-check both entrypoints', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.scripts['gcp:preflight'], 'node scripts/gcp-preflight.js');
  assert.equal(packageJson.scripts['gcp:provision'], 'node scripts/gcp-provision.js');
  assert.match(packageJson.scripts.check, /node --check scripts\/gcp-preflight\.js/);
  assert.match(packageJson.scripts.check, /node --check scripts\/gcp-provision\.js/);
});
