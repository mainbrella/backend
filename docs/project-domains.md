# Project endpoints and custom domains

A project has a stable public endpoint while its backend is an owned, paid,
running container generation. Users select either a container and application
port, or a named network service with a registered application port. Updating
the binding changes the backend without changing DNS. The endpoint does not
start machines or extend their hard or idle leases. A replaced generation needs
explicit republication, including when it replaces a network service.

The default address is `https://p-<project UUID without hyphens>.mainbrella.dev`.
Custom hostnames are aliases for the same endpoint. Existing `projects.domain`
text remains metadata: editing it does not publish an application. The separate
Endpoint action on the Projects page performs publication and domain setup.

## Local development

Start the backend with `npm run dev`. The dev launcher enables local project
hosting for the API process only and follows Wrangler's selected API port. The
default project URL is `http://p-<project UUID without hyphens>.localhost:<port>`.
Add a single-label alias such as `app.localhost` in the Projects UI to use that
host for the same published application.

For a custom backend port, start the API and point the web app to it:

```sh
npm run dev -- --port 8899
VITE_API_URL=http://localhost:8899 npm run dev
```

In the Projects UI, add `app.localhost`, click **Verify DNS**, then click
**Activate locally** once the domain shows pending TLS. The first verification
simulates ownership and routing DNS; the second simulates TLS activation. No
public DNS records or certificates are created. Local aliases require the backend
dev launcher and are disabled in deployed environments. Existing account and
paid/trial access checks still apply. Container applications must listen on
`0.0.0.0` at their application port inside the container, and Docker must be
running. The localhost port above is the backend API port; it does not change the
application port selected when publishing the project.

## Routing and transport

The account API manages project publications and domain verification in the
account database. The isolated gateway receives only the routing database and
runtime bindings; it has no session, billing, or account database binding.
Generation-bound runtime bindings authorize a project ID, publication revision,
and application port. Publication journals and revision fences prevent delayed
operations from replacing a newer binding and allow cleanup after lost responses.

The gateway serves existing bearer preview links through their original handler.
Persistent project URLs use a separate handler and transport policy. HTTP bodies,
streaming, WebSocket upgrades, application Authorization, and application cookies
are supported. The gateway supplies the validated public Host and HTTPS protocol
and preserves the browser's Origin. Platform credentials and internal/forwarding
headers are removed; response cookies cannot set a shared parent-domain cookie.
Application redirects are returned without being followed or rewritten. Stop,
deadline, entitlement loss, and revocation close the relevant runtime transports.

One public network service is selected; other members remain private. Each new
request checks that the registered service still matches the published generation
and port. Private Services must be enabled and qualified independently before
publishing a network target. Network detach does not undo an application request
already accepted; unpublish revokes the endpoint's active transports.

## Customer DNS instructions

Users retain their DNS provider and nameservers. An account/project-specific TXT
record proves ownership before the platform claims a hostname or provisions its
certificate. Pending registrations cannot reserve a hostname globally. The
dashboard displays exact records and copy controls.

With Cloudflare for SaaS, a subdomain uses these records:

| Type | Name | Value |
| --- | --- | --- |
| TXT | `_mainbrella.www.example.com` | The registration's ownership token |
| CNAME | `www.example.com` | The project's `p-…mainbrella.dev` hostname |

Enter the full hostname or the relative label as required by the DNS provider.
Remove conflicting website A/AAAA/CNAME records for that exact hostname; retain
unrelated email and other records. On Cloudflare DNS, DNS-only records provide
the simplest onboarding; proxied customer zones need Cloudflare's O2O support
qualified separately. Cloudflare provisions and renews custom hostname
certificates. Both hostname and certificate status must be active, and routing
DNS must reach the configured target, before the application is served.

A root domain can use ALIAS/ANAME or CNAME flattening only if the DNS provider
supports arbitrary hostname targets. A normal root CNAME is not universally
supported. Standard A/AAAA records require assigned stable ingress addresses.
Do not copy arbitrary Cloudflare edge IPs from a DNS lookup. Cloudflare's
[Apex Proxying](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/apex-proxying/)
is an Enterprise add-on and supplies suitable addresses.

With the static ingress provider, root domains and subdomains use the configured
ingress A/AAAA addresses plus the ownership TXT record. The Caddy ingress manages
HTTPS and forwards to the isolated Worker using an internal credential. It
authorizes certificate issuance only for an already verified hostname claim.
Readiness requires the public DNS addresses to match the configured ingress
addresses and an HTTPS gateway verification response. Removing a domain disables
its application route and certificate authorization.

