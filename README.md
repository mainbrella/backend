# Mainbrella API

The session-authenticated `/containers` API resolves paid access from Stripe and
reserves starts in an account-owned `ContainerAccount` Durable Object. Each
container runs in its own private `UserContainer` in `mainbrella-containers`.
The original `user:<userId>` machine remains the `small` slot; additional slots
use `user:<userId>:slot:<number>`. Container creation and quota reservation remain
exclusive to `POST /containers`; client ownership, plan, resource and lease
headers are never forwarded.

The [preview ingress design and private runtime contract](docs/preview-ingress.md)
cover the runtime, gateway, account endpoints and SDK/dashboard integration.
Previews are enabled on `mainbrella.dev`; live transport, Next.js/browser,
development WebSocket/hot reload and account/generation isolation checks passed.

## Browser terminal

`GET /containers/terminal?id=<container id>&createdAt=<ISO generation>&cols=80&rows=24` requires
`Upgrade: websocket`, an explicit allowlisted browser Origin, and the existing
`mainbrella_session` cookie. `createdAt` is required and must exactly match the
current running container. Dimensions default to 80×24, must be integer strings,
and clamp to 1–500 columns / 1–200 rows. Unknown or duplicate parameters are
rejected. Client headers cannot override the account, image, resources, session
name, generation, or deadline.

The API checks paid access, reads the authenticated account's container list,
then forwards only Upgrade and trusted generation/expiration/dimension headers
to `GET https://internal/terminal`. Cookie and Authorization are not forwarded.
The DO rechecks the generation and persisted lease before `exec()` to reject
stop/recreate races. A stopped, stale, or expired container returns 409; terminal
capacity returns 429; service failures are sanitized as 503. No terminal request
calls `start()`, writes quota, or resets the hard expiration.

The private DO runs a PTY attached to the fixed tmux session `main`. The browser
uses binary UTF-8 stdin, raw binary stdout, JSON `{cols, rows}` resizing and
`{type:"ack"}` output acknowledgements. The DO sends `ready`, `exit` and sanitized
`error` control messages. Non-hibernating sockets retain the live process handle.
Disconnect terminates only the attached tmux client. The existing idle/hard
expiration alarm still destroys the container and closes terminal sockets.

Apply the database migrations, then run `npm run deploy` here to check compatibility
and deploy the container Worker before the API. Deploy `../web` afterward. The image is built in GitHub
Actions; local deployments require GitHub CLI authentication, not Docker.
Existing old-image containers need to be stopped and recreated. This path does
not need SSH tokens. The image deploy script reads `IMAGE_BUILD_SECRET`
from the shell or ignored backend `.env` for the live image manifest.
`/containers/ssh` accepts an explicit container ID; `007_ssh_container_id.sql`
binds tokens to that slot as well as its generation. The SSH gateway protocol is unchanged.

## Local development

Start a Docker-compatible engine (OrbStack, Docker Desktop, or Colima), then run:

```sh
npm ci
npm run dev
```

`npm run dev` starts the API and private container Worker together, with local
D1 and Durable Object storage in `.wrangler/state`. It applies pending local
migrations for both `delta` and `mainbrella-preview-routes` before startup. The
API is available at
`http://localhost:8787`; API docs are at `/docs`. Wrangler builds the Node image
from `containers/Dockerfile` and starts containers on demand. This requires
Wrangler 4.136.0 or newer. Press `r` in the dev terminal to rebuild the image.
`npm run dev:lan` exposes the same setup on your local network.

Local preview links use `http://<token>.localhost:8787/` and route through the
local API Worker to the container, including WebSockets. Open them on the Mac
running Wrangler. Reissue previews created before this setup to get local links.
If overriding the API port, pass `--port <port>`; the dev launcher carries that
port into local preview and project alias routing. The dev launcher uses temporary copies of the Worker configurations with
production routes removed and `LOCAL_DEV=true` on both Workers, preserving local
preview subdomains. Restart dev after changing a Worker configuration. Restarting
Wrangler stops local workloads; start a new container afterward and republish
any endpoint that was bound to the previous generation.

