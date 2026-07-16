# HK-001 Golden Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Hong Kong Buddy into a reproducible Node 22 Flash Launch workload protected by shared pilot access, exact provider readiness, bounded abuse controls, and one authenticated idempotent four-provider launch smoke.

**Architecture:** Keep `backend/server.js` as the composition root while extracting focused security, readiness, smoke, logging, and shutdown modules. Consolidate installation under one npm workspace lockfile, put every application API behind an HttpOnly pilot session except explicit liveness/readiness/access/smoke routes, and route browser requests through one credentialed reauthentication client. Real provider smoke calls the same direct provider primitives used by production routes and returns only aggregate evidence.

**Tech Stack:** Node.js 22, npm 10.9.2 workspaces, Express 4, Node crypto/scrypt/HMAC, google-auth-library, native node:test, static HTML/CSS/JavaScript, Azure OpenAI, Azure Translator, MiniMax TTS, Azure Speech ASR.

## Global Constraints

- Repository root `.` is the only Flash build root and owns the only tracked `package-lock.json`.
- Canonical commands are `npm ci`, `npm run build`, `npm test`, and `npm start`.
- Golden Path readiness requires raw `NODE_ENV=production` and requires `PILOT_AUTH_DISABLED` to be absent or exactly `false`.
- Exact production selectors are `LLM_PROVIDER=azure-openai`, `TTS_PROVIDER=minimax`, `ASR_PROVIDER=azure`, empty `ASR_FALLBACK_PROVIDER`, and `VISIT_TRANSLATION_PROVIDER=azure`.
- `PILOT_AUTH_DISABLED=true` is valid only with `NODE_ENV=test`; production missing or malformed pilot configuration fails closed.
- Production cookie is `__Host-hkbuddy_pilot`, HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=28800, with no Domain.
- Anonymous API access is limited to live, ready, pilot login/status/logout, and machine-authenticated provider smoke.
- Production canonical origin comes only from `PUBLIC_APP_ORIGIN`; request Host/forwarded-host/protocol cannot alter it.
- Production requires `TRUST_PROXY_HOPS=1`; a boolean trust-all value or other hop count is not ready.
- Login body limit is 4 KB, normal JSON is 256 KB, and speech compatibility requests are capped at 10 MiB plus encoded/decoded/MIME validation.
- Paid smoke invokes Azure OpenAI, direct Azure Translator, MiniMax TTS, and Azure Speech ASR once each, without retry, fallback, or mock.
- User/provider content, audio, upstream bodies, access codes, cookies, tokens, and keys never enter logs or smoke persistence.
- Frontend changes originate under `frontend/` and are synchronized to `backend/public`; generated copies are never hand-edited.
- Each task follows RED-GREEN-REFACTOR, passes existing regressions, is reviewed, committed, and pushed to `agent/hk001-golden-path`.

## File Responsibility Map

- `package.json`, root `package-lock.json`, `.gitignore`: reproducible workspace launch contract.
- `scripts/test-root-launch-contract.js`: machine-check canonical runtime commands and files.
- `backend/security/pilot-access.js`: password hash and stateless signed session primitives.
- `backend/security/pilot-routes.js`: login/status/logout and pilot middleware.
- `backend/security/request-boundary.js`: canonical origin and one-hop client identity.
- `backend/security/bounded-token-bucket.js`: TTL/capacity-bounded atomic quota buckets.
- `backend/security/audio-validation.js`: encoded/decoded/MIME/duration checks.
- `backend/runtime/pilot-readiness.js`: exact selector/config readiness and aggregate public response.
- `backend/security/google-identity.js`, `smoke-auth.js`: machine request authentication.
- `backend/runtime/smoke-attempt-cache.js`, `provider-smoke.js`: once-only attempt state and real provider sequence.
- `backend/observability/safe-logger.js`: allowlisted structured fields only.
- `backend/runtime/graceful-shutdown.js`: draining state, bounded close, and smoke refusal.
- `frontend/pilot-access.js`: status/login/logout, single reauth promise, one replay maximum.
- `frontend/app.js`: uses the shared access client for every `/api` request.
- `scripts/sync-frontend-to-public.js`: includes the new browser module.

---

### Task 1: Add the Reproducible Root Launch Contract

**Files:**
- Modify: `package.json`
- Add and track: `package-lock.json`
- Modify: `.gitignore`
- Modify: `backend/package.json`
- Modify: `frontend/package.json`
- Create: `.nvmrc`
- Create: `.npmrc`
- Create: `scripts/check-toolchain.js`
- Create: `scripts/test-root-launch-contract.js`
- Modify: `.github/workflows/main_hktutor.yml`
- Modify: `README.md`

**Interfaces:**
- Produces: one npm workspace and one root lockfile.
- Produces: exact root `build`, `test`, and `start` scripts consumed by Flash.
- Preserves: existing backend regression suite and frontend/public synchronization.

- [ ] **Step 1: Write and run the failing root contract test**

Create `scripts/test-root-launch-contract.js`:

