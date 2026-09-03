# HK Buddy Workspace And Release Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate every HK Buddy-owned top-level directory under `D:\VS_Project\HK_Buddy` while preserving Git worktree integrity and byte-verifiable release-attempt evidence.

**Architecture:** Keep the primary checkout at the repository root, relocate the deployment branch with native Git into `/.worktrees/gcp-production-v1`, and archive every historical release attempt below `/.release-evidence/attempts/<release-sha>/<acceptance-run-id>`. Store ignored byte-level inventories locally and commit only non-secret release summaries plus the operating policy.

**Tech Stack:** Git 2.55, PowerShell 7, SHA-256, JSON, Node.js 22 for existing repository checks.

**Spec:** `docs/superpowers/specs/2026-09-02-workspace-release-layout-design.md`

## Global Constraints

- After migration, `D:\VS_Project` must contain exactly one directory whose name starts with `HK_Buddy`: `D:\VS_Project\HK_Buddy`.
- Preserve all nine existing release-attempt payloads byte-for-byte; do not edit their manifests or journals.
- Existing attempts become non-resumable historical archives because their absolute paths participate in release identity.
- Move `HK_Buddy-deploy` only with `git worktree move`; never use Explorer or raw `Move-Item` for that registered checkout.
- Resolve and validate every move target under `D:\VS_Project\HK_Buddy` before moving; use exact literal paths, no wildcard, overwrite, recursive delete, or cross-shell path handoff.
- Make no GCP or Azure mutation during workspace organization.
- Create no production tag because no release has been promoted.
- Do not push branches or tags.
- Use `apply_patch` for tracked file edits. Generated ignored inventory artifacts may be emitted by the approved migration script.

---

### Task 1: Version The Workspace And Release Policy

**Files:**
- Modify: `.gitignore`
- Create: `docs/development/worktrees-and-releases.md`

**Interfaces:**
- Consumes: the approved design specification and existing `.worktrees/` ignore behavior.
- Produces: anchored ignore rules and the exact operating contract used by Task 2 and future development.

- [ ] **Step 1: Anchor the local workspace ignore rules**

Use `apply_patch` to replace the current unanchored `.worktrees/` line and add the evidence cache:

```gitignore
/.worktrees/
/.release-evidence/
```

Keep every other existing ignore rule unchanged. Do not ignore `ops/`, `docs/`, generic `release-*` names, JSON, archives, or receipt files globally.

- [ ] **Step 2: Write the developer operating guide**

Create `docs/development/worktrees-and-releases.md` with these exact contracts:

```text
Primary checkout: D:\VS_Project\HK_Buddy
Long-lived deployment worktree: D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1
Temporary worktrees: D:\VS_Project\HK_Buddy\.worktrees\<branch-slug>
Release attempt root: D:\VS_Project\HK_Buddy\.release-evidence\attempts\<full-release-sha>\<acceptance-run-id>
Production tag format: prod/v1/YYYY.MM.DD.N
```

The guide must document:

1. `git worktree list --porcelain`, clean-status, branch uniqueness, add, move, and remove commands.
2. A release directory is created at its final path before source archive or manifest creation and is never moved while active.
3. Repeated attempts for one commit use distinct acceptance run IDs.
4. Only a verified public stable Cloud Run release receives an annotated production tag.
5. The tag annotation contains GCP project, Cloud Run revision, image digest, release SHA, acceptance run ID, and release-index record hash.
6. Failed, abandoned, candidate-only, and unpromoted attempts receive no production tag.
7. `.release-evidence` is a local cache whose SHA-256 inventories detect drift; GCP remains the authoritative evidence system.
8. No branch or tag push is implicit.

- [ ] **Step 3: Verify ignore behavior and documentation hygiene**

Run:

```powershell
git check-ignore -v .worktrees/probe
git check-ignore -v .release-evidence/probe
git check-ignore ops/release-index.json
rg -n "T[D]B|T[O]DO|implement[ ]later|fill[ ]in" docs/development/worktrees-and-releases.md
git diff --check
```

Expected results:

- the first two commands identify the anchored rules;
- `ops/release-index.json` is not ignored and `git check-ignore` returns exit code `1`;
- the placeholder scan returns exit code `1`;
- `git diff --check` returns exit code `0` apart from platform line-ending warnings.

- [ ] **Step 4: Run the existing repository baseline check**

Run:

```powershell
$env:Path='C:\Program Files\nodejs;'+$env:Path
npm run sync:frontend:check
```

Expected: `backend/public is in sync with frontend` and exit code `0`.