The launcher checks for leftover project proxies at startup, every 15 seconds,
and after Wrangler exits. During dev, a workload must have been stopped for at
least 30 seconds and have no matching Docker app container before its proxy is
removed. Cleanup preserves active workloads and unrelated Docker containers.
Shutdown also removes orphan proxies created during that dev session. If the
launcher is forcibly killed, the next dev startup cleans recorded stopped work.

OrbStack works through its `orbstack` Docker context. If Wrangler cannot find its
engine, select the context and set the socket explicitly before starting dev:

```sh
docker context use orbstack
export DOCKER_HOST="$(docker context inspect orbstack --format '{{.Endpoints.docker.Host}}')"
```

Local authentication and trial/subscription records are separate from production.
`npm run dev` includes only the Node image. Use `npm run dev:all` to enable
Node, Python, Rust, Go, and DevOps locally from their existing Dockerfiles.
Stop the current dev server before switching; Wrangler builds the images and
starts machines on demand. Additional Wrangler options can be passed through,
for example `npm run dev:all -- --ip 0.0.0.0`.

## Welcome emails

New email, Google, and Apple accounts receive a plain-text welcome email from
Andrew Arrow <andrew@mainbrella.com>. Existing sign-ins, provider linking,
anonymous accounts, and the app-review account do not send a welcome email.
The `WELCOME_EMAIL` Workers binding in `wrangler.jsonc` handles sending without
an API token and restricts the sender to `andrew@mainbrella.com`. Before deploying,
onboard `mainbrella.com` under Cloudflare Email Service → Email Sending.
Production sends run through `ctx.waitUntil`; failures are logged as
`welcome_email_failed` and do not prevent signup. Delivery is best effort with
no automatic retries. Local Wrangler development simulates sending.

## Verification

```sh
npm ci
npm run type-check
npm run check:containers
npm run test:plans  # Paid billing, account quotas, lifecycle, SSH and terminals
npm test           # Full suite, including legacy fixtures noted below
```

Retained admin/Apple-auth tests use an explicit test-only compatibility schema
in `worker/app/fixtures/legacy-compatibility.sql`. It is not a production migration
and does not enable native/community features on a fresh Mainbrella database.
CI runs the full runtime, API and SDK suites, OpenAPI checks, type checking,
JavaScript syntax checks and schema generation. Linux CI exercises file writes
with GNU coreutils; those write tests skip explicitly when it is unavailable locally.

## Production deployment

All production backend code lives here. `containers/` contains the private
container Worker, lifecycle controller, terminal bridge, Dockerfile, and tests.
`wrangler.containers.jsonc` deploys `mainbrella-containers`; `wrangler.jsonc`
deploys `mainbrella-api`. The API retains the original cross-Worker `USER_CONTAINER` binding and adds a
SQLite `CONTAINER_ACCOUNT` binding/export for atomic per-account reservations. `../reference` is
benchmark and historical material only; production builds do not read it.

```sh
npm run deploy:preflight   # Read deployment compatibility metadata; no starts
npm run deploy             # Preflight, containers, then API; stops on failure
npm run deploy:containers  # Container Worker with the CI-published image
npm run deploy:api         # API only
npm run deploy:bootstrap-activity # One-time recovery for missing AccountActivity export (10061)
```

Apply migrations before deploying the API, including 006 (billing webhook
receipts and billing operation leases) and 007 (SSH container IDs). Configure the existing
`STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`, and add `STRIPE_WEBHOOK_SECRET`.
Register `https://api.mainbrella.com/subscription/webhook` in Stripe for checkout,
subscription, schedule, invoice and payment/refund changes as described below.
Keep webhook signing secrets in Wrangler secrets; never commit them.

For the current release, deploy containers before API, then web. The preflight
requires an entitlement-aware, generation-specific predecessor API, the complete
migration ledger (including `011_operational_status.sql`), and configured
`IMAGE_BUILD_SECRET` and separate `MONITORING_SECRET`. It checks the authenticated
image lease endpoint without acquiring a lock. The deployment script continues
to validate the shared image map and acquire its lease before publication.

The original paid-entitlement rollout required API first because its predecessor
did not send entitlement headers. That historical sequence is not safe for the
current release. If preflight rejects an older API, stop and use the staged
bootstrap guidance in [deployment.md](docs/deployment.md). That runbook also
covers release evidence, partial failures and rollback.

The container image includes Node 24, bash, and tmux, with outbound internet enabled.
Deploying an image does not replace running containers; stop and recreate old
containers to use the updated image.

