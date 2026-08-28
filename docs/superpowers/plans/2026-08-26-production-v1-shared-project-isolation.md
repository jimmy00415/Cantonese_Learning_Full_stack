# Production V1 Shared-Project Isolation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the completed Hong Kong Buddy Production V1 release contract to an isolated `hkbuddy-v1-*` resource island inside the already billed `motion-expert-hk-ltd-webpage` project, then deploy and promote only after the existing production acceptance gates pass.

**Architecture:** A single immutable identity module and the executable JSON resource contract define the selected host project and every managed resource. Provisioning treats the host project, its billing link, default VPC, baseline IAM, and unrelated resources as protected read-only state while retaining create-or-exact-readback behavior for the dedicated resource island. Runtime, provider, build, release, evidence, and acceptance code consume the same identities and remain fail-closed.

**Tech Stack:** Node.js 22 ESM, `node:test`, Google Cloud SDK 553, Cloud Run Gen2, Cloud SQL PostgreSQL 16, Artifact Registry, Cloud Storage, Secret Manager, Direct VPC egress, Vertex AI, Speech-to-Text V2, Text-to-Speech, Cloud Monitoring, Cloud Build.

**Spec:** `docs/superpowers/specs/2026-08-26-production-v1-shared-project-isolation-design.md`

## Global Constraints

- Work only in `.worktrees/production-v1-ai-senior` on `feat/production-v1-ai-senior`; legacy application files and cloud resources are immutable.
- Host project is exactly `motion-expert-hk-ltd-webpage`, project number `582852715831`, organization `797368190621`, billing account `01F9FD-24EA9B-A9232C`.
- Every managed GCP resource is namespaced `hkbuddy-v1-*`, except database `hkbuddy_v1` and database users scoped inside `hkbuddy-v1-pg`.
- Project creation, billing-link changes, project display-name/label changes, default-VPC changes, unrelated IAM changes, resource adoption, destructive repair, and cross-project mutation are forbidden.
- `tech-demo-433408` is an immutable read-only Cloud Asset quota consumer only:
  `asset search-all-resources --scope=projects/motion-expert-hk-ltd-webpage --billing-project=tech-demo-433408 --project=motion-expert-hk-ltd-webpage --page-size=500 --read-mask=name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state --order-by=assetType,name --format=json` must auto-page to completion before host mutation and never authorizes a consumer-project write.
- The selected project shares billing, quota, API enablement, audit logs, and project IAM; runtime data, network, identity, secrets, images, jobs, evidence, and release state remain dedicated.
- All implementation follows red-green-refactor TDD. Cloud mutation is forbidden until focused tests, full tests, checks, security gate, diff check, clean commit, and two independent reviews pass.
- Every release candidate deploys at private 100% traffic on the separate
  `hkbuddy-v1-api-candidate` service. Public `hkbuddy-v1-api` remains unchanged
  until receipt-bound promotion after real production acceptance.

---

### Task 1: Central identity and executable resource contract

**Files:**
- Create: `production-v1/src/gcp-identity.js`
- Modify: `production-v1/infra/gcp/resource-contract.json`
- Modify: `production-v1/tests/gcp-infra-contract.test.js`
- Modify: `production-v1/tests/config-shell.test.js`
- Modify: `production-v1/package.json`

**Interfaces:**
- Produces: frozen `GCP_IDENTITY` with `projectId`, `projectNumber`, `organizationId`, `billingAccountId`, `region`, `speechRegion`, stable `service='hkbuddy-v1-api'`, private `candidateService='hkbuddy-v1-api-candidate'`, `repository`, `bucket`, `buildSourceBucket`, `cloudSqlInstance`, `network`, `subnet`, `psaRange`, `serviceAccounts`, `secrets`, and `jobs`.
- Produces: resource contract with `project.mode === 'existing-billed-shared'`, exact protected baseline, and exact namespaced resources.
- Consumes: no prior task interface.