```js
const assert = require('node:assert/strict');
const fs = require('node:fs');
const root = require('../package.json');

assert.deepEqual(root.workspaces, ['backend', 'frontend']);
assert.equal(root.packageManager, 'npm@10.9.2');
assert.equal(root.engines.node, '22.x');
assert.equal(root.engines.npm, '10.9.2');
assert.equal(root.scripts.preinstall, 'node scripts/check-toolchain.js');
for (const script of ['build', 'test', 'start']) {
  assert.equal(typeof root.scripts[script], 'string', `missing root ${script}`);
}
assert.equal(fs.existsSync('package-lock.json'), true);
assert.equal(fs.existsSync('backend/package-lock.json'), false);
assert.equal(fs.existsSync('frontend/package-lock.json'), false);
console.log('root launch contract passed');
```

Run `node scripts/test-root-launch-contract.js`. Expected: FAIL on missing workspace/package-manager/scripts.

- [ ] **Step 2: Define exact root scripts and pins**

Set:

```json
{
  "workspaces": ["backend", "frontend"],
  "packageManager": "npm@10.9.2",
  "engines": { "node": "22.x", "npm": "10.9.2" },
  "scripts": {
    "preinstall": "node scripts/check-toolchain.js",
    "check:launch-contract": "node scripts/test-root-launch-contract.js",
    "sync:frontend": "node scripts/sync-frontend-to-public.js",
    "sync:frontend:check": "node scripts/sync-frontend-to-public.js --check",
    "build": "npm run sync:frontend:check && node --check frontend/app.js && node --check backend/server.js",
    "test:unit": "node --test",
    "test": "npm run test:unit && npm --workspace backend run test:regressions && npm run sync:frontend:check && npm run check:launch-contract",
    "start": "npm --workspace backend start"
  }
}
```

Keep existing development convenience scripts if they do not replace the four canonical commands.

`scripts/check-toolchain.js` exits nonzero unless Node major is 22 and `npm_config_user_agent` reports npm 10.9.2. Set `.npmrc` to `engine-strict=true`. This makes a wrong toolchain fail before dependency installation rather than silently generating another lock format.

- [ ] **Step 3: Track only the root lockfile**

Preserve every existing `.gitignore` rule, remove only the root `package-lock.json` rule, and keep/add these nested-lockfile rules:

```gitignore
backend/package-lock.json
frontend/package-lock.json
```

Remove the root `package-lock.json` ignore, delete local nested lockfiles, run npm 10.9.2 from the root, and generate one workspace lockfile. Set `.nvmrc` to `22`.

- [ ] **Step 4: Make CI exercise the same contract**

Replace three `npm install` calls with:

```yaml
- name: Install, build, and test
  run: |
    npm install --global npm@10.9.2
    npm --version
    npm ci
    npm run build
    npm test
```

The workflow continues to deploy only pushes to `main`; this feature branch must not trigger Azure production deployment.

- [ ] **Step 5: Verify from the root**

```powershell
npm ci
npm run build
npm test
npm run sync:frontend:check
git status --short
```

Expected: commands pass; only intended tracked files appear.

- [ ] **Step 6: Review, commit, and push**

```powershell
git add package.json package-lock.json .gitignore backend/package.json frontend/package.json .nvmrc .npmrc scripts/check-toolchain.js scripts/test-root-launch-contract.js .github/workflows/main_hktutor.yml README.md
git diff --cached --check
git commit -m "build: add reproducible root launch contract"
git push
```

---

### Task 2: Add Shared Pilot Access and Fail-Closed API Boundary

**Files:**
- Create: `backend/security/pilot-access.js`
- Create: `backend/security/pilot-routes.js`
- Create: `backend/scripts/hash-pilot-access-code.js`
- Create: `backend/test/pilot-access.test.js`
- Create: `backend/test/pilot-http-contract.test.js`
- Modify: `backend/server.js`
- Modify: `backend/.env.example`
- Modify: `backend/package.json`
- Modify: five provider regression scripts that spawn `server.js`

**Interfaces:**
- Produces: `hashPilotAccessCode`, `verifyPilotAccessCode`, `issuePilotSession`, `verifyPilotSession`, `pilotCookieDescriptor`.
- Produces: public login/status/logout router and `requirePilotSession` middleware.
- Consumes later: `req.pilotSession.id` as the session quota key.

- [ ] **Step 1: Write crypto/cookie tests**

Cover hash uniqueness and verification, malformed hash, HMAC tamper, expiry, future issue time, wrong version, constant-time signature path, and exact production cookie descriptor.

```js
assert.deepEqual(pilotCookieDescriptor({ production: true }), {
  name: '__Host-hkbuddy_pilot',
  httpOnly: true,
  secure: true,
  sameSite: 'Strict',
  path: '/',
  maxAge: 28_800_000
});
```

Express cookie `maxAge` is milliseconds. The HTTP test must assert the emitted header contains `Max-Age=28800`. Logout calls `clearCookie` with the same name/secure/sameSite/path and no Domain, but without carrying the old `maxAge` option.

- [ ] **Step 2: Implement versioned scrypt hashing**

Use the exact encoded format `scrypt-v1$16384$8$1$<salt-base64url>$<hash-base64url>`:

