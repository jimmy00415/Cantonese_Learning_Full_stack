# Task 7C report — honest multilingual voice and latency acceptance

Date: 2026-08-26
Scope: Task 7C only; no GCP mutation, Docker/build/release/infra edits, package changes, or real-dependency acceptance edits.

## Outcome

Task 7C is implemented and locally verified. Production V1 now has an exact
stable-plus-candidate origin contract, NAT-safe anonymous bootstrap limits,
immutable three-language ASR binding, content-free correlated acceptance
timings, exact latency/grounding/media acceptance, three-language Google voice
smoke evidence contracts, and a separate honest iOS certification boundary.

This report does **not** claim that real provider smoke, candidate load, or real
iPhone/Safari acceptance has run. Those remain release-time or device-time
evidence gates.

## TDD evidence

| Batch | Initial RED | Focused GREEN |
| --- | --- | --- |
| Executable 7C contract | 0/1; missing acceptance timing module | 14/14 |
| Exact workload, SLO, grounding and media contract | 21/55 | 67/67 |
| Stable plus SHA-bound candidate origin | 0/3 | 3/3 |
| NAT client-instance plus coarse-IP bootstrap | 1/3 | 3/3 |
| Three-language ASR transport and durable binding | 0/2 | 2/2 |
| Authenticated timing endpoint | 0/1 | 1/1 |
| Turn-to-async-TTS timing correlation | missing recorder binding | 1/1 |
| Provider locale mapping | `zhHant` incorrectly reached provider unchanged | 1/1; maps to `yueHant` |
| Pinned LINEAR16 fixture generation | missing provider method | 1/1 |
| Three-language Google evidence schema | schema rejected | 1/1 |
| Google ASR generated-fixture smoke | command exited 2 | 1/1 |
| Genuine iOS evidence generator | module missing | 1/1 |
| Immutable GCS evidence writer | module missing | 1/1 |
| Narrow preboot voice-smoke config | export missing | 1/1 |
| Production readiness regression | 57/72; stale origin/runtime fixtures | 75/75 |
| Session API regression | 5/6; stale production fixture | 6/6 |
| Voice media lifecycle regression | legacy valid requests lacked explicit ASR language and hung/faulted | 76/76 |

Two final compatibility REDs were also kept fail-closed and repaired: the
client-instance identity now uses a generator independent from message UUIDs,
and an absent acceptance context is omitted from legacy TTS preparation rather
than passed as an `undefined` property.

## SLO and invariant matrix

| Signal | Acceptance threshold |
| --- | --- |
| Message ACK | P95 <= 300 ms |
| Processing visible | P95 <= 500 ms |
| Grounded answer visible | P50 <= 2,500 ms; P95 <= 6,000 ms |
| 10-second ASR | P50 <= 2,500 ms; P95 <= 4,000 ms |
| 30-second ASR | P95 <= 6,000 ms |
| 55-second ASR | P95 <= 6,000 ms |
| TTS ready | P50 <= 2,500 ms; P95 <= 5,000 ms |
| Delivery integrity | zero duplicate replies and zero accepted-message loss |
| Grounding integrity | zero unsupported verified facts; exact expected claim/evidence/source IDs |
| TTS failure behavior | 100% of visible text remains usable |

The workload sends the real serialized immutable `replyLanguage` and
`replyMode` tuple, exercises Cantonese, English, and Mandarin, and includes 30
eligible voice turns. Missing/wrong sample counts, query digests, correlated
timings, grounding IDs, media behavior, or thresholds fail the artifact.

TTS acceptance performs HEAD, byte-range GET, full GET, MIME/size checks, and
canonical MPEG frame validation. Timing observations are bounded and contain
only release/window/session/turn/message digests, stage names, and durations;
they contain no prompt, transcript, audio, token count, URL, credential, or
secret.

## Voice smoke and fixture provenance

- Production provider and voice smoke bind to `/app/release-manifest.json`, the
  lowercase release SHA, and immutable GCS evidence objects.
- Provider/voice Cloud Run Jobs are required to run as
  `hkbuddy-runtime@hkbuddy-prod-v1-20260826.iam.gserviceaccount.com`; runtime
  identity is read from the metadata server and embedded in schema-v2 voice
  evidence.
- No speech WAV was invented or committed. The real Google ASR smoke first asks
  the pinned Google TTS configuration to generate three non-sensitive LINEAR16
  samples, validates and digests those exact WAV bytes, then transcribes the
  same artifacts with the locale-bound recognizer.
- ASR evidence preserves separate TTS-generation and ASR-transcription
  latencies/digests plus content-free edit/error metrics. TTS evidence covers
  the exact pinned Cantonese, English, and Mandarin MP3 voices and their
  byte/digest/decodability facts.
- Full JSON evidence is written privately and immutably to a caller-specified
  release object with `ifGenerationMatch=0`; stdout contains only a bounded
  non-sensitive summary.

## iOS certification boundary

`voiceInput` is governed by real server ASR evidence and no longer pretends that
server ASR readiness proves Safari capture. `iosVoiceCertified` is an independent
status field and remains false unless a separate valid real-device artifact is
provided.

The iOS generator is inert without the exact confirmation flag. With that flag,
it requires an absolute real-device report, a canonical WAV, explicit iPhone /
iOS / Safari / `audio/mp4` facts, all required interaction assertions, a recent
observation, and clean frozen Git before and after generation. No such device
run was performed or claimed in this task.

## Fresh verification

- `npm test`: 1,323 tests; 1,322 passed; 0 failed; 1 skipped.
- `npm run check`: exit 0.
- Additional syntax checks for `canonical-mp3.js`,
  `gcs-evidence-writer.js`, `acceptance-timings.js`, and
  `ios-voice-evidence.js`: exit 0.
- `node --test tests/voice-media.test.js`: 76/76 passed.
- `node --test tests/readiness.test.js`: 75/75 passed.
- `node --test tests/session-api.test.js`: 6/6 passed.
- `git diff --check`: exit 0 (line-ending warnings only; no whitespace error).

## Scoped files changed

Implementation:

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
- `production-v1/src/providers/tts.js`
- `production-v1/src/server.js`
- `production-v1/src/services/gcs-evidence-writer.js`
- `production-v1/src/services/turn-processor.js`
- `production-v1/src/services/voice-evidence.js`
- `production-v1/src/services/voice.js`
- `production-v1/src/telemetry/acceptance-timings.js`
- `production-v1/src/telemetry/logger.js`

Focused tests:

- `production-v1/tests/chat-controller.test.js`
- `production-v1/tests/config-shell.test.js`
- `production-v1/tests/latency-acceptance.test.js`
- `production-v1/tests/readiness.test.js`
- `production-v1/tests/security-rate-limit.test.js`
- `production-v1/tests/session-api.test.js`
- `production-v1/tests/task-7c-contract.test.js`
- `production-v1/tests/voice-media.test.js`
- `production-v1/tests/voice-transport.test.js`
