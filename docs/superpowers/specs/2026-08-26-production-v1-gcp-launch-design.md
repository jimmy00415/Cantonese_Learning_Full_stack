# Hong Kong Buddy Production V1 GCP Launch Design

## Status and authority

- Date: 2026-08-26
- Product owner instruction: choose the product, engineering, and Google Cloud
  design autonomously and deliver the final Production V1 without changing the
  legacy application.
- Implementation boundary: the existing linked worktree on
  `feat/production-v1-ai-senior`; `frontend/`, `backend/`, `backend/public/`, and
  `hkbuddy-pilot-0630` remain unchanged.
- Cloud boundary: the existing billed shared host project
  `motion-expert-hk-ltd-webpage` (`582852715831`), under organization
  `797368190621` and billing account `01F9FD-24EA9B-A9232C`, contains one exact
  `hkbuddy-v1-*` resource island. The earlier dedicated target
  `hkbuddy-prod-v1-20260826` and its project-creation/billing-link procedure are
  explicitly superseded and must not be used by an operator command.
- Visual reference: Intercom-inspired conversational clarity on the existing
  warm cream/white Hong Kong Buddy system. No Intercom, Meta, or WhatsApp brand
  asset or product chrome is copied.

This document is a launch addendum to
`docs/superpowers/specs/2026-08-25-production-v1-ai-senior-design.md`. The
existing durability, privacy, evidence, retention, and fail-closed contracts
remain authoritative unless this addendum explicitly replaces a cloud-provider
or interaction decision.

The approved shared-host identity and non-adoption amendment is
`docs/superpowers/specs/2026-08-26-production-v1-shared-project-isolation-design.md`.
It replaces the original project/resource identity decision in this addendum;
all product, provider, privacy, evidence, SLO, promotion, and rollback
requirements below remain binding.

## Outcome

Production V1 is one mobile-first conversation with an openly identified AI
campus senior. A student types or records a message, receives a short grounded
answer, can see the official HKBU evidence, and can choose English, written
Cantonese, or Mandarin replies. Voice is a message, not a live call: the student
records, reviews the transcript, and sends; the assistant can prepare a voice
bubble but never autoplays it.

The release is accepted only when the deployed candidate proves all of these:

- campus facts are cited from fresh, allowlisted evidence or labeled
  unverified;
- the production LLM, ASR, and TTS calls work with a dedicated runtime service
  account and no provider API key;
- the 390x844 mobile flow keeps the timeline and composer usable;
- the text answer survives every voice failure;
- measured production latency satisfies the release SLOs in this document;
- the legacy product and its cloud resources are untouched.

For this release only, the product owner may defer the physical iPhone/Safari
test through the exact, final-release-SHA-bound seven-day waiver owned by
`admin@motionexp.com`. That waiver is an alternative only to schema-v4 real
iPhone evidence in the current `iosVoiceAcceptance` publication slot; it does
not certify real iPhone behavior. The public runtime must report
`iosVoiceCertified=false` and `iosVoiceAcceptanceVersion=null`. Controlled
Playwright `390x844` mobile, real Google LLM/ASR/TTS smoke, privacy, readiness,
latency/workload, trace, candidate, and promotion gates remain mandatory.

## Evidence from the current product

Fresh baseline verification on 2026-08-26 established:

- `npm test`: 937 tests, 936 passed, 0 failed, 1 explicit real-PostgreSQL skip;
- `npm run check`: passed;
- current corpus: 19 official HKBU sources and 40 governed claims;
- current local mobile flow: healthy text chat, source cards, honest abstention,
  and a fixed composer;
- current gaps: no release voice capability, no explicit reply-language or
  reply-form preference, no GCP providers/storage/deployment, and an irrelevant
  Academic Registry link can appear for an unrelated unknown question.

The current shell is retained rather than replaced. Its message durability,
idempotency, SSE replay, safe voice-draft lifecycle, strict answer parser,
evidence freshness, and retention gates are valuable production foundations.

## Considered approaches

