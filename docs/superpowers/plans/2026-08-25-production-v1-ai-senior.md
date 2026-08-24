# Hong Kong Buddy Production V1 AI Senior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an isolated, mobile-first Hong Kong Buddy Production V1 that behaves like a persistent AI senior chat, answers HKBU questions from reviewed official evidence, supports editable voice messages and opt-in voice replies, and exposes honest production-readiness boundaries.

**Architecture:** Create a new `production-v1/` modular monolith that serves one static chat UI and a versioned Express API. An anonymous HttpOnly session owns one conversation. Accepted messages are persisted before asynchronous, per-conversation processing. A bounded HKBU retriever supplies claim-level evidence to normalized LLM adapters; the application validates citations and falls back conservatively. Local preview uses serialized atomic-file/local-media adapters, while production readiness requires PostgreSQL and Azure Blob-compatible object storage.

**Tech Stack:** Node.js 22+, ESM, Express, Node test runner, PostgreSQL (`pg`), Azure Blob SDK, vanilla HTML/CSS/JavaScript PWA, Server-Sent Events, existing HKBU/Azure OpenAI/MiniMax/Azure Speech configuration.

**Spec:** `docs/superpowers/specs/2026-08-25-production-v1-ai-senior-design.md`

## Global Constraints

- Work only in `.worktrees/production-v1-ai-senior` on `feat/production-v1-ai-senior`.
- Create all runtime product files under `production-v1/`; do not modify legacy `frontend/`, `backend/`, `backend/public/`, their deployment workflow, or their ignored `.env`.
- Read existing secrets only through an explicit `ENV_FILE`; never print values or add them to tracked files.
- Use `apply_patch` for source/document edits and `npm.cmd` on this Windows host.
- Follow red-green-refactor for every behavior task; record the failing test before implementation.
- Text delivery is canonical; voice never autoplays and TTS failure never blocks or mutates the text answer.
- A campus claim is `verified` only when the delivered message contains at least one current allowlisted official source that directly supports it.
- No fake online/seen/typing state, no claim that the assistant is human, and no mode/scenario UI.
- Production readiness must fail with local storage, deterministic model mode, missing secret/origin, or unavailable production providers.
- Production V1 runs one replica; durable dispatcher leases close restart/crash
  windows, while multi-instance capacity is a later promotion decision.
- A green production report requires real isolated PostgreSQL and private Blob
  lifecycle acceptance plus the defined production-candidate latency workload.
- Do not merge, push, deploy, create cloud resources, or change the old live site during this plan.

---

## Planned File Structure

```text
production-v1/
  package.json
  package-lock.json
  .gitignore
  .env.example
  README.md
  migrations/001_initial.sql
  data/knowledge/hkbu-v1.json
  public/
    index.html
    styles.css
    app.js
    manifest.webmanifest
    assets/ai-senior-avatar.svg
    assets/simplify-wordmark.svg
  src/
    app.js
    server.js
    config.js
    http/errors.js
    http/security.js
    http/session.js
    knowledge/corpus.js
    knowledge/retriever.js
    knowledge/safety.js
    providers/llm.js
    providers/asr.js
    providers/tts.js
    services/answer.js
    services/events.js
    services/dispatcher.js
    services/rate-limiter.js
    services/retention.js
    services/turn-processor.js
    telemetry/logger.js
    stores/atomic-file-store.js
    stores/postgres-store.js
    stores/local-media-store.js
    stores/azure-blob-media-store.js
    stores/store-contract.js
  scripts/provider-smoke.js
  scripts/production-readiness.js
  scripts/retention-cleanup.js
  scripts/real-dependencies-acceptance.js
  scripts/production-latency-workload.js
  tests/
    config-shell.test.js
    atomic-store.test.js
    session-api.test.js
    knowledge.test.js
    answer.test.js
    provider-contracts.test.js
    turn-api.test.js
    voice-media.test.js
    ui-contract.test.js
    postgres-contract.test.js
    security-rate-limit.test.js
    retention.test.js
    readiness.test.js
```

## Task 1: Scaffold the isolated runtime and one-screen shell

**Files:**

- Create: `production-v1/package.json`
- Create: `production-v1/.gitignore`
- Create: `production-v1/.env.example`
- Create: `production-v1/src/config.js`
- Create: `production-v1/src/app.js`
- Create: `production-v1/src/server.js`
- Create: `production-v1/src/http/security.js`
- Create: `production-v1/src/telemetry/logger.js`
- Create: `production-v1/public/index.html`
- Create: `production-v1/public/styles.css`
- Create: `production-v1/public/app.js`
- Create: `production-v1/tests/config-shell.test.js`

**Interfaces:**

- `loadConfig(env)` returns normalized, secret-safe runtime configuration.
- `createApp({ config, store, mediaStore, answerService, eventHub })` returns an Express app without listening.
- `startServer()` binds only from `server.js`.
- `GET /api/health/live` returns `{ data: { status: "ok", version }, error: null, requestId }`.

- [ ] **Step 1: Write the failing config and shell contract**

Create tests that require missing modules and assert:

```js
assert.equal(loadConfig({ NODE_ENV: 'test' }).storeDriver, 'atomic-file');
assert.equal(loadConfig({ NODE_ENV: 'test' }).productionReady, false);
assert.throws(() => loadConfig({ NODE_ENV: 'production' }), /V1_PUBLIC_ORIGIN/);
assert.match(html, /Campus AI Senior/);
assert.match(html, /AI assistant/);
assert.doesNotMatch(html, /MODE|SCENARIO|START MISSION/i);
```

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="config|shell"` from `production-v1/`.

Expected: FAIL because the package/modules/shell do not exist.

- [ ] **Step 3: Add the minimal package and configuration contract**

Use these scripts:

```json
{
  "start": "node src/server.js",
  "dev": "node --watch src/server.js",
  "test": "node --test tests/*.test.js",
  "check": "node --check src/server.js && node --check public/app.js",
  "smoke:provider": "node scripts/provider-smoke.js",
  "readiness": "node scripts/production-readiness.js"
}
```

Runtime dependencies: `express`, `dotenv`, `helmet`, `pg`, and
`@azure/storage-blob`. The strict V1 canonical-WAV parser is internal and does
not need general-purpose container sniffing/metadata packages; Task 5 removes
`file-type`/`music-metadata` if they were scaffolded earlier. Set `engines.node`
to `>=22` and `type` to `module`.

The nested `.gitignore` ignores `.env*` except `.env.example`, local data/media,
and reports, and explicitly re-includes `package-lock.json` so it overrides the
repository's broad lockfile ignore. `git check-ignore -q package-lock.json` must
return nonzero after generation; commit the lockfile normally, never by an
undocumented force-add.

`loadConfig` must support `ENV_FILE`, use V1-prefixed selectors before legacy
selectors, expose booleans rather than secret values in `publicStatus`, and fail
closed in production in this order: public origin, 32-byte session secret,
numeric trusted-proxy hops, PostgreSQL driver/URL, Azure Blob driver/config, real
LLM availability, `V1_INSTANCE_POLICY=single`, an approved
`V1_PRIVACY_NOTICE_VERSION` plus `V1_PRIVACY_NOTICE_APPROVED=true`, and
`V1_RETENTION_WORKER_ENABLED=true`. The exact proxy variable is
`V1_TRUST_PROXY_HOPS`; local defaults to 0, while production must set it
explicitly.

The logger accepts only an allowlist of operational fields (`requestId`, hashed
conversation ID, stage, provider, status class, latency, byte/token counts, safe
error code). Tests must prove it drops message text, transcript, prompt, cookie,
authorization, provider body, and key-like fields.

Configuration tests enumerate provider precedence and pairs exactly:

- `V1_LLM_PROVIDER` before `LLM_PROVIDER`; HKBU uses `HKBU_API_KEY` plus base
  URL/model/API version, Azure OpenAI requires key+endpoint+deployment/API
  version, and MiniMax requires key+base/Anthropic URL+model;
- `V1_ASR_PROVIDER` before `ASR_PROVIDER`; V1 supports only Azure, which requires
  speech key+validated region. A legacy/inherited MiniMax ASR selector must report
  configured/available false and never route because no V1 adapter is defined;
- `V1_TTS_PROVIDER` before `TTS_PROVIDER`; Azure requires speech key+region,
  MiniMax requires key+TTS model/voice;
- incomplete voice pairs disable only their capability, while an incomplete
  selected production LLM fails readiness.

- [ ] **Step 4: Add the minimal single-chat shell and liveness app**

The HTML contains only `app-header`, `message-list`, `turn-status`, `composer`,
and `assistant-info` sheet landmarks. Use a disabled composer until session
bootstrap; do not add legacy navigation. `createApp` adds request IDs, Helmet,
same-origin JSON handling, explicit Origin validation hooks, explicit numeric
trusted-proxy configuration, static serving, safe errors, and liveness.

- [ ] **Step 5: Install and verify green**

Run:

```powershell
npm.cmd install
npm.cmd test -- --test-name-pattern="config|shell"
npm.cmd run check
```

Expected: focused tests and syntax checks PASS with no secret values in output.

- [ ] **Step 6: Commit**

Commit message: `feat(v1): scaffold isolated AI senior runtime`

## Task 2: Build durable sessions, messages, idempotency, and backfill

**Files:**

- Create: `production-v1/src/stores/store-contract.js`
- Create: `production-v1/src/stores/atomic-file-store.js`
- Create: `production-v1/src/http/session.js`
- Create: `production-v1/src/http/errors.js`
- Create: `production-v1/src/services/rate-limiter.js`
- Modify: `production-v1/src/app.js`
- Create: `production-v1/tests/atomic-store.test.js`
- Create: `production-v1/tests/session-api.test.js`
- Create: `production-v1/tests/security-rate-limit.test.js`

**Interfaces:**

```js
store.init()
store.createOrResumeSession({ tokenHash, now })
store.getSessionByTokenHash(tokenHash)
store.acceptMessage({ sessionId, conversationId, clientMessageId, requestHash, text, voiceDraftId, now })
store.listMessages({ sessionId, conversationId, after })
store.getActiveTurn({ sessionId, conversationId })
store.setTurnState({ turnId, state, failureCode, now })
store.deliverAssistant({ turnId, message, now })
store.deleteSession({ sessionId })
store.listRecoverableTurns()
store.listEvents({ sessionId, conversationId, afterCursor })
store.consumeRateLimit({ subjectHash, quota, windowStart, limit, expiresAt })
```

The session cookie is `hb_v1_session`; only its SHA-256 hash is stored. The raw
32-byte random token is HttpOnly, SameSite=Lax, Secure in production, and never
returned in JSON. Each session also stores a separate random, non-authorizing
`clientScopeId`; bootstrap returns it as `clientSessionScope` solely to bind and
purge private client-side pending operations without exposing or inspecting the
HttpOnly cookie.

- [ ] **Step 1: Write failing repository and HTTP tests**

Test a temporary data directory for:

- first session creates exactly one conversation;
- resume with the same token hash returns the same IDs;
- bootstrap with the same cookie returns the same `clientSessionScope`; a new or
  replaced cookie returns a different scope, and possession of a scope alone
  authorizes no route;
- a message creates `sequence=1`, an `accepted` turn, idempotency record, and
  persisted accepted event transactionally;
- retry with identical `clientMessageId` and payload returns the same records;
- retry with the same ID but different request hash throws `IDEMPOTENCY_CONFLICT`;
- two sends sequence monotonically;
- reopening the atomic store preserves acknowledged records and event cursors;
- `GET /messages?after=1` returns only later messages;
- deleting the session removes owned data and clears the cookie;
- another cookie cannot access messages/media metadata.
- missing or cross-site `Origin` on every write returns 403
  `ORIGIN_NOT_ALLOWED`; exact configured Origin succeeds;
- bootstrap rate limiting uses an HMACed client-IP subject from explicitly
  configured proxy hops, while chat/voice/TTS quotas use an HMACed session ID;
- default chat quotas enforce 30/5 minutes and 300/day, return 429
  `RATE_LIMITED`, and include a correct `Retry-After` without logging raw IP or
  session token.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="atomic store|session api|security|rate limit"`.