- [ ] **Step 1: Write failing identity and contract tests**

Add assertions equivalent to:

```js
import { GCP_IDENTITY } from '../src/gcp-identity.js';

assert.equal(GCP_IDENTITY.projectId, 'motion-expert-hk-ltd-webpage');
assert.equal(GCP_IDENTITY.projectNumber, '582852715831');
assert.equal(GCP_IDENTITY.service, 'hkbuddy-v1-api');
assert.equal(GCP_IDENTITY.candidateService, 'hkbuddy-v1-api-candidate');
assert.equal(GCP_IDENTITY.bucket, 'hkbuddy-v1-582852715831-media');
assert.equal(GCP_IDENTITY.network, 'hkbuddy-v1-vpc');
assert.equal(contract.project.mode, 'existing-billed-shared');
assert.deepEqual(contract.project.protectedBindings, [
  { member: 'user:admin@motionexp.com', role: 'roles/owner' },
  { member: 'serviceAccount:service-582852715831@compute-system.iam.gserviceaccount.com', role: 'roles/compute.serviceAgent' },
  { member: 'serviceAccount:582852715831@cloudservices.gserviceaccount.com', role: 'roles/editor' },
]);
```

Assert that serialized identity/contract data contains none of the old project, project number, service, repository, bucket, SQL, network, service-account, secret, or job identities.

- [ ] **Step 2: Run focused tests and verify the red state**

Run: `cd production-v1 && node --test tests/gcp-infra-contract.test.js tests/config-shell.test.js`

Expected: FAIL because `src/gcp-identity.js` does not exist and the contract still targets `hkbuddy-prod-v1-20260826`.

- [ ] **Step 3: Implement the frozen identity module and migrate the JSON contract**

Create an ESM module shaped as:

```js
const projectId = 'motion-expert-hk-ltd-webpage';
const projectNumber = '582852715831';
const serviceAccount = (id) => `${id}@${projectId}.iam.gserviceaccount.com`;

export const GCP_IDENTITY = Object.freeze({
  projectId,
  projectNumber,
  organizationId: '797368190621',
  billingAccountId: '01F9FD-24EA9B-A9232C',
  region: 'asia-east2',
  speechRegion: 'asia-southeast1',
  service: 'hkbuddy-v1-api',
  candidateService: 'hkbuddy-v1-api-candidate',
  repository: 'hkbuddy-v1',
  bucket: 'hkbuddy-v1-582852715831-media',
  cloudSqlInstance: 'hkbuddy-v1-pg',
  database: 'hkbuddy_v1',
  network: 'hkbuddy-v1-vpc',
  subnet: 'hkbuddy-v1-ae2-run',
  psaRange: 'hkbuddy-v1-google-services',
  serviceAccounts: Object.freeze({
    runtime: serviceAccount('hkbuddy-v1-runtime'),
    build: serviceAccount('hkbuddy-v1-build'),
    migrator: serviceAccount('hkbuddy-v1-migrator'),
    deployer: serviceAccount('hkbuddy-v1-deployer'),
    acceptance: serviceAccount('hkbuddy-v1-acceptance'),
  }),
  secrets: Object.freeze({
    dbAppUrl: 'hkbuddy-v1-db-app-url',
    dbMigratorUrl: 'hkbuddy-v1-db-migrator-url',
    session: 'hkbuddy-v1-session-secret',
    bootstrap: 'hkbuddy-v1-db-bootstrap-state',
    legacy: 'hkbuddy-v1-legacy-inventory',
    dependencies: 'hkbuddy-v1-dependency-acceptance',
    llm: 'hkbuddy-v1-llm-smoke',
    asr: 'hkbuddy-v1-asr-smoke',
    tts: 'hkbuddy-v1-tts-smoke',
    ios: 'hkbuddy-v1-ios-voice-acceptance',
  }),
  jobs: Object.freeze({
    migration: 'hkbuddy-v1-migrate',
    dependencies: 'hkbuddy-v1-dependency-acceptance',
    llm: 'hkbuddy-v1-llm-smoke',
    asr: 'hkbuddy-v1-asr-smoke',
    tts: 'hkbuddy-v1-tts-smoke',
  }),
});
```