### Selected: preserve the modular monolith and replace cloud adapters

Run the existing Node/Express application on Cloud Run, retain PostgreSQL via
Cloud SQL, replace Azure Blob with private Cloud Storage, and add Google-native
LLM/ASR/TTS adapters.

Benefits:

- smallest change to the 937-test safety surface;
- PostgreSQL transaction, lease, outbox, quota, and retention semantics remain
  intact;
- Cloud Run and Cloud SQL can live in Hong Kong;
- GCP service-account credentials remove provider API keys;
- one deployment and one same-origin client preserve the simple user model.

Trade-off: Cloud SQL has a fixed monthly cost and the first V1 release remains a
single application replica until its event fan-out contract is redesigned.

### Rejected for V1: Firestore-native rewrite

Firestore in `asia-east2` and its vector search are attractive for a future
serverless architecture, but replacing the current transactions, fenced leases,
outbox, event replay, quotas, and retention state would invalidate the strongest
tested parts of V1. It is not justified to improve this release.

### Rejected for V1: cross-cloud speech plus GCP hosting

Keeping Azure or MiniMax speech would reduce adapter work but preserves API-key
rotation, cross-cloud operational failure, and less predictable routing. Those
providers remain code-compatible but cannot satisfy the GCP Production V1
release evidence.

## Student interaction design

### Header

The compact header shows:

- the existing illustrated avatar;
- `Hong Kong Buddy`;
- `Your HKBU AI senior` as the transparent identity/status line;
- a language chip showing `EN`, `廣`, or `普`;
- a quiet `Info` button containing AI, source, retention, voice, and Simplify
  disclosure.

There is no fake online dot, read receipt, last-active state, or implication
that the avatar is a real student. The relationship is created by continuity,
fast useful replies, stable tone, and remembered session preferences.

### First visit

The opening assistant message is one concise bubble:

> Hi — I’m Hong Kong Buddy, your HKBU AI senior. Ask me about registration,
> halls, food, campus services, transport, or settling into Hong Kong.

The disclosure becomes `Campus facts include official sources.` Four starter
prompts remain, localized to the selected reply language. Starter prompts stop
occupying the timeline after the first message.

### Language and reply form

The language chip opens a compact sheet with two independent settings:

- Reply language: `English`, `廣東話`, `普通話`.
- Reply as: `Text`, `Voice message`.

Wire values are fixed and validated:

- `en` means concise international English;
- `yue-Hant-HK` means natural written Cantonese in Traditional Chinese;
- `cmn-Hans-CN` means natural Mandarin in Simplified Chinese;
- `text` means no automatic TTS generation;
- `voice` means the text answer remains visible and the server prepares one
  non-autoplaying assistant voice attachment after delivery.

The browser stores the preference for the anonymous local session and attaches
it to every idempotent send. The server includes it in the request hash, passes
it as a trusted provider instruction, and rejects unknown values. A language
change affects the next answer, not already delivered messages.

### Composer and voice messages

The composer remains attached to the bottom safe area. In the ordinary state it
contains one expanding text field, `Hold to talk`, and `Send`. When text is
present, the voice button remains available only after the draft is cleared;
the UI explains this without disabling the whole composer.

Voice flow:

1. The first voice action shows the existing privacy/processing consent.
2. Hold records; release stops; 55 seconds auto-stops.
3. Only canonical 16 kHz mono PCM16 WAV leaves the browser.
4. The transcript returns into the ordinary editable composer.
5. Send creates the normal student bubble with a small `Voice` origin label.
6. In voice-reply mode the assistant answer appears as text immediately and its
   voice bubble changes from `Preparing voice…` to a tappable duration control.
7. Audio never autoplays; pause, replay, and visible transcript always exist.

### Answer and source presentation

The first bubble answers directly. A second short paragraph gives the next
action only when useful. Official evidence is collapsed into a `Sources` row
unless there is exactly one actionable source, in which case the current compact
source card remains visible.

Grounding labels are exact:

