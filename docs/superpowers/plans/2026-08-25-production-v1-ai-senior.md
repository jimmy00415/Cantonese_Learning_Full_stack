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
`@azure/storage-blob`, plus pure-JavaScript `file-type` and `music-metadata` for
server-side audio signature/duration enforcement. Set `engines.node` to `>=22`
and `type` to `module`.

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
- `V1_ASR_PROVIDER` before `ASR_PROVIDER`; Azure requires speech key+region,
  MiniMax requires key+explicit ASR enabled+endpoint/model;
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
returned in JSON.

- [ ] **Step 1: Write failing repository and HTTP tests**

Test a temporary data directory for:

- first session creates exactly one conversation;
- resume with the same token hash returns the same IDs;
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

Use envelope responses. `POST /api/v1/session` creates/resumes; `POST
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
- Create: `production-v1/src/providers/asr.js`
- Create: `production-v1/src/providers/tts.js`
- Modify: `production-v1/src/stores/store-contract.js`
- Modify: `production-v1/src/stores/atomic-file-store.js`
- Modify: `production-v1/src/app.js`
- Create: `production-v1/tests/voice-media.test.js`

- [ ] **Step 1: Write failing voice/media tests**

Cover streaming/raw-body 8 MiB limit, allowlisted `audio/webm`,
`audio/ogg`, `audio/wav`, and `audio/mpeg`, detected MIME/magic mismatch,
server-parsed duration at 60,001 ms, unknown/malformed duration fail-closed,
client duration ignored for authorization, owned
draft creation, cross-session denial, single-use draft attach, Azure ASR URL and
headers, Azure/MiniMax TTS normalization, text delivery surviving TTS failure,
TTS idempotent reuse, private media headers, path traversal rejection, and
session deletion removing local media. Assert validation or ASR failure removes
the private temporary object and metadata, and voice/TTS quotas return 429 before
provider calls.

- [ ] **Step 2: Confirm red**

Run `npm.cmd test -- --test-name-pattern="voice|media|ASR|TTS"`.

- [ ] **Step 3: Implement media-store adapters and ownership**

The local adapter writes content-addressed files beneath its configured root and
never accepts caller-provided paths. The Azure Blob adapter uses a private
container, opaque blob names, explicit content type, and server-mediated reads;
do not expose account keys or public container URLs. Store SHA-256 and byte size.

Stream the request with back-pressure into a private temporary object and abort
at 8 MiB. Detect file type from bytes with `file-type`, parse duration with
`music-metadata`, and reject unsupported, malformed, unknown-duration, or over-60
second content before ASR. Never trust query/header/browser duration. Delete the
temporary object on every validation/ASR failure path.

- [ ] **Step 4: Implement ASR and TTS adapters**

Azure ASR uses the configured regional conversation-recognition endpoint with
`zh-HK` default and a 15-second timeout. TTS supports configured Azure Speech or
MiniMax. Normalize output to `{ buffer, mimeType, provider, latencyMs }`. Safe
errors expose `VOICE_TRANSCRIPTION_FAILED` or `VOICE_SYNTHESIS_FAILED` only.

- [ ] **Step 5: Implement routes**

`POST /voice/transcriptions` accepts a raw audio body, validates/stores/transcribes,
and returns editable text plus an owned `voiceDraftId`. `POST /messages/:id/audio` accepts assistant
messages owned by the session, generates once, attaches media, and emits
`audio.ready`. `GET /media/:id` enforces ownership and private/nosniff headers.
Before first recording, the UI—not the API—must have displayed the current draft
notice that audio/transcript will be processed by configured third-party
speech/model providers. Production readiness separately requires the approved
notice version; the server returns that version in session capabilities.

- [ ] **Step 6: Verify green and cumulative regression**

Run focused voice tests and `npm.cmd test`.

- [ ] **Step 7: Commit**

Commit message: `feat(v1): add editable voice messages and opt-in audio`

## Task 6: Implement the polished mobile chat experience

**Files:**

- Create: `production-v1/public/assets/ai-senior-avatar.svg`
- Create: `production-v1/public/assets/simplify-wordmark.svg`
- Create: `production-v1/public/manifest.webmanifest`
- Modify: `production-v1/public/index.html`
- Modify: `production-v1/public/styles.css`
- Modify: `production-v1/public/app.js`
- Create: `production-v1/tests/ui-contract.test.js`

- [ ] **Step 1: Write the failing UI contract**

Assert one `main` chat surface, stable AI label, information sheet disclosure,
starter prompts, source/card templates, fixed composer after timeline, 44 px
targets, safe-area/dvh use, reduced-motion query, focus styles, live status,
hold-to-talk pointer handlers, editable transcript draft, no autoplay attribute,
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

Use Pointer Events and MediaRecorder. Press starts, release transcribes, cancel
discards. Show timer and permission fallback. Put transcript in an editable draft
before sending. `Play voice` calls TTS only on demand, stops when recording or a
new playback begins, and exposes text/AI voice disclosure. Never autoplay.

Before requesting microphone permission, show the configured notice version and
plain-language categories of third-party processing, retention, text fallback,
and deletion. The information sheet exposes the same notice plus AI/non-HKBU
identity, source freshness, guest-cookie loss/cross-device limitation, and
`from Simplify` attribution. Local preview labels the notice `Draft`; production
cannot hide or relabel an unapproved notice.

- [ ] **Step 6: Verify green**

Run UI contract, full tests, and syntax checks.

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
- Create: `production-v1/scripts/real-dependencies-acceptance.js`
- Create: `production-v1/scripts/production-latency-workload.js`
- Create: `production-v1/tests/postgres-contract.test.js`
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

Retention tests use an injected clock and assert: voice objects older than 7 days
are deleted before their metadata; failed Blob deletion remains retryable and is
not falsely recorded successful; anonymous sessions/messages/events older than
30 days cascade only after owned media is handled; worker heartbeat and last
success are durable; stopped/stale worker fails readiness.

Assert production readiness is false for local drivers, deterministic provider,
unapproved/missing privacy version, non-single instance policy, or stale
retention worker. It may be true only for Postgres + Azure Blob + real provider +
valid HTTPS origin/secret/trusted-proxy setting + approved notice + healthy
worker, and only after external acceptance evidence is supplied.

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

Implement `purgeExpired`/media cleanup operations in both stores. Database
deletion never pretends the Blob is gone: failed object deletion remains a
retryable cleanup record with a safe error code.

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
  "acceptance:dependencies": "node scripts/real-dependencies-acceptance.js",
  "acceptance:latency": "node scripts/production-latency-workload.js"
}
```

