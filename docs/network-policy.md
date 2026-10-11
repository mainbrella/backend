# Outbound network control rollout

Internet-off creation is implemented and remains disabled pending the complete release gate. The October 6 UTC live qualification verified public egress denial and required programmatic access on Cloudflare, as detailed below. Local tests also exercise actual API handlers, account admission and the private start option.

## Implemented boundary

The API accepts an optional boolean `internet`, default true. It is immutable for the generation and belongs to the creation idempotency fingerprint. Default/explicit true retain old fingerprints. False needs API `NETWORK_INTERNET_CONTROL_ENABLED=true`, public `networking.internetControl` capability, private `/features` protocol 1 and a dedicated `/container/network-v1` start route. The SDK checks discovery and the returned status. The native start receives `enableInternet:false`; no outbound handler or host override is installed.

The feature probe does not start a guest, renew activity or consume quota. A missing/incompatible probe fails before reservation. The versioned start route also fails closed if runtime code is downgraded between probe and boot. Failure after reservation preserves the charged creation/pending slot for reconciliation. Do not resolve an ambiguous attempt by changing its key. A known policy-unavailable response is returned immediately by both SDKs.

This is a generation-wide public internet switch. It is not a container isolation boundary between processes, a domain/CIDR policy, an HTTP proxy, a secrets vault, region control or a guarantee about inbound access. Existing HTTP commands/files and native PTY transports do not use guest outbound internet. SSH and authenticated previews are independent ingress features and need live compatibility evidence.

## Qualification gate

Use an isolated dedicated account and an explicitly agreed start/rollout budget. Deploy the private runtime before the account/API and leave the flag off until evidence is recorded. Never downgrade the private runtime while the flag remains enabled; turn the API flag off first. Disabled selection cannot be enabled by caller fields such as `enableInternet`, `allowedHosts` or `imageKey`.

Record API/private versions, installed SDK/archive hashes, image digest, size, generation, creation key, allowance before/after and confirmed cleanup. Validate a normal internet-on control and an internet-off generation with the same pinned test tools. Include:

- Public DNS, direct IPv4/IPv6, HTTP/HTTPS, other TCP ports, UDP and resolver/exfiltration attempts.
- No custom image/env/guest root permission can override the native start policy; package managers fail clearly when offline.
- Local loopback and guest service operation; HTTP commands/files, stdin, signals and native PTY controls.
- Browser terminal/tmux and SSH revocation, plus protected preview HTTP/WebSockets only after the separate preview gate is qualified.
- Same-key replay, policy-key conflict, slot recreation, runtime upgrade/downgrade, cancellation and session/idle/billing expiry.
- No denied traffic charges can renew compute or cross an old generation into its replacement.

Check provider documentation and observed behavior rather than treating a mock start option as isolation evidence. Keep the flag disabled if any bypass or ingress regression is unresolved. Do not promise domain/CIDR filtering or safe secret injection based on this result.

## October 6 UTC live evidence

The pinned qualification API `05aaaf48-f5e4-4364-b443-7144faa751f6` and private
runtime `8e57ea75-8b66-4519-9297-bcbe3d100fcd` consumed three Lite Node starts:
one internet-on control and two internet-off generations. Every generation was
cleaned up; primary usage increased from 17 to 20 starts, secondary usage stayed
at zero, and both accounts have zero containers. Two verifier issues (stdin EOF
racing exit and bounded npm DNS timeout handling) required the continuations.

The root guest's ten positive controls all passed online and all failed offline:
A/AAAA/TXT DNS, public HTTP/HTTPS, hostname HTTPS, direct IPv4/IPv6 TCP,
alternate-port TCP and UDP DNS. The final offline generation passed binary
files, stdin EOF, native PTY resize/SIGTERM, cancellation, loopback, protected
preview HTTP/WebSockets/revocation, same-key replay and policy conflict, and
cross-account observation/configuration checks. Offline npm remained denied
but reached the execution timeout; fast package-manager DNS failure remains a
usability gate. Browser terminal/tmux, SSH, replacement-generation fencing and
expiry/retention compatibility still require live evidence.

The combined verifier stopped at webhook delivery, before its final aggregate
checks. Compare the recorded online and offline network fields directly; do
not describe the combined report as a release pass. Evidence:
[job3-verification.json](../.wrangler/job3-20261006/workload-final/job3-verification.json).
Production enablement was reverted while the remaining gates are incomplete.
The separate native interception/credential-injection experiment remains unrun.

## Independent network qualification