Expected: FAIL because store/session routes are absent.

- [ ] **Step 3: Implement the serialized atomic-file adapter**

Persist one versioned JSON snapshot with `sessions`, `conversations`, `messages`,
`turns`, `events`, `mediaAssets`, `rateLimitBuckets`, and `serviceState`.
Serialize mutations through one promise chain. For
each acknowledged mutation, write a same-directory temporary file, fsync it,
rename it atomically, and then update the in-memory snapshot. Validate the schema
version on startup and reject corrupt state rather than replacing it.

Add `requestHash` and `leaseExpiresAt` to turns. Events receive a durable,
per-conversation monotonic cursor. All ownership checks happen inside the store,
not only in routes.

- [ ] **Step 4: Implement session, send, list, and delete routes**

Use envelope responses. `POST /api/v1/session` creates/resumes and returns the
stable non-secret `clientSessionScope`; `POST
/api/v1/messages` validates a UUID client ID, trimmed text 1-4000 chars, and
returns 202; `GET /api/v1/messages` returns messages plus active turn; `DELETE
/api/v1/session` cascades data and clears the cookie. Apply Origin checks before
cookie-authenticated mutations and durable quota consumption before expensive or
state-changing work. Do not start generation yet.

- [ ] **Step 5: Verify green and restart durability**

Run:

```powershell
npm.cmd test -- --test-name-pattern="atomic store|session api|security|rate limit"
npm.cmd test
```

Expected: focused and cumulative suites PASS.

- [ ] **Step 6: Commit**

Commit message: `feat(v1): persist anonymous conversations and turns`

## Task 3: Add the reviewed HKBU corpus, retrieval, freshness, and safety routing

**Files:**

- Create: `production-v1/data/knowledge/hkbu-v1.json`
- Create: `production-v1/src/knowledge/corpus.js`
- Create: `production-v1/src/knowledge/retriever.js`
- Create: `production-v1/src/knowledge/safety.js`
- Create: `production-v1/tests/knowledge.test.js`

**Official source set verified 2026-08-25:**

- `https://ar.hkbu.edu.hk/student-services/new-student-orientation/student-card-collection-schedule`
- `https://ar.hkbu.edu.hk/student-services/useful-information/student-e-card`
- `https://ar.hkbu.edu.hk/student-services/student-record/replacement-of-student-card`
- `https://ito.hkbu.edu.hk/services/account-password.html`
- `https://ito.hkbu.edu.hk/services/it-security/mfa.html`
- `https://ito.hkbu.edu.hk/contact-us.html`
- `https://sa.hkbu.edu.hk/en/accm/on-campus-accommodation/village-care/check-in-procedures.html`
- `https://sa.hkbu.edu.hk/en/accm/on-campus-accommodation/student-residence-halls/check-in-procedures.html`
- `https://eo.hkbu.edu.hk/eo-services/campus-map.html`
- `https://ar.hkbu.edu.hk/about-ar/contact-us`
- `https://library.hkbu.edu.hk/using-the-library/opening-hours/regular-service-hours/`
- `https://eo.hkbu.edu.hk/eo-services/services-facilities/Catering-Services.html`
- `https://eo.hkbu.edu.hk/eo-services/services-facilities/Catering-Services/Main-Canteen.html`
- `https://eo.hkbu.edu.hk/eo-services/services-facilities/Catering-Services/BU-Fiesta.html`
- `https://eo.hkbu.edu.hk/eo-services/services-facilities/medical-services.html`
- `https://sa.hkbu.edu.hk/en/contact-us.html`
- `https://sa.hkbu.edu.hk/en/cdc/counselling/counselling-and-consultation.html`
- `https://sa.hkbu.edu.hk/en/cdc/counselling/emergency-hotlines-and-community-services.html`
- `https://eo.hkbu.edu.hk/eo-services/services-facilities/Security-Control-Rooms-and-Security-Hotline.html`

- [ ] **Step 1: Write failing corpus and retrieval tests**

Tests must reject non-HTTPS, non-HKBU canonical source domains, hostname
lookalikes, URL credentials, missing source locators, verified claims without
review metadata, invalid validity windows, and duplicate IDs across source,
claim, and action namespaces.
They must assert these representative outcomes at `now=2026-08-25T12:00:00+08:00`:

```js
retrieve('Duo 换手机怎么办').topSourceId === 'hkbu.ito.duo'
retrieve('BU Fiesta 今日开吗').claims[0].status === 'verified'
retrieve('BU Fiesta 今日开吗').claims[0].facts.open === false
retrieve('图书馆今天几点关门').needsClarification === true
retrieve('图书馆今天几点关门').ambiguityCodes.includes('LIBRARY_BRANCH_REQUIRED')
routeSafety('有人受伤流很多血').kind === 'emergency'
```

Also assert that BU Fiesta is closed for renovation until further notice, the
Village CARE/Residence 2026 schedule claims do not inherit stale 2025/26 text,
and an expired high-volatility claim cannot yield `verified`. Add emergency
cases in English, Traditional Chinese, and Simplified Chinese for immediate
injury, fire, self-harm, and violence, plus near-miss non-emergencies that must
not trigger the bypass.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="knowledge"`.

Expected: FAIL because corpus and retrieval modules are absent.

- [ ] **Step 3: Create claim-level bilingual corpus**

Cover 12 intent groups: student card/e-Card, account/password, Duo, IT help,
residence check-in, campus/AR navigation, library, dining, medical, OSA/counselling,
transport, and emergency. Each atomic claim contains:

```json
{
  "id": "claim-id",
  "text": { "en": "...", "zhHant": "...", "zhHans": "..." },
  "sourceId": "source-id",
  "sourceLocator": "section/table label",
  "verifiedAt": "2026-08-25T12:00:00+08:00",
  "validFrom": null,
  "validUntil": null,
  "reviewAfter": "2026-09-25T23:59:59+08:00",
  "volatility": "monthly",
  "verificationStatus": "official_verified"
}
```

Never store passwords/passcodes. Add crisis facts for 999 and HKBU Security
3411 7777. Mark timetable, fee, opening-hours, and 2026/27 check-in claims with
short review windows.

The claim `id` is also its model-facing evidence ID; page-level `sourceId` alone
can never justify verified grounding. Each claim also stores a concise
paraphrased `evidenceNote`, exact `sourceLocator`, and `reviewAttestation`
(`reviewer`, `reviewedAt`, `sourceLocator`, `captureMethod`, and `sourceHash`). A
hash, when present, must be the SHA-256 of the normalized captured evidence
fragment; manual review may use `sourceHash: null` and must never invent a
placeholder. Add a corpus-level owner/review cadence record. Tests prove a claim
cannot be `official_verified` without this evidence trail.

Interpret all retrieval time through an injected clock in `Asia/Hong_Kong`.
Freshness status is one of `verified`, `review_overdue`, `expired`,
`not_yet_valid`, `conflicted`, or `unverified`; only `verified` enters
`supportableClaims`. Page update time never overrides a stale sibling claim.

- [ ] **Step 4: Implement deterministic bilingual retrieval and safety bypass**

Normalize with Unicode NFKC, remove zero-width characters, normalize full-width
punctuation/whitespace and `JC³`/`JC3`, use whole-word Latin matching, and use a
curated Cantonese/Traditional/Simplified alias set for intents and building
codes. Score exact intents/tags before token overlap with a stable tie-break.
Return only currently supportable claims; return expired/conflict metadata
separately. Branch- or cohort-dependent questions (for example library hours or
residence check-in) return a clarification instead of guessing. Safety routing
runs before normal retrieval and covers injury, fire, immediate self-harm, and
violence in English, Traditional Chinese, and Simplified Chinese. Near misses
such as `Duo emergency access code`, `firewall login problem`, drills, figurative
English, and non-urgent Health Centre questions must not trigger the bypass.

- [ ] **Step 5: Verify green**

Run `npm.cmd test -- --test-name-pattern="knowledge"` and then `npm.cmd test`.

- [ ] **Step 6: Commit**

Commit message: `feat(v1): add verified HKBU campus knowledge`

## Task 4: Add normalized LLM adapters, grounded answer validation, turn queue, and SSE

**Files:**

- Create: `production-v1/src/providers/llm.js`
- Create: `production-v1/src/services/answer.js`
- Create: `production-v1/src/services/events.js`
- Create: `production-v1/src/services/dispatcher.js`
- Create: `production-v1/src/services/turn-processor.js`
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/.env.example`
- Modify: `production-v1/src/stores/store-contract.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/app.js`
- Modify: `production-v1/src/server.js`
- Modify: `production-v1/src/http/session.js`
- Create: `production-v1/tests/provider-contracts.test.js`
- Create: `production-v1/tests/answer.test.js`
- Create: `production-v1/tests/turn-api.test.js`
- Create: `production-v1/scripts/provider-smoke.js`

**Normalized provider result:**

```js
{
  rawText,
  provider,
  latencyMs,
  usage,
  finishReason,
  providerRequestId
}
```

`answerService` alone parses `rawText` into a strict `ModelDraft` containing
`replyText`, `evidenceIds`, `actionIds`, `suggestedReplies`,
`needsClarification`, and `groundingStatus`, then derives cards from the corpus.

