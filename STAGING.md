# Staging in separate repositories

Run the orchestration commands below from backend. Backend-only operations use
this checkout. Homepage and full-environment operations also need sibling `web`
and `raindrop` checkouts with their own `npm ci` installs. Frontend build commands
run in those repositories. Each repository retains its own Git history.


the backend repository can run alongside the existing production deployments. Staging uses a
separate set of Cloudflare resources in the existing account, with its own
GitHub workflow, deployment gate, and concurrency lock. Adding this support does
not provision resources, change DNS, deploy workers, or enable production releases.

| URL | Target | Worker |
| --- | --- | --- |
| `https://stg.mainbrella.com` | `site` | `mainbrella-web-stg` |
| `https://stg.mainbrella.com/build/` | `builder` | `mainbrella-builder-stg` |
| `https://api-stg.mainbrella.com` | `api` | `mainbrella-api-stg` |
| `https://raindrop-stg.mainbrella.com` | `raindrop` | `mainbrella-raindrop-stg` |

Private targets are `admin`, `marketing`, and `containers`, using workers named
`mainbrella-admin-stg`, `mainbrella-marketing-stg`, and
`mainbrella-containers-stg`. The `previews` target uses
`mainbrella-previews-stg` at `stg.mainbrella.dev` and
`*.stg.mainbrella.dev`. There is no staging `www` redirect target.

## Isolation and defaults

The staging renderer derives app-local configurations from the existing worker
configurations and validates every resource binding before remote commands.
It rejects production D1 IDs, unexpected bindings, non-staging worker references,
and routes outside the reserved staging configuration. The production
`wrangler*.jsonc` files remain unchanged.

| Resource | Staging name |
| --- | --- |
| Application D1 database | `delta-stg` |
| Preview routing D1 database | `mainbrella-stg-preview-routes` |
| R2 bucket | `mainbrella-stg-storage` |
| Build workflow | `mainbrella-build-stg` |

Durable Object namespaces belong to the new staging workers; rate-limit
namespaces are separate too. Databases start empty, with the source migrations
applied. Production users, sessions, files, credits, credentials, and secrets are
not copied. Staging uses the host-only `mainbrella_session_stg` cookie and accepts
browser authentication from the two staging UI origins. Production keeps its
existing cookie and origin rules.

Builds, terminals, storage, and previews use the staging resources. Email delivery,
R2 billing, domain purchases, voice, custom-domain project hosting, custom image
builds, SSH, and security provisioning are disabled. Billing has no credentials by
default, and staging rejects live Stripe keys at both deployment and runtime.
Optional Stripe test credentials do not create a test product/price catalog or
fund accounts automatically. To test paid usage, configure test prepaid billing
as described below and top up with a Stripe test payment. Admin authorization is
unchanged.

Container workers reuse the maintained catalog's immutable image digests from
the `terminal-image` release in `mainbrella/backend`. The release validates those
digests against this checkout's Dockerfiles. It does not build images, obtain a
production image lease, or call the production image manifest API. A missing or
outdated catalog must be published through the existing image release process
before bootstrap can finish.

The Cloudflare account, its limits, and provider billing are shared. Isolation is
at the worker, binding, and data level. Staging builds and containers still consume
Cloudflare resources.

## Publish the homepage first

The static website can be deployed independently, before creating the staging
API, databases, containers, or previews. This path uses the existing local
Wrangler login and does not require the GitHub environment setup below:

```sh
npm run stg:homepage -- --check
npm run stg:homepage -- --publish
```

The publisher requires a clean, committed the backend repository checkout and access to the
configured Cloudflare account. It builds the staging site once and publishes
without tests or a dry run. The `--check` command runs the tests, documentation
check, build, and dry run separately. Publication targets only `mainbrella-web-stg` at
`https://stg.mainbrella.com`. If that exact hostname belongs to an older staging
worker, publication moves its custom domain to the new staging site; it does not
delete the old worker. Evidence is saved under `artifacts/staging/`.

The static homepage and public pages work immediately. Sign-in, payments,
terminals, and the separate builder need their staging services deployed later.
The browser build points at `api-stg.mainbrella.com`, disables analytics, and
discourages indexing. No preview wildcard DNS or TLS is needed for the website.