```js
export async function hashPilotAccessCode(code, { salt = randomBytes(16) } = {}) {
  assertAccessCode(code);
  const derived = await scryptAsync(code, salt, 32, { N: 16384, r: 8, p: 1 });
  return ['scrypt-v1', '16384', '8', '1', salt.toString('base64url'), Buffer.from(derived).toString('base64url')].join('$');
}
```

`verifyPilotAccessCode` parses bounded fields, derives 32 bytes, and uses `timingSafeEqual` only on equal-length buffers.

- [ ] **Step 3: Implement stateless 8-hour signed sessions**

Encode `v1.<payload-base64url>.<hmac-base64url>` where payload contains random `sid`, integer `iat`, and integer `exp`. Verify `exp > now`, `iat <= now + 60`, and HMAC in constant time. Development uses `hkbuddy_pilot_dev`, never the `__Host-` name without Secure.

- [ ] **Step 4: Read the hash script secret only from stdin**

`hash-pilot-access-code.js` rejects a TTY and command-line values, reads one trimmed line from stdin, prints only the encoded hash, and clears its local string reference after use.

Run:

```powershell
$secureCode = Read-Host 'Pilot access code' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureCode)
try {
  [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer) | node backend/scripts/hash-pilot-access-code.js
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable secureCode
}
```

Expected: one `scrypt-v1$...` line and no echo of the input.

- [ ] **Step 5: Add access endpoints and protect all other `/api` routes**

Public routes are exactly `/api/live`, `/api/ready`, `/api/pilot/login`, `/api/pilot/status`, `/api/pilot/logout`, and `/api/internal/provider-smoke`. Login parses at most 4 KB, returns generic invalid credentials, sets the exact cookie, and rotates session on each success. Logout clears with matching attributes.

Production missing/malformed `PILOT_ACCESS_CODE_HASH` or `PILOT_SESSION_SECRET` makes login and protected APIs fail closed. `PILOT_AUTH_DISABLED=true` works only when `NODE_ENV=test`.

- [ ] **Step 6: Update spawned regression fixtures without weakening production**

In the five scripts that spawn `server.js`, set:

```js
NODE_ENV: 'test',
PILOT_AUTH_DISABLED: 'true'
```

Poll `/api/live`, not strict `/api/health`.

- [ ] **Step 7: Run access and regression tests**

The root `node --test` discovery now includes these security tests. Test access codes are created with `randomBytes(24).toString('base64url')` at runtime; no raw code is committed in fixtures.

```powershell
node --test backend/test/pilot-access.test.js
node --test backend/test/pilot-http-contract.test.js
npm --workspace backend run test:regressions
npm run build
```

- [ ] **Step 8: Review, commit, and push**

```powershell
git add backend package.json package-lock.json
git diff --cached --check
git commit -m "feat: add shared pilot access"
git push
```

---

### Task 3: Enforce Canonical Origin, Body Limits, and Bounded Provider Budgets

**Files:**
- Create: `backend/security/request-boundary.js`
- Create: `backend/security/bounded-token-bucket.js`
- Create: `backend/security/audio-validation.js`
- Create: `backend/test/request-boundary.test.js`
- Create: `backend/test/bounded-token-bucket.test.js`
- Create: `backend/test/audio-validation.test.js`
- Create: `backend/test/request-pipeline.test.js`
- Modify: `backend/server.js`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: `resolveClientIp`, `requireCanonicalMutationOrigin`, `createBoundedTokenBucket`, `parseAndValidateAudioData`.
- Produces: `req.pilotSession` plus session/IP quota keys before provider handlers.
- Removes: production hard-coded CORS and global 10 MB JSON parsing.

- [ ] **Step 1: Write origin/proxy spoof tests**

```js
assert.equal(resolveClientIp({ socketIp: '10.0.0.1', xForwardedFor: 'spoof, 203.0.113.8' }, 1), '203.0.113.8');
assert.throws(() => requireCanonicalMutationOrigin({
  origin: 'https://evil.example',
  publicAppOrigin: 'https://hkbuddy.run.app'
}));
```

Prove spoofed Host, X-Forwarded-Host, X-Forwarded-Proto, and left-side XFF cannot change origin or quota identity. Missing Origin on browser mutations is 403.

- [ ] **Step 2: Implement exact one-hop production trust**

Parse `TRUST_PROXY_HOPS` as an integer. Production accepts only 1 and configures `app.set('trust proxy', 1)`. Development defaults to no proxy trust. Origin compares the parsed `Origin` exactly to HTTPS `PUBLIC_APP_ORIGIN`; never derive canonical origin from request headers.

`/api/internal/provider-smoke` is the sole mutating route exempt from the browser Origin and pilot-session checks. A no-Origin smoke request must continue to its Google identity + Flash token + deployment + idempotency machine-auth boundary; every other browser mutation with missing/foreign Origin returns 403 before any provider call. Test both paths with a fake machine-auth handler in the request-pipeline suite.

- [ ] **Step 3: Implement bounded token buckets with atomic two-key consumption**