Developer SSH keys are configured in `wrangler.containers.jsonc`. Connect with
`npx wrangler containers ssh <INSTANCE_ID> --config wrangler.containers.jsonc`.
Private keys stay local. Status polling and SSH attachment do not renew the idle
lease; terminal input/output does.

## Terminal image publishing

The **Build terminal image** GitHub Actions workflow builds a Linux amd64 image,
checks Node/bash/tmux, and pushes it to the Cloudflare managed registry. It runs
on main when the Dockerfile, workflow, or dependency lockfile changes, and can
also be run manually. CI publishes `terminal-image.json` on the `terminal-image`
GitHub release, containing the immutable registry digest and Dockerfile hash.
It does not deploy production Workers.

One-time setup:

1. Create a Cloudflare custom API token with **Account → Containers → Edit**,
   limited to account `2b7a9be82bb64187230703b024e25157`. No zone permissions are
   required for this image-only workflow. Leave IP filtering unset for GitHub
   runners. Add it as the repository Actions secret `CLOUDFLARE_API_TOKEN`.
2. Push the workflow and Dockerfile to main, then run **Build terminal image**
   under the repository Actions tab if it has not already run.
3. Install GitHub CLI and authenticate with `gh auth login` for this private
   repository. Keep your existing Wrangler login for production deployment.
4. Run `npm run deploy` locally after the image workflow succeeds.

The deploy script downloads the terminal release manifest and live custom-image
manifest, verifies the registry account,
repository, digest, and Dockerfile hash, and supplies Wrangler a temporary config
with digest-pinned entries for `terminal` and all ready/publishing custom images.
Set `IMAGE_BUILD_SECRET` in the shell or ignored backend `.env` (the same value
as the API Worker and GitHub Actions); a missing secret or
unavailable custom manifest stops deployment rather than removing user images. The tracked config remains
the build blueprint. Use the npm deploy commands rather than invoking
`wrangler deploy --config wrangler.containers.jsonc` directly, which would still
attempt a local Docker build. `npm run deploy:containers -- --dry-run` exercises
the same image selection without publishing the Worker.

If the local Dockerfile differs from the published one, deployment stops before
uploading. Push that Dockerfile to main and wait for CI to publish its image.
Registry references and hashes are public metadata; API tokens stay in Actions
secrets and are never put in the deployment manifest. The GitHub release and
repository must remain accessible to the authenticated deployment user.

## Paid plans and enforcement

`containers/plan-policy.js` is the authoritative policy imported by both workers.
`GET /subscription/config` publishes these same definitions to the web UI.

| Plan | Monthly USD fee | Concurrent containers | Starts per UTC month | Hard session limit | Idle timeout |
| --- | ---: | ---: | ---: | --- | --- |
| No paid plan | $0 | 0 | 0 | No access | No access |
| Builder | $5 | 5 | 1,000 | 1 hour | 10 minutes |
| Pro | $180 | 100 | 10,000 | 24 hours | 30 minutes |
| Scale | $999 | 500 | 100,000 | 72 hours | 60 minutes |

Every plan supports Lite, Small, Medium, Large, and XL machines, up to 4 vCPU / 12 GiB RAM / 20 GB disk. Builder includes 250 compute-unit hours/month and 28 concurrent units; Pro 9,000 and 128; Scale 50,000 and 640. Units/hour are 1, 6, 10, 16, and 28. Both the unit ceiling and container ceiling apply. Browser terminal, SSH and outbound internet are included. Each container permits
up to four attached terminals (browser and SSH combined); each account permits
ten live SSH access tokens, each expiring within 15 minutes or the machine deadline. Snapshots,
filesystem persistence after stop, custom sizes, team seats, SDKs, enhanced logs,
audit exports and priority capacity are unavailable on all plans. There are no
compute overages: the start quota is a hard cap and usage billing is disabled.

A logged-in account has no container allowance until its recognized, single-item,
quantity-one subscription is active and its current plan period has a successful
Stripe payment. Trials, incomplete, past-due, unpaid, canceled and paused
subscriptions do not grant access. Local `pro_billing.plan` is a synchronized
record, not authorization. Stripe lookup failures fail closed with 503; the API
never substitutes Builder. Unpaid starts return 402 `subscription_required`
before reserving usage or provisioning a machine. An unpaid attempt from an
existing billing account also schedules revocation of its existing machines,
without delaying the 402 response; failed cleanup retains slots for alarm retries.