- [ ] **Step 5: Commit the policy**

```powershell
git add -- .gitignore docs/development/worktrees-and-releases.md
git commit -m "docs: standardize worktrees and release evidence"
```

### Task 2: Relocate And Catalogue Existing Attempts

**Files:**
- Create: `.release-evidence/catalog.json` (ignored generated artifact)
- Create: `.release-evidence/inventories/*.json` (ignored generated artifacts)
- Create: `ops/release-index.json`

**Interfaces:**
- Consumes: Task 1 paths and policy, the two clean registered worktrees, and the nine exact existing `HK_Buddy-release-*` directories.
- Produces: one relocated deployment worktree, nine byte-verified archives, a local detailed catalog, and a tracked non-secret release index.

- [ ] **Step 1: Record the immutable migration map**

Use this exact source-to-destination map:

| Source directory | Release SHA | Acceptance run ID | Disposition |
|---|---|---|---|
| `HK_Buddy-release-05726069` | `05726069d54a47600ef9b4344cd96a2c73f774e1` | `fec0902f-5017-40e0-8d2e-2828b35700c4` | `archived-uncertain` |
| `HK_Buddy-release-29fd22b3` | `29fd22b3dfe2b05283ec521484734097eb10d8cf` | `10d22770-d567-43f4-96c2-fe6ee051d31a` | `archived-uncertain` |
| `HK_Buddy-release-61f3ee29` | `61f3ee29e8daede6045c298fa8e52cb9e41734ed` | `8ca9ef54-cfc1-4de4-a2d0-1a371eac77cc` | `archived-terminal` |
| `HK_Buddy-release-6374b5a6` | `6374b5a6127931011a78f6c6b412955165338183` | `f42e88c4-d203-451f-8f67-569096645594` | `archived-terminal` |
| `HK_Buddy-release-6ceaaf5a` | `6ceaaf5a655c220dafec6e2402469b44725d11f9` | `c4f23c1e-15d8-4993-87d1-7fed3b94e109` | `archived-terminal` |
| `HK_Buddy-release-6e099ef2` | `6e099ef2ca595dbc8334161f78ad483735f2b325` | `bf7cf83e-15d3-48be-8022-0e82df96a073` | `archived-terminal` |
| `HK_Buddy-release-7c32f6d6` | `7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3` | `09657378-a601-4b24-be51-4cd5422f5b89` | `superseded-path-migration` |
| `HK_Buddy-release-8e58cc52` | `8e58cc52d37b32d3999ddc6872e79d98c93882b9` | `a78ed0e6-1790-41dc-b24e-c0afd3bba548` | `archived-uncertain` |
| `HK_Buddy-release-f5674e8` | `f5674e8e46b738f04d86b4baf428f85042f7a593` | `e5092c00-40aa-40d2-855b-9c4cf03b0237` | `archived-uncertain` |

Each destination is exactly:

```text
D:\VS_Project\HK_Buddy\.release-evidence\attempts\<release SHA>\<acceptance run ID>
```

- [ ] **Step 2: Perform the clean-state and path preflight**

Before creating the archive, use `apply_patch` to add the exact anchored line `/.release-evidence/` to `D:\VS_Project\HK_Buddy\.git\info\exclude` if it is absent. This common local exclude keeps the primary checkout clean until the reviewed `.gitignore` commit is integrated; leaving the redundant local rule after integration is harmless.

Run read-only checks from `D:\VS_Project\HK_Buddy`:

```powershell
git status --short
git -C 'D:\VS_Project\HK_Buddy-deploy' status --short
git worktree list --porcelain
Test-Path -LiteralPath 'D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1'
Get-ChildItem -LiteralPath 'D:\VS_Project' -Directory | Where-Object Name -Like 'HK_Buddy*' | Select-Object -ExpandProperty FullName
```

Both statuses must be empty, the deployment worktree must be registered at `D:/VS_Project/HK_Buddy-deploy`, the new deployment path must be absent, and the top-level list must contain exactly the primary checkout, deployment worktree, and nine mapped attempt directories.

