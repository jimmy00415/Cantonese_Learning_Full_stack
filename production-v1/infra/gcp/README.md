# Hong Kong Buddy Production V1 — guarded GCP provisioning

This directory is the executable infrastructure contract for the existing,
billed Motion Expert shared project. It creates only the V1-namespaced resource
island and never adopts, updates, or deletes a non-V1 resource.

## Fixed boundary

- Project: `motion-expert-hk-ltd-webpage` (project number `582852715831`)
- Organization: `797368190621`
- Billing account: `01F9FD-24EA9B-A9232C`
- Cloud Run, Cloud SQL, Artifact Registry, and media storage: `asia-east2`
- Speech-to-Text and Text-to-Speech: `asia-southeast1`
- Vertex AI: `global`
- Monthly budget alert: `HKD 2300`, with 50/80/100% actual and 100%
  forecast thresholds; it is an alert, not a hard spend cap
- Runtime/database connectivity: Cloud Run Direct VPC with
  `private-ranges-only` egress and Cloud SQL private IP
- Cloud SQL transport: `sslmode=require`, with instance-side
  `ENCRYPTED_ONLY`

### Exact provisioned identities

The Tasks 1–2 operator boundary uses only these executable V1 identities:

- Cloud Run service: `hkbuddy-v1-api`
- Artifact Registry Docker repository: `hkbuddy-v1`
- media bucket: `hkbuddy-v1-582852715831-media`
- Cloud SQL instance/database: `hkbuddy-v1-pg` / `hkbuddy_v1`
- VPC/subnet/PSA range: `hkbuddy-v1-vpc` /
  `hkbuddy-v1-ae2-run` / `hkbuddy-v1-google-services`