- `Verified` means every campus fact is supported by current selected claims;
- `Partly verified` means the supported and unsupported clauses are separated;
- `Not confirmed` means the answer contains no unsupported operational claim.

Unknown answers must not display an unrelated generic contact. The retriever
returns either a category-relevant official directory or no source. The reply
states the missing scope and asks one useful clarification. Living-supplies,
immigration, health, and live-transport questions never borrow evidence from an
unrelated campus category.

## Knowledge design

The bundled reviewed corpus remains the runtime authority because it is faster
and more auditable than adding a remote vector database to a small V1 corpus.
Generation never performs uncontrolled web search.

V1 expands the source registry and acceptance set for these categories:

- halls and colleges: eligibility, facilities, services, check-in, and official
  accommodation contacts;
- international-student support and orientation;
- dining outlet inventory and special-hours boundary;
- campus locations and official transport directions;
- language-learning routes and current course-window limitations;
- living supplies as an explicitly non-HKBU trust tier, kept unverified until
  an approved primary source exists.

Every source record identifies its owner office, canonical allowlisted URL,
category, risk, languages, volatility, review cadence, evidence window, and
review attestation. Every claim is atomic and binds a source locator and
effective window.

A scheduled knowledge monitor may fetch allowlisted pages and report content
hash/diff candidates, but it cannot promote a candidate into the answerable
corpus. Promotion requires a reviewed corpus commit and the complete
knowledge/answer test set. Fetch failure, conflict, or review expiry makes the
claim stale or unverified rather than silently retaining confidence.

## Google provider contracts

### Vertex AI LLM

- Provider selector: `V1_LLM_PROVIDER=vertex-ai`.
- Model: `gemini-2.5-flash` through Vertex AI at location `global`.
- Identity: Application Default Credentials from the Cloud Run runtime service
  account; no JSON key and no API key.
- Request: the existing bounded conversation plus selected evidence and exact
  structured-output contract.
- Response: normalized into the existing `rawText`, provider, latency, usage,
  finish reason, and request ID shape before the strict answer parser runs.
- Deadline: 12 seconds total; at most one bounded retry for transport, 408, 429,
  or 5xx; never retry authentication, safety refusal, truncation, or invalid
  successful output.

### Speech-to-Text

- Provider selector: `V1_ASR_PROVIDER=google`.
- API: Speech-to-Text V2 `chirp_2` in `asia-southeast1`.
- Recognition languages: selected reply language first, then the remaining
  values among `yue-Hant-HK`, `en-US`, and `cmn-Hans-CN` where the API contract
  permits alternatives.
- Input: the existing validated canonical WAV only.
- Output: non-empty transcript plus confidence only when supplied.
- Deadline: 15 seconds with no automatic provider retry; the owned idempotent
  upload is the retry boundary.

The current Google support matrix lists Cantonese, English, and Mandarin Chirp
2 in Singapore, avoiding the previously assumed US-only path:
https://docs.cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages

### Text-to-Speech

- Provider selector: `V1_TTS_PROVIDER=google`.
- Languages: `yue-HK`, `en-US`, and `cmn-CN`.
- Candidate quality tier: one release-selected Chirp 3 HD voice per language.
- Cantonese stable fallback candidate: `yue-HK-Standard-B`.
- Output: mono MP3 with a bounded four-MiB response and validated content type
  plus MP3 signature.
- Deadline: 15 seconds with no hidden retry.

Chirp 3 HD Cantonese is currently Preview. The release does not silently fall
back at runtime. The voice smoke and latency/quality acceptance select either
the evidenced Chirp 3 candidate or the stable Cantonese voice before deployment.
Google's live voice list is the authority:
https://docs.cloud.google.com/text-to-speech/docs/list-voices-and-types

### Provider evidence

The existing immutable LLM, ASR, and TTS evidence schemas gain Google provider
allowlists and Google non-secret config digests. Digests include project,
location, model/recognizer/voice, encoding, language mapping, and credential
rotation identifier, but never a token, transcript, prompt, audio, or provider
body. Production readiness remains false until the frozen commit and all active
provider digests match passing evidence.