## Deploy the backend next

Use the local backend publisher to install the API and its private dependencies
without waiting for the preview hostname or GitHub environment setup:

```sh
npm run stg:backend -- --check
npm run stg:backend -- --publish
```

Publication requires a clean, committed the backend repository checkout and access to the
configured Cloudflare account. It uses `CLOUDFLARE_API_TOKEN` if supplied;
otherwise it captures the current Wrangler login token in memory. It never
prints the token, writes it to a file, or copies it to GitHub.

The command validates all four backend targets, creates or reuses `delta-stg`,
`mainbrella-stg-preview-routes`, and `mainbrella-stg-storage`, and applies both
staging migration sets. For a new API worker it first installs the private
Durable Object declarations, then publishes `mainbrella-admin-stg`,
`mainbrella-marketing-stg`, `mainbrella-containers-stg`, and the full
`mainbrella-api-stg` at `https://api-stg.mainbrella.com`. The container catalog
uses existing immutable image digests. It records each published version and
partial progress under `artifacts/staging/`; retries reuse existing resources.

The homepage deployment stays in place. This operation does not publish
Raindrop, the separate builder, or the preview gateway, and needs no
`*.stg.mainbrella.dev` setup. Sign-in with email/password is available after the
API is installed; Google sign-in still needs the authorized staging origins
described below. Billing and other external integrations retain the staging
defaults above. Terminal compute needs a separately funded staging account;
preview URLs need their gateway and DNS/TLS installed later.

## One-time setup for the full environment

1. Merge this feature into the backend repository `main` so GitHub can run
   [the main-owned staging workflow](.github/workflows/staging.yml).
2. Create a GitHub environment named `staging`. Set its variable
   `STAGING_DEPLOYS_ENABLED=true`, and add its own
   `CLOUDFLARE_API_TOKEN` secret. The token needs access to the configured
   Cloudflare account's Workers, Containers/registry, Durable Objects, Workflows,
   D1, and R2, plus worker route/custom-domain access for `mainbrella.com` and
   `mainbrella.dev`. Bootstrap needs permission to create the staging databases
   and bucket. Use the required Workers custom-domain DNS permissions as well.
   Do not enable `PRODUCTION_DEPLOYS_ENABLED` for this setup.
3. Confirm the three requested staging hostnames are available for new Workers
   custom domains. Wrangler installs those custom domains during deployment.
   Existing DNS records at those exact names may need to be resolved first;
   do not change the production hostnames.
