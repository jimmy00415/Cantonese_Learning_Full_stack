# Hong Kong Buddy Production V1 Shared-Project Isolation Design

## Status and authority

- Date: 2026-08-26.
- Approved by the product owner: host Production V1 in an already billed GCP
  project rather than wait for the billing-project quota increase.
- Selected host project: `motion-expert-hk-ltd-webpage`, project number
  `582852715831`, organization `797368190621`, billing account
  `01F9FD-24EA9B-A9232C`.
- Code boundary: only the isolated worktree and `production-v1/` release are in
  scope. The legacy `frontend/`, `backend/`, `backend/public/`, Azure runtime,
  and every existing GCP resource remain untouched.
- This document replaces only the project and resource identity sections of
  `2026-08-26-production-v1-gcp-launch-design.md`. Its product, provider,
  privacy, evidence, SLO, promotion, and rollback requirements remain binding.

## Decision evidence

A read-only inventory of all six projects linked to the open billing account
found:

- `mthinker`, `motionexpert-adver`, `motionexp-website-1`, and
  `motionexpaiweb` have active public or data workloads;
- `tech-demo-433408` retains a terminated VM, reserved addresses, and historical
  build/network artifacts;
- `motion-expert-hk-ltd-webpage` is active and billed but has no visible VM,
  Cloud Run service, Cloud SQL instance, storage bucket, load balancer, address,
  DNS zone, domain registration, App Engine application, Firestore API, or
  private-service peering. Its project IAM contains one human owner and only
  Google-managed/default identities.

Disabled APIs make it impossible to prove the absence of every historical
service object through each service-specific list operation. The selected
project nevertheless has no surrounding service-agent, network, storage, or
runtime footprint for the Production V1 services, so it has the smallest
observed conflict and blast-radius risk among the billed projects.

## Considered approaches

### Selected: a namespaced resource island in the idle billed project

Keep the existing project and billing link, but create a fully named and
least-privileged `hkbuddy-v1-*` resource island. This removes the immediate
billing-project quota blocker without mixing identities, networks, data, or
release controls with an active product.

Trade-off: billing, project API enablement, quota, audit logs, and the project
IAM boundary are shared. This is strong logical isolation, not project-level
isolation.

### Rejected: reuse `tech-demo-433408`

This would also avoid the billing quota, but the project retains historical VM,
IP, Cloud Functions, Artifact Registry, and default-network state in the same
Hong Kong region. It creates more collision and operational ambiguity.

### Deferred: wait for a seventh billed project

A new dedicated project is still the cleanest long-term isolation boundary, but
the billing account currently rejects a seventh link. Production V1 must not be
blocked on a manual quota review. A later project migration is a separate,
planned release and cannot silently change the V1 authority.

## Exact resource island

The migrated fail-closed resource contract uses:

- project: `motion-expert-hk-ltd-webpage` (`582852715831`);
- Artifact Registry: `hkbuddy-v1` in `asia-east2`;
- Cloud Run services: public stable `hkbuddy-v1-api` and private acceptance
  scratch service `hkbuddy-v1-api-candidate`, both in `asia-east2`;
- Cloud SQL: `hkbuddy-v1-pg`, PostgreSQL 16, database `hkbuddy_v1`;
- media bucket: `hkbuddy-v1-582852715831-media` in `asia-east2`;
- Cloud Build source bucket: `hkbuddy-v1-582852715831-build-source` in
  `asia-east2`, private with UBLA and PAP enforced, no versioning or soft
  delete, and a one-day delete lifecycle;
- custom VPC: `hkbuddy-v1-vpc`;
- direct-VPC subnet: `hkbuddy-v1-ae2-run`, `10.24.0.0/26`;
- private-services range: `hkbuddy-v1-google-services`, `10.25.0.0/16`;
- service accounts: `hkbuddy-v1-runtime`, `hkbuddy-v1-build`,
  `hkbuddy-v1-migrator`, `hkbuddy-v1-deployer`, and
  `hkbuddy-v1-acceptance`;
- secrets, jobs, monitoring policies, release evidence, and budget display
  names: exact `hkbuddy-v1-*` identities defined by the executable contract.

The default VPC and its automatically created subnets are read-only inventory.
Provisioning must not attach to, alter, peer, or delete them. The dedicated VPC
uses Direct VPC egress and its own Private Service Access connection. Runtime
and build identities receive no user-managed service-account keys and never use
the default Compute service account.

## Shared-project safety contract

### Cloud Asset disabled-service inventory amendment

The host's disabled Cloud Asset API is not a reason to skip its pre-mutation
inventory. The immutable contract names `tech-demo-433408` as a read-only
Cloud Asset quota consumer. The sole cross-project exception is the exhaustive,
auto-paginated
host request `asset search-all-resources --scope=projects/motion-expert-hk-ltd-webpage
--billing-project=tech-demo-433408 --project=motion-expert-hk-ltd-webpage
--page-size=500 --read-mask=name,assetType,project,displayName,description,location,labels,parentFullResourceName,parentAssetType,state
--order-by=assetType,name --format=json`; it authorizes no consumer-project mutation. The
control plane runs it before API enablement, creates, REST POSTs, or IAM writes
and rejects unavailable, overflowed/truncated, malformed, wrong-project, foreign namespace, or
legacy executable-alias inventory.