```js
const sessionCheck = sessionBucket.peek(sessionId, cost);
const ipCheck = ipBucket.peek(clientIp, cost);
if (!sessionCheck.allowed || !ipCheck.allowed) return denied(sessionCheck, ipCheck);
sessionBucket.consume(sessionId, cost);
ipBucket.consume(clientIp, cost);
```

Each map has `maxEntries=5000`, TTL `2 * windowMs`, oldest-expired eviction, and bounded `Retry-After` 1..900 seconds.

- [ ] **Step 4: Apply exact budgets and route weights**

- Login: 5/IP/15m.
- Speech token: 3/session+IP/10m.
- Provider budget: 60/session/10m and 100/IP/10m.
- `recognize-and-respond=3`, `visit-translate=2`, and correction/speech-to-text/speech-token/conversation translation/tutor translation/TTS voices = 1.

Return stable `RATE_LIMITED` without revealing which key denied.

- [ ] **Step 5: Replace global JSON parsing with route-specific parsers**

Use 4 KiB for login, 256 KiB for normal JSON, and 10 MiB request ceiling for speech routes. `parseAndValidateAudioData` enforces at most 9,786,710 base64 characters, at most 7 MiB decoded audio, and at most 60,000 ms when duration is supplied. Allow only `audio/wav`, `audio/x-wav`, `audio/mpeg`, `audio/mp4`, `audio/webm`, and `audio/ogg`; validate data-URL/base64 syntax before decoding and reject before provider invocation.

- [ ] **Step 6: Verify no provider call crosses a denied boundary**

```powershell
node --test backend/test/request-boundary.test.js
node --test backend/test/bounded-token-bucket.test.js
node --test backend/test/audio-validation.test.js
node --test backend/test/request-pipeline.test.js
npm --workspace backend run test:regressions
```

Provider spies must remain at zero for foreign origin, quota denial, bad content type, and oversized audio.

- [ ] **Step 7: Review, commit, and push**

```powershell
git add backend/security backend/test backend/server.js backend/.env.example
git diff --cached --check
git commit -m "feat: enforce provider budgets and same-origin requests"
git push
```

---

### Task 4: Add Exact Golden Path Liveness and Readiness

**Files:**
- Create: `backend/runtime/pilot-readiness.js`
- Create: `backend/test/pilot-readiness.test.js`
- Create: `backend/test/readiness-http-contract.test.js`
- Modify: `backend/server.js`
- Modify: `backend/.env.example`
- Modify: `README.md`

**Interfaces:**
- Produces: `readGoldenPathConfig`, `evaluatePilotReadiness`, `toPublicReadiness`.
- Produces: process-only `/api/live`, aggregate `/api/ready`, pilot-authenticated strict `/api/health`.
- Changes: production visit translation selector calls Azure directly.

- [ ] **Step 1: Write table-driven readiness failures**

Start from a complete fixture, delete/replace one setting per case, and expect not ready:

```js
for (const [key, value] of [
  ['LLM_PROVIDER', 'hkbu'],
  ['TTS_PROVIDER', 'mock'],
  ['ASR_PROVIDER', 'minimax'],
  ['ASR_FALLBACK_PROVIDER', 'mock'],
  ['VISIT_TRANSLATION_PROVIDER', 'fallback'],
  ['TRUST_PROXY_HOPS', 'true']
]) {
  assert.equal(evaluatePilotReadiness(readGoldenPathConfig({ ...validEnv, [key]: value })).ready, false);
}
```

Repeat for each required provider/access/Flash/origin secret. Scan serialized public response for endpoint, region, model, selector, key, secret length, and component names.

- [ ] **Step 2: Implement exact config evaluation**

Require:

```text
NODE_ENV=production
PILOT_AUTH_DISABLED=<absent or false>
LLM_PROVIDER=azure-openai
TTS_PROVIDER=minimax
ASR_PROVIDER=azure
ASR_FALLBACK_PROVIDER=
VISIT_TRANSLATION_PROVIDER=azure
TRUST_PROXY_HOPS=1
```

Also require canonical Azure OpenAI, Azure Speech, MiniMax, Azure Translator, pilot auth, Flash smoke token/deployment/caller, and `PUBLIC_APP_ORIGIN` settings. Legacy aliases may support non-Golden-Path development but cannot make production ready.

Evaluate these exact raw environment names; defaults and aliases do not satisfy production readiness:

