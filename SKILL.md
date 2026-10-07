---
name: mainbrella-containers
description: Set up Mainbrella API access, integrate account-owned Linux containers into agent projects, verify HTTP execution and file transfer, and clean up containers created for the task.
---

# Mainbrella container automation

Use this workflow when asked to set up Mainbrella or execute work in its containers.
Read [API.md](API.md) for endpoint contracts, images, quotas, and billing rules.
The installable archive also includes an [indexed reference tree](references/index.md)
for individual API topics and the JavaScript/Python SDK instructions. Read only
the relevant topic when the full contract is unnecessary.
Use `https://api.mainbrella.com` unless the user specifies another environment.
Mainbrella uses REST for lifecycle, foreground command execution, and file transfer.
The Python SDK is published as `mainbrella` 0.1.0: `pip install mainbrella==0.1.0`.
The JavaScript SDK is published as `@mainbrella/sdk` 0.1.0: `npm install @mainbrella/sdk@0.1.0`.
See the SDK references for the actual APIs.
Use public `GET /capabilities` to discover deployment support before choosing an
execution mode. Obtain account allowances and deployed images from `/containers`.

## Quick Setup

1. Read `MAINBRELLA_API_KEY` from the project's existing environment loading or
   secret manager. Honor an explicitly supplied credential variable and API origin
   as a pair throughout setup, verification, and deployment. For example, use
   `MAINBRELLA_LOCAL_API_KEY` only with the specified localhost API; map it to
   `MAINBRELLA_API_KEY` in the local tool process, without rewriting `.env` or
   sending it to production. Do not ask for the default variable when the supplied
   variable already contains a valid key. It starts with `mb_`. If the selected
   credential is missing, ask the user to provision it for that environment.
   For production, ask them to sign in at
   `https://mainbrella.com/api-keys/`, create a named key, and provision it locally
   as `MAINBRELLA_API_KEY`. For an existing ignored `.env`, Node 22+ supports
   `node --env-file=.env mainbrella-doctor.mjs` without dependencies or shell
   sourcing. Never expose this key in a Vite `VITE_*` variable/client bundle or
   copy it into the container. Do not ask them to paste the secret into chat. A key
   grants no compute allowance by itself; paid access or a coupon trial is required.
2. Detect the project without asking: `package.json` means JavaScript/TypeScript;
   `pyproject.toml` or `requirements.txt` means Python; `Cargo.toml` means Rust;
   `go.mod` means Go. Preserve the existing package manager, lockfile, environment
   loading, and module format. For an empty directory, use a minimal Python project
   in a new `mainbrella-example` subdirectory unless the user named a language.
3. The supplied check and verification tools need Node 22+. HTTP execution needs
   no local SSH tools. Use existing tools first; install missing prerequisites with
   the environment's established package manager.
   There are no project SDK dependencies to install. Node tools use `.mjs` so they
   also work in CommonJS projects; do not change the project's module type.
4. Download `https://mainbrella.com/mainbrella-doctor.mjs` and
   `https://mainbrella.com/mainbrella-verify.mjs` into the same local directory.
   Inspect them, then run `node mainbrella-doctor.mjs` from the project directory.
   The doctor checks readiness for the full verification suite, including managed
   execution, streaming, reconnect and cancellation. It prints JSON diagnostics
   without secrets and performs only GETs.
   Exit 0 means ready for a new verification container; exit 1 identifies blockers.
   `MAINBRELLA_API_URL` optionally selects a different HTTPS origin (HTTP localhost
   is allowed for development). It must not contain a credential, path, or query.
5. Choose an image from the returned `GET /containers` `imageCatalog`: prefer
   `node`, `python`, `rust`, or `go` for the detected language, and `devops` for
   infrastructure tasks. Only choose IDs actually advertised by this deployment.
   For user-requested custom environments, read `/images` and use an owned `ready`
   image. `buildsEnabled` determines whether new builds can be submitted.
   If the requested runtime image is unavailable, a compiled application may run
   on an advertised image without its build toolchain. Confirm the guest OS,
   architecture, and runtime-library requirements before choosing this fallback;
   read [Compiled application deployment](references/compiled-application-deployment.md).

