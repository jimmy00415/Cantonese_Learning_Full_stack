# HK Buddy Workspace And Release Layout Design

**Status:** Implemented and independently verified on 2026-09-02; pending local branch integration.

## Goal

Keep exactly one HK Buddy-owned directory at `D:\VS_Project\HK_Buddy` while preserving parallel development, immutable release-attempt evidence, and a trustworthy mapping from source commits to GCP deployments.

## Current State

The primary checkout is `D:\VS_Project\HK_Buddy` on branch `feat/production-v1-ai-senior` at commit `8a162da6d093155e46b0f9e39ff6112eb45f2833`. A clean linked worktree exists at `D:\VS_Project\HK_Buddy-deploy` on branch `ops/gcp-production-v1-deploy-20260901` at commit `7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3`.

Nine top-level directories named `HK_Buddy-release-*` are not Git repositories. They are release-attempt evidence bundles containing frozen source archives, Cloud Build configurations, manifests, inventories, receipts, and journals. The `7c32f6d6` attempt completed through evidence collection but was not promoted. The remaining attempts are failed, terminalized, incomplete, or response-uncertain historical attempts.

Every release manifest contains absolute paths. The build configuration path is also part of `releaseIdentitySha256`, and journal records bind that identity and the phase plan. Moving a bundle and rewriting its manifest would therefore create a different release identity and invalidate continuation of its existing receipt chain. Directory junctions are not an acceptable compatibility mechanism because the release state store rejects symlinked or reparse-point paths.

## Chosen Architecture

```text
D:\VS_Project\
└─ HK_Buddy\
   ├─ .git\
   ├─ .worktrees\
   │  ├─ gcp-production-v1\
   │  └─ <temporary-branch-slug>\
   ├─ .release-evidence\
   │  ├─ attempts\
   │  │  └─ <full-release-sha>\
   │  │     └─ <acceptance-run-id>\
   │  ├─ inventories\
   │  │  └─ <full-release-sha>--<acceptance-run-id>.json
   │  └─ catalog.json
   ├─ ops\
   │  └─ release-index.json
   └─ <primary source checkout>
```

The primary checkout remains the repository root. `.worktrees/` contains linked Git checkouts and is ignored. `.release-evidence/` is an ignored, append-only local evidence cache. `ops/release-index.json` is a tracked, non-secret summary that maps source commits and promoted Git tags to evidence inventory hashes and GCP identities.

The existing deployment worktree moves to `.worktrees/gcp-production-v1` with `git worktree move`. It is never moved with Explorer or raw filesystem commands because both its `.git` file and the common Git metadata contain path references.

## Git Version Model

Branches represent mutable lines of work:

- `main` is the integration baseline.
- `feat/*` and `fix/*` are short-lived product branches.
- `ops/*` contains deployment work that must be reviewed independently from product work.
- At most one long-lived local deployment worktree is kept at `.worktrees/gcp-production-v1`; temporary worktrees are removed after their branches are integrated.

Annotated tags represent immutable production versions. A tag is created only after the stable Cloud Run service is public and the end-to-end release verification passes. The tag format is `prod/v1/YYYY.MM.DD.N`, where `N` starts at `1` for each date. Its annotation records the GCP project, Cloud Run revision, container image digest, release SHA, acceptance run ID, and release-index record hash. Failed, abandoned, candidate-only, or unpromoted attempts never receive a production tag.

No production tag is created during this workspace migration because no HK Buddy release has been promoted by the current GCP release chain.

## Release Evidence Model

New attempts are created directly below `.release-evidence/attempts/<full-release-sha>/<acceptance-run-id>` before the first release phase. Their absolute paths are therefore stable for the lifetime of the attempt. Active attempts are never moved.

Each archived attempt receives an inventory stored outside the attempt payload to avoid self-referential hashing. The inventory contains:

- schema version;
- original and archived paths;
- full release SHA and acceptance run ID;
- an `observedJournalState` object derived from the lexically last file in the attempt's receipt-state journal, with keys in this exact order: `lastRecordFile`, `recordType`, `phase`, `status`, `operationId`, `code`; `status` comes from terminal `payload.status` and is otherwise `null`, `operationId` comes from terminal `payload.terminalState.operationId` or the top-level non-terminal record and is otherwise `null`, and `code` comes from terminal `payload.terminalState.code` and is otherwise `null`;
- archive disposition;
- file count and total byte count;
- one SHA-256 digest and byte count for every payload file, using normalized forward-slash relative paths;
- a canonical SHA-256 digest of the ordered inventory entries;
- creation time in UTC.

The local catalog references each inventory digest and records whether the attempt is resumable. The tracked `ops/release-index.json` contains only non-secret summaries. It must not include access tokens, database URLs, signed URLs, private keys, raw evidence payloads, or credential material.