## Configuration and activation

Project hosting is staged disabled in both deployment configurations. An enabled
flag describes configured support, not live qualification. Provision and verify
the infrastructure before advertising the feature.

1. Apply `migrations/016_project_domains.sql` to the account `delta` database
   through its normal migration command. Apply
   `preview-migrations/002_project_endpoints.sql` to the separate
   `mainbrella-preview-routes` database. Never apply the account schema to the
   gateway routing database.
2. Deploy the container runtime containing the project binding routes, then the
   API and gateway. The gateway now also binds `CONTAINER_ACCOUNT` from
   `mainbrella-api`, for generation-specific network membership checks.
3. Set `PROJECT_HOSTING_ENABLED=true` on the API and gateway only after staging
   the routing migration and updated runtime. Keep the same `PREVIEW_DOMAIN`
   and routing database on both. The existing wildcard DNS and Worker route
   serve stable default project hosts.
4. Choose one custom-domain provider below. Keep matching public configuration
   on the API and gateway. Store credentials as Worker secrets, not in JSON
   configuration or source control.
5. Qualify one owned domain and running generation: HTTP, streaming, cookies,
   application authentication, WebSockets, DNS/TLS readiness, stop, replacement,
   unpublish, domain removal, and cross-account isolation. Check both the default
   project URL and custom URL; preserve existing bearer preview behavior.

### Cloudflare for SaaS

Enable Cloudflare for SaaS on the isolated `mainbrella.dev` zone. Configure an
originless fallback record and set the fallback origin following Cloudflare's
[Worker-origin setup](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/start/advanced-settings/worker-as-origin/).
Its zone-scoped `*/*` Worker route must send custom hostname traffic to
`mainbrella-previews`; the existing `*.mainbrella.dev/*` route alone does not
match customer hostname requests. Keep login/account routes on `mainbrella.com`.

Set these API and gateway variables:

```text
PROJECT_DOMAIN_PROVIDER=cloudflare
PROJECT_CLOUDFLARE_ZONE_ID=<isolated SaaS zone ID>
```

Set the API secret `PROJECT_CLOUDFLARE_API_TOKEN` with permission to manage SSL
and custom hostnames on that zone. The API owns provider operations; the gateway
does not need this token. If Apex Proxying is provisioned, set
`PROJECT_APEX_IPS` to the assigned comma-separated IPs. Otherwise leave it unset;
the dashboard must not offer an invented A-record destination.

### Static IP ingress

Provision a server or managed ingress with stable public IPs and inbound ports
80 and 443. The included `ingress/compose.yaml` runs Caddy with persistent
certificate storage. DNS for `ingress.mainbrella.dev` must reach the Cloudflare
Worker, using the existing wildcard route, rather than the Caddy server itself.
Customer A/AAAA records reach the Caddy server. This distinction prevents a
proxy loop.

Set these variables on the API and gateway:

```text
PROJECT_DOMAIN_PROVIDER=ingress
PROJECT_INGRESS_HOST=ingress.mainbrella.dev
PROJECT_APEX_IPS=<stable public ingress IPv4 and optional IPv6 addresses>
```

Generate a random secret of at least 32 characters. Store
`PROJECT_INGRESS_SECRET` as a Worker secret on both deployments and in the
ingress environment. The Caddyfile's certificate authorization callback uses a
loopback-only listener to attach that credential; it never puts the credential
in a query string. Neither the callback listener nor Caddy's administration API
is exposed by Compose. Do not enable request/header debug logging with this
credential installed.

On the ingress server:

```sh
cd ingress
cp .env.example .env
# Fill ACME_EMAIL, PROJECT_INGRESS_HOST, and PROJECT_INGRESS_SECRET.
docker compose config --quiet
docker compose run --rm --no-deps ingress caddy validate --config /etc/caddy/Caddyfile
docker compose up -d
```

The Compose image is pinned to the validated Caddy image digest. Monitor
certificate issuance/renewal and server availability, and retain `/data` across
upgrades. Multi-instance ingress requires coordinated certificate storage and
ACME challenge routing; the supplied configuration is a single-server deployment.

## Verification commands

```sh
npm run test:projects
npm run test:openapi
npm run type-check
npm run check:previews
npm run docs:generate
```

These local checks do not provision SaaS, allocate static IPs, issue live customer
certificates, or consume container starts. The feature must remain disabled until
the chosen ingress is configured and its live transport checks pass.