## Integrate

Use native HTTP facilities (`fetch` in Node, `urllib.request` in Python). Follow [API.md](API.md) for authenticated
create, status, HTTP execution, file read/write, and deletion. Keep credentials server-side.
If agent/tool-calling code already exists, add Mainbrella where execution occurs;
otherwise add a small example matching the detected language.

For multiple containers that need HTTP communication, require
`networking.privateServices: true` and read
[Private Services between machines](references/private-services-between-machines.md)
for network creation and exact-generation membership. This feature is locally
verified; production support has not been qualified. A caller can use
`http://api.internal` after both guests are attached to the same network; issue
a browser preview for the frontend separately.

Create with a unique `Idempotency-Key` header (UUID recommended). Retry the same
key and image selection within 24 hours after an ambiguous result. Use the
returned `creation.containerId` and `creation.createdAt` once its status is
`running`; account status may also include other tasks' containers.

Capture each container's `id` **and** `createdAt`, and pass both to HTTP execution
and cleanup. Preserve the idempotency key until startup and cleanup are resolved.
Use `POST /containers/exec?id=<id>&createdAt=<generation>` with
`{"command":"<shell command>","timeoutMs":30000}`. Collect stdout, stderr and
exitCode. Check timedOut and outputTruncated; either means incomplete execution
with a null exitCode. Timeout is at most 60 seconds and output at most 1 MiB.
Commands are not idempotent; reconcile effects before retrying after a transport
failure. For work beyond a foreground request, use managed execution if advertised
by `/capabilities`; use SSH when the task needs interactive access.

Managed jobs use `POST /containers/executions?id=<id>&createdAt=<generation>` with
a required unique `Idempotency-Key` and a command/timeout body. Preserve the returned
execution ID. Poll GET for results, use DELETE to cancel, or stream `/events` and
reconnect with the last received sequence as `cursor`. Disconnect only detaches.
Matching retries resolve the original job for one hour; never retry beyond that
window. Maximum timeout is 15 minutes within the hard lease. Runtime restart
marks unfinished jobs interrupted and stops their matching container generation,
so choose a dedicated container when unrelated work must remain independent.

Use `GET` and `PUT /containers/files?id=<id>&createdAt=<generation>&path=<absolute-path>`
for file transfer up to 1 MiB. URL-encode query values. Send raw bytes with
`Content-Type: application/octet-stream`; read the download as bytes, not JSON.
The parent directory must exist. Writes replace regular files atomically and reject
symlinks/directories. New files use mode 0600. File operations share the command
concurrency pool and have a 30-second runtime limit. Reconcile an uncertain write
by reading before retrying. Check the corresponding `files` capability flags
before using list/stat/mkdir/remove/move/chmod; read the
[filesystem reference](references/filesystem-metadata-and-directories.md) for
pagination, symlinks and mutation reconciliation. Recursive deletion is explicit,
moves never overwrite, and root cannot be mutated. Watchers remain unsupported.

For an application preview, first check `previews.supported` in `/capabilities`.
Protected previews are enabled on `mainbrella.dev` after live qualification.
When capability discovery confirms support,
start the server on an eligible application port, then POST
`/containers/previews?id=<id>&createdAt=<generation>` with `{"port":3000}`.
The returned URL is a bearer credential: share only as requested and keep it out
of logs/public artifacts. This is temporary hosting: it expires within the hard
lease, and inactivity can stop the container earlier. Explain this before
deployment and report the actual returned expiration alongside the URL. GET the same endpoint
for metadata and DELETE with `previewId` to revoke. A lost creation response
requires listing/revoking before issuing another link; a 503
`preview_reconciliation_required` includes the ID to retry revocation.
Cookies and account credentials are stripped from app traffic. See API.md for
limits and framework restrictions. The SDKs provide `sandbox.previews.create`,
`list` and `revoke`; consult their references for installation instructions.

