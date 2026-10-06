# Outbound network control rollout

Internet-off creation is implemented locally and disabled by default. Its tests exercise actual API handlers, account admission, the private controller and the exact native start option through an adapted local provider. No paid provider start, deployment or remote configuration was performed.

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
