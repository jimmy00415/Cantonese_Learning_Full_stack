import { execFile as execFileCallback } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { GoogleAuth, OAuth2Client } from 'google-auth-library';
import {
  GCP_IDENTITY,
  GCP_OBSOLETE_EXECUTABLE_IDENTITIES,
} from '../src/gcp-identity.js';

const execFileAsync = promisify(execFileCallback);
const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const ORGANIZATION = GCP_IDENTITY.organizationId;
const BILLING_ACCOUNT = GCP_IDENTITY.billingAccountId;
export const REQUIRED_OPERATOR_ACCOUNT = 'admin@motionexp.com';
const CONTRACT_PATH = fileURLToPath(new URL('../infra/gcp/resource-contract.json', import.meta.url));
const NUMERIC_VERSION = /^[1-9]\d*$/;
const CHANNEL_NAME = new RegExp(
  `^projects/(?:${PROJECT}|${PROJECT_NUMBER})/notificationChannels/([1-9]\\d*)$`,
);
const SAFE_ARGUMENT = /^[^\u0000\r\n]*$/;
const ASSET_PROJECT = `projects/${PROJECT_NUMBER}`;
const ASSET_PROJECT_PARENT = `//cloudresourcemanager.googleapis.com/projects/${PROJECT}`;
const ASSET_PROJECT_TYPE = 'cloudresourcemanager.googleapis.com/Project';
const ASSET_READ_MASK = 'name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state';
const ASSET_MAX_BUFFER = 16 * 1024 * 1024;
const OWNERSHIP_LABELS = Object.freeze({
  application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: 'operations',
});

export function canonicalMonitoringChannelName(value) {
  const match = CHANNEL_NAME.exec(String(value ?? ''));
  return match ? `projects/${PROJECT}/notificationChannels/${match[1]}` : null;
}
const REQUIRED_APIS = Object.freeze([
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
const REQUIRED_MONITORING = Object.freeze({
  notificationChannel: {
    required: true, displayName: 'HK Buddy V1 operations', ownershipLabels: OWNERSHIP_LABELS,
    mustBeEnabled: true, requiredType: 'email', requiredEmailAddress: REQUIRED_OPERATOR_ACCOUNT,
    requiredVerificationStatus: 'VERIFIED',
  },
  metricTypes: [
    'run.googleapis.com/request_count',
    'run.googleapis.com/request_latencies',
    'run.googleapis.com/container/instance_count',
    'cloudsql.googleapis.com/database/cpu/utilization',
    'cloudsql.googleapis.com/database/disk/utilization',
    'cloudsql.googleapis.com/database/postgresql/num_backends',
  ],
  policies: [
    { id: 'run-5xx-ratio', displayName: 'HK Buddy V1 Cloud Run 5xx ratio', kind: 'metric-ratio', metricType: 'run.googleapis.com/request_count', threshold: 0.05, durationSeconds: 300 },
    { id: 'run-latency-p95', displayName: 'HK Buddy V1 Cloud Run P95 latency', kind: 'metric-percentile', metricType: 'run.googleapis.com/request_latencies', threshold: 6000, durationSeconds: 300 },
    { id: 'run-instance-cap', displayName: 'HK Buddy V1 Cloud Run instance cap', kind: 'metric-threshold', metricType: 'run.googleapis.com/container/instance_count', threshold: 1, durationSeconds: 300 },
    { id: 'sql-cpu', displayName: 'HK Buddy V1 Cloud SQL CPU', kind: 'metric-threshold', metricType: 'cloudsql.googleapis.com/database/cpu/utilization', threshold: 0.8, durationSeconds: 300 },
    { id: 'sql-storage', displayName: 'HK Buddy V1 Cloud SQL storage', kind: 'metric-threshold', metricType: 'cloudsql.googleapis.com/database/disk/utilization', threshold: 0.8, durationSeconds: 300 },
    { id: 'sql-connections', displayName: 'HK Buddy V1 Cloud SQL connections', kind: 'metric-threshold', metricType: 'cloudsql.googleapis.com/database/postgresql/num_backends', threshold: 80, durationSeconds: 300 },
    { id: 'sql-backup-failure', displayName: 'HK Buddy V1 Cloud SQL backup failure', kind: 'log-match', filter: `logName="projects/${PROJECT}/logs/cloudaudit.googleapis.com%2Fsystem_event" AND protoPayload.methodName="cloudsql.instances.automatedBackup" AND resource.type="cloudsql_database" AND protoPayload.metadata.windowStatus=("STATUS_FAILED" OR "STATUS_ATTEMPT_FAILED")` },
    { id: 'sql-failover', displayName: 'HK Buddy V1 Cloud SQL failover', kind: 'log-match', filter: 'resource.type="cloudsql_database" AND ((log_id("cloudaudit.googleapis.com/activity") AND protoPayload.methodName="cloudsql.instances.failover" AND operation.last=true) OR (log_id("cloudaudit.googleapis.com/system_event") AND protoPayload.methodName="cloudsql.instances.autoFailover"))' },
    { id: 'sql-restart', displayName: 'HK Buddy V1 Cloud SQL restart', kind: 'log-match', filter: 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloudsql_database" AND protoPayload.methodName="cloudsql.instances.restart" AND operation.last=true' },
    { id: 'cloud-build-failure', displayName: 'HK Buddy V1 Cloud Build failure', kind: 'log-match', filter: 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="build" AND protoPayload.methodName="google.devtools.cloudbuild.v1.CloudBuild.CreateBuild" AND operation.last=true AND protoPayload.response.status=("FAILURE" OR "INTERNAL_ERROR" OR "TIMEOUT" OR "EXPIRED")' },
    { id: 'run-deployment-failure', displayName: 'HK Buddy V1 Cloud Run deployment failure', kind: 'log-match', filter: 'log_id("cloudaudit.googleapis.com/activity") AND resource.type="cloud_run_revision" AND protoPayload.methodName=("google.cloud.run.v2.Services.CreateService" OR "google.cloud.run.v2.Services.UpdateService") AND protoPayload.status.code!=0' },
  ],
});
const REQUIRED_FORBIDDEN_WORKLOAD_ROLES = Object.freeze([
  'roles/owner', 'roles/editor', 'roles/run.admin', 'roles/cloudsql.admin',
  'roles/cloudsql.editor', 'roles/compute.networkAdmin', 'roles/storage.admin',
  'roles/secretmanager.admin', 'roles/secretmanager.secretAccessor',
  'roles/texttospeech.user', 'roles/iam.serviceAccountTokenCreator',
]);
const REQUIRED_AUTOMATIC_PROJECT_BINDINGS = Object.freeze([
  { member: `user:${REQUIRED_OPERATOR_ACCOUNT}`, role: 'roles/owner', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloudbuild.iam.gserviceaccount.com', role: 'roles/cloudbuild.serviceAgent', required: true },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@containerregistry.iam.gserviceaccount.com', role: 'roles/containerregistry.ServiceAgent', required: false },
  { member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-pubsub.iam.gserviceaccount.com', role: 'roles/pubsub.serviceAgent', required: false },
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
const REQUIRED_CUSTOM_ROLES = Object.freeze([
  {
    id: 'hkbuddyV1AcceptanceBucketMetadataReader',
    name: `projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader`,
    title: 'HK Buddy acceptance bucket metadata reader',
    description: 'Read fixed media bucket metadata for dependency acceptance',
    includedPermissions: ['storage.buckets.get'],
    stage: 'GA',
  },
]);
const REQUIRED_IAM_BINDINGS = Object.freeze([
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/aiplatform.user' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/speech.client' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/serviceusage.serviceUsageConsumer' },
  { scope: `bucket:${GCP_IDENTITY.bucket}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/storage.objectUser' },
  { scope: `secret:${GCP_IDENTITY.secrets.dbAppUrl}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.session}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.legacy}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.dependencies}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.llm}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.asr}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.tts}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.ios}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `bucket:${GCP_IDENTITY.bucket}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`, role: 'roles/storage.objectUser' },
  { scope: `bucket:${GCP_IDENTITY.bucket}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`, role: `projects/${PROJECT}/roles/hkbuddyV1AcceptanceBucketMetadataReader` },
  { scope: `secret:${GCP_IDENTITY.secrets.dbAppUrl}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.acceptance}`, role: 'roles/logging.logWriter' },
  { scope: `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.migrator}`, role: 'roles/secretmanager.secretAccessor' },
  { scope: `repository:${GCP_IDENTITY.repository}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`, role: 'roles/artifactregistry.writer' },
  { scope: `bucket:${GCP_IDENTITY.buildSourceBucket}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`, role: 'roles/storage.objectViewer' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.build}`, role: 'roles/logging.logWriter' },
  { scope: `repository:${GCP_IDENTITY.repository}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`, role: 'roles/artifactregistry.reader' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`, role: 'roles/cloudbuild.builds.editor' },
  { scope: 'project', member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`, role: 'roles/run.developer' },
  ...[GCP_IDENTITY.secrets.legacy, GCP_IDENTITY.secrets.dependencies, GCP_IDENTITY.secrets.llm, GCP_IDENTITY.secrets.asr, GCP_IDENTITY.secrets.tts, GCP_IDENTITY.secrets.ios].map((id) => ({ scope: `secret:${id}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`, role: 'roles/secretmanager.secretVersionAdder' })),
  ...['runtime', 'migrator', 'build', 'acceptance'].map((name) => ({ scope: `service-account:hkbuddy-v1-${name}`, member: `serviceAccount:${GCP_IDENTITY.serviceAccounts.deployer}`, role: 'roles/iam.serviceAccountUser' })),
  { scope: 'service-account:hkbuddy-v1-build', member: 'serviceAccount:service-__PROJECT_NUMBER__@gcp-sa-cloudbuild.iam.gserviceaccount.com', role: 'roles/iam.serviceAccountTokenCreator' },
]);
const FORBIDDEN_TEXT = Object.freeze([
  'hkbuddy-pilot-0630', 'hkbuddy-pilot-0630.azurewebsites.net',
]);
const GENERATED_SECRET_IDS = Object.freeze([
  GCP_IDENTITY.secrets.dbAppUrl, GCP_IDENTITY.secrets.dbMigratorUrl,
  GCP_IDENTITY.secrets.session, GCP_IDENTITY.secrets.bootstrap,
]);
const EVIDENCE_SECRET_IDS = Object.freeze([
  GCP_IDENTITY.secrets.legacy, GCP_IDENTITY.secrets.dependencies, GCP_IDENTITY.secrets.llm,
  GCP_IDENTITY.secrets.asr, GCP_IDENTITY.secrets.tts, GCP_IDENTITY.secrets.ios,
]);
const SECRET_CONTAINER_IDS = Object.freeze([...GENERATED_SECRET_IDS, ...EVIDENCE_SECRET_IDS]);

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function exact(value, expected) {
  return canonicalJson(value) === canonicalJson(expected);
}

function contractError() {
  return new Error('GCP resource contract is invalid');
}

function requireExact(value, expected) {
  if (!exact(value, expected)) throw contractError();
}

export function isExactOrganizationResource(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.name === `organizations/${ORGANIZATION}`
    && value.lifecycleState === 'ACTIVE');
}

export function isExactBillingAccountResource(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && value.name === `billingAccounts/${BILLING_ACCOUNT}`
    && value.open === true && value.currencyCode === 'HKD');
}

export function isExactProjectParent(parent) {
  return parent === `organizations/${ORGANIZATION}`
    || exact(parent, { type: 'organization', id: ORGANIZATION });
}

export function isExactProjectBillingLink(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.billingEnabled !== true) return false;
  const hasName = Object.hasOwn(value, 'billingAccountName');
  const hasAlias = Object.hasOwn(value, 'billingAccount');
  if (hasName === hasAlias) return false;
  const account = hasName ? value.billingAccountName : value.billingAccount;
  return account === `billingAccounts/${BILLING_ACCOUNT}`;
}

function assertNoForbiddenText(value) {
  const serialized = canonicalJson(value).toLowerCase();
  if (FORBIDDEN_TEXT.some((member) => serialized.includes(member.toLowerCase()))) throw contractError();
}

export function assertResourceContract(contract) {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) throw contractError();
  requireExact(Object.keys(contract).sort(), [
    'apis', 'iam', 'locations', 'project', 'resources', 'safety', 'schemaVersion',
  ]);
  assertNoForbiddenText({
    project: contract.project,
    locations: contract.locations,
    apis: contract.apis,
    resources: contract.resources,
    iam: contract.iam,
  });
  requireExact(contract.schemaVersion, 3);
  requireExact(contract.project, {
    id: PROJECT,
    displayName: 'Motion Expert HK LTD Webpage',
    organizationId: ORGANIZATION,
    billingAccountId: BILLING_ACCOUNT,
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
  requireExact(contract.locations, {
    runtime: 'asia-east2', storage: 'asia-east2', database: 'asia-east2',
    speech: 'asia-southeast1', vertex: 'global',
  });
  requireExact(contract.apis, [...REQUIRED_APIS]);

  const resources = contract.resources;
  requireExact(Object.keys(resources ?? {}).sort(), [
    'artifactRegistry', 'bucket', 'budget', 'buildSourceBucket', 'cloudRun', 'cloudSql', 'customRoles', 'monitoring',
    'network', 'secrets', 'serviceAccounts',
  ]);
  requireExact(resources?.artifactRegistry, {
    repository: GCP_IDENTITY.repository, format: 'DOCKER', mode: 'STANDARD_REPOSITORY', location: 'asia-east2',
    description: 'Hong Kong Buddy production containers',
  });
  requireExact(resources?.serviceAccounts, [
    { id: 'hkbuddy-v1-runtime', email: GCP_IDENTITY.serviceAccounts.runtime, displayName: 'Hong Kong Buddy Cloud Run runtime' },
    { id: 'hkbuddy-v1-build', email: GCP_IDENTITY.serviceAccounts.build, displayName: 'Hong Kong Buddy Cloud Build' },
    { id: 'hkbuddy-v1-migrator', email: GCP_IDENTITY.serviceAccounts.migrator, displayName: 'Hong Kong Buddy database migrator' },
    { id: 'hkbuddy-v1-deployer', email: GCP_IDENTITY.serviceAccounts.deployer, displayName: 'Hong Kong Buddy release deployer' },
    { id: 'hkbuddy-v1-acceptance', email: GCP_IDENTITY.serviceAccounts.acceptance, displayName: 'Hong Kong Buddy dependency acceptance' },
  ]);
  requireExact(resources?.customRoles, REQUIRED_CUSTOM_ROLES);
  requireExact(resources?.network, {
    vpc: GCP_IDENTITY.network, subnet: GCP_IDENTITY.subnet, subnetCidr: '10.24.0.0/26',
    privateGoogleAccess: true, psaRange: GCP_IDENTITY.psaRange,
    psaCidr: '10.25.0.0/16', egress: 'private-ranges-only',
  });
  requireExact(resources?.cloudSql, {
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
  requireExact(resources?.bucket, {
    name: GCP_IDENTITY.bucket, location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 7,
    retentionPolicy: null,
  });
  requireExact(resources?.buildSourceBucket, {
    name: GCP_IDENTITY.buildSourceBucket, location: 'asia-east2',
    uniformBucketLevelAccess: true, publicAccessPrevention: 'enforced',
    versioning: false, softDeleteSeconds: 0, lifecycleDeleteAfterDays: 1,
    retentionPolicy: null,
  });
  requireExact(resources?.secrets, [
    { id: GCP_IDENTITY.secrets.dbAppUrl, purpose: 'runtime PostgreSQL URL', versionPolicy: 'numeric-only' },
    { id: GCP_IDENTITY.secrets.dbMigratorUrl, purpose: 'migration PostgreSQL URL', versionPolicy: 'numeric-only' },
    { id: GCP_IDENTITY.secrets.session, purpose: 'anonymous session signing', versionPolicy: 'numeric-only' },
    { id: GCP_IDENTITY.secrets.bootstrap, purpose: 'non-secret database-user binding receipt', versionPolicy: 'numeric-only' },
    { id: GCP_IDENTITY.secrets.legacy, purpose: 'immutable legacy inventory evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
    { id: GCP_IDENTITY.secrets.dependencies, purpose: 'immutable dependency acceptance evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
    { id: GCP_IDENTITY.secrets.llm, purpose: 'immutable LLM smoke evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
    { id: GCP_IDENTITY.secrets.asr, purpose: 'immutable ASR smoke evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
    { id: GCP_IDENTITY.secrets.tts, purpose: 'immutable TTS smoke evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
    { id: GCP_IDENTITY.secrets.ios, purpose: 'immutable iOS voice acceptance evidence', versionPolicy: 'numeric-only', baseProvisioningVersion: false },
  ]);
  requireExact(resources?.cloudRun, {
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
    startupProbe: {
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 10, failureThreshold: 12,
    },
    livenessProbe: {
      path: '/api/health/live', port: 8080, initialDelaySeconds: 30,
      timeoutSeconds: 5, periodSeconds: 30, failureThreshold: 3,
    },
    readinessProbe: {
      path: '/api/health/ready', port: 8080, initialDelaySeconds: 0,
      timeoutSeconds: 5, periodSeconds: 5, failureThreshold: 3,
    },
    secretVersionPolicy: 'numeric-only',
  });

  requireExact(resources?.monitoring, REQUIRED_MONITORING);
  const policyIds = resources.monitoring.policies.map(({ id }) => id);
  requireExact(policyIds, [
    'run-5xx-ratio', 'run-latency-p95', 'run-instance-cap',
    'sql-cpu', 'sql-storage', 'sql-connections', 'sql-backup-failure',
    'sql-failover', 'sql-restart', 'cloud-build-failure', 'run-deployment-failure',
  ]);
  requireExact(resources?.budget, {
    displayName: 'Hong Kong Buddy Production V1 monthly guard', currency: 'HKD',
    amount: 2300, calendarPeriod: 'MONTH', projectFilter: ASSET_PROJECT,
    thresholds: [
      { percent: 0.5, basis: 'CURRENT_SPEND' },
      { percent: 0.8, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'CURRENT_SPEND' },
      { percent: 1, basis: 'FORECASTED_SPEND' },
    ],
  });

  requireExact(contract.iam, {
    forbiddenWorkloadRoles: REQUIRED_FORBIDDEN_WORKLOAD_ROLES,
    automaticProjectBindings: REQUIRED_AUTOMATIC_PROJECT_BINDINGS,
    bindings: REQUIRED_IAM_BINDINGS,
  });
  const runtime = `serviceAccount:${GCP_IDENTITY.serviceAccounts.runtime}`;
  const runtimeProjectRoles = contract.iam.bindings
    .filter(({ scope, member }) => scope === 'project' && member === runtime)
    .map(({ role }) => role).sort();
  requireExact(runtimeProjectRoles, [
    'roles/aiplatform.user', 'roles/serviceusage.serviceUsageConsumer', 'roles/speech.client',
  ]);
  if (!contract.iam.bindings.some(({ scope, member, role }) => (
    scope === `bucket:${GCP_IDENTITY.bucket}` && member === runtime
      && role === 'roles/storage.objectUser'
  )) || contract.iam.bindings.some(({ scope, member }) => (
    scope === `secret:${GCP_IDENTITY.secrets.dbMigratorUrl}` && member === runtime
  ))) throw contractError();

  requireExact(contract.safety, {
    dryRunDefault: true,
    exactConfirmation: `--confirm-project=${PROJECT}`,
    commandTransport: 'execFile-argv',
    secretTransport: 'authenticated-https-body',
    completePostCreateReadback: true,
    unresolvedProjectIdPolicy: 'existing-project-required',
    noUserManagedServiceAccountKeys: true,
    stopOnForbidden: true,
    stopOnAlreadyExists: true,
    stopOnDrift: true,
    preservePartialResources: true,
    publicPrincipalsForbidden: ['allUsers', 'allAuthenticatedUsers'],
    legacyIdentitiesForbidden: [...FORBIDDEN_TEXT],
  });
  return contract;
}

export async function loadResourceContract({
  contractPath = CONTRACT_PATH,
  readTextFile = (filePath) => readFile(filePath, 'utf8'),
} = {}) {
  if (typeof contractPath !== 'string' || !isAbsolute(contractPath)) throw contractError();
  let parsed;
  try {
    const source = await readTextFile(contractPath);
    if (typeof source !== 'string' || source.length < 1 || source.length > 256 * 1024) throw contractError();
    parsed = JSON.parse(source);
  } catch {
    throw contractError();
  }
  return assertResourceContract(parsed);
}

function commandError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireObjectList(value) {
  if (!Array.isArray(value) || value.some((item) => (
    !item || typeof item !== 'object' || Array.isArray(item)
  ))) {
    throw commandError('LIST_RESPONSE_AMBIGUOUS');
  }
  return value;
}

function canonicalServiceApiName(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 253
    || !value.endsWith('.googleapis.com')) return false;
  const labels = value.split('.');
  return labels.length >= 3 && labels.every((label) => (
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)
  ));
}

function requireEnabledApiSet(value) {
  const rows = requireObjectList(value);
  const enabled = new Set();
  for (const row of rows) {
    const config = row.config;
    const service = config?.name;
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || !canonicalServiceApiName(service)
      || row.name !== `projects/${PROJECT_NUMBER}/services/${service}`
      || row.state !== 'ENABLED' || enabled.has(service)) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    enabled.add(service);
  }
  return enabled;
}

function sameStringSet(left, right) {
  return left instanceof Set && right instanceof Set && left.size === right.size
    && [...left].every((value) => right.has(value));
}

function normalizeTransportStderr(value) {
  const normalized = String(value ?? '').replace(/\r\n|\r/g, '\n');
  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}

function canonicalDescribeAbsence(argv, stderr) {
  const projectFlag = `--project=${PROJECT}`;
  const formatFlag = '--format=json';
  const role = 'hkbuddyV1AcceptanceBucketMetadataReader';
  const descriptors = [
    [
      ['artifacts', 'repositories', 'describe', GCP_IDENTITY.repository, '--location=asia-east2', projectFlag, formatFlag],
      `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Repository [projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}] was not found.`,
    ],
    [
      ['artifacts', 'repositories', 'describe', GCP_IDENTITY.repository, '--location=asia-east2', projectFlag, formatFlag],
      `ERROR: (gcloud.artifacts.repositories.describe) NOT_FOUND: Requested entity was not found. This command is authenticated as ${REQUIRED_OPERATOR_ACCOUNT} which is the active account specified by the [core/account] property.`,
    ],
    ...Object.values(GCP_IDENTITY.serviceAccounts).flatMap((account) => {
      const argv = ['iam', 'service-accounts', 'describe', account, projectFlag, formatFlag];
      return [
        [argv, `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Service account [${account}] was not found in project [${PROJECT}].`],
        [argv, `ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account. This command is authenticated as ${REQUIRED_OPERATOR_ACCOUNT} which is the active account specified by the [core/account] property`],
      ];
    }),
    [
      ['iam', 'roles', 'describe', role, projectFlag, formatFlag],
      `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: Role [projects/${PROJECT}/roles/${role}] was not found.`,
    ],
    [
      ['iam', 'roles', 'describe', role, projectFlag, formatFlag],
      `ERROR: (gcloud.iam.roles.describe) NOT_FOUND: The role named projects/${PROJECT}/roles/${role} was not found. This command is authenticated as ${REQUIRED_OPERATOR_ACCOUNT} which is the active account specified by the [core/account] property.`,
    ],
    [
      ['compute', 'networks', 'describe', GCP_IDENTITY.network, projectFlag, formatFlag],
      `ERROR: (gcloud.compute.networks.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}' was not found`,
    ],
    [
      ['compute', 'networks', 'subnets', 'describe', GCP_IDENTITY.subnet, '--region=asia-east2', projectFlag, formatFlag],
      `ERROR: (gcloud.compute.networks.subnets.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}' was not found`,
    ],
    [
      ['compute', 'addresses', 'describe', GCP_IDENTITY.psaRange, '--global', projectFlag, formatFlag],
      `ERROR: (gcloud.compute.addresses.describe) Could not fetch resource:\n - The resource 'projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}' was not found`,
    ],
    [
      ['sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, projectFlag, formatFlag],
      `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The resource [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}] was not found.`,
    ],
    [
      ['sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, projectFlag, formatFlag],
      `ERROR: (gcloud.sql.instances.describe) HTTPError 404: The Cloud SQL instance does not exist. This command is authenticated as ${REQUIRED_OPERATOR_ACCOUNT} which is the active account specified by the [core/account] property.`,
    ],
    [
      ['sql', 'databases', 'describe', GCP_IDENTITY.database, `--instance=${GCP_IDENTITY.cloudSqlInstance}`, projectFlag, formatFlag],
      `ERROR: (gcloud.sql.databases.describe) HTTPError 404: Database [projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/databases/${GCP_IDENTITY.database}] was not found.`,
    ],
    ...[GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket].flatMap((bucket) => {
      const argv = ['storage', 'buckets', 'describe', `gs://${bucket}`, projectFlag, formatFlag];
      return [
        [argv, `ERROR: (gcloud.storage.buckets.describe) HTTPError 404: The specified bucket [gs://${bucket}] does not exist.`],
        [argv, `ERROR: (gcloud.storage.buckets.describe) gs://${bucket} not found: 404.`],
      ];
    }),
    ...Object.values(GCP_IDENTITY.secrets).flatMap((secret) => {
      const argv = ['secrets', 'describe', secret, projectFlag, formatFlag];
      return [
        [argv, `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT}/secrets/${secret}] not found.`],
        [argv, `ERROR: (gcloud.secrets.describe) NOT_FOUND: Secret [projects/${PROJECT_NUMBER}/secrets/${secret}] not found. This command is authenticated as ${REQUIRED_OPERATOR_ACCOUNT} which is the active account specified by the [core/account] property.`],
      ];
    }),
    ...Object.values(GCP_IDENTITY.jobs).map((job) => [[
      'run', 'jobs', 'describe', job, projectFlag, `--region=${GCP_IDENTITY.region}`, formatFlag,
    ], `ERROR: (gcloud.run.jobs.describe) Cannot find job [${job}].`]),
  ];
  return descriptors.some(([expectedArgv, expectedStderr]) => (
    exact(argv, expectedArgv)
      && (stderr === expectedStderr || stderr === `${expectedStderr}\n`)
  ));
}