## Deploy a static site

Read [Static-site deployment over HTTP](references/static-site-deployment-over-http.md)
(or the same section in API.md) for the complete local build → chunked upload →
hash verification → detached server → readiness → preview → URL checks workflow.
Use the archive's `scripts/mainbrella-deploy-static.mjs` or download and inspect
`https://mainbrella.com/mainbrella-deploy-static.mjs`. It requires Node 22+ and local
`tar`, has no npm dependencies, and uses a single dedicated Lite Node generation.
Build locally with the existing package manager, then run:

```sh
node --env-file=.env scripts/mainbrella-deploy-static.mjs \
  --dist dist --state .mainbrella/deployment.json \
  --check /<actual-page>/ --check /assets/<actual-built-file>.js
```

Omit `--env-file` if the environment already provides the key. Keep `.mainbrella/`
ignored/private; select real paths from the build. The helper checks only the
capabilities it needs. Do not run the full paid verifier before every deployment
unless setup verification is part of the task. It preserves creation key/body,
exact generation, current step, command result flags, logs and preview metadata
before cleanup. It refuses existing state and never blindly replays uncertain
commands or preview issuance. On failure, inspect private diagnostics and reconcile
before an intentional retry; stop the saved generation explicitly when finished
using `--cleanup --state <file>`. Report any remaining container and idle/lease
limits. The helper keeps the bearer URL in private state; share as requested with
its actual expiration. It verifies HTTP content; check browser behavior separately
when relevant.

## Verify

Run `node mainbrella-verify.mjs` with the provisioned key in the environment.
Set `MAINBRELLA_CATALOG_ID` to the available image selected for the project;
without it the script selects `node`. This verification consumes one monthly start.
It creates a new container, runs `echo "hello from mainbrella"` through HTTP, checks
stdout and exit code, writes and reads a binary probe under `/tmp`, compares every
byte, starts a managed job, consumes SSE output with cursor reconnect if needed,
checks the retained result, then starts `sleep 30`, cancels it and polls for
`canceled`. All checks share that one start. It requires foreground, background,
streaming, reconnect, cancellation and binary file read/write capabilities, and
deletes **only that container generation** in a `finally` block.

Verification cleanup is separate from deployment cleanup. When both setup
verification and a two-container deployment are requested, budget three starts:
one temporary verifier and two app containers. Clean up the verifier in `finally`;
keep successfully deployed app containers running for the requested preview,
with saved generation-qualified cleanup instructions. Report their remaining
leases and preview expiration. Do not run another full verifier for each app guest.

Pass requires `ok: true`, `stdout: "hello from mainbrella"`, `exitCode: 0`,
`files: "verified"`, `managed: "verified"`, `cancellation: "verified"`, and
`cleanup: "completed"`. Never report success without all seven. On a failure, use
Troubleshooting to fix the demonstrated cause and re-run at most once **only after
cleanup is confirmed and allowance permits**. If creation was ambiguous or cleanup
failed, reconcile first and report any remaining machine; do not blindly re-run.