## GCP topology

```text
student browser
  -> Cloud Run https://<service>-<hash>.asia-east2.run.app
       -> Cloud SQL for PostgreSQL 16 in asia-east2
       -> private Cloud Storage media bucket in asia-east2
       -> Vertex AI gemini-2.5-flash (global endpoint)
       -> Speech-to-Text V2 chirp_2 (asia-southeast1)
       -> Text-to-Speech (Google endpoint)
       -> Secret Manager
  -> Cloud Logging / Monitoring / budget notifications
```

Binding resource identities:

- project: `motion-expert-hk-ltd-webpage` (`582852715831`);
- runtime/build/migration/deployment/acceptance service accounts:
  `hkbuddy-v1-runtime`, `hkbuddy-v1-build`, `hkbuddy-v1-migrator`,
  `hkbuddy-v1-deployer`, and `hkbuddy-v1-acceptance` in the selected project;
- Artifact Registry repository: `hkbuddy-v1` in `asia-east2`;
- Cloud Run services: public stable `hkbuddy-v1-api` and private acceptance
  scratch service `hkbuddy-v1-api-candidate`, both in `asia-east2`;
- Cloud SQL instance: `hkbuddy-v1-pg` in `asia-east2`;
- database/user: `hkbuddy_v1` / `hkbuddy_app`;
- media bucket: `hkbuddy-v1-582852715831-media`;
- VPC/subnet/private-services range: `hkbuddy-v1-vpc`,
  `hkbuddy-v1-ae2-run`, and `hkbuddy-v1-google-services`;
- budget display name: `Hong Kong Buddy Production V1 monthly guard`.

This is logical isolation inside a shared project. API enablement, quota,
billing, audit logs, and project IAM remain shared. The default VPC and its
subnets, baseline IAM, existing data, and unrelated services are protected
read-only state. Provisioning is create-or-exact-readback for the resource
island only: it never creates or relinks the project, attaches to or modifies
the default network, broadens unrelated IAM, or adopts, repairs, renames, peers,
or deletes an existing resource. Any managed-name collision, partial ownership,
or protected-state drift fails before mutation.

Cloud Run uses one minimum and one maximum instance for the first release, two
vCPU, one GiB memory, concurrency 40, startup CPU boost, and a bounded request
timeout. This removes cold starts and preserves the current in-process SSE
acceleration contract. A later multi-instance release must replace in-process
event hints with a shared fan-out design and pass a new load gate.

Direct VPC may create a Google-managed regional INTERNAL IPv4 Address with
`purpose=SERVERLESS` inside the selected subnet. The project-wide audit accepts
that reservation only with an exact host-project Address self link, one
canonical same-region enumerated subnetwork selector on a known network, no
network selector, and a canonical `/8` through `/30` range fully contained by
the subnet's primary CIDR. The nested range is not a collision with its exact
owning V1 subnet, but remains part of every other overlap calculation. It is
operator-immutable while owned by Cloud Run and is never a repair or deletion
target.

Cloud SQL uses encrypted PostgreSQL 16, automatic backups, point-in-time
recovery, deletion protection, and the Cloud SQL connector. The application
uses a bounded pool and Unix-socket connection; the database password and
session secret live only in Secret Manager. The initial tier is chosen during
provisioning from current available `asia-east2` tiers and must provide at least
one vCPU and 3.75 GiB memory. High availability is enabled for the campus
release; a cheaper zonal database may be used only for a clearly labeled staging
candidate.

The media bucket has uniform bucket-level access, public-access prevention,
seven-day lifecycle deletion, and no public URL. Its bucket policy grants the
reviewed object roles only to the runtime and acceptance service accounts. The
human release operator's distinct project binding permits listing only this
bucket and get/delete only below `release-evidence/`; it grants no runtime media
content access. The GCS adapter preserves the existing opaque object key,
bounded range read, write, delete, orphan cleanup, and durable outbox contracts.

