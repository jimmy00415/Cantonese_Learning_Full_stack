# Final review fix — Cloud Run rejected-execution recovery report

## Scope and starting point

- Worktree: `D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1`
- Branch: `codex/gcp-production-v1-launch`
- Reviewed starting commit: `ab49d547f8065b8f66ff810e6b37464aa5a5e5fa`
- Runtime used: bundled Node `v24.19.0`, npm `10.9.8`
- No GCP or Azure mutation was performed. No archived evidence or attempt was
  edited, and no subagent was used.

The final review finding was confined to the recovery proof for a rejected
Cloud Run Job execution. Task 8A inventory matching, Task 8B waiver behavior,
Task 8C dependency policy, existing phase order, successful/lost-response Job
execution behavior, receipt ordering, and terminal failure handling were not
weakened or redesigned.

## Root cause

The old `FAILED_PRECONDITION` recovery path accepted the rejection only when
the current Cloud Run executions list was empty. Cloud Run retains historical
executions, so a valid rejected request against a Job with any prior execution
could not close its open journal intent even when that request created nothing.
The intent also contained no authoritative pre-execution execution-set
baseline against which restart recovery could compare the current state.

## RED — focused failing tests first

The existing positive recovery case was first changed from an artificial empty
history to a non-empty historical baseline. Before production changes, the
focused test failed as required:

```text
Expected: CLOUD_RUN_EXECUTION_REJECTION_RECOVERED
Actual:   CLOUD_RUN_EXECUTION_REJECTION_EVIDENCE_INVALID
Tests: 1 failed
```

Further tests were added before each corresponding production change:

- normal acceptance execution required `list -> intent -> execute` for each of
  the four guarded Jobs and initially observed 16 calls instead of 20;
- the state-store test required an exact execution baseline on each Cloud Run
  execute intent and initially rejected the new valid journal;
- the ambiguity matrix initially demonstrated that malformed execution
  metadata, foreign-project executions, and foreign-region executions could be
  treated as recoverable.

Those RED results established the missing pre-intent snapshot, missing durable
journal schema, and insufficient execution metadata validation independently.

## Design and implementation

Immediately before journaling every non-restart `*-execute` Cloud Run mutation,
the release runner now:

1. validates the exact managed Job readback as Ready and binds its generation
   and UID;
2. reads that Job's complete authoritative execution list in the fixed project
   and region;
3. validates every execution's API kind/version, exact Job label and bounded
   name, project-number namespace, region label, UUIDv4 UID, and optional exact
   self-link;
4. rejects non-arrays, oversized sets, duplicate names, duplicate UIDs,
   malformed entries, and foreign scope; and
5. sorts the `{name, uid}` identities and journals their canonical SHA-256,
   count, Job, Job generation/UID, project/project number, and region in the
   mutation intent before the Job execution is attempted.

The journal state store requires that exact closed baseline schema for every
`cloud-run-job-execute` intent and binds the baseline Job to the phase and
operation. Rejected-command abort evidence must match the paired intent's set
digest, Job, generation, UID, project, and region.

Recovery still applies only to the previously reviewed dependency-acceptance
`FAILED_PRECONDITION` path. It rereads and validates the exact failed Job
authority and current execution set, canonicalizes the current set using the
same function, and accepts only exact equality with the intent baseline. Thus
an unchanged non-empty history is recoverable, while any set or authority drift
fails closed. Restart recovery remains read-only and never calls `jobs execute`.

The operator-visible proof and fail-closed behavior are documented narrowly in
`production-v1/infra/gcp/README.md`.

## Regression coverage

Focused tests now prove:

- four normal acceptance executions and resumed migration execution snapshot
  before intent and execute;
- ambiguous pre-execution scope or list-read failure creates neither an execute
  intent nor an execute request;
- a two-entry non-empty historical set is accepted even when the current list
  returns the same identities in reverse order;
- restart recovery never re-executes the Job;
- added, removed, duplicate, malformed, foreign-project, foreign-region,
  wrong-Job, and current-attempt executions all fail closed;
- execution-list failure, Job-read failure, Job generation drift, Job UID
  drift, and non-array list output all fail closed without appending a record;
  and
- missing, extra, malformed, out-of-range, wrong-Job, and foreign-scope intent
  baseline fields are rejected by durable journal validation.

## GREEN and final verification

All required verification used the bundled Node runtime and exited `0`:

| Command | Result |
| --- | --- |
| focused release/recovery patterns | 25 passed, 0 failed |
| focused state-store baseline/rejection patterns | 2 passed, 0 failed |
| full `tests/release-contract.test.js` | 171 passed, 0 failed |
| full `tests/release-state-store.test.js` | 69 passed, 0 failed |
| `npm run check` | passed |
| controlled full `npm test` | 2,761 passed, 0 failed, 1 skipped (2,762 total; 219,006.8209 ms) |
| `npm run security:dependencies` | passed with the existing reviewed exception only |
| `git diff --check` | passed |

The full suite used the repository's documented controlled bindings:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\playwright'
$env:TEMP = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\temp'
$env:TMP = 'D:\VS_PROJECT\Testing\HongKong_Buddy\.codex-task-5g-temp\tmp'
```

A preliminary full-suite invocation without these required bindings was not
accepted as verification: it failed only the 63 controlled Task 8 mobile cases,
starting with the explicit browser-root assertion. The documented controlled
rerun above passed completely.

One read-only diagnostic command listed one real dependency-acceptance Job
execution to confirm the Cloud Run v1 JSON fields used by the validator
(`metadata.namespace`, location label, UID, and self-link). It exited `0` and
made no cloud change.

## Self-review

- The canonical set is order-independent but identity-sensitive; both name and
  UID are hashed, and count is durably retained.
- Baseline acquisition completes before the journal intent and execute call, so
  an ambiguous snapshot cannot authorize a mutation.
- Restart with an existing execute intent does not acquire a new baseline and
  cannot execute. Only the explicit immutable rejection-evidence recovery path
  performs the authoritative read-only comparison.
- Current execution metadata is validated before comparison, so matching-looking
  foreign or malformed rows cannot influence a digest.
- Existing success, response-loss, failed-execution, receipt, Job authority,
  generation/UID, and phase behavior remains covered by the full suites.
- The diff is limited to the release runner, journal validator, their focused
  tests, the narrow GCP operator documentation, and this report.

## Result

The Important final-review issue is fixed. Rejected Cloud Run execution
recovery now accepts an unchanged non-empty historical execution set and fails
closed on every required ambiguity without ever re-executing the Job.
