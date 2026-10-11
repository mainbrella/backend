# Mainbrella JavaScript SDK

Published as `@mainbrella/sdk` 0.1.0 on npm. Requires Node 22+; no runtime dependencies.

The source additions documented below are available in this source checkout and need a new SDK release and matching API/runtime deployment. They are not included in the already-published 0.1.0 artifacts.

```sh
npm install @mainbrella/sdk@0.1.0
```

```js
import { Mainbrella } from '@mainbrella/sdk';

const client = new Mainbrella({ apiKey: process.env.MAINBRELLA_API_KEY });
console.log(await client.capabilities());
const sandbox = await client.create({ catalogId: 'node' });
try {
  const result = await sandbox.commands.run('printf hello');
  await sandbox.files.write('/tmp/probe.bin', new Uint8Array([0, 128, 255]));
  const bytes = await sandbox.files.read('/tmp/probe.bin');
  console.log(result.exitCode, bytes.length);
} finally {
  await sandbox.kill();
}
```

Creation retries use the same key until the bounded wait expires. An ambiguous
creation error contains `idempotencyKey`; preserve it and retry the same selection.
Commands and file writes are never automatically retried. Inspect the file or
application state after a lost response. `connect({id, createdAt})` attaches to
an explicit existing generation without creating or stopping anything.

The richer filesystem helpers require the corresponding `capabilities.files`
flags. They operate on absolute UTF-8 guest paths:

```js
await sandbox.files.mkdir('/workspace/output', { recursive: true, mode: '0700' });
const page = await sandbox.files.list('/workspace', { limit: 100 });
// Pass page.nextOffset as offset for the next page, if it is not null.
const metadata = await sandbox.files.stat('/workspace/output');
await sandbox.files.move('/tmp/probe.bin', '/workspace/output/probe.bin');
await sandbox.files.chmod('/workspace/output/probe.bin', '0640');
await sandbox.files.remove('/workspace/output', { recursive: true });
```

Lists contain one level, sorted by UTF-8 filename bytes, with up to 1,000 entries
per page. Pagination rescans; directory changes can duplicate or omit entries.
Metadata includes type, size, mode, uid/gid, second-precision modification time
and symlink target. `stat` inspects a symlink itself unless `followSymlinks: true`.
Moves never overwrite an existing destination. Removal defaults to files or empty
directories and removes a symlink itself. Mutation paths cannot be root. These
operations share the four-operation pool and 30-second file deadline. Recursive
deletion and moves across filesystems may partly complete before interruption;
inspect state before retrying a mutation. Watchers remain unsupported.

