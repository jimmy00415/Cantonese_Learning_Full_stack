# Task 7B report — real PostgreSQL + GCS dependency acceptance

Date: 2026-08-26
Scope: Task 7B only

## Verdict

Implementation and deterministic contract tests: **PASS**.

Live PostgreSQL/GCS dependency acceptance: **NOT RUN**. This task made no GCP
API calls and mutated no GCP resource. A release operator still has to run the
digest-pinned acceptance Job with the dedicated service account and two numeric
database-secret versions, retrieve the exact evidence-object generation, verify
it independently, publish the approved bytes as a numeric Secret Manager
version, delete the handoff object, and prove the release-evidence prefix is
empty.

## Changed files

- `production-v1/scripts/real-dependencies-acceptance.js`
- `production-v1/tests/real-dependency-acceptance.test.js`
- `.superpowers/sdd/2026-08-26-production-v1-gcp-launch/task-7b-report.md`

No package/config/security/Docker/build/release/latency/provider/voice file was
edited by Task 7B. Other files visible in the shared worktree belong to the
parallel Task 7A/7C batches and are not part of this task's commit.

## Delivered contract

- Production dependency acceptance is PostgreSQL 16 plus the fixed private GCS
  bucket, using attached-service-account ADC. Azure remains only a read-only
  legacy collision boundary; Azure-only or mixed acceptance configuration is
  rejected.
- The script requires the fixed project, Cloud SQL database resource, GCS bucket
  and resource, a UUID-scoped PostgreSQL schema, and a matching UUID-scoped GCS
  functional prefix.
- `hkbuddy_migrator` is used only for isolated schema creation, migration,
  grants, zero-object proof, and schema teardown. `hkbuddy_app` performs all
  functional checks. The two URLs must resolve to the same database identity
  and exact distinct users with distinct decoded passwords; the app role is
  proved unable to create schemas or databases.
- Before PostgreSQL or GCS acquisition, a bounded metadata-server request with
  `Metadata-Flavor: Google` must attest exactly
  `hkbuddy-acceptance@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com`.
  The actual Storage client's ADC must independently resolve a metadata-backed
  `Compute` credential with that same email, and bucket metadata must report
  project number `93662314720`. Well-known-file, cross-account, and
  cross-project drift fail before either isolation scope is acquired. Evidence
  records only non-secret checks and the execution-identity digest.
- GCS acceptance proves exact intended IAM permissions, absence of forbidden
  permissions, anonymous non-public access, conditional create-only writes,
  bounded full/range reads, HEAD metadata, pagination, delete, hostile response
  normalization, cancellation, and deadlines. Provider metadata above the
  eight-MiB hard cap is rejected before a full or range stream opens, and upload
  inputs are size-checked before copying. It neither produces nor accepts
  signed/public URLs, key files, API keys, or credential JSON.
- PostgreSQL checks cover migration health, transaction and lease fencing,
  replay/idempotency, message preferences, event/cascade/rate-window behavior,
  ASR/TTS/media generations, deletion outbox, retention, deletion races, and
  restart recovery.
- Cleanup is fail closed. Evidence can be handed off only after the functional
  GCS prefix is proved empty, the UUID schema is proved absent, and all opened
  providers are closed. Pre-existing scopes are never acquired, swept, or
  dropped. Once absence was proved and acquisition began, cleanup also discovers
  and removes a prefix/schema create that committed before its transport failed.

## Frozen release and handoff interface

Required immutable-image inputs:

- CLI `--release-sha=<lowercase 40-hex>`
- `V1_RELEASE_COMMIT_SHA=<same lowercase 40-hex>`
- `V1_RELEASE_MANIFEST_FILE=/app/release-manifest.json`
- exact manifest schema
  `{schemaVersion:1,releaseSha,sourceArchiveSha256,sourcePath:'git-archive:production-v1'}`
- `V1_DEPENDENCY_ACCEPTANCE_OUTPUT_OBJECT=release-evidence/<release-sha>/dependency-acceptance/<lowercase-v4-uuid>.json`

The CLI value, environment value, output path, and manifest release SHA must
match. The script never consults `.git` or a mutable/latest reference.

