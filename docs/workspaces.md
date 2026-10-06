# Persistent workspace rollout and qualification

V1 saves the writable root filesystem and restores it into a new generation. It provides authenticated ownership, save/stop, restore, archive, deletion, reserved-capacity quotas, fixed retention and bounded portable `/workspace` export. There is no automatic persistence on stop, RAM/process restore, mounted-volume persistence or fork API. See API.md for the customer contract.

Deploy the container runtime first, then the API with WORKSPACE_PERSISTENCE_ENABLED unset or false. Existing APIs keep their behavior. The private versioned snapshot/start protocol and digest preflight prevent restoring through a runtime that ignores the snapshot selection. Saved handles stay inside account/runtime Durable Object storage. The account serializes admissions, quota reservations and saves; chunked indexes avoid per-value storage limits. Capture intent is durable before contacting the provider. Ambiguous provider capture is never retried as a new capture. Native capture holds the generation lifecycle lock until the provider call settles.

After enabling issuance for qualification, run the prepared verifier only within an approved paid-start budget:

```
node scripts/verify-workspaces.mjs --max-starts=2 --output=.wrangler/workspaces-qualification-<date>
```

The verifier requires an empty primary account, both API keys in .env, no concurrent account starts, and enabled snapshot/export discovery. It writes mode-0600 recovery evidence before each start/save, allows no blind admission retries, enforces a ten-minute wall deadline, verifies bytes/symlinks/mode/mtime, owner isolation, save replay, archive, stopped-generation fencing, export contents, deletion denial and exact-generation cleanup. Failed or ambiguous runs retain recovery keys. Inspect them before rerunning. Keep the flag disabled if qualification fails. Deploy dashboard/SDK documentation after the backend passes; package publication remains separate.

The isolated Cloudflare snapshot probe passed on 2026-10-06 UTC: 2,100,793 bytes restored with matching SHA-256, native startup 8,141 ms, snapshot 3,356 ms, restore 1,631 ms, cleanup confirmed. The temporary public probe endpoint was disabled afterward. This proves feasibility, not qualification of the customer API.

Backups are customer downloads, not a managed offsite backup service. Physical provider snapshots follow provider retention; public delete revokes new admission and releases quota without guaranteeing immediate provider erasure. Image changes can make snapshots incompatible, so image rollout must retain needed digests or require customer export before replacement. Workspaces are subject to current plan limits; retained metadata remains accessible during billing outages.