Cloud Asset acceptance is type-specific: canonical full name, asset type,
numeric project authority, parent type/name, location, and metadata shape must
agree. Only release-compatible Cloud Run revisions named
`hkbuddy-v1-api-candidate-<12 lowercase hex>` beneath the exact private
candidate service and `hkbuddy-v1-api-<12 lowercase hex>` beneath the exact
stable service are accepted, together with Docker image digests for
`hkbuddy-v1-api@sha256:<64 lowercase hex>` beneath the exact `hkbuddy-v1`
repository.

Before the first write, the control plane must prove all of the following in one
fresh preflight:

1. The active principal is `admin@motionexp.com` and the selected project is in
   the expected organization with billing enabled.
2. Every managed resource identity begins with the approved `hkbuddy-v1`
   namespace, except the fixed database/user names whose scope is the dedicated
   Cloud SQL instance.
3. The proposed subnet and private-service CIDRs do not overlap any project
   subnet, route, supported INTERNAL `RESERVED`/`IN_USE` address family, or
   peering range. Every INTERNAL Address binds an exact host-project,
   name-matching Address `selfLink`, global/regional scope, matching region, and
   same-region subnetwork where selected. Complete ordinary IPv4/IPv6 EXTERNAL
   rows and regional `NAT_AUTO` are shape-validated before exclusion from IPv4
   overlap math; regional IPv6 endpoint/range fields are bounded to prefix 96,
   `VM`/`NETLB`, and a same-region subnetwork. Transient, incomplete, foreign,
   unsupported, noncanonical, or contradictory address shapes fail closed.
4. No existing project-level IAM binding, default-network object, DNS resource,
   domain, BigQuery dataset, or unrelated resource is a mutation target.
5. Existing resources with a managed identity must match the complete expected
   shape; partial or foreign ownership is drift and stops the run.
6. Provisioning is create-or-exact-readback. It never adopts, renames, repairs,
   deletes, or broadens an unrelated resource.

The CLI confirmation changes to
`--confirm-project=motion-expert-hk-ltd-webpage`. The old unbilled target
`hkbuddy-prod-v1-20260826` and all other projects are explicitly forbidden as
mutation targets.

## Migration and test design

The identity migration is a contract change, not a textual replacement:

1. Add failing tests for the selected project, project number, resource prefix,
   bucket, service account, Cloud Run host/tag, network, SQL, build image, IAM,
   monitoring, evidence, and exact-confirmation identities.
2. Add shared-project safety tests proving default/unrelated resources are
   inventory only and that any foreign mutation target fails before a write.
3. Update the executable resource contract and centralize exact identities so
   runtime, providers, provisioning, release, acceptance, Cloud Build, examples,
   and documentation cannot drift.
4. Run focused tests, the full suite, static checks, dependency-security gate,
   diff checks, and two independent reviews before GCP mutation.
5. Run a fresh read-only preflight against the selected project. Only its exact
   passing receipt authorizes provisioning.

## Deployment and acceptance boundary

Provision APIs and the resource island in dependency order. Build from the
frozen clean commit through exact staging directory
`gs://hkbuddy-v1-582852715831-build-source/source`; accept provenance only from
that bucket/prefix with the frozen source digest. Run the digest-pinned database
migration and deploy every candidate only to the separate
`hkbuddy-v1-api-candidate` service. Its revision is
`hkbuddy-v1-api-candidate-<12 lowercase hex>` at private 100% traffic with the
SHA tag on that service only. The untagged candidate-service root is the
in-memory ID-token audience and the tagged URL is the authenticated request
target. Exact candidate IAM contains only the reviewed private invoker and no
`allUsers` or `allAuthenticatedUsers`. Every candidate receipt records
the normalized `invokerIamDisabled=false` privacy invariant in its hashed
candidate contract. Controlled candidate and stable Service specs pin
`run.googleapis.com/invoker-iam-disabled` to exact lowercase string `false`.
Raw Cloud Run v1 live readbacks accept only annotation absence (the enabled
default) or a no-whitespace string case-folding exactly to `false`; malformed,
boolean, semantic-true, wrong apiVersion/kind, spec-only traffic, or drifted
readbacks fail before dependent candidate, promotion, cleanup, rollback,
response-loss, or compensation mutation. IAM policy alone is not privacy proof.
Every candidate receipt also records
`trafficState=candidate-service-private-100` plus the exact stable service and
whether stable is absent or retains its genuine prior revision at 100%. The
public `hkbuddy-v1-api` service is unchanged during candidate acceptance.

