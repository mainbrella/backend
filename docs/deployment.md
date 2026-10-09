# Backend release runbook

The current order is **migrations/secrets → account and routing preflights → containers
→ gateway → API → qualification → web**. `npm run deploy` enforces the preflights and Worker
order and stops on the first failed command. It does not apply migrations, change
secrets, publish web, or run paid verification. Direct `deploy:api`,
`deploy:previews`, and `deploy:containers` commands remain operator tools and
bypass the combined gate.

## Prepare a release

Record the backend and web commits, current API and container deployment/version
IDs, published image digests, and the last qualified compatible pair. Retain the
previous checkout and its dependency lockfile. Account Durable Object data is
not rolled back with Worker code; older code must understand the persisted
reservation, generation, compute-budget and managed-execution state.

Run `npm ci`, `npm test`, `npm run test:openapi`, `npm run type-check`,
`npm run check:containers`, and `npm run docs:generate`. File-write tests must run
on Linux with GNU coreutils before release. Review the migration diff and back
up the target database according to the operator's established D1 procedure.

Apply `npm run db:migrate:remote`. The ledger must include every checked-in SQL
migration, including both files numbered 006, both numbered 007,
`010_api_keys.sql` and `011_operational_status.sql`. Do not use a highest-number
check as a substitute for matching migration filenames.

Apply `npm run db:migrate:previews:remote` to the separate routing database.
Project endpoints require `002_project_endpoints.sql` in addition to the existing
preview migration. The account migration command does not migrate this database.
`npm run previews:preflight` verifies routing tables, constraints, and indexes
using schema metadata reads. Normal deployment runs both preflights before
publishing any Worker.

Configure `MONITORING_SECRET` using `npx wrangler secret put MONITORING_SECRET
--config wrangler.jsonc`. Use a separately generated secret, distinct from
`IMAGE_BUILD_SECRET` and customer credentials. Keep the existing image-build
secret consistent in the deployed API, GitHub Actions, and deployment shell or
ignored backend `.env`. Preflight checks deployed secret names and validates the
local image secret against the lease endpoint. Cloudflare does not return secret
values, so the operator must establish that the deployed monitoring secret is
distinct and available to monitoring tools. No monitoring credential is sent to
the public capability endpoint.

Run `npm run deploy:preflight`. It reads the production API capability contract,
remote migration ledger/table names, and Worker secret metadata. It authenticates
a GET to the deployment-lock endpoint, expecting its method rejection. It never
acquires a lease, reads the build manifest (which can expire build records),
starts containers, or writes status observations. Unreachable, malformed or
unsupported responses block the release. Both Workers are pinned to the same
Cloudflare account in their configs.

The accepted predecessor is the known `2026-10-05` agent API with API keys,
generation-specific idempotent creation, managed execution and binary files.
This implementation already sends paid-entitlement headers. The version string
alone is insufficient because the pre-size and five-size APIs share it.
Capabilities describe API code, not private-runtime health. A passing preflight
does not qualify deployed runtime behavior, billing or login.

Run `npm run deploy:containers -- --dry-run` to validate the published terminal
and catalog hashes and the live custom-image map. This existing preparation
reads the build manifest and may expire overdue builds; it does not publish a
Worker or acquire the deployment lease. A missing or stale release manifest
requires the image workflow to publish a matching digest first.

## Deploy and qualify

Coordinate a release window and avoid new workload admission and custom-image
publication during a size/policy transition. An older API can continue sending
its previous allowances until API publication completes. The image deployment
lease serializes image-map deployments; it does not pause customer API traffic
or serialize the entire release.

Run `npm run deploy`. Container publication uses the existing authoritative image
map and 12-minute lease, with a 10-minute Wrangler timeout. Do not deploy the
tracked container config directly: it contains build recipes rather than the
assembled immutable map. Gateway publication follows container success, and API
publication follows gateway success.
Keep the current images and generations; publication does not upgrade running
guest images. Do not mass-stop customer containers as a deployment step.

Within an explicitly agreed start budget, run `npm run verify:agent` using a
dedicated provisioned account. Verify its own generation was cleaned up and
pre-existing containers were preserved. Qualify installed JS and Python SDK
artifacts separately before describing them as released. Optional
`npm run status:canary` requires an additional one-start budget; it is not part
of `deploy` and has no recurring schedule.

