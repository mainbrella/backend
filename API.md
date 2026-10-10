# Container automation API

Base URL: `https://api.mainbrella.com` (local API: `http://localhost:8787`).
The dashboard and automation share the same account-owned containers and allowance. Prepaid funding, an existing paid legacy plan, or a coupon trial is required.

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
The dependency-free SDKs are published as `@mainbrella/sdk` 0.1.0 on npm
and `mainbrella` 0.1.0 on PyPI. See the
[JavaScript](https://mainbrella.com/sdk/javascript.md) and
[Python](https://mainbrella.com/sdk/python.md) references for installation and APIs.
Native HTTP remains sufficient for lifecycle, execution and file transfer;
local SSH tools are optional for interactive access.

Download and inspect the dependency-free Node 22+ tools:

```sh
curl --fail --silent --show-error https://mainbrella.com/mainbrella-doctor.mjs -o mainbrella-doctor.mjs
curl --fail --silent --show-error https://mainbrella.com/mainbrella-verify.mjs -o mainbrella-verify.mjs
node mainbrella-doctor.mjs
# This creates a container and consumes one start. Run after the doctor passes.
node mainbrella-verify.mjs
```

For a project with an existing ignored `.env`, use Node’s built-in loader:
`node --env-file=.env mainbrella-doctor.mjs` (likewise for verification/deployment).
Never copy the key into the guest or expose it through a Vite `VITE_*` variable
or client bundle. Keep both scripts in the same directory. The doctor checks
readiness for the full verification suite, including managed execution, SSE,
reconnect and cancellation. It performs only GET requests,
checks access, quotas, image availability, HTTP execution/file routes, Node version, and project markers, and
never prints credentials. Both commands print JSON and exit 0 for a pass or 1
for a failure. `MAINBRELLA_API_URL` can select another HTTPS API origin, or HTTP
localhost for development. `MAINBRELLA_CATALOG_ID` selects an advertised image for
verification; it defaults to `node`.

When the user supplies a credential variable and origin explicitly, keep that
pair throughout doctor, verification, and deployment. For a local key stored as
`MAINBRELLA_LOCAL_API_KEY`, load the existing `.env` and map that value to
`MAINBRELLA_API_KEY` only in the tool process, with
`MAINBRELLA_API_URL=http://localhost:8787`. The tools still read their standard
variable names. Do not rewrite `.env`, request a second key, or fall back to the
production origin with the local credential.

Verification runs `echo "hello from mainbrella"`, checks stdout and exit code 0,
writes and reads a six-byte binary probe under `/tmp`, and compares every byte.
It also starts a managed job, consumes SSE output (resuming the last cursor if
disconnected), checks the retained result, then starts `sleep 30`, cancels it
and polls for `canceled`. Foreground, background, streaming, reconnect,
cancellation and binary read/write capabilities are required. All checks share
one new container/start. It deletes that generation in `finally`. Pass requires
`ok: true`, `stdout: "hello from mainbrella"`, `exitCode: 0`, `files: "verified"`,
`managed: "verified"`, `cancellation: "verified"`, and `cleanup: "completed"`.
It preserves pre-existing containers. The static deployment helper below checks
only its own required capabilities; a separate full verification is not a
prerequisite for every deployment and consumes an additional start.
It uses a unique idempotency key and the returned `creation` identity, so concurrent
launches cannot confuse ownership. It retries the same operation up to three times
on a lost response or a `starting` result. Unresolved startup produces
`creation_ambiguous` and `cleanup: "reconcile_manually"`, with `creationKey` for
recovery: repeat the same POST body and key within 24 hours. It never deletes a
machine by guesswork. Cleanup failures include the created ID and generation.

Budget verification and deployment separately. Setup verification followed by a
two-container app consumes three starts: the verifier cleans up its own generation
in `finally`, while a successful deployment leaves its two app generations running
for use. Save identities and provide an explicit cleanup command; report the app
leases and preview expiration separately from the verifier's cleanup result.

## Compiled application deployment

An advertised image can run a compiled binary even when it lacks the source
language's compiler. This is an optional fallback when the requested runtime
image is unavailable. Confirm the guest OS and architecture (for example with
`uname -s` and `uname -m`) and any shared-library requirements. Do not infer the
guest architecture from the local computer or assume every binary is portable.

Build locally using the project's existing toolchain and dependency conventions,
targeting the guest platform. The local Go/SQLite example uses a pure-Go SQLite
driver and `GOOS=linux GOARCH=amd64 CGO_ENABLED=0`; a CGO-based driver may need a
different build environment and matching runtime libraries. Local compilation
also avoids putting a build workload into a 256 MiB Lite guest.

Upload through generation-qualified `PUT /containers/files` in chunks of at most
1 MiB, concatenate in order, and verify the complete binary's SHA-256 against the
local artifact before execution. File uploads create mode 0600; set executable
permissions explicitly. Reconcile uncertain writes before retrying. Start the
server with an execution mode appropriate to its lifetime: managed jobs are
limited to 15 minutes; the detached `setsid nohup` pattern in the static-site
recipe remains bounded by the container lease. Check HTTP readiness before
issuing a preview, and save generation-qualified cleanup instructions.

## Static-site deployment over HTTP

This produces a **temporary preview**, not persistent hosting. The preview expires
no later than the container's hard lease; inactivity can stop the container sooner.
Ordinary stop discards the upload. Report the returned preview `expiresAt` beside
the URL, rather than calculating expiration from the requested TTL. Container IDs
are opaque: an ID such as `small` does not establish the requested machine size.

The [dependency-free Node 22+ helper](https://mainbrella.com/mainbrella-deploy-static.mjs)
is also included as `scripts/mainbrella-deploy-static.mjs` in the skill archive.
It uses native HTTP, a local `tar` executable, and a catalog Node guest with
`node`, `tar`, `setsid`, and `nohup`. It checks guest utilities before uploading;
these are prerequisites of this recipe, not a guarantee for every catalog image.
It does not require SSH, an SDK, `curl`, `ps`, or `sha256sum` in the guest.
Build locally using the existing package manager; the Lite guest only serves
public static output. This helper does not run framework servers or provide SPA
history fallback. Include only files intended for public access in `dist/`.

```sh
# Download and inspect the helper before running it.
curl --fail --silent --show-error https://mainbrella.com/mainbrella-deploy-static.mjs -o mainbrella-deploy-static.mjs
# Preserve the project's package manager and build command.
npm run build
# Keep .mainbrella/ ignored and private. New directories use 0700, state uses 0600.
# Remove --env-file=.env if credentials already come from the environment.
node --env-file=.env mainbrella-deploy-static.mjs \
  --dist dist --state .mainbrella/deployment.json \
  --check /download/ --check /privacy/ --check /terms/ \
  --check /dryerasiac.css --check /images/logo.png
# Add --check /assets/<actual-built-file>.js for the JS emitted by this build.
```

Check paths are examples: select paths that exist in the actual build. Root is
always checked; `--check` adds pages or assets and compares exact bytes with the
local files. Directory paths must end in `/`; their bare path must return a 308
redirect to the directory. A generated missing path must return 404. This checks
HTTP serving through the preview gateway; it does not prove browser rendering
or JavaScript behavior. Perform a browser check when that matters to the task.

The helper follows this workflow:

1. Validate local static files (reject symlinks), create a gzip tar archive, and
   check foreground execution, binary files, previews, Node image and allowances.
2. Save a UUID creation key and exact `{catalogId:"node",size:"lite"}` selection
   before POST. Retry the same key/body at most three times for transport/5xx or
   `starting` responses. Known 4xx errors stop immediately. This is one logical
   start; unresolved or failed starts may still consume allowance.
3. Save returned ID, exact `createdAt` generation, hard expiration and upload
   directory. Upload sequential chunks of at most `1024 * 1024` bytes through
   `PUT /containers/files`, with generation-qualified, encoded query values.
   For an uncertain PUT, read that file and compare SHA-256 before continuing.
4. Concatenate zero-padded chunks, compare the full archive's SHA-256 using Node
   crypto, and extract only after the hash matches. A roughly 13 MB static build
   can use this recipe without exceeding the per-file limit; compression may
   reduce the number of chunks. Chunking does not remove disk, memory, execution
   timeout or lease limits. The helper buffers the archive in memory and is meant
   for modest artifacts, not unbounded bulk transfers.
5. Upload the Node static server, then start it on `0.0.0.0:3000` with explicit
   detachment and redirected descriptors:

   ```sh
   setsid nohup node <upload-dir>/server.cjs <upload-dir>/site 3000 \
     > <upload-dir>/server.log 2>&1 < /dev/null &
   ```

   Wait one second, then probe `http://127.0.0.1:3000/` using native Node `fetch`,
   up to ten attempts with one-second request limits and 500 ms intervals.
   A successful shell exit alone does not prove server readiness. On failure,
   preserve the command result and inspect the final 8 KiB of `server.log` through
   Node before cleanup. Do not assume `ps` is installed. This startup recipe
   succeeded in a reported deployment; the earlier failure discarded diagnostics,
   so missing `setsid` or a startup race is not an established root cause.
6. Persist `previewPending:true`, request `{port:3000,ttlSeconds:900}`, save the
   one-time URL/metadata, then verify root, selected pages/assets, redirects and
   404 through that URL. The final JSON reports success, preview ID, actual ISO
   expiration, exact container generation and state path. It keeps the bearer
   URL in the private state file rather than stdout. Read it privately and share
   only with the requested recipient, alongside expiration and the idle limit.

The helper leaves success running and preserves failure for inspection. A failed
run can continue consuming compute until explicitly stopped or expired. It
refuses to overwrite existing state; it does not automatically resume commands,
launch a replacement, retry preview issuance, or clean up evidence.

State includes `apiOrigin`, `creationKey`, `creationBody`, `container:{id,createdAt}`,
`containerExpiresAt`, `step`, archive hash/chunk count, `uploadChunk`,
`lastCommand:{command,pending}` or `{command,result}`, bounded server-log result,
`apiError:{status,code,previewId}`, `previewPending`, preview metadata/URL,
`verifiedPaths` and cleanup status. Writes are atomic, mode 0600 and fsynced before
further mutations. Command diagnostics retain stdout, stderr, `exitCode`,
`timedOut` and `outputTruncated` privately; they must not enter shared logs.
HTTP errors expose status, allowlisted API code and validated reconciliation ID,
not raw server bodies. Unknown codes become `request_failed`.

Recovery before another start:

- If creation is unresolved, repeat the exact saved body/key within 24 hours.
  Resolve ownership from `creation.containerId` and `creation.createdAt`, not
  another task's container. Save the matching running identity before cleanup.
- If a command is still pending after a transport failure, inspect its effects
  and log on the exact generation before deciding whether to run it again.
- If preview issuance is pending, GET the generation's preview metadata and revoke
  its grants before another issuance. This helper owns a dedicated generation;
  do not revoke unrelated grants on a shared machine. A known
  `preview_reconciliation_required` supplies the ID for generation-qualified
  revocation. Do not retry POST blindly; URLs are not recoverable from listing.
- Preserve state and logs before stopping. Explicit cleanup removes only the
  saved generation and confirms its absence in the returned status:

  ```sh
  node --env-file=.env mainbrella-deploy-static.mjs \
    --cleanup --state .mainbrella/deployment.json
  ```

  If cleanup is uncertain, retain state and reconcile with GET `/containers`;
  never target a replacement in the same slot. Keep resolved state as diagnostic
  evidence; use a new state path for a deliberately new deployment.

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
| `GET /containers/files/list?id=<id>&createdAt=<generation>&path=<directory>&limit=100&offset=0` | 200: one sorted directory page, `{path, entries, nextOffset}`. |
| `GET /containers/files/stat?id=<id>&createdAt=<generation>&path=<path>` | 200: entry metadata; optional `followSymlinks=true` reads the target. |
| `POST /containers/files/mkdir?id=<id>&createdAt=<generation>` with `{path, recursive?, mode?}` | 200: creates a directory; missing parents require `recursive: true`. |
| `DELETE /containers/files/remove?id=<id>&createdAt=<generation>&path=<path>` | 200: removes a file, symlink or empty directory; nonempty directories require `recursive=true`. |
| `POST /containers/files/move?id=<id>&createdAt=<generation>` with `{path, destination}` | 200: moves to an unused destination without replacement or nesting. |
| `PATCH /containers/files/chmod?id=<id>&createdAt=<generation>&path=<path>` with `{mode: "0644"}` | 200: sets permission bits; leaf symlinks are rejected. |
| `GET /containers/events?id=<id>&createdAt=<generation>` | 200: bounded lifecycle events, stable IDs and cursor pagination. |
| `GET /containers/metrics?id=<id>&createdAt=<generation>` | 200: provider workload buckets or unobserved; disabled pending operator qualification. |
| `/containers/webhook?id=<id>&createdAt=<generation>` | GET reads configuration; PUT configures/rotates and returns a signing secret once; DELETE removes future deliveries. Disabled pending operator configuration. |
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

The response also includes a `sizes` catalog (omitted above for brevity). `containers` is empty when Ad Hoc containers stop; Production desired services remain visible with `status: "stopped"`. During a concurrent launch, a reserved slot
may appear with `status: "starting"`; terminal and SSH access require `running`.
Unpaid status has `plan: null`, `active: false` and zero limits. An unpaid first
start returns 402 without provisioning or consuming quota. If an existing billing
record is now unpaid, an attempted start also triggers background revocation of
that account's existing containers.

| Plan | Funding | Concurrent containers | Starts/UTC month | Hard limit | Idle timeout |
| --- | ---: | ---: | ---: | --- | --- |
| Prepaid (Ad Hoc) | $5 minimum top-up | 100 | 10,000 | 24 hours | 30 minutes |
| Builder (legacy) | $5/month | 5 | 1,000 | 1 hour | 10 minutes |
| Pro (legacy) | $180/month | 100 | 10,000 | 24 hours | 30 minutes |
| Scale (legacy) | $999/month | 500 | 100,000 | 72 hours | 60 minutes |

All plans offer five sizes with bash, tmux and outbound internet. `POST /containers` accepts `size`: `lite` (default), `small`, `medium`, `large`, or `xl`. Size is included in the idempotency fingerprint. The default image includes Node 24; other runtimes depend on the selected image. All include SSH and browser terminals. A container permits four concurrent
terminal connections (browser/SSH combined). An account permits ten live SSH
access tokens, each lasting at most 15 minutes or the machine deadline. Process
resume after stop, custom resources, teams, advanced logs/audits and
priority capacity are unavailable. New accounts fund compute with one-time payments; unused balance carries forward. Existing fixed-price subscriptions retain their terms.
Ordinary stop discards unsaved filesystem changes; save a workspace explicitly
to restore its filesystem into a fresh container.

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

A positive verified prepaid balance is required for prepaid access. Legacy access requires a successful payment for the current recognized plan period. Unapproved Stripe trials,
failed payments, expired periods, paused/canceled subscriptions and stale database
plan fields grant no access. Stripe outages prevent new funding and legacy payment verification; prepaid accounts may continue only within already confirmed funds.
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
when the platform does not propagate a disconnect. This foreground route has
no retained or reconnectable jobs; use `/containers/executions` for managed
background jobs, streaming and reconnect when advertised by `/capabilities`.
Foreground results are not retained. An HTTP failure can hide a completed
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
Parent directories are not created automatically. Use the capability-gated
directory operations below when supported by the deployment.

Runtime file operations are bounded by 30 seconds and the hard container deadline,
share the four-command execution pool, and renew idle activity. Disconnect or stop
requests cancellation. A lost response may hide a completed write; read to reconcile
before retrying. Ordinary stop discards unsaved files; save a workspace or export
outputs first. Custom
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

## Filesystem metadata and directories

Check `/capabilities` for `files.list`, `stat`, `mkdir`, `delete`, `move` and `chmod`
before using these additive routes. Every route requires the same exact `id` and
`createdAt` as file transfer, with account ownership, paid lease and generation
rechecked before launch. They share the four-operation pool, 30-second deadline
and idle renewal. No start is consumed. Root is accepted for list/stat only.
Paths must be well-formed UTF-8, absolute and at most 4096 bytes; empty, dot,
parent and NUL segments are rejected. Intermediate symlinks resolve inside the
owned guest. These are guest filesystem controls, not a `/workspace` jail.

`GET /containers/files/list` accepts `path`, optional `limit` (1–1000, default 100)
and `offset` (0–1,000,000, default 0). Entries are one level deep, sorted by UTF-8
filename bytes; child symlinks are not followed. A directory path may itself be
a symlink. Response: `{path, entries, nextOffset}`; null means the final page.
Pagination rescans the directory; changes between requests may duplicate or omit
entries. Sorting/scanning is bounded by the deadline, metadata by 1 MiB. Non-UTF-8
names return 409 `unsupported_file_name` rather than unusable replacement paths.

Each entry includes `name`, `path`, `type`, `size` in bytes, octal `mode`, numeric
`uid`/`gid`, and `modifiedAt` with second precision. Types include `file`,
`directory`, `symlink`, `fifo`, `socket`, `character`, `block` and `other`.
Symlinks include `linkTarget`. `GET /containers/files/stat` returns one entry and
inspects the link itself by default, including broken links. The optional query
`followSymlinks=true` dereferences it; a missing target returns 404.

Mutations return `{path, ok: true}`, plus `destination` for move or `mode` for chmod:

- `POST /containers/files/mkdir` takes JSON `{path, recursive?: boolean, mode?: string}`.
  Default final-directory mode is `0700`; missing parents require `recursive: true`.
  Parent modes follow the guest umask. Recursive creation of an existing non-symlink
  directory succeeds; existing leaf symlinks or non-directories conflict.
- `DELETE /containers/files/remove` takes query `path` and optional `recursive=true`.
  By default directories must be empty. A symlink is removed without deleting its
  target. Missing paths return 404. Recursive deletion can partly complete before
  interruption; inspect state before retrying.
- `POST /containers/files/move` takes JSON `{path, destination}`. The destination
  must be unused and its parent must exist. No overwrite or directory nesting.
  Symlinks are moved as links. Moves into the source subtree are rejected. Across
  filesystems, interruption can leave both source and destination; reconcile first.
- `PATCH /containers/files/chmod` takes query `path` and JSON `{mode: "0644"}`.
  Modes must be four octal characters from `0000` to `0777`; no owner changes,
  recursive chmod or setting special bits. Leaf symlinks are rejected.

Cookie mutations require a trusted Origin; Bearer automation may omit it. Unknown
and duplicate parameters and unexpected JSON fields are rejected. Operations
require bash, GNU coreutils, findutils and sed in the guest. A lost mutation
response can hide completed or partial effects; SDK helpers never retry them.
Documented errors include 404 `file_not_found`, 403 `file_access_denied`, 409
`not_directory`, `file_exists`, `directory_not_empty`, `symlink_not_allowed` or
`container_not_running`, 413 `directory_too_large`, 429 `execution_limit`, and
503 `files_unavailable`. Watchers and programmatic PTY remain separate work.

## Browser billing endpoints

Billing mutations require the login cookie and a trusted browser Origin.
Bearer automation credentials do not authorize purchases or plan changes.

| Method and path | Result |
| --- | --- |
| `GET /billing/config` | Public `{configured,minTopupCents:500,maxTopupCents:100000}`. |
| `GET /billing/balance` | `{balance}` with confirmed balance, available and reserved cents, monthly spending, production rate/runway and automatic recharge settings. |
| `POST /billing/topups` with `{"amountCents":2000,"requestId":"<uuid>"}` | Creates or recovers embedded one-time Stripe Checkout and returns `{client_secret,publishable_key,sessionId}`. Reuse the same UUID and amount after an uncertain response. |
| `POST /billing/topups/complete` with `{"sessionId":"cs_..."}` | Verifies account-owned Checkout and live succeeded/captured card payment, then applies funding by immutable payment identity. Returns 200 `{balance}` only after verified payment; pending returns 409 `payment_pending`, expired returns 409 `topup_expired`. |
| `POST /billing/settings` with `{"spendLimitCents":5000}` | Sets the USD monthly consumption cap; raising it adds no funds. |
| `POST /billing/settings` with `{"autoRecharge":{"enabled":true,"amountCents":2000,"monthlyLimitCents":10000}}` | Explicitly authorizes $20 automatic recharges up to $100 per UTC month and saving the verified card. Both amounts are $5–$1,000 and maximum must cover at least one recharge. Pending payments count toward authorization and never fund runtime. |
| `GET /subscription/config` | Legacy plan policy plus `prepaid_configured` and `billing_model`. |
| `GET /subscription` | Effective entitlement; prepaid uses internal `plan:"usage"` with `subscription:null`. Existing legacy subscribers retain live Stripe reconciliation. |
| `POST /subscription/complete` with `{"session_id":"cs_..."}` | Reconciles a previously issued legacy subscription Checkout. |
| `POST /subscription/portal` with `{}` | Existing legacy payment methods and invoice history portal URL. |
| `GET /subscription/usage` | Existing legacy usage-subscription billing-period information. |
| `POST /subscription/cancel` with `{"confirm":true}` | Cancels at paid period end and removes a pending downgrade. |
| `POST /subscription/webhook` | Stripe signature authenticated; credits successful prepaid purchases and revokes refunded/disputed funding using live charge state. Existing legacy invoices and entitlement events remain supported. |

When `STRIPE_PREPAID_PRICE_ID` is configured, recurring Checkout, plan changes,
upgrades, resumption and legacy cap mutation return 409 `prepaid_billing_required`.
New purchases do not create a monthly subscription. Each dollar paid adds one
dollar of balance. Repeated $5 purchases and a larger single purchase have the
same value, compute prices and account limits; $180 funds the same balance as
36 purchases of $5, and $1,000 funds the same balance as 200 purchases of $5.

Use the web billing controls for explicit user confirmation. Never perform a
purchase, plan change or cancellation as part of an ordinary container job.

## Errors and retry behavior

Errors are JSON `{ "error": "code" }`. Handle HTTP status as well as the code.

| Status | Code | Action |
| --- | --- | --- |
| 400 | `invalid_container_id` / `container_id_required` | Select an ID returned by GET; supply it when multiple containers exist. |
| 400 | `invalid_generation` / `invalid_file_path` | Send the exact returned creation timestamp and a valid absolute file path. |
| 401 | `not_authenticated` | API key or session missing, malformed, expired, or revoked. Provision a valid credential. |
| 402 | `subscription_required` | No paid container access. Use the web billing controls to add prepaid funds or resolve legacy payment; do not retry creation. |
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

`POST /subscription/trial` with `{"plan":"builder","code":"<promo-code>"}` requires a login cookie and trusted browser Origin. It returns the same subscription state as `GET /subscription`, with `trial: {plan, expires_at}` (Unix milliseconds), `active: true`, and `valid_until` capped to trial expiry. Codes are case insensitive. The website no longer offers trial-code entry. This is an application trial, with no Stripe subscription or automatic charges. Subscribe separately to continue after expiry; paid subscriptions supersede trial access. Ordinary Stripe trials still grant no access.

Apply migration `009_trial_coupons.sql` before deploying. From the backend directory, issue a code using:

```sh
npm run coupon:create -- --local builder 14 100 2026-12-31T23:59:59Z
```

Use `--remote` to issue a production code after migrating production. The command generates a random code and stores only its SHA-256 hash. Select plan, trial length (1–90 days), maximum redemptions, and redemption deadline explicitly. No codes are enabled by default. Disable future redemptions with `UPDATE trial_coupons SET enabled = 0 WHERE code_hash = '<hash>';` using your database tooling. Disabling a code does not revoke already granted trials.

Each account may redeem one trial ever. Retrying the same valid redemption returns the original deadline, without extending access or consuming another use. The redemption cap and account uniqueness are enforced atomically. An existing live Stripe subscription blocks redemption. Invalid, expired, disabled, exhausted, or wrong-plan codes return 400 `invalid_promo_code`; an account that used a trial returns 409 `trial_already_used`. Trials share the plan's normal account quotas, and containers/SSH/terminals remain capped to trial expiry.

## Capability discovery

`GET /capabilities` is public and accepts no query parameters. Its `apiVersion`
identifies the contract. Execution/file limits come from the runtime's shared
constants. Unsupported persistence, filesystem watchers and network
policy features are explicit. `previews.supported` requires explicit enablement,
an isolated preview domain, a routing database and the runtime binding. It is
enabled in the qualified production configuration. Preview links use opaque bearer tokens,
so `previews.signedUrls` remains false. `images.customBuilds` reflects configured build
credentials; it does not establish build-service health. Resources currently
advertise all five machine sizes. Regions are not selectable.

Use authenticated `GET /containers` for account allowances, usage, running
generations and the deployed `imageCatalog`. New generations include
`imageDigest`, the server-resolved image reference; older generations may omit it.
Capability discovery does not contact Stripe or reserve a start.

## Private Services between machines

Private Services is a local HTTP prototype, enabled by `LOCAL_DEV=true` or
explicit `PRIVATE_SERVICES_ENABLED=true` with both runtime bindings. Before
creating networks or attaching machines, require
`GET /capabilities` to return `networking.privateServices: true`; an absent or
false value means it is unavailable. Production support has not been qualified.

Create an account-owned named network, then attach exact running generations.
Register a backend as `api` with application port `8080`, and attach a frontend
as `web` without a port for caller-only access. From that frontend,
`curl http://api.internal/users` reaches the backend's registered port. The
platform supplies account and generation identity; guests need no Mainbrella
API key or public preview URL for this connection.

| Request | Body / behavior |
| --- | --- |
| `POST /private-services/networks` | `{"name":"app"}` creates an empty network (201). |
| `GET /private-services/networks` | Returns `{networks:[{name,members}]}` for the authenticated account. Optional `search` filters network names by case-insensitive substring; `page` (default 1) and `limit` (default 10, maximum 100) paginate results. Any of these parameters adds `total` (matching count), `totalNetworks`, `page`, and `limit` to the response. Out-of-range pages clamp to the last page. No parameters returns the complete registry. |
| `PUT /private-services/members?network=app` | `{"id":"<backend-id>","createdAt":"<exact-generation>","name":"api","port":8080}` registers a service (200). Omit `port` for a caller-only member. |
| `DELETE /private-services/members?network=app` | Send the member's exact `id`, `createdAt`, and `name` to detach it without stopping it. |
| `DELETE /private-services/networks?network=app` | Deletes an empty network; detach all members first. |

API keys and browser sessions are accepted; cookie mutations require a trusted
Origin. Creation and attachment require paid access and deployment enablement.
Listing and cleanup remain available when issuance is disabled. Network and
service names match `[a-z][a-z0-9-]{0,62}`. Each account has at most 16 networks,
each with at most 32 members; each generation belongs to one network. Service
names are unique within that network. Registered ports are 1024–65535.

Only plain HTTP on port 80 to `http://NAME.internal` is routed. Requests and
responses are each limited to 1 MiB, with a 10-second request timeout. HTTPS,
WebSockets, CONNECT, arbitrary TCP/UDP, private IPs and direct database protocols
are unsupported. Redirects are returned without being followed. This is service
routing, not a general private LAN or an egress firewall.

Both source and destination must be current, running, paid generations in the
same account-owned network. Stale membership cannot reach a stopped or replaced
generation; reattach a replacement explicitly. Delayed detach for an old
generation cannot remove its replacement. Detach does not undo an application
request already accepted. Membership never starts a machine, changes its internet
policy, or issues public previews. Machines retain independent deadlines and
stop behavior; deleting a member does not cascade to peers. To share a frontend
with a browser, issue a separate protected preview for that frontend only.

The repository's [local users demo](https://github.com/mainbrella/backend/tree/main/examples/private-services)
provides the Node frontend → private Go backend → SQLite recipe and explicit
cleanup command. It seeds three users and renders the results of
`SELECT * FROM users ORDER BY id`. Its launcher verifies private HTTP, rendered
rows, and frontend preview HTML/API while preserving unrelated containers.
This local evidence does not establish production support.

## Production containers and networks

Prepaid accounts support `lifecycle: "production"` in `POST /containers`.
Omitted lifecycle remains `ad_hoc`, with the existing session and idle limits.
Production machines have no session or idle shutdown; five-minute compute
reservations renew automatically while confirmed funding and the spending cap permit.
The account checks every 30 seconds, independently of dashboard visits. All
machines share the same monthly spending cap, concurrency and start safeguards.

```json
{"name":"api","catalogId":"node","size":"small","lifecycle":"production","startupCommand":"cd /workspace/app && npm start"}
```

A startup command must be one line and at most 4,096 characters. The dashboard
requires it; API callers can omit it for an always-on shell machine. The command
runs from the selected immutable image on every machine recovery. Include all
required setup in the image or command. Application processes are supervised
with restart backoff up to 60 seconds; output goes to
`/tmp/mainbrella-production.log`. Runtime recovery backs off from 30 seconds to
five minutes. Recovery retains the logical `id` and `createdAt`, private network
registration and project endpoint binding. Explicit deletion and subsequent
creation still produce a new identity. Recovery does not consume another account
start; it reserves and bills new runtime. Confirmed stopped intervals are not
billed. Idempotency retries retain their original creation identity across
recovery; changing lifecycle or startup command conflicts.

`GET /containers` includes production services with `status: "stopped"` and a
`stopReason` when compute is paused by the cap, payment or recovery backoff.
A production `expiresAt` is the current authorized compute lease, not a fixed
service lifetime. Cap or payment stops preserve desired state; verified paid
access and available cap allow automatic recovery. `DELETE /containers` removes
desired state before cleanup and permanently disables automatic recovery.

Create a production network with
`POST /private-services/networks {"name":"app","lifecycle":"production"}`.
Only production services can attach to it; Ad Hoc networks accept Ad Hoc
containers. A mismatch returns `409 network_lifecycle_conflict`. Optional
`lifecycle=ad_hoc|production` filters network listings before pagination. Existing
networks default to Ad Hoc. Empty networks allocate no compute and have no compute
charge. Networks remain private HTTP registries, with the existing protocol limits.

Production requires usage billing (`402 production_requires_usage`) and a
compatible private runtime (`503 production_unavailable`). Deploy the container
runtime before the account/API worker and web UI. Feature discovery and a
versioned private start route reject an incompatible runtime before provisioning.
Production cannot restore a saved workspace. There is no persistent disk,
transactional snapshot, HTTP readiness guarantee, replica failover or uptime SLA.
Use external durable storage. Starting or expanding production requires 24 hours
of funding for the resulting fleet, after existing runtime reservations. Funding
exhaustion pauses compute and preserves service configuration; successful funding
allows recovery of the same logical service. A pending recharge grants no runtime.

## Protected application previews

Protected previews are enabled on the isolated `mainbrella.dev` gateway after
live transport, Next.js/browser and account/generation isolation qualification. Check
`/capabilities` and use previews only when `previews.supported` is true.

Start the application's HTTP server in an owned container first. Then use
`POST /containers/previews?id=<id>&createdAt=<generation>` with
`{"port":3000,"ttlSeconds":900}`. API keys and login sessions are accepted;
cookie writes require trusted Origin. Requests are bounded to 1024 bytes.
The response is 201 with `{id, port, createdAt, expiresAt, url}`. `expiresAt`
is Unix milliseconds; `createdAt` identifies the container generation.
The HTTPS URL carries a bearer token in its hostname and is returned once.
Anyone possessing it can access that port. Treat it as a credential: share
deliberately and keep it out of logs, analytics and public artifacts.

Ports 1024–65535 are eligible; SSH and other privileged ports are excluded.
TTL is 60–3600 seconds, defaulting to 900, clipped to the hard container deadline.
At most eight grants and sixteen simultaneous HTTP requests/WebSockets are
allowed per container. Successful response headers and active WebSocket traffic
renew idle activity; quiet sockets do not. Issuance never extends the hard lease.
Requests preserve application paths, queries, methods and bodies, including
root-relative assets and WebSocket paths. Connection headers must arrive within
15 seconds; each WebSocket frame is limited to 1 MiB. A stopped/replaced
generation, expired lease/grant or revoked grant cannot accept new traffic.
Expiry and revocation close active runtime transports. Requests never start or
restart a machine. Worker restarts require reconnecting active transports.

- `GET /containers/previews?id=<id>&createdAt=<generation>` returns
  `{previews: [{id, port, createdAt, expiresAt}]}` with active metadata only.
  URLs, raw tokens and hashes are never returned by listing.
- `DELETE /containers/previews?id=<id>&createdAt=<generation>&previewId=<preview-id>`
  returns `{revoked:true}` with status 200 and is idempotent within that running
  generation. Only the owner can list, issue or revoke. All three endpoints
  currently require paid access and the exact running generation.
  Listing and revocation remain available when preview issuance is disabled,
  allowing owners to close existing transports during gateway shutdown.

Creation is not idempotent. If its response is lost, list and revoke the new
grant before issuing another link. A routing-index failure triggers grant
revocation. Partial issuance/revocation cleanup returns 503
`preview_reconciliation_required` with `previewId`; retry DELETE using that ID
and the same container generation. Until runtime revocation succeeds, existing
connections may remain active until their lease/grant expires. Other failures
return `previews_unavailable`; excess grants return 429 `preview_limit`.

The gateway runs on a separate registrable domain and has no account database
or login/billing routes. Cookies, Authorization, client-supplied platform/forwarding
headers and Referer are stripped; response cookies are stripped too. The runtime
sets Host, X-Forwarded-Host and X-Forwarded-Proto from the validated preview origin,
preserving the caller's Origin for application security checks. Application
responses disable caching and set a no-referrer policy. Cookie sessions and
absolute redirect rewriting are not supported.
Framework compatibility, CSP and service workers still require live
qualification. Operators can read `docs/preview-ingress.md` in the backend checkout.

Local SDK helpers are `sandbox.previews.create(port, {ttlSeconds})`, `.list()` and
`.revoke(previewId)` in JavaScript, and `sandbox.previews.create(port, ttl_seconds=…)`,
`.list()` and `.revoke(preview_id)` in Python. Create returns the one-time URL
and metadata; list returns `{previews: [...]}` without URLs. Reconciliation errors
expose `previewId` in JavaScript and `preview_id` in Python. See the
[JavaScript](https://mainbrella.com/sdk/javascript.md) and
[Python](https://mainbrella.com/sdk/python.md) local SDK references.

## Managed execution and streaming

Use `POST /containers/executions?id=<id>&createdAt=<generation>` with a required
`Idempotency-Key` and `{"command":"<shell command>","timeoutMs":30000}`. It returns
202 with an execution record containing `id`, `createdAt`, timestamps, `status`,
`retainUntil` (Unix milliseconds), `cursor`, `outputBytes`, `exitCode`, `timedOut`
and `outputTruncated`. New jobs also report `stdinEnabled`, `stdinClosed`, `stdinBytes` and optional `pty` dimensions. Commands, argv, environment values and creation keys are not returned.

Matching key and all creation-option retries within the same generation return the retained
execution. Changed options return 409 `idempotency_key_conflict`. Retention lasts
one hour from admission, with 32 records per container; when full, a new job returns
429 `execution_history_limit`. After retention expires, a key can launch new work.
Preserve the key and never retry an old operation beyond its retention window.

Shell commands run `/bin/sh -lc`; alternatively pass `{"argv":["executable","literal argument"]}` without shell expansion. Supply exactly one of command/argv. Optional `cwd` is an absolute path without dot/parent segments; optional `env` has up to 64 POSIX variable names, 4096 UTF-8 bytes per value and 16 KiB of JSON. The provider inherits only PATH. Values are sent to the guest and may appear in its output; they are not a secrets vault. Jobs default to 30 seconds, allow up to 15 minutes,
and remain bounded by the hard container deadline. They share four active
operations with foreground commands and files. Active jobs renew idle activity.
Output stops at 1 MiB combined stdout/stderr or the bounded output-event count.
Client disconnect does not cancel the job. Images require GNU timeout. Cancellation and hard timeouts target the operation process group; deliberately detached processes remain bounded by the machine lease. Signal delivery is a request, not proof that every guest child has exited.

- `GET /containers/executions/<execution-id>?id=<id>&createdAt=<generation>` returns
  current state plus retained `stdout` and `stderr`.
- `DELETE` at the same URL requests cancellation and returns 202. Poll until a
  terminal state; cancellation of a completed job has no effect.
- `GET /containers/executions/<execution-id>/events?id=<id>&createdAt=<generation>&cursor=0`
  streams SSE output. stdout/stderr events carry `{type,sequence,data}` and an SSE
  `id` equal to `sequence`. Resume with the last received sequence as `cursor`.
  A cursor ahead of retained output returns 400 `invalid_cursor`.

`GET /containers/executions?id=<id>&createdAt=<generation>` lists up to 32 retained managed-job summaries for that exact generation, including terminal records. It is not a guest-wide OS process table. `commands.attach(id)` reconnects SDK controls and output to a known retained job; attaching does not start or replay it.

Start with `stdin:true` to accept raw input; otherwise stdin closes immediately. `POST /containers/executions/<execution-id>/stdin?...` sends `application/octet-stream`, up to 64 KiB per request, 1 MiB accepted per job and 256 KiB pending. Writes are ordered and respect pipe backpressure. Input is not retained or replayed. Ambiguous accepted bytes remain counted. A 30-second response bound or disconnect does not undo an accepted write; reconcile application state before sending again. `DELETE` at that stdin URL closes input after accepted writes. For a plain pipe this sends EOF; PTY closure can hang up the terminal. Closing input is not a cancellation request.

`POST /containers/executions/<execution-id>/signal?...` accepts only `{"signal":"SIGINT"}`, SIGTERM or SIGKILL. Signals are bound to retained job identity; no arbitrary guest PID is accepted. SIGKILL requests cancellation; SIGINT/SIGTERM can be handled or ignored. Inspect retained state to confirm completion. Cleanup signal/input-close operations remain available during billing outages. Sending bytes requires paid access and the exact live generation.

Start a programmatic terminal with `stdin:true` and `pty:{"cols":80,"rows":24}`. Check `execution.programmaticPty` and `ptyResize` first. Output combines stdout/stderr on stdout and follows terminal line discipline, including CRLF and possible input echo. `POST /containers/executions/<execution-id>/resize?...` accepts `{"cols":132,"rows":40}` with dimensions 1–1000 and requires the exact live paid generation. Resize does not change the original idempotency identity. Disconnect/reconnect use the same SSE cursor flow; a stream disconnect only detaches. Closing a PTY input pipe is not equivalent to a shell's Ctrl-D key. Send application-appropriate bytes or an explicit exit command, then inspect state. Arbitrary SSH/guest processes cannot be attached through this API. Filesystem watchers and guest-wide process listing remain unsupported.

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

## Outbound internet selection

Creation accepts optional `internet: boolean`, default true. `internet:false` requires `networking.internetControl` capability and explicit API `NETWORK_INTERNET_CONTROL_ENABLED=true`; the flag is unset by default pending live qualification. String values, null and numeric coercion are rejected. The selection is immutable for a generation, returned as `internet` in container status, and included in creation idempotency. Default/explicit true preserve legacy fingerprints; reusing the key with a different effective policy returns 409.

An offline start checks the selected private runtime's inert versioned feature contract before reserving quota or compute. It uses a new private network-start path so an older runtime cannot silently ignore the restriction, even if runtime code changes after discovery. Missing/incompatible support returns 503 `network_policy_unavailable`. A failure after reservation can retain a charged pending creation; keep the key and reconcile using that same identity. Both SDKs check public capability discovery before requesting offline creation and require the returned generation's policy to confirm false. A known policy-unavailable response is not automatically retried.

The native provider `enableInternet:false` switch blocks outbound internet without configuring any allowlist/interceptor. Local tests verify the exact provider argument and fail-closed version handling; provider DNS, IPv4/IPv6, HTTP/HTTPS, direct-IP/other-port bypass and SSH/preview compatibility remain live qualification gates. HTTP command, file and PTY transports access the existing guest independently. Inbound authenticated access is a separate feature. Customer CIDR/domain rules, live policy updates, proxy routing and mediated secrets are not implemented by this switch.

## Workload metrics and lifecycle history

These observations describe one owned generation. They are separate from account compute reservations, billing estimates and public service health. Read `observability` capability flags first.

`GET /containers/events?id=<id>&createdAt=<generation>&cursor=0&limit=100` returns `{events,nextCursor,hasMore,historyTruncated,retainForMs}`. Each event includes a stable UUID `id`, increasing slot-wide `sequence`, exact `createdAt`, `occurredAt`, `type`, machine `size`, optional bounded `reason` and `retainUntil`. Types are starting, started, failed and stopped. Started means readiness completed; starting alone does not. Deduplicate by ID and order by sequence. Pass nextCursor to read the next page. Retention is seven days, bounded to 256 events per machine slot across generations. A missing starting event sets historyTruncated. Unknown/expired generations return 404. Reads remain available after stop and during billing outages; they do not renew activity or execute in the guest. Natural-stop timestamps record when the control plane observed the stop. Provider error text, credentials and command/input values are excluded.

`GET /containers/metrics?id=<id>&createdAt=<generation>&from=<ISO>&to=<ISO>` reads provider workload analytics. It stays disabled until operator configuration and live schema/label/unit qualification. The default range is the last hour, limited to the generation and seven-day retention; explicit ranges are at most 24 hours. One-minute buckets cover a half-open [from,to) interval; the first bucket can begin before an unaligned from. Each bucket includes samples, cpuSeconds, memoryPeakBytes and diskUsagePeak. The last field preserves the provider's diskUsage value; its unit remains unqualified and must not be presented as bytes or billing usage. Missing numeric fields are null. Empty/legacy observations return state unobserved, never zero/healthy. Data may arrive late or be sampled. An opaque generation label isolates provider queries and remains private. No analytics credential enters the guest.

SDKs expose `sandbox.events({cursor,limit})` and `sandbox.metrics({from,to})` in JavaScript; Python uses `sandbox.events(cursor=…,limit=…)` and `sandbox.metrics(from_time=…,to_time=…)`. The local lifecycle CLI has `events` and `metrics` commands with explicit ID and generation.

## Lifecycle webhooks

Check `observability.webhooks`. This locally implemented feature remains disabled until the API and private runtime are configured and qualified. One destination belongs to one exact generation. Supported destinations are HTTPS URLs on operator-controlled trusted relay hosts. Arbitrary customer domains and DNS, IP literals, custom ports, embedded credentials and redirects are unsupported; this is not a general outbound URL proxy.

- `PUT /containers/webhook?id=<id>&createdAt=<generation>` accepts `{url,replayFromCursor?}` (4096-byte JSON limit) for a live paid generation. It rotates configuration and returns `{webhook,signingSecret}` once. Keep the signing secret outside logs and guest files/environment. Every PUT rotates the key and clears old attempts; a lost response requires GET reconciliation and an explicit fresh rotation if the secret is unavailable. SDKs never retry it automatically. Without replayFromCursor, only future events queue; with it, retained generation events after that cursor queue.
- `GET` at that URL returns `{webhook:<metadata-or-null>}`, never the signing secret. `DELETE` removes queued attempts and aborts in-flight transport. A receiver may already have accepted an in-flight request; removal cannot undo delivery.
- `GET /containers/webhook/deliveries?...` returns bounded `{deliveries:[…]}` with event ID/sequence, pending/sending/delivered/exhausted state, attempts in the current retry cycle, manualRetries, nextAt, retainUntil, optional lastAttemptAt and HTTP status. Payload, receiver response bodies and exception text are excluded.
- `POST /containers/webhook/retry?...` accepts `{eventId}` for an exhausted retained delivery. It starts a new retry cycle, at most three manual retries. Reads, removal and retry remain available during billing outages and after stop; they cannot act on a replacement generation.

Delivery is at least once and may arrive out of order. Up to eight automatic attempts use delays of 5 seconds, 30 seconds, 2 minutes, 10 minutes, 1 hour, 6 hours and 24 hours. Any 2xx confirms delivery; each response is bounded by 10 seconds. Runtime recovery may repeat an ambiguous attempt. Consumers deduplicate by stable event ID and order by sequence. Configuration lasts seven days after setup. Delivery retention ends with the configuration or event, whichever expires first. Each slot retains at most 32 configurations and 256 deliveries.

POST payloads are `{id,sequence,type,occurredAt,container:{id,createdAt,size},reason?}`. Headers include `Mainbrella-Event-Id` and `Mainbrella-Signature: t=<Unix-seconds>,v1=<hex-HMAC-SHA256>`. The signature covers the exact UTF-8 bytes of `<timestamp>.<raw-body>` using the returned signingSecret string as the HMAC key. Verify the raw body before JSON parsing, check timestamp freshness, then deduplicate event IDs. JS exports `verifyWebhookSignature(bytes,header,secret)`; Python exports `verify_webhook_signature(body,header,secret)`. Both default to a five-minute freshness window and compare signatures through standard cryptographic primitives.

JavaScript `sandbox.webhook.configure(url,{replayFromCursor})`, `.get()`, `.remove()`, `.deliveries()` and `.retry(eventId)` expose the contract. Python equivalents use `replay_from_cursor` and `event_id`. Signing keys are encrypted in private runtime storage with an operator-managed key; destination URL paths/query values remain owner-visible configuration. Key rotation requires reconfiguring retained webhook destinations. Operators should read [the observability runbook](https://github.com/mainbrella/backend/blob/main/docs/workload-observability.md) before enabling delivery. OTLP export remains unsupported.

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

Legacy Builder includes 250 compute-unit hours/month and 28 concurrent units; Pro 9,000 and 128; Scale 50,000 and 640. Container ceilings and monthly start safeguards (1,000 / 10,000 / 100,000) also apply. Monthly usage resets on the UTC calendar month, without rollover.

Create with `{"catalogId":"node","size":"medium"}`. `GET /containers` returns `sizes`, `limits.maxComputeUnitHours`, `limits.maxConcurrentComputeUnits`, and `usage.computeUnitHours`, `reservedComputeUnitHours`, `availableComputeUnitHours`, and `concurrentComputeUnits`. Runtime is reserved durably before provisioning; unused runtime is released on a reconciled stop. Used hours include provisioning and idle time. Ambiguous starts retain reservations until reconciliation. Capacity rejection does not reserve usage. Machines receive an immutable budget deadline and stop at the earliest of that deadline, idle/session/paid-access expiry, or, for legacy plans, the UTC month boundary. Clients must honor returned `expiresAt`.

Errors: 400 `invalid_size`; 409 `compute_capacity_exceeded`; 429 `compute_allowance_exhausted`. A changed size with an existing creation key returns 409 `idempotency_key_conflict`. Legacy plans have no overages. Prepaid accounts meter compute at $0.02 per unit-hour, subject to confirmed funding and a spending cap.

## Saved workspaces and portable export

Discover `capabilities.persistence.snapshots` before issuing saves or restores. Saved-workspace issuance is enabled in the qualified production deployment; other deployments may disable it. Ordinary stop remains destructive; save explicitly before stopping.

`POST /workspaces` accepts `{id, createdAt, name, stop?}` and requires an `Idempotency-Key`. The source identity must match a running generation owned by the authenticated account. Save captures the writable root filesystem, commits its private provider handle, and optionally stops that exact generation. Persist the request body and key before sending: repeat the identical request after a lost response. Recovery receipts last 24 hours. A capture whose provider result cannot be recovered fails closed rather than silently taking another snapshot.

`GET /workspaces` lists account-owned metadata, limits and reserved usage. `GET /workspaces/{uuid}` reads one; `PATCH` renames it or sets `{archived:true|false}`; `DELETE` releases customer quota and revokes future restores. Archive retains quota. Reads, archive and deletion remain available during subscription outages or disabled issuance. Provider handles never appear in public responses. Deletion does not erase provider-held bytes immediately and does not terminate a restore already admitted.

Restore with `POST /containers` and `{workspaceId}` using a new persisted creation key. A restore consumes one normal start and compute allowance and creates a fresh generation. It retains the saved machine size and internet policy, requires the same deployed image digest, and fails before admission if expired, archived or incompatible. A provider restore failure never falls back to an empty filesystem. RAM and running processes are not restored. Existing previews and generation-bound commands do not transfer.

| Plan | Saved workspaces | Reserved capacity | Retention | Saves/month | Capture capacity/month | Retained capture capacity |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Usage | 20 | 160 GB | 14 days | 100 | 400 GB | 400 GB |
| Builder (legacy) | 3 | 8 GB | 7 days | 10 | 20 GB | 20 GB |
| Pro | 20 | 160 GB | 14 days | 100 | 400 GB | 400 GB |
| Scale | 100 | 1,000 GB | 29 days | 500 | 2,000 GB | 2,000 GB |

Each new save reserves the full source disk capacity against both capture budgets before contacting the provider, even if the resulting snapshot is smaller. Failed or uncertain saves keep their reservations; identical keyed retries do not charge again. Monthly counts/bytes reset at UTC calendar month boundaries. Retained capture capacity stays charged for at least 60 days, covering customer retention plus the provider's 30-day TTL after the last restore; daily buckets may retain earlier captures for up to one extra day. Archive, deletion, expiry and subscription changes do not refund these capture budgets. Deletion releases only live workspace count/capacity. Existing workspaces keep their original expiry. Legacy usage is migrated conservatively: saves whose records are unavailable reserve the maximum supported disk capacity.

`GET /workspaces` includes `maxCaptureBytesPerMonth` and `maxRetainedCaptureBytes` in `limits`, and `savesThisMonth`, `captureBytesThisMonth`, and `retainedCaptureBytes` in `usage`. New saves return HTTP 429 with `workspace_quota_exceeded`, `workspace_save_limit`, `workspace_capture_budget_exceeded`, or `workspace_retained_budget_exceeded` when the corresponding limit is reached. Reads, restores of otherwise eligible workspaces, archive and deletion remain available when a save budget is exhausted.

Reservation uses the source machine's full disk capacity, even when the snapshot is smaller. Expiry releases quota and removes usable handles; the provider controls physical retention. Backup to your own storage with `GET /containers/export?id=…&createdAt=…`: this returns a gzip tar archive of `/workspace`, limited to 16 MiB compressed and 60 seconds. Export a restored saved workspace to download it. Export excludes other root paths, mounted volumes and process memory, and fails if the archive exceeds the limit or files change during capture. It shares the four-operation limit with other filesystem operations.

## Public repository launches

The browser entry point is `https://mainbrella.com/run/?repo=OWNER/REPO&ref=main`.
Opening a share link prepares a launch; **Run repository** creates a private launch
for the signed-in recipient using their paid or coupon-trial allowance. The default
result is a shell in `/workspace/repo` on a Small machine. Each recipient gets a
separate container. GitHub login is unnecessary for public repositories.

Optional query/body fields are `ref`, `catalogId` (`node`, `python`, `rust`, `go`,
`devops`), `size`, `cwd` (relative to the checkout), `setupCommand`, `startCommand`,
and `port` (1024–65535). Start command and port must be supplied together. Runtime
suggestions use manifests in the working directory; ambiguous projects default
to Node and allow an override. Commands from share links are visible before Run.

Catalog selection does not guarantee native build prerequisites. Inspect dependency
install/postinstall scripts and the repository Dockerfile, then check tools in the
actual container before installing dependencies. For example, `node-pty` may fall
back to `node-gyp` when prebuilt binaries are unavailable, requiring `python3`,
`make`, and `g++`. Include conditional installation of missing system packages in
`setupCommand` using the guest OS/package manager and available privileges; on
Debian this is `apt-get update` followed by
`apt-get install -y --no-install-recommends python3 make g++`. Do not skip required
lifecycle scripts or regenerate the lockfile to bypass this failure. Repair failed
installs in the retained container, preserving its checkout and completed work.
Repository Dockerfiles are evidence for prerequisites, not automatically compatible
custom images: this launch contract accepts `catalogId`, not `imageId`, and custom
images require one stage starting with `FROM mainbrella:base`.

Authenticated endpoints accept session cookies or existing session/API Bearer
credentials. Cookie mutations require a trusted Origin:

- `GET /repo-launches/resolve?repo=OWNER/REPO&ref=main&cwd=.` validates the public
  repository, resolves an immutable commit, and suggests a runtime. No allocation.
- `POST /repo-launches` with the settings JSON and a stable `Idempotency-Key`
  validates paid/trial access and resolves the commit before storing the launch.
  It returns a launch with `id`, `phase`, `options`, `repository`, `container`,
  `executions`, `createdAt`, `shellReadyAt`, `previewReadyAt`, and `error`.
  Repeating identical settings/key returns the original launch; mismatches return
  409. Creating this record does not allocate until advance.
- `GET /repo-launches/{id}` reads owner-scoped progress. No allocation or replay.
- `POST /repo-launches/{id}/advance` performs or reconciles one workflow step.
  Repeat while phases are `allocating`, `cloning`, `setup`, or `starting`. A lease
  and stable allocation/execution keys prevent duplicate side effects. Retained
  execution IDs are inspected before moving on. End phases are `ready`, `failed`,
  and `stopped`. An expired or reused container slot is never resumed.

The browser stores private run/request identities in the URL fragment, preserves
settings through sign-in with `returnTo`, and copies share links without those
identities. An uncertain initial submission asks for Resume with the same key.
GitHub errors occur before allocation; rate-limited lookups return 429.

Clone/setup/startup checks use retained managed executions. The browser terminal
attaches to the `main` tmux session created at the checkout root. The server runs
in `mainbrella-preview`, with output at `/workspace/.mainbrella-preview.log`, under
normal container idle and hard deadlines. Readiness requires a successful HTTP
response at `/` on the chosen port. The server should listen on `0.0.0.0`. Setup
and startup failures leave the terminal available for manual repair; failed or
uncertain commands are never silently rerun after history expires.

Use the existing execution API to read output and the previews API to issue a
link after readiness. Preview URLs are returned once and never stored in launch
records. The page renews by reconciling/revoking existing grants on that port and
issuing a fresh link. Links last up to 15 minutes, do not extend the container
lease, and give anyone with the URL access. Cookie-based apps are unsupported.

Apply `migrations/013_repo_launches.sql` before deploying this API. Production
rollout requires the frontend, API and new SDK CLI release together; source
availability does not imply the currently published npm package contains `repo`.


## Prepaid billing

New accounts purchase $5–$1,000 of prepaid compute balance through `/billing/topups`. There is no monthly subscription or monthly minimum charge. Unused funding carries forward. Each dollar paid adds one dollar of balance, regardless of purchase size or repetition; all prepaid accounts use the same prices and limits. Client-supplied credit amounts are ignored. Compute costs $0.02 per compute-unit hour; weighted hourly rates are Lite $0.02, Small $0.12, Medium $0.20, Large $0.32 and XL $0.56. Provisioning and idle time count; only elapsed allocation is billed. Ephemeral disk is included. Storage, dedicated IPs and email have no separately enabled usage charges yet.

Mainbrella keeps the wallet in the durable account controller. Available funding is confirmed payment credit minus elapsed consumption minus reserved future runtime. Reservations happen before provisioning and unused reservations are released after confirmed stops. All clients must honor returned `expiresAt`; Ad Hoc machines retain the 24-hour session and 30-minute idle deadlines. Production renews funded five-minute reservations and requires at least 24 hours of fleet funding at launch. The monthly consumption cap remains separate from prepaid balance; raising it never creates funding.

Browser-only `GET /billing/balance` returns balance, available and reserved USD cents, monthly usage/cap, production hourly cost and funded runway, and automatic recharge status. Explicit `/billing/settings` consent enables automatic recharges with a fixed amount and monthly maximum. The durable pending attempt is saved before contacting Stripe. Metadata and retained payment IDs recover unknown outcomes after HTTP idempotency keys expire; an old unknown attempt fails closed. Succeeded captured card payments fund runtime; pending, failed or authentication-required payments do not.

Checkout completion and signed Stripe webhooks independently fetch current PaymentIntent and charge state. Payment currency, amount, capture, customer, account metadata and funding purpose are verified. Funding is applied once per payment identity, across retries and event types. Refunds remove the corresponding number of cents; a dispute revokes the payment's entire balance contribution. A reversal can leave a negative wallet when credit was already consumed. Delayed success events cannot restore revoked funding. Dispute restoration requires operator reconciliation in this initial implementation.

Set `STRIPE_PREPAID_PRICE_ID` to an active one-time USD $5 Price with an active Product. The backend validates it; exact $5 purchases use that Price and other amounts use inline prices under its Product. Configure matching test or live `STRIPE_SECRET_KEY` and `STRIPE_PUBLISHABLE_KEY`; new prepaid purchases require both, while completion verification and billing settings remain available without the publishable key. Apply migration `019_prepaid_billing.sql` and configure the existing signed `/subscription/webhook` for Checkout, PaymentIntent, charge/refund and dispute events before deployment. Existing legacy read, payment-method management, invoice reconciliation and cancellation remain available; new recurring purchases are disabled. See `docs/prepaid-billing.md` and `docs/usage-billing.md` for operator setup.