function classifyTransportError(error, argv = null) {
  if (['FORBIDDEN', 'ALREADY_EXISTS'].includes(error?.code)) return error.code;
  if (error?.code === 'NOT_FOUND' && argv === null) return 'NOT_FOUND';
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  if (status === 403) return 'FORBIDDEN';
  const canonicalStderr = normalizeTransportStderr(error?.stderr ?? error?.message ?? '');
  if (status === 404 && canonicalDescribeAbsence(argv, canonicalStderr)) {
    return 'NOT_FOUND';
  }
  if (status === 409) return 'ALREADY_EXISTS';
  const stderr = String(error?.stderr ?? error?.message ?? '');
  if (/PERMISSION_DENIED|permission denied|does not have permission|\b403\b|forbidden/i.test(stderr)) return 'FORBIDDEN';
  const describedService = [GCP_IDENTITY.service, GCP_IDENTITY.candidateService].find((service) => exact(argv, [
    'run', 'services', 'describe', service,
    `--project=${PROJECT}`, `--region=${GCP_IDENTITY.region}`, '--format=json',
  ]));
  if (describedService
    && canonicalStderr === `ERROR: (gcloud.run.services.describe) Cannot find service [${describedService}]`) {
    return 'CLOUD_RUN_SERVICE_NOT_FOUND';
  }
  if (canonicalDescribeAbsence(argv, canonicalStderr)) return 'NOT_FOUND';
  if (/ALREADY_EXISTS|already exists|\b409\b/i.test(stderr)) return 'ALREADY_EXISTS';
  return 'TRANSPORT_AMBIGUOUS';
}

function classifyRestTransportError(error) {
  const status = Number(error?.response?.status ?? error?.status ?? error?.statusCode);
  if (error?.code === 'NOT_FOUND' || status === 404) return 'TRANSPORT_AMBIGUOUS';
  return classifyTransportError(error);
}

function secretBearingArgument(value) {
  return /--password(?:=|$)|-----BEGIN [A-Z ]*PRIVATE KEY-----|["']?private_key["']?\s*[:=]/i.test(value)
    || /postgres(?:ql)?:\/\/[^/@:]+:[^/@]+@/i.test(value);
}

function safeArgv(argv) {
  if (!Array.isArray(argv)) throw new Error('gcloud requires an argv array');
  if (argv.some((value) => typeof value !== 'string' || !SAFE_ARGUMENT.test(value))) {
    throw new Error('gcloud received unsafe argv');
  }
  if (argv.some(secretBearingArgument)) throw new Error('gcloud refused secret-bearing argv');
  return argv;
}

function nonInteractiveGcloudArgs(prefixArgs, argv) {
  const args = [...safeArgv(prefixArgs), ...safeArgv(argv)];
  const quietCount = args.filter((value) => value === '--quiet').length;
  if (quietCount > 1) throw new Error('gcloud non-interactive argv is invalid');
  if (quietCount === 0) args.push('--quiet');
  return args;
}

export function createGcloudExecutor({ executable, prefixArgs = [], execFile = execFileAsync } = {}) {
  if (typeof executable !== 'string' || !executable
    || !Array.isArray(prefixArgs) || prefixArgs.some((value) => typeof value !== 'string')
    || typeof execFile !== 'function') throw new Error('gcloud executor configuration is invalid');
  return async (argv, { maxBuffer = 1024 * 1024 } = {}) => {
    const args = nonInteractiveGcloudArgs(prefixArgs, argv);
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 32 * 1024 * 1024) {
      throw new Error('gcloud output limit is invalid');
    }
    let result;
    try {
      result = await execFile(executable, args, {
        encoding: 'utf8', maxBuffer, windowsHide: true,
      });
    } catch (cause) {
      const error = commandError(classifyTransportError(cause, argv));
      throw error;
    }
    const stdout = String(result?.stdout ?? '').trim();
    if (!stdout) return null;
    try { return JSON.parse(stdout); } catch { throw commandError('GCLOUD_OUTPUT_INVALID'); }
  };
}

const AUTHENTICATED_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

async function readBoundedAuthenticatedResponse(response) {
  let contentLength = null;
  let headerError = null;
  try {
    if (typeof response?.headers?.get !== 'function') throw commandError('TRANSPORT_AMBIGUOUS');
    const raw = response.headers.get('content-length');
    if (raw !== null && raw !== undefined) {
      if (typeof raw !== 'string' || !/^(?:0|[1-9][0-9]*)$/.test(raw) || raw.length > 16) {
        throw commandError('TRANSPORT_AMBIGUOUS');
      }
      contentLength = Number(raw);
      if (!Number.isSafeInteger(contentLength)) throw commandError('TRANSPORT_AMBIGUOUS');
      if (contentLength > AUTHENTICATED_RESPONSE_MAX_BYTES) {
        throw commandError('CONTROL_PLANE_RESPONSE_TOO_LARGE');
      }
    }
  } catch (error) {
    headerError = error?.code ? error : commandError('TRANSPORT_AMBIGUOUS');
  }

  let body;
  try { body = response?.body; } catch { throw commandError('TRANSPORT_AMBIGUOUS'); }
  if (body === null) {
    if (headerError) throw headerError;
    const bodyForbiddenByStatus = [204, 205, 304].includes(response.status);
    if (contentLength !== 0 && !(contentLength === null && bodyForbiddenByStatus)) {
      throw commandError('TRANSPORT_AMBIGUOUS');
    }
    return '';
  }
  if (!body || typeof body.getReader !== 'function') {
    throw commandError('TRANSPORT_AMBIGUOUS');
  }

  let reader;
  let complete = false;
  const bytes = Buffer.allocUnsafe(AUTHENTICATED_RESPONSE_MAX_BYTES);
  let total = 0;
  try {
    reader = body.getReader();
    if (!reader || typeof reader.read !== 'function' || typeof reader.cancel !== 'function'
      || typeof reader.releaseLock !== 'function') throw commandError('TRANSPORT_AMBIGUOUS');
    if (headerError) throw headerError;
    while (true) {
      const result = await reader.read();
      if (!result || typeof result !== 'object' || typeof result.done !== 'boolean') {
        throw commandError('TRANSPORT_AMBIGUOUS');
      }
      if (result.done) {
        if (result.value !== undefined) throw commandError('TRANSPORT_AMBIGUOUS');
        complete = true;
        break;
      }
      const chunk = result.value;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength < 1
        || !Number.isSafeInteger(chunk.byteLength)
        || chunk.byteOffset < 0 || !Number.isSafeInteger(chunk.byteOffset)
        || chunk.byteOffset + chunk.byteLength > chunk.buffer?.byteLength) {
        throw commandError('TRANSPORT_AMBIGUOUS');
      }
      if (chunk.byteLength > AUTHENTICATED_RESPONSE_MAX_BYTES - total) {
        throw commandError('CONTROL_PLANE_RESPONSE_TOO_LARGE');
      }
      bytes.set(chunk, total);
      total += chunk.byteLength;
    }
    if (contentLength !== null && contentLength !== total) throw commandError('TRANSPORT_AMBIGUOUS');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)); } catch {
      throw commandError('CONTROL_PLANE_OUTPUT_INVALID');
    }
  } catch (error) {
    if (!complete) await reader?.cancel().catch(() => undefined);
    if (error?.code) throw error;
    throw commandError('TRANSPORT_AMBIGUOUS');
  } finally {
    try { reader?.releaseLock(); } catch { /* best-effort release only */ }
  }
}

async function cancelUnreadAuthenticatedResponse(response) {
  try {
    const body = response?.body;
    if (body && typeof body.cancel === 'function') await body.cancel();
  } catch { /* best-effort transport cleanup only */ }
}

export function createGcloudAuthenticatedRequest({
  executable,
  prefixArgs = [],
  account,
  execFile = execFileAsync,
  fetchImpl = globalThis.fetch,
  getTokenInfo,
  environment = process.env,
  now = Date.now,
} = {}) {
  if (typeof executable !== 'string' || !executable || !Array.isArray(prefixArgs)
    || prefixArgs.some((value) => typeof value !== 'string')
    || typeof account !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(account)
    || typeof execFile !== 'function' || typeof fetchImpl !== 'function'
    || (getTokenInfo !== undefined && typeof getTokenInfo !== 'function')
    || !environment || typeof environment !== 'object' || typeof now !== 'function') {
    throw new Error('gcloud HTTPS authentication configuration is invalid');
  }
  const tokenInfoClient = getTokenInfo ? null : new OAuth2Client();
  const inspectToken = getTokenInfo ?? ((token) => tokenInfoClient.getTokenInfo(token));
  let cachedToken = null;
  let refreshAfter = 0;
  let cachedPrincipal = null;
  let principalRefreshAfter = 0;
  const assertNoAuthOverrides = async () => {
    const environmentOverride = Object.entries(environment).some(([name, value]) => (
      name.startsWith('CLOUDSDK_AUTH_') && value !== undefined && value !== null
        && String(value).trim() !== ''
    ));
    if (environmentOverride) throw commandError('GCLOUD_AUTH_OVERRIDE');
    let result;
    try {
      result = await execFile(executable, nonInteractiveGcloudArgs(prefixArgs, [
        'config', 'list',
        '--format=json', `--project=${PROJECT}`,
      ]), { encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true });
    } catch (cause) {
      throw commandError(classifyTransportError(cause));
    }
    let configuration;
    try { configuration = JSON.parse(String(result?.stdout ?? '').trim() || '{}'); } catch {
      throw commandError('GCLOUD_AUTH_CONFIG_INVALID');
    }
    if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
      throw commandError('GCLOUD_AUTH_CONFIG_INVALID');
    }
    const auth = configuration.auth ?? {};
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      throw commandError('GCLOUD_AUTH_CONFIG_INVALID');
    }
    const propertyOverride = Object.values(auth).some((value) => (
      value !== undefined && value !== null && value !== false && value !== 0
        && String(value).trim() !== ''
    ));
    if (propertyOverride) throw commandError('GCLOUD_AUTH_OVERRIDE');
  };
  const getToken = async () => {
    const current = Number(now());
    if (cachedToken && Number.isFinite(current) && current < refreshAfter) return cachedToken;
    await assertNoAuthOverrides();
    let result;
    try {
      result = await execFile(executable, nonInteractiveGcloudArgs(prefixArgs, [
        'auth', 'print-access-token',
        `--account=${account}`, `--project=${PROJECT}`,
      ]), { encoding: 'utf8', maxBuffer: 64 * 1024, windowsHide: true });
    } catch (cause) {
      throw commandError(classifyTransportError(cause));
    }
    const token = String(result?.stdout ?? '').trim();
    if (token.length < 20 || token.length > 8192 || /\s|[\u0000-\u001f\u007f]/.test(token)) {
      throw commandError('GCLOUD_ACCESS_TOKEN_INVALID');
    }
    cachedToken = token;
    refreshAfter = current + 240_000;
    return cachedToken;
  };

  const getPrincipal = async () => {
    const current = Number(now());
    if (cachedPrincipal && Number.isFinite(current) && current < principalRefreshAfter) {
      return cachedPrincipal;
    }
    const token = await getToken();
    let info;
    try { info = await inspectToken(token); } catch { throw commandError('REST_AUTH_UNKNOWN'); }
    if (typeof info?.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(info.email)) {
      throw commandError('REST_AUTH_UNKNOWN');
    }
    cachedPrincipal = info.email;
    principalRefreshAfter = current + 240_000;
    return cachedPrincipal;
  };

  const request = async ({ method, url, body }) => {
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method) || typeof url !== 'string') {
      throw new Error('Authenticated request is invalid');
    }
    let target;
    try { target = new URL(url); } catch { throw new Error('Authenticated request is invalid'); }
    if (target.protocol !== 'https:' || !target.hostname.endsWith('.googleapis.com')) {
      throw new Error('Authenticated request is invalid');
    }
    await getPrincipal();
    const token = await getToken();
    let response;
    try {
      response = await fetchImpl(target.href, {
        method,
        redirect: 'error',
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          'x-goog-user-project': PROJECT,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw commandError('TRANSPORT_AMBIGUOUS');
    }
    let responseMetadataValid = false;
    try {
      responseMetadataValid = response?.redirected === false
        && response.url === target.href
        && typeof response.ok === 'boolean'
        && Number.isSafeInteger(response.status)
        && response.status >= 100 && response.status <= 599;
    } catch { responseMetadataValid = false; }
    if (!responseMetadataValid) {
      await cancelUnreadAuthenticatedResponse(response);
      throw commandError('TRANSPORT_AMBIGUOUS');
    }
    const text = await readBoundedAuthenticatedResponse(response);
    if (!response.ok) {
      const error = commandError(response.status === 403 ? 'FORBIDDEN'
        : response.status === 404 ? 'TRANSPORT_AMBIGUOUS'
          : response.status === 409 ? 'ALREADY_EXISTS' : 'TRANSPORT_AMBIGUOUS');
      throw error;
    }
    if (!text) return null;
    try { return JSON.parse(text); } catch { throw commandError('CONTROL_PLANE_OUTPUT_INVALID'); }
  };
  Object.defineProperty(request, 'getPrincipal', {
    enumerable: false,
    value: getPrincipal,
  });
  return request;
}

export function resolveDefaultGcloudLaunch(environment = process.env) {
  const configuredPython = environment.V1_GCP_PYTHON_EXECUTABLE;
  const configuredGcloud = environment.V1_GCLOUD_PY_PATH;
  if (configuredPython || configuredGcloud) {
    if (!configuredPython || !configuredGcloud
      || !isAbsolute(configuredPython) || !isAbsolute(configuredGcloud)) {
      throw new Error('V1 GCP CLI paths must both be absolute');
    }
    return { executable: configuredPython, prefixArgs: [configuredGcloud] };
  }
  if (process.platform === 'win32') {
    const sdkRoot = 'C:\\Program Files (x86)\\Google\\Cloud SDK\\google-cloud-sdk';
    const python = `${sdkRoot}\\platform\\bundledpython\\python.exe`;
    const gcloud = `${sdkRoot}\\lib\\gcloud.py`;
    if (existsSync(python) && existsSync(gcloud)) return { executable: python, prefixArgs: [gcloud] };
    throw new Error('Bundled Google Cloud CLI Python runtime was not found');
  }
  return { executable: 'gcloud', prefixArgs: [] };
}

