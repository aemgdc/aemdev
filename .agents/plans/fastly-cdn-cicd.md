# Plan / WIP: Fastly CDN config in Git → CI/CD

**Status:** Phase 1 shipped (read-only sync). Phase 2 (Terraform push) not started.
**Last updated:** 2026-06-28
**Owner context:** This repo (`aemgdc/aemdev`) manages the Helix/EDS site `www.aemdev.org`,
whose CDN is Fastly (VCL service, id `tTSyFJgoN3lZqBOA0n3Rd7`).

If you are a fresh Claude context picking this up: read this whole file first, then the
files it references. Everything needed to continue is committed to the repo.

---

## Goal

Version the Fastly CDN configuration in Git and grow it into real CI/CD, so CDN changes
are reviewed and deployed like code instead of clicked in the Fastly UI.

Roadmap:
1. **Phase 1 — Sync down (DONE).** Pull live Fastly config into Git so drift is visible.
2. **Phase 2 — Push out via Terraform (NEXT).** Manage Fastly with the Terraform provider
   so versions/activation/rollback are code-driven and reviewable in PRs.
3. **Phase 3 — Full CI/CD.** PR plan on every change, apply/activate on merge, with a
   staging/canary path before production activation.

---

## Phase 1 — DONE (read-only sync)

Mirrors the repo's existing pattern (small dependency-free `.mjs` scripts in `scripts/`
driven by `workflow_dispatch` workflows that commit results back, e.g. `sync-site-json`).

- **Script:** [`scripts/sync-fastly.mjs`](../../scripts/sync-fastly.mjs)
  - Auth: `Fastly-Key` header, **read** scope is enough. Never writes to Fastly.
  - Resolves the active service version (falls back to latest if none active).
  - Writes a git-friendly snapshot to `config/fastly/<service-slug>/`:
    `generated.vcl`, `vcl/*.vcl` (custom VCL), `objects/*.json` (domains, backends,
    headers, conditions, cache_settings, snippets, ACLs, dictionaries, gzip,
    healthchecks, request/response settings), plus `service.json` / `version.json` /
    `settings.json`.
  - Strips volatile fields (`version`, timestamps) by default so diffs show real changes.
    Set `FASTLY_KEEP_METADATA=true` to keep raw payloads.
  - Env: `FASTLY_API_TOKEN` (required), `FASTLY_SERVICE_ID` (required),
    optional `OUTPUT_DIR`, `FASTLY_KEEP_METADATA`.
- **Workflow:** [`.github/workflows/sync-fastly-config.yaml`](../../.github/workflows/sync-fastly-config.yaml)
  - `workflow_dispatch` (optional `service_id` input override) **and** a daily
    `schedule` (`17 6 * * *` UTC) so UI drift lands as a commit.
  - `environment: main`; commits drift as `github-actions[bot]`.
- **Secrets/vars (already set in the repo, `main` environment):**
  - `FASTLY_API_TOKEN` — secret.
  - `FASTLY_SERVICE_ID` — stored as a **secret** (not a repo variable). The workflow
    reads `secrets.FASTLY_SERVICE_ID`; the `service_id` input overrides it.
- **Current snapshot:** [`config/fastly/www-aemdev-org/`](../../config/fastly/www-aemdev-org/)
  (service `www.aemdev.org`, active version 5 at time of writing).

### Key decisions made in Phase 1
- Chose the raw Fastly REST API over the Fastly CLI to match the repo's zero-dependency
  `.mjs` convention.
- Terraform was deliberately deferred to Phase 2 — sync-down is the baseline it builds on.
- Volatile-field stripping keeps daily snapshot commits meaningful.

---

## Phase 2 — NEXT: Terraform push (when ready, prompt from this plan)

**Intent:** Manage the Fastly service declaratively with the
[`fastly/fastly` Terraform provider](https://registry.terraform.io/providers/fastly/fastly/latest/docs)
so changes are proposed in PRs (`terraform plan`) and activated on merge (`terraform apply`).

### Suggested prompt to start Phase 2
> "Implement Phase 2 of `.agents/plans/fastly-cdn-cicd.md`: stand up the Fastly Terraform
>  provider for service `www.aemdev.org`, import the current live config, and wire
>  plan-on-PR / apply-on-merge GitHub Actions."

### Approach / steps to flesh out
1. **Decide layout:** `terraform/fastly/` with `main.tf`, `variables.tf`, `versions.tf`,
   and a remote state backend (decision needed — see open questions).
2. **Provider + resource:** `fastly_service_vcl` resource modeling domains, backends,
   conditions, headers, snippets, dictionaries, ACLs, gzip, cache/request/response
   settings — the same object set Phase 1 already dumps under `config/fastly/.../objects/`.
   Use those JSON files as the source of truth when authoring the HCL.
3. **Import existing state:** `terraform import fastly_service_vcl.this <service_id>` (or
   `import {}` blocks) so Terraform adopts the live service instead of recreating it.
   Run `terraform plan` until it shows **no changes** vs. the live config — that proves
   the HCL faithfully represents production before anything is applied.
4. **CI:** GitHub Actions — `terraform fmt -check` + `validate` + `plan` (posted to the PR)
   on pull requests; `terraform apply` on merge to `main`. Reuse `environment: main` and
   the existing `FASTLY_API_TOKEN` secret (apply needs a token with **write** scope —
   the Phase 1 read-only token is NOT sufficient).
5. **Activation strategy:** the provider activates new versions on apply. Consider
   `activate = false` + manual promotion, or a staging service, for a safe rollout.
6. **Reconcile with Phase 1:** keep `sync-fastly.mjs` running as drift detection. Once
   Terraform owns the service, out-of-band UI edits should surface as `terraform plan`
   diffs; decide whether to keep committing the JSON snapshot too (recommended — it's a
   readable, provider-agnostic audit trail).

### Open questions to resolve at Phase 2 kickoff
- **Remote state backend?** (S3+DynamoDB, Terraform Cloud, GCS, etc.) Needed before any
  team/multi-account `apply`. Local state is fine only for a first spike.
- **Write-scoped token:** mint a separate Fastly token with write/purge scope for apply;
  keep the read-only token for the Phase 1 sync job.
- **Staging/canary:** is there (or should there be) a separate Fastly service to test
  against before production activation?
- **Secrets/origins:** the `dam-display` block backend work (see Claude memory
  `dam-servlet-backend`) may add configurable AEMaaCS origins — coordinate if those end
  up as Fastly backends/dictionaries.

---

## Quick reference

- Run sync now: GitHub → Actions → "Sync Fastly CDN config" → Run workflow.
- Service: `www.aemdev.org`, id `tTSyFJgoN3lZqBOA0n3Rd7`, type `vcl`.
- The committed snapshot under `config/fastly/` is the authoritative reference for what
  the live config currently looks like — diff against it before/after any change.
