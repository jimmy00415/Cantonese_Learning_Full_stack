# Task 7A report — immutable release artifact and deployment contract

Date: 2026-08-26

## Outcome

Task 7A is implemented locally in the isolated `production-v1` worktree. The
change defines a deterministic, dry-run-first release contract but performs no
GCP build, provisioning, migration, Job execution, deployment, IAM mutation,
traffic change, rollback, or QR generation.

The image contract now includes only the governed HKBU corpus and the exact
runtime scripts required by migration and preboot acceptance. Cloud Build is
bound to the reviewed custom build identity and a digest-pinned official Docker
builder. A clean 40-hex commit is archived deterministically, recorded in the
immutable image manifest, and carried through digest-pinned migration,
acceptance, evidence, candidate, promotion, and rollback phases.

## TDD evidence

Initial focused RED:

```text
node --test tests/release-contract.test.js tests/migration-runner.test.js
5 tests: 3 pass, 2 fail, 0 skip, exit 1
- scripts/image-release-contract.js was absent
- migration discovery accepted an unexpected SQL file
```

The GCS acceptance review later required the dependency Job to attest the
bucket project number. A second focused RED was recorded before adding the
smallest exact permission boundary:

```text
node --test tests/gcp-infra-contract.test.js
1 file-level test: 0 pass, 1 fail, exit 1
SyntaxError: gcp-provision.js did not export assertExactCustomRoleDefinitions
```

