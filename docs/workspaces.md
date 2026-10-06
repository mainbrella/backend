# Persistent workspace rollout and qualification

V1 saves the writable root filesystem and restores it into a new generation. It provides authenticated ownership, save/stop, restore, archive, deletion, reserved-capacity quotas, fixed retention and bounded portable `/workspace` export. There is no automatic persistence on stop, RAM/process restore, mounted-volume persistence or fork API. See API.md for the customer contract.

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