Reservations are shared across all slots, browser sessions and Bearer sessions.
The account saves a reservation before boot; readiness runs outside the reservation
lock so multiple machines can start together. Failed or ambiguous starts remain
charged. Stopping, upgrading, downgrading, canceling and resubscribing do not reset
usage. UTC month rollover resets the allowance. Legacy usage migrates from the
original slot without granting a fresh quota.

Every reservation has a persistent sequence number. Slot cleanup fences canceled
reservations, so delayed boots and responses cannot resurrect a stopped machine
or alter its replacement. Reconciliation persists its entitlement decision before
fanout and continues stopping reachable machines if another slot is unavailable;
failed cleanup retains the slot and retries after 30 seconds.

Each machine has a fixed hard deadline capped by its paid period. An upgrade
changes limits for new sessions and never extends existing hard deadlines.
Renewal also leaves the original hard deadline in place; start a new container
after it expires.
Downgrades and cancellation take effect at the end of the current paid period.
When a lower tier becomes effective, the oldest unexpired containers within its cap remain; excess
containers stop and remaining session/idle deadlines are clamped. Loss of paid
access stops all containers. Polling and token issuance do not renew idle time;
terminal input/output can renew idle time within the fixed hard deadline. Machine
and account alarms enforce deadlines without an open dashboard.

## Subscription changes

Purchases require login and belong to the account's Stripe customer. Checkout
session ownership is verified on completion. A second purchase is rejected while
any live subscription exists; existing subscribers use plan-change endpoints.

- Upgrades use a Stripe-hosted confirmation showing the immediate prorated charge.
  The higher tier requires a successfully paid invoice for that tier.
- Downgrades use an explicitly confirmed Stripe subscription schedule at renewal,
  preserving the current paid tier until then. Selecting the current plan removes
  a pending downgrade. Custom schedules work across the separate plan products.
- Cancellation is explicitly confirmed, removes a pending downgrade, and sets
  `cancel_at_period_end`. Resume before expiration clears that cancellation;
  after expiration, a new checkout is required.
- The billing portal provides payment-method updates and invoice history. Plan
  changes and cancellation use the dedicated app flows to preserve their rules.

