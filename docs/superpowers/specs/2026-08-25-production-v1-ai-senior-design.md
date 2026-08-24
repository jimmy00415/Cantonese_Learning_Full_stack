# Hong Kong Buddy Production V1 AI Senior Design

## Status

- Date: 2026-08-25
- Decision owner: product owner
- Execution mode: approved for direct implementation in an isolated worktree
- Product line: new `production-v1` application; the legacy tutoring/translation
  product remains unchanged
- Visual reference: Intercom-inspired conversational clarity, adapted to Hong
  Kong Buddy and Simplify rather than copied as a brand

## Product Goal

Build one dependable campus chat that feels like messaging a capable HKBU senior.
The student can send text or a short voice message. The AI senior answers in text,
can optionally provide a voice-message version, and cites current official HKBU
sources whenever it makes a campus-specific factual claim.

This is deliberately a messaging product, not a live call, realtime avatar, or
multi-mode tutor. Presence comes from continuity, fast honest state changes,
useful answers, and a stable profile—not from fake human status.

## Product Promise

> Ask the AI senior anything about getting started and living at HKBU. It will
> give the clearest next step it can verify, show where the information came
> from, and say plainly when it cannot confirm something.

The assistant must never imply that it is a real student, employee, or official
HKBU representative. The header identifies it as `Campus AI Senior · AI
assistant`, and the information sheet explains its limits.

## Scope Boundary and Isolation

Production V1 is a new top-level application under `production-v1/` with its own
package, runtime, public assets, data directory, tests, configuration example,
and deployment documentation.

It must not:

- modify the legacy `frontend/`, `backend/`, or `backend/public/` product;
- reuse the old `/api` routes or in-memory session map;
- change the existing Azure workflow or deploy over the existing app;
- commit, print, or copy secret values into tracked files;
- depend on an OpenAI API key that is not currently available.

For local verification, the V1 runtime may load the existing ignored
`backend/.env` through an explicit `ENV_FILE` path. That file remains read-only.
For a separate production deployment, secrets are configured as application
settings.

The canonical parent-brand asset is
`C:\Users\陈奕炜\Downloads\simplify-wordmark.svg`, verified at 1,033 bytes with
SHA-256 `80b8c7a6b9368cfde4b41c776c48c7523d537350c28d300fd1f72736cbe5bb87`.
Implementation copies those exact bytes into the isolated V1 assets; tests fail
if the hash differs.

## User Experience Contract

### One screen, one relationship

The entire signed-out V1 experience is one mobile-first conversation. There is
no mode picker, scenario picker, dashboard, practice panel, or separate voice
screen.

The layout has four durable regions:

1. A compact header with a stable illustrated profile mark, `Campus AI Senior`,
   the visible `AI assistant` label, and an information button.
2. A scrollable message timeline with assistant messages on the left, student
   messages on the right, compact timestamps by message group, source strips,
   and action cards only when useful.
3. An actual processing state directly above the composer, such as `Checking
   official HKBU information…`; it appears only when that work is happening.
4. A fixed composer above the safe area and mobile keyboard with text input,
   hold-to-talk, and send controls. Every touch target is at least 44 by 44 px.

The first visit contains one short disclosure and four starter prompts. It does
not contain a tutorial carousel.

### Messaging cadence

- The student bubble is persisted and rendered immediately after send.
- The server acknowledges a text send at P95 <= 300 ms under normal load.
- A truthful processing state appears as soon as the accepted turn starts.
- The final answer should arrive at P95 <= 8 seconds for a grounded text turn.
- Answers default to one to three short bubbles or paragraphs: direct answer,
  next action, then supporting source/card.
- The assistant asks one relevant follow-up when it materially helps; it avoids
  generic filler such as “Anything else?”.
- No fake typing delay, online dot, read receipt, last-active time, or human
  profile claim is allowed.

### Text and voice

Text is canonical and always available.

- The browser may record MP4/AAC on Safari, WebM/Opus, Ogg/Opus, or WAV, but raw
  container bytes never leave the device. After recording, the client decodes
  the complete blob, resamples/downmixes it, and encodes one canonical 16 kHz,
  mono, PCM16LE WAV for upload. Decode/normalization failure returns to text.
- Holding the microphone starts a short recording; release stops it and starts
  normalization/transcription. Pointer cancellation and a visible cancel action
  discard it. The client auto-stops at 55 seconds; the server independently
  enforces 60 seconds.
- A recording timer and `Release to transcribe` state replace the normal
  composer while recording.
- The resulting transcript is editable before send. Sending it creates a normal
  student message marked as voice-originated and keeps the normalized WAV for
  playback where configured.
- Microphone denial or unsupported recording never blocks text input.
- Assistant voice never autoplays. The first explicit action is `Generate
  voice`; completion only changes the control to ready. A second explicit user
  action plays the generated/reused attachment after the text answer exists.
- Voice playback always has pause/stop, duration where available, a visible
  transcript, and an `AI-generated voice` disclosure.
- TTS failure never changes or removes the text answer.

### Visual language

- Canvas: warm cream; message surfaces: white; text: charcoal; verified/source
  accents: restrained moss/green; active primary action: near-black.
- Typography: Inter with system fallbacks, dense enough to feel like a native
  messenger but with readable 16 px message text.
- Corners: 12-18 px for bubbles and cards, not fully rounded novelty UI.
- Borders: one-pixel hairlines; shadows are subtle and used only for the fixed
  composer and elevated sheet.
- Motion: brief opacity/position transitions, disabled under reduced-motion.
- Simplify is a quiet parent-brand attribution in the information sheet and the
  initial loading/splash state, using the supplied wordmark unchanged. Hong Kong
  Buddy remains the product identity.

### Accessibility

- WCAG 2.2 AA contrast, visible focus, semantic buttons, labels, live regions,
  keyboard send behavior, and screen-reader-compatible status updates.
- `Enter` sends and `Shift+Enter` inserts a newline on desktop; mobile keeps the
  explicit send button.
- Processing is announced once per state, not once per generated token.
- Voice has a complete text path; no information exists only in audio or color.
- The UI respects reduced motion, safe-area insets, and dynamic viewport height.

## Technical Architecture

### Runtime shape

Production V1 is a modular monolith:

```text
browser/PWA
  -> Express HTTP API
       -> session boundary
       -> message-store interface
       -> per-conversation turn queue
       -> curated HKBU retriever
       -> provider adapters
       -> media-store interface
  <- SSE state and delivery notifications
```

