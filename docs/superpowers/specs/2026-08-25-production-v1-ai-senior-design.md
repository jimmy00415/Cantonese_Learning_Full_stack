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

- Holding the microphone starts a short recording; release stops it and starts
  transcription. Pointer cancellation and a visible cancel action discard it.
- A recording timer and `Release to transcribe` state replace the normal
  composer while recording.
- The resulting transcript is editable before send. Sending it creates a normal
  student message marked as voice-originated and keeps the original audio for
  playback where configured.
- Microphone denial or unsupported recording never blocks text input.
- Assistant voice never autoplays. A `Play voice` control generates or reuses a
  voice-message attachment after the text answer exists.
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
- `V1_STORE_DRIVER=postgres` and `DATABASE_URL`
- `V1_MEDIA_DRIVER=azure-blob` with its container configuration
- at least one real LLM provider
- `V1_INSTANCE_POLICY=single`
- explicit `V1_TRUST_PROXY_HOPS`
- `V1_PRIVACY_NOTICE_VERSION` plus `V1_PRIVACY_NOTICE_APPROVED=true`
- `V1_RETENTION_WORKER_ENABLED=true`

Development may use a generated local secret, atomic file/local media paths, and
a deterministic provider fallback, but health reports `productionReady: false`
in any of those states.

## Data Model

### `sessions`

- `id`
- `token_hash` (unique; raw token only exists in the HttpOnly cookie)
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
- `relative_path`
- `mime_type`
- `byte_length`
- `duration_ms` (nullable)
- `sha256`
- `status`: `draft | attached | failed`
- `created_at`

Media IDs are opaque and access is limited to the current session.

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
    knowledge snapshot date.
- `GET /api/v1/messages?after=<sequence>`
  - Returns ordered canonical messages and active turn state.
- `GET /api/v1/events?afterCursor=<cursor>`
  - `afterCursor` and numeric `Last-Event-ID` mean the same exclusive event
    cursor; when both exist they must match or the request fails.
  - Establishes a buffered live subscription, captures the durable high-water
    cursor, drains every persisted event `(afterCursor, highWater]` in ascending
    bounded pages, then flushes buffered events above the high-water cursor in
    order and switches to live delivery. Every event uses its cursor as SSE
    `id`; duplicate cursors are ignored. Buffer overflow closes with a safe
    `resync_required` event so the client reconnects from its last delivered
    cursor. No backlog page is silently skipped.
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

- `POST /api/v1/voice/transcriptions`
  - Accepts a raw allowlisted audio body from a supported browser recording.
  - Streams no more than 8 MiB into a private temporary object, validates MIME
    plus detected file signature, and uses a server-side media parser to reject
    unknown or greater-than-60-second duration. Client duration is advisory only.
  - Stores an owned draft, calls the configured ASR provider, and returns an
    editable transcript plus draft metadata.
  - Validation or ASR failure deletes the temporary object; no failed transcript
    or orphaned upload is retained.
- `POST /api/v1/messages/:messageId/audio`
  - Assistant messages only. Reuses existing audio or calls configured TTS,
    stores the result, associates it with the message, and returns the media URL.
- `GET /api/v1/media/:mediaId`
  - Streams only media owned by the current session with `nosniff`, private
    caching, range support where practical, and an allowlisted MIME type.

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
   Expired leases are safely reclaimed after restart.
4. Set `retrieving`, select approved knowledge entries, and emit a real state.
5. If the message requests an HKBU fact and evidence is insufficient, deliver a
   transparent unverified response with an official help/directory source; do
   not ask a model to guess.
6. Set `generating`, call the selected real provider with a bounded evidence
   pack and strict JSON response contract.
7. Validate every citation ID and action/card against the retrieved allowlist.
8. If provider output is invalid or the provider fails, deliver a conservative
   deterministic evidence summary where evidence exists. Otherwise deliver the
   honest unverified response.
9. Persist one final assistant message, terminal turn state, and delivery event
   in a single transaction only when the current fencing token still matches,
   then emit the persisted `message.delivered` event. A unique assistant-per-turn
   constraint makes a stale worker unable to duplicate a reply.

Provider retries are limited to one retry for transient failures and use the
same turn. TTS has an independent retry path and never changes turn delivery.

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

