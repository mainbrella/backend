# Persistent workspace rollout and qualification

V1 saves the writable root filesystem and restores it into a new generation. It provides authenticated ownership, save/stop, restore, archive, deletion, reserved-capacity quotas, fixed retention and bounded portable `/workspace` export. The lifecycle API adds safe stop/resume and filesystem-only forks behind `WORKSPACE_LIFECYCLE_ENABLED`. It does not preserve RAM or running processes, and it is not a mounted volume or continuous crash-safe disk. See API.md for the customer contract.

Deploy the container runtime first, then the API with WORKSPACE_PERSISTENCE_ENABLED unset or false. Existing APIs keep their behavior. The private versioned snapshot/start protocol and digest preflight prevent restoring through a runtime that ignores the snapshot selection. Saved handles stay inside account/runtime Durable Object storage. The account serializes admissions, quota reservations and saves; chunked indexes avoid per-value storage limits. Capture intent is durable before contacting the provider. Ambiguous provider capture is never retried as a new capture. Native capture holds the generation lifecycle lock until the provider call settles.

After enabling issuance for qualification, run the prepared verifier only within an approved paid-start budget:

```
node scripts/verify-workspaces.mjs --max-starts=2 --output=.wrangler/workspaces-qualification-<date>
```

The verifier requires an empty primary account, both API keys in .env, no concurrent account starts, and enabled snapshot/export discovery. It writes mode-0600 recovery evidence before each start/save, allows no blind admission retries, enforces a ten-minute wall deadline, verifies bytes/symlinks/mode/mtime, owner isolation, save replay, archive, stopped-generation fencing, export contents, deletion denial and exact-generation cleanup. Failed or ambiguous runs retain recovery keys. Inspect them before rerunning. Keep the flag disabled if qualification fails. Deploy dashboard/SDK documentation after the backend passes; package publication remains separate.

The isolated Cloudflare snapshot probe passed on 2026-10-06 UTC: 2,100,793 bytes restored with matching SHA-256, native startup 8,141 ms, snapshot 3,356 ms, restore 1,631 ms, cleanup confirmed. The temporary public probe endpoint was disabled afterward. This proves feasibility, not qualification of the customer API.

The customer API was qualified on 2026-10-06 UTC with exactly two measured starts. Save/stop, idempotent save replay, archive denial, restore, binary bytes, symlink/mode/mtime preservation, ownership isolation, process-state exclusion, stale-generation fencing, portable export and deleted-restore denial passed. Runtime version: `5854b518-6edd-4c26-acae-8190854f1829`; qualification API version: `ace13b66-cf20-4f78-a837-99402133fb69`.

The original verifier reported a cleanup failure because deleting the already replaced source returned the expected fenced HTTP 409. Issuance was immediately disabled (`3b7f3438-f0ca-41ed-a24d-b5b8a2d0892f`). Reconciliation confirmed both exact generations absent, the account empty, the saved workspace deleted and the start delta still exactly two. The verifier now accepts a cleanup 409 only after an authenticated list confirms that exact generation absent; its regression tests also reject a still-present generation. The original failed report is preserved alongside separate reconciliation evidence in `.wrangler/workspaces-qualification-20261006-release/`. No qualification rerun or additional start was used. Snapshot issuance is enabled following that reconciled qualification. Dashboard and registry-installed SDK workflows were qualified separately below.

Backups are customer downloads, not a managed offsite backup service. Physical provider snapshots follow provider retention; public delete revokes new admission and releases quota without guaranteeing immediate provider erasure. Image changes can make snapshots incompatible, so image rollout must retain needed digests or require customer export before replacement. Workspaces are subject to current plan limits; retained metadata remains accessible during billing outages.

Cost controls reserve full source disk capacity before each capture. Builder ($5)
allows 3 live workspaces / 8 GB, 10 new saves/month and 20 GB of capture capacity;
Pro ($180) allows 20 / 160 GB, 100 saves and 400 GB; Scale ($999) allows
100 / 1,000 GB, 500 saves and 2,000 GB. Both UTC-month and retained capture budgets
apply. Reservations survive deletion, expiry, billing changes, failed captures,
controller restarts and receipt pruning. They persist for at least 60 days, with
daily aggregation conservatively retaining earlier captures for up to one extra
day. Existing workspace expiry/restore eligibility is preserved. Legacy monthly
save counts without recoverable records reserve the largest supported disk;
never silently reset existing usage at rollout.

