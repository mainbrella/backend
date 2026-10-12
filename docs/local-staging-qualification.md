# Isolated local staging qualification

`scripts/qualify-local-staging.mjs` exercises the actual API routing and account/
container Durable Objects in Miniflare, with real Docker Linux processes,
filesystem snapshots and restoration. It accepts an existing **local** image and
a new evidence directory. It never loads `.env`, connects a remote binding,
pulls an image, calls Stripe or Cloudflare account APIs, or accepts a deployed
API URL.

Use a Python image with GNU `timeout` and the existing guest tools. Build the
checked-in catalog image locally if needed:

```sh
docker build -f containers/catalog/python.Dockerfile -t mainbrella-python-staging:local .
node scripts/qualify-local-staging.mjs \
  --image=mainbrella-python-staging:local \
  --output=artifacts/local-staging-unique-run
```

Image building can download public base images and packages. The qualification
runner itself refuses an absent image and binds its existing immutable Docker
image ID. Docker, host Python 3 (standard SQLite parser), and installed repository
dependencies are prerequisites.
Choose a fresh output directory for every run; prior evidence is never replaced.

The runner allocates separate local D1, Durable Object and R2 state. It creates
two disposable users and API keys, stores key hashes in local D1, and posts
explicit synthetic prepaid funding directly to each isolated account DO. This
qualifies prepaid admission/accounting behavior against a local fixture; it
does **not** qualify Stripe payment verification. API requests use the actual
key authentication and authorization handlers.

The integrated scenario is bounded to three account starts (source, fork and
resume), a separate native snapshot probe with two starts (capture and restore),
and a five-minute workload deadline plus a three-minute cleanup allowance. Native
probe commands have ten-second limits and its actor has a 45-second cleanup
alarm. Readiness, phase, RPC inventory, API cleanup, runtime disposal and Docker
commands also have individual bounds. It verifies immediate cancellation of a bounded sleep job without waiting for
running, subsequent file write/removal in the same generation, retained marker
bytes, streamed binary files, preserved Python
state and isolation, cross-account denials, protected preview forwarding and
credential stripping, independent fork writes with the source still running,
stop/resume filesystem metadata, stale-generation read/delete denials, and
idempotent resume replay. API/runtime compatibility dates and flags match the checked-in deployment
configuration; no staging-only request-disconnect flag is added. Lifecycle flags
exist only in the generated local
Miniflare bindings. No checked-in release gate is enabled.

A qualification-only container subclass adds a read-only snapshot-ID inventory
that waits for the existing serialized snapshot operation before reading its
durable receipts. Runtime handling, validation, authorization, snapshot capture,
process supervision, and routing reuse the existing implementations. The runner
cancels only its known exact generations, disposes its runtime, removes Docker
containers by its unique Worker prefix, and removes only snapshot handles
reported by its own actors. The native probe waits for its active operation
and saves its snapshot handle before attempting restore, allowing a lost client
response to be recovered while the actor remains alive. Local Docker snapshot
images omit container labels, so labels cannot establish snapshot ownership.
An actor/provider crash after capture acceptance but before handle persistence
remains unqualified; an ambiguous runtime receipt fails cleanup qualification. It never prunes unrelated Docker resources. The runner removes only signal
handlers installed by its own Miniflare instance so SIGINT/SIGTERM enter cleanup
instead of exiting immediately. Evidence records actual owned Docker container
and known snapshot-image inventories after removal; successful CLI removal alone is
not treated as proof that cleanup finished.

`qualification.json` records the source revision, local immutable image ID,
bundle/runner/host SDK entry/lockfile hashes and tooling versions, checks, generation identities,
local snapshot result, remaining live gates and
cleanup. It omits generated API keys and bearer preview URLs. The native probe saves its handle immediately in its isolated actor so cleanup
can recover it even if the response or restore is interrupted. A failed native
snapshot call records the actual runtime rejection, and lifecycle qualification
remains failed; there is no simulated snapshot fallback.

Local results do not establish crash recovery between accepted snapshot capture
and durable handle persistence, deployed snapshot behavior, deployed preview
DNS/TLS/WebSockets, deployed interpreter cancellation/recovery, sustained
streamed-transfer socket-disconnect cleanup, Stripe funding
proof, or package publication. Those remain explicit release gates. The runner
also does not claim adversarial network isolation from its filesystem scenario.

The local run found and exercises two integration boundaries that API mocks
cannot establish: real HTTP Content-Length preservation through streamed file
responses, and guest process-group identity independently of provider PID
namespaces. Detailed failed-run evidence remains separate from final successful
qualification evidence; source fixes require the final integration run and CI
checks to pass again.

Miniflare's dispatch transport preserves the requested preview URL while
rewriting its Host header to the loopback runtime origin. The local entry
fixture restores Host from that original `.localhost` URL and delegates to the
original Worker fetch handler. This permits actual token routing, credential
stripping and Docker forwarding to be tested; it does not qualify deployed DNS,
TLS or hostile Host-header handling. The production gateway is unchanged.

The earlier reviewed local run is
`artifacts/local-staging-reviewed-final/qualification.json` (`ok: true`). It passed the
integrated scenario, including immediate command cancellation followed by file
write/removal and retained marker bytes in the same running generation, and
removed two live generations, three reported snapshot
images and three owned Docker containers/proxies. Post-cleanup inventory found
no containers with the run's Worker prefix and none of its reported snapshot
image names. The evidence explicitly excludes captures whose handles were never
persisted or observed.

`artifacts/local-staging-reviewed-final-interrupt-native/qualification.json` records
SIGINT after native snapshot creation and before the probe response reached the
runner (exit 130). Cleanup recovered the actor's persisted handle.
`artifacts/local-staging-reviewed-final-interrupt-lifecycle/qualification.json` records
SIGTERM during real Python context work (exit 143). Both interruption checks
completed cleanup with no errors and empty observed inventories. All three
reports record identical API/runtime bundle hashes and runner hashes.

The October 12 parity follow-up is
`artifacts/p0-parity-final-20261012/qualification.json` (`ok: true`). It also
configures a multiline startup recipe on an existing source without changing
its PID or nonce, then verifies that fork and resume automatically start an
HTTP listener and pass readiness without a client launch command. Both restored
processes have fresh nonces: this qualifies application relaunch, not RAM
preservation. Replaying resume retains the restored PID and nonce instead of
launching again. The source remains alive and independent after the fork.
All other integrated checks passed, with two active generations, three reported
snapshots and three owned Docker containers/proxies removed, no cleanup errors,
and empty observed inventories. This remains an isolated local qualification;
the deployed and publication gates above are unchanged.

The local Miniflare Docker provider logs `SYS_ADMIN`, `/dev/fuse` and
`apparmor:unconfined` settings at startup. Deployed container isolation and
provider privilege parity remain outside this application lifecycle scenario.
