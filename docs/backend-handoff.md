# Backend integration handoff

These changes live in the backend repository. Frontend work can proceed independently; publish claims about new endpoints after the backend rollout and a live smoke check.

| Contract | What the web app can use |
| --- | --- |
| `GET /capabilities` | Runtime feature flags and limits. Use these instead of assuming background execution, persistence, previews, or larger machines are available. |
| `GET /status` | Website, API, auth, provisioning, SSH, image-build and billing observations, plus incidents. Each component includes freshness and probe scope. |
| `GET /status/history` | Up to 100 observations per page, retained for 31 days. Follow both returned cursor fields when present. |
| `/containers/executions` | Start shell/argv jobs, inspect/list, write stdin, signal, resize PTYs and reconnect. See [API.md](../API.md) for authenticated request shapes. |
| `/containers/previews` | Production-qualified issue/list/revoke for owned generations on `mainbrella.dev`, including Next.js assets, WebSockets/HMR, account isolation and stop revocation. Gate controls on `previews.supported`. URL is a bearer credential returned once. |
| `/workspaces`, create with `workspaceId` | Saved filesystem workspaces are enabled and production-qualified through the API, dashboard and registry-installed SDKs. Save explicitly before stop; restore starts a fresh generation without RAM/process state. Gate new snapshots on `persistence.snapshots`. See [workspaces.md](workspaces.md). |
| `/images`, `/image-builds` | Catalog selection exists. Custom build handlers and workflow are implemented, but production build admission is disabled until the API has its GitHub dispatch credential. See [custom-images.md](custom-images.md). |
| Container `imageDigest` | Optional image identity recorded at generation creation. Do not manufacture it when an older response lacks it. |
| `sdk/javascript`, `sdk/python` | Python 0.1.0 is published on PyPI; JavaScript 0.1.0 is published on npm. Both support lifecycle, execution, files, and saved workspaces. Installation examples are in their READMEs. |
| Benchmark JSON | Raw samples, failures, cleanup results, environment metadata and methodology. Publish measured results from an actual run. |

Missing observations and observations older than 15 minutes are `unknown`. An auth observation with scope `control_plane` proves the database check succeeded; it does not prove a customer can log in. The scheduled collector checks website/API reachability and database access. Provisioning, SSH, image builds and billing need separate probes. Incident text is public plain text and should be rendered as text.

The frontend repository's API documentation, agent skill and SDK references are
generated from backend sources. Run web `npm run docs:sync` after changing those
sources and `npm run docs:check` before release. Published SDK installation
guidance is synchronized for 0.1.0 on both registries.

## Rollout

1. Follow [deployment.md](deployment.md): apply all pending migrations, including `011_operational_status.sql`, and configure a dedicated `MONITORING_SECRET` plus the existing shared image-build secret. Account API keys cannot write operational status.
2. Run `npm run deploy:preflight`, then check image selection with `npm run deploy:containers -- --dry-run`. Preflight rejects unsupported predecessor APIs; use the runbook's staged bootstrap rather than reversing the current deployment order.
3. Run `npm run deploy`. It repeats preflight, deploys the private container Worker, then deploys the API. These runtime changes do not require rebuilding a matching published container image.
4. Within an agreed start budget, run `npm run verify:agent` with a dedicated provisioned account. It consumes one container start and checks commands, binary files, managed streaming and cleanup.
5. If desired, budget a separate start for `npm run status:canary` to record a synthetic provisioning observation. Recurring paid canaries are not enabled by these changes.
6. Publish frontend integrations and claims after verifying the deployed contract.

Managed commands share the four-command sandbox limit with foreground commands and file operations. They have a maximum 15-minute timeout bounded by the sandbox lease. Each sandbox retains up to 32 execution records for one hour. Disconnecting from the event stream does not cancel a command; cancellation is explicit.

On a Durable Object restart, unfinished managed jobs become `interrupted`. Recovery destroys the affected container generation to stop orphaned processes, which can interrupt other work in that generation. Use a dedicated generation when that consequence matters. Commands are never replayed automatically.

## Further backend work

Five sizes and compute entitlement enforcement are implemented. Saved workspaces
and protected previews have completed their customer qualification; see
[workspaces.md](workspaces.md) and [preview-ingress.md](preview-ingress.md).
The corrected browser/Rust/Lite-Python benchmark replay remains pending under a
new eleven-start budget; see [size-benchmarks.md](size-benchmarks.md). Snapshot
economics remain unmeasured. Warm pools, configurable lifecycle policies,
snapshot/fork ergonomics and process-state suspend/resume remain separate work.

Filesystem list/stat/mkdir/remove/move/chmod and managed stdin/signals/PTY are
implemented with schemas, SDKs and exact-generation checks. Native PTY resize and
signals passed the October 6 internet-off checks; full internet-off release gates
remain open. GNU timeout/stat/find/sed compatibility checks gate image builds.
Watching and guest-wide process listing remain unsupported. Both SDKs are
published as 0.1.0; preserve the artifact and deployed gates for future releases.
See [sdk-release.md](sdk-release.md) and [network-policy.md](network-policy.md).

Workload lifecycle events and a compact dashboard History view are available.
Provider analytics and signed, encrypted-key webhook delivery remain disabled
pending explicit API/runtime configuration and provider qualification. See
[workload-observability.md](workload-observability.md); these observations are
separate from public service health and billing resource usage.
