import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertResourceContract,
  createDefaultGcloudAuthenticatedRequest,
  createDefaultGcloudExecutor,
  GcpControlPlane,
  isExactBillingAccountResource,
  isExactOrganizationResource,
  isExactProjectBillingLink,
  isExactProjectParent,
  loadResourceContract,
  REQUIRED_OPERATOR_ACCOUNT,
} from './gcp-provision.js';
import { GCP_IDENTITY } from '../src/gcp-identity.js';

const PROJECT = GCP_IDENTITY.projectId;
const PROJECT_NUMBER = GCP_IDENTITY.projectNumber;
const ORGANIZATION = GCP_IDENTITY.organizationId;
const BILLING_ACCOUNT = GCP_IDENTITY.billingAccountId;
const CHANNEL_NAME = /^projects\/582852715831\/notificationChannels\/[1-9]\d*$/;

function publish(writeOutput, exitCode, publicReport) {
  writeOutput(`${JSON.stringify(publicReport)}\n`);
  return { exitCode, publicReport };
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.some((value) => typeof value !== 'string')) return null;
  if (argv.length === 0) return { notificationChannel: null };
  if (argv.length !== 1 || !argv[0].startsWith('--notification-channel=')) return null;
  const notificationChannel = argv[0].slice('--notification-channel='.length);
  return CHANNEL_NAME.test(notificationChannel) ? { notificationChannel } : null;
}

function projectMatches(project) {
  return project?.projectId === PROJECT && isExactProjectParent(project?.parent)
    && String(project?.projectNumber ?? '') === PROJECT_NUMBER
    && project?.name === 'Motion Expert HK LTD Webpage'
    && project?.lifecycleState === 'ACTIVE'
    && JSON.stringify(project?.labels ?? {}) === '{}';
}

function safeFailure(code, details = {}) {
  return {
    status: 'failed', code, projectId: PROJECT, mutationPerformed: false,
    ...details,
  };
}