- [ ] **Step 1: Write failing provider, answer, ordering, and SSE tests**

Use injected fake `fetch` and a temporary store. Cover:

- HKBU/Azure OpenAI request URL/header/body shape without logging key values;
- MiniMax Anthropic-compatible request/response normalization;
- one 12-second total deadline across fetch, bounded response-body read, and at
  most one transient retry with the exact same serialized body, turn ID, and
  evidence snapshot; no retry for auth, invalid schema, refusal, or content
  filter;
- response bodies over 256 KiB and provider truncation/content-filter finish
  reasons fail safely;
- fenced/extra-text JSON parsing and invalid schema rejection;
- a string-aware brace scanner accepts at most one object and rejects multiple
  objects, truncation, legacy `citationIds`, extra properties, or oversized
  fields/arrays;
- unknown evidence/action IDs rejected;
- `verified` downgraded when no current claim-level evidence supports it;
- deterministic evidence summary on provider failure;
- honest unverified response when retrieval is insufficient;
- two accepted messages on one conversation deliver in order;
- duplicate client ID creates one assistant message;
- SSE assigns monotonic durable cursors and replays strictly after the query
  cursor on first connect. On native EventSource reconnect, a valid numeric
  `Last-Event-ID` takes precedence over the unchanged bootstrap query; only a
  header lower than the query is rejected. Replay precedes live delivery and
  emits heartbeat, delivery, and safe failure codes;
- a backlog larger than two replay pages plus an event arriving during replay is
  delivered once, strictly ordered, with no cursor gap; simulated live-buffer
  overflow emits `resync_required` and reconnect from the last delivered cursor
  drains the remainder without loss;
- restart recovery leases accepted/retrieving/generating turns once, and an
  expired lease can be reclaimed without producing a duplicate assistant reply.
- a simulated crash after persisted 202 but before any in-memory notification is
  discovered by the polling dispatcher;
- two dispatcher instances racing for the same turn result in one fencing token,
  and a stale token cannot renew, transition, or deliver;
- an earlier unfinished turn prevents a later turn in that conversation from
  being claimed, while another conversation can progress.
- turn 1 context excludes an already accepted turn 2 user message; turn 2
  context includes turn 1's delivered assistant reply even when persistence
  sequence is interleaved;
- a lease expiring during provider work prevents the stale worker from failing
  or delivering, renewal failure aborts the request, session deletion cannot be
  undone by a worker, and terminal failures remain visible after reload;
- duplicate/out-of-order live notifications, persisted-before-publish crash,
  close during replay, slow-client backpressure, heartbeat cursor neutrality,
  and listener cleanup after session deletion.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="provider|answer|turn api"`.

- [ ] **Step 3: Implement adapters and strict answer validation**

Support `hkbu`, `azure-openai`, and `minimax` from existing variable names plus
V1 overrides. Private `config.llm.settings` contains only the selected adapter's
settings; `publicStatus` remains booleans. Use AbortController with one shared
deadline. Do not include raw evidence as model instructions; wrap it as
untrusted reference data. Require strict JSON, cap output, and map only retrieved
claim-level evidence IDs and allowlisted action IDs into delivered UI data.
Never silently try a second configured provider.

The deterministic fallback must synthesize only selected claim text and source
metadata. It cannot invent procedures. Safety bypass returns deterministic
emergency guidance without calling the model.

- [ ] **Step 4: Implement per-conversation processing and SSE**

`POST /messages` may wake the dispatcher after the 202 response, but correctness
must not depend on that wake. The dispatcher continuously polls durable accepted
turns and atomically calls:

```js
store.claimNextTurn({ workerId, leaseToken, leaseUntil, now })
store.renewTurnLease({ turnId, leaseToken, leaseUntil, now })
store.setTurnState({ turnId, leaseToken, state, now })
store.getTurnContext({ turnId })
store.failTurn({ turnId, leaseToken, failureCode, now })
store.deliverAssistant({ turnId, leaseToken, message, now })
store.getEventHighWater({ sessionId, conversationId })
store.listEventsPage({ sessionId, conversationId, afterCursor, throughCursor, limit })
```

Claim only the earliest unfinished turn per conversation. Every worker mutation
checks the random fencing token and unexpired lease; a failed renewal aborts the
provider request. Delivery persists assistant message, terminal turn, and event
in one operation with a unique assistant-per-turn invariant. `getTurnContext`
uses turn order, not raw message sequence, so later accepted input cannot leak
into an earlier prompt. `GET /events` uses numeric `Last-Event-ID` when present
and otherwise uses `afterCursor`; it rejects only a header that rewinds below the
query cursor. It registers a bounded live buffer first,
captures the store's high-water cursor, drains all persisted pages through that
cursor, flushes buffered higher cursors in order with deduplication, and only
then switches to live. Notifications trigger a durable cursor drain rather than
being written directly. Each durable event's cursor is the SSE `id`. On buffer
overflow or socket backpressure it sends `resync_required` without an `id` and
closes; the client reconnects from its last delivered ID, so no page or live-race
event can be skipped. Send `retry: 3000`, 20-second heartbeat comments, and clean
listeners on close.

- [ ] **Step 5: Add a secret-safe real-provider smoke script**

The script does nothing unless `--confirm-real-provider` is supplied. It loads
`ENV_FILE`, calls only the selected provider once with a fixed low-token,
non-sensitive prompt and no retry/fallback, and prints provider, HTTP class,
normalized success, latency, and a stable error code only. It never prints
endpoint/model/prompt/body/header/raw error and exits nonzero before network if
no real provider is selected. Fake-fetch tests prove key values cannot reach
stdout/stderr. It is manual and never part of unit tests.

- [ ] **Step 6: Verify green**

Run focused tests, `npm.cmd test`, and `npm.cmd run check`.

- [ ] **Step 7: Commit**

Commit message: `feat(v1): deliver grounded queued AI senior replies`

## Task 5: Add owned voice drafts, Azure ASR, opt-in TTS, and media adapters

**Files:**

- Create: `production-v1/src/stores/local-media-store.js`
- Create: `production-v1/src/stores/azure-blob-media-store.js`
- Create: `production-v1/src/media/canonical-wav.js`
- Create: `production-v1/src/http/voice.js`
- Create: `production-v1/src/providers/asr.js`
- Create: `production-v1/src/providers/tts.js`
- Create: `production-v1/src/services/voice.js`
- Create: `production-v1/src/services/media-cleanup.js`
- Create: `production-v1/scripts/voice-provider-smoke.js`
- Modify: `production-v1/.env.example`
- Modify: `production-v1/package.json`
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/src/stores/store-contract.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/http/session.js`
- Modify: `production-v1/src/http/errors.js`
- Modify: `production-v1/src/services/rate-limiter.js`
- Modify: `production-v1/src/telemetry/logger.js`
- Modify: `production-v1/src/app.js`
- Modify: `production-v1/src/server.js`
- Create: `production-v1/tests/helpers/media-lifecycle-contract.js`
- Create: `production-v1/tests/voice-media.test.js`

**Interfaces:**

```js
store.claimVoiceUploadWithRateLimits({ sessionId, clientUploadId, requestSha256,
  mimeType, rateLimits, leaseToken, attemptStorageKey, leaseExpiresAt,
  attemptDeadlineAt, now })
store.renewVoiceUploadLease({ uploadId, leaseToken, leaseExpiresAt, now })
store.setVoiceUploadTranscribing({ uploadId, leaseToken, now })
store.getVoiceUploadStatus({ sessionId, clientUploadId })
store.completeVoiceUpload({ uploadId, leaseToken, mediaAsset, transcript, now })
store.failVoiceUpload({ uploadId, leaseToken, failureCode, failureHttpStatus,
  retryable, cleanupNotBefore, now })
store.claimAssistantAudioWithRateLimits({ sessionId, messageId, kind, rateLimits,
  leaseToken, attemptStorageKey, configVersion, leaseExpiresAt,
  attemptDeadlineAt, now })
store.renewMediaGenerationLease({ generationId, leaseToken, leaseExpiresAt, now })
store.getAssistantAudioStatus({ sessionId, messageId, kind })
store.completeMediaGeneration({ generationId, leaseToken, mediaAsset, now })
store.failMediaGeneration({ generationId, leaseToken, failureCode,
  failureHttpStatus, retryable, cleanupNotBefore, now })
store.revokeVoiceDraft({ sessionId, draftId, now, cleanupNotBefore })
store.revokeSessionAndEnqueueMedia({ sessionId, now, cleanupNotBefore })
store.enqueueMediaDeletion({ storageKey, reason, notBefore, now })
store.rearmMediaDeletionAfterWrite({ storageKey, reason, notBefore, now })
store.claimNextMediaDeletion({ workerId, leaseToken, leaseExpiresAt, now })
store.completeMediaDeletion({ jobId, generation, leaseToken, now })
store.failMediaDeletion({ jobId, generation, leaseToken, failureCode, retryAt, now })
store.isStorageKeyLive({ storageKey, now })
mediaStore.putAttempt({ storageKey, readable, maxBytes, signal })
mediaStore.open({ storageKey, start, end, signal })
mediaStore.delete({ storageKey, signal })
mediaStore.listAttemptKeys({ prefix, before, limit, cursor, signal })
```

Task 5 also closes the already-shipped session-scope dependency: bump the local
snapshot schema from 1 to 2, add a random unique `clientScopeId` to every new
session, and return it as non-authorizing `clientSessionScope` from both new and
resumed bootstrap responses. On startup, a fully valid schema-1 snapshot is
upgraded once by assigning every existing session a random scope and committing
the complete schema-2 snapshot through the same temporary-file/fsync/atomic-
rename path before serving; unknown or corrupt versions still fail closed.
The same bootstrap capabilities expose only two additional server-owned build
fields: `releaseCommitSha` (the configured 40-hex `V1_RELEASE_COMMIT_SHA`, or
`null` for an unfrozen local preview) and the exact constant
`normalizerContractVersion="canonical-wav-v1"`. A query parameter, request
body, cookie, or browser override can never set either field; tests prove no
credential/config detail is exposed with them.

