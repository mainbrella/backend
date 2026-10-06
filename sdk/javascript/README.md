# Mainbrella JavaScript SDK

Local package, not published to npm yet. Requires Node 22+; no dependencies.

```sh
npm install /absolute/path/to/backend/sdk/javascript
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

Versioned local archives can be built and checked with backend `npm run sdk:qualify`.
Install its `.tgz` with `npm install /path/to/mainbrella-sdk-0.1.0.tgz`; this remains
an archive installation, not an npm registry release. See the backend
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
invalidates its links. Application cookies are stripped; cookie sessions, external
Host semantics and absolute redirect rewriting are unsupported. Public previews
remain disabled pending isolated-domain configuration and live qualification.

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

`file read --path /guest/file --output /local/new-file` creates a new local file without overwriting. `file write --path /guest/file --source /local/file` transfers binary bytes up to 1 MiB. `job input --source /local/chunk` accepts up to 64 KiB. CLI input writes never retry automatically. Registry publication and live qualification remain pending.

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
