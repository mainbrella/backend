# Mainbrella Python SDK

Local package, not published to PyPI yet. Python 3.10+; standard-library runtime.

```sh
python -m pip install /absolute/path/to/backend/sdk/python
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

Credentials belong in your environment or secret manager. HTTPS is required
except loopback development URLs. HTTP redirects are refused.

`sandbox.commands.start(command, timeout_ms=300000)` returns a managed job with
`get()`, `wait()`, `cancel()` and `events()`. `events()` yields stdout/stderr chunks
and status updates, reconnects on normal stream rotation and tracks `job.cursor`.
Closing the iterator detaches; cancellation is explicit. `Execution(sandbox, id)`
reconnects to a retained job. Preserve `idempotency_key` on start errors and retry
the same options within one hour. Runtime restart interrupts unfinished managed
jobs and stops their matching container generation.

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
invalidates its links. Application cookies are stripped; cookie sessions, external
Host semantics and absolute redirect rewriting are unsupported. Public previews
remain disabled pending isolated-domain configuration and live qualification.
