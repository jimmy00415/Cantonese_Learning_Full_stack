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
- Cloud Run service: `hkbuddy-v1-api` in `asia-east2`;
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
`hkbuddy-v1-api-<12 lowercase hex>` beneath the exact service and Docker image
digests for `hkbuddy-v1-api@sha256:<64 lowercase hex>` beneath the exact
`hkbuddy-v1` repository are accepted descendants.

Before the first write, the control plane must prove all of the following in one
fresh preflight:

1. The active principal is `admin@motionexp.com` and the selected project is in
   the expected organization with billing enabled.
2. Every managed resource identity begins with the approved `hkbuddy-v1`
   namespace, except the fixed database/user names whose scope is the dedicated
   Cloud SQL instance.
3. The proposed subnet and private-service CIDRs do not overlap any project
   subnet, route, supported internal `RESERVED` address family, or peering
   range; unsupported or incomplete internal-address shapes fail closed.
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
frozen clean commit, run the digest-pinned database migration, and deploy the
candidate with zero stable traffic. The public invoker binding and stable
traffic remain promotion actions, not provisioning shortcuts.

Promotion requires the existing production acceptance contract: real Vertex
LLM, Cantonese/English/Mandarin ASR and TTS, governed HKBU answers and citations,
200-turn workload, latency SLOs, mobile 390x844 interaction, privacy/security
checks, immutable evidence, and verified rollback. Failure leaves the candidate
unpromoted and preserves every pre-existing resource.
