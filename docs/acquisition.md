# Acquisition data spine

The acquisition spine connects public repository intent to account activity and paid compute. It supplements Google Analytics, which remains useful for page and campaign reporting; backend events are the source for account-level activation and billing outcomes.

## Storage and attribution

Migration `021_acquisition.sql` creates:

- `acquisition_leads`: a verified canonical GitHub repository, allowlisted first-touch attribution, a server UUID, and a hash of the browser's intent token. The raw token is never stored or returned.
- `acquisition_accounts`: one immutable first-linked lead per account. An account may link later repository intents too; these remain separate leads and do not replace the first association.
- `acquisition_events`: append-only, uniquely keyed product facts with occurrence and recording timestamps.
- `acquisition_projection_accounts` and `acquisition_projection_scan`: per-account and fair-scan cursors for billing projection.

Attribution is fixed when the visitor submits the first repository. The browser should retain the opaque 32-byte hex intent token only for the flow, and should collect/send UTMs and click identifiers only where tracking consent permits. The token can link a verified repository intent to the signed-in account for 30 days. Linking uses the account's stored email and requires an allowed browser `Origin` plus the `mainbrella_session` cookie; the caller cannot select an account or email. `lead.captured` is written with that account linkage. Signup alone, or an anonymous repository submission, is not a captured lead.

## Events and sources

| Event | Recorded when |
| --- | --- |
| `repo.submitted` | `POST /acquisition/repositories` verifies that GitHub reports a public repository and stores the intent. Reusing the same token and repository returns the original lead; changing the repository conflicts. |
| `lead.captured` | `POST /acquisition/link` links an unexpired repository intent to the signed-in account, using its stored contact email. |
| `user.created` | A database trigger observes a new `users` row after migration 021. Existing signups are not backfilled. |
| `workspace.started` | A managed launch persists a running container generation, or the authenticated container account list observes a running generation. The event key includes account, container ID, and generation so repeated snapshots deduplicate. |
| `workload.activated` | A managed repository launch reaches `ready` after a successful setup command or successful HTTP preview readiness. A clone-only shell does not count. Arbitrary CLI commands do not count without managed repository evidence. |
| `preview.opened` | The preview gateway returns a successful HTML document for an actual browser document or iframe GET. A preview ID is recorded once; URLs, bearer tokens, query strings, and cookies are excluded. |
| `developer.qualified` | A user has two distinct managed workload activations on different UTC calendar days. The database trigger records this qualification once. |
| `wallet.funded_paid` | The bounded billing projector confirms delivered wallet funding with real-money consideration. Promotional credit and sales tax are excluded from consideration. |
| `compute.consumed_paid` | The projector attributes consumed compute to delivered paid consideration using FIFO funding lots. `paidMicroUsdDelta` is a signed string: later receipts, revocations, or refunds may append positive or negative corrections without changing prior events. |
| `launch.failed` | A managed repository launch persists a failed phase. The payload records a safe failure stage and error code, not command text, logs, credentials, or preview URLs. |

Product event writes from API observers and billing projection use deterministic unique keys and are idempotent. `recordProductEventSafely` is feature-flagged and catches storage failures with a generic log message. Launch lifecycle and user-created SQL triggers are part of the migrations, so they continue recording after migration even when `ACQUISITION_ENABLED` is off.

The preview gateway keeps its isolated routing database. It reports document observations through the existing private `CONTAINER_ACCOUNT` binding; the API worker checks the Durable Object owner and live preview route before writing to the account database. This internal observation path has no public HTTP route. Preview and generic running-container observations are best effort during storage or binding outages; another view or snapshot retries the same event key. Managed launch events commit atomically with launch state.

## APIs and admin reads

`ACQUISITION_ENABLED=true` enables the acquisition HTTP APIs, running-container and preview observers, and billing projector. Repository submissions are limited to 20 per minute per client IP by `ACQUISITION_SUBMISSION_LIMIT`. Submission bodies are limited to 4 KB and accept only a repository, the 64-character intent token, and allowlisted attribution fields. GitHub metadata verification uses the existing optional `REPO_RUN_GITHUB_TOKEN`; no container is created by submission.

- `POST /acquisition/repositories`: trusted `Origin`, no account session. Returns `{ leadId, repo }` and never returns the intent token.
- `POST /acquisition/link`: trusted `Origin` and current browser session. Accepts only `{ token }`.
- `GET /admin/acquisition/leads` and `GET /admin/acquisition/events`: trusted `Origin` and a current browser session for `oneone@gmail.com`. Pages are limited to 100 rows; lead pages use an ID cursor and event pages use an exclusive sequence cursor. Filters include account, lead, and event type. Lead responses contain contact and attribution for review but never the token hash.

Example unique-account funnel counts:

```sql
SELECT
  COUNT(DISTINCT CASE WHEN event_type = 'lead.captured' THEN user_id END) AS captured_accounts,
  COUNT(DISTINCT CASE WHEN event_type = 'user.created' THEN user_id END) AS signups,
  COUNT(DISTINCT CASE WHEN event_type = 'workload.activated' THEN user_id END) AS activated_developers,
  COUNT(DISTINCT CASE WHEN event_type = 'developer.qualified' THEN user_id END) AS qualified_developers
FROM acquisition_events;
```

Net paid compute consumption, including signed corrections:

```sql
SELECT user_id,
  SUM(CAST(json_extract(payload, '$.paidMicroUsdDelta') AS INTEGER)) AS net_paid_micro_usd
FROM acquisition_events
WHERE event_type = 'compute.consumed_paid'
GROUP BY user_id;
```

## Rollout and operating notes

Apply migrations 021 and 022 before deploying the API, preview gateway, and web client. This workspace has not been deployed. The five-minute scheduled billing projector processes bounded batches and advances a fair per-account scan cursor; monitor the generic `acquisition_billing_projection_incomplete` and `acquisition_billing_projection_failed` logs. The projector can derive billing events from retained accounting ledger rows, but there is no historical signup or repository-launch backfill. Migration triggers only observe future user and launch writes.

Turning off `ACQUISITION_ENABLED` disables the HTTP routes, observers, and projector. SQL triggers installed by migrations 021/022 continue to record newly inserted user and managed launch lifecycle facts. Keep that behavior in mind when using the flag as an operational pause.