The GCS handoff is create-only and then read back at the exact generation. Full
canonical JSON never appears on stdout. The safe receipt contains only object
name, generation, semantic artifact digest, exact object-byte digest, checks,
and cleanup proof. If upload commits but later verification fails, the script
discovers that exact generation, deletes it with a generation precondition,
proves the object absent, and permits a clean rerun. An ambiguous upload error
may delete only bytes that exactly match the intended object digest.

## Evidence schema and digest semantics

The canonical dependency record is compatible with
`validateDependencyAcceptanceEvidence` and `validateReleaseEvidenceBundle` and
contains only:

`schemaVersion`, `commitSha`, `legacyInventoryDigest`, `postgresResourceId`,
`postgresIdentitySha256`, `gcsResourceId`, `gcsIdentitySha256`, `schema`,
`gcsPrefix`, `checks`, `schemaAbsent`, `gcsPrefixObjectCount`, `result`,
`occurredAt`, and `artifactSha256`.

Two deliberately different digests are proved independently:

- `artifactSha256`: semantic canonical-record digest, calculated by the shared
  release-evidence contract while excluding the self-referential field.
- `objectSha256`: SHA-256 of the exact pretty-printed JSON bytes plus trailing
  newline uploaded to and read back from GCS.

The script and tests never require these digests to be equal. The release
operator must verify both after downloading the exact object generation.

## TDD evidence

Initial focused RED:

```text
node --test tests/real-dependency-acceptance.test.js
27 tests: 16 pass, 11 fail, exit 1
```

Additional RED checkpoints added before their implementations:

```text
immutable release SHA interface: 51 tests, 27 pass, 24 fail, exit 1
manifest/output/dual-database interface: 67 tests, 39 pass, 28 fail, exit 1
metadata identity interface: import-time failure because the export was absent
bounded metadata body: exposed a null-signal/Web-stream compatibility defect
```

Independent review then returned five Important blockers. Each was reproduced
before its implementation:

```text
ambiguous prefix/schema create RED: 76 tests, 74 pass, 2 fail, exit 1
generation-fenced evidence compensation RED: 77 tests, 76 pass, 1 fail, exit 1
Storage ADC/bucket ownership RED: 81 tests, 76 pass, 5 reported failures, exit 1
oversized metadata pre-read cap RED: 82 tests, 81 pass, 1 fail, exit 1
decoded-password separation RED: 84 tests, 81 pass, 3 reported failures, exit 1
```

Each RED was resolved without weakening the fail-closed assertions. The final
focused run was:

```text
node --test tests/real-dependency-acceptance.test.js
84 tests: 84 pass, 0 fail, 0 skip, exit 0
duration 297 ms
```

Relevant PostgreSQL/GCS/storage/readiness contract suite:

```text
node --test tests/real-dependency-acceptance.test.js tests/readiness.test.js tests/postgres-contract.test.js tests/gcs-media-store.test.js tests/storage-runtime.test.js
216 tests: 215 pass, 0 fail, 1 approved real-PostgreSQL skip, exit 0
duration 1.09 s
```

Repository full suite:

```text
npm.cmd test
1334 tests: 1333 pass, 0 fail, 1 approved real-PostgreSQL skip, exit 0
duration 5.80 s
```

Static verification:

```text
node --check scripts/real-dependencies-acceptance.js
exit 0

npm.cmd run check
exit 0

git diff --check -- production-v1/scripts/real-dependencies-acceptance.js production-v1/tests/real-dependency-acceptance.test.js
exit 0 (line-ending warnings only)
```

The focused, combined readiness, and repository full suites all passed after
Task 7C's shared fixtures stabilized.

## Residual live boundary

The one skipped adjacent test requires an approved isolated real PostgreSQL
database. All tests in this report use injected/fake providers and therefore do
not constitute real Cloud SQL, GCS IAM, metadata-service, cleanup, image, Job,
or Secret Manager evidence. Promotion must remain closed until the live Job and
the independent download/hash/delete/zero-residue verification succeed.

Commit identity is reported separately after the scoped commit is created; a
commit cannot embed its own final hash without changing that hash.