| Capability | Required raw configuration |
|---|---|
| Azure OpenAI | `AZURE_OPENAI_KEY`, HTTPS `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_DEPLOYMENT`, `AZURE_OPENAI_API_VERSION` |
| MiniMax TTS | `MINIMAX_API_KEY`, HTTPS `MINIMAX_BASE_URL`, `MINIMAX_TTS_MODEL`, `MINIMAX_TTS_VOICE`, `MINIMAX_TTS_LANGUAGE_BOOST` |
| Azure Speech ASR | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION`, `AZURE_ASR_LANGUAGE` |
| Azure Translator | `AZURE_TRANSLATOR_KEY`, HTTPS `AZURE_TRANSLATOR_ENDPOINT`, `AZURE_TRANSLATOR_REGION` |
| Pilot access | `PILOT_ACCESS_CODE_HASH`, `PILOT_SESSION_SECRET` with at least 32 bytes of entropy |
| Flash machine smoke | `FLASH_LAUNCH_SMOKE_TOKEN`, `FLASH_LAUNCH_DEPLOYMENT_ID`, service-account `FLASH_LAUNCH_SMOKE_CALLER` |
| Request boundary | HTTPS origin-only `PUBLIC_APP_ORIGIN`, `TRUST_PROXY_HOPS=1` |
| Runtime mode | `NODE_ENV=production`; `PILOT_AUTH_DISABLED` absent or exactly `false` |

Add negative tests where only `AZURE_TEXT_TRANSLATOR_*`, `ANTHROPIC_*`, default deployment/version/model/voice, or fallback constants exist; each remains not ready. Add separate cases for missing/non-production `NODE_ENV` and `PILOT_AUTH_DISABLED=true`; those remain not ready even when every provider credential is present.

- [ ] **Step 3: Add exact route responses**

`/api/live` always returns process liveness without provider/config reads. `/api/ready` returns only:

```json
{"status":"ready"}
```

or HTTP 503:

```json
{"status":"not_ready","code":"CONFIG_NOT_READY"}
```

Authenticated `/api/health` returns redacted component diagnostics and uses strict logical AND.

- [ ] **Step 4: Route production visit translation directly to Azure**

When `VISIT_TRANSLATION_PROVIDER=azure`, call `translateWithAzureTranslator()` once and do not enter the existing `Promise.any` fallback aggregator. A provider error is an error, not a success-looking fallback.

- [ ] **Step 5: Verify readiness, routing, regressions, and build**

```powershell
node --test backend/test/pilot-readiness.test.js
node --test backend/test/readiness-http-contract.test.js
npm --workspace backend run test:visit-azure-translator
npm --workspace backend run test:regressions
npm run build
```

- [ ] **Step 6: Review, commit, and push**

```powershell
git add backend/runtime backend/test backend/server.js backend/.env.example README.md
git diff --cached --check
git commit -m "feat: add exact Azure pilot readiness"
git push
```

---

### Task 5: Add Authenticated Idempotent Four-Provider Launch Smoke

**Files:**
- Create: `backend/security/google-identity.js`
- Create: `backend/security/smoke-auth.js`
- Create: `backend/runtime/smoke-attempt-cache.js`
- Create: `backend/runtime/provider-smoke.js`
- Create: `backend/providers/minimax-audio.js`
- Create: `backend/test/google-identity.test.js`
- Create: `backend/test/smoke-auth.test.js`
- Create: `backend/test/smoke-attempt-cache.test.js`
- Create: `backend/test/provider-smoke.test.js`
- Create: `backend/test/provider-smoke-http.test.js`
- Create: `backend/test/minimax-audio.test.js`
- Modify: `backend/server.js`
- Modify: `backend/package.json`
- Modify: root `package-lock.json`
- Modify: `backend/.env.example`

**Interfaces:**
- Produces: verified Google caller + Flash token/deployment/idempotency boundary.
- Produces: bounded attempt cache with `begin`, `get`, `complete`, `markInconclusive`.
- Produces: `createGoldenPathSmokeRunner` calling all four direct primitives exactly once on success and each reached primitive at most once on failure.

- [ ] **Step 1: Add Google token verification tests and dependency**

Add `google-auth-library`. Inject `verifyIdToken` in tests and assert issuer, audience=`PUBLIC_APP_ORIGIN`, expiry, and email=`FLASH_LAUNCH_SMOKE_CALLER`. Require the same token in `X-Serverless-Authorization` for Cloud Run IAM and `Authorization` for application verification; the application reads only `Authorization`. Reject redirects so neither header is forwarded.

- [ ] **Step 2: Parse exact Flash and idempotency headers**

The key format is `fl-smoke-v1.<issuedAtUnixSeconds>.<uuid>`, ASCII at most 128 chars, maximum age 15 minutes, and future skew at most 60 seconds.

```js
const fingerprint = createHash('sha256')
  .update(`${attemptId}\0${deploymentId}\0${verifiedCaller}\0${audience}`)
  .digest('base64url');