Release candidates are built and checked with backend `npm run sdk:qualify`.
Version 0.1.0 passed artifact and bounded deployed qualification; fresh npm
downloads match the qualified archive and pass clean-install checks. See the backend
[SDK release runbook](https://github.com/mainbrella/backend/blob/main/docs/sdk-release.md)
for artifact and deployed-workflow gates.

Keep the API key in a secret store or environment, never in code or logs. The
client rejects credential-bearing URLs, redirects, and HTTP except loopback.
Nonzero command exit codes are returned normally. API failures raise
`MainbrellaError` with a sanitized code and HTTP status.

Managed execution separates process lifetime from a request:

```js
const job = await sandbox.commands.start('npm test', { timeoutMs: 300_000 });
for await (const event of job.events()) {
  if (event.type === 'stdout') process.stdout.write(event.data);
}
const result = await job.get();
// await job.cancel(); // Explicit cancellation; closing events only detaches.
```

`events()` reconnects on normal stream rotation and tracks `job.cursor`; a transport
failure exposes its cursor for explicit reconnect. `job.wait()` polls to terminal
state. A wait timeout leaves the job running. `new Execution(sandbox, id)` reconnects
to a known job. Preserve the idempotency key from a failed `commands.start()` call
and retry the same options within the one-hour retention window. Runtime restart
interrupts unfinished jobs and stops their matching container generation.

For richer process control, check `execution.argv`, `stdin`, `signals`, `managedProcessListing`, `programmaticPty` and `ptyResize` in `client.capabilities()`:

```js
const job = await sandbox.commands.start(['cat'], { stdin: true, cwd: '/tmp', env: { TASK: 'probe' } });
await job.stdin.write(new TextEncoder().encode('hello\n'));
await job.stdin.close(); // Pipe EOF; no automatic input retry.
const result = await job.wait();
const attached = sandbox.commands.attach(job.id);
const { executions } = await sandbox.commands.list(); // Retained managed jobs.
const terminal = await sandbox.commands.start(['/bin/sh'], { stdin: true, pty: { cols: 80, rows: 24 } });
await terminal.resize(132, 40);
await terminal.stdin.write(new TextEncoder().encode('exit\n'));
await terminal.wait();
// await terminal.signal('SIGTERM'); // Delivery request; inspect state afterward.
```

An array starts the executable directly; a string uses `/bin/sh -lc`. Environment values go into the guest and are not protected secrets. Input caps are 64 KiB per write, 1 MiB accepted per job and 256 KiB pending. Ambiguous writes stay counted and are never retried. PTY output merges stderr into stdout with terminal line discipline; input closure may hang up the terminal. Cancellation targets the operation process group; deliberately detached processes remain bounded by the machine lease. These local helpers require corresponding deployed capabilities. Guest-wide process listing and filesystem watching remain unsupported.

Protected application previews are available only when
`(await client.capabilities()).previews.supported` is true. Start your application's
HTTP server in the sandbox first, then create a link for its listening port:

```js
const preview = await sandbox.previews.create(3000, { ttlSeconds: 900 });
// Give preview.url to the intended recipient through a private channel.
const { previews } = await sandbox.previews.list(); // Metadata only, no URLs.
await sandbox.previews.revoke(preview.id);
```

Ports are 1024–65535, TTL is 60–3600 seconds (default 900), and at most eight
grants are active per generation. `expiresAt` is Unix milliseconds, clipped to
the container deadline. The URL is a bearer credential returned once; keep it
out of logs and analytics. Listing and revocation work when new issuance is disabled.
Creation is never retried automatically. After a lost response, list and revoke
the unwanted grant before creating another link. A `preview_reconciliation_required`
error exposes `error.previewId`; retry `sandbox.previews.revoke(error.previewId)`.
Revocation closes active connections. Stopping or replacing the generation
invalidates its links. Application cookies are stripped; cookie sessions and
absolute redirect rewriting are unsupported. Host and forwarded host/protocol
reflect the validated HTTPS preview origin; the caller's Origin is preserved.
Protected previews are enabled on `mainbrella.dev` after live qualification;
check `previews.supported` in `/capabilities` before using them.

## Command line

The same local npm archive installs the dependency-free `mainbrella` command. Set `MAINBRELLA_API_KEY` in your environment; optional `MAINBRELLA_API_URL` selects a trusted API origin. Credentials are never CLI arguments. From the project where the archive is installed:

```sh
./node_modules/.bin/mainbrella --help
./node_modules/.bin/mainbrella create --size small --idempotency-key stable-create-key
# Preserve the returned id/createdAt before issuing another command.
./node_modules/.bin/mainbrella run --id <id> --created-at <generation> --command 'printf hello'
./node_modules/.bin/mainbrella kill --id <id> --created-at <generation>
```

`create` and `start` require an explicit stable idempotency key. Errors include it after an ambiguous response. Repeat the same options within retention; never issue a new key to resolve uncertainty. Every workload action requires both container ID and exact generation. There is no bulk-stop command. `job` controls inspect/cancel/stream/signal/resize/send input to known execution IDs; `jobs` lists retained managed jobs. Results are JSON and streamed events are newline-delimited JSON. `run` returns the guest exit code (124 on timeout, 125 on truncated output); API/CLI errors exit 1 and emit sanitized JSON on stderr.

`file read --path /guest/file --output /local/new-file` creates a new local file without overwriting. `file write --path /guest/file --source /local/file` transfers binary bytes up to 1 MiB. `job input --source /local/chunk` accepts up to 64 KiB. CLI input writes never retry automatically. The CLI is included in the published npm package; check deployed capabilities before using optional features.

## Workload observations and webhooks

Check `observability.lifecycleEvents`, `metrics` and `webhooks` first. Lifecycle history belongs to one generation, survives stop, and is bounded to seven days/256 events per slot. Deduplicate stable IDs and order by sequence. Metrics are provider workload observations, separate from billing allocations and public service health; missing evidence remains unobserved/null. Metrics and webhook delivery remain disabled until operator configuration and live qualification.

```js
const page = await sandbox.events({ cursor: 0, limit: 100 });
if (page.hasMore) await sandbox.events({ cursor: page.nextCursor });
const capabilities = await client.capabilities();
if (capabilities.observability.metrics) {
  const observations = await sandbox.metrics();
}
if (capabilities.observability.webhooks) {
  const configured = await sandbox.webhook.configure('https://trusted-relay.example/callback', { replayFromCursor: 0 });
  // Store configured.signingSecret securely, outside guest files/env and logs.
  const { deliveries } = await sandbox.webhook.deliveries();
  // await sandbox.webhook.retry(exhaustedEventId);
  await sandbox.webhook.remove();
}
```

For a receiving server, import `verifyWebhookSignature` and call `await verifyWebhookSignature(rawBodyBytes, signatureHeader, signingSecret)` before parsing JSON. It authenticates the exact bytes and a five-minute timestamp window. Persist received event IDs to reject duplicates; delivery can be out of order. The CLI also exposes generation-bound `events` and `metrics` reads.

Targets must be operator-controlled trusted HTTPS relay hosts; arbitrary customer domains, IPs, credentials, ports and redirects are unsupported. Configuration is per generation and expires after seven days. PUT rotates the secret and clears old attempts; it is never retried automatically. Reconcile lost responses, then rotate explicitly if the one-time secret is unavailable. Eight automatic attempts use bounded backoff; exhausted deliveries allow at most three manual retry cycles. Removing configuration cancels future attempts but cannot undo requests a receiver already accepted. See [API.md](https://mainbrella.com/API.md#lifecycle-webhooks) for retention and signature details. OTLP remains unsupported.

## Outbound internet selection

Internet defaults to enabled. Offline creation is immutable for that generation and requires the advertised `networking.internetControl` capability. The SDK checks discovery before admission, fails if a runtime cannot enforce the policy, and confirms the returned selection. It never coerces a string to a boolean. This flag does not configure domain/CIDR allowlists or mediated secrets. Keep the same creation key on ambiguous transport failure; live provider isolation remains a release gate.

```js
const offline = await client.create({ internet: false, idempotencyKey: "offline-workspace" });
```

The CLI accepts `create --idempotency-key offline-workspace --internet false`.

The CLI also supports generation-bound `file list/stat/mkdir/remove/move/chmod`. Directory removal is nonrecursive unless `--recursive` is explicit; move refuses replacement. Permission modes use four octal digits (`0640`). Listing accepts `--limit` up to 1000 and `--offset` up to 1000000.

## Saved workspaces

Check `(await client.capabilities()).persistence.snapshots` before using save/restore. Save explicitly; ordinary stop discards changes.

```js
const saveKey = crypto.randomUUID(); // Persist this key and body before sending.
const saved = await sandbox.saveWorkspace('Project files', { stop: true, idempotencyKey: saveKey });
const restored = await client.workspaces.restore(saved.id, { idempotencyKey: crypto.randomUUID() });
const archive = await restored.exportWorkspace(); // /workspace gzip tar, at most 16 MiB compressed.
await restored.kill();
await client.workspaces.delete(saved.id);
```

`client.workspaces.list()`, `.get(id)` and `.update(id, {name, archived})` manage saved metadata. Retry an ambiguous save with its original body and key (`error.idempotencyKey`). Restore consumes one start, requires the saved image digest, size and internet policy, and restores filesystem bytes with a fresh generation. RAM, processes and previews do not resume. Plan quotas and expiry apply; archive retains quota, while deletion revokes future restores without immediately erasing provider-held bytes.

## Run a public GitHub repository

The next CLI release includes a browser launcher:

```sh
mainbrella repo acme/demo --ref main --open
mainbrella repo acme/web --setup 'npm ci' --start 'npm run dev -- --host 0.0.0.0' --port 3000 --open
```

It prints a shareable `https://mainbrella.com/run/` URL and optionally opens it
using the operating system's browser launcher. No API key is required; sign in
with Mainbrella and choose **Run repository** to allocate. Flags include `--ref`,
`--runtime node|python|rust|go|devops`, `--size`, `--cwd`, `--setup`, `--start`, and
`--port`. Without commands the result is a cloned repository and usable shell.
`mainbrella run` retains its existing shell-execution meaning.

After publishing the updated package, the one-shot form is
`npx --package @mainbrella/sdk mainbrella repo acme/demo --open`. Until then, run
`node sdk/javascript/cli.mjs repo acme/demo --open` from this checkout.

## Unreleased stateful Python interpreter

Stateful Python contexts are also implemented in this checkout. Use an image
with `python3` and check the API's `codeInterpreter` capability:

```js
const context = await sandbox.code.create();
try {
  await context.run('values = [2, 3, 5]');
  const result = await context.run('sum(values)', { timeoutMs: 1000 });
  console.log(result.results, result.error);
} finally {
  await context.close();
}
```

Contexts hold a shared operation slot for at most 15 minutes. Variables survive
calls and Python exceptions; they are lost on stop, timeout, cancellation, or
runtime recovery. Results contain stdout/stderr, MIME values, and structured
errors. Rich HTML is untrusted. Code is never automatically retried. See
[interpreter limits and lifecycle](../../docs/code-interpreter.md).

## Unreleased filesystem lifecycle and security helpers

The following helpers are implemented in this checkout; they are not part of the
published 0.1.0 package. Install from this checkout to test them and check live
capabilities before use. Backend deployment and SDK publication are separate.

```js
await sandbox.stop({ idempotencyKey: 'stop-my-job' });
const resumed = await sandbox.resume({ idempotencyKey: 'resume-my-job' });
const fork = await resumed.fork({ name: 'Experiment', idempotencyKey: 'fork-my-job' });
// Destructive cleanup is explicit; kill() retains its existing behavior.
await fork.delete();

const secret = await client.secrets.create({ name: 'Upstream API',
  value: process.env.UPSTREAM_API_KEY, hostname: 'api.example.com',
  header: 'authorization', prefix: 'Bearer ' });
const restricted = await client.create({
  networkPolicy: { allow: ['api.example.com'], deny: [] },
  secretBindings: [secret.id],
});
await client.secrets.rotate(secret.id, process.env.REPLACEMENT_API_KEY);
await client.secrets.delete(secret.id);
```

Stop captures files before releasing compute; Resume returns a new generation,
and Fork leaves the source running. Each capture uses saved-workspace retention
and quota; a resume/fork consumes a normal start. Preserve the same key on an
uncertain result. There is no RAM/process preservation or automatic capture on
provider crash. Production recovery after an explicit resume uses its saved
checkpoint, so later writes still need external durable storage.

Restricted machines require `networking.egressPolicies`; secret bindings require
`secrets.vault`. Policy implies internet disabled and permits only mediated HTTP
and HTTPS to allowed public destinations. CIDR/domain denies take precedence.
The relay injects credentials outside the guest into the configured HTTPS host
and header. Secret values are never readable through the SDK. Choose a trusted
upstream and scoped tokens; an upstream can disclose transformed credentials.

## MCP server (source checkout)

The unreleased source includes a Node 22+ stdio MCP server. With
`MAINBRELLA_API_KEY` already set in the parent environment, configure your agent:

```json
{
  "mcpServers": {
    "mainbrella": {
      "command": "node",
      "args": ["/absolute/path/to/backend/sdk/javascript/mcp.mjs"]
    }
  }
}
```

Use your client's secret/environment settings if it does not inherit the parent
shell. No key belongs in the prompt or committed config. Tools include discovery,
commands, text files, workspace save and filesystem lifecycle; every mutation is
bound to a generation or explicit creation key. Follow capability discovery for
gated operations. This executable is not in the published 0.1.0 package yet.

## OTLP pull export

The HTTP API exports collector-compatible JSON without a telemetry dependency:

```js
const response = await client.request(sandbox.path('/containers/telemetry/logs', {
  cursor: '0', limit: '100',
}), { stream: true });
const payload = await response.json(); // Forward to your collector /v1/logs.
const nextCursor = response.headers.get('Mainbrella-Next-Cursor');
// Persist nextCursor only after the collector acknowledges this payload.
```

Use `/containers/telemetry/metrics` with non-overlapping `from`/`to` ranges for
OTLP CPU and memory metrics when `observability.metrics` is enabled. Log export
requires `observability.otlp`. Missing metric samples are not zero measurements.


## Client-managed prewarming (unreleased)

Pools in this checkout keep a local inventory of ordinary, billed ad-hoc
sandboxes. This helper requires a running client process and explicit refill;
use `client.pools` below for durable server inventory and automatic replenishment.
Normal account start, concurrency, compute budgets, idle timeout and maximum
session duration apply while a sandbox waits in the pool.

```js
const pool = client.pool({ targetSize: 2, create: { catalogId: 'python' } });
let sandbox;
try {
  await pool.refill();
  sandbox = await pool.acquire(); // Fails with pool_empty if inventory expired.
  console.log(await sandbox.commands.run('python --version'));
  await pool.refill(); // Explicitly replace the acquired slot when budget allows.
} finally {
  try { if (sandbox) await sandbox.kill(); }
  finally { await pool.close(); } // Cleans only inventory still owned by the pool.
}
```

Use `imageId` or `workspaceId` in `create` for prepared environments. A pool
serializes calls, checks each generation before acquisition, and preserves the
same creation key after an uncertain response. `pool.state` exposes inventory
and a pending key for reconciliation. `close()` can finish a pending create
before deleting it, so closing may incur a start and compute charge. Retry
failed cleanup with `close()`; acquired sandboxes remain your responsibility.

Inventory is process-local and cannot be restored from `state`. Process crashes
lose the pool's bookkeeping: retain generation identities and pending keys in
your application's journal and reconcile them through normal SDK operations.
A pending key is retried for at most one hour, bounded by half the API's advertised
retention. After `pool_creation_expired`, reconcile it manually instead of issuing
a replacement create. Prewarming is not RAM-preserving pause/resume.

## Server-managed pools (unreleased)

When `capabilities.pools.managed` is true, `client.pools` maintains inventory in
the account coordinator, including after your client exits. Persist the request
keys before making either a create or acquire request:

```js
const { pool } = await client.pools.create({ name: 'Agent workers', targetSize: 2,
  ttlSeconds: 600, catalogId: 'python', idempotencyKey: 'workers-batch-42' });
console.log(await client.pools.get(pool.id)); // Wait for ready > 0.
const sandbox = await client.pools.acquire(pool.id, { idempotencyKey: 'task-42' });
try { console.log(await sandbox.commands.run('python --version')); }
finally { await sandbox.kill(); }
await client.pools.delete(pool.id);
```

`pool_empty` means inventory is still warming or account limits prevent refill.
An uncertain response exposes `error.idempotencyKey`; retry with the same key
and options, within 24 hours. Acquiring transfers ownership exactly once and
returns a generation-bound `Sandbox`. A retry returns that same generation or
`acquisition_no_longer_running`; it never silently assigns another sandbox.

`list()`, `get(id)`, `update(id, {name, targetSize})`, and `delete(id)` manage the
pool. Target size may be 0–20, bounded by account capacity; each account can have
eight pools. Set the target to zero to drain and pause. Required `ttlSeconds` is
60–86400 and cannot be extended. Expiry/deletion stops only unclaimed inventory;
acquired sandboxes remain your responsibility. Retry failed deletion until it
confirms cleanup. Launch image, size, and network policy are immutable.

Inventory consumes normal starts and compute, retains its original idle/hard
deadlines, and is replenished automatically while the pool is active and funded.
An expired idle sandbox may therefore incur another start without a client
request. Deleting the client object does not delete the pool. These helpers do
not reset or reuse previously acquired sandboxes.

## Image builds, versions and tags (unreleased)

```js
const queued = await client.images.create({ name: 'Agent tools',
  dockerfile: 'FROM mainbrella:base\nRUN python -m pip install requests' });
const { image } = await client.images.get(queued.image.id);
console.log(await client.images.logs(image.id));
// After the build reports ready:
await client.images.tags.set('agent-tools.stable', image.id);
const resolved = await client.images.tags.get('agent-tools.stable');
const sandbox = await client.create({ imageId: resolved.image.id });
try { console.log(sandbox.imageDigest); } finally { await sandbox.kill(); }
```

`images.list()`, `images.delete(id)`, `images.tags.list()` and
`images.tags.delete(tag)` manage saved versions and aliases. Optional build
`context` is gzip tar bytes (`Uint8Array`, at most 512 KiB). Builds require live
`images.customBuilds`; tags require the new backend migration and deployment.
Image IDs/digests are immutable; resolve a tag once and retain the resulting ID
for all retries of a creation. Tags are account-scoped, capped at 30, and only
point to ready images. Moving a tag leaves existing containers unchanged.

Build options also accept `cacheFrom`, an owned ready image ID whose inline
BuildKit cache can be reused. Existing images without cache metadata remain
valid but may yield no cache hits. `baseImage: {image, username?, password?}`
selects a digest-pinned `ghcr.io` or `docker.io` base; the Dockerfile still starts
with `FROM mainbrella:base`. Both credentials must be supplied together. Check
`privateRegistriesEnabled` from `images.list()` before authenticated imports.
Keep credentials in your application's secret store; do not put them in a
Dockerfile or logs. The base must satisfy Mainbrella's shell/GNU-tooling contract.
Builds use an operator-configured private build repository. Cache/private-base
support requires its backend migration, configuration and live qualification.

## Streaming transfers and directory copies

Check `capabilities.files.streamingTransfers` before using the new transfer
endpoint. Files can be up to 64 MiB; streams flow under backpressure and uploads
replace the destination atomically only after a clean, exact-length EOF.

```js
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
const source = './dataset.bin';
await sandbox.files.upload('/workspace/dataset.bin', Readable.toWeb(createReadStream(source)), {
  size: (await stat(source)).size,
});
const bytes = await sandbox.files.download('/workspace/dataset.bin');
// Consume bytes as a Web ReadableStream; cancel it if you stop reading.
await bytes.cancel();
await sandbox.files.uploadDirectory('./project', '/workspace/project');
await sandbox.files.downloadDirectory('/workspace/output', './output');

const stop = new AbortController();
for await (const event of sandbox.files.watch('/workspace/project', { signal: stop.signal })) {
  console.log(event.type, event.entry.path); // create, modify, remove
  stop.abort();
  break;
}
```

Transfers share the execution pool and have a five-minute runtime deadline;
configure `timeoutMs` for the expected duration (default 90 seconds). `upload`
also accepts a `Uint8Array` and infers its size. Download consumers must discard
incomplete output. Transfers cannot resume and writes are never retried after
an ambiguous response. Forced cancellation can leave a hidden guest temporary
file next to the destination.

Directory helpers require Node, copy at most 10,000 entries and 64 levels, reject
symlinks/special files, and keep unrelated destination files. Each file is atomic;
the directory as a whole is not. Permissions are not synchronized. Keep the source
and destination trees stable during a copy. Polling `watch` uses normal metadata
requests, defaults to one second, and starts after an initial baseline; transient
changes and same-size rewrites within one second may be missed. It is independent
of the server's native `files.watch` capability, which remains unavailable.

## Linux desktop automation (unreleased)

Desktop helpers require a compatible image with Python 3, Xvfb, xdpyinfo,
xdotool and ImageMagick `import`. They do not install packages automatically.
`sandbox.desktop.probe()` checks the image using a temporary interpreter context.

```js
const desktop = await sandbox.desktop.start({ width: 1280, height: 720 });
try {
  await desktop.launch(['openbox']);
  await desktop.launch(['xterm']);
  await desktop.move(120, 100);
  await desktop.click();
  await desktop.type('printf hello');
  await desktop.press('Return');
  const png = await desktop.screenshot(); // Uint8Array, at most 8 MiB.
} finally { await desktop.close(); }
```

Each desktop occupies a supervised Python context for at most 15 minutes,
bounded by the sandbox's remaining lease. Width is 320–1920; height is 240–1080.
Applications inherit the session's `DISPLAY`; launch accepts argv without shell
interpolation. A launch response confirms admission, not GUI readiness.
Screenshots use binary file transfer, validate their size/PNG dimensions and
remove their temporary file after download. The SDK serializes session actions.

Input and startup are never automatically replayed after a lost response.
If startup or close cannot confirm cleanup, the error retains `contextId` and
`cleanupUnconfirmed`; reconcile through `sandbox.code.attach(id).close()`.
Stop, expiry and runtime restart end the context and its process group; a
deliberately daemonized application can escape that group and remains bounded
by the sandbox lease. There is no reconnectable desktop handle, VNC viewer,
recording, Windows support or published desktop catalog yet.