Add `src/gcp-identity.js` to `npm run check`. Update the JSON contract, custom role, IAM scopes, monitoring filters, budget display name, and exact confirmation string to the new identity set. Preserve database, security, backup, SLO, and cost values.

- [ ] **Step 4: Run focused tests and verify green**

Run: `cd production-v1 && node --test tests/gcp-infra-contract.test.js tests/config-shell.test.js && npm run check`

Expected: PASS with no old cloud identity in the contract or identity module.

- [ ] **Step 5: Commit the contract tranche**

```bash
git add production-v1/src/gcp-identity.js production-v1/infra/gcp/resource-contract.json production-v1/tests/gcp-infra-contract.test.js production-v1/tests/config-shell.test.js production-v1/package.json
git commit -m "refactor(production-v1): bind shared project resource island"
```

### Task 2: Shared-project preflight and non-adoption provisioning

**Files:**
- Modify: `production-v1/scripts/gcp-preflight.js`
- Modify: `production-v1/scripts/gcp-provision.js`
- Modify: `production-v1/tests/gcp-infra-contract.test.js`
- Modify: `production-v1/infra/gcp/README.md`

**Interfaces:**
- Consumes: `GCP_IDENTITY` and the migrated resource contract from Task 1.
- Produces: `runGcpPreflight()` receipt containing exact existing-project/billing/baseline evidence and `mutationPerformed: false`.
- Produces: `runGcpProvision()` that can enable required APIs and create only exact `hkbuddy-v1-*` resources after protected-state verification.

- [ ] **Step 1: Write failing shared-project safety tests**

Cover these exact behaviors:

```js
await assert.rejects(
  () => controlPlane.create('project'),
  (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
);
await assert.rejects(
  () => controlPlane.create('billing'),
  (error) => error.code === 'SHARED_PROJECT_MUTATION_FORBIDDEN',
);
```

Also prove that absent project, wrong project number, changed display name,
changed billing link, missing protected binding, foreign `hkbuddy-v1-*`
resource, default-network mutation target, non-namespaced managed identity, CIDR
overlap, or foreign project command stops before API enablement or resource
creation. Prove that the three protected baseline bindings remain unchanged and
that expected Google service-agent bindings may appear only after their API is
enabled.

- [ ] **Step 2: Run focused tests and verify the red state**

Run: `cd production-v1 && node --test tests/gcp-infra-contract.test.js`

Expected: FAIL because provisioning still supports project creation/billing linking and old identities.

- [ ] **Step 3: Implement shared-host preflight and protected-state audit**

Import `GCP_IDENTITY`; remove duplicated project constants. Require the project
to exist with project number `582852715831`, display name
`Motion Expert HK LTD Webpage`, no labels, active lifecycle, exact organization,
open billing account, and enabled billing link. Treat project/billing create
methods as hard errors. Snapshot protected project IAM and existing default VPC
as read-only inputs; never generate a mutating command for them.

Provision only these network identities:

```js
{
  vpc: 'hkbuddy-v1-vpc',
  subnet: 'hkbuddy-v1-ae2-run',
  subnetCidr: '10.24.0.0/26',
  psaRange: 'hkbuddy-v1-google-services',
  psaCidr: '10.25.0.0/16',
}
```

Keep read-before-write, exact post-create readback, no adoption, drift stop,
secret-redaction, key audit, and least-privilege IAM behavior unchanged.
The pre-mutation CIDR audit binds every INTERNAL Address to an exact
host-project/name Address `selfLink`, global or regional scope, matching region,
and same-region subnetwork selector where applicable. It validates complete
ordinary IPv4/IPv6 EXTERNAL rows and regional `NAT_AUTO` before excluding them
from INTERNAL IPv4 overlap math, including bounded regional IPv6 endpoint/range
shape; transient, missing, foreign, noncanonical, or contradictory rows fail
closed with zero mutation.

