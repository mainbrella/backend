# Protected preview ingress

The private runtime, isolated gateway and authenticated account endpoints are
live, with preview issuance enabled on `mainbrella.dev`. Wildcard DNS/TLS,
routing schema, operator configurable-logging review and the earlier one-Lite
transport probe passed. The October 6 UTC follow-up passed 46 checks with one
additional primary-account Medium Node generation, including Next.js browser
workflows at 390×844, 768×1024, 1280×800 and 1440×900, development WebSockets/hot
reload, cross-account and replacement-generation isolation, and denial after
stop. The report records `releaseQualified: true` and confirmed cleanup.

Current deployed versions:

- API: `b3f683e5-8277-442f-9ab4-f1bf2b1baca5`
- Private runtime: `560bf176-6e61-4555-b0ed-48b98332d0b2`
- Gateway: `6ea1bc44-2aa1-404b-89d7-074a876e35ce`

Both preview enablement flags are true. The pair above includes the job-3
transport compatibility fixes; metrics, webhooks and internet control remain
disabled. Public `/capabilities` confirms preview support. Job 3 consumed three
additional Lite starts with confirmed cleanup; final primary usage is 20,
secondary usage is zero, and both accounts have zero containers. The earlier
preview follow-up increased primary starts from 16 to 17. The generation was stopped
78 seconds after its creation request, within the approved 30-minute cap.
JavaScript/Python SDK helpers and capability-gated dashboard controls are
implemented, and the operator confirms the deployed preview dashboard works. Cookie sessions and absolute redirect rewriting remain
unsupported. Historical checkpoints below describe earlier rollout states.

Evidence is local and ignored by Git:
[framework-final.json](../.wrangler/preview-framework-preparation/live-2026-10-06T03-37-54-654Z/framework-final.json),
[final-rollout.json](../.wrangler/preview-framework-preparation/live-2026-10-06T03-37-54-654Z/final-rollout.json),
and [final-state.json](../.wrangler/preview-framework-preparation/live-2026-10-06T03-37-54-654Z/final-state.json).
The final runner records three cumulative starts across the framework batches;
`startsAlreadyRequested: 2` and `maxNewStarts: 1` identify this follow-up's scope.

## Provider boundary

The installed Workers types expose `container.getTcpPort(port): Fetcher`.
Cloudflare documents using its `fetch()` method for HTTP and forwarding WebSocket
upgrades through that Fetcher. This implementation uses that primitive directly;
it does not add a guest proxy, SSH tunnel or another command execution layer.
The application must already be listening on its selected port. A failed
connection returns an error and never creates or restarts a container.