The two `claim*WithRateLimit` operations return exactly one of
`claimed|ready|live|permanent_failure|conflict|rate_limited` and serialize active
session validation, ownership, idempotency, quota, attempt increment,
token/expiry, and attempt key. Only `claimed` authorizes body/provider work.
`permanent_failure` returns the stored safe code/status without another quota,
body, or provider attempt. Upload/generation services renew their
leases while reading the request, calling the provider, and writing media; abort,
lease loss, or client disconnect stops work and enters the same cleanup contract.
Renewal never extends `attemptDeadlineAt`. Voice request ingestion has a
30-second absolute and 10-second idle deadline; provider and media writes each
have 15-second deadlines. A new upload claim starts in truthful `uploading`
state and only a fenced transition after hash/WAV validation may change it to
`transcribing`. Ordinary deletion enqueue coalesces work that predates a delete;
every post-write fence loss instead calls `rearmMediaDeletionAfterWrite`, which
increments generation from any prior state and fences the old cleanup claim.
On expired/retryable reclaim, that same atomic mutation first moves any displaced
prior attempt key into the independent deletion outbox at a new generation with
`notBefore >= max(oldLeaseExpiry, oldHardDeadline, now) + 60s`, then replaces the
row key and consumes quota. A crash therefore leaves either the old row reference
or the new row plus durable old-key cleanup, never neither.

Every multi-window rate-limit mutation evaluates all buckets before changing any.
If one or more are exhausted, its `blockingExpiresAt` is the maximum exhausted
bucket expiry, not the first bucket; HTTP `Retry-After` is
`max(1, ceil((blockingExpiresAt-now)/1000))`. Quota/claim state is unchanged.
Task 5 applies this correction to existing chat `acceptMessageWithRateLimits` as
well as voice/TTS claims.

- [ ] **Step 1: Write failing voice/media tests**

Cover these contracts before implementation:

- Origin/session/header/declared-length/quota failure occurs before the request
  body is read; streaming aborts and cleans the private temporary object at 8
  MiB + 1. An injected slow/never-ending body hits the 10-second idle or
  30-second absolute deadline, cannot renew past `attemptDeadlineAt`, releases
  resources, and returns the stable 408 error.
- `X-Client-Upload-Id` UUID plus `X-Content-SHA256` create one durable upload.
  One newly claimed attempt calls ASR and consumes quota once; same-ID/same-hash
  live/ready retries make no additional call or quota mutation. A live
  status requires both lease and hard deadline. Expiry and only outcomes marked
  retryable by the exact taxonomy may make another upstream attempt with the
  exact same identity/bytes; every persisted non-retryable outcome returns its
  original safe status without quota/body/provider. Fencing permits exactly one
  durable result/attachment. Changed hash/MIME is 409 and cross-session
  ownership is isolated.
- Existing schema-1 local sessions receive unique stable scopes through the
  atomic migration; same-cookie bootstrap/restart returns the same scope, a new
  cookie gets a different scope, and presenting only a scope never authorizes
  messages/media. Migration interruption leaves either the valid old snapshot
  or the complete new one and is safely retryable.
- Bootstrap returns only the server-owned release SHA/null and
  `normalizerContractVersion="canonical-wav-v1"`; attempted client/query
  overrides do nothing, and the response exposes no credential, rotation ID,
  provider endpoint, evidence path, or storage setting.
- Exhaust short+daily chat, ASR, and TTS windows simultaneously; require
  `Retry-After` from the later daily expiry, no counter/claim mutation, and the
  same result regardless of bucket-array order.
- Only exact canonical PCM16LE WAV is accepted. Mutate every RIFF/WAVE format,
  channel/rate/bit-depth/byte-rate/block-align/length field; test trailing data,
  odd data, SHA mismatch, exactly 60,000 ms pass, and 60,001 ms fail. Browser
  duration/type claims are ignored.
- Validation/ASR failure removes temporary data; an owned ready draft is
  explicit-deleteable, cross-session/random IDs are 404, and `acceptMessage`
  atomically consumes a draft once while setting both asset owner and message
  media reference.
- Twenty concurrent TTS requests yield one durable `(assistantMessageId,
  assistant_voice)` generation/provider call. Test active-lease reuse, expired
  reclaim with explicit upstream at-least-once semantics, renewal, stale
  finalize/fail/event rejection, text survival, and quota only for a newly
  acquired generation claim. Inject a transaction midpoint failure and prove no
  quota/claim half-state; 429 must leave the claim unchanged.
- Azure ASR/TTS and MiniMax TTS fake transports assert HTTPS/no redirect, exact
  fixed language/voice/request fields, 15-second total deadline, zero retry,
  bounded responses, strict status/hex/size/magic validation, SSML escaping, and
  secret-safe logs.
- Table-drive every provider outcome from the design: no-match/silence/babble,
  auth/config rejection, other fixed 4xx/refusal, malformed/oversized/wrong-type
  2xx, network, upstream 408/429/5xx, and deadline. Assert exact public
  code/status/retryability and that a same-identity retry makes zero new claim,
  quota, body, or provider work for every non-retryable result while transient
  outcomes alone may reclaim.
- GET 200, each single Range form 206, invalid/multiple/overflow/unsatisfiable
  Range 416, and HEAD 200 ignoring Range. Authorized 200/206/416 have precise
  private/no-store, nosniff, length/range headers; cross-session 404 causes zero
  media-store reads and exposes no size/range metadata.
- Draft/session/expired-attempt deletion revokes access before enqueuing opaque
  object keys. Object-not-found succeeds, other Blob deletion failures remain
  retryable, stale cleanup workers cannot finalize, and temporary-prefix sweeping
  removes orphans.
- Persist the per-attempt key before body/provider work. Race session deletion at
  provider-return-before-write, write-before-attach, and delete-before-late-write;
  each ends with zero accessible/orphaned object. The prefix sweeper waits beyond
  lease + provider deadline + 60-second grace and never deletes a live-row key.
  In the exact cleanup race, let Blob deletion return success/not-found, write
  the same key before the old worker commits DB completion, call
  `rearmMediaDeletionAfterWrite`, reject the old generation/token completion,
  and require the new job to delete the late object. Run the equivalent late
  write after a completed job too.
- Reclaim expired ASR and TTS attempts after their old key has been written.
  Inject crashes immediately before and after the atomic reclaim commit, restart,
  and prove the old key is respectively still row-referenced or durably outboxed
  in the same committed state that first exposes the new key. Race a stale old
  worker's later write/rearm against cleanup and require generation fencing plus
  eventual zero orphan objects.
- Race atomic claim with session deletion in both commit orders. If claim wins,
  deletion captures its attempt key, revokes its lease, and queues cleanup. If
  deletion wins, the stale claim returns safe 401/404 with no quota, operation
  row, attempt key, object, or foreign-key 500.
- Assert phase-specific HTTP precedence. Before claim/body: Origin 403;
  auth/ownership 401/404; production release capability 503
  `VOICE_NOT_RELEASE_VERIFIED`; malformed headers 400; declared-size 413; media
  type 415; stored conflict/permanent result 409/original safe status; atomic
  quota 429. Test combined disabled-capability plus malformed/oversized/wrong-
  MIME requests and prove capability wins with zero state/body/provider. After
  claim, whichever actual event occurs first wins: a chunk crossing
  the cap is 413, while an idle/absolute timer that fires first is 408. Test both
  race orders with an injected scheduler; then SHA/WAV/duration is 422,
  media-store unavailable 503, provider invalid/unavailable 502, and provider
  deadline 504. Post-claim quota remains consumed, the failure/retryability is
  fenced-persisted, and its attempt key is cleaned/queued. Assert 202 operation
  responses expose `Location` and `Retry-After`; expired status is terminal 200
  `VOICE_ATTEMPT_EXPIRED`/`retryable:true`, never endless 202, and a lost 201 is
  recoverable without re-uploading.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="voice|media|ASR|TTS|WAV"`.

- [ ] **Step 3: Implement media-store adapters and ownership**

First implement the schema-1-to-2 session-scope migration and bootstrap output
above, with migration/session API regression tests. Task 7's PostgreSQL schema
must create `sessions.client_scope_id` as non-null and unique and its store
contract must return the same field; Task 6 may not depend on historical prose
or infer scope from the HttpOnly cookie.

Both adapters generate opaque per-asset and per-attempt keys and never accept a
caller path or use a global cross-session content-addressed key. The Azure Blob
adapter requires a private container, explicit auth mode (account URL plus
managed identity, or connection string), explicit content type, server-mediated
reads, and no public/SAS URL. Store SHA-256 and byte size as metadata.

Stream with back-pressure into a private attempt object and abort at 8 MiB. V1
does not ship ffmpeg or accept Safari/Chromium source containers at the server.
`canonical-wav.js` validates exact RIFF/WAVE PCM format 1, mono, 16 kHz, 16-bit,
byte rate 32000, block alignment 2, matching 44-byte header/data/total lengths,
even data bytes, no trailing chunks, and at most 1,920,000 PCM bytes/60 seconds.
The body SHA must match the required header. Delete validation/ASR failures and
stale attempt objects through one durable cleanup/outbox contract.

Every upload/generation claim persists its random `attemptStorageKey`, token,
expiry, non-extendable hard deadline, start time, attempt increment, and durable
quota update in one store mutation before external work. Voice body ingestion is
bounded by 30 seconds absolute/10 seconds idle; provider and object writes are
bounded by 15 seconds each. Session deletion revokes those leases and adds
asset plus attempt keys to a session-independent, key-deduplicated outbox with
`notBefore >= max(leaseExpiresAt, attemptDeadlineAt) + 60s grace`. Recheck ownership/lease
before and after every object write; a lost post-write fence must enqueue that
known key. The sweeper requires both age beyond the grace horizon and no live-row
reference.

For a retryable/expired reclaim, the store transaction generation-rearms an
outbox job for the old `attemptStorageKey` from any job state before overwriting
that column with the new unique key. Its safe horizon is
`max(old lease expiry, old attempt deadline, reclaim time) + 60s`; quota, old-key
outbox, new attempt/token/key, and attempt increment commit or roll back together.
An old worker that writes afterward performs the normal post-write rearm, raising
generation again so an in-flight cleanup token cannot close it.

Ordinary `enqueueMediaDeletion` uses an atomic generation-aware upsert keyed by
storage key and coalesces only work known to predate the current delete. A write
that finishes after losing its ownership fence must call the distinct
`rearmMediaDeletionAfterWrite`; that operation always increments generation,
clears terminal/lease fields, and resets pending from `pending`, `deleting`, or
`completed`. Cleanup complete/fail requires both generation and lease token, so
an old worker cannot close a job after a concurrent late write.

- [ ] **Step 4: Implement ASR and TTS adapters**

V1 ASR supports Azure only. A MiniMax ASR selector is unavailable/fail-closed and
never routed. Azure calls exactly
`https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`
with `Ocp-Apim-Subscription-Key`, exact `audio/wav;
codecs=audio/pcm; samplerate=16000`, `Accept: application/json`, a 256 KiB
response cap, one 15-second total deadline, no retry, and requires
`RecognitionStatus=Success` plus non-empty `DisplayText` without synthesizing
confidence.

Azure TTS calls exactly
`https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` with
`Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, fixed
`zh-HK-HiuMaanNeural`, `X-Microsoft-OutputFormat:
audio-24khz-48kbitrate-mono-mp3`, and `User-Agent:
HongKongBuddy-ProductionV1/0.1`. Its exact UTF-8 body is
`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-HK"><voice name="zh-HK-HiuMaanNeural">${escapeXml(text)}</voice></speak>`;
`escapeXml` text-node-escapes `&`, `<`, `>`, `"`, and `'` and never accepts
client/prebuilt SSML. Cap at 4 MiB and validate `audio/mpeg` plus MP3 signature.
MiniMax calls exactly `{MINIMAX_BASE_URL}/v1/t2a_v2` with
`Authorization: Bearer <key>` and JSON `{ model, text, stream:false,
output_format:"hex", language_boost:"Chinese,Yue",
voice_setting:{voice_id,speed:1,vol:1,pitch:0},
audio_setting:{sample_rate:32000,bitrate:128000,format:"mp3",channel:1} }`.
No client value can override the body. Require
`base_resp.status_code===0`, `data.status===2`, nonempty even-only hex (8 MiB
characters max), exact optional `extra_info.audio_size`, raw JSON <=9 MiB,
decoded audio <=4 MiB, and MP3 magic. Both use HTTPS,
`redirect: 'error'`, a 15-second total deadline, and zero adapter retry. Normalize
ASR/TTS transport outcomes to the exact design table: ASR no-match/silence/
babble or fixed-input rejection is non-retryable 422; provider auth/config,
non-rate-limit 4xx/refusal, and malformed successful responses are non-retryable;
only network/upstream 408/429/5xx, the total deadline, media unavailability,
client abort/ingress timeout, and attempt expiry are retryable. Normalize
accepted TTS to `{ buffer, mimeType, provider, latencyMs }` and failures to a
stable category/code/status/retryability without exposing raw provider data.