- [ ] **Step 4: Run focused tests and dry-run preflight fixtures**

Run: `cd production-v1 && node --test tests/gcp-infra-contract.test.js && npm run check`

Expected: PASS; fixture histories contain no project create, billing update,
default-network update, unrelated IAM update, delete, or foreign-project call.

- [ ] **Step 5: Commit the control-plane tranche**

```bash
git add production-v1/scripts/gcp-preflight.js production-v1/scripts/gcp-provision.js production-v1/tests/gcp-infra-contract.test.js production-v1/infra/gcp/README.md
git commit -m "fix(production-v1): protect shared project baseline"
```

### Task 3: Runtime, provider, storage, and evidence identity migration

**Files:**
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/src/providers/asr.js`
- Modify: `production-v1/src/providers/llm.js`
- Modify: `production-v1/src/providers/tts.js`
- Modify: `production-v1/src/services/gcs-evidence-writer.js`
- Modify: `production-v1/src/services/release-evidence.js`
- Modify: `production-v1/src/services/storage-runtime.js`
- Modify: `production-v1/src/services/voice-evidence.js`
- Modify: `production-v1/tests/config-shell.test.js`
- Modify: `production-v1/tests/gcs-media-store.test.js`
- Modify: `production-v1/tests/llm-evidence.test.js`
- Modify: `production-v1/tests/provider-contracts.test.js`
- Modify: `production-v1/tests/readiness.test.js`
- Modify: `production-v1/tests/server-readiness.test.js`
- Modify: `production-v1/tests/session-api.test.js`
- Modify: `production-v1/tests/storage-runtime.test.js`
- Modify: `production-v1/tests/task-7c-contract.test.js`
- Modify: `production-v1/tests/voice-evidence.test.js`
- Modify: `production-v1/tests/voice-media.test.js`

**Interfaces:**
- Consumes: `GCP_IDENTITY` from Task 1.
- Produces: production configuration that accepts only the selected project,
  runtime service account, Cloud Run stable/candidate origins, and media bucket.
- Preserves: provider models, languages, ADC-only authentication, evidence
  schemas, privacy, text-first voice degradation, and readiness semantics.

- [ ] **Step 1: Change test fixtures to the new identities**

Use stable origin
`https://hkbuddy-v1-api-582852715831.asia-east2.run.app`, candidate tag origin
`https://candidate-111111111111---hkbuddy-v1-api-candidate-582852715831.asia-east2.run.app`
with test commit `1111111111111111111111111111111111111111`, runtime identity
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`, and
bucket `hkbuddy-v1-582852715831-media`. Add negative cases for old-project,
old-service, old-runtime, old-bucket, and foreign-project-number values.

- [ ] **Step 2: Run the runtime/provider test slice and verify red**

Run: `cd production-v1 && node --test tests/config-shell.test.js tests/gcs-media-store.test.js tests/llm-evidence.test.js tests/provider-contracts.test.js tests/readiness.test.js tests/server-readiness.test.js tests/session-api.test.js tests/storage-runtime.test.js tests/task-7c-contract.test.js tests/voice-evidence.test.js tests/voice-media.test.js`

Expected: FAIL at the old hard-coded production identities.

- [ ] **Step 3: Replace duplicated runtime identities with `GCP_IDENTITY`**

Update stable-host and candidate-tag regular expressions for the distinct
`hkbuddy-v1-api` and `hkbuddy-v1-api-candidate` services; the untagged candidate
root is the token audience and only the tagged candidate-service URL is the QA
request target. Use the central project, bucket, runtime account, and provider
project values. Preserve exact runtime production validation and reject every
old or foreign identity. Update evidence digests only through the existing
canonical serialization paths; do not weaken a schema or accept multiple
projects.

- [ ] **Step 4: Run the runtime/provider test slice and verify green**

Run the exact Step 2 command followed by `cd production-v1 && npm run check`.

Expected: PASS with the same evidence, readiness, storage, and voice behavior.

- [ ] **Step 5: Commit the runtime tranche**

```bash
git add production-v1/src production-v1/tests
git commit -m "refactor(production-v1): migrate runtime cloud identity"
```

### Task 4: Build, release, workload, and acceptance identity migration

**Files:**
- Modify: `production-v1/cloudbuild.yaml`
- Modify: `production-v1/scripts/gcp-release.js`
- Modify: `production-v1/scripts/provider-smoke.js`
- Modify: `production-v1/scripts/voice-provider-smoke.js`
- Modify: `production-v1/scripts/real-dependencies-acceptance.js`
- Modify: `production-v1/scripts/production-latency-workload.js`
- Modify: `production-v1/tests/latency-acceptance.test.js`
- Modify: `production-v1/tests/real-dependency-acceptance.test.js`
- Modify: `production-v1/tests/release-contract.test.js`
- Modify: `production-v1/tests/security-rate-limit.test.js`

**Interfaces:**
- Consumes: `GCP_IDENTITY`, resource contract, and protected provisioning from Tasks 1-2.
- Produces: build image `asia-east2-docker.pkg.dev/motion-expert-hk-ltd-webpage/hkbuddy-v1/hkbuddy-v1-api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa` in contract fixtures and the observed immutable digest in production.
- Produces: namespaced migration/smoke jobs and two-service candidate/stable release receipts bound to project number `582852715831`.

- [ ] **Step 1: Write failing release and acceptance identity tests**

Assert exact build service account
`projects/motion-expert-hk-ltd-webpage/serviceAccounts/hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
stable service `hkbuddy-v1-api`, private candidate service
`hkbuddy-v1-api-candidate`, repository `hkbuddy-v1`, jobs
`hkbuddy-v1-migrate`, `hkbuddy-v1-dependency-acceptance`,
`hkbuddy-v1-llm-smoke`, `hkbuddy-v1-asr-smoke`, and
`hkbuddy-v1-tts-smoke`. Assert logs, traces, evidence object paths, rollout
receipts, rollback, and promotion commands bind only the selected project and
namespaced service.

