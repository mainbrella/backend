# P1 runtime status

Engineering status for the October 11, 2026 source changes. Source implementation,
local tests, deployed qualification and published SDK availability are separate.
This change does not close every P1 gap.

| P1 capability | Result in this change | Remaining work |
| --- | --- | --- |
| Independent persistent volumes | Provider feasibility and lifecycle requirements documented | Runtime attachment, mount supervision, isolation, storage accounting and qualification |
| Memory-preserving pause/resume | Explicitly unavailable | Supported checkpoint primitive or a different runtime |
| Prewarmed pools | JS/Python process-local inventory, explicit refill/acquire/cleanup | Server-managed persistent pools and automatic replenishment |
| Templates and images | Immutable IDs/digests, owner-scoped tags, SDK management | Build rollout, private registries, arbitrary bases and cross-build caching |
| Code interpreter | Stateful Python, bounded rich results, generation-scoped contexts | Deployed runtime qualification; additional languages |
| File transfers and syncing | 64 MiB streaming, atomic file commits, directory copies, polling watches | Resumable transfers, native watching and deletion/permission synchronization |
| Observability | OTLP JSON pull exports for lifecycle events and enabled metrics | Existing metrics/webhook live release gates; managed collector delivery |
| Agent/IDE integrations | Stdio MCP server, documentation and installed-package tests | Publication, managed LSP and a broader integration catalog |

Both SDKs require a new release for these source additions. No production
feature gate was enabled, no remote database migration was applied, and no
service was deployed as part of this change.

## Independent persistent volumes

`persistence.volumes` remains false. Cloudflare supports mounting R2 through FUSE,
but this is object storage with different consistency/performance and filesystem
semantics from a block volume. Its example installs FUSE and tigrisfs, supplies
bucket-scoped credentials, waits for the mount to be ready, and requires a clean
unmount after writes. Those credentials are visible inside the guest.
[Provider FUSE guide](https://developers.cloudflare.com/containers/examples/r2-fuse-mount/).

MainBrella has no qualified mount client in its images, owned volume attachment
registry, lease fencing, concurrent-writer policy, or durable mount supervisor.
Managed commands are capped at 15 minutes and use process-group SIGKILL at their
deadline. Running a writable FUSE mount as an ordinary managed command cannot
guarantee clean unmount or flushing. A volume implementation needs runtime-owned
attachment/teardown, failure and restart recovery, storage accounting, and
qualification with dirty writes and network interruption. An R2 project archive
or a filesystem snapshot does not satisfy that contract.

## Memory-preserving pause/resume

`persistence.memory` remains false. The provider's snapshot API saves filesystem
state and explicitly excludes memory and processes; snapshots also require their
original image version. MainBrella's stop/resume and fork restore files into a
new process environment. Interpreter state only lives in a running generation.
[Provider snapshot contract](https://developers.cloudflare.com/containers/guides/snapshots/).

Preserving RAM requires a supported runtime checkpoint/restore primitive or a
different execution backend, followed by qualification for processes, sockets,
timers and secrets. Renaming filesystem restore to pause would not implement it.

## Prewarming

The SDK adds process-local `pool()` helpers with explicit refill, acquisition and
cleanup. Inventory consists of normal billed ad-hoc sandboxes and retains their
account limits and timeouts. Pending creates preserve their keys within a bounded
retry window; cleanup retains exact generations. No server scheduler, persistent
pool ownership, keepalive, or crash-restorable client state exists. Application
journaling and ordinary generation/key reconciliation are still necessary after
client process loss. See the SDK READMEs for cost and recovery behavior.

## Images

Image IDs and digests identify immutable versions. Account-scoped movable tags
and SDK build/list/log/delete helpers are implemented in source. Migration
`039_image_tags.sql` is required for tags. Private registry imports, arbitrary
base images, cross-build caching and a general declarative template builder are
still unavailable. Custom builds remain gated by configured dispatch credentials
and require the deployed qualification described in [custom-images.md](custom-images.md).