Cloud Run and Firestore both support Hong Kong `asia-east2`; this design uses
Cloud SQL to preserve tested semantics. Cloud Run region authority:
https://docs.cloud.google.com/run/docs/locations

## IAM, secrets, and cost guard

The runtime service account receives only:

- Cloud SQL Client;
- bucket-scoped object read/write/delete;
- Vertex AI User;
- Speech-to-Text client;
- Text-to-Speech user;
- accessor on the exact V1 secrets.

It is not Project Owner and has no service-account key. The deployer can build
and update only the V1 runtime and can act as the runtime service account; it is
not used by the application.

The binding project budget is HKD 2300 per month in the billing account's native
currency, with actual alerts at 50%, 80%, and 100% plus a 100% forecast
threshold. The earlier USD 300 draft is superseded and must not be used for
provisioning or acceptance. Budget alerts do not stop usage, so product limits also cap
message count, audio duration/bytes, TTS generations, context bytes, output
tokens, Cloud Run instances, and database connections. Logs exclude message
text, transcripts, audio, credentials, signed URLs, and raw provider bodies.

## Release SLOs

Measured from Hong Kong against the final HTTPS origin:

- text send accepted and persisted: P95 <= 300 ms;
- accepted text to visible processing state: P95 <= 500 ms;
- grounded answer visible: P50 <= 2.5 s and P95 <= 6 s;
- 10-second voice upload completion to editable transcript: P50 <= 2.5 s and
  P95 <= 4 s;
- 30/55-second voice transcription: P95 <= 6 s;
- selected TTS attachment ready: P50 <= 2.5 s and P95 <= 5 s;
- duplicate assistant replies: 0;
- acknowledged message loss: 0;
- unsupported campus facts labeled Verified: 0;
- text retained when TTS fails: 100%.

The release workload remains 200 text turns across 20 sessions at concurrency
five, 30 governed ASR samples across languages/durations, and 30 TTS requests.
Provider and application timings are reported separately. Cross-region Vertex,
Singapore STT, and TTS latency are measured rather than assumed.

## Deployment, promotion, and rollback

1. Commit the GCP adapter, deployment, language, knowledge, and test changes.
2. Freeze a clean commit SHA.
3. Verify the selected existing shared project and configure only the exact
   `hkbuddy-v1-*` resource island. Project creation, billing-link changes,
   default-VPC changes, unrelated IAM changes, and resource adoption are
   forbidden.
   The dependency-acceptance identity receives object access plus one fixed GA
   custom role containing only `storage.buckets.get`, bound only on the media
   bucket, so it can attest the exact bucket project without gaining bucket
   listing or administration.
   The fixed human operator uses a separate GA custom role containing only
   `storage.objects.get`, `storage.objects.list`, and `storage.objects.delete`.
   Its version-3 project condition permits bucket-scoped listing only on the
   fixed media bucket and object get/delete only below the slash-terminated
   `release-evidence/` prefix. It is independent of both the two-bucket
   bucket-policy operator and the build-source creator-only grant. Provisioning
   reconciles both known operator conditions through one exact allowlist with
   authoritative ETag/readback, then proves list propagation before the full
   audit; preflight reports exact known absence without mutation and rejects
   every widened or unknown condition.
4. Archive exactly that clean commit. In Cloud Build, install production
   dependencies without lifecycle scripts, run the time-boxed fail-closed
   dependency security gate, and require its exact reviewed PASS receipt before
   the image step. Then build into Artifact Registry and capture the build ID,
   source-archive SHA-256, verified provenance, OCI revision/source labels, and
   immutable image digest; the final build receipt must include the successful
   gate step.
5. Apply and verify the database migration through the digest-pinned one-shot
   migration job.