- [ ] **Step 2: Run release/acceptance tests and verify red**

Run: `cd production-v1 && node --test tests/latency-acceptance.test.js tests/real-dependency-acceptance.test.js tests/release-contract.test.js tests/security-rate-limit.test.js`

Expected: FAIL because build/release scripts still reference old identities.

- [ ] **Step 3: Migrate build, release, smoke, and workload code**

Import central identities into Node scripts. Update Cloud Build repository,
image, build service account, labels, and receipt validation. Rename all release
jobs/secrets/service accounts. Update revision regex, Cloud Run tag origin,
logging filters, trace resource labels, digest checks, candidate cleanup,
promotion, and rollback to the exact two-service model. Keep create-only evidence,
one-frozen-workload, no-token persistence, private candidate, and
fresh-promotion-validation controls unchanged. Every release deploys revision
`hkbuddy-v1-api-candidate-<12 lowercase hex>` to
`hkbuddy-v1-api-candidate` at private 100% traffic with the SHA tag only on that
service. Candidate IAM is limited to the exact reviewed private invoker; the
untagged candidate root is the ID-token audience, and candidate receipts bind
`trafficState=candidate-service-private-100`, both service names, and exact
stable absent or genuine-prior-stable-at-100 state.
Both controlled Service specs pin `run.googleapis.com/invoker-iam-disabled` to
exact lowercase string `false`; raw Cloud Run v1 readbacks require exact
apiVersion/kind, authoritative status traffic, and annotation absence or an
unpadded case-insensitive `false`. Bind normalized `invokerIamDisabled=false`
into the candidate contract hash and reject malformed/boolean/true/drifted
privacy state before deploy/readback, promotion, cleanup, rollback,
response-loss, or compensation mutation.

