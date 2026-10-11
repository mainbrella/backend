# Backend release runbook

The coordinated release order is **migrations/secrets → account, routing, and service preflights → containers
→ gateway → admin and marketing → API → qualification → web**. `npm run deploy` enforces the preflights and Worker
order and stops on the first failed command. It does not apply migrations, change
secrets, publish web, or run paid verification. Direct `deploy:api`,
`deploy:previews`, and `deploy:containers` commands remain operator tools and
bypass the combined gate.

## Independent admin and marketing releases

This repository contains three independently deployed application Workers:
`mainbrella-api` (`worker/index.ts`, `wrangler.jsonc`),
`mainbrella-admin` (`worker/admin.ts`, `wrangler.admin.jsonc`), and
`mainbrella-marketing` (`worker/marketing.ts`, `wrangler.marketing.jsonc`).
Containers and the preview gateway retain their existing independent configurations.

The public API forwards `/admin/*` and `/api/get-marketing-users` to `ADMIN_API`,
and `/api/send-marketing-email` and `/api/unsubscribe` to `MARKETING_API`.
Public URLs, host-only browser session cookies, authentication policy, and API
contracts remain the same. Both services validate requests and authentication
themselves. Their Workers have no public routes, workers.dev URL, or preview URL.
The API continues serving the complete OpenAPI document, including service endpoints.

Admin owns user/table browsing, acquisition reports, accounting reports/closes,
storage invoice reconciliation, and marketing recipient lists. It binds to the
existing API `ContainerAccount` namespace for billing history and accounting
checkpoints; it does not create or migrate a Durable Object namespace. Marketing
owns the sender, HTML template, and public unsubscribe handler. Welcome and
authentication emails stay with the API. Both services share the existing `delta`
database. Only `wrangler.jsonc` owns migration execution: use
`npm run db:migrate:remote`. Keep schema changes compatible with independently
deployed versions; migration state is not reverted by a Worker rollback.

For a template or marketing implementation change, run:

```sh
npm run test:marketing
npm run type-check
npm run check:marketing
npm run deploy:marketing
```

For an admin implementation change, use the corresponding `test:admin`,
`check:admin`, and `deploy:admin` commands, plus `type-check`.
These deploy commands run only the selected service's preflight and publication;
they do not acquire an image lease or republish containers, previews, or the API.
The preflight validates private routing, shared bindings/configuration, the remote
migration ledger, and (for admin) Stripe secret metadata. It performs no database
writes, email sends, or workload starts. The checks use Wrangler dry runs.

CI selects service checks for files owned exclusively by admin or marketing.
Shared authentication, schemas, migration files, configuration/tooling, and unknown
paths run the full checks. The existing `test` status aggregates whichever checks
were selected. An endpoint contract change also requires publishing the API's
updated OpenAPI document. CI validates changes; publication remains an explicit
operator action.

### First rollout

1. Apply account migrations through the API configuration.
2. Configure `STRIPE_SECRET_KEY` on the admin Worker from the established secure
   secret source:
   `npx wrangler secret put STRIPE_SECRET_KEY --config wrangler.admin.jsonc`.
   On the first rollout, confirm creation of `mainbrella-admin` when prompted.
   This creates the Worker and provisions its secret before `deploy:admin` checks
   secret metadata. A missing Worker or secret blocks the preflight; provision it
   with the command above and rerun `npm run deploy:admin`.
   Secrets on the existing API are not inherited by a new Worker. Admin accounting
   closes need the same Stripe account to refresh payment evidence. Marketing
   requires its configured Email Sending binding and the already onboarded sender domains.
3. Run the scoped tests, type check, and both dry runs. Publish admin and marketing
   before publishing the API with its new service bindings. For the full coordinated
   release, `npm run deploy` enforces that order. An API-only rollout can follow
   `npm run deploy:admin`, `npm run deploy:marketing`, then `npm run deploy:api`
   after the applicable release checks; retain the full release for runtime changes.
4. Check admin access with an existing session and exercise unsubscribe with a
   dedicated test recipient. Sending a real email is a separate operator check.

After the first rollout, unchanged API bindings continue pointing at each service's
current deployment. Inspect logs with `wrangler tail --config wrangler.admin.jsonc`
or `wrangler tail --config wrangler.marketing.jsonc`. Roll back only the affected
service using `wrangler rollback --config <service-config>` when its predecessor
is compatible with the current shared schema and account service.

`npm run dev` starts API, containers, admin, and marketing together with local
service bindings and the shared local database; migrations still run once through
the API configuration. Local Email Sending simulates delivery.

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
using schema metadata reads. Normal deployment runs account, routing, and service preflights before
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

Run `npm run deploy:preflight` and `npm run services:preflight`. The account
preflight reads the production API capability contract,
remote migration ledger/table names, and Worker secret metadata. It authenticates
a GET to the deployment-lock endpoint, expecting its method rejection. It never
acquires a lease, reads the build manifest (which can expire build records),
starts containers, or writes status observations. Unreachable, malformed or
unsupported responses block the release. All Workers are pinned to the same
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
assembled immutable map. Gateway publication follows container success, admin
and marketing publication follow gateway success, and API publication follows
both service publications.
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

This runs preflights, deploys the current containers without `ACCOUNT_ACTIVITY`,
publishes admin and marketing, deploys the API to provision its export, then redeploys containers with the binding
restored. It preserves the required runtime-before-API order, image validation,
authoritative image map and deployment leases, then publishes the gateway.
Account, routing, and service preflights run before publication. The tracked container config is unchanged.
Container activity notifications are skipped during the intermediate stage;
changes during that interval are not replayed. Finish all six publications
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