Resolve each source and destination with `[System.IO.Path]::GetFullPath()`. Every destination must start with `D:\VS_Project\HK_Buddy\.release-evidence\attempts\` using an ordinal-ignore-case comparison, every source must have parent `D:\VS_Project`, and no destination may already exist. Stop before any move if one assertion fails.

- [ ] **Step 3: Generate pre-move payload inventories**

For every mapped source, enumerate ordinary files recursively with `Get-ChildItem -File -Recurse -Force`, sort by normalized relative path, and record these properties:

```json
{
  "relativePath": "release-manifest.json",
  "byteCount": 1,
  "sha256": "64 lowercase hexadecimal characters"
}
```

The real `byteCount` and `sha256` values come from `Length` and `Get-FileHash -Algorithm SHA256`. Reject any reparse point anywhere below a source. Store the nine pre-move inventories only in this plan's `.superpowers/sdd/2026-09-02-workspace-release-layout/` workspace. Do not write inside an attempt payload.

Compute `payloadSha256` as SHA-256 of UTF-8 without BOM over the compact JSON serialization of the sorted file-entry array. The inventory metadata is excluded from that digest.

- [ ] **Step 4: Move the registered Git worktree**

Create `D:\VS_Project\HK_Buddy\.worktrees` if it does not exist, then run:

```powershell
git -C 'D:\VS_Project\HK_Buddy' worktree move `
  'D:\VS_Project\HK_Buddy-deploy' `
  'D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1'
