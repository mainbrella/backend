# Production lifecycle

The dashboard navigation is Overview, Ad Hoc, Production, Projects. Overview
shows account billing, limits and workload totals. Each workload view reuses the
existing container and network lists. Production creation shows hourly and
30-day compute estimates and the monthly cap, and requires a startup command.
Existing resources default to Ad Hoc. Networks keep a lifecycle and reject
members with a different lifecycle; an empty network has no compute charge.

The account owns durable desired state and five-minute compute reservations.
It reconciles every 30 seconds, reserves extensions before updating the runtime,
and meters only allocated runtime. The runtime enforces the reserved compute and
paid-access deadlines even if the account heartbeat stops. Production bypasses
Ad Hoc session/idle limits. Native inactivity is set to six hours and account
heartbeats keep the runtime active; this is within Cloudflare's documented API
limit. Explicit deletion removes desired state before cleanup. Revoked or
cap-stopped desired services remain visible and only recover with authorized
compute. Legacy subscriptions cannot create Production services.

Provider recovery uses a fresh reservation, the pinned image and saved startup
command, with backoff from 30 seconds to five minutes. The logical service identity
stays stable; explicit recreation gets a new identity. Private outbound routing
is reinstalled, while project binding and network membership remain attached.
Managed command handles and live connections are closed on a runtime stop.
Startup commands run under a shell supervisor, with process restart backoff up to
60 seconds. Logs are available in /tmp/mainbrella-production.log through the
terminal. This first release reports machine readiness, not HTTP app readiness.

At paid billing-period boundaries compute fails closed until the new period is
proven paid. The old period can be invoiced after its lease is settled without
removing the desired service. There is no new unpaid grace period. Interrupted
compute automatically resumes with the same logical identity once access is
verified. Confirmed stopped intervals are excluded from billing.

Use stateless applications with external durable storage. Recovery starts from
the image, not unsaved local files or RAM. This release provides no persistent
disk, replica failover, HTTP health monitoring, rollback, or uptime SLA.

Deploy the private runtime, account/API worker, then web UI. The account checks
production feature discovery and uses /container/production-v1 so old runtimes
cannot silently start Ad Hoc machines. Qualify with Stripe test-clock renewal,
cap exhaustion/recovery, runtime interruption and stable project/private routing
before deploying for live customer workloads. No deployment is performed by
editing this code.

Cloudflare reference: https://developers.cloudflare.com/containers/api/durable-object-container/