`loadConfig` keeps provider keys/endpoints internal and validates the Azure region
before URL construction. Public/session status separates `asrConfigured`,
`ttsConfigured`, local preview flags, release `voiceInput`/`voiceOutput`, and
non-secret evidence versions. Production `voiceInput` requires
`V1_ASR_SMOKE_EVIDENCE_FILE`/`V1_ASR_SMOKE_EVIDENCE_VERSION` plus
`V1_IOS_VOICE_ACCEPTANCE_FILE`/`V1_IOS_VOICE_ACCEPTANCE_VERSION`; production
`voiceOutput` requires
`V1_TTS_SMOKE_EVIDENCE_FILE`/`V1_TTS_SMOKE_EVIDENCE_VERSION`. The selected
provider also requires its explicit non-secret credential-rotation ID. Missing,
failed, stale, future-dated, commit/config-mismatched evidence never appears as
available; development may expose only clearly labeled preview capabilities.
Tests use an injected clock and prove post-startup expiry disables the POST with
zero claim/quota/body/provider activity and secret values cannot enter status.

- [ ] **Step 5: Implement routes**

In production, both POST routes first check the corresponding bound release
capability after Origin/session/ownership but before idempotency claim, quota,
body, or provider transport. False returns 503
`VOICE_NOT_RELEASE_VERIFIED` with zero new state/cost. Preview capabilities are
separate and work only outside production.

`POST /api/v1/voice/transcriptions` authenticates/reserves before body. A new
claim is publicly/persistently `uploading`; after canonical SHA/WAV validation,
`setVoiceUploadTranscribing` makes the fenced truthful transition before ASR.
It returns editable text plus an owned `voiceDraftId`. A newly completed
transcript returns 201; ready same-hash retry returns 200; an active same-hash
lease returns 202 with its real `uploading|transcribing` state, `Location`, and
`Retry-After: 1` without quota/provider duplication; changed hash/MIME returns
409. A persisted permanent failure returns its original safe status with
`retryable:false` and no new work. Retryable failure/expiry may be
fenced-reclaimed and consumes quota only when that new provider attempt is
actually claimed.
`GET /api/v1/voice/uploads/:clientUploadId` returns 202 only while lease and
hard deadline are both current; ready and failed are 200. It projects an expired
live row as 200 `failed`, `VOICE_ATTEMPT_EXPIRED`, `retryable:true`, and makes a
lost 201 recoverable without another body.

`DELETE /api/v1/voice/drafts/:draftId` durably revokes an
unattached draft and queues object deletion. `POST
/api/v1/messages/:id/audio` accepts a delivered assistant message owned by the
session, ignores all client voice/text parameters, atomically reuses/claims one
fenced generation, attaches media, and emits `audio.ready` only from a live
lease. Ready reuse returns 200; another live claim returns 202 `generating`; the
request that acquires the claim performs one bounded TTS call and returns 201
only after fenced attachment. A permanent failed generation returns its stored
safe result without new quota/provider work; only retryable failure or an
expired lease may reclaim. `GET
/api/v1/messages/:id/audio/status` returns same-session terminal/live status;
202 requires a current lease plus hard deadline and uses `Location` and
`Retry-After: 1`; failed/expired is 200 with stable `failureCode` and
`retryable`. `GET|HEAD
/api/v1/media/:id` implements the exact ownership, 200/206/416,
single-range, private no-store/nosniff contract in the design.

`DELETE /api/v1/session` uses the media deletion outbox: one store mutation
revokes the session and every upload/generation lease, then records all asset
and in-flight attempt keys before metadata is cascaded. Jobs survive the cascade
and wait past the lease/deadline/grace horizon. A best-effort drain may run
immediately for already-safe keys, but failure remains durable
for the cleanup worker; the response does not falsely claim synchronous Blob
deletion. Add a bounded temporary-prefix/draft/generation sweeper with fenced
claims and idempotent object-not-found success.
Before first recording, the UI—not the API—must have displayed the current draft
notice that audio/transcript will be processed by configured third-party
speech/model providers. Production readiness separately requires the approved
notice version; the server returns that version in session capabilities.

Add `voice-provider-smoke.js`, inert unless both one capability selector and its
confirmation are present. Exact invocations are
`--capability tts --confirm-real-voice-provider` and
`--capability asr --asr-file <absolute-canonical-wav>
--confirm-real-voice-provider --confirm-asr-audio-nonsensitive`. One process
invokes exactly the requested capability once with no retry/fallback; ASR mode
cannot call TTS and TTS mode cannot call ASR. TTS uses a fixed non-sensitive
server-owned phrase. Before transport it also requires a 40-hex
`V1_RELEASE_COMMIT_SHA` and the selected provider's credential-rotation ID;
missing values exit without a call. Output only capability/provider, normalized success,
latency, fixture SHA/duration/byte aggregates, and stable error code—never key,
endpoint, prompt, transcript, audio, headers, or raw body.

On success the script writes a safe evidence record with `schemaVersion`,
`commitSha`, `capability`, `provider`, `contractVersion`,
`providerConfigDigest`, ASR-only `fixtureSha256`/`fixtureDurationMs`,
`occurredAt`, `result`, `latencyMs`, and `artifactSha256`. The final field hashes
the canonical record excluding itself. `providerConfigDigest` hashes the exact
selected non-secret provider, normalized endpoint origin/path, region,
model/voice/output settings, and required credential-rotation ID from
`V1_AZURE_SPEECH_CREDENTIAL_VERSION` or
`V1_MINIMAX_CREDENTIAL_VERSION`. Production reads independent
`V1_ASR_SMOKE_EVIDENCE_FILE` and `V1_TTS_SMOKE_EVIDENCE_FILE` and requires
`V1_RELEASE_COMMIT_SHA` plus the matching
`V1_ASR_SMOKE_EVIDENCE_VERSION`/`V1_TTS_SMOKE_EVIDENCE_VERSION` to equal the
record commit and artifact digest; it recomputes the selected config digest and
rejects a failed, malformed, mismatched, older-than-30-days, or more-than-five-
minutes-future record. Every production voice POST rechecks the loaded evidence
against an injected current clock before claim/quota/body/provider, so evidence
that expires after startup fails closed. No script auto-mutates environment
configuration. The script writes only beneath the ignored
`production-v1/reports/speech/` directory using
`<commitSha>-<capability>-<artifactSha256>.json`; ASR and TTS can therefore be
configured from distinct immutable artifacts without a caller-controlled path.
Add `"smoke:voice": "node scripts/voice-provider-smoke.js"` to package scripts;
unit tests prove missing/excess selectors or confirmations exit before transport
and that each mode makes at most its one permitted call.

- [ ] **Step 6: Verify green and cumulative regression**

Run focused voice tests, `npm.cmd test`, `npm.cmd run check`, `git diff --check`,
the secret scan, and the immutable legacy/deployment isolation query. Do not run
a real speech provider in Task 5.

- [ ] **Step 7: Commit**

Commit message: `feat(v1): add editable voice messages and opt-in audio`

## Task 6: Implement the polished mobile chat experience

**Files:**

- Create: `production-v1/public/assets/ai-senior-avatar.svg`
- Create: `production-v1/public/assets/simplify-wordmark.svg`
- Create: `production-v1/public/audio-normalize.js`
- Create: `production-v1/public/ios-voice-acceptance.js`
- Create: `production-v1/public/manifest.webmanifest`
- Create: `production-v1/playwright.config.js`
- Create: `production-v1/scripts/ios-voice-acceptance.js`
- Create: `production-v1/tests/browser/voice-normalize.spec.js`
- Create: `production-v1/tests/fixtures/audio/README.md`
- Create: `production-v1/tests/fixtures/audio/*.{mp4,webm,ogg,wav}`
- Create: `production-v1/tests/ios-voice-acceptance.test.js`
- Modify: `production-v1/public/index.html`
- Modify: `production-v1/public/styles.css`
- Modify: `production-v1/public/app.js`
- Modify: `production-v1/package.json`
- Modify: `production-v1/package-lock.json`
- Create: `production-v1/tests/audio-normalize.test.js`
- Create: `production-v1/tests/ui-contract.test.js`

- [ ] **Step 1: Write the failing UI contract**