Local evidence is not claimed to be tamper-proof merely because it is ignored by Git. Cryptographic inventories detect later drift. Authoritative release evidence continues to use GCP Artifact Registry, Cloud Storage, Secret Manager, Cloud Build provenance, and Cloud Run readbacks according to the production release contract.

## Treatment Of Existing Attempts

All nine existing top-level attempt directories are preserved byte-for-byte and relocated into the new evidence cache. Their manifests and journal files are not edited.

Because their manifest paths no longer resolve after relocation, all nine are cataloged as non-resumable historical attempts. The disposition is derived without changing their original evidence:

- failed or terminalized journals become `archived-terminal`;
- open or response-uncertain journals become `archived-uncertain`;
- `7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3`, which completed through collection but was not promoted, becomes `superseded-path-migration`.

These dispositions are catalog metadata, not fabricated journal terminal records. The migration does not claim that an uncertain cloud mutation did or did not occur. The next production deployment starts a fresh attempt from the standardized path and independently reconciles current GCP state.

The migration performs no GCP mutation and no Azure access. It neither deletes nor rolls back Cloud Build images, Cloud Run jobs, Cloud SQL state, Cloud Storage objects, or Secret Manager versions.

## Migration Procedure

1. Confirm the primary and deployment worktrees are clean and record their branch and HEAD values.
2. Confirm `.worktrees/` is ignored and add anchored ignore rules for `/.worktrees/` and `/.release-evidence/` to the tracked `.gitignore`.
3. Resolve every source and destination to an absolute path and verify that every destination remains within `D:\VS_Project\HK_Buddy`.
4. Generate pre-move inventories for all nine attempt directories without writing inside them.
5. Create `.release-evidence/attempts`, `.release-evidence/inventories`, and the local catalog.
6. Move the registered deployment checkout with `git worktree move D:\VS_Project\HK_Buddy-deploy D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1`.
7. Move each release-attempt directory with native PowerShell `Move-Item -LiteralPath` on the same volume into its SHA/run-ID destination. No cross-shell path handoff, wildcard, recursive delete, or overwrite is allowed.
8. Recompute every inventory after the move. File paths, byte counts, and SHA-256 values must exactly match the pre-move inventory.
9. Write `.release-evidence/catalog.json` and the non-secret tracked `ops/release-index.json`.
10. Verify Git worktree metadata, both worktree statuses, branch/HEAD identities, archive inventories, and the top-level directory invariant.

If a worktree move fails, stop without pruning metadata. If an evidence move or hash comparison fails, move only the exact affected directory back to its recorded original path and stop. No source directory is deleted during the migration.

## Future Workflow

Developers create parallel checkouts with `git worktree add .worktrees/<branch-slug> <branch>` after verifying `.worktrees/` remains ignored. One branch may be checked out in only one worktree. Worktree removal requires a clean status and an integrated or deliberately retained branch.

Release preparation creates its attempt directory at the final standardized path before producing the source archive or manifest. The acceptance run ID disambiguates repeated attempts for the same commit. A release attempt remains at that path until it is either promoted or archived; it is never renamed during a phase chain.

After promotion, the release process updates `ops/release-index.json`, creates the annotated production tag, verifies that the tag target equals the deployed release SHA, and records the exact public Cloud Run URL and image digest. Pushing branches or tags remains an explicit separate action and is not part of local workspace organization.

## Verification And Acceptance Criteria

The migration is complete only when all of the following are true:

- `D:\VS_Project` contains exactly one directory whose name starts with `HK_Buddy`, namely `D:\VS_Project\HK_Buddy`.
- `git worktree list --porcelain` reports the primary checkout and the relocated deployment checkout with their original branches and HEAD commits.
- `git status --short` is empty in both existing worktrees after the organization commit is accounted for.
- No release payload file is missing, added, or changed according to the pre/post SHA-256 inventories.
- All nine old attempt manifests and journals remain byte-identical.
- The local catalog classifies every old attempt and marks it non-resumable.
- The tracked release index contains no credential-like material and passes JSON parsing and schema checks.
- `.worktrees/` and `.release-evidence/` are ignored by Git, while `ops/release-index.json` remains tracked.
- `git worktree prune -n -v` reports no stale entry; the real prune command is not run automatically.
- No GCP or Azure resource mutation occurs during the migration.

## Rejected Alternatives

Keeping the current active release directory at the top level is operationally safest for that one attempt but fails the one-directory requirement and perpetuates the layout problem.

Leaving hidden directory junctions at the old paths appears visually cleaner but still leaves multiple top-level HK Buddy entries and conflicts with the release controller's no-symlink path checks.

Converting `HK_Buddy` into a bare repository container with every checkout below it would satisfy the visual hierarchy, but it would unnecessarily relocate the primary checkout, disrupt saved project integrations, and increase recovery risk. Keeping the primary checkout at the root is simpler and fully supports linked worktrees.
