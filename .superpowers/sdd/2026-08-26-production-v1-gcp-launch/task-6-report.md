# Task 6 report — isolated GCP production infrastructure contract

## Delivery status

The infrastructure contract, guarded read-only preflight, guarded idempotent
provisioner, operator runbook, and regression suite are implemented in the
isolated `production-v1` worktree. This implementation task made **no GCP
mutation**. The live confirmed path remains exclusively with the parent task
after independent review and explicit operator approval.

The fixed boundary is project `hkbuddy-prod-v1-20260826`, organization
`797368190621`, billing account `01F9FD-24EA9B-A9232C`, and reviewed operator
`admin@motionexp.com`. No legacy Hong Kong Buddy resource is referenced as a
mutation target.

## Executable resource contract

`production-v1/infra/gcp/resource-contract.json` fixes the complete resource
surface and fails on extra or replaced contract fields:

- 18 required APIs and four distinct service accounts for runtime, build,
  migration, and deployment;
- Artifact Registry and GCS in `asia-east2`;
- custom VPC `10.24.0.0/26`, named PSA allocation `10.25.0.0/16`, Direct VPC
  `private-ranges-only`, and private-IP-only Cloud SQL;
- PostgreSQL 16 HA with `ENCRYPTED_ONLY`, PITR, seven-day WAL/backup retention,
  retained/final backups, and deletion protection;
- separate `hkbuddy_app` and `hkbuddy_migrator` database identities;
- ten Secret Manager containers, including six versionless evidence containers
  handed to the frozen-release task;
- 21 resource-scoped IAM grants plus exact required/permitted Google-managed
  project entitlements;
- six metric and five validated log-event alert policies;
- the native-currency `HKD 2300` monthly budget alert with 50/80/100% actual
  and 100% forecast notifications. This is explicitly not a hard spend cap;
- fixed Cloud Run limits, probes, initial zero traffic, numeric secret pins,
  Direct VPC, and separate runtime/migrator identities for the later release.

Cloud SQL creation uses the supported SQL Admin v1 `instances.insert` body so
the named `settings.ipConfiguration.allocatedIpRange` is never omitted. The
installed GA Cloud SDK does not expose that create flag.

## Guarded authentication and mutation boundary

All CLI operations use `execFile` argument arrays. Secret material is never put
in argv, output, reports, or temporary files; authenticated HTTPS clients carry
it only in request bodies or Authorization headers.

The live client requires the exact active gcloud account and independently
introspects the effective access token email. It rejects every effective
`CLOUDSDK_AUTH_*` credential override and every active gcloud `auth` property,
including service-account impersonation, access-token-file, and
credential-file overrides. The bearer token is not treated as proof merely
because it was requested with `--account`.

Provisioning is inert without the exact fixed-project confirmation. A target
project `403` remains unresolved, not absent. Only the exact confirmed path may
make one guarded `projects.create` call for the fixed ID, followed by exact
readback; collision, permission failure, or ambiguous readback stops without
choosing a different ID. Every other `403` remains fail closed.

## Safe two-stage bootstrap

The operation order prevents an unmonitored paid topology:

1. project, billing link, and required API/service-identity foundation;
2. exact enabled, verified email notification-channel gate;
3. create/read back the HKD budget, then all alert policies;
4. only then Artifact Registry, service accounts, VPC, HA Cloud SQL, bucket,
   secret containers and values, database users, and workload IAM.

On the first fresh confirmed run, no channel can exist yet. The provisioner
stops cleanly at `notification-channel` after only step 1. The operator must
create the target-project email channel and complete the external email
verification before the resumed confirmed run supplies its numeric channel ID.

## Idempotence and security audits

Each durable resource is described/listed, compared, created only if absent,
then read back exactly. Pagination is exhausted before absence or uniqueness is
decided. Null, primitive, array, malformed, looping, or oversized list-page
state is ambiguous and cannot trigger duplicate creation.

The following fail-closed audits precede sensitive writes:

- project IAM subset immediately after project resolution;
- user-managed key audit after all four service accounts and before downstream
  grants;
- every managed project, bucket, repository, secret, and service-account IAM
  scope after containers exist but before any secret value or DB user write.

Subset audits permit only not-yet-created expected grants; foreign owners,
public principals, external accessors/impersonators, conditions, duplicates,
wrong roles, and unmodeled service agents stop the run. Final readback is
mandatory and requires the complete exact allowlist. Workloads cannot receive
`roles/iam.serviceAccountTokenCreator`. The current Google APIs Service Agent
pair permits only `roles/compute.instanceGroupManagerServiceAgent`; legacy
project Editor is rejected.

Generated session and database credentials are canonical unpadded base64url
encodings of exactly 32 bytes. Weak, padded, noncanonical, duplicate, or
multiple-enabled-version readback is drift. Only four generated secret
containers receive base versions; all six release-evidence containers remain
versionless for the later accepted artifacts.

## TDD and review evidence

- Initial RED: the focused test could not import the absent infrastructure
  module (**0 pass / 1 fail**).
- Reviewer regression RED for the final safety batch: **113 tests / 105 pass /
  8 fail**, covering Google APIs Service Agent entitlement, canonical secret
  strength, malformed successful list pages, and notification/budget ordering.
- Final bounded-review RED: **139 tests / 124 pass / 15 fail**, covering
  malformed non-paginated API/PSA/SQL-user/CIDR lists, writable Artifact
  Registry mode, and Secret Manager lifecycle/encryption drift.
- A separate command-shape RED proved `gcloud config list auth` was invalid for
  the installed SDK; the corrected `gcloud config list --format=json` path was
  then implemented and verified live read-only.
- Final focused infrastructure suite: **139/139 pass**.
- Full `npm.cmd test`: **1,312 tests / 1,311 pass / 0 fail / 1 explicit existing
  real-PostgreSQL skip**.
- `npm.cmd run check`: pass.
- `git diff --check`: pass; only the existing Windows LF/CRLF notice is emitted.
- `npm.cmd run gcp:provision`: exit 0 dry-run; no mutation; planned order begins
  project → billing → APIs → channel → budget → alerts → topology.
- Isolated live read-only `npm.cmd run gcp:preflight`: exit 0 with
  `PROJECT_ID_UNRESOLVED`, `create-probe-required`, and
  `mutationPerformed:false`.

Independent final bounded review: **APPROVE / READY**. The reviewer found no
remaining Critical, Important, or Minor blocker after the final TDD corrections.
Review instant: `2026-08-26T04:47:31+08:00` (Asia/Hong_Kong).

## Remaining live boundary

No project, API, billing link, channel, budget, database, network, secret, IAM
grant, or monitoring policy was created by this implementation task. After
review approval, the parent may run the exact confirmed project foundation
path. External notification-channel creation and email verification are a real
operator prerequisite, not something this script fabricates or bypasses. The
parent must record safe post-mutation readback and preserve any partial exact
resources for resumable diagnosis.
