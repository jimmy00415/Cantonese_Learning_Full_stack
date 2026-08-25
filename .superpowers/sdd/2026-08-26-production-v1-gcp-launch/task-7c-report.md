# Task 7C report — honest multilingual voice and latency acceptance

Date: 2026-08-26
Scope: Task 7C only. No GCP mutation and no Docker, build, release, infrastructure,
or real-dependency acceptance changes were made by Task 7C. The only package
manifest change is the parent-approved, exact runtime dependency
`mpg123-decoder@1.0.3` used as the independent MP3 decode oracle.

## Outcome and truth boundary

Task 7C is implemented and locally verified. It provides:

- exact wire languages `en`, `yue-Hant-HK`, and `cmn-Hans-CN` from client
  serialization through durable upload/turn binding, with provider-specific
  locale mapping only inside the ASR, TTS, and LLM provider adapters;
- content-free, release/window-bound server/provider timings correlated to the
  exact request or upload whose latency is judged;
- strict expected grounding and media acceptance rather than presence checks;
- real provider-adapter failure injection that proves canonical assistant text
  remains visible when TTS synthesis fails;
- three-language Google voice smoke evidence contracts, including generated
  LINEAR16 ASR fixture provenance and full MP3 decode evidence; and
- a fail-closed, separate iPhone/Safari certification artifact contract.

This report does **not** claim that a real provider smoke, candidate load run,
or real iPhone/Safari run has occurred. Those remain release-time or
device-time evidence gates. `iosVoiceCertified` remains false without a valid
schema-v3 real-device artifact.

## TDD and independent-review remediation evidence

The original Task 7C implementation was committed as
`eb327328f1955eeb34421b04ad6ecc73f4c9710e`. Independent review returned
NO-APPROVE. Each finding was reproduced with a failing test before its fix.

| Batch | Initial RED / reproduced defect | Focused GREEN |
| --- | --- | --- |
| Exact language contract | legacy provider aliases could appear on the wire and tests masked the mismatch | exact wire-language assertions; language-focused set 275/275 |
| Correlated TTS/ASR timing | TTS could be timed from a later cached `/audio` request; ASR observations were not rigorously paired to spool-complete and bucket duration | timing/failure-focused set 156/156 |
| Controlled TTS failure | artifact lacked a genuine provider-adapter rejection path | real adapter rejection plus canonical-text retention covered in the 156/156 set |
| Strict grounding | unrelated/extra verified facts or citations could satisfy a loose oracle | grounding-focused set 6/6 |
| MP3 integrity | decoder export was initially absent; header/pseudo-frame acceptance was insufficient | structural traversal plus independent full-buffer decode 2/2 |
| iOS evidence v3 | legacy booleans or an unrelated WAV were not cryptographically bound to the raw device capture | generator and validator 2/2 |
| Combined Task 7C focus | all remediation paths together | 284/284 |

Earlier TDD batches retained from the original implementation include the
executable contract, stable-plus-candidate origin, NAT-safe bootstrap, explicit
three-language ASR binding, authenticated timing endpoint, generated-fixture
voice smoke, immutable evidence writer, narrow preboot smoke configuration,
production readiness, session API, and voice-media regressions.

## SLO and invariant matrix

| Signal | Acceptance threshold and evidence boundary |
| --- | --- |
| Message ACK | P95 <= 300 ms |
| Processing visible | P95 <= 500 ms |
| Grounded answer visible | P50 <= 2,500 ms; P95 <= 6,000 ms |
| 10-second ASR | paired spool-complete to transcript-ready samples; P50 <= 2,500 ms and P95 <= 4,000 ms |
| 30-second ASR | paired spool-complete to transcript-ready samples; P95 <= 6,000 ms |
| 55-second ASR | paired spool-complete to transcript-ready samples; P95 <= 6,000 ms |
| TTS ready | original accepted voice request to synthesis-ready; P50 <= 2,500 ms and P95 <= 5,000 ms |
| Delivery integrity | zero duplicate replies and zero accepted-message loss |
| Grounding integrity | zero unsupported verified facts; exact expected claim, evidence, source, and URL; no extra verified claims or citations |
| TTS failure behavior | 100% of canonical visible text remains usable and audio failure is reported |

