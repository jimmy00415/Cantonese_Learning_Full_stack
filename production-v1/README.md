# Hong Kong Buddy Production V1

Production V1 is a mobile-first, text-primary HKBU senior chat. Voice behaves like
a WeChat/WhatsApp voice message: the student records, reviews the transcript, and
sends it as one normal chat message. The assistant may generate an optional voice
reply only after an explicit tap; text remains canonical and audio never autoplays.

This directory is isolated from the legacy application. It has its own runtime,
storage drivers, release evidence, reports, and deployment boundary. Do not point
it at the legacy app, legacy PostgreSQL database, or legacy Blob container.

## Local product preview

From `production-v1/`:

```powershell
$env:ENV_FILE='..\backend\.env'
npm.cmd start
```

The local default origin is `http://localhost:3000`. Set `V1_PUBLIC_ORIGIN` when
using another port or a LAN IP. Local mode uses the atomic JSON store and local
private media directory. It is a product preview, not a campus-distribution or
production-readiness result.

Useful local checks:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run readiness
```

Local readiness intentionally exits nonzero with the boundary
`local-preview-only`. It must never be reported as production-ready.

## Production topology and runtime gate

V1 runs as one new application replica behind HTTPS:

- Node/Express serves the chat UI, API, dispatcher, and SSE updates.
- A new PostgreSQL resource stores sessions, conversations, turns, event replay,
  quotas, media ownership, deletion outbox, and durable worker state.
- The private `hkbuddy-prod-v1-20260826-media` GCS bucket stores opaque
  voice/TTS attempt objects with uniform bucket-level access and public-access
  prevention.
- The reviewed HKBU corpus in `data/knowledge/hkbu-v1.json` is the grounding
  boundary; only allowlisted official HKBU sources can support verified claims.
- One real LLM provider is required. ASR and TTS are separately configured and
  separately release-evidenced capabilities.
- The GCP release selectors are `vertex-ai`, `google-stt-v2`, and `google-tts`.
  All three share Application Default Credentials from the attached Cloud Run
  runtime service account. API keys, access-token settings, credential JSON,
  and credential-file paths are rejected.

Production does not listen on a port until the first retention run succeeds and
all six live checks are ready: database, private media, corpus, retention,
dispatcher, and single-instance runtime. Configuration and release evidence are
validated before opening PostgreSQL or GCS. The LLM smoke artifact is also
validated before startup and re-read on every readiness evaluation; readiness
never calls the provider. There is no production fallback to the local drivers
or deterministic model.

After startup, one low-frequency single-flight watchdog owns live dependency
evaluation. A red result pauses turn dispatch and rejects every state-changing
API request with `503`; a later green result resumes both. Public
`GET /api/health/ready` serves only the watchdog's sanitized cache, so repeated
public probes never create PostgreSQL or GCS traffic.

## Production setting names

Store secrets only in the new app's secret manager/environment. Never commit
values. The production boundary uses these setting names:

- HTTP/runtime: `NODE_ENV`, `PORT`, `V1_PUBLIC_ORIGIN`, `V1_SESSION_SECRET`,
  `V1_TRUST_PROXY_HOPS`, `V1_INSTANCE_POLICY`
- PostgreSQL: `V1_STORE_DRIVER`, `V1_DATABASE_URL`,
  `V1_POSTGRES_RESOURCE_ID`
- private GCS: `V1_MEDIA_DRIVER=gcs`,
  `V1_GOOGLE_CLOUD_PROJECT=hkbuddy-prod-v1-20260826`,
  `V1_GCS_BUCKET=hkbuddy-prod-v1-20260826-media`, and
  `V1_GCS_RESOURCE_ID=//storage.googleapis.com/projects/_/buckets/hkbuddy-prod-v1-20260826-media`;
  authentication is attached-service-account ADC only
- model: `V1_LLM_PROVIDER`, `V1_LLM_CREDENTIAL_VERSION`, plus the selected
  provider's complete V1-prefixed credential, endpoint, model/deployment,
  API-version, and request-profile set
