# Managed prewarming pools

Server-managed pools are implemented in source. They require
`MANAGED_POOLS_ENABLED=true` in the API/account-coordinator deployment and the
existing container bindings. The flag is not enabled by this change. No new D1
migration is required. Live qualification remains outstanding.

The JavaScript and Python SDKs expose these APIs through `client.pools`. Their
existing process-local `pool()` helpers remain separate and do not create durable
server inventory.

## Contract

| Endpoint | Behavior |
| --- | --- |
| `GET /pools` | List owned pools and their readiness/error state |
| `POST /pools` | Create a pool; requires `Idempotency-Key` |
| `GET /pools/{poolId}` | Read one pool |
| `PATCH /pools/{poolId}` | Change `name` or `targetSize` |
| `DELETE /pools/{poolId}` | Stop unclaimed inventory and remove the pool |
| `POST /pools/{poolId}/acquire` | Claim one running generation; requires `Idempotency-Key` |

Creation requires `name`, `targetSize` (0–20) and `ttlSeconds` (60–86,400). At most
eight pools can exist per account. The sum of active pool targets cannot exceed
the account's container limit. Existing occupied slots and compute-unit limits
can still prevent a pool from filling.

Optional launch selection is `size`, `catalogId` or `imageId`, `internet`,
`networkPolicy`, and `secretBindings`, with the same ownership and security gates
as ordinary container creation. The defaults are Lite, the Node catalog image,
and internet enabled. Production lifecycle and workspace restoration are not
pool launch options. Pool selection and expiry cannot change after creation.
Create another pool for a different image or expiration.

Responses include a `pool` object with `id`, `name`, `targetSize`, `ready`,
`starting`, `status`, immutable public `selection`, and ISO `createdAt`,
`updatedAt`, and `expiresAt` timestamps. `status` is `active`, `paused`,
`degraded`, `expired`, or `deleting`; `lastError` explains the most recent refill
or cleanup failure. `starting` includes pending reservations and retryable
launch intents, so it does not guarantee a runtime has started. A successful
create persists desired inventory; it does not wait for that inventory to boot.

Warm inventory consists of ordinary paid ad-hoc containers. It uses normal start
quotas, concurrent slots, compute reservations, confirmed funding and spending
caps. Charges begin when a warm container starts, before acquisition. Guests keep
their original idle and session deadlines; acquiring one does not reset either
deadline. Unused guests can expire and consume another start when replenished.
No readiness or startup latency guarantee is implied.

`targetSize` counts only unclaimed inventory. Acquiring removes one running
generation atomically and schedules a replacement. Acquired containers are never
returned or recycled into a pool. Pool resize, deletion, and expiry affect only
inventory that remains unclaimed. Setting `targetSize: 0` pauses replenishment
and drains inventory. The original expiration remains fixed; after expiration,
the scheduler stops replenishing and drains remaining inventory. Expired pool
metadata remains listed until deleted and counts toward the eight-pool limit.

Warm guests also appear in ordinary account container listings and consume the
same limits. Acquire a guest before using it: directly accessing an unclaimed
guest does not remove it from pool ownership, and pool cleanup can still stop it.

Creation and acquisition receipts survive coordinator eviction and remain valid
for 24 hours. Retry uncertain requests with the original key. A create key cannot
recreate a deleted pool. An acquisition key cannot claim a replacement after its
original generation stops; this returns `409 acquisition_no_longer_running`.
Reusing an acquisition key against another pool returns an idempotency conflict.
No ready guest returns `409 pool_empty`; an expired pool returns `410 pool_expired`.

## Implementation and recovery

The account Durable Object owns the pool index, inventory and acquisition
receipts. Normal account start admission performs all quota, billing, image and
security checks. The account reservation, keyed creation record and inventory
ownership commit atomically before runtime provisioning. Boot occurs outside the
account mutation lock. Cleanup checks the reservation identity before stopping
any slot, including starts with lost replies. Claimed guests lose pool ownership
in the same durable write that records the acquisition receipt.

Account alarms schedule replenishment in batches of at most four starts. They
check full inventory every 30 seconds, use shorter scheduling for missing
inventory, and back off refill errors for 30 seconds. Alarms share the existing
billing, entitlement-refresh and stop reconciliation paths. Unknown runtime
outcomes retain their reservations and quota until normal reconciliation fences
or confirms them. Provider alarm timing and runtime availability can delay
replenishment or cleanup.

Deletion remains accessible during billing lookup outages and when issuance is
disabled. `503 pool_cleanup_pending` means the deletion intent is durable but
some stops need retrying; the scheduler continues cleanup. Repeated deletion is
safe. Cleanup does not implicitly snapshot or preserve the guest filesystem.

## Live qualification before rollout

Use a controlled paid staging account and the intended deployed image/runtime.
Confirm `pools.managed` reflects configuration, then record the deployment IDs,
account limits, starting wallet balance, creation keys and exact generations.

1. Create a one-guest pool with a short TTL. Close the SDK process, observe an
   alarm-created ready guest from a new client, and verify charged starts and
   reserved compute in normal account status.
2. Acquire it with a fixed key, replay that key, and acquire concurrently from a
   larger pool. Verify distinct keys never receive the same generation and a
   replay preserves the original one. Verify an empty pool returns `pool_empty`.
3. Let replacement provisioning complete. Resize to zero, delete, and separately
   allow TTL expiration. Verify all unclaimed guests stop, unused reservation
   funds release, and the acquired generation continues with its original
   deadline. Inspect accounting evidence for warm runtime and final stops.
4. Interrupt or lose a create/acquire response and restart or evict the account
   coordinator. Verify keyed retries and alarms recover ownership without extra
   reservations, duplicate acquisition or unowned running guests. Delay boot
   dispatch while deleting its pool and verify the reservation fence rejects it.
5. Fill normal concurrency, start quota, and spending limits. Verify refill
   reports the underlying error without bypassing admission or spinning alarms.
   Remove a limit condition and confirm refill recovers. Revoke paid access and
   verify warm guests stop; no new guests may start on stale paid evidence.
6. Stop a warm guest through the regular API, reuse its slot for an independent
   generation, and delete the pool. Verify cleanup cannot stop the replacement.
   Simulate an unavailable stop and verify durable cleanup resumes after recovery.
7. Exercise configured private images, internet-off selections, egress rules,
   and secret binding revocation before enabling those combinations publicly.
   Confirm runtime policy remains unchanged at acquisition.

For rollback, disable `MANAGED_POOLS_ENABLED` on the API/account coordinator.
New create, resize and acquisition requests fail closed, while list and delete
remain available. Account alarms drain unclaimed inventory without touching
acquired guests. Observe each affected account until cleanup completes and
reserved funds reconcile; do not assume the configuration change proves the
stops succeeded. Delete retained pool records if they should not resume after
re-enablement before their original expiration. Restore issuance only after the
failed qualification is understood and repeated successfully.