- [ ] **Step 6: Add guarded real-dependency and latency acceptance commands**

The dependency command requires separately named acceptance PostgreSQL and Blob
settings plus `V1_ACCEPTANCE_CONFIRM_EPHEMERAL=true`; it refuses default/legacy
production settings. It applies the migration to a unique schema, exercises two
concurrent store instances claiming/delivering, crash/expired lease recovery,
FK/cascade/idempotency/event replay, and private Blob write/read/delete, then
removes only its uniquely prefixed records/objects. It prints statuses/latencies,
never connection strings or object contents.

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

- [ ] **Step 3: Run a real configured-provider smoke**

Set `ENV_FILE` to the existing ignored legacy environment and run
`npm.cmd run smoke:provider`. Record only provider name, normalized result,
latency, and pass/fail. Do not record prompt, answer, endpoint query secrets, or
keys.

- [ ] **Step 4: Record the real-infrastructure acceptance boundary**

Do not create or mutate cloud resources automatically. If separately approved
acceptance PostgreSQL/Blob settings exist, run `npm.cmd run
acceptance:dependencies`; otherwise record `NOT RUN — no isolated approved
acceptance resources` and keep production readiness red. A static SQL/fake-pool
test never substitutes for this gate.

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

- [ ] **Step 6: Measure local observations and restart durability**

Record send-ack, state-visible, final-answer, ASR, and TTS timings when available.
Restart local preview and prove acknowledged messages survive. Label small-sample
timings as observations, not SLO proof.

- [ ] **Step 7: Record the production SLO and privacy gates**

Do not run the production workload without an approved new target and explicit
load-test confirmation. If available, run `npm.cmd run acceptance:latency` and
require the defined nearest-rank P95/invariant pass. Otherwise record it not run
and keep campus promotion blocked. Likewise record the configured privacy notice
version and approval; a local `Draft` notice is a correct preview result but not
production approval.

- [ ] **Step 8: Write verification evidence**

Document commands, commit SHA, Node version, test totals, local URL, provider
smoke status, screenshots/viewport observations, latency samples, known
environment blocks, production/local readiness distinction, real dependency/SLO
gate status, privacy/retention status, and the exact statement: `No old app
deployment or configuration was changed.`

- [ ] **Step 9: Request final code review and fix all blocking findings**

Use `superpowers:requesting-code-review` over the full branch diff. Re-run the
complete ladder after any fix.

- [ ] **Step 10: Present integration options without executing them**

Offer: keep branch for review, merge locally, push/create PR, or provision a new
deployment target. Do not execute any option until the user chooses it.
