"""Synchronous Mainbrella client. No third-party runtime dependencies."""
import json
import hashlib
import hmac
import re
import time
import uuid
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


def verify_webhook_signature(body, signature, signing_secret, now=None, tolerance=300):
    now = time.time() if now is None else now
    if (not isinstance(body, bytes) or len(body) > 16 * 1024 or not isinstance(signature, str)
            or not isinstance(signing_secret, str) or not re.fullmatch(r"mbwh_[a-f0-9]{64}", signing_secret)
            or type(tolerance) is not int or not 1 <= tolerance <= 900 or type(now) not in (int, float)
            or not 0 <= now < float("inf")):
        return False
    match = re.fullmatch(r"t=([0-9]{1,13}),v1=([a-f0-9]{64})", signature)
    if not match or abs(int(now) - int(match[1])) > tolerance:
        return False
    expected = hmac.new(signing_secret.encode(), match[1].encode() + b"." + body, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, match[2])


class MainbrellaError(Exception):
    def __init__(self, code, status=0, idempotency_key=None, preview_id=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.idempotency_key = idempotency_key
        self.preview_id = preview_id


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _transport(url, method, headers, body, timeout):
    opener = build_opener(_NoRedirect())
    try:
        response = opener.open(Request(url, data=body, headers=headers, method=method), timeout=timeout)
    except HTTPError as error:
        response = error
    with response:
        return response.status, response.read()


class Mainbrella:
    def __init__(self, api_key, base_url="https://api.mainbrella.com", timeout=90, transport=_transport):
        if not isinstance(api_key, str) or not re.fullmatch(r"mb_[a-fA-F0-9]{64}", api_key):
            raise MainbrellaError("invalid_api_key")
        try:
            url = urlsplit(base_url)
            url.port
        except ValueError:
            raise MainbrellaError("invalid_api_url") from None
        if (not url.hostname or url.username or url.password or url.path not in ("", "/") or url.query or url.fragment
                or (url.scheme != "https" and not (url.scheme == "http" and url.hostname in ("localhost", "127.0.0.1", "::1")))):
            raise MainbrellaError("invalid_api_url")
        if not isinstance(timeout, (float, int)) or timeout <= 0:
            raise MainbrellaError("invalid_client_options")
        self._api_key = api_key
        self.base_url = f"{url.scheme}://{url.netloc}"
        self.timeout = timeout
        self._transport = transport
        self.workspaces = _Workspaces(self)

    def request(self, path, method="GET", body=None, headers=None, binary=False, timeout=None):
        if not path.startswith("/") or path.startswith("//") or urlsplit(path).scheme:
            raise MainbrellaError("invalid_api_path")
        outgoing = dict(headers or {})
        outgoing["Authorization"] = f"Bearer {self._api_key}"
        if body is not None:
            outgoing["Content-Type"] = "application/octet-stream" if isinstance(body, bytes) else "application/json"
            body = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
        try:
            status, data = self._transport(self.base_url + path, method, outgoing, body, timeout or self.timeout)
        except Exception:
            raise MainbrellaError("transport_unavailable") from None
        if not 200 <= status < 300:
            preview_id = None
            try:
                value = json.loads(data)
                code = value.get("error") if isinstance(value, dict) else None
                candidate = value.get("previewId") if isinstance(value, dict) else None
                if code == "preview_reconciliation_required" and isinstance(candidate, str) and re.fullmatch(r"[a-f0-9]{32}", candidate):
                    preview_id = candidate
            except (ValueError, TypeError):
                code = None
            if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
                code = "request_failed"
            raise MainbrellaError(code, status, preview_id=preview_id)
        if binary:
            return data
        try:
            return json.loads(data)
        except (ValueError, TypeError):
            raise MainbrellaError("invalid_response", status) from None

    def capabilities(self):
        return self.request("/capabilities")

    def list(self):
        return self.request("/containers")

    def connect(self, container_id, created_at):
        return Sandbox(self, container_id, created_at)

    def create(self, catalog_id=None, image_id=None, idempotency_key=None, wait_timeout=120, poll_interval=1, size=None, internet=None, workspace_id=None):
        key = idempotency_key or str(uuid.uuid4())
        if catalog_id and image_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) or wait_timeout <= 0 or poll_interval <= 0:
            raise MainbrellaError("invalid_creation_options")
        body = {"imageId": image_id} if image_id else {"catalogId": catalog_id} if catalog_id else {}
        if workspace_id is not None:
            if catalog_id or image_id or not isinstance(workspace_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', workspace_id):
                raise MainbrellaError('invalid_creation_options')
            if self.capabilities().get('persistence', {}).get('snapshots') is not True:
                raise MainbrellaError('persistence_unavailable', 503, idempotency_key=key)
            body['workspaceId'] = workspace_id
        if size is not None:
            if size not in ('lite', 'small', 'medium', 'large', 'xl'):
                raise MainbrellaError('invalid_creation_options')
            body['size'] = size
        if internet is not None:
            if not isinstance(internet, bool):
                raise MainbrellaError('invalid_creation_options')
            if internet is False and self.capabilities().get('networking', {}).get('internetControl') is not True:
                raise MainbrellaError('network_policy_unavailable', 503, idempotency_key=key)
            body['internet'] = internet
        deadline = time.monotonic() + wait_timeout
        while time.monotonic() < deadline:
            try:
                result = self.request("/containers", "POST", body, {"Idempotency-Key": key},
                                      timeout=min(self.timeout, max(0.001, deadline - time.monotonic())))
                creation = result.get("creation", {})
                if not creation.get("id") or creation.get("status") not in ("starting", "running"):
                    raise MainbrellaError("invalid_creation_response")
                if creation["status"] == "running":
                    selected = next((c for c in result.get("containers", []) if c.get("id") == creation.get("containerId")
                                     and c.get("createdAt") == creation.get("createdAt") and c.get("status") == "running"), None)
                    if not selected:
                        raise MainbrellaError("invalid_creation_response")
                    if internet is False and selected.get('internet') is not False:
                        raise MainbrellaError('network_policy_unconfirmed', 409)
                    if workspace_id is not None and selected.get('workspaceId') != workspace_id:
                        raise MainbrellaError('workspace_restore_unconfirmed', 409)
                    sandbox = self.connect(selected["id"], selected["createdAt"])
                    sandbox.creation_id = creation["id"]
                    sandbox.image_digest = selected.get("imageDigest")
                    sandbox.instance = selected.get("instance")
                    sandbox.internet = selected.get('internet')
                    sandbox.workspace_id = selected.get('workspaceId')
                    return sandbox
            except MainbrellaError as error:
                if error.code in ('network_policy_unavailable', 'persistence_unavailable') or error.status not in (0, 503) or error.status == 0 and error.code != "transport_unavailable":
                    error.idempotency_key = key
                    raise
            time.sleep(max(0, min(poll_interval, deadline - time.monotonic())))
        raise MainbrellaError("creation_ambiguous", idempotency_key=key)


class _Workspaces:
    def __init__(self, client):
        self.client = client

    def _path(self, workspace_id):
        if not isinstance(workspace_id, str) or not re.fullmatch(r'[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}', workspace_id):
            raise MainbrellaError('invalid_workspace_identity')
        return '/workspaces/' + workspace_id

    def list(self):
        return self.client.request('/workspaces')

    def get(self, workspace_id):
        return self.client.request(self._path(workspace_id))

    def update(self, workspace_id, name=None, archived=None):
        body = {}
        if name is not None:
            body['name'] = name
        if archived is not None:
            body['archived'] = archived
        return self.client.request(self._path(workspace_id), 'PATCH', body)

    def delete(self, workspace_id):
        return self.client.request(self._path(workspace_id), 'DELETE')

    def restore(self, workspace_id, **options):
        self._path(workspace_id)
        return self.client.create(workspace_id=workspace_id, **options)


class _Files:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def read(self, path):
        return self.sandbox.client.request(self.sandbox._path("/containers/files", path=path), binary=True)

    def write(self, path, data):
        if not isinstance(data, bytes):
            raise MainbrellaError("file_bytes_required")
        return self.sandbox.client.request(self.sandbox._path("/containers/files", path=path), "PUT", data)

    def list(self, path, limit=None, offset=None):
        extra = {"path": path}
        if limit is not None:
            extra["limit"] = limit
        if offset is not None:
            extra["offset"] = offset
        return self.sandbox.client.request(self.sandbox._path("/containers/files/list", **extra))

    def stat(self, path, follow_symlinks=False):
        if type(follow_symlinks) is not bool:
            raise MainbrellaError("invalid_file_options")
        return self.sandbox.client.request(self.sandbox._path("/containers/files/stat", path=path, followSymlinks=str(follow_symlinks).lower()))

    def mkdir(self, path, recursive=False, mode=None):
        body = {"path": path, "recursive": recursive}
        if mode is not None:
            body["mode"] = mode
        return self.sandbox.client.request(self.sandbox._path("/containers/files/mkdir"), "POST", body)

    def remove(self, path, recursive=False):
        if type(recursive) is not bool:
            raise MainbrellaError("invalid_file_options")
        return self.sandbox.client.request(self.sandbox._path("/containers/files/remove", path=path, recursive=str(recursive).lower()), "DELETE")

    def move(self, path, destination):
        return self.sandbox.client.request(self.sandbox._path("/containers/files/move"), "POST", {"path": path, "destination": destination})

    def chmod(self, path, mode):
        return self.sandbox.client.request(self.sandbox._path("/containers/files/chmod", path=path), "PATCH", {"mode": mode})


class _Previews:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def create(self, port, ttl_seconds=None):
        if (type(port) is not int or not 1024 <= port <= 65535
                or ttl_seconds is not None and (type(ttl_seconds) is not int or not 60 <= ttl_seconds <= 3600)):
            raise MainbrellaError("invalid_preview_options")
        body = {"port": port}
        if ttl_seconds is not None:
            body["ttlSeconds"] = ttl_seconds
        return self.sandbox.client.request(self.sandbox._path("/containers/previews"), "POST", body)

    def list(self):
        return self.sandbox.client.request(self.sandbox._path("/containers/previews"))

    def revoke(self, preview_id):
        if not isinstance(preview_id, str) or not re.fullmatch(r"[a-f0-9]{32}", preview_id):
            raise MainbrellaError("invalid_preview_identity")
        return self.sandbox.client.request(self.sandbox._path("/containers/previews", previewId=preview_id), "DELETE")


class _Webhook:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def get(self):
        return self.sandbox.client.request(self.sandbox._path("/containers/webhook"))

    def configure(self, url, replay_from_cursor=None):
        body = {"url": url}
        if replay_from_cursor is not None:
            body["replayFromCursor"] = replay_from_cursor
        return self.sandbox.client.request(self.sandbox._path("/containers/webhook"), "PUT", body)

    def remove(self):
        return self.sandbox.client.request(self.sandbox._path("/containers/webhook"), "DELETE")

    def deliveries(self):
        return self.sandbox.client.request(self.sandbox._path("/containers/webhook/deliveries"))

    def retry(self, event_id):
        if not isinstance(event_id, str) or not re.fullmatch(r"[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}", event_id):
            raise MainbrellaError("invalid_event_identity")
        return self.sandbox.client.request(self.sandbox._path("/containers/webhook/retry"), "POST", {"eventId": event_id})


class _Commands:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def run(self, command, timeout_ms=None):
        body = {"command": command}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self.sandbox.client.request(self.sandbox._path("/containers/exec"), "POST", body)

    def list(self):
        return self.sandbox.client.request(self.sandbox._path("/containers/executions"))

    def attach(self, execution_id):
        return Execution(self.sandbox, execution_id)

    def start(self, command, timeout_ms=None, idempotency_key=None, stdin=None, cwd=None, env=None, pty=None):
        key = idempotency_key or str(uuid.uuid4())
        body = {"argv": command} if isinstance(command, list) else {"command": command}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        for name, value in (("stdin", stdin), ("cwd", cwd), ("env", env), ("pty", pty)):
            if value is not None:
                body[name] = value
        try:
            record = self.sandbox.client.request(self.sandbox._path("/containers/executions"), "POST", body, {"Idempotency-Key": key})
            return Execution(self.sandbox, record["id"])
        except MainbrellaError as error:
            error.idempotency_key = key
            raise


class _ExecutionInput:
    def __init__(self, execution):
        self.execution = execution

    def write(self, data):
        if not isinstance(data, bytes):
            raise MainbrellaError("stdin_bytes_required")
        return self.execution.sandbox.client.request(self.execution._path("/stdin"), "POST", data)

    def close(self):
        return self.execution.sandbox.client.request(self.execution._path("/stdin"), "DELETE")


class Execution:
    def __init__(self, sandbox, execution_id):
        if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", execution_id):
            raise MainbrellaError("invalid_execution_identity")
        self.sandbox = sandbox
        self.id = execution_id
        self.cursor = 0
        self.stdin = _ExecutionInput(self)

    def _path(self, suffix="", **extra):
        return self.sandbox._path("/containers/executions/" + self.id + suffix, **extra)

    def get(self):
        return self.sandbox.client.request(self._path())

    def cancel(self):
        return self.sandbox.client.request(self._path(), "DELETE")

    def signal(self, signal):
        if signal not in ("SIGINT", "SIGTERM", "SIGKILL"):
            raise MainbrellaError("invalid_execution_signal")
        return self.sandbox.client.request(self._path("/signal"), "POST", {"signal": signal})

    def resize(self, cols, rows):
        if any(type(value) is not int or not 1 <= value <= 1000 for value in (cols, rows)):
            raise MainbrellaError("invalid_terminal_size")
        return self.sandbox.client.request(self._path("/resize"), "POST", {"cols": cols, "rows": rows})

    def wait(self, timeout=900, poll_interval=1):
        if timeout <= 0 or poll_interval <= 0:
            raise MainbrellaError("invalid_wait_options")
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            result = self.get()
            if result["status"] not in ("starting", "running"):
                return result
            time.sleep(max(0, min(poll_interval, deadline - time.monotonic())))
        raise MainbrellaError("execution_wait_timeout")

    def events(self, cursor=None):
        """Yield live SSE output, replaying retained chunks after stream rotation."""
        cursor = self.cursor if cursor is None else cursor
        if not isinstance(cursor, int) or cursor < 0:
            raise MainbrellaError("invalid_cursor")
        client = self.sandbox.client
        while True:
            completed = False
            saw_status = False
            try:
                response = build_opener(_NoRedirect()).open(Request(client.base_url + self._path("/events", cursor=cursor),
                    headers={"Authorization": "Bearer " + client._api_key}), timeout=client.timeout)
                with response:
                    frame = []
                    while True:
                        line = response.readline(65537)
                        if not line:
                            break
                        if len(line) > 65536:
                            raise ValueError("oversized_event")
                        if line.strip():
                            frame.append(line.decode("utf-8").rstrip("\n"))
                            if sum(len(part) for part in frame) > 65536:
                                raise ValueError("oversized_event")
                            continue
                        kind = next((part[7:] for part in frame if part.startswith("event: ")), None)
                        data = next((part[6:] for part in frame if part.startswith("data: ")), None)
                        frame = []
                        if not data:
                            continue
                        item = json.loads(data)
                        if kind == "status":
                            saw_status = True
                            completed = item["status"] not in ("starting", "running")
                            yield {"type": "status", "execution": item}
                            if completed:
                                break
                        elif kind in ("stdout", "stderr"):
                            if not isinstance(item.get("sequence"), int) or not isinstance(item.get("data"), str):
                                raise ValueError("invalid_event")
                            if item["sequence"] > cursor:
                                self.cursor = cursor = item["sequence"]
                                yield item
                    if not saw_status:
                        raise ValueError("incomplete_stream")
            except HTTPError as error:
                error.close()
                raise MainbrellaError("execution_stream_unavailable", error.code) from None
            except (OSError, ValueError, KeyError, TypeError):
                raise MainbrellaError("execution_stream_unavailable") from None
            if completed:
                return


class Sandbox:
    def __init__(self, client, container_id, created_at):
        try:
            valid = (re.fullmatch(r"small|c[1-9]\d{0,2}", container_id)
                     and datetime.fromisoformat(created_at.replace("Z", "+00:00")).isoformat(timespec="milliseconds").replace("+00:00", "Z") == created_at)
        except (ValueError, TypeError, AttributeError):
            valid = False
        if not valid:
            raise MainbrellaError("invalid_container_identity")
        self.client = client
        self.id = container_id
        self.created_at = created_at
        self.files = _Files(self)
        self.commands = _Commands(self)
        self.previews = _Previews(self)
        self.webhook = _Webhook(self)

    def events(self, cursor=None, limit=None):
        options = {name: value for name, value in (("cursor", cursor), ("limit", limit)) if value is not None}
        return self.client.request(self._path("/containers/events", **options))

    def metrics(self, from_time=None, to_time=None):
        options = {name: value for name, value in (("from", from_time), ("to", to_time)) if value is not None}
        return self.client.request(self._path("/containers/metrics", **options))

    def _path(self, endpoint, **extra):
        return endpoint + "?" + urlencode(dict(extra, id=self.id, createdAt=self.created_at))

    def kill(self):
        result = self.client.request(self._path("/containers"), "DELETE")
        if not isinstance(result.get("containers"), list) or any(
                c.get("id") == self.id and c.get("createdAt") == self.created_at for c in result["containers"]):
            raise MainbrellaError("cleanup_unconfirmed")
        return result

    def save_workspace(self, name, stop=False, idempotency_key=None):
        key = idempotency_key or str(uuid.uuid4())
        if not isinstance(name, str) or not 1 <= len(name) <= 80 or type(stop) is not bool or not re.fullmatch(r'[A-Za-z0-9_-]{1,128}', key):
            raise MainbrellaError('invalid_workspace_options')
        try:
            return self.client.request('/workspaces', 'POST', {'id': self.id, 'createdAt': self.created_at, 'name': name, 'stop': stop}, {'Idempotency-Key': key})
        except MainbrellaError as error:
            error.idempotency_key = key
            raise

    def export_workspace(self):
        return self.client.request(self._path('/containers/export'), binary=True)

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.kill()
