# Live process cloning assessment

Assessed October 12, 2026. Mainbrella's current runtime can restore a filesystem
and start an application from an explicit recipe. It cannot yet clone the
application's running process or memory. Keep `persistence.memory: false`.

## What is available now

`containers/workspaces.js` calls Cloudflare's `snapshotContainer()` and restores
the resulting handle through `container.start({containerSnapshot})`. The
[Cloudflare snapshot contract](https://developers.cloudflare.com/containers/guides/snapshots/)
explicitly excludes memory and running processes. The installed runtime interface
in `cloudflare-configuration.d.ts` has no memory-checkpoint operation or start
option for host devices, Linux capabilities, or privileged execution.

An application launch recipe closes the ordinary readiness gap: the restored
files can be used by a freshly started application, and a successful HTTP check
can establish readiness. It does not preserve an original nonce, an in-memory
queue, a paused call stack, or open connections. Report those separately in any
comparison. Retrying a restore must reuse the original creation receipt rather
than start another process.

Ordinary running containers can now save their future recipe with
`PATCH /containers/startup`; the app exposes Startup settings and repository
launches register their known command, directory and readiness path. Filesystem
fork and stop/resume inherit it. The JavaScript and Python SDKs expose an
explicit readiness wait that fences the exact generation and surfaces startup
failures. See [startup and readiness](workspaces.md#saved-launch-recipes-and-application-readiness).
This is a source change, and the new `startupConfiguration` discovery flag lets
clients distinguish it from older deployments that only accept a recipe when
saving a workspace.

## Alternatives and their prerequisites

**Provider-native memory snapshots:** the smallest integration if Cloudflare
adds this facility. No such operation was found in the current documentation or
installed API. An implementation would need memory-inclusive handles, image and
runtime compatibility, explicit pause/resume behavior, and independent restore
identities. Do not assume filesystem handles will gain these semantics.

**CRIU process checkpoints:** [CRIU](https://github.com/checkpoint-restore/criu)
can save and restore Linux tasks. It requires appropriate kernel features,
permissions, and support for the workload's resources; installing a binary is
not sufficient. See the project's
[command and privilege documentation](https://github.com/checkpoint-restore/criu/blob/criu-dev/Documentation/criu.txt).
We have not qualified CRIU checkpoint/restore inside a deployed Cloudflare
container. A read-only production diagnostic did find effective and bounding
`SYS_ADMIN` and `SYS_PTRACE`, no seccomp filter, and a `/dev/kvm` device. The start
API does not expose controls for those facilities, but their observed presence
makes it incorrect to dismiss an in-guest CRIU experiment solely for missing
privileges. Kernel features, process resources and cross-container restoration
still need direct tests. A restricted single-process experiment would not prove
arbitrary sandbox cloning.

**A runtime we operate with memory snapshots:**
[Firecracker's snapshot API](https://github.com/firecracker-microvm/firecracker/blob/main/docs/snapshotting/snapshot-support.md)
can capture a paused microVM's memory and device state. Disk backing files must
also be managed. This would require a Linux/KVM execution fleet and a new runtime
adapter, with compatible hosts, storage, networking, placement, billing, and
cleanup. Independent clones also need correct identity and entropy handling.
This is an infrastructure project, not an option on the existing Cloudflare
container. No new fleet or provider was provisioned for this assessment.

## Diagnostic run

`experiments/checkpoint-support.mjs` reads selected kernel capability facts,
seccomp mode, KVM device presence, and an installed CRIU version. It does not
checkpoint anything or establish that restore works. Run it inside a disposable
candidate runtime:

```sh
node experiments/checkpoint-support.mjs
```

The local Docker run on October 12 used the existing Mainbrella terminal image
`sha256:4634a0725f39588677c2a043ea8045063c9eadf596be79331894af44714d3076`,
with no network, a read-only root filesystem, and no added privileges. It reported
Linux x64, UID 0, seccomp mode 2, no effective or bounding `SYS_PTRACE`, `SYS_ADMIN`,
or `CHECKPOINT_RESTORE`, no `/dev/kvm`, and no CRIU binary. The container was removed
on exit. This is evidence about that local Docker configuration only; it does
not establish the deployed Cloudflare kernel's permissions. The diagnostic's
`processRestoreVerified` remains false in every case.

The separate production diagnostic completed at 2026-10-12 12:29:19 UTC, before
the parity work and comparison pause. It reported Linux x64,
`6.18.54-cloudflare-microvm-2026.9.16`, UID 0, effective/bounding `SYS_ADMIN` and
`SYS_PTRACE`, no `CHECKPOINT_RESTORE`, seccomp mode 0, `/dev/kvm` present, and no
installed CRIU. It created and removed one owned sandbox; cleanup was confirmed.
The input script SHA-256 was
`6390420db07e9565fcafd1903f7e417ef6f94bdf594a47e790b9701fbc1a13f1`.
Retained evidence is in the sibling Repo Rodeo checkout at
`artifacts/mainbrella-checkpoint-support-2026-10-12T12-29-10-337Z/result.json`.
This reports available facilities, not a successful checkpoint or usable nested
virtualization.

## First process experiment

`experiments/criu-process-smoke.mjs` runs only in a disposable Linux guest with
Node and CRIU already installed. It prepares five random memory-only jobs in its
own HTTP worker, attempts a CRIU dump and restore, and compares the listening
worker's PID, nonce and jobs before trying a cold restart. It checks the unique
fixture path and Linux process start time before cleanup. Its report always
distinguishes a same-guest process restore from a cross-container fork:

```sh
node experiments/criu-process-smoke.mjs --output /tmp/criu-NEW-RUN
```

The first actual run used local native ARM64 Linux, CRIU 4.1.1, added
`SYS_ADMIN`/`SYS_PTRACE`, and seccomp disabled. CRIU's kernel check failed on
restricted network operations and the read-only `ns_last_pid` sysctl. The actual
Node dump also failed on an `anon_inode:[io_uring]` mapping. No restore succeeded;
the owned worker and disposable container were removed. Evidence is in
`artifacts/mb-criu-parity-1b1c937e/`. These are local runtime/workload failures;
they are not evidence that the different Cloudflare x64 kernel has the same
restrictions. Catalog images, production processes and feature flags were not
changed by this experiment.

The next gate is a bounded same-guest restore on the deployed runtime, followed
by a consistent filesystem capture while the process is stopped and restoration
into independent containers. Even after that works, the backend must account
for interpreter/execution metadata held outside the guest in Durable Objects,
process identity, sockets, timers, failure recovery and secret isolation. Keep
`persistence.memory:false` until those semantics are implemented and qualified.

## Acceptance before enabling memory persistence

Use the same externally prepared workload and verification across runtimes:

1. Prepare a paused worker with a random nonce and a queue that exists only in
   its memory. Record the external input ledger without placing it in guest
   files or launch commands.
2. Capture once and restore at least three independent branches. Before sending
   application input or executing a launch recipe, check that the original
   nonce, queue fingerprint, and listening service are present.
3. Apply baseline, correct, and misleading patches through an explicit supported
   patch-loading boundary. Check exact receipts against the external ledger.
   This is not a claim of transparent patching of arbitrary running code.
4. Show that a cold restart loses the reproduction and that changing one branch
   leaves the source and other branches unchanged. Verify files as well as RAM.
5. Measure capture pause, restore latency, memory/disk cost, failure cleanup,
   expired-handle behavior, dropped connections, and retry behavior. Repeat
   through a fresh client and an interrupted response.
6. Verify generation fencing, independent credentials and entropy, account
   isolation, and defined behavior for external connections before admitting
   customer workloads.

The current implementation can improve restart readiness and recovery while
this capability remains unavailable. No current article result should be changed
to claim inherited processes on the strength of a successful fresh launch.
