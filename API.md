# Container automation API

Base URL: `https://api.mainbrella.com` (local API: `http://localhost:8787`).
The dashboard and automation share the same account-owned containers and allowance. An active paid plan or coupon trial is required.

## Authentication

Sign in at `https://mainbrella.com/login/`, open **Account → API Keys (`/api-keys/`)**, and create a named key. Copy the secret immediately; it is shown only once. Send it as `Authorization: Bearer mb_<key-value>` to container, execution, file, image, and SSH issuance endpoints. Keys stay valid until revoked, independently of browser sign-out, and remain subject to your account’s plan and quotas.

Manage keys using a browser session cookie:

- `GET /api-keys` lists names, prefixes, creation dates, and last-used dates without secrets.
- `POST /api-keys` with `{"name":"Deployment script"}` creates a key and returns `{key, token}` once (201). Names must contain 1–80 characters after trimming; each account can have up to 20 keys.
- `DELETE /api-keys?id=<key-id>` revokes a key. Subsequent requests with that key return 401.

Key creation and revocation require a trusted Origin. API keys cannot manage keys, authorize purchases, or change billing. Browser session Bearer credentials remain supported for compatibility; they expire after 30 days and are revoked by browser sign-out. Invalid credentials return 401 even if a valid cookie is also sent.

Bearer requests can omit Origin. If Origin is supplied, it must be allowlisted.
Browser clients continue using the session cookie and must send a trusted Origin
for mutations. Bearer authentication is limited to lifecycle, execution, files, images, and SSH issuance;
the browser WebSocket terminal remains cookie-authenticated with a trusted Origin.

Keep credentials in a secret store or protected local file, never in a repository,
URL, transcript, or log. Treat API keys as account access. For example, run the following in **bash** to create a temporary
header file without putting the value in shell history or curl's argument list:

```bash
API_URL=https://api.mainbrella.com
AUTH_FILE=$(mktemp)
chmod 600 "$AUTH_FILE"
trap 'rm -f "$AUTH_FILE"' EXIT
read -r -s -p 'Mainbrella API key: ' MAINBRELLA_API_KEY
printf '\n'
printf 'Authorization: Bearer %s\n' "$MAINBRELLA_API_KEY" > "$AUTH_FILE"
unset MAINBRELLA_API_KEY

# Check status and allowance before starting.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" "$API_URL/containers"

# Start one small container. No body selects the default Node image.
# Optionally send {"catalogId":"python"} using a deployed imageCatalog ID.
CREATE_KEY=$(node -e 'console.log(require("node:crypto").randomUUID())')
# Preserve CREATE_KEY and repeat the same POST to recover an ambiguous result.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -H "Idempotency-Key: $CREATE_KEY" -X POST "$API_URL/containers"

# Replace ID and generation below with values from the successful launch response.
# Run a command over HTTP; no local SSH tools are needed.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -H 'Content-Type: application/json' -d '{"command":"echo hello from mainbrella","timeoutMs":30000}' -X POST "$API_URL/containers/exec?id=<returned-id>&createdAt=<returned-createdAt>"

# Stop only the selected container when finished.
curl --fail-with-body --silent --show-error --header "@$AUTH_FILE" -X DELETE "$API_URL/containers?id=<returned-id>&createdAt=<returned-createdAt>"
```

Only run the operations needed for the task. The four examples are separate
requests, not a script to launch and immediately stop a container. For unattended
use, provision the protected header file through your secret manager and keep it
for the authorized job's duration.

## Agent setup and verification

