# Workload observations rollout

Lifecycle history is deployed. Metrics and webhook delivery stay disabled unless explicitly enabled. This runbook does not authorize paid starts, deployment, new secrets or publication. Existing local controller/API/SDK tests do not establish provider analytics or transport behavior.

## Lifecycle history

The private controller records starting, readiness, startup/runtime failures and observed stops. It persists a bounded seven-day/256-event journal per account-owned machine slot, with UUID IDs and monotonic sequence numbers across generations. Explicit stop records follow confirmed platform destruction. Native monitor callbacks and status reads can observe natural stops; their timestamp is the control-plane observation time. A delayed monitor callback rechecks the generation and cannot mark a replacement stopped.

History reads do not contact the guest or renew activity. Cleanup alarms share scheduling with container leases, managed output retention and webhook attempts. Legacy generations may lack history. Reads and delivery cleanup remain available during billing outages.

## Metrics gate

### Repeatable read-only provider check

`npm run qualify:metrics -- --output=NEW_DIR` reads the pinned account's live
schema and recent labels, then uses the actual production query/decoder to
verify two distinct historical generations and an absent generation. Put the
dedicated Analytics Read token in ignored `backend/.env` as
`WORKLOAD_METRICS_TOKEN`. Reports hash identity labels, bound responses, omit
credentials/provider exceptions and never overwrite an evidence directory.

For an operator-only investigation without that token:

```sh
npm run qualify:metrics -- --output=.wrangler/NEW_METRICS_CHECK --credential=operator-session
```

This explicit mode reads the local Wrangler OAuth session for provider queries
only. It does not configure Worker secrets, deploy, start containers or enable
metrics. Neither mode proves deployed customer authorization or fresh-sample
ingestion delay; the report always retains `releaseQualified: false`.

The October 6 UTC operator-session run passed schema, production adapter,
two-generation filtering and absent-generation checks. The live schema describes
disk usage in bytes and CPU time in seconds; its memory description does not
establish units. Private evidence:
[metrics-provider.json](../.wrangler/workload-metrics-readonly-20261006-2/metrics-provider.json).
The same read-only checks passed again after the transport fix:
[updated metrics evidence](../.wrangler/job3-20261006/metrics-after-fixes/metrics-provider.json).

Cloudflare provides workload metrics separately from resource-allocation billing usage. The controller labels each new start with an opaque `mb_generation` UUID. The authenticated API retrieves that identity only from the owned slot and filters analytics by the exact label and generation time range. Identity labels and analytics credentials are not exposed publicly or passed to the guest.

Before enabling, qualify a dedicated generation within an explicitly agreed start budget. Verify the actual GraphQL schema, label filtering across recreation/placement, one-minute aggregation, adaptive sample counts, ingestion delay, null/missing fields, bounded responses and token permissions. Confirm the units of `memory` and `diskUsage` from the account's live schema. `diskUsagePeak` intentionally remains a raw provider value pending unit evidence; the dashboard displays only CPU seconds and RAM. Do not infer zeros, uptime or billing amounts from missing samples.

Use an account Analytics Read token with the narrowest available scope as API `WORKLOAD_METRICS_TOKEN`. Set API vars `WORKLOAD_METRICS_ACCOUNT_ID` and `WORKLOAD_METRICS_ENABLED=true` only after qualification. The private Worker must be deployed first so new generations receive labels. Existing unlabeled generations return unobserved. Turning the enable flag off stops provider queries.

## Webhook gate

### Temporary qualification receiver

The operator authorized the separate
`experiments/wrangler.webhook-receiver.jsonc` Worker. It has no customer/database
bindings, forwarding, guest access or production deployment-script integration.
Logging and development preview URLs are disabled. A separate operator secret
protects administration; public receipt verifies exact raw-body signatures,
timestamp freshness and the configured container/generation/event identity.
Per-run state, including the signing key, expires after ten minutes. Rotation
cannot extend that deadline. Summaries contain event IDs/hashes and counters,
never signing credentials or full payloads. DELETE and expiry wipe the state.

```sh
npm run qualify:receiver -- --output=NEW_DIR --secret-file=LOCAL_SECRET_FILE
```

The secret file supplies `QUALIFICATION_RECEIVER_TOKEN`; keep it outside Git
with mode 0600. The executable pins the operator-owned receiver origin. Its
synthetic signature, transient-failure/retry, out-of-order, deduplication and
rotation checks passed against Cloudflare with confirmed receiver-state cleanup
and zero container starts. Evidence:
[receiver-verification.json](../.wrangler/job3-20261006/receiver-check/receiver-verification.json).
These results qualify the receiver, not the private workload outbox. Do not
describe this temporary receiver as a customer webhook forwarding service.

Configure matching `WORKLOAD_WEBHOOKS_ENABLED=true` and `WEBHOOK_ALLOWED_HOSTS` vars in the API and private Worker only after destination/provider qualification. The private Worker additionally requires a 32-byte lowercase hex `WEBHOOK_ENCRYPTION_KEY` secret, generated and stored through the operator secret workflow. Never put that value in config files, guest env, logs or test artifacts. The API does not need the encryption key.

The allowlist is exact host matching for operator-controlled, trusted public relay destinations. It must not contain arbitrary customer-controlled DNS: a hostname allowlist alone does not stop DNS rebinding. General customer endpoint support requires a separately qualified egress mediator/pinning policy. HTTPS only, port 443, no embedded credentials, IP literals or redirects. The API and private runtime both validate policy, and every attempt revalidates it. No caller-supplied headers are accepted. Destination paths/query values remain owner-visible configuration, so avoid treating their storage as an encrypted vault.