Cloud Build submit must use exact staging directory
`gs://hkbuddy-v1-582852715831-build-source/source`, and provenance must match its
bucket/prefix and frozen source digest. Candidate service absence is valid only
on the exact service-describe `CLOUD_RUN_SERVICE_NOT_FOUND`; every other
create-or-readback family treats absence only when the exact describe command,
project/location, resource identity, and canonical error agree, while generic
stderr remains ambiguous. Promotion copies only the accepted image/config into
stable: a later release preserves the genuine prior stable revision at 100%,
stages the accepted stable revision untagged at 0%, verifies it is tag-free, and
then switches it to 100%; a first release creates stable privately at 100% and
makes `allUsers:roles/run.invoker` the final mutation after exact verification.
Receipt-bound cleanup validates and deletes only the candidate service. An
exact candidate-specific already-absent precheck skips revision, artifact, IAM,
and delete operations but still repeats canonical absence readback before a
no-mutation success; raw null, generic 404, wrong identity, and ambiguous
transport fail closed. Later
rollback accepts only the exact prior stable revision plus paired immutable
image and mutates only stable traffic; first-release rollback is unavailable
with zero calls.

- [ ] **Step 4: Run release/acceptance tests and verify green**

Run the exact Step 2 command followed by `cd production-v1 && npm run check`.

Expected: PASS; command histories contain no old or foreign project/resource identity.

- [ ] **Step 5: Commit the release tranche**

```bash
git add production-v1/cloudbuild.yaml production-v1/scripts production-v1/tests
git commit -m "refactor(production-v1): migrate release resource island"
```

### Task 5: Documentation, exhaustive identity scan, and pre-mutation review

**Files:**
- Modify: `production-v1/.env.example`
- Modify: `production-v1/README.md`
- Modify: `production-v1/infra/gcp/README.md`
- Modify: `docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md`
- Modify: `docs/superpowers/plans/2026-08-26-production-v1-gcp-launch.md`
- Test: all `production-v1/tests/*.test.js`

**Interfaces:**
- Consumes: all code and contract changes from Tasks 1-4.
- Produces: operator documentation with exact selected project, confirmation,
  namespaced resources, protected shared state, and rollback boundary.

- [ ] **Step 1: Update documentation and examples**

Replace operational instructions with the selected project and exact resource
island. Mark the old dedicated-project creation/billing step superseded by the
shared-project design. Document that default VPC, baseline IAM, existing data,
and unrelated services are protected and that API/quota/billing remain shared.

- [ ] **Step 2: Run exhaustive old-identity and namespace scans**

Run:

```bash
rg -n "hkbuddy-prod-v1-20260826|93662314720|hkbuddy-api|hkbuddy-pg|hkbuddy-prod-vpc|hkbuddy-prod-v1-20260826-media" production-v1
rg -n "hkbuddy-(runtime|build|migrator|deployer|acceptance|migrate|dependency|llm|asr|tts|ios|db|session|legacy)" production-v1
```

Expected: no unintended old identity; every managed non-database identity is
`hkbuddy-v1-*`. Historical explanation may retain the old project only in the
superseded design/plan, never in executable files or operator commands.

- [ ] **Step 3: Run the complete local verification ladder**

Run:

```bash
cd production-v1 && npm test
cd production-v1 && npm run check
cd production-v1 && npm run security:dependencies
git diff --check
git status --short --branch
```

Expected: 0 failed tests, only the approved real-PostgreSQL skip, exact
`DEPENDENCY_SECURITY_EXCEPTION_REVIEWED`, clean diff check, and only intended
tracked changes before commit.

- [ ] **Step 4: Commit documentation and freeze the candidate commit**