The [published skill](https://mainbrella.com/SKILL.md) guides project detection,
integration, and troubleshooting. Provision `MAINBRELLA_API_KEY` through your
existing secret manager or environment loader; never put it into chat or commit it.
No Mainbrella SDK is published yet. Use native HTTP requests for lifecycle,
command execution, and file transfer; local SSH tools are optional for interactive access.
Local dependency-free SDK packages are available in this backend repository at
`sdk/javascript` and `sdk/python`; their READMEs describe local installation. Do
not assume these names can be installed from public npm/PyPI registries.

Download and inspect the dependency-free Node 22+ tools:

```sh
curl --fail --silent --show-error https://mainbrella.com/mainbrella-doctor.mjs -o mainbrella-doctor.mjs
curl --fail --silent --show-error https://mainbrella.com/mainbrella-verify.mjs -o mainbrella-verify.mjs
node mainbrella-doctor.mjs
# This creates a container and consumes one start. Run after the doctor passes.
node mainbrella-verify.mjs
```

Keep both scripts in the same directory. The doctor performs only GET requests,
checks access, quotas, image availability, HTTP execution/file routes, Node version, and project markers, and
never prints credentials. Both commands print JSON and exit 0 for a pass or 1
for a failure. `MAINBRELLA_API_URL` can select another HTTPS API origin, or HTTP
localhost for development. `MAINBRELLA_CATALOG_ID` selects an advertised image for
verification; it defaults to `node`.

Verification runs `echo "hello from mainbrella"`, checks stdout and exit code 0,
writes and reads a six-byte binary probe under `/tmp`, and compares every byte.
It deletes the newly created generation in `finally`. Pass requires
`ok: true`, `files: "verified"`, and `cleanup: "completed"`. It preserves pre-existing containers.
It uses a unique idempotency key and the returned `creation` identity, so concurrent
launches cannot confuse ownership. It retries the same operation up to three times
on a lost response or a `starting` result. Unresolved startup produces
`creation_ambiguous` and `cleanup: "reconcile_manually"`, with `creationKey` for
recovery: repeat the same POST body and key within 24 hours. It never deletes a
machine by guesswork. Cleanup failures include the created ID and generation.

## Images

`GET /containers` includes `imageCatalog: [{id, name}]` for images actually
published by the deployment. Catalog definitions alone do not guarantee availability.
Supported catalog IDs are `node`, `python`, `rust`, `go`, and `devops` when advertised.
`POST /containers` accepts either `{"catalogId":"python"}` or
`{"imageId":"<owned-ready-image-id>"}`, never both. An omitted body uses the
Node image. These choices do not change plan resource sizes or deadlines.

| Method and path | Result |
| --- | --- |
| `GET /images` | Owned images, `buildsEnabled`, build `limits`, and monthly `usage`. |
| `POST /images` | Multipart `name`, text `dockerfile`, and optional file `context`; returns 202 `{image}`. Builds must be enabled. |
| `GET /images/{id}` | Owned image `{image}` with status `queued`, `building`, `publishing`, `ready`, or `failed`. |
| `GET /images/{id}/logs` | `{logs, status}` for an owned build. |
| `DELETE /images/{id}` | Deletes an owned image; active builds cannot be deleted. Existing running containers remain. |

Dockerfiles must start with `FROM mainbrella:base` (after optional comments), use
one build stage, and be at most 16 KiB. Optional context is a `.tar.gz` file of at
most 512 KiB. Read returned limits instead of assuming allowance; currently up to
10 builds per UTC month, 3 saved images, and a 300-second build deadline.
Launch custom images only after status is `ready`; inspect logs for a failed build.

## Endpoints

| Method and path | Result |
| --- | --- |
| `GET /containers` | 200: current containers, effective plan, limits, and usage. Does not renew idle time. |
| `POST /containers` | 200: reserves a start and boots the selected machine size (default lite) using the default Node image or optional JSON `{catalogId, size}` / `{imageId, size}` selection; returns status after readiness. 402 without paid access; 409 if the concurrency cap is occupied; optional `Idempotency-Key` resolves retries to one reservation for 24 hours and adds `creation` identity/status; 429 if monthly starts are exhausted. |
| `DELETE /containers?id=<id>&createdAt=<generation>` | 200: stops the selected container and returns status. Generation is optional but recommended to reject stale actions. An explicit ID is required when multiple containers exist. Does not refund starts. |
| `POST /containers/exec?id=small&createdAt=<ISO generation>` with `{"command":"echo hello","timeoutMs":30000}` | 200: `{stdout, stderr, exitCode, timedOut, outputTruncated}`. ID and exact generation are required. Runs a foreground `/bin/sh -lc` command without SSH or a PTY. |
| `GET /containers/files?id=<id>&createdAt=<generation>&path=<absolute-path>` | 200: raw `application/octet-stream` bytes for a regular file, up to 1 MiB. ID, exact generation, and URL-encoded path are required. |
| `PUT /containers/files?id=<id>&createdAt=<generation>&path=<absolute-path>` with a raw byte body | 200: `{path, size}` after writing up to 1 MiB. An empty body creates an empty file. Requires an existing parent directory. |
| `POST /containers/ssh` with `{"id":"small","createdAt":"<ISO generation>"}` | 200: `{command, expiresAt, hostname}` for the selected running container. Generation is optional. `expiresAt` is Unix milliseconds. Access lasts at most 15 minutes or until hard container expiry, whichever comes first. |

Lifecycle response example (UTC timestamps and usage month):

```json
{
  "plan": "builder",
  "active": true,
  "containers": [{
    "id": "small",
    "name": "Small container",
    "size": "lite",
    "computeUnits": 1,
    "instance": "lite",
    "status": "running",
    "createdAt": "2026-10-05T12:00:00.000Z",
    "expiresAt": "2026-10-05T13:00:00.000Z"
  }],
  "limits": {
    "maxComputeUnitHours": 250,
    "maxConcurrentComputeUnits": 28,
    "maxContainers": 5,
    "maxStartsPerMonth": 1000,
    "maxSessionMs": 3600000,
    "idleTimeoutMs": 600000
  },
  "usage": {"month": "2026-10", "starts": 1, "computeUnitHours": 0, "reservedComputeUnitHours": 1, "availableComputeUnitHours": 249, "concurrentComputeUnits": 1}
}
```

The response also includes a `sizes` catalog (omitted above for brevity). `containers` is empty when stopped. During a concurrent launch, a reserved slot
may appear with `status: "starting"`; terminal and SSH access require `running`.
Unpaid status has `plan: null`, `active: false` and zero limits. An unpaid first
start returns 402 without provisioning or consuming quota. If an existing billing
record is now unpaid, an attempted start also triggers background revocation of
that account's existing containers.

| Plan | USD/month | Concurrent containers | Starts/UTC month | Hard limit | Idle timeout |
| --- | ---: | ---: | ---: | --- | --- |
| Builder | $5 | 5 | 1,000 | 1 hour | 10 minutes |
| Pro | $180 | 100 | 10,000 | 24 hours | 30 minutes |
| Scale | $999 | 500 | 100,000 | 72 hours | 60 minutes |

All plans offer five sizes with bash, tmux and outbound internet. `POST /containers` accepts `size`: `lite` (default), `small`, `medium`, `large`, or `xl`. Size is included in the idempotency fingerprint. The default image includes Node 24; other runtimes depend on the selected image. All include SSH and browser terminals. A container permits four concurrent
terminal connections (browser/SSH combined). An account permits ten live SSH
access tokens, each lasting at most 15 minutes or the machine deadline. Snapshots,
resume after stop, custom resources, SDKs, teams, advanced logs/audits and priority
capacity are unavailable. Monthly fees are fixed; compute usage is not billed.
The filesystem is lost when a container stops.

Ownership and resources come from the authenticated account and server policy.
Request bodies and client headers cannot override the owner, plan, registry image, raw resource configuration,
slots or deadlines. The named `size` field selects a server-defined size. IDs returned by status select only the authenticated account's
slots. Arbitrary `/containers/<id>` routes are rejected. All sessions of the same
account share the same concurrency and UTC monthly quota.

The account serializes reservations before booting, so concurrent launches never
exceed its cap. Readiness can proceed in parallel. Failed starts still consume a
reservation; stopping early does not refund usage. Quota persists across stops,
restarts, upgrades, downgrades, cancellation and resubscription, and resets at the
next UTC month. At capacity, additional POSTs return 409 without spending usage.

A successful payment for the current recognized plan period is required. Unapproved Stripe trials,
failed payments, expired periods, paused/canceled subscriptions and stale database
plan fields grant no access. Stripe outages return 503 instead of guessing a plan.
DELETE cleanup remains available during billing outages. Hard deadlines are fixed
at creation and capped by the original paid period; upgrades and renewals never
lengthen existing sessions. Start a new container after that deadline.
Downgrades/cancellation take effect at the end of the paid period. On an effective
downgrade, excess machines stop (oldest unexpired machines within the cap remain) and deadlines
are clamped; loss of paid access stops all machines. Polling/token issuance do not
renew idle time; terminal activity renews only the idle deadline.

## HTTP command execution

`POST /containers/exec` requires an owned, running `id` and its exact `createdAt`
in the query. Cookie mutations require a trusted Origin; API keys work without
Origin. The JSON body accepts only `command` and optional `timeoutMs`.
A command must be nonblank, contain no NUL, and fit in 16 KiB of UTF-8; the whole
request is limited to 32 KiB. No user, image, resource, or lease overrides are accepted.

The timeout defaults to 30 seconds, accepts integers from 1 to 60,000 ms, includes
process startup, and never exceeds the container's hard deadline. The command
gets closed stdin and separate UTF-8 stdout/stderr, with a combined limit of 1 MiB.
Normal completion returns an integer `exitCode`, including nonzero command exits.
Timeout and excess output terminate the process and return partial output with
`exitCode: null` and `timedOut: true` or `outputTruncated: true`, respectively.
Both flags are false on normal completion. Output ordering between streams is
not preserved; invalid UTF-8 is replaced when decoded.

Four HTTP commands can run concurrently per container, separately from terminal
connections. Starting a command counts as idle activity without extending the
hard deadline or consuming a start. Stopping/replacing a machine revokes commands.
A disconnect requests cancellation when observable; the timeout still applies
when the platform does not propagate a disconnect. Background jobs and reconnect
are not supported. Results are not retained. An HTTP failure can hide a completed
command: do not blindly retry commands with side effects. SSH remains available
for longer-running and interactive workflows.

## HTTP files

File requests require an owned, running, paid generation, checked again immediately
before the guest process starts. Send raw bytes with `Content-Type: application/octet-stream`
for PUT; consume GET as bytes (`response.arrayBuffer()` in JavaScript), not JSON or text.
Both uploads and downloads are limited to 1 MiB. Oversized uploads are rejected before
writing, and oversized reads return an error without partial data. Paths must be absolute,
at most 4096 UTF-8 bytes, with no NUL, empty, `.` or `..` segments. URL-encode all query values.
Paths refer to the owned guest filesystem; `/workspace` is a convention, not an access boundary.

GET reads regular files and follows symlinks inside the guest. PUT writes a temporary
file beside the destination and atomically replaces it; it rejects directories and
existing symlinks. New files use mode 0600; replacement preserves permission bits.
Parent directories are not created automatically. Use HTTP execution for directory
creation and listing until dedicated directory APIs are available.

Runtime file operations are bounded by 30 seconds and the hard container deadline,
share the four-command execution pool, and renew idle activity. Disconnect or stop
requests cancellation. A lost response may hide a completed write; read to reconcile
before retrying. Files are ephemeral and disappear when the machine stops. Custom
images must retain `/bin/sh` and GNU coreutils, supplied by Mainbrella's base image.

```js
// sandbox is the running creation identity; apiKey stays in a server environment.
const query = new URLSearchParams({
  id: sandbox.containerId, createdAt: sandbox.createdAt, path: '/workspace/input.bin',
});
const url = `https://api.mainbrella.com/containers/files?${query}`;
const headers = { Authorization: `Bearer ${apiKey}` };
const upload = await fetch(url, {
  method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream' },
  body: new Uint8Array([0, 128, 255]),
});
if (!upload.ok) throw new Error(`Upload failed: ${upload.status}`);
const download = await fetch(url, { headers });
if (!download.ok) throw new Error(`Download failed: ${download.status}`);
const bytes = new Uint8Array(await download.arrayBuffer());
```

## Browser billing endpoints

Billing mutations require the login cookie and a trusted browser Origin.
Bearer automation credentials do not authorize purchases or plan changes.

| Method and path | Result |
| --- | --- |
| `GET /subscription/config` | Public server plan definitions and billing availability. |
| `GET /subscription` | Current Stripe subscription, paid `active`, `plan`, `valid_until` (Unix ms), `scheduled_plan`, and `scheduled_change_at` (Unix seconds). |
| `POST /subscription/checkout` with `{"plan":"builder"}` | Creates/reuses account-owned embedded checkout; rejects an existing live subscription. |
| `POST /subscription/complete` with `{"session_id":"cs_..."}` | Verifies owned checkout completion and current paid entitlement. |
| `POST /subscription/portal` with `{"plan":"pro"}` | Stripe confirmation URL for an upgrade with immediate invoiced proration. |
| `POST /subscription/portal` with `{}` | Payment methods and invoice history portal URL. |
| `POST /subscription/change` with `{"plan":"builder","confirm":true}` | Schedules a downgrade for renewal. Select the current plan to remove a scheduled downgrade. |
| `POST /subscription/cancel` with `{"confirm":true}` | Cancels at paid period end and removes a pending downgrade. |
| `POST /subscription/resume` with `{}` | Resumes a subscription pending period-end cancellation. |
| `POST /subscription/webhook` | Stripe signature authenticated; private integration for live reconciliation. |

Use the web billing controls for explicit user confirmation. Never perform a
purchase, plan change or cancellation as part of an ordinary container job.

## Errors and retry behavior

Errors are JSON `{ "error": "code" }`. Handle HTTP status as well as the code.

| Status | Code | Action |
| --- | --- | --- |
| 400 | `invalid_container_id` / `container_id_required` | Select an ID returned by GET; supply it when multiple containers exist. |
| 400 | `invalid_generation` / `invalid_file_path` | Send the exact returned creation timestamp and a valid absolute file path. |
| 401 | `not_authenticated` | API key or session missing, malformed, expired, or revoked. Provision a valid credential. |
| 402 | `subscription_required` | No paid container access. Use the web billing controls to subscribe or resolve payment; do not retry creation. |
| 403 | `origin_required` / `origin_not_allowed` | Cookie mutations need a trusted Origin; Bearer requests may omit it. Supplied Origins must be trusted. |
| 404 | `not_found` | Use the exact documented route; no arbitrary container IDs. |
| 413 | `request_too_large` | HTTP execution body exceeds 32 KiB. |
| 413 | `file_too_large` | File transfer exceeds 1 MiB. Use authorized SSH for larger files. |
| 404 | `file_not_found` | Check the file path; for writes, create the parent directory first. |
| 409 | `not_regular_file` | Use a regular file; writes also reject existing symlinks. |
| 403 | `file_access_denied` | Check guest filesystem permissions and available disk space. |
| 405 | `method_not_allowed` | Use the documented HTTP method. |
| 409 | `container_limit_exceeded` | The plan's concurrency cap is occupied. GET status and reuse it, or stop it only if the task authorizes replacement. |
| 404 | `image_not_found` | Choose an advertised catalog ID or an owned custom image. |
| 409 | `image_not_ready` / `image_not_available` | Wait for custom-image readiness or choose a currently published catalog image. |
| 409 | `container_not_running` | Execution, files, and SSH need the exact live generation; GET status before deciding whether to start. |
| 429 | `container_quota_exceeded` | The plan's starts are exhausted this UTC month. Wait for next month; do not retry or create another account to evade the limit. |
| 429 | `terminal_limit` | Four terminal connections are attached to this container. Close or reuse an existing connection. |
| 429 | `execution_limit` | Four HTTP command/file operations are already active on this container. Wait for completion. |
| 429 | `ssh_token_limit` | Ten live SSH access tokens for this account. Reuse existing access or wait for expiration. |
| 503 | `billing_unavailable` / `containers_unavailable` / `ssh_unavailable` / `execution_unavailable` / `files_unavailable` | Service unavailable. Reconcile with GET before any further launch; read a file to reconcile an uncertain write. |

Use `Idempotency-Key` on `POST /containers` for safe creation retries. Keys accept
1–128 letters, digits, underscores or hyphens, are scoped to the authenticated
account, and are retained for 24 hours from reservation. Repeat the same key and
image selection after a timeout or 503; this resolves to the original operation
without another charge or boot. A keyed 200 response adds
`creation: {id, containerId, createdAt, status}`. `id` identifies the operation;
`status` is `starting` or `running`. Wait for `running` before using the returned
container ID and exact generation for execution or cleanup. Other entries in
`containers` may belong to concurrent work.

A changed image selection returns 409 `idempotency_key_conflict`. If the original
reservation failed, stopped, expired, or its slot was reused, retries return 409
`creation_no_longer_running` with `creation: {id, containerId, status: "stopped"}`;
they never launch a replacement. Failed starts still consume quota. After 24 hours,
a key may create a new operation; use a new key for each intentional launch and
never retry an old operation beyond that window. Billing and authorization checks
still apply. Without a key, each POST may reserve a new start: reconcile with GET
after an ambiguous result and do not blindly retry. Allow at least 60 seconds for
the readiness check.

SSH tokens stop working when
the container stops or is recreated; do not print the returned token-bearing
command in shared logs. Use HTTP execution for bounded foreground jobs. Use the returned SSH command
with trusted `ssh` and `cloudflared` tools for interactive or longer jobs.

## Card-free trial coupons

`POST /subscription/trial` with `{"plan":"builder","code":"<promo-code>"}` requires a login cookie and trusted browser Origin. It returns the same subscription state as `GET /subscription`, with `trial: {plan, expires_at}` (Unix milliseconds), `active: true`, and `valid_until` capped to trial expiry. Codes are case insensitive and may be redeemed on `/pricing/:slug` before entering payment details. This is an application trial, with no Stripe subscription or automatic charges. Subscribe separately to continue after expiry; paid subscriptions supersede trial access. Ordinary Stripe trials still grant no access.

Apply migration `009_trial_coupons.sql` before deploying. From the backend directory, issue a code using:

```sh
npm run coupon:create -- --local builder 14 100 2026-12-31T23:59:59Z
```

Use `--remote` to issue a production code after migrating production. The command generates a random code and stores only its SHA-256 hash. Select plan, trial length (1–90 days), maximum redemptions, and redemption deadline explicitly. No codes are enabled by default. Disable future redemptions with `UPDATE trial_coupons SET enabled = 0 WHERE code_hash = '<hash>';` using your database tooling. Disabling a code does not revoke already granted trials.

Each account may redeem one trial ever. Retrying the same valid redemption returns the original deadline, without extending access or consuming another use. The redemption cap and account uniqueness are enforced atomically. An existing live Stripe subscription blocks redemption. Invalid, expired, disabled, exhausted, or wrong-plan codes return 400 `invalid_promo_code`; an account that used a trial returns 409 `trial_already_used`. Trials share the plan's normal account quotas, and containers/SSH/terminals remain capped to trial expiry.

## Capability discovery

`GET /capabilities` is public and accepts no query parameters. Its `apiVersion`
identifies the contract. Execution/file limits come from the runtime's shared
constants. Unsupported persistence, preview, filesystem-directory and network
policy features are explicit. `images.customBuilds` reflects configured build
credentials; it does not establish build-service health. Resources currently
advertise all five machine sizes. Regions are not selectable.

Use authenticated `GET /containers` for account allowances, usage, running
generations and the deployed `imageCatalog`. New generations include
`imageDigest`, the server-resolved image reference; older generations may omit it.
Capability discovery does not contact Stripe or reserve a start.

## Managed execution and streaming

Use `POST /containers/executions?id=<id>&createdAt=<generation>` with a required
`Idempotency-Key` and `{"command":"<shell command>","timeoutMs":30000}`. It returns
202 with an execution record containing `id`, `createdAt`, timestamps, `status`,
`retainUntil` (Unix milliseconds), `cursor`, `outputBytes`, `exitCode`, `timedOut`
and `outputTruncated`. The command and creation key are not returned.

Matching key/command/timeout retries within the same generation return the retained
execution. Changed options return 409 `idempotency_key_conflict`. Retention lasts
one hour from admission, with 32 records per container; when full, a new job returns
429 `execution_history_limit`. After retention expires, a key can launch new work.
Preserve the key and never retry an old operation beyond its retention window.

Managed commands run `/bin/sh -lc`, default to 30 seconds, allow up to 15 minutes,
and remain bounded by the hard container deadline. They share four active
operations with foreground commands and files. Active jobs renew idle activity.
Output stops at 1 MiB combined stdout/stderr or the bounded output-event count.
Client disconnect does not cancel the job.

- `GET /containers/executions/<execution-id>?id=<id>&createdAt=<generation>` returns
  current state plus retained `stdout` and `stderr`.
- `DELETE` at the same URL requests cancellation and returns 202. Poll until a
  terminal state; cancellation of a completed job has no effect.
- `GET /containers/executions/<execution-id>/events?id=<id>&createdAt=<generation>&cursor=0`
  streams SSE output. stdout/stderr events carry `{type,sequence,data}` and an SSE
  `id` equal to `sequence`. Resume with the last received sequence as `cursor`.
  A cursor ahead of retained output returns 400 `invalid_cursor`.

SSE connections emit heartbeat comments, rotate after 30 seconds, and end with a
`status` event containing execution metadata. Reconnect after a nonterminal status;
stop after `succeeded`, `failed`, `canceled`, `timed_out`, `output_limit` or
`interrupted`. At most eight streams attach to a container. Closing a stream only
detaches. Results and cancellation remain available to the authenticated owner
after the container stops and during billing outages, until retention expires.
Expired, foreign-generation or missing records return 404 `execution_not_found`.

New execution admission requires paid access and a running generation. On a
runtime restart, unfinished jobs become `interrupted` and their matching container
generation stops to revoke orphan processes. This can terminate other work on that
generation. Jobs are never replayed automatically. Filesystem/process persistence
across stop or restart is not supported.

## Public operational status

`GET /status` returns overall `state`, `generatedAt`, `staleAfterMs`, seven component
observations and up to 50 incidents, with active incidents first. Components are website, API, authentication,
provisioning, SSH, images and billing. Observations include `scope` (reachability,
control plane or synthetic workflow), latency and timestamp. Missing evidence or
evidence older than 15 minutes becomes unknown. Active incidents prevent an overall
operational state. No credentials or account information appear in public status.

`GET /status/history` returns up to 100 observations with 31-day retention. Filter
by `component`; paginate using returned `next.before` and `next.beforeId` together.
No availability percentage is inferred from missing samples.

`POST /internal/status/observations` and `/internal/status/incidents` require the
dedicated `MONITORING_SECRET` Bearer credential. Account API keys are not accepted.
The first accepts `{observations:[{component,state,scope,latencyMs?}]}` with at most
seven distinct components and a server-assigned timestamp. The second accepts
`{id,component,title,state,message}`; id is a UUID and state is investigating,
identified, monitoring or resolved. An incident cannot change component or reopen
after resolution. Incident text is public.


## Machine sizes and compute allowance

| Size | Cloudflare instance | vCPU | RAM | Disk | Compute units/hour |
| --- | --- | --- | --- | --- | --- |
| lite | lite | 1/16 | 256 MiB | 2 GB | 1 |
| small | standard-1 | 0.5 | 4 GiB | 8 GB | 6 |
| medium | standard-2 | 1 | 6 GiB | 12 GB | 10 |
| large | standard-3 | 2 | 8 GiB | 16 GB | 16 |
| xl | standard-4 | 4 | 12 GiB | 20 GB | 28 |

Builder includes 250 compute-unit hours/month and 28 concurrent units; Pro 9,000 and 128; Scale 50,000 and 640. Container ceilings and monthly start safeguards (1,000 / 10,000 / 100,000) also apply. Monthly usage resets on the UTC calendar month, without rollover.

Create with `{"catalogId":"node","size":"medium"}`. `GET /containers` returns `sizes`, `limits.maxComputeUnitHours`, `limits.maxConcurrentComputeUnits`, and `usage.computeUnitHours`, `reservedComputeUnitHours`, `availableComputeUnitHours`, and `concurrentComputeUnits`. Runtime is reserved durably before provisioning; unused runtime is released on a reconciled stop. Used hours include provisioning and idle time. Ambiguous starts retain reservations until reconciliation. Capacity rejection does not reserve usage. Machines receive an immutable budget deadline and stop at the earliest of that deadline, idle/session/paid-access expiry, or the UTC month boundary. Clients must honor returned `expiresAt`.

Errors: 400 `invalid_size`; 409 `compute_capacity_exceeded`; 429 `compute_allowance_exhausted`. A changed size with an existing creation key returns 409 `idempotency_key_conflict`. No automatic overages or top-ups are enabled.
