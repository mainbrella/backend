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