```bash
git add production-v1/.env.example production-v1/README.md production-v1/infra/gcp/README.md docs/superpowers
git commit -m "docs(production-v1): document shared project operations"
```

Run the complete Step 3 verification again, require a clean worktree, and record the 40-hex HEAD.

- [ ] **Step 5: Obtain two independent approvals**

One reviewer verifies shared-project non-adoption, protected baseline, command
scoping, and IAM/network semantics. A separate reviewer verifies runtime,
provider, build, release, evidence, promotion, rollback, and old-identity
exclusion. Any Critical or Important finding returns to the owning task and
repeats the complete verification ladder.

### Task 6: Live GCP preflight, provisioning, deployment, and promotion

**Files:**
- Read: `production-v1/infra/gcp/resource-contract.json`
- Run: `production-v1/scripts/gcp-preflight.js`
- Run: `production-v1/scripts/gcp-provision.js`
- Run: `production-v1/scripts/gcp-release.js`
- Write only generated local release receipts under the existing ignored release-evidence directory.

**Interfaces:**
- Consumes: clean reviewed commit, isolated Cloud SDK config, exact monitoring notification channel, and selected host project.
- Produces: verified `hkbuddy-v1-*` GCP resource island, separate private
  candidate service in `candidate-service-private-100`, immutable named
  two-service acceptance receipts, promoted stable service, rollback receipt,
  public URL, and QR code.

- [ ] **Step 1: Run fresh read-only preflight**

Use `CLOUDSDK_CONFIG=C:\Users\陈奕炜\AppData\Local\gcloud-hkbuddy-production-v1` and run:

```bash
cd production-v1
npm run gcp:preflight
```

Expected: selected project active, project number and organization exact,
billing enabled, operator/rest principal exact, baseline bindings protected,
no CIDR conflict, no managed-resource collision, `mutationPerformed: false`.

- [ ] **Step 2: Create or verify the notification channel and provision**

If no verified email channel exists, create one exact namespaced channel and
complete Google verification before continuing. Then run:

```powershell
$env:V1_NOTIFICATION_CHANNEL = gcloud.cmd monitoring channels list --project=motion-expert-hk-ltd-webpage --filter="displayName='HK Buddy V1 operations' AND type='email'" --format="value(name)" --limit=1
if (-not ($env:V1_NOTIFICATION_CHANNEL -match '^projects/582852715831/notificationChannels/[1-9]\d*$')) { throw 'Verified HK Buddy V1 notification channel is unavailable' }
npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage "--notification-channel=$env:V1_NOTIFICATION_CHANNEL"
```

Expected: only required APIs and exact `hkbuddy-v1-*` resources are created;
all existing unrelated resources read back unchanged. Secrets are generated
without printing values. Re-running produces only `unchanged` results.

- [ ] **Step 3: Build, migrate, and deploy the private candidate**

Run the release controller from the clean 40-hex commit using the complete
manifest-refresh sequence: build, migration, inventory, acceptance, collect,
evidence, candidate, readiness, workload, mobile, then promote. Require successful
dependency security receipt, provenance, image labels, immutable digest,
digest-pinned migration job, legacy inventory, dependency acceptance, real LLM,
ASR, and TTS smoke receipts. Require `hkbuddy-v1-api-candidate` at private 100%
for every release, the SHA tag on that service only, exact private invoker IAM,
untagged-root audience, and `trafficState=candidate-service-private-100` bound
with both service identities. Keep public `hkbuddy-v1-api` unchanged throughout
candidate acceptance.

- [ ] **Step 4: Run complete production acceptance**

Run 200 text turns across 20 sessions at concurrency 5, 30 governed ASR cases,
30 TTS cases, real Cloud Logging trace validation, knowledge/citation checks,
privacy/security checks, and the 390x844 mobile checklist. Require the existing
SLOs: grounded answer P50 <= 2.5 s/P95 <= 6 s; 10-second voice transcript P50
<= 2.5 s/P95 <= 4 s; TTS ready P50 <= 2.5 s/P95 <= 5 s; zero duplicate replies,
zero acknowledged loss, zero unsupported Verified facts, and 100% text survival
on TTS failure.