A dedicated generation can configure its endpoint after create and explicitly replay retained starting/readiness events from cursor zero. PUT rotates the signing secret and clears prior attempts. The secret is returned once and encrypted with AES-GCM using configuration/generation associated data. Retained keys require the same operator encryption key; rotation requires customer reconfiguration. Runtime recovery reconciles journal events and retries ambiguous leased attempts without replaying guest commands.

Receivers must verify `Mainbrella-Signature` against exact raw body bytes, enforce timestamp freshness, persist deduplication IDs and tolerate out-of-order sequences. SDK verification helpers use HMAC-SHA256 and a five-minute default window. Use stable event IDs, not signature timestamps, for deduplication. Any 2xx acknowledges receipt; receiver bodies and errors are not retained. Eight attempts use bounded backoff; up to three manual cycles recover exhausted delivery. Configuration expires seven days after setup; pending records expire with either configuration or event. The shared alarm maintains delivery after VM stop without renewing compute.

Qualify signed delivery, duplicate/out-of-order handling, transient failure, restart recovery, lease recovery, explicit retry, removal/rotation during in-flight transport, retention, cross-account/generation isolation and disabled-policy cleanup. Removal cancels in-flight transport, but a receiver may already have accepted a request. Verify private alarm/provider behavior and inspect confirmed compute cleanup. The original local implementation performed no live callback or paid start; the October 6 qualification below supersedes that historical status.

Sources: [Cloudflare startup labels and monitor/exec APIs](https://developers.cloudflare.com/containers/api/durable-object-container/) and [workload versus billing analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/). Provider documentation is a design input; the above rollout evidence remains required. OTLP export is future work.

## October 6 UTC workload and outbox qualification

The combined live verifier consumed three Lite Node starts (one online control,
two offline continuations), with confirmed cleanup and zero secondary-account
starts. It passed all ten online/offline network comparisons and programmatic
offline access checks, but failed native webhook delivery. Its failure report
is retained at [job3-verification.json](../.wrangler/job3-20261006/workload-final/job3-verification.json).
The verifier now checkpoints bounded delivery status/HTTP codes and receiver
counters before removing configuration on failure.

A separate `experiments/wrangler.webhook-outbox.jsonc` Worker uses the actual
outbox, lifecycle controller and shared scheduler on Cloudflare SQLite Durable
Objects. Only its container lifecycle adapter is synthetic; it has no native
container or customer account binding. Authenticated, UUID-scoped objects and
their alarms expire after ten minutes, and cleanup removes both peer objects.
This isolates real provider alarms, cryptography and HTTPS transport with zero
VM starts. Fixed error categories contain no exception text or credentials.

The live diagnostic reproduced `illegal_invocation`: the default global
`fetch` was stored and called as an outbox method. An arrow wrapper preserves
its platform receiver. The next diagnostic exposed runtime rejection of
`redirect: "error"`. Webhook and metrics calls now use `manual`; non-2xx
responses fail closed and redirects never carry credentials onward. Regression
tests cover both the receiver binding and redirect rejection. This observed
runtime behavior takes precedence over the current Request documentation's
advertised redirect values; see [Cloudflare invocation errors](https://developers.cloudflare.com/workers/observability/errors/#illegal-invocation-errors)
and [Request redirect behavior](https://developers.cloudflare.com/workers/runtime-apis/request/).

The fixed probe version `c9099c00-bbed-4ccd-844c-86c34c731542` passed automatic
signed replay delivery, a forced 503 and alarm retry, out-of-order arrival,
and delivery after synthetic compute stop. Both peer states were deleted.
Evidence: [outbox-verification.json](../.wrangler/job3-20261006/outbox-manual-redirect/outbox-verification.json).

```sh
npm run qualify:outbox -- --output=NEW_DIR --secret-file=LOCAL_SECRET_FILE
npm run verify:job3 -- --output=NEW_DIR --max-starts=2 --secret-file=LOCAL_SECRET_FILE --api-version=UUID --runtime-version=UUID
```

The outbox probe consumes zero starts. The combined verifier consumes real
workload allowance and requires explicit deployment/enablement and a bounded
budget; an interrupted run must use its checkpoint for reconciliation. Do not
blindly rerun it with new creation keys. Three-start continuation additionally
requires a cleaned prior report from the same pinned deployment.

These reports remain `releaseQualified: false`. Native workload delivery after
the transport fix, rotation/restart/lease and in-flight removal, retention and
disabled cleanup, browser terminal/tmux/SSH with internet off, and customer
metrics/token/unit/ingestion checks remain open. Metrics, webhooks and internet
control stay disabled; previews remain enabled. Final deployed versions are API `b3f683e5-8277-442f-9ab4-f1bf2b1baca5` and
private runtime `560bf176-6e61-4555-b0ed-48b98332d0b2`; gateway
`6ea1bc44-2aa1-404b-89d7-074a876e35ce` is unchanged. The same redirect-mode fix
also applies to scheduled reachability and the isolated interception probe.
[Final state](../.wrangler/job3-20261006/final-state.json) records disabled
qualification flags, enabled previews, primary starts 20/secondary starts 0,
and zero containers in both accounts.

Full backend/runtime/API/SDK suites passed: 224 runtime/script checks, 188 API
checks, 20 JavaScript SDK checks and 12 Python SDK checks. OpenAPI's 18 checks,
TypeScript, syntax checks and schema generation passed. A credential scan of
changed sources and private JSON reports found no operator/account credentials.

`WORKLOAD_METRICS_TOKEN` is still absent locally. Supply an account Analytics Read token in the ignored
backend `.env`; an operator OAuth session is not a production substitute.