The new service serves its own static client and API from one origin. Ordinary
HTTPS performs session creation, message sends, message backfill, voice upload,
transcription, and TTS requests. SSE only accelerates updates for the currently
open conversation; `GET /messages` is authoritative after reconnect.

### V1 deployment shape

V1 uses Node.js 22 or newer. Production persistence is PostgreSQL; production
voice media is Azure Blob-compatible object storage. A serialized atomic-file
message store and local media adapter exist for tests and local product preview
only. They prove restart behavior on one process but never satisfy production
readiness.

SQLite is intentionally excluded from the cloud release path: current Node 24
documents `node:sqlite` as a release-candidate API, and Azure App Service
explicitly warns against SQLite or other lock-dependent local databases on its
storage mounts. The authoritative references are the
[Node 24 SQLite documentation](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
and [Azure storage-mount guidance](https://learn.microsoft.com/en-us/azure/app-service/configure-connect-to-azure-storage).
Student accounts and cross-device identity are a later version;
V1 uses an anonymous, opaque, HttpOnly session cookie.

The first production release runs exactly one application worker/replica. A
durable database dispatcher and fenced leases still close the crash window
between HTTP 202 and execution. Multi-instance capacity policy is deferred until
load evidence and operational ownership exist; it is not silently enabled.

When `NODE_ENV=production`, startup fails closed unless all of these are set:

- `V1_PUBLIC_ORIGIN`
- `V1_SESSION_SECRET` with at least 32 bytes of entropy
- `V1_STORE_DRIVER=postgres`, `V1_DATABASE_URL`, and the non-secret
  `V1_POSTGRES_RESOURCE_ID`
- `V1_MEDIA_DRIVER=azure-blob`, V1-prefixed container credentials/settings, and
  the non-secret `V1_BLOB_RESOURCE_ID`
- a digest-bound, product/operations-owner-approved legacy resource inventory
  through `V1_LEGACY_RESOURCE_INVENTORY_FILE` and
  `V1_LEGACY_RESOURCE_INVENTORY_VERSION`
- at least one real LLM provider
- `V1_INSTANCE_POLICY=single`
- explicit `V1_TRUST_PROXY_HOPS`
- `V1_PRIVACY_NOTICE_VERSION` plus `V1_PRIVACY_NOTICE_APPROVED=true`
- `V1_RETENTION_WORKER_ENABLED=true`

Development may use a generated local secret, atomic file/local media paths, and
a deterministic provider fallback, but health reports `productionReady: false`
in any of those states.

Session capabilities expose the privacy notice version and separate speech
states, never keys/settings: `asrConfigured`, `ttsConfigured`, local
`voiceInputPreview`/`voiceOutputPreview`, release `voiceInput`/`voiceOutput`, and
non-secret evidence versions. They also expose server-owned build metadata:
`releaseCommitSha` (a configured 40-hex SHA, otherwise `null` outside a frozen
candidate) and the exact `normalizerContractVersion`. Neither field may be
supplied or overridden by a query parameter or client payload. In production,
`voiceInput` requires Azure ASR
configuration, a successful bound ASR smoke version, and a bound real-iOS Safari
acceptance version; `voiceOutput` requires selected TTS configuration and a
successful bound TTS smoke version. Missing/failed evidence forces the
corresponding release capability false while text remains usable. Development
may expose the clearly labeled preview flags for fake/local verification, but a
configured provider is never described as verified or release-available.

Speech evidence is executable configuration, not a status label. The guarded
smoke command runs exactly one selected capability per process:
`--capability tts --confirm-real-voice-provider`, or `--capability asr
--asr-file <absolute-canonical-wav> --confirm-real-voice-provider
--confirm-asr-audio-nonsensitive`. It makes one call with no provider fallback
or retry; ASR mode cannot call TTS and TTS mode cannot call ASR.

Each successful record contains `schemaVersion`, `commitSha`, `capability`,
`provider`, `contractVersion`, `providerConfigDigest`, ASR-only
`fixtureSha256`/`fixtureDurationMs`, `occurredAt`, `result`, `latencyMs`, and
`artifactSha256`, where the artifact digest hashes the canonical record without
that field. The config digest hashes the exact selected non-secret provider,
normalized endpoint origin/path, region, model, voice, output settings, and a
required non-secret credential-rotation ID
(`V1_AZURE_SPEECH_CREDENTIAL_VERSION` or
`V1_MINIMAX_CREDENTIAL_VERSION`)—never a key, audio, transcript, prompt, header,
or raw body. ASR and TTS use independent files
`V1_ASR_SMOKE_EVIDENCE_FILE` and `V1_TTS_SMOKE_EVIDENCE_FILE`, so both can be
enabled deterministically. `V1_RELEASE_COMMIT_SHA` and the applicable
`V1_ASR_SMOKE_EVIDENCE_VERSION`/`V1_TTS_SMOKE_EVIDENCE_VERSION` must match each
record's commit and artifact digest. Startup recomputes the selected config
digest and rejects malformed, failed, mismatched, older-than-30-days, or more
than five-minutes-future evidence.

Real-iOS input evidence is a separate safe record loaded from
`V1_IOS_VOICE_ACCEPTANCE_FILE`; `V1_IOS_VOICE_ACCEPTANCE_VERSION` is its
artifact digest. It binds commit, client normalizer/contract version, device
model class, iOS/Safari versions, capture MIME, fixture SHA/duration,
permission/cancel/55-second-stop/no-raw-upload assertions, result, time, and
artifact digest. It expires after 90 days or immediately when commit,
normalizer/contract, or configured input path changes, and timestamps more than
five minutes in the future are invalid. Every production voice POST re-evaluates
the loaded records against an injected current clock, including the 30/90-day
age and future-skew rules; expiry after startup therefore fails closed without a
restart. Missing or invalid speech/iOS evidence makes the corresponding
production POST fail 503 before claim, quota, body read, or provider transport;
development preview remains a separate non-production capability.

The iOS record is produced only by the opt-in real-app diagnostic on an isolated
HTTPS candidate plus the guarded local `acceptance:ios-voice` validator. The
diagnostic reads `releaseCommitSha` and `normalizerContractVersion` only from
the authenticated session bootstrap response and fails closed if either is
missing or malformed. It exports a content-free receipt of instrumented MP4/AAC normalization,
55-second stop, permission/cancel cleanup, one canonical idempotent upload,
editable transcript, text fallback, and zero raw-container network requests.
The validator requires a clean current HEAD matching `V1_RELEASE_COMMIT_SHA`,
explicit real-device/non-sensitive confirmations, exact receipt schema/origin/
versions/assertions, two-hour receipt age and five-minute future skew, refuses
the legacy origin, makes no network call, and writes only the ignored canonical
`reports/ios/<commit>-<artifact>.json` file.

## Data Model

### `sessions`

- `id`
- `token_hash` (unique; raw token only exists in the HttpOnly cookie)
- `client_scope_id` (opaque, non-secret, stable only for this session)
- `created_at`
- `last_seen_at`

### `conversations`

- `id`
- `session_id`
- `version`
- `created_at`
- `updated_at`

V1 creates exactly one active conversation for an anonymous session.

### `messages`

- `id`
- `conversation_id`
- `sequence` (unique within the conversation)
- `role`: `user | assistant`
- `kind`: `text | voice`
- `text`
- `status`: `accepted | delivered | failed`
- `media_id` (nullable)
- `citations_json`
- `cards_json`
- `created_at`

### `turns`

- `id`
- `conversation_id`
- `inbound_message_id`
- `client_message_id`
- `request_hash`
- `state`: `accepted | retrieving | generating | delivered | failed`
- `failure_code` (nullable, stable machine code)
- `attempt`
- `lease_expires_at` (nullable; enables safe restart recovery)
- `lease_token` (nullable; required as a fencing token on every worker write)
- `created_at`
- `updated_at`

`(conversation_id, client_message_id)` is unique. Repeating a send with the same
client ID and request hash returns the original message/turn and never creates a
second answer. Reusing it with different content returns an idempotency conflict.

### `events`

- `id`
- `conversation_id`
- `cursor` (unique, monotonically increasing within the conversation)
- `type`
- `payload_json` (safe state/message identifiers only)
- `created_at`

Accepted messages, turn transitions, terminal delivery, audio readiness, and
failure events are persisted. SSE is therefore an acceleration layer with
replay, not an ephemeral source of truth.

### `media_assets`

- `id`
- `session_id`
- `owner_message_id` (nullable until a voice draft is sent)
- `kind`: `user_voice | assistant_voice`
- `storage_key` (opaque per asset; never caller supplied or globally
  content-addressed across sessions)
- `mime_type`
- `byte_length`
- `duration_ms` (nullable)
- `sha256`
- `status`: `draft | attached | failed`
- `created_at`
- `updated_at`, `expires_at` (nullable)

Media IDs are opaque and access is limited to the current session. SHA-256 is
used for integrity and idempotency, not as a cross-session storage key.
`storage_key` is globally unique and never reused.

### `voice_uploads`

- `id`, `session_id`, `client_upload_id`
- `request_sha256`, `mime_type`
- `state`: `uploading | transcribing | ready | failed`
- `attempt`, `lease_token`, `lease_expires_at`
- `attempt_storage_key`, `attempt_started_at`, `attempt_deadline_at`, `created_at`,
  `updated_at`
- `media_asset_id`, `transcript`, `failure_code`, `failure_http_status`,
  `retryable`

`(session_id, client_upload_id)` is unique. Same-ID/same-hash retries return the
existing ready draft or current live state without a second ASR call; same-ID
with a different hash or MIME is an idempotency conflict. After an expired or
failed claim, upstream ASR is explicitly at-least-once: a reclaim may call it
again, while fencing guarantees only one durable ready result/media attachment.
Claims, reclaims, completion, and failure are fenced.
`session_id` references sessions with cascade; `media_asset_id` is nullable and
uses set-null until fenced completion. A unique nullable attempt key and an index
on `(state, lease_expires_at, updated_at)` support reclaim and cleanup.

### `media_generations`

- `id`, `owner_message_id`, `kind`
- `state`: `generating | attached | failed`
- `attempt`, `lease_token`, `lease_expires_at`
- `attempt_storage_key`, `attempt_started_at`, `attempt_deadline_at`, `created_at`,
  `updated_at`
- `media_asset_id`, `failure_code`, `failure_http_status`, `retryable`,
  `config_version`

`(owner_message_id, kind)` is unique. V1 uses `kind=assistant_voice`. Only a live
lease may attach an object, persist `audio.ready`, or record terminal failure;
an expired attempt may be reclaimed without allowing the stale worker to win.
`owner_message_id` references messages with cascade; `media_asset_id` is nullable
and uses set-null until fenced attachment. A unique nullable attempt key and an
index on `(state, lease_expires_at, updated_at)` support reclaim.

### `media_deletion_jobs`

- `id`, `storage_key`, `reason`, `not_before`
- `state`: `pending | deleting | completed`, `attempt`, `generation`
- `lease_token`, `lease_expires_at`, `last_error_code`
- `created_at`, `updated_at`, `completed_at` (nullable)

Session/draft deletion revokes access and copies every attached, draft, and
in-flight `attempt_storage_key` into this outbox in the same database mutation
before owned rows are removed. The outbox does not foreign-key back to the
session/asset rows and therefore survives their cascade. Its unique
`storage_key` deduplicates cleanup. Physical object deletion is retryable and
fenced; object-not-found counts as success.
The claim index is `(state, not_before, lease_expires_at)`; a completed job keeps
its terminal timestamp, and no owner-row cascade can remove it.

Ordinary `enqueueMediaDeletion(storage_key, ...)` is a generation-aware atomic
upsert: a new key creates generation 1 and repeated pre-delete enqueue coalesces
the safe `not_before`. A distinct
`rearmMediaDeletionAfterWrite(storage_key, ...)` is mandatory after any write
whose fence is lost. It increments generation and resets the job to pending from
*every* prior state, including pending, deleting, or completed; it clears
terminal/lease fields and applies the new `not_before`. Cleanup claim/complete/
fail require both generation and fencing token, so the previous delete worker
cannot complete after a concurrent late write. This closes both
object-not-found-then-write and delete-returned-before-DB-complete windows.

Every upload/generation claim allocates and persists its opaque attempt key and
non-extendable `attempt_deadline_at` in the same mutation as
attempt/lease/quota before any body/provider work. Voice ingress has a 30-second
absolute/10-second idle body deadline; provider and media writes each have a
15-second deadline. A voice-upload attempt therefore has a hard 60-second total
horizon from claim, and a TTS attempt a hard 30-second horizon. Lease renewal can
never extend that horizon. Session deletion revokes those leases and sets each
job's `not_before` no earlier than `max(lease_expires_at, attempt_deadline_at)`
plus a 60-second late-write/clock-skew grace. Workers recheck the session and lease immediately
before and after every object write. A post-write lost fence must enqueue the
already-known key. A bounded prefix sweeper may delete only keys older than the
same lease/deadline/grace horizon with no live row reference; it never deletes a
key merely because it is absent from the current process memory.

An expired/retryable reclaim never overwrites the only reference to the previous
attempt key. In the same atomic claim/quota mutation it generation-rearms a
deletion-outbox job for that displaced key with
`not_before >= max(old lease expiry, old hard deadline, reclaim time) + 60s`, and
only then stores the new unique attempt key. A crash before commit leaves the old
row reference; a crash after commit leaves durable old-key cleanup plus the new
row. If the stale worker writes afterward, its post-write rearm increments the
job generation again and fences any prior cleanup worker.

### `rate_limit_buckets` and `service_state`

Durable rate-limit buckets store only an HMACed subject key, quota name, window,
count, and expiry. `service_state` records retention-worker heartbeat and last
successful cleanup without storing message content. Both adapters implement the
same semantics so local tests and production PostgreSQL use one contract.

## API Contract

All JSON endpoints return `{ data, error, requestId }`. Errors expose stable codes
and safe user messages, not provider payloads, stack traces, or secrets.

### Session and timeline

- `POST /api/v1/session`
  - Creates or resumes the opaque-cookie session and its conversation.
  - Returns conversation metadata, capability flags, initial messages, and
    knowledge snapshot date. It also returns `clientSessionScope` from the
    session's non-authorizing opaque scope ID so private client-side pending
    uploads can be purged rather than attached after cookie/session replacement.
- `GET /api/v1/messages?after=<sequence>`
  - Returns ordered canonical messages and active turn state.
- `GET /api/v1/events?afterCursor=<cursor>`
  - `afterCursor` bootstraps the first connection. A valid numeric
    `Last-Event-ID` takes precedence on native EventSource reconnect; if it is
    lower than a simultaneous query cursor, the request fails as an attempted
    rewind.
  - Establishes a buffered live subscription, captures the durable high-water
    cursor, drains every persisted event `(resumeCursor, highWater]` in ascending
    bounded pages, then flushes buffered events above the high-water cursor in
    order and switches to live delivery. Every event uses its cursor as SSE
    `id`; duplicate cursors are ignored. Buffer overflow closes with a safe
    `resync_required` event without an SSE `id`, so the client reconnects from
    its last durably delivered cursor. Live notifications only trigger a drain
    from the durable store; they are never trusted as the event payload. Socket
    backpressure closes safely for replay instead of growing an unbounded
    buffer. No backlog page is silently skipped.
  - Streams `turn.state`, `message.delivered`, `audio.ready`, `turn.failed`, and
    heartbeat after catch-up.

### Sending

- `POST /api/v1/messages`
  - Body: `clientMessageId`, `text`, optional `voiceDraftId`.
  - Validates length, persists message and turn transactionally, queues work,
    and returns HTTP 202.
  - Empty, oversized, reused-with-different-payload, or unauthorized voice draft
    requests fail without queueing a turn.

### Voice

In production, transcription writes require release `voiceInput=true` and new
TTS generation requires `voiceOutput=true`. After Origin/session/ownership but
before idempotency claim, quota, body, or provider transport, a false capability
returns 503 `VOICE_NOT_RELEASE_VERIFIED` with zero state/cost side effect. Local
development may use the separately labeled preview capability; status/media GET
and deletion remain available for already-owned records.

- `POST /api/v1/voice/transcriptions`
  - Requires `X-Client-Upload-Id` (UUID) and `X-Content-SHA256` (64 lowercase
    hex) and accepts only canonical `audio/wav` PCM from the client normalizer.
  - Performs Origin, session, headers/declared length, and one atomic durable
    quota-plus-upload-attempt claim before reading body bytes. The new/reclaim
    branches atomically consume quota, increment attempt, and persist lease token,
    expiry, and attempt storage key in truthful `uploading` state. Only a fenced
    transition after actual SHA and canonical-WAV validation changes it to
    `transcribing`. Ready/live/permanent-failure/conflict branches do not consume
    quota; 429 creates or changes no claim. Same-ID/same-hash
    ready retries reuse the result without quota or ASR; a changed hash/MIME is
    HTTP 409.
  - Streams no more than 8 MiB into a private temporary object with a 30-second
    absolute and 10-second idle body deadline and verifies the
    actual SHA. It then requires an exact 44-byte RIFF/WAVE header, PCM format 1,
    mono, 16 kHz, 16-bit, byte rate 32000, block alignment 2, even data length,
    internally consistent RIFF/data lengths, no trailing chunks, and no more
    than 1,920,000 PCM bytes/60 seconds. Browser duration is never trusted.
  - Stores an owned draft, calls the configured ASR provider, and returns an
    editable transcript plus draft metadata.
  - Validation or ASR failure deletes the temporary object; no failed transcript
    or orphaned upload is retained.
  - A newly completed upload returns 201, ready idempotent reuse returns 200, an
    already-active same-hash lease returns 202 with truthful
    `uploading|transcribing`, `Location`, and `Retry-After: 1`, and hash/MIME
    conflict returns 409. Only retryable failed or expired work is reclaimed,
    always with a new fenced provider-attempt quota claim.
- `GET /api/v1/voice/uploads/:clientUploadId`
  - Same-session operation status. A live `uploading`/`transcribing` attempt is
    202 only while both lease and hard deadline are current. Ready returns 200.
    Failed returns 200 with stable `failureCode` and `retryable`; an expired live
    row is projected as 200 `{ state:"failed", retryable:true,
    failureCode:"VOICE_ATTEMPT_EXPIRED" }`. Missing/cross-session IDs are the
    same 404. A ready response contains the same editable transcript/draft as the
    original 201.
  - Pre-claim malformed-header 400, declared-size 413, and media-type 415 create
    no operation and are re-evaluated on a later request. Post-claim streamed-size
    413 and SHA/WAV/duration 422 persist `retryable:false` plus their safe HTTP
    status; a same-ID/hash POST returns that result without quota/body/provider.
    Only outcomes explicitly marked retryable in the exact taxonomy below, plus
    expiry, may acquire a new quota-bearing fenced attempt; non-retryable 5xx
    provider-contract/config results also reuse their stored result.
    Conflict/authorization are not stored as retryable operations.
- `DELETE /api/v1/voice/drafts/:draftId`
  - Revokes the current session's unattached draft and durably enqueues physical
    deletion. Missing and cross-session IDs both return 404.
- `POST /api/v1/messages/:messageId/audio`
  - Delivered assistant messages only. It takes no client text/voice parameters,
    reuses an attached result, or atomically claims one fenced TTS generation.
    Only a live claim may attach media and emit `audio.ready`; ready reuse/poll
    does not consume generation quota.
  - New/reclaim generation claim and TTS quota consumption are one store
    mutation. It increments attempt and persists token, expiry, attempt key, and
    config version; ready/live/conflict branches do not consume quota, and 429
    creates or changes no claim.
  - Ready reuse returns 200; another live claim returns 202 `generating` with
    `Location` and `Retry-After: 1`; the
    request that acquires a claim performs one bounded call and returns 201 only
    after fenced attachment. Only retryable failed or expired work can be
    reclaimed idempotently.
- `GET /api/v1/messages/:messageId/audio/status`
  - Same-session generation status. A generation is live 202 only while lease
    and hard deadline are current. Attached returns 200. Failed returns 200 with
    stable `failureCode`/`retryable`; an expired row is projected as retryable
    `VOICE_ATTEMPT_EXPIRED`. Missing, cross-session, and non-assistant IDs are
    indistinguishable 404s. Only retryable failure/expiry permits another POST;
    permanent failure is reused without new quota/provider work.
- `GET|HEAD /api/v1/media/:mediaId`
  - Streams only media owned by the current session; missing and cross-session
    IDs are indistinguishable 404s and never open Blob content.
  - GET without Range returns 200. One valid `bytes=start-end`, `start-`, or
    `-suffix` range returns 206. Invalid, multiple, overflowing, or unsatisfiable
    ranges return 416 with `Content-Range: bytes */<size>`. HEAD returns 200,
    ignores Range, and has no body.
  - Authorized 200/206/416 responses set private `no-store`, `nosniff`,
    `Accept-Ranges: bytes`, and exact length/range metadata. A 200/HEAD length is
    the full asset; a 206 length is the selected range; a 416 has
    `Content-Range: bytes */<size>` and a length for its safe error body. A 404
    sets only generic no-store/nosniff response headers and never reveals size,
    range support, or Blob existence. The server never returns a Blob/SAS URL.

Voice errors use phase-specific precedence rather than one impossible global
ordering. Before any durable claim/body read: Origin 403; session/ownership
401/404; production release capability 503 `VOICE_NOT_RELEASE_VERIFIED`;
malformed UUID/hash/header 400; declared length over a hard cap 413; wrong media
type 415; existing idempotency/state conflict or permanent stored failure
409/original safe status; atomic claim/quota 429. Therefore a request combining
a disabled release capability with malformed/oversized/wrong-MIME input returns
the capability 503 and reads no body. These failures create no new attempt or
quota side effect except a previously stored result.

After a claim, the stream decides by actual first event: each received chunk
checks size before processing bytes, so a cap-crossing chunk produces 413; if
the idle/absolute timer fires first it produces 408. Either persists the attempt
with its defined retryability and cleans/enqueues its key; quota is not rolled
back. SHA/WAV/duration validation is 422; media/store unavailable is 503;
provider invalid/unavailable is 502; provider deadline is 504. Stable public
error codes accompany every status without exposing provider/media content.

The persisted outcome taxonomy is exact; only transient rows may consume quota
on a same-identity retry:

| Outcome after claim | Public status/code | Retryable |
|---|---|---|
| client disconnect before completion | no current response; stored 408 `VOICE_UPLOAD_ABORTED` | true |
| ingress idle/absolute timeout | 408 `VOICE_UPLOAD_TIMEOUT` | true |
| streamed cap crossing | 413 `VOICE_UPLOAD_TOO_LARGE` | false |
| SHA mismatch | 422 `VOICE_HASH_MISMATCH` | false |
| malformed/noncanonical/over-duration WAV | 422 `VOICE_INVALID_WAV` | false |
| Azure `NoMatch`, initial-silence/babble timeout, or fixed-input rejection | 422 `VOICE_SPEECH_NOT_RECOGNIZED` | false |
| provider authentication/configuration rejection | 503 `VOICE_PROVIDER_MISCONFIGURED` | false |
| provider 2xx malformed/oversized/wrong-content successful response | 502 `VOICE_PROVIDER_INVALID_RESPONSE` | false |
| other non-rate-limit provider 4xx/refusal | 502 `VOICE_TRANSCRIPTION_REJECTED` or `VOICE_SYNTHESIS_REJECTED` | false |
| network, upstream 408/429/5xx | 502 `VOICE_TRANSCRIPTION_FAILED` or `VOICE_SYNTHESIS_FAILED` | true |
| total provider deadline | 504 `VOICE_PROVIDER_TIMEOUT` | true |
| media write unavailable/timeout | 503 `VOICE_MEDIA_UNAVAILABLE` | true |
| expired live lease/hard horizon | status 200 `VOICE_ATTEMPT_EXPIRED` | true |

The ASR/TTS adapters normalize provider responses into these categories rather
than one generic 502. The same ID/hash or message/kind POST reuses a
non-retryable stored code/status with no claim, quota, body, or provider work.
Regression tests cover each fake-provider category and prove only rows explicitly
marked retryable plus expiry can acquire another fenced attempt.

Session deletion and claim use the same active-session serialization boundary.
If a claim commits first, deletion must capture its attempt key, revoke the
lease, and enqueue cleanup before cascading owner rows. If deletion commits
first, a stale-auth claim returns indistinguishable 401/404 with no quota,
upload/generation row, key, object, or foreign-key error. A worker that writes
after losing either race must call the generation-incrementing post-write rearm
operation before returning.

### Operations

- `GET /api/health/live`: process liveness only.
- `GET /api/health/ready`: selected message store, selected media store, knowledge
  corpus, provider configuration, and deployment-boundary checks; no secret
  values.

## Turn Processing and Concurrency

1. Persist the user message, `accepted` turn, idempotency record, and accepted
   event in one transaction.
2. Return HTTP 202 before model work.
3. A database-backed dispatcher continuously scans accepted work; it does not
   depend on the HTTP handler's in-memory enqueue succeeding. It atomically
   claims the earliest unfinished turn for a conversation, assigns a random
   fencing token and lease expiry, and renews the lease during provider work.
   Expired leases are safely reclaimed after restart. Renew, transition,
   failure, and delivery writes require both the matching fencing token and an
   unexpired lease; losing a lease aborts provider work.
4. Set `retrieving`, select approved knowledge entries, and emit a real state.
   Build context with `getTurnContext(turnId)`: prior completed user/assistant
   pairs plus the current inbound message only. Later accepted turns never enter
   an earlier turn's prompt, even when their user-message sequence is lower than
   the first assistant reply's sequence.
5. If the message requests an HKBU fact and evidence is insufficient, deliver a
   transparent unverified response with an official help/directory source; do
   not ask a model to guess.
6. Set `generating`, call the selected real provider with a bounded evidence
   pack and strict JSON response contract.
7. Validate every claim-level evidence ID and action/card against the retrieved
   allowlist.
8. If provider output is invalid or the provider fails, deliver a conservative
   deterministic evidence summary where evidence exists. Otherwise deliver the
   honest unverified response.
9. Persist one final assistant message, terminal turn state, and delivery event
   in a single transaction only when the current fencing token still matches,
   then emit the persisted `message.delivered` event. A unique assistant-per-turn
   constraint makes a stale worker unable to duplicate a reply.

Provider transport returns bounded raw text and metadata; the answer service is
the only layer that parses and validates model output. LLM retries are limited
to one retry for transient failures and use the same serialized request,
evidence snapshot, turn, and 12-second total deadline across both attempts. The
deadline covers response-body reading and the body is capped. ASR/TTS do not
retry automatically inside one request; a later user retry reuses or safely
reclaims the same durable upload/generation contract and never changes text-turn
delivery.

## Knowledge and Grounding

### V1 source strategy

V1 uses a small reviewed corpus of official HKBU pages, not an uncontrolled web
crawler. This gives a safer and faster path to production while keeping a clear
upgrade path to scheduled ingestion and vector search.

Each knowledge record includes:

- `id`, `title`, `publisher`, `canonicalUrl`
- `verifiedAt` and source-level metadata
- `risk`: `normal | time_sensitive | high_stakes`
- `tags`, bilingual example questions, and atomic `claims`
- optional `contact` and allowlisted actions
- a short paraphrased evidence note and reviewer attestation tying each claim to
  its precise official page section without treating copied page text as model
  instructions

Every claim—not merely every page—has its own globally unique `id` (the evidence
ID), `sourceId`, `sourceLocator`, `verifiedAt`, optional
`validFrom`/`validUntil`, `reviewAfter`, volatility, and verification status. All
time boundaries are RFC 3339 instants with a Hong Kong offset. Runtime status
distinguishes `verified`, `review_overdue`, `expired`, `not_yet_valid`,
`conflicted`, and `unverified`; only `verified` claims may support a verified
answer. A page containing a 2026 schedule and a stale 2025/26 note therefore
cannot accidentally promote both as current.

The initial corpus covers student identity/account help, Duo/MFA, Academic
Registry and campus navigation, accommodation/check-in, IT support, library,
dining, health, student affairs, transport, and emergency/help contacts where
an official source is available.

Food opening status, residence procedures, dates, fees, policies, health, and
emergency information are time-sensitive. Their entries require a review date.
Expired entries may still be linked but cannot support a confident factual
answer.

Immediate danger, fire, serious injury, self-harm, or violence bypasses normal
retrieval/generation. The application displays the official emergency path
first—999 for an immediate emergency and the verified HKBU security contact—then
offers only short, safe follow-up guidance.

### Retrieval and validation

V1 retrieval is deterministic lexical/tag matching with bilingual aliases. It
returns a small evidence pack with claim-level evidence IDs. This is sufficient for
the bounded initial corpus and is easier to audit than premature embeddings.

The model must return:

```json
{
  "replyText": "...",
  "evidenceIds": ["claim-id"],
  "cards": [],
  "suggestedReplies": [],
  "needsClarification": false,
  "groundingStatus": "verified"
}
```

The application, not the model, validates evidence IDs and folds their source
records into deduplicated URLs/cards. Unknown evidence IDs, arbitrary
URLs/actions, and `verified` without a valid current claim are rejected.

## Provider Strategy

Production V1 reuses existing working configuration without exposing it:

- LLM: configured HKBU, Azure OpenAI, or MiniMax chat-completion endpoint.
- ASR: Azure Speech short-audio REST is the only V1 ASR adapter. There is no
  silent provider fallback, and Fast Transcription/MiniMax ASR are deferred.
- TTS: configured Azure Speech or MiniMax provider.

`V1_LLM_PROVIDER`, `V1_ASR_PROVIDER`, and `V1_TTS_PROVIDER` override the legacy
provider selectors. Provider adapters receive only the settings they require and
return normalized results. Logs contain provider name, latency, status class,
request ID, and token/byte counts when available—never prompts, transcripts,
message text, keys, authorization headers, or raw provider error bodies.

A deterministic provider exists only for automated tests and explicit local
demo mode. Production readiness fails if it is selected.

Provider configuration precedence and required pairs are explicit:

- LLM selector: `V1_LLM_PROVIDER`, then `LLM_PROVIDER`; allowed `hkbu`,
  `azure-openai`, `minimax`, and test-only `deterministic`.
- HKBU: `HKBU_API_KEY` plus `HKBU_BASE_URL`, `HKBU_MODEL`, and
  `HKBU_API_VERSION` defaults.
- Azure OpenAI: `AZURE_OPENAI_KEY` plus `AZURE_OPENAI_ENDPOINT`, with deployment
  and API version settings.
- MiniMax LLM/TTS: `MINIMAX_API_KEY`, base URL, Anthropic base URL, selected LLM
  model, and selected TTS model/voice.
- ASR selector: `V1_ASR_PROVIDER`, then `ASR_PROVIDER`; V1 supports only `azure`,
  requiring `AZURE_SPEECH_KEY` and a validated region. An inherited `minimax`
  selector is reported configured/available false and never routed. Azure calls
  exactly `https://{region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=zh-HK&format=simple`
  with `Ocp-Apim-Subscription-Key`, `Content-Type: audio/wav;
  codecs=audio/pcm; samplerate=16000`, and `Accept: application/json`.
  The bounded 256 KiB JSON response must have `RecognitionStatus=Success` and a
  non-empty `DisplayText`; confidence is included only when the provider actually
  supplies a finite value.
- TTS selector: `V1_TTS_PROVIDER`, then `TTS_PROVIDER`; unsupported or incomplete
  voice configuration disables that capability rather than affecting text.
  Azure calls exactly
  `https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` with
  `Ocp-Apim-Subscription-Key`, `Content-Type: application/ssml+xml`, fixed
  `zh-HK-HiuMaanNeural`, `X-Microsoft-OutputFormat:
  audio-24khz-48kbitrate-mono-mp3`, and `User-Agent:
  HongKongBuddy-ProductionV1/0.1`. Its UTF-8 request body has no optional prosody
  or client fields and is serialized exactly as
  `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="zh-HK"><voice name="zh-HK-HiuMaanNeural">${escapeXml(text)}</voice></speak>`.
  `escapeXml` replaces `&`, `<`, `>`, `"`, and `'` in an order-safe text-node
  encoding and never accepts prebuilt SSML. The response must be `audio/mpeg`, no
  more than 4 MiB, and have a valid MP3 ID3/frame signature.
  MiniMax uses the configured fixed
  model/voice, `language_boost=Chinese,Yue`, `stream=false`, and
  `output_format=hex`, with fixed `audio_setting` of mono MP3, 32 kHz, and 128
  kbps. It requires `base_resp.status_code === 0`, `data.status === 2`, a
  non-empty even-length hex-only `data.audio` of at most 8 MiB characters, and
  (when present) exact `extra_info.audio_size`. The raw JSON is capped at 9 MiB;
  decoded audio is capped at 4 MiB and must pass MP3 signature validation before
  acceptance. MiniMax calls exactly `{MINIMAX_BASE_URL}/v1/t2a_v2` with
  `Authorization: Bearer <key>` and `Content-Type: application/json`. Its body is
  exactly the configured fixed `model`, server-owned `text`, `stream:false`,
  `output_format:"hex"`, `language_boost:"Chinese,Yue"`,
  `voice_setting:{voice_id,speed:1,vol:1,pitch:0}`, and
  `audio_setting:{sample_rate:32000,bitrate:128000,format:"mp3",channel:1}`; no
  client field can override it.

LLM work has one 12-second total deadline across the initial request, bounded
response read, retry delay, and at most one retry for network failure, timeout,
408, 429, or 5xx. Authentication, refusal/content filter, and invalid successful
output are not retried.
ASR and TTS each have one 15-second total deadline including body read, HTTPS-only
transport, `redirect: 'error'`, bounded provider responses, and no automatic
retry inside the request. The user can retry the same owned upload/message action
idempotently.

## Security and Privacy

- Anonymous session cookies are `HttpOnly`, `SameSite=Lax`, path-scoped, signed
  through a stored token hash, and `Secure` in production.
- Session lookup is constant-shape and media/conversation access is always
  ownership-checked.
- JSON body limits, text limits, streaming binary limits, strict canonical-WAV
  validation, opaque storage keys, timeout/abort control, write-request Origin
  validation, and per-session rate limits are mandatory.
- Every state-changing request requires an `Origin` exactly matching the
  configured origin; missing or cross-origin writes fail with
  `ORIGIN_NOT_ALLOWED`. Production explicitly configures numeric trusted-proxy
  hops before deriving a bootstrap IP hash.
- Durable default quotas are: 20 session bootstraps per 10 minutes per HMACed
  client-IP key, 30 messages per 5 minutes and 300 per day per session, 10 voice
  uploads per 10 minutes and 60 per day, and 5 TTS generations per 10 minutes
  plus 20 per day. A 429
  response includes `RATE_LIMITED` and `Retry-After`; deployments may lower but
  not silently remove these limits.
- Multi-window claims evaluate every applicable bucket atomically. If several
  buckets are exhausted, the store returns the latest `blocking_expires_at`
  regardless of bucket order and HTTP derives `Retry-After` as the positive
  ceiling of its remaining seconds; no rate counter, claim, or operation row is
  changed. This rule applies equally to chat, ASR, and TTS.
- CORS is same-origin by default. Production accepts only `V1_PUBLIC_ORIGIN`.
- Security headers include CSP, frame denial, referrer policy, content-type
  protection, and permissions policy for microphone use.
- User content is not written to normal request logs. Request IDs make failures
  supportable without exposing conversations.
- Before first microphone use, the UI explains that audio and transcript are
  sent to the selected configured speech/model providers to produce the reply;
  recording begins only after the user's explicit action. The information sheet
  explains AI identity, current third-party processing categories, source
  freshness, generated voice, anonymous local session behavior, retention, and
  how to clear the conversation.
- Production readiness requires a versioned privacy notice approved by the
  product/legal owner. Implementation can ship a clearly labeled draft notice
  locally, but no campus deployment may claim ready until the approval flag and
  notice version are configured.
- `DELETE /api/v1/session` atomically revokes all upload/generation leases,
  records every owned asset and in-flight attempt key in the durable deletion
  outbox with a safe late-write `not_before`, removes the session/conversation rows, and
  clears the cookie. `deleted: true` means access is revoked and physical deletion
  is reliably queued; it never falsely claims a cross-database/Blob transaction.
- Default retention is 30 days for anonymous text/events and 7 days for voice
  media unless a deployment selects a stricter policy. A real scheduled cleanup
  worker first revokes access and enqueues keys transactionally, then performs
  physical deletion. It must use the same lifecycle core as explicit deletion,
  record its last successful run, retry failed object deletion, and make
  readiness fail when the worker is stopped or stale. It never deletes Blob
  first while leaving readable metadata, or drops metadata without a durable
  outbox key.

## Failure Experience

- Provider timeout: keep the student message, show a retryable assistant state,
  and never create a duplicate retry.
- Weak or expired evidence: state that the fact could not be confirmed and show
  the official page/contact.
- Recording normalization or ASR failure: never upload a raw fallback container
  or invent a transcript; offer retry and `Type instead`, and clean private
  temporary objects through the durable deletion path.
- TTS failure: retain the text answer and show `Voice unavailable — retry`.
- SSE disconnect: reconnect with the persisted cursor, replay missed events,
  fetch canonical messages after the last sequence, and continue without loss.
- Database/media not writable: readiness fails; message sends return a safe
  unavailable response rather than pretending to accept data.
- JavaScript or unsupported browser recording: core text chat remains usable.

## Operational Targets

- Text send accepted and persisted: P95 <= 300 ms
- Accepted text to visible processing state: P95 <= 500 ms
- Grounded response delivered: P95 <= 8 s
- Voice upload completion to transcript, <= 60 s audio: P95 <= 6 s
- Optional TTS ready after request: P95 <= 5 s
- Duplicate assistant replies for the same client message ID: 0
- Campus factual claims labeled verified without a valid displayed source: 0
- Text availability when TTS fails: 100%
- Message loss after an acknowledged send: 0 in local-adapter restart tests and
  the production PostgreSQL acceptance suite

Local implementation records representative timings but does not satisfy a
production SLO. A production candidate passes only after a separate target runs:

- 200 text turns across 20 new sessions at concurrency 5, using a fixed mix of
  grounded, abstention, and short casual prompts;
- 30 prerecorded ASR samples covering Cantonese and English, split evenly among
  approximately 10-, 30-, and 55-second durations;
- 30 opt-in TTS requests after text delivery;
- nearest-rank P95 calculation for each latency target, with zero acknowledged
  message loss, duplicate reply, or unsupported verified claim.

Provider/server timings are reported separately. Failure of any target blocks
campus promotion but does not invalidate local feature verification.

## Testing Strategy

Tests use Node's built-in test runner. The defined Playwright browser matrix is
required for Task 6; real-device iOS acceptance remains a separate release gate.

- Unit: config readiness, tokenizer/retriever, source expiry, provider parsing,
  citation/action validation, cookie/token helpers, MIME/path validation.
- Store: schema migration, transactionality, sequencing, idempotency, ownership,
  deletion, local-adapter restart durability, pending-turn recovery, and
  PostgreSQL transaction/query contracts.
- API: session, accepted send, backfill, SSE replay, duplicate retry, invalid
  input, rate limit, provider failure, ASR/TTS independence, media ownership,
  and health contracts.
- UI contracts: one-screen shell, no legacy modes/scenarios, composer order,
  truthful states, citations, voice draft edit, no autoplay, accessibility, and
  parent-brand attribution.
- Browser: 390x844 mobile, desktop, keyboard flow, reload/reconnect, voice
  unsupported fallback, information sheet, clear conversation, and no horizontal
  overflow. The real-container matrix requires WebM/Opus in bundled Chromium,
  Ogg/Opus in Playwright Firefox, MP4/AAC in installed branded Chrome, and WAV
  in all; WebKit exercises WAV plus explicit unsupported fallback, while real
  iOS Safari separately gates MP4/AAC capture. Success checks canonical WAV
  structure and fixture-specific duration/RMS/frequency or PCM fingerprint;
  unsupported decode must make no upload.
- Security: secret scan, CSP/header contract, traversal attempts, unauthorized
  media, Origin/CSRF, durable quotas, oversized or over-duration input, privacy
  notice gates, retention cleanup, and production config fail-closed checks.
- Real dependency acceptance: the atomic and PostgreSQL stores run the same
  displaced-key reclaim, claim/delete ordering, stale-write rearm, zero-orphan,
  and maximum-window quota contract. Apply the migration to a fresh schema in
  the intended isolated V1 PostgreSQL resource and run that exact matrix across
  two store instances while exercising a unique prefix in the intended private
  V1 Blob container for write/read/delete. These are required for a green
  production readiness report and may be skipped only with the result labeled
  local-preview-only.
- Legacy regression: the original V2 suite and frontend sync check remain green
  because legacy code is untouched.

## Release and Deployment Boundary

The V1 code can be completed and locally verified now. Deploying it requires a
new Azure/Vercel/service target or an explicitly approved new deployment slot.
It must never overwrite `hkbuddy-pilot-0630` or reuse its old workflow by
accident.

Release evidence must bind:

- feature-branch commit SHA;
- Node/runtime version;
- separate app/resource identity and hostname;
- production settings present without values;
- readiness response;
- mobile browser screenshots;
- provider smoke results;
- PostgreSQL migration/concurrency and Blob lifecycle acceptance results;
- real production-candidate latency workload results;
- privacy notice approval/version and retention-worker freshness;
- exact one-replica deployment configuration.

Real dependency evidence is executed against the intended new V1 production
PostgreSQL database and Blob container while isolating every mutation inside a
fresh guarded schema/blob prefix. The new V1 resources must have independent
resource IDs and canonical identity hashes from every legacy resource; sharing
either physical resource with the legacy app is a production blocker. The
authoritative legacy inventory is never inferred from whichever environment
variables happen to be present. It is an owner-reviewed, frozen-commit-bound,
artifact-hashed record listing every legacy PostgreSQL/Blob resource ID and
canonical identity digest, or an explicit reviewed `none` declaration for each
resource class. Missing, malformed, unapproved, stale, incomplete, or
digest/commit-mismatched inventory blocks startup before any V1 production
storage connection. The
record binds the exact current `V1_POSTGRES_RESOURCE_ID` and
`V1_BLOB_RESOURCE_ID`, SHA-256 hashes of those V1 canonical actual identities,
the validated legacy-inventory digest, the validated unique schema/blob prefix,
named checks, cleanup success, result, time, frozen commit, and artifact hash.
Production loads it only from
`V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_FILE` with the matching
`V1_DEPENDENCY_ACCEPTANCE_EVIDENCE_VERSION`; every readiness evaluation rejects
a digest/commit/current-V1-resource mismatch, any legacy-resource equality,
failed cleanup, records older than seven days, or timestamps more than five
minutes in the future. Evidence from a separate acceptance-only database or
container may validate an adapter but cannot make V1 production readiness
green. It cannot be synthesized by unit/fake-pool tests.

No merge, push, live deployment, DNS change, or old-app configuration change is
part of the automatic local execution.

## Explicitly Deferred

- HKBU student-email login, account linking, and cross-device history
- multiple human/AI tutors or persona marketplace
- live audio calls, WebRTC, barge-in, live waveform streaming, 3D/animated avatar
- uncontrolled web search or crawler answers
- embeddings/vector database before the bounded lexical corpus needs it
- multi-instance capacity policy and rollout after single-replica V1 evidence
- silent long-term personalization or storage of inferred sensitive attributes
- maps API, indoor navigation, payments, staff case-management, or automatic
  official-system actions

## Acceptance Criteria

- Opening V1 shows only the AI senior conversation and composer; no mode or
  scenario UI from the old product exists.
- Text send, reload/backfill, idempotent retry, ordered sequential replies, and
  session deletion pass automated tests.
- Relevant campus answers display supporting official source titles, freshness,
  and links; unknown/expired evidence produces an honest limitation.
- Voice input keeps the raw browser container on-device, uploads only normalized
  canonical WAV, produces an editable transcript, and degrades cleanly to text.
- Voice output is opt-in, never autoplays, and cannot block text delivery.
- Mobile 390x844 keeps the header, timeline, truthful state, and composer usable
  above the keyboard with no horizontal overflow.
- The Simplify attribution uses the supplied wordmark quietly and accessibly.
- Production readiness fails without PostgreSQL, object storage, session secret,
  public origin, a real LLM provider, an approved privacy notice, a healthy
  retention worker, and a single-replica deployment policy.
- The legacy frontend/public/backend trees remain byte-identical to their
  pre-V1 branch state, and the legacy regression suite stays green.
- The new branch has focused tests, a clean diff, and a documented local run
  command. Live deployment remains blocked until a separate target is selected.