export async function runGcpPreflight({
  argv = process.argv.slice(2),
  contract,
  gcloud,
  request,
  getRestPrincipal,
  environment = process.env,
  writeOutput = (line) => process.stdout.write(line),
} = {}) {
  let selectedContract;
  try { selectedContract = assertResourceContract(contract ?? await loadResourceContract()); } catch {
    return publish(writeOutput, 2, safeFailure('RESOURCE_CONTRACT_INVALID'));
  }
  const selection = parseArguments(argv);
  if (!selection) return publish(writeOutput, 2, safeFailure('PREFLIGHT_ARGUMENTS_INVALID'));

  let runCommand;
  let authenticatedRequest = request;
  try {
    runCommand = gcloud ?? createDefaultGcloudExecutor({ environment });
  } catch {
    return publish(writeOutput, 1, safeFailure('CONTROL_PLANE_UNAVAILABLE'));
  }

  let activeAccounts;
  try {
    activeAccounts = await runCommand([
      'auth', 'list', '--filter=status:ACTIVE', `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    return publish(writeOutput, 1, safeFailure('GCP_AUTH_UNKNOWN'));
  }
  if (!Array.isArray(activeAccounts) || activeAccounts.length !== 1
    || activeAccounts[0]?.status !== 'ACTIVE' || typeof activeAccounts[0]?.account !== 'string') {
    return publish(writeOutput, 1, safeFailure('GCP_AUTH_INVALID'));
  }
  if (activeAccounts[0].account !== REQUIRED_OPERATOR_ACCOUNT) {
    return publish(writeOutput, 1, safeFailure('GCP_AUTH_INVALID'));
  }

  let restPrincipal;
  try {
    authenticatedRequest ??= createDefaultGcloudAuthenticatedRequest({
      environment, account: activeAccounts[0].account,
    });
    const identify = getRestPrincipal ?? authenticatedRequest.getPrincipal;
    if (typeof identify !== 'function') throw new Error('REST identity unavailable');
    restPrincipal = await identify();
  } catch {
    return publish(writeOutput, 1, safeFailure('CONTROL_PLANE_IDENTITY_UNKNOWN'));
  }
  if (restPrincipal !== activeAccounts[0].account) {
    return publish(writeOutput, 1, safeFailure('CONTROL_PLANE_IDENTITY_MISMATCH'));
  }

  let organization;
  try {
    organization = await runCommand([
      'organizations', 'describe', ORGANIZATION, `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    return publish(writeOutput, 1, safeFailure('ORGANIZATION_STATE_UNKNOWN'));
  }
  if (!isExactOrganizationResource(organization)) {
    return publish(writeOutput, 1, safeFailure('ORGANIZATION_DRIFT'));
  }

  let billing;
  try {
    billing = await runCommand([
      'billing', 'accounts', 'describe', BILLING_ACCOUNT,
      `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    return publish(writeOutput, 1, safeFailure('BILLING_STATE_UNKNOWN'));
  }
  if (!isExactBillingAccountResource(billing)) {
    const inactive = billing?.name !== `billingAccounts/${BILLING_ACCOUNT}`
      || billing?.open !== true;
    return publish(writeOutput, 1, safeFailure(
      inactive ? 'BILLING_ACCOUNT_INACTIVE' : 'BUDGET_CURRENCY_MISMATCH',
    ));
  }
  if (billing.currencyCode !== selectedContract.resources.budget.currency) {
    return publish(writeOutput, 1, safeFailure('BUDGET_CURRENCY_MISMATCH'));
  }

  let projectState = 'present';
  let project;
  try {
    project = await runCommand([
      'projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json',
    ]);
  } catch (error) {
    if (error?.code === 'NOT_FOUND') projectState = 'absent';
    else if (error?.code === 'FORBIDDEN') projectState = 'unresolved';
    else return publish(writeOutput, 1, safeFailure('PROJECT_STATE_UNKNOWN'));
  }
  if (projectState !== 'present' || !projectMatches(project)) {
    return publish(writeOutput, 1, safeFailure('SHARED_PROJECT_BASELINE_INVALID', { projectState }));
  }

  let billingLink;
  try {
    billingLink = await runCommand([
      'billing', 'projects', 'describe', PROJECT, `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    return publish(writeOutput, 1, safeFailure('SHARED_PROJECT_BASELINE_INVALID', { projectState }));
  }
  if (!isExactProjectBillingLink(billingLink)) {
    return publish(writeOutput, 1, safeFailure('SHARED_PROJECT_BASELINE_INVALID', { projectState }));
  }

  let projectPolicy;
  try {
    projectPolicy = await runCommand([
      'projects', 'get-iam-policy', PROJECT, `--project=${PROJECT}`, '--format=json',
    ]);
  } catch {
    return publish(writeOutput, 1, safeFailure('SHARED_PROJECT_BASELINE_INVALID', { projectState }));
  }
  const protectedBindings = selectedContract.project.protectedBindings;
  const currentBindings = Array.isArray(projectPolicy?.bindings) ? projectPolicy.bindings : [];
  if (!protectedBindings.every(({ member, role }) => currentBindings.some((binding) => (
    binding?.role === role && Array.isArray(binding.members) && binding.members.includes(member)
  )))) return publish(writeOutput, 1, safeFailure('SHARED_PROJECT_BASELINE_INVALID', { projectState }));

  try {
    const auditPlane = new GcpControlPlane({
      contract: selectedContract, notificationChannel: selection.notificationChannel,
      gcloud: runCommand, request: authenticatedRequest,
    });
    await auditPlane.auditPreMutationState({ notificationChannel: selection.notificationChannel });
  } catch (error) {
    const code = [
      'IAM_ALLOWLIST_MISMATCH', 'CIDR_OVERLAP', 'RESOURCE_COLLISION',
      'SHARED_PROJECT_BASELINE_INVALID', 'ALERT_CHANNEL_REQUIRED',
    ].includes(error?.code) ? error.code : 'PREFLIGHT_INVENTORY_INVALID';
    return publish(writeOutput, 1, safeFailure(code, { projectState }));
  }

  // This is the single inventory gate shared with the mutating provisioner.
  // Disabled service APIs are explicitly deferred to the API-only first stage.
  let alertChannel = 'not-supplied';
  if (selection.notificationChannel) {
    {
      let channel;
      try {
        channel = await authenticatedRequest({
          method: 'GET',
          url: `https://monitoring.googleapis.com/v3/${selection.notificationChannel}`,
        });
      } catch {
        return publish(writeOutput, 1, safeFailure('ALERT_CHANNEL_UNVERIFIED', {
          projectState, readyForProjectCreation: false,
        }));
      }
      if (channel?.name !== selection.notificationChannel
        || channel?.displayName !== selectedContract.resources.monitoring.notificationChannel.displayName
        || !channel?.userLabels
        || Object.keys(channel.userLabels).length !== Object.keys(
          selectedContract.resources.monitoring.notificationChannel.ownershipLabels,
        ).length
        || !Object.entries(selectedContract.resources.monitoring.notificationChannel.ownershipLabels)
          .every(([key, value]) => channel.userLabels[key] === value)
        || channel?.type !== 'email' || channel?.enabled !== true
        || channel?.verificationStatus !== 'VERIFIED') {
        return publish(writeOutput, 1, safeFailure('ALERT_CHANNEL_UNVERIFIED', {
          projectState, readyForProjectCreation: false,
        }));
      }
      alertChannel = 'verified';
    }
  }

  return publish(writeOutput, 0, {
    status: 'dry-run', code: 'GCP_PREFLIGHT_COMPLETE', projectId: PROJECT,
    projectNumber: PROJECT_NUMBER, projectState,
    alertChannel, mutationPerformed: false,
  });
}

const isMain = process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  const result = await runGcpPreflight();
  process.exitCode = result.exitCode;
}