Use the network-only runner for the next bounded online/offline comparison. It
does not require webhook enablement, receiver credentials, webhook API calls or
metrics configuration. The default `verify:job3` command retains the combined
network/webhook workflow.

After approving a new two-start budget, deploy the runtime before temporarily
enabling `NETWORK_INTERNET_CONTROL_ENABLED=true` on the API. Keep metrics and
webhooks disabled. Record the deployed API and runtime version UUIDs, provision
the primary and secondary account keys in `.env`, pause concurrent starts on
those accounts, then run:

```sh
npm run verify:network -- \
  --max-starts=2 \
  --output=.wrangler/network-qualification-<new-run> \
  --api-version=API_VERSION_UUID \
  --runtime-version=RUNTIME_VERSION_UUID
```

The runner uses one online and one offline Lite Node generation sequentially.
It checkpoints recovery keys before admission, tests same-key replay and policy
conflict, compares the ten root-guest network controls, exercises files,
stdin/signals/PTY and protected preview HTTP/WebSockets/revocation, and verifies
retained stop history, exact-generation cleanup and account start deltas. Existing
containers must remain unchanged. The report is `job3-verification.json`; its
`mode` is `network`. A failed or interrupted run must be reconciled before another
start. Resume reports must match the selected mode and pinned deployments; do not
use the historical combined run as a network-mode continuation.

The offline start must reuse the preceding stopped slot with a different
generation. The runner checks that the old generation cannot read or overwrite
the replacement's binary file, execute a command, or stop it. It then verifies
the replacement's bytes and advertised offline policy remain intact. Successful
checks remove only `replacement_generation_fencing` from the report's pending
gates. An unexpected idempotent-replay identity is retained for manual
reconciliation and blocks continuation, even if the expected generation was
cleaned up. No third start is used to force slot reuse.

Package-manager evidence includes elapsed time. An offline command that times
out, truncates output, or takes more than ten seconds leaves the DNS-failure
latency gate open. The runner does not alter guest DNS settings to manufacture
a fast failure.

For a verifier-only change, the existing compatible runtime needs no redeploy.
Read its active version with `npx wrangler deployments list --config
wrangler.containers.jsonc`. After the local suites and deployment preflight pass,
and only within the agreed two-start budget, temporarily enable issuance with
`npm run deploy:api -- --var NETWORK_INTERNET_CONTROL_ENABLED:true`. Record the
new API version from the deployment output and use it in the command above,
along with the active runtime version and a new evidence directory. Both
qualification accounts must have no concurrent admission during the run.

After success or failure, withdraw issuance with `npm run deploy:api -- --var
NETWORK_INTERNET_CONTROL_ENABLED:false` and confirm public discovery reports
`networking.internetControl: false`. Confirm both admitted generations absent
and start deltas before attempting another run. If withdrawal fails or a
response is ambiguous, reconcile the active API version and capability before
retrying; do not consume a new start to recover.

`ok: true` establishes these checks only; `releaseQualified` remains false.
Browser terminal/tmux, SSH, runtime
upgrade/downgrade, lifecycle expiry/retention and offline package-manager latency
remain explicit gates. An unreachable online control cannot establish denial.
Turn the API flag off after this bounded check while any release gate remains
open. Do not enable permanent customer issuance based on this report alone.

## Policy and secrets architecture

Cloudflare's native API supports outbound HTTP interception through a Fetcher, including HTTPS only with interception enabled and the provider CA trusted by the guest. Non-HTTP traffic needs internet disabled to avoid bypass. This codebase currently uses native Durable Object containers, so adding the separate Containers library would be a deliberate architectural choice rather than an incidental dependency.

The customer implementation described below must pass live qualification of native interception, exact host and port matching, redirects, IP/DNS rebinding, alternate protocols, guest CA modification, generation revocation and provider transport limits before rollout. Restrict destinations and injected header names/values server-side. Credentials must remain in trusted control-plane storage and never enter guest files/env, request URLs, API read responses, logs, snapshots or SDK archives. Response reflection by a credentialed endpoint is also part of the threat model; a mediated credential is not unextractable merely because it was injected outside the guest. A trusted relay and scoped/revocable upstream tokens are likely necessary.