- service accounts:
  `hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-migrator@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  `hkbuddy-v1-deployer@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
  and
  `hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
- generated/bootstrap Secret containers: `hkbuddy-v1-db-app-url`,
  `hkbuddy-v1-db-migrator-url`, `hkbuddy-v1-session-secret`, and
  `hkbuddy-v1-db-bootstrap-state`
- evidence Secret containers: `hkbuddy-v1-legacy-inventory`,
  `hkbuddy-v1-dependency-acceptance`, `hkbuddy-v1-llm-smoke`,
  `hkbuddy-v1-asr-smoke`, `hkbuddy-v1-tts-smoke`, and
  `hkbuddy-v1-ios-voice-acceptance`
- Cloud Run Jobs: `hkbuddy-v1-migrate`,
  `hkbuddy-v1-dependency-acceptance`, `hkbuddy-v1-llm-smoke`,
  `hkbuddy-v1-asr-smoke`, and `hkbuddy-v1-tts-smoke`

### Read-only Cloud Asset inventory consumer

The host does not enable Cloud Asset API. Before any provisioning write, the
control plane therefore performs one exhaustive, auto-paginated JSON inventory read of the host
using `tech-demo-433408` strictly as the Cloud Asset quota consumer:

```text
gcloud asset search-all-resources --scope=projects/motion-expert-hk-ltd-webpage --billing-project=tech-demo-433408 --project=motion-expert-hk-ltd-webpage --page-size=500 --read-mask=name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state --order-by=assetType,name --format=json
```

`tech-demo-433408` is never a deployment host and is never the target of API
enablement, resource, billing, IAM, or REST mutation. Malformed, unavailable,
truncated/overflowed, wrong-project, or foreign managed-namespace inventory fails closed before a
host mutation.

The complete identities, APIs, IAM bindings, probes, backup controls, alert
policies, and budget thresholds live in `resource-contract.json`. The contract
is deliberately exact. Changing an identity or weakening a control makes the
scripts fail before mutation.

## Commands

`npm run gcp:preflight` is read-only. It requires the existing active shared
project, its exact project number and display name, no project labels, its open
billing link, and the three protected baseline IAM bindings. It never creates,
links, patches, or deletes the project, billing link, default network, or any
unrelated IAM policy.

The billing account must report `currencyCode=HKD`. Google requires a fixed
budget amount to use the billing account's native currency, so the reviewed
live ruling is `HKD 2300` rather than the earlier `USD 300` draft. Any currency
mismatch fails before mutation.

An optional existing target-project Monitoring channel can be checked with:

```text
npm run gcp:preflight -- --notification-channel=projects/582852715831/notificationChannels/NUMERIC_ID
```

The channel must have display name `HK Buddy V1 operations`, exact ownership
labels `application=hong_kong_buddy`, `environment=production_v1`, and
`hkbuddy_contract=operations`, have `type=email`, be enabled, and have
`verificationStatus=VERIFIED`. Billing Budgets does not accept an arbitrary
Monitoring channel type. A missing, disabled, inaccessible, non-email, or
unverified channel is not treated as usable.

`npm run gcp:provision` is also inert by default: it validates the contract and
prints the planned fixed operation IDs. The mutating first-stage bootstrap is:

```text
npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage
```

That exact form first re-audits the immutable shared-project baseline and every
managed-resource collision, then enables only the required APIs and stops at
the required channel gate. After the operator creates and verifies the email
channel, the mutating resume form is:

```text
npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage --notification-channel=projects/582852715831/notificationChannels/NUMERIC_ID
```

No abbreviated confirmation, alternate project, extra flag, or legacy identity
is accepted. The project and its billing link must already exist and match the
immutable shared baseline; neither is ever created, linked, patched, or adopted.
Every confirmed run performs the complete read-only collision and network-CIDR
audit before its first API enablement, create, POST, or IAM mutation. The
operator then creates the real email channel in that project and completes its
external email verification. A rerun with the numeric verified channel creates
and reads back the budget and alert policies before any VPC, HA Cloud SQL,
storage, secret, or workload-IAM mutation. The script reports the exact resume
boundary and never rolls back or deletes partial resources.

## CLI launch on Windows

The script uses `execFile` with an argument array; it never builds a shell
command string. On the standard Windows Cloud SDK installation it invokes the
bundled Python runtime and `gcloud.py` directly. A nonstandard installation must
provide both absolute paths:

- `V1_GCP_PYTHON_EXECUTABLE`
- `V1_GCLOUD_PY_PATH`

The active Cloud SDK configuration remains operator-controlled. Use the
dedicated Production V1 configuration directory when running the reviewed live
command; the scripts never switch configurations implicitly. For example, set
`CLOUDSDK_CONFIG` to the reviewed `gcloud-hkbuddy-production-v1` directory in
the operator process before invoking npm.

Authenticated HTTPS calls acquire an access token in memory for the one active
gcloud account. The reviewed launch authority is fixed to
`admin@motionexp.com`; both CLI and REST must resolve to that account before
mutation. The script rejects every effective `CLOUDSDK_AUTH_*` credential
override and any active gcloud `auth` override, including impersonation,
access-token-file, and credential-file settings. It introspects the actual
access token and compares the returned email rather than trusting the requested
account argument. This also makes the project-creator `roles/owner` baseline explicit
instead of accepting whichever identity happens to be active. The bearer token
is never placed in an argument or report. This operator authentication path is
separate from the runtime: Cloud Run uses its attached service account through
application default credentials.

## Frozen release commands

`scripts/gcp-release.js` is also inert by default. The source archive command
accepts only one clean lower-case 40-hex `HEAD`, rejects tracked or untracked
worktree changes, fixes every archive member mtime to that commit's validated
`%ct`, archives the `production-v1` tree outside the repository, and returns
its SHA-256:

```text
node scripts/gcp-release.js --prepare-archive --repository-root=ABSOLUTE_REPOSITORY_ROOT --destination=ABSOLUTE_OUTPUT/source.tar.gz --release-sha=40_HEX_SHA
node scripts/gcp-release.js --prepare-archive --repository-root=ABSOLUTE_REPOSITORY_ROOT --destination=ABSOLUTE_OUTPUT/source.tar.gz --release-sha=40_HEX_SHA --confirm-archive=40_HEX_SHA
```

The release manifest is a local JSON control record with exact keys for the
release SHA, absolute archive path and hash, immutable image digest, numeric DB
Secret versions, one UUIDv4 acceptance run ID, the four exact generation-bound
GCS output objects, project number, previous V1 revision, and the six evidence
artifacts. The legacy inventory is also carried separately because it must be
published before the dependency Job can run. Each evidence member separates
its local absolute JSON path, semantic artifact SHA-256, exact object-byte
SHA-256, fixed Secret ID, and expected numeric Secret version. The release
runner verifies the file bytes, embedded commit/artifact binding, size, and
basic secret-safety before its first Secret Manager mutation. It must not
contain credentials. The first `build` invocation alone accepts
`imageDigest: null`; its verified receipt returns the digest that must replace
that null before any later phase is accepted. One phase is selected at a time:

```text
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build
node scripts/gcp-release.js --manifest=ABSOLUTE_RELEASE_MANIFEST.json --phase=build --confirm-release=40_HEX_SHA
```

The guarded order is `build`, `migration`, `inventory`, `acceptance`, `collect`,
`evidence`, `candidate`, then `promote`; `rollback` is the separately confirmed
recovery phase. Build
completion requires the custom build identity; a fresh production-only install;
an exact `DEPENDENCY_SECURITY_EXCEPTION_REVIEWED` gate receipt before the image
step; verified provenance; successful image/corpus and OCI-label checks; one
Build ID; the archive hash; and the final digest. A missing, failed, expired, or
drifted dependency gate is a failed build receipt. `inventory` publishes and
reads back the legacy inventory's one planned
numeric Secret version. `acceptance` runs the `hkbuddy-v1-dependency-acceptance`
Job as
`hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
and the `hkbuddy-v1-llm-smoke`, `hkbuddy-v1-asr-smoke`, and
`hkbuddy-v1-tts-smoke` Jobs as
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`;
every Job is digest-pinned and its exact service account is read back before
execution. Each
Job creates one private, release/run-scoped GCS JSON object with an
overwrite-preventing generation precondition. `collect` first describes one
exact numeric generation, downloads only that generation to the planned local
path, and independently derives the semantic artifact and exact object-byte
SHA-256 values. Evidence publication then accepts only the planned numeric
version returned and described by Secret Manager. Only after all versions read
back does it delete those exact GCS generations and require zero SHA-scoped
output residue. Neither workload identity can publish Secret versions; that
authority remains with the reviewed deployer. Candidate deployment is
digest-pinned and
zero-traffic with `/api/health/ready` as both startup dependency gate and
readiness probe, plus `/api/health/live` as the liveness probe. Public IAM can
be changed only after the active account reads back as the reviewed owner
`admin@motionexp.com`; the deployer is deliberately not granted
`roles/run.admin` or service-IAM administration.

The manifest is deliberately refreshed between boundaries: `build` supplies
the immutable image digest; successful Jobs supply numeric GCS generations;
`collect` supplies the four semantic/object digest pairs; and Secret Manager
supplies numeric versions. A value from stdout is never accepted on its own:
the next phase requires the corresponding exact control-plane or file readback.

Every built image contains `/app/release-manifest.json` with exactly the schema
version, frozen release SHA, source-archive SHA-256, and
`git-archive:production-v1` source marker. Cloud Build verifies that file
against its substitutions. Jobs and the service receive
`V1_RELEASE_MANIFEST_FILE=/app/release-manifest.json` and
`V1_RELEASE_COMMIT_SHA`; no workload needs a `.git` directory or a mutable tag.

## Idempotence and failure behavior

Each durable operation follows this sequence:

1. describe or list;
2. compare every contract-bearing field;
3. create only when absent;
4. read back and compare again.

An inaccessible (`403`) resource is unknown, never absent. This includes the
target shared project: a `403`, absence, wrong project number, or baseline drift
fails closed and never creates or probes a project. `ALREADY_EXISTS`, permission
failure, unresolved readback, a global bucket/project collision, immutable
drift, wrong parent, public bucket
principal, broad workload IAM, missing metric descriptor, or ambiguous result
stops the run. If a create response is lost, the script accepts it only when an
immediate readback proves the exact contract. The safe report identifies the
last completed step and the next resume boundary without including provider
error bodies.

List-based readbacks validate every non-paginated response and exhaust every
paginated endpoint before deciding absence, uniqueness, or exactness. A null,
primitive, wrong container shape, malformed member, or malformed successful
page is ambiguous, never empty. A project-policy subset audit runs immediately after
project resolution. A second subset audit covers every managed bucket,
repository, secret, and service-account policy after the empty containers exist
but before any secret value or database user is written. These audits permit
not-yet-created expected grants but reject every unmodeled entitlement. The
final readback is mandatory, not advisory: it re-describes every
resource, re-audits all five service accounts for user-managed keys, rejects a
public bucket member, and compares the managed project, bucket, repository,
secret, and service-account IAM policies to exact per-scope allowlists. It also
lists project custom roles and requires the one fixed GA
`hkbuddyV1AcceptanceBucketMetadataReader` definition with exactly
`storage.buckets.get`; an extra permission, role, deletion, or stage drift is a
hard failure. Any
extra managed workload binding, conditional replacement, or missing binding
fails the run. Workload principals may never receive
`roles/iam.serviceAccountTokenCreator`; the only such binding is the expected
Google-managed Cloud Build service agent on
`hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`.
The Cloud Build service agent's automatically managed project-level
`roles/cloudbuild.serviceAgent` grant is separately required and is never
re-created by this script. Exact official service-agent member/role pairs for
the enabled or used APIs are permitted if Google materializes them; arbitrary
Google-managed roles, external users/service accounts, public principals, and
extra project or resource bindings are rejected. In particular, a new project's
Google APIs Service Agent may have only the current
`roles/compute.instanceGroupManagerServiceAgent` entitlement; legacy
project-level `roles/editor` is not allowed.

Cloud SQL is created through the supported SQL Admin v1 `instances.insert`
request because the installed GA Cloud SDK cannot bind the named PSA allocation
on its create command. The request sets
`settings.ipConfiguration.allocatedIpRange=hkbuddy-v1-google-services`,
private IP only, `ENCRYPTED_ONLY`, HA, backup/PITR/WAL retention, retained and
final backups, and deletion protection in one reviewed body. Its long-running
operation must finish successfully before the complete instance readback is
accepted.

Artifact Registry is created and read back as an exact writable
`STANDARD_REPOSITORY`; a remote or virtual Docker repository with the same name
is a collision, not an acceptable substitute.

## Database identities and secrets

`hkbuddy_app` and `hkbuddy_migrator` are different PostgreSQL identities.
Cloud SQL's authenticated users API receives passwords only in an HTTPS JSON
body. The application user is created with only `pg_read_all_data` and
`pg_write_all_data`, which prevents Cloud SQL from automatically assigning
`cloudsqlsuperuser`; the migrator is explicitly assigned
`cloudsqlsuperuser` for DDL.

The application URL, migrator URL, and session value are generated in memory.
They are sent only in authenticated SQL Admin or Secret Manager request bodies.
They never appear in gcloud arguments, stdout, logs, reports, or temporary
files. Every generated credential, including both URL passwords, must remain a
canonical unpadded base64url encoding of exactly 32 bytes on readback; a weak or
noncanonical pre-existing value is drift. Secret containers also require exact
Google-managed automatic replication, exact labels, and no expiry, TTL,
rotation, topic, or CMEK control. Runtime and migration URLs point at the private IP and contain only
`sslmode=require`. A non-secret bootstrap receipt binds the user roles to the
numeric URL-secret versions. Existing users without that receipt stop as an
ambiguous partial state.

Only numeric Secret Manager versions are returned for the later Cloud Run
service/job specification. `latest` is not a deployment pin. The runtime gets
access to the application URL and session secret only; the migrator gets access
to the migrator URL only.

The base provisioning pass also creates six empty evidence containers:
`hkbuddy-v1-legacy-inventory`, `hkbuddy-v1-dependency-acceptance`,
`hkbuddy-v1-llm-smoke`, `hkbuddy-v1-asr-smoke`, `hkbuddy-v1-tts-smoke`, and
`hkbuddy-v1-ios-voice-acceptance`. It creates no version in those containers.
The frozen-release task adds exactly one accepted numeric version to each and
mounts it read-only; startup validation remains fail closed. Runtime receives
secret-scoped accessor grants for these six containers so no project-wide
Secret Manager access is needed.

The
`hkbuddy-v1-deployer@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
deployer can act as
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
`hkbuddy-v1-migrator@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`,
`hkbuddy-v1-build@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`, and
`hkbuddy-v1-acceptance@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
only through service-account-scoped
`roles/iam.serviceAccountUser` bindings. There is no project-wide `actAs`
grant. The build identity writes only to the `hkbuddy-v1` repository and project
logs; the deployer reads only that repository and has `roles/run.developer`.
The acceptance identity is DB/GCS-only: it can read the app and migrator URL
Secret containers, exercise and clean up private bucket objects, and write
platform logs. Its normal object grant is complemented only by the custom
`storage.buckets.get` permission on the fixed media bucket so the dependency
Job can attest the bucket's exact production project number; it receives no
bucket-list or storage-admin role. It has no Vertex AI, STT, TTS,
runtime-serving, or evidence
Secret-version publishing role. Provider and voice smoke jobs instead run as
the exact
`hkbuddy-v1-runtime@motion-expert-hk-ltd-webpage.iam.gserviceaccount.com`
serving identity; every job readback must record the attached identity before
its evidence can be accepted.

Final readback also lists user-managed keys for all five service accounts and
fails if any exist. Runtime provider access is via Cloud Run application
default credentials, never an API key or downloaded service-account key.

## Monitoring contract

The contract creates six metric policies and five event policies: Cloud Run
5xx ratio, P95 latency and the one-instance cap; Cloud SQL CPU, storage and
connections; Cloud SQL backup failure, failover and restart; Cloud Build
failure; and Cloud Run deployment failure. Before a metric policy is created,
the exact Monitoring metric descriptor must resolve. Before an event policy is
created, the exact Logging filter is submitted to the read-only
`entries:list` endpoint. An unsupported descriptor or filter stops before the
Monitoring policy write. The verified email channel is then used by every
policy and by the exact HKD 2300 budget alert.

## Release boundary

This task creates the isolated project foundation. It does not build an image,
run migration 001, create a Cloud Run candidate, or route traffic. Those actions
belong to the frozen-release tasks after this contract and its independent
review are green. The Cloud Run template in the JSON is the binding input for
that later deployment: one instance, always-allocated CPU, Direct VPC, zero
initial traffic, and separate live/ready probes. That later task also supplies
the six accepted evidence versions; this base task deliberately leaves those
containers versionless.