These are conservative capacity controls, not a guarantee of profit. Cloudflare
has no published separate native-snapshot rate as of October 6, 2026. At a
hypothetical $0.03/GB-month, the retained caps correspond to $0.60 / $12 / $60
per account-month (12% / 6.7% / 6% of gross plan revenue), before compute,
requests, metadata, payment fees and other costs. This is a stress assumption,
not a Cloudflare quote. Revisit the caps against actual provider billing before
increasing them. Sources: https://developers.cloudflare.com/containers/platform/pricing/
and https://developers.cloudflare.com/containers/guides/snapshots/.

## Safe stop, resume and fork

`POST /containers/stop`, `/containers/resume` and `/containers/fork` accept the
source `{id, createdAt}` and require `Idempotency-Key`; fork also accepts `name`.
They return the ordinary account status. Resume and fork include the existing
`creation` receipt. `DELETE /containers` retains permanent deletion semantics.

Safe stop reserves the same workspace capture/count/disk budgets and retention
as an explicit save. Capture completes durably before compute stops. Capture
failure leaves the live source running; ambiguous provider captures cannot be
blindly repeated. The stopped descriptor preserves its slot and generation,
with `workspaceId`, `status: "stopped"` and `persistenceExpiresAt` in epoch
milliseconds. Stopped identities occupy no compute/concurrency allowance and
cannot be reused by unrelated starts. They remain visible after expiry until
deleted. The associated save is visible in Workspaces and counts toward its
limits. Deleting or archiving it can prevent resume.

Resume uses the same slot with a fresh fenced runtime generation and reapplies
its image, size, network policy, secret bindings and production startup command.
It reserves a new start and runtime lease. A failed restore never falls back to
an empty image; its checkpoint stays available for a new keyed retry after the
uncertain start reservation is reconciled. Old access credentials and stale
lifecycle requests cannot act on the new generation. A completed stop retry is
safe even after the machine resumes.

Fork captures the live source and starts an independent Ad Hoc machine from
that filesystem. It leaves the source running, retains its network restrictions
and secret bindings, and uses ordinary start/compute capacity limits. The capture
and creation have durable replay receipts, so a retry can finish from a captured
source even if that source has since stopped. Filesystem writes diverge after
fork; processes and RAM are not copied. Applications that need a transactionally
consistent database snapshot must quiesce writes themselves before capture.

Explicit lifecycle operations were exercised with local runtime doubles,
including binary files, lost replies, controller eviction, capture/restore
failure, expiry/deletion, generation fencing, quotas, independent fork writes,
and Production checkpoint recovery. These are not new paid-provider
qualification results. Keep lifecycle issuance gated until a deployed runtime,
API, SDK and dashboard qualification is completed under an approved budget.

## Saved launch recipes and application readiness

When `persistence.restoreLaunch` is enabled, `POST /workspaces` accepts an
optional immutable `launch` recipe:

```json
{
  "command": "npm start",
  "cwd": "/workspace/app",
  "readiness": { "port": 3000, "path": "/health", "timeoutMs": 30000 }
}
```

Saving only records this recipe; it never starts or changes the source
application. A restore starts the command once in its new filesystem generation.
The command must stay in the foreground. There is no automatic restart, memory
copy, process continuation or live cloning. Without a recipe, restore preserves
the existing filesystem-only behavior. Safe Stop/Resume and Fork inherit the
source generation's saved recipe, including after its original workspace has
been deleted. Explicit Save without `launch` still creates a filesystem-only
workspace.

An ordinary running ad hoc source can now register the same recipe using
`PATCH /containers/startup` with `{id, createdAt, launch}`. This requires
`persistence.startupConfiguration`. It only changes generation-scoped metadata:
it neither starts nor restarts the source. Both the account lock and runtime
generation check fence stale requests. Repeating an identical update is safe;
`launch:null` clears future automatic startup. `GET /containers` exposes the
canonical recipe as `launch`; stopped descriptors retain its summary. Existing
saved workspaces remain immutable. Production containers retain their separate
`startupCommand` supervisor and reject this setting. An older container runtime
returns `workspace_launch_unavailable`, so deploy the runtime before the API.

The JavaScript SDK exposes `sandbox.configureStartup(recipe)` and
`sandbox.waitUntilReady()`; Python exposes `configure_startup(recipe)` and
`wait_until_ready()`. The readiness helpers only poll the exact generation and
reject stopped/replaced machines, missing readiness, launch failures and timeout.
Their successful return establishes the saved initial HTTP check, not continuous
uptime. These additions have local regression coverage; they require deployment
and SDK publication before customer use, followed by production qualification.

