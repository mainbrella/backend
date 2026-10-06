# Mainbrella Python SDK

Published on PyPI as `mainbrella` 0.1.0. Python 3.10+; standard-library runtime.

```sh
pip install mainbrella==0.1.0
```

```python
import os
from mainbrella import Mainbrella

client = Mainbrella(os.environ["MAINBRELLA_API_KEY"])
print(client.capabilities())
with client.create(catalog_id="python") as sandbox:
    result = sandbox.commands.run("python --version")
    sandbox.files.write("/tmp/probe.bin", bytes([0, 128, 255]))
    assert sandbox.files.read("/tmp/probe.bin") == bytes([0, 128, 255])
```

The context manager cleans up only its returned generation. `connect(id, created_at)`
uses an existing generation without provisioning. Creation retries one idempotency
key; ambiguous errors expose `idempotency_key` for reconciliation. Commands and
writes are never retried automatically. API errors expose sanitized `code` and
`status`. Nonzero shell exit codes remain normal command results.

The richer filesystem helpers require the corresponding `client.capabilities()["files"]`
flags. They operate on absolute UTF-8 guest paths:

```python
sandbox.files.mkdir("/workspace/output", recursive=True, mode="0700")
page = sandbox.files.list("/workspace", limit=100)
# Pass page["nextOffset"] as offset for the next page, if it is not None.
metadata = sandbox.files.stat("/workspace/output")
sandbox.files.move("/tmp/probe.bin", "/workspace/output/probe.bin")
sandbox.files.chmod("/workspace/output/probe.bin", "0640")
sandbox.files.remove("/workspace/output", recursive=True)
```

Lists contain one level, sorted by UTF-8 filename bytes, with up to 1,000 entries
per page. Pagination rescans; directory changes can duplicate or omit entries.
Metadata includes type, size, mode, uid/gid, second-precision modification time
and symlink target. `stat` inspects a symlink itself unless `follow_symlinks=True`.
Moves never overwrite an existing destination. Removal defaults to files or empty
directories and removes a symlink itself. Mutation paths cannot be root. These
operations share the four-operation pool and 30-second file deadline. Recursive
deletion and moves across filesystems may partly complete before interruption;
inspect state before retrying a mutation. Watchers remain unsupported.

