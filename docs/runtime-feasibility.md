# Resource and snapshot feasibility probes

The local production API implements five named sizes and no customer persistence; actual deployed values and representative workload behavior remain release gates. The code in `experiments/` provides an isolated way to gather evidence before changing those contracts. No provider probe or deployment has been run as part of this work.

## Isolated runtime experiment

`experiments/wrangler.runtime-probe.jsonc` describes a separate private Worker with a disposable container Durable Object. It has no customer account bindings, public routes or HTTP probe endpoint, and is not included in `npm run deploy`. To run it, deploy that separate configuration and invoke its binding from a private operator Worker using a fresh object for each sample:

```js
const probe = env.RUNTIME_PROBE.get(env.RUNTIME_PROBE.idFromName(crypto.randomUUID()));
const result = await probe.run({
  instance: 'standard-1',
  workload: 'typescript',
  snapshot: true,
});
```

Confirm the binding name against the experiment configuration. Each object is single-use. The probe disables outbound internet, installs a three-minute cleanup alarm, writes a random 2 MiB file and marker, and optionally compiles 200 generated TypeScript modules. It records start/workload/snapshot/restore timings, image identity, file checksum and cleanup outcome. Snapshot restore must reproduce both the marker and checksum; failure does not fall back to an empty image.

These fixed workloads check the mechanism. They do not qualify npm installs, application builds, browser workloads or customer repositories. Verify both the result and container cleanup; a failed cleanup retains the alarm for another attempt. Stored snapshot handles are subject to provider expiry rather than an explicit deletion step.

The probe accepts the instance names represented in the installed runtime types: `lite` and `standard-1` through `standard-4`. The [provider limits](https://developers.cloudflare.com/containers/platform/limits/) also describe other configurations; validate API and account compatibility before adding any of them. Do not select production resources through client-supplied forwarding headers.

## Cost estimates and production gates

`scripts/estimate-resource-cost.mjs` accepts explicit JSON inputs on stdin. `cpuSeconds` is active vCPU-seconds per container. Memory and disk are provisioned per container for `runningSeconds`; `egressGB` is the aggregate across all containers. Supply rates from the current [provider pricing](https://developers.cloudflare.com/containers/platform/pricing/):

```json
{
  "containers": 10,
  "cpuSeconds": 30,
  "memoryMiB": 4096,
  "diskGB": 8,
  "runningSeconds": 600,
  "rates": {
    "cpuPerVcpuSecond": 0.00002,
    "memoryPerGiBSecond": 0.0000025,
    "diskPerGBSecond": 0.00000007
  },
  "egressGB": 1,
  "egressPerGB": 0.025
}
```

These example rates were checked on October 5, 2026; the tool deliberately does not supply defaults. Its output is gross marginal resource cost before included allowances and excludes Workers, Durable Objects, D1, logs, builds, registry, snapshots and support.

Before offering larger resources, run representative install/test/build/browser workloads, measure startup and concurrent use, and model the worst case allowed by each plan. Add server-side resource entitlements, include the selected resource in creation idempotency, and update runtime status, capability discovery, OpenAPI, SDKs and documentation together.

## Filesystem snapshots

The provider's [snapshot guide](https://developers.cloudflare.com/containers/guides/snapshots/) describes filesystem snapshots rather than process or memory checkpoints. Snapshots are tied to compatible image versions and expire after 30 days, with expiry refreshed on restore. Snapshot handles can be stored in Durable Object storage.

The mock tests verify that the experiment supplies a snapshot ID without an image on restore, checks content and cleans up failures. A deployed smoke test is still required to prove provider behavior and measure latency/cost.

A customer-facing workspace needs an owning account, compatible image identity, snapshot retention and quotas, explicit expiry errors, generation fencing, and billing policy. Define stop/restore/archive semantics before exposing persistence. Expired or incompatible snapshots must produce a visible failure rather than silently creating an empty workspace.
