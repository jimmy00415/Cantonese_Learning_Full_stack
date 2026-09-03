# Task 8B report — honest product-owner real-iPhone waiver

## Status

Task 8B is implemented in the required `gcp-production-v1` worktree on
`codex/gcp-production-v1-launch`, starting from
`3740f7f81c71e05424425f400afe7300ec9797d1`. The final task commit is the commit
reported by the handoff; it cannot be embedded in its own content. A release
operator must generate the waiver only after that final commit is known and
must bind the waiver to that exact lowercase 40-hex SHA.

The implementation is locally verified. Production launch is not yet cleared:
the independent mandatory dependency security gate fails closed on newly
reported `qs` advisories, as recorded below. No dependency exception was added
and no non-iPhone release gate was bypassed.

## Implemented behavior

- Added immutable `iosVoiceWaiverContract` values for the exact product-owner
  decision, owner, scope, reason, limitation, result, and seven-day duration.
- Added `validateIosVoiceReleaseEvidence`, which accepts either the unchanged
  schema-v4 real-iPhone evidence validator or the exact current waiver.
- Left `validateIosVoiceEvidence` unchanged. Runtime configuration still uses
  only that certification validator, so a waiver reports
  `iosVoiceCertified=false` and `iosVoiceAcceptanceVersion=null`.
- The waiver validator requires exact keys and values, a lowercase release SHA,
  a canonical digest from `finalizeEvidenceRecord`, canonical ISO-8601 approval
  and expiry instants, approval no more than five minutes in the future, expiry
  strictly after the validation clock, and an interval of exactly seven days.
- The current GCP `evidence` phase alone uses the release-only validator before
  publication. Historical receipt-bound candidate cleanup and rollback keep
  their prior immutable byte/hash behavior. Manifest, evidence, receipt, and
  numeric Secret-version bindings are unchanged.
- Added the create-only local `acceptance:ios-waiver` generator. It accepts only
  the three exact `--name=value` arguments, rejects missing/extra/duplicate
  arguments, wrong owner/SHA, relative or non-JSON destinations, and existing
  destinations. It writes canonical UTF-8 JSON plus one trailing newline with
  create-only semantics and prints only destination, artifact digest, approval
  time, expiry time, and decision on success. It has no credential input or
  credential access.
- Updated the launch design, implementation plan, GCP runbook, and production
  README to state that this release may be public under the exact waiver but is
  not real-iPhone certified. Controlled Playwright `390x844` mobile, real
  Google LLM/ASR/TTS, privacy, readiness, latency/workload, trace, candidate,
  and promotion gates remain mandatory.

## TDD evidence

### RED

Before production edits, the new focused test file was run with the bundled
Node runtime:

```text
node --test tests/ios-voice-waiver.test.js
tests 22; pass 0; fail 22; exit 1
```

Expected failures were observed because `iosVoiceWaiverContract` and
`validateIosVoiceReleaseEvidence` were absent, the generator module did not
exist, and the package command was absent.

The release/runtime-focused RED run was:

```text
node --test --test-name-pattern="owner waiver" tests/release-contract.test.js tests/config-shell.test.js
tests 2; pass 1; fail 1; exit 1
```

The runtime characterization passed before implementation. The new release
test failed with `RELEASE_PHASE_FAILED`, `mutationPerformed=false`, and no
Secret Manager calls, proving the missing release-only acceptance branch.

### GREEN

After minimal implementation:

```text
node --test tests/ios-voice-waiver.test.js
tests 29; pass 29; fail 0; exit 0

node --test --test-name-pattern="owner waiver" tests/release-contract.test.js tests/config-shell.test.js
tests 2; pass 2; fail 0; exit 0

node --test tests/ios-voice-waiver.test.js tests/voice-media.test.js tests/release-contract.test.js tests/config-shell.test.js
tests 299; pass 299; fail 0; exit 0
```

The focused suite covers current acceptance, runtime rejection, expiry, future
skew, short/long intervals, wrong owner/SHA/scope/reason/result/decision,
limitations drift, extra keys, noncanonical instants, wrong and tampered
digests, exact CLI invocation, missing confirmation, relative/non-JSON paths,
duplicates/extras, canonical file creation, and overwrite refusal. The release
test proves the waiver is validated before the first Secret publication. The
configuration test proves Google provider-backed input/output voice remains
available independently while real-iPhone certification remains false/null.

## Final verification

All commands used the bundled Node `v24.19.0` runtime.

- `npm run check`: exit 0, including syntax validation of
  `scripts/ios-voice-waiver.js`.
- Full `npm test` with the documented controlled `D:` Playwright browser cache,
  `TEMP`, and `TMP`: exit 0. An initial run without those required environment
  bindings failed only the controlled-mobile group; rerunning unchanged code
  with the documented bindings passed.
- `git diff --check`: exit 0.
- Task 8A boundary check: `git diff -- production-v1/scripts/gcp-provision.js`
  was empty.
- No GCP or Azure command was run, no cloud state was mutated, and no archived
  attempt was edited.

The required live dependency gate was run and failed closed:

```text
npm run security:dependencies
{"status":"failed","code":"DEPENDENCY_AUDIT_NOT_ALLOWED"}
exit 1
```

Read-only inspection of the fresh audit showed three moderate findings:
reviewed `gaxios` via `uuid`, reviewed `uuid` advisory `1119441`, and newly
reported `qs` advisories `1158506` and `1158507`. The checked-in gate permits
only the exact two-finding reviewed exception. This is independent of the Task
8B waiver and remains a mandatory release blocker requiring a separate
dependency remediation or explicitly reviewed security-policy change.

## Self-review

- All fixed waiver values and exact-key validation match the Task 8B brief.
- The original schema-v4 validator body and runtime call site were not changed.
- Only current iOS evidence publication calls the alternative validator;
  historical cleanup/rollback code is unchanged.
- The waiver generator creates evidence locally and cannot mutate cloud state.
- No credential field, environment read, token, prompt, transcript, audio, or
  provider body is accepted or emitted by the generator.
- Task 8A resource rules and preflight/provision behavior were not touched.
- The waiver is explicitly limited to real iPhone/Safari evidence and cannot
  turn any other gate green.

## Remaining concern

Do not begin the fresh release attempt until the dependency security gate is
green under its own mandatory contract. Once it is green and the final task SHA
is known, generate a new waiver outside tracked source and use that final SHA;
do not reuse a waiver generated for an earlier commit.