Sources: [Cloudflare outbound traffic](https://developers.cloudflare.com/containers/configuration/outbound-traffic/) and [native Durable Object container API](https://developers.cloudflare.com/containers/api/durable-object-container/). Live provider feasibility and bypass/revocation checks remain mandatory before enabling a customer-facing policy or secrets feature.

## Isolated native interception probe

`experiments/wrangler.network-probe.jsonc` is a separate private, opt-in Worker with no production/customer bindings, public routes or deploy-script integration. Its default enable flag is false and relay URL is empty. Local tests and an in-memory JavaScript bundle pass; the actual container build needs Docker and the live experiment remains unrun.

After a separately agreed rollout/start budget, configure an **operator-controlled** HTTPS relay, the experiment-only `NETWORK_PROBE_RELAY_TOKEN` secret and its enable flag. The relay must validate the bearer token and return only `{authenticated:true,runId}` for the received run ID. Do not use an endpoint that reflects credentials. The mediator further reduces the response to fixed acknowledgment fields and strips guest/receiver headers. A trusted hostname alone does not protect against DNS rebinding; this experiment is deliberately restricted to infrastructure the operator owns.

A private operator Worker can invoke a fresh object:

```js
const probe = env.NETWORK_PROBE.get(env.NETWORK_PROBE.idFromName(crypto.randomUUID()));
const result = await probe.run({ enabled: true });
```

The single-use probe reserves a two-minute cleanup alarm and starts one Lite guest with internet disabled. It installs both native HTTP and wildcard HTTPS interception before start, tests the fixed relay with provider CA trust, rejects other destinations, checks direct TCP to an IP/alternate port and TXT resolution, then replaces the interceptors with denial and checks revocation. Credentials stay in the Worker environment and never enter guest argv/env, entrypoint props, result storage or forwarded receiver responses. A failed check fails the report; failed destruction leaves the alarm for another attempt. Runtime restart destroys the guest rather than silently resuming an incomplete experiment.

This provides a bounded mechanism test, not complete network/secrets qualification. Independent internet-on controls are needed to distinguish denied traffic from unreachable destinations. Add IPv6/UDP, certificate/CA changes, redirects/rebinding, same-connection behavior, in-flight acceptance, runtime restart, generation reuse and upstream revocation evidence before product work. Interceptor replacement cannot undo an already accepted upstream request. The native API cannot remove installed intercepts from a running guest, so changing policy must replace the trusted handler. The later customer implementation below adds policy/secrets endpoints; production `egressPolicies` stays false until its separate release gate passes.


## Customer policy and encrypted vault implementation (October 11)

Creation accepts `networkPolicy: {allow: string[], deny?: string[]}` and
`secretBindings: string[]`. Rules support exact domains, `*.example.com`
(subdomains only), `*`, public IPv4/IPv6 addresses and CIDR ranges. Deny wins.
An empty allow list denies all public egress. The lists normalize before
idempotency comparison. Policy plus `internet:true` is rejected; a restricted
machine always starts with native `enableInternet:false` and HTTP80/HTTPS443
interception installed before boot. Alternate ports, raw TCP/UDP and arbitrary
DNS exfiltration are outside the allow rules and remain disabled by the native
policy. Provider HTTPS interception of a bare IP is unsupported; use hostnames
for HTTPS. CIDR deny rules also check every resolved address of an allowed hostname.
CIDR-only grants authorize literal IP requests; a hostname must match an allow
domain before the relay resolves it, preventing denied names from leaking data
through relay DNS queries.

The immutable policy and secret IDs appear in container metadata and survive
filesystem capture, fork, stop/resume and production recovery. Secret values
never appear in those records, guest environment variables or entrypoint props.
Deleting a required secret blocks subsequent mediated requests from every bound
machine. Rotation takes effect on the next admission. A response from a stopped,
replaced or recovered runtime, or a superseded secret version, is withheld.
Runtime incarnation fencing is independent of a production service's logical
`createdAt` identity. Revocation cannot undo an upstream request already accepted.

`POST /secrets` accepts `{name,value,hostname,header,prefix?}`. `GET /secrets`
returns metadata only. `PUT /secrets/:id` rotates `{value}`;
`DELETE /secrets/:id` revokes the binding. Names and exact HTTPS host/header scope
are immutable. Permitted header names are `authorization`, `x-api-key`, and
`api-key`; a prefix such as `Bearer ` is optional. Secret values are nonempty
printable ASCII without whitespace, up to 4096 bytes. There are at most 100
secrets per account and 16 bindings per generation. Two bindings cannot inject
the same host/header. Create/rotate requires paid access; list/delete remains
available for cleanup without a paid subscription. AES-256-GCM uses a fresh IV
for every write and authenticates account plus secret identity. Storage contains
ciphertext and redacted metadata. Keep the encryption key stable: replacing it
without re-encrypting existing records makes those secrets unreadable.

`containers/account-security.js` authorizes each request against the live
runtime and decrypts only exact-host HTTPS bindings. The independent
`services/egress-relay.mjs` service resolves every address, rejects private,
loopback, link-local, multicast and reserved addresses, evaluates all domain/CIDR
rules, and pins the selected IP into Node's transport lookup. The original host
still controls Host, SNI and TLS certificate verification. No later DNS lookup or
redirect can change the authorized target. The relay overwrites scoped headers,
strips internal/transport headers, never follows redirects, and rejects compressed
upstream responses. Request bodies are bounded to 4 MiB, responses to 8 MiB and
request time to 30 seconds. Account mediation permits two concurrent requests;
the relay defaults to eight. Responses are buffered for reflection checks, so
this initial transport does not provide streaming/SSE or outbound WebSockets.

The relay blocks literal, JSON, URL-encoded and base64 credential reflections in
response headers/body. This is defense in depth, not a guarantee against an
upstream that deliberately transforms its credentials. Use trusted upstream
services and scoped, revocable credentials. An owner can select their upstream;
MainBrella cannot make credentials unextractable from a malicious authorized
endpoint. Avoid arbitrary echo/debug endpoints and upstreams that execute
caller-selected requests using the injected credential.

Provider CA trust variables are set for common Node, Python, curl and Git clients
in startup and managed execution. The standard Debian images also install the
provider CA in the system trust store during readiness. Custom runtimes with
independent certificate stores may need their own trust configuration; changing
the guest trust store cannot enable direct internet access. Account-authorized
`*.internal` HTTP private services retain their separate membership policy.

### Operator setup and release gate

Nothing in this change deploys a service, starts a paid guest, or enables the
production gates. The relay is runnable with Node 24 and no new dependencies:

```sh
node services/egress-relay.mjs
```

Supply `EGRESS_RELAY_TOKEN` through the service secret store (32–256 printable
non-space characters). It listens on `127.0.0.1:8081` by default; configure
`EGRESS_RELAY_BIND` and `EGRESS_RELAY_PORT` if needed. Put an HTTPS ingress in
front of `/v1/egress`, retain body/time limits, and disable request/response body
and authorization-header logging at that ingress. The endpoint requires the
bearer token and has no unauthenticated forwarding route. Configure the API's
`EGRESS_RELAY_URL` to that exact HTTPS endpoint and install the matching
`EGRESS_RELAY_TOKEN`. The control plane sends credentials only to this fixed,
operator-controlled relay over TLS. Protect its operator access accordingly.

Install `SECRETS_ENCRYPTION_KEY` as a 32-byte, standard-base64 Worker secret.
`SECRETS_VAULT_ENABLED=true` enables vault writes. Policy admission additionally
requires `EGRESS_POLICIES_ENABLED=true` on both the API and private runtime,
relay configuration, and the runtime's protocol-1 `egressPolicies:1` probe. The
versioned `/container/egress-v1` route prevents a runtime downgrade from silently
dropping the policy. API gate withdrawal also denies ongoing public mediation.
Metadata reads and secret deletion remain available with the vault gate off.

Local tests exercise ciphertext ownership/tamper rejection, write-only metadata,
rotation/deletion, scope validation, native installation-before-boot, runtime
incarnation revocation, forged guest headers, domain/CIDR denial, mixed private
DNS responses, DNS cancellation, credential reflection, response size limits and
actual authenticated relay HTTP handling. Run:

```sh
node --test containers/security.test.mjs scripts/egress-relay.test.mjs
```

These tests do not establish Cloudflare isolation. Before enabling customer
issuance, deploy an isolated relay and private runtime, retain all default gates
off, and agree an explicit account/start budget. Use an owned acknowledgment
upstream with a disposable scoped credential, not an echo service. Record pinned
API/runtime/image/relay versions, start counts and cleanup. Compare online and
restricted guests; test allowed HTTPS and denied domain/CIDR requests, arbitrary
DNS, direct IPv4/IPv6, UDP, alternate ports, TLS CA changes and redirects. Attempt
DNS rebinding using mixed public/private A/AAAA answers. Exercise secret rotation
and deletion during a slow request, provider recovery with the same logical
identity, snapshot/fork/resume, expiry, runtime downgrade, SSH, browser terminal,
and protected preview/WebSocket compatibility. No guest file, environment,
process argument, snapshot, API response or operator log should contain a raw
credential. Confirm default-deny behavior when relay, encryption key or runtime
configuration is withdrawn. Disable gates after bounded qualification while any
check remains unresolved. The historical internet-off probe does not qualify
this new relay or customer mediation path.