For development and release qualification, build local archives with backend
`npm run sdk:qualify` and install the wheel with
`python -m pip install /path/to/mainbrella-0.1.0-py3-none-any.whl`. See the backend
[SDK release runbook](https://github.com/mainbrella/backend/blob/main/docs/sdk-release.md)
for artifact and deployed-workflow gates.

Credentials belong in your environment or secret manager. HTTPS is required
except loopback development URLs. HTTP redirects are refused.

`sandbox.commands.start(command, timeout_ms=300000)` returns a managed job with
`get()`, `wait()`, `cancel()` and `events()`. `events()` yields stdout/stderr chunks
and status updates, reconnects on normal stream rotation and tracks `job.cursor`.
Closing the iterator detaches; cancellation is explicit. `Execution(sandbox, id)`
reconnects to a retained job. Preserve `idempotency_key` on start errors and retry
the same options within one hour. Runtime restart interrupts unfinished managed
jobs and stops their matching container generation.

Check `client.capabilities()["execution"]` for `argv`, `stdin`, `signals`, `managedProcessListing`, `programmaticPty` and `ptyResize` before using richer process control:

```python
job = sandbox.commands.start(["cat"], stdin=True, cwd="/tmp", env={"TASK": "probe"})
job.stdin.write(b"hello\n")
job.stdin.close()  # Pipe EOF; no automatic input retry.
result = job.wait()
attached = sandbox.commands.attach(job.id)
executions = sandbox.commands.list()["executions"]  # Retained managed jobs.
terminal = sandbox.commands.start(["/bin/sh"], stdin=True, pty={"cols": 80, "rows": 24})
terminal.resize(132, 40)
terminal.stdin.write(b"exit\n")
terminal.wait()
# terminal.signal("SIGTERM")  # Delivery request; inspect state afterward.
```

A list starts argv directly; a string uses `/bin/sh -lc`. Environment values go into the guest and are not protected secrets. Input caps are 64 KiB per write, 1 MiB accepted per job and 256 KiB pending. Ambiguous writes stay counted and are never retried. PTY output combines stderr on stdout with terminal line discipline; input closure may hang up the terminal. Cancellation targets the operation process group; deliberately detached processes remain bounded by the machine lease. Local helpers require corresponding deployed capabilities. Guest-wide process listing and filesystem watching remain unsupported.

Protected application previews require
`client.capabilities()["previews"]["supported"]` to be true. Start your application's
HTTP server in the sandbox first, then create a link for its listening port:

```python
preview = sandbox.previews.create(3000, ttl_seconds=900)
# Give preview["url"] to the intended recipient through a private channel.
previews = sandbox.previews.list()["previews"]  # Metadata only, no URLs.
sandbox.previews.revoke(preview["id"])
```

Ports are 1024–65535, TTL is 60–3600 seconds (default 900), and at most eight
grants are active per generation. `expiresAt` is Unix milliseconds, clipped to
the container deadline. The URL is a bearer credential returned once; keep it
out of logs and analytics. Listing and revocation work when new issuance is disabled.
Creation is never retried automatically. After a lost response, list and revoke
the unwanted grant before creating another link. A `preview_reconciliation_required`
error exposes `error.preview_id`; retry `sandbox.previews.revoke(error.preview_id)`.
Revocation closes active connections. Stopping or replacing the generation
invalidates its links. Application cookies are stripped; cookie sessions and
absolute redirect rewriting are unsupported. Host and forwarded host/protocol
reflect the validated HTTPS preview origin; the caller's Origin is preserved.
Protected previews are enabled on `mainbrella.dev` after live qualification;
check `previews.supported` in `/capabilities` before using them.

## Workload observations and webhooks

Check `observability.lifecycleEvents`, `metrics` and `webhooks` first. Lifecycle history belongs to one generation, survives stop, and is bounded to seven days/256 events per slot. Deduplicate stable IDs and order by sequence. Metrics are provider workload observations, separate from billing allocations and public service health; missing evidence remains unobserved/null. Metrics and webhook delivery remain disabled until operator configuration and live qualification.

```python
page = sandbox.events(cursor=0, limit=100)
if page["hasMore"]:
    page = sandbox.events(cursor=page["nextCursor"])
capabilities = client.capabilities()
if capabilities["observability"]["metrics"]:
    observations = sandbox.metrics()
if capabilities["observability"]["webhooks"]:
    configured = sandbox.webhook.configure("https://trusted-relay.example/callback", replay_from_cursor=0)
    # Store configured["signingSecret"] securely, outside guest files/env and logs.
    deliveries = sandbox.webhook.deliveries()["deliveries"]
    # sandbox.webhook.retry(exhausted_event_id)
    sandbox.webhook.remove()
```

Receiving servers import `verify_webhook_signature` and call `verify_webhook_signature(raw_body, signature_header, signing_secret)` before JSON parsing. It authenticates exact bytes and a five-minute timestamp window. Persist received IDs to reject duplicates; delivery can arrive out of order.

Targets must be operator-controlled trusted HTTPS relay hosts; arbitrary customer domains, IPs, credentials, ports and redirects are unsupported. Configuration is per generation and expires after seven days. PUT rotates the secret and clears old attempts; it is never retried automatically. Reconcile lost responses, then rotate explicitly if the one-time secret is unavailable. Eight automatic attempts use bounded backoff; exhausted deliveries allow at most three manual retry cycles. Removing configuration cancels future attempts but cannot undo requests a receiver already accepted. See [API.md](https://mainbrella.com/API.md#lifecycle-webhooks) for retention and signature details. OTLP remains unsupported.

## Outbound internet selection

Internet defaults to enabled. Offline creation is immutable for that generation and requires the advertised `networking.internetControl` capability. The SDK checks discovery before admission, fails if a runtime cannot enforce the policy, and confirms the returned selection. Keep the same creation key on ambiguous transport failure. This does not configure allowlists or secrets; live provider isolation remains a release gate.

```python
offline = client.create(internet=False, idempotency_key="offline-workspace")
```

## Saved workspaces

Check `client.capabilities()["persistence"]["snapshots"]` before save/restore. Ordinary stop discards changes; save explicitly.

```python
import uuid
save_key = str(uuid.uuid4())  # Persist the key and request body before sending.
saved = sandbox.save_workspace("Project files", stop=True, idempotency_key=save_key)
restored = client.workspaces.restore(saved["id"], idempotency_key=str(uuid.uuid4()))
archive = restored.export_workspace()  # /workspace gzip tar, at most 16 MiB compressed.
restored.kill()
client.workspaces.delete(saved["id"])
```

`client.workspaces.list()`, `.get(id)` and `.update(id, name=…, archived=True)` manage metadata. Retry an ambiguous save with the original body and key (`error.idempotency_key`). Restore consumes one start and requires the saved image digest, size and internet policy. Filesystem bytes return in a fresh generation; RAM, processes and previews do not resume. Quotas and expiry apply. Archive retains quota; deletion revokes future restores without immediately erasing provider-held bytes.
