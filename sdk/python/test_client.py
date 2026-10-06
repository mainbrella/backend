import json
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit
from mainbrella import Mainbrella, MainbrellaError, verify_webhook_signature

KEY = "mb_" + "a" * 64
GENERATION = "2026-10-05T12:00:00.000Z"


class ClientTests(unittest.TestCase):
    def test_workspace_restore_fails_closed_without_start(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append(urlsplit(url).path)
            return 200, b'{"persistence":{"snapshots":false}}'
        client = Mainbrella(KEY, transport=transport)
        with self.assertRaises(MainbrellaError) as caught:
            client.workspaces.restore("d688d42a-25ef-4c13-9b28-21a0fde6e163", idempotency_key="restore-recovery")
        self.assertEqual(caught.exception.code, "persistence_unavailable")
        self.assertEqual(caught.exception.idempotency_key, "restore-recovery")
        self.assertEqual(calls, ["/capabilities"])

    def test_internet_off_fails_closed_and_preserves_explicit_boolean(self):
        calls = []
        def unsupported(url, method, headers, body, timeout):
            calls.append(urlsplit(url).path)
            return 200, b'{"networking":{"internetControl":false}}'
        client = Mainbrella(KEY, transport=unsupported)
        with self.assertRaises(MainbrellaError) as caught:
            client.create(internet=False, idempotency_key="offline")
        self.assertEqual(caught.exception.code, "network_policy_unavailable")
        self.assertEqual(caught.exception.idempotency_key, "offline")
        self.assertEqual(calls, ["/capabilities"])
        for internet in (0, "false", {}, []):
            with self.assertRaises(MainbrellaError):
                client.create(internet=internet)
        policy = [False]
        def supported(url, method, headers, body, timeout):
            if urlsplit(url).path == "/capabilities":
                return 200, b'{"networking":{"internetControl":true}}'
            self.assertIs(json.loads(body)["internet"], False)
            return 200, json.dumps({"creation": {"id": "offline", "containerId": "small", "createdAt": GENERATION, "status": "running"},
                "containers": [{"id": "small", "createdAt": GENERATION, "status": "running", "internet": policy[0]}]}).encode()
        client = Mainbrella(KEY, transport=supported)
        self.assertIs(client.create(internet=False).internet, False)
        policy[0] = True
        with self.assertRaises(MainbrellaError) as caught:
            client.create(internet=False)
        self.assertEqual(caught.exception.code, "network_policy_unconfirmed")
        def unavailable(url, method, headers, body, timeout):
            if urlsplit(url).path == "/capabilities":
                return 200, b'{"networking":{"internetControl":true}}'
            calls.append(urlsplit(url).path)
            return 503, b'{"error":"network_policy_unavailable"}'
        with self.assertRaises(MainbrellaError):
            Mainbrella(KEY, transport=unavailable).create(internet=False, wait_timeout=1)
        self.assertEqual(calls, ["/capabilities", "/containers"])

    def test_webhook_verification_uses_raw_bytes_and_rejects_tampering_and_stale_timestamps(self):
        import hmac, hashlib
        secret = "mbwh_" + "a" * 64
        body = '{ "message": "héllo 界" }'.encode()
        timestamp = 1000
        digest = hmac.new(secret.encode(), str(timestamp).encode() + b"." + body, hashlib.sha256).hexdigest()
        signature = f"t={timestamp},v1={digest}"
        self.assertTrue(verify_webhook_signature(body, signature, secret, now=1000))
        self.assertFalse(verify_webhook_signature(body + b" ", signature, secret, now=1000))
        self.assertFalse(verify_webhook_signature(body, signature, "mbwh_" + "b" * 64, now=1000))
        self.assertFalse(verify_webhook_signature(body, signature, secret, now=1301))
        self.assertFalse(verify_webhook_signature(body, signature, secret, now=699))
        self.assertFalse(verify_webhook_signature(body, signature + ",extra=1", secret, now=1000))
        self.assertFalse(verify_webhook_signature(body, signature, secret, now=1000, tolerance=True))
        self.assertFalse(verify_webhook_signature(body, signature, secret, now=float("nan")))

    def test_observability_and_webhook_helpers_bind_generation_without_retries(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["id"], ["small"])
            self.assertEqual(query["createdAt"], [GENERATION])
            calls.append((urlsplit(url).path, method, json.loads(body) if body else None, query))
            return 200, b'{"ok":true}'
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        sandbox.events(cursor=1, limit=10)
        sandbox.metrics(from_time=GENERATION, to_time=GENERATION)
        sandbox.webhook.configure("https://relay.example.com/customer", replay_from_cursor=0)
        sandbox.webhook.get(); sandbox.webhook.deliveries()
        event_id = "d688d42a-25ef-4c13-9b28-21a0fde6e163"
        sandbox.webhook.retry(event_id); sandbox.webhook.remove()
        self.assertEqual(calls[0][3]["cursor"], ["1"])
        self.assertEqual(calls[2][2], {"url": "https://relay.example.com/customer", "replayFromCursor": 0})
        self.assertEqual(calls[5][2], {"eventId": event_id})
        with self.assertRaises(MainbrellaError):
            sandbox.webhook.retry("bad")
        self.assertEqual(len(calls), 7)

    def test_managed_process_helpers_bind_identity_argv_binary_input_and_signals(self):
        job_id = "d688d42a-25ef-4c13-9b28-21a0fde6e163"
        calls = []
        def transport(url, method, headers, body, timeout):
            parsed = urlsplit(url); query = parse_qs(parsed.query)
            self.assertEqual(query["id"], ["small"]); self.assertEqual(query["createdAt"], [GENERATION])
            calls.append((parsed.path, method, body))
            if parsed.path == "/containers/executions" and method == "GET":
                return 200, json.dumps({"executions": [{"id": job_id, "status": "running"}]}).encode()
            if parsed.path.endswith("/stdin"):
                if method == "POST":
                    self.assertEqual(body, bytes([0, 128, 255])); self.assertEqual(headers["Content-Type"], "application/octet-stream")
                return 200, json.dumps({"bytes": 3 if method == "POST" else 0, "stdinClosed": method == "DELETE"}).encode()
            return 202, json.dumps({"id": job_id, "status": "running"}).encode()
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        job = sandbox.commands.start(["cat", "$(literal)"], stdin=True, cwd="/workspace", env={"TASK": "probe"}, idempotency_key="input-key")
        self.assertEqual(json.loads(calls[0][2]), {"argv": ["cat", "$(literal)"], "stdin": True, "cwd": "/workspace", "env": {"TASK": "probe"}})
        attached = sandbox.commands.attach(job.id)
        attached.stdin.write(bytes([0, 128, 255])); attached.stdin.close(); attached.signal("SIGINT")
        self.assertEqual(json.loads(calls[3][2]), {"signal": "SIGINT"})
        self.assertEqual(sandbox.commands.list()["executions"][0]["id"], job_id)
        with self.assertRaises(MainbrellaError):
            attached.stdin.write("text")
        with self.assertRaises(MainbrellaError):
            attached.signal("SIGSTOP")
        attached.resize(132, 40)
        self.assertEqual(json.loads(calls[-1][2]), {"cols": 132, "rows": 40})
        for cols in (0, 1001, True, "80"):
            with self.assertRaises(MainbrellaError):
                attached.resize(cols, 24)
        self.assertEqual(len(calls), 6)

    def test_filesystem_helpers_keep_identity_and_never_retry_mutations(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            parsed = urlsplit(url)
            query = parse_qs(parsed.query)
            self.assertEqual(query["id"], ["c1"]); self.assertEqual(query["createdAt"], [GENERATION])
            calls.append((parsed.path, method, query, json.loads(body) if body else None))
            return 200, b'{"ok":true}'
        files = Mainbrella(KEY, transport=transport).connect("c1", GENERATION).files
        path = "/workspace/界 &?.bin"
        files.list(path, limit=2, offset=4); files.stat(path, follow_symlinks=True)
        files.mkdir(path, recursive=True, mode="0750"); files.remove(path, recursive=True)
        files.move(path, "/workspace/moved"); files.chmod(path, "0640")
        self.assertEqual([(c[0], c[1]) for c in calls], [("/containers/files/list", "GET"), ("/containers/files/stat", "GET"),
                         ("/containers/files/mkdir", "POST"), ("/containers/files/remove", "DELETE"), ("/containers/files/move", "POST"), ("/containers/files/chmod", "PATCH")])
        self.assertEqual(calls[0][2]["limit"], ["2"]); self.assertEqual(calls[0][2]["offset"], ["4"])
        self.assertEqual(calls[1][2]["followSymlinks"], ["true"]); self.assertEqual(calls[3][2]["recursive"], ["true"])
        self.assertEqual(calls[2][3], {"path": path, "recursive": True, "mode": "0750"})
        self.assertEqual(calls[4][3], {"path": path, "destination": "/workspace/moved"}); self.assertEqual(calls[5][3], {"mode": "0640"})
        def fail(*args):
            calls.append("failure")
            raise OSError("private")
        with self.assertRaises(MainbrellaError):
            Mainbrella(KEY, transport=fail).connect("c1", GENERATION).files.remove(path)
        self.assertEqual(len(calls), 7)
        with self.assertRaises(MainbrellaError):
            files.remove(path, recursive="true")
        with self.assertRaises(MainbrellaError):
            files.stat(path, follow_symlinks="false")
        self.assertEqual(len(calls), 7)

    def test_complete_http_workflow_replay_cancellation_and_owned_cleanup(self):
        owner = self
        existing = {"id": "small", "createdAt": "2026-01-01T00:00:00.000Z", "status": "running"}
        created = {"id": "c1", "createdAt": GENERATION, "status": "running"}
        job_id = "d688d42a-25ef-4c13-9b28-21a0fde6e163"
        state = {"streams": 0, "deleted": False, "canceled": False, "errors": []}
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def handle_request(self):
                try:
                    url = urlsplit(self.path)
                    query = parse_qs(url.query)
                    body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                    owner.assertEqual(self.headers["Authorization"], "Bearer " + KEY)
                    result = None
                    content_type = "application/json"
                    if url.path == "/capabilities":
                        result = {"execution": {"foreground": True, "streaming": True}}
                    elif url.path == "/containers" and self.command == "POST":
                        owner.assertTrue(self.headers["Idempotency-Key"])
                        owner.assertEqual(json.loads(body), {"catalogId": "python"})
                        result = {"creation": {"id": "operation", "containerId": "c1", "createdAt": GENERATION, "status": "running"}, "containers": [existing, created]}
                    elif url.path == "/containers" and self.command == "GET":
                        result = {"containers": [existing] if state["deleted"] else [existing, created]}
                    else:
                        owner.assertEqual(query["id"], ["c1"])
                        owner.assertEqual(query["createdAt"], [GENERATION])
                        if url.path == "/containers":
                            owner.assertEqual(self.command, "DELETE")
                            state["deleted"] = True
                            result = {"containers": [existing]}
                        elif url.path == "/containers/exec":
                            result = {"stdout": "hello", "stderr": "diagnostic", "exitCode": 7, "timedOut": False, "outputTruncated": False}
                        elif url.path == "/containers/files":
                            owner.assertEqual(query["path"], ["/tmp/界 &?.bin"])
                            if self.command == "PUT":
                                state["file"] = body
                                result = {"size": len(body)}
                            else:
                                result = state["file"]
                                content_type = "application/octet-stream"
                        elif url.path == "/containers/executions":
                            owner.assertTrue(self.headers["Idempotency-Key"])
                            result = {"id": job_id}
                        elif url.path.endswith("/events"):
                            owner.assertEqual(query["cursor"], [str(state["streams"])])
                            result = ('id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"héllo 界"}\n\nevent: status\ndata: {"status":"running"}\n\n'
                                      if state["streams"] == 0 else
                                      'id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"duplicate"}\n\nid: 2\nevent: stderr\ndata: {"sequence":2,"type":"stderr","data":"done"}\n\nevent: status\ndata: {"status":"succeeded"}\n\n').encode()
                            state["streams"] += 1
                            content_type = "text/event-stream"
                        else:
                            owner.assertEqual(url.path, "/containers/executions/" + job_id)
                            if self.command == "DELETE":
                                state["canceled"] = True
                            result = {"id": job_id, "status": "canceled" if state["canceled"] else "succeeded"}
                    data = result if isinstance(result, bytes) else json.dumps(result).encode()
                    self.send_response(200); self.send_header("Content-Type", content_type); self.end_headers(); self.wfile.write(data)
                except Exception as error:
                    state["errors"].append(str(error))
                    self.send_response(500); self.end_headers(); self.wfile.write(b"{}")
            do_GET = do_POST = do_PUT = do_DELETE = handle_request
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            from mainbrella import Execution
            client = Mainbrella(KEY, base_url=f"http://127.0.0.1:{server.server_port}")
            self.assertTrue(client.capabilities()["execution"]["streaming"])
            with client.create(catalog_id="python") as sandbox:
                self.assertEqual(sandbox.commands.run("command")["exitCode"], 7)
                sandbox.files.write("/tmp/界 &?.bin", bytes([0, 128, 255]))
                self.assertEqual(sandbox.files.read("/tmp/界 &?.bin"), bytes([0, 128, 255]))
                job = sandbox.commands.start("managed")
                reconnected = Execution(sandbox, job.id)
                output = [event["data"] for event in reconnected.events() if event["type"] != "status"]
                self.assertEqual(output, ["héllo 界", "done"])
                self.assertEqual(reconnected.cursor, 2)
                self.assertEqual(reconnected.wait(poll_interval=0.001)["status"], "succeeded")
                self.assertEqual(job.cancel()["status"], "canceled")
            self.assertEqual(client.list()["containers"], [existing])
            self.assertEqual(state["errors"], [])
            self.assertEqual(state["streams"], 2)
            self.assertTrue(state["deleted"] and state["canceled"])
        finally:
            server.shutdown(); server.server_close(); thread.join()

    def test_previews_use_exact_generation_and_metadata_reconciliation(self):
        calls = []
        grant = {"id": "b" * 32, "port": 3000, "createdAt": GENERATION, "expiresAt": 2000000000000}
        def transport(url, method, headers, body, timeout):
            calls.append(method)
            self.assertEqual(urlsplit(url).path, "/containers/previews")
            query = parse_qs(urlsplit(url).query)
            self.assertEqual(query["id"], ["small"])
            self.assertEqual(query["createdAt"], [GENERATION])
            if method == "POST":
                self.assertEqual(json.loads(body), {"port": 3000, "ttlSeconds": 600})
                return 201, json.dumps(dict(grant, url="https://" + "a" * 48 + ".preview.example/")).encode()
            if method == "DELETE":
                self.assertEqual(query["previewId"], [grant["id"]])
                return 200, b'{"revoked":true}'
            return 200, json.dumps({"previews": [grant]}).encode()
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        link = sandbox.previews.create(3000, ttl_seconds=600)
        self.assertEqual(link["id"], grant["id"])
        self.assertEqual(sandbox.previews.list(), {"previews": [grant]})
        self.assertEqual(sandbox.previews.revoke(link["id"]), {"revoked": True})
        for port in [22, 1023, 65536, 3000.5, "3000", True]:
            with self.assertRaises(MainbrellaError):
                sandbox.previews.create(port)
        for ttl in [59, 3601, 60.5, "600", True]:
            with self.assertRaises(MainbrellaError):
                sandbox.previews.create(3000, ttl_seconds=ttl)
        with self.assertRaises(MainbrellaError):
            sandbox.previews.revoke("invalid")
        self.assertEqual(len(calls), 3)

    def test_preview_failure_is_not_retried_and_keeps_only_safe_cleanup_id(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return 503, json.dumps({"error": "preview_reconciliation_required", "previewId": "b" * 32, "token": KEY}).encode()
        sandbox = Mainbrella(KEY, transport=transport).connect("small", GENERATION)
        with self.assertRaises(MainbrellaError) as error:
            sandbox.previews.create(3000)
        self.assertEqual(error.exception.preview_id, "b" * 32)
        self.assertEqual(error.exception.status, 503)
        self.assertEqual(len(calls), 1)
        for code, preview_id in [("previews_unavailable", "b" * 32), ("preview_reconciliation_required", KEY)]:
            client = Mainbrella(KEY, transport=lambda *args: (503, json.dumps({"error": code, "previewId": preview_id}).encode()))
            with self.assertRaises(MainbrellaError) as error:
                client.connect("small", GENERATION).previews.list()
            self.assertIsNone(error.exception.preview_id)

    def test_creation_retries_and_generation_cleanup(self):
        calls = []
        def transport(url, method, headers, body, timeout):
            calls.append((method, headers, body))
            if len(calls) == 1:
                raise OSError(KEY)
            if method == "DELETE":
                self.assertEqual(parse_qs(urlsplit(url).query)["createdAt"], [GENERATION])
                return 200, b'{"containers":[]}'
            return 200, json.dumps({"creation": {"id": "operation", "containerId": "c1", "createdAt": GENERATION, "status": "running"},
                                    "containers": [{"id": "small", "createdAt": GENERATION, "status": "running"},
                                                   {"id": "c1", "createdAt": GENERATION, "status": "running"}]}).encode()
        with Mainbrella(KEY, transport=transport).create(idempotency_key="stable", poll_interval=0.001) as sandbox:
            self.assertEqual(sandbox.id, "c1")
        self.assertEqual([h["Idempotency-Key"] for m, h, b in calls if m == "POST"], ["stable", "stable"])

    def test_no_command_retry_and_sanitized_failures(self):
        calls = []
        def transport(*args):
            calls.append(args)
            return 503, json.dumps({"error": "secret: " + KEY}).encode()
        with self.assertRaises(MainbrellaError) as error:
            Mainbrella(KEY, transport=transport).connect("small", GENERATION).commands.run("side effect")
        self.assertEqual(error.exception.code, "request_failed")
        self.assertEqual(len(calls), 1)

    def test_unsafe_urls_and_ambiguous_creation(self):
        for url in ["http://example.com", "https://user:pass@example.com", "https://example.com/path"]:
            with self.assertRaises(MainbrellaError):
                Mainbrella(KEY, base_url=url)
        client = Mainbrella(KEY, transport=lambda *args: (503, b'{"error":"unavailable"}'))
        with self.assertRaises(MainbrellaError) as error:
            client.create(idempotency_key="recover", wait_timeout=0.005, poll_interval=0.001)
        self.assertEqual(error.exception.idempotency_key, "recover")

    def test_real_http_binary_roundtrip_and_redirect_refusal(self):
        probe = bytes([0, 128, 255])
        owner = self
        class Handler(BaseHTTPRequestHandler):
            stored = b""
            def log_message(self, *args):
                pass
            def do_PUT(self):
                owner.assertEqual(self.headers["Authorization"], "Bearer " + KEY)
                owner.assertEqual(parse_qs(urlsplit(self.path).query)["createdAt"], [GENERATION])
                Handler.stored = self.rfile.read(int(self.headers["Content-Length"]))
                self.send_response(200); self.end_headers(); self.wfile.write(b'{"size":3}')
            def do_GET(self):
                if self.path == "/redirect":
                    self.send_response(302); self.send_header("Location", "/leak"); self.end_headers()
                elif "/events?" in self.path:
                    self.send_response(200); self.end_headers()
                    self.wfile.write('id: 1\nevent: stdout\ndata: {"sequence":1,"type":"stdout","data":"héllo 界"}\n\nevent: status\ndata: {"status":"succeeded"}\n\n'.encode())
                else:
                    owner.assertNotEqual(self.path, "/leak")
                    self.send_response(200); self.end_headers(); self.wfile.write(Handler.stored)
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            client = Mainbrella(KEY, base_url=f"http://127.0.0.1:{server.server_port}")
            sandbox = client.connect("small", GENERATION)
            sandbox.files.write("/tmp/界 &?.bin", probe)
            self.assertEqual(sandbox.files.read("/tmp/界 &?.bin"), probe)
            with self.assertRaises(MainbrellaError) as error:
                client.request("/redirect")
            self.assertEqual(error.exception.status, 302)
            from mainbrella import Execution
            execution = Execution(sandbox, 'd688d42a-25ef-4c13-9b28-21a0fde6e163')
            events = list(execution.events())
            self.assertEqual(events[0]["data"], "héllo 界")
            self.assertEqual(execution.cursor, 1)
        finally:
            server.shutdown(); server.server_close(); thread.join()


if __name__ == "__main__":
    unittest.main()