Promotion freshly revalidates the private candidate, immutable image/config,
complete receipt chain, Task 8 artifacts, and production traces before copying
the accepted image/config into stable. A later release preserves the genuine
prior stable revision at 100%, stages the accepted stable revision untagged at
0%, verifies exact image/config and absence of every stable tag, then atomically
switches the accepted stable revision to 100%; public stable IAM is exact
read-only state throughout. A first release creates stable privately at 100%,
verifies service/revision/image/config and private IAM, then makes
`allUsers:roles/run.invoker` the final mutation; only its IAM readback follows.
Ambiguous candidate work restores or removes only a receipt-proven private
candidate service. Later-promotion ambiguity restores the exact prior stable
100% state without changing public IAM; first-promotion ambiguity restores the
accepted stable service and exact private stable IAM.

Promotion requires the existing production acceptance contract: real Vertex
LLM, Cantonese/English/Mandarin ASR and TTS, governed HKBU answers and citations,
200-turn workload, latency SLOs, mobile 390x844 interaction, privacy/security
checks, immutable evidence, and verified rollback. Failure leaves the candidate
unpromoted and preserves every pre-existing resource.

The mandatory receipt order is build, migration, inventory, acceptance,
collection, evidence publication, candidate, readiness, controlled workload,
mobile acceptance, then promotion, with the release manifest refreshed at each
producer/consumer boundary. Candidate cleanup loads through the candidate
receipt, revalidates its service/revision/tag/image/private IAM, deletes only
`hkbuddy-v1-api-candidate`, and verifies candidate-specific canonical absence;
an exact candidate-specific already-absent precheck skips revision, artifact,
IAM, and delete operations but still repeats canonical absence readback before
reporting no mutation. Raw null output, generic 404, wrong identity, or ambiguous
transport is never absence evidence. Cleanup never changes stable traffic or
IAM. Later rollback loads the complete mobile
chain, revalidates the receipt-proven prior stable revision/image/service, and
mutates only `hkbuddy-v1-api` traffic. It does not depend on the candidate
service still existing. First-release rollback is unavailable and performs no
control-plane call because no genuine prior V1 exists.

## Stage D local acceptance closure (2026-08-28)

The isolation contract applies to the evidence filesystem as well as the shared
cloud project. Candidate privacy is the final candidate operation: its receipt
hashes all seven reference fields, while a separate authority anchor is rebuilt
from the journaled publication and terminal candidate-receipt digest and checked
before dependent work. Candidate privacy, readiness, the privacy-start/privacy-end/
workload three-file bundle, and all seven mobile artifacts are journaled before
create-only publication. Restart can adopt only exact intended bytes, complete
the missing suffix, and append a missing terminal record. Exact length and
bounded descriptor reads plus parent/path/file identity checks reject foreign,
oversized, replaced, linked/junction, mixed, wrong-attempt, and receipt-drifted
state without overwrite. Publication rechecks the durable temp inode and parent
around the hard link. These portable checks assume a trusted operator-owned
local directory; they do not claim a native no-TOCTOU guarantee against a
malicious same-user process because Windows Node has no handle-relative `openat`.

Historical proof-at-gate validity is distinct from current freshness. Workload
start and end proofs are checked at their respective recorded gate clocks even
when the valid workload lasts longer than five minutes. Fresh wrappers reject
`current >= expiresAt`. After stable staging, promotion appends a fresh,
attempt-bound proof, validates it with the current post-proof clock, and rereads
the complete receipt/evidence chain plus candidate/stable service, revision,
image/config, traffic, IAM, and authority state. Its final intent binds the
canonical digest of that barrier. Expired pre-intent proofs are retained and
followed by a new proof; an expired unperformed final intent requires an exact
before-state abort before re-proof. Mixed/ambiguous state blocks, and no later
cloud mutation is allowed after the terminal promotion mutation.

The mobile phase rejects prebuilt evidence and binds fresh privacy boundaries,
before/after candidate and stable readbacks, and the real local Production V1
shell/API/EventSource flow. Node derives a private per-run cryptographically
watermarked WAV, verifies Chromium's actual command line, captures the real
upload bytes, and validates the challenge correlation. Explicit playback is
browser-owned evidence from isolated CDP and native media/Media/WebAudio
observations, not a page token or lifecycle boolean. Node also binds transcript/
draft IDs, supported/unsupported message identities, manual text-answer audio
generation and its durable retry only after opt-in, retry/reload, every-page
downloads, and all UI checks. Untouched text answers remain excluded from
startup and interval recovery. Local evidence pins Playwright `1.62.1`, Chromium revision `1234` /
`151.0.7922.34`, `390x844` DPR 1, four fully opaque raw-and-pixel-unique PNGs,
and WAV SHA-256
`ef989be190f7e9cef40b80516209d972eb08910263ddee3a44f52fdf84e534a7`.
This remains controlled mobile-web evidence, not real-iOS, live-GCP, provider,
promotion, public-IAM, or runtime acceptance.
