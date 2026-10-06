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

## Next policy and secrets work

Cloudflare's native API supports outbound HTTP interception through a Fetcher, including HTTPS only with interception enabled and the provider CA trusted by the guest. Non-HTTP traffic needs internet disabled to avoid bypass. This codebase currently uses native Durable Object containers, so adding the separate Containers library would be a deliberate architectural choice rather than an incidental dependency.

Before customer policies or secret injection, qualify native interception, exact host and port matching, redirects, IP/DNS rebinding, alternate protocols, guest CA modification, generation revocation and provider transport limits. Restrict destinations and injected header names/values server-side. Credentials must remain in trusted control-plane storage and never enter guest files/env, request URLs, API read responses, logs, snapshots or SDK archives. Response reflection by a credentialed endpoint is also part of the threat model; a mediated credential is not unextractable merely because it was injected outside the guest. A trusted relay and scoped/revocable upstream tokens are likely necessary.

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

This provides a bounded mechanism test, not complete network/secrets qualification. Independent internet-on controls are needed to distinguish denied traffic from unreachable destinations. Add IPv6/UDP, certificate/CA changes, redirects/rebinding, same-connection behavior, in-flight acceptance, runtime restart, generation reuse and upstream revocation evidence before product work. Interceptor replacement cannot undo an already accepted upstream request. The native API cannot remove installed intercepts from a running guest, so changing policy must replace the trusted handler. Customer policy/secrets endpoints remain absent and `egressPolicies` stays false.
