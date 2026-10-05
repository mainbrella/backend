---
name: mainbrella-containers
description: Set up Mainbrella API access, integrate account-owned Linux containers into agent projects, verify HTTP execution and file transfer, and clean up containers created for the task.
---

# Mainbrella container automation

Use this workflow when asked to set up Mainbrella or execute work in its containers.
Read [API.md](API.md) for endpoint contracts, images, quotas, and billing rules.
Use `https://api.mainbrella.com` unless the user specifies another environment.
Mainbrella uses REST for lifecycle, foreground command execution, and file transfer. No published
SDK is available. Do not install invented SDK packages.
Local SDKs exist under `sdk/javascript` and `sdk/python` when this backend checkout
is available. Install from those paths only; see their READMEs for the actual API.
Use public `GET /capabilities` to discover deployment support before choosing an
execution mode. Obtain account allowances and deployed images from `/containers`.

## Quick Setup

1. Read `MAINBRELLA_API_KEY` from the project's existing environment loading or
   secret manager. It starts with `mb_`. If missing, ask the user to sign in at
   `https://mainbrella.com/api-keys/`, create a named key, and provision it locally
   as `MAINBRELLA_API_KEY`. Do not ask them to paste the secret into chat. A key
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
   The doctor prints JSON diagnostics without secrets and performs only GETs.
   Exit 0 means ready for a new verification container; exit 1 identifies blockers.
   `MAINBRELLA_API_URL` optionally selects a different HTTPS origin (HTTP localhost
   is allowed for development). It must not contain a credential, path, or query.
5. Choose an image from the returned `GET /containers` `imageCatalog`: prefer
   `node`, `python`, `rust`, or `go` for the detected language, and `devops` for
   infrastructure tasks. Only choose IDs actually advertised by this deployment.
   For user-requested custom environments, read `/images` and use an owned `ready`
   image. `buildsEnabled` determines whether new builds can be submitted.

## Integrate

Use native HTTP facilities (`fetch` in Node, `urllib.request` in Python). Follow [API.md](API.md) for authenticated
create, status, HTTP execution, file read/write, and deletion. Keep credentials server-side.
If agent/tool-calling code already exists, add Mainbrella where execution occurs;
otherwise add a small example matching the detected language.

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
by reading before retrying. Use execution for directory creation and listing.

## Verify

Run `node mainbrella-verify.mjs` with the provisioned key in the environment.
Set `MAINBRELLA_CATALOG_ID` to the available image selected for the project;
without it the script selects `node`. This verification consumes one monthly start.
It creates a new container, runs `echo "hello from mainbrella"` through HTTP, checks
stdout and exit code, writes and reads a binary probe under `/tmp`, compares every
byte, and deletes **only that container generation** in a `finally` block.

Pass requires `ok: true`, `stdout: "hello from mainbrella"`, `exitCode: 0`,
`files: "verified"`, and `cleanup: "completed"`. Never report success without all five. On a failure, use
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
| `file_too_large` / `invalid_file_path` | Use files up to 1 MiB and valid absolute paths; use authorized SSH for larger transfers. |
| `file_not_found` / `not_regular_file` / `file_access_denied` | Check the path, parent directory and guest permissions. Writes need a regular file or an unused path. |
| `idempotency_key_conflict` | The key belongs to a different image selection. Use the original request to reconcile it; use a new key only for an intentional new launch. |
| `creation_no_longer_running` | The original operation stopped or failed. Do not touch a replacement in its slot. |
| `creation_ambiguous` / launch timeout / 503 | Retry the same creation key and image selection within 24 hours; `starting` means wait and retry. Preserve `creationKey` if verification remains unresolved. Failed starts may consume quota. |
| `cleanup: "failed"` | Retry generation-qualified DELETE for the reported container; cleanup remains available during billing outages. Confirm absence with GET. |
| 409 `container_not_running` | Refresh status; a stopped or replaced generation must not be targeted. |

## Report

One paragraph: which integration changed, what command ran, stdout, exit code,
whether the binary file round trip passed, and whether cleanup completed. State any blocker or remaining container plainly.
Offer one relevant next step: an owned custom image, an LLM tool that runs commands,
or a coding agent inside a container. Do not start that additional work unasked.