6. Publish and read back the reviewed legacy inventory first. Run the
   digest-pinned dependency Job as the dedicated DB/GCS-only acceptance
   identity and the LLM/ASR/TTS Jobs as the exact runtime identity. Each Job
   writes one create-only private GCS object under the frozen release/run
   prefix. Describe and download one exact numeric generation, independently
   verify the semantic artifact SHA-256 and exact object-byte SHA-256, then
   publish and read back the accepted numeric Secret Manager versions. Delete
   only those verified generations and prove zero release-output residue. The
   release plan validates the complete storage-operation set before command
   execution: every target must remain under the exact media-bucket
   `release-evidence/<release-sha>/` boundary, collect/delete stay generation-
   bound, and the final list cannot widen beyond that release SHA.
   Artifact SHA-256 values remain separate from Secret version numbers.
7. Only after those evidence versions exist, boot digest-pinned revision
   `hkbuddy-v1-api-candidate-<12 lowercase hex>` on the separate
   `hkbuddy-v1-api-candidate` service at private 100% traffic behind its
   SHA-bound `candidate-<12 lowercase hex>` tag, with the evidence mounted as
   read-only files. The tag exists only on that private service. Authentication
   mints an in-memory ID token for the untagged candidate-service root while the
   request targets the tagged URL. Exact candidate IAM contains only the
   reviewed private invoker and no public principal. Controlled candidate and
   stable Service specs pin `run.googleapis.com/invoker-iam-disabled` to exact
   lowercase string `false`. Raw Cloud Run v1 live readbacks accept only
   annotation absence (IAM check enabled by default) or a no-whitespace string
   case-folding exactly to `false`; malformed/boolean/true values, wrong
   apiVersion/kind, spec-only traffic, or drift fail before dependent mutation.
   The normalized false invariant is part of the hashed candidate contract and
   applies to deploy/readback, promotion, cleanup, rollback, response-loss, and
   compensation; private IAM alone is insufficient. The receipt records
   `trafficState=candidate-service-private-100`, both service identities, and
   stable absent or genuine-prior-stable-at-100 state. The public stable service
   is unchanged during acceptance.
8. Run candidate-specific mobile, retention, readiness, and latency acceptance
   against the same resource identities, image digest, and frozen commit.
9. Promote only after fresh candidate service/revision/IAM/image/config and
   immutable readiness/workload/mobile/trace validation. On a later release,
   keep the genuine prior stable revision at 100%, stage the accepted stable
   revision untagged at 0%, verify exact image/config and a tag-free stable
   service, then atomically switch the accepted stable revision to 100%; stable
   public IAM is read-only. Every stable readback revalidates the same Invoker
   IAM enabled truth. On the first release, create stable privately at
   100%, verify its service/revision/image/config and private IAM, then add
   `allUsers:roles/run.invoker` as the final mutation, followed only by IAM
   readback. Response-loss compensation restores the exact prior stable state
   on a later release or the accepted private stable state and private IAM on a
   first release. It never makes an unaccepted candidate public.
10. Return the exact stable origin
    `https://hkbuddy-v1-api-582852715831.asia-east2.run.app` and generate a
    decode-verified QR code from that URL outside tracked source.

Rollback is separately confirmed and moves only `hkbuddy-v1-api` traffic to the
exact previous evidenced V1 revision at 100%, then verifies stable readback and
unchanged public IAM. It neither depends on nor mutates the private candidate
service. Receipt-bound candidate cleanup is a separate operation: it validates
the exact candidate service/revision/tag/image/private IAM, deletes only
`hkbuddy-v1-api-candidate`, and verifies candidate-specific canonical absence.
An exact already-absent initial precheck skips revision, artifact, IAM, and
delete operations but repeats canonical absence readback before reporting no
mutation. Raw null output, generic 404, wrong identity, and ambiguous errors are
not absence witnesses.
Neither operation deletes production data, the resource island, protected
shared-project state, or unrelated services, and neither mutates the legacy
Azure app, database, Blob container, workflow, hostname, or settings. Database
migration 1 is additive; rollback never drops production data.

## Explicitly deferred

