# Hong Kong Buddy Production V1 GCP Launch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` to execute this plan task-by-task. Use `superpowers:test-driven-development` for every behavior change, `superpowers:systematic-debugging` for unexpected failures, and `superpowers:verification-before-completion` before any release claim.

**Goal:** Deploy an isolated, production-gated Hong Kong Buddy V1 on Google Cloud that feels like messaging a capable HKBU senior, answers from reviewed official evidence, and supports English, Cantonese, and Mandarin text plus asynchronous voice messages.

**Architecture:** Preserve the tested Node/Express modular monolith, PostgreSQL transaction model, durable dispatcher, SSE replay, strict citation validator, and privacy lifecycle. Add Google ADC-backed Vertex AI, Speech-to-Text V2, Text-to-Speech, and private Cloud Storage adapters. Run one warm Cloud Run instance in Hong Kong against a new Cloud SQL database and new GCS bucket. Every campus fact remains governed by the bundled reviewed corpus; monitoring can propose changes but never promote them automatically.

**Tech Stack:** Node.js 22 ESM, Express 5, PostgreSQL 16, Google Cloud Run, Cloud SQL, Cloud Storage, Secret Manager, Artifact Registry, Cloud Build, Vertex AI Gemini 2.5 Flash, Speech-to-Text V2 Chirp 2, Text-to-Speech, vanilla HTML/CSS/JavaScript, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-26-production-v1-gcp-launch-design.md`

## Global constraints

- Work only in `.worktrees/production-v1-ai-senior` on `feat/production-v1-ai-senior`.
- Do not modify or deploy `frontend/`, `backend/`, `backend/public/`, the legacy Azure workflow, `hkbuddy-pilot-0630`, legacy DNS, databases, or Blob containers.
- Use only project `hkbuddy-prod-v1-20260826`; pass `--project` and the isolated Cloud SDK configuration on every mutating GCP command.
- Never print, commit, or persist access tokens, database passwords, session secrets, prompts, transcripts, audio, or raw provider bodies.
- Use Application Default Credentials from the attached Cloud Run service account. Do not create service-account keys or accept `GOOGLE_API_KEY`.
- Preserve fail-closed readiness. A missing or stale provider, storage, iOS voice, latency, or frozen-SHA evidence gate stays visibly red.
- Text delivery is canonical. TTS failure never delays, removes, or mutates the grounded text answer. Audio never autoplays.
- Reply settings are immutable per accepted message and part of its idempotency hash.
- Implement behavior through red-green-refactor and commit each coherent green task.
- Keep Cloud Run at exactly one minimum and one maximum instance until shared event fan-out replaces the in-process acceleration path.

## Task 1: Add Google authentication and provider contracts

**Files:**

- Modify: `production-v1/package.json`
- Modify: `production-v1/package-lock.json`
- Modify: `production-v1/src/config.js`
- Create: `production-v1/src/providers/google-auth.js`
- Modify: `production-v1/src/providers/llm.js`
- Modify: `production-v1/src/providers/asr.js`
- Modify: `production-v1/src/providers/tts.js`
- Modify: `production-v1/src/services/release-evidence.js`
- Modify: `production-v1/src/services/voice-evidence.js`
- Modify: `production-v1/src/server.js`
- Modify: `production-v1/.env.example`
- Modify: `production-v1/README.md`
- Modify: `production-v1/tests/config-shell.test.js`
- Modify: `production-v1/tests/provider-contracts.test.js`
- Modify: `production-v1/tests/llm-evidence.test.js`
- Modify: `production-v1/tests/voice-evidence.test.js`
- Modify: `production-v1/tests/readiness.test.js`
- Modify: `production-v1/tests/server-readiness.test.js`

- [ ] **Step 1: Write failing Google configuration and adapter tests.** Require production-only V1-prefixed settings, reject API-key authentication, validate project/location/model/recognizer/language/voice values, and prove access tokens and upstream bodies cannot enter safe errors or evidence.
- [ ] **Step 2: Run the focused red tests.**

  ```powershell
  node --test tests/config-shell.test.js tests/provider-contracts.test.js tests/llm-evidence.test.js tests/voice-evidence.test.js
  ```

  Expected: FAIL on the missing Google selectors, auth adapter, request contracts, and evidence descriptors.

- [ ] **Step 3: Implement `createGoogleAccessTokenProvider`.** Use `google-auth-library` with the cloud-platform scope, injectable auth in tests, bounded token caching, and sanitized failures. Never log or return the token outside the request adapter.
- [ ] **Step 4: Implement Vertex AI.** Add provider `vertex-ai`; call the `generateContent` REST route for `gemini-2.5-flash`, preserve the existing bounded context/deadline/retry policy, parse only candidate text plus normalized usage metadata, and leave the strict one-object answer parser unchanged.
- [ ] **Step 5: Implement Google speech.** Add `google-stt-v2` for synchronous canonical WAV recognition in `asia-southeast1`, and `google-tts` for locale-mapped MP3 synthesis. Bind selected voices and the no-hidden-fallback policy to evidence. Reject unsupported locales instead of guessing.
- [ ] **Step 6: Extend immutable release evidence and readiness.** Add Google non-secret configuration digests, frozen commit binding, credential rotation labels, and exact provider allowlists. Missing, stale, future-dated, or mismatched evidence must remain not-ready without making a provider call.
- [ ] **Step 7: Verify green.**

  ```powershell
  npm.cmd install
  node --test tests/config-shell.test.js tests/provider-contracts.test.js tests/llm-evidence.test.js tests/voice-evidence.test.js tests/readiness.test.js tests/server-readiness.test.js
  npm.cmd run check
  ```

- [ ] **Step 8: Commit.** `feat(v1): add GCP AI provider contracts`

## Task 2: Add private GCS media storage and reproducible container delivery

**Files:**

- Create: `production-v1/src/stores/gcs-media-store.js`
- Modify: `production-v1/src/services/storage-runtime.js`
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/src/services/release-evidence.js`
- Modify: `production-v1/src/server.js`
- Modify: `production-v1/package.json`
- Modify: `production-v1/package-lock.json`
- Create: `production-v1/Dockerfile`
- Create: `production-v1/.dockerignore`
- Create: `production-v1/cloudbuild.yaml`
- Create: `production-v1/scripts/run-migrations.js`
- Modify: `production-v1/.env.example`
- Modify: `production-v1/README.md`
- Create: `production-v1/tests/gcs-media-store.test.js`
- Modify: `production-v1/tests/storage-runtime.test.js`
- Modify: `production-v1/tests/voice-media.test.js`
- Modify: `production-v1/tests/config-shell.test.js`
- Modify: `production-v1/tests/llm-evidence.test.js`

