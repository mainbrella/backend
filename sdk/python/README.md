# Mainbrella Python SDK

Published on PyPI as `mainbrella` 0.1.0. Python 3.10+; standard-library runtime.

The source additions documented below are available in this source checkout and need a new SDK release and matching API/runtime deployment. They are not included in the already-published 0.1.0 artifacts.

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

Managed execution capacity errors expose `error.retry_after_seconds` when the
API provides a valid retry hint. The SDK does not automatically resubmit commands.
Retain the original idempotency key and stay within its recovery window.

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

The unreleased SDK accepts `launch={"command": "node server.mjs",
"cwd": "/workspace/app", "readiness": {"port": 3000, "path": "/health"}}`
in `save_workspace` when the deployment advertises `persistence.restoreLaunch`.
Each restore starts that command once. Restore returns when the machine is
running; inspect `restored.readiness` and refresh the exact container through
`client.list()` until its readiness status is `ready` or `failed`. Failure
diagnostics include a log path and bounded tail. This starts a new process;
it does not preserve the original application's memory.

## Unreleased stateful Python interpreter

Stateful Python contexts are also implemented in this checkout. Use an image
with `python3` and check the API's `codeInterpreter` capability:

```python
with sandbox.code.create() as context:
    context.run('values = [2, 3, 5]')
    result = context.run('sum(values)', timeout_ms=1000)
    print(result['results'], result['error'])
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

```python
sandbox.stop(idempotency_key="stop-my-job")
resumed = sandbox.resume(idempotency_key="resume-my-job")
fork = resumed.fork(name="Experiment", idempotency_key="fork-my-job")
fork.delete()  # destructive; kill() and context-manager cleanup stay destructive

secret = client.secrets.create("Upstream API", os.environ["UPSTREAM_API_KEY"],
                               "api.example.com", prefix="Bearer ")
restricted = client.create(network_policy={"allow": ["api.example.com"], "deny": []},
                           secret_bindings=[secret["id"]])
client.secrets.rotate(secret["id"], os.environ["REPLACEMENT_API_KEY"])
client.secrets.delete(secret["id"])
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


## Client-managed prewarming (unreleased)

This checkout provides explicit prewarming of ordinary, billed ad-hoc sandboxes.
This helper has no background refill, keepalive or reuse of acquired
machines. Normal start, concurrency, compute, idle and session limits apply.

```python
pool = client.pool(target_size=2, create={"catalog_id": "python"})
sandbox = None
try:
    pool.refill()
    sandbox = pool.acquire()  # pool_empty if waiting generations have expired.
    print(sandbox.commands.run("python --version"))
    pool.refill()  # Explicit replacement; requires available account budget.
finally:
    try:
        if sandbox is not None:
            sandbox.kill()
    finally:
        pool.close()  # Only unassigned inventory is cleaned up.
```

Use `image_id` or `workspace_id` for a prepared environment. Calls serialize
across threads and acquisition checks the exact generation. Uncertain creation
retries retain their original key, exposed through `pool.state["pending"]`.
`close()` may finish an ambiguous create before deleting it and therefore incur
a start/compute charge. Retry cleanup failures with `close()`; acquired machines
are the caller's responsibility.

Pool bookkeeping lives only in this process and cannot be restored from `state`.
Journal identities and pending keys in your application for crash recovery via
normal SDK operations. Pending creation retries stop after at most one hour,
bounded by half the API's advertised retention; `pool_creation_expired` requires
manual reconciliation. There is no memory-preserving pause/resume.

## Server-managed pools (unreleased)

When `client.capabilities()['pools']['managed']` is true, `client.pools` keeps
inventory in the account coordinator and replenishes it after client exit.
Persist operation keys before the request so uncertain results can be retried:

```python
pool = client.pools.create('Agent workers', target_size=2, ttl_seconds=600,
                          catalog_id='python', idempotency_key='workers-batch-42')['pool']
print(client.pools.get(pool['id']))  # Wait for ready > 0.
sandbox = client.pools.acquire(pool['id'], idempotency_key='task-42')
try:
    print(sandbox.commands.run('python --version'))
finally:
    sandbox.kill()
client.pools.delete(pool['id'])
```

`pool_empty` means inventory is warming or account limits prevent replenishment.
Retry uncertain responses with `error.idempotency_key` and the original options
within 24 hours. An acquisition retry returns the same generation or
`acquisition_no_longer_running`, never another sandbox.

`list()`, `get(id)`, `update(id, name=..., target_size=...)`, and `delete(id)`
manage the pool. Eight pools per account, target size 0–20 within account capacity,
and required `ttl_seconds` 60–86400. Expiry cannot be extended. Set target size to
zero to pause and drain. Deletion and expiry stop unclaimed inventory; acquired
sandboxes remain your responsibility. Retry failed deletion until confirmed.
Image, size and network policy are immutable.