```

Compare exact `X-Flash-Smoke-Token` in constant time, require `X-Flash-Deployment-Id` to equal `FLASH_LAUNCH_DEPLOYMENT_ID`, and parse exact `Idempotency-Key`. The same attempt id with a different immutable binding is rejected; a new attempt id for the same deployment is eligible to run.

- [ ] **Step 3: Implement bounded once-only attempt state**

`begin` returns `new`, `completed`, `running`, or `inconclusive` plus an unguessable owner token for `new`. A concurrent duplicate of a non-stale started attempt returns HTTP 409 without mutating the original record. Only a started record older than the 120-second execution deadline may transition to terminal inconclusive, and only the matching owner token may `complete` an attempt. A duplicate completed attempt returns the cached aggregate. Cache at most 100 attempts with 30-minute TTL.

- [ ] **Step 4: Run the same direct provider primitives once each**

Compose the runner with the existing `callLLMProvider('azure-openai', ...)`, `translateWithAzureTranslator`, a new low-level MiniMax audio primitive, and `transcribeAzure`. The exact `Buffer` returned by MiniMax is passed to Azure ASR. Destructure the existing Azure primitive's `{ transcript, result }` return value and immediately discard `result`; never treat the result object as transcript or usage evidence.

```js
const audio = await requestMiniMaxAudio(SYNTHETIC_CANTONESE, {
  format: 'wav', sampleRate: 16000, channel: 1
});
const { transcript } = await transcribeAzure(
  audio.buffer,
  'wav',
  process.env.AZURE_ASR_LANGUAGE
);
```

No retry, fallback, or mock is allowed. On success every primitive runs exactly once; after a failure, unreached dependency-blocked providers are stable `skipped` items and no primitive is called more than once. Discard all content/audio after non-empty/MIME/size validation.

`requestMiniMaxAudio(text, options)` returns `{ buffer, mimeType, sampleRate, channel, usageCharacters }`. For smoke it requests non-streaming `format: "wav"`, `sample_rate: 16000`, and `channel: 1`, which is compatible with the Azure short-audio PCM WAV contract. Preserve existing UI behavior through `synthesizeMiniMaxDataUri()`, which calls the same primitive with the existing 32-kHz MP3 settings and wraps the returned buffer as a data URI; do not change the browser TTS response contract. `minimax-audio.test.js` parses the returned RIFF/WAVE header and requires PCM format 1, 16-bit samples, 16,000-Hz sample rate, one channel, and data length consistent with MiniMax `extra_info`; request parameters or a claimed MIME alone are insufficient.

Use these bounded synthetic contracts:

- Azure OpenAI prompt asks for one short Cantonese acknowledgement; response 1..256 UTF-8 characters.
- Azure Translator translates `你好` from Cantonese/Chinese to English; response 1..512 characters.
- MiniMax synthesizes `你好，歡迎嚟到香港。`; allowed audio MIME and 256 bytes..2 MiB.
- Azure Speech receives that exact 16-kHz mono WAV Buffer and returns a transcript 1..512 characters.

- [ ] **Step 5: Return and cache only aggregate evidence**

Success is strict HTTP 200 JSON with no extra fields:

```json
{
  "status": "passed",
  "providers": [
    {
      "provider": "azure-openai",
      "status": "passed",
      "latencyMs": 123,
      "usage": { "inputCharacters": 24, "outputCharacters": 2 }
    },
    {
      "provider": "azure-translator",
      "status": "passed",
      "latencyMs": 91,
      "usage": { "inputCharacters": 2, "outputCharacters": 5 }
    },
    {
      "provider": "minimax-tts",
      "status": "passed",
      "latencyMs": 402,
      "usage": { "inputCharacters": 10, "audioBytes": 32044, "audioDurationMs": 1000 }
    },
    {
      "provider": "azure-speech-asr",
      "status": "passed",
      "latencyMs": 318,
      "usage": { "audioBytes": 32044, "audioDurationMs": 1000, "outputCharacters": 10 }
    }
  ]
}
```

The array contains exactly those four unique providers in the shown order and each provider has only its shown usage keys. `latencyMs` is integer 0..120000; input/output characters 0..4096; audio bytes 0..2097152; audio duration 0..60000; optional stable code is an allowlisted value at most 64 characters. HTTP 502 is `{ "status":"failed", "code":"PROVIDER_SMOKE_FAILED", "providers":[...] }` with four passed/failed/skipped items under the same field and bounds contract. HTTP 409 is exactly `{ "status":"inconclusive", "code":"SMOKE_ATTEMPT_INCONCLUSIVE" }`.

- [ ] **Step 6: Verify no paid replay, fallback, or content leak**

```powershell
node --test backend/test/google-identity.test.js
node --test backend/test/smoke-auth.test.js
node --test backend/test/smoke-attempt-cache.test.js
node --test backend/test/provider-smoke.test.js
node --test backend/test/provider-smoke-http.test.js
node --test backend/test/minimax-audio.test.js
npm --workspace backend run test:regressions
```

Provider spies equal 1 each. Captured response/cache/log JSON excludes synthetic prompt, translation, transcript, audio bytes/base64, token, key, and upstream body.

Use a Flash wire fixture that asserts exact header names, both Google headers with one audience-bound token, strict response schemas, duplicate-completed reuse, started/inconclusive denial, conflicting binding denial, and a new explicit attempt running exactly once.

- [ ] **Step 7: Review, commit, and push**

```powershell
git add backend package-lock.json
git diff --cached --check
git commit -m "feat: add idempotent provider launch smoke"
git push
```

---

### Task 6: Add Pilot Access UI and Shared Reauthentication

**Files:**
- Create: `frontend/pilot-access.js`
- Create: `frontend/test/pilot-access.test.js`
- Modify: `frontend/app.js`
- Modify: `frontend/index.html`
- Modify: `frontend/styles.css`
- Modify: `frontend/i18n/index.js`
- Modify: `scripts/sync-frontend-to-public.js`

**Interfaces:**
- Produces: `createPilotAccessClient({ fetchImpl, requestAccess })` with raw `status`, `login`, and `logout` methods plus protected `ensureAuthenticated` and `fetch`.
- Produces: one blocking access dialog and one shared reauthentication promise.
- Replaces: direct app `/api` fetches through the existing `fetchJSON` entry point.

- [ ] **Step 1: Write browser-client concurrency and storage tests**

Simulate three concurrent protected requests returning 401. Assert `requestAccess` is called once, each request replays once, credentials are `same-origin`, and a second 401 is returned without recursion. Also prove raw `status` 401 opens exactly one dialog at initialization, bad `login` 401 is returned directly without joining/re-entering `reauthPromise`, and `logout` 401 does not open a dialog. Stub local/session storage and assert the raw code is never written.

- [ ] **Step 2: Implement the shared client**

```js
function createPilotAccessClient({ fetchImpl, requestAccess }) {
  let reauthPromise = null;
  const rawFetch = (input, init = {}) => fetchImpl(input, {
    ...init,
    credentials: 'same-origin'
  });
  const status = () => rawFetch('/api/pilot/status');
  const login = (accessCode) => rawFetch('/api/pilot/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accessCode })
  });
  async function authenticateOnce() {
    if (!reauthPromise) reauthPromise = Promise.resolve(requestAccess({ login })).finally(() => { reauthPromise = null; });
    return reauthPromise;
  }
  async function authenticatedFetch(input, init = {}, replayed = false) {
    const response = await rawFetch(input, init);
    if (response.status !== 401 || replayed) return response;
    await authenticateOnce();
    return authenticatedFetch(input, init, true);
  }
  async function logout() {
    reauthPromise = null;
    return rawFetch('/api/pilot/logout', { method: 'POST' });
  }
  return { status, login, logout, fetch: authenticatedFetch, ensureAuthenticated: authenticateOnce };
}