Assert one `main` chat surface, stable AI label, information sheet disclosure,
starter prompts, source/card templates, fixed composer after timeline, 44 px
targets, safe-area/dvh use, reduced-motion query, focus styles, live status,
hold-to-talk pointer handlers, canonical WAV normalization, persisted upload
operation recovery, editable transcript draft, no autoplay or programmatic
playback after generation,
clear-session control, exact Simplify wordmark hash
`80b8c7a6b9368cfde4b41c776c48c7523d537350c28d300fd1f72736cbe5bb87`, and absence of legacy
mode/scenario/mission labels.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="ui contract"`.

- [ ] **Step 3: Implement the static structure and visual system**

Use the Intercom-inspired warm cream/charcoal/white visual language in the spec.
Keep the header 56 px, timeline readable at 390x844, and composer fixed above
`env(safe-area-inset-bottom)`. The avatar is an original neutral illustration,
not a real person's photo. Add `from Simplify` only inside the info sheet and
quiet startup attribution using the supplied SVG unchanged.

Read the canonical source only from
`C:\Users\陈奕炜\Downloads\simplify-wordmark.svg` (1,033 bytes, expected hash
above) and add its exact bytes with `apply_patch`; never redraw it or copy from a
legacy worktree.

- [ ] **Step 4: Implement session, timeline, citations, and truthful states**

Bootstrap `/session`, render canonical ordered messages, use EventSource plus
backfill, reconcile optimistic user bubbles by ID, show only persisted stage
states, render direct official links with freshness, support retry without new
client IDs, and preserve draft text on errors/reload where safe.

- [ ] **Step 5: Implement hold-to-talk and playback UX**

The first mic tap shows the privacy notice and only then requests permission; it
never starts a hidden recording. Use one captured Pointer Event at a time and
start the timer only on `MediaRecorder.start`. Release stops at most once and
normalizes/transcribes. Cancel, `pointercancel`, `lostpointercapture`, hidden,
`pagehide`, and track/recorder errors abort upload, discard, stop every track, and
return to text. Auto-stop at 55 seconds.

`audio-normalize.js` decodes the complete local MP4/AAC, WebM/Opus, Ogg/Opus, or
WAV blob with Web Audio, resamples/downmixes to 16 kHz mono, and emits exact
PCM16LE canonical WAV. Decode/API failure never uploads the source container and
falls back to text. The transcript remains editable and requires explicit Send;
recording never auto-sends.

Numerical unit tests cover channel downmix, resampling length, clipping/rounding,
PCM16LE endian/sign, 44-byte RIFF/data sizes, silence, maximum duration, and
empty/invalid buffers. Browser tests use small license-clean fixtures with
documented provenance for MP4/AAC, WebM/Opus, Ogg/Opus, and WAV; a fake decoder
does not substitute for the real-container browser gate.

Add pinned `@playwright/test` as a development dependency and
`"test:browser:voice": "playwright test tests/browser/voice-normalize.spec.js"`.
The Playwright config starts isolated V1 on a non-legacy port and uses this fixed
browser×codec matrix: bundled Chromium must normalize WebM/Opus and WAV;
Playwright Firefox must normalize Ogg/Opus and WAV; installed branded Chrome
must normalize MP4/AAC, WebM/Opus, and WAV; Playwright WebKit must normalize WAV
and exercise the explicit unsupported/decode-failure fallback without upload.
The branded-Chrome project is a required Task 6 prerequisite rather than asking
bundled Chromium to provide proprietary AAC; absence blocks Task 6. Real iOS
Safari MP4/AAC remains a separate release gate.

The fixture README records generation/source, license, codec/container,
duration, channels, sample rate, fundamental tone/content fingerprint, and
SHA-256. Every success calls the actual Web Audio normalizer and asserts exact
WAV invariants plus fixture-specific duration tolerance, non-silent RMS/energy,
and dominant-frequency/content bounds (and exact PCM hash for the canonical WAV
fixture); a fixed silence or wrong clip cannot pass. Every matrix fallback
asserts no transcription fetch/upload and an immediately usable text composer.

Add `"acceptance:ios-voice": "node scripts/ios-voice-acceptance.js"` and an
opt-in `?iosVoiceAcceptance=1` diagnostic driven by the real app/normalizer on an
isolated HTTPS candidate. The diagnostic never exposes audio/transcript. It
first bootstraps the current cookie session and obtains the server-owned
`releaseCommitSha` and `normalizerContractVersion`; missing/non-40-hex SHA or a
version other than `canonical-wav-v1` disables export and visibly fails the
diagnostic. Query parameters and operator-entered values cannot override either
binding. It instrumentally records a safe exact receipt containing that frozen
public commit, normalizer contract version, candidate origin, device model class, parsed
iOS/Safari versions, capture MIME, canonical-WAV SHA/duration, and named results
for MP4/AAC capture/decode, 55-second auto-stop, permission-denial cleanup,
cancel cleanup, exactly one idempotent canonical upload, editable transcript,
text fallback, and `rawContainerNetworkCount=0`. It exports only that JSON after
all scenarios pass; ordinary users never see the diagnostic without the query
flag.

The local validator runs exactly as `npm.cmd run acceptance:ios-voice --
--receipt <absolute-safe-json> --candidate-origin <isolated-https-origin>
--confirm-real-ios-device --confirm-ios-audio-nonsensitive`. Before writing, it
requires clean current HEAD equal to 40-hex `V1_RELEASE_COMMIT_SHA`, the exact
receipt schema with no audio/transcript/base64/content fields, matching origin/
commit/normalizer, every named assertion, one upload, zero raw-container
requests, receipt age at most two hours, and no timestamp over five minutes in
the future. It also refuses the known legacy origin/hostname. It makes no
network/provider call itself and writes the canonical immutable artifact only
to ignored `production-v1/reports/ios/<commitSha>-<artifactSha256>.json`; tests
cover every rejection and hash rule. That artifact is the only input accepted
by `V1_IOS_VOICE_ACCEPTANCE_FILE`/version.

Generate one `clientUploadId` with `crypto.randomUUID()` and SHA-256 the final
WAV with WebCrypto. Bind every private IndexedDB record to the bootstrap
`clientSessionScope`; client code never attempts to read the HttpOnly cookie.
Keep that exact ID/hash/blob in IndexedDB until
ready, explicit cancel/delete, non-retryable validation/conflict, session clear,
cookie/session replacement, or a one-hour local TTL. A retryable failed/expired
state keeps the exact blob during that TTL and may re-upload only those same
bytes/ID/hash. A 202 follows `Location` with bounded polling and `Retry-After`;
lost 201, reload, and another tab recover the same operation without generating
new identity or audio. After every bootstrap, missing/mismatched scope purges the
record before any POST; status 404 may re-POST only when the record's bound scope
equals the current bootstrap scope. Use an IndexedDB transaction plus
`BroadcastChannel` (with storage-event fallback) so one tab owns polling/upload
and broadcasts ready/delete cleanup. Tests cover TTL expiry, clear session,
cancel, ready, retryable failure, non-retryable failure, 404, cookie loss, and
scope replacement, authorization-by-scope rejection, and two-tab cleanup without
retaining transcript/audio beyond the stated rules.

The first assistant audio action is `Generate voice`. TTS completion or
`audio.ready` only exposes a ready control. A second, distinct user click calls
`play()` synchronously in its handler. Only one audio plays; recording/new
playback stops the previous one; hidden pauses without auto-resume. Expose
transcript and AI voice disclosure. Never autoplay.

Before requesting microphone permission, show the configured notice version and
plain-language categories of third-party processing, retention, text fallback,
and deletion. The information sheet exposes the same notice plus AI/non-HKBU
identity, source freshness, guest-cookie loss/cross-device limitation, and
`from Simplify` attribution. Local preview labels the notice `Draft`; production
cannot hide or relabel an unapproved notice.

- [ ] **Step 6: Verify green**

Run UI/normalizer contracts, `npm.cmd run test:browser:voice`, full tests, and
syntax checks. Install the pinned Chromium/Firefox/WebKit revisions if absent
and verify the branded-Chrome channel prerequisite; `NOT RUN` does not satisfy
Task 6.

- [ ] **Step 7: Commit**

Commit message: `feat(v1): build the mobile AI senior chat experience`

## Task 7: Add PostgreSQL, schema migration, Azure Blob readiness, and operations

**Files:**

- Create: `production-v1/migrations/001_initial.sql`
- Create: `production-v1/src/stores/postgres-store.js`
- Create: `production-v1/src/services/retention.js`
- Modify: `production-v1/src/config.js`
- Modify: `production-v1/src/app.js`
- Modify: `production-v1/src/server.js`
- Modify: `production-v1/package.json`
- Create: `production-v1/scripts/production-readiness.js`
- Create: `production-v1/scripts/retention-cleanup.js`
- Create: `production-v1/scripts/legacy-resource-inventory.js`
- Create: `production-v1/scripts/real-dependencies-acceptance.js`
- Create: `production-v1/scripts/production-latency-workload.js`
- Create: `production-v1/tests/postgres-contract.test.js`
- Reuse: `production-v1/tests/helpers/media-lifecycle-contract.js`
- Create: `production-v1/tests/retention.test.js`
- Create: `production-v1/tests/readiness.test.js`
- Create: `production-v1/README.md`

- [ ] **Step 1: Write failing SQL and readiness contracts**

Statically and with an injected fake pool assert migrations include foreign
keys, unique `(conversation_id, sequence)`, `(conversation_id,
client_message_id)`, and `(conversation_id, cursor)`, request hash, lease expiry,
random lease fencing token, unique assistant-per-turn, durable rate buckets,
service-state heartbeat, JSON citation/card/event fields, cascades,
earliest-turn claim index, and media ownership. Exercise transaction
begin/commit/rollback, stale-token rejection, and same-session authorization.
Require non-null unique `sessions.client_scope_id`, stable bootstrap return, and
prove the scope alone grants no authorization.
Require `voice_uploads` unique `(session_id, client_upload_id)`,
`media_generations` unique `(owner_message_id, kind)`, and fenced indexed
`media_deletion_jobs`; exercise ASR/TTS concurrent claim/reclaim and session
delete outbox crash recovery across two store instances.

The Task 5 atomic lifecycle/rate-limit suite is a shared adapter contract, not a
local-only test. Run the exact same matrix against `AtomicFileStore` in Task 5
and `PostgresStore` in Task 7. For both adapters it proves rollback retains the
old row key; post-commit restart exposes the new key plus displaced-key outbox
generation; stale writes rearm pending, deleting, and completed jobs; stale
generation/token completion fails; cleanup reaches zero orphans; both
claim-versus-delete commit orders preserve ownership, quota, and attempt keys;
and every chat/ASR/TTS multi-window claim returns the maximum exhausted expiry
independent of bucket order. A fake pool may drive the early RED test, but only
the real isolated PostgreSQL acceptance below satisfies production evidence.

Require globally unique opaque `media_assets.storage_key`; attempt keys plus
created/updated/start timestamps in upload/generation rows; explicit session and
message FKs/cascades; nullable media-asset attachment FKs; deletion jobs with no
FK to cascading owner rows, unique storage key, terminal timestamp, and indexes
on `(state, not_before, lease_expires_at)`. Claim indexes cover live/expired voice
work without table scans.

Retention tests use an injected clock and assert: voice objects older than 7 days
are first made inaccessible and copied to the durable outbox in one transaction;
failed Blob deletion remains retryable and is not falsely recorded successful;
object-not-found completes idempotently; anonymous sessions/messages/events older
than 30 days cascade only after their asset/attempt keys are durably queued;
worker heartbeat and last success are durable; stopped/stale worker fails
readiness. A DB crash cannot leave readable metadata pointing to a deleted Blob
or remove the only key needed for later deletion.

Assert production readiness is false for local drivers, deterministic provider,
unapproved/missing privacy version, non-single instance policy, or stale
retention worker. It may be true only for Postgres + Azure Blob + real provider +
valid HTTPS origin/secret/trusted-proxy setting + approved notice + healthy
worker, and only after external acceptance evidence is supplied.
Production config accepts only `V1_DATABASE_URL`, V1-prefixed Blob
credentials/container settings, `V1_POSTGRES_RESOURCE_ID`, and
`V1_BLOB_RESOURCE_ID`; unprefixed database/Blob variables remain development
compatibility inputs and must not satisfy or select production storage.
Production startup must load the exact pair
`V1_LEGACY_RESOURCE_INVENTORY_FILE`/
`V1_LEGACY_RESOURCE_INVENTORY_VERSION` and require
`V1_LEGACY_RESOURCE_INVENTORY_APPROVED=true` before opening either V1 production
store. The record has `schemaVersion`, `commitSha`, non-empty
`legacyApplicationIds` and `legacyOrigins` including the known legacy app,
`postgresResources` and `blobResources` entries containing only non-secret
`resourceId` plus 64-lowercase-hex `identitySha256`, explicit
`declaresNoLegacyPostgres`/`declaresNoLegacyBlob`, `reviewedAt`, `result:true`,
and `artifactSha256` over canonical content excluding that field. For each
resource class exactly one is valid: a non-empty complete array with its `none`
flag false, or an empty array with an explicit true reviewed-none declaration.
It must bind the frozen 40-hex release commit, be no older than seven days and no
more than five minutes future, and match its configured digest on startup and
every readiness evaluation. Missing/invalid/unapproved inventory fails before a
DB/Blob connection; no conditional scan of present environment variables can
substitute for it. Tests cover every fail-closed branch.
Production `voiceInput=true` requires bound
ASR file/version and iOS file/version pairs; `voiceOutput=true` requires the
bound TTS file/version pair. Missing or failed
evidence forces the corresponding release capability false and prevents the
release report from claiming complete voice V1. Configuration-only states are
reported as `asrConfigured`/`ttsConfigured`, never as verified availability.
Aggregate production readiness additionally requires the fresh matching
`V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE`/version pair; no evidence path or digest
is exposed publicly.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="postgres|retention|readiness"`.