Idle inventory consumes ordinary start/compute budgets and keeps its original
idle/hard deadlines. Automatic replacement of expired inventory may incur another
start without a client request. The pool survives client exit until deleted or
expired. Previously acquired machines are never reset or reused.

## Image builds, versions and tags (unreleased)

```python
queued = client.images.create("Agent tools",
    "FROM mainbrella:base\nRUN python -m pip install requests")
image = client.images.get(queued["image"]["id"])["image"]
print(client.images.logs(image["id"]))
# After the build reports ready:
client.images.tags.set("agent-tools.stable", image["id"])
resolved = client.images.tags.get("agent-tools.stable")
with client.create(image_id=resolved["image"]["id"]) as sandbox:
    print(sandbox.image_digest)
```

Use `images.list()`, `.delete(id)`, `.tags.list()` and `.tags.delete(tag)` for
management. Optional build `context` contains gzip tar bytes, at most 512 KiB.
Builds still require live `images.customBuilds`; tags require the new migration
and backend deployment. Tags are account-scoped, capped at 30, and point only to
ready images. Resolve once and retain the immutable image ID with the creation
key for retries; moving a tag does not change existing containers.

Image builds also accept `cache_from=<owned-ready-image-id>` and
`base_image={"image": "ghcr.io/owner/tools@sha256:...", "username": "reader", "password": token}`.
Omit both credential fields for a public base. Only digest-pinned `ghcr.io` and
`docker.io` references are accepted; the Dockerfile still starts with
`FROM mainbrella:base`. Check `privateRegistriesEnabled` from `images.list()`
before authenticated imports. Keep tokens in your secret store, outside the
Dockerfile and logs. Builds require a configured private build repository.
Existing images without inline cache metadata may yield no cache hits. These
options require migration, configuration and live qualification.

## Streaming transfers and directory copies

Check `client.capabilities()["files"]["streamingTransfers"]` before using the new
transfer endpoint. Files can be up to 64 MiB; input and output stay streaming.

```python
import os
import shutil
from threading import Event

with open("./dataset.bin", "rb") as source:
    sandbox.files.upload("/workspace/dataset.bin", source, size=os.fstat(source.fileno()).st_size)
with sandbox.files.download("/workspace/dataset.bin") as source, open("./download.bin", "wb") as target:
    shutil.copyfileobj(source, target, length=65536)

sandbox.files.upload_directory("./project", "/workspace/project")
sandbox.files.download_directory("/workspace/output", "./output")
stop = Event()
for event in sandbox.files.watch("/workspace/project", stop_event=stop):
    print(event["type"], event["entry"]["path"])
    stop.set()
```

Uploads require a clean, exact-length EOF before atomic replacement; `bytes`
inputs infer their size. Downloads are context-managed readers: close them when
finished and discard incomplete output. Configure `timeout` for the expected
transfer duration (default 90 seconds); the runtime allows five minutes or the
generation deadline. Transfers share execution capacity and never automatically
retry writes. Interrupted guest processes may leave hidden temporary files.

Directory copies reject symlinks and special files, keep unrelated destination
files and bound traversal to 10,000 entries and 64 levels. Each file is atomic;
the directory as a whole is not. Permissions are not synchronized. Keep both trees
stable during copying. Polling `watch` starts after an initial metadata baseline;
its default interval is one second. Transient changes and same-size rewrites within
one second may be missed. The native server watcher capability remains unavailable.

## Linux desktop automation (unreleased)

Use a compatible image with Python 3, Xvfb, xdpyinfo, xdotool and ImageMagick
`import`. `sandbox.desktop.probe()` checks the image using a temporary Python
context. The SDK does not install packages automatically.

```python
with sandbox.desktop.start(width=1280, height=720) as desktop:
    desktop.launch(['openbox'])
    desktop.launch(['xterm'])
    desktop.move(120, 100)
    desktop.click()
    desktop.type('printf hello')
    desktop.press('Return')
    png = desktop.screenshot()  # bytes, at most 8 MiB
```

A desktop occupies a supervised Python context for at most 15 minutes and no
longer than the sandbox's remaining lease. Width is 320–1920 and height 240–1080.
Applications inherit `DISPLAY`; launch accepts argv without shell interpolation.
Admission does not imply GUI readiness. Screenshots use binary file transfer,
check size/PNG dimensions, and remove temporary files even on download failure.
Actions serialize within the session and are never automatically replayed.

`close()` or the context manager deletes the supervised context. If cleanup is
uncertain, an error retains `context_id` and `cleanup_unconfirmed`; reconcile
through `sandbox.code.attach(id).close()`. Stop, expiry and runtime restart end
the context/process group; deliberately daemonized applications can escape that
group and remain bounded by the sandbox lease. No reconnectable desktop handle,
VNC viewer, recording, Windows or published desktop catalog is included.