The workload serializes the immutable `replyLanguage` and `replyMode` tuple and
covers all three wire languages. It sends 31 voice-mode source turns: 30
successful TTS samples plus one isolated controlled TTS provider failure. The
failure turn is not counted as a success sample.

ASR acceptance requires a server observation from spool-complete to
transcript-ready and its exact provider observation, joined by correlation ID,
binding ID, upload ID, source duration, operation, outcome, and bounded
timestamp. Each 10/30/55-second bucket must contain its expected exact pairs.
TTS acceptance begins when the original accepted voice request is prepared,
then correlates server and provider completion to the exact assistant message.
The workload only polls the resulting audio status; it does not manufacture a
later synthesis request to improve the measurement.

The acceptance-only failure header is accepted solely in the candidate
acceptance context. It reaches the real configured TTS adapter with an invalid
empty synthesis input, obtains the canonical `VOICE_SYNTHESIS_REJECTED` failure,
and verifies that the already-delivered canonical assistant text is unchanged
and usable.

Timing artifacts are content-free. They contain bounded identifiers, digests,
operations, layers, outcomes, failure codes, and durations; they do not contain
prompts, transcripts, audio, tokens, URLs, credentials, or secrets.

## Grounding oracle

Each deterministic acceptance prompt declares its exact allowed claim ID,
evidence ID, source ID, and source URL. A grounded response passes only with
that one verified citation and no additional verified factual claims or
citations. A response marked non-grounded must be unverified and contain zero
citations. Consequently, an official but unrelated citation, an extra factual
claim, or a cited non-grounded response fails acceptance.

## MP3 traversal, decode, and media binding

TTS acceptance validates HEAD, byte-range GET, full GET, MIME type, declared
length, and that the media response `messageId` equals the requested assistant
message ID. The full response then passes both:

1. bounded MPEG traversal: exact ID3 bounds, MPEG version/layer, bitrate,
   sample rate, channel mode, computed frame length, complete contiguous frames,
   nonzero payloads, consistent stream parameters, and no truncation; and
2. independent full-buffer decoding with exact
   `mpg123-decoder@1.0.3`: zero decoder errors, nonzero samples, a bounded sample
   rate and channel count, finite decoded planes, and decoded duration within a
   bounded tolerance of structural duration.

TTS voice evidence contract `google-tts-v3` records the pinned decoder, decoded
sample count/rate/channel count/duration, byte length, and audio digest for each
language.

The committed regression fixture contains only a 940-byte, three-complete-frame
prefix of upstream `parallel.1.mp3` from `eshaz/wasm-audio-decoders` commit
`e8d3a22e53c63b84f96faf330384fe0e205214fe`. Its SHA-256 is
`edb14c9748600607f1c63f6c3a20734a3ccf19f41141c9cfd9069210c9fac024`.
It is provenance-pinned test data, not a handcrafted speech recording or live
acceptance sample.

## Voice smoke and ASR fixture provenance

- Provider and voice smoke bind to `/app/release-manifest.json`, the lowercase
  release SHA, and caller-selected immutable private evidence output.
- Provider/voice Cloud Run Jobs must run as
  `hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com`; smoke reads
  the metadata identity and embeds it in the evidence.
- No speech WAV was invented or committed. Real ASR smoke first asks the pinned
  Google TTS configuration to generate three non-sensitive LINEAR16 samples,
  validates and digests the exact WAV bytes, and then submits those same bytes
  to locale-bound Google ASR.
- ASR evidence preserves distinct generation and transcription stages,
  latencies, and digests. Failures remain diagnosable without recording speech
  content in the evidence.

## iOS schema-v3 certification boundary

The generator now requires all of the following exact absolute inputs plus an
explicit real-device confirmation flag:

- a raw iPhone Safari `audio/mp4` capture;
- its normalized canonical mono, 16 kHz, PCM16 WAV;
- a schema-v2 device/browser report; and
- a schema-v1 ordered normalization and UX steps report.

