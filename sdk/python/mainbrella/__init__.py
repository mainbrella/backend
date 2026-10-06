"""Synchronous Mainbrella client. No third-party runtime dependencies."""
import json
import re
import time
import uuid
from datetime import datetime
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener


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

    def create(self, catalog_id=None, image_id=None, idempotency_key=None, wait_timeout=120, poll_interval=1, size=None):
        key = idempotency_key or str(uuid.uuid4())
        if catalog_id and image_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) or wait_timeout <= 0 or poll_interval <= 0:
            raise MainbrellaError("invalid_creation_options")
        body = {"imageId": image_id} if image_id else {"catalogId": catalog_id} if catalog_id else {}
        if size is not None:
            if size not in ('lite', 'small', 'medium', 'large', 'xl'):
                raise MainbrellaError('invalid_creation_options')
            body['size'] = size
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
                    sandbox = self.connect(selected["id"], selected["createdAt"])
                    sandbox.creation_id = creation["id"]
                    sandbox.image_digest = selected.get("imageDigest")
                    sandbox.instance = selected.get("instance")
                    return sandbox
            except MainbrellaError as error:
                if error.status not in (0, 503) or error.status == 0 and error.code != "transport_unavailable":
                    error.idempotency_key = key
                    raise
            time.sleep(max(0, min(poll_interval, deadline - time.monotonic())))
        raise MainbrellaError("creation_ambiguous", idempotency_key=key)


class _Files:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def read(self, path):
        return self.sandbox.client.request(self.sandbox._path("/containers/files", path=path), binary=True)

    def write(self, path, data):
        if not isinstance(data, bytes):
            raise MainbrellaError("file_bytes_required")
        return self.sandbox.client.request(self.sandbox._path("/containers/files", path=path), "PUT", data)


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


class _Commands:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def run(self, command, timeout_ms=None):
        body = {"command": command}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self.sandbox.client.request(self.sandbox._path("/containers/exec"), "POST", body)

    def start(self, command, timeout_ms=None, idempotency_key=None):
        key = idempotency_key or str(uuid.uuid4())
        body = {"command": command}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        try:
            record = self.sandbox.client.request(self.sandbox._path("/containers/executions"), "POST", body, {"Idempotency-Key": key})
            return Execution(self.sandbox, record["id"])
        except MainbrellaError as error:
            error.idempotency_key = key
            raise


class Execution:
    def __init__(self, sandbox, execution_id):
        if not re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", execution_id):
            raise MainbrellaError("invalid_execution_identity")
        self.sandbox = sandbox
        self.id = execution_id
        self.cursor = 0

    def _path(self, suffix="", **extra):
        return self.sandbox._path("/containers/executions/" + self.id + suffix, **extra)

    def get(self):
        return self.sandbox.client.request(self._path())

    def cancel(self):
        return self.sandbox.client.request(self._path(), "DELETE")

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

    def _path(self, endpoint, **extra):
        return endpoint + "?" + urlencode(dict(extra, id=self.id, createdAt=self.created_at))

    def kill(self):
        result = self.client.request(self._path("/containers"), "DELETE")
        if not isinstance(result.get("containers"), list) or any(
                c.get("id") == self.id and c.get("createdAt") == self.created_at for c in result["containers"]):
            raise MainbrellaError("cleanup_unconfirmed")
        return result

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.kill()