Preserve containers that existed before setup. Reuse one only when authorized for
the task; never stop it just to free a slot or satisfy a verification gate. Export
needed artifacts before cleanup: files are lost on stop. Status polling does not
renew idle time, and SSH issuance does not extend the hard deadline.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Missing key / 401 | Provision or renew a named API key; never print it. |
| 402 / inactive access | Report the paid-access or trial requirement. Do not purchase or change billing as part of setup. |
| Missing catalog image / `image_not_available` | Refresh status and choose an advertised suitable image. |
| 409 `container_limit_exceeded` | Inspect status; reuse only authorized work or wait. Do not evict existing machines. |
| 429 `container_quota_exceeded` | Wait for the next UTC month; stop launch attempts. |
| 429 `ssh_token_limit` / `terminal_limit` | Reuse authorized access, close an authorized connection, or wait for expiry. |
| `execution_failed` / `timedOut` / `outputTruncated` | Inspect exit status and execution flags. Reduce the job or use authorized SSH access for longer tasks. |
| 429 `execution_limit` | Wait for an active command/file operation to finish; do not stop unrelated work. |
| `file_verification_failed` / `files_unavailable` | Check deployment alignment and image utilities. Preserve unexpected file contents and diagnostics outside shared logs. |
| `file_too_large` / `invalid_file_path` | Use valid absolute paths and files up to 1 MiB; for larger artifacts upload archive chunks, concatenate and verify SHA-256 before extraction (see the static deployment reference). Authorized SSH is another option. |
| `file_not_found` / `not_regular_file` / `file_access_denied` | Check the path, parent directory and guest permissions. Writes need a regular file or an unused path. |
| `idempotency_key_conflict` | The key belongs to a different image selection. Use the original request to reconcile it; use a new key only for an intentional new launch. |
| `creation_no_longer_running` | The original operation stopped or failed. Do not touch a replacement in its slot. |
| `creation_ambiguous` / launch timeout / 503 | Retry the same creation key and image selection within 24 hours; `starting` means wait and retry. Preserve `creationKey` if verification remains unresolved. Failed starts may consume quota. |
| `cleanup: "failed"` | Retry generation-qualified DELETE for the reported container; cleanup remains available during billing outages. Confirm absence with GET. |
| 409 `container_not_running` | Refresh status; a stopped or replaced generation must not be targeted. |

## Report

One paragraph: which integration changed, what command ran, stdout, exit code,
whether binary files, managed streaming/results and cancellation passed, and
whether cleanup completed. For deployment, report verified paths and the requested
preview URL with actual expiration instead; identify temporary hosting and earlier
idle shutdown. State any blocker or remaining container plainly.
Offer one relevant next step: an owned custom image, an LLM tool that runs commands,
or a coding agent inside a container. Do not start that additional work unasked.

For managed stdin, literal argv, signals, retained-job listing and programmatic PTY resize, read [Managed execution and streaming](references/managed-execution-and-streaming.md). Gate each control on `/capabilities`; preserve exact generation/job identities. Input bytes are not retained or retried. Environment values enter the guest and are not protected secrets. Closing an output stream only detaches.

The local npm SDK archive also installs `mainbrella`; read its [JavaScript reference](references/javascript-sdk.md#command-line) for lifecycle CLI usage. Creation/start require a stable explicit idempotency key. Every workload action requires both ID and generation; preserve returned identity before further actions.

For generation-bound lifecycle history, provider metric evidence and signed callback delivery, read [Workload observations](references/workload-metrics-and-lifecycle-history.md) and [Lifecycle webhooks](references/lifecycle-webhooks.md). Gate controls on observability capabilities. Missing observations are unknown, not zero/healthy. Callback delivery is at least once; verify raw-body signatures, enforce freshness and deduplicate stable event IDs. Store one-time signing secrets outside the guest and logs.

## Saved workspace recovery

Check `/capabilities` persistence flags before issuing a save or restore. Ordinary stop discards filesystem changes. Persist the exact generation, save body and idempotency key before `POST /workspaces`; optionally request `stop:true`. Recover a lost response with the same body/key within 24 hours. Restore through `POST /containers` with `workspaceId` and a fresh persisted creation key. This consumes one start and restores only filesystem state, with the same deployed image digest, size and internet policy. RAM, processes and previews do not resume. Use account-owned list/archive/delete APIs to manage quotas and expiry. To keep a portable backup, export `/workspace` from a running or restored generation (gzip tar, 16 MiB compressed maximum); store the bytes outside Mainbrella. See `API.md` for retention and deletion semantics.
