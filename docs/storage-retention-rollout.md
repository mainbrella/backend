# Storage retention and abuse controls

Apply D1 migration `032_storage_retention.sql`, then deploy the container Worker
before the API Worker. The wallet supports legacy seven-day reservations during
this rolling upgrade and accepts new 30-day reservations. Deploy the web before
the API: it accepts both seven-day and 30-day responses and shows warnings and
downloads in Build and Balance.

Production configuration enables charging with a configured floor of
2026-10-11 UTC. On its first enabled scheduled run, the API persists
`billing_activated_at` as the next UTC midnight. Only full UTC days at or after
both timestamps are charged. Old metering history is never charged retroactively.
The storage summary reports the effective start date.

A commit reserves 30 days of retention, current-day accrued costs, and its writes.
Container and AI reservations cannot spend that held credit. Failed renewal stops
growth and creates a read-only notice. First warning delivery by email or an
owner-authenticated billing response gives at least 30 days to export or add funds.
Email warnings are still sent if an in-app warning has already been returned.
Emails use the existing WELCOME_EMAIL binding and include the exact UTC deadline;
reminders are sent seven days and one day before deletion. Messages can repeat
if provider acknowledgement or recording delivery fails.

The notice grace can extend past paid retention. That small subsidy is an explicit
platform expense, bounded by capacity controls. Undelivered initial notices,
unsettled billing, and unavailable funding checks prevent deletion. Inspect alerts
rather than bypassing these guards. No email address requires an in-app notice
before expiration is eligible. Renewing funding cancels the deadline and notices.

Expiration rechecks funds in the serialized wallet. Its persisted token fences
new reservations while an atomic D1 batch queues physical deletion and removes
references. A top-up before the claim can renew retention and cancel deletion;
a top-up after the claim cannot restore already-expiring files. Lost acknowledgements
retry the same token. Completed accounts leave the expiry queue; failed accounts,
receipts and physical deletions use advancing cursors so they cannot starve others.

Defaults:

- Account capacity: 10 GB, including files, history, diagnostics and pending writes.
- Platform capacity: 1 TB, atomically enforced on physical object growth.
- Authenticated Build reads: 120/minute/account, 6,000/minute/platform.
- Repository/ZIP export starts: six/minute/account, two concurrent exports/account.
- Event stream starts: six/minute/account, two concurrent event streams/account.
- All export/event streams: 100 concurrent/platform, leases capped at 15 minutes.
- Metered R2 operations: 10,000/minute/platform. Deletes remain available.

Set `R2_WRITES_PAUSED=true` to stop new growth while preserving reads, immutable
retries and deletions. Set `R2_PLATFORM_MAX_BYTES` to change the global physical
capacity ceiling. Existing objects are not evicted to enforce a reduced ceiling.

Every scheduled run emits structured `storage_health` metrics: retained bytes,
provider operations, unsettled receipts and their age, queued physical deletions
and their age, undelivered initial warnings, and the emergency pause state. The
operator receives at most one alert email per UTC day when capacity reaches 80%,
operation volume approaches the limit, backlogs exceed a day, or notices are
undelivered. Logs still alert if email itself fails. Platform quotas do not replace
edge abuse protection for unauthenticated traffic or other API feature modules.
