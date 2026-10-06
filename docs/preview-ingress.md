# Protected preview ingress

The local implementation supplies the private runtime, an isolated gateway,
a separate routing-index schema and authenticated account API endpoints.
Public previews remain disabled in the local configuration. Routing database
bindings are present in the API and gateway configs; migration and deployment
are unverified, and no preview domain is configured. JavaScript/Python SDK
helpers and capability-gated dashboard controls are implemented locally.
`/capabilities` reports support only when explicitly enabled with a valid domain and both bindings. No deployment, provider experiment
or paid start was performed.

## Provider boundary

The installed Workers types expose `container.getTcpPort(port): Fetcher`.
Cloudflare documents using its `fetch()` method for HTTP and forwarding WebSocket
upgrades through that Fetcher. This implementation uses that primitive directly;
it does not add a guest proxy, SSH tunnel or another command execution layer.
The application must already be listening on its selected port. A failed
connection returns an error and never creates or restarts a container.

Sources checked October 5, 2026: [Durable Object container API](https://developers.cloudflare.com/durable-objects/api/container/)
and [WebSocket forwarding example](https://developers.cloudflare.com/containers/examples/websocket/).
Local tests use fake Fetchers and sockets; they do not establish provider behavior.

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

The primitive strips platform headers, Authorization, cookies and forwarding
headers before reaching the application. It strips Set-Cookie from responses,
disables caching and sets a no-referrer policy. It preserves redirects without
following them. Cookie-based application sessions, external Host semantics and
redirect rewriting remain gateway work. Do not promise them from this primitive.

## Implemented gateway and account API

`worker/preview-gateway.ts` serves only preview application traffic. It has no
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
owns response-cookie stripping, no-store/no-referrer and active revocation.

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
Operator/CDN logging policy is a deployment qualification item. Listing never
returns tokens or hashes. Sharing a URL deliberately grants access to its app;
only the account owner can issue/list/revoke it.

## Configuration and rollout

`wrangler.previews.jsonc` is deliberately disabled, with no public routes,
workers.dev or preview URL. Local API and gateway configurations include the
separate routing database binding; the API enablement/domain variables remain absent. `npm run check:previews` bundles
this disabled gateway without deploying it. `npm run deploy` does not publish
or enable the preview gateway.

Before enabling:

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
origins. The app currently sees the private upstream Host; external Host semantics
and absolute redirect rewriting are unsupported. Relative redirects are passed
through without following them. Preserve and qualify WebSocket Origin behavior
with a real framework; do not bypass its checks or weaken the account site's
origin policy. CSP and service workers remain live qualification items.

## SDK and dashboard integration

Both SDKs expose `sandbox.previews.create`, `.list` and `.revoke`, bound to the
sandbox's exact generation. Create returns URL and grant metadata; list returns
metadata only. JavaScript accepts `create(port, {ttlSeconds})`; Python accepts
`create(port, ttl_seconds=...)`. Neither retries issuance. Reconciliation failures
preserve a validated `previewId` / `preview_id` for explicit revocation retry.
Packages remain unpublished; installation instructions require a local checkout.

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

## Qualification gates

`node --test containers/previews.test.mjs` exercises the runtime guard with no
starts. `worker/app/previews.test.ts` covers account ownership, API keys, generations,
input limits and routing failure/reconciliation. `worker/preview-gateway.test.ts`
covers exact hosts, expiry, hash routing, path/query/binary forwarding, aborts,
WebSocket/stream passthrough and bounded cleanup. These checks use mocks, not
provider transports. The public feature still requires an agreed bounded deployed run.
Use a dedicated account and a real Next.js or similar app listening on port 3000.
Verify HTTP/assets, WebSockets, expiry, revocation of active transports, wrong
tokens, port restrictions, cross-account isolation and generation replacement.
Confirm the preview worker cannot route into the account API, and preserve all
pre-existing containers during generation-specific cleanup. The container Worker
enables `enable_request_signal` so binding-request disconnects can abort runtime
transports; the gateway propagates signals and must qualify this behavior. Deployment
compatibility and the existing release preflight remain separate prerequisites.