- [ ] **Step 1: Write failing GCS contract tests.** Reuse the shared media lifecycle matrix and add exact tests for opaque keys, range reads, bounded downloads, private access, prefix pagination, deletion, health checks, error normalization, and GCS resource identity digests.
- [ ] **Step 2: Run the focused red tests.**

  ```powershell
  node --test tests/gcs-media-store.test.js tests/storage-runtime.test.js tests/voice-media.test.js tests/config-shell.test.js
  ```

  Expected: FAIL because `gcs` is not an available production media driver.

- [ ] **Step 3: Implement the GCS adapter.** Use `@google-cloud/storage` with ADC, Uniform Bucket-Level Access assumptions, no public or signed URL, bounded streams, conditional writes where the existing attempt contract requires them, and safe provider errors.
- [ ] **Step 4: Replace the production storage requirement.** Production must require `postgres + gcs`, `V1_GCS_BUCKET`, and an exact GCS resource ID. Local preview remains `atomic-file + local`; there is no production fallback to Azure aliases.
- [ ] **Step 5: Add the container and migration path.** Build as an unprivileged Node 22 image, install production dependencies from the lockfile, copy only the V1 runtime, expose port 8080, and add a one-shot migration command that verifies every expected migration version before exit.
- [ ] **Step 6: Verify green and image contents.**

  ```powershell
  node --test tests/gcs-media-store.test.js tests/storage-runtime.test.js tests/voice-media.test.js tests/config-shell.test.js tests/llm-evidence.test.js
  npm.cmd test
  npm.cmd run check
  ```

  Expected: all automated tests pass; local readiness still reports preview rather than production.

- [ ] **Step 7: Commit.** `feat(v1): add private GCP storage runtime`

## Task 3: Make reply language and voice format immutable end to end

**Files:**