- [ ] **Step 3: Implement migration and PostgreSQL store contract**

Use parameterized SQL only. `acceptMessage` and `deliverAssistant` use explicit
transactions and row/advisory locking per conversation to allocate sequence
numbers. `claimNextTurn` uses `FOR UPDATE SKIP LOCKED`, excludes conversations
with an earlier unfinished turn, and writes lease token/expiry atomically.
Renew/state/delivery queries require the live token; a unique turn foreign key on
assistant messages prevents duplicate delivery. Idempotency conflict checks
compare stored request hash.

Implement `purgeExpired` by calling the same Task 5 media-lifecycle core used by
explicit draft/session deletion: revoke access and enqueue first, then claim and
delete physical objects. Task 7 retention only supplies production scheduling
and store adapters; it must not implement a second lifecycle. Database deletion
never pretends the Blob is gone: failed object deletion remains a retryable
cleanup record with a safe error code.

- [ ] **Step 4: Implement the retention worker and one-shot command**

`startRetentionWorker` runs once at startup and then on a configurable interval,
records heartbeat before work and success only after database plus media cleanup
complete, and supports graceful stop. The one-shot script invokes the identical
service for an external scheduler. Default anonymous text/event retention is 30
days and voice is 7 days. Production cannot set longer values without an
explicit policy version.

- [ ] **Step 5: Wire driver factories and health/readiness**

Select drivers from config; never silently fall back in production. Liveness
does not call dependencies. Readiness checks DB round trip, corpus validity,
private media container access, dispatcher and retention heartbeats, real
providers configured, single-instance policy, approved privacy notice, and
production boundary. Its public body contains names/statuses/versions only.

Add scripts:

```json
{
  "cleanup:retention": "node scripts/retention-cleanup.js",
  "acceptance:legacy-inventory": "node scripts/legacy-resource-inventory.js",
  "acceptance:dependencies": "node scripts/real-dependencies-acceptance.js",
  "acceptance:latency": "node scripts/production-latency-workload.js"
}
```

- [ ] **Step 6: Add guarded real-dependency and latency acceptance commands**

Legacy isolation is a separate owner-attested gate, not an optional comparison
against whatever old variables happen to be loaded. Run its validator only as
`npm.cmd run acceptance:legacy-inventory -- --manifest
<absolute-owner-reviewed-safe-json> --confirm-owner-reviewed-legacy-resources`.
It requires a clean HEAD equal to `V1_RELEASE_COMMIT_SHA`, validates the exact
inventory schema/one-of rules above, requires the known legacy application ID
and `https://hkbuddy-pilot-0630.azurewebsites.net` origin, rejects duplicate or
malformed IDs/digests and unknown fields, and writes only the ignored immutable
`production-v1/reports/legacy-inventory/<commit>-<artifact>.json`. It performs no
network/provider/storage call, never discovers or invents an empty inventory,
and cannot be satisfied by the command's environment alone. The reviewed
manifest and explicit confirmation are both required; the operator is
responsible for obtaining it from the product/operations owner after inspecting
the legacy deployment inventory. Tests prove empty arrays require the matching
explicit reviewed-none declaration and that the output binds commit, time, and
digest without credentials or canonical resource tuples.

The dependency command requires the exact isolated inputs
`V1_ACCEPTANCE_DATABASE_URL`, one of
`V1_ACCEPTANCE_BLOB_CONNECTION_STRING` or
`V1_ACCEPTANCE_BLOB_ACCOUNT_URL`, `V1_ACCEPTANCE_BLOB_CONTAINER`,
`V1_ACCEPTANCE_SCHEMA`,
`V1_ACCEPTANCE_BLOB_PREFIX`, `V1_ACCEPTANCE_POSTGRES_RESOURCE_ID`,
`V1_ACCEPTANCE_BLOB_RESOURCE_ID`, and
`V1_ACCEPTANCE_CONFIRM_EPHEMERAL=true`, plus the frozen 40-hex
`V1_RELEASE_COMMIT_SHA`. Missing/malformed commit exits before connecting.
Before any connection it also requires the valid approved inventory pair, proves
that each intended V1 resource ID and canonical identity digest is absent from
the complete legacy lists, and copies the exact `legacyInventoryDigest` into the
acceptance report. If either resource class is neither fully listed nor
explicitly declared none, it exits before connecting.
It also requires the intended new production resource settings
`V1_DATABASE_URL`, `V1_POSTGRES_RESOURCE_ID`, the V1-prefixed Blob connection
settings/container, and `V1_BLOB_RESOURCE_ID`. The acceptance URL/container and
both acceptance resource IDs must equal those intended new V1 production
settings exactly; this command isolates with a schema/prefix, not a different
physical resource. Evidence from different acceptance-only resources is labeled
adapter-only and is never accepted by production readiness.
Schema and prefix must contain the fresh
run UUID and match exact `^v1_accept_[0-9a-f]{32}$` and
`^v1-accept/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/$`
forms for the same generated UUID. Before connecting, the script canonicalizes
and hashes the acceptance and intended-new-V1 identities, requires each pair to
match, and refuses every V1/acceptance identity digest or resource ID found in
the complete approved legacy inventory. As defense in depth it also
canonicalizes and refuses equality with any legacy compatibility value present
in `DATABASE_URL`, `AZURE_STORAGE_CONNECTION_STRING`,
`AZURE_BLOB_ACCOUNT_URL`, `AZURE_BLOB_CONTAINER`, or
`AZURE_STORAGE_CONTAINER`, but presence/absence of those variables never defines
inventory completeness. In production,
`V1_DATABASE_URL` and V1-prefixed Blob settings are mandatory; unprefixed
fallbacks are allowed only for local compatibility and never select a
production resource. PostgreSQL canonical identity is the UTF-8 canonical JSON
tuple `["postgres",lowercaseHost,explicitOrDefault5432Port,
percentDecodedDatabase]`; Blob identity is `["azure-blob",
lowercaseHttpsAccountHost,exactContainer]`, derived fail-closed from either
account URL or the parsed connection-string endpoint without credentials. Any
ambiguous/unparseable identity is rejected. The script SHA-256 hashes those
tuples for comparison/reporting and never prints raw URLs or connection strings.
SQL uses only the explicit schema and search path, and Blob listing/deletion is
confined to the validated prefix.

It applies the migration to that unique schema, exercises two
concurrent store instances claiming/delivering, crash/expired lease recovery,
FK/cascade/idempotency/event replay, private Blob full/range/HEAD access, and
voice upload/generation new/live/reclaim fencing. Against this real isolated
PostgreSQL/Blob pair it runs the shared exact lifecycle matrix: rollback leaves
the old attempt key row-referenced; post-commit restart finds the replacement
key and displaced-key outbox generation; stale ASR and TTS writes rearm jobs
from pending, deleting, and completed; stale generation/token completion is
rejected; and cleanup reaches zero orphans. It executes both claim-versus-delete
commit orders and verifies ownership, quota, and attempt keys, then exhausts
short+daily chat, ASR, and TTS windows in both bucket orders and requires the
maximum blocking expiry. It deletes a session while a
provider attempt is before write, after write, and before attach; restarts the
outbox worker; verifies fenced cleanup, prefix sweep safety, no accessible media,
and no final orphaned object. It then removes only its uniquely prefixed
records/objects. In a `finally` path it deletes every object under the validated
prefix, paginates a fresh listing to prove the prefix count is exactly zero,
drops only the validated UUID schema with quoted identifier plus `CASCADE`, and
queries `pg_namespace` to prove the schema/tables are absent. It never drops the
database, container, or anything outside the guarded schema/prefix. Cleanup or
verification failure forces the report result false even when functional checks
passed. The acceptance uses two store instances and includes concurrent
claim plus deletion-job deduplication. It prints statuses/latencies,
never connection strings or object contents. It writes the ignored safe report
`production-v1/reports/acceptance/<runId>.json` containing `schemaVersion`,
`commitSha`, `legacyInventoryDigest`, hashed resource identities, schema/prefix, named checks, cleanup
fields `schemaAbsent:true` and `blobPrefixObjectCount:0`, result, `occurredAt`,
and `artifactSha256` (canonical payload excluding
that field). Production consumes it only through the exact pair
`V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE` and
`V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION`. Readiness recomputes the current
intended-new-V1 PostgreSQL/Blob identity hashes and accepts the report only when
its artifact hash, frozen commit, both report resource IDs/digests equal the
current V1 resource IDs/digests, both remain unequal to every inventoried legacy
identity/ID in the still-valid complete inventory, the report's
`legacyInventoryDigest` equals the current configured inventory artifact, and
the schema/prefix, successful cleanup, and result match; it
rejects records older than seven days or more than five minutes in the future on
every readiness evaluation. Static/fake-pool tests never create or substitute
this artifact.