```

Do not add `--force` and do not run `git worktree prune`.

- [ ] **Step 5: Move the nine exact release directories**

In the same PowerShell process used for path validation, create each SHA parent and run `Move-Item -LiteralPath <validated source> -Destination <validated destination>` once per map entry. Do not use a wildcard, pipeline-generated command string, overwrite flag, `cmd.exe`, Bash, recursive delete, or fallback copy/delete.

If a move fails, stop. Move only already-moved entries back to their exact source paths in reverse order after verifying those source paths are absent and the destinations remain within the validated archive root.

- [ ] **Step 6: Verify byte identity and emit local inventories**

Recompute each inventory from the destination using the same algorithm. Require exact equality of the ordered relative paths, byte counts, per-file SHA-256 values, file count, total bytes, and `payloadSha256`.

After equality succeeds, write one pretty-printed UTF-8 JSON inventory to:

```text
.release-evidence/inventories/<release-sha>--<acceptance-run-id>.json
```

Each inventory has schema version `hkbuddy-release-attempt-inventory-v1`, original path, archived path, release SHA, acceptance run ID, disposition, `resumable: false`, UTC `createdAt`, counts, `payloadSha256`, and the sorted `files` array. Then write `.release-evidence/catalog.json` with schema version `hkbuddy-release-evidence-catalog-v1`, UTC `generatedAt`, and nine records containing the inventory file path and SHA-256 of the full inventory file.

Immediately after `resumable`, each inventory must contain an `observedJournalState` object derived from the lexically last file in its `*-receipts/state` directory. Its keys must be exactly and in this order: `lastRecordFile`, `recordType`, `phase`, `status`, `operationId`, `code`. Copy `lastRecordFile`, `recordType`, and `phase` from the selected record identity; for terminal records copy `status` from `payload.status`, `operationId` from `payload.terminalState.operationId`, and `code` from `payload.terminalState.code`, using `null` when a field is absent; for non-terminal records use the top-level `operationId` and set `status` and `code` to `null`. This metadata is outside `files` and must not change the payload file list or `payloadSha256`.

- [ ] **Step 7: Create the tracked non-secret release index**

Use `apply_patch` to create `ops/release-index.json` with schema version `hkbuddy-release-index-v1`, GCP project `motion-expert-hk-ltd-webpage`, project number `582852715831`, UTC `generatedAt`, and nine records sorted by release SHA. Each record contains:

```json
{
  "releaseSha": "the exact 40-character SHA from the migration map",
  "acceptanceRunId": "the exact UUID from the migration map",
  "disposition": "the exact disposition from the migration map",
  "resumable": false,
  "localArchiveRelativePath": ".release-evidence/attempts/<release SHA>/<acceptance run ID>",
  "inventorySha256": "the SHA-256 of the generated inventory file",
  "imageDigest": null,
  "productionTag": null,
  "publicUrl": null
}
```

For attempts whose manifests contain a non-null image digest, preserve that exact digest instead of `null`. Do not copy any other manifest field or evidence payload into the tracked index.

- [ ] **Step 8: Verify the final layout and contracts**

Run:

```powershell
git -C 'D:\VS_Project\HK_Buddy' worktree list --porcelain
git -C 'D:\VS_Project\HK_Buddy' status --short
git -C 'D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1' status --short
git -C 'D:\VS_Project\HK_Buddy\.worktrees\gcp-production-v1' rev-parse HEAD
git -C 'D:\VS_Project\HK_Buddy' worktree prune -n -v
Get-ChildItem -LiteralPath 'D:\VS_Project' -Directory | Where-Object Name -Like 'HK_Buddy*' | Select-Object -ExpandProperty FullName
git check-ignore -v .release-evidence/catalog.json
git check-ignore ops/release-index.json
$null=Get-Content -LiteralPath 'ops/release-index.json' -Raw | ConvertFrom-Json
rg -n "accessToken|access_token|client_secret|private_key|postgres(?:ql)?://|X-Goog-Signature" ops/release-index.json
git diff --check
```

Expected results:

- worktree metadata reports `D:/VS_Project/HK_Buddy/.worktrees/gcp-production-v1` on `ops/gcp-production-v1-deploy-20260901` at `7c32f6d6bc0fbc41c5a2a6381c520cfd033f10f3`;
- the deployment worktree status is empty;
- the primary checkout status is empty because the common local exclude protects the not-yet-integrated branch boundary;
- prune dry-run reports no stale entry;
- the top-level query returns only `D:\VS_Project\HK_Buddy`;
- the ignored catalog is ignored and tracked index is not ignored;
- JSON parsing succeeds and the credential scan returns no matches;
- all nine post-move inventories still match their pre-move copies.

- [ ] **Step 9: Commit the tracked release index**

```powershell
git add -- ops/release-index.json
git commit -m "chore: index archived release attempts"
```

Do not add `.release-evidence` or create a Git tag.

### Task 3: Final Branch And Workspace Verification

**Files:**
- Verify: `.gitignore`
- Verify: `docs/development/worktrees-and-releases.md`
- Verify: `docs/superpowers/specs/2026-09-02-workspace-release-layout-design.md`
- Verify: `ops/release-index.json`

**Interfaces:**
- Consumes: the two reviewed task commits and the completed filesystem migration.
- Produces: evidence that the organization branch is safe to integrate and that the temporary implementation worktree can be removed after integration.

- [ ] **Step 1: Run final repository checks**

```powershell
$env:Path='C:\Program Files\nodejs;'+$env:Path
npm run sync:frontend:check
git diff --check 8a162da6d093155e46b0f9e39ff6112eb45f2833..HEAD
git status --short
git log --oneline 8a162da6d093155e46b0f9e39ff6112eb45f2833..HEAD
```

Expected: frontend sync succeeds, diff check succeeds, the implementation worktree is clean, and the log contains the design, policy, and release-index commits.

- [ ] **Step 2: Re-run the external layout verification**

Repeat Task 2 Step 8 in a fresh PowerShell process and compare all nine archives to their inventory files again. This second pass is independent of the migration process.

- [ ] **Step 3: Preserve the migration audit before cleanup**

After the scoped re-review reports and SDD ledger are finalized, and immediately before removing `.worktrees/workspace-layout`, copy the complete `.superpowers/sdd/2026-09-02-workspace-release-layout` directory into `.release-evidence/migrations/2026-09-02-workspace-release-layout` without moving or deleting the source. Generate `.release-evidence/migration-inventories/2026-09-02-workspace-release-layout.json` outside the copied payload with schema `hkbuddy-workspace-migration-audit-v1`, source and target relative identities, UTC creation time, sorted per-file SHA-256 records and byte counts, total file count and bytes, and a payload SHA-256 computed from the compact UTF-8-without-BOM JSON serialization of the sorted file-entry array. Add and verify the corresponding `migrationAudits` catalog record and its full inventory SHA-256.

Make preservation refreshes repeatable and idempotent: on the first run create the absent target; on later runs validate both roots, reject reparse points and any target-only file instead of deleting it, copy every source file to its exact relative target with overwrite permitted only at that validated file path, and then regenerate the external inventory and catalog record. If the sorted file records are unchanged, retain the existing inventory `createdAt` and catalog `generatedAt` so a no-change refresh reproduces the same inventory, catalog link, and catalog bytes; if any record changes, use new UTC timestamps. This allows the final-fix report and later controller-generated re-review or ledger artifacts to be added by a later refresh without touching an archived release-attempt payload or a tracked file. Require exact source/copy file-list, byte-count, and digest equality, plus catalog/inventory linkage, after the final refresh; cleanup is prohibited if preservation verification fails or if the audit is older than the finalized scoped review artifacts.

If verification produces no other tracked changes, do not create an empty commit. Hand the clean branch to `superpowers:finishing-a-development-branch`; integration into `feat/production-v1-ai-senior` and removal of `.worktrees/workspace-layout` happen only after the final review and the verified audit preservation above.