Check `/capabilities`, `/status` and `/status/history`, then observe the
five-minute collector producing fresh reachability/database evidence. These
reachability checks retry failures twice, after one and two seconds, before
recording an outage. API Worker configuration must retain
`global_fetch_strictly_public` so its public `/health` self-request reaches the
Worker rather than failing inside Cloudflare's same-zone routing. Deployments
do not create incidents; a sustained failed health check still records an outage.
These checks do not prove login, SSH, image builds or billing. Publish web integrations
and feature claims only after the appropriate live workflow passes.

Protected previews are enabled and production-qualified on `mainbrella.dev`.
They have a separate gateway configuration and routing database migration
directory. The default deploy command publishes the gateway before the API. Preserve
the enabled preview settings during unrelated API releases and follow
[preview-ingress.md](preview-ingress.md) for isolated
domain/TLS, routing bindings, runtime-before-gateway-before-enabled-API order,
partial cleanup and the bounded qualification run. The gateway must never receive
the account database or an account-site hostname.

## Unsupported predecessor / bootstrap

### Missing AccountActivity export (Cloudflare error 10061)

If container publication fails with `Cannot create binding for class
'AccountActivity' that is not exported by script 'mainbrella-api'`, the deployed
API has not yet introduced the activity Durable Object. The local API exports it,
but Cloudflare needs that export deployed before another Worker can bind to it.

For an accepted predecessor that passes compatibility preflight, run:

```sh
npm run deploy:bootstrap-activity
```

This runs preflight, deploys the current containers without `ACCOUNT_ACTIVITY`,
deploys the API to provision its export, then redeploys containers with the binding
restored. It preserves the required runtime-before-API order, image validation,
authoritative image map and deployment leases, then publishes the gateway.
Both account and routing preflights run before publication. The tracked config is unchanged.
Container activity notifications are skipped during the intermediate stage;
changes during that interval are not replayed. Finish all four publications
before qualifying activity streams or publishing web integrations.

The command stops on failure. If API publication fails, retry the bootstrap
command after correcting the failure. If only the final container publication
fails, run `npm run deploy:containers` to restore notifications, then
`npm run deploy:previews`. If only gateway publication fails, retry
`npm run deploy:previews`. Subsequent
releases use the normal `npm run deploy` command.

### Older API contracts

Do not reverse the current order to bypass a failed preflight. The original
paid-entitlement and image-manifest releases had API-first bootstrap requirements;
the current API also requires a managed-execution and size-aware runtime.

For a deployment predating the accepted agent contract, use a separately reviewed
staged upgrade through a compatible historical API/runtime pair. Inspect its
entitlement headers, live image manifest and deployment-lock handlers before
publishing; apply migrations and configure secrets first. Pin the historical
commit and review its deployment commands rather than assuming today's commands
work on it. Keep admission closed during incompatible intermediate stages.
Establish the accepted predecessor contract and rerun preflight before proceeding
with the current pair. This runbook does not claim an unattended bootstrap from
an arbitrary legacy deployment.

## Partial failure and rollback

- **Preflight or container deployment fails:** the combined command does not
  publish API. Confirm the actual container deployment version after an ambiguous
  timeout. The deploy script attempts lease release in `finally`; if the client
  died, wait for the recorded lease's expiry before retrying. Never delete another
  deployment's lease or replace the image map with an empty snapshot.
- **API publication fails after containers succeed:** keep admission closed and
  confirm the active API version. Prefer retrying the same API release after
  correcting the failure. The accepted predecessor supports entitlement/generation
  headers but the partial pair is not a qualified size-policy deployment.
- **Gateway publication fails:** the normal command stops before API publication.
  Correct the failure and rerun deployment so the API cannot advertise support
  before the updated gateway is published.
- **A published pair fails qualification:** hold web publication and restore a
  previously qualified compatible pair only after checking persisted-state
  compatibility. Restore the older API first to withdraw new feature admission,
  then the matching runtime. An older API that loses compute reservations or
  interprets the current Durable Object state incorrectly is not a rollback
  candidate; use a forward fix with admission closed instead.

For container rollback, use the previous compatible source with the **current
authoritative image map and deployment lease**. Do not blindly restore a saved
Wrangler container version: it can remove images created since that version.
Confirm its image-map tooling and published Dockerfile/catalog hashes still
match before publishing. Keep D1 migrations applied; do not drop status, API-key,
image or billing tables to undo code. Preserve generation and reservation state.
Runtime replacement can interrupt managed work, and filesystem destruction
cannot be undone by Worker rollback. Report affected generations explicitly.

After recovery, rerun the agreed qualification and check fresh status evidence
before opening admission or publishing web. Record the active version IDs,
failures, cleanup results and remaining unknown workflows in the release record.