globalThis.HKBuddyPilotAccess = { createPilotAccessClient };
```

- [ ] **Step 3: Add the blocking dialog and initialize access before providers**

Insert the dialog before the app root scripts, with one password field, generic invalid/throttled states, and logout action. Initialization calls the client's raw `status()` before `/api/health`, voice discovery, session creation, or any provider route. The dialog submits only through raw `login()`. None of the three pilot endpoints may call `authenticatedFetch`, so their 401 responses cannot recursively enter the shared reauthentication promise. Clear the field after submit/success/reset.

Load the non-module global explicitly before the existing module app:

```html
<script src="pilot-access.js"></script>
<script type="module" src="app.js?v=20260709layout2"></script>
```

`app.js` reads `globalThis.HKBuddyPilotAccess` and fails closed with a visible initialization error if it is absent. The frontend test parses both `frontend/index.html` and synchronized `backend/public/index.html` and asserts this exact order before application initialization.

- [ ] **Step 4: Route every application request through the client**

Update `fetchJSON` to call the shared client; all existing provider call sites continue through it. Add `credentials: same-origin`. Remove transcript/upstream/raw error console statements from the browser.

- [ ] **Step 5: Sync and verify source/generated parity**

Add `pilot-access.js` to the sync manifest and script order.

The existing root `node --test` discovery includes both backend security and frontend browser-client tests.

```powershell
node --test frontend/test/pilot-access.test.js
npm run build
npm run sync:frontend:check
npm test
```

- [ ] **Step 6: Review, commit, and push**

```powershell
git add frontend scripts/sync-frontend-to-public.js backend/public
git diff --cached --check
git commit -m "feat: add pilot access UI and reauthentication"
git push
```

---

### Task 7: Redact Runtime Logs and Drain Gracefully

**Files:**
- Create: `backend/observability/safe-logger.js`
- Create: `backend/runtime/graceful-shutdown.js`
- Create: `backend/test/safe-logger.test.js`
- Create: `backend/test/graceful-shutdown.test.js`
- Create: `backend/test/privacy-contract.test.js`
- Modify: `backend/server.js`
- Modify: `frontend/app.js`

**Interfaces:**
- Produces: allowlisted `safeLogger` fields only.
- Produces: `createDrainController({ server, deadlineMs, logger, exit })` with `isDraining` and `begin`.
- Changes: readiness becomes 503 while draining and new smoke attempts are refused.

- [ ] **Step 1: Write privacy sink tests around known leak sites**

Feed synthetic prompt, user line, translation, transcript, audio base64, token, key, and upstream error body through failure/success paths. Assert none appears in logger sink, response, attempt cache, or browser console capture.

- [ ] **Step 2: Implement an allowlist logger**

```js
const ALLOWED_FIELDS = new Set([
  'requestId', 'routeFamily', 'status', 'latencyMs',
  'provider', 'errorCode', 'usage'
]);

const EVENT_MESSAGES = Object.freeze({
  'request.completed': 'request completed',
  'provider.failed': 'provider request failed',
  'smoke.completed': 'provider smoke completed',
  'shutdown.started': 'shutdown started'
});