The latency command requires an explicitly approved candidate URL and
`V1_LOAD_TEST_CONFIRM=true`. It implements the spec workload: 200 text turns
across 20 sessions at concurrency 5, 30 mixed 10/30/55-second ASR samples, and 30
TTS requests; nearest-rank P95 and invariant counts determine pass/fail. Do not
run either guarded command against any existing app during this plan.

- [ ] **Step 7: Document exact local and production commands**

README includes:

```powershell
$env:ENV_FILE='..\backend\.env'
npm.cmd start
```

and separate production variables by name only. State plainly that local
atomic-file/local-media mode is a product preview, not campus distribution.
Document new-app deployment requirement, 30-day anonymous text/event and 7-day
voice-media retention cleanup, data deletion, backups, corpus review, provider
smoke, privacy-notice approval, exact one-replica policy, real dependency and
latency acceptance, and rollback without touching the legacy app.

- [ ] **Step 8: Verify green**

Run PostgreSQL/retention/readiness tests, full test suite, `npm.cmd run readiness`
in local mode (expected nonzero with an explicit preview boundary), and syntax
checks. Do not claim real PostgreSQL/Blob or SLO acceptance without running the
guarded commands on a separately approved target.

- [ ] **Step 9: Commit**

Commit message: `feat(v1): enforce production storage and readiness gates`

## Task 8: End-to-end verification, legacy non-regression, and release evidence

**Files:**

- Modify only if a verified defect is found in `production-v1/`.
- Create: `production-v1/docs/verification-2026-08-25.md`
- Do not modify legacy product files.

- [ ] **Step 1: Run the complete automated ladder**

From `production-v1/`:

```powershell
npm.cmd test
npm.cmd run check
npm.cmd run test:browser:voice
```

From repository root:

```powershell
npm.cmd run sync:frontend:check
npm.cmd --prefix backend run test:v2
git diff --check
```

Expected: all V1 tests, syntax, legacy sync, and 14-test V2 suite PASS.

- [ ] **Step 2: Run secret and isolation checks**

Verify tracked `production-v1` files contain no credential-like values, `.env`
is ignored, and the V1 lockfile is tracked. Record the immutable feature base
`a15437876d77ce663954ac60fe16584163435565`, verify it is the branch merge-base,
and require an empty diff from that base for `frontend/`, `backend/`,
`.github/workflows/`, root `package.json`, `.deployment`, `AZURE_DEPLOYMENT.md`,
and any other root deployment manifest found by `rg --files`. Git may report
changes only under `production-v1/` plus the two new Superpowers documents.

- [ ] **Step 3: Prepare guarded real-gate inputs without calling them**

Confirm by unit test that LLM smoke is inert without
`--confirm-real-provider`, voice smoke is inert without its exact single-
capability confirmations, and dependency/latency commands are inert without
their guards. Inventory only setting names/presence, the approved non-sensitive
canonical ASR fixture, and whether isolated dependency/iOS/candidate targets are
available. Also record whether an owner-reviewed legacy-resource manifest is
available; do not synthesize `none` from absent old environment variables. Do
not call a real LLM/speech provider, acceptance database/Blob,
real iOS upload, or production load target yet: all such evidence must be
collected only after Step 9 freezes and commits the reviewed candidate SHA.

- [ ] **Step 4: Record real-infrastructure target availability**

Do not create or mutate cloud resources automatically. Record whether the exact,
separately approved acceptance PostgreSQL/Blob settings exist, but defer
`npm.cmd run acceptance:dependencies` until the frozen-SHA gate in Step 10. If
they do not exist, record `NOT RUN — no isolated approved acceptance resources`
and keep production readiness red. A static SQL/fake-pool test never substitutes
for this gate. Independently record whether the product/operations owner has
supplied the complete legacy-resource manifest required by the guarded inventory
validator; absent owner attestation keeps storage startup/readiness red.

- [ ] **Step 5: Start local V1 and verify API/browser flows**

Use a non-legacy port. Verify at 390x844 and desktop:

- first bootstrap and disclosure;
- text question about Duo and official citation;
- unknown campus fact yields honest limitation;
- duplicate retry creates one reply;
- second message queues in order;
- reload/backfill and persisted-cursor SSE replay;
- info sheet and clear conversation;
- mic-denied/unsupported text fallback;
- voice transcript edit and manual playback if browser/provider support it;
- no overflow, covered composer, fake human status, or voice autoplay.

Campus voice-input promotion additionally requires evidence from a real iOS
Safari device (not only Playwright WebKit): MP4/AAC capture, local canonical-WAV
conversion, 55-second auto-stop, permission denial/cancel cleanup, one idempotent
upload, editable transcript, and no raw-container network request. Prepare the
device/fixture now but run this only against the frozen Step 10 candidate. If it
is not run or fails, report `voiceInput=false` for production release evidence
while keeping text chat usable.

The safe iOS record contains `schemaVersion`, `commitSha`,
`normalizerContractVersion`, device model class, iOS/Safari versions, capture
MIME, fixture SHA/duration, each named assertion/result, `occurredAt`, and
`artifactSha256` over the canonical payload excluding that field—never captured
audio or transcript. Production reads `V1_IOS_VOICE_ACCEPTANCE_FILE` and requires
`V1_IOS_VOICE_ACCEPTANCE_VERSION` to equal that digest and
`V1_RELEASE_COMMIT_SHA`; startup and every production voice POST reject evidence
older than 90 days, more than five minutes in the future, or whose commit/
normalizer contract differs. No verification step edits environment
configuration automatically.

- [ ] **Step 6: Measure local observations and restart durability**

Record send-ack, state-visible, final-answer, ASR, and TTS timings when available.
Restart local preview and prove acknowledged messages survive. Label small-sample
timings as observations, not SLO proof.

- [ ] **Step 7: Record the production SLO and privacy gates**

Do not run the production workload without an approved new target and explicit
load-test confirmation. Record target/guard availability now and defer
`npm.cmd run acceptance:latency` until the frozen-SHA Step 10 gate. If unavailable,
record it not run and keep campus promotion blocked. Likewise record the
configured privacy notice version and approval; a local `Draft` notice is a
correct preview result but not production approval.

- [ ] **Step 8: Write verification evidence**

Document commands, commit SHA, Node version, test totals, local URL, provider
smoke target/guard status, screenshots/viewport observations, latency samples, known
environment blocks, production/local readiness distinction, real dependency/SLO
gate status, privacy/retention status, and the exact statement: `No old app
deployment or configuration was changed.`
Separate runtime readiness (live dependency checks) from release evidence bound
to commit SHA, isolated resource identity, retention freshness, real speech
smoke, and the iOS device acceptance result. At this stage real gates are
explicitly `PENDING FROZEN SHA` or `NOT AVAILABLE`, never pre-claimed as passed.

- [ ] **Step 9: Request final code review and fix all blocking findings**

Use `superpowers:requesting-code-review` over the full branch diff. Re-run the
complete ladder after any fix. Commit the reviewed implementation plus tracked
verification document as `docs(v1): freeze production candidate evidence`, then
re-run the ladder and isolation/secret checks on that exact HEAD. Repeat review,
fix, commit, and automated verification until the tracked worktree is clean.
This clean HEAD is the frozen release-candidate SHA; no real gate may run before
it exists.

- [ ] **Step 10: Run real gates only against the frozen clean SHA**

Capture `git rev-parse HEAD` as `V1_RELEASE_COMMIT_SHA` and require an empty
tracked status before and after every gate. Set `ENV_FILE` only to the existing
ignored environment, then run the LLM smoke exactly as
`npm.cmd run smoke:provider -- --confirm-real-provider`. Record only provider,
normalized result, latency, and pass/fail—never prompt, answer, endpoint query,
or key.

Run TTS once as `npm.cmd run smoke:voice -- --capability tts
--confirm-real-voice-provider`; run ASR at most once only as `npm.cmd run
smoke:voice -- --capability asr --asr-file <absolute-canonical-wav>
--confirm-real-voice-provider --confirm-asr-audio-nonsensitive`. Each process is
single-capability with no retry/fallback. Successful ASR and TTS write their
separate ignored evidence files/digests from Task 5. Missing/failed/not-run keeps
the matching release capability false.

Before dependency acceptance, validate the separately owner-reviewed legacy
manifest exactly as `npm.cmd run acceptance:legacy-inventory -- --manifest
<absolute-owner-reviewed-safe-json> --confirm-owner-reviewed-legacy-resources`.
If it is missing or fails, do not connect to PostgreSQL/Blob and keep production
readiness red. The generated ignored inventory artifact/digest is then a required
input to the dependency gate and later readiness checks.

If the separately approved isolated dependency settings exist, run
`npm.cmd run acceptance:dependencies`; if the approved candidate and explicit
load guard exist, run `npm.cmd run acceptance:latency`; and if the Task 6
diagnostic receipt from a prepared real iOS device and isolated HTTPS candidate
is available, run `npm.cmd run acceptance:ios-voice -- --receipt
<absolute-safe-json> --candidate-origin <isolated-https-origin>
--confirm-real-ios-device --confirm-ios-audio-nonsensitive`. Otherwise record each as
`NOT RUN` and preserve the corresponding red release gate. All generated records
and an aggregate `production-v1/reports/release/<frozenSha>.json` are ignored,
safe, artifact-hashed, and must bind exactly to the frozen SHA. No tracked file,
environment, deployment, DNS, or old app is mutated.

If a real gate reveals a code defect, invalidate the evidence, fix through TDD,
repeat Step 9 to freeze a new SHA, and do not make a second paid/real provider
call without explicit user approval. There is no commit, code review, or tracked
document edit after a successful frozen-SHA evidence run.

- [ ] **Step 11: Present integration options without executing them**

Offer: keep branch for review, merge locally, push/create PR, or provision a new
deployment target. Do not execute any option until the user chooses it.