- Modify: `production-v1/migrations/001_initial.sql`
- Modify: `production-v1/src/http/session.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/stores/postgres-store.js`
- Modify: `production-v1/src/services/turn-processor.js`
- Modify: `production-v1/src/services/answer.js`
- Modify: `production-v1/src/services/voice.js`
- Modify: `production-v1/src/providers/tts.js`
- Modify: `production-v1/public/chat-state.js`
- Modify: `production-v1/public/chat-controller.js`
- Modify: `production-v1/public/voice-message-controller.js`
- Modify: `production-v1/public/assistant-audio-controller.js`
- Modify: `production-v1/tests/postgres-contract.test.js`
- Modify: `production-v1/tests/atomic-store.test.js`
- Modify: `production-v1/tests/turn-api.test.js`
- Modify: `production-v1/tests/chat-state.test.js`
- Modify: `production-v1/tests/chat-controller.test.js`
- Modify: `production-v1/tests/voice-message-controller.test.js`
- Modify: `production-v1/tests/answer.test.js`
- Modify: `production-v1/tests/assistant-audio-controller.test.js`

Wire enums are exactly `en | yue-Hant-HK | cmn-Hans-CN` and `text | voice`.

- [ ] **Step 1: Write failing persistence/API tests.** Reject unknown or missing production values, prove accepted values survive atomic restart and PostgreSQL round trips, include them in the idempotency hash, and prove a retry cannot adopt newer browser preferences.
- [ ] **Step 2: Write failing answer/voice tests.** Require locale-specific answer instructions and deterministic fallbacks, attach TTS automatically only for `voice`, retain visible text, and never invoke playback before a direct user action.
- [ ] **Step 3: Run the focused red tests.**

  ```powershell
  node --test tests/atomic-store.test.js tests/postgres-contract.test.js tests/turn-api.test.js tests/chat-state.test.js tests/chat-controller.test.js tests/answer.test.js tests/voice-message-controller.test.js tests/assistant-audio-controller.test.js
  ```

- [ ] **Step 4: Implement the immutable message contract.** Store reply language and mode on the user message and turn, return them in safe API DTOs, and carry them through dispatcher claims and retries. Existing snapshots receive the explicit defaults `en` and `text` during validation/migration.
- [ ] **Step 5: Implement language-constrained generation.** Add trusted instructions for concise international English, natural written Cantonese in Traditional Chinese, or Mandarin in Simplified Chinese. Deterministic grounded fallbacks select the same locale and never translate URLs, office names, or unsupported facts.
- [ ] **Step 6: Implement asynchronous voice replies.** Deliver text first, enqueue the existing fenced TTS generation for `voice`, expose pending/ready/unavailable states, and keep manual `Play voice` as the only path that calls `HTMLMediaElement.play()`.
- [ ] **Step 7: Verify green.** Run the focused set, then `npm.cmd test` and `npm.cmd run check`.
- [ ] **Step 8: Commit.** `feat(v1): add multilingual reply preferences`

## Task 4: Polish the 390px messaging UX

**Files:**

- Modify: `production-v1/public/index.html`
- Modify: `production-v1/public/styles.css`
- Modify: `production-v1/public/app.js`
- Modify: `production-v1/public/chat-copy.js`
- Modify: `production-v1/public/message-renderer.js`
- Modify: `production-v1/public/timeline-view.js`
- Modify: `production-v1/tests/ui-contract.test.js`
- Modify: `production-v1/tests/chat-copy.test.js`
- Modify: `production-v1/tests/message-renderer.test.js`
- Modify: `production-v1/tests/timeline-view.test.js`
- Modify: `production-v1/tests/starter-prompts.test.js`
- Modify: `production-v1/tests/assistant-audio-actions.test.js`

- [ ] **Step 1: Write failing semantic/UI tests.** Require the compact AI identity, language chip, accessible reply sheet, explicit text/voice selection, localized starter prompts, compact source disclosure, purposeful unknown-answer handoff, 44px controls, visible focus, reduced motion, safe-area composer, and no call/online/read-receipt affordances.
- [ ] **Step 2: Run the focused red tests.**

  ```powershell
  node --test tests/ui-contract.test.js tests/chat-copy.test.js tests/message-renderer.test.js tests/timeline-view.test.js tests/starter-prompts.test.js tests/assistant-audio-actions.test.js
  ```

- [ ] **Step 3: Implement the reply sheet and persistence.** Header shows `Hong Kong Buddy` and `Your HKBU AI senior`; the chip opens native-accessible controls for `English`, `廣東話`, `普通話`, `Text`, and `Voice message`. Store only the anonymous session preference and restore focus to the opener.
- [ ] **Step 4: Improve answer presentation.** Keep direct answer text first, collapse multiple official links under `Sources (n)`, show freshness without jargon, display `AI voice ready` with `Play voice`, and render a category-relevant official handoff only when supplied by the server.
- [ ] **Step 5: Tighten mobile layout and copy.** Preserve the warm cream/white system, Simplify attribution, readable 16px text, high contrast, 44px hit targets, keyboard navigation, and one fixed composer without horizontal overflow at 390x844.
- [ ] **Step 6: Verify green.** Run the focused tests, full tests, and syntax checks.
- [ ] **Step 7: Commit.** `feat(v1): refine mobile AI senior chat`

