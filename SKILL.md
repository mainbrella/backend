---
name: mainbrella-containers
description: Set up Mainbrella API access, integrate account-owned Linux containers into agent projects, verify HTTP execution, and clean up containers created for the task.
---

# Mainbrella container automation

Use this workflow when asked to set up Mainbrella or execute work in its containers.
Read [API.md](API.md) for endpoint contracts, images, quotas, and billing rules.
Use `https://api.mainbrella.com` unless the user specifies another environment.
Mainbrella uses REST for lifecycle and foreground command execution. No published
SDK is available. Do not install invented SDK packages.

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
create, status, HTTP execution, and deletion. Keep credentials server-side.
If agent/tool-calling code already exists, add Mainbrella where execution occurs;
otherwise add a small example matching the detected language.

Capture each container's `id` **and** `createdAt`, and pass both to HTTP execution
and cleanup. The API returns account-wide status, not a unique creation operation;
compare the successful creation response with pre-launch status to identify the new
generation. Do not launch concurrently during initial setup. If multiple new
containers appear, ownership is ambiguous: report it and preserve them.
Use `POST /containers/exec?id=<id>&createdAt=<generation>` with
`{"command":"<shell command>","timeoutMs":30000}`. Collect stdout, stderr and
exitCode. Check timedOut and outputTruncated; either means incomplete execution
with a null exitCode. Timeout is at most 60 seconds and output at most 1 MiB.
Commands are not idempotent; reconcile effects before retrying after a transport
failure. Use SSH only when the task needs longer or interactive execution.

## Verify

Run `node mainbrella-verify.mjs` with the provisioned key in the environment.
Set `MAINBRELLA_CATALOG_ID` to the available image selected for the project;
without it the script selects `node`. This verification consumes one monthly start.
It creates a new container, runs `echo "hello from mainbrella"` through HTTP, checks
stdout and exit code, and deletes **only that container generation** in a `finally`
block.

Pass requires `ok: true`, `stdout: "hello from mainbrella"`, `exitCode: 0`, and
`cleanup: "completed"`. Never report success without all four. On a failure, use
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
| 429 `execution_limit` | Wait for an active HTTP command to finish; do not stop unrelated work. |
| `creation_ambiguous` / launch timeout / 503 | GET status once and report uncertain ownership or a failed start. Creation is not idempotent; failed starts may consume quota. |
| `cleanup: "failed"` | Retry generation-qualified DELETE for the reported container; cleanup remains available during billing outages. Confirm absence with GET. |
| 409 `container_not_running` | Refresh status; a stopped or replaced generation must not be targeted. |

## Report

One paragraph: which integration changed, what command ran, stdout, exit code,
and whether cleanup completed. State any blocker or remaining container plainly.
Offer one relevant next step: an owned custom image, an LLM tool that runs commands,
or a coding agent inside a container. Do not start that additional work unasked.