See [Stripe's update confirmation flow](https://docs.stripe.com/customer-management/portal-deep-links)
and [subscription schedules](https://docs.stripe.com/billing/subscriptions/subscription-schedules)
for the underlying billing mechanisms.

The signed webhook verifies the raw body, timestamp and HMAC before reading an
account, resolves live Stripe state rather than trusting event order, and saves
an event receipt only after entitlement reconciliation succeeds. Failed revocation
remains retryable. Configure subscription, schedule, invoice, checkout and payment
refund/dispute events: `customer.subscription.*`, `subscription_schedule.*`,
`invoice.*`, `checkout.session.*`, `charge.refunded`, and `charge.dispute.created`.
Status, startup and terminal/SSH connections also resolve
live billing state, so a saved plan name cannot bypass payment checks.

## API automation

See [API.md](API.md) for authentication, endpoints, curl examples, limits and retry
behavior, and [SKILL.md](SKILL.md) for the reusable automation skill. Both files
are also published by `../web`. Backend changes update the copies here; coordinate
publication through [the backend handoff](docs/backend-handoff.md) when the web
repository is being edited independently.

Lifecycle, execution, images, and SSH issuance accept `Authorization: Bearer mb_<key-value>`
without Origin. Create named keys at `https://mainbrella.com/api-keys/`.
Login-session Bearer credentials remain supported for compatibility.
Cookie mutations still require a trusted Origin. Browser terminals remain
cookie-only. Paid entitlements and quota are identical for UI and automation.
Cleanup remains available during a Stripe outage and cannot start a machine.

To install the skill in Codex, copy `SKILL.md` and `API.md` into
`~/.codex/skills/mainbrella-containers/` (or the equivalent skills directory for
your agent), then invoke `$mainbrella-containers`. Provision `MAINBRELLA_API_KEY`
separately using the instructions in `API.md`.

## Repository lookup authentication

Repository launches and `/repo-launches/resolve` use the optional API Worker
secret `REPO_RUN_GITHUB_TOKEN` to authenticate GitHub metadata, commit, and tree
lookups. Without it, requests share GitHub's unauthenticated limit of 60 per hour
per IP. A personal access token generally allows 5,000 requests per hour, shared
with other requests by that GitHub user; secondary limits still apply.

Create a dedicated personal access token for public repository reads (a classic
PAT with no scopes is sufficient). Set it from the backend directory:

```sh
npx wrangler secret put REPO_RUN_GITHUB_TOKEN --config wrangler.jsonc
npm run deploy:api
```

For local development, set the same binding in `.dev.vars`. Keep the token in
secrets, separate from `IMAGE_BUILD_GITHUB_TOKEN`. It is sent only to GitHub's API,
redacted from launch error logs, and never passed into containers, launch records,
or browser responses. Private repositories remain rejected even if the token can
access them. GitHub redirects remain rejected. Invalid or expired tokens return
`github_unavailable`; rotate the secret rather than retrying unauthenticated.
See [GitHub's rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api).

## Custom image build and deployment

The **Build custom image** workflow must be on `main` before enabling builds.
Set `IMAGE_BUILD_SECRET` (at least 32 characters) in both the API Worker and
GitHub Actions, and set `IMAGE_BUILD_GITHUB_TOKEN` in the API Worker to a token
with Actions write access to this repository. `CLOUDFLARE_API_TOKEN` in Actions
must permit both registry access and deployment of the container Worker.

The original live-manifest rollout required an API-first bootstrap. For the
current release, apply all remote D1 migrations, configure the custom-image
workflow and its secrets, then use `npm run deploy` with `IMAGE_BUILD_SECRET`
in the shell or backend `.env`. If the deployed API predates the manifest/lease
contract, follow [the staged bootstrap runbook](docs/deployment.md) before
accepting builds; do not deploy the current API ahead of its runtime.
Node loads this secret from `.env` automatically for container deployments; an
explicit shell/Actions value takes precedence.

Preparation downloads the recipe and pinned base image on a trusted runner.
The user Dockerfile builds and runs its compatibility check on a separate,
disposable runner with no registry, deployment, or API callback secrets.
Publication loads the resulting archive without executing it, pushes it, reports
`publishing` with its immutable digest, deploys the assembled image map, then
reports `ready`. The terminal release and live API manifest feed the same deploy
script; the old `custom-images.json` release snapshot is no longer consumed.

All production image-map deployments acquire an API lease. The lease lasts 12
minutes; the Wrangler subprocess is bounded to 10 minutes, and deployments wait
up to 8 minutes for a competing lease. This serializes local deployments, builds,
and deletion reconciliation. Deleted images disappear from the live manifest
and trigger the workflow's `reconcile` operation. An hourly reconciliation retries
failed removals; deleting an image does not stop an already-running container.
If Actions is unavailable, attached image slots can remain until reconciliation
succeeds. Dry runs validate the live manifest without acquiring a deployment lease.

Explicit GitHub dispatch rejections (400/401/403/404/422) refund the monthly build
reservation atomically. Ambiguous network/server failures keep the reservation.
`npm run test:images` and CI exercise the SQL state machine through generated image selection and the
container controller, deployment failure handling, quota refunds, and workflow
syntax. It uses simulated GitHub/Cloudflare boundaries; a production build and
launch still need a smoke test after rollout. The broader `npm test` currently
also includes retained legacy admin/Apple tests with isolated compatibility fixtures.

## OpenAPI documentation

The API uses the same Chanfana + Hono + Zod setup as Cubacadabra. Run `npm run dev`
and open `http://localhost:8787/docs` for Swagger UI or `/redocs` for ReDoc.
The OpenAPI 3.1 document is served at `/openapi.json` and generated directly from
`worker/app/openapi-*.ts`. Existing handlers retain runtime validation, CORS,
authentication, background work, and WebSocket responses.

Export a standalone document without starting Wrangler or configuring secrets:

```sh
npm run docs:generate
# Optional output path (parent directory must exist):
npm run docs:generate -- /tmp/mainbrella-openapi.json
```

The default generated `openapi.json` is ignored by Git. To document a new endpoint,
add its schema alongside related routes in `worker/app/openapi-*.ts`, using
`register(api, method, path, schema, handler)`. Use Hono path parameters such as
`/images/:id` and describe them with `request.params`; the document uses `{id}`.
Include a unique `operationId`, summary, tag, request schema, response schemas,
and the correct security scheme. The shared helpers in `openapi-shared.ts` cover
JSON bodies/responses and common errors. For a new feature module, register it in
`openapi.ts`. Add the method/path to `openapi.test.ts` and run:

```sh
npm run test:openapi
npm run type-check
npm run docs:generate
```

Billing mutations use browser cookies and a trusted Origin; container/image
automation uses the session Bearer credential. Native app and internal service
tokens have separate security schemes. WebSocket routes describe the HTTP upgrade;
Swagger UI does not open terminal WebSocket sessions.

### API keys

Signed-in web users can create and revoke automation credentials at `/api-keys/`.
Before deploying API key support, apply D1 migration `010_api_keys.sql` using
`npm run db:migrate:remote`, then deploy the API and web builds. Only token hashes
are stored; the secret is returned once. Keys authorize the existing container,
image, and SSH issuance routes, with the same account entitlements and quotas.

## HTTP execution

`POST /containers/exec?id=<id>&createdAt=<ISO generation>` runs a foreground shell
command using API keys or browser authentication. It returns separate stdout,
stderr, exitCode, timedOut and outputTruncated. See API.md for limits and retry
semantics. Generation and paid lease checks run again inside the private DO;
execution never starts a machine or reserves quota. The runtime caps commands at
four concurrent requests, 60 seconds and 1 MiB combined output. Stop and deadline
revocation cancel active work. No image rebuild or database migration is needed.

Deploy the container Worker before the API for this additive endpoint, then deploy
web so the published docs and verification tool match. An API deployed before its
private runtime will return execution_unavailable. Run the web `verify:agent`
command with the provisioned API key after rollout; it consumes one start and
cleans up only its own generation. Until rollout, local process tests and API
fixtures verify the contract but do not satisfy the production release gate.

## HTTP files

`GET` and `PUT /containers/files?id=<id>&createdAt=<ISO generation>&path=<absolute-path>`
transfer raw binary files up to 1 MiB. Writes use atomic replacement and an existing
parent directory. Reads return `application/octet-stream`; see API.md for path,
permission and retry semantics. File operations recheck the generation and paid
lease before process launch, renew idle activity, and share the four-command pool.
The runtime bounds each operation by 30 seconds and the hard deadline.

No database migration or image rebuild is needed for catalog/base images, which
already include `/bin/sh` and GNU coreutils. Deploy the container Worker, then API,
then web. The doctor checks both file routes, and verification checks binary transfer, command execution and generation cleanup.

`node --test containers/files.test.mjs` runs real local filesystem/process checks.
Write tests require GNU coreutils on PATH, as provided by the Linux catalog images;
on macOS, prepend an available coreutils `libexec/gnubin` directory to PATH. Without
it those tests explicitly skip. `npx tsx --test worker/app/files.test.ts` verifies
public authentication, account ownership, error handling and binary forwarding.

Directory metadata/listing and mkdir/remove/move/chmod use the separate `/containers/files/*` routes. They share authorization, the generation-bound operation pool and bounded execution. Images must include GNU stat/find/sed/coreutils. Filesystem watchers remain unsupported. See API.md for symlink, pagination and partial-mutation semantics.

## Local project hosting

Start the backend with `npm run dev` to enable project endpoints in the Projects UI.
The default project URL uses `p-<project UUID without hyphens>.localhost`; a custom
alias such as `app.localhost` reaches the same published application. In the UI,
add the alias, click **Verify DNS**, then click **Activate locally** after it reaches
the pending TLS state. Local mode simulates DNS ownership, routing, and TLS; it
does not require public DNS records or issue certificates. The application still
uses the selected port inside its container and must listen on `0.0.0.0`.

If the backend API uses a different port, pass it to Wrangler and point the web
app at that API, for example:

```sh
npm run dev -- --port 8899
VITE_API_URL=http://localhost:8899 npm run dev
```

Local projects use the existing account and paid/trial access checks. Docker must
be running for container-backed applications. See
[docs/project-domains.md](docs/project-domains.md) for the local and deployed
domain flows.

## Agent API and local SDKs

`GET /capabilities` publishes deployment features and shared runtime limits without
authentication or provisioning. Account allowances and deployed catalog IDs remain
in authenticated `GET /containers`.

Managed execution uses `POST /containers/executions` with a generation and required
`Idempotency-Key`, followed by GET for retained results, DELETE for cancellation,
and GET `/containers/executions/:executionId/events` for SSE output and cursor replay.
It permits up to 15 minutes within the hard lease, shares the four-operation pool,
and retains up to 32 execution records per container for one hour. Disconnect only
detaches. A runtime restart interrupts unfinished jobs and stops their matching
generation; it never replays a command. See [API.md](API.md) for the full contract.

The dependency-free packages in [sdk/javascript](sdk/javascript/README.md) and
[sdk/python](sdk/python/README.md) install locally. They are not published to npm
or PyPI. Both support creation, generation-specific cleanup, binary files,
foreground commands, filesystem metadata/mutations, managed argv/cwd/env, stdin, signals, PTY resize, retained-job listing and streamed reconnect. Commands and environment values are not retained. Guest-wide OS process listing is not implemented.

`npm run sdk:qualify` creates versioned archives, clean-installs them and writes hashes and qualification evidence. `npm run sdk:qualify:deployed` installs those exact npm/wheel candidates and verifies their deployed workflows with an explicit two-start budget and recovery checkpoints; follow [the release runbook](docs/sdk-release.md) for its required arguments and account scope. Registry publication and paid deployed qualification remain separate gates. `npm run docs:package` creates the installable skill/reference bundle. The backend API.md/SKILL.md and SDK READMEs are authoritative; run web `npm run docs:sync` after changing them. Both repositories check public contract agreement in CI.

Protected application previews now have a private runtime, isolated gateway and
authenticated `/containers/previews` API, with hash-only routing in a separate
database. They are enabled on the qualified isolated `mainbrella.dev` gateway.
`npm run check:previews` bundles the gateway without
deployment. The default deploy command does not publish it. See
[the ingress handoff](docs/preview-ingress.md) for configuration, sharing semantics,
failure reconciliation and recorded live evidence. SDK helpers and capability-gated dashboard controls exist locally; verify the deployed dashboard controls separately.
`npm run verify:previews` supplies a one-start transport probe with recovery
checkpoints; follow the handoff's required arguments and explicit budget. Its
success does not satisfy the remaining framework, isolation and deployment gates.
`npm run previews:preflight` checks the staged isolation/routing configuration and
remote routing schema with no writes or starts; `-- --local` checks configuration
only. Run it separately from the account deployment preflight before preview rollout.

`npm run verify:agent` exercises create, execution, files, streaming and cleanup,
consuming one start. `npm run benchmark:api -- --samples=5 --concurrency=1` runs
bounded foreground samples and saves raw results with their methodology. Both
require a provisioned `MAINBRELLA_API_KEY` and pass account/capability checks before
launching. They preserve all pre-existing containers.

## Workload observability

Generation-bound `/containers/events` reads a bounded seven-day lifecycle journal. Runtime monitor/status observations record natural stops without guest exec or idle renewal. `/containers/metrics` uses opaque provider labels; `/containers/webhook` configures signed callback delivery with encrypted signing keys, durable retries, deduplication identities and bounded retention. Metrics and webhooks are disabled until explicitly configured and qualified. Arbitrary customer webhook destinations remain unsupported; only trusted operator-controlled HTTPS relays are allowed. SDKs expose these operations and signature verification. See [the observability runbook](docs/workload-observability.md).

## Operational status

Apply `011_operational_status.sql` before deploying the updated API. The five-minute
scheduled handler records website/API reachability and authentication-database
availability. These scopes do not establish successful login, provisioning, SSH,
image-build or billing workflows. `/status` reports unobserved or stale components
as unknown; `/status/history` exposes 31 days of observations with cursor pagination.

Configure a separate `MONITORING_SECRET` to authorize internal observation and
incident submissions. API keys cannot report public status. Operator-authored
incident text is public. `npm run status:canary` uses a dedicated provisioned
account and this secret to report a one-start create/execute/files/stream/cleanup
probe. It has no recurring schedule, preserving control over its start budget.

See [the backend handoff](docs/backend-handoff.md), [security evidence](docs/security-evidence.md)
and [runtime feasibility](docs/runtime-feasibility.md) for web integration and release gates.


### Size pricing and cost assumptions

Policy lives in `containers/plan-policy.js`. All plans offer the same five sizes; omitted size defaults to Lite. Runtime is reserved account-wide before boot, with unused runtime released on confirmed stop. Delayed or unreadable machines retain reservations. Budget deadlines survive restarts and terminal activity. Sessions are capped at the UTC month boundary; monthly allowance does not roll over. Starts limits are now 1,000 / 10,000 / 100,000 per UTC month, as lifecycle safeguards. Top-ups and automatic overages are not implemented.

At full allowance utilization, Builder and Pro cost $0.02 per compute-unit hour; Scale costs $0.01998. Small / Medium / Large / XL effective hourly prices on Pro are $0.12 / $0.20 / $0.32 / $0.56. These are about 33–42% above equivalent CPU/RAM at E2B/Daytona's published $0.0504/vCPU-hour and $0.0162/GiB-hour rates, before their storage charges and E2B plan fees. Partially used subscriptions have higher effective hourly prices. Resources, CPU scheduling and platform features differ; this is a resource-rate comparison, not a workload-performance benchmark.

Cloudflare's published marginal rates (checked 2026-10-05) are $0.072 per active vCPU-hour, $0.009 per provisioned GiB-hour, and $0.000252 per provisioned disk GB-hour. Full-CPU compute costs/hour for our sizes are $0.007254 / $0.074016 / $0.129024 / $0.220032 / $0.401040. XL has the greatest cost per unit ($0.0143229). Worst-case container compute at full allowance is therefore $3.58 / $128.91 / $716.14, leaving roughly 28% before other costs. Cloudflare's shared included usage is excluded rather than assigned to each customer. This is not a full gross-margin guarantee: egress, Workers/DO requests and duration, logging, image builds/storage, payment fees, taxes, support and operational capacity must be monitored separately. CPU-light workloads cost less. The automated pricing check verifies the compute envelope, not total profitability.

Sources: [Cloudflare pricing](https://developers.cloudflare.com/containers/platform/pricing/), [E2B pricing](https://e2b.dev/pricing), [Daytona pricing](https://www.daytona.io/pricing).

Deploy the private containers Worker before the API Worker, then publish the web build. This ensures the runtime enforces compute deadlines before the API advertises larger sizes and allowances. The `deploy` script uses that order.

## Private Services between machines

The October 7 commits add an account-owned HTTP service registry, native
`*.internal` routing, exact-generation membership, and dashboard management.
Create a network, register a backend port as `api`, and attach a frontend as a
caller; `http://api.internal/users` connects them without exposing the backend
through a public preview or putting a Mainbrella API key in the guest. Membership
and machine lifecycles are independent. This is a local prototype; require
`networking.privateServices: true` in `/capabilities` before using it.

See [the API contract](API.md#private-services-between-machines) for requests,
cleanup and limits. It supports bounded plain HTTP, not arbitrary TCP, HTTPS,
WebSockets, private IPs or direct database connections.

The saved October 7 local reports confirm private HTTP between two machines and
a backend with no preview. Both full runs failed later at frontend preview
checks, with cleanup recorded; they do not establish complete qualification.
`scripts/verify-private-services.mjs` is the bounded local verifier.

The separate [local users demo](examples/private-services/README.md) subsequently
passed private Go/SQLite access, frontend preview HTML/API, and browser rendering
of three rows at 390×844, 768×1024, 1280×800, and 1440×900 without horizontal
overflow. Its launcher leaves the two Lite app generations running and provides
explicit cleanup. This successful deployment does not replace the broader
isolation verifier or establish production qualification.

For competitor copy, compare against Daytona's [linked sandboxes](https://www.daytona.io/docs/en/sandboxes/#linked-sandboxes),
reviewed October 7, 2026: same-runner parent/child networking, DNS aliases,
ephemeral children and cascading parent deletion. Mainbrella's implemented
advantage for HTTP services is explicit membership among independently managed
machines, including attachment after creation. Daytona also documents direct
port connections; our HTTP prototype does not establish transport parity,
performance superiority, or production availability.