The resulting fixed project custom role is
`hkbuddyAcceptanceBucketMetadataReader`, stage `GA`, with exactly
`storage.buckets.get`. It is bound only on
`hkbuddy-prod-v1-20260826-media` to `hkbuddy-acceptance`. Provisioning,
pre-sensitive audit, and final readback reject missing, deleted, extra,
permission-drifted, or stage-drifted role definitions. The CLI flag contract was
cross-checked against the current official
[gcloud custom-role command](https://docs.cloud.google.com/sdk/gcloud/reference/iam/roles/create).

Focused GREEN:

```text
node --test tests/release-contract.test.js
16 tests: 16 pass, 0 fail, 0 skip, exit 0

node --test tests/gcp-infra-contract.test.js
148 tests: 148 pass, 0 fail, 0 skip, exit 0

node --test tests/gcp-infra-contract.test.js tests/release-contract.test.js tests/migration-runner.test.js
168 tests: 168 pass, 0 fail, 0 skip, exit 0
```

One integration RED in the combined run was the expected old exact-role fixture:
167/168 passed and the remaining assertion omitted the newly required custom
role. Updating that single exact allowlist produced the 168/168 result above.

The later Task 7C integration run exposed an intermittent archive-determinism
RED. Re-running it with a fixture commit whose timestamp was fixed in the past
made the failure deterministic:

```text
node --test tests/release-contract.test.js
15 pass, 1 fail, exit 1
git archive members must inherit the immutable release commit timestamp
actual 1787697078; expected 1704067200
```

The root cause was that `<release SHA>:production-v1` resolves to a Git tree,
whose archive member mtime defaults to the execution clock. The production fix
reads and validates the immutable commit `%ct` and supplies it through
`git archive --mtime=@<commit timestamp>`. The unchanged byte-level archive
assertions now pass, including 12 consecutive focused runs.

After the separately reviewed dependency-security gate landed, its release
integration was also driven RED before implementation:

```text
node --test tests/release-contract.test.js
16 tests: 14 pass, 2 fail, 0 skip, exit 1
- the new dependency gate step was absent from Cloud Build
- the final Build receipt rejected the expected gate step
```

Cloud Build now performs a fresh production-only install, runs
`npm run --silent security:dependencies`, validates the exact eight-field
`DEPENDENCY_SECURITY_EXCEPTION_REVIEWED` PASS receipt without logging it, and
only then starts the image build. The release receipt fails closed when that
step is missing or not successful. Focused GREEN returned to 16/16; the combined
7A plus dependency-gate suite passed 216/216, and the parsed YAML step order is
`validate-release-sha`, `dependency-security-gate`, `build`,
`verify-image-contract`, `verify-oci-labels`.

After the independently reviewed gate follow-up and Task 7C's dev-only FFmpeg
tooling landed, the same final combined suite passed 236/236. A clean isolated
`npm ci --omit=dev --ignore-scripts --no-audit` installed 193 production
packages, returned the exact gate PASS receipt, included `mpg123-decoder`, and
proved `@ffmpeg-installer/ffmpeg` absent. The temporary install directory was
validated under the system temp root, removed recursively, and rechecked with
zero residue.

## Implemented contract

- `.dockerignore` and `Dockerfile` allowlist only the governed corpus and exact
  runtime scripts. `/app/release-manifest.json` binds schema version, clean
  release SHA, source-archive SHA-256, and `git-archive:production-v1`.
- The image-release validator loads the real default corpus and rejects absent
  corpus, unrelated data, reports, or scripts.
- The release archive binds every member mtime to the immutable release commit,
  is deterministic and gzip-stable, remains outside the repository, and is
  clean-worktree gated and exact-SHA confirmed.
- Cloud Build uses the reviewed `hkbuddy-build` service account, a
  digest-pinned official Docker builder, verified provenance, OCI revision and
  source labels, image/corpus validation, one successful Build ID, source hash,
  and final image digest readback. Its image step cannot start until the fresh
  production dependency install and exact time-boxed security-gate receipt pass;
  the final Build receipt also requires that gate step to be successful.
- Release phases are separately confirmed and ordered as `build`, `migration`,
  `inventory`, `acceptance`, `collect`, `evidence`, `candidate`, and `promote`;
  `rollback` is separate. Every workload image is digest-pinned.
- Migration discovery accepts only one contiguous, self-recording versioned SQL
  set and rejects every unexpected or malformed `.sql` file.
- Dependency acceptance runs as `hkbuddy-acceptance`; LLM/ASR/TTS smoke Jobs run
  as the exact serving `hkbuddy-runtime` identity. Job definitions and attached
  identities are read back before execution.
- Private acceptance JSON is written create-only under the release/run prefix,
  described and downloaded at one exact numeric generation, independently
  checked for semantic artifact SHA-256 and exact object-byte SHA-256, published
  and read back as one planned numeric Secret version, deleted generation-exact,
  and followed by a zero-residue listing.
- Candidate deployment is zero-traffic, digest-pinned, numeric-secret pinned,
  and uses only DB/session environment secrets; evidence is mounted as absolute
  read-only files. Service, revision, IAM, artifact digest, image, identity,
  environment, mounts, probes, resources, VPC, and traffic are exact readbacks.
- Startup and readiness use `/api/health/ready`; liveness remains
  `/api/health/live`. Promotion requires the reviewed owner identity and exact
  public IAM/traffic readback for `hkbuddy-api`; rollback requires exact prior
  revision traffic readback.
- The deployer receives only the reviewed release operations, exact
  service-account-scoped `actAs`, and evidence-secret version publishing. It
  does not receive `roles/run.admin`. Buckets, secrets, and service accounts
  remain private.
- The binding budget is HKD 2300 monthly with actual 50/80/100 percent and
  forecast 100 percent alerts; the stale USD 300 draft is removed.

## Fresh verification

```text
npm.cmd ci --ignore-scripts --no-audit
196 packages installed from package-lock.json, exit 0

npm.cmd run --silent security:dependencies
status=passed; code=DEPENDENCY_SECURITY_EXCEPTION_REVIEWED; exit 0

node --test tests/gcp-infra-contract.test.js tests/release-contract.test.js tests/migration-runner.test.js tests/dependency-security-gate.test.js
236 tests: 236 pass, 0 fail, 0 skip, exit 0

npm.cmd test
1431 tests: 1430 pass, 0 fail, 1 approved real-PostgreSQL skip, exit 0
duration 13.71 s

npm.cmd run check
exit 0

node --check scripts/gcp-release.js
node --check scripts/image-release-contract.js
node --check scripts/create-image-release-manifest.js
node --check scripts/gcp-provision.js
node --check scripts/run-migrations.js
all exit 0

git diff --check
exit 0 (line-ending warnings only)

node -e '<run focused archive contract 12 times>'
12/12 runs green, exit 0

isolated npm ci --omit=dev --ignore-scripts --no-audit
193 production packages; security gate PASS;
@ffmpeg-installer/ffmpeg absent; mpg123-decoder present; zero temp residue

parse cloudbuild.yaml and assert exact ordered step/waitFor contract
exit 0
```

The exact pinned `mpg123-decoder@1.0.3` introduced by Task 7C is installed and
covered by the full-suite result. The exact dev-only
`@ffmpeg-installer/ffmpeg@1.1.0` is excluded from the production install. A
local Docker build was not claimed or run because this workstation has no
Docker CLI; the real verified Cloud Build and in-image contract execution
remain a live release prerequisite.

## Files changed

- `docs/superpowers/plans/2026-08-26-production-v1-gcp-launch.md`
- `docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md`
- `.superpowers/sdd/2026-08-26-production-v1-gcp-launch/task-7a-report.md`
- `production-v1/.dockerignore`
- `production-v1/Dockerfile`
- `production-v1/cloudbuild.yaml`
- `production-v1/infra/gcp/README.md`
- `production-v1/infra/gcp/resource-contract.json`
- `production-v1/scripts/create-image-release-manifest.js`
- `production-v1/scripts/gcp-provision.js`
- `production-v1/scripts/gcp-release.js`
- `production-v1/scripts/image-release-contract.js`
- `production-v1/scripts/run-migrations.js`
- `production-v1/tests/gcp-infra-contract.test.js`
- `production-v1/tests/migration-runner.test.js`
- `production-v1/tests/release-contract.test.js`

No package, runtime config, HTTP security, provider, latency, voice, or real GCS
acceptance source file was edited by Task 7A.

## Residual live prerequisites

1. Complete independent review of the combined Task 7 changes, fix any blocking
   finding through a new failing regression, and freeze the resulting clean
   40-hex SHA.
2. Run the confirmed preflight/provision contract with the reviewed owner and a
   verified numeric Monitoring email channel; read back the exact custom role,
   IAM, private network, Cloud SQL, bucket, secrets, alerts, and budget.
3. Create the deterministic release archive outside the repository, submit the
   real Cloud Build, and capture verified provenance plus the immutable digest.
4. Run the digest-pinned migration and acceptance Jobs, retrieve exact GCS
   generations, validate and publish numeric evidence versions, then delete and
   prove zero release-output residue.
5. Deploy and validate the zero-traffic candidate, run the remaining real/mobile
   latency and iOS evidence gates, and promote only after all frozen-SHA evidence
   is green.
6. Generate and decode-verify the final QR only after the stable promoted HTTPS
   URL exists. No final URL or QR exists from this local task.