4. For terminal/build previews, prepare a proxied wildcard DNS record for
   `*.stg.mainbrella.dev` and edge TLS coverage for that wildcard. The preview
   worker owns only the staging apex and wildcard. On a full DNS setup,
   [Universal SSL only covers the zone apex and first-level subdomains](https://developers.cloudflare.com/ssl/edge-certificates/universal-ssl/limitations/),
   so the nested wildcard needs an appropriate advanced or custom edge
   certificate. These DNS/certificate changes are not automated by the staging
   provisioner.
5. To use Google sign-in, allow `https://stg.mainbrella.com` and
   `https://raindrop-stg.mainbrella.com` as JavaScript origins in the Google OAuth
   client. Optionally set the environment variable `STAGING_GOOGLE_CLIENT_ID`
   to a dedicated public client ID; otherwise the existing public client ID is
   used. The workflow passes the same ID to both browser builds and the API.
   Email/password accounts can be created in the empty staging database without
   Google setup.

No application secrets are required for the default staging feature set. If
needed, add a GitHub environment secret named `STAGING_SECRETS_JSON`, containing
an object with only these supported keys:

- `MONITORING_SECRET` and `IMAGE_BUILD_SECRET`: new, distinct values of at least
  32 characters each.
- `STRIPE_SECRET_KEY`: an `sk_test_` or `rk_test_` key.
- `STRIPE_PUBLISHABLE_KEY`: a `pk_test_` key.
- `STRIPE_WEBHOOK_SECRET`: a new endpoint secret for a Stripe test webhook at
  the staging API.
- `STRIPE_PREPAID_PRICE_ID`: an active, one-time USD price for $5.00 on an active
  product in the same Stripe test account. Requires an explicit test secret key
  in this JSON. The existing billing code verifies the price through that test
  account before checkout; a production price ID will not work.

Leave unused keys out. The API receives these values in the same code version;
the private admin service receives only the test Stripe secret key if supplied.
The publisher creates a temporary secret file with mode `0600`, removes it on
success or failure, and keeps secret values out of release evidence. These inputs
do not copy or manage secrets on production workers. Removing a key from this
JSON does not revoke an already installed worker secret; explicitly remove it
from the affected staging worker when retiring it.

## Validate and install

From the repository root:

```sh
npm ci
npm test
npm run stg:plan
npm run stg:check
```

`stg:check` runs the relevant tests, builds staging browser assets, and dry-runs
all eight worker bundles with offline resource IDs. It needs no Cloudflare token
and does not discover, create, migrate, or publish provider resources. To check
one target, use `npm run stg:check -- api` (or another target from the table).
CI runs the full check when the affected application/configuration scope requires
it. Staging frontend builds disable analytics and emit `robots.txt` and
`X-Robots-Tag` rules to discourage indexing; this is not access control.

For first installation, commit and push the intended source on a the backend repository branch,
then run:

```sh
npm run stg:bootstrap
```

The command dispatches the workflow definition on `main`, pinned to the current
committed source SHA on the pushed branch. It requires a clean worktree and the
the backend repository origin. Staging may deploy a pushed feature branch without first merging
that application change into `main`.

Bootstrap builds the frontend assets once, discovers or creates only the reserved
staging D1/R2 resources, and applies both staging migration sets. For a new API
worker it publishes a temporary, unrouted set of Durable Object declarations to
resolve the API/container dependency cycle. It then publishes `admin`,
`marketing`, `containers`, the full `api`, `previews`, `site`, `builder`, and
`raindrop`, checking dependencies before each publication. Existing stage API
workers skip the declaration step. A retry reuses existing resources and applies
only outstanding migrations.

Staging deploys and bootstrap skip tests and dry runs. Use `stg:check` or CI for
those checks; publication retains the staging configuration and dependency gates.

Resource planning is also available independently:

```sh
npm run stg:provision             # Prints the plan; no network requests
npm run stg:provision -- --apply  # Creates missing reserved D1/R2 resources only
```

The explicit `--apply` path requires a local `CLOUDFLARE_API_TOKEN`. It does not
install schemas, workers, DNS, or certificates. Normal setup uses the workflow's
bootstrap operation instead.

## Release, migrate, and verify

Subsequent releases select one target and reuse the staging resources:

```sh
npm run stg:deploy -- api
npm run stg:deploy -- site
npm run stg:deploy -- builder
npm run stg:deploy -- raindrop
```

The other supported targets are `admin`, `marketing`, `containers`, and
`previews`. Bare `stg:deploy` fails with usage help. Ordinary releases do not
create resources or apply schema changes. Apply migrations explicitly before
releasing code that needs them:

```sh
npm run stg:migrate:api
npm run stg:migrate:previews
```

All staging workflow operations share the `canopy-staging` lock. Production uses
its existing workflows, gate, and locks. The staging workflow uploads
`artifacts/staging/` with the source SHA, artifact hashes, discovered resource IDs,
worker version receipts, and partial progress if an operation fails. Inspect that
evidence before retrying or rolling back a partially completed bootstrap.

After installation, verify:

- `https://api-stg.mainbrella.com/health` returns `{"ok":true}`.
- Registration and sign-in work on the staging site; signing into production
  still uses a separate account/session.
- Raindrop shows staging data for an authorized admin account.
- A credited staging account can start a terminal, persist a file, and open a
  preview under `*.stg.mainbrella.dev`.
- `https://api-stg.mainbrella.com/openapi.json` advertises the staging server and
  cookie. For CLI/MCP testing, explicitly set
  `MAINBRELLA_API_URL=https://api-stg.mainbrella.com`. For JavaScript SDK clients,
  pass `baseUrl: 'https://api-stg.mainbrella.com'`; Python clients take
  `base_url='https://api-stg.mainbrella.com'`. Published SDK documentation examples
  retain their canonical production defaults.

Roll back only the affected `*-stg` worker versions, coordinating with the
staging lock. A worker rollback does not undo D1 or Durable Object migrations.