- speech: `V1_ASR_PROVIDER`, `V1_TTS_PROVIDER` and the selected provider's
  complete credentials/settings and credential-rotation version
- policy: `V1_PRIVACY_NOTICE_VERSION`, `V1_PRIVACY_NOTICE_APPROVED`,
  `V1_RETENTION_WORKER_ENABLED`
- frozen release: `V1_RELEASE_COMMIT_SHA`
- legacy isolation: `V1_LEGACY_RESOURCE_INVENTORY_FILE`,
  `V1_LEGACY_RESOURCE_INVENTORY_VERSION`,
  `V1_LEGACY_RESOURCE_INVENTORY_APPROVED`
- real dependency evidence: `V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE`,
  `V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION`
- LLM evidence: `V1_LLM_SMOKE_EVIDENCE_FILE`,
  `V1_LLM_SMOKE_EVIDENCE_VERSION`
- voice evidence: `V1_ASR_SMOKE_EVIDENCE_FILE`,
  `V1_ASR_SMOKE_EVIDENCE_VERSION`, `V1_TTS_SMOKE_EVIDENCE_FILE`,
  `V1_TTS_SMOKE_EVIDENCE_VERSION`, `V1_IOS_VOICE_ACCEPTANCE_FILE`,
  `V1_IOS_VOICE_ACCEPTANCE_VERSION`

Production database and Blob selection accepts only V1-prefixed settings.
Production LLM selection follows the same V1-only rule. Unprefixed settings are
local-compatibility inputs and cannot satisfy production. Dependency init,
readiness, startup, PostgreSQL connection, query, and statement waits also have
bounded `V1_*_TIMEOUT_MS` settings documented in `.env.example`; the readiness
watchdog interval is configured separately with
`V1_READINESS_WATCHDOG_INTERVAL_MS`.

For the Google release, configure `V1_GOOGLE_CLOUD_PROJECT` as
`hkbuddy-prod-v1-20260826`, `V1_VERTEX_LOCATION=global`, and
`V1_VERTEX_MODEL=gemini-2.5-flash`. STT is fixed to `chirp_2` through the `_`
recognizer in `asia-southeast1`. TTS uses the regional
`asia-southeast1` endpoint and exactly one evidenced Chirp 3 HD Achernar voice
for each supported locale: `en-US`, `yue-HK`, and `cmn-CN`. Unsupported reply
languages are rejected; there is no hidden runtime voice fallback. Rotate the
non-secret `V1_GOOGLE_CREDENTIAL_VERSION` label whenever attached service-account
authority changes. Tokens, prompts, transcripts, audio, and upstream bodies are
never evidence fields.

## Frozen release and guarded evidence

Freeze and review a clean commit before any real gate. `V1_RELEASE_COMMIT_SHA`
must equal that clean `HEAD` before and after every acceptance run.

1. Obtain an owner-reviewed safe legacy manifest. Do not infer an empty legacy
   inventory from missing environment variables.

   ```powershell
   npm.cmd run acceptance:legacy-inventory -- --manifest <absolute-owner-reviewed-safe-json> --confirm-owner-reviewed-legacy-resources
   ```

2. Configure only the approved new V1 PostgreSQL/Blob resources plus the
   `V1_ACCEPTANCE_*` settings. The acceptance schema and Blob prefix must contain
   the same fresh UUID. Then run:

   ```powershell
   npm.cmd run acceptance:dependencies
   ```

   The command is blocked unless every identity/confirmation gate passes. It
   creates only the UUID-scoped schema/prefix and proves both are absent again in
   `finally`. Never run it against an existing app or an unreviewed resource.

3. Apply and verify the complete migration set as a separate one-shot command
   against only the approved new V1 database:

   ```powershell
   npm.cmd run migrate
   ```

   Application startup never runs migrations and refuses a database without
   every expected migration version.