## Task 5: Expand and regression-test the governed HKBU knowledge base

**Files:**

- Modify: `production-v1/src/knowledge/corpus.js`
- Modify: `production-v1/src/knowledge/retriever.js`
- Modify: `production-v1/src/services/answer.js`
- Create: `production-v1/scripts/knowledge-diff.js`
- Modify: `production-v1/tests/knowledge.test.js`
- Modify: `production-v1/tests/answer.test.js`
- Create: `production-v1/tests/knowledge-acceptance.test.js`
- Modify: `production-v1/README.md`

- [ ] **Step 1: Review only current first-party sources.** Capture fresh evidence for accommodation/halls, facilities, international-student services, dining, campus locations/transport, language-learning routes, and category-specific official directories. Record owner office, locator, effective window, volatility, review cadence, and attestation. Do not scrape or promote uncontrolled web content.
- [ ] **Step 2: Write the 40-case failing acceptance matrix.** Cover student cards, accounts/Duo, residences, dining, AR/campus locations, transport, international support, language learning, living-supplies abstention, medical/safety, stale/conflicted claims, and category-relevant unknown fallbacks in all three reply languages.
- [ ] **Step 3: Run red.**

  ```powershell
  node --test tests/knowledge.test.js tests/answer.test.js tests/knowledge-acceptance.test.js
  ```

- [ ] **Step 4: Add the smallest reviewed claims and routing changes.** Claims remain atomic and source-bound. Living supplies remain `Not confirmed` unless an approved primary source exists. Remove the global Academic Registry fallback; the retriever returns a relevant directory or no link.
- [ ] **Step 5: Add a monitor-only diff command.** It may fetch allowlisted URLs and emit safe hashes/change candidates, but it cannot edit or promote the corpus. Network failure, conflict, or expiry makes evidence stale/unverified.
- [ ] **Step 6: Verify green.** Run knowledge tests, the full suite, syntax checks, and inspect the generated safe source/claim/category counts.
- [ ] **Step 7: Commit.** `feat(v1): expand governed HKBU guidance`

## Task 6: Create the isolated GCP project and production resources

**Files:**

- Create: `production-v1/infra/gcp/resource-contract.json`
- Create: `production-v1/infra/gcp/README.md`
- Create: `production-v1/scripts/gcp-preflight.js`
- Create: `production-v1/scripts/gcp-provision.js`
- Create: `production-v1/tests/gcp-infra-contract.test.js`
- Modify: `production-v1/package.json`

- [ ] **Step 1: Write failing infrastructure-contract tests.** Require the exact new project/resource identities, org/billing binding, API list, least-privilege service accounts, Hong Kong runtime/storage/database locations, Singapore STT boundary, one-instance cap, no public bucket member, Secret Manager numeric versions, backups/PITR/deletion protection, monitoring alerts, and USD 300 budget thresholds.
- [ ] **Step 2: Implement safe preflight and provisioning commands.** Default is read-only dry-run. Mutation requires `--confirm-project=hkbuddy-prod-v1-20260826`; every command passes the project explicitly, is idempotent/read-before-write, emits no secret values, and refuses any legacy project/resource identity.
- [ ] **Step 3: Verify local infrastructure contracts.**

  ```powershell
  node --test tests/gcp-infra-contract.test.js
  npm.cmd run gcp:preflight
  npm.cmd run check
  ```

- [ ] **Step 4: Create and bill the isolated project.** Create `hkbuddy-prod-v1-20260826` under organization `797368190621`, link billing account `01F9FD-24EA9B-A9232C`, and enable only the documented APIs.
- [ ] **Step 5: Create the production topology.** Create Artifact Registry, runtime/build identities, VPC/subnet/private service access, Cloud SQL PostgreSQL 16 with HA/backups/PITR/deletion protection, the private GCS bucket with UBLA/PAP/lifecycle, secret containers, monitoring policies, and the monthly budget. Generate session/database secrets in memory and add them as numeric Secret Manager versions without printing them.
- [ ] **Step 6: Read back every control.** Export only non-secret safe metadata, verify IAM contains no broad runtime role, bucket has no public binding, SQL has the intended availability/private connectivity, and no command referenced a legacy resource.
- [ ] **Step 7: Commit.** `chore(v1): codify isolated GCP production`