export function safeLog(logger, level, eventId, fields) {
  if (!Object.hasOwn(EVENT_MESSAGES, eventId)) throw new Error('Unknown safe log event');
  const safeFields = sanitizeLogFields(fields);
  logger[level](safeFields, EVENT_MESSAGES[eventId]);
}
```

Replace the free-form `message` parameter with a fixed event id selected from an allowlist such as `request.completed`, `provider.failed`, `smoke.completed`, and `shutdown.started`; arbitrary `error.message` is never accepted. Map raw provider errors to stable codes before logging or responding.

Validate values as well as keys before forwarding: `routeFamily`, `provider`, and `errorCode` use closed allowlists; `requestId` is bounded ASCII; status/latency are bounded integers; `usage` is deep-copied from only `inputCharacters`, `outputCharacters`, `audioBytes`, and `audioDurationMs` after applying the smoke bounds. Reject the entire log call on an unknown nested key, stringified object, getter, prototype-bearing value, or out-of-range number.

Remove morgan's raw URL formatter and replace it with a request-completion middleware that records only request id, route family (not raw path/query), status, and latency. The privacy test captures actual `console`, request logger, and safe-logger sinks so a query string or upstream error body cannot bypass the field allowlist.

- [ ] **Step 3: Track active requests and bounded drain**

The drain controller stops accepting new connections, marks draining, waits for active requests up to `SHUTDOWN_DRAIN_MS` (default 10,000; max 30,000), closes the server, and exits. It handles SIGTERM/SIGINT once and never logs bodies.

- [ ] **Step 4: Wire drain truth into routes**

`/api/live` remains process-live until close; `/api/ready` returns aggregate 503 while draining; protected/provider routes return `SERVICE_DRAINING`; provider smoke refuses to begin after drain starts.

- [ ] **Step 5: Verify redaction and signals**

```powershell
node --test backend/test/safe-logger.test.js
node --test backend/test/graceful-shutdown.test.js
node --test backend/test/privacy-contract.test.js
npm test
npm run build
```

- [ ] **Step 6: Review, commit, and push**

```powershell
npm run sync:frontend
git add backend frontend/app.js backend/public/app.js
git diff --cached --check
git commit -m "fix: redact logs and drain gracefully"
git push
```

---

### Task 8: Produce HK-001 Golden Path Launch Evidence

**Files:**
- Create: `scripts/verify-hk001-launch-contract.js`
- Create: `docs/quality/hk001-golden-path-evidence.md`
- Modify: `README.md`
- Modify: `AZURE_DEPLOYMENT.md`

**Interfaces:**
- Produces: clean-clone local evidence and inputs consumed by Flash disposable-GCP verification.
- Guarantees: unavailable GCP/provider credentials remain an explicit blocker, never a pass.

- [ ] **Step 1: Add the clean-clone verifier**

The script checks root lockfile and actual Node/npm versions, runs canonical install/build/test commands in a temporary clone, chooses a free localhost port, and spawns the exact canonical `npm start` command with `NODE_ENV=test`, `PILOT_AUTH_DISABLED=true`, that port, and no provider secrets. Use `windowsHide: true`. Record the spawned process identity and close event. Only while that exact child/process group is still live may the Windows `finally` block invoke `taskkill.exe /PID <validated integer pid> /T /F`, or the POSIX path signal its detached negative group id (`SIGTERM`, then bounded `SIGKILL`). If the child already exited, never signal a possibly reused PID/PGID. In both cases await/confirm close and verify the chosen port can be rebound. The verifier polls `/api/live`, verifies frontend/public parity, writes no secrets, and fails if tree termination or port release cannot be proved.

- [ ] **Step 2: Run all local gates from a clean clone**

```powershell
node scripts/verify-hk001-launch-contract.js
npm ci
npm run build
npm test
```

Expected: the verifier proves clean canonical install/build/test/start, `/api/live` 200, and bounded child termination; the three direct commands exit 0.

- [ ] **Step 3: Run the Flash disposable candidate/browser flow**

After the Flash candidate plan is implemented, verify candidate liveness/readiness, one four-provider smoke, promotion readback, browser login/practice/translation/TTS/ASR/throttle/logout/re-login, injected smoke failure, and rollback readback. Record only status, latency, bounded usage, revision/traffic/IAM metadata, and timestamps.

This step is blocked until HK Tasks 4 and 5 are committed and Flash is configured to build that exact HK commit SHA; a branch tip or older readiness/smoke contract is not valid evidence.

- [ ] **Step 4: Commit and push evidence or blocker state**

```powershell
git add scripts/verify-hk001-launch-contract.js docs/quality/hk001-golden-path-evidence.md README.md AZURE_DEPLOYMENT.md
git diff --cached --check
git commit -m "test: add hk001 golden launch evidence"
git push
```

## Golden Path Exit Gate

Run:

```powershell
npm ci
npm run build
npm test
npm run sync:frontend:check
git status --short
```

Local implementation is complete only when these pass. Production launch readiness additionally requires the Flash disposable-GCP candidate, real four-provider smoke, promotion/IAM readback, browser flow, and rollback evidence to pass; otherwise both PRs remain draft with a named blocker.