4. Run the separately guarded LLM, ASR, TTS, and real-iPhone acceptance against
   the frozen candidate. A configured provider is not a verified capability.
   The LLM smoke requires strict V1 provider settings, a lowercase frozen commit
   SHA, and the exact real-provider confirmation:

   ```powershell
   npm.cmd run smoke:provider -- --confirm-real-provider
   ```

   Bind the resulting immutable `reports/llm/` artifact through
   `V1_LLM_SMOKE_EVIDENCE_FILE` and its artifact digest through
   `V1_LLM_SMOKE_EVIDENCE_VERSION`. Runtime startup and every readiness check
   validate that file against the frozen commit, provider, effective non-secret
   configuration, and credential-rotation version without making another
   provider request. The evidence expires after seven days and permits at most
   five minutes of future clock skew. It is a release attestation, not a claim
   that the upstream provider is live at every later instant.

5. With an explicitly approved new candidate and non-sensitive canonical WAV
   manifest:

   ```powershell
   $env:V1_LOAD_TEST_CONFIRM='true'
   npm.cmd run acceptance:latency -- --candidate-origin <new-https-origin> --asr-manifest <absolute-safe-json> --confirm-approved-candidate
   ```

   This fixed workload is 200 text turns across 20 sessions at concurrency 5,
   30 ASR samples across 10/30/55-second buckets, and 30 TTS requests. A fake or
   local run is not SLO evidence.

6. Run `npm.cmd run readiness`. In production this starts the complete live
   runtime on an ephemeral loopback port, revalidates every dependency/evidence
   gate, reports only safe statuses/versions, and closes the probe runtime.

All generated evidence under `reports/` is ignored, immutable, artifact-hashed,
and bound to the frozen commit. It must not contain credentials, message text,
transcripts, audio, provider bodies, private URLs, or raw errors.

## Retention, deletion, backups, and corpus review

- Anonymous guest sessions are purged after 30 days without message, event, or
  voice-upload activity. This is an inactivity window, not a per-message maximum;
  an active guest session retains its earlier conversation until the session has
  been inactive for the full window or the user clears it.
- Voice/TTS media: 7 days.
- Expired rate-limit buckets are removed by the same fenced retention run.
- Explicit conversation deletion revokes ownership first and queues GCS deletion
  durably; failed physical deletion remains retryable.
- The retention worker records durable heartbeat/success state. A stopped or stale
  worker makes readiness fail.
- Run `npm.cmd run cleanup:retention` only in a fully evidenced production V1
  environment and never beside the live singleton. It uses the same retention
  service and storage boundary, then durably marks its one-shot worker stopped.
- Configure encrypted PostgreSQL backups and recovery testing for the new V1
  resource. GCS is temporary media, not the source of conversational truth.
- Review every corpus claim at its stated cadence, update source attestations, and
  ship corpus changes through a new frozen release. Overdue/conflicted/unknown
  information must be disclosed rather than invented.

Student email authentication is deliberately deferred. Anonymous secure-session
cookies are V1's current identity boundary; do not describe them as student SSO.

## Deployment and rollback boundary

`Dockerfile` pins the Node 22 OCI base, installs production packages with
`npm ci` from `package-lock.json`, copies only runtime, migration, and public
assets, and runs as the unprivileged `node` user on port 8080. Local Docker is
not required for this tranche. Build the frozen source later with Cloud Build:

```powershell
gcloud.cmd builds submit --project=hkbuddy-prod-v1-20260826 --config=cloudbuild.yaml --substitutions=_RELEASE_SHA=<lowercase-40-hex-sha> .
```

The build rejects a noncanonical SHA and publishes only
`asia-east2-docker.pkg.dev/hkbuddy-prod-v1-20260826/hkbuddy/hkbuddy-api:<sha>`.
Run `npm.cmd run migrate` as a separate one-shot job; it is never part of
`CMD` or application startup.

Deploy only as a new application with new resource identities, DNS/hostname, and
secret scope. Start with exactly one replica. Promote traffic only after privacy,
real provider, iOS voice, dependency, retention, readiness, and latency gates all
pass for the same frozen commit.

Rollback routes traffic away from the new V1 application or restores its previous
frozen release. Do not edit, restart, redeploy, migrate, or repoint
`hkbuddy-pilot-0630` as part of V1 rollback. No old app deployment or
configuration is changed by these procedures.
