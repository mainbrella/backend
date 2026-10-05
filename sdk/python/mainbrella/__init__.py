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
    def __init__(self, code, status=0, idempotency_key=None):
        super().__init__(code)
        self.code = code
        self.status = status
        self.idempotency_key = idempotency_key


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
            try:
                value = json.loads(data)
                code = value.get("error") if isinstance(value, dict) else None
            except (ValueError, TypeError):
                code = None
            if not isinstance(code, str) or not re.fullmatch(r"[a-z][a-z0-9_]{0,79}", code):
                code = "request_failed"
            raise MainbrellaError(code, status)
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

    def create(self, catalog_id=None, image_id=None, idempotency_key=None, wait_timeout=120, poll_interval=1):
        key = idempotency_key or str(uuid.uuid4())
        if catalog_id and image_id or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", key) or wait_timeout <= 0 or poll_interval <= 0:
            raise MainbrellaError("invalid_creation_options")
        body = {"imageId": image_id} if image_id else {"catalogId": catalog_id} if catalog_id else {}
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


class _Commands:
    def __init__(self, sandbox):
        self.sandbox = sandbox

    def run(self, command, timeout_ms=None):
        body = {"command": command}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        return self.sandbox.client.request(self.sandbox._path("/containers/exec"), "POST", body)


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