- [ ] **Step 5: Promote, verify rollback, and deliver**

Freshly revalidate the private candidate service/revision/IAM/image/config,
acceptance artifact, Task 8 bindings, and 200 production traces. On a later
release, preserve the genuine prior stable revision at 100%, stage the accepted
stable revision untagged at 0%, verify exact image/config and no stable tag, then
atomically switch it to 100% without changing public IAM. On the first release,
create stable privately at 100%, verify service/revision/image/config and
private IAM, then add `allUsers:roles/run.invoker` as the final mutation and
perform only IAM readback afterward. Verify stable health, readiness, text,
voice, sources, mobile safe area, and no autoplay. Execute the non-destructive
stable-only rollback drill required by the release contract and return to the
accepted revision. On any ambiguous first-release IAM/service/readback, restore
the accepted private stable state and exact private IAM before reporting
compensation. Candidate cleanup separately validates its receipt, deletes only
`hkbuddy-v1-api-candidate`, and verifies canonical absence.
If its initial exact candidate-specific precheck is already-absent, it skips
revision/artifact/IAM/delete, repeats canonical absence readback, and reports no
mutation; raw null output, generic 404, wrong identity, and ambiguous transport
fail closed. Every candidate/stable and compensation readback revalidates the
enabled Invoker IAM check rather than trusting IAM policy alone.
Generate a QR code for the final stable HTTPS URL and
report exact deployed revision, image digest, release commit, acceptance result,
known shared-project boundary, URL, and QR artifact.

## Stage D local implementation checkpoint (2026-08-28)

- [x] Make candidate privacy publication last in the candidate phase. Hash the
  seven-field reference in the receipt and independently anchor it to the
  journaled publication plus terminal candidate-receipt digest; adopt only
  exact prior bytes after restart.
- [x] Journal readiness, the privacy-start/privacy-end/workload three-file
  bundle, and all seven mobile artifacts before publication; exact-byte restart
  completes every covered suffix/terminal crash boundary without overwrite.
- [x] Bound evidence reads to intended length and descriptor/path/parent identity
  and recheck publication identity around the create-only link. This is the
  strongest portable Node contract for a trusted operator-owned directory, not
  a native no-TOCTOU guarantee against a malicious same-user process.
- [x] Bind the fresh mobile chain to privacy start/end, candidate and stable
  before/after readbacks, four structurally decoded PNG screenshots, and the
  canonical WAV fixture. Pin Playwright `1.62.1`, Chromium revision `1234` /
  `151.0.7922.34`, and `390x844` DPR 1; require four fully opaque raw/pixel-
  unique PNGs and keep real iOS separate. The positive harness uses the real
  local Product V1 shell, native EventSource, and product APIs with Node-owned
  message/retry/UI observations plus a private per-run watermarked WAV,
  verified Chromium command line and actual upload, and isolated CDP/native
  Media/WebAudio playback evidence. It trusts no page token/lifecycle report,
  observes downloads on every page, and limits text-answer recovery to an
  already-existing retryable generation after explicit opt-in.
- [x] Validate workload start/end and other historical evidence at their recorded
  gate clocks while fresh wrappers reject the exact expiry boundary. Promotion
  appends an attempt-bound proof, validates it with the current post-proof clock,
  rereads all predecessors and candidate/stable/IAM/authority sources, and binds
  the canonical barrier digest to final intent. Expired safe-before paths abort
  and re-proof; mixed/ambiguous paths block. Forbid every cloud mutation after
  the terminal promotion mutation.
- [ ] Execute live shared-project/candidate/provider/real-iOS/promotion/public
  acceptance. The Stage D checkpoint is local-only and authorizes no GCP,
  provider, legacy, Azure, or public-IAM operation.
