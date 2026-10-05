# Backend integration handoff

These changes live in the backend repository. Frontend work can proceed independently; publish claims about new endpoints after the backend rollout and a live smoke check.

| Contract | What the web app can use |
| --- | --- |
| `GET /capabilities` | Runtime feature flags and limits. Use these instead of assuming background execution, persistence, previews, or larger machines are available. |
| `GET /status` | Website, API, auth, provisioning, SSH, image-build and billing observations, plus incidents. Each component includes freshness and probe scope. |
| `GET /status/history` | Up to 100 observations per page, retained for 31 days. Follow both returned cursor fields when present. |
| `/containers/executions` | Start, inspect, cancel and reconnect to managed commands. See [API.md](../API.md) for authenticated request shapes. |
| Container `imageDigest` | Optional image identity recorded at generation creation. Do not manufacture it when an older response lacks it. |
| `sdk/javascript`, `sdk/python` | Local, unpublished SDKs with create, command, binary-file and cleanup support. Installation examples are in their READMEs. |
| Benchmark JSON | Raw samples, failures, cleanup results, environment metadata and methodology. Publish measured results from an actual run. |

Missing observations and observations older than 15 minutes are `unknown`. An auth observation with scope `control_plane` proves the database check succeeded; it does not prove a customer can log in. The scheduled collector checks website/API reachability and database access. Provisioning, SSH, image builds and billing need separate probes. Incident text is public plain text and should be rendered as text.

The frontend repository's copies of API documentation, the agent skill, and diagnostic instructions need a coordinated update. This work does not edit those copies.

## Rollout

1. Apply `migrations/011_operational_status.sql` to the target database.
2. Deploy the private container worker before the API worker so managed-execution requests have a compatible destination. These changes do not require rebuilding the container image.
3. Configure a dedicated `MONITORING_SECRET` for observation/incident writes and monitoring tooling. Account API keys cannot write operational status.
4. Run `npm run verify:agent` with a dedicated funded account and the documented environment variables. It consumes one container start and checks commands, binary files, managed streaming and cleanup.
5. If desired, run `npm run status:canary` once to record a synthetic provisioning observation. Recurring paid canaries are not enabled by these changes.
6. Publish frontend integrations and claims after verifying the deployed contract.

Managed commands share the four-command sandbox limit with foreground commands and file operations. They have a maximum 15-minute timeout bounded by the sandbox lease. Each sandbox retains up to 32 execution records for one hour. Disconnecting from the event stream does not cancel a command; cancellation is explicit.

On a Durable Object restart, unfinished managed jobs become `interrupted`. Recovery destroys the affected container generation to stop orphaned processes, which can interrupt other work in that generation. Use a dedicated generation when that consequence matters. Commands are never replayed automatically.

## Further backend work

The isolated probes in [runtime-feasibility.md](runtime-feasibility.md) prepare resource-size and filesystem-snapshot experiments. They do not enable those features for customers. Production support still needs measured workloads and costs, entitlement enforcement, persistence ownership and quotas, image compatibility, and expiry behavior. Secure previews, warm pools and configurable lifecycle policies remain separate implementation work.
