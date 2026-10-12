# P1 runtime status

Engineering status for the October 11, 2026 source changes. Source implementation,
local tests, deployed qualification and published SDK availability are separate.
This change does not close every P1 gap.

The subsequent [October 11 release-readiness record](release-readiness-2026-10-11.md)
tracks the CI correction, local qualification and read-only production checks.
In particular, migrations 039 and 040 are already applied in production; the
image credentials and live build gates remain outstanding.

| P1 capability | Result in this change | Remaining work |
| --- | --- | --- |
| Independent persistent volumes | Provider feasibility and lifecycle requirements documented | Runtime attachment, mount supervision, isolation, storage accounting and qualification |
| Memory-preserving pause/resume | Explicitly unavailable | Supported checkpoint primitive or a different runtime |
| Prewarmed pools | Durable account-owned server pools, automatic replenishment, bounded TTL, retry-safe acquisition; JS/Python clients | Deploy and qualify alarm recovery, concurrent acquisition and paid cleanup; `MANAGED_POOLS_ENABLED` remains off |
| Templates and images | Immutable IDs/digests, owner-scoped tags, SDK management, owner-scoped inline cache reuse, digest-pinned registry base imports | Configure a private build repository and registry encryption key; verify migrations per target; qualify real builds/cache hits/private imports; general declarative builder remains unavailable |
| Code interpreter | Stateful Python, bounded rich results, generation-scoped contexts | Deployed runtime qualification; additional languages |
| File transfers and syncing | 64 MiB streaming, atomic file commits, directory copies, polling watches | Resumable transfers, native watching and deletion/permission synchronization |
| Observability | OTLP JSON pull exports for lifecycle events and enabled metrics | Existing metrics/webhook live release gates; managed collector delivery |
| Agent/IDE integrations | Stdio MCP server, documentation and installed-package tests | Publication, managed LSP and a broader integration catalog |

Both SDKs require a new release for these source additions. No production
feature gate was enabled, no remote database migration was applied, and no
service was deployed as part of this change.

An October 11 metadata-only local check found no configured metrics token, image
dispatch token, registry-encryption key, webhook-encryption key or qualification
receiver token in the shell/ignored environment file. This checks local inputs,
not deployed secret state. Live build/metrics/webhook qualification therefore
still needs operator configuration, selected deployed revisions and a bounded
start/build budget; local tests cannot close those gates.

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

`/pools` and `client.pools` now implement durable server inventory in the account
coordinator. Alarms replenish normal billed ad-hoc sandboxes within account
limits. Required TTL is 60–86400 seconds; expiry, resize-to-zero and deletion
drain only unclaimed generations. Acquiring transfers ownership atomically and
preserves the original idle/hard deadline. Create/acquire receipts retain keys
for 24 hours. Cleanup checks the exact reservation and never stops an acquired
or subsequently replaced machine.

The runtime gate is `MANAGED_POOLS_ENABLED=true`, with account and runtime
bindings. It has not been enabled here. Tests exercise controller restart,
concurrent claims, lost responses, pending boot/deletion races, quota/billing,
expiry and generation replacement; provider alarm and real paid cleanup remain
live release gates. See [managed pools](managed-pools.md) for the rollout contract.
The original SDK `pool()` helper remains process-local with explicit refill;
its application-side journal/reconciliation requirements are unchanged.

## Images

Image IDs and digests identify immutable versions. Account-scoped movable tags
and SDK build/list/log/delete helpers are implemented in source. Migration
`039_image_tags.sql` is required for tags. Migration `040_image_build_inputs.sql`
adds owned-image cache selection and digest-pinned `ghcr.io`/`docker.io` base
imports. One-use registry credentials are encrypted with owner/build-bound
authenticated encryption and consumed only by trusted preparation. The customer
build job receives image bytes, without registry/control-plane credentials.

All new custom builds require a configured private build repository, whose
visibility is checked before admission. The public backend workflow cannot host
private source/layer artifacts. Cache hits and base/runtime compatibility need
real build qualification; the new bounded verifier prepares the evidence and
cleanup path but has not been run remotely. See [custom-images.md](custom-images.md).
A general declarative builder, arbitrary registry hosts and full platform/OS
selection remain outside this implementation.

## P2 follow-on

The first P2 source slice adds Linux desktop SDK helpers using the existing
bounded interpreter supervisor: Xvfb sessions, mouse/keyboard input, argv
launches and streamed PNG screenshots. It requires a compatible image and does
not add VNC, recording or Windows support. See [desktop.md](desktop.md) and
[P2 runtime status](p2-runtime-gaps.md). This does not close the outstanding
P1 volume, memory or live-qualification gates.