- HKBU student-email SSO and cross-device account history;
- a live call, WebRTC, barge-in, animated avatar, or fake human presence;
- automatic promotion of web-crawled content;
- maps, indoor navigation, payments, or actions in official HKBU systems;
- multiple Cloud Run replicas before a shared event fan-out contract exists;
- changing or decommissioning the legacy product.

## Stage D local acceptance closure (2026-08-28)

The executable local contract adds the missing final barriers without changing
the live authorization boundary. Candidate privacy publication is the final
candidate operation. The candidate receipt hashes all seven reference fields;
an independent authority anchor reconstructed from the publication journal and
terminal candidate-receipt digest must match before dependent phases. Candidate privacy, readiness, the
privacy-start/privacy-end/workload three-file bundle, and the seven-file mobile
bundle are journaled byte-for-byte before create-only publication; deterministic
restart adopts only exact prior bytes and continues the missing suffix.
Historical privacy validity is evaluated at each recorded gate clock, including
the independent start/end clocks for a workload longer than five minutes.
Freshness is separate, and every live wrapper rejects the exact expiry boundary.

Adoption reads require the exact intended length before allocation, bound all
reads, and compare descriptor/path/parent identity before and after. Publication
does the same around the durable temp file and create-only hard link. Links,
junctions, replacement, oversize, mixed bundles, and receipt drift fail closed.
This is a portable defense for a trusted operator-owned local evidence
directory, not a native no-TOCTOU guarantee against an actively malicious
same-user process; Node on Windows exposes no handle-relative `openat` API.

Promotion uses append-only attempt-bound proof checkpoints. After stable staging
it produces a fresh privacy proof, validates it using the current post-proof
clock, and rereads every evidence/receipt predecessor and authoritative
candidate/stable service, revision, image/config, traffic, IAM, and authority
source. A canonical digest of that full promotion barrier is stored in the final
intent. Expired pre-intent proof checkpoints are preserved and followed by a new
proof; an expired unperformed final intent requires exact before-state, an abort,
and a new proof/intent. Mixed or ambiguous state blocks. No cloud mutation may
follow the terminal promotion mutation.

The controlled browser evidence contract is Playwright `1.62.1`, Chromium
revision `1234` / browser `151.0.7922.34`, isolated `390x844` DPR-1 mobile web,
four fully opaque PNG screenshots with encoded and decoded-pixel uniqueness, and
fixed one-second PCM16LE 16 kHz mono WAV SHA-256
`ef989be190f7e9cef40b80516209d972eb08910263ddee3a44f52fdf84e534a7`.
The positive local harness starts the real Product V1 application and observes
its native exact EventSource and product voice/message/media APIs from Node.
Each run derives a private cryptographically watermarked WAV challenge, verifies
the real Chromium command line, captures the actual upload, and accepts only a
challenge-correlated signal. Explicit playback is observed outside the page
main world through isolated CDP plus native media/Media/WebAudio signals; there
is no page-visible instrumentation token. The harness also binds transcript,
draft, message and media IDs, unsupported handoff, retry/reload, every-page
download attempts, and UI state. Manual text-answer TTS is durable only after
opt-in: recovery resumes an existing retryable generation but does not enqueue
untouched text answers. It does not claim real-iOS Safari. All live GCP, provider,
real-iOS, promotion, public-IAM, runtime-health, URL, and QR gates remain
unexecuted.

## Real-iPhone waiver amendment (2026-09-03)

The product owner has explicitly authorized public launch without physical
iPhone/Safari certification for this release. The release controller may accept
either unchanged schema-v4 real-iPhone evidence or the exact schema-v1
`real-iphone-safari` waiver described above. The waiver must be generated
locally after the final commit is known, be canonical and self-hash-valid, bind
that exact lowercase 40-hex commit, identify `admin@motionexp.com`, carry only
the `not-real-ios-tested` limitation, and expire exactly seven days after its
canonical approval instant. It is never valid in the runtime certification
validator. Expiry, future skew beyond five minutes, interval drift, wrong
owner/SHA/scope/reason/result/limitations, extra keys, or digest tampering block
the release before Secret Manager access. No other launch gate is waived.
