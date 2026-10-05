# Protected preview ingress

The local implementation currently supplies a private container runtime primitive.
It does not supply public preview URLs, authenticated account API endpoints, SDK
helpers or dashboard controls. `/capabilities` continues to report previews as
unsupported. No deployment, provider experiment or paid start was performed.

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
the future account API must resolve ownership before calling them.

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

## Next implementation: isolated gateway and account API

Use a separate registrable domain for preview apps, with wildcard DNS and TLS.
Avoid any hostname under `mainbrella.com`: untrusted apps must not share the
account site's cookie scope or origin. Route each grant as one label, for example
`<48-character-token>.<preview-domain>`, so root-relative assets, application paths
and WebSocket URLs remain on one origin. The preview domain has not been chosen
or configured. Do not add public routes until that choice is established.

Keep the gateway separate from account/login/billing routing. It should have only
the container binding and access to a bounded routing index. A proposed index
maps SHA-256(token) to the private DO address, grant ID, generation and expiry;
never store raw tokens. Missing/expired/revoked routes fail closed and are not
cached. The DO remains authoritative for port, token validity, generation and
active transport revocation. Gateway input must never control internal preview
headers, DO addresses or ports. Scrub token-bearing hostnames from logs.

Add authenticated `GET`, `POST` and `DELETE /containers/previews` using existing
API-key/session authentication, trusted-origin write policy and
`runningContainer()` ownership resolution. Require `id` and `createdAt`.
Register matching Chanfana/Zod schemas and OpenAPI tests in the same change.
Issuance must reconcile DO grant creation with routing-index creation; a failed
index write revokes the grant. Revocation must disable the route and close the
DO transport; partial failures must be visible and retryable. Lost issuance
responses can leave a grant: list/revoke its metadata and issue a new one rather
than recovering a raw token from storage.

Links are bearer capabilities: possession permits access to that grant's app.
The account owner alone issues/lists/revokes them. Document this sharing rule,
expiration and inability to extend the container lease. A compact dashboard row
should let the owner choose a port, create/open a link, read its expiration and
revoke it; a JS/Python helper should return the URL and grant metadata. Show these
only when configured deployment capabilities report support. Do not publish
registry installation commands for the still-unpublished SDKs.

Before enabling application cookies, define host-only cookie handling and reject
parent-domain cookies that could cross preview origins. Validate HTTP Host,
Origin and forwarded-header behavior with a real framework. Cover root-relative
assets, redirects, WebSocket Origin checks, CSP and service workers without
weakening the account site's origin policy.

## Qualification gates

`node --test containers/previews.test.mjs` exercises the runtime guard with no
starts. The public feature still requires account ownership/API-key tests,
routing-index failure/reconciliation tests and an agreed bounded deployed run.
Use a dedicated account and a real Next.js or similar app listening on port 3000.
Verify HTTP/assets, WebSockets, expiry, revocation of active transports, wrong
tokens, port restrictions, cross-account isolation and generation replacement.
Confirm the preview worker cannot route into the account API, and preserve all
pre-existing containers during generation-specific cleanup. The container Worker
enables `enable_request_signal` so binding-request disconnects can abort runtime
transports; the future gateway must propagate signals and qualify this behavior.
Deployment
compatibility and the existing release preflight remain separate prerequisites.
