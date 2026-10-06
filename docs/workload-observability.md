# Workload observations rollout

Lifecycle history is implemented locally. Metrics and webhook delivery stay disabled unless explicitly enabled. This runbook does not authorize paid starts, deployment, new secrets or publication. Existing local controller/API/SDK tests do not establish provider analytics or transport behavior.

## Lifecycle history

The private controller records starting, readiness, startup/runtime failures and observed stops. It persists a bounded seven-day/256-event journal per account-owned machine slot, with UUID IDs and monotonic sequence numbers across generations. Explicit stop records follow confirmed platform destruction. Native monitor callbacks and status reads can observe natural stops; their timestamp is the control-plane observation time. A delayed monitor callback rechecks the generation and cannot mark a replacement stopped.

History reads do not contact the guest or renew activity. Cleanup alarms share scheduling with container leases, managed output retention and webhook attempts. Legacy generations may lack history. Reads and delivery cleanup remain available during billing outages.

## Metrics gate

Cloudflare provides workload metrics separately from resource-allocation billing usage. The controller labels each new start with an opaque `mb_generation` UUID. The authenticated API retrieves that identity only from the owned slot and filters analytics by the exact label and generation time range. Identity labels and analytics credentials are not exposed publicly or passed to the guest.

Before enabling, qualify a dedicated generation within an explicitly agreed start budget. Verify the actual GraphQL schema, label filtering across recreation/placement, one-minute aggregation, adaptive sample counts, ingestion delay, null/missing fields, bounded responses and token permissions. Confirm the units of `memory` and `diskUsage` from the account's live schema. `diskUsagePeak` intentionally remains a raw provider value pending unit evidence; the dashboard displays only CPU seconds and RAM. Do not infer zeros, uptime or billing amounts from missing samples.

Use an account Analytics Read token with the narrowest available scope as API `WORKLOAD_METRICS_TOKEN`. Set API vars `WORKLOAD_METRICS_ACCOUNT_ID` and `WORKLOAD_METRICS_ENABLED=true` only after qualification. The private Worker must be deployed first so new generations receive labels. Existing unlabeled generations return unobserved. Turning the enable flag off stops provider queries.

## Webhook gate

Configure matching `WORKLOAD_WEBHOOKS_ENABLED=true` and `WEBHOOK_ALLOWED_HOSTS` vars in the API and private Worker only after destination/provider qualification. The private Worker additionally requires a 32-byte lowercase hex `WEBHOOK_ENCRYPTION_KEY` secret, generated and stored through the operator secret workflow. Never put that value in config files, guest env, logs or test artifacts. The API does not need the encryption key.

The allowlist is exact host matching for operator-controlled, trusted public relay destinations. It must not contain arbitrary customer-controlled DNS: a hostname allowlist alone does not stop DNS rebinding. General customer endpoint support requires a separately qualified egress mediator/pinning policy. HTTPS only, port 443, no embedded credentials, IP literals or redirects. The API and private runtime both validate policy, and every attempt revalidates it. No caller-supplied headers are accepted. Destination paths/query values remain owner-visible configuration, so avoid treating their storage as an encrypted vault.

A dedicated generation can configure its endpoint after create and explicitly replay retained starting/readiness events from cursor zero. PUT rotates the signing secret and clears prior attempts. The secret is returned once and encrypted with AES-GCM using configuration/generation associated data. Retained keys require the same operator encryption key; rotation requires customer reconfiguration. Runtime recovery reconciles journal events and retries ambiguous leased attempts without replaying guest commands.

Receivers must verify `Mainbrella-Signature` against exact raw body bytes, enforce timestamp freshness, persist deduplication IDs and tolerate out-of-order sequences. SDK verification helpers use HMAC-SHA256 and a five-minute default window. Use stable event IDs, not signature timestamps, for deduplication. Any 2xx acknowledges receipt; receiver bodies and errors are not retained. Eight attempts use bounded backoff; up to three manual cycles recover exhausted delivery. Configuration expires seven days after setup; pending records expire with either configuration or event. The shared alarm maintains delivery after VM stop without renewing compute.

Qualify signed delivery, duplicate/out-of-order handling, transient failure, restart recovery, lease recovery, explicit retry, removal/rotation during in-flight transport, retention, cross-account/generation isolation and disabled-policy cleanup. Removal cancels in-flight transport, but a receiver may already have accepted a request. Verify private alarm/provider behavior and inspect confirmed compute cleanup. No live callback or paid start was performed during local implementation.

Sources: [Cloudflare startup labels and monitor/exec APIs](https://developers.cloudflare.com/containers/api/durable-object-container/) and [workload versus billing analytics](https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-container-metrics/). Provider documentation is a design input; the above rollout evidence remains required. OTLP export is future work.