Every claim—not merely every page—has its own `sourceId`, `sourceLocator`,
`verifiedAt`, optional `validFrom`/`validUntil`, `reviewAfter`, volatility, and
verification status. A page containing a 2026 schedule and a stale 2025/26 note
therefore cannot accidentally promote both as current.

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
returns a small evidence pack with claim-level source IDs. This is sufficient for
the bounded initial corpus and is easier to audit than premature embeddings.

The model must return:

```json
{
  "replyText": "...",
  "citationIds": ["source-id"],
  "cards": [],
  "suggestedReplies": [],
  "needsClarification": false,
  "groundingStatus": "verified"
}
```

The application, not the model, converts source IDs into URLs/cards. Unknown
source IDs, arbitrary URLs/actions, and `verified` without a valid current source
are rejected.

## Provider Strategy

Production V1 reuses existing working configuration without exposing it:

- LLM: configured HKBU, Azure OpenAI, or MiniMax chat-completion endpoint.
- ASR: Azure Speech REST first where configured; MiniMax may be a configured
  fallback.
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
- ASR selector: `V1_ASR_PROVIDER`, then `ASR_PROVIDER`; Azure requires
  `AZURE_SPEECH_KEY` and region. MiniMax ASR is enabled only by its explicit
  enable flag and endpoint/model settings.
- TTS selector: `V1_TTS_PROVIDER`, then `TTS_PROVIDER`; unsupported or incomplete
  voice configuration disables that capability rather than affecting text.

LLM timeout defaults to 12 seconds with one retry only for timeout, 429, and 5xx.
ASR and TTS default to 15 seconds with no automatic retry inside the request;
the user can retry the same owned draft/message action idempotently.

## Security and Privacy

- Anonymous session cookies are `HttpOnly`, `SameSite=Lax`, path-scoped, signed
  through a stored token hash, and `Secure` in production.
- Session lookup is constant-shape and media/conversation access is always
  ownership-checked.
- JSON body limits, text limits, binary audio limits, MIME allowlists, path
  canonicalization, timeout/abort control, write-request Origin validation, and
  per-session rate limits are
  mandatory.
- Every state-changing request requires an `Origin` exactly matching the
  configured origin; missing or cross-origin writes fail with
  `ORIGIN_NOT_ALLOWED`. Production explicitly configures numeric trusted-proxy
  hops before deriving a bootstrap IP hash.
- Durable default quotas are: 20 session bootstraps per 10 minutes per HMACed
  client-IP key, 30 messages per 5 minutes and 300 per day per session, 10 voice
  uploads per 10 minutes and 60 per day, and 20 TTS generations per day. A 429
  response includes `RATE_LIMITED` and `Retry-After`; deployments may lower but
  not silently remove these limits.
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
- `DELETE /api/v1/session` deletes the session, conversation, messages, turns,
  and owned media, then clears the cookie.
- Default retention is 30 days for anonymous text/events and 7 days for voice
  media unless a deployment selects a stricter policy. A real scheduled cleanup
  worker must use the same ownership-aware deletion contract, record its last
  successful run, retry failed object deletion, and make readiness fail when the
  worker is stopped or stale.

## Failure Experience

- Provider timeout: keep the student message, show a retryable assistant state,
  and never create a duplicate retry.
- Weak or expired evidence: state that the fact could not be confirmed and show
  the official page/contact.
- ASR failure: keep the recording draft only for the current attempt, offer retry
  and `Type instead`, and never invent a transcript.
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

Tests use Node's built-in test runner and browser automation where available.

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
  overflow.
- Security: secret scan, CSP/header contract, traversal attempts, unauthorized
  media, Origin/CSRF, durable quotas, oversized or over-duration input, privacy
  notice gates, retention cleanup, and production config fail-closed checks.
- Real dependency acceptance: apply the migration to an isolated PostgreSQL
  database and exercise lease/fencing/concurrency/cascade behavior; exercise a
  private Blob test container for write/read/delete. These are required for a
  green production readiness report and may be skipped only with the result
  labeled local-preview-only.
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
- Voice input uploads raw audio, produces an editable transcript, and degrades
  cleanly to text.
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