It traverses the ISO-BMFF container and requires `ftyp`, a bounded audio `moov`
track (`mp4a` or Opus), and a nonempty `mdat`. The output binds raw capture
digest/bytes, WAV digest/bytes/duration, device report digest/bytes, steps
digest/bytes, device run ID, and the exact normalizer contract in one aggregate
SHA-256. Required steps are ordered and individually observed: permission,
55-second auto-stop, track cleanup, cancel cleanup, one idempotent upload,
editable transcript, denial fallback, and no raw-container upload.

Legacy schema-v1/v2 boolean evidence, mismatched or unrelated WAV bytes,
unbound reports, bad container bounds, missing steps, and arbitrary confirmation
are rejected. No real device run was performed in Task 7C.

## Fresh local verification

- Focused command covering the eight Task 7C suites: 284/284 passed.
- Task 7C's pre-integration full `cmd /d /c npm.cmd test`: 1,359 tests;
  1,358 passed; 0 failed; 1 skipped. A later shared-worktree rerun after Task
  7A added an uncommitted release-archive test was 1,357 passed, 1 failed, and
  1 skipped; the sole failure was that Task 7A archive test's deterministic-tar
  hash assertion, outside Task 7C. Task 7C's 284-test focused set remained green.
- `cmd /d /c npm.cmd run check`: exit 0.
- `cmd /d /c npm.cmd ls mpg123-decoder@1.0.3 --depth=0`: exact dependency present.
- Explicit syntax checks for the new MP3 module, iOS generator, and MP3 fixture:
  exit 0.
- `git diff --check`: exit 0; line-ending warnings only, no whitespace error.

These are local deterministic checks only. Live provider, candidate load,
release image, GCP object generation, and iPhone evidence are not certified by
this report.

## Exact Task 7C files

Implementation and contracts across the original Task 7C commit and this
review-remediation commit:

- `.superpowers/sdd/2026-08-26-production-v1-gcp-launch/task-7c-report.md`
- `production-v1/package.json`
- `production-v1/package-lock.json`
- `production-v1/public/chat-controller.js`
- `production-v1/public/voice-message-controller.js`
- `production-v1/public/voice-transport.js`
- `production-v1/public/voice-upload-coordinator.js`
- `production-v1/public/voice-upload-store.js`
- `production-v1/scripts/ios-voice-evidence.js`
- `production-v1/scripts/production-latency-workload.js`
- `production-v1/scripts/provider-smoke.js`
- `production-v1/scripts/voice-provider-smoke.js`
- `production-v1/src/app.js`
- `production-v1/src/config.js`
- `production-v1/src/http/security.js`
- `production-v1/src/http/session.js`
- `production-v1/src/http/voice.js`
- `production-v1/src/media/canonical-mp3.js`
- `production-v1/src/providers/asr.js`
- `production-v1/src/providers/llm.js`
- `production-v1/src/providers/tts.js`
- `production-v1/src/server.js`
- `production-v1/src/services/answer.js`
- `production-v1/src/services/gcs-evidence-writer.js`
- `production-v1/src/services/turn-processor.js`
- `production-v1/src/services/voice-evidence.js`
- `production-v1/src/services/voice.js`
- `production-v1/src/telemetry/acceptance-timings.js`
- `production-v1/src/telemetry/logger.js`

Focused tests and fixture:

- `production-v1/tests/answer.test.js`
- `production-v1/tests/chat-controller.test.js`
- `production-v1/tests/config-shell.test.js`
- `production-v1/tests/fixtures/canonical-mp3-fixture.js`
- `production-v1/tests/latency-acceptance.test.js`
- `production-v1/tests/provider-contracts.test.js`
- `production-v1/tests/readiness.test.js`
- `production-v1/tests/security-rate-limit.test.js`
- `production-v1/tests/session-api.test.js`
- `production-v1/tests/task-7c-contract.test.js`
- `production-v1/tests/turn-api.test.js`
- `production-v1/tests/voice-evidence.test.js`
- `production-v1/tests/voice-media.test.js`
- `production-v1/tests/voice-transport.test.js`