export function createDefaultGcloudExecutor({ environment = process.env } = {}) {
  return createGcloudExecutor(resolveDefaultGcloudLaunch(environment));
}

export function createDefaultGcloudTextExecutor({
  environment = process.env,
  execFile = execFileAsync,
} = {}) {
  const { executable, prefixArgs } = resolveDefaultGcloudLaunch(environment);
  if (typeof execFile !== 'function') throw new Error('gcloud executor configuration is invalid');
  return async (argv, { signal, maxBuffer = 1024 * 1024 } = {}) => {
    const args = nonInteractiveGcloudArgs(prefixArgs, argv);
    if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 1 || maxBuffer > 4 * 1024 * 1024) {
      throw new Error('gcloud text output limit is invalid');
    }
    let result;
    try {
      result = await execFile(executable, args, {
        encoding: 'utf8', maxBuffer, windowsHide: true, shell: false, signal,
      });
    } catch (cause) {
      throw commandError(classifyTransportError(cause));
    }
    return String(result?.stdout ?? '');
  };
}

export function createDefaultGcloudAuthenticatedRequest({ environment = process.env, account } = {}) {
  return createGcloudAuthenticatedRequest({
    ...resolveDefaultGcloudLaunch(environment), account, environment,
  });
}

export function createAuthenticatedRequest({ auth = new GoogleAuth({
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
}) } = {}) {
  if (!auth || typeof auth.getClient !== 'function') throw new Error('Google authentication client is invalid');
  let clientPromise;
  const getClient = () => (clientPromise ??= auth.getClient());
  const request = async ({ method, url, body }) => {
    if (!['GET', 'POST', 'PATCH', 'PUT'].includes(method)
      || typeof url !== 'string' || !url.startsWith('https://')) {
      throw new Error('Authenticated request is invalid');
    }
    try {
      const client = await getClient();
      client.quotaProjectId = PROJECT;
      const response = await client.request({
        method, url, data: body, timeout: 120_000,
        headers: { 'x-goog-user-project': PROJECT },
      });
      return response.data;
    } catch (cause) {
      throw commandError(classifyRestTransportError(cause));
    }
  };
  Object.defineProperty(request, 'getPrincipal', {
    enumerable: false,
    value: async () => {
      try {
        const client = await getClient();
        if (typeof client.getAccessToken !== 'function' || typeof client.getTokenInfo !== 'function') {
          throw new Error('credential identity unavailable');
        }
        const response = await client.getAccessToken();
        const token = typeof response === 'string' ? response : response?.token;
        if (typeof token !== 'string' || !token) throw new Error('credential token unavailable');
        const info = await client.getTokenInfo(token);
        if (typeof info?.email !== 'string' || !info.email) throw new Error('credential email unavailable');
        return info.email;
      } catch {
        throw commandError('REST_AUTH_UNKNOWN');
      }
    },
  });
  return request;
}

