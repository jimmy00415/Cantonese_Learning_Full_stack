# Hong Kong Buddy Production V1 — Agent Handoff

> Snapshot date: 2026-09-01
> Resume branch: `feat/production-v1-ai-senior`
> Last verified implementation commit: `a69613e693eb5bcefde8866c97950023d8333d41`
> On the new computer, treat `git rev-parse HEAD` as the authoritative checkout SHA.

## Objective

Finish Production V1 as a text-and-voice, WeChat/WhatsApp-style HKBU senior
tutor. Do not redesign it as a live phone call or 3D avatar. The release must
provide accurate, source-backed campus answers, low-latency text/voice replies,
and English/Cantonese/Mandarin response choices.

## Current verdict

- Code is pushed and the worktree was clean at handoff.
- No Production V1 stable URL or QR code exists yet.
- The legacy Azure app `hkbuddy-pilot-0630` was not changed and is out of scope.
- The new bucket-IAM recovery is implemented and contract-tested, but has not
  been executed in GCP.
- Live cloud state below is the last confirmed snapshot, not fresh truth. Recheck
  it after browser OAuth on the new computer.

## Repository bootstrap

```powershell
git clone https://github.com/jimmy00415/Cantonese_Learning_Full_stack.git
cd Cantonese_Learning_Full_stack
git switch feat/production-v1-ai-senior
git pull --ff-only
cd production-v1
node --version  # must be Node.js 22 or newer
npm ci
npm run check
# Before this command, configure the exact controlled Task 8 D: harness from README.md.
npm test
npm run security:dependencies
git status --short
```

Full `npm test` includes a deliberately host-bound Task 8 browser-evidence
gate. Its exact controlled Windows `D:` Playwright/TEMP setup is documented in
`README.md`. A generic machine that cannot reproduce that harness must report
Task 8 as an outstanding external gate; never skip or weaken it and then claim
a full-suite PASS.

Last verified results on the source computer:

- Full tests: 2638 passed, 0 failed, 1 skipped.
- GCP infrastructure contract: 802/802.
- Release contract: 142/142.
- JavaScript syntax checks: 63/63.
- Dependency security gate: passed under the reviewed exception expiring
  2026-09-26.
- Staged secret scan: no OAuth code, API key, private key, or alert code found.

## GCP boundary

- Project: `motion-expert-hk-ltd-webpage` (`582852715831`).
- Fixed human operator: `admin@motionexp.com`.
- Verified notification channel:
  `projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089`.
- Authenticate with browser OAuth. Do not copy the old gcloud directory, paste
  an OAuth verification code into a file, create credential JSON, use an access
  token file, or enable impersonation.

Create a separate Cloud SDK configuration and authenticate:

```powershell
$env:CLOUDSDK_CONFIG = Join-Path $env:LOCALAPPDATA 'gcloud-hkbuddy-production-v1'
New-Item -ItemType Directory -Force -Path $env:CLOUDSDK_CONFIG | Out-Null
gcloud auth login admin@motionexp.com
gcloud config set account admin@motionexp.com
gcloud config set project motion-expert-hk-ltd-webpage
gcloud auth list --filter=status:ACTIVE
gcloud config get-value project
```

## Last confirmed live state

- Budget/alerts, Artifact Registry, five service accounts, custom acceptance
  role, VPC/subnet/PSA, private HA PostgreSQL 16, database, two V1 buckets, and
  ten empty Secret containers existed.
- The latest provision run stopped with `POST_CREATE_READBACK_FAILED` at
  `bucket-iam-baseline` after the media-bucket policy write removed the
  operator's effective bucket-policy read/write access.
- The build-source bucket still retained its generated convenience bindings.
- No Secret version and no `hkbuddy_app` or `hkbuddy_migrator` database user had
  been created.
- No V1 Cloud Run Job, candidate service, stable service, public URL, or QR code
  existed.

## Exact resume sequence

1. Read `README.md`, `infra/gcp/README.md`, and
   `infra/gcp/resource-contract.json`; treat them as executable contracts.
2. Run the read-only preflight and retain its JSON. Before one-time recovery it
   may fail with `PREFLIGHT_INVENTORY_INVALID` at the known locked media-bucket
   read. That does not prove the remaining inventory passed.
3. Run only the exact confirmed provision command below. It may first create the
   narrow three-permission custom role and exact two-bucket conditioned binding,
   wait for propagation, and then restart the complete fail-closed audit.
4. If the result is unexpected, stop all mutation. Record `code`,
   `mutationPerformed`, `completed`, and `resumeBoundary`; investigate with
   read-only commands before retrying.

```powershell
npm run gcp:preflight -- --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089

npm run gcp:provision -- --confirm-project=motion-expert-hk-ltd-webpage --notification-channel=projects/motion-expert-hk-ltd-webpage/notificationChannels/5363602469320935089
```

If provisioning returns `OPERATOR_BUCKET_IAM_PROPAGATION_TIMEOUT`, preserve all
resources, wait, and rerun the same exact command. Never grant
`roles/storage.admin`, restore legacy convenience bindings, manually edit either
bucket policy, delete/recreate resources, or create credentials as a workaround.

## Remaining completion gates

After `GCP_PROVISION_COMPLETE`, continue the guarded release phases in
`infra/gcp/README.md`. Production is complete only after all of these pass:

- owner confirmation of the legacy-resource inventory;
- real iPhone Safari voice evidence;
- 30-file multilingual canonical-WAV latency evidence;
- private zero-traffic candidate acceptance;
- stable promotion with traffic/IAM/readiness/privacy readback;
- live text, voice, source citation, retention, and mobile acceptance.

Only then generate the public URL and QR code. Do not describe local tests,
planned hostnames, or a private candidate as a production release.

## Agent reporting contract

Lead every update with one of: `CODE_READY`, `GCP_PROVISIONED`,
`CANDIDATE_ACCEPTED`, `PRODUCTION_LIVE`, or `BLOCKED`. These states are not
interchangeable. Cite fresh command/readback evidence, keep secrets out of logs
and commits, preserve partial resources, and never weaken a fail-closed gate to
make the run appear green.