Sources checked October 5, 2026: [Durable Object container API](https://developers.cloudflare.com/durable-objects/api/container/)
and [WebSocket forwarding example](https://developers.cloudflare.com/containers/examples/websocket/).
Local tests use fake Fetchers and sockets; deployed provider transport evidence
comes from the bounded verification run below.

## Implemented private runtime contract

`ContainerPreviews` is attached to each private `UserContainer` Durable Object.
The container Worker's top-level `fetch()` still returns 404, and its configuration
has no public routes or workers.dev endpoint. Only trusted bindings may reach
these routes. Caller-supplied generation headers are not account authentication;
the account API resolves ownership before calling them.

Every route requires `x-preview-created-at` matching the exact running generation,
an unexpired idle/hard lease and current stored paid entitlement.

| Private route | Behavior |
| --- | --- |
| `POST /previews` | Accept `{ "port": 3000, "ttlSeconds": 900 }`; issue a grant and return its token once, with status 201. |
| `GET /previews` | Return `{ "previews": [...] }` containing active grant metadata without tokens or hashes. |
| `DELETE /previews?previewId=<id>` | Revoke a grant and close its active transports. Repeating a deletion in the same running generation succeeds. |
| `/preview/<application-path>?<application-query>` | Require `x-preview-token`; forward the request to the grant's stored port. Preserve method, body, path and query. |

Grant metadata contains `id` (32 hexadecimal characters), `port`, `createdAt`
(the container generation) and `expiresAt` (epoch milliseconds). Tokens contain
192 random bits encoded as 48 lowercase hexadecimal characters; durable storage
retains only their SHA-256 hashes. Tokens cannot select another port. Grants
survive a DO restart but cannot authorize a replacement generation. Active
transports do not survive a Worker restart and need a fresh connection.

Limits are authoritative in `containers/preview-contract.js`: ports 1024–65535,
eight active grants per generation, sixteen simultaneous requests/WebSockets,
60–3600 seconds requested TTL with a 900-second default, a 15-second response-header
timeout and 1 MiB per WebSocket frame. Grant expiry is clipped to the container's
hard deadline. Ports below 1024, including SSH and privileged HTTP ports, are
excluded. Future runtime control listeners must be explicitly excluded before
being added; a high application port alone does not prove a service is safe to share.

Admission and grant mutation use the existing lifecycle serialization lock.
Application response waits release that lock so stop/revoke remain responsive.
Revocation and stop abort active HTTP streams and close both sides of WebSocket
bridges. A hard timer enforces grant expiry; a one-second transport check also
closes requests after lease shortening, idle expiry or a stored entitlement
change. Successful response headers renew idle activity;
WebSocket traffic renews it at most once per second. Quiet sockets do not renew
it. Existing terminal and managed execution flows keep their own limits.

The primitive strips platform headers, Authorization, cookies and caller-supplied
forwarding headers before reaching the application. The gateway attests the
validated public origin using `x-preview-origin`; after validating the token and
origin, the runtime sets Host, X-Forwarded-Host and X-Forwarded-Proto from it.
Caller Origin is preserved, so foreign-origin framework requests stay rejected.
The attestation is stripped before reaching the guest. Missing attestation retains
legacy forwarding for deployment compatibility; invalid attestation is rejected.
The primitive strips Set-Cookie from responses,
disables caching and sets a no-referrer policy. It preserves redirects without
following them. Cookie-based application sessions and absolute redirect rewriting
remain unsupported.

## Implemented gateway and account API

`worker/preview-gateway.ts` serves preview application traffic and redirects the
exact preview apex to `https://mainbrella.com` with status 308, preserving the path
and query. The apex redirect works even when previews are disabled. It has no
login, billing or account database bindings. A separate D1 routing database maps
SHA-256(token) to the owner-resolved private DO address, grant ID, generation and
expiry. There are no raw tokens in storage and no cached routing reads. The runtime
remains authoritative for port, token validity, generation and active transport
revocation. A stale route can never revive a revoked runtime grant.

The gateway requires HTTPS and exactly one 48-character lowercase hexadecimal
label under `PREVIEW_DOMAIN`, for example `<token>.<preview-domain>`. Root-relative
assets and WebSocket paths remain on that origin. Invalid/missing/expired routes
return a generic 404; index/binding failures return a generic 503. The request
cannot select an internal address or port. The gateway overwrites internal
preview headers and strips account credentials, cookies, platform/forwarding
headers and Referer. It preserves method, body, path, query, Origin and Upgrade,
uses manual redirects and propagates the request AbortSignal. Responses pass
through unchanged to retain streaming and Worker WebSocket upgrades; the runtime
owns response-cookie stripping, no-store/no-transform/no-referrer and active revocation.

The account API registers authenticated GET, POST and DELETE
`/containers/previews`, with matching Chanfana/Zod schemas. All require `id` and
`createdAt`, resolve ownership with `runningContainer()`, require paid access and
accept API keys or browser sessions. Cookie writes require trusted Origin.
POST accepts `{port, ttlSeconds?}` and returns `{id, port, createdAt, expiresAt,
url}` once. GET returns active metadata only. DELETE additionally requires
`previewId` and returns `{revoked:true}`, idempotently within that running generation.
These management operations do not renew the lease or start/restart a machine.
Listing/revocation remain available when issuance is disabled, so the owner can
close existing transports during gateway shutdown.

Issuance creates the runtime grant first, then inserts its hash in the routing
index. Failed or ambiguous index writes attempt both route deletion and runtime
revocation. Revocation removes the owner/generation-scoped route first, then
closes runtime transports. Both cleanup operations are attempted even if one
fails. A partial failure returns 503 `preview_reconciliation_required` with
`previewId` so the owner can retry DELETE. Other unavailable failures return
`previews_unavailable`. Existing connections can remain active if runtime
revocation failed, until retry succeeds or the lease/grant expires. Lost issuance
responses can leave a grant: list/revoke metadata and issue a new URL rather than
recovering a raw token. If the generation has stopped, runtime access already
fails closed and leftover routing records age out.

Runtime admission caps each generation at eight active grants with TTL at most
one hour. The routing schema indexes expiry; a five-minute gateway cron deletes
up to 1,000 expired rows per run. Delayed cleanup never extends routing validity.
Monitor cleanup backlog and increase the explicit cleanup budget if issuance
volume requires it. The query cap bounds work, not total historical database size.

Gateway observability is disabled to avoid automatic token-host logging, and
errors never log request URLs, token values or routing exceptions. Do not add
analytics, request logging or third-party assets that expose bearer hostnames.
Preview application responses and gateway errors now set
`Cache-Control: no-store, no-transform`. The added directive asks intermediaries
to preserve the payload, including preventing automatic analytics injection.
[Cloudflare documents this restriction](https://developers.cloudflare.com/web-analytics/faq/).
A private disposable HTML edge probe observed no external requests with these
directives; the earlier browser failure recorded two external requests despite
zero page errors and zero failed HTTP responses. The production header change was deployed and all four live browser viewports
passed without external requests. This does not
prevent an application from deliberately loading its own external resources.
Operator/CDN logging policy is a deployment qualification item. Listing never
returns tokens or hashes. Sharing a URL deliberately grants access to its app;
only the account owner can issue/list/revoke it.

The initial deployed `mainbrella.dev` route added `NEL` and `Report-To`
headers even with gateway observability disabled. Browser network-error reports
can include the requested URL, whose hostname would contain a bearer token.
Disable Network Error Logging for this zone using its dashboard setting or
`PATCH /zones/e6597a41a75e1abb92f4bc5e5758c460/settings/nel` with
`{"value":"off"}` and a credential with Zone Settings Edit permission. Verify
the public response no longer advertises reporting before issuing real grants.
The operator disabled NEL before the October 6 run, and the verifier and final
public checks confirmed those reporting headers are absent.
This resolves browser reporting only; the remaining CDN/Worker log review still
applies. See [Cloudflare's NEL documentation](https://developers.cloudflare.com/network-error-logging/).

## Configuration and rollout

`wrangler.previews.jsonc` enables the qualified gateway, with workers.dev and
development preview URLs off. The `mainbrella.dev` apex custom domain provisions
DNS/TLS for the redirect. Its preview route is `https://*.mainbrella.dev/*`
in zone `e6597a41a75e1abb92f4bc5e5758c460`. Local API and gateway configurations
include the separate routing database binding, matching `PREVIEW_DOMAIN` values
of `mainbrella.dev` and `PREVIEWS_ENABLED: "true"`. `npm run check:previews` bundles
the gateway without deploying it. `npm run deploy` does not publish the preview
gateway; deploy it separately with its own configuration.

The apex redirect was deployed on October 6, 2026 in gateway version
`75ed26f7-e9dd-4bbb-aad3-943a56a6fe69`. Cloudflare and Google public DNS resolve
the apex; live HTTPS checks returned 308 for `/` and preserved paths and queries.
An unissued preview subdomain continued to return 404.

For a new rollout or requalification:

1. Choose and establish ownership of a **separate registrable domain**, with
   wildcard DNS, Worker routing and wildcard TLS. Never use a hostname under
   `mainbrella.com`. The code rejects that account domain, malformed DNS names,
   URLs, wildcards and ports; it does not implement a public-suffix registry.
   The operator must verify the selected name is a privately owned registrable
   domain, rather than a public suffix or a shared tenant suffix.
2. Verify the dedicated routing D1 database identified by the local bindings
   exists in the intended account. Both API and gateway must use the same
   `PREVIEW_ROUTES` database and `migrations_dir: "preview-migrations"`.
   Apply `001_preview_routes.sql` there using Wrangler D1 migrations. Do not add
   the account database to the gateway or apply this schema to `delta`.
3. Set matching `PREVIEW_DOMAIN` values in the two configs. Keep
   `PREVIEWS_ENABLED: "false"` until migration, private runtime and isolated
   gateway configuration are ready. Bind only `USER_CONTAINER` and
   `PREVIEW_ROUTES` on the gateway. Configure its wildcard route on the isolated
   domain. Enable `PREVIEWS_ENABLED: "true"` on both for the agreed qualification
   run, with the runtime and gateway available before the API advertises support.
   `/capabilities` describes configured support, not live health or qualification.
4. Follow the existing compatibility preflight/containers/API release runbook.
   Run the bounded qualification below before publishing feature claims. To
   disable new preview traffic, disable the gateway and API flags; this alone
   does not terminate existing runtime transports. Explicitly revoke active
   grants, or wait for their bounded expiry. Retain the routing database for
   cleanup/reconciliation. Never mass-stop pre-existing customer containers.

Application cookies remain disabled. Do not enable them without defining
host-only handling and rejecting parent-domain cookies that could cross preview
origins. The app sees the validated public preview Host and HTTPS forwarded
protocol. Absolute redirect rewriting is unsupported. Relative redirects are passed
through without following them. Preserve and qualify WebSocket Origin behavior
with a real framework; do not bypass its checks or weaken the account site's
origin policy. CSP and service workers remain live qualification items.

### Read-only rollout preflight

After staging matching domains, explicit enablement flags and the wildcard
gateway route, run `npm run previews:preflight -- --local` to check configuration
without remote requests. Keep both flags `false` during staging. After applying
the routing migration, run `npm run previews:preflight` before publishing the
gateway or advertising preview support from the API. Repeat it after changing
either configuration, including the enablement flags. The general
`deploy:preflight` checks the account database and compatibility predecessor;
it does not replace this separate preview check.

The preview preflight verifies matching pinned accounts and runtime bindings,
database isolation, matching routing migration settings, disabled development
URLs/public runtime routes, request signals, the exact isolated wildcard route,
disabled gateway logging and the cleanup schedule. Its default mode uses only
remote schema/migration SELECTs on `PREVIEW_ROUTES`: it checks the applied
`001_preview_routes.sql`, table constraints and expiry index without reading
routing rows, token hashes or account data. It makes no database writes, deploys
no Workers and consumes no starts. Configuration or schema failures stop it
before rollout. Local and remote preflights passed for the staged
`mainbrella.dev` configuration with issuance disabled; the general deployment
compatibility preflight and published-image container dry-run also passed.

A pass still reports `releaseQualified: false`. Configuration checks do not
establish domain ownership, registrable-domain isolation, DNS/wildcard TLS,
provider/CDN logging settings or that deployed Workers match these files.
Retain those operator reviews and the bounded transport/framework/isolation
evidence separately. `--local` additionally leaves remote schema verification
pending.

## SDK and dashboard integration

Both SDKs expose `sandbox.previews.create`, `.list` and `.revoke`, bound to the
sandbox's exact generation. Create returns URL and grant metadata; list returns
metadata only. JavaScript accepts `create(port, {ttlSeconds})`; Python accepts
`create(port, ttl_seconds=...)`. Neither retries issuance. Reconciliation failures
preserve a validated `previewId` / `preview_id` for explicit revocation retry.
Python 0.1.0 is published on PyPI and JavaScript 0.1.0 on npm. Follow each SDK reference for installation.

The dashboard reads public capabilities without credentials and adds a compact
Preview control only when support is advertised. Its expandable port form creates
a default 15-minute link, shows expiration, opens with no referrer and revokes.
One-time URLs remain in memory, survive container polling and disappear at expiry
or generation replacement. After lost issuance, creation stays disabled until
metadata is refreshed; an unrecovered URL can be revoked but cannot be reopened.
If support is disabled during a session, existing controls retain list/revoke and
disable creation. A fresh page without advertised support has no preview controls.

Local controller/request tests and SDK/API integration cover lost responses,
reconciliation, generation replacement and capability gating. Mocked-API browser
checks passed at 390×844, 768×1024, 1280×800 and 1440×900, including expiry while
open. These results do not establish deployed transport behavior.

## Bounded transport verification

`npm run verify:previews` prepares transport evidence with at most **one new
Lite generation** on the Node catalog image. Use Node 22+ and a dedicated
provisioned account, after the rollout prerequisites above and agreement on the
one-start budget. The command does not deploy or enable previews. Supply the
isolated registrable domain and the API, runtime and gateway source revisions
from deployment records; those revisions are labeled operator supplied.
Set `MAINBRELLA_API_KEY` in the environment and optionally set a trusted
`MAINBRELLA_API_URL` (the default is `https://api.mainbrella.com`).

```sh
npm run verify:previews -- \
  --output=/path/to/new-preview-evidence \
  --max-starts=1 \
  --preview-domain=ISOLATED_REGISTRABLE_DOMAIN \
  --api-revision=API_COMMIT_SHA \
  --runtime-revision=RUNTIME_COMMIT_SHA \
  --gateway-revision=GATEWAY_COMMIT_SHA
```

The runner checks public capabilities without credentials, then probes a random
unissued hostname on the preview domain before any paid start. DNS/TLS must work
and the gateway must return a no-store/no-referrer 404 without `NEL`, `Report-To`
or `Reporting-Endpoints` headers. Failure stops without creation or grant
issuance. This edge check does not replace the full CDN logging review. It then
checks authenticated account allowance and the catalog and checkpoints a creation key before admission
and rejects an identity already present in the account. It uploads the
dependency-free `scripts/preview-app.mjs` fixture, starts a four-minute managed
job on port 3000 and waits for readiness, including the initial `starting` state.
There are no new-key creation retries or stops of pre-existing generations.

Checks cover HTML/root-relative assets, binary responses and POST bodies, query
preservation, credential/response-cookie stripping, relative redirects,
metadata-only listing, control-port rejection, invalid hosts/tokens and a request
to an account-only path. Native WebSockets must echo through the gateway.
Revocation must close an HTTP stream and WebSocket that were still open before
the mutation; an already completed stream cannot count. A separate quiet
WebSocket must remain open until its 60-second grant expires, then close and deny
new access. Finally, stopping the exact created generation must close another
active WebSocket and deny its URL. Transport waits are bounded; the expiry check
normally takes about a minute. The managed fixture ends after four minutes even
if the verifier is interrupted; the machine's existing lease remains independent.

`preview-verification.json` is updated atomically in a new private evidence
directory. It records checks, stage, cleanup, safe grant IDs/expiry, creation and
execution keys, exact container generation, verifier/fixture/SDK source hashes,
Node version, API version and target. It omits account credentials, bearer URLs,
tokens, command output and raw server errors. Existing evidence directories are
never overwritten. Loopback targets are explicitly labeled and cannot qualify
provider transports. Run `node --test scripts/verify-previews.test.mjs` for local
failure-path and real loopback HTTP/WebSocket fixture checks with no paid starts.

After a failure or interruption, inspect the checkpoint before approving another
run. `cleanup: "completed"` means an account read confirmed the exact generation
absent; `failed` or `pending` requires reconciliation. If `container` is present,
stop only that recorded `id`/`createdAt` using the dedicated account. If admission
is ambiguous (`reconcile_manually`), use the recorded `creationKey` with the same
`{catalogId:"node", size:"lite"}` selection to reconcile within the 24-hour
idempotency window, under the existing budget; never invent a new key. Do not
replay an expired key, guess ownership from the newest slot, or mass-stop the
account. Grant IDs allow list/revoke reconciliation while that generation runs;
the checkpoint cannot recover a one-time URL. Successful stop invalidates runtime
access even if expired routing rows await cleanup.

Even `ok: true` always leaves `releaseQualified: false`: this fixture is a
transport probe. Its `pendingGates` still require a real Next.js or similar
framework/browser run (including WebSocket Origin, CSP and service workers),
cross-account isolation with a second account, replacement-generation checks
within a separately agreed start budget, and domain/TLS/CDN logging review.
Retain that evidence alongside this report before enabling public claims.

## October 6, 2026 deployed transport result

The verifier passed against `mainbrella.dev` using one new Lite generation and
the Node catalog image. The test account had no pre-existing containers. API
version `3712dd18-9306-4859-b981-1ff02331f200` and gateway version
`9d63ffbd-ccaa-4b44-8ee5-c9cccdb65f3f` were temporarily enabled; the existing
runtime version was `8fda2eef-9aa9-4163-a48a-d2e5d8b6f58e`.

All fourteen recorded checks passed: wildcard DNS/TLS, absence of browser
reporting headers, application readiness, HTTP/assets/binary data, credential
stripping, relative redirects, metadata-only listing, control-port rejection,
gateway isolation, WebSocket echo, active revocation, active expiry, active stop
and denial after stop. The account read confirmed the exact test generation
absent. The verifier's `cleanup` is `completed`, and `releaseQualified` remains
false.

Evidence: [preview-verification.json](../.wrangler/preview-qualification-2026-10-06T03-14-00-127Z/preview-verification.json)
and [rollout.json](../.wrangler/preview-rollout-20261006/rollout.json). These files
are local, private and ignored by Git. They record verifier/source hashes,
deployment metadata and recovery identities without API keys or bearer URLs.
The source revision is operator supplied; actual deployed version IDs are
recorded separately. Both API and gateway were restored to disabled issuance
after the test. The next live run needs a separately bounded budget and a second
account credential for the remaining framework/isolation gates.

## October 5 operator logging review and next qualification batch

The operator's Cloudflare dashboard screenshot of `mainbrella-previews` showed
Logs, Traces and Logpush disabled, no export destinations, and no connected Tail
Worker. The displayed `observability.enabled: false` agrees with the tracked
gateway configuration. The operator separately confirmed Network Error Logging
off for `mainbrella.dev`, domain Logpush not enabled, and no HTTP Requests export
jobs. This completes the operator review of configurable logging for the current
gateway/zone. Cloudflare's internal retention is a separate provider policy; this
review does not establish that the provider retains no request metadata. Repeat
the review after changing logging/export settings or adding integrations.

Authenticated account reads confirmed that both supplied test keys have active
Builder entitlements and neither account has a running container. Credentials
stay in the ignored backend `.env`; the primary key is `MAINBRELLA_API_KEY` and
the second account key is `MAINBRELLA_API_KEY2`. Do not include either in reports
or upload them into the guest.

The operator approved this bounded batch:

- Temporarily enable the existing API and gateway preview flags; preserve the
  runtime/image map and record deployed versions. Restore disabled issuance on
  failure or incomplete evidence.
- Use at most two sequential **Medium** Node generations on the primary account,
  with at most 30 minutes of runtime per generation. Medium provides 1 vCPU and
  6 GiB RAM for framework install/build work. No starts on the second account.
  This caps requested runtime at 10 compute-unit-hours, separate from the two
  starts. An interrupted runner still requires reconciliation; the Builder
  provider/session lease may last up to one hour without confirmed cleanup.
- Run a pinned, minimal Next.js application on port 3000; inspect HTML, static
  assets, client hydration, nested navigation/refresh, API requests, development
  WebSocket Origin behavior, CSP and service-worker behavior. Record any
  framework limitations rather than weakening its origin checks.
- With the active second account, attempt primary-generation preview list,
  issuance and revocation. Confirm denial and continued primary-account access.
- Stop the first exact generation, recreate the same slot once, and check old
  URLs and old-generation management requests stay denied while a fresh preview
  works. Check both a forged grant ID and the known first-generation grant ID.
- Retain recovery keys and exact generations before every creation. Abort on
  failed checks; no new-key retries, size escalation or additional starts.
  Confirm each created generation absent before proceeding or concluding.

The pinned fixture is prepared privately under
`.wrangler/preview-framework-preparation/nextjs/` with Next.js 16.3.8 and React
19.3.0, an exact npm lockfile, and no application credentials or external
telemetry. A production build and eleven local HTTP checks passed: readiness,
root HTML, CSP, framework asset discovery/delivery, nested routing, API POST,
service-worker script delivery, server-action discovery/redirect/result. The
local server was stopped. These checks do not establish browser execution or
gateway/provider behavior. The private `local-check.json` records source hashes;
`nextjs-source.tar.gz` contains only those source files and fits the existing
1 MiB transfer limit. Upload source, run `npm ci` and build in the guest so the
local macOS dependencies/build are not reused on Linux. Use
`NEXT_TELEMETRY_DISABLED=1` for install/build/server execution.

The existing one-start `verify:previews` fixture is already qualified for its
transport scope. It is not the framework/isolation runner and need not be
repeated just to spend another start. The first Medium start built the fixture and
passed second-account management isolation, but Next.js Server Actions rejected
the private upstream host. That generation was stopped and both enablement flags
restored to false. The runtime/gateway fix attests the validated public origin;
local tests against the actual Next.js server reproduce the old 500, verify a
same-origin 303 after the fix, and retain foreign-origin rejection. The second
Medium start passed replacement-generation management rejection, old-URL denial,
cross-account isolation and foreign-origin Server Action rejection. It completed
the mobile app interactions and no-overflow check, then failed the final browser
check with two external requests, zero page errors and zero failed HTTP responses.
Both generations were confirmed stopped; the two-start budget is exhausted.
The evidence is in
[framework-recovery-2.json](../.wrangler/preview-framework-preparation/live-2026-10-06T03-37-54-654Z/framework-recovery-2.json).
The follow-up scope was to deploy the no-transform response change and qualify the
full browser workflow at all four sizes, plus development WebSockets/hot reload
and post-stop denial. The approved follow-up used one additional Medium Node start,
at most 30 minutes, on the primary account and no starts on the secondary account.
The completed follow-up and current deployed versions are recorded at the top
of this runbook. Future paid runs require a new bounded budget.
The private follow-up runner is prepared at
`.wrangler/preview-framework-preparation/run-final.mjs`. It requires
`--max-new-starts=1`, verifies the prior reports and unchanged verification inputs,
and refuses execution until `final-rollout.json` records the deployed API/runtime/
gateway versions with `deploymentPending: false`. It writes fresh
`framework-final.json` checkpoints, checks the no-transform header in each browser
viewport, and records external hosts with bearer tokens redacted if checks fail.
It uses the primary account for the sole new generation, keeps the secondary
account read/management-only, and retains the 30-minute cleanup deadline.
For the development fixture, configure `allowedDevOrigins` with exactly the
current preview hostname via `MAINBRELLA_PREVIEW_HOST`; do not allow wildcard
origins. This is separate from production Server Action validation.

## Qualification gates

`node --test containers/previews.test.mjs` exercises the runtime guard with no
starts. `worker/app/previews.test.ts` covers account ownership, API keys, generations,
input limits and routing failure/reconciliation. `worker/preview-gateway.test.ts`
covers exact hosts, expiry, hash routing, path/query/binary forwarding, aborts,
WebSocket/stream passthrough and bounded cleanup. These checks use mocks, not
provider transports. The deployed transport and final framework/browser/isolation runs passed.
Repeat affected checks when changing the runtime, gateway or routing policy.
Use a dedicated account and a real Next.js or similar app listening on port 3000.
Verify HTTP/assets, WebSockets, expiry, revocation of active transports, wrong
tokens, port restrictions, cross-account isolation and generation replacement.
Confirm the preview worker cannot route into the account API, and preserve all
pre-existing containers during generation-specific cleanup. The container Worker
enables `enable_request_signal` so binding-request disconnects can abort runtime
transports; the gateway propagates signals and must qualify this behavior. Deployment
compatibility and the existing release preflight remain separate prerequisites.