## Task 7: Freeze, build, migrate, and deploy the candidate

**Files:**

- Create: `production-v1/docs/release-verification-2026-08-26.md`
- Modify source only when a demonstrated defect has a failing regression test first.

- [ ] **Step 1: Run implementation review.** Use `superpowers:requesting-code-review` over the complete spec-to-branch diff. Fix every blocking finding through TDD and repeat review until clear.
- [ ] **Step 2: Run the complete local ladder.**

  ```powershell
  npm.cmd test
  npm.cmd run check
  git diff --check
  git status --short
  ```

  Also verify the diff from the feature base contains no legacy runtime/deployment file, credential-like tracked value, generated report, or `.env`.

- [ ] **Step 3: Freeze a clean SHA.** Commit the reviewed verification document, rerun the ladder, and record the clean 40-hex HEAD as `V1_RELEASE_COMMIT_SHA`. Any later source change invalidates provider and deployment evidence.
- [ ] **Step 4: Build one immutable image.** Use Cloud Build and Artifact Registry; tag by the full frozen SHA and capture the immutable image digest. Do not build from an uncommitted directory.
- [ ] **Step 5: Run migration through an isolated job.** Mount the numeric database secret version, connect through the intended VPC/Cloud SQL path, apply and verify migration 001, then remove the job execution. Never expose the database publicly or print its URL.
- [ ] **Step 6: Deploy a zero-traffic candidate.** Attach the runtime service account, exact Cloud SQL/GCS/AI settings, numeric secret/evidence versions, one-instance cap, always-allocated CPU, startup/liveness probes, and frozen image digest. The public app receives no traffic until readiness is green.
- [ ] **Step 7: Commit only documentation that predates evidence.** After the candidate exists, no tracked mutation is allowed; generated real-gate reports remain ignored and bind to the frozen SHA.

## Task 8: Run real gates, mobile QA, promotion, and handoff

**Files:**

- Generated ignored evidence only under `production-v1/reports/`.
- Create the final QR PNG from the promoted HTTPS URL outside tracked source.

- [ ] **Step 1: Run one guarded real smoke per provider.** On the frozen SHA, exercise Vertex AI, one non-sensitive canonical-WAV STT sample per supported language, and one short TTS sample per selected voice. Evidence contains only provider/config digests, result, latency, timestamp, request identifier hash, and artifact hash.
- [ ] **Step 2: Run real dependency acceptance.** Use a UUID-scoped schema and object prefix on the new Cloud SQL/GCS resources, prove transaction/lease/replay/idempotency/media/outbox/retention behavior, and prove cleanup reaches zero before accepting the report.
- [ ] **Step 3: Run readiness and workload gates.** Require `/api/health/live=200`, `/api/health/ready=200`, 200 text turns across 20 sessions at concurrency five, multilingual ASR/TTS samples, no duplicates/loss, and every latency/grounding SLO from the spec. A failed paid smoke is diagnosed before any repeat.
- [ ] **Step 4: Run same-viewport mobile QA.** In the in-app browser at 390x844, verify first visit, language/mode changes, text send, editable voice transcript, ready-but-not-autoplaying audio, verified sources, unknown-answer handoff, retry/reload, consent, clear conversation, keyboard focus, safe areas, and no horizontal overflow. Capture fresh screenshots from the deployed candidate.
- [ ] **Step 5: Promote once.** Route 100% traffic to the evidenced revision only after all gates pass. Read back the service URL, traffic split, revision, image digest, min/max instances, IAM, SQL, bucket, alerts, and budget. If any post-promotion gate fails, move traffic to the last known-good V1 revision or to zero; never route to legacy.
- [ ] **Step 6: Generate and verify the QR code.** Encode the exact promoted HTTPS URL, decode-test it locally, and render it with the live link in the handoff.
- [ ] **Step 7: Final verification.** Use `superpowers:verification-before-completion`; report implementation, runtime health, knowledge freshness, speech capability, measured latency, cost guard, and any honest readiness limitation separately.

## Definition of done

- The live Cloud Run URL opens the isolated V1 and no legacy resource was changed.
- English, Cantonese, and Mandarin preferences are explicit and immutable per message.
- Text and optional non-autoplay voice replies work on a 390px mobile viewport.
- Governed questions cite current official evidence; unsupported questions do not guess or link an unrelated office.
- PostgreSQL, private media lifecycle, provider evidence, readiness, security, retention, and workload gates pass on the same frozen SHA/resource identities.
- The final handoff includes the live HTTPS link and a decode-verified QR code.
