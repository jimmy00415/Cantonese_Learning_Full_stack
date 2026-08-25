# Task 7C report — honest multilingual voice and latency acceptance

Date: 2026-08-26
Scope: Task 7C only. No GCP mutation and no Docker, build, release, infrastructure,
or real-dependency acceptance changes were made by Task 7C. The package
manifest changes are the parent-approved exact runtime dependency
`mpg123-decoder@1.0.3`, used as the independent MP3 decode oracle, and the
parent-approved exact **dev-only** dependency
`@ffmpeg-installer/ffmpeg@1.1.0`, used only by the offline iOS evidence
generator. The production image installs with `--omit=dev` and does not copy
the iOS generator, so it contains neither that generator nor its FFmpeg binary.

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
- a fail-closed, separate iPhone/Safari schema-v4 artifact contract whose WAV
  is derived by the generator itself with an allowlisted binary.

This report does **not** claim that a real provider smoke, candidate load run,
or real iPhone/Safari run has occurred. Those remain release-time or
device-time evidence gates. `iosVoiceCertified` remains false without a valid
schema-v4 real-device and operator artifact. The synthetic AAC fixture used in
local regression tests is not physical-iPhone provenance and is not a release
artifact.

## TDD and two-round independent-review remediation evidence

The original Task 7C implementation was committed as
`eb327328f1955eeb34421b04ad6ecc73f4c9710e`. The first remediation was
committed as `47b7a8f`. Two independent reviews returned NO-APPROVE; every
finding was reproduced with a failing test before its fix.

| Batch | Initial RED / reproduced defect | Focused GREEN |
| --- | --- | --- |
| Exact language contract | legacy provider aliases could appear on the wire and tests masked the mismatch | exact wire-language assertions; language-focused set 275/275 |
| Correlated TTS/ASR timing | TTS could be timed from a later cached `/audio` request; ASR observations were not rigorously paired to spool-complete and bucket duration | timing/failure-focused set 156/156 |
| Exact LLM timing pairs | count-preserving duplicate, missing, correlation mutation, or binding mutation could satisfy the prior text timing count | workload plus adversarial timing set 17/17 |
| Controlled TTS failure | artifact lacked a genuine provider-adapter rejection path | real adapter rejection plus canonical-text retention covered in the 156/156 set |
| Strict grounding | unrelated/extra verified facts or citations could satisfy a loose oracle | grounding-focused set 6/6 |
| MP3 integrity | decoder export was initially absent; header/pseudo-frame acceptance was insufficient; a decoded all-zero PCM plane still passed | structural traversal plus independent full-buffer decode, silent-plane rejection, and bounded low-amplitude retention 2/2 |
| iOS evidence v3 to v4 | marker-only fake MP4 plus an unrelated WAV could still certify, and normalizer fields were self-attested | real decode/derivation generator 1/1 and strict validator 1/1 |
| Combined Task 7C focus | all remediation paths together | 326/326 |

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

Every expected text operation is likewise keyed by its original correlation ID
and assistant-message binding ID. Exactly one successful server observation is
required for each of 200 text turns, and exactly one provider observation is
required for each of the 80 turns expected to call the model. Duplicate,
missing, extra, or mutated observations make the pair set unavailable. Text
SLOs are computed only from those exact paired samples, never from unpaired
count-equivalent observations.

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
   bounded tolerance of structural duration. The decoded planes must also
   exceed bounded peak-amplitude and mean-square-energy floors: all-zero PCM is
   rejected while the regression retains valid 1e-6-amplitude samples.

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

## iOS schema-v4 certification boundary

The generator now requires all of the following exact absolute inputs plus an
explicit real-device confirmation flag:

- a raw iPhone Safari `audio/mp4` capture;
- its normalized canonical mono, 16 kHz, PCM16 WAV;
- a schema-v2 device/browser report; and
- a schema-v2 ordered operator and UX steps report.

It traverses the ISO-BMFF container and requires `ftyp`, a bounded audio `moov`
track (`mp4a` or Opus), and a nonempty `mdat`. Structural markers are not the
decode oracle. The generator then:

1. selects the exact allowlisted `win32-x64` binary installed through the exact
   dev dependency `@ffmpeg-installer/ffmpeg@1.1.0`;
2. verifies installer version `20181217-f22fcd4`, binary SHA-256
   `c8abc49e7be62dde8e12972af373959e0076a7b8dc8040eb45978e0608f8781e`,
   and the exact `ffmpeg -version` first line before use;
3. writes the bound MP4 only into a unique per-user temporary directory,
   requests mode 0700/0600 where the OS honors POSIX modes, executes fixed argv
   without a shell and with FFmpeg's protocol allowlist restricted to `file`,
   derives `derived.wav` itself, validates canonical WAV bytes, and removes the
   directory in `finally`; and
4. requires the derived bytes to equal the separately supplied and
   report-bound WAV byte-for-byte.

Schema-v4 output binds raw capture digest/bytes, derived WAV
digest/bytes/duration, device report digest/bytes, steps digest/bytes, device
run ID, normalizer package/platform/binary digest/actual version/exact argv/exit,
and the aggregate normalization binding. Normalization-step input no longer
contains trusted normalizer fields. Required operator steps remain ordered and
individually observed: permission, 55-second auto-stop, track cleanup, cancel
cleanup, one idempotent upload, editable transcript, denial fallback, and no
raw-container upload.

The regression executes a genuinely decodable AAC-in-MP4 fixture and proves
both full derivation and private-temp cleanup. A fully self-consistent
marker-only fake MP4 bundle, a real decodable MP4 paired with an unrelated WAV,
and self-attested normalizer fields are rejected. The AAC fixture is generated
for deterministic engineering verification; it is not represented as a
physical iPhone recording.

Legacy schema-v1/v2/v3 evidence, unbound reports, bad container bounds, missing
steps, and arbitrary confirmation are rejected. No real device or operator run
was performed in Task 7C, so `iosVoiceCertified` remains false in the release.
The wrapper package declares LGPL-2.1, while the installed optional Windows
binary package declares GPLv3 and reports a GPL-enabled build; for that reason
the tool remains offline/dev-only and is not shipped in the production image.

## Fresh local verification

- Focused command covering the eight Task 7C suites: 326/326 passed.
- Full `npm.cmd test`: 1,431 tests; 1,430 passed; 0 failed; 1 pre-existing
  skip.
- `npm.cmd run check`: exit 0.
- `npm.cmd run security:dependencies`: exit 0 with the exact
  `DEPENDENCY_SECURITY_EXCEPTION_REVIEWED` receipt; 0 high and 0 critical
  vulnerabilities, with the separately reviewed current moderate exception.
- `npm.cmd ls @ffmpeg-installer/ffmpeg@1.1.0 mpg123-decoder@1.0.3 --depth=0`:
  both exact versions present in their intended dev/runtime dependency classes.
- Explicit syntax checks for the MP3 module, iOS generator, latency workload,
  and voice-evidence validator: exit 0.
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