The command is a single line of at most 4096 characters. `cwd` is an absolute
directory without dot segments, defaults to `/workspace`, and is limited to
1024 characters. Readiness uses an application port from 1024–65535 and a local
HTTP path (default `/`, at most 1024 characters); redirects are not followed.
The timeout is 1000–60000 ms, default 30000, starting after machine boot and
clamped to the machine's compute deadline. The save request is limited to 32 KiB.
Recipe defaults are canonicalized before the keyed-save fingerprint is recorded.
Recipes accept no raw environment values. Existing vault secret bindings retain
their established egress behavior; their values are not injected into the guest.

Machine `status: running` and application `readiness.status` are distinct.
Creation responses, keyed creation retries and `GET /containers` expose
`starting`, `ready` or `failed`. Only a local HTTP 2xx before the saved deadline
marks the application ready. This is an initial readiness check, not continuous
health monitoring. Status reads and retries only observe the saved launch; they
never execute it again. The watcher operates outside account mutations, fences
the exact generation and runtime incarnation, and resumes after controller
eviction without relaunching the command.

An exited foreground command or readiness timeout leaves the machine available
for inspection, with `error: launch_exited` or `readiness_timeout`, `logPath` and
up to 8192 UTF-8 bytes of diagnostic `logTail`. This tail is best effort at the
time of failure; output may still be draining to the guest log. Exit reporting
does not wait indefinitely for background descendants to close output streams.
The guest retains current and
previous log files, each bounded to 1 MiB, under the generation-specific log
path; this bound is per launch. Later snapshots can inherit earlier log files,
which continue to use ordinary guest disk space. Logs are authenticated account
data and may contain application output. An unavailable launch-capable runtime
fails closed with `workspace_launch_unavailable` rather than silently restoring
an idle filesystem. The local controller and shell tests cover response loss,
single launch, readiness deadlines, retained diagnostics, controller eviction,
generation replacement and recipe inheritance. Deployment and paid-provider
qualification remain separate work.

## Installed SDK workspace qualification

On October 6, 2026, clean registry installations of `@mainbrella/sdk@0.1.0`
and `mainbrella==0.1.0` each passed a production save/stop, restore and portable
export workflow. The checks exercised the public SDK save and restore helpers,
same-key save replay, list/get/rename, cross-account denial, binary bytes,
symlink/mode/mtime preservation and stale-generation fencing. Both exported
archives were inspected independently on the host and retained as private evidence.

The JavaScript run used two Lite Node starts and Python used two Lite Python
starts. Account usage increased from 61 to 65; both exact generations from each
run are absent, both temporary workspaces are deleted, and pre-existing workspace
metadata was preserved. Evidence is in
`.wrangler/workspace-clients-20261006/javascript.json` and `python.json`, with
the corresponding `*-workspace.tar.gz` exports. These checks consumed four of
the approved six starts. The dashboard check below consumed the remaining two.
No backend deployment or capability change was needed.

## Production dashboard qualification

On October 6, 2026, the production dashboard passed save with stop, saved-workspace
listing, restore, stop and deletion through its browser controls. Binary bytes,
symlinks and file permissions survived restore. The restored generation's portable
export was downloaded with the published JavaScript SDK and inspected independently
on the host; this is SDK export evidence, not a dashboard export control.

The initial browser-account mismatch attempt is preserved in
`.wrangler/workspace-clients-20261006/dashboard.json` and consumed no starts.
The successful run used the browser account's separately supplied `FOO_KEY` after
its Builder trial became active. It consumed exactly two Lite Node starts, from
zero to two. The original SDK qualification account remained at 65 starts.
Authenticated follow-up lists confirmed both accounts have no containers or saved
workspaces, and the verifier confirmed both exact generations absent.

Chromium verification passed at 390×844, 768×1024, 1280×800 and 1440×900 with
no horizontal overflow or page errors; screenshots were also reviewed. Private
evidence, screenshots, the independently inspected export and a hashed summary are
in `.wrangler/workspace-dashboard-20261006-r2/`. Web deployment version:
`8a121d1a-61c8-4c38-8e3e-ded302c52a15`. The six-start client qualification budget
is fully consumed; no additional start or backend capability change was needed.