async function readActiveGcloudAccount(gcloud) {
  if (typeof gcloud !== 'function') {
    throw commandError('CONTROL_PLANE_IDENTITY_UNKNOWN');
  }
  let active;
  try {
    active = await gcloud([
      'auth', 'list', '--filter=status:ACTIVE', `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    throw commandError('CONTROL_PLANE_IDENTITY_UNKNOWN');
  }
  if (!Array.isArray(active) || active.length !== 1
    || active[0]?.status !== 'ACTIVE' || typeof active[0]?.account !== 'string') {
    throw commandError('CONTROL_PLANE_IDENTITY_MISMATCH');
  }
  return active[0].account;
}

async function assertSameControlPlaneIdentity({ account, getRestPrincipal }) {
  if (typeof account !== 'string' || !account || typeof getRestPrincipal !== 'function') {
    throw commandError('CONTROL_PLANE_IDENTITY_UNKNOWN');
  }
  let restPrincipal;
  try { restPrincipal = await getRestPrincipal(); } catch {
    throw commandError('CONTROL_PLANE_IDENTITY_UNKNOWN');
  }
  if (restPrincipal !== account) throw commandError('CONTROL_PLANE_IDENTITY_MISMATCH');
}

export async function ensureExactResource({ id, mutate, read, create, compare, initialState }) {
  if (typeof id !== 'string' || !id || typeof mutate !== 'boolean'
    || typeof read !== 'function' || typeof create !== 'function'
    || typeof compare !== 'function') throw commandError('RESOURCE_OPERATION_INVALID');
  const current = initialState ?? await read();
  if (current?.status === 'unknown') throw commandError('RESOURCE_STATE_UNKNOWN');
  if (current?.status === 'present') {
    if (!compare(current.value)) throw commandError('RESOURCE_DRIFT');
    return { id, status: 'unchanged' };
  }
  if (current?.status !== 'absent') throw commandError('RESOURCE_STATE_UNKNOWN');
  if (!mutate) return { id, status: 'planned' };
  try {
    await create();
  } catch (error) {
    if (classifyTransportError(error) === 'ALREADY_EXISTS') throw commandError('RESOURCE_COLLISION');
    let recovered;
    try { recovered = await read(); } catch { throw commandError('CREATE_RESULT_AMBIGUOUS'); }
    if (recovered?.status === 'present' && compare(recovered.value)) {
      return { id, status: 'created-readback-recovered' };
    }
    throw commandError('CREATE_RESULT_AMBIGUOUS');
  }
  const readback = await read();
  if (readback?.status !== 'present' || !compare(readback.value)) {
    throw commandError('POST_CREATE_READBACK_FAILED');
  }
  return { id, status: 'created' };
}

export async function assertNoUserManagedServiceAccountKeys({ contract, gcloud }) {
  if (!contract || !Array.isArray(contract.resources?.serviceAccounts) || typeof gcloud !== 'function') {
    throw commandError('SERVICE_ACCOUNT_KEY_AUDIT_INVALID');
  }
  for (const account of contract.resources.serviceAccounts) {
    const keys = await gcloud([
      'iam', 'service-accounts', 'keys', 'list', `--iam-account=${account.email}`,
      '--managed-by=user', `--project=${PROJECT}`, '--format=json',
    ]);
    if (!Array.isArray(keys)) throw commandError('SERVICE_ACCOUNT_KEY_AUDIT_INVALID');
    if (keys.length !== 0) throw commandError('USER_MANAGED_SERVICE_ACCOUNT_KEY');
  }
}

export function assertExactCustomRoleDefinitions({ contract, roles }) {
  if (!contract || !Array.isArray(contract.resources?.customRoles) || !Array.isArray(roles)) {
    throw commandError('CUSTOM_ROLE_ALLOWLIST_MISMATCH');
  }
  const expected = contract.resources.customRoles.map((role) => ({
    name: role.name,
    title: role.title,
    description: role.description,
    includedPermissions: [...role.includedPermissions].sort(),
    stage: role.stage,
    deleted: false,
  })).sort((left, right) => left.name.localeCompare(right.name));
  const actual = roles.map((role) => ({
    name: role?.name,
    title: role?.title,
    description: role?.description,
    includedPermissions: Array.isArray(role?.includedPermissions)
      ? [...role.includedPermissions].sort()
      : role?.includedPermissions,
    stage: role?.stage,
    deleted: role?.deleted ?? false,
  })).sort((left, right) => String(left.name).localeCompare(String(right.name)));
  if (!exact(actual, expected)) throw commandError('CUSTOM_ROLE_ALLOWLIST_MISMATCH');
  return true;
}

function managedIamScopes(contract) {
  return [
    'project', `bucket:${contract.resources.bucket.name}`,
    `bucket:${contract.resources.buildSourceBucket.name}`,
    `repository:${contract.resources.artifactRegistry.repository}`,
    ...contract.resources.secrets.map(({ id }) => `secret:${id}`),
    ...contract.resources.serviceAccounts.map(({ id }) => `service-account:${id}`),
  ];
}

function assertManagedIamPolicies({
  contract, projectNumber, policiesByScope, scopes, requireExpected, requireProtectedBaseline = false, enabledApis,
}) {
  if (!contract || !/^\d{6,20}$/.test(String(projectNumber ?? ''))
    || (!policiesByScope || typeof policiesByScope !== 'object')
    || !Array.isArray(scopes) || scopes.length === 0
    || typeof requireExpected !== 'boolean' || typeof requireProtectedBaseline !== 'boolean'
    || !(enabledApis instanceof Set)) {
    throw commandError('IAM_ALLOWLIST_MISMATCH');
  }
  const workloadMembers = new Set(contract.resources.serviceAccounts.map(
    ({ email }) => `serviceAccount:${email}`,
  ));
  const managedScopes = new Set(managedIamScopes(contract));
  if (new Set(scopes).size !== scopes.length || scopes.some((scope) => !managedScopes.has(scope))) {
    throw commandError('IAM_ALLOWLIST_MISMATCH');
  }
  const configured = contract.iam.bindings.map(({ scope, member, role }) => ({
    scope, member: member.replace('__PROJECT_NUMBER__', String(projectNumber)), role,
  }));
  const automatic = contract.iam.automaticProjectBindings.map(({ member, role, required }) => ({
    scope: 'project', member: member.replace('__PROJECT_NUMBER__', String(projectNumber)),
    role, required,
  }));
  const baseline = contract.project.protectedBindings.map(({ member, role }) => ({
    scope: 'project', member, role,
  }));
  const serviceAgentApi = new Map([
    ['roles/cloudbuild.serviceAgent', 'cloudbuild.googleapis.com'],
    ['roles/containerregistry.ServiceAgent', 'containerregistry.googleapis.com'],
    ['roles/pubsub.serviceAgent', 'pubsub.googleapis.com'],
    ['roles/artifactregistry.serviceAgent', 'artifactregistry.googleapis.com'],
    ['roles/compute.serviceAgent', 'compute.googleapis.com'],
    ['roles/servicenetworking.serviceAgent', 'servicenetworking.googleapis.com'],
    ['roles/cloudsql.serviceAgent', 'sqladmin.googleapis.com'],
    ['roles/run.serviceAgent', 'run.googleapis.com'],
    ['roles/aiplatform.serviceAgent', 'aiplatform.googleapis.com'],
    ['roles/speech.serviceAgent', 'speech.googleapis.com'],
    ['roles/monitoring.notificationServiceAgent', 'monitoring.googleapis.com'],
    ['roles/logging.serviceAgent', 'logging.googleapis.com'],
    ['roles/cloudbuild.builds.builder', 'cloudbuild.googleapis.com'],
    ['roles/compute.instanceGroupManagerServiceAgent', 'compute.googleapis.com'],
  ]);
  const permittedAutomatic = automatic.filter((binding) => (
    !serviceAgentApi.has(binding.role) || enabledApis.has(serviceAgentApi.get(binding.role))
  ));
  const required = [
    ...baseline,
    ...configured,
    ...permittedAutomatic.filter((binding) => binding.required).map(({ required: ignored, ...binding }) => {
      void ignored;
      return binding;
    }),
  ];
  const allowedKeys = new Set([
    ...configured,
    ...baseline,
    ...permittedAutomatic.map(({ required: ignored, ...binding }) => {
      void ignored;
      return binding;
    }),
  ].map(canonicalJson));
  const actualKeys = new Set();
  for (const scope of scopes) {
    const policy = policiesByScope instanceof Map ? policiesByScope.get(scope) : policiesByScope[scope];
    if (!policy || typeof policy !== 'object' || Array.isArray(policy)) {
      throw commandError('IAM_ALLOWLIST_MISMATCH');
    }
    const bindings = policy.bindings ?? [];
    if (!Array.isArray(bindings)) throw commandError('IAM_ALLOWLIST_MISMATCH');
    for (const binding of bindings) {
      if (typeof binding?.role !== 'string' || !Array.isArray(binding.members)
        || binding.members.length === 0 || binding.condition) {
        throw commandError('IAM_ALLOWLIST_MISMATCH');
      }
      for (const member of binding.members) {
        if (typeof member !== 'string') throw commandError('IAM_ALLOWLIST_MISMATCH');
        if (workloadMembers.has(member) && binding.role === 'roles/iam.serviceAccountTokenCreator') {
          throw commandError('IAM_ALLOWLIST_MISMATCH');
        }
        const key = canonicalJson({ scope, member, role: binding.role });
        if (!allowedKeys.has(key) || actualKeys.has(key)) {
          throw commandError('IAM_ALLOWLIST_MISMATCH');
        }
        actualKeys.add(key);
      }
    }
  }
  if (requireExpected && required.some((binding) => !actualKeys.has(canonicalJson(binding)))) {
    throw commandError('IAM_ALLOWLIST_MISMATCH');
  }
  if (requireProtectedBaseline && baseline.some((binding) => !actualKeys.has(canonicalJson(binding)))) {
    throw commandError('IAM_ALLOWLIST_MISMATCH');
  }
  return true;
}

export function assertManagedIamPoliciesSubset({ contract, projectNumber, policiesByScope, scopes, requireProtectedBaseline = false, enabledApis }) {
  return assertManagedIamPolicies({
    contract, projectNumber, policiesByScope, scopes, requireExpected: false, requireProtectedBaseline, enabledApis,
  });
}

export function assertExactManagedIamPolicies({ contract, projectNumber, policiesByScope, enabledApis }) {
  return assertManagedIamPolicies({
    contract, projectNumber, policiesByScope,
    scopes: managedIamScopes(contract), requireExpected: true, enabledApis,
  });
}

export function monitoringGroupByField(metricType) {
  if (String(metricType).startsWith('run.googleapis.com/')) return 'resource.label.service_name';
  if (String(metricType).startsWith('cloudsql.googleapis.com/')) return 'resource.label.database_id';
  throw new Error('unsupported monitoring metric');
}

function sameNetwork(value, expected) {
  const normalized = String(expected).replace(/^https?:\/\/[^/]+\/compute\/v1\//, '');
  const candidate = String(value).replace(/^https?:\/\/[^/]+\/compute\/v1\//, '');
  return candidate === normalized;
}

const SERVICE_NETWORKING_CONNECTION_SERVICE = 'services/servicenetworking.googleapis.com';
const SERVICE_NETWORKING_PEERING = 'servicenetworking-googleapis-com';

function serviceNetworkingNetworkName(network) {
  return `projects/${PROJECT_NUMBER}/global/networks/${network}`;
}

function requireServiceNetworkingConnections(values, network) {
  const listing = requireObjectList(values);
  const expectedNetwork = serviceNetworkingNetworkName(network);
  if (listing.length > 1
    || listing.some((value) => value.service !== SERVICE_NETWORKING_CONNECTION_SERVICE
    || value.network !== expectedNetwork
    || value.peering !== SERVICE_NETWORKING_PEERING
    || !Array.isArray(value.reservedPeeringRanges)
    || value.reservedPeeringRanges.some((range) => typeof range !== 'string'))) {
    throw commandError('LIST_RESPONSE_AMBIGUOUS');
  }
  return listing;
}

const COMPUTE_NAME = /^[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
const COMPUTE_NETWORK_PREFIX = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/`;
const COMPUTE_REGION = new RegExp(`^https://www\\.googleapis\\.com/compute/v1/projects/${PROJECT}/regions/[a-z]+(?:-[a-z]+)+[1-9]\\d*$`);
const COMPUTE_GLOBAL_ADDRESS_PREFIX = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/`;
const COMPUTE_DEFAULT_GATEWAY = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/gateways/default-internet-gateway`;
const INTERNAL_REGIONAL_SUBNETWORK_SINGLES = new Set([
  'DNS_RESOLVER', 'GCE_ENDPOINT', 'SHARED_LOADBALANCER_VIP',
]);
const INTERNAL_REGIONAL_NETWORK_RANGES = new Set(['IPSEC_INTERCONNECT']);
const INTERNAL_GLOBAL_NETWORK_SINGLES = new Set(['PRIVATE_SERVICE_CONNECT']);
const INTERNAL_REGIONAL_SELECTOR_FREE_RANGES = new Set(['SERVERLESS']);
const INTERNAL_GLOBAL_NETWORK_RANGES = new Set(['VPC_PEERING']);
const INTERNAL_ADDRESS_STATUSES = new Set(['RESERVED', 'IN_USE']);

function canonicalIpv4(value) {
  const parts = String(value).split('.');
  return parts.length === 4 && parts.every((part) => (
    /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255
  ));
}

function canonicalCidr(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2 || !canonicalIpv4(parts[0])
    || !/^(?:[0-9]|[12]\d|3[0-2])$/.test(parts[1])) return false;
  const bounds = cidrBounds(value);
  return bounds !== null && bounds[0] === ipv4Number(parts[0]);
}

function canonicalIpv6(value) {
  if (typeof value !== 'string' || value.length < 2 || value.includes('[')
    || value.includes(']') || value.includes('.')) return false;
  try {
    return new URL(`http://[${value}]/`).hostname === `[${value}]`;
  } catch {
    return false;
  }
}

function ipv6Number(value) {
  if (!canonicalIpv6(value)) return null;
  const halves = value.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const missing = halves.length === 2 ? 8 - left.length - right.length : 0;
  if ((halves.length === 1 && left.length !== 8)
    || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) return null;
  return groups.reduce((result, group) => (result << 16n) + BigInt(`0x${group}`), 0n);
}

function canonicalIpv6Cidr(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('/');
  if (parts.length !== 2 || !canonicalIpv6(parts[0])
    || !/^(?:0|[1-9]\d?|1[01]\d|12[0-8])$/.test(parts[1])) return false;
  const numeric = ipv6Number(parts[0]);
  const prefix = Number(parts[1]);
  const hostBits = 128n - BigInt(prefix);
  const hostMask = hostBits === 0n ? 0n : (1n << hostBits) - 1n;
  return numeric !== null && (numeric & hostMask) === 0n;
}

function ipv6CidrContains(outer, inner) {
  if (!canonicalIpv6Cidr(outer) || !canonicalIpv6Cidr(inner)) return false;
  const [outerAddress, outerPrefixText] = outer.split('/');
  const [innerAddress, innerPrefixText] = inner.split('/');
  const outerPrefix = Number(outerPrefixText);
  const innerPrefix = Number(innerPrefixText);
  if (innerPrefix < outerPrefix) return false;
  const hostBits = 128n - BigInt(outerPrefix);
  const mask = hostBits === 0n ? (1n << 128n) - 1n
    : ((1n << 128n) - 1n) ^ ((1n << hostBits) - 1n);
  return (ipv6Number(outerAddress) & mask) === (ipv6Number(innerAddress) & mask);
}

function plainComputeRow(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Object.values(value).every((member) => member !== null);
}

function exactAddressScope(item, regional) {
  const hasRegion = Object.hasOwn(item, 'region');
  if (regional) {
    return hasRegion && typeof item.region === 'string' && COMPUTE_REGION.test(item.region)
      && item.selfLink === `${item.region}/addresses/${item.name}`;
  }
  return !hasRegion && item.selfLink === `${COMPUTE_GLOBAL_ADDRESS_PREFIX}${item.name}`;
}

function exactSubnetworkRegion(item) {
  if (typeof item.subnetwork !== 'string' || typeof item.region !== 'string') return false;
  const prefix = `${item.region}/subnetworks/`;
  const name = item.subnetwork.slice(prefix.length);
  return item.subnetwork.startsWith(prefix) && COMPUTE_NAME.test(name);
}

function internalAddressCidr(item, networkLinks, subnetsByLink) {
  if (item.addressType !== 'INTERNAL' || !INTERNAL_ADDRESS_STATUSES.has(item.status)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  if (item.ipVersion !== 'IPV4' || item.networkTier !== 'PREMIUM'
    || Object.hasOwn(item, 'ipCollection') || Object.hasOwn(item, 'ipv6EndpointType')) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  const regionalSubnetworkSingle = INTERNAL_REGIONAL_SUBNETWORK_SINGLES.has(item.purpose);
  const regionalNetworkRange = INTERNAL_REGIONAL_NETWORK_RANGES.has(item.purpose);
  const globalNetworkSingle = INTERNAL_GLOBAL_NETWORK_SINGLES.has(item.purpose);
  const regionalSelectorFreeRange = INTERNAL_REGIONAL_SELECTOR_FREE_RANGES.has(item.purpose);
  const globalNetworkRange = INTERNAL_GLOBAL_NETWORK_RANGES.has(item.purpose);
  const single = regionalSubnetworkSingle || globalNetworkSingle;
  const range = regionalNetworkRange || regionalSelectorFreeRange || globalNetworkRange;
  if (!single && !range) throw commandError('CIDR_AUDIT_INVALID');
  if (!canonicalIpv4(item.address)) throw commandError('CIDR_AUDIT_INVALID');
  if (single && Object.hasOwn(item, 'prefixLength')) throw commandError('CIDR_AUDIT_INVALID');
  const prefixLength = single ? 32 : item.prefixLength;
  if (!Number.isInteger(prefixLength) || (range && (prefixLength < 8 || prefixLength > 30))
    || !canonicalCidr(`${item.address}/${prefixLength}`)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  const hasRegion = Object.hasOwn(item, 'region');
  const hasNetwork = Object.hasOwn(item, 'network');
  const hasSubnetwork = Object.hasOwn(item, 'subnetwork');
  const regional = regionalSubnetworkSingle || regionalNetworkRange || regionalSelectorFreeRange;
  if (regional !== hasRegion || !exactAddressScope(item, regional)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  if (regionalSubnetworkSingle) {
    if (hasNetwork || !hasSubnetwork || !exactSubnetworkRegion(item)) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
    const subnet = subnetsByLink.get(item.subnetwork);
    if (!subnet || subnet.region !== item.region
      || !cidrContainedBy(`${item.address}/32`, subnet.ipCidrRange)) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
  } else if (regionalSelectorFreeRange) {
    if (hasNetwork || hasSubnetwork) throw commandError('CIDR_AUDIT_INVALID');
  } else if (!hasNetwork || hasSubnetwork || !networkLinks.has(item.network)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  return `${item.address}/${prefixLength}`;
}

function validateExternalAddress(item, subnetsByLink) {
  if (!INTERNAL_ADDRESS_STATUSES.has(item.status) || Object.hasOwn(item, 'network')) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  const purposePresent = Object.hasOwn(item, 'purpose');
  if (purposePresent && item.purpose !== 'NAT_AUTO') throw commandError('CIDR_AUDIT_INVALID');
  const regional = Object.hasOwn(item, 'region');
  if ((purposePresent && !regional) || !exactAddressScope(item, regional)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  const hasPrefixLength = Object.hasOwn(item, 'prefixLength');
  const hasEndpointType = Object.hasOwn(item, 'ipv6EndpointType');
  const hasSubnetwork = Object.hasOwn(item, 'subnetwork');
  const hasIpCollection = Object.hasOwn(item, 'ipCollection');
  if (!['PREMIUM', 'STANDARD'].includes(item.networkTier)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  if (item.ipVersion === 'IPV4') {
    if (!canonicalIpv4(item.address) || hasPrefixLength || hasEndpointType || hasSubnetwork) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
    if (!regional && item.networkTier !== 'PREMIUM') throw commandError('CIDR_AUDIT_INVALID');
    if (hasIpCollection) {
      const prefix = `${item.region}/publicDelegatedPrefixes/`;
      const name = String(item.ipCollection).slice(prefix.length);
      if (!regional || purposePresent || !String(item.ipCollection).startsWith(prefix)
        || !COMPUTE_NAME.test(name)) throw commandError('CIDR_AUDIT_INVALID');
    }
  } else if (item.ipVersion === 'IPV6') {
    if (!canonicalIpv6(item.address) || purposePresent || hasIpCollection) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
    if (!regional) {
      if (hasPrefixLength || hasEndpointType || hasSubnetwork || item.networkTier !== 'PREMIUM') {
        throw commandError('CIDR_AUDIT_INVALID');
      }
    } else {
      if (!hasPrefixLength || item.prefixLength !== 96 || !hasEndpointType
        || !['VM', 'NETLB'].includes(item.ipv6EndpointType)
        || !hasSubnetwork || !exactSubnetworkRegion(item)
        || !canonicalIpv6Cidr(`${item.address}/96`)) {
        throw commandError('CIDR_AUDIT_INVALID');
      }
      const subnet = subnetsByLink.get(item.subnetwork);
      const acceptedEndpointMode = item.ipv6EndpointType === 'NETLB'
        ? subnet?.ipv6GceEndpoint === 'VM_AND_FR'
        : ['VM_ONLY', 'VM_AND_FR'].includes(subnet?.ipv6GceEndpoint);
      if (!subnet || subnet.region !== item.region || subnet.ipv6AccessType !== 'EXTERNAL'
        || subnet.stackType !== 'IPV4_IPV6' || !acceptedEndpointMode
        || !canonicalIpv6Cidr(subnet.externalIpv6Prefix)
        || !ipv6CidrContains(subnet.externalIpv6Prefix, `${item.address}/96`)) {
        throw commandError('CIDR_AUDIT_INVALID');
      }
    }
  } else {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  return true;
}

function validateComputeNetworksAndSubnets(networks, subnets) {
  if (!Array.isArray(networks) || !Array.isArray(subnets)
    || networks.some((item) => !plainComputeRow(item)
      || typeof item.name !== 'string' || !COMPUTE_NAME.test(item.name)
      || item.selfLink !== `${COMPUTE_NETWORK_PREFIX}${item.name}`)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  const networkLinks = new Set(networks.map(({ selfLink }) => selfLink));
  if (networkLinks.size !== networks.length) throw commandError('CIDR_AUDIT_INVALID');
  const subnetsByLink = new Map();
  for (const item of subnets) {
    if (!plainComputeRow(item) || typeof item.name !== 'string' || !COMPUTE_NAME.test(item.name)
      || !networkLinks.has(item.network) || !canonicalCidr(item.ipCidrRange)
      || typeof item.region !== 'string' || !COMPUTE_REGION.test(item.region)
      || item.selfLink !== `${item.region}/subnetworks/${item.name}`
      || subnetsByLink.has(item.selfLink)) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
    if (Object.hasOwn(item, 'externalIpv6Prefix')
      && !canonicalIpv6Cidr(item.externalIpv6Prefix)) throw commandError('CIDR_AUDIT_INVALID');
    subnetsByLink.set(item.selfLink, item);
  }
  return { networkLinks, subnetsByLink };
}

export function validateComputeAddressInventory({ addresses, networks, subnets } = {}) {
  const { networkLinks, subnetsByLink } = validateComputeNetworksAndSubnets(networks, subnets);
  if (!Array.isArray(addresses)) throw commandError('CIDR_AUDIT_INVALID');
  const selfLinks = new Set();
  for (const item of addresses) {
    if (!plainComputeRow(item) || typeof item.name !== 'string' || !COMPUTE_NAME.test(item.name)
      || typeof item.address !== 'string' || typeof item.selfLink !== 'string'
      || !['INTERNAL', 'EXTERNAL'].includes(item.addressType)
      || !['IPV4', 'IPV6'].includes(item.ipVersion)
      || !INTERNAL_ADDRESS_STATUSES.has(item.status)
      || (Object.hasOwn(item, 'kind') && item.kind !== 'compute#address')
      || selfLinks.has(item.selfLink)) {
      throw commandError('CIDR_AUDIT_INVALID');
    }
    const regional = Object.hasOwn(item, 'region');
    if (!exactAddressScope(item, regional)) throw commandError('CIDR_AUDIT_INVALID');
    selfLinks.add(item.selfLink);
    if (item.addressType === 'INTERNAL') internalAddressCidr(item, networkLinks, subnetsByLink);
    else validateExternalAddress(item, subnetsByLink);
  }
  return true;
}

function canonicalNextHop(item, networkLinks) {
  const entries = Object.entries(item).filter(([key]) => key.startsWith('nextHop'));
  if (entries.length !== 1 || typeof entries[0][1] !== 'string') return false;
  const [kind, value] = entries[0];
  const name = '[a-z](?:[-a-z0-9]{0,61}[a-z0-9])?';
  const region = '[a-z]+(?:-[a-z]+)+[1-9]\\d*';
  const zone = '[a-z]+(?:-[a-z0-9]+)+-[a-z]';
  if (kind === 'nextHopIp') return canonicalIpv4(value);
  if (kind === 'nextHopNetwork') return networkLinks.has(value);
  if (kind === 'nextHopPeering') return COMPUTE_NAME.test(value);
  if (kind === 'nextHopGateway') {
    return new RegExp(`^https://www\\.googleapis\\.com/compute/v1/projects/${PROJECT}/global/gateways/${name}$`).test(value);
  }
  if (kind === 'nextHopInstance') {
    return new RegExp(`^https://www\\.googleapis\\.com/compute/v1/projects/${PROJECT}/zones/${zone}/instances/${name}$`).test(value);
  }
  if (kind === 'nextHopVpnTunnel') {
    return new RegExp(`^https://www\\.googleapis\\.com/compute/v1/projects/${PROJECT}/regions/${region}/vpnTunnels/${name}$`).test(value);
  }
  if (kind === 'nextHopIlb') {
    return new RegExp(`^https://www\\.googleapis\\.com/compute/v1/projects/${PROJECT}/regions/${region}/forwardingRules/${name}$`).test(value);
  }
  return false;
}

function validateComputeInventory({ networks, subnets, routes, addresses }) {
  if (!Array.isArray(networks) || !Array.isArray(subnets)
    || !Array.isArray(routes) || !Array.isArray(addresses)) throw commandError('CIDR_AUDIT_INVALID');
  const { networkLinks } = validateComputeNetworksAndSubnets(networks, subnets);
  if (routes.some((item) => !item || typeof item !== 'object' || Array.isArray(item)
    || typeof item.name !== 'string' || !COMPUTE_NAME.test(item.name)
    || !networkLinks.has(item.network) || !canonicalCidr(item.destRange)
    || !canonicalNextHop(item, networkLinks))) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  validateComputeAddressInventory({ addresses, networks, subnets });
  return networkLinks;
}

function assertCidrNoOverlap({ desired, network, subnets, routes, addresses }) {
  const targetSubnets = subnets
    .filter((item) => sameNetwork(item?.network, network))
    .map(({ ipCidrRange }) => ipCidrRange);
  const targetRoutes = routes
    .filter((item) => sameNetwork(item?.network, network))
    .filter(({ destRange, nextHopGateway }) => !(
      destRange === '0.0.0.0/0' && nextHopGateway === COMPUTE_DEFAULT_GATEWAY
    ))
    .map(({ destRange }) => destRange);
  const targetAddresses = addresses
    .filter(({ addressType, status }) => addressType === 'INTERNAL' && INTERNAL_ADDRESS_STATUSES.has(status))
    .map(({ address, prefixLength }) => `${address}/${prefixLength ?? 32}`);
  if ([...targetSubnets, ...targetAddresses].some((candidate) => cidrOverlap(desired, candidate))
    || targetRoutes.some((candidate) => cidrOverlap(desired, candidate))) {
    throw commandError('CIDR_OVERLAP');
  }
}

export function assertCidrAvailable({
  desired, network, networks, subnets, routes, addresses, kind = 'subnet',
}) {
  if (typeof desired !== 'string' || typeof network !== 'string'
    || !['subnet', 'psa'].includes(kind)
    || !Array.isArray(subnets) || !Array.isArray(routes) || !Array.isArray(addresses)) {
    throw commandError('CIDR_AUDIT_INVALID');
  }
  if (!canonicalCidr(desired)) throw commandError('CIDR_AUDIT_INVALID');
  if (networks !== undefined) {
    const networkLinks = validateComputeInventory({ networks, subnets, routes, addresses });
    if (!networkLinks.has(network)) throw commandError('CIDR_AUDIT_INVALID');
  }
  assertCidrNoOverlap({ desired, network, subnets, routes, addresses });
}

function assertProjectWideCidrAvailability({ networks, subnets, routes, addresses }) {
  const inventory = {
    networks: requireObjectList(networks), subnets: requireObjectList(subnets),
    routes: requireObjectList(routes), addresses: requireObjectList(addresses),
  };
  const allNetworks = validateComputeInventory(inventory);
  for (const network of allNetworks) {
    assertCidrNoOverlap({ desired: '10.24.0.0/26', network, ...inventory });
    assertCidrNoOverlap({ desired: '10.25.0.0/16', network, ...inventory });
  }
}

function apiForProvisionStep(id) {
  if (id === 'artifact-registry') return 'artifactregistry.googleapis.com';
  if (id.startsWith('service-account:') || id.startsWith('custom-role:') || id.startsWith('iam:')) return 'iam.googleapis.com';
  if (['vpc', 'subnet', 'psa-range'].includes(id)) return 'compute.googleapis.com';
  if (id === 'psa-connection') return 'servicenetworking.googleapis.com';
  if (['cloud-sql-instance', 'database'].includes(id) || id.startsWith('db-user:')) return 'sqladmin.googleapis.com';
  if (id === 'bucket' || id === 'build-source-bucket') return 'storage.googleapis.com';
  if (id.startsWith('secret-')) return 'secretmanager.googleapis.com';
  if (id === 'notification-channel' || id.startsWith('monitoring-policy:')) return 'monitoring.googleapis.com';
  if (id === 'budget') return 'billingbudgets.googleapis.com';
  return null;
}

export function validateServiceAccountIdentity(value, { email, displayName } = {}) {
  const prototype = value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.getPrototypeOf(value)
    : undefined;
  const exactName = `projects/${PROJECT}/serviceAccounts/${email}`;
  if ((prototype !== Object.prototype && prototype !== null)
    || typeof email !== 'string' || !/^[a-z0-9][a-z0-9._-]*@[a-z0-9.-]+$/.test(email)
    || value.email !== email || value.name !== exactName || value.projectId !== PROJECT
    || (Object.hasOwn(value, 'disabled') && value.disabled !== false)
    || (displayName !== undefined && value.displayName !== displayName)
    || (Object.hasOwn(value, 'oauth2ClientId') && !/^[1-9]\d*$/.test(value.oauth2ClientId))
    || (Object.hasOwn(value, 'uniqueId') && !/^[1-9]\d*$/.test(value.uniqueId))) {
    throw commandError('SERVICE_ACCOUNT_IDENTITY_INVALID');
  }
  return true;
}

function assertManagedIdentityInventory(items, expected, extractor, marker = /hkbuddy-v1-/i) {
  const permitted = new Set(expected);
  for (const item of requireObjectList(items)) {
    const raw = extractor(item);
    if (typeof raw !== 'string' || raw.length === 0) throw commandError('LIST_RESPONSE_AMBIGUOUS');
    const name = raw.replace(/^gs:\/\//, '').split('/').at(-1).split('@')[0];
    const text = [raw, item.displayName, item.description, item.metadata?.name]
      .filter((value) => typeof value === 'string').join(' ');
    if (hasObsoleteExecutableIdentity(text)) throw commandError('RESOURCE_COLLISION');
    if (marker.test(text) && !permitted.has(name)) throw commandError('RESOURCE_COLLISION');
  }
}

export function validateManagedServiceAccountInventory(items, expectedAccounts) {
  if (!Array.isArray(expectedAccounts) || expectedAccounts.length === 0
    || expectedAccounts.some((account) => !account || typeof account !== 'object'
      || typeof account.id !== 'string' || typeof account.email !== 'string'
      || account.email.split('@')[0] !== account.id)) {
    throw commandError('LIST_RESPONSE_AMBIGUOUS');
  }
  const expectedById = new Map(expectedAccounts.map((account) => [account.id, account]));
  if (expectedById.size !== expectedAccounts.length) throw commandError('LIST_RESPONSE_AMBIGUOUS');
  assertManagedIdentityInventory(items, [...expectedById.keys()], (item) => {
    if (typeof item?.email !== 'string') throw commandError('LIST_RESPONSE_AMBIGUOUS');
    const expected = expectedById.get(item.email.split('@')[0]);
    try {
      validateServiceAccountIdentity(item, {
        email: expected?.email ?? item.email,
        ...(expected?.displayName === undefined ? {} : { displayName: expected.displayName }),
      });
    } catch {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    return item.email;
  });
  return true;
}

const OBSOLETE_EXECUTABLE_IDENTITY = new RegExp(
  `(?<![a-z0-9_-])(?:${GCP_OBSOLETE_EXECUTABLE_IDENTITIES
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|')})(?![a-z0-9_-])`,
  'i',
);

function hasObsoleteExecutableIdentity(value) {
  return OBSOLETE_EXECUTABLE_IDENTITY.test(String(value));
}

function hasManagedName(value) {
  return /hkbuddy-v1(?:-|\b)|\bhk buddy v1(?:\s|$)|\bhong kong buddy production v1(?:\s|$)/i
    .test(String(value));
}

function assertMonitoringInventory(policies, channels) {
  const expectedPolicies = new Map(REQUIRED_MONITORING.policies.map((policy) => [policy.displayName, policy]));
  const seenPolicies = new Set();
  for (const policy of requireObjectList(policies)) {
    if (!new RegExp(`^projects/${PROJECT}/alertPolicies/[1-9]\\d*$`).test(policy?.name ?? '')) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    if (typeof policy.displayName !== 'string' || (policy.userLabels !== undefined
      && (!policy.userLabels || typeof policy.userLabels !== 'object' || Array.isArray(policy.userLabels)))) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    const marker = policy.userLabels?.hkbuddy_contract;
    const managed = hasManagedName(policy.displayName) || typeof marker === 'string';
    if (!managed) continue;
    const definition = expectedPolicies.get(policy.displayName);
    if (!definition || marker !== definition.id.replaceAll('-', '_')
      || !exact(policy.userLabels, {
        application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: marker,
      })) throw commandError('RESOURCE_COLLISION');
    if (seenPolicies.has(definition.id)) throw commandError('RESOURCE_COLLISION');
    seenPolicies.add(definition.id);
  }
  let managedChannels = 0;
  for (const channel of requireObjectList(channels)) {
    if (!new RegExp(`^projects/${PROJECT}/notificationChannels/[1-9]\\d*$`).test(channel?.name ?? '')) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    if (typeof channel.displayName !== 'string' || typeof channel.type !== 'string'
      || typeof channel.enabled !== 'boolean'
      || (channel.verificationStatus !== undefined && typeof channel.verificationStatus !== 'string')
      || (channel.labels !== undefined && (!channel.labels
        || typeof channel.labels !== 'object' || Array.isArray(channel.labels)))
      || (channel.userLabels !== undefined && (!channel.userLabels
        || typeof channel.userLabels !== 'object' || Array.isArray(channel.userLabels)))) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    const managed = hasManagedName(channel.displayName)
      || channel.userLabels?.application === OWNERSHIP_LABELS.application;
    if (managed && (channel.displayName !== REQUIRED_MONITORING.notificationChannel.displayName
      || !exact(channel.userLabels, OWNERSHIP_LABELS) || channel.type !== 'email'
      || !exact(channel.labels, {
        email_address: REQUIRED_MONITORING.notificationChannel.requiredEmailAddress,
      })
      || channel.enabled !== true || channel.verificationStatus !== 'VERIFIED')) {
      throw commandError('RESOURCE_COLLISION');
    }
    if (managed) managedChannels += 1;
  }
  if (managedChannels > 1) throw commandError('RESOURCE_COLLISION');
}

function assertBudgetInventory(budgets, projectNumber) {
  for (const budget of requireObjectList(budgets)) {
    if (!new RegExp(`^billingAccounts/${BILLING_ACCOUNT}/budgets/[A-Za-z0-9_-]+$`).test(budget?.name ?? '')) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    if (typeof budget.displayName !== 'string' || !budget.budgetFilter
      || typeof budget.budgetFilter !== 'object' || Array.isArray(budget.budgetFilter)) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    if (hasManagedName(budget.displayName)
      && (budget.displayName !== 'Hong Kong Buddy Production V1 monthly guard'
        || !exact(budget.budgetFilter, {
          projects: [`projects/${projectNumber}`], calendarPeriod: 'MONTH',
          creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
        }))) {
      throw commandError('RESOURCE_COLLISION');
    }
  }
}

function cloudAssetMetadataIsValid(asset) {
  const optionalStrings = ['displayName', 'description', 'location', 'state'];
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)
    || typeof asset.name !== 'string' || !asset.name.startsWith('//')
    || typeof asset.assetType !== 'string' || asset.assetType.length < 3
    || typeof asset.project !== 'string'
    || typeof asset.parentFullResourceName !== 'string' || !asset.parentFullResourceName.startsWith('//')
    || typeof asset.parentAssetType !== 'string' || asset.parentAssetType.length < 3
    || optionalStrings.some((field) => Object.hasOwn(asset, field) && typeof asset[field] !== 'string')) return false;
  if (Object.hasOwn(asset, 'labels') && (
    !asset.labels || typeof asset.labels !== 'object' || Array.isArray(asset.labels)
      || Object.values(asset.labels).some((value) => typeof value !== 'string')
  )) return false;
  return true;
}

function exactAsset({ asset, assetType, name, location, parent = ASSET_PROJECT_PARENT, parentAssetType = ASSET_PROJECT_TYPE }) {
  return asset.assetType === assetType && asset.name === name && asset.location === location
    && asset.parentFullResourceName === parent && asset.parentAssetType === parentAssetType;
}

function exactTopLevelManagedAsset(asset) {
  const serviceAccountDisplays = {
    'hkbuddy-v1-runtime': 'Hong Kong Buddy Cloud Run runtime',
    'hkbuddy-v1-build': 'Hong Kong Buddy Cloud Build',
    'hkbuddy-v1-migrator': 'Hong Kong Buddy database migrator',
    'hkbuddy-v1-deployer': 'Hong Kong Buddy release deployer',
    'hkbuddy-v1-acceptance': 'Hong Kong Buddy dependency acceptance',
  };
  const serviceAccounts = new Map(Object.values(GCP_IDENTITY.serviceAccounts).map((email) => [
    `//iam.googleapis.com/projects/${PROJECT}/serviceAccounts/${email}`, serviceAccountDisplays[email.split('@')[0]],
  ]));
  const secrets = new Set(Object.values(GCP_IDENTITY.secrets).map((id) => `//secretmanager.googleapis.com/projects/${PROJECT}/secrets/${id}`));
  const jobs = new Set(Object.values(GCP_IDENTITY.jobs).map((id) => `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/jobs/${id}`));
  for (const service of [GCP_IDENTITY.service, GCP_IDENTITY.candidateService]) {
    if (exactAsset({ asset, assetType: 'run.googleapis.com/Service', name: `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${service}`, location: 'asia-east2' })) return asset.displayName === undefined || asset.displayName === service;
  }
  if (exactAsset({ asset, assetType: 'artifactregistry.googleapis.com/Repository', name: `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`, location: 'asia-east2' })) return asset.displayName === undefined || asset.displayName === GCP_IDENTITY.repository;
  if (exactAsset({ asset, assetType: 'storage.googleapis.com/Bucket', name: `//storage.googleapis.com/${GCP_IDENTITY.bucket}`, location: 'asia-east2' })) return true;
  if (exactAsset({ asset, assetType: 'storage.googleapis.com/Bucket', name: `//storage.googleapis.com/${GCP_IDENTITY.buildSourceBucket}`, location: 'asia-east2' })) return true;
  if (exactAsset({ asset, assetType: 'sqladmin.googleapis.com/Instance', name: `//sqladmin.googleapis.com/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}`, location: 'asia-east2' })) return true;
  if (exactAsset({ asset, assetType: 'compute.googleapis.com/Network', name: `//compute.googleapis.com/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`, location: 'global' })) return true;
  if (exactAsset({ asset, assetType: 'compute.googleapis.com/Subnetwork', name: `//compute.googleapis.com/projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}`, location: 'asia-east2' })) return true;
  if (exactAsset({ asset, assetType: 'compute.googleapis.com/Address', name: `//compute.googleapis.com/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`, location: 'global' })) return true;
  if (exactAsset({
    asset, assetType: 'servicenetworking.googleapis.com/Connection',
    name: `//servicenetworking.googleapis.com/projects/${PROJECT_NUMBER}/global/networks/${GCP_IDENTITY.network}`,
    location: 'global', parent: `//cloudresourcemanager.googleapis.com/projects/${PROJECT_NUMBER}`,
  })) return true;
  if (serviceAccounts.has(asset.name) && exactAsset({ asset, assetType: 'iam.googleapis.com/ServiceAccount', name: asset.name, location: 'global' })) return asset.displayName === undefined || asset.displayName === serviceAccounts.get(asset.name);
  if (secrets.has(asset.name) && exactAsset({ asset, assetType: 'secretmanager.googleapis.com/Secret', name: asset.name, location: 'global' })) return true;
  if (jobs.has(asset.name) && exactAsset({ asset, assetType: 'run.googleapis.com/Job', name: asset.name, location: 'asia-east2' })) return true;
  return REQUIRED_CUSTOM_ROLES.some(({ id }) => exactAsset({ asset, assetType: 'iam.googleapis.com/Role', name: `//iam.googleapis.com/projects/${PROJECT}/roles/${id}`, location: 'global' }));
}

function exactManagedDescendantAsset(asset) {
  const repository = `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`;
  if (asset.assetType === 'run.googleapis.com/Revision') {
    return [GCP_IDENTITY.service, GCP_IDENTITY.candidateService].some((serviceName) => {
      const service = `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${serviceName}`;
      const prefix = `${service}/revisions/${serviceName}-`;
      return asset.name.startsWith(prefix) && /^[0-9a-f]{12}$/.test(asset.name.slice(prefix.length))
        && asset.location === 'asia-east2' && asset.parentFullResourceName === service
        && asset.parentAssetType === 'run.googleapis.com/Service';
    });
  }
  if (asset.assetType === 'artifactregistry.googleapis.com/DockerImage') {
    const prefix = `${repository}/dockerImages/${GCP_IDENTITY.service}@sha256:`;
    return asset.name.startsWith(prefix) && /^[0-9a-f]{64}$/.test(asset.name.slice(prefix.length))
      && asset.location === 'asia-east2' && asset.parentFullResourceName === repository
      && asset.parentAssetType === 'artifactregistry.googleapis.com/Repository';
  }
  return false;
}

function exactManagedGeneratedAsset(asset) {
  const labels = asset.labels ?? {};
  if (asset.assetType === 'monitoring.googleapis.com/AlertPolicy') {
    const policy = REQUIRED_MONITORING.policies.find(({ displayName }) => displayName === asset.displayName);
    return Boolean(policy) && new RegExp(`^//monitoring\\.googleapis\\.com/projects/${PROJECT_NUMBER}/alertPolicies/[1-9]\\d*$`).test(asset.name)
      && asset.location === 'global' && asset.parentFullResourceName === ASSET_PROJECT_PARENT
      && asset.parentAssetType === ASSET_PROJECT_TYPE
      && exact(labels, { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: policy.id.replaceAll('-', '_') });
  }
  if (asset.assetType === 'monitoring.googleapis.com/NotificationChannel') {
    return asset.displayName === REQUIRED_MONITORING.notificationChannel.displayName
      && new RegExp(`^//monitoring\\.googleapis\\.com/projects/${PROJECT_NUMBER}/notificationChannels/[1-9]\\d*$`).test(asset.name)
      && asset.location === 'global' && asset.parentFullResourceName === ASSET_PROJECT_PARENT
      && asset.parentAssetType === ASSET_PROJECT_TYPE
      && exact(labels, {
        email_address: REQUIRED_MONITORING.notificationChannel.requiredEmailAddress,
      });
  }
  return false;
}

function assetHasManagedMarker(asset) {
  const text = [asset.name, asset.displayName, asset.description, asset.parentFullResourceName,
    asset.parentAssetType,
    ...Object.entries(asset.labels ?? {}).flat()]
    .filter((value) => typeof value === 'string').join(' ');
  return hasManagedName(text) || /hkbuddyv1/i.test(text);
}

function assertCloudAssetInventory(assets) {
  if (!Array.isArray(assets) || assets.some((asset) => !cloudAssetMetadataIsValid(asset))) {
    throw commandError('CLOUD_ASSET_INVENTORY_AMBIGUOUS');
  }
  if (assets.some((asset) => asset.project !== ASSET_PROJECT)) {
    throw commandError('CLOUD_ASSET_INVENTORY_WRONG_PROJECT');
  }
  for (const asset of assets) {
    const text = [asset.name, asset.displayName, asset.description, asset.parentFullResourceName,
      asset.parentAssetType, ...Object.entries(asset.labels ?? {}).flat()]
      .filter((value) => typeof value === 'string').join(' ');
    if (hasObsoleteExecutableIdentity(text)) {
      throw commandError('RESOURCE_COLLISION');
    }
    const managedDescendantParent = asset.parentFullResourceName
      === `//artifactregistry.googleapis.com/projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`
      || [GCP_IDENTITY.service, GCP_IDENTITY.candidateService].some((service) => (
        asset.parentFullResourceName
        === `//run.googleapis.com/projects/${PROJECT}/locations/asia-east2/services/${service}`
      ));
    if ((assetHasManagedMarker(asset) || managedDescendantParent) && !exactTopLevelManagedAsset(asset)
      && !exactManagedDescendantAsset(asset) && !exactManagedGeneratedAsset(asset)) {
      throw commandError('RESOURCE_COLLISION');
    }
  }
  return assets;
}

function iamStepIds(contract) {
  return contract.iam.bindings.map((_, index) => `iam:${String(index + 1).padStart(2, '0')}`);
}

function policyStepIds(contract) {
  return contract.resources.monitoring.policies.map(({ id }) => `monitoring-policy:${id}`);
}

function provisionSteps(contract) {
  return [
    'project', 'billing', 'apis', 'notification-channel', 'budget',
    ...policyStepIds(contract),
    'artifact-registry',
    ...contract.resources.serviceAccounts.map(({ id }) => `service-account:${id}`),
    ...contract.resources.customRoles.map(({ id }) => `custom-role:${id}`),
    'vpc', 'subnet', 'psa-range', 'psa-connection', 'cloud-sql-instance', 'database',
    'bucket', 'build-source-bucket',
    ...contract.resources.secrets.map(({ id }) => `secret-container:${id}`),
    `secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`,
    `secret-version:${GCP_IDENTITY.secrets.dbMigratorUrl}`,
    `secret-version:${GCP_IDENTITY.secrets.session}`,
    'db-user:hkbuddy_app', 'db-user:hkbuddy_migrator',
    `secret-version:${GCP_IDENTITY.secrets.bootstrap}`,
    ...iamStepIds(contract),
  ];
}

const STATIC_EXPECTED_STEPS = [
  'project', 'billing', 'apis', 'notification-channel', 'budget',
  'monitoring-policy:run-5xx-ratio', 'monitoring-policy:run-latency-p95',
  'monitoring-policy:run-instance-cap', 'monitoring-policy:sql-cpu',
  'monitoring-policy:sql-storage', 'monitoring-policy:sql-connections',
  'monitoring-policy:sql-backup-failure', 'monitoring-policy:sql-failover',
  'monitoring-policy:sql-restart', 'monitoring-policy:cloud-build-failure',
  'monitoring-policy:run-deployment-failure',
  'artifact-registry',
  'service-account:hkbuddy-v1-runtime', 'service-account:hkbuddy-v1-build',
  'service-account:hkbuddy-v1-migrator', 'service-account:hkbuddy-v1-deployer',
  'service-account:hkbuddy-v1-acceptance',
  'custom-role:hkbuddyV1AcceptanceBucketMetadataReader',
  'vpc', 'subnet', 'psa-range', 'psa-connection', 'cloud-sql-instance', 'database',
  'bucket', 'build-source-bucket',
  ...SECRET_CONTAINER_IDS.map((id) => `secret-container:${id}`),
  `secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`, `secret-version:${GCP_IDENTITY.secrets.dbMigratorUrl}`,
  `secret-version:${GCP_IDENTITY.secrets.session}`, 'db-user:hkbuddy_app',
  'db-user:hkbuddy_migrator', `secret-version:${GCP_IDENTITY.secrets.bootstrap}`,
  ...Array.from({ length: 35 }, (_, index) => `iam:${String(index + 1).padStart(2, '0')}`),
];

export const EXPECTED_PROVISION_STEPS = Object.freeze(STATIC_EXPECTED_STEPS);

function preMutationParent(id) {
  if (id === 'subnet' || id === 'psa-connection') return 'vpc';
  if (id === 'database' || id.startsWith('db-user:')) return 'cloud-sql-instance';
  if (id.startsWith('secret-version:')) {
    return `secret-container:${id.slice('secret-version:'.length)}`;
  }
  return null;
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return { valid: false };
  let confirmed = false;
  let channel = null;
  for (const value of argv) {
    if (value === `--confirm-project=${PROJECT}` && !confirmed) {
      confirmed = true;
    } else if (value.startsWith('--notification-channel=') && channel === null) {
      channel = canonicalMonitoringChannelName(value.slice('--notification-channel='.length));
      if (!channel) return { valid: false };
    } else {
      return { valid: false };
    }
  }
  return { valid: true, confirmed, channel };
}

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

function contextValue(controlPlane, id) {
  return typeof controlPlane.value === 'function' ? controlPlane.value(id) : undefined;
}

function randomSecret(randomBytes, bytes = 32) {
  const value = randomBytes(bytes);
  if (!Buffer.isBuffer(value) || value.length < bytes) throw commandError('SECRET_GENERATION_FAILED');
  return value.toString('base64url');
}

function isCanonicalSecret(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  let decoded;
  try { decoded = Buffer.from(value, 'base64url'); } catch { return false; }
  return decoded.length === 32 && decoded.toString('base64url') === value;
}

function databaseUrl({ user, password, privateIp, database }) {
  if (typeof privateIp !== 'string' || !/^10\.25\.\d{1,3}\.\d{1,3}$/.test(privateIp)) {
    throw commandError('CLOUD_SQL_PRIVATE_IP_UNAVAILABLE');
  }
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${privateIp}:5432/${database}?sslmode=require`;
}

function secretVersionFromValue(value) {
  return NUMERIC_VERSION.test(String(value?.version ?? '')) ? String(value.version) : null;
}

function sensitiveInputFor(id, { contract, controlPlane, randomBytes, secretVersions }) {
  if (id === `secret-version:${GCP_IDENTITY.secrets.session}`) {
    return { value: randomSecret(randomBytes) };
  }
  if (id === `secret-version:${GCP_IDENTITY.secrets.dbAppUrl}` || id === `secret-version:${GCP_IDENTITY.secrets.dbMigratorUrl}`) {
    const app = id.endsWith('app-url');
    const user = app ? 'hkbuddy_app' : 'hkbuddy_migrator';
    const sql = contextValue(controlPlane, 'cloud-sql-instance');
    return {
      value: databaseUrl({
        user, password: randomSecret(randomBytes),
        privateIp: sql?.privateIp, database: contract.resources.cloudSql.database,
      }),
    };
  }
  if (id === 'db-user:hkbuddy_app' || id === 'db-user:hkbuddy_migrator') {
    const user = id.slice('db-user:'.length);
    const secretId = user === 'hkbuddy_app' ? GCP_IDENTITY.secrets.dbAppUrl : GCP_IDENTITY.secrets.dbMigratorUrl;
    const secret = contextValue(controlPlane, `secret-version:${secretId}`);
    return { databaseUrl: secret?.secretValue };
  }
  if (id === `secret-version:${GCP_IDENTITY.secrets.bootstrap}`) {
    return {
      value: canonicalJson({
        schemaVersion: 1,
        projectId: PROJECT,
        instance: contract.resources.cloudSql.instance,
        database: contract.resources.cloudSql.database,
        appUser: 'hkbuddy_app',
        appSecretVersion: secretVersions[GCP_IDENTITY.secrets.dbAppUrl],
        migratorUser: 'hkbuddy_migrator',
        migratorSecretVersion: secretVersions[GCP_IDENTITY.secrets.dbMigratorUrl],
        appDatabaseRoles: ['pg_read_all_data', 'pg_write_all_data'],
        migratorDatabaseRoles: ['cloudsqlsuperuser'],
      }),
    };
  }
  return null;
}

function safeFailureReport(code, completed, resumeBoundary, mutationPerformed = false) {
  return {
    status: 'failed', code, projectId: PROJECT, mutationPerformed,
    completed, resumeBoundary,
    partialResourcesPreserved: true,
  };
}

export async function runGcpProvision({
  argv = process.argv.slice(2),
  contract,
  controlPlane,
  gcloud,
  request,
  environment = process.env,
  getRestPrincipal,
  randomBytes = nodeRandomBytes,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  let selectedContract;
  try { selectedContract = assertResourceContract(contract ?? await loadResourceContract()); } catch {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RESOURCE_CONTRACT_INVALID', projectId: PROJECT,
      mutationPerformed: false,
    });
  }
  if (!exact(provisionSteps(selectedContract), STATIC_EXPECTED_STEPS)) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'RESOURCE_CONTRACT_INVALID', projectId: PROJECT,
      mutationPerformed: false,
    });
  }

  const selection = parseArguments(argv);
  if (!selection.valid) {
    return publish(writeOutput, 2, {
      status: 'not-run', code: 'EXACT_PROJECT_CONFIRMATION_REQUIRED',
      projectId: PROJECT, mutationPerformed: false,
    });
  }
  if (!selection.confirmed) {
    return publish(writeOutput, 0, {
      status: 'dry-run', code: 'GCP_PROVISION_DRY_RUN', projectId: PROJECT,
      mutationPerformed: false, plannedSteps: [...STATIC_EXPECTED_STEPS],
    });
  }

  let plane = controlPlane;
  try {
    if (!plane) {
      const liveGcloud = gcloud ?? createDefaultGcloudExecutor({ environment });
      const activeAccount = await readActiveGcloudAccount(liveGcloud);
      if (activeAccount !== REQUIRED_OPERATOR_ACCOUNT) {
        throw commandError('CONTROL_PLANE_IDENTITY_MISMATCH');
      }
      const liveRequest = request ?? createDefaultGcloudAuthenticatedRequest({
        environment, account: activeAccount,
      });
      await assertSameControlPlaneIdentity({
        account: activeAccount,
        getRestPrincipal: getRestPrincipal ?? liveRequest.getPrincipal,
      });
      plane = new GcpControlPlane({
        contract: selectedContract,
        notificationChannel: selection.channel,
        gcloud: liveGcloud,
        request: liveRequest,
      });
    }
  } catch (error) {
    const code = ['CONTROL_PLANE_IDENTITY_UNKNOWN', 'CONTROL_PLANE_IDENTITY_MISMATCH'].includes(error?.code)
      ? error.code
      : 'CONTROL_PLANE_UNAVAILABLE';
    return publish(writeOutput, 1, {
      ...safeFailureReport(code, [], 'project'), mutationPerformed: false,
    });
  }
  if (!plane || typeof plane.read !== 'function' || typeof plane.create !== 'function'
    || typeof plane.compare !== 'function'
    || typeof plane.auditUserManagedServiceAccountKeys !== 'function'
    || typeof plane.auditManagedIamPolicies !== 'function'
    || typeof plane.auditPreMutationState !== 'function'
    || typeof plane.finalReadback !== 'function') {
    return publish(writeOutput, 1, {
      ...safeFailureReport('CONTROL_PLANE_INVALID', [], 'project'), mutationPerformed: false,
    });
  }

  const completed = [];
  const secretVersions = {};
  let mutationPerformed = false;
  try {
    await plane.auditPreMutationState({ notificationChannel: selection.channel });
  } catch (error) {
    return publish(writeOutput, 1, {
      ...safeFailureReport(error?.code ?? 'PRE_MUTATION_AUDIT_FAILED', [], 'pre-mutation-audit'),
      mutationPerformed: false,
    });
  }
  for (const id of STATIC_EXPECTED_STEPS) {
    if (id === 'billing' || id === `secret-version:${GCP_IDENTITY.secrets.dbAppUrl}`) {
      const projectOnly = id === 'billing';
      try {
        await plane.auditManagedIamPolicies({ projectOnly });
      } catch (error) {
        return publish(writeOutput, 1, safeFailureReport(
          error?.code ?? 'IAM_ALLOWLIST_MISMATCH', completed,
          projectOnly ? 'project-iam-subset-audit' : 'managed-iam-subset-audit',
          mutationPerformed,
        ));
      }
    }
    if (id === 'vpc') {
      try {
        await plane.auditUserManagedServiceAccountKeys();
      } catch (error) {
        return publish(writeOutput, 1, safeFailureReport(
          error?.code ?? 'SERVICE_ACCOUNT_KEY_AUDIT_INVALID', completed,
          'service-account-key-audit',
          mutationPerformed,
        ));
      }
    }
    if (id === 'notification-channel') {
      if (!selection.channel) {
        return publish(writeOutput, 1, safeFailureReport(
          'ALERT_CHANNEL_REQUIRED', completed, id, mutationPerformed,
        ));
      }
      let channel;
      try { channel = await plane.read(id, { notificationChannel: selection.channel }); } catch {
        return publish(writeOutput, 1, safeFailureReport(
          'ALERT_CHANNEL_UNVERIFIED', completed, id, mutationPerformed,
        ));
      }
      if (channel?.status !== 'present' || !plane.compare(id, channel.value, { notificationChannel: selection.channel })) {
        return publish(writeOutput, 1, safeFailureReport(
          'ALERT_CHANNEL_UNVERIFIED', completed, id, mutationPerformed,
        ));
      }
      completed.push(id);
      continue;
    }

    let sensitive = null;
    try {
      if (id.startsWith('secret-version:') || id.startsWith('db-user:')) {
        const current = await plane.read(id, { notificationChannel: selection.channel, secretVersions });
        if (current?.status === 'present' && plane.compare(id, current.value, { secretVersions })) {
          completed.push(id);
          if (id.startsWith('secret-version:')) {
            const secretId = id.slice('secret-version:'.length);
            const version = secretVersionFromValue(current.value);
            if (!version) throw commandError('SECRET_VERSION_INVALID');
            secretVersions[secretId] = version;
          }
          continue;
        }
        if (current?.status === 'unknown') throw commandError('RESOURCE_STATE_UNKNOWN');
        if (current?.status === 'present') throw commandError('RESOURCE_DRIFT');
        sensitive = sensitiveInputFor(id, {
          contract: selectedContract, controlPlane: plane, randomBytes, secretVersions,
        });
        const result = await ensureExactResource({
          id, mutate: true,
          initialState: current,
          read: () => plane.read(id, { notificationChannel: selection.channel, secretVersions }),
          create: () => {
            mutationPerformed = true;
            return plane.create(id, {
              notificationChannel: selection.channel, secretVersions, sensitive,
            });
          },
          compare: (value) => plane.compare(id, value, { secretVersions }),
        });
        void result;
      } else if (id === 'project' || id === 'billing') {
        const current = await plane.read(id, { notificationChannel: selection.channel, secretVersions });
        if (current?.status !== 'present' || !plane.compare(id, current.value, {
          notificationChannel: selection.channel, secretVersions,
        })) throw commandError('SHARED_PROJECT_BASELINE_INVALID');
      } else {
        await ensureExactResource({
          id, mutate: true,
          read: () => plane.read(id, { notificationChannel: selection.channel, secretVersions }),
          create: () => {
            mutationPerformed = true;
            return plane.create(id, { notificationChannel: selection.channel, secretVersions });
          },
          compare: (value) => plane.compare(id, value, { notificationChannel: selection.channel, secretVersions }),
        });
      }
      completed.push(id);
      if (id.startsWith('secret-version:')) {
        const secretId = id.slice('secret-version:'.length);
        const version = secretVersionFromValue(contextValue(plane, id));
        if (!version) throw commandError('SECRET_VERSION_INVALID');
        secretVersions[secretId] = version;
      }
    } catch (error) {
      return publish(writeOutput, 1, safeFailureReport(
        error?.code === 'RESOURCE_DRIFT' && id === 'notification-channel'
          ? 'ALERT_CHANNEL_UNVERIFIED'
          : (error?.code ?? 'PROVISION_STEP_FAILED'),
        completed,
        id,
        mutationPerformed,
      ));
    } finally {
      sensitive = null;
    }
  }

  try { await plane.finalReadback({ notificationChannel: selection.channel, secretVersions }); } catch (error) {
    return publish(writeOutput, 1, safeFailureReport(
      error?.code ?? 'FINAL_READBACK_FAILED', completed, 'final-readback', mutationPerformed,
    ));
  }
  if (!GENERATED_SECRET_IDS.every((id) => NUMERIC_VERSION.test(String(secretVersions[id] ?? '')))) {
    return publish(writeOutput, 1, safeFailureReport(
      'SECRET_VERSION_INVALID', completed, 'final-readback', mutationPerformed,
    ));
  }
  return publish(writeOutput, 0, {
    status: 'provisioned', code: 'GCP_PROVISION_COMPLETE', projectId: PROJECT,
    mutationPerformed, completed, secretVersions,
  });
}

// The live control plane is deliberately below the orchestration contract. It
// converts fixed operation IDs to argv arrays or authenticated HTTPS requests;
// it never receives a shell command string.
export class GcpControlPlane {
  constructor({ contract, notificationChannel, gcloud, request }) {
    this.contract = contract;
    this.notificationChannel = notificationChannel == null
      ? null
      : canonicalMonitoringChannelName(notificationChannel);
    this.gcloud = gcloud;
    this.request = request;
    this.cache = new Map();
    this.createdUsers = new Set();
  }

  value(id) {
    return this.cache.get(id);
  }

  async auditUserManagedServiceAccountKeys() {
    return assertNoUserManagedServiceAccountKeys({ contract: this.contract, gcloud: this.gcloud });
  }

  async auditManagedIamPolicies(options = {}) {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || Object.keys(options).some((key) => !['projectOnly', 'requireProtectedBaseline'].includes(key))) {
      throw commandError('IAM_ALLOWLIST_MISMATCH');
    }
    const projectOnly = options.projectOnly ?? false;
    const requireProtectedBaseline = options.requireProtectedBaseline ?? projectOnly;
    if (typeof projectOnly !== 'boolean' || typeof requireProtectedBaseline !== 'boolean') {
      throw commandError('IAM_ALLOWLIST_MISMATCH');
    }
    const scopes = projectOnly ? ['project'] : managedIamScopes(this.contract);
    const enabledBefore = await this.#enabledApis();
    const policyEntries = await Promise.all(scopes.map(async (scope) => (
      [scope, await this.#iamPolicy(scope)]
    )));
    if (!projectOnly) await this.#auditCustomRoles();
    const enabledAfter = await this.#enabledApis();
    if (!sameStringSet(enabledBefore, enabledAfter)) throw commandError('IAM_ALLOWLIST_MISMATCH');
    assertManagedIamPoliciesSubset({
      contract: this.contract,
      projectNumber: this.#projectNumber(),
      policiesByScope: new Map(policyEntries),
      scopes, enabledApis: enabledAfter, requireProtectedBaseline,
    });
    return new Set(enabledAfter);
  }

  async auditPreMutationState({ notificationChannel } = {}) {
    const project = await this.read('project');
    const billing = await this.read('billing');
    if (project?.status !== 'present' || !this.compare('project', project.value)
      || billing?.status !== 'present' || !this.compare('billing', billing.value)) {
      throw commandError('SHARED_PROJECT_BASELINE_INVALID');
    }
    let organization;
    let billingAccount;
    try {
      organization = await this.#gcloud([
        'organizations', 'describe', ORGANIZATION, `--project=${PROJECT}`, '--format=json',
      ]);
      billingAccount = await this.#gcloud([
        'billing', 'accounts', 'describe', BILLING_ACCOUNT,
        `--project=${PROJECT}`, '--format=json',
      ]);
    } catch {
      throw commandError('SHARED_PROJECT_BASELINE_INVALID');
    }
    if (!isExactOrganizationResource(organization)
      || !isExactBillingAccountResource(billingAccount)) {
      throw commandError('SHARED_PROJECT_BASELINE_INVALID');
    }
    await this.#auditCloudAssetInventory();
    const enabledBeforeIamAudit = await this.#enabledApis();
    const enabledApis = await this.auditManagedIamPolicies({ projectOnly: true });
    if (!sameStringSet(enabledBeforeIamAudit, enabledApis)) {
      throw commandError('IAM_ALLOWLIST_MISMATCH');
    }
    await this.#auditManagedIdentityInventory(enabledApis);

    if (enabledApis.has('compute.googleapis.com')) {
      const [networks, subnets, routes, addresses] = await Promise.all([
        this.#gcloud(['compute', 'networks', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['compute', 'networks', 'subnets', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['compute', 'routes', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['compute', 'addresses', 'list', `--project=${PROJECT}`, '--format=json']),
      ]);
      const networkInventory = requireObjectList(networks);
      assertProjectWideCidrAvailability({ networks, subnets, routes, addresses });
      if (enabledApis.has('servicenetworking.googleapis.com')) {
        const peeringLists = await Promise.all(networkInventory.map(async ({ name }) => (
          requireServiceNetworkingConnections(await this.#gcloud([
            'services', 'vpc-peerings', 'list', `--network=${name}`, '--service=servicenetworking.googleapis.com',
            `--project=${PROJECT}`, '--format=json',
          ]), name)
        )));
        const targetNetwork = serviceNetworkingNetworkName(GCP_IDENTITY.network);
        if (peeringLists.flatMap(requireObjectList).some((peering) => (
          Array.isArray(peering?.reservedPeeringRanges)
          && peering.reservedPeeringRanges.includes(GCP_IDENTITY.psaRange)
          && !sameNetwork(peering.network, targetNetwork)
        ))) throw commandError('RESOURCE_COLLISION');
      }
    }

    const context = {
      notificationChannel: canonicalMonitoringChannelName(notificationChannel),
      secretVersions: {},
    };
    const auditStatuses = new Map();
    for (const id of STATIC_EXPECTED_STEPS) {
      if (['project', 'billing', 'apis'].includes(id) || id.startsWith('iam:')) continue;
      if (id === 'notification-channel' && !notificationChannel) continue;
      const api = apiForProvisionStep(id);
      if (api && !enabledApis.has(api)) continue;
      const parent = preMutationParent(id);
      if (parent) {
        const parentStatus = auditStatuses.get(parent);
        if (parentStatus === 'absent') continue;
        if (parentStatus !== 'present') throw commandError('RESOURCE_STATE_UNKNOWN');
      }
      const current = await this.read(id, context);
      if (id === 'notification-channel' && current?.status !== 'present') {
        throw commandError('ALERT_CHANNEL_REQUIRED');
      }
      if (!['present', 'absent'].includes(current?.status)) {
        throw commandError('RESOURCE_STATE_UNKNOWN');
      }
      if (current?.status === 'present' && !this.compare(id, current.value, context)) {
        throw commandError('RESOURCE_COLLISION');
      }
      auditStatuses.set(id, current.status);
    }
    return true;
  }

  async read(id, context = {}) {
    try {
      const result = await this.#read(id, context);
      if (result?.status === 'present') this.cache.set(id, result.value);
      return result;
    } catch (error) {
      const code = classifyTransportError(error);
      if (code === 'NOT_FOUND') return { status: 'absent' };
      if (code === 'FORBIDDEN') return { status: 'unknown', code: 'FORBIDDEN' };
      throw error;
    }
  }

  async create(id, context = {}) {
    if (id === 'project' || id === 'billing') throw commandError('SHARED_PROJECT_MUTATION_FORBIDDEN');
    const value = await this.#create(id, context);
    if (id.startsWith('db-user:')) this.createdUsers.add(id.slice('db-user:'.length));
    return value;
  }

  compare(id, value, context = {}) {
    try { return this.#compare(id, value, context); } catch { return false; }
  }

  async #gcloud(args, options) {
    if (!args.includes(`--project=${PROJECT}`)) throw commandError('PROJECT_FLAG_REQUIRED');
    return this.gcloud(args, options);
  }

  async #rest(input) {
    try {
      return await this.request(input);
    } catch (error) {
      if (error?.code === 'NOT_FOUND') throw commandError('TRANSPORT_AMBIGUOUS');
      throw error;
    }
  }

  async #listAll({ url, itemKey }) {
    const items = [];
    const seenTokens = new Set();
    let pageToken = null;
    for (let page = 0; page < 1_000; page += 1) {
      const pageUrl = new URL(url);
      if (pageToken !== null) pageUrl.searchParams.set('pageToken', pageToken);
      const response = await this.#rest({ method: 'GET', url: pageUrl.href });
      if (!response || typeof response !== 'object' || Array.isArray(response)) {
        throw commandError('PAGINATION_AMBIGUOUS');
      }
      const members = response?.[itemKey] ?? [];
      if (!Array.isArray(members)) throw commandError('PAGINATION_AMBIGUOUS');
      items.push(...members);
      const next = response?.nextPageToken;
      if (next === undefined || next === null || next === '') return items;
      if (typeof next !== 'string' || next.length > 2_048 || seenTokens.has(next)) {
        throw commandError('PAGINATION_AMBIGUOUS');
      }
      seenTokens.add(next);
      pageToken = next;
    }
    throw commandError('PAGINATION_AMBIGUOUS');
  }

  #projectNumber() {
    const project = this.cache.get('project');
    const value = String(project?.projectNumber ?? '');
    if (!/^\d{6,20}$/.test(value)) throw commandError('PROJECT_NUMBER_UNAVAILABLE');
    return value;
  }

  async #enabledApis() {
    const enabled = requireObjectList(await this.#gcloud([
      'services', 'list', '--enabled', `--project=${PROJECT}`, '--format=json',
    ]));
    const enabledApis = requireEnabledApiSet(enabled);
    this.cache.set('apis', enabled);
    return enabledApis;
  }

  #privateIp() {
    const cached = this.cache.get('cloud-sql-instance');
    if (cached?.privateIp) return cached.privateIp;
    const value = cached?.ipAddresses?.find(({ type }) => type === 'PRIVATE')?.ipAddress;
    if (!value) throw commandError('CLOUD_SQL_PRIVATE_IP_UNAVAILABLE');
    return value;
  }

  #binding(index) {
    const binding = structuredClone(this.contract.iam.bindings[index]);
    binding.member = binding.member.replace('__PROJECT_NUMBER__', this.#projectNumber());
    return binding;
  }

  #customRole(id) {
    const role = this.contract.resources.customRoles.find(({ id: candidate }) => candidate === id);
    if (!role) throw commandError('CUSTOM_ROLE_UNSUPPORTED');
    return role;
  }

  async #auditCustomRoles() {
    const roles = requireObjectList(await this.#gcloud([
      'iam', 'roles', 'list', `--project=${PROJECT}`, '--format=json',
    ]));
    return assertExactCustomRoleDefinitions({ contract: this.contract, roles });
  }

  async #auditManagedIdentityInventory(enabledApis) {
    if (enabledApis.has('iam.googleapis.com')) {
      const [serviceAccounts, roles] = await Promise.all([
        this.#gcloud(['iam', 'service-accounts', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['iam', 'roles', 'list', `--project=${PROJECT}`, '--format=json']),
      ]);
      validateManagedServiceAccountInventory(
        serviceAccounts,
        this.contract.resources.serviceAccounts,
      );
      assertManagedIdentityInventory(roles, this.contract.resources.customRoles.map(({ id }) => id), (item) => {
        if (typeof item.name !== 'string'
          || (item.name.includes('hkbuddyV1') && !item.name.startsWith(`projects/${PROJECT}/roles/`))) {
          throw commandError('LIST_RESPONSE_AMBIGUOUS');
        }
        return item.name;
      }, /hkbuddyV1/i);
    }
    if (enabledApis.has('artifactregistry.googleapis.com')) {
      const repositories = await this.#gcloud([
        'artifacts', 'repositories', 'list', '--location=asia-east2', `--project=${PROJECT}`, '--format=json',
      ]);
      assertManagedIdentityInventory(repositories, [GCP_IDENTITY.repository], (item) => {
        if (typeof item.name !== 'string' || (item.name.includes('hkbuddy-v1')
          && !item.name.startsWith(`projects/${PROJECT}/locations/asia-east2/repositories/`))) {
          throw commandError('LIST_RESPONSE_AMBIGUOUS');
        }
        return item.name;
      });
    }
    if (enabledApis.has('sqladmin.googleapis.com')) {
      const instances = await this.#gcloud(['sql', 'instances', 'list', `--project=${PROJECT}`, '--format=json']);
      assertManagedIdentityInventory(instances, [GCP_IDENTITY.cloudSqlInstance], (item) => {
        if (typeof item.name !== 'string' || (item.name.includes('hkbuddy-v1')
          && item.project !== undefined && item.project !== PROJECT)) throw commandError('LIST_RESPONSE_AMBIGUOUS');
        return item.name;
      });
    }
    if (enabledApis.has('secretmanager.googleapis.com')) {
      const secrets = await this.#gcloud(['secrets', 'list', `--project=${PROJECT}`, '--format=json']);
      assertManagedIdentityInventory(secrets, this.contract.resources.secrets.map(({ id }) => id), (item) => {
        if (typeof item.name !== 'string' || (item.name.includes('hkbuddy-v1')
          && !item.name.startsWith(`projects/${PROJECT}/secrets/`))) throw commandError('LIST_RESPONSE_AMBIGUOUS');
        return item.name;
      });
    }
    if (enabledApis.has('storage.googleapis.com')) {
      const buckets = await this.#gcloud(['storage', 'buckets', 'list', `--project=${PROJECT}`, '--format=json']);
      assertManagedIdentityInventory(
        buckets, [GCP_IDENTITY.bucket, GCP_IDENTITY.buildSourceBucket], ({ name }) => name,
      );
    }
    if (enabledApis.has('compute.googleapis.com')) {
      const [networks, subnets, addresses] = await Promise.all([
        this.#gcloud(['compute', 'networks', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['compute', 'networks', 'subnets', 'list', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['compute', 'addresses', 'list', `--project=${PROJECT}`, '--format=json']),
      ]);
      assertManagedIdentityInventory(networks, [GCP_IDENTITY.network], ({ name }) => name);
      assertManagedIdentityInventory(subnets, [GCP_IDENTITY.subnet], ({ name }) => name);
      assertManagedIdentityInventory(addresses, [GCP_IDENTITY.psaRange], ({ name }) => name);
    }
    if (enabledApis.has('run.googleapis.com')) {
      const [services, jobs] = await Promise.all([
        this.#gcloud(['run', 'services', 'list', '--region=asia-east2', `--project=${PROJECT}`, '--format=json']),
        this.#gcloud(['run', 'jobs', 'list', '--region=asia-east2', `--project=${PROJECT}`, '--format=json']),
      ]);
      assertManagedIdentityInventory(
        services, [GCP_IDENTITY.service, GCP_IDENTITY.candidateService],
        (item) => item.metadata?.name ?? item.name,
      );
      assertManagedIdentityInventory(jobs, Object.values(GCP_IDENTITY.jobs), (item) => item.metadata?.name ?? item.name);
    }
    if (enabledApis.has('monitoring.googleapis.com')) {
      const [policies, channels] = await Promise.all([
        this.#listAll({ url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies?pageSize=1000`, itemKey: 'alertPolicies' }),
        this.#listAll({ url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/notificationChannels?pageSize=1000`, itemKey: 'notificationChannels' }),
      ]);
      assertMonitoringInventory(policies, channels);
    }
    if (enabledApis.has('billingbudgets.googleapis.com')) {
      const budgets = await this.#listAll({
        url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${BILLING_ACCOUNT}/budgets?pageSize=100`, itemKey: 'budgets',
      });
      assertBudgetInventory(budgets, this.#projectNumber());
    }
  }

  async #auditCloudAssetInventory() {
    let assets;
    try {
      assets = await this.#gcloud([
        'asset', 'search-all-resources', `--scope=projects/${PROJECT}`,
        `--billing-project=${GCP_IDENTITY.assetInventoryConsumerProjectId}`,
        `--project=${PROJECT}`, '--page-size=500', `--read-mask=${ASSET_READ_MASK}`,
        '--order-by=assetType,name', '--format=json',
      ], { maxBuffer: ASSET_MAX_BUFFER });
    } catch (error) {
      throw commandError('CLOUD_ASSET_INVENTORY_UNAVAILABLE');
    }
    return assertCloudAssetInventory(assets);
  }

  async #read(id, context) {
    if (id === 'project') {
      return { status: 'present', value: await this.#gcloud([
        'projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'billing') {
      const value = await this.#gcloud([
        'billing', 'projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json',
      ]);
      return value?.billingEnabled === true ? { status: 'present', value } : { status: 'absent' };
    }
    if (id === 'apis') {
      const value = await this.#gcloud([
        'services', 'list', '--enabled', `--project=${PROJECT}`, '--format=json',
      ]);
      const enabled = requireEnabledApiSet(value);
      return REQUIRED_APIS.every((api) => enabled.has(api))
        ? { status: 'present', value }
        : { status: 'absent' };
    }
    if (id === 'artifact-registry') {
      return { status: 'present', value: await this.#gcloud([
        'artifacts', 'repositories', 'describe', GCP_IDENTITY.repository, '--location=asia-east2',
        `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id.startsWith('service-account:')) {
      const account = this.contract.resources.serviceAccounts.find(({ id: name }) => name === id.slice('service-account:'.length));
      const value = await this.#gcloud([
        'iam', 'service-accounts', 'describe', account.email,
        `--project=${PROJECT}`, '--format=json',
      ]);
      validateServiceAccountIdentity(value, { email: account.email });
      return { status: 'present', value };
    }
    if (id.startsWith('custom-role:')) {
      const role = this.#customRole(id.slice('custom-role:'.length));
      return { status: 'present', value: await this.#gcloud([
        'iam', 'roles', 'describe', role.id, `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'vpc') {
      return { status: 'present', value: await this.#gcloud([
        'compute', 'networks', 'describe', GCP_IDENTITY.network,
        `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'subnet') {
      return { status: 'present', value: await this.#gcloud([
        'compute', 'networks', 'subnets', 'describe', GCP_IDENTITY.subnet,
        '--region=asia-east2', `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'psa-range') {
      return { status: 'present', value: await this.#gcloud([
        'compute', 'addresses', 'describe', GCP_IDENTITY.psaRange, '--global',
        `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'psa-connection') {
      const values = await this.#gcloud([
        'services', 'vpc-peerings', 'list', `--network=${GCP_IDENTITY.network}`,
        '--service=servicenetworking.googleapis.com', `--project=${PROJECT}`, '--format=json',
      ]);
      const listing = requireServiceNetworkingConnections(values, GCP_IDENTITY.network);
      return listing.length === 1 ? { status: 'present', value: listing[0] } : { status: 'absent' };
    }
    if (id === 'cloud-sql-instance') {
      const raw = await this.#gcloud([
        'sql', 'instances', 'describe', GCP_IDENTITY.cloudSqlInstance, `--project=${PROJECT}`, '--format=json',
      ]);
      const privateIp = raw?.ipAddresses?.find(({ type }) => type === 'PRIVATE')?.ipAddress;
      return { status: 'present', value: { ...raw, privateIp } };
    }
    if (id === 'database') {
      return { status: 'present', value: await this.#gcloud([
        'sql', 'databases', 'describe', GCP_IDENTITY.database, `--instance=${GCP_IDENTITY.cloudSqlInstance}`,
        `--project=${PROJECT}`, '--format=json',
      ]) };
    }
    if (id === 'bucket' || id === 'build-source-bucket') {
      const bucket = id === 'bucket' ? GCP_IDENTITY.bucket : GCP_IDENTITY.buildSourceBucket;
      const value = await this.#gcloud([
        'storage', 'buckets', 'describe', `gs://${bucket}`, `--project=${PROJECT}`, '--format=json',
      ]);
      if (String(value?.projectNumber ?? '') !== this.#projectNumber()) {
        throw commandError('BUCKET_ID_COLLISION');
      }
      return { status: 'present', value };
    }
    if (id.startsWith('secret-container:')) {
      const secretId = id.slice('secret-container:'.length);
      const value = await this.#gcloud([
        'secrets', 'describe', secretId, `--project=${PROJECT}`, '--format=json',
      ]);
      return { status: 'present', value };
    }
    if (id.startsWith('job:')) {
      const job = id.slice('job:'.length);
      if (!Object.values(GCP_IDENTITY.jobs).includes(job)) throw commandError('UNKNOWN_PROVISION_STEP');
      const value = await this.#gcloud([
        'run', 'jobs', 'describe', job, `--project=${PROJECT}`,
        `--region=${GCP_IDENTITY.region}`, '--format=json',
      ]);
      return { status: 'present', value };
    }
    if (id.startsWith('secret-version:')) return this.#readSecretVersion(id.slice('secret-version:'.length));
    if (id.startsWith('db-user:')) return this.#readDatabaseUser(id.slice('db-user:'.length));
    if (id.startsWith('iam:')) return this.#readIam(Number(id.slice(4)) - 1);
    if (id === 'notification-channel') {
      const channel = canonicalMonitoringChannelName(
        context.notificationChannel ?? this.notificationChannel,
      );
      if (!channel) return { status: 'absent' };
      const value = await this.#rest({ method: 'GET', url: `https://monitoring.googleapis.com/v3/${channel}` });
      return { status: 'present', value };
    }
    if (id.startsWith('monitoring-policy:')) return this.#readPolicy(id.slice('monitoring-policy:'.length));
    if (id === 'budget') return this.#readBudget();
    throw commandError('UNKNOWN_PROVISION_STEP');
  }

  async #create(id, context) {
    if (id === 'apis') return this.#gcloud([
      'services', 'enable', ...REQUIRED_APIS, `--project=${PROJECT}`, '--format=json',
    ]);
    if (id === 'artifact-registry') return this.#gcloud([
      'artifacts', 'repositories', 'create', GCP_IDENTITY.repository, '--repository-format=docker',
      '--mode=standard-repository',
      '--location=asia-east2', '--description=Hong Kong Buddy production containers',
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (id.startsWith('service-account:')) {
      const account = this.contract.resources.serviceAccounts.find(({ id: name }) => name === id.slice('service-account:'.length));
      return this.#gcloud([
        'iam', 'service-accounts', 'create', account.id, `--display-name=${account.displayName}`,
        `--project=${PROJECT}`, '--format=json',
      ]);
    }
    if (id.startsWith('custom-role:')) {
      const role = this.#customRole(id.slice('custom-role:'.length));
      return this.#gcloud([
        'iam', 'roles', 'create', role.id, `--project=${PROJECT}`,
        `--title=${role.title}`, `--description=${role.description}`,
        `--permissions=${role.includedPermissions.join(',')}`, `--stage=${role.stage}`,
        '--format=json',
      ]);
    }
    if (id === 'vpc') return this.#gcloud([
      'compute', 'networks', 'create', GCP_IDENTITY.network, '--subnet-mode=custom',
      '--bgp-routing-mode=regional', `--project=${PROJECT}`, '--format=json',
    ]);
    if (id === 'subnet') {
      await this.#assertCidrAvailable('10.24.0.0/26', 'subnet');
      return this.#gcloud([
        'compute', 'networks', 'subnets', 'create', GCP_IDENTITY.subnet,
        `--network=${GCP_IDENTITY.network}`, '--region=asia-east2', '--range=10.24.0.0/26',
        '--enable-private-ip-google-access', `--project=${PROJECT}`, '--format=json',
      ]);
    }
    if (id === 'psa-range') {
      await this.#assertCidrAvailable('10.25.0.0/16', 'psa');
      return this.#gcloud([
        'compute', 'addresses', 'create', GCP_IDENTITY.psaRange, '--global',
        '--purpose=VPC_PEERING', '--addresses=10.25.0.0', '--prefix-length=16',
        `--network=${GCP_IDENTITY.network}`,
        '--description=Private services access for Hong Kong Buddy Cloud SQL',
        `--project=${PROJECT}`, '--format=json',
      ]);
    }
    if (id === 'psa-connection') return this.#gcloud([
      'services', 'vpc-peerings', 'connect', `--network=${GCP_IDENTITY.network}`,
      `--ranges=${GCP_IDENTITY.psaRange}`, '--service=servicenetworking.googleapis.com',
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (id === 'cloud-sql-instance') {
      const operation = await this.#rest({
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
      });
      return this.#waitForSqlOperation(operation, 'v1');
    }
    if (id === 'database') return this.#gcloud([
      'sql', 'databases', 'create', GCP_IDENTITY.database, `--instance=${GCP_IDENTITY.cloudSqlInstance}`,
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (id === 'bucket' || id === 'build-source-bucket') {
      const definition = id === 'bucket'
        ? this.contract.resources.bucket : this.contract.resources.buildSourceBucket;
      return this.#rest({
      method: 'POST',
      url: `https://storage.googleapis.com/storage/v1/b?project=${PROJECT}&projection=full`,
      body: {
        name: definition.name, location: definition.location,
        iamConfiguration: {
          uniformBucketLevelAccess: { enabled: true }, publicAccessPrevention: 'enforced',
        },
        versioning: { enabled: false },
        softDeletePolicy: { retentionDurationSeconds: '0' },
        lifecycle: { rule: [{
          action: { type: 'Delete' }, condition: { age: definition.lifecycleDeleteAfterDays },
        }] },
      },
      });
    }
    if (id.startsWith('secret-container:')) {
      const secretId = id.slice('secret-container:'.length);
      return this.#rest({
        method: 'POST',
        url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?secretId=${secretId}`,
        body: { replication: { automatic: {} }, labels: { application: 'hong-kong-buddy', environment: 'production-v1' } },
      });
    }
    if (id.startsWith('secret-version:')) {
      const secretId = id.slice('secret-version:'.length);
      if (typeof context.sensitive?.value !== 'string' || !context.sensitive.value) {
        throw commandError('SECRET_INPUT_INVALID');
      }
      return this.#rest({
        method: 'POST',
        url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretId}:addVersion`,
        body: { payload: { data: Buffer.from(context.sensitive.value, 'utf8').toString('base64') } },
      });
    }
    if (id.startsWith('db-user:')) return this.#createDatabaseUser(id.slice('db-user:'.length), context);
    if (id.startsWith('iam:')) return this.#createIam(Number(id.slice(4)) - 1);
    if (id.startsWith('monitoring-policy:')) return this.#createPolicy(id.slice('monitoring-policy:'.length), context.notificationChannel);
    if (id === 'budget') return this.#createBudget(context.notificationChannel);
    throw commandError('UNKNOWN_PROVISION_STEP');
  }

  #compare(id, value, context) {
    if (!value || typeof value !== 'object') return false;
    if (id === 'project') {
      return value.projectId === PROJECT && isExactProjectParent(value.parent)
        && String(value.projectNumber ?? '') === PROJECT_NUMBER
        && value.lifecycleState === 'ACTIVE'
        && (value.displayName ?? value.name) === this.contract.project.displayName
        && exact(value.labels ?? {}, this.contract.project.labels);
    }
    if (id === 'billing') {
      return isExactProjectBillingLink(value);
    }
    if (id === 'apis') {
      const enabled = requireEnabledApiSet(value);
      return REQUIRED_APIS.every((api) => enabled.has(api));
    }
    if (id === 'artifact-registry') {
      return value.format === 'DOCKER'
        && value.name === `projects/${PROJECT}/locations/asia-east2/repositories/${GCP_IDENTITY.repository}`
        && value.mode === 'STANDARD_REPOSITORY'
        && (value.location ?? String(value.name).split('/locations/')[1]?.split('/')[0]) === 'asia-east2'
        && value.description === 'Hong Kong Buddy production containers';
    }
    if (id.startsWith('service-account:')) {
      const account = this.contract.resources.serviceAccounts.find(({ id: name }) => name === id.slice('service-account:'.length));
      return validateServiceAccountIdentity(value, {
        email: account.email, displayName: account.displayName,
      });
    }
    if (id.startsWith('custom-role:')) {
      const role = this.#customRole(id.slice('custom-role:'.length));
      return exact({
        name: value.name,
        title: value.title,
        description: value.description,
        includedPermissions: Array.isArray(value.includedPermissions)
          ? [...value.includedPermissions].sort()
          : value.includedPermissions,
        stage: value.stage,
        deleted: value.deleted ?? false,
      }, {
        name: role.name,
        title: role.title,
        description: role.description,
        includedPermissions: [...role.includedPermissions].sort(),
        stage: role.stage,
        deleted: false,
      });
    }
    if (id === 'vpc') return value.name === GCP_IDENTITY.network
      && value.selfLink === `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`
      && value.autoCreateSubnetworks === false && String(value.routingConfig?.routingMode ?? '').toUpperCase() === 'REGIONAL';
    if (id === 'subnet') return value.name === GCP_IDENTITY.subnet
      && value.selfLink === `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2/subnetworks/${GCP_IDENTITY.subnet}`
      && value.region === `https://www.googleapis.com/compute/v1/projects/${PROJECT}/regions/asia-east2`
      && value.ipCidrRange === '10.24.0.0/26'
      && value.privateIpGoogleAccess === true
      && value.network === `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
    if (id === 'psa-range') {
      const network = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`;
      validateComputeAddressInventory({
        addresses: [value], networks: [{ name: GCP_IDENTITY.network, selfLink: network }], subnets: [],
      });
      return value.name === GCP_IDENTITY.psaRange
        && value.selfLink === `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/addresses/${GCP_IDENTITY.psaRange}`
        && value.address === '10.25.0.0' && value.prefixLength === 16
        && value.addressType === 'INTERNAL' && value.ipVersion === 'IPV4'
        && value.networkTier === 'PREMIUM' && value.status === 'RESERVED'
        && value.purpose === 'VPC_PEERING' && !Object.hasOwn(value, 'region')
        && value.network === network;
    }
    if (id === 'psa-connection') {
      return value.service === SERVICE_NETWORKING_CONNECTION_SERVICE
        && value.network === serviceNetworkingNetworkName(GCP_IDENTITY.network)
        && value.peering === SERVICE_NETWORKING_PEERING
        && exact(value.reservedPeeringRanges, [GCP_IDENTITY.psaRange]);
    }
    if (id === 'cloud-sql-instance') return this.#compareCloudSql(value);
    if (id === 'database') return value.name === GCP_IDENTITY.database && value.instance === GCP_IDENTITY.cloudSqlInstance
      && value.project === PROJECT;
    if (id === 'bucket' || id === 'build-source-bucket') return this.#compareBucket(id, value);
    if (id.startsWith('secret-container:')) {
      const secretId = id.slice('secret-container:'.length);
      return value.name === `projects/${PROJECT}/secrets/${secretId}`
        && exact(value.replication, { automatic: {} })
        && exact(value.labels, { application: 'hong-kong-buddy', environment: 'production-v1' })
        && !Object.hasOwn(value, 'expireTime') && !Object.hasOwn(value, 'ttl')
        && !Object.hasOwn(value, 'rotation') && !Object.hasOwn(value, 'topics');
    }
    if (id.startsWith('secret-version:')) return this.#compareSecretVersion(id.slice('secret-version:'.length), value, context);
    if (id.startsWith('db-user:')) return this.#compareDatabaseUser(id.slice('db-user:'.length), value);
    if (id.startsWith('iam:')) return value.exact === true;
    if (id === 'notification-channel') {
      const channel = canonicalMonitoringChannelName(
        context.notificationChannel ?? this.notificationChannel,
      );
      return Boolean(channel) && value.name === channel
      && value.displayName === REQUIRED_MONITORING.notificationChannel.displayName
      && exact(value.userLabels, OWNERSHIP_LABELS)
      && exact(value.labels, {
        email_address: REQUIRED_MONITORING.notificationChannel.requiredEmailAddress,
      })
      && value.type === 'email' && value.enabled === true
      && value.verificationStatus === 'VERIFIED';
    }
    if (id.startsWith('monitoring-policy:')) return value.exact === true;
    if (id === 'budget') return value.exact === true;
    return false;
  }

  #compareCloudSql(value) {
    const settings = value.settings ?? {};
    const backup = settings.backupConfiguration ?? {};
    const retention = backup.backupRetentionSettings ?? {};
    const ip = settings.ipConfiguration ?? {};
    const onlyPrivate = Array.isArray(value.ipAddresses)
      && value.ipAddresses.length > 0
      && value.ipAddresses.every(({ type }) => type === 'PRIVATE');
    return value.name === GCP_IDENTITY.cloudSqlInstance && value.project === PROJECT
      && value.region === 'asia-east2' && value.databaseVersion === 'POSTGRES_16'
      && value.state === 'RUNNABLE' && settings.availabilityType === 'REGIONAL'
      && settings.tier === 'db-custom-1-3840' && settings.dataDiskType === 'PD_SSD'
      && Number(settings.dataDiskSizeGb) === 20 && settings.storageAutoResize === true
      && ip.ipv4Enabled === false
      && ip.privateNetwork === `projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`
      && ip.allocatedIpRange === GCP_IDENTITY.psaRange
      && ip.sslMode === 'ENCRYPTED_ONLY' && onlyPrivate && Boolean(value.privateIp)
      && backup.enabled === true && backup.startTime === '18:00'
      && backup.pointInTimeRecoveryEnabled === true
      && Number(backup.transactionLogRetentionDays) === 7
      && Number(retention.retainedBackups) === 7 && retention.retentionUnit === 'COUNT'
      && settings.deletionProtectionEnabled === true
      && settings.retainBackupsOnDelete === true
      && settings.finalBackupConfig?.enabled === true
      && Number(settings.finalBackupConfig?.retentionDays) === 30;
  }

  #compareBucket(id, value) {
    const definition = id === 'bucket'
      ? this.contract.resources.bucket : this.contract.resources.buildSourceBucket;
    const rules = value.lifecycle?.rule ?? [];
    const policy = value.iamConfiguration ?? {};
    return value.name === definition.name
      && String(value.projectNumber ?? '') === this.#projectNumber()
      && value.location === 'ASIA-EAST2'
      && policy.uniformBucketLevelAccess?.enabled === true
      && policy.publicAccessPrevention === 'enforced'
      && value.versioning?.enabled !== true
      && Number(value.softDeletePolicy?.retentionDurationSeconds ?? 0) === 0
      && (value.retentionPolicy === undefined || value.retentionPolicy === null)
      && exact(rules, [{
        action: { type: 'Delete' }, condition: { age: definition.lifecycleDeleteAfterDays },
      }]);
  }

  async #readSecretVersion(secretId) {
    const listedVersions = await this.#listAll({
      url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretId}/versions?pageSize=100&filter=state%3AENABLED`,
      itemKey: 'versions',
    });
    const versions = listedVersions.filter(({ name, state }) => (
      state === 'ENABLED' && NUMERIC_VERSION.test(String(name ?? '').split('/').at(-1))
    ));
    if (versions.length === 0) return { status: 'absent' };
    if (versions.length !== 1) return { status: 'present', value: { exact: false } };
    const version = versions[0].name.split('/').at(-1);
    const access = await this.#rest({
      method: 'GET',
      url: `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretId}/versions/${version}:access`,
    });
    let secretValue;
    try { secretValue = Buffer.from(access.payload.data, 'base64').toString('utf8'); } catch {
      return { status: 'present', value: { exact: false } };
    }
    return { status: 'present', value: { version, secretValue, exact: true } };
  }

  #compareSecretVersion(secretId, value, context) {
    if (!NUMERIC_VERSION.test(String(value.version ?? '')) || typeof value.secretValue !== 'string') return false;
    if (secretId === GCP_IDENTITY.secrets.session) return isCanonicalSecret(value.secretValue);
    if (secretId === GCP_IDENTITY.secrets.dbAppUrl || secretId === GCP_IDENTITY.secrets.dbMigratorUrl) {
      const user = secretId === GCP_IDENTITY.secrets.dbAppUrl ? 'hkbuddy_app' : 'hkbuddy_migrator';
      let parsed;
      try { parsed = new URL(value.secretValue); } catch { return false; }
      let password;
      try { password = decodeURIComponent(parsed.password); } catch { return false; }
      return parsed.protocol === 'postgresql:' && decodeURIComponent(parsed.username) === user
        && isCanonicalSecret(password) && parsed.hostname === this.#privateIp()
        && parsed.port === '5432' && parsed.pathname === '/hkbuddy_v1'
        && parsed.search === '?sslmode=require' && !parsed.hash;
    }
    if (secretId === GCP_IDENTITY.secrets.bootstrap) {
      let receipt;
      try { receipt = JSON.parse(value.secretValue); } catch { return false; }
      return exact(receipt, {
        schemaVersion: 1, projectId: PROJECT, instance: GCP_IDENTITY.cloudSqlInstance, database: GCP_IDENTITY.database,
        appUser: 'hkbuddy_app', appSecretVersion: context.secretVersions?.[GCP_IDENTITY.secrets.dbAppUrl],
        migratorUser: 'hkbuddy_migrator', migratorSecretVersion: context.secretVersions?.[GCP_IDENTITY.secrets.dbMigratorUrl],
        appDatabaseRoles: ['pg_read_all_data', 'pg_write_all_data'],
        migratorDatabaseRoles: ['cloudsqlsuperuser'],
      });
    }
    return false;
  }

  async #readDatabaseUser(user) {
    const listing = await this.#rest({
      method: 'GET',
      url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/users`,
    });
    if (!listing || typeof listing !== 'object' || Array.isArray(listing)) {
      throw commandError('LIST_RESPONSE_AMBIGUOUS');
    }
    const users = Object.hasOwn(listing, 'items') ? requireObjectList(listing.items) : [];
    const matches = users.filter(({ name }) => name === user);
    if (matches.length === 0) return { status: 'absent' };
    if (matches.length !== 1) return { status: 'present', value: { exact: false } };
    if (!this.createdUsers.has(user)) {
      const marker = await this.#readSecretVersion(GCP_IDENTITY.secrets.bootstrap);
      if (marker.status !== 'present') return { status: 'unknown', code: 'DB_USER_BINDING_AMBIGUOUS' };
      this.cache.set(`secret-version:${GCP_IDENTITY.secrets.bootstrap}`, marker.value);
    }
    return { status: 'present', value: matches[0] };
  }

  #compareDatabaseUser(user, value) {
    const definition = this.contract.resources.cloudSql.users.find(({ name }) => name === user);
    return value.name === user && value.type === 'BUILT_IN'
      && exact([...(value.databaseRoles ?? [])].sort(), [...definition.databaseRoles].sort())
      && !value.databaseRoles.includes('roles/cloudsql.admin')
      && (user !== 'hkbuddy_app' || !value.databaseRoles.includes('cloudsqlsuperuser'));
  }

  async #createDatabaseUser(user, context) {
    const definition = this.contract.resources.cloudSql.users.find(({ name }) => name === user);
    let parsed;
    try { parsed = new URL(context.sensitive?.databaseUrl); } catch { throw commandError('DB_USER_SECRET_INVALID'); }
    let password;
    try { password = decodeURIComponent(parsed.password); } catch { throw commandError('DB_USER_SECRET_INVALID'); }
    if (decodeURIComponent(parsed.username) !== user || !isCanonicalSecret(password)) {
      throw commandError('DB_USER_SECRET_INVALID');
    }
    const result = await this.#rest({
      method: 'POST',
      url: `https://sqladmin.googleapis.com/sql/v1beta4/projects/${PROJECT}/instances/${GCP_IDENTITY.cloudSqlInstance}/users`,
      body: {
        name: user, host: '', type: 'BUILT_IN', password,
        databaseRoles: [...definition.databaseRoles],
      },
    });
    return this.#waitForSqlOperation(result);
  }

  async #waitForSqlOperation(operation, apiVersion = 'v1beta4') {
    if (!['v1', 'v1beta4'].includes(apiVersion)) throw commandError('SQL_OPERATION_AMBIGUOUS');
    const name = operation?.name;
    if (!name) throw commandError('SQL_OPERATION_AMBIGUOUS');
    for (let attempt = 0; attempt < 600; attempt += 1) {
      const current = attempt === 0 && operation.status === 'DONE'
        ? operation
        : await this.#rest({
          method: 'GET',
          url: `https://sqladmin.googleapis.com/sql/${apiVersion}/projects/${PROJECT}/operations/${name}`,
        });
      if (current?.status === 'DONE') {
        if (current.error?.errors?.length) throw commandError('SQL_OPERATION_FAILED');
        return current;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 2_000));
    }
    throw commandError('SQL_OPERATION_TIMEOUT');
  }

  async #readIam(index) {
    const binding = this.#binding(index);
    const policy = await this.#iamPolicy(binding.scope);
    const matched = (policy?.bindings ?? []).some(({ role, members, condition }) => (
      role === binding.role && members?.includes(binding.member) && !condition
    ));
    return matched ? { status: 'present', value: { exact: true } } : { status: 'absent' };
  }

  async #iamPolicy(scope) {
    if (scope === 'project') return this.#gcloud([
      'projects', 'get-iam-policy', PROJECT, `--project=${PROJECT}`, '--format=json',
    ]);
    if (scope.startsWith('bucket:')) return this.#gcloud([
      'storage', 'buckets', 'get-iam-policy', `gs://${scope.slice('bucket:'.length)}`,
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (scope.startsWith('repository:')) return this.#gcloud([
      'artifacts', 'repositories', 'get-iam-policy', scope.slice('repository:'.length),
      '--location=asia-east2', `--project=${PROJECT}`, '--format=json',
    ]);
    if (scope.startsWith('secret:')) return this.#gcloud([
      'secrets', 'get-iam-policy', scope.slice('secret:'.length),
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (scope.startsWith('service-account:')) {
      const account = this.contract.resources.serviceAccounts.find(({ id }) => id === scope.slice('service-account:'.length));
      return this.#gcloud([
        'iam', 'service-accounts', 'get-iam-policy', account.email,
        `--project=${PROJECT}`, '--format=json',
      ]);
    }
    throw commandError('IAM_SCOPE_INVALID');
  }

  async #createIam(index) {
    const binding = this.#binding(index);
    if (binding.scope === 'project') return this.#gcloud([
      'projects', 'add-iam-policy-binding', PROJECT, `--member=${binding.member}`,
      `--role=${binding.role}`, '--condition=None', `--project=${PROJECT}`, '--format=json',
    ]);
    if (binding.scope.startsWith('bucket:')) return this.#gcloud([
      'storage', 'buckets', 'add-iam-policy-binding', `gs://${binding.scope.slice('bucket:'.length)}`,
      `--member=${binding.member}`, `--role=${binding.role}`, `--project=${PROJECT}`, '--format=json',
    ]);
    if (binding.scope.startsWith('repository:')) return this.#gcloud([
      'artifacts', 'repositories', 'add-iam-policy-binding', binding.scope.slice('repository:'.length),
      '--location=asia-east2', `--member=${binding.member}`, `--role=${binding.role}`,
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (binding.scope.startsWith('secret:')) return this.#gcloud([
      'secrets', 'add-iam-policy-binding', binding.scope.slice('secret:'.length),
      `--member=${binding.member}`, `--role=${binding.role}`, '--condition=None',
      `--project=${PROJECT}`, '--format=json',
    ]);
    if (binding.scope.startsWith('service-account:')) {
      const account = this.contract.resources.serviceAccounts.find(({ id }) => id === binding.scope.slice('service-account:'.length));
      return this.#gcloud([
        'iam', 'service-accounts', 'add-iam-policy-binding', account.email,
        `--member=${binding.member}`, `--role=${binding.role}`, '--condition=None',
        `--project=${PROJECT}`, '--format=json',
      ]);
    }
    throw commandError('IAM_SCOPE_INVALID');
  }

  async #readPolicy(policyId) {
    const policies = await this.#listAll({
      url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies?pageSize=1000`,
      itemKey: 'alertPolicies',
    });
    const definition = this.#policyDefinition(policyId);
    if (!definition) throw commandError('MONITORING_POLICY_UNSUPPORTED');
    const marker = policyId.replaceAll('-', '_');
    const matches = policies.filter(({ displayName, userLabels }) => (
      userLabels?.hkbuddy_contract === marker || displayName === definition.displayName
    ));
    if (matches.length === 0) return { status: 'absent' };
    if (matches.length !== 1) return { status: 'present', value: { exact: false } };
    return { status: 'present', value: { exact: this.#policyMatches(policyId, matches[0]) } };
  }

  #policyDefinition(policyId) {
    return this.contract.resources.monitoring.policies.find(({ id }) => id === policyId);
  }

  #metricFilter(policy) {
    const run = policy.metricType.startsWith('run.googleapis.com/');
    return run
      ? `resource.type=\"cloud_run_revision\" AND resource.label.service_name=\"${GCP_IDENTITY.service}\" AND resource.label.location=\"asia-east2\" AND metric.type=\"${policy.metricType}\"`
      : `resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${PROJECT}:${GCP_IDENTITY.cloudSqlInstance}\" AND metric.type=\"${policy.metricType}\"`;
  }

  #policyBody(policyId, channel) {
    const policy = this.#policyDefinition(policyId);
    const canonicalChannel = canonicalMonitoringChannelName(channel);
    if (!canonicalChannel) throw commandError('MONITORING_CHANNEL_INVALID');
    const common = {
      displayName: policy.displayName,
      combiner: 'OR', enabled: true, notificationChannels: [canonicalChannel],
      userLabels: { application: 'hong_kong_buddy', environment: 'production_v1', hkbuddy_contract: policy.id.replaceAll('-', '_') },
    };
    if (policy.kind === 'log-match') {
      return {
        ...common,
        conditions: [{ displayName: policy.displayName, conditionMatchedLog: { filter: policy.filter } }],
        alertStrategy: { notificationRateLimit: { period: '300s' }, autoClose: '604800s' },
      };
    }
    const aggregation = {
      alignmentPeriod: '60s',
      perSeriesAligner: policy.kind === 'metric-percentile' ? 'ALIGN_PERCENTILE_95' : 'ALIGN_MEAN',
      crossSeriesReducer: 'REDUCE_MAX',
      groupByFields: [monitoringGroupByField(policy.metricType)],
    };
    let conditionThreshold = {
      filter: this.#metricFilter(policy), comparison: 'COMPARISON_GT',
      thresholdValue: policy.id === 'run-instance-cap' ? 0.999 : policy.threshold,
      duration: `${policy.durationSeconds}s`, aggregations: [aggregation], trigger: { count: 1 },
    };
    if (policy.kind === 'metric-ratio') {
      const baseFilter = this.#metricFilter(policy);
      conditionThreshold = {
        ...conditionThreshold,
        filter: `${baseFilter} AND metric.label.response_code_class=\"5xx\"`,
        denominatorFilter: baseFilter,
        aggregations: [{ ...aggregation, perSeriesAligner: 'ALIGN_RATE', crossSeriesReducer: 'REDUCE_SUM' }],
        denominatorAggregations: [{ ...aggregation, perSeriesAligner: 'ALIGN_RATE', crossSeriesReducer: 'REDUCE_SUM' }],
      };
    }
    return {
      ...common,
      conditions: [{ displayName: policy.displayName, conditionThreshold }],
      alertStrategy: { autoClose: '604800s' },
    };
  }

  #policyMatches(policyId, actual) {
    if (!new RegExp(`^projects/${PROJECT}/alertPolicies/[1-9]\\d*$`).test(actual?.name ?? '')) return false;
    const expected = this.#policyBody(policyId, this.notificationChannel);
    const projected = {
      displayName: actual.displayName, combiner: actual.combiner, enabled: actual.enabled,
      notificationChannels: actual.notificationChannels, userLabels: actual.userLabels,
      conditions: (actual.conditions ?? []).map(({ name: ignored, ...condition }) => { void ignored; return condition; }),
      alertStrategy: actual.alertStrategy,
    };
    return exact(projected, expected);
  }

  async #createPolicy(policyId, channel) {
    const policy = this.#policyDefinition(policyId);
    if (!policy) throw commandError('MONITORING_POLICY_UNSUPPORTED');
    if (policy.metricType) {
      let descriptor;
      try {
        const metricDescriptorPath = policy.metricType.split('/').map(encodeURIComponent).join('/');
        descriptor = await this.#rest({
          method: 'GET',
          url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/metricDescriptors/${metricDescriptorPath}`,
        });
      } catch {
        throw commandError('MONITORING_METRIC_DESCRIPTOR_UNVERIFIED');
      }
      if (descriptor?.type !== policy.metricType) {
        throw commandError('MONITORING_METRIC_DESCRIPTOR_UNVERIFIED');
      }
    } else if (policy.kind === 'log-match') {
      try {
        const validated = await this.#rest({
          method: 'POST', url: 'https://logging.googleapis.com/v2/entries:list',
          body: {
            resourceNames: [`projects/${PROJECT}`], filter: policy.filter,
            pageSize: 1, orderBy: 'timestamp desc',
          },
        });
        if (!validated || typeof validated !== 'object' || Array.isArray(validated)) {
          throw new Error('invalid validation response');
        }
      } catch {
        throw commandError('MONITORING_LOG_FILTER_UNVERIFIED');
      }
    }
    return this.#rest({
      method: 'POST', url: `https://monitoring.googleapis.com/v3/projects/${PROJECT}/alertPolicies`,
      body: this.#policyBody(policyId, channel),
    });
  }

  async #readBudget() {
    const budgets = await this.#listAll({
      url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${BILLING_ACCOUNT}/budgets?pageSize=100`,
      itemKey: 'budgets',
    });
    const matches = budgets.filter(({ displayName }) => (
      displayName === 'Hong Kong Buddy Production V1 monthly guard'
    ));
    if (matches.length === 0) return { status: 'absent' };
    if (matches.length !== 1) return { status: 'present', value: { exact: false } };
    return { status: 'present', value: { exact: this.#budgetMatches(matches[0]) } };
  }

  #budgetBody(channel) {
    const canonicalChannel = canonicalMonitoringChannelName(channel);
    if (!canonicalChannel) throw commandError('MONITORING_CHANNEL_INVALID');
    return {
      displayName: 'Hong Kong Buddy Production V1 monthly guard',
      budgetFilter: {
        projects: [`projects/${this.#projectNumber()}`], calendarPeriod: 'MONTH',
        creditTypesTreatment: 'INCLUDE_ALL_CREDITS',
      },
      amount: { specifiedAmount: { currencyCode: 'HKD', units: '2300' } },
      thresholdRules: [
        { thresholdPercent: 0.5, spendBasis: 'CURRENT_SPEND' },
        { thresholdPercent: 0.8, spendBasis: 'CURRENT_SPEND' },
        { thresholdPercent: 1, spendBasis: 'CURRENT_SPEND' },
        { thresholdPercent: 1, spendBasis: 'FORECASTED_SPEND' },
      ],
      notificationsRule: {
        monitoringNotificationChannels: [canonicalChannel], disableDefaultIamRecipients: false,
      },
    };
  }

  #budgetMatches(actual) {
    if (!new RegExp(`^billingAccounts/${BILLING_ACCOUNT}/budgets/[A-Za-z0-9_-]+$`).test(actual?.name ?? '')) return false;
    const expected = this.#budgetBody(this.notificationChannel);
    const notification = actual.notificationsRule ?? {};
    const projected = {
      displayName: actual.displayName, budgetFilter: actual.budgetFilter,
      amount: actual.amount, thresholdRules: actual.thresholdRules,
      notificationsRule: {
        monitoringNotificationChannels: notification.monitoringNotificationChannels,
        disableDefaultIamRecipients: notification.disableDefaultIamRecipients ?? false,
      },
    };
    return exact(projected, expected);
  }

  async #createBudget(channel) {
    return this.#rest({
      method: 'POST',
      url: `https://billingbudgets.googleapis.com/v1/billingAccounts/${BILLING_ACCOUNT}/budgets`,
      body: this.#budgetBody(channel),
    });
  }

  async #assertCidrAvailable(desired, kind) {
    const [networks, subnets, routes, addresses] = await Promise.all([
      this.#gcloud(['compute', 'networks', 'list', `--project=${PROJECT}`, '--format=json']),
      this.#gcloud(['compute', 'networks', 'subnets', 'list', `--project=${PROJECT}`, '--format=json']),
      this.#gcloud(['compute', 'routes', 'list', `--project=${PROJECT}`, '--format=json']),
      this.#gcloud(['compute', 'addresses', 'list', `--project=${PROJECT}`, '--format=json']),
    ]);
    assertCidrAvailable({
      desired,
      kind,
      network: `https://www.googleapis.com/compute/v1/projects/${PROJECT}/global/networks/${GCP_IDENTITY.network}`,
      networks: requireObjectList(networks), subnets: requireObjectList(subnets), routes: requireObjectList(routes),
      addresses: requireObjectList(addresses),
    });
  }

  async finalReadback({ notificationChannel, secretVersions }) {
    const canonicalChannel = canonicalMonitoringChannelName(notificationChannel);
    if (!canonicalChannel
      || !GENERATED_SECRET_IDS.every((id) => NUMERIC_VERSION.test(String(secretVersions[id] ?? '')))) {
      throw commandError('FINAL_READBACK_FAILED');
    }
    await this.auditUserManagedServiceAccountKeys();

    for (const id of STATIC_EXPECTED_STEPS) {
      const value = await this.read(id, { notificationChannel: canonicalChannel, secretVersions });
      if (value?.status !== 'present' || !this.compare(id, value.value, {
        notificationChannel: canonicalChannel, secretVersions,
      })) {
        throw commandError('FINAL_READBACK_FAILED');
      }
    }

    const scopes = managedIamScopes(this.contract);
    const enabledBefore = await this.#enabledApis();
    await this.#auditCustomRoles();
    const policyEntries = await Promise.all(scopes.map(async (scope) => (
      [scope, await this.#iamPolicy(scope)]
    )));
    const enabledAfter = await this.#enabledApis();
    if (!sameStringSet(enabledBefore, enabledAfter)) throw commandError('IAM_ALLOWLIST_MISMATCH');
    const policiesByScope = new Map(policyEntries);
    const bucketPolicy = policiesByScope.get(`bucket:${GCP_IDENTITY.bucket}`);
    const publicMember = (bucketPolicy?.bindings ?? []).some(({ members }) => (
      members?.some((member) => ['allUsers', 'allAuthenticatedUsers'].includes(member))
    ));
    if (publicMember) throw commandError('PUBLIC_BUCKET_BINDING');

    assertExactManagedIamPolicies({
      contract: this.contract, projectNumber: this.#projectNumber(), policiesByScope,
      enabledApis: enabledAfter,
    });
  }
}

function ipv4Number(value) {
  const parts = String(value).split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => (total * 256) + Number(part), 0) >>> 0;
}

function cidrBounds(value) {
  const [address, prefixText] = String(value).split('/');
  const ip = ipv4Number(address);
  const prefix = Number(prefixText);
  if (ip === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  const size = 2 ** (32 - prefix);
  const start = Math.floor(ip / size) * size;
  return [start, start + size - 1];
}

function cidrOverlap(left, right) {
  const a = cidrBounds(left);
  const b = cidrBounds(right);
  if (!a || !b) return true;
  return a[0] <= b[1] && b[0] <= a[1];
}

function cidrContainedBy(inner, outer) {
  const candidate = cidrBounds(inner);
  const container = cidrBounds(outer);
  if (!candidate || !container) return true;
  return candidate[0] >= container[0] && candidate[1] <= container[1];
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const result = await runGcpProvision();
  process.exitCode = result.exitCode;
}
