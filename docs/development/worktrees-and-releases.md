# Worktrees and releases

This guide is the operating contract for local parallel development and release evidence.

## Canonical locations

```text
Primary checkout: D:\VS_Project\HK_Buddy
Long-lived deployment worktree: D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1
Temporary worktrees: D:\VS_Project\HK_Buddy\.worktrees\<branch-slug>
Release attempt root: D:\VS_Project\HK_Buddy\.release-evidence\attempts\<full-release-sha>\<acceptance-run-id>
Production tag format: prod/v1/YYYY.MM.DD.N
```

The primary checkout remains at the repository root. `.worktrees/` contains linked Git
checkouts; `.release-evidence/` is a local, append-only evidence cache.

## Worktree operations

Inspect all registered worktrees and their branch/HEAD metadata:

```powershell
git worktree list --porcelain
```

Before adding, moving, or removing a worktree, require a clean status in the relevant
checkout:

```powershell
git -C D:\VS_Project\HK_Buddy status --short
git -C D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1 status --short
```

One branch may be checked out in only one worktree. Verify branch uniqueness with
`git worktree list --porcelain` before adding another checkout. Add a temporary worktree
only at its final path:

```powershell
git worktree add D:\VS_Project\HK_Buddy\.worktrees\<branch-slug> <branch>
```

Move the registered deployment worktree with Git, never Explorer or a raw filesystem
move, so both its `.git` file and Git's common metadata remain valid:

```powershell
git worktree move D:\VS_Project\HK_Buddy-deploy D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1
```

Before any move, resolve both source and destination to absolute paths and verify that
the destination remains under `D:\VS_Project\HK_Buddy`; stop if the check fails. Do not
use an unresolved variable, wildcard, or path outside this repository as the move target.

Remove a worktree only after confirming its status is clean and its branch is integrated
or deliberately retained:

```powershell
git worktree remove D:\VS_Project\HK_Buddy\.worktrees\<branch-slug>
```

No branch or tag push is implicit in any of these local operations. Pushes are explicit,
separate actions.

## Release-attempt paths and evidence

Create each release directory at its final path before creating a source archive,
manifest, or any other release payload:

```text
D:\VS_Project\HK_Buddy\.release-evidence\attempts\<full-release-sha>\<acceptance-run-id>
```

The directory is never moved or renamed while active. Repeated attempts for one commit
must use distinct acceptance run IDs. Archived attempts retain their final paths and are
inventoried outside the attempt payload.

Existing, abandoned, failed, candidate-only, and other archived attempts are
non-resumable. Any retry must use a new acceptance run ID and a new attempt directory at
the corresponding final path; never reopen or overwrite the archived attempt directory.

`.release-evidence` is a local cache, not the authority for deployment state. SHA-256
inventories detect later drift in cached evidence; GCP Artifact Registry, Cloud Storage,
Secret Manager, Cloud Build provenance, and Cloud Run readbacks remain the authoritative
evidence system.

## Production tags

Only a verified public stable Cloud Run release, after end-to-end acceptance passes,
receives an annotated production tag in this format:

```text
prod/v1/YYYY.MM.DD.N
```

The annotation must contain the GCP project, Cloud Run revision, image digest, release
SHA, acceptance run ID, and release-index record hash. Failed, abandoned, candidate-only,
and unpromoted attempts receive no production tag. After promotion, update the tracked
`ops/release-index.json`, create the annotated tag, verify that its target equals the
deployed release SHA, and record the exact public Cloud Run URL and image digest.

## Canonical release-index record hash

Finalize every release-index record field before hashing, including setting the
`productionTag` value before either the hash or annotated tag is created. Build a new
object whose keys are exactly and in this order:

```text
releaseSha
acceptanceRunId
disposition
resumable
localArchiveRelativePath
inventorySha256
imageDigest
productionTag
publicUrl
```

Serialize that object as compact JSON with Node.js `JSON.stringify` semantics, encode
the result as UTF-8 with no BOM and no trailing newline, and compute SHA-256 as lowercase
hexadecimal. The hash is external to the release-index record: do not add it as another
record field. Record the resulting hash in the annotated production tag only after all
fields, including `productionTag`, have been finalized.
